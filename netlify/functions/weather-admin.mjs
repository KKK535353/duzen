import { timingSafeEqual } from "node:crypto";
import { store } from "../lib/push.mjs";
import { getForecast, getForecastFor, buildMessage, setupVapid, sendToPids, weatherPayload, loadCfg } from "../lib/weather.mjs";

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
        card: r ? r.card !== false : false, am: r ? r.am !== false : false, pm: !!(r && r.pm === true),
      });
    }
    people.sort((a, c) => (c.selected - a.selected) || a.name.localeCompare(c.name, "tr"));
    return json({ ok: true, enabled: cfg.enabled, nightEnabled: cfg.nightEnabled, last: cfg.last, lastNight: cfg.lastNight, people });
  }

  if (b.action === "save") {
    // items: [{id, card, am, pm}]  (eski panel: ids -> ana sayfa + sabah)
    const raw = Array.isArray(b.items) ? b.items
      : (Array.isArray(b.ids) ? b.ids.map((id) => ({ id, card: true, am: true, pm: false })) : []);
    const items = raw.filter((x) => x && PID.test(String(x.id))).slice(0, 200);
    const cfg = await loadCfg(s);
    const next = {};
    const notes = [];
    for (const x of items) {
      const pid = String(x.id);
      const flags = { card: x.card === true, am: x.am === true, pm: x.pm === true };
      if (!flags.card && !flags.am && !flags.pm) continue;
      if (!(await s.get("sub/" + pid, { type: "json" }))) continue;
      const prev = cfg.recipients[pid];
      const was = { am: prev ? prev.am !== false : false, pm: !!(prev && prev.pm === true) };
      next[pid] = { off: prev ? !!prev.off : false, added: prev ? prev.added : Date.now(), ...flags };
      const parts = [];
      if (flags.am && !was.am) parts.push("her sabah 10:00'da bugünün");
      if (flags.pm && !was.pm) parts.push("her gece 23:00'da yarının");
      if (parts.length) notes.push({ pid, parts });
    }
    await s.setJSON("weather", { ...cfg, enabled: b.enabled === true, nightEnabled: b.nightEnabled === true, recipients: next });
    // Yeni bir bildirim türü eklenen kişilere haber ver
    let notified = 0;
    if (notes.length && b.notify === true) {
      await setupVapid(s);
      for (const n of notes) {
        const msg = `Senin için ${n.parts.join(" ve ")} İstanbul hava durumu bildirimi ayarlandı. İstersen Ayarlar'dan kapatabilirsin.`;
        const r = await sendToPids(s, [n.pid], {
          title: "Düzen", body: msg, tag: "weather-added-" + Date.now(),
          url: `/?t=${encodeURIComponent("Düzen")}&b=${encodeURIComponent(msg)}`,
        });
        notified += r.sent;
      }
    }
    return json({ ok: true, selected: Object.keys(next).length, added: notes.length, notified });
  }

  if (b.action === "preview") {
    try {
      const tomorrow = b.which === "tomorrow";
      const f = tomorrow ? await getForecastFor(1) : await getForecast();
      const m = buildMessage(f, { tomorrow });
      return json({ ok: true, which: tomorrow ? "tomorrow" : "today", source: f.source, note: f.note || "", title: m.title, body: m.body, full: m.full });
    } catch (e) {
      return json({ error: "Hava durumu alınamadı: " + String(e && e.message).slice(0, 200) }, 502);
    }
  }

  if (b.action === "sendnow") {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => PID.test(x)).slice(0, 200);
    if (!ids.length) return json({ error: "Kimse seçilmedi" }, 400);
    const tomorrow = b.which === "tomorrow";
    let f;
    try { f = tomorrow ? await getForecastFor(1) : await getForecast(); } catch (e) { return json({ error: "Hava durumu alınamadı: " + String(e && e.message).slice(0, 200) }, 502); }
    const m = buildMessage(f, { tomorrow });
    await setupVapid(s);
    const r = await sendToPids(s, ids, weatherPayload(m));
    return json({ ok: true, source: f.source, ...r });
  }

  return json({ error: "Bilinmeyen işlem" }, 400);
};

export const config = { path: "/api/weather" };
