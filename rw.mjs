// Returns and waste (Hassan 2026-11-06). Rule from the shared sheet («القواعد المعتمدة»): no return without Hassan's
// approval or the supervisor code, with a written reason. A return takes money back from an order (it comes off the
// day's sales); waste is food thrown away (burnt, dropped, expired, made too much) and is counted at cost.
import crypto from "node:crypto";
import { unifiedName, itemsCost } from "./subsidy.mjs";
import { sheetState } from "./sheets.mjs";

export async function migrateRw(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS returns_waste (
    id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, op_day DATE NOT NULL, at BIGINT NOT NULL,
    order_id BIGINT, order_num INT, item TEXT, qty NUMERIC, pieces INT, amount NUMERIC, cost NUMERIC,
    reason TEXT NOT NULL, note TEXT, by_dev TEXT)`);
  await pool.query("CREATE INDEX IF NOT EXISTS returns_waste_day ON returns_waste (op_day)");
}

// the supervisor code is a Render setting (SUPERVISOR_CODE); compared in constant time
export function supervisorOk(code) {
  const want = String(process.env.SUPERVISOR_CODE || "");
  const got = String(code || "");
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// cost of a waste line from «المنيو والتكاليف» (cost of one box; pieces counted as a share of the box)
export function wasteCost(item, qty, pieces) {
  const { costs, names } = sheetState();
  const u = unifiedName(item, names || []);
  if (!u || costs[u] == null) {
    // not in the sheet: the board's own cost per piece (subsidy.mjs) for one box, then scaled
    const one = itemsCost(`1 × ${item}`);
    if (one == null) return null;
    const boxPcs0 = +((String(item).match(/(\d+)\s*(?:قطعة|قطع|حبة)/) || [])[1] || 0);
    return Math.round(one * (pieces && boxPcs0 ? pieces / boxPcs0 : Number(qty) || 0) * 100) / 100;
  }
  const boxPcs = +((u.match(/\((\d+)/) || [])[1] || 0);
  const boxes = pieces && boxPcs ? pieces / boxPcs : Number(qty) || 0;
  return Math.round(costs[u] * boxes * 100) / 100;
}

const row = r => ({ id: String(r.id), kind: r.kind, at: Number(r.at), orderNum: r.order_num, item: r.item, qty: r.qty == null ? null : Number(r.qty),
  pieces: r.pieces, amount: r.amount == null ? null : Number(r.amount), cost: r.cost == null ? null : Number(r.cost), reason: r.reason, note: r.note });

export async function listRw(pool, day) {
  return (await pool.query("SELECT * FROM returns_waste WHERE op_day=$1 ORDER BY at DESC", [day])).rows.map(row);
}
export async function returnsOf(pool, day) {
  return (await pool.query("SELECT order_id, order_num, amount, reason FROM returns_waste WHERE op_day=$1 AND kind='return'", [day])).rows;
}

export async function addRw(pool, b, day, log = console.log) {
  const reason = String(b.reason || "").trim().slice(0, 60);
  const note = String(b.note || "").trim().slice(0, 200);
  if (!reason) return { status: 400, error: "اكتب السبب" };
  if (b.kind === "return") {
    if (!supervisorOk(b.code)) return { status: 403, error: "رمز المشرف غير صحيح" };
    const o = (await pool.query("SELECT id, num, total, delivery_fee FROM orders WHERE op_day=$1 AND num=$2", [day, parseInt(b.orderNum, 10) || 0])).rows[0];
    if (!o) return { status: 404, error: "رقم الطلب غير موجود اليوم" };
    const max = Math.max(0, Number(o.total || 0) - Number(o.delivery_fee || 0));
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount > 0) || amount > max + 0.01) return { status: 400, error: `المبلغ لازم يكون بين 1 و ${max} ريال` };
    const { rows: [r] } = await pool.query(`INSERT INTO returns_waste (kind, op_day, at, order_id, order_num, amount, reason, note, by_dev)
      VALUES ('return',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [day, Date.now(), o.id, o.num, amount, reason, note, String(b.dev || "").slice(0, 60)]);
    log(`rw: return #${o.num} ${amount} SAR (${reason})`);
    return { status: 201, entry: row(r) };
  }
  if (b.kind === "waste") {
    const item = String(b.item || "").trim().slice(0, 80);
    const qty = Math.max(0, Number(b.qty) || 0), pieces = Math.max(0, parseInt(b.pieces, 10) || 0);
    if (!item || (!qty && !pieces)) return { status: 400, error: "اختر الصنف والعدد" };
    const cost = wasteCost(item, qty, pieces);
    const { rows: [r] } = await pool.query(`INSERT INTO returns_waste (kind, op_day, at, item, qty, pieces, cost, reason, note, by_dev)
      VALUES ('waste',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [day, Date.now(), item, qty || null, pieces || null, cost, reason, note, String(b.dev || "").slice(0, 60)]);
    log(`rw: waste ${pieces ? pieces + " pcs" : qty + " box"} ${item} cost=${cost ?? "?"} (${reason})`);
    return { status: 201, entry: row(r) };
  }
  return { status: 400, error: "kind" };
}
