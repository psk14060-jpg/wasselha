// Minigeesh order server
// - POST /api/web-order      : website sends an order (public, CORS) -> status "pending"
// - GET  /                   : kitchen board (PIN protected)
// - /api/board/*             : board reads and updates orders
import { dayStats } from "./daystats.mjs";
import { audit } from "./audit.mjs";
import { migratePurchases, googleCaller, pendingPurchases, markSaved } from "./purchases.mjs";
import { normItemLines, linesSum, unpricedLines } from "./itemlines.mjs";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateWa, handleWebhook, recentReviews, readTranscript, lastKnownPoint } from "./wa.mjs";
import { migrateReader, recordCorrection, evalReader, readerVersion } from "./reader.mjs";
import { isFreeArea, getMenu } from "./menu.mjs";
import { migrateTts, speech } from "./tts.mjs";
import { migrateLocation, neighbourhoodOf, findPoint, applyLocation } from "./location.mjs";
import { migrateBlacklist, listBlacklist, markNoShow, recentPings, keyOf } from "./blacklist.mjs";
import { migrateReports, startWeeklyJob, buildWeek, weekStartOf, customers } from "./reports.mjs";
import { migratePrefs, startTasteJob, tasteReport } from "./prefs.mjs";
import { startSheetJob, sheetState } from "./sheets.mjs";
import { suggestBatches, routeUrl } from "./batch.mjs";
import { startKitchenModel, kitchenModel } from "./kitchenstats.mjs";
import { migrateRw, addRw, listRw } from "./rw.mjs";
import { migrateGifts, issueGift, applyGift, giftMessage, GIFT } from "./gifts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const BOARD_PIN = String(process.env.BOARD_PIN || "");
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://minigeesh.sa,https://www.minigeesh.sa,https://minigeesh.psk14060.chatgpt.site")
  .split(",").map(s => s.trim()).filter(Boolean);
const DEV_ALLOW_LOCAL = process.env.DEV_ALLOW_LOCAL === "1";
const WA_WEBHOOK_TOKEN = String(process.env.WA_WEBHOOK_TOKEN || "");

if (!DATABASE_URL) { console.error("DATABASE_URL is missing"); process.exit(1); }
if (!/^\d{4,8}$/.test(BOARD_PIN)) { console.error("BOARD_PIN must be 4-8 digits"); process.exit(1); }

pg.types.setTypeParser(1082, v => v); // keep DATE as "YYYY-MM-DD"
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5,
});

const STATUSES = ["pending", "new", "prep", "ready", "out", "done", "cancelled", "dismissed"];
const SOURCES = ["web", "wa", "call", "shop", "chefz", "hunger", "keeta", "ninja"];
const APPS = ["chefz", "hunger", "keeta", "ninja"];
const TYPES = ["del", "pick"];

// Riyadh is UTC+3 all year. The operating day starts at 06:00 local, because service runs past midnight.
const opDayOf = ms => new Date(ms + 3 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      op_day DATE NOT NULL,
      num INT NOT NULL,
      ref TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      area TEXT NOT NULL DEFAULT '',
      items TEXT NOT NULL DEFAULT '',
      total NUMERIC,
      delivery_fee NUMERIC,
      note TEXT NOT NULL DEFAULT '',
      due BIGINT NOT NULL,
      created BIGINT NOT NULL,
      updated BIGINT NOT NULL,
      confirmed_at BIGINT,
      out_at BIGINT,
      raw JSONB
    );
    CREATE INDEX IF NOT EXISTS orders_day_idx ON orders (op_day);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_ref_uidx ON orders (ref) WHERE ref IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS orders_day_num_uidx ON orders (op_day, num);
  `);
  await migrateWa(pool);
  await migratePurchases(pool);
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS app_ref TEXT");
  await migrateTts(pool);
  await migrateGifts(pool);
  // one-off fix (2026-11-03): order #8 read "30 kabaji" as 2 × 20; it is 20 + 10 pieces
  const fix8 = await pool.query(`UPDATE orders SET items=$1, total=total-76+58, note=TRIM(BOTH ' ·' FROM note || ' · صُحّح: الكباجي ٣٠ = ٢٠ + ١٠'), updated=$2
    WHERE op_day='2026-11-03' AND num=8 AND items=$3`,
    ["1 × كباجي جبن سائل برشة سكر 20 قطعة — 38 ريال\n1 × كباجي جبن سائل برشة سكر 10 قطع — 20 ريال\n1 × فطائر مثلثة 30 قطعة — 45 ريال\n1 × كب بيتزا 28 قطعة — 47 ريال", Date.now(),
     "2 × كباجي جبن سائل برشة سكر 20 قطعة — 76 ريال\n1 × فطائر مثلثة 30 قطعة — 45 ريال\n1 × كب بيتزا 28 قطعة — 47 ريال"]);
  if (fix8.rowCount) console.log("fix: order #8 of 2026-11-03 corrected");
  // one-off fix (2026-11-03): order #12 "سمبوسه مشكل ٢٠" meant triangles, not the southern samosa
  const fix12 = await pool.query(`UPDATE orders SET items=$1, total=total-38+35, note=TRIM(BOTH ' ·' FROM note || ' · صُحّح: السمبوسة = فطائر مثلثة'), updated=$2
    WHERE op_day='2026-11-03' AND num=12 AND items=$3`,
    ["1 × فطائر مثلثة 20 قطعة (مشكل) — 35 ريال\n1 × كباجي جبن سائل برشة سكر 10 قطع — 20 ريال", Date.now(),
     "1 × سمبوسة جنوبية 20 قطعة (مشكل) — 38 ريال\n1 × كباجي جبن سائل برشة سكر 10 قطع — 20 ريال"]);
  if (fix12.rowCount) console.log("fix: order #12 of 2026-11-03 corrected");
  // one-off fix (2026-11-04): #10 (website, غرناطة) kept the website fee of 10, not the distance fee of 5
  const fix10 = await pool.query(`UPDATE orders SET delivery_fee=10, total=total-5+10, area='📍 غرناطة · 3.7 كم (توصيل 10 ر)', updated=$1
    WHERE op_day='2026-11-04' AND num=10 AND source='web' AND delivery_fee=5`, [Date.now()]);
  if (fix10.rowCount) console.log("fix: #10 of 2026-11-04 fee restored to 10");
  // one-off fix (2026-11-04): #13 "٣٠ حبه سمبوسة بالفرن جبن و دجاج" = one box of 30 baked triangles (the shop quoted 125 with delivery)
  const fix13 = await pool.query(`UPDATE orders SET items=$1, total=125, note=TRIM(BOTH ' ·' FROM note || ' · صُحّح: السمبوسة بالفرن = فطائر مثلثة ٣٠'), updated=$2
    WHERE op_day='2026-11-04' AND num=13 AND items LIKE '%سمبوسة جنوبية%'`,
    ["1 × كب بيتزا 42 قطعة — 65 ريال\n1 × فطائر مثلثة 30 قطعة (جبن ودجاج) — 45 ريال", Date.now()]);
  if (fix13.rowCount) console.log("fix: #13 of 2026-11-04 corrected");
  // requested by Hassan (2026-11-04): add one boats box (35 SAR) to order #29
  const add29 = await pool.query(`UPDATE orders SET items=items || E'\n1 × قوارب 18 قطعة — 35 ريال', total=COALESCE(total,0)+35,
      note=TRIM(BOTH ' ·' FROM note || ' · أُضيف بوكس قوارب (طلب حسن)'), updated=$1
    WHERE op_day='2026-11-04' AND num=29 AND note NOT LIKE '%أُضيف بوكس قوارب (طلب حسن)%'`, [Date.now()]);
  if (add29.rowCount) console.log("fix: boats box added to #29 of 2026-11-04");
  // one-off fix (2026-11-04): tomorrow's #1 (typed on the board) and #2 (WhatsApp) are the same customer and order.
  // Keep #2 (delivery with location), with the three items the shop typed in #1.
  const dupA = (await pool.query("SELECT id, items, total FROM orders WHERE op_day='2026-11-05' AND num=1 AND source='call' AND status<>'cancelled'")).rows[0];
  const dupB = (await pool.query("SELECT id, delivery_fee FROM orders WHERE op_day='2026-11-05' AND num=2 AND source='wa' AND status<>'cancelled' AND note NOT LIKE '%دُمج مع الطلب #1%'")).rows[0];
  if (dupA && dupB) {
    await pool.query(`UPDATE orders SET items=$2, total=$3, note=TRIM(BOTH ' ·' FROM note || ' · دُمج مع الطلب #1'), updated=$4 WHERE id=$1`,
      [dupB.id, dupA.items, Number(dupA.total) + (Number(dupB.delivery_fee) || 0), Date.now()]);
    await pool.query(`UPDATE orders SET status='cancelled', note=TRIM(BOTH ' ·' FROM note || ' · مكرر: دُمج في الطلب #2'), updated=$2 WHERE id=$1`, [dupA.id, Date.now()]);
    console.log("fix: 2026-11-05 #1 merged into #2");
  }
  await pool.query(`UPDATE orders SET area=REPLACE(area, '<UNKNOWN> · ', '') WHERE op_day>='2026-11-04' AND area LIKE '%<UNKNOWN>%'`);
  // one-off (2026-11-05): #3 today was the customer confirming her Friday booking MG-8K4SU («بكرى الجمعه»), not a new order
  const fx3 = await pool.query(`UPDATE orders SET status='cancelled', note=TRIM(BOTH ' ·' FROM note || ' · تأكيد لحجز الجمعة MG-8K4SU'), updated=$1
    WHERE op_day='2026-11-05' AND num=3 AND items='(راجع المحادثة)' AND status<>'cancelled'`, [Date.now()]);
  if (fx3.rowCount) {
    await pool.query(`UPDATE orders SET status='new', note=TRIM(BOTH ' ·' FROM note || ' · العميلة أكدت الجمعة بالواتساب (٥ نوفمبر)'), updated=$1
      WHERE ref='MG-8K4SU' AND status='cancelled'`, [Date.now()]);
    console.log("fix: 2026-11-05 #3 → Friday booking MG-8K4SU restored");
  }
  // requested by Hassan (2026-11-04): Maryam's pickup was cancelled by mistake instead of marked no-show — put her number on the list
  for (const o of (await pool.query(`SELECT id, num, phone, wa_from FROM orders WHERE op_day='2026-11-04' AND name LIKE '%مريم%' AND status='cancelled'`)).rows) {
    const k = keyOf(o.wa_from, o.phone);
    if (k && !(await pool.query("SELECT 1 FROM blacklist WHERE key=$1", [k])).rows.length) { await markNoShow(pool, o.id); console.log(`fix: #${o.num} (مريم) added to the no-show list`); }
    else if (!k) console.log(`fix: #${o.num} (مريم) has no phone number`);
  }
  // one-off fix (2026-11-03): #17 was a payment chat about the website booking #5, not a new order
  const fix17 = await pool.query(`UPDATE orders SET status='cancelled', note=TRIM(BOTH ' ·' FROM note || ' · مكرر: هو نفسه الطلب #5'), updated=$1
    WHERE op_day='2026-11-03' AND num=17 AND status<>'cancelled' AND items='(راجع المحادثة)'`, [Date.now()]);
  if (fix17.rowCount) {
    await pool.query(`UPDATE orders SET note=TRIM(BOTH ' ·' FROM note || ' · الدفع تحويل'), updated=$1 WHERE op_day='2026-11-03' AND num=5 AND note NOT LIKE '%الدفع تحويل%'`, [Date.now()]);
    console.log("fix: #17 of 2026-11-03 cancelled as duplicate of #5");
  }
  await migratePrefs(pool);
  await migrateLocation(pool);
  await migrateBlacklist(pool);
  await migrateRw(pool);
  await migrateReader(pool);
  // seed the reader's lessons with the orders already corrected by hand (their current items are the right ones)
  for (const [d, n] of [["2026-11-03", 8], ["2026-11-03", 12], ["2026-11-04", 13], ["2026-11-04", 29], ["2026-11-05", 2]]) {
    const o = (await pool.query("SELECT id, raw_text, items FROM orders WHERE op_day=$1 AND num=$2 AND raw_text IS NOT NULL", [d, n])).rows[0];
    if (o && !(await pool.query("SELECT 1 FROM reader_examples WHERE order_id=$1", [o.id])).rows.length)
      await pool.query("INSERT INTO reader_examples (order_id, transcript, reader_items, correct_items, created) VALUES ($1,$2,'(صُحّح يدويًا)',$3,$4)",
        [o.id, String(o.raw_text).slice(-1800), o.items, Date.now()]);
  }
  await migrateReports(pool);
  // board settings shared by every device (e.g. alert sound on/off), and per-order alert mute
  await pool.query("CREATE TABLE IF NOT EXISTS board_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL)");
  // kitchen alerts: a message Hassan (or anyone on the board) writes; every kitchen screen shows it and says «تنبيه تنبيه» until «تم»
  await pool.query(`CREATE TABLE IF NOT EXISTS kitchen_alerts (id BIGSERIAL PRIMARY KEY, text TEXT NOT NULL, at BIGINT NOT NULL,
    from_dev TEXT, from_name TEXT, heard JSONB NOT NULL DEFAULT '[]', ack_at BIGINT, ack_by TEXT)`);
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS alert_muted BOOLEAN NOT NULL DEFAULT false");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT");
  // one courier for several deliveries: same batch_id, drop order batch_seq, group leaves the shop at batch_out
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_id TEXT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_seq INT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_out BIGINT");
  // 2026-11-05 18:40: النايفية and العزيزية deliver free — open orders already booked there drop their fee (once)
  if (!(await pool.query("SELECT 1 FROM board_settings WHERE key='fix_free_areas_1105'")).rows.length) {
    const { rows } = await pool.query("SELECT id, num, op_day, area, total, delivery_fee FROM orders WHERE type='del' AND status IN ('new','prep','ready') AND op_day >= '2026-11-05' AND COALESCE(delivery_fee,0) > 0");
    for (const o of rows) if (isFreeArea(o.area)) {
      await pool.query("UPDATE orders SET total = CASE WHEN total IS NULL THEN NULL ELSE total - delivery_fee END, delivery_fee = 0, area = regexp_replace(area, '\\(توصيل [0-9.]+ ر\\)', '(توصيل مجاني)'), updated=$2 WHERE id=$1", [o.id, Date.now()]);
      console.log(`fix: free area ${o.op_day instanceof Date ? o.op_day.toISOString().slice(0, 10) : o.op_day} #${o.num} fee ${o.delivery_fee} → 0`);
    }
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('fix_free_areas_1105', 'true')");
  }
  // 2026-11-06 #3 (website MG-J4K76): the customer asked for 3:30 pm in the chat, the board had the website's 4:30
  if (!(await pool.query("SELECT 1 FROM board_settings WHERE key='fix_1106_3'")).rows.length) {
    const r = await pool.query("UPDATE orders SET due=$1, note=TRIM(BOTH ' ·' FROM '⏰ العميل طلب 3:30 في الواتساب (كان 4:30) · ' || COALESCE(note,'')), updated=$2 WHERE op_day='2026-11-06' AND num=3 AND ref='MG-J4K76' AND status IN ('new','prep') RETURNING num",
      [Date.parse("2026-11-06T15:30:00+03:00"), Date.now()]);
    console.log("fix: 2026-11-06 #3 due 16:30 → 15:30 rows=" + r.rowCount);
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('fix_1106_3', 'true')");
  }
  // same, for open orders that only have a map point (no neighbourhood typed), e.g. #37 of 2026-11-05: look the point up
  if (!(await pool.query("SELECT 1 FROM board_settings WHERE key='fix_free_areas_1105b'")).rows.length) {
    const { rows } = await pool.query("SELECT id, num, area, dest, delivery_fee FROM orders WHERE type='del' AND status IN ('new','prep','ready','out') AND op_day >= '2026-11-05' AND COALESCE(delivery_fee,0) > 0 AND dest IS NOT NULL");
    let missed = 0;
    for (const o of rows) {
      const [lat, lng] = String(o.dest).split(",").map(Number);
      const hood = await neighbourhoodOf({ lat, lng });
      if (!hood) missed++;
      console.log(`fix: free-area check #${o.num} point=${o.dest} hood=${hood || "?"}`);
      if (isFreeArea(hood)) {
        await pool.query("UPDATE orders SET total = CASE WHEN total IS NULL THEN NULL ELSE total - delivery_fee END, delivery_fee = 0, area = regexp_replace(area, '^📍\\s*', '📍 ' || $3 || ' · '), updated=$2 WHERE id=$1", [o.id, Date.now(), hood.replace(/^حي\s+/, "")]);
        await pool.query("UPDATE orders SET area = regexp_replace(area, '\\(توصيل [0-9.]+ ر\\)', '(توصيل مجاني)') WHERE id=$1", [o.id]);
        console.log(`fix: free area #${o.num} fee ${o.delivery_fee} → 0`);
      }
    }
    if (!missed) await pool.query("INSERT INTO board_settings (key, value) VALUES ('fix_free_areas_1105b', 'true')"); // retried on next start if the lookup failed
  }
  // timeline of every order for the preparation analysis: each status change, plus item and time edits,
  // with how busy the kitchen was at that moment. Written by a trigger so every path (board, WhatsApp, website) is covered.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_events (
      id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL, op_day DATE NOT NULL, at BIGINT NOT NULL,
      kind TEXT NOT NULL, from_status TEXT, to_status TEXT, due BIGINT, items TEXT,
      open_new INT, open_prep INT, open_ready INT)`);
  await pool.query("CREATE INDEX IF NOT EXISTS order_events_day ON order_events (op_day, at)");
  await pool.query(`
    CREATE OR REPLACE FUNCTION log_order_event() RETURNS trigger AS $f$
    DECLARE n INT; pr INT; rd INT; ms BIGINT := (extract(epoch from clock_timestamp())*1000)::bigint;
    BEGIN
      SELECT count(*) FILTER (WHERE status='new'), count(*) FILTER (WHERE status='prep'), count(*) FILTER (WHERE status='ready')
        INTO n, pr, rd FROM orders WHERE op_day=NEW.op_day AND id<>NEW.id;
      IF TG_OP='INSERT' THEN
        INSERT INTO order_events (order_id,op_day,at,kind,to_status,due,items,open_new,open_prep,open_ready)
          VALUES (NEW.id,NEW.op_day,ms,'created',NEW.status,NEW.due,NEW.items,n,pr,rd);
      ELSE
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          INSERT INTO order_events (order_id,op_day,at,kind,from_status,to_status,due,items,open_new,open_prep,open_ready)
            VALUES (NEW.id,NEW.op_day,ms,'status',OLD.status,NEW.status,NEW.due,NEW.items,n,pr,rd);
        END IF;
        IF NEW.items IS DISTINCT FROM OLD.items OR NEW.due IS DISTINCT FROM OLD.due THEN
          INSERT INTO order_events (order_id,op_day,at,kind,from_status,to_status,due,items,open_new,open_prep,open_ready)
            VALUES (NEW.id,NEW.op_day,ms,'edited',OLD.status,NEW.status,NEW.due,NEW.items,n,pr,rd);
        END IF;
      END IF;
      RETURN NEW;
    END $f$ LANGUAGE plpgsql`);
  await pool.query("DROP TRIGGER IF EXISTS orders_log_event ON orders");
  await pool.query("CREATE TRIGGER orders_log_event AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION log_order_event()");
}

// ---------- helpers ----------
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
const num = v => (v === null || v === undefined || v === "" || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;

function send(res, code, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(code, {
    "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too_large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      const txt = Buffer.concat(chunks).toString("utf8");
      if (!txt) return resolve({});
      try { resolve(JSON.parse(txt)); } catch { reject(Object.assign(new Error("bad_json"), { code: 400 })); }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "?";
}

// simple fixed-window limiter
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.t > windowMs) { buckets.set(key, { t: now, n: 1 }); return false; }
  b.n++; return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();

// ---------- session (signed cookie) ----------
function sign(v) { return crypto.createHmac("sha256", SECRET).update(v).digest("base64url"); }
function makeSession() {
  const exp = Date.now() + 180 * 864e5;
  const v = `board.${exp}`;
  return `${v}.${sign(v)}`;
}
function isAuthed(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)mg_s=([^;]+)/);
  if (!m) return false;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  const v = `${parts[0]}.${parts[1]}`;
  const good = sign(v);
  if (good.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(parts[2]))) return false;
  return Number(parts[1]) > Date.now();
}

// ---------- orders ----------
function rowToOrder(r) {
  return {
    id: String(r.id), opDay: r.op_day instanceof Date ? r.op_day.toISOString().slice(0, 10) : String(r.op_day),
    num: r.num, ref: r.ref, source: r.source, type: r.type, status: r.status,
    name: r.name, phone: r.phone, area: r.area, items: r.items,
    total: r.total === null ? null : Number(r.total), deliveryFee: r.delivery_fee === null ? null : Number(r.delivery_fee),
    note: r.note, due: Number(r.due), created: Number(r.created), updated: Number(r.updated),
    confirmedAt: r.confirmed_at ? Number(r.confirmed_at) : null, outAt: r.out_at ? Number(r.out_at) : null,
    waFrom: r.wa_from || null, rawText: r.raw_text || "", needsReview: !!r.needs_review, appRef: r.app_ref || "",
    giftOut: r.gift_out || null, giftIn: r.gift_in || null, alertMuted: !!r.alert_muted,
    travelMin: r.travel_min == null ? null : Number(r.travel_min), dest: r.dest || null,
    prepAt: r.prep_at == null ? null : Number(r.prep_at),
    batchId: r.batch_id || null, batchSeq: r.batch_seq == null ? null : Number(r.batch_seq), batchOut: r.batch_out == null ? null : Number(r.batch_out),
  };
}

async function insertOrder(o) {
  const day = opDayOf(o.due);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["day:" + day]);
    const { rows: [{ n }] } = await client.query("SELECT COALESCE(MAX(num),0)+1 AS n FROM orders WHERE op_day=$1", [day]);
    const now = Date.now();
    const { rows } = await client.query(
      `INSERT INTO orders (op_day,num,ref,source,type,status,name,phone,area,items,total,delivery_fee,note,due,created,updated,confirmed_at,raw,wa_from,raw_text,needs_review,app_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [day, n, o.ref || null, o.source, o.type, o.status, o.name, o.phone, o.area, o.items, o.total, o.deliveryFee,
        o.note, o.due, now, o.status === "pending" ? null : now, o.raw ? JSON.stringify(o.raw) : null,
        o.waFrom || null, o.rawText || null, !!o.needsReview, o.appRef || null]);
    await client.query("COMMIT");
    return rowToOrder(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

function cleanDue(v) {
  const now = Date.now();
  const d = Number(v);
  if (!isFinite(d) || d < now - 12 * 3600e3 || d > now + 62 * 864e5) return null; // bookings up to two months ahead
  return Math.round(d);
}

// Website order payload (sent by the storefront right before it opens WhatsApp)
function fromWebPayload(b) {
  const ref = clip(b.ref, 16).toUpperCase();
  if (!/^MG-[A-Z0-9]{4,8}$/.test(ref)) return { error: "bad_ref" };
  const type = b.type === "del" ? "del" : "pick";
  const due = cleanDue(b.due);
  if (!due) return { error: "bad_due" };
  const items = Array.isArray(b.items) ? b.items.slice(0, 40).map(it => {
    const q = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
    const line = clip(`${clip(it.name, 60)} ${clip(it.tag, 30)}`, 100);
    const price = num(it.price);
    return `${q} × ${line}${price !== null ? ` — ${Math.round(price * q * 100) / 100} ريال` : ""}`;
  }).filter(Boolean) : [];
  if (!items.length) return { error: "no_items" };
  return {
    order: {
      ref, source: "web", type, status: "pending",
      name: clip(b.name, 60), phone: "", area: type === "del" ? clip(b.area, 80) : "",
      items: items.join("\n"), total: num(b.total), deliveryFee: num(b.deliveryFee),
      note: clip(b.notes, 300), due,
      raw: { asap: !!b.asap, timeLabel: clip(b.timeLabel, 40), dayText: clip(b.dayText, 40), ua: undefined },
    },
  };
}

function fromBoardPayload(b) {
  const due = cleanDue(b.due);
  if (!due) return { error: "bad_due" };
  const items = clip(normItemLines(b.items), 1500);
  if (!items) return { error: "no_items" };
  return {
    order: {
      ref: null, source: SOURCES.includes(b.source) && b.source !== "web" ? b.source : "wa",
      type: APPS.includes(b.source) ? "pick" : TYPES.includes(b.type) ? b.type : "pick", status: "new",
      appRef: APPS.includes(b.source) ? clip(b.appRef, 30) : null,
      name: clip(b.name, 60), phone: clip(b.phone, 20), area: b.type === "del" ? clip(b.area, 80) : "",
      items, total: num(b.total), deliveryFee: num(b.deliveryFee), note: clip(b.note, 300), due,
    },
  };
}

// ---------- CORS for the storefront ----------
function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  const ok = ALLOWED_ORIGINS.includes(origin) || (DEV_ALLOW_LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } : null;
}

// ---------- static board ----------
// the board page carries its version, so open screens can tell when a newer one is deployed
const BOARD_VER = crypto.createHash("sha1").update(fs.readFileSync(path.join(__dirname, "public", "board.html"))).digest("hex").slice(0, 10);
const boardHtml = () => fs.readFileSync(path.join(__dirname, "public", "board.html"), "utf8").replace("__BOARD_VER__", BOARD_VER);
// screens currently open (in memory): sound state and the last alert each one played, so the owner can check them remotely
const screens = new Map();
const loginHtml = () => fs.readFileSync(path.join(__dirname, "public", "login.html"));
let previewCache = null;
const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
  "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
};

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    // health
    if (p === "/healthz") { await pool.query("SELECT 1"); return send(res, 200, { ok: true }); }

    // storefront -> server
    if (p === "/api/web-order") {
      const cors = corsHeaders(req);
      if (req.method === "OPTIONS") { res.writeHead(cors ? 204 : 403, cors || {}); return res.end(); }
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      if (!cors) return send(res, 403, { error: "origin" });
      if (limited("web:" + clientIp(req), 30, 3600e3)) return send(res, 429, { error: "rate" }, cors);
      const b = await readBody(req, 24 * 1024);
      const { order, error } = fromWebPayload(b);
      if (error) return send(res, 400, { error }, cors);
      try {
        const o = await insertOrder(order);
        await applyGift(pool, o.id, order.note).catch(e => console.log("gift: " + e.message));
        console.log(`web order ${o.ref} #${o.num} day=${o.opDay}`);
        return send(res, 201, { ok: true, ref: o.ref, num: o.num }, cors);
      } catch (e) {
        if (e.code === "23505") return send(res, 200, { ok: true, ref: order.ref, duplicate: true }, cors);
        throw e;
      }
    }

    // WhatsApp webhook (Meta Cloud API format). The secret token is part of the path.
    const wh = p.match(/^\/webhooks\/whatsapp\/([A-Za-z0-9_-]{16,})$/);
    if (wh) {
      if (!WA_WEBHOOK_TOKEN || wh[1].length !== WA_WEBHOOK_TOKEN.length ||
          !crypto.timingSafeEqual(Buffer.from(wh[1]), Buffer.from(WA_WEBHOOK_TOKEN))) return send(res, 404, "Not found");
      if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode"), tok = url.searchParams.get("hub.verify_token");
        if (mode === "subscribe" && tok === WA_WEBHOOK_TOKEN) return send(res, 200, String(url.searchParams.get("hub.challenge") || ""));
        return send(res, 200, "ok");
      }
      if (req.method === "POST") {
        const b = await readBody(req, 512 * 1024);
        send(res, 200, { ok: true });
        handleWebhook(b, { pool, insertOrder, applyGift, log: m => console.log(m) }).catch(e => console.error("webhook", e));
        return;
      }
      return send(res, 405, { error: "method" });
    }

    // purchase photos → Hassan's Drive via his Apps Script (Google identity token of the Drive owner, no PIN / no shared secret)
    if (p === "/api/purchases/pending" || p === "/api/purchases/saved") {
      if (limited("purch:" + clientIp(req), 120, 3600e3)) return send(res, 429, { error: "rate" });
      if (!(await googleCaller(req).catch(() => null))) return send(res, 401, { error: "auth" });
      if (p.endsWith("pending") && req.method === "GET") return send(res, 200, { items: await pendingPurchases(pool) });
      if (p.endsWith("saved") && req.method === "POST") {
        const b = await readBody(req, 4096);
        return send(res, 200, { ok: await markSaved(pool, String(b.id || ""), String(b.link || ""), String(b.name || "")) });
      }
      return send(res, 405, { error: "method" });
    }
    // login
    if (p === "/login" && req.method === "GET") { res.writeHead(200, pageHeaders); return res.end(loginHtml()); }
    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (limited("login:" + ip, 10, 15 * 60e3)) return send(res, 429, { error: "rate" });
      const b = await readBody(req, 1024);
      const pin = String(b.pin || "");
      const ok = pin.length === BOARD_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(BOARD_PIN));
      if (!ok) return send(res, 401, { error: "pin" });
      return send(res, 200, { ok: true }, { "Set-Cookie": `mg_s=${makeSession()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${180 * 86400}` });
    }
    if (p === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "Set-Cookie": "mg_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
    }

    // short voice clips for the board alerts (public/sounds/<name>.mp3)
    const snd = p.match(/^\/sounds\/([a-z0-9-]{1,40})\.mp3$/);
    if (snd) {
      const f = path.join(__dirname, "public", "sounds", snd[1] + ".mp3");
      if (!fs.existsSync(f)) return send(res, 404, { error: "not_found" });
      const buf = fs.readFileSync(f);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length, "Cache-Control": "public, max-age=3600" });
      return res.end(buf);
    }
    // board page
    if (p === "/" || p === "/board") {
      if (!isAuthed(req)) { res.writeHead(302, { Location: "/login" }); return res.end(); }
      res.writeHead(200, pageHeaders); return res.end(boardHtml());
    }

    // board API
    if (p.startsWith("/api/board")) {
      if (!isAuthed(req)) return send(res, 401, { error: "auth" });
      // same-origin guard for writes
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: "origin" });
      }
      if (p === "/api/board/menu" && req.method === "GET") return send(res, 200, await getMenu());
      if (p === "/api/board/say" && req.method === "GET") {
        try {
          const audio = await speech(pool, url.searchParams.get("t"));
          res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "private, max-age=86400" });
          return res.end(audio);
        } catch (e) {
          if (e.code !== 503) console.log("tts: " + e.message);
          return send(res, e.code === 400 ? 400 : 503, { error: e.message.slice(0, 80) });
        }
      }
      if (p === "/api/board/orders" && req.method === "GET") {
        const day = String(url.searchParams.get("day") || opDayOf(Date.now()));
        const from = url.searchParams.get("from"); // bookings view: every day from this date on
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from))) return send(res, 400, { error: "day" });
        const { rows } = from
          ? await pool.query("SELECT * FROM orders WHERE op_day>=$1 ORDER BY due ASC", [from])
          : await pool.query("SELECT o.*, (SELECT min(e.at) FROM order_events e WHERE e.order_id=o.id AND e.to_status='prep') AS prep_at FROM orders o WHERE o.op_day=$1 ORDER BY o.due ASC", [day]);
        const st = await pool.query("SELECT value FROM board_settings WHERE key='sound'");
        const later = new Date(Date.parse(opDayOf(Date.now())) + 2 * 864e5).toISOString().slice(0, 10);
        const up = await pool.query("SELECT count(*)::int AS n FROM orders WHERE op_day>=$1 AND status NOT IN ('cancelled','dismissed','done')", [later]);
        const seen = [...screens.values()].filter(x => Date.now() - x.at < 3 * 60e3);
        // courier batches: route links for merged groups, and suggestions for today's open deliveries
        const groups = {};
        for (const o of rows) if (o.batch_id && o.status !== "cancelled") (groups[o.batch_id] = groups[o.batch_id] || []).push(o);
        const batches = Object.fromEntries(Object.entries(groups).map(([k, g]) => { g.sort((a, b) => (a.batch_seq || 0) - (b.batch_seq || 0));
          return [k, { nums: g.map(o => o.num), ids: g.map(o => String(o.id)), route: routeUrl(g.map(o => o.dest)) }]; }));
        const batchTips = !from && day === opDayOf(Date.now()) ? await suggestBatches(rows).catch(e => (console.log("batch: " + e.message), [])) : [];
        return send(res, 200, { now: Date.now(), day: from || day, orders: rows.map(rowToOrder), batches, batchTips, kitchenModel: kitchenModel(), rw: from ? [] : await listRw(pool, day), supervisorSet: !!process.env.SUPERVISOR_CODE, upcoming: up.rows[0].n, ver: BOARD_VER, costs: sheetState().costs, subsidyActive: sheetState().subsidyActive, screens: seen,
          blacklist: await listBlacklist(pool), blackPings: recentPings(), reviews: recentReviews(),
          alerts: (await pool.query("SELECT * FROM kitchen_alerts WHERE at > $1 ORDER BY at DESC LIMIT 15", [Date.now() - 24 * 3600e3])).rows.map(a => ({
            id: String(a.id), text: a.text, at: Number(a.at), fromDev: a.from_dev, fromName: a.from_name, heard: a.heard || [], ackAt: a.ack_at == null ? null : Number(a.ack_at), ackBy: a.ack_by })),
          settings: { sound: st.rows.length ? st.rows[0].value === true : true } });
      }
      if (p === "/api/board/reports" && req.method === "GET") {
        const weeks = (await pool.query("SELECT week_start::text AS w, created FROM weekly_reports ORDER BY week_start DESC LIMIT 26")).rows;
        const want = url.searchParams.get("week");
        if (want === "current") {
          // this week so far; one fresh build per 30 minutes
          const k = weekStartOf(opDayOf(Date.now()));
          if (!previewCache || previewCache.week !== k || Date.now() - previewCache.at > 30 * 60e3) previewCache = { week: k, at: Date.now(), r: await buildWeek(pool, k, { save: false }) };
          return send(res, 200, { weeks, report: { ...previewCache.r, partial: true } });
        }
        const w = want && /^\d{4}-\d{2}-\d{2}$/.test(want) ? want : weeks[0]?.w;
        const r = w ? (await pool.query("SELECT week_start::text AS \"weekStart\", data, brief FROM weekly_reports WHERE week_start=$1", [w])).rows[0] : null;
        return send(res, 200, { weeks, report: r || null });
      }
      if (p === "/api/board/customers" && req.method === "GET") {
        return send(res, 200, await customers(pool, Math.max(7, Math.min(90, parseInt(url.searchParams.get("lapse"), 10) || 21))));
      }
      if (p === "/api/board/taste" && req.method === "GET") {
        const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days"), 10) || 15));
        return send(res, 200, await tasteReport(pool, days));
      }
      if (p === "/api/board/blacklist" && req.method === "POST") {
        const b = await readBody(req, 2048);
        const r = await markNoShow(pool, String(b.orderId || ""));
        return send(res, r.error ? 400 : 200, r);
      }
      const bl = p.match(/^\/api\/board\/blacklist\/(\d{11,15})$/);
      if (bl && req.method === "DELETE") {
        await pool.query("DELETE FROM blacklist WHERE key=$1", [bl[1]]);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/board/heartbeat" && req.method === "POST") {
        const b = await readBody(req, 4096);
        const id = String(b.id || "").slice(0, 20); if (!id) return send(res, 400, { error: "id" });
        const cl = v => String(v ?? "").slice(0, 60);
        const prev = screens.get(id);
        const x = { id, name: cl(b.name), ver: cl(b.ver), unlocked: !!b.unlocked, master: !!b.master, visible: !!b.visible,
          lastPlay: b.lastPlay ? { kind: cl(b.lastPlay.kind), at: Number(b.lastPlay.at) || 0, ok: !!b.lastPlay.ok, err: cl(b.lastPlay.err) } : null, at: Date.now() };
        screens.set(id, x);
        if (x.lastPlay && (!prev?.lastPlay || prev.lastPlay.at !== x.lastPlay.at))
          console.log(`sound: ${x.name} ${x.lastPlay.ok ? "played" : "could not play"} ${x.lastPlay.kind}${x.lastPlay.err ? ": " + x.lastPlay.err : ""} (engine ${cl(b.lastPlay.ctx)}, page ${cl(b.lastPlay.vis)})`);
        if (!prev || prev.unlocked !== x.unlocked || prev.master !== x.master || prev.visible !== x.visible)
          console.log(`screen: ${x.name} ${x.id} sound=${x.master ? (x.unlocked ? "on" : "needs-tap") : "off"} visible=${x.visible} ver=${x.ver}`);
        if (screens.size > 50) for (const [k, v] of screens) if (Date.now() - v.at > 3600e3) screens.delete(k);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/board/rw" && req.method === "POST") {
        const b = await readBody(req, 4096);
        const r = await addRw(pool, b, opDayOf(Date.now()));
        return send(res, r.status, r.error ? { error: r.error } : { entry: r.entry });
      }
      if (p === "/api/board/alert" && req.method === "POST") {
        const b = await readBody(req, 4096);
        const text = String(b.text || "").trim().slice(0, 300);
        if (!text) return send(res, 400, { error: "text" });
        const { rows: [a] } = await pool.query("INSERT INTO kitchen_alerts (text, at, from_dev, from_name) VALUES ($1,$2,$3,$4) RETURNING id",
          [text, Date.now(), String(b.dev || "").slice(0, 20), String(b.name || "").slice(0, 60)]);
        console.log(`alert: #${a.id} sent from ${String(b.name || "?").slice(0, 60)}: ${text.slice(0, 80)}`);
        return send(res, 201, { id: String(a.id) });
      }
      const ka = p.match(/^\/api\/board\/alert\/(\d+)\/(heard|ack)$/);
      if (ka && req.method === "POST") {
        const b = await readBody(req, 2048);
        const name = String(b.name || "جهاز").slice(0, 60);
        if (ka[2] === "heard")
          await pool.query("UPDATE kitchen_alerts SET heard = CASE WHEN heard ? $2 THEN heard ELSE heard || to_jsonb($2::text) END WHERE id=$1", [ka[1], name]);
        else {
          await pool.query("UPDATE kitchen_alerts SET ack_at=$2, ack_by=$3 WHERE id=$1 AND ack_at IS NULL", [ka[1], Date.now(), name]);
          console.log(`alert: #${ka[1]} done on ${name}`);
        }
        return send(res, 200, { ok: true });
      }
      if (p === "/api/board/batch" && req.method === "POST") {
        // ids in drop order; out = when the courier leaves the shop
        const b = await readBody(req, 2048);
        const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 4);
        const out = Number(b.out);
        if (ids.length < 2 || !out) return send(res, 400, { error: "batch" });
        const bid = "B" + Date.now().toString(36);
        for (let i = 0; i < ids.length; i++)
          await pool.query("UPDATE orders SET batch_id=$1, batch_seq=$2, batch_out=$3, updated=$4 WHERE id=$5 AND status IN ('new','prep','ready')", [bid, i + 1, out, Date.now(), ids[i]]);
        console.log(`batch: ${bid} orders ${ids.join("+")} leave ${new Date(out + 3 * 3600e3).toISOString().slice(11, 16)}`);
        return send(res, 200, { batchId: bid });
      }
      const bd = p.match(/^\/api\/board\/batch\/(B[0-9a-z]+)$/);
      if (bd && req.method === "DELETE") {
        await pool.query("UPDATE orders SET batch_id=NULL, batch_seq=NULL, batch_out=NULL, updated=$2 WHERE batch_id=$1", [bd[1], Date.now()]);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/board/settings" && req.method === "POST") {
        const b = await readBody(req);
        if (typeof b.sound !== "boolean") return send(res, 400, { error: "sound" });
        await pool.query("INSERT INTO board_settings (key,value) VALUES ('sound',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(b.sound)]);
        return send(res, 200, { settings: { sound: b.sound } });
      }
      if (p === "/api/board/orders" && req.method === "POST") {
        const b = await readBody(req);
        const { order, error } = fromBoardPayload(b);
        if (error) return send(res, 400, { error });
        let o = await insertOrder(order);
        if (await applyGift(pool, o.id, order.note).catch(() => null)) o = rowToOrder((await pool.query("SELECT * FROM orders WHERE id=$1", [o.id])).rows[0]);
        return send(res, 201, { order: o });
      }
      const m = p.match(/^\/api\/board\/orders\/(\d+)$/);
      if (m && req.method === "PATCH") {
        const b = await readBody(req);
        // return gift: give this order its code and hand back the message to send on WhatsApp
        if (b.issueGift === true) {
          const code = await issueGift(pool, m[1]);
          if (!code) return send(res, 404, { error: "not_found" });
          const { rows } = await pool.query("SELECT * FROM orders WHERE id=$1", [m[1]]);
          return send(res, 200, { order: rowToOrder(rows[0]), code, message: giftMessage(code) });
        }
        const sets = []; const vals = [];
        const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
        if (b.status !== undefined) {
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: "status" });
          put("status", b.status);
          if (b.status === "out") put("out_at", Date.now());
          if (b.status === "cancelled") put("cancel_reason", clip(b.cancelReason, 40) || null);
        }
        if (b.muteAlert !== undefined) put("alert_muted", !!b.muteAlert);
        if (b.confirm === true) { put("confirmed_at", Date.now()); put("needs_review", false); }
        if (b.name !== undefined) put("name", clip(b.name, 60));
        if (b.phone !== undefined) put("phone", clip(b.phone, 20));
        if (b.area !== undefined) put("area", clip(b.area, 80));
        let before = null;
        if (b.items !== undefined) { const it = clip(normItemLines(b.items), 1500); if (!it) return send(res, 400, { error: "no_items" }); put("items", it);
          before = (await pool.query("SELECT id, source, items, raw_text FROM orders WHERE id=$1", [m[1]])).rows[0]; }
        if (b.note !== undefined) put("note", clip(b.note, 300));
        if (b.appRef !== undefined) put("app_ref", clip(b.appRef, 30) || null);
        if (b.total !== undefined) put("total", num(b.total));
        if (b.deliveryFee !== undefined) put("delivery_fee", b.deliveryFee === null ? null : num(b.deliveryFee));
        if (b.type !== undefined) { if (!TYPES.includes(b.type)) return send(res, 400, { error: "type" }); put("type", b.type); }
        if (b.source !== undefined) { if (!SOURCES.includes(b.source)) return send(res, 400, { error: "source" }); put("source", b.source); }
        if (b.due !== undefined) {
          const d = cleanDue(b.due); if (!d) return send(res, 400, { error: "bad_due" });
          const cur = await pool.query("SELECT op_day FROM orders WHERE id=$1", [m[1]]);
          if (!cur.rows.length) return send(res, 404, { error: "not_found" });
          const curDay = cur.rows[0].op_day instanceof Date ? cur.rows[0].op_day.toISOString().slice(0, 10) : String(cur.rows[0].op_day);
          if (opDayOf(d) !== curDay) {
            // moving a booking to another day: it takes the next number of that day
            const nd = opDayOf(d); const client = await pool.connect();
            try {
              await client.query("BEGIN");
              await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["day:" + nd]);
              const { rows: [{ n }] } = await client.query("SELECT COALESCE(MAX(num),0)+1 AS n FROM orders WHERE op_day=$1", [nd]);
              await client.query("UPDATE orders SET op_day=$1, num=$2 WHERE id=$3", [nd, n, m[1]]);
              await client.query("COMMIT");
            } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
          }
          put("due", d);
        }
        if (!sets.length) return send(res, 400, { error: "empty" });
        put("updated", Date.now());
        vals.push(m[1]);
        const { rows } = await pool.query(`UPDATE orders SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
        if (!rows.length) return send(res, 404, { error: "not_found" });
        if (before) await recordCorrection(pool, before, rows[0].items).catch(e => console.log("reader: " + e.message)); // the shop's fix teaches the reader
        // one courier: «خرج» or «تم» on one order of a group moves the others with it; cancelling one takes it out of the group
        if (rows[0].batch_id && ["out", "done"].includes(b.status))
          await pool.query(`UPDATE orders SET status=$1, out_at=COALESCE(out_at,$2), updated=$2 WHERE batch_id=$3 AND id<>$4 AND status IN ('new','prep','ready'${b.status === "done" ? ",'out'" : ""})`,
            [b.status, Date.now(), rows[0].batch_id, m[1]]);
        if (rows[0].batch_id && b.status === "cancelled") {
          await pool.query("UPDATE orders SET batch_id=NULL, batch_seq=NULL, batch_out=NULL WHERE id=$1", [m[1]]);
          const left = await pool.query("SELECT id FROM orders WHERE batch_id=$1 AND status<>'cancelled'", [rows[0].batch_id]);
          if (left.rows.length < 2) await pool.query("UPDATE orders SET batch_id=NULL, batch_seq=NULL, batch_out=NULL WHERE batch_id=$1", [rows[0].batch_id]);
        }
        if (b.note !== undefined && await applyGift(pool, m[1], b.note).catch(() => null)) {
          const again = await pool.query("SELECT * FROM orders WHERE id=$1", [m[1]]);
          return send(res, 200, { order: rowToOrder(again.rows[0]) });
        }
        return send(res, 200, { order: rowToOrder(rows[0]) });
      }
      return send(res, 404, { error: "not_found" });
    }

    return send(res, 404, "Not found");
  } catch (e) {
    const code = e.code === 413 ? 413 : e.code === 400 ? 400 : 500;
    if (code === 500) console.error(e);
    return send(res, code, { error: code === 500 ? "server" : e.message });
  }
});

migrate().then(() => {
  server.listen(PORT, () => console.log(`minigeesh-orders listening on ${PORT}`));
  startTasteJob(pool);
  startSheetJob(pool); // shared Google Sheet between the agents
  startKitchenModel(pool); // measured prep times → «أقرب وقت»
  setTimeout(() => ["2026-11-07", "2026-11-08"].reduce((p, d) => p.then(() => audit(pool, d)), Promise.resolve()).catch(e => console.log("audit: " + e.message)), 20e3); // one-off check (2026-11-09)
  setTimeout(async () => { try { // one-off (2026-11-10): purchase senders = Suleiman + Hassan (the number that sent the first test invoices)
    if (await pool.query("SELECT 1 FROM board_settings WHERE key='purchase_senders'").then(r => r.rows.length)) return;
    const h = (await pool.query("SELECT wa_from FROM purchases ORDER BY at LIMIT 1")).rows[0];
    const list = [{ key: "530853547", name: "سليمان" }];
    if (h) list.push({ key: String(h.wa_from).replace(/\D/g, "").slice(-9), name: "حسن" });
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('purchase_senders', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(list)]);
    if (h) await pool.query("UPDATE purchases SET sender='حسن', file_name=replace(file_name, sender, 'حسن') WHERE wa_from=$1", [h.wa_from]);
    const { api, read } = await import("./sheets.mjs");
    const col = await read("فواتير_المشتريات", "B:B");
    const rows = col.map((r, i) => [i, r[0]]).filter(([i, v]) => i > 0 && v === "البقاء لله");
    for (const [i] of rows) await api("PUT", `/values/${encodeURIComponent("'فواتير_المشتريات'!B" + (i + 1))}?valueInputOption=RAW`, { values: [["حسن"]] });
    console.log(`fix: purchase senders set (${list.length}), sheet rows renamed ${rows.length}`);
  } catch (e) { console.log("fix: purchase senders " + e.message); } }, 40e3);
  setTimeout(async () => { try { // one-off: which env variable holds the Dualhook key, and is it accepted? (names/status only)
    const { dualhookKey } = await import("./purchases.mjs");
    const dk = dualhookKey();
    const dh = Object.keys(process.env).filter(k => /DUAL|DH_/i.test(k));
    console.log(`dualhook-probe: env names with dualhook=${dh.join(",") || "-"} key_from=${dk.name || "none"} len=${dk.value.length}`);
    if (!dk.value) return;
    const r = await fetch("https://api.dualhook.com/v25.0/983224204880529?fields=id,status,quality_rating", { headers: { authorization: "Bearer " + dk.value } });
    console.log(`dualhook-probe: status=${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 160)}`);
  } catch (e) { console.log("dualhook-probe: " + e.message); } }, 15e3);
  setTimeout(async () => { try { // one-off: why #21 of 2026-11-09 got 19:30 (Hassan: the customer said right after Isha)
    const hm = ms => new Date(Number(ms) + 3 * 3600e3).toISOString().slice(11, 16);
    const o = (await pool.query("SELECT * FROM orders WHERE op_day='2026-11-09' AND num=21")).rows[0];
    if (!o) return console.log("o21: not found");
    console.log(`o21: created=${hm(o.created)} confirmed=${hm(o.confirmed_at)} due=${hm(o.due)} type=${o.type} status=${o.status} area=${o.area} note=${o.note} raw=${JSON.stringify(o.raw)}`);
    const ms = (await pool.query("SELECT dir, body, at FROM wa_messages WHERE wa_from=$1 AND at > $2 ORDER BY at", [o.wa_from, Number(o.created) - 3 * 3600e3])).rows;
    for (const m of ms) console.log(`o21: ${hm(m.at)} ${m.dir} ${String(m.body || "").replace(/\s+/g, " ").slice(0, 300)}`);
    const ev = (await pool.query("SELECT kind, from_status, to_status, due, at FROM order_events WHERE order_id=$1 ORDER BY at", [o.id])).rows;
    for (const e of ev) console.log(`o21: ev ${hm(e.at)} ${e.kind} ${e.from_status || ""}→${e.to_status || ""} due=${hm(e.due)}`);
  } catch (e) { console.log("o21: " + e.message); } }, 30e3);
  setTimeout(() => getMenu().then(m => { console.log(`menu: source=${m.source} products=${m.products.length}`); for (const p of m.products) console.log(`menu: ${p.id} | ${p.name} | ${p.description} | ${p.variants.map(v => v.tag + "=" + v.price).join(", ")}`); }).catch(e => console.log("menu: " + e.message)), 25e3); // one-off: compare with the printed menus (2026-11-09)
  // 2026-11-08 16:13 Hassan: delivery subsidy cancelled
  pool.query("INSERT INTO board_settings (key, value) VALUES ('subsidy_off_hassan', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(Date.parse("2026-11-08T16:13:00+03:00"))])
    .then(r => r.rowCount && console.log("fix: delivery subsidy off (Hassan 2026-11-08)")).catch(() => {});
  // 2026-11-08 #21 (Hassan): a «بوكس تشكيلة العائلة» 69 SAR was added but the total did not move; delivery is 20 SAR.
  // Once (board_settings fix21_1108): price the line, then total = lines + 20 when every line has a price.
  (async () => {
    if ((await pool.query("SELECT 1 FROM board_settings WHERE key='fix21_1108'")).rows.length) return;
    const o = (await pool.query("SELECT id, items, total, delivery_fee, area, type FROM orders WHERE op_day='2026-11-08' AND num=21")).rows[0];
    if (!o) return console.log("fix: #21 not found");
    console.log(`fix: #21 before total=${o.total} fee=${o.delivery_fee} type=${o.type} area=${o.area} items=${String(o.items).replace(/\n/g, " / ")}`);
    let items = normItemLines(o.items).split("\n").map(l => /العائلة/.test(l) && !/—\s*[\d.]+\s*ريال/.test(l) ? l + " — 69 ريال" : l).join("\n");
    if (o.type !== "del") return console.log("fix: #21 is not a delivery order, left as is");
    if (unpricedLines(items).length) return console.log("fix: #21 has unpriced lines, left as is: " + unpricedLines(items).join(" / "));
    const total = linesSum(items) + 20;
    const area = o.type === "del" ? (String(o.area || "").replace(/\s*\((?:توصيل[^)]*)\)\s*$/, "") + " (توصيل 20 ر)") : o.area;
    await pool.query("UPDATE orders SET items=$2, total=$3, delivery_fee=CASE WHEN type='del' THEN 20 ELSE delivery_fee END, area=$4, updated=$5 WHERE id=$1", [o.id, items, total, area, Date.now()]);
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('fix21_1108', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(Date.now())]);
    console.log(`fix: #21 after total=${total} area=${area} items=${items.replace(/\n/g, " / ")}`);
  })().catch(e => console.log("fix: #21 " + e.message));
  // 2026-11-07 #35: an Enter inside the item line split its price off, the total became 0
  pool.query(`UPDATE orders SET items='1 × كباجي جبن سائل برشة سكر 10 قطع — 20 ريال', total=20, updated=$1
    WHERE op_day='2026-11-07' AND num=35 AND total=0 AND items LIKE '%قطعة — 20%' RETURNING num`, [Date.now()])
    .then(r => r.rowCount && console.log("fix: 2026-11-07 #35 total 0 → 20")).catch(e => console.log("fix: #35 " + e.message));
  // 2026-11-06 Hassan: #13 (جواهر) to the no-show list
  (async () => {
    const o = (await pool.query("SELECT id, num, name, phone, wa_from, status, type FROM orders WHERE op_day='2026-11-06' AND num=13")).rows[0];
    if (!o) return console.log("fix: #13 not found");
    const k = keyOf(o.wa_from, o.phone);
    if (!/جواهر|jawaher/i.test(o.name || "")) return console.log(`fix: #13 name is «${o.name || ""}», not جواهر — not added (phone …${String(k || "").slice(-4)} ${o.type}/${o.status})`);
    if (k && !(await pool.query("SELECT 1 FROM blacklist WHERE key=$1", [k])).rows.length) {
      await markNoShow(pool, o.id);
      if (o.type === "del") { // a delivery she did not take from the courier, not a pickup
        await pool.query("UPDATE blacklist SET reason='ما استلمت التوصيل' WHERE key=$1", [k]);
        await pool.query("UPDATE orders SET note=REPLACE(note, '🚫 ما جاء للاستلام', '🚫 ما استلمت التوصيل') WHERE id=$1", [o.id]);
      }
      console.log(`fix: #13 (${o.name}) …${k.slice(-4)} added to the no-show list (was ${o.type}/${o.status})`);
    }
    else console.log(`fix: #13 ${k ? "already on the list" : "has no phone"}`);
  })().catch(e => console.log("fix: #13 " + e.message));
  // 2026-11-06 Hassan: #24 back to «بانتظار التحضير»; the chat says pickup («حطه استلام») under the name «ممتاز», the reader had delivery to النايفية
  (async () => {
    if ((await pool.query("SELECT 1 FROM board_settings WHERE key='fix_1106_24'")).rows.length) return;
    const b = (await pool.query("SELECT status, type, name, area, total, delivery_fee FROM orders WHERE op_day='2026-11-06' AND num=24")).rows[0];
    if (!b) return console.log("fix: #24 not found");
    await pool.query(`UPDATE orders SET status='new', out_at=NULL, type='pick', area='', delivery_fee=0, total=35, travel_min=NULL, dest=NULL,
      name=CASE WHEN COALESCE(name,'')='' THEN 'ممتاز' ELSE name END,
      note=TRIM(BOTH ' ·' FROM 'استلام من المحل (العميل: حطه استلام) · كان يبيه قبل 5 · ' || COALESCE(note,'')), updated=$1
      WHERE op_day='2026-11-06' AND num=24`, [Date.now()]);
    console.log(`fix: #24 ${b.status}/${b.type} ${b.area} total=${b.total} → new/pick total=35 name=${b.name || "ممتاز"}`);
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('fix_1106_24', 'true')");
  })().catch(e => console.log("fix: #24 " + e.message));
  // 2026-11-06 Hassan: Saleh's order #27 (website MG-UYYCK) becomes a delivery; location from the order or his chat
  (async () => {
    if ((await pool.query("SELECT 1 FROM board_settings WHERE key='fix_1106_27'")).rows.length) return;
    const o = (await pool.query("SELECT * FROM orders WHERE op_day='2026-11-06' AND num=27")).rows[0];
    if (!o) return console.log("fix: #27 not found");
    console.log(`fix: #27 before type=${o.type} name=${o.name} phone=…${String(o.phone || "").slice(-4)} wa=…${String(o.wa_from || "").slice(-4)} area=${o.area} fee=${o.delivery_fee} total=${o.total} dest=${o.dest} note=${String(o.note || "").slice(0, 200)}`);
    const keys = [o.wa_from, String(o.phone || "").replace(/\D/g, "").replace(/^0/, "966")].filter(Boolean);
    const msgs = (await pool.query("SELECT dir, body, at FROM wa_messages WHERE wa_from = ANY($1) ORDER BY at DESC LIMIT 12", [keys])).rows;
    for (const m of msgs.slice().reverse()) console.log(`fix: #27 chat ${new Date(Number(m.at) + 3 * 3600e3).toISOString().slice(11, 16)} ${m.dir === "in" ? "[العميل]" : "[المحل]"} ${String(m.body).slice(0, 160)}`);
    let pt = await findPoint(String(o.note || "")).catch(() => null), from = "the order";
    if (!pt) for (const m of msgs.filter(x => x.dir === "in")) { pt = await findPoint(m.body).catch(() => null); if (pt) { from = "the chat"; break; } }
    if (!pt) for (const k of keys) { const kp = await lastKnownPoint(pool, k, o.id).catch(() => null); if (kp) { pt = kp.point; from = "an earlier order " + kp.when; break; } }
    await pool.query("UPDATE orders SET type='del', delivery_fee=NULL, updated=$2 WHERE id=$1", [o.id, Date.now()]);
    if (pt) await applyLocation(pool, o.id, pt, console.log, from.startsWith("an earlier") ? "📍 الموقع من طلب سابق — تأكد مع العميل" : "");
    const a = (await pool.query("SELECT type, area, delivery_fee, total, travel_min, dest FROM orders WHERE id=$1", [o.id])).rows[0];
    console.log(`fix: #27 after (${pt ? "location from " + from : "NO location found"}) type=${a.type} area=${a.area} fee=${a.delivery_fee} total=${a.total} drive=${a.travel_min} dest=${a.dest}`);
    await pool.query("INSERT INTO board_settings (key, value) VALUES ('fix_1106_27', 'true')");
  })().catch(e => console.log("fix: #27 " + e.message));
  // 2026-11-06 Hassan: add two The Chefz orders from his screenshot (once each, by the app's order number)
  (async () => {
    for (const [ref, hm, items, total, status] of [
      ["301360153", "16:13", "1 × تشكيلة قوارب أجبان ومسخن تشكيلة — 59 ريال", 59, "new"],
      ["301369155", "17:50", "1 × تشكيلة قوارب أجبان ومسخن تشكيلة — 59 ريال", 59, "new"],
      ["301374451", "16:08", "1 × قوارب 18 قطعة — 49.5 ريال", 49.5, "prep"],    // already «قيد التحضير» in The Chefz
      ["301382840", "16:26", "1 × تشكيلة قوارب أجبان ومسخن تشكيلة — 59 ريال", 59, "prep"],
      ["301380056", "16:34", "1 × فطائر مثلثة مشكلة (الحجم غير مذكور في ذا شفز) — 67.5 ريال", 67.5, "new"],
    ]) {
      if ((await pool.query("SELECT 1 FROM orders WHERE app_ref=$1", [ref])).rows.length) continue;
      const o = await insertOrder({ source: "chefz", type: "del", status, name: "ذا شفز", phone: "", area: "",
        items, total, deliveryFee: null, note: "", due: Date.parse(`2026-11-06T${hm}:00+03:00`), appRef: ref });
      console.log(`fix: added The Chefz ${ref} as #${o.num} due ${hm}`);
    }
    // Hassan: «مثلثات فطائر مشكلة» on The Chefz (67.50) is 30 pieces
    const u = await pool.query("UPDATE orders SET items='1 × فطائر مثلثة 30 قطعة — 67.5 ريال', updated=$1 WHERE app_ref='301380056' AND items LIKE '%الحجم غير مذكور%' RETURNING num", [Date.now()]);
    if (u.rowCount) console.log("fix: The Chefz 301380056 #" + u.rows[0].num + " → 30 pieces");
  })().catch(e => console.log("fix: chefz " + e.message));
  // one-off for Hassan (2026-11-06): yesterday's boats and cup pizza lines
  pool.query("SELECT num, source, items FROM orders WHERE op_day='2026-11-05' AND status NOT IN ('cancelled','dismissed','pending') ORDER BY num")
    .then(r => { for (const o of r.rows) for (const l of String(o.items || "").split("\n")) if (/قوارب|كب بيتزا|تشكيلة|مسخن/.test(l)) console.log(`y1105: #${o.num} ${o.source} ${l}`); console.log("y1105: end orders=" + r.rows.length); })
    .catch(e => console.log("y1105: " + e.message));
  // score the reader against past corrections whenever its code changed
  if (process.env.ANTHROPIC_API_KEY) setTimeout(() => evalReader(pool, (t, id) => readTranscript(pool, t, id),
    readerVersion(fs.readFileSync(path.join(__dirname, "wa.mjs"), "utf8") + fs.readFileSync(path.join(__dirname, "reader.mjs"), "utf8"))).catch(e => console.log("reader-eval: " + e.message)), 120e3);
  startWeeklyJob(pool);
  // on start, log the taste report (no names or phones) so it can be read from the service logs
  tasteReport(pool, 15).then(r => {
    console.log(`taste-report: from=${r.from} days=${r.analysedDays} orders=${r.orders}`);
    for (const c of r.changes.slice(0, 25)) console.log(`taste-change: ${c.product} | ${c.ingredient} | ${c.change} | customers=${c.customers} requests=${c.requests} of product_orders=${c.product_orders} product_customers=${c.product_customers} | ${(c.examples || []).join(" ؛ ").slice(0, 160)}`);
    for (const l of r.lost.slice(0, 15)) console.log(`taste-lost: ${l.product} | ${l.ingredient || "-"} | ${l.reason} | customers=${l.customers} | ${(l.examples || []).join(" ؛ ").slice(0, 160)}`);
  }).catch(e => console.log("taste-report: " + e.message));
  // on start, log today's order timeline (no names or phones) to help trace late orders
  const hm = ms => ms ? new Date(Number(ms) + 3 * 3600e3).toISOString().slice(11, 16) : "-";
  pool.query("SELECT op_day::text AS d,num,source,type,status,area,items,total,note,raw_text,due,created,updated,ref,COALESCE(wa_from,phone,'') AS who FROM orders WHERE op_day>=$1 ORDER BY op_day,num", [opDayOf(Date.now())])
    .then(({ rows }) => rows.forEach(o => {
      console.log(`day: ${o.d === opDayOf(Date.now()) ? "" : o.d + " "}#${o.num} ${o.source}/${o.type}/${o.status} cust=…${String(o.who).slice(-4)} ref=${o.ref || "-"} total=${o.total} due=${hm(o.due)} created=${hm(o.created)} updated=${hm(o.updated)} area=${o.area || "-"} items=${String(o.items || "").replace(/\n/g, " / ").slice(0, 200)} note=${String(o.note || "").slice(0, 120)}`);
      if (o.source === "wa" && o.raw_text) console.log(`chat: #${o.num} ` + String(o.raw_text).replace(/\n/g, " ⏎ ").slice(-1500));
    }))
    .catch(e => console.log("day: " + e.message));
}).catch(e => { console.error("migration failed", e); process.exit(1); });
