// One-off check for Hassan (2026-11-09 «هل أنت متأكد أن جميع الطلبات مسجلة وكذلك المبيعات»): for one operating day, logs «audit:» lines —
// counts and sales per source as the board counts them, every order whose total does not match its lines, unpriced orders,
// orders still open, unconfirmed website orders, and WhatsApp customers who wrote that day but have no order.
import { linesSum, unpricedLines } from "./itemlines.mjs";
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const l4 = s => "…" + String(s || "").replace(/\D/g, "").slice(-4);
const k9 = s => String(s || "").replace(/\D/g, "").slice(-9);
export async function audit(pool, day, log = console.log) {
  const { rows: os } = await pool.query("SELECT * FROM orders WHERE op_day=$1 ORDER BY num", [day]);
  const by = {}; const issues = [];
  let sales = 0;
  for (const o of os) {
    const s = by[o.source] = by[o.source] || { n: 0, cancelled: 0, pending: 0, sales: 0 };
    if (o.status === "cancelled") { s.cancelled++; continue; }
    if (o.status === "pending" || o.status === "dismissed") { s.pending++; issues.push(`#${o.num} ${o.source} status=${o.status} items=${String(o.items).replace(/\n/g, " / ").slice(0, 80)}`); continue; }
    s.n++;
    const own = o.type === "del" && !APPS.includes(o.source);
    const fee = own ? Number(o.delivery_fee) || Number((String(o.area).match(/توصيل\s*([\d.]+)\s*ر/) || [])[1]) || 0 : 0;
    const val = o.total == null ? null : Number(o.total) - (o.total == null ? 0 : fee);
    if (o.source !== "chefz" && val != null) { s.sales += val; sales += val; }
    const ls = linesSum(o.items), un = unpricedLines(o.items);
    if (o.total == null) issues.push(`#${o.num} ${o.source} NO TOTAL items=${String(o.items).replace(/\n/g, " / ").slice(0, 100)}`);
    else if (Number(o.total) === 0) issues.push(`#${o.num} ${o.source} TOTAL 0`);
    if (un.length && o.source !== "chefz") issues.push(`#${o.num} ${o.source} unpriced lines: ${un.join(" / ").slice(0, 120)} total=${o.total}`);
    else if (o.total != null && ls && Math.abs(ls - val) > 0.5) issues.push(`#${o.num} ${o.source}/${o.type} total=${o.total} fee=${fee} lines=${ls} → diff ${Math.round((val - ls) * 100) / 100} items=${String(o.items).replace(/\n/g, " / ").slice(0, 140)}`);
    if (["new", "prep", "ready", "out"].includes(o.status)) issues.push(`#${o.num} still ${o.status}`);
    if (o.needs_review) issues.push(`#${o.num} needs_review`);
  }
  const rets = (await pool.query("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM returns_waste WHERE op_day=$1 AND kind='return'", [day]).catch(() => ({ rows: [{ s: 0, n: 0 }] }))).rows[0];
  log(`audit: ${day} orders=${os.length} by_source=${JSON.stringify(by)} sales_before_returns=${Math.round(sales * 100) / 100} returns=${rets.n}/${rets.s} sales=${Math.round((sales - Number(rets.s)) * 100) / 100}`);
  for (const i of issues) log(`audit: ${day} ${i}`);
  // WhatsApp: customers who wrote in this operating day (06:00 → 06:00) with no order of theirs that day
  const t0 = Date.parse(day + "T06:00:00+03:00"), t1 = t0 + 864e5;
  const { rows: wa } = await pool.query("SELECT wa_from, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last, (array_agg(body ORDER BY at DESC))[1] AS lastbody FROM wa_messages WHERE dir='in' AND at>=$1 AND at<$2 GROUP BY wa_from", [t0, t1]);
  const have = new Set(os.flatMap(o => [k9(o.wa_from), k9(o.phone)]).filter(Boolean));
  const hm = t => new Date(Number(t) + 3 * 3600e3).toISOString().slice(11, 16);
  let miss = 0;
  for (const w of wa) if (!have.has(k9(w.wa_from))) { miss++; log(`audit: ${day} WA no order: ${l4(w.wa_from)} msgs=${w.n} ${hm(w.first)}-${hm(w.last)} last="${String(w.lastbody || "").replace(/\s+/g, " ").slice(0, 90)}"`); }
  log(`audit: ${day} WA customers=${wa.length} without order=${miss} issues=${issues.length}`);
}
