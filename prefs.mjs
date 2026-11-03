// Customer taste analysis: every night, read the previous day's orders and WhatsApp chats and record each
// request to change a product ("بدون ببروني", "بدل الزيتون جبن") and each objection that ended a chat without
// an order ("فيه ببروني؟ لا خلاص"). The report then shows, per product and ingredient, how many different
// customers asked, so one customer's taste is told apart from what most customers want.
import { getMenu } from "./menu.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const opDayOf = ms => new Date(ms + 3 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);

export async function migratePrefs(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS taste_signals (
      id BIGSERIAL PRIMARY KEY, op_day DATE NOT NULL, kind TEXT NOT NULL,       -- 'change' on an order, 'lost' chat without an order
      order_id BIGINT, customer TEXT NOT NULL, product_id TEXT, product TEXT,
      ingredient TEXT, change TEXT, with_text TEXT, quote TEXT, at BIGINT NOT NULL)`);
  await pool.query("CREATE INDEX IF NOT EXISTS taste_signals_day ON taste_signals (op_day)");
  await pool.query("CREATE TABLE IF NOT EXISTS taste_runs (op_day DATE PRIMARY KEY, at BIGINT NOT NULL, orders INT, signals INT)");
}

const TOOL = {
  name: "save_signals",
  description: "يسجّل طلبات العملاء لتعديل الأصناف واعتراضاتهم.",
  input_schema: {
    type: "object",
    properties: {
      changes: { type: "array", items: { type: "object", properties: {
        order_id: { type: "string" }, product_id: { type: "string", description: "معرّف الصنف من المنيو، أو فارغ إن كان عامًا" },
        ingredient: { type: "string", description: "المكوّن بصيغة موحّدة قصيرة، مثل: ببروني، زيتون، فلفل حار، بصل" },
        change: { type: "string", enum: ["remove", "replace", "extra", "less", "add", "other"] },
        with: { type: "string", description: "البديل إن طلب تبديلًا، وإلا فارغ" },
        quote: { type: "string", description: "كلام العميل حرفيًا باختصار" } },
        required: ["order_id", "ingredient", "change", "quote"] } },
      lost: { type: "array", items: { type: "object", properties: {
        customer: { type: "string" }, product_id: { type: "string" }, ingredient: { type: "string" },
        reason: { type: "string", description: "سبب عدم الطلب باختصار، مثل: لا يريد الببروني، السعر، الوقت غير متاح" },
        quote: { type: "string" } }, required: ["customer", "reason", "quote"] } },
    },
    required: ["changes", "lost"],
  },
};

async function askClaude(apiKey, payload, menu, knownIngredients) {
  const MENU = menu.products.map(p => `${p.id} | ${p.name}${p.description ? " | " + p.description : ""}`).join("\n");
  const system = `أنت محلل طلبات لمطعم مينيقيش للمعجنات. أمامك طلبات يوم واحد ومحادثات واتساب لم تنتهِ بطلب.
المنيو (المعرّف | الاسم | الوصف):
${MENU}
المطلوب:
1) changes: كل طلب من العميل لتعديل مكوّن في صنف: حذف (remove) مثل «بدون ببروني»، تبديل (replace) مثل «بدل الزيتون جبن»، زيادة (extra)، تقليل (less)، إضافة (add). سطر لكل مكوّن ولكل صنف.
   الملاحظات التي لا تخص المكوّنات (الوقت، الدفع، الموقع، «حمّرها زيادة»، «سخّنها») ليست تعديلات مكوّنات؛ تجاهلها إلا التحمير فسجّله change=other و ingredient=التحمير.
2) lost: محادثات سأل فيها العميل ولم يطلب، وسبب واضح لعدم الطلب (مكوّن لا يريده، السعر، الوقت، الحي). إن لم يتضح سبب فلا تسجّلها.
وحّد أسماء المكوّنات${knownIngredients.length ? "، واستخدم هذه الأسماء إن طابقت: " + knownIngredients.join("، ") : ""}.
لا تخترع شيئًا لم يقله العميل. سجّل النتيجة بأداة save_signals.`;
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, tools: [TOOL], tool_choice: { type: "tool", name: "save_signals" },
      messages: [{ role: "user", content: payload }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error("claude_http_" + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const call = (j.content || []).find(c => c.type === "tool_use");
  if (!call) throw new Error("claude_no_signals");
  return call.input;
}

const customerOnly = t => String(t || "").split("\n").filter(l => !l.startsWith("[المحل]")).join("\n");

// Analyse one operating day (idempotent: a day is done once).
export async function analyseDay(pool, day, log = console.log) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "no_key";
  const done = await pool.query("SELECT 1 FROM taste_runs WHERE op_day=$1", [day]);
  if (done.rows.length) return "done_before";
  const menu = await getMenu();
  const { rows: orders } = await pool.query(
    "SELECT id, num, source, items, note, raw_text, phone, wa_from FROM orders WHERE op_day=$1 AND status NOT IN ('cancelled','dismissed')", [day]);
  // chats of that day from numbers that placed no order that day
  const start = Date.parse(day + "T06:00:00+03:00"), end = start + 864e5;
  const { rows: chats } = await pool.query(
    `SELECT wa_from, string_agg(body, ' ⏎ ' ORDER BY at) AS text FROM wa_messages
       WHERE at >= $1 AND at < $2 AND dir = 'in' AND body <> '' AND wa_from NOT IN (SELECT wa_from FROM orders WHERE op_day=$3 AND wa_from IS NOT NULL)
       GROUP BY wa_from`, [start, end, day]);
  const lines = [];
  for (const o of orders) {
    const said = [o.note, customerOnly(o.raw_text).slice(-1500)].filter(Boolean).join(" ⏎ ");
    lines.push(`[طلب ${o.id}] (${o.source}) الأصناف: ${String(o.items || "").replace(/\n/g, "، ")}${said ? "\nكلام العميل والملاحظة: " + said : ""}`);
  }
  for (const c of chats) lines.push(`[محادثة بلا طلب ${c.wa_from}] ${String(c.text).slice(0, 1500)}`);
  if (!lines.length) {
    await pool.query("INSERT INTO taste_runs (op_day, at, orders, signals) VALUES ($1,$2,0,0) ON CONFLICT DO NOTHING", [day, Date.now()]);
    return "empty";
  }
  const known = (await pool.query("SELECT DISTINCT ingredient FROM taste_signals WHERE ingredient IS NOT NULL LIMIT 60")).rows.map(r => r.ingredient);
  const out = await askClaude(apiKey, lines.join("\n\n").slice(0, 60000), menu, known);
  const byId = new Map(orders.map(o => [String(o.id), o]));
  const pname = id => (menu.products.find(p => p.id === id) || {}).name || null;
  let n = 0; const now = Date.now();
  for (const c of out.changes || []) {
    const o = byId.get(String(c.order_id)); if (!o || !c.ingredient) continue;
    const customer = o.wa_from || String(o.phone || "").replace(/\D/g, "").replace(/^0/, "966") || "order:" + o.id;
    await pool.query(`INSERT INTO taste_signals (op_day,kind,order_id,customer,product_id,product,ingredient,change,with_text,quote,at)
      VALUES ($1,'change',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [day, o.id, customer, c.product_id || null, pname(c.product_id), String(c.ingredient).slice(0, 40), c.change, String(c.with || "").slice(0, 40) || null, String(c.quote || "").slice(0, 200), now]);
    n++;
  }
  for (const l of out.lost || []) {
    if (!l.customer || !l.reason) continue;
    await pool.query(`INSERT INTO taste_signals (op_day,kind,customer,product_id,product,ingredient,change,quote,at)
      VALUES ($1,'lost',$2,$3,$4,$5,$6,$7,$8)`,
      [day, String(l.customer).slice(0, 30), l.product_id || null, pname(l.product_id), l.ingredient ? String(l.ingredient).slice(0, 40) : null, String(l.reason).slice(0, 80), String(l.quote || "").slice(0, 200), now]);
    n++;
  }
  await pool.query("INSERT INTO taste_runs (op_day, at, orders, signals) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [day, now, orders.length, n]);
  log(`taste: day=${day} orders=${orders.length} chats=${chats.length} signals=${n}`);
  return "ok";
}

// Every hour: analyse each finished day not done yet (a day is finished once the next one has started at 06:00).
export function startTasteJob(pool, log = console.log) {
  const tick = async () => {
    try {
      const today = opDayOf(Date.now());
      const { rows } = await pool.query(
        `SELECT DISTINCT op_day::text AS d FROM orders WHERE op_day < $1 AND op_day NOT IN (SELECT op_day FROM taste_runs) ORDER BY 1 LIMIT 5`, [today]);
      for (const r of rows) await analyseDay(pool, r.d, log).catch(e => log("taste: " + r.d + " " + e.message));
    } catch (e) { log("taste: " + e.message); }
  };
  setTimeout(tick, 60e3);
  setInterval(tick, 3600e3);
}

// Report over the last N days: for each product and ingredient, how many orders and how many different customers asked,
// against how many orders contained that product. Also the reasons chats ended without an order.
export async function tasteReport(pool, days = 15) {
  const from = new Date(Date.parse(opDayOf(Date.now())) - days * 864e5).toISOString().slice(0, 10);
  const changes = (await pool.query(
    `SELECT COALESCE(product,'(عام)') AS product, product_id, ingredient, change, count(*)::int AS requests, count(DISTINCT customer)::int AS customers,
            (array_agg(quote ORDER BY at DESC))[1:3] AS examples
       FROM taste_signals WHERE kind='change' AND op_day >= $1 GROUP BY 1,2,3,4 ORDER BY customers DESC, requests DESC`, [from])).rows;
  const menu = await getMenu();
  const orders = (await pool.query("SELECT items, COALESCE(wa_from, phone, id::text) AS c FROM orders WHERE op_day >= $1 AND status NOT IN ('cancelled','dismissed')", [from])).rows;
  for (const r of changes) {
    const p = menu.products.find(x => x.id === r.product_id);
    const withP = p ? orders.filter(o => String(o.items || "").includes(p.name)) : [];
    r.product_orders = withP.length;
    r.product_customers = new Set(withP.map(o => o.c)).size;
  }
  const lost = (await pool.query(
    `SELECT COALESCE(product,'(عام)') AS product, ingredient, change AS reason, count(DISTINCT customer)::int AS customers, (array_agg(quote ORDER BY at DESC))[1:3] AS examples
       FROM taste_signals WHERE kind='lost' AND op_day >= $1 GROUP BY 1,2,3 ORDER BY customers DESC`, [from])).rows;
  const runs = (await pool.query("SELECT count(*)::int AS days, COALESCE(sum(orders),0)::int AS orders FROM taste_runs WHERE op_day >= $1", [from])).rows[0];
  return { from, days, analysedDays: runs.days, orders: runs.orders, changes, lost };
}
