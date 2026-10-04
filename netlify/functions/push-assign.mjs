import { timingSafeEqual } from "node:crypto";
import { store, vapid, webpush } from "../lib/push.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PID = /^[0-9a-f]{32}$/;
const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const json = (o, status = 200) => Response.json(o, { status });

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!same(b.secret ?? "", secret)) return json({ error: "Şifre yanlış" }, 401);

  const s = store();

  if (b.action === "all") {
    const { blobs } = await s.list({ prefix: "assigned/" });
    const items = [];
    for (const { key } of blobs) {
      const pid = key.slice(9);
      const list = (await s.get(key, { type: "json" })) || [];
      const sub = await s.get("sub/" + pid, { type: "json" });
      for (const r of list) {
        items.push({ pid, name: [sub && sub.name, sub && sub.surname].filter(Boolean).join(" "), rid: r.id, text: r.text, time: r.time, days: r.days, off: !!r.off });
      }
    }
    return json({ ok: true, items });
  }

  if (b.action === "del") {
    const pid = String(b.pid || ""), rid = String(b.rid || "");
    if (!PID.test(pid)) return json({ error: "Geçersiz kişi" }, 400);
    const list = (await s.get("assigned/" + pid, { type: "json" })) || [];
    const next = list.filter((r) => r.id !== rid);
    if (next.length) await s.setJSON("assigned/" + pid, next); else await s.delete("assigned/" + pid);
    return json({ ok: true });
  }

  if (b.action === "add") {
    const text = String(b.text ?? "").trim().slice(0, 140);
    const time = String(b.time ?? "");
    const days = (Array.isArray(b.days) ? b.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => PID.test(x)).slice(0, 50);
    if (!text || !TIME.test(time) || !days.length) return json({ error: "Mesaj, saat ve en az bir gün gerekli" }, 400);
    if (!ids.length) return json({ error: "Kimse seçilmedi" }, 400);

    const v = await vapid(s);
    const subject = (process.env.URL || "").startsWith("https://") ? process.env.URL : "mailto:push@example.com";
    webpush.setVapidDetails(subject, v.publicKey, v.privateKey);

    const dayTxt = days.length === 7 ? "her gün" : days.map((d) => DAYS[d]).join(", ");
    let count = 0, skipped = 0, notified = 0;
    for (const pid of ids) {
      const sub = await s.get("sub/" + pid, { type: "json" });
      if (!sub) { skipped++; continue; }
      const list = (await s.get("assigned/" + pid, { type: "json" })) || [];
      if (list.length >= 10) { skipped++; continue; }
      list.push({
        id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text, time, days: [...days].sort(), off: false, created: Date.now(),
      });
      await s.setJSON("assigned/" + pid, list);
      count++;
      // Kişi bilgilensin: bildirimle haber ver
      try {
        await webpush.sendNotification(sub.sub, JSON.stringify({
          title: "Düzen",
          body: `Senin için günlük hatırlatıcı ayarlandı: ${text} (${time}, ${dayTxt}). İstersen Ayarlar'dan kapatabilirsin.`,
          tag: "assigned-" + Date.now(),
        }), { TTL: 3600 });
        notified++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await s.delete("sub/" + pid); await s.delete("assigned/" + pid); }
      }
    }
    return json({ ok: true, count, skipped, notified });
  }

  return json({ error: "Bilinmeyen işlem" }, 400);
};

export const config = { path: "/api/push-assign" };
