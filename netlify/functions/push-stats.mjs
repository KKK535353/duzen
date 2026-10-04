import { timingSafeEqual } from "node:crypto";
import { store } from "../lib/push.mjs";

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

  const s = store();
  const { blobs } = await s.list({ prefix: "sub/" });
  const day = 864e5, now = Date.now();
  let active1 = 0, active7 = 0;
  const people = [];
  for (const { key } of blobs) {
    const rec = await s.get(key, { type: "json" });
    if (!rec || !rec.updated) continue;
    if (b.list) people.push({ id: key.slice(4), name: String(rec.name || ""), surname: String(rec.surname || ""), updated: rec.updated });
    const age = now - rec.updated;
    if (age <= day) active1++;
    if (age <= 7 * day) active7++;
  }
  // Yalnızca sayılar döner, kimin ne ilaç kullandığı gösterilmez
  people.sort((a, c) => c.updated - a.updated);
  return Response.json({ ok: true, total: blobs.length, active1, active7, ...(b.list ? { people } : {}) });
};

export const config = { path: "/api/push-stats" };
