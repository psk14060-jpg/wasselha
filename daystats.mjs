// One-off read for Hassan's question (2026-11-09 «هل ترى تحسن في سرعة التحضير اليوم»): per operating day, from the board's
// status history: «ابدأ التحضير» → «جاهز» minutes, ready vs the time the order had to be ready (departure for our deliveries,
// customer time otherwise), and «خرج» vs departure. Logged as «daystat:» lines.
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.floor((s.length - 1) / 2)] * 10) / 10; };
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + .5))] * 10) / 10; };
export async function dayStats(pool, from, log = console.log) {
  const { rows: os } = await pool.query(`SELECT id, op_day::text AS d, num, source, type, items, due, created, confirmed_at, travel_min, status FROM orders
    WHERE op_day >= $1 AND status NOT IN ('cancelled','dismissed','pending') ORDER BY op_day, num`, [from]);
  const { rows: ev } = await pool.query(`SELECT order_id, to_status, at FROM order_events WHERE op_day >= $1 AND kind='status' ORDER BY at`, [from]);
  const evs = new Map(); for (const e of ev) { const k = String(e.order_id); const m = evs.get(k) || {}; if (!m[e.to_status]) m[e.to_status] = Number(e.at); evs.set(k, m); }
  const days = {};
  for (const o of os) {
    const d = days[o.d] = days[o.d] || { n: 0, prep: [], together: 0, noPrep: 0, readyLate: [], readyN: 0, outLate: [], outN: 0, wait: [] };
    d.n++; const e = evs.get(String(o.id)) || {};
    if (e.prep && e.ready) { const m = (e.ready - e.prep) / 60e3; if (m < 1) d.together++; else if (m <= 180) d.prep.push(m); } else if (e.ready) d.noPrep++;
    const own = o.type === "del" && !["chefz", "hunger", "keeta", "ninja"].includes(o.source);
    const need = Number(o.due) - (own ? (Number(o.travel_min) || 0) * 60e3 : 0);
    if (e.ready) { d.readyN++; d.readyLate.push((e.ready - need) / 60e3); }
    if (own && e.out) { d.outN++; d.outLate.push((e.out - need) / 60e3); }
    const st = Number(o.confirmed_at || o.created); if (e.prep && st && e.prep > st) d.wait.push((e.prep - st) / 60e3);
  }
  for (const [day, d] of Object.entries(days)) {
    const late = d.readyLate.filter(x => x > 5).length, outLate = d.outLate.filter(x => x > 5).length;
    log(`daystat: ${day} orders=${d.n} prep_measured=${d.prep.length} prep_med=${med(d.prep)} prep_p75=${pct(d.prep, .75)} pressed_together=${d.together} ready_without_start=${d.noPrep}` +
      ` | ready late>5m ${late}/${d.readyN} ready_vs_need_med=${med(d.readyLate)} p75=${pct(d.readyLate, .75)} | out late>5m ${outLate}/${d.outN} out_vs_depart_med=${med(d.outLate)} | start_wait_med=${med(d.wait)}`);
  }
}
