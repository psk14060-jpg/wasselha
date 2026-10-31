// WhatsApp intake: Meta Cloud API webhook payloads (direct, or forwarded by a coexistence provider).
// - A message that carries a website order number (MG-XXXXX) confirms that pending order automatically.
// - Other customer text is read by Claude; if it is an order, it becomes a "review and confirm" card.
// - Several messages from the same customer within 20 minutes update one card instead of creating many.

const MENU = `فطائر مثلثة: 10 قطع 20 ريال، 20 قطعة 35، 30 قطعة 45
كب بيتزا: 28 قطعة 47، 42 قطعة 65
قوارب: 18 قطعة 35
قوارب المسخن: 18 قطعة 39
تشكيلة قوارب أجبان ومسخن: 49
كباجي جبن سائل برشة سكر: 10 قطع 20، 20 قطعة 38
ميني كباجي بالسكر: 35 قطعة 35
ميني كباجي بالكراميل: 35 قطعة 42
سمبوسة جنوبية: 10 قطع 20، 20 قطعة 38
بيتزا: 10 قطع 21، 20 قطعة 39
مناقيش: 10 قطع 21، 20 قطعة 39
تشكيلة 48 (تكفي 8–10): 72
تشكيلة 80 (تكفي 18): 115
تشكيلة 115 (تكفي 25): 145`;

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// the same message reader the board uses, for when Claude is unavailable
const { parseOrder } = new Function(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "parser.js"), "utf8") + "\nreturn { parseOrder };")();

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const MERGE_WINDOW = 20 * 60e3;

const localPhone = waId => {
  const d = String(waId || "").replace(/\D/g, "");
  return d.startsWith("966") ? "0" + d.slice(3) : d;
};

export async function migrateWa(pool) {
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS wa_from TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_text TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS wa_messages (
      id TEXT PRIMARY KEY,
      wa_from TEXT,
      kind TEXT,
      body TEXT,
      at BIGINT NOT NULL,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS wa_messages_from_idx ON wa_messages (wa_from, at);
  `);
}

// Pull customer messages out of a webhook body. Ignores the business's own messages (echoes) and statuses.
export function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      if (ch.field && ch.field !== "messages") continue;
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name || ""]));
      for (const m of v.messages || []) {
        let text = "";
        if (m.type === "text") text = m.text?.body || "";
        else if (m.type === "button") text = m.button?.text || "";
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
        else if (m.type === "image" || m.type === "video" || m.type === "document") text = m[m.type]?.caption || "";
        out.push({ id: m.id, from: m.from, name: names[m.from] || "", type: m.type, text: String(text).slice(0, 4000), ts: Number(m.timestamp) * 1000 || Date.now() });
      }
    }
  }
  return out;
}

async function askClaude(apiKey, text, nowMs) {
  const riyadh = new Date(nowMs + 3 * 3600e3);
  const nowTxt = riyadh.toISOString().slice(0, 16).replace("T", " ");
  const system = `أنت تقرأ رسائل واتساب يرسلها عملاء مطعم مينيقيش للمعجنات في الهفوف، وتحوّل الطلبات إلى بيانات.
الوقت الآن في الرياض: ${nowTxt}. ساعات الطلب من 3:30 عصرًا حتى 12:30 بعد منتصف الليل، فأي ساعة بلا ص/م تعني مساءً، و12 تعني منتصف الليل.
المنيو والأسعار (السعر للبوكس):
${MENU}
أعد JSON فقط بلا أي نص آخر، بهذا الشكل:
{"is_order":true|false,"name":"","type":"del|pick|unknown","area":"","day":0|1,"time":"HH:MM"|"asap"|null,"items":["2 × فطائر مثلثة 20 قطعة — 70 ريال"],"total":number|null,"note":"","unclear":"ما الذي ينقص أو غير واضح، باختصار"}
قواعد:
- is_order=true فقط إذا كانت الرسالة تطلب أصنافًا فعلًا. التحية والسؤال عن الأسعار أو الموقع أو الدوام ليست طلبًا.
- طابق الأصناف مع المنيو واكتب السعر من المنيو. إذا لم يُذكر الحجم فاكتب الصنف بلا حجم ولا سعر واذكر ذلك في unclear.
- day=1 فقط إذا قال بكرة أو غدًا أو ذكر يوم الغد.
- لا تخترع شيئًا لم يقله العميل.`;
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: text }] }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error("claude_http_" + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const raw = (j.content || []).map(c => c.text || "").join("");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("claude_no_json");
  return JSON.parse(m[0]);
}

function dueFromParsed(p, nowMs) {
  if (!p || !p.time || p.time === "asap") return { due: nowMs + 30 * 60e3, timeKnown: p?.time === "asap" };
  const mm = String(p.time).match(/^(\d{1,2}):(\d{2})$/);
  if (!mm) return { due: nowMs + 30 * 60e3, timeKnown: false };
  const h = +mm[1], mi = +mm[2];
  const opDay = new Date(nowMs + 3 * 3600e3 - 6 * 3600e3);          // Riyadh operating day
  let ms = Date.UTC(opDay.getUTCFullYear(), opDay.getUTCMonth(), opDay.getUTCDate() + (p.day === 1 ? 1 : 0), h, mi) - 3 * 3600e3;
  if (h * 60 + mi < 6 * 60) ms += 864e5;
  return { due: ms, timeKnown: true };
}

// ctx: { pool, insertOrder, opDayOf, log }
export async function handleWebhook(body, ctx) {
  const { pool, insertOrder, log } = ctx;
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const msgs = extractMessages(body);
  const fields = (body?.entry || []).flatMap(e => (e.changes || []).map(c => c.field)).join(",");
  log(`wa: webhook received fields=${fields || "-"} customer_messages=${msgs.length}`);
  for (const m of msgs) {
    // de-duplicate (providers retry)
    const ins = await pool.query("INSERT INTO wa_messages (id, wa_from, kind, body, at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id",
      [m.id, m.from, m.type, m.text, m.ts]);
    if (!ins.rows.length) continue;
    const phone = localPhone(m.from);
    let result = "ignored";
    try {
      // 1) website order number
      const ref = (m.text.match(/MG-[A-Z0-9]{4,8}/i) || [])[0];
      if (ref) {
        const up = await pool.query(
          `UPDATE orders SET status=CASE WHEN status IN ('pending','dismissed') THEN 'new' ELSE status END,
             confirmed_at=COALESCE(confirmed_at,$2), phone=CASE WHEN phone='' THEN $3 ELSE phone END, wa_from=$4, updated=$2
           WHERE ref=$1 RETURNING num, status`, [ref.toUpperCase(), Date.now(), phone, m.from]);
        result = up.rows.length ? `confirmed ${ref} #${up.rows[0].num}` : `ref_not_found ${ref}`;
        if (up.rows.length) { log(`wa: ${result}`); continue; }
      }
      // 2) voice note or media without text: card asking the owner to listen
      if (!m.text && ["audio", "voice", "image", "video", "document"].includes(m.type)) {
        if (m.type === "audio" || m.type === "voice") {
          await insertOrder({ ref: null, source: "wa", type: "pick", status: "pending", name: m.name, phone, area: "",
            items: "رسالة صوتية — استمع لها في واتساب", total: null, deliveryFee: null, note: "", due: Date.now() + 30 * 60e3,
            waFrom: m.from, rawText: "[رسالة صوتية]", needsReview: true });
          result = "voice_card";
        }
        continue;
      }
      if (!m.text.trim()) { result = "empty"; continue; }
      const ORDER_HINT = /(ابغى|أبغى|ابغي|ابي|أبي|ابا|أبا|اطلب|أطلب|طلب|بوكس|حبه|حبة|قطعة|قطع|توصيل|استلام|فطائر|فطاير|كب|قوارب|كباجي|سمبوسة|بيتزا|مناقيش|تشكيلة|\d)/;
      const fallbackCard = async why => {
        // Claude unavailable: still put the raw message on the board so it is never lost
        const open = await pool.query(`SELECT id, raw_text FROM orders WHERE wa_from=$1 AND source='wa' AND status='pending' AND created > $2 ORDER BY created DESC LIMIT 1`,
          [m.from, Date.now() - MERGE_WINDOW]);
        if (open.rows.length) {
          const t = ((open.rows[0].raw_text || "") + "\n" + m.text).slice(-3000);
          await pool.query("UPDATE orders SET raw_text=$1, items=$2, updated=$3 WHERE id=$4", [t, t.slice(0, 1500), Date.now(), open.rows[0].id]);
          return "raw_card_updated (" + why + ")";
        }
        if (!ORDER_HINT.test(m.text)) return "ignored_no_hint (" + why + ")";
        let pr = {}; try { pr = parseOrder(m.text); } catch {}
        const t = pr.time ? `${String(pr.time.h).padStart(2, "0")}:${String(pr.time.m).padStart(2, "0")}` : (pr.asap ? "asap" : null);
        const { due, timeKnown } = dueFromParsed({ time: t, day: pr.day === 1 ? 1 : 0 }, Date.now());
        const cleaned = m.text.replace(/(السلام عليكم|مرحبا|ابغى|أبغى|ابغي|ابي|أبي|ابا|أبا|لو سمحت|الله يعافيك)/g, "")
          .replace(/(?:الساعة|الساعه|ساعة|ساعه|على)\s*[\d٠-٩]{1,2}(?:[:.][\d٠-٩]{2})?\s*(ونص|و نص|والنص|وربع|و ربع|الا ربع|إلا ربع)?\s*(صباحا|صباحًا|مساء|مساءً|ليلا|عصرا|ص|م)?/g, "")
          .replace(/(استلام|توصيل)/g, "").replace(/\s{2,}/g, " ").trim();
        const o = await insertOrder({ ref: null, source: "wa", type: pr.type === "del" ? "del" : "pick", status: "pending", name: pr.name || m.name, phone,
          area: pr.type === "del" ? (pr.area || "") : "", items: (cleaned || m.text).slice(0, 1500), total: pr.total ?? null, deliveryFee: null,
          note: ["راجع الأصناف", timeKnown ? "" : "الوقت غير محدد"].filter(Boolean).join(" · "), due,
          waFrom: m.from, rawText: m.text.slice(0, 3000), needsReview: true });
        return "raw_card_created #" + o.num + " (" + why + ")";
      };
      if (!apiKey) { result = await fallbackCard("no_api_key"); log("wa: " + result); continue; }

      // 3) free text -> merge with this customer's recent open card, then let Claude read it
      const open = await pool.query(
        `SELECT id, raw_text FROM orders WHERE wa_from=$1 AND source='wa' AND status='pending' AND created > $2 ORDER BY created DESC LIMIT 1`,
        [m.from, Date.now() - MERGE_WINDOW]);
      const prevText = open.rows[0]?.raw_text && open.rows[0].raw_text !== "[رسالة صوتية]" ? open.rows[0].raw_text : "";
      let combined = prevText ? prevText + "\n" + m.text : m.text;
      if (!prevText) {
        // include this customer's last few messages so an order split over messages is read together
        const recent = await pool.query("SELECT body FROM wa_messages WHERE wa_from=$1 AND at > $2 AND id<>$3 AND body<>'' ORDER BY at ASC LIMIT 6",
          [m.from, Date.now() - MERGE_WINDOW, m.id]);
        if (recent.rows.length) combined = recent.rows.map(r => r.body).join("\n") + "\n" + m.text;
      }
      let p;
      try { p = await askClaude(apiKey, combined.slice(-3000), Date.now()); }
      catch (e) { log("wa: claude failed " + String(e.message || e).slice(0, 160)); result = await fallbackCard("claude_error"); log("wa: " + result); continue; }
      if (!p.is_order) { result = "not_order"; continue; }
      const { due, timeKnown } = dueFromParsed(p, Date.now());
      const items = (Array.isArray(p.items) ? p.items : []).map(s => String(s).slice(0, 120)).filter(Boolean).slice(0, 30).join("\n") || "(الأصناف غير واضحة)";
      const notes = [p.note, !timeKnown ? "الوقت غير محدد" : "", p.unclear ? "ناقص: " + p.unclear : ""].filter(Boolean).join(" · ").slice(0, 300);
      const fields = {
        name: String(p.name || m.name || "").slice(0, 60), type: p.type === "del" ? "del" : "pick",
        area: p.type === "del" ? String(p.area || "").slice(0, 80) : "", items,
        total: isFinite(Number(p.total)) && p.total !== null ? Number(p.total) : null, note: notes, due,
      };
      if (open.rows.length) {
        await pool.query(`UPDATE orders SET name=$1,type=$2,area=$3,items=$4,total=$5,note=$6,due=$7,raw_text=$8,updated=$9 WHERE id=$10`,
          [fields.name, fields.type, fields.area, fields.items, fields.total, fields.note, fields.due, combined.slice(-3000), Date.now(), open.rows[0].id]);
        result = "card_updated " + open.rows[0].id;
      } else {
        const o = await insertOrder({ ref: null, source: "wa", status: "pending", phone, deliveryFee: null, ...fields,
          waFrom: m.from, rawText: combined.slice(-3000), needsReview: true });
        result = "card_created #" + o.num;
      }
      log(`wa: ${result}`);
    } catch (e) {
      result = "error " + String(e.message || e).slice(0, 180);
      log(`wa: ${result}`);
    } finally {
      await pool.query("UPDATE wa_messages SET result=$1 WHERE id=$2", [result, m.id]).catch(() => {});
    }
  }
  return msgs.length;
}
