# Minigeesh order board

Small server for the Minigeesh kitchen:

- `POST /api/web-order` receives an order from minigeesh.sa right before WhatsApp opens. It lands as **pending** until the owner confirms the WhatsApp message arrived.
- `/` is the kitchen board (PIN login). Phone and walk-in orders are added there by hand.

Env: `DATABASE_URL`, `BOARD_PIN` (4-8 digits), `SESSION_SECRET`, optional `ALLOWED_ORIGINS`.

Edit `src/*`, then run `node build.mjs` to regenerate `public/`.
