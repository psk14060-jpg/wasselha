// Minigeesh order server
// - POST /api/web-order      : website sends an order (public, CORS) -> status "pending"
// - GET  /                   : kitchen board (PIN protected)
// - /api/board/*             : board reads and updates orders
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateWa, handleWebhook } from "./wa.mjs";
import { getMenu } from "./menu.mjs";
import { migrateTts, speech } from "./tts.mjs";

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
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS app_ref TEXT");
  await migrateTts(pool);
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
  if (!isFinite(d) || d < now - 12 * 3600e3 || d > now + 8 * 864e5) return null;
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
  const items = clip(b.items, 1500);
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
const boardHtml = () => fs.readFileSync(path.join(__dirname, "public", "board.html"));
const loginHtml = () => fs.readFileSync(path.join(__dirname, "public", "login.html"));
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
    // read-only support view (no names or phones), enabled only while DIAG_TOKEN is set
    if (p === "/api/diag" && process.env.DIAG_TOKEN && url.searchParams.get("token") === process.env.DIAG_TOKEN) {
      const { rows } = await pool.query("SELECT num,source,type,status,area,items,note,due,created,updated,confirmed_at,out_at FROM orders WHERE op_day=$1 ORDER BY num", [url.searchParams.get("day") || opDayOf(Date.now())]);
      return send(res, 200, rows);
    }
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
        handleWebhook(b, { pool, insertOrder, log: m => console.log(m) }).catch(e => console.error("webhook", e));
        return;
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
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, { error: "day" });
        const { rows } = await pool.query("SELECT * FROM orders WHERE op_day=$1 ORDER BY due ASC", [day]);
        return send(res, 200, { now: Date.now(), day, orders: rows.map(rowToOrder) });
      }
      if (p === "/api/board/orders" && req.method === "POST") {
        const b = await readBody(req);
        const { order, error } = fromBoardPayload(b);
        if (error) return send(res, 400, { error });
        const o = await insertOrder(order);
        return send(res, 201, { order: o });
      }
      const m = p.match(/^\/api\/board\/orders\/(\d+)$/);
      if (m && req.method === "PATCH") {
        const b = await readBody(req);
        const sets = []; const vals = [];
        const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
        if (b.status !== undefined) {
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: "status" });
          put("status", b.status);
          if (b.status === "out") put("out_at", Date.now());
        }
        if (b.confirm === true) { put("confirmed_at", Date.now()); put("needs_review", false); }
        if (b.name !== undefined) put("name", clip(b.name, 60));
        if (b.phone !== undefined) put("phone", clip(b.phone, 20));
        if (b.area !== undefined) put("area", clip(b.area, 80));
        if (b.items !== undefined) { const it = clip(b.items, 1500); if (!it) return send(res, 400, { error: "no_items" }); put("items", it); }
        if (b.note !== undefined) put("note", clip(b.note, 300));
        if (b.appRef !== undefined) put("app_ref", clip(b.appRef, 30) || null);
        if (b.total !== undefined) put("total", num(b.total));
        if (b.type !== undefined) { if (!TYPES.includes(b.type)) return send(res, 400, { error: "type" }); put("type", b.type); }
        if (b.source !== undefined) { if (!SOURCES.includes(b.source)) return send(res, 400, { error: "source" }); put("source", b.source); }
        if (b.due !== undefined) {
          const d = cleanDue(b.due); if (!d) return send(res, 400, { error: "bad_due" });
          const cur = await pool.query("SELECT op_day FROM orders WHERE id=$1", [m[1]]);
          if (!cur.rows.length) return send(res, 404, { error: "not_found" });
          const curDay = cur.rows[0].op_day instanceof Date ? cur.rows[0].op_day.toISOString().slice(0, 10) : String(cur.rows[0].op_day);
          if (opDayOf(d) !== curDay) return send(res, 400, { error: "day_change" });
          put("due", d);
        }
        if (!sets.length) return send(res, 400, { error: "empty" });
        put("updated", Date.now());
        vals.push(m[1]);
        const { rows } = await pool.query(`UPDATE orders SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
        if (!rows.length) return send(res, 404, { error: "not_found" });
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
}).catch(e => { console.error("migration failed", e); process.exit(1); });
