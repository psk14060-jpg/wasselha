// one-off 2026-11-26 (Hassan «نعم»): November's purchase invoices 5–24 Nov into «المشتريات».
// 5–14 from the accountant's Excel (مشتريات_نوفمبر_2026.xlsx, lines priced VAT-inclusive), 17–24 read from the Drive photos.
// Runs once (board_settings pinv_import_1126); removed in the next commit.
import { syncSuppliesDay } from "./supplies.mjs";
const K = (name, unit, billed, price, base) => ({ name, unit, factor: 1, base: base || unit, billed, received: billed, price });
const D = id => `https://drive.google.com/file/d/${id}/view`;
// [date, supplier (name in suppliers), invoice no, total, vat, pay (cash|card|transfer|credit), by, lines, photo, note]
const ROWS = [
  ["2026-11-05", "شركة ثلاجة أجاويد للتجارة", "71758", 833.75, 108.75, "cash", "سليمان", [K("صدور دجاج 4×2.5 كجم", "كرتون", 3, 207), K("طحين فاخر 45 كجم", "كيس", 5, 42.55)]],
  ["2026-11-07", "شركة على كيفك", "196590", 149.85, 19.55, "cash", "سليمان", [K("صواني فرن 41×29", "حبة", 3, 49.95)]],
  ["2026-11-07", "أسواق نجمة غيوم", "64260", 8, 1.04, "cash", "سليمان", [K("مياه 5 جالون", "حبة", 1, 8)]],
  ["2026-11-07", "مؤسسة نوف الركيان", "100011202611070000014", 10, 0, "cash", "سليمان", [K("سيليكون", "حبة", 1, 10)]],
  ["2026-11-08", "ظل التوفير", "247080", 62.79, 8.19, "cash", "سليمان", [K("جزر", "كيلو", 2.282, 7.95), K("ليمون أصفر", "كيلو", 0.794, 6.95), K("فلفل بارد", "كيلو", 2.556, 5.85), K("بصل", "كيلو", 12.4, 1.95)]],
  ["2026-11-11", "نايف ألفا للطباعة", "05323", 9228, 1203.65, "transfer", "حسن", [K("علبة 36×10×5", "حبة", 1500, 1.49488), K("علبة 36×17.5×4.5", "حبة", 1500, 1.609867), K("علبة ميني كرواسون", "حبة", 1500, 3.047253)]],
  ["2026-11-12", "بو سعد للبلاستيك", "26400600219119", 375, 48.91, "card", "حسن", [K("صحن مدور ذهبي", "كرتون", 1, 375)], D("1HgFoz4wr9idwxtRkpdiP0DuUIyKyH1Vk")],
  ["2026-11-13", "أسواق نجمة غيوم", "66348", 16, 2.08, "cash", "سليمان", [K("مياه 5 جالون", "حبة", 1, 8), K("حليب المراعي 250 مل", "حبة", 2, 4)]],
  ["2026-11-13", "ظل التوفير", "245210", 49.82, 6.5, "cash", "سليمان", [K("باذنجان", "كيلو", 1.959, 1.95), K("بصل", "كيلو", 8.708, 1.95), K("فلفل بارد", "كيلو", 1.405, 5.95), K("ليمون أصفر", "كيلو", 0.426, 6.95), K("طماطم", "كيلو", 2.788, 4.95), K("ثوم 500 جم", "حبة", 2, 1.95)]],
  ["2026-11-14", "شركة ثلاجة أجاويد للتجارة", "72766", 652.05, 85.05, "cash", "سليمان", [K("جبن كريمي كيري 12×1 كجم", "كرتون", 1, 477.25), K("لبنة داري 4×2.7 كجم", "كرتون", 1, 174.8)], D("1QQeQz7hKcAO4KkM4j6P4cQfHshdN462Z")],
  ["2026-11-17", "بو سعد للبلاستيك", "2652301300144057", 5.75, 0.75, "cash", "سليمان", [], D("1URAhVO2NokUYqKJsxYUOSWXEMgcwFIV6")],
  ["2026-11-17", "ظل التوفير", "248863", 5.4, 0.7, "cash", "سليمان", [], D("1xGVuZ3W1atZSXJEB0PU-QyY97EGHJHSe")],
  ["2026-11-18", "أسواق نجمة غيوم", "68146", 4, 0.52, "card", "سليمان", [], D("1jD5-qJqbHX0sK0nsflY2k42YC6v7Uyim")],
  ["2026-11-19", "شركة عربة الفواكه", "26600542366", 30.02, 3.92, "cash", "سليمان", [], D("1JzKj7k-OPEhXx9FHkuAeQwradCtqucFp")],
  ["2026-11-19", "أسواق نجمة غيوم", "68446", 10, 1.3, "card", "سليمان", [], D("1SnssW_1U1Ib87lWV7QlxcwKZV3HkSO8g")],
  ["2026-11-19", "أسواق نجمة غيوم", "68566", 4, 0.52, "card", "سليمان", [], D("1wdHqrYkGVsbEUzuGtHM-TSpZVAXyV5WS")],
  ["2026-11-21", "شركة الشهراني العالمية (Bakers Way)", "123304-0126", 75, 9.78, "cash", "سليمان", [K("دهن سائل الصافي 900 جم", "كرتون", 1, 75)], D("1PdBNXcoRUvx4x2dvRA8_cQON-qg4zWHn")],
  ["2026-11-21", "أسواق نجمة غيوم", "69040", 4, 0.52, "card", "سليمان", [], D("1bYI8xQT45g6499Lad-dhWPoUMAMzaGn1")],
  ["2026-11-21", "ظل التوفير", "247517", 9.59, 1.25, "cash", "سليمان", [], D("14i-VcLAWO679Mxx8bkm3q9q0WtPfEhrD")],
  ["2026-11-21", "بقالة ماجد العتيبي", "26-200-000569", 8, 1.04, "cash", "سليمان", [], D("1toTZDPss8rYKMxJhlV4jqPW8CcHWaesS")],
  ["2026-11-22", "أسواق نجمة غيوم", "69397", 6, 0.78, "card", "سليمان", [], D("1FfYvKPnFN_3u0gXlkLgUnL7cR_4TAOT6")],
  ["2026-11-22", "محل محمد سعيد الجلال", "20792", 40, 5.22, "cash", "سليمان", [], D("1ytUfl7tIC2esXC_3rl7J_kR3W-RdZUfY")],
  ["2026-11-24", "شركة الموزع الأفضل للغاز", "9601196564", 2451.58, 319.77, "credit", "حسن", [K("غاز سائل", "لتر", 1451, 1.68958)], D("1POiXdr4SX0eAEyLgnHntB9gszCfscFXA")],
];
export async function importNov(pool, log = console.log) {
  if ((await pool.query("SELECT 1 FROM board_settings WHERE key='pinv_import_1126'")).rows.length) return;
  const sup = Object.fromEntries((await pool.query("SELECT id, name FROM suppliers")).rows.map(s => [s.name, s.id]));
  let n = 0, skip = 0, sum = 0; const days = new Set();
  for (const [date, name, no, total, vat, pay, by, lines, photo] of ROWS) {
    const sid = sup[name]; if (!sid) { log(`supplies-import: no supplier ${name}`); continue; }
    const at = Date.parse(date + "T12:00:00+03:00");
    const ins = await pool.query(`INSERT INTO pinvoices (supplier_id, inv_no, inv_date, total, vat, lines, status, entered_by, op_day, created, updated, approved_at, photo_link)
      VALUES ($1,$2,$3::date,$4,$5,$6,'done',$7,$3::date,$8,$8,$8,$9) ON CONFLICT DO NOTHING RETURNING id`, [sid, no, date, total, vat, JSON.stringify(lines), by + " (استيراد)", at, photo || null]);
    if (!ins.rows.length) { skip++; continue; }
    const id = ins.rows[0].id;
    if (pay === "cash") await pool.query(`INSERT INTO cash_moves (key, op_day, type, label, amount, at, by_name, doc, inv_id) VALUES ($1,$2::date,'purchase',$3,$4,$5,$6,$7,$8) ON CONFLICT (key) DO NOTHING`,
      [`pinv-${id}-cash`, date, "مشتريات: " + name, -total, at, by, "فاتورة " + no + " (استيراد نوفمبر)", id]);
    else if (pay === "card" || pay === "transfer") await pool.query("INSERT INTO pinv_payments (key, inv_id, method, amount, at, by_name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING", [`pinv-${id}-imp`, id, pay, total, at, by]);
    for (const l of lines) await pool.query("INSERT INTO stock_moves (inv_id, item, qty, base, at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (inv_id, item) DO NOTHING", [id, l.name, l.received * l.factor, l.base, at]);
    n++; sum += total; days.add(date);
  }
  await pool.query("INSERT INTO board_settings (key, value) VALUES ('pinv_import_1126', 'true') ON CONFLICT (key) DO NOTHING");
  log(`supplies-import: added=${n} skipped=${skip} total=${Math.round(sum * 100) / 100}`);
  for (const d of [...days].sort()) { await syncSuppliesDay(pool, d, log).catch(e => log("supplies-import sheet " + d + ": " + e.message)); await new Promise(r => setTimeout(r, 4000)); }
}
