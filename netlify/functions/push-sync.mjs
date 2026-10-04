import { store, idOf, ALLOWED } from "../lib/push.mjs";

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
    return Response.json({ ok: true });
  }

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

  const done = (Array.isArray(b.done) ? b.done : []).slice(0, 300).map((x) => str(x, 80));

  const rec = {
    sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
    name: b.name !== undefined ? str(b.name, 40).trim() : ((old && old.name) || ""),
    tz: str(b.tz, 60) || "Europe/Istanbul",
    meds,
    done,
    sent: (old && old.sent) || {},
    updated: Date.now(),
  };
  await s.setJSON("sub/" + id, rec);
  return Response.json({ ok: true, meds: meds.length });
};

export const config = { path: "/api/push-sync" };
