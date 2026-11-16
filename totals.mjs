// The total of an order we price ourselves (WhatsApp, phone) is always the item lines + the delivery fee.
// #13 of 2026-11-15: «1 × مناقيش 10 قطع — 21 ريال» + delivery 5 sat on the board at 16 (should be 26); the edit that
// set it left no trace. Checked after every insert/edit and every minute for open and today's orders, so a wrong
// total never stays, whatever path wrote it.
import { linesSum, unpricedLines } from "./itemlines.mjs";

const PRICED = ["wa", "call", "shop"];
// a typed discount or a line without a price: the shop's own total is kept
const KEEP = /خصم|تخفيض|مجانا|مجاناً|هدية|discount/i;

export function expectedTotal(o) {
  if (!o || !PRICED.includes(o.source) || !o.items) return null;
  if (KEEP.test(o.items) || KEEP.test(o.note || "")) return null;
  if (unpricedLines(o.items).length) return null;
  const sum = linesSum(o.items);
  if (!(sum > 0)) return null;
  const fee = o.type === "del" ? (Number(o.delivery_fee) || 0) : 0;
  return Math.round((sum + fee) * 100) / 100;
}

export async function fixTotal(pool, id, log = console.log) {
  const { rows: [o] } = await pool.query("SELECT id, num, op_day, source, type, items, note, total, delivery_fee, status FROM orders WHERE id=$1", [id]);
  if (!o || o.status === "cancelled" || o.status === "dismissed") return null;
  const want = expectedTotal(o);
  if (want == null || (o.total != null && Math.abs(Number(o.total) - want) < 0.01)) return null;
  const was = o.total == null ? "فاضي" : String(Number(o.total));
  await pool.query(`UPDATE orders SET total=$2, note=LEFT(TRIM(BOTH ' ·' FROM COALESCE(note,'') || ' · ' || $3), 300), updated=$4 WHERE id=$1`,
    [o.id, want, `صُحّح الإجمالي تلقائيًا (كان ${was})`, Date.now()]);
  const day = o.op_day instanceof Date ? o.op_day.toISOString().slice(0, 10) : String(o.op_day);
  log(`total-fix: ${day} #${o.num} ${was} → ${want}`);
  return want;
}

export async function fixOpenTotals(pool, log = console.log) {
  const { rows } = await pool.query(`SELECT id FROM orders WHERE source = ANY($1) AND status NOT IN ('cancelled','dismissed')
    AND (status IN ('pending','new','prep','ready','out') OR updated > $2)`, [PRICED, Date.now() - 12 * 3600e3]);
  let n = 0;
  for (const r of rows) if (await fixTotal(pool, r.id, log).catch(e => (log("total-fix: " + e.message), null)) != null) n++;
  return n;
}
