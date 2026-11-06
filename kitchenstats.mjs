// What the kitchen really does, from the board's own status history (order_events): how long an order takes from
// «ابدأ التحضير» to «جاهز», how that grows with the order size, how many orders are in preparation at once,
// and how many get ready per hour. Used to schedule «أقرب وقت» on real numbers, not on a guess.
import { DEFAULT_MODEL, stationsOf } from "./capacity.mjs";
const APPS = ["chefz", "hunger", "keeta", "ninja"];

// The kitchen model used for «أقرب وقت»: lanes = orders usually in preparation at once (p75), time per order size = p75
// of the measured «ابدأ التحضير» → «جاهز» (a size with fewer than 10 measures keeps the default). Rebuilt at start and nightly.
let MODEL = DEFAULT_MODEL;
export const kitchenModel = () => MODEL;
// oven: p75 time of oven-only orders; fry: least-squares line of time against pieces on fry-only orders, never faster
// than frying alone (2 min / 10 pieces, Hassan), shifted up by the p75 of what the line misses; lanes: p75 of how many
// orders of that station were in preparation when one started. A station with fewer than 8 measures keeps the default.
export function modelFrom(k) {
  const D = DEFAULT_MODEL, st = k.stations || {};
  const oven = st.oven && st.oven.n >= 8 ? { lanes: Math.max(1, Math.min(4, st.oven.lanesP75 || D.oven.lanes)), min: Math.ceil(st.oven.p75) } : D.oven;
  const fry = st.fry && st.fry.n >= 8 ? { lanes: Math.max(1, Math.min(3, st.fry.lanesP75 || D.fry.lanes)), base: Math.max(0, Math.ceil(st.fry.base)), per10: Math.max(2, Math.round(st.fry.per10 * 10) / 10) } : D.fry;
  return { oven, fry, basis: `${k.prep.n} طلب من ${k.from} (فرن ${st.oven ? st.oven.n : 0}، قلي ${st.fry ? st.fry.n : 0})` };
}
export function startKitchenModel(pool, log = console.log) {
  const run = () => kitchenStats(pool).then(k => { MODEL = modelFrom(k); log("kitchen: " + JSON.stringify(k)); log("kitchen-model: " + JSON.stringify(MODEL)); })
    .catch(e => log("kitchen: " + e.message));
  setTimeout(run, 45e3); setInterval(run, 24 * 3600e3);
}
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const boxes = items => String(items || "").split("\n").reduce((s, l) => { const m = l.match(/^\s*(\d+)\s*×/); return s + (m ? +m[1] : 0); }, 0);

export async function kitchenStats(pool, days = 14) {
  const from = new Date(Date.now() + 3 * 3600e3 - 6 * 3600e3 - days * 864e5).toISOString().slice(0, 10);
  const { rows: ev } = await pool.query(
    `SELECT e.order_id, e.to_status, e.from_status, e.at, e.open_prep FROM order_events e WHERE e.op_day >= $1 AND e.kind='status' ORDER BY e.at`, [from]);
  const { rows: os } = await pool.query(
    `SELECT id, op_day::text AS d, source, type, items, due, created, confirmed_at, status FROM orders WHERE op_day >= $1 AND status NOT IN ('cancelled','dismissed','pending')`, [from]);
  const byId = new Map(os.map(o => [String(o.id), { ...o, ev: {} }]));
  for (const e of ev) { const o = byId.get(String(e.order_id)); if (o && !o.ev[e.to_status]) o.ev[e.to_status] = Number(e.at); }

  const prep = [], bySize = {}, wait = [], conc = [];
  let pressedTogether = 0, measured = 0;
  for (const o of byId.values()) {
    const p = o.ev.prep, r = o.ev.ready;
    if (p && r && r > p) {
      const m = (r - p) / 60e3;
      measured++;
      if (m < 1) { pressedTogether++; continue; }          // «ابدأ» and «جاهز» pressed together: not a real measure
      if (m > 180) continue;
      prep.push(m);
      const b = boxes(o.items), k = b <= 1 ? "1" : b === 2 ? "2" : b <= 4 ? "3-4" : "5+";
      (bySize[k] = bySize[k] || []).push(m);
    }
    const start = Number(o.confirmed_at || o.created);
    if (p && start && p > start) wait.push((p - start) / 60e3);
  }
  for (const e of ev) if (e.open_prep != null) conc.push(Number(e.open_prep));

  // orders made ready per hour, in hours that had any
  const perHour = {};
  for (const o of byId.values()) if (o.ev.ready) { const h = Math.floor(o.ev.ready / 3600e3); perHour[h] = (perHour[h] || 0) + 1; }
  const hours = Object.values(perHour);
  // gap between one order getting ready and the next, in busy stretches (gap under 60 minutes)
  const readyTimes = [...byId.values()].map(o => o.ev.ready).filter(Boolean).sort((a, b) => a - b);
  const gaps = []; for (let i = 1; i < readyTimes.length; i++) { const g = (readyTimes[i] - readyTimes[i - 1]) / 60e3; if (g > 0 && g < 60) gaps.push(g); }

  // per station (oven-only orders / fry-only orders), from the same measures
  const ovenRuns = [], fryRuns = [];
  for (const o of byId.values()) {
    const p = o.ev.prep, r = o.ev.ready; if (!(p && r && r > p)) continue;
    const m = (r - p) / 60e3; if (m < 1 || m > 180) continue;
    const s = stationsOf(o.items);
    if (s.oven && !s.fryPcs) ovenRuns.push({ p, r, m });
    else if (s.fryPcs && !s.oven) fryRuns.push({ p, r, m, pcs: s.fryPcs });
  }
  const lanesAt = runs => q(runs.map(a => runs.filter(b => b.p <= a.p && b.r > a.p).length), .75);
  let fit = null;
  if (fryRuns.length >= 3) {
    const n = fryRuns.length, xs = fryRuns.map(f => f.pcs / 10), ys = fryRuns.map(f => f.m);
    const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    let per10 = sxx ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx : 2;
    per10 = Math.max(2, per10);
    const base0 = my - per10 * mx;
    const miss = q(ys.map((y, i) => y - (base0 + per10 * xs[i])), .75) || 0;
    fit = { n, base: Math.round((base0 + miss) * 10) / 10, per10: Math.round(per10 * 10) / 10, lanesP75: lanesAt(fryRuns),
      pcsP50: q(fryRuns.map(f => f.pcs), .5), p50: Math.round(q(ys, .5) * 10) / 10 };
  }
  const stations = {
    oven: ovenRuns.length ? { n: ovenRuns.length, p50: Math.round(q(ovenRuns.map(o => o.m), .5) * 10) / 10, p75: Math.round(q(ovenRuns.map(o => o.m), .75) * 10) / 10, lanesP75: lanesAt(ovenRuns) } : null,
    fry: fit,
  };
  const r1 = x => x == null ? null : Math.round(x * 10) / 10;
  return {
    from, orders: byId.size, measured, pressedTogether,
    prep: { n: prep.length, p25: r1(q(prep, .25)), p50: r1(q(prep, .5)), p75: r1(q(prep, .75)), p90: r1(q(prep, .9)) },
    bySize: Object.fromEntries(Object.entries(bySize).map(([k, a]) => [k, { n: a.length, p50: r1(q(a, .5)), p75: r1(q(a, .75)) }])),
    waitBeforeStart: { n: wait.length, p50: r1(q(wait, .5)), p75: r1(q(wait, .75)) },
    inPrepAtOnce: { p50: q(conc, .5), p75: q(conc, .75), p90: q(conc, .9), max: conc.length ? Math.max(...conc) : null },
    readyPerHour: { hours: hours.length, p50: q(hours, .5), p75: q(hours, .75), max: hours.length ? Math.max(...hours) : null },
    gapBetweenReady: { n: gaps.length, p25: r1(q(gaps, .25)), p50: r1(q(gaps, .5)) },
    stations,
  };
}
