// /tv and /admin (المدير التنفيذي 2026-11-17): two read-only screens on the board server, each behind its own code.
//   /tv    — TV / restaurant manager: today, this week vs the same days last week, 14 days by channel. No balance,
//            profit, commissions or customer data. No code of its own (Hassan 2026-11-17: he uses the TV himself):
//            a device logged in to the board opens it, otherwise the board login once.
//   /admin — Hassan only: full weekly card, all weeks, channels, apps, cancellations, waste, prep, lateness by stage,
//            new/returning customers. Code: env OWNER_CODE only (never the supervisor code).
// Definitions (fixed by the executive agent, do not change): sales = direct channels after returns, without delivery fees
// and without The Chefz; average order = sales ÷ priced orders; amounts with VAT; operating day starts 06:00;
// a partial week is never compared with a full one.
import crypto from "node:crypto";
import { execRow, HEADERS } from "./execsummary.mjs";
import { keyOf } from "./blacklist.mjs";
import { read } from "./sheets.mjs";

const APPS = ["chefz", "hunger", "keeta", "ninja"];
const DIRECT = ["shop", "call", "wa", "web"];
const LIVE = ["new", "prep", "ready", "out", "done"];
const FIRST_DAY = "2026-10-31";
const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const weekStart = d => addDays(d, -new Date(Date.parse(d + "T00:00:00Z")).getUTCDay());
export const opDayOf = ms => new Date(ms + 3 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);
const r2 = x => Math.round(x * 100) / 100;
const col = (row, name) => row[HEADERS.indexOf(name)];

export function codeOk(kind, code) {
  const want = String((kind === "admin" ? process.env.OWNER_CODE : process.env.TV_CODE) || ""), got = String(code || "");
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
export const codeSet = kind => !!(kind === "admin" ? process.env.OWNER_CODE : process.env.TV_CODE);

// one object per operating day, built with execRow (the same numbers as «الملخص_التنفيذي») + prep minutes and lateness by stage
export async function collectDays(pool, from, to) {
  const q = (sql, p) => pool.query(sql, p).then(r => r.rows).catch(() => []);
  const orders = await q(`SELECT id, num, op_day::text AS d, source, type, status, area, total, delivery_fee, due, travel_min, wa_from, phone, created
    FROM orders WHERE op_day BETWEEN $1 AND $2 AND status NOT IN ('pending','dismissed')`, [from, to]);
  const rw = await q("SELECT op_day::text AS d, kind, amount, cost FROM returns_waste WHERE op_day BETWEEN $1 AND $2", [from, to]);
  const ids = orders.map(o => o.id);
  const events = ids.length ? await q("SELECT order_id, to_status, at FROM order_events WHERE order_id = ANY($1) AND kind='status' ORDER BY at", [ids]) : [];
  const firsts = await q(`SELECT wa_from, phone, min(op_day)::text AS first FROM orders WHERE status IN ('new','prep','ready','out','done') GROUP BY wa_from, phone`);
  const firstOf = new Map();
  for (const f of firsts) { const k = keyOf(f.wa_from, f.phone); if (k && (!firstOf.has(k) || f.first < firstOf.get(k))) firstOf.set(k, f.first); }
  const evBy = new Map();
  for (const e of events) { const k = String(e.order_id); if (!evBy.has(k)) evBy.set(k, []); evBy.get(k).push(e); }
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const os = orders.filter(o => o.d === d);
    const ev = os.flatMap(o => evBy.get(String(o.id)) || []);
    const seenBefore = new Set([...firstOf].filter(([, f]) => f < d).map(([k]) => k));
    const row = execRow(d, { orders: os, returns: rw.filter(r => r.d === d && r.kind === "return"), waste: rw.filter(r => r.d === d && r.kind === "waste"), events: ev, seenBefore });
    const at = (id, st) => { const e = (evBy.get(String(id)) || []).find(x => x.to_status === st); return e ? Number(e.at) : null; };
    const preps = [], lateOut = [], latePrep = [];
    const keys = new Set();
    for (const o of os.filter(o => LIVE.includes(o.status))) {
      const p = at(o.id, "prep"), r = at(o.id, "ready");
      if (p && r && r > p && r - p < 4 * 3600e3) preps.push((r - p) / 60e3);
      const ourDel = o.type === "del" && !APPS.includes(o.source);
      const e = at(o.id, ourDel ? "out" : "ready");
      if (e && e - (Number(o.due) - (ourDel ? (Number(o.travel_min) || 15) * 60e3 : 0)) >= 60e3) (ourDel ? lateOut : latePrep).push(o.num);
      const k = keyOf(o.wa_from, o.phone); if (k && k.length >= 11) keys.add(k);
    }
    out.push({
      d, day: DAYS[new Date(Date.parse(d + "T00:00:00Z")).getUTCDay()],
      orders: col(row, "عدد الطلبات"), sales: col(row, "المبيعات (بدون التوصيل وذا شيفز، بعد المرتجع)"), priced: col(row, "طلبات مسعّرة"),
      apps: col(row, "طلبات التطبيقات"),
      ch: { shop: col(row, "المحل"), call: col(row, "اتصال"), wa: col(row, "واتساب"), web: col(row, "الموقع"), chefz: col(row, "ذا شيفز") },
      fees: col(row, "رسوم التوصيل المحصلة"), cancelled: col(row, "طلبات ملغية"), cancelledValue: col(row, "قيمة الملغي"),
      returns: col(row, "المرتجع"), waste: col(row, "الهدر بالتكلفة شامل الضريبة"),
      preps, lateOut: lateOut.length, latePrep: latePrep.length, keys: [...keys].map(k => [k, firstOf.get(k) || d]),
    });
  }
  return out;
}

// a range of days added up; customers counted once per range (new = first order ever inside the range)
export function sumDays(days, from, to) {
  const ds = days.filter(x => x.d >= from && x.d <= to);
  const s = { from, to, days: ds.length, orders: 0, sales: 0, priced: 0, apps: 0, ch: { shop: 0, call: 0, wa: 0, web: 0, chefz: 0 },
    fees: 0, cancelled: 0, cancelledValue: 0, returns: 0, waste: 0, lateOut: 0, latePrep: 0 };
  const preps = [], cust = new Map();
  for (const x of ds) {
    for (const k of ["orders", "sales", "priced", "apps", "fees", "cancelled", "cancelledValue", "returns", "waste", "lateOut", "latePrep"]) s[k] += Number(x[k]) || 0;
    for (const k of Object.keys(s.ch)) s.ch[k] += Number(x.ch[k]) || 0;
    preps.push(...x.preps);
    for (const [k, f] of x.keys) cust.set(k, f);
  }
  s.sales = r2(s.sales); s.avg = s.priced ? r2(s.sales / s.priced) : 0;
  for (const k of Object.keys(s.ch)) s.ch[k] = r2(s.ch[k]);
  s.prep = preps.length ? Math.round(preps.reduce((a, b) => a + b, 0) / preps.length) : null;
  s.late = s.lateOut + s.latePrep;
  s.newCust = [...cust.values()].filter(f => f >= from).length; s.retCust = cust.size - s.newCust;
  const direct = s.ch.shop + s.ch.call + s.ch.wa + s.ch.web;
  s.share = direct ? { call: r2((s.ch.shop + s.ch.call) / direct), wa: r2(s.ch.wa / direct), web: r2(s.ch.web / direct) } : null;
  return s;
}

// orders that should already be ready (or out with the courier) and are not
export async function lateNow(pool, now = Date.now()) {
  const { rows } = await pool.query(`SELECT source, type, status, due, travel_min FROM orders WHERE op_day=$1 AND status IN ('new','prep','ready')`, [opDayOf(now)]).catch(() => ({ rows: [] }));
  let n = 0;
  for (const o of rows) {
    const ourDel = o.type === "del" && !APPS.includes(o.source);
    if (o.status === "ready" && !ourDel) continue; // pickup ready = waiting on the customer, not late
    const must = Number(o.due) - (ourDel ? (Number(o.travel_min) || 15) * 60e3 : 0);
    if (now - must >= 60e3) n++;
  }
  return n;
}

export async function tvData(pool, now = Date.now()) {
  const today = opDayOf(now), from = addDays(today, -13), ws = weekStart(today), pws = addDays(ws, -7);
  const span = Math.round((Date.parse(today) - Date.parse(ws)) / 864e5); // days of this week so far, today included = span + 1
  const days = await collectDays(pool, [from, pws].sort()[0], today);
  const t = sumDays(days, today, today);
  const week = sumDays(days, ws, today), prev = sumDays(days, pws, addDays(pws, span));
  return {
    at: now, today, lateNow: await lateNow(pool, now),
    todayCard: { orders: t.orders, priced: t.priced, sales: t.sales, avg: t.avg, prep: t.prep },
    week: { from: ws, to: today, sales: week.sales, orders: week.orders, avg: week.avg },
    prev: { from: pws, to: addDays(pws, span), sales: prev.sales, orders: prev.orders, avg: prev.avg, partial: pws < FIRST_DAY },
    days14: days.filter(x => x.d >= from).map(x => ({ d: x.d, day: x.day, shop: r2(x.ch.shop + x.ch.call), wa: x.ch.wa, web: x.ch.web, chefz: x.ch.chefz })),
  };
}

// «مبيعات_التطبيقات» (written by Claude in Chrome and this board): daily rows only, per platform
async function appsDaily() {
  try {
    const rows = await read("مبيعات_التطبيقات", "A2:I");
    const num = v => { const n = Number(String(v ?? "").replace(/[٬,]/g, "").replace("٫", ".")); return Number.isFinite(n) ? n : null; };
    return rows.filter(r => /^\d{4}-\d\d-\d\d$/.test(r[0] || "") && String(r[7] || "").startsWith(r[0] + " إلى " + r[0]))
      .map(r => ({ d: r[0], platform: r[1], orders: num(r[2]), sales: num(r[3]) })).filter(r => r.sales != null);
  } catch { return null; }
}

export async function adminData(pool, now = Date.now()) {
  const today = opDayOf(now);
  const days = await collectDays(pool, FIRST_DAY, today);
  const apps = await appsDaily();
  const weeks = [];
  for (let ws = weekStart(FIRST_DAY); ws <= today; ws = addDays(ws, 7)) {
    const we = addDays(ws, 6);
    const s = sumDays(days, ws, we < today ? we : today);
    s.partial = ws < FIRST_DAY ? "قبل بداية اللوحة" : we >= today ? "الأسبوع الحالي" : null;
    if (apps) for (const pf of ["هنقرستيشن", "ذا شفز"]) {
      const rs = apps.filter(a => a.platform === pf && a.d >= ws && a.d <= we);
      const covered = new Set(rs.map(a => a.d)).size;
      s[pf === "هنقرستيشن" ? "hunger" : "chefzPortal"] = rs.length ? { sales: r2(rs.reduce((a, b) => a + b.sales, 0)), orders: rs.reduce((a, b) => a + (b.orders || 0), 0), days: covered } : null;
    }
    weeks.push(s);
  }
  const full = weeks.filter(w => !w.partial);
  return { at: now, today, weeks: weeks.reverse(), last: full[full.length - 1] || null, before: full[full.length - 2] || null, appsRead: !!apps };
}
