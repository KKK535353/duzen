import { store, idOf, ALLOWED } from "../lib/push.mjs";

// Kullanıcının kendi telefonundan: kendisine atanan hatırlatıcıları görür, açıp kapatır
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b;
  try { b = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const sub = b && b.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !ALLOWED.some((r) => r.test(sub.endpoint))) {
    return new Response("Bad subscription", { status: 400 });
  }
  const s = store();
  const pid = idOf(sub.endpoint);
  const exists = await s.get("sub/" + pid, { type: "json" });
  if (!exists) return Response.json({ items: [] });

  const list = (await s.get("assigned/" + pid, { type: "json" })) || [];
  const wcfg = (await s.get("weather", { type: "json" })) || {};
  const wr = wcfg.recipients && wcfg.recipients[pid];
  if (wr && b.weatherOff !== undefined) {
    wr.off = b.weatherOff === true;
    await s.setJSON("weather", wcfg);
  }
  if (b.id !== undefined) {
    const r = list.find((x) => x.id === String(b.id));
    if (r) { r.off = !!b.off; await s.setJSON("assigned/" + pid, list); }
  }
  return Response.json({
    items: list.map(({ id, text, time, days, off }) => ({ id, text, time, days, off: !!off })),
    weather: { selected: !!wr, off: !!(wr && wr.off), card: wr ? wr.card !== false : false, am: wr ? wr.am !== false : false, pm: !!(wr && wr.pm === true) },
  });
};

export const config = { path: "/api/push-assigned" };
