import { timingSafeEqual } from "node:crypto";
import { store } from "../lib/push.mjs";
import { getForecast, buildMessage, setupVapid, sendToPids, weatherPayload, loadCfg } from "../lib/weather.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const PID = /^[0-9a-f]{32}$/;
const json = (o, status = 200) => Response.json(o, { status });

// Panel: hava durumu bildirimi alacak kişileri seç, önizle, dene
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!same(b.secret ?? "", secret)) return json({ error: "Şifre yanlış" }, 401);

  const s = store();

  if (b.action === "get") {
    const cfg = await loadCfg(s);
    const { blobs } = await s.list({ prefix: "sub/" });
    const people = [];
    for (const { key } of blobs) {
      const rec = await s.get(key, { type: "json" });
      if (!rec) continue;
      const pid = key.slice(4), r = cfg.recipients[pid];
      people.push({
        id: pid, name: [rec.name, rec.surname].filter(Boolean).join(" "),
        selected: !!r, off: !!(r && r.off),
      });
    }
    people.sort((a, c) => (c.selected - a.selected) || a.name.localeCompare(c.name, "tr"));
    return json({ ok: true, enabled: cfg.enabled, last: cfg.last, people });
  }

  if (b.action === "save") {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => PID.test(x)).slice(0, 200);
    const cfg = await loadCfg(s);
    const next = {};
    const added = [];
    for (const pid of ids) {
      if (!(await s.get("sub/" + pid, { type: "json" }))) continue;
      if (cfg.recipients[pid]) next[pid] = cfg.recipients[pid];
      else { next[pid] = { off: false, added: Date.now() }; added.push(pid); }
    }
    await s.setJSON("weather", { ...cfg, enabled: b.enabled === true, recipients: next });
    // Yeni eklenenlere haber ver, kapatma imkânı olduğunu söylesin
    let notified = 0;
    if (added.length) {
      await setupVapid(s);
      const msg = "Senin için her sabah 10:00'da İstanbul hava durumu bildirimi ayarlandı. İstersen Ayarlar'dan kapatabilirsin.";
      const r = await sendToPids(s, added, {
        title: "Düzen", body: msg, tag: "weather-added-" + Date.now(),
        url: `/?t=${encodeURIComponent("Düzen")}&b=${encodeURIComponent(msg)}`,
      });
      notified = r.sent;
    }
    return json({ ok: true, selected: Object.keys(next).length, added: added.length, notified });
  }

  if (b.action === "preview") {
    try {
      const f = await getForecast();
      const m = buildMessage(f);
      return json({ ok: true, source: f.source, note: f.note || "", title: m.title, body: m.body, full: m.full });
    } catch (e) {
      return json({ error: "Hava durumu alınamadı: " + String(e && e.message).slice(0, 200) }, 502);
    }
  }

  if (b.action === "sendnow") {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => PID.test(x)).slice(0, 200);
    if (!ids.length) return json({ error: "Kimse seçilmedi" }, 400);
    let f;
    try { f = await getForecast(); } catch (e) { return json({ error: "Hava durumu alınamadı: " + String(e && e.message).slice(0, 200) }, 502); }
    const m = buildMessage(f);
    await setupVapid(s);
    const r = await sendToPids(s, ids, weatherPayload(m));
    return json({ ok: true, source: f.source, ...r });
  }

  return json({ error: "Bilinmeyen işlem" }, 400);
};

export const config = { path: "/api/weather" };
