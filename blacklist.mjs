// No-show list: customers who ordered for pickup and never came. Their next order is flagged so the shop can apologise.
export const keyOf = (waFrom, phone) => {
  let d = String(waFrom || phone || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("05")) d = "966" + d.slice(1); else if (/^5\d{8}$/.test(d)) d = "966" + d;
  return d.length >= 11 ? d : null;
};

export async function migrateBlacklist(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS blacklist (
    key TEXT PRIMARY KEY, name TEXT, reason TEXT, order_num INT, op_day DATE, times INT NOT NULL DEFAULT 1, created BIGINT NOT NULL)`);
}

export async function listBlacklist(pool) {
  return (await pool.query("SELECT key, name, reason, order_num AS \"orderNum\", op_day::text AS \"opDay\", times, created FROM blacklist ORDER BY created DESC")).rows;
}

// mark an order as a no-show: cancel it and put the customer on the list (a second no-show counts up)
export async function markNoShow(pool, orderId) {
  const { rows: [o] } = await pool.query("SELECT id, num, op_day, name, phone, wa_from, note FROM orders WHERE id=$1", [orderId]);
  if (!o) return { error: "not_found" };
  const key = keyOf(o.wa_from, o.phone);
  if (!key) return { error: "no_phone" };
  const day = o.op_day instanceof Date ? o.op_day.toISOString().slice(0, 10) : String(o.op_day);
  await pool.query(`INSERT INTO blacklist (key, name, reason, order_num, op_day, created) VALUES ($1,$2,'ما جاء للاستلام',$3,$4,$5)
    ON CONFLICT (key) DO UPDATE SET times=blacklist.times+1, order_num=$3, op_day=$4, created=$5, name=COALESCE(NULLIF($2,''), blacklist.name)`,
    [key, o.name || "", o.num, day, Date.now()]);
  await pool.query(`UPDATE orders SET status='cancelled', note=TRIM(BOTH ' ·' FROM note || ' · 🚫 ما جاء للاستلام'), updated=$2 WHERE id=$1`, [o.id, Date.now()]);
  return { ok: true, key };
}

// blacklisted numbers that wrote to the shop recently (kept in memory, shown on every board)
const pings = new Map();
export function notePing(key, name) { pings.set(key, { key, name: name || "", at: Date.now() }); }
export function recentPings() {
  const out = [];
  for (const [k, v] of pings) { if (Date.now() - v.at > 30 * 60e3) pings.delete(k); else out.push(v); }
  return out;
}
