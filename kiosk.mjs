// «شاشة العميل» (Hassan 2026-11-26): the customer screen in the shop shows the live website menu; the customer builds the
// order and presses «اعتمد الطلب». It lands on the board as an «المحل» pickup, waiting for the cashier to take the money
// (status pending) — nothing is cooked before it is paid. Prices always come from the menu on the server, never the page.

// pure (tested): the page sends [{id, tag, qty, flavor}]; returns the board's item lines and the total, or an error
export function priceKiosk(menu, lines) {
  const out = []; let total = 0;
  for (const l of Array.isArray(lines) ? lines.slice(0, 30) : []) {
    const p = (menu.products || []).find(x => x.id === l.id);
    const v = p && (p.variants || []).find(x => x.tag === l.tag);
    const qty = Math.max(1, Math.min(20, parseInt(l.qty, 10) || 1));
    if (!p || !v || !(Number(v.price) > 0)) return { error: "صنف غير موجود في المنيو" };
    const flavor = (p.flavors || []).includes(l.flavor) ? l.flavor : "";
    const amount = Math.round(Number(v.price) * qty * 100) / 100;
    out.push(`${qty} × ${p.name} ${v.tag}${flavor ? " (" + flavor + ")" : ""} — ${amount} ريال`);
    total += amount;
  }
  if (!out.length) return { error: "السلة فاضية" };
  return { items: out.join("\n"), total: Math.round(total * 100) / 100 };
}
