// «محادثات_واتساب» (المدير التنفيذي 2026-11-17): one row per operating day, written nightly at 02:00.
// A conversation = a customer number that wrote to us during the operating day (06:00 → 06:00 Riyadh).
// Not counted: the free-delivery courier and the purchase-invoice senders (they are not customers).
// «صارت طلب» = that number has an order created the same operating day (cancelled, pending and dismissed ones not counted).
// First reply = minutes from the customer's first message of the day to our first reply after it (replies sent from the
// WhatsApp Business app arrive as echoes, dir 'out'). No reply in the 12 hours after = «بلا رد».
import { api, append, read, resetSheetIds, deleteDate } from "./sheets.mjs";
import { courierKeys } from "./courier.mjs";

export const TAB = "محادثات_واتساب";
export const HEADERS = ["التاريخ", "اليوم", "محادثات العملاء", "صارت طلب", "نسبة التحويل", "متوسط أول رد (دقيقة)", "وسيط أول رد (دقيقة)", "محادثات بلا رد", "أُعدّ في"];
const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const LIVE = ["new", "prep", "ready", "out", "done"];
const k9 = s => String(s || "").replace(/\D/g, "").slice(-9);
export const dayWindow = d => { const from = Date.parse(d + "T06:00:00+03:00"); return [from, from + 864e5]; };

// pure (tested): msgs = [{wa_from, dir, at}] for the day plus 12 h after; orders = [{wa_from, phone, status, created}]
export function waRow(day, { msgs, orders, exclude = new Set() }) {
  const [from, to] = dayWindow(day);
  const firstIn = new Map();
  for (const m of msgs) {
    const k = k9(m.wa_from); if (k.length !== 9 || exclude.has(k)) continue;
    if (m.dir === "in" && m.at >= from && m.at < to && (!firstIn.has(k) || m.at < firstIn.get(k))) firstIn.set(k, Number(m.at));
  }
  const ordered = new Set(orders.filter(o => LIVE.includes(o.status) && Number(o.created) >= from && Number(o.created) < to)
    .flatMap(o => [k9(o.wa_from), k9(o.phone)]).filter(k => k.length === 9));
  const waits = []; let noReply = 0, conv = 0;
  for (const [k, t0] of firstIn) {
    if (ordered.has(k)) conv++;
    const r = msgs.filter(m => m.dir === "out" && k9(m.wa_from) === k && m.at > t0 && m.at <= t0 + 12 * 3600e3).sort((a, b) => a.at - b.at)[0];
    if (r) waits.push((Number(r.at) - t0) / 60e3); else noReply++;
  }
  const n = firstIn.size;
  const sorted = [...waits].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const r1 = x => Math.round(x * 10) / 10;
  return [day, DAYS[new Date(Date.parse(day + "T00:00:00Z")).getUTCDay()], n, conv, n ? Math.round(conv / n * 100) / 100 : 0,
    waits.length ? r1(waits.reduce((a, b) => a + b, 0) / waits.length) : "", median == null ? "" : r1(median), noReply];
}

async function exclusions(pool) {
  const s = new Set(courierKeys());
  const r = await pool.query("SELECT value FROM board_settings WHERE key='purchase_senders'").catch(() => ({ rows: [] }));
  for (const p of (r.rows[0] && r.rows[0].value) || []) if (p && p.key) s.add(k9(p.key));
  return s;
}

export async function syncWa(pool, day, log = console.log) {
  const [from, to] = dayWindow(day);
  const msgs = (await pool.query("SELECT wa_from, dir, at FROM wa_messages WHERE at >= $1 AND at < $2", [from, to + 12 * 3600e3])).rows.map(m => ({ ...m, at: Number(m.at) }));
  const orders = (await pool.query("SELECT wa_from, phone, status, created FROM orders WHERE created >= $1 AND created < $2", [from, to])).rows;
  const row = waRow(day, { msgs, orders, exclude: await exclusions(pool) });
  row.push(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  const tabs = ((await api("GET", "?fields=sheets.properties")).sheets || []).map(s => s.properties.title);
  if (!tabs.includes(TAB)) { await api("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title: TAB, rightToLeft: true } } }] }); resetSheetIds(); }
  const h = await read(TAB, "A1:Z1");
  if (JSON.stringify(h[0] || []) !== JSON.stringify(HEADERS)) await api("PUT", `/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`, { values: [HEADERS] });
  await deleteDate(TAB, day);
  await append(TAB, [row]);
  log(`wa-stats: ${day} conversations=${row[2]} ordered=${row[3]} avgReply=${row[5]}`);
  return row;
}
