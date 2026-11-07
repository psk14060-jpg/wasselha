# Minigeesh kitchen board — working rules and lessons

Owner: Hassan (Riyadh); restaurant in Hofuf, Al-Ahsa. Talk to him in Arabic. Brand: «مينيقيش».
Live: https://minigeesh-orders.onrender.com (Render service srv-dbipv0etlv9c73bdfvug, workspace tea-daiqbo9594qs739pn74g).
Deploy: push branch `minigeesh-orders`, then trigger the deploy (Render shows auto-deploy on, but pushes still do not deploy — checked 2026-11-05). Never push untested work there.

## Before every deploy
1. `node build.mjs` then `npm test` — every real mistake is a check in `test/regressions.mjs`. A new mistake gets a new check first.
2. UI changes: screenshot at phone (400px) and desktop (1280px) widths before shipping (layout broke once with too many buttons).
3. Sound changes: test with the browser's default autoplay policy and a real tap (touch), not with autoplay forced on.
4. After deploy: read the startup log lines (`day:`, `chat:`, `fix:`, `sound:`, `screen:`) to confirm.

## The reader (WhatsApp → order)
- Model: `READER_MODEL` (default claude-sonnet-5-5). Prompt in `wa.mjs` `askClaude`.
- After the reader, code decides: `placeUnknown` (glossary in `reader.mjs`), `fixSamosa`, `dayHint`, exact size composition, shop-quote check, no blank cards.
- Every time the shop edits the items of a WhatsApp order, `recordCorrection` saves (chat → right items) in `reader_examples`; the 8 latest are given to the reader as examples.
- On each deploy that changes `wa.mjs`/`reader.mjs`, `evalReader` re-reads the last 20 corrected chats and logs `reader-eval: X/Y` plus each miss. A drop means the change made the reader worse.

## Lessons (each cost Hassan a wrong order or a broken screen)
- A global text replace turned the audio helper into a function calling itself: every sound failed silently for a day. Never mass-replace code; re-read the result.
- Media files Hassan sends are used whole. Do not cut "noise" out of a clip without asking (the airport clip's speech was cut).
- The reader (Claude) does not reliably follow menu rules written in its prompt. Rules that matter go in code after the reader: `fixSamosa` (baked «سمبوسة» = triangles), sizes composed exactly (30 = 20 + 10), shop-quoted total compared with the board total.
- Customer words: «سمبوسة/سمبوسك» = فطائر مثلثة unless «جنوبية / مقلية / بالبر». «نوتيلا» = كباجي نوتيلا. Drinks names → softDrink / water.
- Free delivery: النايفية and العزيزية (Hassan 2026-11-05), `FREE_AREAS` in `menu.mjs` — fee 0 in the menu areas, map locations and WhatsApp pricing.
- Neighbourhood fee from the website list wins over distance zones; a website order keeps the fee it was sent with.
- Drive time = map minutes + 5. No ×1.4, no extra courier minutes.
- One customer = one phone number in any format (05…, 9665…, Arabic digits). Before creating an order, look for the same customer's open order (WhatsApp, website, or typed on the board) and update it instead.
- Pickup or delivery the customer chooses in his words («حطه استلام», «ابي توصيل») is taken in code (`typeHint`), not from the reader (#24 of 2026-11-06 stayed delivery to a wrong neighbourhood).
- The day the customer says («بكرة / الجمعة / بعد بكرة») is taken in code (`dayHint`), not from the reader; a future day without a time defaults to 16:00 with the time marked missing.
- An approval with nothing to cook never becomes a blank card: it shows a review notice; a confirmation of an existing booking (matched by WhatsApp number or the phone on the order) updates that booking.
- Pickup orders that are ready wait on the customer: no late alarm.
- Card time (Hassan 2026-11-06): for our own deliveries the big time is when the order leaves the shop with the courier; the customer's time is the small line «يوصل العميل …».
- «أقرب وقت» (Hassan 2026-11-06: build it on data, not on his guess of 10 min): `capacity.mjs` — two stations working at once: OVEN (triangles frozen, cup pizza and boats ready-made: tray → oven → box, time ~fixed) and FRY (kabaji rolled, filled, fried; 2 min per 10 pieces; southern samosa and mini kabaji too). Order ready when its slower station is. Lanes and minutes measured from order_events (`kitchenstats.mjs`: oven-only p75, fry-only line against pieces, never under 2/10; rebuilt at start and nightly, logged `kitchen-model:`). Used by the board form, WhatsApp «asap», and website «أقرب وقت» orders at approval.
- Shared files built into the board (`subsidy.mjs`, `capacity.mjs`) live in one page scope: no two may declare the same top-level name (a duplicate `latin` broke the whole page in testing). `npm test` compiles the built page.
- A time the customer says in the chat after a website order (or with no new items) moves that order (`chatTime` in `wa.mjs`; #3 of 2026-11-06 stayed at the website's 4:30 while the customer asked 3:30).
- The order form always offers «أقرب وقت» for today, also after the 12:30 am last slot (2026-11-06 00:35 Hassan could not add an order). Test the form at late-night and early-morning clock times.
- «ابدأ التحضير الآن» clip plays twice per order only (at start time, and once a minute later), counted per device across reloads (Hassan 2026-11-05).
- Items text typed or edited on the board: a line that does not start with «N ×» joins the line above (`joinItemLines`); an Enter inside #35 of 2026-11-07 split the price off and its total became 0.
- Cancelled orders and delivery fees are not sales. The Chefz orders are not sales either (Hassan 2026-11-06): out of the board's sales chip, the weekly report and «المبيعات اليومية»; they still show on the board for the kitchen.
- Website orders stay hidden until the shop writes the approval phrase in WhatsApp.
- Ask before building when Hassan says "discuss first".
- 2026-11-05: report styles merged from another branch used bare class names (`.bar`, `.tile`) and broke the board header and the item tiles. Styles for a panel are always scoped under that panel (`.rep …`); a check in `npm test` fails on a class defined twice without scope. Compare screenshots with the previous build after any merge.

## Who decides what (Hassan, 2026-11-05)
- The marketing agent decides prices, offers, loyalty and delivery subsidy; this agent builds them. Rule changes come from there.
- Delivery subsidy (`subsidy.mjs`, shared with the board): Sun–Wed, items ≥ 60 SAR, shop pays 5 SAR, more while the margin after delivery stays ≥ 65% (price without VAT, food + box cost), never above the fee. None Thu/Fri 3–9 pm (and, as written, none Thu/Fri/Sat at all). Unknown item costs → base 5 only.
- Loyalty: paused until the marketing agent sends the design. Do not build.
- Rewaa POS integration: cancelled (13,800 SAR). Shop sales come from a weekly Rewaa Excel export; never enter shop sales on the board (the «المحل» source is hidden).
- Weekly report every Sunday 08:00 (`reports.mjs`, board ⋯ → التقارير): sales by item/channel/hour without delivery fees, average order, repeat and lapsed customers, cancelled and reasons (picked when cancelling), subsidy paid. Taste report: 2026-11-18.
- Kitchen alert (⋯ → 📢 تنبيه للمطبخ, table `kitchen_alerts`): written message shown on every screen with «تنبيه تنبيه» every minute until «تم»; not played on the sending device; sender sees heard/done. Sound file `public/sounds/kitchen-alert.mp3` (Hassan's recording, used whole) — until it exists a two-tone sound plays.
- One courier for close deliveries (`batch.mjs`, Hassan 2026-11-05): board suggests pairs of our own deliveries leaving within 20 min, customers ≤ 6 km apart (or same neighbourhood without map points), every customer within 10 min late / 15 min early. Kitchen presses «دمج»: same batch_id, both prepared for the group departure (batch_out), one «خرج» moves the group, card shows drop order and a Google Maps route. Courier is paid by each customer, so fees do not change.
- The Chefz names (Hassan 2026-11-06): «مثلثات فطائر مشكلة» 67.50 = فطائر مثلثة 30 قطعة; «Mix Boat Pastries / معجنات قوارب مشكلة» 49.50 = قوارب 18; «مشكل قوارب أجبان ومسخن دجاج» 59 = تشكيلة قوارب أجبان ومسخن.
- Returns and waste (⋯ → ↩ مرتجع وهدر, `rw.mjs`, table `returns_waste`, Hassan 2026-11-06): a return needs the supervisor code (Render env `SUPERVISOR_CODE`, never in chat logs or code) and a reason; it comes off the day's sales (board chip, weekly report, a negative «مرتجع» line in «المبيعات اليومية»). Waste = item + boxes or pieces + reason, counted at cost (sheet costs, else `itemsCost`).
- Rewaa cashier names in the reader: `CASHIER_NAMES` in `reader.mjs`.

## Shared sheet between the agents (`sheets.mjs`, Hassan 2026-11-05)
- Google Sheet 1TTXbWtikFPDkTN_2GJPpMwdOCsNOZCowbRsJodXEm1U, service account key in Render env `GOOGLE_SA_JSON`.
- «المبيعات اليومية» columns (Hassan 2026-11-06): «الساعة» = time the order came in (created), column K «وقت الاستلام المطلوب» = requested time (due). Neighbourhoods written with one spelling (`canonArea`: website list name, «حي» dropped, «المطيرفي» → «المطرفي»).
- Write only «المبيعات اليومية» (02:00 nightly, one row per item line + a negative «دعم توصيل من المحل» line), «الإلغاء والتأخير» (same run), «العملاء» (Sundays, whole tab rewritten). Same columns as the sheet. A day is deleted and rewritten, never appended twice.
- Read «القواعد المعتمدة» (subsidy on/off from its status/dates; any rule change → log + note) and «المنيو والتكاليف» (unified names via `unifiedName`, costs for the subsidy margin) every 10 minutes.
- Mistakes in other agents' tabs → a row in «ملاحظات», never an edit. Phones: last 4 digits only. No shop (Rewaa) sales.
- Do not add header buttons; secondary tools go in the ⋯ menu, card extras in their own row.
