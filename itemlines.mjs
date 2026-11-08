// Items text typed or edited on the board (shared by the server and the board page: plain JavaScript, no imports).
// - A line that does not start with «N ×» continues the line above (an Enter inside #35 of 2026-11-07 split its price off).
// - A price written loosely at the end of a line («٦٩ ريال», «- 69 ر», «69ر») becomes «— 69 ريال», the one form the board,
//   the reports and the shared sheet read. #21 of 2026-11-08: a family box added at 69 SAR did not move the total.
const ilLatin = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/٫/g, ".");
const IL_PRICE = /\s*[—–\-:=]?\s*(\d+(?:\.\d+)?)\s*(?:ريال|ر\.?\s*س|ر|sar)\.?\s*$/i;

export function normItemLines(t) {
  const lines = String(t || "").split("\n").reduce((a, l) => {
    const x = l.trim(); if (!x) return a;
    if (!a.length || /^\s*[\d٠-٩۰-۹]+\s*[×xX*]/.test(x)) a.push(x); else a[a.length - 1] += " " + x;
    return a;
  }, []);
  return lines.map(l => {
    let x = l.replace(/^\s*([\d٠-٩۰-۹]+)\s*[×xX*]\s*/, (m, q) => ilLatin(q) + " × ");
    const m = ilLatin(x).match(IL_PRICE);
    if (m) x = ilLatin(x).slice(0, m.index).trim() + " — " + m[1] + " ريال";
    return x;
  }).join("\n");
}
// sum of the line prices («— 35 ريال»), after the same cleaning
export const linesSum = t => normItemLines(t).split("\n").reduce((s, l) => { const m = l.match(/—\s*([\d.]+)\s*ريال/); return s + (m ? +m[1] : 0); }, 0);
// lines with no price (to warn the shop the total did not move for them)
export const unpricedLines = t => normItemLines(t).split("\n").filter(l => l && !/—\s*[\d.]+\s*ريال/.test(l));
