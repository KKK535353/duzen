import { timingSafeEqual } from "node:crypto";
import { store, vapid, webpush } from "../lib/push.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const PID = /^[0-9a-f]{32}$/;
const json = (o, status = 200) => Response.json(o, { status });
const fullName = (sub) => [sub && sub.name, sub && sub.surname].filter(Boolean).join(" ");

// Panel: gelen kutusu ve cevap
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!same(b.secret ?? "", secret)) return json({ error: "Şifre yanlış" }, 401);

  const s = store();

  if (b.action === "list") {
    const { blobs } = await s.list({ prefix: "thread/" });
    const items = [];
    for (const { key } of blobs) {
      const pid = key.slice(7);
      const th = await s.get(key, { type: "json" });
      if (!th || !th.msgs || !th.msgs.length) continue;
      const sub = await s.get("sub/" + pid, { type: "json" });
      const last = th.msgs[th.msgs.length - 1];
      items.push({
        pid, name: fullName(sub), count: th.msgs.length,
        last: { from: last.from, text: String(last.text).slice(0, 90), ts: last.ts },
        waiting: (th.lastUserTs || 0) > (th.lastAdminTs || 0),
      });
    }
    items.sort((a, c) => (c.waiting - a.waiting) || (c.last.ts - a.last.ts));
    return json({ ok: true, items });
  }

  const pid = String(b.pid || "");
  if (!PID.test(pid)) return json({ error: "Geçersiz kişi" }, 400);

  if (b.action === "thread") {
    const th = (await s.get("thread/" + pid, { type: "json" })) || { msgs: [] };
    const sub = await s.get("sub/" + pid, { type: "json" });
    return json({ ok: true, name: fullName(sub), msgs: th.msgs.map(({ id, from, text, ts }) => ({ id, from, text, ts })) });
  }

  if (b.action === "del") {
    await s.delete("thread/" + pid);
    return json({ ok: true });
  }

  if (b.action === "reply") {
    const text = String(b.text ?? "").trim().slice(0, 500);
    if (!text) return json({ error: "Cevap boş" }, 400);
    const th = await s.get("thread/" + pid, { type: "json" });
    if (!th) return json({ error: "Yazışma bulunamadı" }, 404);
    const now = Date.now();
    th.msgs.push({ id: "a" + now.toString(36) + Math.random().toString(36).slice(2, 5), from: "a", text, ts: now });
    th.msgs = th.msgs.slice(-200);
    th.lastAdminTs = now;
    await s.setJSON("thread/" + pid, th);

    let notified = false;
    const sub = await s.get("sub/" + pid, { type: "json" });
    if (sub) {
      const v = await vapid(s);
      const subject = (process.env.URL || "").startsWith("https://") ? process.env.URL : "mailto:push@example.com";
      webpush.setVapidDetails(subject, v.publicKey, v.privateKey);
      try {
        await webpush.sendNotification(sub.sub, JSON.stringify({
          title: "Düzen", body: "Talebinize yanıt geldi", tag: "reply-" + now, url: "/?open=contact",
        }), { TTL: 86400 });
        notified = true;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await s.delete("sub/" + pid); await s.delete("assigned/" + pid); }
      }
    }
    return json({ ok: true, notified });
  }

  return json({ error: "Bilinmeyen işlem" }, 400);
};

export const config = { path: "/api/push-inbox" };
