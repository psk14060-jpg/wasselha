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
const WINDOW = 3 * 60e3;
const k9 = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "").slice(-9);
export const isPurchaseText = t => /^\s*\[?(?:صورة|ملف)?\]?\s*مشتريات/.test(String(t || ""));
export function payOf(t) {
  const s = String(t || "");
  if (/آجل|اجل|أجل|دين/.test(s)) return "آجل";
  if (/تحويل|حوال/.test(s)) return "تحويل";
  if (/كاش|نقد|كاشه/.test(s)) return "كاش";
  return "غير محدد";
}
const clean = t => String(t || "").replace(/^\s*\[(?:صورة|ملف)\]\s*/, "").trim();

export async function migratePurchases(pool) {
  await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_id TEXT`);
  await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS mime TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS purchases (
    msg_id TEXT PRIMARY KEY, wa_from TEXT, sender TEXT, at BIGINT NOT NULL, media_id TEXT, mime TEXT, caption TEXT, pay TEXT,
    drive_link TEXT, file_name TEXT, status TEXT NOT NULL DEFAULT 'wait', err TEXT, sheet_done BOOLEAN NOT NULL DEFAULT false)`);
}
// allowed senders: board_settings «purchase_senders» = [{"key":"5xxxxxxxx","name":"سليمان"}]; empty list = anyone writing «مشتريات»
async function senders(pool) {
  const r = (await pool.query("SELECT value FROM board_settings WHERE key='purchase_senders'")).rows[0];
  try { return r ? JSON.parse(r.value) : []; } catch { return []; }
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
  if (list.length && !who) return null;
  const sender = who ? who.name : (m.name || "…" + k9(m.from).slice(-4));
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

// ---------- nightly ----------
const dayOf = ms => new Date(Number(ms) + 3 * 3600e3).toISOString().slice(0, 10);
async function driveFetch(method, url, body, headers = {}) {
  const r = await fetch(url, { method, headers: { authorization: "Bearer " + await token("https://www.googleapis.com/auth/drive"), ...headers }, body, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`drive_${r.status} ${(j.error && j.error.message) || ""}`.trim());
  return j;
}
const monthFolders = {};
async function monthFolder(ym) {
  if (monthFolders[ym]) return monthFolders[ym];
  const q = encodeURIComponent(`'${ROOT_FOLDER}' in parents and name='${ym}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const f = await driveFetch("GET", `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  if (f.files && f.files[0]) return (monthFolders[ym] = f.files[0].id);
  const c = await driveFetch("POST", "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", JSON.stringify({ name: ym, mimeType: "application/vnd.google-apps.folder", parents: [ROOT_FOLDER] }), { "content-type": "application/json" });
  return (monthFolders[ym] = c.id);
}
async function download(mediaId) {
  const key = process.env.DUALHOOK_KEY;
  if (!key) throw new Error("no DUALHOOK_KEY");
  const r = await fetch(`https://api.dualhook.com/v25.0/${mediaId}/content`, { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`media_${r.status} ${(await r.text()).slice(0, 120)}`);
  return { bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/jpeg" };
}
const extOf = t => /png/.test(t) ? "png" : /pdf/.test(t) ? "pdf" : /webp/.test(t) ? "webp" : "jpg";
async function upload(folder, name, bytes, type) {
  const bnd = "mgp" + Date.now();
  const head = Buffer.from(`--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder] })}\r\n--${bnd}\r\nContent-Type: ${type}\r\n\r\n`);
  const body = Buffer.concat([head, bytes, Buffer.from(`\r\n--${bnd}--`)]);
  return driveFetch("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink", body, { "content-type": "multipart/related; boundary=" + bnd });
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
export async function syncPurchases(pool, log = console.log) {
  const rows = (await pool.query("SELECT * FROM purchases WHERE status<>'saved' OR NOT sheet_done ORDER BY at")).rows;
  if (!rows.length) return;
  let saved = 0, failed = 0;
  for (const p of rows.filter(r => r.status !== "saved")) {
    try {
      const { bytes, type } = await download(p.media_id);
      const day = dayOf(p.at);
      const n = Number((await pool.query("SELECT count(*) AS c FROM purchases WHERE sender=$1 AND status='saved' AND file_name LIKE $2", [p.sender, day + "_%"])).rows[0].c) + 1;
      const name = `${day}_${p.sender}_${n}.${extOf(type || p.mime)}`;
      const f = await upload(await monthFolder(day.slice(0, 7)), name, bytes, type);
      await pool.query("UPDATE purchases SET status='saved', drive_link=$2, file_name=$3, err=NULL WHERE msg_id=$1", [p.msg_id, f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, name]);
      saved++;
    } catch (e) { failed++; await pool.query("UPDATE purchases SET status='error', err=$2 WHERE msg_id=$1", [p.msg_id, String(e.message).slice(0, 200)]); log(`purchases: ${p.msg_id.slice(-6)} ${e.message}`); }
  }
  const ready = (await pool.query("SELECT * FROM purchases WHERE status='saved' AND NOT sheet_done ORDER BY at")).rows;
  if (ready.length) {
    await ensureTab();
    await append(TAB, ready.map(p => [dayOf(p.at), p.sender, p.drive_link, p.caption || "", p.pay, "جديدة"]));
    await pool.query("UPDATE purchases SET sheet_done=true WHERE msg_id = ANY($1)", [ready.map(p => p.msg_id)]);
  }
  log(`purchases: saved ${saved}, failed ${failed}, sheet rows ${ready.length}`);
}
