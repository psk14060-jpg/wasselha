// Weekly owner report and customer view, computed from the orders board.
// Every Sunday morning the previous week (Sunday–Saturday operating days) is summarised, compared with the
// week before, and Claude writes a short brief with the three decisions for the coming week.
import { getMenu } from "./menu.mjs";
import { tasteReport } from "./prefs.mjs";
import { subsidyFor, feeOfOrder } from "./subsidy.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const DAY = 864e5;
const opDayOf = ms => new Date(ms + 3 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);
const addDays = (k, n) => new Date(Date.parse(k) + n * DAY).toISOString().slice(0, 10);
const WEEKDAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const SRC = { web: "الموقع", wa: "واتساب", call: "اتصال", shop: "المحل", chefz: "ذا شيفز", hunger: "هنقرستيشن", keeta: "كيتا", ninja: "نينجا" };
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const LIVE = "status NOT IN ('cancelled','dismissed','pending')";

export async function migrateReports(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS weekly_reports (
    week_start DATE PRIMARY KEY, data JSONB NOT NULL, brief TEXT, created BIGINT NOT NULL)`);
}

// One customer per WhatsApp number or phone (05… and 9665… are the same person).
export function customerKey(o) {
  let d = String(o.wa_from || o.phone || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("05")) d = "966" + d.slice(1); else if (/^5\d{8}$/.test(d)) d = "966" + d;
  return d.length >= 11 ? d : null;
}

// "2 × كب بيتزا 28 قطعة — 94 ريال" → product name, quantity and line price
function itemLines(items, products) {
  const out = [];
  for (const raw of String(items || "").split("\n")) {
    const m = raw.trim().match(/^(\d+)\s*×\s*(.+?)(?:\s*—\s*([\d.]+)\s*ريال)?$/);
    if (!m) continue;
    const text = m[2].replace(/\s*\(.*?\)\s*$/, "").trim();
    const p = products.slice().sort((a, b) => b.name.length - a.name.length).find(x => text.startsWith(x.name));
    out.push({ product: p ? p.name : text, qty: +m[1], value: m[3] ? +m[3] : null });
  }
  return out;
}

async function weekFigures(pool, from, to, products) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE op_day >= $1 AND op_day < $2 AND ${LIVE}`, [from, to]);
  // sales = what the food sold for: no delivery fee (it goes to the outside couriers), no cancelled orders
  const rowO = o => ({ type: o.type, source: o.source, deliveryFee: o.delivery_fee == null ? null : Number(o.delivery_fee), area: o.area,
    total: o.total == null ? null : Number(o.total), due: Number(o.due), created: Number(o.created), items: o.items });
  const food = o => o.total == null ? 0 : Math.max(0, Number(o.total) - feeOfOrder(rowO(o)));
  const sum = a => a.reduce((s, x) => s + food(x), 0);
  const sales = sum(rows);
  const fees = rows.reduce((s, o) => s + (o.total == null ? 0 : feeOfOrder(rowO(o))), 0);
  const subsidy = rows.map(o => subsidyFor(rowO(o)).amount).filter(Boolean);
  const salesByHour = {};
  const bySource = {}, byWeekday = {}, byHour = {}, byProduct = {}, byArea = {};
  for (const o of rows) {
    const s = SRC[o.source] || o.source;
    bySource[s] = bySource[s] || { orders: 0, sales: 0 }; bySource[s].orders++; bySource[s].sales += food(o);
    const r = new Date(Number(o.due) + 3 * 3600e3);
    const wd = WEEKDAYS[new Date(Date.parse(String(o.op_day instanceof Date ? o.op_day.toISOString().slice(0, 10) : o.op_day))).getUTCDay()];
    byWeekday[wd] = (byWeekday[wd] || 0) + 1;
    const h = r.getUTCHours(); byHour[h] = (byHour[h] || 0) + 1; salesByHour[h] = (salesByHour[h] || 0) + food(o);
    for (const l of itemLines(o.items, products)) {
      byProduct[l.product] = byProduct[l.product] || { boxes: 0, sales: 0, orders: 0 };
      byProduct[l.product].boxes += l.qty; byProduct[l.product].orders++; byProduct[l.product].sales += l.value || 0;
    }
    if (o.type === "del" && o.area) { const a = String(o.area).replace(/\s*\(.*\)\s*$/, "").trim(); byArea[a] = (byArea[a] || 0) + 1; }
  }
  // late: a pickup ready after its time, our delivery out less than 15 minutes before its time
  const ev = (await pool.query(
    `SELECT order_id, to_status, min(at) AS at FROM order_events WHERE op_day >= $1 AND op_day < $2 AND to_status IN ('ready','out') GROUP BY 1,2`, [from, to])).rows;
  const evAt = new Map(ev.map(e => [e.order_id + ":" + e.to_status, Number(e.at)]));
  let measured = 0, late = 0;
  for (const o of rows) {
    const del = o.type === "del" && !APPS.includes(o.source);
    const at = evAt.get(o.id + ":" + (del ? "out" : "ready"));
    if (!at) continue;
    measured++;
    if (at > Number(o.due) - (del ? 15 * 60e3 : 0)) late++;
  }
  const keys = rows.map(customerKey).filter(Boolean);
  // cancelled orders and why (reason picked when cancelling; older ones read from the note)
  const cx = (await pool.query(`SELECT o.*, EXISTS (SELECT 1 FROM blacklist b WHERE b.op_day = o.op_day AND b.order_num = o.num) AS noshow FROM orders o
    WHERE o.op_day >= $1 AND o.op_day < $2 AND o.status = 'cancelled'`, [from, to])).rows;
  const cxReasons = {};
  for (const o of cx) {
    const why = o.cancel_reason || (/مكرر|دُمج/.test(o.note || "") ? "مكرر" : o.noshow ? "ما جاء يستلم" : /تأكيد لحجز/.test(o.note || "") ? "مكرر" : "غير محدد");
    cxReasons[why] = cxReasons[why] || { orders: 0, value: 0 }; cxReasons[why].orders++; cxReasons[why].value += food(o);
  }
  return {
    orders: rows.length, sales: Math.round(sales), avgTicket: rows.length ? Math.round(sales / rows.length) : 0,
    fees: Math.round(fees), subsidy: { orders: subsidy.length, total: subsidy.reduce((a, b) => a + b, 0) },
    salesByHour: Object.fromEntries(Object.entries(salesByHour).map(([k, v]) => [k, Math.round(v)])),
    cancelled: { orders: cx.length, value: Math.round(cx.reduce((s, o) => s + food(o), 0)),
      reasons: Object.fromEntries(Object.entries(cxReasons).map(([k, v]) => [k, { orders: v.orders, value: Math.round(v.value) }])) },
    withPhone: keys.length, customers: new Set(keys).size,
    appShare: rows.length ? Math.round(100 * rows.filter(o => APPS.includes(o.source)).length / rows.length) : 0,
    bySource, byWeekday, byHour, byArea,
    topProducts: Object.entries(byProduct).sort((a, b) => b[1].boxes - a[1].boxes).slice(0, 12).map(([name, v]) => ({ name, ...v, sales: Math.round(v.sales) })),
    late: { measured, late, pct: measured ? Math.round(100 * late / measured) : null },
  };
}

// Customers: everyone with a number, their history, who came back and who stopped ordering.
export async function customers(pool, lapseDays = 21) {
  const { rows } = await pool.query(`SELECT id, op_day, name, phone, wa_from, total, items, source, due FROM orders WHERE ${LIVE} ORDER BY due`);
  const by = new Map();
  for (const o of rows) {
    const k = customerKey(o); if (!k) continue;
    const c = by.get(k) || { key: k, name: "", orders: 0, spend: 0, first: Number(o.due), last: 0, lastItems: "", sources: {} };
    c.orders++; c.spend += Number(o.total) || 0; c.last = Math.max(c.last, Number(o.due));
    if (o.name && !/^بدون/.test(o.name)) c.name = o.name;
    c.lastItems = String(o.items || "").split("\n")[0]; c.sources[SRC[o.source] || o.source] = 1;
    by.set(k, c);
  }
  const now = Date.now(); const list = [...by.values()].map(c => ({ ...c, spend: Math.round(c.spend), sources: Object.keys(c.sources), daysSince: Math.floor((now - c.last) / DAY) }));
  const firstDay = rows.length ? Number(rows[0].due) : now;
  return {
    since: opDayOf(firstDay), total: list.length,
    repeat: list.filter(c => c.orders > 1).length,
    lapsed: list.filter(c => c.daysSince >= lapseDays).sort((a, b) => b.spend - a.spend).slice(0, 200),
    top: list.slice().sort((a, b) => b.spend - a.spend).slice(0, 20),
    noPhoneOrders: rows.filter(o => !customerKey(o)).length, lapseDays,
  };
}

async function writeBrief(apiKey, data) {
  const system = `أنت مستشار تشغيل وتسويق لمطعم مينيقيش (معجنات ميني للضيافة في الأحساء). أمامك أرقام أسبوع من لوحة الطلبات مقارنة بالأسبوع الذي قبله.
اكتب بالعربية، بدون مقدمات:
- «الخلاصة»: ٣ جمل فيها أهم ما تغيّر بالأرقام.
- «أهم ٣ نقاط للأسبوع القادم»: كل نقطة سطر واحد عملي ومربوط برقم من البيانات (تشغيل، أو شيء يراجعه وكيل التسويق).
- «تنبيه على البيانات» إن وُجد: مثل قلة الطلبات المسجّل لها رقم، أو صغر العينة.
لا تخترع أرقامًا غير موجودة، ولا توصِ بشيء لا تسنده البيانات. إذا كان الأسبوع السابق بلا بيانات فلا تقارن.
الأسعار والعروض والولاء ودعم التوصيل يقررها وكيل التسويق: لا تقترح سعرًا أو عرضًا، بل اذكر ما يحتاج أن يراجعه وكيل التسويق ولماذا.
المبيعات هنا بدون رسوم التوصيل وبدون الملغى، ولا تشمل مبيعات المحل المباشرة (تُسجَّل في رواء).`;
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: "user", content: JSON.stringify(data) }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error("claude_http_" + r.status);
  const j = await r.json();
  return (j.content || []).map(c => c.text || "").join("").trim();
}

// Report for the week starting on weekStart (a Sunday operating day).
export async function buildWeek(pool, weekStart, { save = true } = {}) {
  const menu = await getMenu();
  const end = addDays(weekStart, 7);
  const cur = await weekFigures(pool, weekStart, end, menu.products);
  const prev = await weekFigures(pool, addDays(weekStart, -7), weekStart, menu.products);
  const cust = await customers(pool);
  const taste = await tasteReport(pool, 7).catch(() => null);
  const newCustomers = (await pool.query(
    `SELECT count(*)::int AS n FROM (SELECT COALESCE(wa_from, phone) k, min(op_day) d FROM orders WHERE ${LIVE} AND COALESCE(wa_from, phone, '') <> '' GROUP BY 1) x WHERE d >= $1 AND d < $2`, [weekStart, end])).rows[0].n;
  const returning = (await pool.query(
    `SELECT count(*)::int AS n FROM (SELECT COALESCE(wa_from, phone) k FROM orders WHERE ${LIVE} AND op_day >= $1 AND op_day < $2 AND COALESCE(wa_from, phone, '') <> '' GROUP BY 1) w
      WHERE EXISTS (SELECT 1 FROM orders o WHERE ${LIVE} AND o.op_day < $1 AND COALESCE(o.wa_from, o.phone) = w.k)`, [weekStart, end])).rows[0].n;
  const data = {
    returning, shopSalesNote: "مبيعات المحل المباشرة في رواء وليست هنا",
    week: { from: weekStart, to: addDays(weekStart, 6) }, current: cur, previous: prev, newCustomers,
    customers: { total: cust.total, repeat: cust.repeat, lapsed: cust.lapsed.length, since: cust.since,
      lapsedTop: cust.lapsed.slice(0, 10).map(c => ({ name: c.name, key: c.key, orders: c.orders, spend: c.spend, daysSince: c.daysSince, lastItems: c.lastItems })) },
    taste: taste ? { changes: taste.changes.slice(0, 6).map(c => ({ product: c.product, ingredient: c.ingredient, change: c.change, customers: c.customers, productCustomers: c.product_customers })),
      lost: taste.lost.slice(0, 5).map(l => ({ product: l.product, reason: l.reason, customers: l.customers })) } : null,
  };
  let brief = null;
  if (process.env.ANTHROPIC_API_KEY) brief = await writeBrief(process.env.ANTHROPIC_API_KEY, data).catch(e => "تعذّرت كتابة الخلاصة (" + e.message + ")");
  if (save) await pool.query(`INSERT INTO weekly_reports (week_start, data, brief, created) VALUES ($1,$2,$3,$4)
    ON CONFLICT (week_start) DO UPDATE SET data=$2, brief=$3, created=$4`, [weekStart, JSON.stringify(data), brief, Date.now()]);
  return { weekStart, data, brief };
}

// Sunday of the week that contains operating day k
export const weekStartOf = k => addDays(k, -new Date(Date.parse(k)).getUTCDay());

// Every hour: from Sunday 08:00 (Riyadh) the finished week gets its report, once.
export function startWeeklyJob(pool, log = console.log) {
  const tick = async () => {
    try {
      const r = new Date(Date.now() + 3 * 3600e3);
      if (r.getUTCHours() < 8 && r.getUTCDay() === 0) return;
      const last = addDays(weekStartOf(opDayOf(Date.now())), -7);
      const done = await pool.query("SELECT 1 FROM weekly_reports WHERE week_start=$1", [last]);
      if (done.rows.length) return;
      const any = await pool.query("SELECT 1 FROM orders WHERE op_day >= $1 AND op_day < $2 LIMIT 1", [last, addDays(last, 7)]);
      if (!any.rows.length) return;
      await buildWeek(pool, last);
      log("weekly: report ready for " + last);
    } catch (e) { log("weekly: " + e.message); }
  };
  setTimeout(tick, 90e3);
  setInterval(tick, 3600e3);
}
