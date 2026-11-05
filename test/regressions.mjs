// Every real mistake on the board becomes a check here. Run before every deploy: npm test
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
console.log(`\n${n} checks passed`);
