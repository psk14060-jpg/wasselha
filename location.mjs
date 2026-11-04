// Customer location → delivery time and fee, the same way the website does it:
// road distance from the shop (OSRM), else straight line × factor at a set speed; the fee comes from the distance zones.
import { getMenu } from "./menu.mjs";

const DEFAULTS = { shop: { lat: 25.3287496, lng: 49.5631309 }, maxKm: 20, fallbackFactor: 1.35, fallbackSpeed: 30, timeFactor: 1.4,
  zones: [{ name: "قريب جدًا", maxKm: 3.5, fee: 5 }, { name: "قريب", maxKm: 7, fee: 5 }, { name: "متوسط", maxKm: 10, fee: 10 }, { name: "بعيد", maxKm: 13, fee: 15 }, { name: "أبعد", maxKm: 20, fee: 20 }] };

const inSaudi = (lat, lng) => lat > 15 && lat < 33 && lng > 34 && lng < 56;

// "[موقع] lat,lng", a Google Maps link (long or short), or "lat, lng" typed by hand
export async function findPoint(text) {
  const t = String(text || "");
  const pick = s => {
    const m = String(s).match(/(?:@|q=|query=|ll=|destination=|\[موقع\]\s*|^|\s)(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    return inSaudi(lat, lng) ? { lat, lng } : null;
  };
  const direct = pick(t);
  if (direct) return direct;
  const short = t.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\/[A-Za-z0-9_\-/?=&.]+/);
  if (!short) return null;
  let url = short[0];
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "user-agent": "minigeesh-orders" } });
      const loc = r.headers.get("location");
      const hit = pick(decodeURIComponent(loc || ""));
      if (hit) return hit;
      if (!loc) { const body = await r.text(); return pick(decodeURIComponent(body.slice(0, 20000))); }
      url = new URL(loc, url).href;
    } catch { return null; }
  }
  return null;
}

function haversineKm(a, b) {
  const R = 6371, d = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function deliveryFor(point) {
  const r = { ...DEFAULTS, ...((await getMenu()).rules || {}) };
  const shop = r.shop || DEFAULTS.shop, zones = r.zones?.length ? r.zones : DEFAULTS.zones;
  let km, minutes, approx = false;
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${shop.lng},${shop.lat};${point.lng},${point.lat}?overview=false`,
      { signal: AbortSignal.timeout(6000), headers: { "user-agent": "minigeesh-orders" } });
    const j = await res.json();
    km = j.routes[0].distance / 1000; minutes = j.routes[0].duration / 60;
    if (!isFinite(km) || !isFinite(minutes)) throw new Error("osrm");
  } catch {
    km = haversineKm(shop, point) * (r.fallbackFactor || 1.35); minutes = km / (r.fallbackSpeed || 30) * 60; approx = true;
  }
  const zone = zones.find(z => km <= z.maxKm);
  return { km: Math.round(km * 10) / 10, minutes: Math.ceil(minutes), approx, // plain map time; the board adds 5 minutes for the road
    zone: zone ? zone.name : null, fee: zone ? zone.fee : null, inRange: !!zone && km <= (r.maxKm || 20),
    mapsUrl: `https://www.google.com/maps?q=${point.lat.toFixed(6)},${point.lng.toFixed(6)}` };
}

export async function migrateLocation(pool) {
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS travel_min INT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest TEXT");
}

// Put the drive on the order: delivery, area label with distance, fee from the zone, total adjusted, map link for the driver.
export async function applyLocation(pool, orderId, point, log = console.log, sourceNote = "") {
  const d = await deliveryFor(point);
  const { rows: [o] } = await pool.query("SELECT id, num, source, total, delivery_fee, note, area FROM orders WHERE id=$1", [orderId]);
  if (!o) return null;
  const oldFee = Number(o.delivery_fee) || 0;
  // the fee of a neighbourhood from the website's list wins (as on the website); a website order keeps the fee it was sent with.
  // The map point then only sets the drive time and the driver's link.
  const areaName = String(o.area || "").replace(/^📍\s*/, "").replace(/\s*·.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
  const listed = ((await getMenu()).areas || []).find(a => a.name === areaName);
  const fee = listed ? listed.fee : (o.source === "web" && o.delivery_fee != null) ? Number(o.delivery_fee) : d.inRange ? d.fee : null;
  const total = o.total == null ? null : Number(o.total) - oldFee + (fee || 0);
  const keepArea = areaName;
  const area = `📍 ${keepArea ? keepArea + " · " : ""}${d.km} كم${fee != null ? ` (توصيل ${fee} ر)` : " (خارج النطاق)"}`;
  const note = String(o.note || "")
    .replace(/\s*·?\s*📍 الموقع: \S+/g, "")
    .split("·").map(x => x.trim()).filter(x => x && !/^(?:الحي|العنوان|الموقع)\s+غير\s+(?:مذكور|محدد)|^المسافة تقريبية$|^⚠ الموقع أبعد/.test(x)).join(" · ")
    .replace(/(⚠ ناقص: [^·]*?)(?:،\s*)?(?:الحي|رسوم الحي)(?=،|\s*·|$)/g, "$1").replace(/⚠ ناقص:\s*(?:·|$)/g, "").replace(/^\s*·\s*|\s*·\s*$/g, "").trim();
  const note2 = [note.replace(/\s*·?\s*📍 الموقع من طلب سابق[^·]*/g, ""), `📍 الموقع: ${d.mapsUrl}`, sourceNote, d.inRange ? "" : `⚠ الموقع أبعد من نطاق التوصيل (${d.km} كم)`, d.approx ? "المسافة تقريبية" : ""].filter(Boolean).join(" · ").slice(0, 300);
  await pool.query(`UPDATE orders SET type='del', area=$1, delivery_fee=$2, total=$3, note=$4, travel_min=$5, dest=$6, updated=$7 WHERE id=$8`,
    [area.slice(0, 80), fee, total, note2, d.minutes, `${point.lat},${point.lng}`, Date.now(), orderId]);
  log(`wa: location on #${o.num}: ${d.km} km, ${d.minutes} min, fee ${fee}${d.approx ? " (approx)" : ""}`);
  return d;
}
