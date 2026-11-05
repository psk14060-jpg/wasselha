// Delivery subsidy (decided by the marketing agent, sent by Hassan 2026-11-05):
// Sunday–Wednesday, items of 60 SAR or more: the shop pays 5 SAR of the delivery fee, and more while the
// margin left after delivery stays at 65% or higher (never more than the fee). No subsidy Thursday and Friday 3–9 pm.
// Read as written: only Sunday–Wednesday qualify, so Thursday, Friday and Saturday get none at any hour.
// Shared by the server (reports) and the board (built into the page), so this file must stay plain JavaScript
// with no imports.

export const SUBSIDY_RULE = {
  from: Date.parse("2026-11-05T12:51:00+03:00"), // orders created before the rule keep no subsidy
  days: [0, 1, 2, 3],                            // Riyadh weekday of the delivery: Sun..Wed
  blocked: [{ days: [4, 5], fromHour: 15, toHour: 21 }],
  minItems: 60, base: 5, targetMargin: 0.65, vat: 0.15,
};

// Food cost per piece (Hassan's costing) plus 0.22 per box (box + bag 0.12, butter paper 0.10).
// The highest filling cost is used where fillings differ. Products with no known cost keep the base subsidy only.
const PIECE_COST = [
  [/كباجي نوتيلا|ميني كباجي/, null],
  [/كباجي/, 0.30],
  [/سمبوسة جنوبية/, 0.403],
  [/فطائر مثلثة|فطاير/, 0.46],
  [/قوارب المسخن|مسخن/, null],
  [/قوارب/, 0.39],
];
const BOX_COST = 0.22;

const latin = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

// Cost of the items text ("2 × فطائر مثلثة 20 قطعة (رانش) — 70 ريال"); null if any line has no known cost.
export function itemsCost(items) {
  let cost = 0, lines = 0;
  for (const raw of String(items || "").split("\n")) {
    const t = latin(raw).trim(); if (!t) continue;
    const m = t.match(/^(\d+)\s*×\s*(.+?)(?:\s*—\s*([\d.]+)\s*ريال)?$/);
    if (!m) return null;
    lines++;
    const qty = +m[1], text = m[2], price = m[3] ? +m[3] : null;
    if (/مشروب|غاز|ماء|مياه/.test(text)) { if (price == null) return null; cost += price; continue; } // drinks: no margin assumed
    const hit = PIECE_COST.find(([re]) => re.test(text));
    if (!hit || hit[1] == null) return null;
    const pcs = (text.match(/(\d+)\s*(?:قطعة|قطع|حبة)/) || [])[1];
    if (!pcs) return null;
    cost += qty * (+pcs * hit[1] + BOX_COST);
  }
  return lines ? cost : null;
}

// Fee of an order (stored, or written in the area label "(توصيل 10 ر)").
export function feeOfOrder(o) {
  if (o.deliveryFee != null) return +o.deliveryFee || 0;
  const m = String(o.area || "").match(/توصيل\s*([\d.]+)\s*ر/);
  return m ? +m[1] : 0;
}

const APP_SOURCES = ["chefz", "hunger", "keeta", "ninja"];

// { amount, pay, why } — amount 0 when the order does not qualify.
export function subsidyFor(o, rule = SUBSIDY_RULE) {
  const none = why => ({ amount: 0, pay: o.total == null ? null : +o.total, why });
  if (o.type !== "del" || APP_SOURCES.includes(o.source)) return none("");
  const fee = feeOfOrder(o);
  if (!fee || o.total == null) return none("");
  if (Number(o.created || 0) < rule.from) return none("");
  const items = +o.total - fee;
  if (items < rule.minItems) return none(`أقل من ${rule.minItems} ر`);
  const r = new Date(Number(o.due) + 3 * 3600e3), wd = r.getUTCDay(), h = r.getUTCHours();
  if (rule.blocked.some(b => b.days.includes(wd) && h >= b.fromHour && h < b.toHour)) return none("لا دعم الخميس والجمعة ٣–٩ م");
  if (!rule.days.includes(wd)) return none("الدعم من الأحد إلى الأربعاء");
  let amount = Math.min(fee, rule.base);
  const cost = itemsCost(o.items);
  let why = "دعم أساسي";
  if (cost != null) {
    const net = items / (1 + rule.vat);                       // margin is measured on the price without VAT
    const room = Math.floor(net * (1 - rule.targetMargin) - cost); // what the shop can pay and keep 65%
    if (room > amount) { amount = Math.min(fee, room); why = "هامش الطلب يسمح بأكثر"; }
  } else why = "دعم أساسي (تكلفة بعض الأصناف غير مسجّلة)";
  return { amount, pay: +o.total - amount, why };
}
