// «أقرب وقت» on the kitchen's real numbers (Hassan 2026-11-06: "build the queue on the data you have, not on my words").
// From the board's own status history (kitchenstats.mjs, 207 orders 23 Oct – 6 Nov 2026):
//   «ابدأ التحضير» → «جاهز»: 1 box 11 min (p75 14), 2 boxes 12 (p75 17), 3+ boxes 20 (p75 22);
//   orders in preparation at the same time: usually 1–2 (p75 2, max 5).
// So the kitchen is two lanes; each order takes its size's p75 time. An as-soon-as-possible order gets the first moment
// a lane is free long enough for it, after the orders already waiting or in preparation. The server recomputes the
// model from the history every night and sends it to the board; DEFAULT_MODEL is the measured start.
// Shared by the server and the board (built into the page): plain JavaScript, no imports.

export const DEFAULT_MODEL = { lanes: 2, svc: { 1: 14, 2: 17, 3: 22 }, basis: "207 طلب 23 أكتوبر – 6 نوفمبر" };
export const OPEN_MIN = 15 * 60 + 30;  // first orders ready at 3:30 pm

export const boxesOf = items => String(items || "").split("\n").reduce((s, l) => { const m = String(l).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).match(/^\s*(\d+)\s*×/); return s + (m ? +m[1] : 0); }, 0);
export function svcMin(boxes, model) { const s = (model || DEFAULT_MODEL).svc; return boxes <= 1 ? s[1] : boxes === 2 ? s[2] : s[3]; }

// most jobs running at the same moment inside [a, b)
function peak(jobs, a, b) {
  const pts = [];
  for (const j of jobs) { const s = Math.max(j.start, a), e = Math.min(j.end, b); if (s < e) { pts.push([s, 1]); pts.push([e, -1]); } }
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, m = 0; for (const [, d] of pts) { n += d; m = Math.max(m, n); } return m;
}

// jobs: [{start, end}] (ms) the kitchen is already committed to. Returns the earliest ready time for a new order of
// `minutes`, starting no earlier than `from` (and finishing no earlier than opening).
export function nextReady(jobs, from, minutes, model, openMs) {
  const K = (model || DEFAULT_MODEL).lanes, s = minutes * 60e3;
  let t = Math.max(from, (openMs || 0) - s);
  const js = (jobs || []).filter(j => j.end > t);
  for (let guard = 0; guard < 300; guard++) {
    if (peak(js, t, t + s) < K) return Math.ceil((t + s) / 60e3) * 60e3;
    const ends = js.map(j => j.end).filter(e => e > t);
    if (!ends.length) break;
    t = Math.min(...ends);
  }
  return Math.ceil((t + s) / 60e3) * 60e3;
}

// what the kitchen is committed to, from open orders: {status, prepAt, readyAt (when it must be ready), boxes}
export function kitchenJobs(orders, now, model) {
  const out = [];
  for (const o of orders) {
    const m = svcMin(o.boxes, model) * 60e3;
    if (o.status === "prep") { const st = o.prepAt || now; out.push({ start: st, end: Math.max(st + m, now + 2 * 60e3) }); }
    else if (o.status === "new") { const st = Math.max(o.readyAt - m, now); out.push({ start: st, end: st + m }); }
  }
  return out;
}

// 3:30 pm of the operating day (it starts at 06:00 Riyadh) that `ms` belongs to
export function openOf(ms) {
  const d = new Date(ms + 3 * 3600e3 - 6 * 3600e3);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3 * 3600e3 + OPEN_MIN * 60e3;
}
