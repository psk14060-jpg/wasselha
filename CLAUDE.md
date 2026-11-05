# Minigeesh kitchen board — working rules and lessons

Owner: Hassan (Riyadh); restaurant in Hofuf, Al-Ahsa. Talk to him in Arabic. Brand: «مينيقيش».
Live: https://minigeesh-orders.onrender.com (Render service srv-dbipv0etlv9c73bdfvug, workspace tea-daiqbo9594qs739pn74g).
Deploy: push branch `minigeesh-orders`, then trigger the deploy (auto-deploy does not fire).

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
- Neighbourhood fee from the website list wins over distance zones; a website order keeps the fee it was sent with.
- Drive time = map minutes + 5. No ×1.4, no extra courier minutes.
- One customer = one phone number in any format (05…, 9665…, Arabic digits). Before creating an order, look for the same customer's open order (WhatsApp, website, or typed on the board) and update it instead.
- The day the customer says («بكرة / الجمعة / بعد بكرة») is taken in code (`dayHint`), not from the reader; a future day without a time defaults to 16:00 with the time marked missing.
- An approval with nothing to cook never becomes a blank card: it shows a review notice; a confirmation of an existing booking (matched by WhatsApp number or the phone on the order) updates that booking.
- Pickup orders that are ready wait on the customer: no late alarm.
- Cancelled orders and delivery fees are not sales.
- Website orders stay hidden until the shop writes the approval phrase in WhatsApp.
- Ask before building when Hassan says "discuss first".

## Who decides what (Hassan, 2026-11-05)
- The marketing agent decides prices, offers, loyalty and delivery subsidy; this agent builds them. Rule changes come from there.
- Delivery subsidy (`subsidy.mjs`, shared with the board): Sun–Wed, items ≥ 60 SAR, shop pays 5 SAR, more while the margin after delivery stays ≥ 65% (price without VAT, food + box cost), never above the fee. None Thu/Fri 3–9 pm (and, as written, none Thu/Fri/Sat at all). Unknown item costs → base 5 only.
- Loyalty: paused until the marketing agent sends the design. Do not build.
- Rewaa POS integration: cancelled (13,800 SAR). Shop sales come from a weekly Rewaa Excel export; never enter shop sales on the board (the «المحل» source is hidden).
- Weekly report every Sunday 08:00 (`reports.mjs`, board ⋯ → التقارير): sales by item/channel/hour without delivery fees, average order, repeat and lapsed customers, cancelled and reasons (picked when cancelling), subsidy paid. Taste report: 2026-11-18.
- Rewaa cashier names in the reader: `CASHIER_NAMES` in `reader.mjs`.

## Shared sheet between the agents (`sheets.mjs`, Hassan 2026-11-05)
- Google Sheet 1TTXbWtikFPDkTN_2GJPpMwdOCsNOZCowbRsJodXEm1U, service account key in Render env `GOOGLE_SA_JSON`.
- Write only «المبيعات اليومية» (02:00 nightly, one row per item line + a negative «دعم توصيل من المحل» line), «الإلغاء والتأخير» (same run), «العملاء» (Sundays, whole tab rewritten). Same columns as the sheet. A day is deleted and rewritten, never appended twice.
- Read «القواعد المعتمدة» (subsidy on/off from its status/dates; any rule change → log + note) and «المنيو والتكاليف» (unified names via `unifiedName`, costs for the subsidy margin) every 10 minutes.
- Mistakes in other agents' tabs → a row in «ملاحظات», never an edit. Phones: last 4 digits only. No shop (Rewaa) sales.
- Do not add header buttons; secondary tools go in the ⋯ menu, card extras in their own row.
