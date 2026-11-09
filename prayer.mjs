// Prayer times in Al-Hofuf (Umm al-Qura method: Fajr 18.5°, Asr one shadow, Isha = Maghrib + 90 min, + 120 in Ramadan not handled).
// Customers give times like «بعد صلاة العشاء» (#21 of 2026-11-09 said «7:30 بعد العشاء» while Isha in Al-Ahsa was 6:26).
const LAT = 25.3836, LNG = 49.5864, TZ = 3;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function sun(dayMs) {
  const jd = dayMs / 864e5 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360, g = rad((357.528 + 0.9856003 * n) % 360);
  const lam = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)), eps = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = deg(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam))) / 15;
  let eot = L / 15 - ((ra + 24) % 24); eot = ((eot + 12) % 24 + 24) % 24 - 12; // hours
  return { dec, eot };
}
const arc = (alt, dec) => deg(Math.acos((Math.sin(rad(alt)) - Math.sin(rad(LAT)) * Math.sin(dec)) / (Math.cos(rad(LAT)) * Math.cos(dec)))) / 15;
// dayStr "YYYY-MM-DD" (local date) → {fajr,dhuhr,asr,maghrib,isha} as epoch ms
export function prayerTimes(dayStr) {
  const mid = Date.parse(dayStr + "T00:00:00Z") - TZ * 3600e3; // local midnight
  const { dec, eot } = sun(mid + 12 * 3600e3);
  const noon = 12 + TZ - LNG / 15 - eot; // local hours
  const asrAlt = deg(Math.atan(1 / (1 + Math.tan(Math.abs(rad(LAT) - dec)))));
  const h = { fajr: noon - arc(-18.5, dec), dhuhr: noon + 2 / 60, asr: noon + arc(asrAlt, dec), maghrib: noon + arc(-0.833, dec) };
  h.isha = h.maghrib + 1.5;
  const out = {}; for (const [k, v] of Object.entries(h)) out[k] = Math.round((mid + v * 3600e3) / 60e3) * 60e3;
  return out;
}
const hm = ms => { const d = new Date(ms + TZ * 3600e3); let H = d.getUTCHours(); const M = String(d.getUTCMinutes()).padStart(2, "0"); return `${H > 12 ? H - 12 : H}:${M}`; };
export function prayerLine(nowMs) {
  const day = new Date(nowMs + TZ * 3600e3 - 3 * 3600e3).toISOString().slice(0, 10); // operating day (until 3 am)
  const t = prayerTimes(day);
  return `أوقات الصلاة اليوم في الأحساء: الفجر ${hm(t.fajr)} ص، الظهر ${hm(t.dhuhr)}، العصر ${hm(t.asr)}، المغرب ${hm(t.maghrib)}، العشاء ${hm(t.isha)} م.`;
}
