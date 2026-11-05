// One courier for several deliveries (Hassan 2026-11-05): when our own delivery orders leave close in time and their
// customers are close to each other, the board suggests sending them with one courier, in the order that gets every
// customer their food no more than 10 minutes after the promised time. The kitchen decides; the board only suggests.
// The courier is paid by each customer, so the fee does not change.
import { getMenu } from "./menu.mjs";

const SHOP = { lat: 25.3287496, lng: 49.5631309 };
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const ACTIVE = ["new", "prep", "ready"];
export const BATCH = { maxLateMin: 10, maxEarlyMin: 15, windowMin: 20, stopMin: 3, roadBuffer: 5 };

const pt = s => { const m = String(s || "").match(/^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/); return m ? { lat: +m[1], lng: +m[2] } : null; };
const hav = (a, b) => { const d = Math.PI / 180; const h = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const areaName = a => String(a || "").replace(/📍/g, "").replace(/\s*\(.*\)\s*$/, "").split("·")[0].trim();

// drive minutes between two customers: OSRM, cached; straight line × 1.35 at 30 km/h if the map service does not answer
const legCache = new Map();
async function legMin(a, b) {
  const k = [a, b].map(p => p.lat.toFixed(5) + "," + p.lng.toFixed(5)).sort().join("|");
  if (legCache.has(k)) return legCache.get(k);
  let min;
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j.code !== "Ok") throw new Error(j.code);
    min = j.routes[0].duration / 60;
  } catch { min = hav(a, b) * 1.35 / 30 * 60; }
  min = Math.ceil(min);
  if (legCache.size > 2000) legCache.clear();
  legCache.set(k, min);
  return min;
}

// minutes from the shop to the customer, as the board counts it (map time + 5)
function travelOf(o, areas) {
  if (o.travel_min != null) return Number(o.travel_min) + BATCH.roadBuffer;
  const a = areas.find(x => x.name === areaName(o.area));
  return a && a.minutes != null ? Math.ceil(a.minutes) + BATCH.roadBuffer : 20;
}

// try one route order: leave the shop at L, drop the first, then the second. Returns null if someone is too late or too early.
function plan(a, b, leg, now) {
  const viaB = a.travel + BATCH.stopMin + leg;                 // minutes from the shop to the second customer
  const onTime = Math.min(a.due - a.travel * 60e3, b.due - viaB * 60e3);
  for (const shift of [0, 5, 10]) {
    const L = Math.max(onTime + shift * 60e3, now);
    const arrA = L + a.travel * 60e3, arrB = L + viaB * 60e3;
    const late = [arrA - a.due, arrB - b.due].map(x => Math.round(x / 60e3));
    if (late.some(x => x > BATCH.maxLateMin) || late.some(x => -x > BATCH.maxEarlyMin)) continue;
    return { out: L, arrive: [arrA, arrB], late, total: viaB };
  }
  return null;
}

// Suggestions for today's open delivery orders (rows straight from the database). Pairs only, each order in one suggestion.
export async function suggestBatches(rows, now = Date.now()) {
  const areas = ((await getMenu().catch(() => null)) || {}).areas || [];
  const c = rows.filter(o => o.type === "del" && !APPS.includes(o.source) && ACTIVE.includes(o.status) && !o.batch_id)
    .map(o => ({ id: String(o.id), num: o.num, due: Number(o.due), p: pt(o.dest), area: areaName(o.area), travel: travelOf(o, areas) }));
  const opts = [];
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
    const A = c[i], B = c[j];
    if (Math.abs((A.due - A.travel * 60e3) - (B.due - B.travel * 60e3)) > BATCH.windowMin * 60e3) continue;
    let leg;
    if (A.p && B.p) { if (hav(A.p, B.p) > 6) continue; leg = await legMin(A.p, B.p); }
    else if (!A.p && !B.p && A.area && A.area === B.area) leg = 3;   // no map point: same neighbourhood only
    else continue;
    for (const [x, y] of [[A, B], [B, A]]) {
      const r = plan(x, y, leg, now);
      if (r) opts.push({ ids: [x.id, y.id], nums: [x.num, y.num], areas: [x.area, y.area], leg, ...r });
    }
  }
  // best first: least lateness, then shortest route; each order used once
  opts.sort((a, b) => Math.max(...a.late) - Math.max(...b.late) || a.total - b.total);
  const used = new Set(), out = [];
  for (const o of opts) {
    if (o.ids.some(id => used.has(id))) continue;
    o.ids.forEach(id => used.add(id));
    out.push({ key: o.ids.slice().sort().join("-"), ids: o.ids, nums: o.nums, areas: o.areas, out: o.out, arrive: o.arrive, late: o.late, leg: o.leg });
  }
  return out;
}

// Google Maps route for the courier: shop → stops in order
export function routeUrl(dests) {
  const ps = dests.map(pt).filter(Boolean);
  if (!ps.length) return null;
  const f = p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const last = ps[ps.length - 1], mid = ps.slice(0, -1);
  return `https://www.google.com/maps/dir/?api=1&origin=${f(SHOP)}&destination=${f(last)}${mid.length ? "&waypoints=" + mid.map(f).join("|") : ""}&travelmode=driving`;
}
