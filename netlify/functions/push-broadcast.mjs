import { timingSafeEqual } from "node:crypto";
import { store, vapid, webpush } from "../lib/push.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return Response.json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, { status: 503 });

  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
  if (!same(b.secret ?? "", secret)) return Response.json({ error: "Şifre yanlış" }, { status: 401 });

  const title = String(b.title ?? "").trim().slice(0, 80);
  const body = String(b.body ?? "").trim().slice(0, 300);
  if (!title || !body) return Response.json({ error: "Başlık ve mesaj gerekli" }, { status: 400 });

  const s = store();
  const v = await vapid(s);
  const subject = (process.env.URL || "").startsWith("https://") ? process.env.URL : "mailto:push@example.com";
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);

  let { blobs } = await s.list({ prefix: "sub/" });
  if (b.ids !== undefined) {
    const want = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    if (!want.size) return Response.json({ error: "Kimse seçilmedi" }, { status: 400 });
    blobs = blobs.filter(({ key }) => want.has(key.slice(4)));
  }
  const bid = "b" + Date.now().toString(36);
  const url = `/?t=${encodeURIComponent(title)}&b=${encodeURIComponent(body)}&n=${bid}`;
  const payload = JSON.stringify({ title, body, tag: "duyuru-" + Date.now(), url });
  const important = b.important === true;
  const okPids = [];
  let sent = 0, failed = 0, removed = 0;

  for (let i = 0; i < blobs.length; i += 20) {
    await Promise.all(blobs.slice(i, i + 20).map(async ({ key }) => {
      const rec = await s.get(key, { type: "json" });
      if (!rec) return;
      try {
        await webpush.sendNotification(rec.sub, payload, { TTL: 3600 });
        sent++;
        okPids.push(key.slice(4));
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await s.delete(key); removed++; }
        else { failed++; console.error("broadcast error", e.statusCode, e.body); }
      }
    }));
  }
  if (okPids.length) {   // duyuru kaydı: kimlere gitti, kimler açtı
    await s.setJSON("bc/" + bid, { id: bid, title, body: body.slice(0, 100), sentAt: Date.now(), important, to: okPids, opened: {} });
    try {
      const all = (await s.list({ prefix: "bc/" })).blobs.map((x) => x.key).sort();
      for (const k of all.slice(0, Math.max(0, all.length - 30))) await s.delete(k);
    } catch {}
  }
  if (important && okPids.length) {
    const now = Date.now();
    const cur = (await s.get("pending", { type: "json" })) || { items: [] };
    cur.items = cur.items.filter((i) => now - i.sentAt < 900000);
    okPids.forEach((pid) => cur.items.push({ pid, title, body, url, sentAt: now }));
    await s.setJSON("pending", cur);
  }
  return Response.json({ ok: true, total: blobs.length, sent, failed, removed, important });
};

export const config = { path: "/api/push-broadcast" };
