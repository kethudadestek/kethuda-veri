// Kethüda · resmi rakam güncelleyici
// Her ay TCMB EVDS'den TÜFE endeksini çeker, "12 aylık ortalamalara göre değişim"i hesaplar
// ve parametreler.json'a o ay yenilenen kiralar için yasal üst sınır olarak ekler.
// Elle girilmiş değerlerin üzerine asla yazmaz. Şüpheli bir sonuç çıkarsa durur ve hata verir.
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = (process.env.EVDS_API_KEY || '').trim();
const SERIES = process.env.EVDS_SERIES || 'TP.FG.J0'; // TÜFE genel endeks
// TCMB 2026'da EVDS 3'e geçti; önce yeni adres, olmazsa eski adres denenir
const BASES = (process.env.EVDS_URL ? [process.env.EVDS_URL] : [])
  .concat(['https://evds3.tcmb.gov.tr/igmevdsms-dis', 'https://evds2.tcmb.gov.tr/service/evds']);
const FILE = new URL('./parametreler.json', import.meta.url);

if (!KEY) {
  console.error('EVDS_API_KEY tanımlı değil. GitHub > Settings > Secrets and variables > Actions bölümüne ekle.');
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const start = `01-01-${now.getFullYear() - 3}`;
const end = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;

async function getJson(path) {
  const errors = [];
  for (const base of BASES) {
    const url = `${base.replace(/\/$/, '')}/${path}`;
    try {
      const res = await fetch(url, { headers: { key: KEY, Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${base} → HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        continue;
      }
      try {
        return { json: JSON.parse(text), base };
      } catch {
        errors.push(`${base} → JSON yerine sayfa döndü (anahtar bu sistemde geçersiz olabilir): ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      }
    } catch (e) {
      errors.push(`${base} → bağlanılamadı: ${e.message}`);
    }
  }
  return { json: null, errors };
}

// Alan adları büyük/küçük harf farkıyla gelebilir
const pick = (obj, ...names) => {
  for (const n of names) {
    const k = Object.keys(obj).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
};
const listOf = (json) => (Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : []);

// Tarih biçimleri: "2026-9", "2026-09", "09-2026", "01-09-2026"
function parseDate(t) {
  const parts = String(t).split('-').map(Number);
  if (parts.length === 2) return parts[0] > 1900 ? { y: parts[0], m: parts[1] } : { y: parts[1], m: parts[0] };
  if (parts.length === 3) return parts[0] > 1900 ? { y: parts[0], m: parts[1] } : { y: parts[2], m: parts[1] };
  return { y: NaN, m: NaN };
}
const ym = (p) => p.y * 12 + (p.m - 1);
const norm = (v) => String(v ?? '').toLocaleLowerCase('tr-TR');

async function seriesPoints(code) {
  const { json, errors } = await getJson(`series=${code}&startDate=${start}&endDate=${end}&type=json&frequency=5`);
  if (!json) {
    console.error('EVDS verisi alınamadı. Denenen adresler:\n- ' + errors.join('\n- '));
    console.error("\nÇözüm: evds3.tcmb.gov.tr adresine giriş yapıp yeni bir API anahtarı al ve GitHub'daki EVDS_API_KEY değerini onunla değiştir.");
    process.exit(1);
  }
  const field = code.replace(/\./g, '_');
  return listOf(json)
    .map((it) => ({ ...parseDate(it.Tarih), v: Number(it[field]) }))
    .filter((p) => p.y && p.m && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => ym(a) - ym(b));
}

// TÜİK 2026'da TÜFE'nin baz yılını değiştirdi (2025=100). Eski seri durunca yenisini EVDS'te kendimiz buluruz.
async function discoverCpiSeries() {
  console.log('Yeni TÜFE serisi aranıyor…');
  const cats = listOf((await getJson('categories/type=json')).json);
  let priceCats = cats.filter((c) => norm(pick(c, 'TOPIC_TITLE_TR', 'CATEGORY_NAME')).includes('fiyat') || norm(pick(c, 'TOPIC_TITLE_ENG')).includes('price'));
  if (!priceCats.length) priceCats = cats; // bulunamazsa hepsine bak
  const candidates = [];
  for (const c of priceCats) {
    const id = pick(c, 'CATEGORY_ID', 'ID');
    const groups = listOf((await getJson(`datagroups/mode=2&code=${id}&type=json`)).json);
    for (const g of groups) {
      const name = String(pick(g, 'DATAGROUP_NAME', 'DATAGROUP_NAME_ENG') ?? '');
      const n = norm(name);
      if (n.includes('tüketici fiyat') || n.includes('tüfe') || norm(pick(g, 'DATAGROUP_NAME_ENG')).includes('consumer price')) {
        candidates.push({ code: pick(g, 'DATAGROUP_CODE'), name, end: String(pick(g, 'END_DATE') ?? '') });
      }
    }
  }
  console.log('Bulunan TÜFE veri grupları:\n' + candidates.map((c) => `  ${c.code} · ${c.name} · bitiş ${c.end}`).join('\n'));
  // Arşiv, özel kapsamlı, mevsimsellikten arındırılmış, bölgesel ve ağırlık gruplarını ele;
  // "Genel" olanı ve en güncel biteni öne al
  const bad = /arşiv|özel kapsam|mevsim|ağırlık|bölge|il(?:lere|ler)|göstergeleri/;
  return candidates
    .filter((c) => !bad.test(norm(c.name)))
    .sort((a, b) => (norm(b.name).includes('genel') ? 1 : 0) - (norm(a.name).includes('genel') ? 1 : 0) || b.end.split('-').reverse().join('').localeCompare(a.end.split('-').reverse().join('')));
}

async function seriesInGroup(group) {
  const series = listOf((await getJson(`serieList/type=json&code=${group.code}`)).json);
  const named = (x) => norm(pick(x, 'SERIE_NAME', 'SERIE_NAME_ENG'));
  const general = series.find((x) => /genel|general/.test(named(x))) ?? series[0];
  return general ? { code: pick(general, 'SERIE_CODE'), name: pick(general, 'SERIE_NAME') } : null;
}

const isStale = (pts) => !pts.length || now.getFullYear() * 12 + now.getMonth() - ym(pts[pts.length - 1]) > 3;
const avg = (arr) => arr.reduce((s, p) => s + p.v, 0) / arr.length;
const nextKey = (p) => (p.m === 12 ? `${p.y + 1}-01` : `${p.y}-${pad(p.m + 1)}`);
// i. aya kadar olan verilerle hesaplanan oran (i+1. ay yenilenen kiralar için)
const rateAt = (pts, i) => Math.round((avg(pts.slice(i - 11, i + 1)) / avg(pts.slice(i - 23, i - 11)) - 1) * 10000) / 100;

const params = JSON.parse(readFileSync(FILE, 'utf8'));
const rates = params.kira.rates;

// Seriyi, TÜİK'in daha önce açıkladığı oranlarla karşılaştırarak doğrula
function validate(pts) {
  for (let i = pts.length - 1; i >= 23; i--) {
    const k = nextKey(pts[i]);
    if (rates[k] != null) {
      const calc = rateAt(pts, i);
      return { key: k, calc, official: rates[k], ok: Math.abs(calc - rates[k]) <= 0.15 };
    }
  }
  return null;
}

function splice(fresh, old) {
  if (fresh.length >= 24 || !old.length) return fresh;
  const oldBy = new Map(old.map((p) => [ym(p), p.v]));
  const overlap = fresh.filter((p) => oldBy.has(ym(p)));
  if (!overlap.length) return fresh;
  const factor = overlap.reduce((s, p) => s + p.v / oldBy.get(ym(p)), 0) / overlap.length;
  const firstNew = ym(fresh[0]);
  const older = old.filter((p) => ym(p) < firstNew).map((p) => ({ ...p, v: p.v * factor }));
  return [...older, ...fresh];
}

const base = await seriesPoints(SERIES);
let points = null;
const tryPoints = (label, pts) => {
  if (pts.length < 24 || isStale(pts)) {
    console.log(`  ✗ ${label}: ${pts.length < 24 ? `yetersiz veri (${pts.length} ay)` : 'veri güncel değil'}`);
    return false;
  }
  const v = validate(pts);
  if (!v) {
    console.log(`  ? ${label}: karşılaştıracak resmi oran yok`);
    return false;
  }
  console.log(`  ${v.ok ? '✓' : '✗'} ${label}: ${v.key} için hesap %${v.calc}, TÜİK %${v.official}`);
  return v.ok;
};

console.log('Seriler TÜİK oranlarıyla karşılaştırılıyor:');
if (tryPoints(SERIES, base)) points = base;
if (!points && !process.env.EVDS_SERIES) {
  for (const g of await discoverCpiSeries()) {
    const s = await seriesInGroup(g);
    if (!s) continue;
    const pts = splice(await seriesPoints(s.code), base);
    if (tryPoints(`${s.code} · ${s.name} (${g.code})`, pts)) {
      points = pts;
      break;
    }
  }
}
if (!points) {
  console.error('TÜİK oranlarıyla uyuşan bir seri bulunamadı. Yeni oran yazılmadı; elle kontrol et.');
  process.exit(1);
}

const lp = points[points.length - 1];
const rate = rateAt(points, points.length - 1);

// Bu oran bir sonraki ay yenilenen kiralara uygulanır
const ny = lp.m === 12 ? lp.y + 1 : lp.y;
const nm = lp.m === 12 ? 1 : lp.m + 1;
const key = `${ny}-${pad(nm)}`;

console.log(`Hesaplanan: ${key} → %${rate} (son veri ${lp.y}-${pad(lp.m)})`);
if (rates[key] != null) {
  const diff = Math.abs(rates[key] - rate);
  console.log(`${key} zaten var (%${rates[key]}). Değişiklik yok.${diff > 0.05 ? ` Not: hesaplanan değer %${diff.toFixed(2)} farklı, kontrol et.` : ' Hesap doğrulandı.'}`);
  process.exit(0);
}

// Güvenlik: önceki aya göre 3 puandan fazla fark varsa yazma, elle kontrol et
const keys = Object.keys(rates).sort();
const prevRate = keys.length ? rates[keys[keys.length - 1]] : null;
if (prevRate != null && Math.abs(prevRate - rate) > 3) {
  console.error(`Şüpheli sonuç: ${key} için %${rate}, önceki ay %${prevRate}. TÜİK bültenini kontrol edip elle gir.`);
  process.exit(1);
}

rates[key] = rate;
params.updatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(FILE, JSON.stringify(params, null, 2) + '\n');
console.log(`Eklendi: ${key} → %${rate}`);
