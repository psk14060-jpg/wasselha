// «شفت إعلانكم» (وكيل التسويق 2026-11-18, by Hassan): the Instagram campaign opens WhatsApp with a ready message
// «مرحبا، شفت إعلانكم في إنستقرام وأبي أطلب». Every customer message saying they saw our ad is recorded (even with no order),
// its source goes into the order's «من وين عرفتنا» (orders.heard) when the order has none, and is counted per day.
export const AD_RE = /شف(?:ت|نا)\s*(?:[اإأ]علان(?:كم|ك)?)/;
export function adSource(text) {
  const t = String(text || "");
  if (!AD_RE.test(t)) return null;
  if (/[اإ]نستقرام|[اإ]نستغرام|[اإ]نستا|instagram|insta/i.test(t)) return "إنستقرام";
  if (/تيك\s*توك|تيكتوك|tiktok/i.test(t)) return "تيك توك";
  return "إعلان غير محدد";
}
export async function migrateAdMentions(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ad_mentions (msg_id TEXT PRIMARY KEY, wa_from TEXT NOT NULL, at BIGINT NOT NULL, source TEXT NOT NULL)`);
}
// called for every incoming customer message
export async function recordAdMention(pool, m, log = console.log) {
  const src = adSource(m.text); if (!src) return null;
  await pool.query("INSERT INTO ad_mentions (msg_id, wa_from, at, source) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [m.id, m.from, Number(m.ts) || Date.now(), src]);
  // an order already open for this chat (today or later) takes the source if it has none
  const up = await pool.query(`UPDATE orders SET heard=$2 WHERE wa_from=$1 AND heard IS NULL AND status NOT IN ('cancelled','dismissed','done') AND due > $3 RETURNING num`,
    [m.from, src, Date.now() - 12 * 3600e3]);
  log(`ad-mention: …${String(m.from).slice(-4)} ${src}${up.rowCount ? " → order #" + up.rows.map(r => r.num).join(",") : ""}`);
  return src;
}
// for a new order: the source this WhatsApp number said in the last 14 days
export async function heardFromAd(pool, waFrom) {
  if (!waFrom) return null;
  const r = await pool.query("SELECT source FROM ad_mentions WHERE wa_from=$1 AND at > $2 ORDER BY at DESC LIMIT 1", [waFrom, Date.now() - 14 * 864e5]).catch(() => ({ rows: [] }));
  return r.rows[0] ? r.rows[0].source : null;
}
