// Reader support: what the shop corrected teaches the reader, words customers use map to menu items in code,
// and a scored check runs the reader against every past correction whenever the reader changes.
import crypto from "node:crypto";

export async function migrateReader(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS reader_examples (
    id BIGSERIAL PRIMARY KEY, order_id BIGINT, transcript TEXT NOT NULL, reader_items TEXT, correct_items TEXT NOT NULL, created BIGINT NOT NULL)`);
}

// The shop changed the items of an order the reader wrote: keep it as a lesson (transcript → what was right).
export async function recordCorrection(pool, before, newItems) {
  if (!before || before.source !== "wa" || !before.raw_text) return;
  const norm = x => String(x || "").split("\n").map(l => l.replace(/\s*—.*$/, "").trim()).filter(Boolean).sort().join("|");
  if (norm(before.items) === norm(newItems)) return;
  await pool.query("DELETE FROM reader_examples WHERE order_id=$1", [before.id]);
  await pool.query("INSERT INTO reader_examples (order_id, transcript, reader_items, correct_items, created) VALUES ($1,$2,$3,$4,$5)",
    [before.id, String(before.raw_text).slice(-1800), before.items, String(newItems).slice(0, 800), Date.now()]);
}

export async function recentExamples(pool, limit = 8, exceptOrder = 0) {
  return (await pool.query("SELECT transcript, correct_items FROM reader_examples WHERE order_id IS DISTINCT FROM $2 ORDER BY created DESC LIMIT $1", [limit, exceptOrder])).rows;
}

export function examplesText(ex) {
  if (!ex.length) return "";
  return "\nأمثلة حقيقية صحّحها المحل (تعلّم منها؛ المحادثة ثم الطلب الصحيح):\n" +
    ex.map((e, i) => `مثال ${i + 1}:\n${e.transcript.slice(-700)}\n← الصحيح: ${e.correct_items.replace(/\n/g, "، ")}`).join("\n\n");
}

// Words customers use for each product (kept here, not left to the reader). Order matters: specific before general.
export const GLOSSARY = [
  [/نوتيلا|نوتلا/, p => /ميني|٣٥|35/.test(p) ? "miniNutella" : "kabajiNutella"],
  [/ميني\s*كباج|كباجي\s*ميني|مني\s*كباج/, p => /كرميل|كراميل/.test(p) ? "miniCaramel" : "miniSugar"],
  [/كباج|كابج|كبج/, () => "kabajiSugar"],
  [/مسخن/, p => /تشكيل|اجبان|أجبان|جبن/.test(p) ? "cheeseMusakhanBoats" : "musakhanBoats18"],
  [/قوارب|قارب/, () => "boats18"],
  [/كب\s*بيتز|كاب\s*بيتز|كب\b|كاب\b|معجنات\s*كب/, () => "cupPizza"],
  [/مناقيش|منقوش/, () => "manaqeesh"],
  [/بيتزا|بيتزه/, () => "pizza"],
  [/جنوبي|مقلي|بالبر|البر/, () => "samosa"],
  [/مثلث|فطاير|فطائر|سمبوس/, () => "triangles"],
  [/بيبسي|كولا|سفن|ميرندا|حمضيات|غازي/, () => "softDrink"],
  [/ماء|موية|مويه/, () => "water"],
];
const latin = s => String(s).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

// Items the reader could not place ("text") are matched with the glossary and the piece count rebuilt from the sizes.
export function placeUnknown(p, menu) {
  if (!p || !Array.isArray(p.items)) return;
  const out = [];
  for (const it of p.items) {
    if (!it || it.id || !it.text) { out.push(it); continue; }
    const t = latin(it.text);
    const hit = GLOSSARY.find(([re]) => re.test(t));
    const prod = hit && menu.products.find(x => x.id === hit[1](t));
    if (!prod) { out.push(it); continue; }
    const want = parseInt((t.match(/(\d{1,3})/) || [])[1], 10);
    const sizes = prod.variants.map(v => ({ v, n: parseInt(v.tag, 10) || 0 })).filter(x => x.n).sort((a, b) => b.n - a.n);
    if (!sizes.length || !want) { out.push({ id: prod.id, tag: prod.variants[0].tag, qty: want && !sizes.length ? want : 1, flavor: "" }); continue; }
    let left = want; const tags = [];
    for (const x of sizes) while (left >= x.n) { tags.push(x.v.tag); left -= x.n; }
    if (left > 0 || !tags.length) { out.push(it); continue; }
    const counts = tags.reduce((m, tg) => (m[tg] = (m[tg] || 0) + 1, m), {});
    for (const [tag, qty] of Object.entries(counts)) out.push({ id: prod.id, tag, qty, flavor: "" });
  }
  p.items = out;
}

// Score the reader against every past correction (only when the reader or its rules changed).
export async function evalReader(pool, readFn, version, log = console.log) {
  const ex = (await pool.query("SELECT order_id, transcript, correct_items FROM reader_examples ORDER BY created DESC LIMIT 20")).rows;
  if (!ex.length) return;
  const done = await pool.query("SELECT value FROM board_settings WHERE key='reader_eval'");
  if (done.rows.length && done.rows[0].value === version) return;
  const norm = x => String(x || "").split("\n").map(l => l.replace(/\s*—.*$/, "").replace(/\s*\(.*?\)\s*$/, "").trim()).filter(Boolean).sort().join("|");
  let ok = 0;
  for (const e of ex) {
    try {
      const got = await readFn(e.transcript, e.order_id);
      if (norm(got) === norm(e.correct_items)) ok++;
      else log(`reader-eval: miss order ${e.order_id}: got «${String(got).replace(/\n/g, "، ")}» want «${e.correct_items.replace(/\n/g, "، ")}»`);
    } catch (err) { log("reader-eval: " + err.message); }
  }
  log(`reader-eval: ${ok}/${ex.length} past corrections read right (version ${version})`);
  await pool.query("INSERT INTO board_settings (key,value) VALUES ('reader_eval',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(version)]);
}

export const readerVersion = src => crypto.createHash("sha1").update(src).digest("hex").slice(0, 10);
