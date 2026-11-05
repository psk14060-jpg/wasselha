// Shared Google Sheet between the agents («مينيقيش – ملف العمل المشترك للوكلاء»).
// The board writes only «المبيعات اليومية», «العملاء», «الإلغاء والتأخير» (same columns as the sheet), and notes in «ملاحظات».
// It reads «القواعد المعتمدة» (delivery subsidy on/off, rule changes) and «المنيو والتكاليف» (unified names and costs).
// Dates 2026-11-05, 24-hour Riyadh time, amounts with VAT, phones as the last 4 digits only, no shop (Rewaa) sales.
// Access: service account in GOOGLE_SA_JSON (shared on the file as editor).
import crypto from "node:crypto";
import { subsidyFor, feeOfOrder, unifiedName, setSheetCosts } from "./subsidy.mjs";
import { keyOf } from "./blacklist.mjs";

const SHEET_ID = process.env.SHARED_SHEET_ID || "1TTXbWtikFPDkTN_2GJPpMwdOCsNOZCowbRsJodXEm1U";
const WRITER = "وكيل التشغيل";
const T = { sales: "المبيعات اليومية", customers: "العملاء", cx: "الإلغاء والتأخير", notes: "ملاحظات", rules: "القواعد المعتمدة", menu: "المنيو والتكاليف" };
const SRC = { web: "الموقع", wa: "واتساب", call: "اتصال", shop: "المحل", chefz: "ذا شيفز", hunger: "هنقرستيشن", keeta: "كيتا", ninja: "نينجا" };
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const STATUS = { new: "جديد", prep: "تحضير", ready: "جاهز", out: "خرج", done: "تم", cancelled: "ملغي" };
const LAPSE_DAYS = 21;
const DAY = 864e5;

const riyadh = ms => new Date(Number(ms) + 3 * 3600e3);
const opDayOf = ms => new Date(Number(ms) + 3 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);
const hhmm = ms => riyadh(ms).toISOString().slice(11, 16);
const dateOf = ms => riyadh(ms).toISOString().slice(0, 10);
const dayStr = d => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
const areaName = a => { const n = String(a || "").replace(/📍/g, "").replace(/\s*\(.*\)\s*$/, "").split("·")[0].trim(); return /^[\d.]+\s*كم$/.test(n) ? "" : n; };
export const enabled = () => !!process.env.GOOGLE_SA_JSON;

// ---------- Google auth (service account JWT → access token) ----------
let tok = null;
async function token() {
  if (tok && tok.exp > Date.now() + 60e3) return tok.value;
  const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
  const key = String(sa.private_key).replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("google_token " + r.status + " " + (j.error_description || j.error || ""));
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.value;
}
async function api(method, path, body) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method, headers: { authorization: "Bearer " + await token(), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`sheets_${r.status} ${(j.error && j.error.message) || ""}`.trim());
  return j;
}
const rng = (tab, a1) => encodeURIComponent(`'${tab}'!${a1}`);
async function read(tab, a1) {
  return (await api("GET", `/values/${rng(tab, a1)}?valueRenderOption=UNFORMATTED_VALUE`)).values || [];
}
async function append(tab, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500)
    await api("POST", `/values/${rng(tab, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows.slice(i, i + 500) });
}
let sheetIds = null;
async function sheetId(tab) {
  if (!sheetIds) sheetIds = Object.fromEntries(((await api("GET", "?fields=sheets.properties")).sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
  if (sheetIds[tab] === undefined) throw new Error("tab_missing " + tab);
  return sheetIds[tab];
}
// Remove the data rows of one date (column A) from one of our own tabs, so a day can be rewritten without duplicates.
async function deleteDate(tab, date) {
  const col = await read(tab, "A:A");
  const rows = [];
  col.forEach((r, i) => { if (i > 0 && String(r[0] ?? "") === date) rows.push(i); });
  if (!rows.length) return 0;
  // contiguous blocks, deleted from the bottom up
  const blocks = [];
  for (const i of rows.sort((a, b) => b - a)) {
    const last = blocks[blocks.length - 1];
    if (last && last.start === i + 1) last.start = i; else blocks.push({ start: i, end: i + 1 });
  }
  const id = await sheetId(tab);
  await api("POST", ":batchUpdate", { requests: blocks.map(b => ({ deleteDimension: { range: { sheetId: id, dimension: "ROWS", startIndex: b.start, endIndex: b.end } } })) });
  return rows.length;
}

// ---------- small state kept in board_settings ----------
async function getS(pool, k) { const r = await pool.query("SELECT value FROM board_settings WHERE key=$1", [k]); return r.rows.length ? r.rows[0].value : null; }
async function setS(pool, k, v) { await pool.query("INSERT INTO board_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2", [k, JSON.stringify(v)]); }

export async function note(tab, text) {
  await append(T.notes, [[dateOf(Date.now()), WRITER, tab, String(text).slice(0, 500), "جديد"]]);
}

// ---------- read: approved rules and menu costs ----------
let names = [];       // unified names from «المنيو والتكاليف»
let costs = {};       // unified name → cost without VAT
let subsidyActive = true;
export const sheetState = () => ({ costs, subsidyActive, names });

function inForce(row, today) {
  const [, , start, end, status] = row;
  const d = v => v === "" || v == null ? null : typeof v === "number" ? new Date(Date.UTC(1899, 11, 30) + v * DAY).toISOString().slice(0, 10) : String(v).slice(0, 10);
  return String(status || "").trim() === "سارية" && (!d(start) || d(start) <= today) && (!d(end) || d(end) >= today);
}

export async function readShared(pool, log = console.log) {
  const menu = await read(T.menu, "A2:E200");
  names = menu.map(r => String(r[0] || "").trim()).filter(Boolean);
  costs = {};
  for (const r of menu) { const n = String(r[0] || "").trim(); const c = Number(String(r[4] ?? "").replace("٫", ".")); if (n && r[4] !== "" && r[4] != null && Number.isFinite(c)) costs[n] = c; }
  const rules = (await read(T.rules, "A2:E100")).filter(r => String(r[0] || "").trim());
  const today = opDayOf(Date.now());
  const sub = rules.find(r => /دعم التوصيل/.test(r[0]));
  subsidyActive = sub ? inForce(sub, today) : false;
  setSheetCosts(costs, subsidyActive);
  // a rule added or changed by the marketing agent: tell the shop's agent (the log) and leave a note that it was seen
  const seen = (await getS(pool, "sheet_rules")) || {};
  const now = {};
  for (const r of rules) now[String(r[0]).trim()] = [r[1], r[2], r[3], r[4]].map(x => String(x ?? "")).join(" | ");
  const changed = Object.keys(now).filter(k => seen[k] !== undefined && seen[k] !== now[k]);
  const added = Object.keys(now).filter(k => seen[k] === undefined && Object.keys(seen).length);
  for (const k of [...changed, ...added]) {
    log(`sheet: rule ${changed.includes(k) ? "changed" : "added"} «${k}»: ${now[k]}`);
    await note(T.rules, `استلمت ${changed.includes(k) ? "تعديل" : "إضافة"} القاعدة «${k}» (${now[k]}). ${/دعم التوصيل|الذروة/.test(k) ? "حالة دعم التوصيل في اللوحة الآن: " + (subsidyActive ? "مفعّل" : "موقوف") + "." : "تُراجع وتُطبّق في اللوحة."}`).catch(() => {});
  }
  await setS(pool, "sheet_rules", now);
  log(`sheet: read ${names.length} menu names, ${Object.keys(costs).length} costs, ${rules.length} rules, subsidy ${subsidyActive ? "on" : "off"}`);
}

// ---------- write: daily sales and cancelled/late ----------
function lines(items) {
  const out = [];
  for (const raw of String(items || "").split("\n")) {
    const t = raw.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).trim(); if (!t) continue;
    const m = t.match(/^(\d+)\s*×\s*(.+?)(?:\s*—\s*([\d.]+)\s*ريال.*)?$/);
    if (m) out.push({ qty: +m[1], text: m[2].replace(/\s*—.*$/, "").trim(), amount: m[3] ? +m[3] : null });
    else out.push({ qty: null, text: t.replace(/\s*—.*$/, ""), amount: null });
  }
  return out;
}
const rowO = o => ({ type: o.type, source: o.source, deliveryFee: o.delivery_fee == null ? null : Number(o.delivery_fee), area: o.area,
  total: o.total == null ? null : Number(o.total), due: Number(o.due), created: Number(o.created), items: o.items });

export async function syncDay(pool, day, log = console.log) {
  const { rows: orders } = await pool.query(
    `SELECT * FROM orders WHERE op_day=$1 AND status NOT IN ('pending','dismissed') AND source<>'shop' ORDER BY num`, [day]);
  const missing = new Set();
  const sales = [];
  for (const o of orders) {
    const base = [day, hhmm(o.due), o.num, SRC[o.source] || o.source];
    const fee = o.total == null || APPS.includes(o.source) ? "" : feeOfOrder(rowO(o)) || "";
    const ls = lines(o.items);
    if (!ls.length) ls.push({ qty: null, text: "(بدون أصناف)", amount: o.total == null ? null : Number(o.total) - (fee || 0) });
    ls.forEach((l, i) => {
      const u = unifiedName(l.text, names);
      if (!u && l.qty != null) missing.add(l.text.replace(/\s*\(.*?\)\s*$/, ""));
      sales.push([...base, u || l.text, l.qty ?? "", l.amount ?? "", i === 0 ? fee : "", STATUS[o.status] || o.status, o.type === "del" ? areaName(o.area) : ""]);
    });
    const sub = o.status === "cancelled" ? 0 : subsidyFor(rowO(o)).amount;
    if (sub) sales.push([...base, "دعم توصيل من المحل", 1, -sub, "", STATUS[o.status] || o.status, areaName(o.area)]);
  }
  await deleteDate(T.sales, day);
  await append(T.sales, sales);

  // cancelled (with the stage it was cancelled at and the reason) and late (minutes past the time it had to be ready / out)
  const ids = orders.map(o => o.id);
  const ev = ids.length ? (await pool.query(`SELECT order_id, from_status, to_status, at FROM order_events WHERE order_id = ANY($1) AND kind='status' ORDER BY at`, [ids])).rows : [];
  const first = (id, st) => ev.find(e => String(e.order_id) === String(id) && e.to_status === st);
  const black = (await pool.query("SELECT order_num FROM blacklist WHERE op_day=$1", [day]).catch(() => ({ rows: [] }))).rows.map(r => r.order_num);
  const cx = [];
  for (const o of orders) {
    if (o.status === "cancelled") {
      const e = ev.filter(x => String(x.order_id) === String(o.id) && x.to_status === "cancelled").pop();
      const why = o.cancel_reason || (/مكرر|دُمج|تأكيد لحجز/.test(o.note || "") ? "مكرر" : black.includes(o.num) ? "ما جاء يستلم" : "غير محدد");
      cx.push([day, o.num, "إلغاء", e && e.from_status ? STATUS[e.from_status] || e.from_status : "", "", why]);
      continue;
    }
    const ourDel = o.type === "del" && !APPS.includes(o.source);
    const e = first(o.id, ourDel ? "out" : "ready");
    if (!e) continue;
    const must = Number(o.due) - (ourDel ? (Number(o.travel_min) || 15) * 60e3 : 0);
    const late = Math.round((Number(e.at) - must) / 60e3);
    if (late >= 1) cx.push([day, o.num, "تأخير", ourDel ? "خروج للمندوب" : "التحضير", late, ""]);
  }
  await deleteDate(T.cx, day);
  await append(T.cx, cx);

  // board item names with no unified name in «المنيو والتكاليف»: one note per name
  const told = new Set((await getS(pool, "sheet_missing_names")) || []);
  const fresh = [...missing].filter(n => !told.has(n));
  if (fresh.length) {
    await note(T.menu, `أصناف تُباع في اللوحة وما لها اسم موحد في «المنيو والتكاليف»، كُتبت باسم اللوحة: ${fresh.join("، ")}`).catch(() => {});
    await setS(pool, "sheet_missing_names", [...told, ...fresh]);
  }
  log(`sheet: ${day} sales rows=${sales.length} orders=${orders.length} cancelled/late=${cx.length}${fresh.length ? " new-names=" + fresh.length : ""}`);
}

// ---------- write: customers (whole tab rewritten) ----------
export async function syncCustomers(pool, log = console.log) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE status NOT IN ('pending','dismissed','cancelled') AND source<>'shop' ORDER BY due`);
  const by = new Map();
  for (const o of rows) {
    const k = keyOf(o.wa_from, o.phone); if (!k || k.length < 11) continue;
    const c = by.get(k) || { k, n: 0, spend: 0, priced: 0, first: o.op_day, last: o.op_day, lastAt: 0, area: "" };
    c.n++;
    if (o.total != null) { c.spend += Math.max(0, Number(o.total) - feeOfOrder(rowO(o))); c.priced++; }
    c.last = o.op_day; c.lastAt = Number(o.due);
    if (o.type === "del" && areaName(o.area)) c.area = areaName(o.area);
    by.set(k, c);
  }
  const now = Date.now();
  const out = [...by.values()].sort((a, b) => b.n - a.n || b.spend - a.spend).map(c => {
    const lapsed = (now - c.lastAt) / DAY >= LAPSE_DAYS;
    const kind = [c.n > 1 ? "متكرر" : "مرة واحدة", lapsed ? "منقطع" : ""].filter(Boolean).join(" · ");
    return ["C" + crypto.createHash("sha256").update(c.k).digest("hex").slice(0, 8), c.k.slice(-4), c.n, dayStr(c.first), dayStr(c.last),
      c.priced ? Math.round(c.spend / c.priced) : "", kind, c.area];
  });
  await api("POST", `/values/${rng(T.customers, "A2:H")}:clear`, {});
  if (out.length) await api("PUT", `/values/${rng(T.customers, "A2")}?valueInputOption=RAW`, { values: out });
  log(`sheet: customers rows=${out.length}`);
}

// ---------- jobs ----------
let busy = false;
export function startSheetJob(pool, log = console.log) {
  if (!enabled()) { log("sheet: GOOGLE_SA_JSON not set, shared sheet off"); return; }
  const run = async first => {
    if (busy) return; busy = true;
    try {
      await readShared(pool, log);
      if (!(await getS(pool, "sheet_hello"))) {
        await note(T.notes, "تجربة: ربط لوحة الطلبات بالملف المشترك شغال. المبيعات تُكتب كل ليلة الساعة 2 فجرًا، والعملاء كل أحد.");
        await setS(pool, "sheet_hello", Date.now());
        log("sheet: hello note written");
      }
      const r = riyadh(Date.now());
      const today = opDayOf(Date.now());
      // 02:00 every night: the operating day that is ending (it started at 06:00 yesterday)
      if (r.getUTCHours() >= 2 && r.getUTCHours() < 6 && (await getS(pool, "sheet_sales_done")) !== today) {
        await syncDay(pool, today, log); await setS(pool, "sheet_sales_done", today);
      } else if (first) await syncDay(pool, today, log); // on start: today so far (rewritten in full at 02:00)
      const weekKey = dateOf(Date.now());
      if ((r.getUTCDay() === 0 && r.getUTCHours() >= 3 && (await getS(pool, "sheet_customers_done")) !== weekKey) || !(await getS(pool, "sheet_customers_done"))) {
        await syncCustomers(pool, log); await setS(pool, "sheet_customers_done", weekKey);
      }
    } catch (e) { log("sheet: " + e.message); }
    finally { busy = false; }
  };
  setTimeout(() => run(true), 30e3);
  setInterval(() => run(false), 10 * 60e3);
}
