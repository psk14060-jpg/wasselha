// Weekly sales (Hassan 2026-11-13): the week runs Sunday → end of Saturday's shift (operating days, so Saturday's late night counts).
// Counted exactly like the «مبيعات اليوم» chip: no cancelled/unconfirmed orders, no The Chefz, no delivery fee, minus returns.
import crypto from "node:crypto";
// Owner only (Hassan 2026-11-13: «لا أريد الكاشير يراه»): the numbers are served only with the owner's code —
// env OWNER_CODE, which Hassan sets himself in Render (falls back to SUPERVISOR_CODE, also his alone while OWNER_CODE is unset).
export function ownerOk(code) {
  const want = String(process.env.OWNER_CODE || process.env.SUPERVISOR_CODE || ""), got = String(code || "");
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const weekStart = d => addDays(d, -new Date(Date.parse(d + "T00:00:00Z")).getUTCDay());
export const feeOf = o => {
  const own = o.type === "del" && !APPS.includes(o.source);
  if (!own) return 0;
  if (o.delivery_fee != null) return Number(o.delivery_fee) || 0;
  return Number((String(o.area || "").match(/توصيل\s*([\d.]+)\s*ر/) || [])[1]) || 0;
};
async function totals(pool, from, to) {
  const { rows } = await pool.query(`SELECT op_day::text AS d, source, type, area, total, delivery_fee FROM orders
    WHERE op_day BETWEEN $1 AND $2 AND status IN ('new','prep','ready','out','done') AND total IS NOT NULL`, [from, to]);
  const rets = (await pool.query("SELECT op_day::text AS d, COALESCE(SUM(amount),0) AS s FROM returns_waste WHERE kind='return' AND op_day BETWEEN $1 AND $2 GROUP BY op_day", [from, to]).catch(() => ({ rows: [] }))).rows;
  const by = {};
  for (const o of rows) { if (o.source === "chefz") continue; const x = by[o.d] = by[o.d] || { n: 0, sales: 0 }; x.n++; x.sales += Math.max(0, Number(o.total) - feeOf(o)); }
  for (const r of rets) { const x = by[r.d] = by[r.d] || { n: 0, sales: 0 }; x.sales -= Number(r.s); }
  return by;
}
let cache = null;
export async function weekSales(pool, today) {
  if (cache && cache.today === today && Date.now() - cache.at < 60e3) return cache.value;
  const start = weekStart(today), end = addDays(start, 6), pStart = addDays(start, -7), pEnd = addDays(start, -1);
  const cur = await totals(pool, start, end), prev = await totals(pool, pStart, pEnd);
  const days = [...Array(7)].map((_, i) => { const d = addDays(start, i); const x = cur[d] || { n: 0, sales: 0 };
    return { d, name: DAYS[i], n: x.n, sales: Math.round(x.sales), future: d > today, today: d === today }; });
  const sum = o => Object.values(o).reduce((a, x) => ({ n: a.n + x.n, sales: a.sales + x.sales }), { n: 0, sales: 0 });
  const c = sum(cur), p = sum(prev);
  // last week up to the same weekday, so the comparison is fair mid-week
  const upto = addDays(pStart, days.findIndex(x => x.today) < 0 ? 6 : days.findIndex(x => x.today));
  const pSame = sum(Object.fromEntries(Object.entries(prev).filter(([d]) => d <= upto)));
  const value = { from: start, to: end, n: c.n, sales: Math.round(c.sales), avgTicket: c.n ? Math.round(c.sales / c.n) : 0, days,
    prev: { from: pStart, to: pEnd, n: p.n, sales: Math.round(p.sales), sameDays: Math.round(pSame.sales) } };
  cache = { today, at: Date.now(), value };
  return value;
}
