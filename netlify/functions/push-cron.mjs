import { store, vapid, webpush, localNow } from "../lib/push.mjs";

const enc = encodeURIComponent;
const infoUrl = (t, b) => `/?t=${enc(t)}&b=${enc(b)}`;

export default async () => {
  const s = store();
  const v = await vapid(s);
  const subject = (process.env.URL || "").startsWith("https://") ? process.env.URL : "mailto:push@example.com";
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);

  const { blobs } = await s.list({ prefix: "sub/" });
  const pend = (await s.get("pending", { type: "json" })) || { items: [] };
  const handled = new Set();
  let sentCount = 0;

  for (const { key } of blobs) {
    const pid = key.slice(4);
    const rec = await s.get(key, { type: "json" });
    if (!rec) continue;
    const now = localNow(rec.tz);
    const nowMs = Date.now();
    rec.sent = rec.sent || {};
    let changed = false, gone = false;

    for (const k of Object.keys(rec.sent)) {
      if (!k.startsWith(now.date)) { delete rec.sent[k]; changed = true; }
    }
    const done = new Set(rec.done || []);

    // true: gönderildi, false: abonelik geçersiz (kayıt silindi)
    const deliver = async (payload) => {
      try {
        await webpush.sendNotification(rec.sub, JSON.stringify(payload), { TTL: 600, urgency: "high" });
        sentCount++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await s.delete(key); await s.delete("assigned/" + pid);
          return false;
        }
        console.error("push error", e.statusCode, e.body);
      }
      return true;
    };

    // 1) İlaç saatleri: ilk bildirim, 3 dk sonra (açılmadıysa ve işaretlenmediyse) bir kez daha
    for (const m of rec.meds || []) {
      if (gone) break;
      if (now.date < m.start || (m.end && now.date > m.end) || !m.days.includes(now.wd)) continue;
      for (const t of m.times) {
        const [h, mm] = t.split(":").map(Number);
        const diff = now.min - (h * 60 + mm);
        const slot = `${now.date}|${m.id}|${t}`;
        const v1 = rec.sent[slot + "|1"];
        const t1 = typeof v1 === "number" && v1 > 1e12 ? v1 : 0;
        const opened = t1 > 0 && (rec.updated || 0) > t1;
        const snoozed = (rec.snz || []).some((z) => z.slot === slot && z.until > nowMs);
        let stage = 0;
        if (diff >= 0 && diff <= 2 && !done.has(slot)) stage = 1;
        else if (diff >= 3 && diff <= 5 && !done.has(slot) && !opened && !snoozed) stage = 2;
        if (!stage || rec.sent[slot + "|" + stage]) continue;

        rec.sent[slot + "|" + stage] = nowMs;
        changed = true;
        const ok = await deliver({
          title: (stage === 2 ? "Hatırlatma: " : "İlaç vakti: ") + m.name,
          body: stage === 2 ? `${t} dozunu henüz işaretlemedin` : (m.dose ? `${t}, ${m.dose}` : `${t}, dozunu almayı unutma`),
          tag: slot,
          url: `/?slot=${enc(slot)}`,
        });
        if (!ok) { gone = true; break; }
      }
    }

    // 1b) Ertelenen dozlar: erteleme süresi dolunca bildirim
    for (const z of rec.snz || []) {
      if (gone) break;
      const [date, medId, time] = z.slot.split("|");
      if (date !== now.date || nowMs < z.until || nowMs > z.until + 180000 || done.has(z.slot)) continue;
      const m = (rec.meds || []).find((x) => x.id === medId);
      const k = `${z.slot}|z${z.until}`;
      if (!m || rec.sent[k]) continue;
      rec.sent[k] = nowMs;
      changed = true;
      const ok = await deliver({
        title: "İlaç vakti: " + m.name,
        body: `${time} dozunu ertelemiştin`,
        tag: z.slot,
        url: `/?slot=${enc(z.slot)}`,
      });
      if (!ok) gone = true;
    }

    // 2) Kişinin kendi günlük hatırlatıcıları (su içme vb.)
    for (const r of rec.rem || []) {
      if (gone) break;
      if (!r.days.includes(now.wd)) continue;
      const [h, mm] = r.time.split(":").map(Number);
      const diff = now.min - (h * 60 + mm);
      if (diff < 0 || diff > 2) continue;
      const k = `${now.date}|r:${r.id}|${r.time}|1`;
      if (rec.sent[k]) continue;
      rec.sent[k] = nowMs;
      changed = true;
      const ok = await deliver({ title: "Düzen", body: r.text, tag: `${now.date}|r:${r.id}`, url: infoUrl("Düzen", r.text) });
      if (!ok) gone = true;
    }

    // 3) Panelden bu kişiye atanmış günlük hatırlatıcılar
    const asg = gone ? [] : ((await s.get("assigned/" + pid, { type: "json" })) || []);
    for (const r of asg) {
      if (gone) break;
      if (r.off || !r.days.includes(now.wd)) continue;
      const [h, mm] = r.time.split(":").map(Number);
      const diff = now.min - (h * 60 + mm);
      if (diff < 0 || diff > 2) continue;
      const k = `${now.date}|a:${r.id}|${r.time}|1`;
      if (rec.sent[k]) continue;
      rec.sent[k] = nowMs;
      changed = true;
      const ok = await deliver({ title: "Düzen", body: r.text, tag: `${now.date}|a:${r.id}`, url: infoUrl("Düzen", r.text) });
      if (!ok) gone = true;
    }

    // 4) "Önemli" duyurular: 3 dk içinde açılmadıysa bir kez tekrar
    for (const it of pend.items) {
      if (gone) break;
      if (it.pid !== pid || handled.has(`${it.pid}|${it.sentAt}`)) continue;
      const age = nowMs - it.sentAt;
      if (age < 180000) continue;
      handled.add(`${it.pid}|${it.sentAt}`);
      if (age > 600000) continue;
      if ((rec.updated || 0) > it.sentAt) continue; // uygulamayı açmış
      const ok = await deliver({ title: "Tekrar: " + it.title, body: it.body, tag: "rep-" + it.sentAt, url: it.url });
      if (!ok) gone = true;
    }

    // Yalnızca "sent" alanını güncel kayda yaz (eşzamanlı eşitlemeyi ezmemek için)
    if (changed && !gone) {
      const fresh = await s.get(key, { type: "json" });
      if (fresh) { fresh.sent = rec.sent; await s.setJSON(key, fresh); }
    }
  }

  if (handled.size || pend.items.length) {
    const fresh = (await s.get("pending", { type: "json" })) || { items: [] };
    fresh.items = fresh.items.filter((i) => !handled.has(`${i.pid}|${i.sentAt}`) && Date.now() - i.sentAt < 900000);
    await s.setJSON("pending", fresh);
  }
  console.log("push-cron: gönderilen", sentCount);
};

export const config = { schedule: "* * * * *" };
