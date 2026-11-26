// «المشتريات» (Hassan 2026-11-26): the worker records purchase invoices on the board instead of sending photos.
// Supplier + invoice number + total (VAT worked out for registered suppliers), how it was paid, optional items and photo.
// Drawer money has ONE source: cash_moves. Every move has a unique key, so a double tap / double save never takes
// money out of the drawer twice (the shift-close screen, phase 2, reads the same table).
import { api, append, read, resetSheetIds, deleteDate } from "./sheets.mjs";

const r2 = x => Math.round(Number(x) * 100) / 100;
const nOf = v => { const x = parseFloat(String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/,/g, "")); return isFinite(x) ? x : 0; };
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
export const opDayOf = ms => new Date(ms + 3 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);

// VAT inside a VAT-inclusive total (15%); none for a supplier that is not VAT registered
export const vatOf = (total, registered) => registered ? r2(nOf(total) * 15 / 115) : 0;
export const linesSum = lines => r2((lines || []).reduce((s, l) => s + nOf(l.billed) * nOf(l.price), 0));
export function cleanLines(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, 60).map(l => ({
    name: clip(l.name, 80), unit: clip(l.unit, 20) || "حبة", factor: nOf(l.factor) || 1, base: clip(l.base, 20) || "حبة",
    billed: nOf(l.billed), received: l.received === "" || l.received == null ? nOf(l.billed) : nOf(l.received), price: nOf(l.price),
  })).filter(l => l.name);
}
// what enters stock and what is missing, from the approved lines
export function receipt(lines) {
  const stock = [], short = [];
  for (const l of lines || []) {
    if (l.received > 0) stock.push({ item: l.name, qty: r2(l.received * l.factor), base: l.base });
    if (l.received < l.billed) short.push(`${r2(l.billed - l.received)} ${l.unit} ${l.name}`);
  }
  return { stock, short };
}

// the suppliers found in November's invoices (Drive «فواتير المشتريات», read 2026-11-26); the shop adds the rest
const SEED = [
  ["شركة ثلاجة أجاويد للتجارة", "311376880600003", true, [["صدور دجاج 4×2.5 كجم", "كرتون", 10, "كيلو", 180], ["طحين فاخر 45 كجم", "كيس", 45, "كيلو", 37], ["جبن كريمي كيري 12×1 كجم", "كرتون", 12, "كيلو", 415], ["لبنة داري 4×2.7 كجم", "كرتون", 10.8, "كيلو", 152]]],
  ["ظل التوفير", "302005929900003", true, [["بصل", "كيلو", 1, "كيلو", 1.95], ["فلفل بارد", "كيلو", 1, "كيلو", 5.85], ["جزر", "كيلو", 1, "كيلو", 7.95], ["طماطم", "كيلو", 1, "كيلو", 4.95], ["ليمون أصفر", "كيلو", 1, "كيلو", 6.95]]],
  ["أسواق نجمة غيوم", "312822364100003", true, [["مياه 5 جالون", "حبة", 1, "حبة", 8], ["حليب المراعي 250 مل", "حبة", 1, "حبة", 4]]],
  ["شركة الشهراني العالمية (Bakers Way)", "310039528300003", true, [["دهن سائل الصافي 900 جم", "كرتون", 1, "كرتون", 75]]],
  ["شركة الموزع الأفضل للغاز", "300056834210003", true, [["غاز سائل", "لتر", 1, "لتر", 1.69]]],
  ["نايف ألفا للطباعة", "300828106900003", true, [["علبة 36×10×5", "حبة", 1, "حبة", 1.5], ["علبة 36×17.5×4.5", "حبة", 1, "حبة", 1.61], ["علبة ميني كرواسون", "حبة", 1, "حبة", 3.05]]],
  ["بو سعد للبلاستيك", "311021825200003", true, [["صحن مدور ذهبي", "كرتون", 1, "كرتون", 375]]],
  ["شركة عربة الفواكه", "", true, [["فلفل بارد", "كيلو", 1, "كيلو", 10.01], ["بصل أبيض", "كيلو", 1, "كيلو", 10.01]]],
  ["بقالة ماجد العتيبي", "312546853700003", true, []],
  ["محل محمد سعيد الجلال", "300488455700003", true, []],
  ["شركة على كيفك", "310496523610003", true, [["صواني فرن 41×29", "حبة", 1, "حبة", 49.95]]],
  ["مؤسسة نوف الركيان", "", false, []],
];

export async function migrateSupplies(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, vat TEXT, vat_registered BOOLEAN NOT NULL DEFAULT true,
    items JSONB NOT NULL DEFAULT '[]', active BOOLEAN NOT NULL DEFAULT true, created BIGINT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pinvoices (id BIGSERIAL PRIMARY KEY, supplier_id INT NOT NULL REFERENCES suppliers(id), inv_no TEXT, inv_date DATE NOT NULL,
    total NUMERIC, vat NUMERIC, lines JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', shortages JSONB NOT NULL DEFAULT '[]',
    entered_by TEXT, op_day DATE NOT NULL, created BIGINT NOT NULL, updated BIGINT NOT NULL, approved_at BIGINT, photo_link TEXT)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pinvoices_sup_no ON pinvoices (supplier_id, inv_no) WHERE inv_no IS NOT NULL AND inv_no <> ''`);
  // every movement of the cash drawer; key UNIQUE = the double-save guard
  await pool.query(`CREATE TABLE IF NOT EXISTS cash_moves (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, op_day DATE NOT NULL, type TEXT NOT NULL,
    label TEXT, amount NUMERIC NOT NULL, at BIGINT NOT NULL, by_name TEXT, doc TEXT, inv_id BIGINT, fix_of TEXT, reason TEXT)`);
  await pool.query("CREATE INDEX IF NOT EXISTS cash_moves_day ON cash_moves (op_day)");
  // supplier payments that do not touch the drawer (card, transfer, bank later)
  await pool.query(`CREATE TABLE IF NOT EXISTS pinv_payments (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, inv_id BIGINT NOT NULL, method TEXT NOT NULL,
    amount NUMERIC NOT NULL, at BIGINT NOT NULL, by_name TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stock_moves (id BIGSERIAL PRIMARY KEY, inv_id BIGINT, item TEXT NOT NULL, qty NUMERIC NOT NULL, base TEXT, at BIGINT NOT NULL,
    UNIQUE (inv_id, item))`);
  await pool.query("ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bytes BYTEA").catch(() => {});
  const done = await pool.query("SELECT 1 FROM board_settings WHERE key='suppliers_seed_v1'");
  if (!done.rows.length) {
    for (const [name, vat, reg, items] of SEED)
      await pool.query("INSERT INTO suppliers (name, vat, vat_registered, items, created) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING",
        [name, vat || null, reg, JSON.stringify(items.map(([n, unit, factor, base, price]) => ({ name: n, unit, factor, base, price }))), Date.now()]);
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('suppliers_seed_v1', 'true') ON CONFLICT (key) DO NOTHING");
  }
}

const invRow = (i, paid) => ({
  id: String(i.id), supplierId: i.supplier_id, no: i.inv_no || "", date: i.inv_date instanceof Date ? i.inv_date.toISOString().slice(0, 10) : String(i.inv_date).slice(0, 10),
  total: i.total == null ? null : Number(i.total), vat: i.vat == null ? null : Number(i.vat), lines: i.lines || [], status: i.status, shortages: i.shortages || [],
  enteredBy: i.entered_by || "", created: Number(i.created), photo: i.photo_link || "", photoWait: !!i.photo_wait,
  cash: r2(paid.cash || 0), other: r2(paid.other || 0), due: i.total == null ? null : r2(Number(i.total) - (paid.cash || 0) - (paid.other || 0)),
});
async function paidOf(pool, ids) {
  const m = {};
  if (!ids.length) return m;
  for (const r of (await pool.query("SELECT inv_id, -sum(amount) AS s FROM cash_moves WHERE inv_id = ANY($1::bigint[]) GROUP BY inv_id", [ids])).rows) (m[r.inv_id] = m[r.inv_id] || {}).cash = Number(r.s);
  for (const r of (await pool.query("SELECT inv_id, sum(amount) AS s FROM pinv_payments WHERE inv_id = ANY($1::bigint[]) GROUP BY inv_id", [ids])).rows) (m[r.inv_id] = m[r.inv_id] || {}).other = Number(r.s);
  return m;
}
export async function suppliesState(pool, now = Date.now()) {
  const day = opDayOf(now);
  const suppliers = (await pool.query("SELECT id, name, vat, vat_registered, items FROM suppliers WHERE active ORDER BY id")).rows
    .map(s => ({ id: s.id, name: s.name, vat: s.vat || "", vatRegistered: s.vat_registered, items: s.items || [] }));
  const inv = (await pool.query(`SELECT i.*, EXISTS (SELECT 1 FROM purchases p WHERE p.msg_id LIKE 'sup-' || i.id || '-%' AND p.status <> 'saved') AS photo_wait
    FROM pinvoices i WHERE i.op_day = $1 OR i.status = 'draft' OR (i.status = 'done' AND i.op_day >= $2) ORDER BY i.created DESC LIMIT 200`,
    [day, new Date(Date.parse(day) - 60 * 864e5).toISOString().slice(0, 10)])).rows;
  const paid = await paidOf(pool, inv.map(i => i.id));
  const invoices = inv.map(i => invRow(i, paid[i.id] || {}))
    .filter(i => i.status === "draft" || String(inv.find(x => String(x.id) === i.id).op_day).slice(0, 10) === day || (i.due || 0) > 0.009);
  const drawer = (await pool.query("SELECT COALESCE(sum(amount),0) AS s FROM cash_moves WHERE op_day=$1 AND type='purchase'", [day])).rows[0].s;
  return { day, suppliers, invoices, drawerToday: r2(-Number(drawer)) };
}

async function getInv(pool, id) { return (await pool.query("SELECT * FROM pinvoices WHERE id=$1", [id])).rows[0]; }
async function one(pool, id) { const i = await getInv(pool, id); if (!i) return null; return invRow(i, (await paidOf(pool, [i.id]))[i.id] || {}); }

export async function addSupplier(pool, b) {
  const name = clip(b.name, 80);
  if (name.length < 2) return { error: "اكتب اسم المورد" };
  const vat = clip(b.vat, 15).replace(/\D/g, "");
  if (vat && vat.length !== 15) return { error: "الرقم الضريبي 15 رقم" };
  const r = await pool.query("INSERT INTO suppliers (name, vat, vat_registered, created) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO UPDATE SET active=true RETURNING id",
    [name, vat || null, b.vatRegistered !== false, Date.now()]);
  return { id: r.rows[0].id };
}

// create or update a DRAFT; an approved invoice is never edited here
export async function saveInvoice(pool, b, now = Date.now()) {
  const sup = (await pool.query("SELECT * FROM suppliers WHERE id=$1", [Number(b.supplierId)])).rows[0];
  if (!sup) return { error: "اختر المورد" };
  const no = clip(b.no, 40), date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : opDayOf(now);
  const total = b.total === "" || b.total == null ? null : r2(nOf(b.total));
  const vat = b.vat === "" || b.vat == null ? (total == null ? null : vatOf(total, sup.vat_registered)) : r2(nOf(b.vat));
  const lines = cleanLines(b.lines), by = clip(b.enteredBy, 30);
  try {
    if (b.id) {
      const u = await pool.query(`UPDATE pinvoices SET supplier_id=$2, inv_no=$3, inv_date=$4, total=$5, vat=$6, lines=$7, entered_by=COALESCE(NULLIF($8,''), entered_by), updated=$9
        WHERE id=$1 AND status='draft' RETURNING id`, [b.id, sup.id, no || null, date, total, vat, JSON.stringify(lines), by, now]);
      if (!u.rows.length) return { error: "الفاتورة معتمدة، ما تتعدل من هنا", invoice: await one(pool, b.id) };
      return { invoice: await one(pool, b.id) };
    }
    const r = await pool.query(`INSERT INTO pinvoices (supplier_id, inv_no, inv_date, total, vat, lines, entered_by, op_day, created, updated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [sup.id, no || null, date, total, vat, JSON.stringify(lines), by || null, opDayOf(now), now]);
    return { invoice: await one(pool, r.rows[0].id) };
  } catch (e) {
    if (e.code === "23505") return { error: `فاتورة ${no} من ${sup.name} مسجّلة من قبل` };
    throw e;
  }
}

// cash out of the drawer for an invoice: ONE drawer payment per invoice (key pinv-<id>-cash); a second call finds it
export async function payCash(pool, id, amount, by, now = Date.now()) {
  const i = await getInv(pool, id);
  if (!i) return { error: "الفاتورة غير موجودة" };
  const a = r2(nOf(amount));
  if (!(a > 0)) return { error: "اكتب المبلغ" };
  const sup = (await pool.query("SELECT name FROM suppliers WHERE id=$1", [i.supplier_id])).rows[0];
  const r = await pool.query(`INSERT INTO cash_moves (key, op_day, type, label, amount, at, by_name, doc, inv_id) VALUES ($1,$2,'purchase',$3,$4,$5,$6,$7,$8)
    ON CONFLICT (key) DO NOTHING RETURNING id`, [`pinv-${i.id}-cash`, opDayOf(now), "مشتريات: " + sup.name, -a, now, clip(by, 30) || null, "فاتورة " + (i.inv_no || "(بدون رقم)"), i.id]);
  return { added: r.rows.length > 0, invoice: await one(pool, id) };
}

// card / transfer now, or the credit (آجل) settled later from the bank: never more than what is due; key from the page
export async function payOther(pool, id, b, now = Date.now()) {
  const i = await getInv(pool, id);
  if (!i) return { error: "الفاتورة غير موجودة" };
  const inv = await one(pool, id), a = r2(nOf(b.amount));
  const method = ["card", "transfer", "bank"].includes(b.method) ? b.method : null;
  if (!method) return { error: "طريقة الدفع" };
  if (!(a > 0)) return { error: "اكتب المبلغ" };
  if (inv.total != null && a > (inv.due || 0) + 0.009) return { error: `الباقي للمورد ${inv.due} بس` };
  const key = clip(b.key, 60) || `pinv-${i.id}-${method}-${a}`;
  const r = await pool.query("INSERT INTO pinv_payments (key, inv_id, method, amount, at, by_name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING RETURNING id",
    [key, i.id, method, a, now, clip(b.by, 30) || null]);
  return { added: r.rows.length > 0, invoice: await one(pool, id) };
}

// approve: draft → done once (the UPDATE … WHERE status='draft' is the guard); stock enters with the received quantities
export async function approveInvoice(pool, id, now = Date.now()) {
  const i = await getInv(pool, id);
  if (!i) return { error: "الفاتورة غير موجودة" };
  if (i.total == null || !(Number(i.total) > 0)) return { error: "اكتب إجمالي الفاتورة قبل الاعتماد" };
  const { stock, short } = receipt(i.lines || []);
  const u = await pool.query("UPDATE pinvoices SET status='done', approved_at=$2, shortages=$3, updated=$2 WHERE id=$1 AND status='draft' RETURNING id", [id, now, JSON.stringify(short)]);
  if (!u.rows.length) return { changed: false, invoice: await one(pool, id) };
  for (const s of stock) await pool.query("INSERT INTO stock_moves (inv_id, item, qty, base, at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (inv_id, item) DO NOTHING", [id, s.item, s.qty, s.base, now]);
  return { changed: true, invoice: await one(pool, id) };
}
export async function deleteDraft(pool, id) {
  const paid = (await pool.query("SELECT (SELECT count(*) FROM cash_moves WHERE inv_id=$1) + (SELECT count(*) FROM pinv_payments WHERE inv_id=$1) AS n", [id])).rows[0].n;
  if (Number(paid)) return { error: "فيها دفع مسجّل، ما تنحذف" };
  const d = await pool.query("DELETE FROM pinvoices WHERE id=$1 AND status='draft' RETURNING id", [id]);
  return d.rows.length ? { ok: true } : { error: "ما تنحذف" };
}
// the photo goes to Drive through the same nightly Apps Script as the WhatsApp purchase photos
export async function addPhoto(pool, id, b64, mime, by, now = Date.now()) {
  const i = await getInv(pool, id);
  if (!i) return { error: "الفاتورة غير موجودة" };
  const bytes = Buffer.from(String(b64 || ""), "base64");
  if (bytes.length < 1000 || bytes.length > 4e6) return { error: "الصورة ما وصلت كاملة" };
  const n = Number((await pool.query("SELECT count(*) AS c FROM purchases WHERE msg_id LIKE $1", [`sup-${i.id}-%`])).rows[0].c) + 1;
  const sup = (await pool.query("SELECT name FROM suppliers WHERE id=$1", [i.supplier_id])).rows[0];
  await pool.query(`INSERT INTO purchases (msg_id, wa_from, sender, at, mime, caption, pay, bytes) VALUES ($1,'board',$2,$3,$4,$5,'',$6) ON CONFLICT (msg_id) DO NOTHING`,
    [`sup-${i.id}-${n}`, clip(by, 30) || "اللوحة", now, /png/.test(mime) ? "image/png" : "image/jpeg", `مشتريات اللوحة: ${sup.name} فاتورة ${i.inv_no || ""}`.trim(), bytes]);
  return { invoice: await one(pool, id) };
}
export async function photoSaved(pool, msgId, link) {
  const m = String(msgId).match(/^sup-(\d+)-\d+$/);
  if (m) await pool.query("UPDATE pinvoices SET photo_link=$2 WHERE id=$1", [m[1], String(link).slice(0, 300)]);
}

// «مشتريات_اللوحة» in the shared sheet: one row per approved invoice, the day rewritten when anything on it changes
export const TAB = "مشتريات_اللوحة";
export const HEADERS = ["تاريخ الفاتورة", "المورد", "الرقم الضريبي للمورد", "رقم الفاتورة", "قبل الضريبة", "الضريبة", "الإجمالي شامل الضريبة",
  "من الدرج", "شبكة/تحويل/بنك", "باقي للمورد (آجل)", "نواقص الاستلام", "الأصناف", "صورة الفاتورة", "أدخلها", "رقم داخلي", "أُعدّ في"];
export function sheetRow(i, sup, at) {
  const lines = (i.lines || []).map(l => `${l.billed} ${l.unit} ${l.name} × ${l.price}`).join(" | ");
  return [i.date, sup.name, sup.vat || "", i.no, r2((i.total || 0) - (i.vat || 0)), i.vat || 0, i.total || 0, i.cash, i.other, i.due || 0,
    (i.shortages || []).join("، "), lines, i.photo || "", i.enteredBy, "P" + i.id, at];
}
async function ensureTab() {
  const tabs = ((await api("GET", "?fields=sheets.properties")).sheets || []).map(s => s.properties.title);
  if (!tabs.includes(TAB)) { await api("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title: TAB, rightToLeft: true } } }] }); resetSheetIds(); }
  const h = await read(TAB, "A1:Z1");
  if (JSON.stringify(h[0] || []) !== JSON.stringify(HEADERS)) await api("PUT", `/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`, { values: [HEADERS] });
}
export async function syncSuppliesDay(pool, date, log = console.log) {
  if (!process.env.GOOGLE_SA_JSON) return 0;
  const rows = (await pool.query("SELECT * FROM pinvoices WHERE status='done' AND inv_date=$1 ORDER BY id", [date])).rows;
  const paid = await paidOf(pool, rows.map(r => r.id));
  const sups = Object.fromEntries((await pool.query("SELECT * FROM suppliers")).rows.map(s => [s.id, s]));
  const at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  await ensureTab();
  await deleteDate(TAB, date);
  const out = rows.map(r => sheetRow(invRow(r, paid[r.id] || {}), sups[r.supplier_id], at));
  if (out.length) await append(TAB, out);
  log(`supplies-sheet: ${date} rows=${out.length}`);
  return out.length;
}
// called after approve / payment / photo: the invoice's day is rewritten a few seconds later (several taps → one write)
const pendingDays = new Map();
export function queueSync(pool, date, log = console.log) {
  if (!date) return;
  clearTimeout(pendingDays.get(date));
  pendingDays.set(date, setTimeout(() => { pendingDays.delete(date); syncSuppliesDay(pool, date, log).catch(e => log("supplies-sheet: " + e.message)); }, 8000));
}
export async function invDate(pool, id) { const i = await getInv(pool, id); return i ? (i.inv_date instanceof Date ? i.inv_date.toISOString().slice(0, 10) : String(i.inv_date).slice(0, 10)) : null; }
