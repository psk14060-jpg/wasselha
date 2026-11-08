import fs from "node:fs";
// Every real mistake on the board becomes a check here. Run before every deploy: npm test
import { subsidyFor as subsidyForReal, unifiedName, SUBSIDY_RULE as RULE0 } from "../subsidy.mjs";
import assert from "node:assert/strict";
process.env.SITE_URL = "http://127.0.0.1:1"; // use the built-in menu snapshot
const { fixSamosa, shopQuote, priceOrder, dayHint } = await import("../wa.mjs");
const { getMenu } = await import("../menu.mjs");
const { findPoint } = await import("../location.mjs");
const { keyOf } = await import("../blacklist.mjs");
const { placeUnknown } = await import("../reader.mjs");
const menu = await getMenu();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };

const { normItemLines, linesSum, unpricedLines } = await import("../itemlines.mjs");
t("2026-11-08 #21: بوكس مضاف بسعر مكتوب بأي شكل يدخل الإجمالي", () => {
  const base = "1 × فطائر مثلثة 20 قطعة — 35 ريال";
  for (const add of ["1 × بوكس تشكيلة العائلة ٦٩ ريال", "١ × بوكس تشكيلة العائلة - 69 ر", "1 x بوكس تشكيلة العائلة 69ريال", "1 × بوكس تشكيلة العائلة — ٦٩ ريال"]) {
    const s = normItemLines(base + "\n" + add);
    assert.equal(linesSum(s), 104, add);
    assert.match(s.split("\n")[1], /^1 × بوكس تشكيلة العائلة — 69 ريال$/, add);
  }
  assert.equal(normItemLines("1 × كباجي 10 قطع\n— 20 ريال"), "1 × كباجي 10 قطع — 20 ريال");
  assert.equal(normItemLines("2 × فطائر مثلثة 20 قطعة"), "2 × فطائر مثلثة 20 قطعة");
  assert.deepEqual(unpricedLines(base + "\n1 × بوكس تشكيلة العائلة"), ["1 × بوكس تشكيلة العائلة"]);
});

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
  const R = { ...RULE0, active: true }; // the rule as it worked while on (cancelled by Hassan 2026-11-08)
  const subsidyFor = (x) => subsidyForReal(x, R);
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
const { isFreeArea } = await import("../menu.mjs");
t("2026-11-05: النايفية والعزيزية توصيل مجاني بأي صيغة للاسم", () => {
  for (const x of ["النايفية", "حي النايفيه", "📍 العزيزية · 3.2 كم (توصيل 10 ر)", "العزيزيه (توصيل 5 ر)"]) assert.ok(isFreeArea(x), x);
  for (const x of ["المهندسين", "السلمانية", ""]) assert.ok(!isFreeArea(x), x);
});
const { canonArea } = await import("../sheets.mjs");
t("2026-11-06 الملف المشترك: اسم واحد لكل حي (المطرفي)", () => {
  for (const x of ["المطيرفي", "حي المطرفي", "المطرفى", "📍 المطيرفي · 2.3 كم (توصيل 10 ر)"]) assert.equal(canonArea(x), "المطرفي", x);
  assert.equal(canonArea("📍 حي النايفية · 1.1 كم (توصيل مجاني)"), "النايفية");
  assert.equal(canonArea("📍 1.1 كم (توصيل 5 ر)"), "");
});
const cap = await import("../capacity.mjs");
t("2026-11-06 «أقرب وقت»: فرن وقلي يشتغلون بنفس الوقت، القلي يكبر مع عدد الحبات", () => {
  const M = { oven: { lanes: 2, min: 14 }, fry: { lanes: 1, base: 6, per10: 3 } }, T = Date.parse("2026-11-06T17:00:00+03:00");
  const hm = ms => new Date(ms + 3 * 3600e3).toISOString().slice(11, 16), open = cap.openOf(T), none = { oven: [], fry: [] };
  assert.deepEqual(cap.stationsOf("1 × كب بيتزا 42 قطعة\n2 × كباجي جبن سائل برشة سكر 20 قطعة"), { oven: true, fryPcs: 40 });
  assert.equal(hm(cap.nextReady(none, T, "1 × قوارب 18 قطعة", M, open)), "17:14");                         // oven only
  assert.equal(hm(cap.nextReady(none, T, "1 × كباجي جبن سائل برشة سكر 20 قطعة", M, open)), "17:12");       // 6 + 3×2
  assert.equal(hm(cap.nextReady(none, T, "1 × قوارب 18 قطعة\n1 × كباجي جبن سائل برشة سكر 40 قطعة", M, open)), "17:18"); // max(14, 18)
  const fryBusy = cap.kitchenJobs([{ status: "prep", prepAt: T, items: "1 × كباجي جبن سائل برشة سكر 20 قطعة" }], T, M);
  assert.equal(hm(cap.nextReady(fryBusy, T, "1 × قوارب 18 قطعة", M, open)), "17:14");                      // fryer busy does not slow the oven
  assert.equal(hm(cap.nextReady(fryBusy, T, "1 × كباجي جبن سائل برشة سكر 20 قطعة", M, open)), "17:24");    // waits for the fryer
  const noon = Date.parse("2026-11-06T12:30:00+03:00");
  assert.equal(hm(cap.nextReady(none, noon, "1 × قوارب 18 قطعة", M, cap.openOf(noon))), "15:30");
});
t("2026-11-06: صفحة اللوحة المبنية تشتغل (ملفات مشتركة بنفس أسماء المتغيرات كسرت الصفحة كاملة)", () => {
  const h = fs.readFileSync(new URL("../public/board.html", import.meta.url), "utf8");
  for (const [, code] of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code);
});
{ const { typeHint } = await import("../wa.mjs");
  t("typeHint: آخر كلام العميل عن الاستلام أو التوصيل هو اللي يحكم", () => {
    assert.equal(typeHint(["فيه توصيل اليوم للسلمانيه الجنوبيه ؟", "قبل 5", "تمام حطه استلام", "ممتاز"]), "pick");
    assert.equal(typeHint(["ابي استلام", "لا خلاص ابي توصيل"]), "del");
    assert.equal(typeHint(["بجي اخذه الساعة 6"]), "pick");
    assert.equal(typeHint(["فيه توصيل للمطرفي؟"]), null);      // a question is not a choice
    assert.equal(typeHint(["20 قطعة فطاير"]), null);
  }); }
t("2026-11-07 #35: سطر صنف انكسر بـ Enter ما يصفّر الإجمالي", () => {
  const h = fs.readFileSync(new URL("../public/board.html", import.meta.url), "utf8");
  assert.match(h, /const joinItemLines=normItemLines/); assert.match(h, /function normItemLines/);
  const [join, sum] = [normItemLines, linesSum];
  const broken = "1 × كباجي جبن سائل برشة سكر 10\nقطعة — 20\n ريال";
  assert.equal(join(broken), "1 × كباجي جبن سائل برشة سكر 10 قطعة — 20 ريال");
  assert.equal(sum(broken), 20);
  assert.equal(sum("1 × قوارب 18 قطعة — 35 ريال\n2 × كب بيتزا 28 قطعة — 94 ريال"), 129);
});
console.log(`\n${n} checks passed`);

// the subsidy is off now (Hassan 2026-11-08)
assert.equal(subsidyForReal({ type: "del", source: "call", deliveryFee: 10, total: 75, due: Date.parse("2026-11-08T19:00:00+03:00"), created: Date.now(), items: "1 × كب بيتزا 42 قطعة — 65 ريال" }).amount, 0);
t("CSS كله داخل <style> (ما فيه شي بعد </style>)", () => {
  const css = fs.readFileSync(new URL("../src/board.style.css", import.meta.url), "utf8");
  assert.equal(css.trim().endsWith("</style>"), true);
});
