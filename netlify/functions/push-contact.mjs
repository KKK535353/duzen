import { store, idOf, ALLOWED } from "../lib/push.mjs";

const DAY = 864e5, KEEP = 60 * DAY, MAX_MSGS = 200;
const json = (o, status = 200) => Response.json(o, { status });

// Kullanıcının telefonundan: "Bize ulaşın" yazışması
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
  const exists = await s.get("sub/" + pid, { type: "json" });
  if (!exists) return json({ error: "Önce arka plan bildirimlerini aç", msgs: [], unread: 0 }, 400);

  const now = Date.now();
  const th = (await s.get("thread/" + pid, { type: "json" })) || { msgs: [], seenTs: 0, lastUserTs: 0, lastAdminTs: 0 };
  th.msgs = th.msgs.filter((m) => now - m.ts < KEEP);
  let dirty = false;

  if (b.action === "send") {
    const text = String(b.text ?? "").trim().slice(0, 500);
    if (!text) return json({ error: "Mesaj boş" }, 400);
    const recent = th.msgs.filter((m) => m.from === "u" && now - m.ts < DAY);
    if (recent.length >= 20) return json({ error: "Bugün çok mesaj gönderdin, yarın tekrar dene" }, 429);
    if (recent.length && now - recent[recent.length - 1].ts < 3000) return json({ error: "Biraz yavaş, birkaç saniye sonra tekrar dene" }, 429);
    th.msgs.push({ id: "u" + now.toString(36) + Math.random().toString(36).slice(2, 5), from: "u", text, ts: now });
    th.msgs = th.msgs.slice(-MAX_MSGS);
    th.lastUserTs = now;
    dirty = true;
  }
  if (b.seen === true) { th.seenTs = now; dirty = true; }
  if (dirty) await s.setJSON("thread/" + pid, th);

  const unread = th.msgs.filter((m) => m.from === "a" && m.ts > (th.seenTs || 0)).length;
  return json({
    ok: true, unread,
    msgs: th.msgs.slice(-50).map(({ id, from, text, ts }) => ({ id, from, text, ts })),
  });
};

export const config = { path: "/api/push-contact" };
