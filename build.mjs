// Builds public/*.html from src templates (shared board styles + message reader)
import fs from "node:fs";
const style = fs.readFileSync("src/board.style.css", "utf8");
const parser = fs.readFileSync("src/parser.js", "utf8");
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/board.html",
  fs.readFileSync("src/board.template.html", "utf8").replace("{{STYLE}}", () => style).replace("{{PARSER}}", () => parser));
fs.copyFileSync("src/login.template.html", "public/login.html");
console.log("built public/board.html, public/login.html");
