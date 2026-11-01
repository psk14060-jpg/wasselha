// "Return gift": after delivery the shop sends the customer a personal code for a free item on the next order.
// Offer decided by the marketing agent (2026-11-01): 10 pieces of liquid-cheese kabaji free,
// on a next order of 60 SAR or more, valid 14 days, one use, not combined with other offers.
export const GIFT = {
  item: "١٠ قطع كباجي جبن سائل",
  minTotal: 60,
  days: 14,
};

const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const latinDigits = s => String(s || "").replace(/[٠-٩]/g, d => AR_DIGITS[d]);
// R482, r 482, R-482, ر482
const CODE_RE = /(?:^|[^A-Za-zء-ي])[Rrر]\s?-?\s?(\d{3})(?!\d)/;

export async function migrateGifts(pool) {
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_out TEXT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_out_at BIGINT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_in TEXT");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS orders_gift_out ON orders (gift_out) WHERE gift_out IS NOT NULL");
}

// Give this order a code (once). Codes are R + 3 digits, unique among codes issued in the last 60 days.
export async function issueGift(pool, orderId) {
  const { rows: [o] } = await pool.query("SELECT gift_out FROM orders WHERE id=$1", [orderId]);
  if (!o) return null;
  if (o.gift_out) return o.gift_out;
  for (let i = 0; i < 40; i++) {
    const code = "R" + String(100 + Math.floor(Math.random() * 900));
    const { rows } = await pool.query("SELECT 1 FROM orders WHERE gift_out=$1 AND gift_out_at > $2", [code, Date.now() - 60 * 864e5]);
    if (rows.length) continue;
    await pool.query("UPDATE orders SET gift_out=NULL WHERE gift_out=$1", [code]); // free an expired duplicate
    const r = await pool.query("UPDATE orders SET gift_out=$1, gift_out_at=$2, updated=$2 WHERE id=$3 AND gift_out IS NULL RETURNING gift_out", [code, Date.now(), orderId]);
    if (r.rows.length) return code;
    const again = await pool.query("SELECT gift_out FROM orders WHERE id=$1", [orderId]);
    return again.rows[0]?.gift_out || null;
  }
  return null;
}

// The message the shop sends; neutral wording as the brand rules ask.
export function giftMessage(code) {
  return `شكرًا لطلبك من مينيقيش 🧡\nهديتك على طلبك الجاي: ${GIFT.item} مجانًا\nالكود: ${code}\nصالح ${GIFT.days} يوم لطلب من ${GIFT.minTotal} ريال وفوق\nاحفظ رقمنا عشان توصلك عروضنا`;
}

// Look for a code in the customer's own words and attach the result to the order as a note for the kitchen.
const OWN_NOTE = /(?:🎁|⚠) كود R\d{3}[^·]*(?:·\s*)?/g;
export async function applyGift(pool, orderId, customerText) {
  const m = latinDigits(String(customerText || "").replace(OWN_NOTE, "")).match(CODE_RE);
  if (!m) return null;
  const code = "R" + m[1];
  const { rows: [o] } = await pool.query("SELECT id, total, note, gift_in FROM orders WHERE id=$1", [orderId]);
  if (!o || o.gift_in) return null;
  const { rows: [src] } = await pool.query("SELECT id, num, gift_out_at FROM orders WHERE gift_out=$1", [code]);
  let msg;
  if (!src || String(src.id) === String(o.id)) msg = `⚠ كود ${code} غير موجود`;
  else if (Date.now() - Number(src.gift_out_at) > GIFT.days * 864e5) msg = `⚠ كود ${code} منتهي`;
  else {
    const used = await pool.query("SELECT num FROM orders WHERE gift_in=$1 AND id<>$2 LIMIT 1", [code, o.id]);
    if (used.rows.length) msg = `⚠ كود ${code} مستخدم من قبل`;
    else {
      const short = o.total != null && Number(o.total) < GIFT.minTotal;
      msg = `🎁 كود ${code}: أضف ${GIFT.item} مجانًا` + (short ? ` (⚠ الطلب أقل من ${GIFT.minTotal} ريال)` : "");
      await pool.query("UPDATE orders SET gift_in=$1 WHERE id=$2", [code, o.id]);
    }
  }
  const note = [msg, String(o.note || "").replace(OWN_NOTE, "").trim()].filter(Boolean).join(" · ").slice(0, 300);
  await pool.query("UPDATE orders SET note=$1, updated=$2 WHERE id=$3", [note, Date.now(), o.id]);
  return msg;
}

// Customer lines only: the shop's own gift message must never count as the customer using the code.
export const customerLines = transcript => String(transcript || "").split("\n").filter(l => !l.startsWith("[المحل]")).join("\n");
