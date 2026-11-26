// Purchase invoices (Hassan 2026-11-09). WhatsApp groups do not reach the board (Coexistence number via Dualhook: Meta's Groups
// API is not available), so Hassan / Suleiman send the invoice photo to the board's number with a caption starting «مشتريات»
// and the payment method (كاش / تحويل / آجل). A «مشتريات …» text sent within 3 minutes of photos from the same sender covers them.
// Nothing reads the invoice: the photo and the text are kept as they are.
// Every night at 02:00 (with the sheet job): each photo is downloaded (Dualhook runtime, env DUALHOOK_KEY), saved to Drive
// «فواتير المشتريات/YYYY-MM/DATE_SENDER_N.jpg», and one row is added to the tab «فواتير_المشتريات»:
// التاريخ | المرسل | رابط الصورة | النص المرفق | طريقة الدفع | الحالة («جديدة»; Claude sets «مسجلة» after entering it in the POS).
import { token, api, append, read, resetSheetIds } from "./sheets.mjs";
export const ROOT_FOLDER = process.env.PURCHASES_FOLDER_ID || "1MTDswrTU23t1vSX8vhUoNBZXoqXWH6EA";
export const TAB = "فواتير_المشتريات";
const WINDOW = 10 * 60e3; // photos taken one by one: a «مشتريات …» text covers the sender's photos of the 10 minutes before it
const k9 = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "").slice(-9);
// «مشتريات …» at the start of any line, also «فاتورة مشتريات» (Hassan 2026-11-11 wrote «فاتورة مشتريات\nمشتريات تحويل»)
export const isPurchaseText = t => /(?:^|\n)\s*(?:\[(?:صورة|ملف)\]\s*)?(?:فاتور[ةه]\s+)?مشتريات/.test(String(t || ""));
export function payOf(t) {
  const s = String(t || "");
  if (/آجل|اجل|أجل|دين/.test(s)) return "آجل";
  if (/تحويل|حوال/.test(s)) return "تحويل";
  if (/كاش|نقد|كاشه/.test(s)) return "كاش";
  return "غير محدد";
}
const clean = t => String(t || "").replace(/^\s*\[(?:صورة|ملف)\]\s*/, "").trim();

export const isPurchaseSender = async (pool, from) => (await senders(pool)).some(x => k9(x.key) === k9(from));
export async function migratePurchases(pool) {
  await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_id TEXT`);
  await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS mime TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS purchases (
    msg_id TEXT PRIMARY KEY, wa_from TEXT, sender TEXT, at BIGINT NOT NULL, media_id TEXT, mime TEXT, caption TEXT, pay TEXT,
    drive_link TEXT, file_name TEXT, status TEXT NOT NULL DEFAULT 'wait', err TEXT, sheet_done BOOLEAN NOT NULL DEFAULT false)`);
}
// allowed senders: board_settings «purchase_senders» = [{"key":"5xxxxxxxx","name":"سليمان"}]; nobody else, ever
async function senders(pool) {
  const r = (await pool.query("SELECT value FROM board_settings WHERE key='purchase_senders'")).rows[0];
  // board_settings.value comes back already parsed (json column) — the old JSON.parse threw and left the list empty,
  // which after the 2026-11-11 «nobody else» rule silently dropped every invoice (Hassan 2026-11-15)
  if (!r) return [];
  const v = typeof r.value === "string" ? (() => { try { return JSON.parse(r.value); } catch { return []; } })() : r.value;
  return Array.isArray(v) ? v : [];
}
async function claim(pool, row, caption, sender) {
  const ins = await pool.query(`INSERT INTO purchases (msg_id, wa_from, sender, at, media_id, mime, caption, pay) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id`, [row.id, row.wa_from, sender, Number(row.at), row.media_id, row.mime, caption, payOf(caption)]);
  return ins.rows.length;
}
// Called for every inbound message after it is stored. Returns a log string when it was a purchase message, else null.
export async function onPurchaseMessage(pool, m) {
  const media = (m.type === "image" || m.type === "document") && m.raw && m.raw.id;
  if (media) await pool.query("UPDATE wa_messages SET media_id=$2, mime=$3 WHERE id=$1", [m.id, m.raw.id, m.raw.mime_type || ""]);
  const list = await senders(pool);
  const who = list.find(x => k9(x.key) === k9(m.from));
  if (!who) { if (!list.length && (media || isPurchaseText(m.text))) console.log("purchase: sender list is EMPTY — nothing can be kept"); return null; } // only Hassan and Suleiman: a customer's photo never becomes a purchase invoice (empty list = nobody)
  const sender = who.name;
  const own = isPurchaseText(m.text);
  if (media && own) { await claim(pool, { id: m.id, wa_from: m.from, at: m.ts, media_id: m.raw.id, mime: m.raw.mime_type || "" }, clean(m.text), sender); return `purchase: photo from ${sender} (${payOf(m.text)})`; }
  if (media) {
    // a photo right after a «مشتريات …» text from the same sender
    const t = (await pool.query(`SELECT body FROM wa_messages WHERE wa_from=$1 AND dir='in' AND at BETWEEN $2 AND $3 AND id<>$4 ORDER BY at DESC`,
      [m.from, m.ts - WINDOW, m.ts, m.id])).rows.find(r => isPurchaseText(r.body));
    if (!t) return null;
    await claim(pool, { id: m.id, wa_from: m.from, at: m.ts, media_id: m.raw.id, mime: m.raw.mime_type || "" }, clean(t.body), sender);
    return `purchase: photo from ${sender} under an earlier text (${payOf(t.body)})`;
  }
  if (!own) return null;
  // a «مشتريات …» text: photos the same sender sent in the 3 minutes before it (without their own caption) are covered by it
  const prev = (await pool.query(`SELECT id, wa_from, at, media_id, mime FROM wa_messages WHERE wa_from=$1 AND dir='in' AND media_id IS NOT NULL
    AND at BETWEEN $2 AND $3 AND id NOT IN (SELECT msg_id FROM purchases)`, [m.from, m.ts - WINDOW, m.ts])).rows;
  let n = 0; for (const r of prev) n += await claim(pool, r, clean(m.text), sender);
  // photos with their own captions already claimed in the window inherit a missing payment method
  await pool.query(`UPDATE purchases SET pay=$3 WHERE wa_from=$1 AND at BETWEEN $2 AND $4 AND pay='غير محدد'`, [m.from, m.ts - WINDOW, payOf(m.text), m.ts + WINDOW]);
  return `purchase: text from ${sender} (${payOf(m.text)}), covers ${n} earlier photo(s)`;
}

// re-read recent texts once (after a rule change): claim what the new rule covers
export async function reclaimRecent(pool, sinceMs, log = console.log) {
  const list = await senders(pool);
  const rows = (await pool.query("SELECT id, wa_from, body, at FROM wa_messages WHERE dir='in' AND at > $1 AND media_id IS NULL ORDER BY at", [sinceMs])).rows;
  for (const r of rows) {
    if (!isPurchaseText(r.body)) continue;
    const who = list.find(x => k9(x.key) === k9(r.wa_from)); if (!who) continue;
    const prev = (await pool.query(`SELECT id, wa_from, at, media_id, mime FROM wa_messages WHERE wa_from=$1 AND dir='in' AND media_id IS NOT NULL
      AND at BETWEEN $2 AND $3 AND id NOT IN (SELECT msg_id FROM purchases)`, [r.wa_from, Number(r.at) - WINDOW, Number(r.at) + WINDOW])).rows;
    let n = 0; for (const p of prev) n += await claim(pool, p, clean(r.body), who ? who.name : "…" + k9(r.wa_from).slice(-4));
    if (payOf(r.body) !== "غير محدد") await pool.query(`UPDATE purchases SET pay=$3 WHERE wa_from=$1 AND at BETWEEN $2 AND $4 AND pay='غير محدد'`, [r.wa_from, Number(r.at) - WINDOW, payOf(r.body), Number(r.at) + WINDOW]);
    log(`purchase: re-read text (${payOf(r.body)}) covers ${n} photo(s)`);
  }
}
// ---------- nightly ----------
// A service account cannot own files in a personal Drive («Service Accounts do not have storage quota», tested 2026-11-09), so the
// photos are saved by a Google Apps Script that runs as Hassan's own Google account every night at ~02:15:
//   GET  /api/purchases/pending  → photos not saved yet (bytes fetched here from Dualhook), with the file and month folder names
//   POST /api/purchases/saved    → {id, link}: the board records the link and adds the row to «فواتير_المشتريات»
// Both carry the script's Google identity token; the board accepts only the shop's verified Google accounts (the script lives in minigeesh@gmail.com) (no shared secret).
const dayOf = ms => new Date(Number(ms) + 3 * 3600e3).toISOString().slice(0, 10);
const OWNERS = String(process.env.PURCHASES_GOOGLE_EMAILS || "minigeesh@gmail.com,psk14060@gmail.com").toLowerCase().split(",").map(x => x.trim());
export async function googleCaller(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+([\w.-]+)$/);
  if (!m) return null;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(m[1]), { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const j = await r.json();
  const ok = ["accounts.google.com", "https://accounts.google.com"].includes(j.iss) && String(j.email_verified) === "true" &&
    OWNERS.includes(String(j.email || "").toLowerCase()) && Number(j.exp) * 1000 > Date.now();
  return ok ? j.email : null;
}
export async function download(mediaId) {
  const key = dualhookKey().value;
  if (!key) throw new Error("no Dualhook key (no env value starting with dh_live_)");
  const r = await fetch(`https://api.dualhook.com/v25.0/${mediaId}/content`, { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`media_${r.status} ${(await r.text()).slice(0, 120)}`);
  return { bytes: Buffer.from(await r.arrayBuffer()), type: (r.headers.get("content-type") || "image/jpeg").split(";")[0] };
}
// the Dualhook runtime key: whichever env variable holds a value starting with «dh_live_» (Hassan has more than one Dualhook value)
export function dualhookKey() {
  const clean = v => String(v || "").trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  const names = ["DUALHOOK_KEY", ...Object.keys(process.env).filter(k => k !== "DUALHOOK_KEY")];
  for (const n of names) { const v = clean(process.env[n]); if (v.startsWith("dh_live_")) return { name: n, value: v }; }
  return { name: null, value: "" };
}
// Hassan 2026-11-18: invoices are saved as PDF, not photos (for the accountant). The photo is turned upright (phone EXIF),
// made grey with stretched contrast and a light sharpen (a scanned look that keeps faint thermal print readable),
// kept large (longest side 2400 px) so nothing is lost, and put on one page the size of the photo. A PDF sent as is stays as is.
// the paper inside the photo (receipts are shot on a table): Otsu threshold on a small grey copy, then the rows and columns
// that are mostly paper; a few % margin. Falls back to the whole photo when no clear paper is found.
export async function paperBox(sharp, buf) {
  const meta = await sharp(buf).metadata();
  const W = 300, small = await sharp(buf).resize({ width: W }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = small, w = info.width, h = info.height;
  const hist = new Array(256).fill(0); for (const v of data) hist[v]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = data.length - wB; if (!wF) break; sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; th = t; } }
  const rowOk = y => { let n = 0; for (let x = 0; x < w; x++) if (data[y * w + x] > th) n++; return n / w > 0.35; };
  const colOk = x => { let n = 0; for (let y = 0; y < h; y++) if (data[y * w + x] > th) n++; return n / h > 0.35; };
  let top = 0, bot = h - 1, left = 0, right = w - 1;
  while (top < h && !rowOk(top)) top++; while (bot > top && !rowOk(bot)) bot--;
  while (left < w && !colOk(left)) left++; while (right > left && !colOk(right)) right--;
  const bw = right - left + 1, bh = bot - top + 1;
  if (bw < w * 0.3 || bh < h * 0.3) return { left: 0, top: 0, width: meta.width, height: meta.height };
  const k = meta.width / w, m = 0.02;
  const L = Math.max(0, Math.floor((left - bw * m) * k)), T = Math.max(0, Math.floor((top - bh * m) * k));
  const R = Math.min(meta.width, Math.ceil((right + 1 + bw * m) * k)), B = Math.min(meta.height, Math.ceil((bot + 1 + bh * m) * k));
  return { left: L, top: T, width: R - L, height: B - T };
}
export async function toPdf(bytes, type) {
  if (/pdf/.test(type || "")) return { bytes, type: "application/pdf" };
  const { default: sharp } = await import("sharp");
  const { PDFDocument } = await import("pdf-lib");
  const upright = await sharp(bytes).rotate().toBuffer();
  const box = await paperBox(sharp, upright);
  const grey = await sharp(upright).extract(box).resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
    .grayscale().normalise({ lower: 1, upper: 99 }).sharpen({ sigma: 0.8 }).raw().toBuffer({ resolveWithObject: true });
  // (no whitening of the table around a tilted page: tried, it wiped shadowed text — an invoice must never lose a figure)
  const img = await sharp(grey.data, { raw: { width: grey.info.width, height: grey.info.height, channels: 1 } }).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const doc = await PDFDocument.create();
  doc.setTitle("فاتورة مشتريات"); doc.setProducer("Minigeesh board");
  const jpg = await doc.embedJpg(img.data);
  const scale = 72 / 200; // 200 dpi: an A4-ish page for a phone photo of a receipt
  const page = doc.addPage([img.info.width * scale, img.info.height * scale]);
  page.drawImage(jpg, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return { bytes: Buffer.from(await doc.save()), type: "application/pdf" };
}
const extOf = t => /png/.test(t) ? "png" : /pdf/.test(t) ? "pdf" : /webp/.test(t) ? "webp" : "jpg";
export async function pendingPurchases(pool, log = console.log, max = 15) {
  const rows = (await pool.query("SELECT * FROM purchases WHERE status<>'saved' ORDER BY at LIMIT $1", [max])).rows;
  const out = [];
  for (const p of rows) {
    try {
      const raw = p.bytes ? { bytes: Buffer.from(p.bytes), type: p.mime } : await download(p.media_id); // board «مشتريات» photos are stored, not on Dualhook
      const { bytes, type } = await toPdf(raw.bytes, raw.type || p.mime).catch(e => { log(`purchases: pdf failed, saving the photo (${e.message})`); return raw; });
      const day = dayOf(p.at);
      const n = Number((await pool.query("SELECT count(*) AS c FROM purchases WHERE sender=$1 AND (at < $2 OR (at = $2 AND msg_id < $4)) AND at >= $3", [p.sender, p.at, Date.parse(day + "T00:00:00+03:00"), p.msg_id])).rows[0].c) + 1;
      out.push({ id: p.msg_id, folder: day.slice(0, 7), name: `${day}_${p.sender}_${n}.${extOf(type || p.mime)}`, mime: type, b64: bytes.toString("base64") });
    } catch (e) { await pool.query("UPDATE purchases SET status='error', err=$2 WHERE msg_id=$1", [p.msg_id, String(e.message).slice(0, 200)]); log(`purchases: ${String(p.msg_id).slice(-6)} ${e.message}`); }
  }
  return out;
}
async function ensureTab() {
  const tabs = ((await api("GET", "?fields=sheets.properties")).sheets || []).map(s => s.properties.title);
  if (!tabs.includes(TAB)) {
    await api("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title: TAB, rightToLeft: true } } }] });
    resetSheetIds();
  }
  const h = await read(TAB, "A1:F1");
  if (!(h[0] && h[0][0])) await api("PUT", `/values/${encodeURIComponent(`'${TAB}'!A1:F1`)}?valueInputOption=RAW`, { values: [["التاريخ", "المرسل", "رابط الصورة", "النص المرفق", "طريقة الدفع", "الحالة"]] });
}
export async function markSaved(pool, id, link, name, log = console.log) {
  const up = await pool.query("UPDATE purchases SET status='saved', drive_link=$2, file_name=$3, err=NULL WHERE msg_id=$1 RETURNING *", [id, String(link).slice(0, 300), String(name || "").slice(0, 120)]);
  if (!up.rows.length) return false;
  const p = up.rows[0];
  const sup = String(id).match(/^sup-(\d+)-\d+$/); // a photo from the board's «مشتريات» page: link it to its invoice
  if (sup) await pool.query("UPDATE pinvoices SET photo_link=$2 WHERE id=$1", [sup[1], p.drive_link]).catch(e => log("purchases: link " + e.message));
  if (sup) await pool.query("UPDATE purchases SET bytes=NULL WHERE msg_id=$1", [id]).catch(() => {}); // in Drive now
  if (!p.sheet_done) {
    await ensureTab();
    await append(TAB, [[dayOf(p.at), p.sender, p.drive_link, p.caption || "", p.pay, "جديدة"]]);
    await pool.query("UPDATE purchases SET sheet_done=true WHERE msg_id=$1", [id]);
  }
  log(`purchases: saved ${p.file_name}`);
  return true;
}
