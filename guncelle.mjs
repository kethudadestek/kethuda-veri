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
  const norm = (v) => String(v ?? '').toLocaleLowerCase('tr-TR');
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
  // En güncel biten ve "2025" bazlı olanı öne al
  candidates.sort((a, b) => (/2025/.test(b.name) ? 1 : 0) - (/2025/.test(a.name) ? 1 : 0) || b.end.localeCompare(a.end));
  for (const g of candidates) {
    const series = listOf((await getJson(`serieList/type=json&code=${g.code}`)).json);
    const general = series.find((x) => /genel|general/.test(norm(pick(x, 'SERIE_NAME', 'SERIE_NAME_ENG')))) ?? series[0];
    if (general) {
      const code = pick(general, 'SERIE_CODE');
      console.log(`Seçilen seri: ${code} · ${pick(general, 'SERIE_NAME')} (${g.code})`);
      return code;
    }
  }
  return null;
}

let points = await seriesPoints(SERIES);
const isStale = (pts) => {
  if (!pts.length) return true;
  const l = pts[pts.length - 1];
  return (now.getFullYear() * 12 + now.getMonth()) - ym(l) > 3;
};

if (isStale(points) && !process.env.EVDS_SERIES) {
  const code = await discoverCpiSeries();
  if (!code) {
    console.error('Yeni TÜFE serisi bulunamadı. EVDS_SERIES ile seri kodunu elle ver.');
    process.exit(1);
  }
  const fresh = await seriesPoints(code);
  // Yeni seri 24 aydan kısaysa eski seriyle ortak aylardaki orana göre birleştir
  if (fresh.length < 24 && points.length) {
    const oldBy = new Map(points.map((p) => [ym(p), p.v]));
    const overlap = fresh.filter((p) => oldBy.has(ym(p)));
    if (!overlap.length) {
      console.error('Eski ve yeni seri birleştirilemedi (ortak ay yok).');
      process.exit(1);
    }
    const factor = overlap.reduce((s, p) => s + p.v / oldBy.get(ym(p)), 0) / overlap.length;
    const firstNew = ym(fresh[0]);
    const older = points.filter((p) => ym(p) < firstNew).map((p) => ({ ...p, v: p.v * factor }));
    console.log(`Eski seri ${older.length} ay için ${overlap.length} ortak ayın oranıyla eklendi.`);
    points = [...older, ...fresh];
  } else {
    points = fresh;
  }
}

if (points.length < 24) {
  console.error(`Yeterli veri yok (${points.length} ay).`);
  process.exit(1);
}

// Veri güncel mi? (son ay en fazla 3 ay eski olmalı)
const lp = points[points.length - 1];
const ageMonths = (now.getFullYear() - lp.y) * 12 + (now.getMonth() + 1 - lp.m);
if (ageMonths > 3) {
  console.error(`Son veri ${lp.y}-${pad(lp.m)} tarihli, çok eski. TÜİK endeksin baz yılını değiştirmiş olabilir; EVDS_SERIES ile yeni seri kodunu ver.`);
  process.exit(1);
}

// Son ay için: son 12 ayın ortalaması / önceki 12 ayın ortalaması
const avg = (arr) => arr.reduce((s, p) => s + p.v, 0) / arr.length;
const rate = Math.round((avg(points.slice(-12)) / avg(points.slice(-24, -12)) - 1) * 10000) / 100;

// Bu oran bir sonraki ay yenilenen kiralara uygulanır
const ny = lp.m === 12 ? lp.y + 1 : lp.y;
const nm = lp.m === 12 ? 1 : lp.m + 1;
const key = `${ny}-${pad(nm)}`;

const params = JSON.parse(readFileSync(FILE, 'utf8'));
const rates = params.kira.rates;
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
