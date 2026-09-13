import { writeFileSync } from 'node:fs';
try {
  writeFileSync(new URL('../.env', import.meta.url), `HOST=127.0.0.1\nPORT=3000\nDATABASE_PATH=./data/wasselha.sqlite\nCOOKIE_SECURE=false\n`, { flag: 'wx', mode: 0o600 });
  console.log('تم إنشاء ملف .env محليًا. لا حاجة لكلمات مرور مسبقة — كل مطعم ومندوب يسجّل حسابه الخاص من الواجهة. ابدأ التشغيل باستخدام npm start.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('ملف الإعداد موجود؛ لم يتم تغييره.');
  else throw error;
}
