import webpush from "web-push";
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

export { webpush };
export const store = () => getStore({ name: "duzen", consistency: "strong" });

export async function vapid(s) {
  let v = await s.get("vapid", { type: "json" });
  if (!v) {
    v = webpush.generateVAPIDKeys();
    await s.setJSON("vapid", v);
  }
  return v;
}

export const idOf = (endpoint) =>
  createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

// Yalnızca bilinen push servislerine gönderim yapılır
export const ALLOWED = [
  /^https:\/\/fcm\.googleapis\.com\//,
  /^https:\/\/[a-z0-9.-]+\.push\.apple\.com\//,
  /^https:\/\/updates\.push\.services\.mozilla\.com\//,
  /^https:\/\/[a-z0-9.-]+\.notify\.windows\.com\//,
];

export function localNow(tz) {
  const make = (zone) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    });
  let f;
  try { f = make(tz); } catch { f = make("Europe/Istanbul"); }
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    min: Number(p.hour) * 60 + Number(p.minute),
    wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday),
  };
}
