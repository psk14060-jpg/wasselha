// Menu and delivery areas, read live from the storefront (minigeesh.sa) so prices are kept in one place.
// Falls back to the last good copy, then to a built-in snapshot.
import vm from "node:vm";

const SITE = process.env.SITE_URL || "https://minigeesh.sa";
const REFRESH_MS = 30 * 60e3;

const SNAPSHOT = {
  products: [
    { id: "triangles", name: "فطائر مثلثة", description: "رانش · مكسيكي · فاهيتا", variants: [{ tag: "10 قطع", price: 20 }, { tag: "20 قطعة", price: 35 }, { tag: "30 قطعة", price: 45 }] },
    { id: "cupPizza", name: "كب بيتزا", description: "تشكيلة نكهات مناسبة للمشاركة", variants: [{ tag: "28 قطعة", price: 47 }, { tag: "42 قطعة", price: 65 }] },
    { id: "boats18", name: "قوارب", description: "تشكيلة من الأجبان والحمسات والزعتر", variants: [{ tag: "18 قطعة", price: 35 }] },
    { id: "kabajiSugar", name: "كباجي جبن سائل برشة سكر", description: "", variants: [{ tag: "10 قطع", price: 20 }, { tag: "20 قطعة", price: 38 }] },
    { id: "miniSugar", name: "ميني كباجي بالسكر", description: "", variants: [{ tag: "35 قطعة", price: 35 }] },
    { id: "miniCaramel", name: "ميني كباجي بالكراميل", description: "", variants: [{ tag: "35 قطعة", price: 42 }] },
    { id: "samosa", name: "سمبوسة جنوبية", description: "بعجينة البر · دجاج أو جبن", variants: [{ tag: "10 قطع", price: 20 }, { tag: "20 قطعة", price: 38 }] },
    { id: "pizza", name: "بيتزا", description: "تشكيلة من نكهات البيتزا", variants: [{ tag: "10 قطع", price: 21 }, { tag: "20 قطعة", price: 39 }] },
    { id: "manaqeesh", name: "مناقيش", description: "تشكيلة من نكهات المناقيش", variants: [{ tag: "10 قطع", price: 21 }, { tag: "20 قطعة", price: 39 }] },
    { id: "musakhanBoats18", name: "قوارب المسخن", description: "", variants: [{ tag: "18 قطعة", price: 39 }] },
    { id: "cheeseMusakhanBoats", name: "تشكيلة قوارب أجبان ومسخن", description: "", variants: [{ tag: "تشكيلة", price: 49 }] },
    { id: "mix48", name: "تشكيلة 48", description: "28 كب بيتزا · 10 فطائر مثلثة · 10 مناقيش", variants: [{ tag: "تكفي 8–10", price: 72 }] },
    { id: "mix80", name: "تشكيلة 80", description: "42 كب بيتزا · 18 قوارب · 20 فطائر مثلثة", variants: [{ tag: "تكفي 18", price: 115 }] },
    { id: "mix115", name: "تشكيلة 115", description: "42 كب بيتزا · 18 قوارب · 20 فطائر مثلثة · 35 ميني كباجي", variants: [{ tag: "تكفي 25", price: 145 }] },
  ],
  areas: [],
  rules: {},
};

let current = { ...SNAPSHOT, source: "snapshot", fetchedAt: 0 };
let inflight = null;

// Return the text of the bracketed literal that starts at the first "[" after `marker`.
function literalAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const start = src.indexOf("[", at);
  if (start < 0) return null;
  let depth = 0, quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const evalLiteral = txt => vm.runInNewContext("(" + txt + ")", Object.create(null), { timeout: 200 });
function numberAfter(src, key) {
  const m = src.match(new RegExp(key + "\\s*:\\s*(\\d+(?:\\.\\d+)?)"));
  return m ? Number(m[1]) : null;
}

// Fillings a customer can choose, taken from the product description ("رانش · مكسيكي · فاهيتا", "دجاج أو جبن").
function flavorsOf(p) {
  if (/^mix|تشكيلة/.test(p.id + " " + p.name)) return [];
  const d = String(p.description || "");
  if (!d.includes("·") && !/ أو /.test(d)) return [];
  return d.split("·").flatMap(x => x.split(/ أو /)).map(x => x.trim())
    .filter(x => x && x.length <= 14 && !/بعجينة|تشكيلة|قطعة|قطع|\d/.test(x));
}

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "minigeesh-orders" } });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.text();
}

async function refresh() {
  const html = await fetchText(SITE + "/");
  const groupsTxt = literalAfter(html, "const groups=") || literalAfter(html, "const groups =") || literalAfter(html, "groups=");
  if (!groupsTxt) throw new Error("menu not found in page");
  const groups = evalLiteral(groupsTxt);
  let products = groups.flatMap(g => g.items || []);
  // extra products added by a script (e.g. the musakhan ads)
  for (const m of html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)) {
    const src = m[1];
    if (/leaflet|tiktok|meta-whatsapp|storefront|kitchen-sync|minigeesh-delivery/.test(src)) continue;
    try {
      const js = await fetchText(new URL(src, SITE + "/").href);
      const t = literalAfter(js, "const products");
      if (t) for (const p of evalLiteral(t)) if (p && p.id && Array.isArray(p.variants) && !products.some(x => x.id === p.id)) products.push(p);
    } catch {}
  }
  products = products.filter(p => p && p.id && p.name && Array.isArray(p.variants) && p.variants.length)
    .map(p => ({ id: String(p.id), name: String(p.name), description: String(p.description || ""),
      variants: p.variants.map(v => ({ tag: String(v.tag || ""), price: Number(v.price) || 0 })) }));
  if (products.length < 3) throw new Error("too few products");

  let areas = [], rules = {};
  try {
    const dsrc = (html.match(/<script[^>]+src="([^"]*minigeesh-delivery[^"]*)"/) || [])[1] || "assets/minigeesh-delivery.js";
    const djs = await fetchText(new URL(dsrc, SITE + "/").href);
    const at = literalAfter(djs, "AREAS:");
    if (at) areas = evalLiteral(at).map(a => ({ name: String(a.name), city: String(a.city || ""), fee: Number(a.fee) || 0,
      minutes: a.minutes === null || a.minutes === undefined ? null : Number(a.minutes) }));
    rules = { minSubtotal: numberAfter(djs, "MIN_SUBTOTAL"), midMinSubtotal: numberAfter(djs, "MID_MIN_SUBTOTAL"), midMinFee: numberAfter(djs, "MID_MIN_FEE"),
      farMinSubtotal: numberAfter(djs, "FAR_MIN_SUBTOTAL"), farMinFee: numberAfter(djs, "FAR_MIN_FEE"),
      timeFactor: numberAfter(djs, "TIME_FACTOR") };
    // delivery by map point, exactly as the website prices it: shop location, distance zones, road-distance fallback
    const shop = djs.match(/SHOP\s*:\s*\{\s*lat\s*:\s*([\d.]+)\s*,\s*lng\s*:\s*([\d.]+)/);
    const zt = literalAfter(djs, "ZONES:");
    if (shop) rules.shop = { lat: +shop[1], lng: +shop[2] };
    if (zt) rules.zones = evalLiteral(zt).map(z => ({ name: String(z.name), maxKm: Number(z.maxKm), fee: Number(z.customerFee) }));
    rules.maxKm = numberAfter(djs, "MAX_KM"); rules.fallbackFactor = numberAfter(djs, "FALLBACK_FACTOR"); rules.fallbackSpeed = numberAfter(djs, "FALLBACK_SPEED_KMH");
  } catch {}
  if (!areas.length) areas = current.areas;
  current = { products, areas, rules, source: "site", fetchedAt: Date.now() };
  return current;
}

// Items sold in the shop but not listed on the website. Nutella only comes as kabaji:
// 10/20 pieces are priced like the sugar kabaji, 35 pieces like the mini kabaji (Hassan, 2026-11-02).
function withShopOnly(products) {
  const out = [...products];
  const has = re => out.some(p => re.test(p.name));
  const like = id => out.find(p => p.id === id);
  if (!has(/نوتيلا/)) {
    const k = like("kabajiSugar"), m = like("miniSugar");
    if (k) out.push({ id: "kabajiNutella", name: "كباجي نوتيلا", description: "", variants: k.variants.map(v => ({ ...v })) });
    if (m) out.push({ id: "miniNutella", name: "ميني كباجي نوتيلا", description: "", variants: m.variants.map(v => ({ ...v })) });
  }
  // sold in the shop, not on the website (Hassan, 2026-11-03): 5-piece pizza or manaqeesh 12 SAR, soft drink 3, water 1
  for (const id of ["pizza", "manaqeesh"]) {
    const i = out.findIndex(p => p.id === id);
    if (i >= 0 && !out[i].variants.some(v => /^5\s/.test(v.tag))) out[i] = { ...out[i], variants: [{ tag: "5 قطع", price: 12 }, ...out[i].variants] };
  }
  // one-day offer (Hassan, 2026-11-04): «بوكس المشاركة» 69 SAR, until midnight tonight
  if (Date.now() < Date.parse("2026-11-05T00:00:00+03:00") && !has(/بوكس المشاركة/))
    out.push({ id: "shareBox", name: "بوكس المشاركة", description: "18 قطعة قوارب · 5 قطع مناقيش · 10 قطع بيتزا (عرض اليوم فقط)", variants: [{ tag: "بوكس", price: 69 }] });
  if (!has(/مشروب|غاز/)) out.push({ id: "softDrink", name: "مشروب غازي", description: "", variants: [{ tag: "علبة", price: 3 }] });
  if (!has(/^ماء|مياه/)) out.push({ id: "water", name: "ماء", description: "", variants: [{ tag: "قارورة", price: 1 }] });
  return out;
}

export async function getMenu() {
  if (Date.now() - current.fetchedAt > REFRESH_MS && !inflight) {
    inflight = refresh().catch(e => { console.log("menu: refresh failed " + e.message); current.fetchedAt = Date.now() - REFRESH_MS + 5 * 60e3; })
      .finally(() => { inflight = null; });
    if (current.source === "snapshot") await inflight; // first call waits so the board starts with the live menu
  }
  return {
    products: withShopOnly(current.products).map(p => ({ ...p, flavors: flavorsOf(p) })),
    areas: current.areas, rules: current.rules, source: current.source, fetchedAt: current.fetchedAt,
  };
}

// Menu as text for the WhatsApp reader
export async function menuText() {
  const m = await getMenu();
  return m.products.map(p => `${p.name}${flavorsOf(p).length ? " (حشوات: " + flavorsOf(p).join("، ") + ")" : ""}: ` +
    p.variants.map(v => `${v.tag} ${v.price} ريال`).join("، ")).join("\n");
}
