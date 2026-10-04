import { store, vapid, webpush, localNow } from "../lib/push.mjs";

export default async () => {
  const s = store();
  const v = await vapid(s);
  const subject = (process.env.URL || "").startsWith("https://") ? process.env.URL : "mailto:push@example.com";
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);

  const { blobs } = await s.list({ prefix: "sub/" });
  let sentCount = 0;

  for (const { key } of blobs) {
    const rec = await s.get(key, { type: "json" });
    if (!rec) continue;
    const now = localNow(rec.tz);
    rec.sent = rec.sent || {};
    let changed = false, gone = false;

    for (const k of Object.keys(rec.sent)) {
      if (!k.startsWith(now.date)) { delete rec.sent[k]; changed = true; }
    }
    const done = new Set(rec.done || []);

    for (const m of rec.meds || []) {
      if (now.date < m.start || (m.end && now.date > m.end) || !m.days.includes(now.wd)) continue;
      for (const t of m.times) {
        const [h, mm] = t.split(":").map(Number);
        const diff = now.min - (h * 60 + mm);
        const slot = `${now.date}|${m.id}|${t}`;
        let stage = 0;
        if (diff >= 0 && diff <= 2 && !done.has(slot)) stage = 1;
        else if (diff >= 10 && diff <= 12 && !done.has(slot)) stage = 2;
        if (!stage || rec.sent[slot + "|" + stage]) continue;

        rec.sent[slot + "|" + stage] = 1;
        changed = true;
        const payload = JSON.stringify({
          title: (stage === 2 ? "Hatırlatma: " : "İlaç vakti: ") + m.name,
          body: stage === 2 ? `${t} dozunu henüz işaretlemedin` : (m.dose ? `${t}, ${m.dose}` : `${t}, dozunu almayı unutma`),
          tag: slot,
        });
        try {
          await webpush.sendNotification(rec.sub, payload, { TTL: 600, urgency: "high" });
          sentCount++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) { await s.delete(key); gone = true; break; }
          console.error("push error", e.statusCode, e.body);
        }
      }
      if (gone) break;
    }
    if (changed && !gone) await s.setJSON(key, rec);
  }
  console.log("push-cron: gönderilen", sentCount);
};

export const config = { schedule: "* * * * *" };
