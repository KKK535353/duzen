import { timingSafeEqual } from "node:crypto";
import { store } from "../lib/push.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Panel: ilaç listesini paylaşmayı KENDİSİ açan kişilerin ilaçları (diğerlerinin ilaç bilgisi bu yanıtta hiç yer almaz)
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return Response.json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, { status: 503 });
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
  if (!same(b.secret ?? "", secret)) return Response.json({ error: "Şifre yanlış" }, { status: 401 });

  const s = store();
  const { blobs } = await s.list({ prefix: "sub/" });
  const people = [];
  let notSharing = 0;
  for (const { key } of blobs) {
    const rec = await s.get(key, { type: "json" });
    if (!rec) continue;
    if (rec.shareMeds !== true) { notSharing++; continue; }
    const pid = key.slice(4);
    people.push({
      id: pid,
      name: [rec.name, rec.surname].filter(Boolean).join(" ") || "İsimsiz (" + pid.slice(0, 4) + ")",
      updated: rec.updated || 0,
      meds: (rec.meds || []).map((m) => ({
        name: m.name, dose: m.dose || "", times: m.times || [], days: m.days || [],
        start: m.start && m.start !== "0000-01-01" ? m.start : "", end: m.end || "",
      })),
    });
  }
  people.sort((a, c) => a.name.localeCompare(c.name, "tr"));
  return Response.json({ ok: true, people, sharing: people.length, notSharing });
};

export const config = { path: "/api/push-meds" };
