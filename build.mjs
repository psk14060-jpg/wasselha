// Builds public/*.html from src templates (shared board styles + message reader)
import fs from "node:fs";
const style = fs.readFileSync("src/board.style.css", "utf8");
const parser = fs.readFileSync("src/parser.js", "utf8");
const subsidy = fs.readFileSync("subsidy.mjs", "utf8").replace(/^export /gm, "");
const capacity = fs.readFileSync("capacity.mjs", "utf8").replace(/^export /gm, ""); // «أقرب وقت»: one order every 10 minutes // same rule on the board and the server
const itemlines = fs.readFileSync("itemlines.mjs", "utf8").replace(/^export /gm, "");
const logo = "data:image/jpeg;base64," + fs.readFileSync("src/brand/logo.jpg").toString("base64"); // Hassan 2026-11-17: «استخدم شعاري mini في كل الصفحات»
const withLogo = t => t.replaceAll("{{LOGO}}", logo);
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/board.html",
  withLogo(fs.readFileSync("src/board.template.html", "utf8")).replace("{{STYLE}}", () => style).replace("{{PARSER}}", () => parser).replace("{{SUBSIDY}}", () => subsidy).replace("{{CAPACITY}}", () => capacity).replace("{{ITEMLINES}}", () => itemlines));
fs.writeFileSync("public/login.html", withLogo(fs.readFileSync("src/login.template.html", "utf8")));
fs.writeFileSync("public/tv.html", withLogo(fs.readFileSync("src/tv.template.html", "utf8")));
fs.writeFileSync("public/admin.html", withLogo(fs.readFileSync("src/admin.template.html", "utf8")));
fs.writeFileSync("public/kiosk.html", withLogo(fs.readFileSync("src/kiosk.template.html", "utf8"))); // «شاشة العميل» (Hassan 2026-11-26)
fs.writeFileSync("public/supplies.html", withLogo(fs.readFileSync("src/supplies.template.html", "utf8"))); // «المشتريات» (Hassan 2026-11-26)
console.log("built public/board.html, public/login.html");
