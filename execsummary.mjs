// «الملخص_التنفيذي» (Hassan 2026-11-16): one row per operating day in the shared sheet, for the executive agent.
// All sales channels are on the board since Rewaa stopped (shop, phone, website, WhatsApp, apps). Amounts with VAT.
// Sales are counted like the «مبيعات اليوم» chip: no cancelled/unconfirmed, no delivery fee, minus returns;
// The Chefz is shown in its own column and kept out of the sales total (Hassan 2026-11-06).
import { api, append, read, resetSheetIds, deleteDate } from "./sheets.mjs";
import { keyOf } from "./blacklist.mjs";
import { feeOf } from "./weeksales.mjs";

export const TAB = "الملخص_التنفيذي";
export const MGMT_TAB = "أرقام_الإدارة";
const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const CH = [["shop", "المحل"], ["call", "اتصال"], ["wa", "واتساب"], ["web", "الموقع"], ["hunger", "هنقرستيشن"], ["keeta", "كيتا"], ["ninja", "نينجا"], ["chefz", "ذا شيفز"]];
export const HEADERS = ["التاريخ", "اليوم", "عدد الطلبات", "المبيعات (بدون التوصيل وذا شيفز، بعد المرتجع)", "متوسط الطلب",
  ...CH.map(([, n]) => n), "رسوم التوصيل المحصلة", "طلبات ملغية", "قيمة الملغي", "المرتجع", "الهدر بالتكلفة شامل الضريبة",
  "متوسط التحضير (دقيقة)", "طلبات متأخرة", "عملاء جدد", "عملاء متكررون", "طلبات مسعّرة", "طلبات التطبيقات", "أُعدّ في",
  // after «أُعدّ في» (المدير التنفيذي 2026-11-17: new columns at the end): money collected per payment method, delivery fee included
  "كاش (المحصّل)", "شبكة (المحصّل)", "تحويل (المحصّل)", "دفع غير محدد (المحصّل)",
  "طلبات مباشرة بدون رقم جوال"];
const LIVE = ["new", "prep", "ready", "out", "done"];
const r2 = x => Math.round(x * 100) / 100;

// pure: everything for one day from rows already read (tested in test/regressions.mjs)
export function execRow(day, { orders, returns = [], waste = [], events = [], seenBefore = new Set() }) {
  const live = orders.filter(o => LIVE.includes(o.status));
  const net = o => o.total == null ? 0 : Math.max(0, Number(o.total) - feeOf(o));
  const by = Object.fromEntries(CH.map(([k]) => [k, 0]));
  let fees = 0;
  for (const o of live) { by[o.source] = (by[o.source] || 0) + net(o); fees += o.total == null ? 0 : feeOf(o); }
  const ret = returns.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const sales = Object.entries(by).filter(([k]) => k !== "chefz").reduce((s, [, v]) => s + v, 0) - ret;
  const counted = live.filter(o => o.source !== "chefz").length;
  // «طلبات مسعّرة» (المدير التنفيذي 2026-11-17): direct orders with a price; app orders on the board carry none and pulled the average down
  const priced = live.filter(o => !APPS.includes(o.source) && o.total != null).length;
  const apps = live.filter(o => APPS.includes(o.source)).length;
  const cancelled = orders.filter(o => o.status === "cancelled");
  const wasteCost = waste.reduce((s, w) => s + (Number(w.cost) || 0), 0) * 1.15;
  // preparation: first «تحضير» → first «جاهز»; late: ready (pickup/apps) or out (our deliveries) after it was due
  const at = (id, st) => { const e = events.find(x => String(x.order_id) === String(id) && x.to_status === st); return e ? Number(e.at) : null; };
  const preps = []; let late = 0;
  for (const o of live) {
    const p = at(o.id, "prep"), r = at(o.id, "ready");
    if (p && r && r > p && r - p < 4 * 3600e3) preps.push((r - p) / 60e3);
    const ourDel = o.type === "del" && !APPS.includes(o.source);
    const e = at(o.id, ourDel ? "out" : "ready");
    if (e && e - (Number(o.due) - (ourDel ? (Number(o.travel_min) || 15) * 60e3 : 0)) >= 60e3) late++;
  }
  const keys = [...new Set(live.map(o => keyOf(o.wa_from, o.phone)).filter(k => k && k.length >= 11))];
  const fresh = keys.filter(k => !seenBefore.has(k)).length;
  return [day, DAYS[new Date(Date.parse(day + "T00:00:00Z")).getUTCDay()], counted, r2(sales), priced ? r2(sales / priced) : 0,
    ...CH.map(([k]) => r2(by[k] || 0)), r2(fees), cancelled.length, r2(cancelled.reduce((s, o) => s + net(o), 0)), r2(ret), r2(wasteCost),
    preps.length ? Math.round(preps.reduce((a, b) => a + b, 0) / preps.length) : "", late, fresh, keys.length - fresh, priced, apps];
}

// collected per payment method: direct orders with a price, delivery fee included (what should be in the drawer / the bank)
export function payCols(orders) {
  const s = { cash: 0, card: 0, transfer: 0, none: 0 };
  for (const o of orders) {
    if (!LIVE.includes(o.status) || APPS.includes(o.source) || o.total == null) continue;
    s[["cash", "card", "transfer"].includes(o.pay) ? o.pay : "none"] += Number(o.total) || 0;
  }
  return [r2(s.cash), r2(s.card), r2(s.transfer), r2(s.none)];
}
// direct orders (not cancelled) with no usable phone number: they cannot be counted as a customer (المدير التنفيذي 2026-11-17)
export const noPhone = orders => orders.filter(o => LIVE.includes(o.status) && !APPS.includes(o.source) && !((keyOf(o.wa_from, o.phone) || "").length >= 11)).length;

async function ensureTabs() {
  const tabs = ((await api("GET", "?fields=sheets.properties")).sheets || []).map(s => s.properties.title);
  const add = [TAB, MGMT_TAB].filter(t => !tabs.includes(t));
  if (add.length) { await api("POST", ":batchUpdate", { requests: add.map(title => ({ addSheet: { properties: { title, rightToLeft: true } } })) }); resetSheetIds(); }
  const put = async (tab, rows) => api("PUT", `/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, { values: rows });
  const h = await read(TAB, "A1:AH1");
  if (JSON.stringify((h[0] || [])) !== JSON.stringify(HEADERS)) await put(TAB, [HEADERS]); // columns added later rewrite the header
  const m = await read(MGMT_TAB, "A1:A1");
  // filled by Hassan once a month; the board never writes below the header and the example row
  if (!(m[0] && m[0][0])) await put(MGMT_TAB, [["الشهر", "الرصيد البنكي", "إيجار المحل (شهري)", "الرواتب", "سكن العمال", "الغاز", "الكهرباء والماء", "الإقامات والتأمين", "اشتراكات وأنظمة", "تسويق", "صيانة", "أخرى", "ملاحظة"],
    ["2026-11", "", 2083, 10200, 1400, 2500, "", "", "", "", "", "", "مثال من أرقام أكتوبر: عدّل واملأ الفاضي (المبالغ شاملة الضريبة)"]]);
}

export async function syncExec(pool, day, log = console.log) {
  const { rows: orders } = await pool.query(`SELECT id, num, source, type, status, area, total, delivery_fee, due, travel_min, wa_from, phone, pay
    FROM orders WHERE op_day=$1 AND status NOT IN ('pending','dismissed')`, [day]);
  const q = (sql, p) => pool.query(sql, p).then(r => r.rows).catch(() => []);
  const returns = await q("SELECT amount FROM returns_waste WHERE op_day=$1 AND kind='return'", [day]);
  const waste = await q("SELECT cost FROM returns_waste WHERE op_day=$1 AND kind='waste'", [day]);
  const ids = orders.map(o => o.id);
  const events = ids.length ? await q("SELECT order_id, to_status, at FROM order_events WHERE order_id = ANY($1) AND kind='status' ORDER BY at", [ids]) : [];
  const before = await q("SELECT DISTINCT wa_from, phone FROM orders WHERE op_day < $1 AND status IN ('new','prep','ready','out','done')", [day]);
  const seenBefore = new Set(before.map(o => keyOf(o.wa_from, o.phone)).filter(Boolean));
  const row = execRow(day, { orders, returns, waste, events, seenBefore });
  row.push(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", ...payCols(orders), noPhone(orders));
  await ensureTabs();
  await deleteDate(TAB, day);
  await append(TAB, [row]);
  log(`exec: ${day} orders=${row[2]} sales=${row[3]}`);
  return row;
}
