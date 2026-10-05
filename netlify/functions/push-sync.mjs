import { store, idOf, ALLOWED, localNow } from "../lib/push.mjs";
import { getWeekCached } from "../lib/weather.mjs";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v ?? "").slice(0, n);

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b;
  try { b = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const sub = b && b.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys || !sub.keys.p256dh || !sub.keys.auth ||
      !ALLOWED.some((r) => r.test(sub.endpoint))) {
    return new Response("Bad subscription", { status: 400 });
  }

  const s = store();
  const id = idOf(sub.endpoint);

  if (b.unsubscribe) {
    await s.delete("sub/" + id);
    await s.delete("assigned/" + id);
    return Response.json({ ok: true });
  }

  if (await s.get("removed/" + id, { type: "json" })) return Response.json({ removed: true }, { status: 403 });

  // Bu bildirim kaydı daha önce geçersiz çıkmış: aynı kaydı yeniden oluşturma, uygulamaya aboneliği yenilemesini söyle
  if (await s.get("stale/" + id, { type: "json" })) return Response.json({ ok: true, resubscribe: true });

  const old = await s.get("sub/" + id, { type: "json" });
  if (!old) {
    const { blobs } = await s.list({ prefix: "sub/" });
    if (blobs.length >= 200) return new Response("Too many subscriptions", { status: 429 });
  }

  const meds = (Array.isArray(b.meds) ? b.meds : []).slice(0, 60).map((m) => ({
    id: str(m.id, 40),
    name: str(m.name, 80),
    dose: str(m.dose, 80),
    times: (Array.isArray(m.times) ? m.times : []).filter((t) => TIME.test(t)).slice(0, 12),
    days: (Array.isArray(m.days) ? m.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    start: DATE.test(m.start) ? m.start : "0000-01-01",
    end: DATE.test(m.end) ? m.end : "",
  })).filter((m) => m.id && m.name && m.times.length && m.days.length);

  const rem = (Array.isArray(b.rem) ? b.rem : []).slice(0, 20).map((r) => ({
    id: str(r.id, 40),
    text: str(r.text, 140).trim(),
    time: TIME.test(r.time) ? r.time : "",
    days: (Array.isArray(r.days) ? r.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  })).filter((r) => r.id && r.text && r.time && r.days.length);

  const appts = (Array.isArray(b.appts) ? b.appts : []).slice(0, 20).map((a) => ({
    id: str(a && a.id, 40),
    title: str(a && a.title, 80).trim(),
    place: str(a && a.place, 80).trim(),
    date: DATE.test(a && a.date) ? a.date : "",
    time: TIME.test(a && a.time) ? a.time : "",
    d1: !!(a && a.d1),
    h2: !!(a && a.h2),
    w1: !(a && a.w1 === false),
    d3: !(a && a.d3 === false),
  })).filter((a) => a.id && a.title && a.date && a.time);

  const snz = (Array.isArray(b.snz) ? b.snz : []).slice(0, 30)
    .map((z) => ({ slot: str(z && z.slot, 80), until: Number(z && z.until) }))
    .filter((z) => z.slot && Number.isFinite(z.until));

  // Etkinlik: uygulamayı açma ve bildirime dokunma sayıları (içerik tutulmaz)
  const tzName = str(b.tz, 60) || "Europe/Istanbul";
  const evs = (Array.isArray(b.evs) ? b.evs : []).slice(0, 5).map((e) => ({
    type: e && e.type === "notif" ? "notif" : "open",
    kind: str(e && e.kind, 20),
    ref: /^b[0-9a-z]{4,14}$/.test(String((e && e.ref) || "")) ? e.ref : "",
  }));
  const act = { lastOpen: 0, lastNotif: null, days: {}, ...((old && old.act) || {}) };
  act.days = { ...(act.days || {}) };
  if (evs.length) {
    const day = localNow(tzName).date, tsNow = Date.now();
    for (const e of evs) {
      const d = (act.days[day] = act.days[day] || { o: 0, n: 0 });
      d.o++;
      act.lastOpen = tsNow;
      act.recent = [...(act.recent || []), tsNow].filter((x) => tsNow - x < 3 * 864e5).slice(-40);
      if (e.type === "notif") { d.n++; act.lastNotif = { ts: tsNow, kind: e.kind || "bildirim" }; }
    }
    const keys = Object.keys(act.days).sort();
    while (keys.length > 14) delete act.days[keys.shift()];
  }

  const done = (Array.isArray(b.done) ? b.done : []).slice(0, 300).map((x) => str(x, 80));

  const rec = {
    sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
    name: b.name !== undefined ? str(b.name, 40).trim() : ((old && old.name) || ""),
    surname: b.surname !== undefined ? str(b.surname, 40).trim() : ((old && old.surname) || ""),
    tz: str(b.tz, 60) || "Europe/Istanbul",
    meds,
    rem: b.rem !== undefined ? rem : ((old && old.rem) || []),
    appts: b.appts !== undefined ? appts : ((old && old.appts) || []),
    snz: b.snz !== undefined ? snz : ((old && old.snz) || []),
    shareMeds: b.shareMeds !== undefined ? b.shareMeds === true : !!(old && old.shareMeds),
    done,
    act,
    created: (old && old.created) || Date.now(),
    log: (old && old.log) || [],
    sent: (old && old.sent) || {},
    updated: Date.now(),
  };
  await s.setJSON("sub/" + id, rec);
  // Duyuruyu bildirimden açtıysa duyurunun "açtı" listesine ekle
  for (const e of evs) {
    if (e.type !== "notif" || !e.ref) continue;
    const bc = await s.get("bc/" + e.ref, { type: "json" });
    if (bc && bc.opened && !bc.opened[id]) { bc.opened[id] = Date.now(); await s.setJSON("bc/" + e.ref, bc); }
  }
  const out = { ok: true, meds: meds.length };
  // Uygulama hava durumu isterse ve kişi panelden yetkilendirilmişse haftalık tahmini yanıta ekle
  if (b.wx === true) {
    try {
      const cfg = await s.get("weather", { type: "json" });
      if (cfg && cfg.recipients && cfg.recipients[id]) {
        try { out.weather = await getWeekCached(s); }
        catch (e) { out.weather = { error: true }; console.error("push-sync: hava durumu alınamadı", e && e.message); }
      } else out.weatherSelected = false;
    } catch { /* hava durumu hata verse de eşitleme başarılı sayılır */ }
  }
  return Response.json(out);
};

export const config = { path: "/api/push-sync" };
