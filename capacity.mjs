// «أقرب وقت» on how the kitchen really works (Hassan 2026-11-06) and on its measured times:
// - CAP_OVEN station: triangles come frozen, cup pizza and boats are ready-made — set on a tray, oven, box. Time hardly
//   depends on the quantity (one bake).
// - CAP_FRY station: kabaji is rolled, filled, then fried; frying takes 2 minutes per 10 pieces, so time grows with pieces.
//   (Southern samosa and mini kabaji are fried too.)
// The two stations work at the same time: an order with both is ready when the slower part is. Each station has its
// own lanes (orders it can handle at once). Times and lanes are measured from the board's status history
// (kitchenstats.mjs) and rebuilt nightly; DEFAULT_MODEL holds the first measures.
// Shared by the server and the board (built into the page): plain JavaScript, no imports.

export const DEFAULT_MODEL = {
  oven: { lanes: 2, min: 14 },                 // minutes from «ابدأ التحضير» to «جاهز» for an oven-only order (p75)
  fry: { lanes: 1, base: 6, per10: 3 },        // rolling/filling start + minutes per 10 pieces (frying alone is 2 per 10)
  basis: "قياس أولي",
};
export const OPEN_MIN = 15 * 60 + 30;  // first orders ready at 3:30 pm

const capLatin = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
const CAP_FRY = /كباجي|سمبوسة\s*جنوبية/;
const CAP_OVEN = /فطائر|فطاير|كب\s*بيتزا|قوارب|بيتزا|مناقيش|مسخن|تشكيلة|بوكس المشاركة/;

// what an order needs from each station: { oven: true/false, fryPcs: pieces to fry }
export function stationsOf(items) {
  let oven = false, fryPcs = 0;
  for (const raw of String(items || "").split("\n")) {
    const t = capLatin(raw); if (!t.trim()) continue;
    const qty = +((t.match(/^\s*(\d+)\s*×/) || [])[1] || 1);
    const pcs = +((t.match(/(\d+)\s*(?:قطعة|قطع|حبة|حبات)/) || [])[1] || 0);
    if (CAP_FRY.test(t)) fryPcs += qty * (pcs || 10);
    else if (CAP_OVEN.test(t)) oven = true;
  }
  return { oven, fryPcs };
}
export const boxesOf = items => String(items || "").split("\n").reduce((s, l) => { const m = capLatin(l).match(/^\s*(\d+)\s*×/); return s + (m ? +m[1] : 0); }, 0);

// minutes each station needs for this order (0 = not needed)
export function needOf(items, model) {
  const M = model || DEFAULT_MODEL, s = stationsOf(items);
  return { oven: s.oven ? M.oven.min : 0, fry: s.fryPcs ? Math.ceil(M.fry.base + M.fry.per10 * s.fryPcs / 10) : 0 };
}

// most jobs running at the same moment inside [a, b)
function capPeak(jobs, a, b) {
  const pts = [];
  for (const j of jobs) { const s = Math.max(j.start, a), e = Math.min(j.end, b); if (s < e) { pts.push([s, 1]); pts.push([e, -1]); } }
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, m = 0; for (const [, d] of pts) { n += d; m = Math.max(m, n); } return m;
}
// earliest finish on one station with `lanes`, for a job of `minutes` starting no earlier than t0
function stationFinish(jobs, t0, minutes, lanes) {
  const s = minutes * 60e3; let t = t0;
  const js = (jobs || []).filter(j => j.end > t);
  for (let guard = 0; guard < 300; guard++) {
    if (capPeak(js, t, t + s) < lanes) return t + s;
    const ends = js.map(j => j.end).filter(e => e > t);
    if (!ends.length) break;
    t = Math.min(...ends);
  }
  return t + s;
}

// jobs: { oven: [{start,end}], fry: [...] } already committed. Returns the earliest ready time (ms) for an order with
// these items, starting no earlier than `from`; before opening, the first ready time is 3:30 pm.
export function nextReady(jobs, from, items, model, openMs) {
  const M = model || DEFAULT_MODEL, need = needOf(items, M);
  if (!need.oven && !need.fry) need.oven = M.oven.min;   // unknown items: count them as an oven order
  const longest = Math.max(need.oven, need.fry) * 60e3;
  const t0 = Math.max(from, (openMs || 0) - longest);
  const done = Math.max(need.oven ? stationFinish(jobs.oven, t0, need.oven, M.oven.lanes) : 0,
                        need.fry ? stationFinish(jobs.fry, t0, need.fry, M.fry.lanes) : 0);
  return Math.ceil(done / 60e3) * 60e3;
}

// what each station is committed to, from open orders: {status, prepAt, readyAt (when it must be ready), items}
export function kitchenJobs(orders, now, model) {
  const M = model || DEFAULT_MODEL, out = { oven: [], fry: [] };
  for (const o of orders) {
    const need = needOf(o.items, M);
    if (!need.oven && !need.fry) need.oven = M.oven.min;
    for (const st of ["oven", "fry"]) {
      if (!need[st]) continue;
      const m = need[st] * 60e3;
      if (o.status === "prep") { const b = o.prepAt || now; out[st].push({ start: b, end: Math.max(b + m, now + 2 * 60e3) }); }
      else if (o.status === "new") { const b = Math.max(o.readyAt - m, now); out[st].push({ start: b, end: b + m }); }
    }
  }
  return out;
}

// 3:30 pm of the operating day (it starts at 06:00 Riyadh) that `ms` belongs to
export function openOf(ms) {
  const d = new Date(ms + 3 * 3600e3 - 6 * 3600e3);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3 * 3600e3 + OPEN_MIN * 60e3;
}
