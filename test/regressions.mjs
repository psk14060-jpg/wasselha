import fs from "node:fs";
// Every real mistake on the board becomes a check here. Run before every deploy: npm test
import { subsidyFor, unifiedName } from "../subsidy.mjs";
import assert from "node:assert/strict";
process.env.SITE_URL = "http://127.0.0.1:1"; // use the built-in menu snapshot
const { fixSamosa, shopQuote, priceOrder, dayHint } = await import("../wa.mjs");
const { getMenu } = await import("../menu.mjs");
const { findPoint } = await import("../location.mjs");
const { keyOf } = await import("../blacklist.mjs");
const { placeUnknown } = await import("../reader.mjs");
const menu = await getMenu();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };

t("2026-11-03 #12: «سمبوسة مشكل ٢٠» = فطائر مثلثة ٢٠", () => {
  const p = { items: [{ id: "samosa", tag: "20 قطعة", qty: 1, flavor: "مشكل" }] };
  fixSamosa(p, "ابي سمبوسه مشكل ٢٠ قطع", menu);
  assert.deepEqual(p.items.map(i => [i.id, i.tag, i.qty]), [["triangles", "20 قطعة", 1]]);
});
t("2026-11-04 #13: «٣٠ سمبوسة بالفرن جبن ودجاج» = بوكس فطائر ٣٠ (مو ٥٠ سمبوسة جنوبية)", () => {
  const p = { items: [{ id: "samosa", tag: "20 قطعة", qty: 1, flavor: "جبن" }, { id: "samosa", tag: "10 قطع", qty: 1, flavor: "جبن" }, { id: "samosa", tag: "20 قطعة", qty: 1, flavor: "دجاج" }] };
  fixSamosa(p, "٣٠ حبه سمبوسة بالفرن جبن و دجاج", menu);
  assert.deepEqual(p.items.map(i => [i.id, i.tag, i.qty]), [["triangles", "30 قطعة", 1]]);
});
t("السمبوسة الجنوبية / المقلية / بالبر تبقى سمبوسة جنوبية", () => {
  for (const said of ["سمبوسة جنوبية دجاج ٢٠", "سمبوسة مقلية ١٠", "سميوسه البر ١٠ حبات"]) {
    const p = { items: [{ id: "samosa", tag: "10 قطع", qty: 1 }] };
    fixSamosa(p, said, menu); assert.equal(p.items[0].id, "samosa", said);
  }
});
t("2026-11-03 #8: كباجي ٢٠ + ١٠ يتسعّر ٥٨ (مو ٢ × ٢٠ = ٧٦)", () => {
  const b = priceOrder({ items: [{ id: "kabajiSugar", tag: "20 قطعة", qty: 1 }, { id: "kabajiSugar", tag: "10 قطع", qty: 1 }] }, menu);
  assert.equal(b.total, 58);
});
t("2026-11-02: كباجي نوتيلا موجود ومسعّر مثل الكباجي", () => {
  const b = priceOrder({ items: [{ id: "kabajiNutella", tag: "20 قطعة", qty: 1 }] }, menu);
  assert.equal(b.total, 38);
});
t("2026-11-03: بيتزا ٥ قطع ١٢، غازي ٣، ماء ١", () => {
  const b = priceOrder({ items: [{ id: "pizza", tag: "5 قطع", qty: 1 }, { id: "softDrink", tag: "علبة", qty: 2 }, { id: "water", tag: "قارورة", qty: 1 }] }, menu);
  assert.equal(b.total, 12 + 6 + 1);
});
t("2026-11-04: سعر المحل في المحادثة يُقرأ للمقارنة", () => {
  assert.equal(shopQuote([{ dir: "out", body: "125 مع التوصيل" }, { dir: "out", body: "اجهز الطلب" }]), 125);
  assert.equal(shopQuote([{ dir: "out", body: "الحساب 82 ريال" }]), 82);
  assert.equal(shopQuote([{ dir: "out", body: "تم اعتماد طلبك" }]), null);
});
const pin = await findPoint("[موقع] 25.383210,49.586400 البيت");
assert.deepEqual(pin, { lat: 25.38321, lng: 49.5864 }); n++; console.log("✓ دبوس الموقع يُقرأ");
const link = await findPoint("https://www.google.com/maps?q=25.3550,49.5900");
assert.deepEqual(link, { lat: 25.355, lng: 49.59 }); n++; console.log("✓ رابط قوقل ماب يُقرأ");
t("2026-11-04: رقم العميل نفسه بأي صيغة (05 / 966 / أرقام عربية)", () => {
  assert.equal(keyOf(null, "0501112223"), "966501112223");
  assert.equal(keyOf("966501112223"), "966501112223");
  assert.equal(keyOf(null, "٠٥٠١١١٢٢٢٣"), "966501112223");
});
t("2026-11-05 #3: «طلبك اليوم او بكرة» ← «بكرى الجمعه» = بكرة (مو اليوم)", () => {
  const thu = Date.parse("2026-11-05T10:04:00+03:00"); // Thursday
  assert.equal(dayHint(["أرجو تأكيد الطلب", "بكرى الجمعه", "هذا"], thu), 1);
  assert.equal(dayHint(["ابيه بكرة"], thu), 1);
  assert.equal(dayHint(["بعد بكرة العصر"], thu), 2);
  assert.equal(dayHint(["ابيه اليوم"], thu), 0);
  assert.equal(dayHint(["الأحد الساعة ٥"], thu), 3);
  assert.equal(dayHint(["ابي ٢٠ كباجي"], thu), null);
});
t("القاموس: كلمات العملاء اللي ما عرفها القارئ تتحول لأصناف المنيو", () => {
  const cases = [["كباجا 20 حبه", "kabajiSugar", "20 قطعة"], ["٤٢ حبة مني معجنات كب", "cupPizza", "42 قطعة"], ["30 فطاير", "triangles", "30 قطعة"],
    ["١٠ نوتيلا", "kabajiNutella", "10 قطع"], ["قوارب مسخن", "musakhanBoats18", "18 قطعة"], ["ميني كباجي كراميل", "miniCaramel", "35 قطعة"]];
  for (const [text, id, tag] of cases) {
    const p = { items: [{ text }] }; placeUnknown(p, menu);
    assert.equal(p.items[0].id, id, text); assert.equal(p.items[0].tag, tag, text);
  }
});
t("أسماء الكاشير في رواء: بوكس التذوق/الوجبة/الحفلات = ميني بيتزا 5/10/20، بوكس اللمة = 30 فطاير", () => {
  for (const [text, id, tag] of [["بوكس التذوق", "pizza", "5 قطع"], ["2 بوكس الوجبة", "pizza", "10 قطع"], ["بوكس الحفلات", "pizza", "20 قطعة"], ["بوكس اللمة", "triangles", "30 قطعة"]]) {
    const p = { items: [{ text }] }; placeUnknown(p, menu);
    assert.equal(p.items[0].id, id, text); assert.equal(p.items[0].tag, tag, text);
  }
  const p = { items: [{ text: "2 بوكس الوجبة" }] }; placeUnknown(p, menu); assert.equal(p.items[0].qty, 2);
});
t("2026-11-05 دعم التوصيل: أحد–أربعاء ومن ٦٠ ر، ٥ ر أساسي ويزيد إذا الهامش يسمح، لا دعم الخميس/الجمعة ٣–٩", () => {
  const sun = Date.parse("2026-11-08T19:00:00+03:00"), thu = Date.parse("2026-11-12T17:00:00+03:00"), sat = Date.parse("2026-11-07T12:00:00+03:00");
  const o = (items, total, due, extra = {}) => ({ type: "del", source: "call", deliveryFee: 10, total, due, created: Date.now(), items, ...extra });
  assert.equal(subsidyFor(o("1 × كب بيتزا 42 قطعة — 65 ريال", 75, sun)).amount, 5);          // cost unknown: base only
  assert.equal(subsidyFor(o("1 × كباجي جبن سائل برشة سكر 20 قطعة — 38 ريال\n1 × قوارب 18 قطعة — 35 ريال", 83, sun)).amount, 8); // margin allows more
  assert.equal(subsidyFor(o("1 × قوارب 18 قطعة — 35 ريال", 45, sun)).amount, 0);            // under 60
  assert.equal(subsidyFor(o("1 × كب بيتزا 42 قطعة — 65 ريال", 75, thu)).amount, 0);           // Thursday 5 pm
  assert.equal(subsidyFor(o("1 × كب بيتزا 42 قطعة — 65 ريال", 75, sat)).amount, 0);           // Saturday
  assert.equal(subsidyFor(o("1 × كب بيتزا 42 قطعة — 65 ريال", 65, sun, { type: "pick", deliveryFee: null })).amount, 0);
  assert.equal(subsidyFor(o("1 × كب بيتزا 42 قطعة — 65 ريال", 75, sun, { source: "chefz" })).amount, 0);
  assert.equal(subsidyFor(o("1 × كب بيتزا 42 قطعة — 65 ريال", 75, sun, { created: Date.parse("2026-11-01") })).amount, 0);
});
t("الملف المشترك: أصناف اللوحة تتحول للاسم الموحد في «المنيو والتكاليف»", () => {
  const names = ["كب بيتزا (42 حبة)", "كباجي جبن سايل (20 حبة)", "بوكس اللمة – فطاير مثلثة (30 حبة)", "قوارب أجبان مشكلة (18 حبة)", "قوارب مسخن (18 حبة)",
    "قوارب مشكلة أجبان ومسخن (22 حبة)", "ميني بيتزا (5 حبات)", "تشكيلة (48 حبة)", "ببسي (صغير)", "ميني كباجي كراميل مملح (35 حبة)"];
  for (const [t, want] of [["كب بيتزا 42 قطعة", names[0]], ["كباجي جبن سائل برشة سكر 20 قطعة", names[1]], ["فطائر مثلثة 30 قطعة (رانش)", names[2]],
    ["قوارب 18 قطعة", names[3]], ["قوارب المسخن 18 قطعة", names[4]], ["تشكيلة قوارب أجبان ومسخن تشكيلة", names[5]], ["بيتزا 5 قطع", names[6]],
    ["تشكيلة 48 تكفي 8–10", names[7]], ["مشروب غازي علبة", names[8]], ["ميني كباجي بالكراميل 35 قطعة", names[9]], ["كباجي نوتيلا 10 قطع", null]])
    assert.equal(unifiedName(t, names), want, t);
});
t("2026-11-05: أنماط التقارير ما تغيّر شكل اللوحة (رأس اللوحة .bar وأزرار الأصناف .tile)", () => {
  const css = fs.readFileSync(new URL("../src/board.style.css", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/board.template.html", import.meta.url), "utf8");
  for (const cls of ["bar", "tiles", "tile", "card", "muted"]) {
    const bare = css.split("}").filter(r => new RegExp("(^|,)\\s*\\." + cls + "\\s*$").test(r.split("{")[0].trim())).length;
    assert.ok(bare <= 1, "." + cls + " معرّف أكثر من مرة بدون نطاق");
  }
});
await (async () => {
  // 2026-11-05 one courier for close deliveries: suggest only when every customer gets it within 10 minutes of the promised time
  const { suggestBatches } = await import("../batch.mjs");
  const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("offline"); };
  const T = Date.parse("2026-11-05T18:00:00+03:00"), now = T - 60 * 60e3;
  const row = (id, num, due, dest, extra = {}) => ({ id, num, type: "del", source: "wa", status: "new", due, dest, travel_min: 10, area: "", ...extra });
  const tips = await suggestBatches([
    row(1, 4, T, "25.3400,49.5800"), row(2, 6, T + 5 * 60e3, "25.3460,49.5850"),
    row(3, 7, T + 90 * 60e3, "25.3410,49.5810"),                    // too late in the day to join
    row(4, 8, T, "25.3400,49.5800", { type: "pick" }),               // pickup
    row(5, 9, T, "25.4500,49.7000"),                                 // far away
  ], now);
  globalThis.fetch = realFetch;
  n++; assert.equal(tips.length, 1, "one suggestion"); assert.deepEqual(tips[0].nums.slice().sort(), [4, 6]);
  assert.ok(tips[0].late.every(x => x <= 10 && x >= -15), "every customer within 10 minutes");
  console.log("  ✓ مندوب واحد: يقترح #4 و#6 فقط، وكل عميل يوصله خلال ١٠ دقائق");
})();
console.log(`\n${n} checks passed`);
