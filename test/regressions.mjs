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
t("2026-11-09 مندوب التوصيل المجاني: «تم توصيل الطلب» تُفهم، والكلام العادي لا", async () => {
  const { DELIVERED, isCourier } = await import("../courier.mjs");
  for (const s of ["تم توصيل الطلب", "تم تسليم اطلب", "تم تسليم الطلب ✅", "سلمت الطلب", "وصلته", "تم", "تمت التوصيل #12"]) assert.ok(DELIVERED.test(s), s);
  for (const s of ["وين الموقع؟", "العميل ما يرد", "بطلع الحين", "كم الحساب"]) assert.ok(!DELIVERED.test(s), s);
  const keep = process.env.COURIER_PHONES; process.env.COURIER_PHONES = "0500000001";
  assert.ok(isCourier("966500000001")); assert.ok(isCourier("0500000001")); assert.ok(!isCourier("966553214828"));
  delete process.env.COURIER_PHONES; assert.ok(!isCourier("966500000001")); if (keep) process.env.COURIER_PHONES = keep;
  assert.ok(!/\b5\d{8}\b/.test(fs.readFileSync(new URL("../courier.mjs", import.meta.url), "utf8")), "no phone number in courier.mjs (public repo)");
});
t("2026-11-11 فصل الفواتير عن صور العملاء: صورة عميل ما تصير فاتورة، وفاتورة ما تروح للقارئ", async () => {
  const src = fs.readFileSync(new URL("../purchases.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("if (!who) {") && src.includes("return null; } // only Hassan and Suleiman"), "purchases only from allowed senders");
  const wa = fs.readFileSync(new URL("../wa.mjs", import.meta.url), "utf8");
  assert.ok(wa.includes("isPurchaseSender(pool, m.from)") && wa.includes("!invoiceIds.has(r.id)"), "reader skips invoices");
});
t("2026-11-12 #3: «30 سمبوسة جنوبية بر» = سمبوسة جنوبية 20 + 10 (مو فطائر 30)", async () => {
  const { fixSamosa } = await import("../wa.mjs");
  const menu = { products: [
    { id: "samosa", variants: [{ tag: "10 قطع", price: 20 }, { tag: "20 قطعة", price: 38 }] },
    { id: "triangles", variants: [{ tag: "10 قطع", price: 20 }, { tag: "20 قطعة", price: 35 }, { tag: "30 قطعة", price: 45 }] }] };
  const p = { items: [{ id: "triangles", tag: "30 قطعة", qty: 1, flavor: "" }] };
  fixSamosa(p, "ابي ٣٠ قطعه سمبوسة جنوبية بر", menu);
  assert.deepEqual(p.items.map(i => i.id + ":" + i.tag + "x" + i.qty).sort(), ["samosa:10 قطعx1", "samosa:20 قطعةx1"]);
  const q = { items: [{ id: "triangles", tag: "20 قطعة", qty: 1, flavor: "" }] };
  const r = { items: [{ id: "triangles", tag: "30 قطعة", qty: 1, flavor: "جبن ودجاج" }] };
  fixSamosa(r, "لا\n30 حبه مكس بر عكاوي دجاج\nخلاص كباجي", menu); // the real #3 chat: no «سمبوسة» word, «بر» alone
  assert.equal(r.items.filter(i => i.id === "samosa").length, 2);
  fixSamosa(q, "20 سمبوسة دجاج", menu); // plain «سمبوسة» stays triangles
  assert.equal(q.items[0].id, "triangles");
});
t("2026-11-15 قائمة مرسلي المشتريات تُقرأ سواء رجعت نص أو كائن (عمود json)", async () => {
  const src = fs.readFileSync(new URL("../purchases.mjs", import.meta.url), "utf8");
  assert.ok(src.includes('typeof r.value === "string"'), "senders() handles a parsed json value");
});
t("2026-11-15 #13: إجمالي طلب الواتساب = الأصناف + التوصيل (كان 16 والصحيح 26)", async () => {
  const { expectedTotal } = await import("../totals.mjs");
  assert.equal(expectedTotal({ source: "wa", type: "del", items: "1 × مناقيش 10 قطع — 21 ريال", delivery_fee: 5, total: 16 }), 26);
  assert.equal(expectedTotal({ source: "wa", type: "pick", items: "1 × مناقيش 10 قطع — 21 ريال\n2 × كب بيتزا — 30 ريال", delivery_fee: 5 }), 51);
  assert.equal(expectedTotal({ source: "call", type: "del", items: "1 × فطائر ٣٠ قطعة ٤٥ ريال", delivery_fee: 0 }), 45);
  assert.equal(expectedTotal({ source: "web", type: "del", items: "1 × مناقيش 10 قطع — 21 ريال", delivery_fee: 5 }), null); // website keeps its own total
  assert.equal(expectedTotal({ source: "chefz", type: "pick", items: "1 × مناقيش 10 قطع — 21 ريال" }), null);
  assert.equal(expectedTotal({ source: "wa", type: "del", items: "1 × مناقيش 10 قطع — 21 ريال\n1 × صوص", delivery_fee: 5 }), null); // unpriced line: keep
  assert.equal(expectedTotal({ source: "wa", type: "del", items: "1 × مناقيش 10 قطع — 21 ريال", note: "خصم 5", delivery_fee: 5 }), null); // typed discount: keep
  const srv = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(srv.includes("fixOpenTotals(pool)") && (srv.match(/fixTotal\(pool/g) || []).length >= 2, "checked on insert, edit and every minute");
});
t("2026-11-16 الملخص التنفيذي: سطر اليوم من كل القنوات (المحل محسوب، ذا شيفز والتوصيل والملغي برا المبيعات)", async () => {
  const { execRow, HEADERS } = await import("../execsummary.mjs");
  const due = Date.parse("2026-11-15T18:00:00+03:00");
  const orders = [
    { id: 1, source: "shop", type: "pick", status: "done", total: 50, due, phone: "0501111111" },
    { id: 2, source: "wa", type: "del", status: "done", total: 26, delivery_fee: 5, due, wa_from: "966502222222" },
    { id: 3, source: "chefz", type: "pick", status: "done", total: 67.5, due },
    { id: 4, source: "call", type: "pick", status: "cancelled", total: 30, due, phone: "0503333333" },
  ];
  const events = [{ order_id: 1, to_status: "prep", at: due - 20 * 60e3 }, { order_id: 1, to_status: "ready", at: due - 8 * 60e3 },
    { order_id: 2, to_status: "prep", at: due - 30 * 60e3 }, { order_id: 2, to_status: "ready", at: due - 22 * 60e3 }, { order_id: 2, to_status: "out", at: due + 10 * 60e3 }];
  const row = execRow("2026-11-15", { orders, returns: [{ amount: 10 }], waste: [{ cost: 10 }], events, seenBefore: new Set(["966501111111"]) });
  const col = n => row[HEADERS.indexOf(n)];
  assert.equal(col("اليوم"), "الأحد");
  assert.equal(col("عدد الطلبات"), 2);
  assert.equal(col("المبيعات (بدون التوصيل وذا شيفز، بعد المرتجع)"), 50 + 21 - 10);
  assert.equal(col("المحل"), 50); assert.equal(col("واتساب"), 21); assert.equal(col("ذا شيفز"), 67.5);
  assert.equal(col("رسوم التوصيل المحصلة"), 5);
  assert.equal(col("طلبات ملغية"), 1); assert.equal(col("قيمة الملغي"), 30);
  assert.equal(col("الهدر بالتكلفة شامل الضريبة"), 11.5);
  assert.equal(col("متوسط التحضير (دقيقة)"), 10);
  assert.equal(col("طلبات متأخرة"), 1); // the delivery left after its departure time
  assert.equal(col("عملاء جدد"), 1); assert.equal(col("عملاء متكررون"), 1);
  assert.equal(col("طلبات مسعّرة"), 2); assert.equal(col("طلبات التطبيقات"), 1);
  assert.equal(col("متوسط الطلب"), 30.5); // sales ÷ priced direct orders, apps without a price do not pull it down
  assert.equal(row.length, HEADERS.indexOf("أُعدّ في")); // «أُعدّ في» and the payment columns are added when written
});
t("2026-11-17 /tv و/admin: جمع الأسبوع، الأسبوع الناقص، والرموز منفصلة", async () => {
  const { sumDays, codeOk, weekStart } = await import("../dash.mjs");
  const day = (d, sales, priced, keys) => ({ d, orders: priced, sales, priced, apps: 0, ch: { shop: 0, call: sales, wa: 0, web: 0, chefz: 0 }, fees: 0, cancelled: 0, cancelledValue: 0, returns: 0, waste: 0, preps: [10, 14], lateOut: 1, latePrep: 0, keys });
  const s = sumDays([day("2026-11-08", 100, 2, [["A", "2026-11-01"]]), day("2026-11-09", 200, 3, [["B", "2026-11-09"], ["A", "2026-11-01"]]), day("2026-11-20", 999, 1, [])], "2026-11-08", "2026-11-14");
  assert.equal(s.sales, 300); assert.equal(s.avg, 60); assert.equal(s.prep, 12); assert.equal(s.late, 2);
  assert.equal(s.newCust, 1); assert.equal(s.retCust, 1); // a customer counted once per week
  assert.equal(weekStart("2026-11-17"), "2026-11-15");
  const old = [process.env.TV_CODE, process.env.OWNER_CODE];
  process.env.TV_CODE = "1111"; process.env.OWNER_CODE = "2222";
  assert.ok(codeOk("tv", "1111") && !codeOk("admin", "1111") && codeOk("admin", "2222") && !codeOk("tv", "2222"));
  delete process.env.OWNER_CODE; process.env.SUPERVISOR_CODE = "2222";
  assert.ok(!codeOk("admin", "2222"), "admin never falls back to the supervisor code");
  [process.env.TV_CODE, process.env.OWNER_CODE] = old; if (old[0] === undefined) delete process.env.TV_CODE; if (old[1] === undefined) delete process.env.OWNER_CODE; delete process.env.SUPERVISOR_CODE;
  const tv = fs.readFileSync(new URL("../src/tv.template.html", import.meta.url), "utf8");
  for (const bad of ["رصيد", "أرباح", "عمولة", "phone", "wa_from"]) assert.ok(!tv.includes(bad), "TV page must not show " + bad);
  const srv = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(/kind === "tv"\) \{ if \(!tvAuthed\(req\)\)/.test(srv), "/tv data needs Hassan's code (TV session), not the cashier's board login");
  assert.ok(/\["\/api\/board\/reports", "\/api\/board\/customers", "\/api\/board\/taste"\]\.includes\(p\)[\s\S]{0,400}ownerOk\(req\.headers\["x-owner-code"\]\)/.test(srv), "reports need the owner's code (the board is open at the cashier)");
});

t("2026-11-17 طلبات المدير التنفيذي: محادثات واتساب، الدفع، وقت التوصيل، ولا أرقام جوال في الكود", async () => {
  const { waRow, dayWindow } = await import("../wastats.mjs");
  const [f] = dayWindow("2026-11-16"); const min = 60e3;
  const msgs = [
    { wa_from: "966500000011", dir: "in", at: f + 60 * min }, { wa_from: "966500000011", dir: "out", at: f + 64 * min },
    { wa_from: "966500000022", dir: "in", at: f + 120 * min }, { wa_from: "966500000022", dir: "in", at: f + 121 * min }, { wa_from: "966500000022", dir: "out", at: f + 130 * min },
    { wa_from: "966500000033", dir: "in", at: f + 200 * min },                       // never answered
    { wa_from: "966500000099", dir: "in", at: f + 10 * min },                        // the courier: not a customer
    { wa_from: "966500000044", dir: "in", at: f - 30 * min },                        // the day before
  ];
  const orders = [{ wa_from: "966500000011", phone: "", status: "done", created: f + 70 * min }, { wa_from: "", phone: "0500000033", status: "cancelled", created: f + 210 * min }];
  const r = waRow("2026-11-16", { msgs, orders, exclude: new Set(["500000099"]) });
  assert.deepEqual(r.slice(2), [3, 1, 0.33, 7, 7, 1]); // 3 conversations, 1 order (the cancelled one not counted), replies 4 and 10 min, 1 without reply
  const { payCols, HEADERS } = await import("../execsummary.mjs");
  assert.deepEqual(payCols([{ status: "done", source: "wa", total: 50, pay: "cash" }, { status: "done", source: "call", total: 30, pay: "card" },
    { status: "done", source: "shop", total: 20, pay: null }, { status: "cancelled", source: "wa", total: 99, pay: "cash" }, { status: "done", source: "hunger", total: 40, pay: "app" }]), [50, 30, 0, 20]);
  assert.equal(HEADERS[HEADERS.indexOf("أُعدّ في") + 1], "كاش (المحصّل)"); // new columns go after the old last one
  const { deliveryMore } = await import("../sheets.mjs");
  assert.deepEqual(deliveryMore({ type: "del", source: "wa", note: "· سلّمه المندوب (واتساب)" }, [{ to_status: "out", at: 1000 }, { to_status: "done", at: 1000 + 18 * min }]), [18, "مندوب التوصيل المجاني"]);
  assert.deepEqual(deliveryMore({ type: "pick", source: "wa" }, []), ["", ""]);
  for (const f of ["server.mjs", "courier.mjs", "sheets.mjs", "wa.mjs", "purchases.mjs"]) {
    const src = fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
    assert.ok(!/["'](?:966|0)?5\d{8}["']/.test(src), "phone number in " + f + " (the repository is public)");
  }
});
t("2026-11-17 تعريف واحد للعملاء والتأخير بين التقرير والشيت، وعدّ الطلبات بدون رقم", async () => {
  const { weekCustomers } = await import("../reports.mjs");
  const pool = { query: async () => ({ rows: [
    { wa_from: "966500000011", phone: "", d: "2026-11-01" }, { wa_from: "", phone: "0500000011", d: "2026-11-16" }, // same customer in two formats
    { wa_from: "", phone: "٠٥٠٠٠٠٠٠٢٢", d: "2026-11-17" }, { wa_from: "966500000022", phone: "", d: "2026-11-18" },   // new this week, twice
    { wa_from: "", phone: "", d: "2026-11-17" } ] }) };
  assert.deepEqual(await weekCustomers(pool, "2026-11-15", "2026-11-22"), { newCustomers: 1, returning: 1 });
  const { noPhone } = await import("../execsummary.mjs");
  assert.equal(noPhone([{ status: "done", source: "shop", phone: "" }, { status: "done", source: "call", phone: "0500000011" },
    { status: "done", source: "hunger", phone: "" }, { status: "cancelled", source: "shop", phone: "" }, { status: "done", source: "wa", wa_from: "966500000033" }]), 1);
  const rep = fs.readFileSync(new URL("../reports.mjs", import.meta.url), "utf8");
  assert.ok(rep.includes("(Number(o.travel_min) || 15) * 60e3") && rep.includes(">= 60e3) late++"), "report lateness = execRow lateness");
  assert.ok(rep.includes("canonArea(o.area)"), "delivery areas in the report use the sheet's one spelling");
});
t("2026-11-17 #23: طلب واتساب أو اتصال لازم فيه رقم جوال", () => {
  const b = fs.readFileSync(new URL("../src/board.template.html", import.meta.url), "utf8");
  assert.ok(/\["wa","call"\]\.includes\(segVal\("srcSeg"\)\)&&\$\("phone"\)\.value/.test(b), "the form refuses a WhatsApp/phone order without a number");
});
t("2026-11-18 فواتير المشتريات تنحفظ PDF (صورة الجوال تصير صفحة)", async () => {
  const { toPdf, paperBox } = await import("../purchases.mjs");
  const { default: sharp } = await import("sharp");
  // a white «paper» on a dark «table», like a receipt photo
  const paper = await sharp({ create: { width: 300, height: 500, channels: 3, background: "#f2f2f2" } }).png().toBuffer();
  const photo = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#1a1a1a" } }).composite([{ input: paper, left: 150, top: 200 }]).jpeg().toBuffer();
  const box = await paperBox(sharp, photo);
  assert.ok(box.left > 100 && box.left < 150 && box.width < 400 && box.top > 150 && box.height < 600, "crops to the paper: " + JSON.stringify(box));
  const r = await toPdf(photo, "image/jpeg");
  assert.equal(r.type, "application/pdf"); assert.equal(r.bytes.subarray(0, 5).toString(), "%PDF-");
  const pdf = Buffer.from("%PDF-1.4 test"); assert.equal((await toPdf(pdf, "application/pdf")).bytes, pdf); // a PDF stays as sent
  const plain = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  assert.deepEqual(await paperBox(sharp, plain), { left: 0, top: 0, width: 400, height: 400 }); // no table: whole photo
});
t("2026-11-18 رسوم الموقع الجديدة تنطبق على الطلبات المفتوحة (siteFee)", async () => {
  const { siteFee, hoodOf } = await import("../menu.mjs");
  const areas = [{ name: "الجوهرة", fee: 5 }, { name: "حي المحمدية", fee: 10 }];
  assert.equal(hoodOf("📍 الجوهرة · 4 كم (توصيل 10 ر)"), "الجوهرة");
  assert.equal(siteFee(areas, "الجوهرة (توصيل 10 ر)"), 5);
  assert.equal(siteFee(areas, "المحمدية (توصيل 15 ر)"), 10);
  assert.equal(siteFee(areas, "النايفية (توصيل 10 ر)"), 0);
  assert.equal(siteFee(areas, "حي غير موجود (توصيل 20 ر)"), null);
  const srv = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(/if \(fee >= old\)[^\n]*kept/.test(srv), "a confirmed fee is never raised");
});
t("2026-11-18 «شفت إعلانكم» يسجّل المصدر", async () => {
  const { adSource } = await import("../admention.mjs");
  assert.equal(adSource("مرحبا، شفت إعلانكم في إنستقرام وأبي أطلب"), "إنستقرام");
  assert.equal(adSource("شفت اعلانكم بالانستا"), "إنستقرام");
  assert.equal(adSource("هلا شفت اعلانكم في التيك توك"), "تيك توك");
  assert.equal(adSource("شفت إعلانكم"), "إعلان غير محدد");
  assert.equal(adSource("ابي اطلب 20 فطاير"), null);
  const srv = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(srv.includes("if (!o.heard && o.waFrom) o.heard = await heardFromAd(pool, o.waFrom)"), "a new WhatsApp order takes the ad source");
});
