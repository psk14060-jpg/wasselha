// WhatsApp intake: Meta Cloud API webhook payloads (direct, or forwarded by a coexistence provider).
// - A message that carries a website order number (MG-XXXXX) confirms that pending order automatically.
// - Other customer text is read by Claude; if it is an order, it becomes a "review and confirm" card.
// - Several messages from the same customer within 20 minutes update one card instead of creating many.

import { getMenu } from "./menu.mjs";
import { customerLines } from "./gifts.mjs";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// the same message reader the board uses, for when Claude is unavailable
const { parseOrder } = new Function(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "parser.js"), "utf8") + "\nreturn { parseOrder };")();

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

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
        for (const m of v.message_echoes || v.messages || []) {
          if (!m.to) continue;
          out.push({ id: m.id, from: m.to, name: "", type: m.type, dir: "out",
            text: String(msgText(m)).slice(0, 4000), ts: Number(m.timestamp) * 1000 || Date.now() });
        }
      }
    }
  }
  return out;
}

async function askClaude(apiKey, transcript, nowMs, previous, menu) {
  const MENU = menu.products.map(p => `${p.id} | ${p.name}${p.flavors.length ? " | حشوات: " + p.flavors.join("، ") : ""} | الأحجام: ` +
    p.variants.map(v => `«${v.tag}» ${v.price} ريال`).join("، ")).join("\n");
  const AREAS = menu.areas.map(a => a.name).join("، ");
  const riyadh = new Date(nowMs + 3 * 3600e3);
  const nowTxt = riyadh.toISOString().slice(0, 16).replace("T", " ") + " (" + ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"][riyadh.getUTCDay()] + ")";
  const system = `أنت تقرأ محادثة واتساب بين عميل ومطعم مينيقيش للمعجنات في الهفوف. المحل اعتمد الطلب للتو برسالة مثل «تم اعتماد طلبك» أو «تم تأكيد الطلب»، ومهمتك استخراج الطلب الذي اعتُمد.
السطور التي تبدأ بـ [العميل] كتبها العميل، والتي تبدأ بـ [المحل] ردود المطعم.
الوقت الآن في الرياض: ${nowTxt}. ساعات الطلب من 3:30 عصرًا حتى 12:30 بعد منتصف الليل، فأي ساعة بلا ص/م تعني مساءً، و12 تعني منتصف الليل.
المنيو (المعرّف | الاسم | الأحجام):
${MENU}
أحياء التوصيل: ${AREAS}
${previous ? `ملاحظة: هذا العميل عنده طلب معتمد سابقًا (#${previous.num}) أصنافه: ${previous.items.replace(/\n/g, "، ")}. إذا كانت الرسائل الجديدة تعدّل ذلك الطلب أو تضيف عليه فاجعل is_change=true واكتب في items الطلب كاملًا بعد التعديل.` : ""}
سجّل الطلب بأداة save_order.
قواعد:
- العملاء يكتبون بالعامية وعلى عدة رسائل، ويسألون قبل أن يطلبوا. استخرج ما استقر عليه العميل في النهاية: إذا غيّر رأيه فخذ الأخير.
- رسالة الاعتماد من [المحل] هي المرجع الأقوى: إذا كتب فيها ملخصًا للأصناف أو الوقت فخذ به.
- items: لكل صنف id و tag مطابقين حرفيًا لما في المنيو أعلاه، و qty عدد البوكسات، و flavor الحشوة إن ذُكرت (وإلا ""). إذا طلب حشوتين لنفس الصنف فاجعل كل حشوة عنصرًا مستقلًا.
- «نوتيلا» وحدها تعني دائمًا كباجي نوتيلا: 10 أو 20 حبة = kabajiNutella، و35 حبة = miniNutella. وإذا قال «ميني» فهي miniNutella.
- العدد قد يكون بالقطع: «10 بيتزا» = بيتزا بحجم «10 قطع» qty=1، و«20 فطاير» = فطائر مثلثة «20 قطعة» qty=1، و«40 فطاير» = «20 قطعة» qty=2.
- إذا تعذّرت مطابقة صنف مع المنيو فاكتبه في text مختصرًا (اسم الصنف وعدده فقط) بدل id.
- items أصناف فقط: لا تضع فيها كلام الدفع (شبكة، سحب، تحويل) ولا الحشوات الزائدة ولا الأسئلة؛ طلبات التحضير مثل «حمّرها زيادة» تذهب إلى note.
- area: اسم الحي مطابقًا حرفيًا لقائمة الأحياء إن أمكن، وإلا كما قاله العميل.
- day: عدد الأيام من اليوم إلى يوم التسليم: 0 اليوم، 1 بكرة أو غدًا، ولحجز يوم محدد (مثل «الجمعة» أو «٦ نوفمبر») احسب الأيام من تاريخ اليوم أعلاه. type=del إذا طلب توصيل أو ذكر حيًا للتوصيل، وpick إذا قال استلام أو يمر يأخذه، وunknown إن لم يتضح.
- note: ملاحظة التحضير والدفع باختصار (مثل: حمّرها زيادة · الدفع شبكة عند الاستلام).
- unclear: ما ينقص فعلًا لتجهيز الطلب في أقل من 10 كلمات، أو فارغ. لا تشرح افتراضاتك.
- لا تخترع شيئًا لم يُذكر.`;
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    // a forced tool call: the answer always comes back as structured fields, never as prose
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: [ORDER_TOOL], tool_choice: { type: "tool", name: "save_order" },
      messages: [{ role: "user", content: transcript }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("claude_http_" + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const call = (j.content || []).find(c => c.type === "tool_use" && c.name === "save_order");
  if (!call || !call.input || !Array.isArray(call.input.items)) throw new Error("claude_no_order " + JSON.stringify(j.content || []).slice(0, 160));
  return call.input;
}
const ORDER_TOOL = {
  name: "save_order",
  description: "يسجّل الطلب المعتمد في لوحة المطبخ.",
  input_schema: {
    type: "object",
    properties: {
      is_change: { type: "boolean" },
      name: { type: "string" },
      type: { type: "string", enum: ["del", "pick", "unknown"] },
      area: { type: "string" },
      day: { type: "integer", minimum: 0, maximum: 60 },
      time: { type: "string", description: "HH:MM بنظام 24 ساعة، أو asap، أو فارغ إن لم يُذكر" },
      items: { type: "array", items: { type: "object", properties: {
        id: { type: "string", description: "معرّف الصنف من المنيو" }, tag: { type: "string", description: "الحجم حرفيًا من المنيو" },
        qty: { type: "integer", minimum: 1 }, flavor: { type: "string" },
        text: { type: "string", description: "فقط لصنف لا يطابق المنيو" } } } },
      note: { type: "string" },
      unclear: { type: "string" },
    },
    required: ["is_change", "type", "time", "items", "note", "unclear"],
  },
};

// "As soon as possible" (or no time said): pickup in 30 minutes; delivery after preparation plus the drive,
// using the same numbers as the board (25 min prep, area minutes × time factor, 10 min for the courier).
function asapDue(p, nowMs, menu) {
  if (!p || p.type !== "del") return nowMs + 30 * 60e3;
  const norm = x => String(x || "").replace(/\s+/g, " ").trim();
  const a = menu && menu.areas.find(x => norm(x.name) === norm(p.area));
  const f = (menu && menu.rules && menu.rules.timeFactor) || 1.4;
  const drive = a && a.minutes != null ? Math.ceil(a.minutes * f) : 20;
  return nowMs + (25 + drive + 10) * 60e3;
}
function dueFromParsed(p, nowMs, menu) {
  if (!p || !p.time || p.time === "asap") return { due: asapDue(p, nowMs, menu), timeKnown: p?.time === "asap" };
  const mm = String(p.time).match(/^(\d{1,2}):(\d{2})$/);
  if (!mm) return { due: asapDue(p, nowMs, menu), timeKnown: false };
  const h = +mm[1], mi = +mm[2];
  const opDay = new Date(nowMs + 3 * 3600e3 - 6 * 3600e3);          // Riyadh operating day
  let ms = Date.UTC(opDay.getUTCFullYear(), opDay.getUTCMonth(), opDay.getUTCDate() + Math.max(0, Math.min(60, parseInt(p.day, 10) || 0)), h, mi) - 3 * 3600e3;
  if (h * 60 + mi < 6 * 60) ms += 864e5;
  return { due: ms, timeKnown: true };
}

// The owner's approval phrase. Only a message from the business containing it turns a chat into a kitchen order.
const APPROVAL = /تم\s*(ال)?([اأ]عتماد|تأكيد|تاكيد)\s*(ال)?طلب/;
const APPROVAL_WINDOW = 3 * 3600e3; // how far back a chat is read when it is approved
const SESSION_GAP = 90 * 60e3;      // a silence this long starts a new conversation

// Turn the reader's structured items into kitchen lines with prices from the live website menu,
// and add the delivery fee of the matched area.
const norm = t => String(t || "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
function priceOrder(p, menu) {
  const lines = []; const missing = []; let sum = 0, unknown = 0;
  for (const it of (Array.isArray(p.items) ? p.items : []).slice(0, 30)) {
    if (it && typeof it === "object" && it.id) {
      const prod = menu.products.find(x => x.id === it.id);
      const v = prod && (prod.variants.find(x => x.tag === it.tag) || prod.variants.find(x => norm(x.tag) === norm(it.tag)) || (prod.variants.length === 1 ? prod.variants[0] : null));
      const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
      const flavor = it.flavor ? ` (${String(it.flavor).slice(0, 30)})` : "";
      if (prod && v) { lines.push(`${qty} × ${prod.name} ${v.tag}${flavor} — ${v.price * qty} ريال`); sum += v.price * qty; continue; }
      if (prod) { lines.push(`${qty} × ${prod.name}${flavor} — ؟ (الحجم غير محدد)`); unknown++; missing.push("حجم " + prod.name); continue; }
    }
    const text = typeof it === "string" ? it : (it && (it.text || it.name)) || "";
    if (text) { lines.push(`؟ ${String(text).slice(0, 120)}`); unknown++; }
  }
  if (!lines.length) { lines.push("(راجع المحادثة)"); missing.push("الأصناف"); }
  else if (unknown && !missing.length) missing.push("صنف غير مطابق للمنيو");
  let fee = null, areaLabel = "";
  if (p.type === "del") {
    const a = menu.areas.find(x => norm(x.name) === norm(p.area)) || menu.areas.find(x => p.area && (norm(p.area).includes(norm(x.name)) || norm(x.name).includes(norm(p.area))));
    if (a) { fee = a.fee; areaLabel = `${a.name}${a.fee ? ` (توصيل ${a.fee} ر)` : " (توصيل مجاني)"}`; }
    else if (p.area) { areaLabel = String(p.area).slice(0, 80); missing.push("رسوم الحي"); }
    else missing.push("الحي");
  }
  return { items: lines.join("\n"), total: sum ? sum + (fee || 0) : null, fee, areaLabel, missing };
}

// Build the order from this customer's chat, triggered by the owner's approval message.
async function approveFromConversation(m, phone, ctx, apiKey) {
  const { pool, insertOrder, log } = ctx;
  const now = Date.now();
  // last order already approved for this customer (website or WhatsApp) that the kitchen has not finished
  const prev = (await pool.query(
    `SELECT id, num, items, source, ref, confirmed_at, status FROM orders
      WHERE wa_from=$1 AND status IN ('new','prep','ready','out') AND confirmed_at > $2 ORDER BY confirmed_at DESC LIMIT 1`,
    [m.from, now - APPROVAL_WINDOW])).rows[0];
  const since = prev ? Number(prev.confirmed_at) - 5000 : now - APPROVAL_WINDOW; // WhatsApp timestamps are whole seconds
  const all = (await pool.query(
    `SELECT id, dir, body, at FROM wa_messages WHERE wa_from=$1 AND at >= $2 AND at <= $3 AND body<>'' ORDER BY at ASC, id ASC LIMIT 200`,
    [m.from, since, m.ts + 1000])).rows;
  // keep only the latest conversation: start after the previous approval, after a website order message,
  // or after a silence longer than SESSION_GAP
  let start = 0;
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.id === m.id) continue;
    if (r.dir === "out" && APPROVAL.test(r.body)) start = i + 1;
    else if (r.dir !== "out" && /MG-[A-Z0-9]{4,8}/i.test(r.body)) start = i + 1;
    if (i > 0 && Number(r.at) - Number(all[i - 1].at) > SESSION_GAP) start = Math.max(start, i);
  }
  const rows = all.slice(start).filter(r => !/MG-[A-Z0-9]{4,8}/i.test(r.body));
  const customerRows = rows.filter(r => r.dir !== "out");
  if (prev && !customerRows.length) return `already_approved #${prev.num}`; // e.g. approving a website order that was confirmed by its MG number
  if (!customerRows.length) return "approval_without_customer_text";
  const transcript = rows.map(r => (r.dir === "out" ? "[المحل] " : "[العميل] ") + r.body).join("\n").slice(-7000);

  const menu = await getMenu();
  let p = null;
  if (apiKey) {
    for (let attempt = 1; attempt <= 2 && !p; attempt++) {
      try { p = await askClaude(apiKey, transcript, now, prev ? { num: prev.num, items: prev.items } : null, menu); }
      catch (e) { log(`wa: claude failed (try ${attempt}) ` + String(e.message || e).slice(0, 200)); }
    }
  }
  if (!p) {
    // no Claude: read time and type with the simple reader, keep the customer's words as the items
    let pr = {}; try { pr = parseOrder(customerRows.map(r => r.body).join("\n") + "\n" + m.text); } catch {}
    p = { type: pr.type || "unknown", area: pr.area, day: pr.day,
      time: pr.time ? `${String(pr.time.h).padStart(2, "0")}:${String(pr.time.m).padStart(2, "0")}` : (pr.asap ? "asap" : null),
      items: apiKey ? [{ text: "تعذّرت قراءة الأصناف — افتح المحادثة" }] : customerRows.map(r => ({ text: r.body })).slice(-6),
      unclear: apiKey ? "" : "راجع الأصناف في المحادثة" };
  }
  const built = priceOrder(p, menu);
  const matchedItems = (Array.isArray(p.items) ? p.items : []).filter(it => it && typeof it === "object" && it.id).length;
  if (prev && !matchedItems) {
    const extra = String(p.note || "").trim().slice(0, 160);
    if (!extra) return `nothing_new_for #${prev.num}`;
    await pool.query(`UPDATE orders SET note=TRIM(BOTH ' ·' FROM note || ' · واتساب: ' || $2), updated=$3 WHERE id=$1`, [prev.id, extra, Date.now()]);
    return `merged_note_into #${prev.num}`;
  }
  if (prev && prev.source === "web") {
    // the same items as the website order already approved: nothing new
    const norm2 = x => String(x).replace(/\s*—.*$/, "").replace(/\s+/g, " ").trim();
    const a = built.items.split("\n").map(norm2).sort().join("|"), b = String(prev.items).split("\n").map(norm2).sort().join("|");
    if (a === b) return `same_as_website_order #${prev.num}`;
  }
  const { due, timeKnown } = dueFromParsed(p, now, menu);
  const fields = {
    name: String(p.name || m.name || "").slice(0, 60), type: p.type === "del" ? "del" : "pick",
    area: built.areaLabel, items: built.items, total: built.total, deliveryFee: built.fee, due,
  };
  const missing = [...built.missing];
  if (!timeKnown) missing.push("الوقت");
  if (p.type !== "del" && p.type !== "pick") missing.push("استلام أو توصيل");
  const baseNote = [missing.length ? "⚠ ناقص: " + missing.join("، ") : "", p.note, p.unclear].filter(Boolean);

  // approved again before the kitchen finished: it is a change to that order, not a new one
  if (prev && p.is_change && ["new", "prep"].includes(prev.status) && prev.source === "wa") {
    const note = ["عُدّل بعد الاعتماد", ...baseNote].join(" · ").slice(0, 300);
    await pool.query(`UPDATE orders SET name=CASE WHEN $1<>'' THEN $1 ELSE name END,type=$2,area=$3,items=$4,total=$5,note=$6,due=$7,raw_text=$8,updated=$9,delivery_fee=$11 WHERE id=$10`,
      [fields.name, fields.type, fields.area, fields.items, fields.total, note, fields.due, transcript.slice(-3000), now, prev.id, fields.deliveryFee]);
    if (ctx.applyGift) await ctx.applyGift(pool, prev.id, customerLines(transcript)).catch(() => null);
    return `order_changed #${prev.num}`;
  }
  const note = [prev && p.is_change ? `تعديل على الطلب #${prev.num} وقد بدأ تجهيزه — راجعهما` : "", ...baseNote].filter(Boolean).join(" · ").slice(0, 300);
  const o = await insertOrder({ ref: null, source: "wa", status: "new", phone, ...fields, note,
    waFrom: m.from, rawText: transcript.slice(-3000), needsReview: false });
  if (ctx.applyGift) await ctx.applyGift(pool, o.id, customerLines(transcript)).catch(() => null);
  return `approved_order #${o.num}`;
}

// ctx: { pool, insertOrder, opDayOf, log }
export async function handleWebhook(body, ctx) {
  const { pool, log } = ctx;
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const msgs = extractMessages(body);
  const fields = (body?.entry || []).flatMap(e => (e.changes || []).map(c => c.field)).join(",");
  log(`wa: webhook received fields=${fields || "-"} messages=${msgs.length}`);
  for (const m of msgs) {
    if (!m.text && (m.type === "audio" || m.type === "voice")) m.text = "[رسالة صوتية]";
    // de-duplicate (providers retry)
    const ins = await pool.query("INSERT INTO wa_messages (id, wa_from, kind, body, at, dir) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id",
      [m.id, m.from, m.type, m.text, m.ts, m.dir]);
    if (!ins.rows.length) continue;
    const phone = localPhone(m.from);
    let result = "stored";
    try {
      if (m.dir === "out") {
        // the owner's reply from the WhatsApp Business app: the approval phrase turns the chat into a kitchen order
        log(`wa: owner reply len=${m.text.length} approval=${APPROVAL.test(m.text)}`);
        if (APPROVAL.test(m.text)) { result = await approveFromConversation(m, phone, ctx, apiKey); log("wa: " + result); }
        continue;
      }
      // a customer message carrying a website order number confirms that order
      const ref = (m.text.match(/MG-[A-Z0-9]{4,8}/i) || [])[0];
      if (ref) {
        const up = await pool.query(
          `UPDATE orders SET status=CASE WHEN status IN ('pending','dismissed') THEN 'new' ELSE status END,
             confirmed_at=COALESCE(confirmed_at,$2), phone=CASE WHEN phone='' THEN $3 ELSE phone END, wa_from=$4, updated=$2
           WHERE ref=$1 RETURNING num, status`, [ref.toUpperCase(), Date.now(), phone, m.from]);
        result = up.rows.length ? `confirmed ${ref} #${up.rows[0].num}` : `ref_not_found ${ref}`;
        if (up.rows.length) {
          const me = (await pool.query("SELECT id, num FROM orders WHERE ref=$1", [ref.toUpperCase()])).rows[0];
          const others = (await pool.query(
            `SELECT id, num, status, source FROM orders WHERE wa_from=$1 AND id<>$2 AND status IN ('new','prep','ready')
               AND confirmed_at > $3 ORDER BY confirmed_at DESC`, [m.from, me.id, Date.now() - 3 * 3600e3])).rows;
          for (const o of others) {
            if (o.status === "new" && o.source === "web") {
              await pool.query(`UPDATE orders SET status='cancelled', note=TRIM(BOTH ' ·' FROM note || ' · استُبدل بالطلب #' || $2), updated=$3 WHERE id=$1`, [o.id, me.num, Date.now()]);
              await pool.query(`UPDATE orders SET note=TRIM(BOTH ' ·' FROM note || ' · بديل للطلب #' || $2), updated=$3 WHERE id=$1`, [me.id, o.num, Date.now()]);
              result += ` replaced #${o.num}`;
            } else {
              await pool.query(`UPDATE orders SET note=TRIM(BOTH ' ·' FROM note || $2), updated=$3 WHERE id=$1`,
                [me.id, ` · ⚠ نفس العميل عنده طلب #${o.num} ${o.status === "new" ? "مؤكد" : "قيد التحضير"} — تأكد أنه ليس تكرارًا`, Date.now()]);
              result += ` flagged_dup_of #${o.num}`;
            }
          }
        }
        log(`wa: ${result}`);
      }
      // anything else from the customer is only stored until the owner approves
    } catch (e) {
      result = "error " + String(e.message || e).slice(0, 180);
      log(`wa: ${result}`);
    } finally {
      await pool.query("UPDATE wa_messages SET result=$1 WHERE id=$2", [result, m.id]).catch(() => {});
    }
  }
  return msgs.length;
}
export { askClaude };
