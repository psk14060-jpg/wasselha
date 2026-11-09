// «فواتير المشتريات» — runs as the Drive owner's Google account, every night at ~02:15 Riyadh.
// Pulls the purchase photos the kitchen board received on WhatsApp, saves each into
// «فواتير المشتريات/YYYY-MM/» and tells the board the link (the board then adds the row to the shared sheet).
// No shared secret: the board checks this account's Google identity token.
const BOARD = "https://minigeesh-orders.onrender.com";
const ROOT = "1MTDswrTU23t1vSX8vhUoNBZXoqXWH6EA";

function run() {
  const auth = { Authorization: "Bearer " + ScriptApp.getIdentityToken() };
  const root = DriveApp.getFolderById(ROOT);
  let saved = 0;
  for (let round = 0; round < 10; round++) {
    const r = UrlFetchApp.fetch(BOARD + "/api/purchases/pending", { headers: auth, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error("pending " + r.getResponseCode() + " " + r.getContentText().slice(0, 200));
    const items = JSON.parse(r.getContentText()).items || [];
    if (!items.length) break;
    for (const it of items) {
      const sub = root.getFoldersByName(it.folder);
      const folder = sub.hasNext() ? sub.next() : root.createFolder(it.folder);
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(it.b64), it.mime, it.name));
      UrlFetchApp.fetch(BOARD + "/api/purchases/saved", {
        method: "post", contentType: "application/json", headers: auth, muteHttpExceptions: true,
        payload: JSON.stringify({ id: it.id, link: file.getUrl(), name: it.name }),
      });
      saved++;
    }
  }
  console.log("saved " + saved);
}

// run once by hand: (re)creates the nightly trigger
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("run").timeBased().everyDays(1).atHour(2).nearMinute(15).inTimezone("Asia/Riyadh").create();
}
