/* ===== PARSER START ===== */
function normDigits(s){
  return String(s||"").replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g,d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/٫/g,".").replace(/‏|‎/g,"");
}
function parseClock(s){
  s=normDigits(s);
  if(/أقرب|اسرع|أسرع|الحين|حالا|حالًا|الآن|الان|فور/.test(s)) return {asap:true};
  const m=s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(صباح[اًا]?|مساء[ًا]?|ليل[اًا]?|عصر[اًا]?|ظهر[اًا]?|pm|am|ص|م)?/i);
  if(!m) return null;
  let h=+m[1], mi=+(m[2]||0); const mk=(m[3]||"").toLowerCase();
  if(h>23||mi>59) return null;
  if(!m[2] && !mk && !/الساعة|ساعة/.test(s)) return null;
  if(h<=12){
    if(/^(ص|صباح|am)/.test(mk)){ if(h===12) h=0; }
    else if(/^(م|مساء|pm|عصر|ظهر)/.test(mk)){ if(h<12) h+=12; }
    else if(/^ليل/.test(mk)){ if(h===12) h=0; else if(h>=6) h+=12; }
    else { if(h===12) h=0; else h+=12; } /* بدون علامة: ساعات العمل مسائية، و12 تعني منتصف الليل */
  }
  return {h,m:mi};
}
function parseOrder(text){
  const t=normDigits(text);
  const lines=t.split(/\r?\n+/).map(l=>l.replace(/[*_~`]/g,"").replace(/^[\s\-–•▪️◾️▫️·*]+/,"").trim()).filter(Boolean);
  const r={items:[]};
  const val=l=>{const i=l.search(/[:：]/);return i<0?"":l.slice(i+1).trim();};
  const skip=/(أقرب توصيل|أجر المندوب|مدة التجهيز|المسافة|أرجو|الإجمالي|الاجمالي|المجموع|المطلوب|رسوم|سعر التوصيل|خصم|ضريبة|شكر|مرحب|السلام|طلب جديد|رقم الطلب|https?:\/\/|wa\.me|maps)/;
  let typeHint=null;
  for(const l of lines){
    const key=l.split(/[:：]/)[0];
    if(/^(الاسم|اسم العميل|العميل|الاسم الكريم)/.test(key)){ r.name=val(l); continue; }
    if(/رقم الطلب/.test(key)){ const mm=l.match(/MG-[A-Z0-9]{4,8}/i); if(mm) r.ref=mm[0].toUpperCase(); continue; }
    if(/(الجوال|الهاتف|رقم الجوال|رقم التواصل|التواصل)/.test(key) && val(l)){ continue; }
    if(/^(الحي|العنوان|الموقع|المنطقة|عنوان التوصيل)/.test(key) && val(l) && !/https?:/.test(val(l))){ r.area=val(l); continue; }
    if(/(نوع الطلب|طريقة الاستلام|طريقة الطلب|الاستلام\s*\/\s*التوصيل|التوصيل\s*\/\s*الاستلام|^النوع)/.test(key)){
      const v=val(l); if(/توصيل/.test(v)) typeHint="del"; else if(/استلام|المحل|الفرع/.test(v)) typeHint="pick"; continue; }
    if(/^(اليوم|التاريخ|يوم الاستلام|يوم التوصيل)/.test(key)){
      const v=val(l); if(/غد|بكر/.test(v)) r.day=1; else if(/اليوم/.test(v)) r.day=0;
      else{const dm=v.match(/\b(\d{1,2})\b/);if(dm){const base=new Date(Date.now()-6*3600e3);const tom=new Date(base);tom.setDate(base.getDate()+1);
        if(+dm[1]===base.getDate())r.day=0;else if(+dm[1]===tom.getDate())r.day=1;}}
      continue; }
    if(/(الوقت|وقت|الساعة|موعد)/.test(key) && val(l)){
      const c=parseClock(val(l)); if(c){ if(c.asap) r.asap=true; else r.time=c; } continue; }
    if(/ملاحظ/.test(key)){ r.note=val(l); continue; }
    if(/(الإجمالي|الاجمالي|المجموع|المطلوب|الإجمالي الكلي)/.test(l) && !/قبل/.test(l)){
      const nums=l.match(/\d+(?:\.\d+)?/g); if(nums) r.total=+nums[nums.length-1]; continue; }
    if(skip.test(l)) continue;
    if(/\d/.test(l) || /×|x\s*\d|\d\s*x/i.test(l)){
      let it=l.replace(/\s{2,}/g," ");
      if(it.length<=80) r.items.push(it);
    }
  }
  const ph=t.replace(/[\s\-()]/g,"").match(/(?:\+?966|00966|0)?5\d{8}/);
  if(ph){ r.phone=ph[0].replace(/^(\+?966|00966)/,"0"); if(!/^0/.test(r.phone)) r.phone="0"+r.phone; }
  r.items=r.items.filter(it=>!(r.phone && it.replace(/[\s\-]/g,"").includes(r.phone.slice(1))));
  if(typeHint) r.type=typeHint;
  else if(/استلام|من المحل|من الفرع/.test(t) && !/توصيل\s*[:：]?\s*(نعم|مطلوب)/.test(t)) r.type=/عنوان|الحي/.test(t)?"del":"pick";
  else if(/توصيل/.test(t)) r.type="del";
  if(r.day==null && /بكرة|بكره|غدًا|غدا|الغد/.test(t)) r.day=1;
  if(!r.time && !r.asap){ const m=t.match(/\d{1,2}:\d{2}\s*(?:ص|م|صباحًا|مساءً|صباحا|مساء|pm|am)?/i); if(m){const c=parseClock(m[0]); if(c&&!c.asap) r.time=c;} }
  /* free text: "الساعة 9" / "الساعه ٩ ونص" / "على 10 مساء" */
  if(!r.time && !r.asap){
    const m=t.match(/(?:الساعة|الساعه|ساعة|ساعه|على)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(ونص|و نص|والنص|وربع|و ربع|الا ربع|إلا ربع)?\s*(صباح[اًا]?|مساء[ًا]?|ليل[اًا]?|عصر[اًا]?|ص|م)?/);
    if(m){ const c=parseClock(m[1]+":"+(m[2]||"00")+" "+(m[4]||""));
      if(c&&!c.asap){ let mins=c.h*60+c.m; if(/نص/.test(m[3]||""))mins+=30; else if(/ا ربع|إلا ربع|الا ربع/.test(m[3]||""))mins-=15; else if(/ربع/.test(m[3]||""))mins+=15;
        mins=(mins+1440)%1440; r.time={h:Math.floor(mins/60),m:mins%60}; } }
  }
  if(!r.time && !r.asap && /(الحين|حالا|حالًا|أقرب وقت|اقرب وقت|الآن|الان)/.test(t)) r.asap=true;
  return r;
}
/* ===== PARSER END ===== */