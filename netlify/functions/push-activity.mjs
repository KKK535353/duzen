import { timingSafeEqual } from "node:crypto";
import { store, localNow } from "../lib/push.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const fmtDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const full = (r) => [r && r.name, r && r.surname].filter(Boolean).join(" ");

// Panel: kim uygulamayı açtı, kim bildirime dokundu
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.BROADCAST_SECRET;
  if (!secret) return Response.json({ error: "Sunucuda BROADCAST_SECRET tanımlı değil" }, { status: 503 });
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
  if (!same(b.secret ?? "", secret)) return Response.json({ error: "Şifre yanlış" }, { status: 401 });

  const s = store();
  const now = Date.now();
  const today = fmtDate(now);

  // Bildirim günlüğü: kime, ne zaman, ne gönderildi, gitti mi, dokundu mu
  if (b.log === true) {
    const OPEN_WINDOW = 30 * 60000;
    const keysL = (await s.list({ prefix: "sub/" })).blobs;
    const entries = [], missed = [];
    for (const { key } of keysL) {
      const rec = await s.get(key, { type: "json" });
      if (!rec) continue;
      const pid = key.slice(4);
      const name = full(rec) || ("İsimsiz (" + pid.slice(0, 4) + ")");
      const share = rec.shareMeds === true;                 // ilaç adı yalnızca kendisi paylaşmayı açtıysa görünür
      const recent = (rec.act && rec.act.recent) || [];
      for (const e of rec.log || []) {
        if (now - e.ts > 3 * 864e5) continue;               // 3 günden eski kayıtlar gösterilmez
        const openTs = recent.find((x) => x >= e.ts && x <= e.ts + OPEN_WINDOW);
        entries.push({
          ts: e.ts, name, kind: e.kind, sched: e.sched || "", med: share ? (e.med || "") : "",
          res: e.res, code: e.code || 0, opened: !!openTs, openAfterMin: openTs ? Math.round((openTs - e.ts) / 60000) : null,
        });
      }
      // Bugün zamanı geçtiği halde ilk ilaç bildirimi görünmeyenler
      const L = localNow(rec.tz);
      const doneSet = new Set(rec.done || []);
      for (const m of rec.meds || []) {
        if (L.date < m.start || (m.end && L.date > m.end) || !(m.days || []).includes(L.wd)) continue;
        for (const t of m.times || []) {
          const [h, mm] = t.split(":").map(Number);
          if (L.min - (h * 60 + mm) < 6) continue;           // henüz erken ya da gönderim penceresinde
          const slot = `${L.date}|${m.id}|${t}`;
          if (doneSet.has(slot) || (rec.sent || {})[slot + "|1"]) continue;
          missed.push({ name, sched: t, med: share ? m.name : "" });
        }
      }
    }
    entries.sort((a, c) => c.ts - a.ts);
    const t0 = Date.parse(today + "T00:00:00+03:00");
    const todayE = entries.filter((e) => e.ts >= t0);
    return Response.json({
      ok: true, entries: entries.slice(0, 80), missed,
      summary: {
        sentToday: todayE.filter((e) => e.res === "ok").length,
        failedToday: todayE.filter((e) => e.res === "fail").length,
        missedToday: missed.length,
      },
    });
  }
  const last7 = new Set(Array.from({ length: 7 }, (_, i) => fmtDate(now - i * 864e5)));

  const { blobs } = await s.list({ prefix: "sub/" });
  const people = [], names = {};
  for (const { key } of blobs) {
    const rec = await s.get(key, { type: "json" });
    if (!rec) continue;
    const pid = key.slice(4);
    const act = rec.act || {};
    const days = act.days || {};
    let opens7 = 0, notifs7 = 0;
    for (const [d, v] of Object.entries(days)) if (last7.has(d)) { opens7 += v.o || 0; notifs7 += v.n || 0; }
    names[pid] = full(rec) || ("İsimsiz (" + pid.slice(0, 4) + ")");
    people.push({
      id: pid, name: full(rec), updated: rec.updated || 0,
      lastOpen: act.lastOpen || 0, lastNotif: act.lastNotif || null,
      opensToday: (days[today] && days[today].o) || 0, notifsToday: (days[today] && days[today].n) || 0,
      opens7, notifs7,
    });
  }
  people.sort((a, c) => (c.lastOpen || c.updated) - (a.lastOpen || a.updated));

  const bcKeys = (await s.list({ prefix: "bc/" })).blobs.map((x) => x.key).sort().reverse().slice(0, 15);
  const broadcasts = [];
  for (const k of bcKeys) {
    const bc = await s.get(k, { type: "json" });
    if (!bc) continue;
    const opened = Object.keys(bc.opened || {});
    broadcasts.push({
      id: bc.id, title: bc.title, body: bc.body, sentAt: bc.sentAt, important: !!bc.important, silent: !!bc.silent,
      sent: (bc.to || []).length, opened: opened.length,
      openedNames: opened.map((p) => names[p]).filter(Boolean),
      notOpenedNames: (bc.to || []).filter((p) => !(bc.opened || {})[p]).map((p) => names[p]).filter(Boolean),
    });
  }

  // Bildirim kaydı geçersiz olduğu için silinenler (kişi uygulamayı açıp kaydı yenileyene kadar listelenir)
  const stale = [];
  for (const { key } of (await s.list({ prefix: "stale/" })).blobs) {
    const st = await s.get(key, { type: "json" });
    if (!st || now - st.ts > 30 * 864e5) continue;
    const renewed = people.some((p) => p.name && p.name === st.name && (p.updated || 0) > st.ts);
    if (!renewed) stale.push({ name: st.name || "İsimsiz", ts: st.ts });
  }
  stale.sort((a, c) => c.ts - a.ts);

  return Response.json({
    ok: true, people, broadcasts, stale,
    totals: {
      people: people.length,
      openedToday: people.filter((p) => p.opensToday > 0).length,
      opened7: people.filter((p) => p.opens7 > 0).length,
      notifToday: people.filter((p) => p.notifsToday > 0).length,
    },
  });
};

export const config = { path: "/api/push-activity" };
