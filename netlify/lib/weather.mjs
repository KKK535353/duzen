import { webpush, vapid, localNow, markStale } from "./push.mjs";

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
const MGM_ICON = {
  A: "☀️", AB: "🌤️", PB: "⛅", CB: "☁️",
  HY: "🌧️", Y: "🌧️", KY: "🌧️", HSY: "🌦️", SY: "🌦️", KSY: "🌧️", MSY: "🌦️", GSY: "⛈️", KGY: "⛈️",
  KKY: "🌨️", HKY: "❄️", K: "❄️", YKY: "❄️", DY: "🌨️",
  D: "🌫️", SIS: "🌫️", PUS: "🌫️", R: "💨", GKR: "💨", KKR: "💨", SCK: "☀️", SGK: "❄️", KF: "🌪️",
};
export const WINDY = 35; // km/sa ve üstü: rüzgar işareti

function wmo(code) {
  if (code === 0) return ["Açık", false, "☀️"];
  if (code === 1) return ["Az bulutlu", false, "🌤️"];
  if (code === 2) return ["Parçalı bulutlu", false, "⛅"];
  if (code === 3) return ["Çok bulutlu", false, "☁️"];
  if (code === 45 || code === 48) return ["Sisli", false, "🌫️"];
  if (code >= 51 && code <= 57) return ["Çiseleyen yağmur", true, "🌦️"];
  if (code >= 61 && code <= 65) return ["Yağmurlu", true, "🌧️"];
  if (code === 66 || code === 67) return ["Dondurucu yağmur", true, "🌧️"];
  if (code >= 71 && code <= 77) return ["Kar yağışlı", true, "❄️"];
  if (code >= 80 && code <= 82) return ["Sağanak yağışlı", true, "🌧️"];
  if (code === 85 || code === 86) return ["Kar sağanağı", true, "❄️"];
  if (code >= 95) return ["Gök gürültülü fırtına", true, "⛈️"];
  return ["Değişken hava", false, "🌤️"];
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
const addD = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function mgmDay(d, n) {
  if (d["hadiseGun" + n] == null) return null;
  const code = String(d["hadiseGun" + n]);
  const wind = d["ruzgarHizGun" + n] != null ? Math.round(num(d["ruzgarHizGun" + n], 0, 300)) : null;
  return {
    code, cond: MGM_CODES[code] || "Hava durumu", icon: MGM_ICON[code] || "🌤️", wet: MGM_WET.has(code),
    low: num(d["enDusukGun" + n], -60, 60), high: num(d["enYuksekGun" + n], -60, 60), wind,
    humMin: d["enDusukNemGun" + n] != null ? num(d["enDusukNemGun" + n], 0, 100) : null,
    humMax: d["enYuksekNemGun" + n] != null ? num(d["enYuksekNemGun" + n], 0, 100) : null,
    pop: null,
  };
}

// Meteoroloji Genel Müdürlüğü: sitesinin kendi servisi (resmî, belgeli bir API değil). Bugünden başlayan 5 gün.
export async function fetchMGMDays() {
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
  const out = [];
  for (let n = 1; n <= 5; n++) { try { const x = mgmDay(d, n); if (x) out.push({ offset: n - 1, ...x }); } catch { /* o gün atlanır */ } }
  if (!out.some((x) => x.offset === 0)) throw new Error("bugünün tahmini yok");
  return out;
}
export async function fetchMGM() {
  const t = (await fetchMGMDays()).find((x) => x.offset === 0);
  return { source: "MGM", ...t };
}

// Yedek kaynak: Open-Meteo (ücretsiz, anahtarsız, ticari olmayan kullanım için)
export async function fetchOMDays(past = 5, forecast = 10) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=41.0082&longitude=28.9784"
    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max"
    + `&timezone=Europe%2FIstanbul&past_days=${past}&forecast_days=${forecast}`;
  const j = await getJson(url, 6000, { "User-Agent": UA });
  const d = j && j.daily;
  if (!d || !d.temperature_2m_max || !d.time) throw new Error("veri yok");
  const out = [];
  for (let i = 0; i < d.time.length; i++) {
    try {
      const [cond, wet, icon] = wmo(Number(d.weather_code && d.weather_code[i]));
      const pop = d.precipitation_probability_max && d.precipitation_probability_max[i];
      out.push({
        date: d.time[i], cond, wet, icon,
        low: Math.round(num(d.temperature_2m_min[i], -60, 60)), high: Math.round(num(d.temperature_2m_max[i], -60, 60)),
        wind: d.wind_speed_10m_max && d.wind_speed_10m_max[i] != null ? Math.round(num(d.wind_speed_10m_max[i], 0, 300)) : null,
        humMin: null, humMax: null, pop: pop != null ? Math.round(num(pop, 0, 100)) : null,
      });
    } catch { /* o gün atlanır */ }
  }
  if (!out.length) throw new Error("veri yok");
  return out;
}
export async function fetchOpenMeteo() {
  const today = localNow("Europe/Istanbul").date;
  const days = await fetchOMDays(0, 1);
  const t = days.find((x) => x.date === today) || days[0];
  return { source: "Open-Meteo", ...t };
}

// offset 1 = yarın. MGM bugünden 5 gün verir; olmazsa Open-Meteo
export async function getForecastFor(offset) {
  if (!offset) return getForecast();
  const today = localNow("Europe/Istanbul").date;
  const target = addD(today, offset);
  const errs = [];
  try {
    const x = (await fetchMGMDays()).find((d) => d.offset === offset);
    if (x) return { source: "MGM", ...x, date: target };
    errs.push("MGM: o günün tahmini yok");
  } catch (e) { errs.push("MGM: " + (e && e.message)); }
  try {
    const x = (await fetchOMDays(0, offset + 1)).find((d) => d.date === target);
    if (x) return { source: "Open-Meteo", ...x, note: errs.join("; ") };
    errs.push("Open-Meteo: o günün tahmini yok");
  } catch (e) { errs.push("Open-Meteo: " + (e && e.message)); }
  throw new Error(errs.join(" | "));
}

export async function getForecast() {
  const errs = [];
  try { return await fetchMGM(); } catch (e) { errs.push("MGM: " + (e && e.message)); }
  try { const f = await fetchOpenMeteo(); f.note = errs.join("; "); return f; } catch (e) { errs.push("Open-Meteo: " + (e && e.message)); }
  throw new Error(errs.join(" | "));
}

// Ana sayfa için kayan 5 iş günü: bugünden başlar (hafta sonuysa Pazartesi'den), gün geçtikçe kayar
export async function getWeek() {
  const today = localNow("Europe/Istanbul").date;
  const dow = new Date(today + "T00:00:00Z").getUTCDay();   // 0 Pazar
  const start = dow === 6 ? addD(today, 2) : dow === 0 ? addD(today, 1) : today;
  const targets = [];
  for (let d = start; targets.length < 5; d = addD(d, 1)) {
    const w = new Date(d + "T00:00:00Z").getUTCDay();
    if (w !== 0 && w !== 6) targets.push(d);
  }
  const errs = [];
  let mgm = null, om = null;
  try { mgm = await fetchMGMDays(); } catch (e) { errs.push("MGM: " + (e && e.message)); }
  const by = {};
  if (mgm) mgm.forEach((x) => { by[addD(today, x.offset)] = { ...x, src: "MGM" }; });
  if ([...targets, today].some((d) => !by[d])) {          // MGM'nin 5 gününü aşan günler için
    try { om = await fetchOMDays(0, 10); } catch (e) { errs.push("Open-Meteo: " + (e && e.message)); }
  }
  const omBy = {};
  (om || []).forEach((x) => { omBy[x.date] = { ...x, src: "Open-Meteo" }; });
  if (!mgm && !om) throw new Error(errs.join(" | "));
  const pick = (d) => by[d] || omBy[d] || null;
  const labels = ["Pzt", "Sal", "Çar", "Per", "Cum"];
  const view = (x) => ({
    icon: x.icon, cond: x.cond, low: x.low, high: x.high, wind: x.wind, wet: x.wet,
    windy: x.wind != null && x.wind >= WINDY, humMin: x.humMin, humMax: x.humMax, pop: x.pop, src: x.src,
  });
  const week = targets.map((d) => {
    const x = pick(d);
    const w = new Date(d + "T00:00:00Z").getUTCDay();
    return { date: d, label: labels[w - 1], today: d === today, past: false, na: !x, ...(x ? view(x) : {}) };
  });
  const t = pick(today);
  return { today, monday: start, week, now: t ? view(t) : null, note: errs.join("; ") };
}

// Haftalık tahmin: bir saat önbellekte tutulur (herkes her açışında MGM'yi yormasın)
export async function getWeekCached(s) {
  const today = localNow("Europe/Istanbul").date;
  const cache = await s.get("wxweek", { type: "json" });
  if (cache && cache.data && cache.data.today === today && Date.now() - cache.ts < 3600000) return { ...cache.data, cached: true };
  try {
    const data = await getWeek();
    await s.setJSON("wxweek", { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (cache && cache.data) return { ...cache.data, stale: true };
    throw e;
  }
}

export function buildMessage(f, opts = {}) {
  let day = "";
  try {
    day = opts.tomorrow && f.date
      ? new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", day: "numeric", month: "long", weekday: "long" }).format(new Date(f.date + "T00:00:00Z"))
      : new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "long", weekday: "long" }).format(new Date());
  } catch { /* tarih yazılmaz */ }
  if (opts.tomorrow) return buildTomorrow(f, day);
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

function buildTomorrow(f, day) {
  const src = f.source === "MGM" ? "Meteoroloji Genel Müdürlüğü" : "Open-Meteo";
  const hint = f.wet ? "Şemsiyeni hazırla." : (f.pop != null && f.pop >= 50 ? `Yağış ihtimali %${f.pop}.` : "");
  const body = `${day ? day + ": " : ""}${f.cond}, ${f.low}° / ${f.high}°.${hint ? " " + hint : ""}${f.wind != null ? ` Rüzgar ${f.wind} km/sa.` : ""} (${f.source})`;
  const lines = [
    `İstanbul, ${day || "yarın"} (yarın)`, f.cond,
    `En düşük ${f.low}°, en yüksek ${f.high}°`,
    f.humMin != null && f.humMax != null ? `Nem %${f.humMin} - %${f.humMax}` : null,
    f.wind != null ? `Rüzgar ${f.wind} km/sa` : null,
    hint || null,
    `Kaynak: ${src}`,
  ].filter(Boolean);
  return { title: "Yarının hava durumu, İstanbul", body, full: lines.join("\n") };
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
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { await s.delete("sub/" + pid); await s.delete("assigned/" + pid); await markStale(s, pid, rec); removed++; }
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
  return { enabled: !!c.enabled, nightEnabled: !!c.nightEnabled, recipients: c.recipients || {}, last: c.last || null, lastNight: c.lastNight || null };
}
