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
const MERGE_WINDOW = 20 * 60e3;   // raw fallback merge
const CONV_WINDOW = 90 * 60e3;    // how far back a chat is read as one conversation
const CHANGE_WINDOW = 3 * 3600e3; // a confirmed order this recent can be "changed" by new messages

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
    ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS dir TEXT NOT NULL DEFAULT 'in';
  `);
}

const msgText = m => {
  if (m.type === "text") return m.text?.body || "";
  if (m.type === "button") return m.button?.text || "";
  if (m.type === "interactive") return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
  if (m.type === "image" || m.type === "video" || m.type === "document") return m[m.type]?.caption || "";
  return "";
};

// Pull messages out of a webhook body: customer messages (dir "in") and, with coexistence,
// the replies the business sent from the WhatsApp Business app (smb_message_echoes, dir "out").
// `from` is always the customer's number, so one conversation shares one key.
export function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch.value || {};
      if (!ch.field || ch.field === "messages") {
        const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name || ""]));
        for (const m of v.messages || []) {
          out.push({ id: m.id, from: m.from, name: names[m.from] || "", type: m.type, dir: "in",
            text: String(msgText(m)).slice(0, 4000), ts: Number(m.timestamp) * 1000 || Date.now() });
        }
      } else if (ch.field === "smb_message_echoes") {
        for (const m of v.message_echoes || []) {
          if (!m.to) continue;
          out.push({ id: m.id, from: m.to, name: "", type: m.type, dir: "out",
            text: String(msgText(m)).slice(0, 4000), ts: Number(m.timestamp) * 1000 || Date.now() });
        }
      }
    }
  }
  return out;
}

async function askClaude(apiKey, transcript, nowMs, previous) {
  const riyadh = new Date(nowMs + 3 * 3600e3);
  const nowTxt = riyadh.toISOString().slice(0, 16).replace("T", " ");
  const system = `أنت تقرأ محادثة واتساب بين عميل ومطعم مينيقيش للمعجنات في الهفوف، وتستخرج الطلب النهائي الذي اتفقا عليه.
السطور التي تبدأ بـ [العميل] كتبها العميل، والتي تبدأ بـ [المحل] ردود المطعم.
الوقت الآن في الرياض: ${nowTxt}. ساعات الطلب من 3:30 عصرًا حتى 12:30 بعد منتصف الليل، فأي ساعة بلا ص/م تعني مساءً، و12 تعني منتصف الليل.
المنيو والأسعار (السعر للبوكس الواحد):
${MENU}
${previous ? `ملاحظة: هذا العميل عنده طلب مؤكد سابقًا (#${previous.num}) أصنافه: ${previous.items.replace(/\n/g, "، ")}. إذا كانت الرسائل الجديدة تعدّل ذلك الطلب أو تضيف عليه فاجعل is_change=true واكتب في items الطلب كاملًا بعد التعديل.` : ""}
أعد JSON فقط بلا أي نص آخر:
{"is_order":true|false,"is_change":true|false,"name":"","type":"del|pick|unknown","area":"","day":0|1,"time":"HH:MM"|"asap"|null,"items":["1 × بيتزا 10 قطع (رانش) — 21 ريال"],"total":number|null,"note":"","unclear":"ما ينقص باختصار، أو فارغ"}
قواعد:
- العملاء يكتبون بالعامية وعلى عدة رسائل، ويسألون قبل أن يطلبوا. اقرأ المحادثة كلها واستخرج ما استقر عليه العميل في النهاية: إذا غيّر رأيه فخذ الأخير.
- is_order=true فقط إذا طلب العميل أصنافًا فعلًا (مثل: سو لي، ابغى، جهز لي، خلاص عطني). الأسئلة عن الأصناف أو الحشوات أو الأسعار أو الدوام أو الموقع وحدها ليست طلبًا.
- العدد قد يكون بالقطع لا بالبوكسات: «10 بيتزا» تعني بوكس بيتزا 10 قطع، و«20 فطاير» بوكس 20 قطعة. إذا لم يطابق العدد حجمًا في المنيو فاكتبه كما قاله وانسب السعر الأقرب منطقيًا واذكر ذلك في unclear.
- الحشوة أو النكهة تُكتب بين قوسين بعد الصنف. إذا طلب نكهتين لنفس الصنف فاجعل كل نكهة سطرًا مستقلًا.
- إذا ذكر [المحل] سعرًا أو وقتًا أو تفصيلًا ووافق العميل فاعتمده.
- اكتب السعر من المنيو لكل سطر = العدد × سعر البوكس، والإجمالي مجموع السطور. إذا تعذّر سعر سطر فاتركه بلا سعر واجعل total=null.
- day=1 فقط إذا قال بكرة أو غدًا. type=del إذا طلب توصيل أو ذكر حيًا للتوصيل، وpick إذا قال استلام أو بمر آخذه.
- لا تخترع شيئًا لم يُذكر.`;
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages: [{ role: "user", content: transcript }] }),
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

// Read this customer's recent conversation and create or update their order card.
async function readConversation(m, phone, ctx, apiKey, fallbackCard) {
  const { pool, insertOrder, log } = ctx;
  const now = Date.now();
  const open = (await pool.query(
    `SELECT id, created FROM orders WHERE wa_from=$1 AND source='wa' AND status='pending' AND created > $2 ORDER BY created DESC LIMIT 1`,
    [m.from, now - CONV_WINDOW])).rows[0];
  const prev = open ? null : (await pool.query(
    `SELECT id, num, items, confirmed_at FROM orders WHERE wa_from=$1 AND status IN ('new','prep','ready','out') AND confirmed_at > $2 ORDER BY confirmed_at DESC LIMIT 1`,
    [m.from, now - CHANGE_WINDOW])).rows[0];
  // where the conversation starts: shortly before the open card, after the confirmed order, or the last 90 minutes
  const since = open ? Number(open.created) - 30 * 60e3 : prev ? Number(prev.confirmed_at) - 5000 : now - CONV_WINDOW; // WhatsApp timestamps are whole seconds
  const rows = (await pool.query(
    `SELECT dir, body FROM wa_messages WHERE wa_from=$1 AND at >= $2 AND body<>'' ORDER BY at ASC LIMIT 60`, [m.from, since])).rows;
  if (!rows.some(r => r.dir !== "out")) return "no_customer_text";
  const transcript = rows.map(r => (r.dir === "out" ? "[المحل] " : "[العميل] ") + r.body).join("\n").slice(-6000);
  let p;
  try { p = await askClaude(apiKey, transcript, now, prev ? { num: prev.num, items: prev.items } : null); }
  catch (e) {
    log("wa: claude failed " + String(e.message || e).slice(0, 160));
    return fallbackCard ? await fallbackCard("claude_error") : "claude_error";
  }
  if (!p.is_order) return "not_order";
  const { due, timeKnown } = dueFromParsed(p, now);
  const items = (Array.isArray(p.items) ? p.items : []).map(x => String(x).slice(0, 140)).filter(Boolean).slice(0, 30).join("\n") || "(الأصناف غير واضحة)";
  const changeNote = prev && p.is_change ? `تعديل على الطلب المؤكد #${prev.num} — عدّل الطلب الأصلي أو ألغه` : "";
  const note = [changeNote, p.note, !timeKnown ? "الوقت غير محدد" : "", p.unclear ? "ناقص: " + p.unclear : ""].filter(Boolean).join(" · ").slice(0, 300);
  const fields = {
    name: String(p.name || m.name || "").slice(0, 60), type: p.type === "del" ? "del" : "pick",
    area: p.type === "del" ? String(p.area || "").slice(0, 80) : "", items,
    total: p.total !== null && p.total !== undefined && isFinite(Number(p.total)) ? Number(p.total) : null, note, due,
  };
  if (open) {
    await pool.query(`UPDATE orders SET name=CASE WHEN $1<>'' THEN $1 ELSE name END,type=$2,area=$3,items=$4,total=$5,note=$6,due=$7,raw_text=$8,updated=$9 WHERE id=$10`,
      [fields.name, fields.type, fields.area, fields.items, fields.total, fields.note, fields.due, transcript.slice(-3000), now, open.id]);
    return "card_updated " + open.id;
  }
  const o = await insertOrder({ ref: null, source: "wa", status: "pending", phone, deliveryFee: null, ...fields,
    waFrom: m.from, rawText: transcript.slice(-3000), needsReview: true });
  return (changeNote ? "change_card_created #" : "card_created #") + o.num;
}

// ctx: { pool, insertOrder, opDayOf, log }
export async function handleWebhook(body, ctx) {
  const { pool, insertOrder, log } = ctx;
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const msgs = extractMessages(body);
  const fields = (body?.entry || []).flatMap(e => (e.changes || []).map(c => c.field)).join(",");
  log(`wa: webhook received fields=${fields || "-"} messages=${msgs.length}`);
  for (const m of msgs) {
    // de-duplicate (providers retry)
    const ins = await pool.query("INSERT INTO wa_messages (id, wa_from, kind, body, at, dir) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id",
      [m.id, m.from, m.type, m.text, m.ts, m.dir]);
    if (!ins.rows.length) continue;
    const phone = localPhone(m.from);
    let result = "ignored";
    try {
      // the business's own reply: only re-read a conversation that already has an open card
      if (m.dir === "out") {
        if (!apiKey || !m.text.trim()) { result = "echo_stored"; continue; }
        const open = await pool.query(`SELECT id FROM orders WHERE wa_from=$1 AND source='wa' AND status='pending' AND created > $2 LIMIT 1`, [m.from, Date.now() - CONV_WINDOW]);
        if (!open.rows.length) { result = "echo_stored"; continue; }
        result = await readConversation(m, phone, ctx, apiKey);
        log("wa: " + result);
        continue;
      }
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

      // 3) free text -> read the whole recent conversation
      result = await readConversation(m, phone, ctx, apiKey, fallbackCard);
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
