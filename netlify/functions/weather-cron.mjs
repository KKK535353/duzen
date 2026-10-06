import { store, localNow } from "../lib/push.mjs";
import { getForecast, getForecastFor, buildMessage, setupVapid, sendToPids, weatherPayload, loadCfg } from "../lib/weather.mjs";

const addD = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// İstanbul saatiyle: 10:00 bugünün tahmini, 23:00 yarının tahmini. Türkiye UTC+3 olduğu için 07:00 ve 20:00 UTC.
// Her biri başarısız olursa 5 dakika arayla iki kez daha dener.
export default async () => {
  const s = store();
  const L = localNow("Europe/Istanbul");
  const hour = Math.floor(L.min / 60);
  if (hour === 10) return morning(s, L.date);
  if (hour === 23) return night(s, L.date);
};

async function morning(s, today) {
  const cfg = await loadCfg(s);
  if (!cfg.enabled) return;
  if (cfg.last && cfg.last.date === today && cfg.last.ok) return;   // bugün zaten gönderildi

  const pids = Object.entries(cfg.recipients).filter(([, v]) => v && v.am !== false && !v.off).map(([k]) => k);
  if (!pids.length) return;

  let f;
  try { f = await getForecast(); }
  catch (e) {
    console.error("weather-cron: tahmin alınamadı", e && e.message);
    const cur = await loadCfg(s);
    await s.setJSON("weather", { ...cur, last: { date: today, ok: false, error: String(e && e.message).slice(0, 300), at: Date.now() } });
    return;
  }
  const m = buildMessage(f);
  await setupVapid(s);
  const r = await sendToPids(s, pids, weatherPayload(m));
  const cur = await loadCfg(s);
  await s.setJSON("weather", { ...cur, last: { date: today, ok: true, at: Date.now(), sent: r.sent, failed: r.failed, source: f.source, body: m.body, note: f.note || "" } });
  console.log("weather-cron (sabah): gönderilen", r.sent, "kaynak", f.source);
}

async function night(s, today) {
  const cfg = await loadCfg(s);
  if (!cfg.nightEnabled) return;
  const forDate = addD(today, 1);
  if (cfg.lastNight && cfg.lastNight.forDate === forDate && cfg.lastNight.ok) return;   // yarının tahmini zaten gönderildi

  const pids = Object.entries(cfg.recipients).filter(([, v]) => v && v.pm === true && !v.off).map(([k]) => k);
  if (!pids.length) return;

  let f;
  try { f = await getForecastFor(1); }
  catch (e) {
    console.error("weather-cron (gece): tahmin alınamadı", e && e.message);
    const cur = await loadCfg(s);
    await s.setJSON("weather", { ...cur, lastNight: { forDate, ok: false, error: String(e && e.message).slice(0, 300), at: Date.now() } });
    return;
  }
  const m = buildMessage(f, { tomorrow: true });
  await setupVapid(s);
  const r = await sendToPids(s, pids, weatherPayload(m));
  const cur = await loadCfg(s);
  await s.setJSON("weather", { ...cur, lastNight: { forDate, ok: true, at: Date.now(), sent: r.sent, failed: r.failed, source: f.source, body: m.body, note: f.note || "" } });
  console.log("weather-cron (gece): gönderilen", r.sent, "kaynak", f.source);
}

export const config = { schedule: "0,5,10 7,20 * * *" };
