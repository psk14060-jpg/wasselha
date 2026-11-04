# Minigeesh kitchen board — working rules and lessons

Owner: Hassan (Riyadh); restaurant in Hofuf, Al-Ahsa. Talk to him in Arabic. Brand: «مينيقيش».
Live: https://minigeesh-orders.onrender.com (Render service srv-dbipv0etlv9c73bdfvug, workspace tea-daiqbo9594qs739pn74g).
Deploy: push branch `minigeesh-orders`, then trigger the deploy (auto-deploy does not fire).

## Before every deploy
1. `node build.mjs` then `npm test` — every real mistake is a check in `test/regressions.mjs`. A new mistake gets a new check first.
2. UI changes: screenshot at phone (400px) and desktop (1280px) widths before shipping (layout broke once with too many buttons).
3. Sound changes: test with the browser's default autoplay policy and a real tap (touch), not with autoplay forced on.
4. After deploy: read the startup log lines (`day:`, `chat:`, `fix:`, `sound:`, `screen:`) to confirm.

## Lessons (each cost Hassan a wrong order or a broken screen)
- A global text replace turned the audio helper into a function calling itself: every sound failed silently for a day. Never mass-replace code; re-read the result.
- Media files Hassan sends are used whole. Do not cut "noise" out of a clip without asking (the airport clip's speech was cut).
- The reader (Claude) does not reliably follow menu rules written in its prompt. Rules that matter go in code after the reader: `fixSamosa` (baked «سمبوسة» = triangles), sizes composed exactly (30 = 20 + 10), shop-quoted total compared with the board total.
- Customer words: «سمبوسة/سمبوسك» = فطائر مثلثة unless «جنوبية / مقلية / بالبر». «نوتيلا» = كباجي نوتيلا. Drinks names → softDrink / water.
- Neighbourhood fee from the website list wins over distance zones; a website order keeps the fee it was sent with.
- Drive time = map minutes + 5. No ×1.4, no extra courier minutes.
- One customer = one phone number in any format (05…, 9665…, Arabic digits). Before creating an order, look for the same customer's open order (WhatsApp, website, or typed on the board) and update it instead.
- Pickup orders that are ready wait on the customer: no late alarm.
- Cancelled orders and delivery fees are not sales.
- Website orders stay hidden until the shop writes the approval phrase in WhatsApp.
- Ask before building when Hassan says "discuss first" (loyalty system is on hold; weekly report is parked on branch `wip-weekly-report`).
- Do not add header buttons; secondary tools go in the ⋯ menu, card extras in their own row.
