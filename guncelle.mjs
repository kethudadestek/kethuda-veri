// Kethüda · resmi rakam güncelleyici
// Her ay TCMB EVDS'den TÜFE endeksini çeker, "12 aylık ortalamalara göre değişim"i hesaplar
// ve parametreler.json'a o ay yenilenen kiralar için yasal üst sınır olarak ekler.
// Elle girilmiş değerlerin üzerine asla yazmaz. Şüpheli bir sonuç çıkarsa durur ve hata verir.
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.EVDS_API_KEY;
const BASE = process.env.EVDS_URL || 'https://evds2.tcmb.gov.tr/service/evds';
const SERIES = process.env.EVDS_SERIES || 'TP.FG.J0'; // TÜFE genel endeks
const FILE = new URL('./parametreler.json', import.meta.url);

if (!KEY) {
  console.error('EVDS_API_KEY tanımlı değil. GitHub > Settings > Secrets bölümüne ekle.');
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const start = `01-01-${now.getFullYear() - 3}`;
const end = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
const url = `${BASE}/series=${SERIES}&startDate=${start}&endDate=${end}&type=json&frequency=5`;

const res = await fetch(url, { headers: { key: KEY } });
if (!res.ok) {
  console.error('EVDS isteği başarısız:', res.status, await res.text());
  process.exit(1);
}
const json = await res.json();
const field = SERIES.replace(/\./g, '_');
// Tarih biçimi "2026-9" ya da "2026-09"
const points = (json.items || [])
  .map((it) => {
    const [y, m] = String(it.Tarih).split('-').map(Number);
    const v = Number(it[field]);
    return { y, m, v };
  })
  .filter((p) => p.y && p.m && Number.isFinite(p.v) && p.v > 0)
  .sort((a, b) => a.y - b.y || a.m - b.m);

if (points.length < 24) {
  console.error('Yeterli veri yok:', points.length);
  process.exit(1);
}

// Son ay (M) için: son 12 ayın ortalaması / önceki 12 ayın ortalaması
const avg = (arr) => arr.reduce((s, p) => s + p.v, 0) / arr.length;
const last = points.slice(-12);
const prev = points.slice(-24, -12);
const rate = Math.round((avg(last) / avg(prev) - 1) * 10000) / 100;

// Bu oran bir sonraki ay yenilenen kiralara uygulanır
const lp = points[points.length - 1];
const ny = lp.m === 12 ? lp.y + 1 : lp.y;
const nm = lp.m === 12 ? 1 : lp.m + 1;
const key = `${ny}-${pad(nm)}`;

const params = JSON.parse(readFileSync(FILE, 'utf8'));
const rates = params.kira.rates;
if (rates[key] != null) {
  console.log(`${key} zaten var (%${rates[key]}). Değişiklik yok.`);
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
