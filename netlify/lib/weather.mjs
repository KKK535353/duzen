import { webpush, vapid } from "./push.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MGM_HEADERS = {
  Origin: "https://www.mgm.gov.tr",
  Referer: "https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx",
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
};

const MGM_CODES = {
  A: "Açık", AB: "Az bulutlu", PB: "Parçalı bulutlu", CB: "Çok bulutlu",
  HY: "Hafif yağmurlu", Y: "Yağmurlu", KY: "Kuvvetli yağmurlu",
  HSY: "Hafif sağanak yağışlı", SY: "Sağanak yağışlı", KSY: "Kuvvetli sağanak yağışlı",
  MSY: "Yer yer sağanak yağışlı", GSY: "Gök gürültülü sağanak yağışlı", KGY: "Kuvvetli gök gürültülü sağanak yağışlı",
  KKY: "Karla karışık yağmurlu", HKY: "Hafif kar yağışlı", K: "Kar yağışlı", YKY: "Yoğun kar yağışlı", DY: "Dolu",
  D: "Dumanlı", SIS: "Sisli", PUS: "Puslu", R: "Rüzgarlı", GKR: "Güneyli kuvvetli rüzgarlı", KKR: "Kuzeyli kuvvetli rüzgarlı",
  SCK: "Sıcak", SGK: "Soğuk", KF: "Toz veya kum fırtınalı",
};
const MGM_WET = new Set(["HY", "Y", "KY", "HSY", "SY", "KSY", "MSY", "GSY", "KGY", "KKY", "DY", "K", "HKY", "YKY"]);

function wmo(code) {
  if (code === 0) return ["Açık", false];
  if (code === 1) return ["Az bulutlu", false];
  if (code === 2) return ["Parçalı bulutlu", false];
  if (code === 3) return ["Çok bulutlu", false];
  if (code === 45 || code === 48) return ["Sisli", false];
  if (code >= 51 && code <= 57) return ["Çiseleyen yağmur", true];
  if (code >= 61 && code <= 65) return ["Yağmurlu", true];
  if (code === 66 || code === 67) return ["Dondurucu yağmur", true];
  if (code >= 71 && code <= 77) return ["Kar yağışlı", true];
  if (code >= 80 && code <= 82) return ["Sağanak yağışlı", true];
  if (code === 85 || code === 86) return ["Kar sağanağı", true];
  if (code >= 95) return ["Gök gürültülü fırtına", true];
  return ["Değişken hava", false];
}

async function getJson(url, ms, headers) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}
const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error("geçersiz değer");
  return n;
};

// Meteoroloji Genel Müdürlüğü (sitesinin kendi servisi; resmî, belgeli bir API değil)
export async function fetchMGM() {
  const centers = await getJson("https://servis.mgm.gov.tr/web/merkezler?il=istanbul", 5000, MGM_HEADERS);
  const c = Array.isArray(centers) ? centers[0] : null;
  if (!c) throw new Error("merkez bulunamadı");
  let d = null;
  for (const id of [...new Set([c.gunlukTahminIstNo, c.merkezId].filter(Boolean))]) {
    try {
      const j = await getJson("https://servis.mgm.gov.tr/web/tahminler/gunluk?istno=" + id, 5000, MGM_HEADERS);
      if (Array.isArray(j) && j[0] && j[0].hadiseGun1 != null) { d = j[0]; break; }
    } catch { /* sıradaki kimliği dene */ }
  }
  if (!d) throw new Error("günlük tahmin alınamadı");
  const code = String(d.hadiseGun1);
  return {
    source: "MGM",
    cond: MGM_CODES[code] || "Hava durumu",
    wet: MGM_WET.has(code),
    low: num(d.enDusukGun1, -60, 60),
    high: num(d.enYuksekGun1, -60, 60),
    wind: d.ruzgarHizGun1 != null ? Math.round(num(d.ruzgarHizGun1, 0, 300)) : null,
    humMin: d.enDusukNemGun1 != null ? num(d.enDusukNemGun1, 0, 100) : null,
    humMax: d.enYuksekNemGun1 != null ? num(d.enYuksekNemGun1, 0, 100) : null,
    pop: null,
  };
}

// Yedek kaynak: Open-Meteo (ücretsiz, anahtarsız, ticari olmayan kullanım için)
export async function fetchOpenMeteo() {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=41.0082&longitude=28.9784"
    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max"
    + "&timezone=Europe%2FIstanbul&forecast_days=1";
  const j = await getJson(url, 6000, { "User-Agent": UA });
  const d = j && j.daily;
  if (!d || !d.temperature_2m_max) throw new Error("veri yok");
  const [cond, wet] = wmo(Number(d.weather_code && d.weather_code[0]));
  const pop = d.precipitation_probability_max && d.precipitation_probability_max[0];
  return {
    source: "Open-Meteo", cond, wet,
    low: Math.round(num(d.temperature_2m_min[0], -60, 60)),
    high: Math.round(num(d.temperature_2m_max[0], -60, 60)),
    wind: d.wind_speed_10m_max && d.wind_speed_10m_max[0] != null ? Math.round(num(d.wind_speed_10m_max[0], 0, 300)) : null,
    humMin: null, humMax: null,
    pop: pop != null ? Math.round(num(pop, 0, 100)) : null,
  };
}

export async function getForecast() {
  const errs = [];
  try { return await fetchMGM(); } catch (e) { errs.push("MGM: " + (e && e.message)); }
  try { const f = await fetchOpenMeteo(); f.note = errs.join("; "); return f; } catch (e) { errs.push("Open-Meteo: " + (e && e.message)); }
  throw new Error(errs.join(" | "));
}

export function buildMessage(f) {
  let day = "";
  try { day = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "long", weekday: "long" }).format(new Date()); } catch { /* tarih yazılmaz */ }
  const src = f.source === "MGM" ? "Meteoroloji Genel Müdürlüğü" : "Open-Meteo";
  const hint = f.wet ? "Şemsiye almayı unutma." : (f.pop != null && f.pop >= 50 ? `Yağış ihtimali %${f.pop}.` : "");
  const body = `${f.cond}, ${f.low}° / ${f.high}°.${hint ? " " + hint : ""}${f.wind != null ? ` Rüzgar ${f.wind} km/sa.` : ""} (${f.source})`;
  const lines = [
    `İstanbul${day ? ", " + day : ""}`, f.cond,
    `En düşük ${f.low}°, en yüksek ${f.high}°`,
    f.humMin != null && f.humMax != null ? `Nem %${f.humMin} - %${f.humMax}` : null,
    f.wind != null ? `Rüzgar ${f.wind} km/sa` : null,
    hint || null,
    `Kaynak: ${src}`,
  ].filter(Boolean);
  return { title: "İstanbul hava durumu", body, full: lines.join("\n") };
}

export async function setupVapid(s) {
  const v = await vapid(s);
  const subject = (process.env.URL || "").startsWith("https://") ? process.env.URL : "mailto:push@example.com";
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);
}

// Seçilen kişilere gönder; geçersiz abonelikleri temizler
export async function sendToPids(s, pids, payload) {
  let sent = 0, failed = 0, removed = 0;
  for (const pid of pids) {
    const rec = await s.get("sub/" + pid, { type: "json" });
    if (!rec) { failed++; continue; }
    try {
      await webpush.sendNotification(rec.sub, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { await s.delete("sub/" + pid); await s.delete("assigned/" + pid); removed++; }
      else { failed++; console.error("weather push error", e && e.statusCode); }
    }
  }
  return { sent, failed, removed };
}

export const weatherPayload = (m) => ({
  title: m.title, body: m.body, tag: "weather-" + Date.now(),
  url: `/?t=${encodeURIComponent(m.title)}&b=${encodeURIComponent(m.full)}`,
});

export async function loadCfg(s) {
  const c = (await s.get("weather", { type: "json" })) || {};
  return { enabled: !!c.enabled, recipients: c.recipients || {}, last: c.last || null };
}
