import { timingSafeEqual } from "node:crypto";
import { store } from "../lib/push.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const PID = /^[0-9a-f]{32}$/;
const json = (o, status = 200) => Response.json(o, { status });

// Panel: bir kişiyi sunucudan sil
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!same(b.secret ?? "", secret)) return json({ error: "Şifre yanlış" }, 401);

  if (b.action === "del") {
    const pid = String(b.pid || "");
    if (!PID.test(pid)) return json({ error: "Geçersiz kişi" }, 400);
    const s = store();
    await s.delete("sub/" + pid);        // bildirim kaydı, ilaç listesi, hatırlatıcılar, etkinlik
    await s.delete("assigned/" + pid);   // panelden atanan hatırlatıcılar
    await s.delete("thread/" + pid);     // "Bize ulaşın" yazışması
    const pend = await s.get("pending", { type: "json" });
    if (pend && Array.isArray(pend.items)) {
      pend.items = pend.items.filter((i) => i.pid !== pid);
      await s.setJSON("pending", pend);
    }
    const wcfg = await s.get("weather", { type: "json" });
    if (wcfg && wcfg.recipients && wcfg.recipients[pid]) { delete wcfg.recipients[pid]; await s.setJSON("weather", wcfg); }
    // Telefon bir sonraki açılışta kendiliğinden yeniden kayıt olmasın diye işaret bırak
    await s.setJSON("removed/" + pid, { ts: Date.now() });
    return json({ ok: true });
  }
  return json({ error: "Bilinmeyen işlem" }, 400);
};

export const config = { path: "/api/push-users" };
