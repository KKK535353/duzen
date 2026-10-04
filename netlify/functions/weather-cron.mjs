import { store, localNow } from "../lib/push.mjs";
import { getForecast, buildMessage, setupVapid, sendToPids, weatherPayload, loadCfg } from "../lib/weather.mjs";

// Her sabah 10:00 (İstanbul) hava durumu bildirimi. Türkiye UTC+3 olduğu için 07:00 UTC.
// Başarısız olursa 5 dakika arayla iki kez daha dener.
export default async () => {
  const s = store();
  const cfg = await loadCfg(s);
  const today = localNow("Europe/Istanbul").date;
  if (!cfg.enabled) return;
  if (cfg.last && cfg.last.date === today && cfg.last.ok) return;   // bugün zaten gönderildi

  const pids = Object.entries(cfg.recipients).filter(([, v]) => !(v && v.off)).map(([k]) => k);
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
  console.log("weather-cron: gönderilen", r.sent, "kaynak", f.source);
};

export const config = { schedule: "0,5,10 7 * * *" };
