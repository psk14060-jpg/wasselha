// Builds public/*.html from src templates (shared board styles + message reader)
import fs from "node:fs";
const style = fs.readFileSync("src/board.style.css", "utf8");
const parser = fs.readFileSync("src/parser.js", "utf8");
const subsidy = fs.readFileSync("subsidy.mjs", "utf8").replace(/^export /gm, "");
const capacity = fs.readFileSync("capacity.mjs", "utf8").replace(/^export /gm, ""); // «أقرب وقت»: one order every 10 minutes // same rule on the board and the server
const itemlines = fs.readFileSync("itemlines.mjs", "utf8").replace(/^export /gm, "");
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/board.html",
  fs.readFileSync("src/board.template.html", "utf8").replace("{{STYLE}}", () => style).replace("{{PARSER}}", () => parser).replace("{{SUBSIDY}}", () => subsidy).replace("{{CAPACITY}}", () => capacity).replace("{{ITEMLINES}}", () => itemlines));
fs.copyFileSync("src/login.template.html", "public/login.html");
console.log("built public/board.html, public/login.html");
