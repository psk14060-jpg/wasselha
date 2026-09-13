import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const restaurant = randomBytes(18).toString('base64url');
const courier = randomBytes(18).toString('base64url');
try {
  writeFileSync(new URL('../.env', import.meta.url), `HOST=127.0.0.1\nPORT=3000\nDATABASE_PATH=./data/wasselha.sqlite\nRESTAURANT_PASSWORD=${restaurant}\nCOURIER_PASSWORD=${courier}\nCOOKIE_SECURE=false\n`, { flag: 'wx', mode: 0o600 });
  console.log('تم إعداد كلمات مرور محلية مختلفة للمطعم والمندوب. تجدها في ملف .env. ابدأ التشغيل باستخدام npm start.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('ملف الإعداد موجود؛ لم يتم تغييره.');
  else throw error;
}
