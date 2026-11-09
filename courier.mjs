// The free-delivery courier (Hassan 2026-11-09): every free delivery (النايفية، العزيزية) goes with him, and when he hands an order
// over he writes «تم توصيل الطلب» on WhatsApp. That message closes the order on the board («تم التسليم»).
// Which order: a number in his message (#12 / 12) wins; otherwise the free delivery that left first («خرج»), and if none was
// marked «خرج», the ready free delivery with the earliest time. Nothing to close → stored only, logged.
import { isFreeArea } from "./menu.mjs";
export const COURIER_KEYS = ["560390218"]; // last 9 digits
const k9 = s => String(s || "").replace(/\D/g, "").slice(-9);
export const isCourier = from => COURIER_KEYS.includes(k9(from));
export const DELIVERED = /(?:تمت?|خلاص)\s*(?:ال)?(?:توصيل|تسليم|تسلم)|(?:سل[ّ]?مت|وص[ّ]?لت)\s*(?:ال)?(?:طلب|ه|ها)?|^\s*(?:تم|وصل|سلمته|وصلته)\s*[.!✅👍]*\s*$/;
const latin = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const free = o => o.type === "del" && !APPS.includes(o.source) && (isFreeArea(o.area) || /توصيل مجاني/.test(o.area || "") || Number(o.delivery_fee) === 0);

export async function courierDelivered(pool, text, now = Date.now()) {
  if (!DELIVERED.test(text)) return "courier: not a delivery note";
  const since = now - 14 * 3600e3;
  const { rows } = await pool.query(
    "SELECT id, num, status, type, source, area, delivery_fee, due, out_at FROM orders WHERE status IN ('out','ready') AND due > $1 ORDER BY due", [since]);
  const cands = rows.filter(free);
  const n = (latin(text).match(/#?\s*(\d{1,3})(?!\s*(?:قطع|حب|ريال|ر\b|د))/) || [])[1];
  let o = n ? cands.find(x => x.num === +n) : null;
  if (!o) o = cands.filter(x => x.status === "out").sort((a, b) => Number(a.out_at || a.due) - Number(b.out_at || b.due))[0]
       || cands.filter(x => x.status === "ready")[0];
  if (!o) return `courier: delivery note, no free delivery out or ready (${rows.length} open)`;
  await pool.query("UPDATE orders SET status='done', out_at=COALESCE(out_at,$2), note=TRIM(BOTH ' ·' FROM note || ' · سلّمه المندوب (واتساب)'), updated=$2 WHERE id=$1", [o.id, now]);
  return `courier: #${o.num} ${o.status} → done (${cands.length} free open)`;
}
