import { store, idOf, ALLOWED, localNow } from "../lib/push.mjs";
import { getWeek, loadCfg } from "../lib/weather.mjs";

const TTL = 60 * 60 * 1000;
const json = (o, status = 200) => Response.json(o, { status });

// Uygulama ana sayfası: hava durumu için yetki verilen kişiler haftalık tahmini görür
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const sub = b && b.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !ALLOWED.some((r) => r.test(sub.endpoint))) {
    return json({ error: "Bad subscription" }, 400);
  }
  const s = store();
  const pid = idOf(sub.endpoint);
  if (!(await s.get("sub/" + pid, { type: "json" }))) return json({ error: "not-selected" }, 403);
  const cfg = await loadCfg(s);
  if (!cfg.recipients[pid]) return json({ error: "not-selected" }, 403);

  const today = localNow("Europe/Istanbul").date;
  const cache = await s.get("wxweek", { type: "json" });
  if (cache && cache.data && cache.data.today === today && Date.now() - cache.ts < TTL) {
    return json({ ok: true, ...cache.data, cached: true });
  }
  try {
    const data = await getWeek();
    await s.setJSON("wxweek", { ts: Date.now(), data });
    return json({ ok: true, ...data });
  } catch (e) {
    console.error("weather-week:", e && e.message);
    if (cache && cache.data) return json({ ok: true, ...cache.data, stale: true });
    return json({ error: "Hava durumu şu an alınamıyor" }, 502);
  }
};

export const config = { path: "/api/weather-week" };
