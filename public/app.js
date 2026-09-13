const main=document.querySelector('#main');
const S={role:'customer',session:null,restaurants:null,catalog:null,products:[],billing:null,orders:[],restaurantSlug:null,cart:new Map(),page:'shop',busy:false,generation:0,rendered:''};
const pending=new Map();
const labels={awaiting_courier:'بانتظار المندوب',reserved:'بانتظار تأكيد العميل',confirmed:'مؤكد · للمطبخ',preparing:'قيد التجهيز',ready:'جاهز للاستلام',out_for_delivery:'في الطريق',delivered:'تم التسليم · تسوية مفتوحة',closed:'مكتمل',cancelled:'ملغى',expired:'انتهت المهلة',delivery_failed:'متعثر'};
const payLabels={pending:'لم يُحصّل بعد',collected:'نقد في عهدة المندوب',settled:'تمت التسوية',failed:'تعذر التحصيل'};
const closed=['closed','cancelled','expired'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price=v=>new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(v/100)+' ر.س';
const time=v=>new Intl.DateTimeFormat('ar-SA',{hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(v));
const total=()=>[...S.cart].reduce((n,[id,q])=>n+(S.catalog?.products.find(p=>p.id===id)?.price??0)*q,0);
function toast(message,error=false){const el=document.querySelector('#toast');el.textContent=message;el.className=error?'error':'';el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.hidden=true,6000);}
async function api(path,{body,role=S.role,csrf=S.session?.csrf,method}={}) {
  const verb=method??(body!==undefined?'POST':'GET');
  const headers={'X-Wasselha-Role':role};const options={headers,method:verb,signal:AbortSignal.timeout(12000)};
  const signature=role+path+JSON.stringify(body);
  if(verb!=='GET') headers['X-CSRF-Token']=csrf??'';
  if(body!==undefined){if(!pending.has(signature))pending.set(signature,crypto.randomUUID());Object.assign(headers,{'Content-Type':'application/json','Idempotency-Key':pending.get(signature)});options.body=JSON.stringify(body);}
  let response;
  try{response=await fetch('/api'+path,options);}catch{throw new Error('تعذر الاتصال. أعد المحاولة؛ سيستخدم الطلب نفس معرّف العملية لتجنب التكرار.');}
  const data=await response.json();
  if(!response.ok)throw new Error(data.error??'تعذر إكمال العملية.');
  if(body!==undefined)pending.delete(signature);
  return data;
}
function intro(title,description,extra=''){return `<div class="intro"><div><h1>${title}</h1><p>${description}</p></div>${extra}</div>`;}
function empty(title,text){return `<div class="empty"><strong>${title}</strong><p>${text}</p></div>`;}
function button(action,id,text,kind=''){return `<button class="button ${kind}" data-action="${action}" data-id="${esc(id)}">${text}</button>`;}
function renderDirectory(){
  return intro('المطاعم على وصلها','اختر مطعمًا لتصفّح منيوه وتطلب توصيله.')+
  (S.restaurants.length?`<div class="products">${S.restaurants.map(r=>`<article class="product"><div class="product-icon" aria-hidden="true">◇</div><h3>${esc(r.name)}</h3><p class="muted">${esc(r.city)}</p><div class="product-bottom"><span class="tag">${r.accepting?'يستقبل الطلبات':'متوقف مؤقتًا'}</span><a class="button" href="#shop/${encodeURIComponent(r.slug)}">عرض المنيو ←</a></div></article>`).join('')}</div>`:empty('لا توجد مطاعم منضمة بعد','كن أول مطعم ينضم للمنصة.'))+
  `<p class="note">عندك مطعم؟ <a href="#restaurant/signup">سجّله على وصلها</a>. عندك دراجة أو سيارة وتحب التوصيل؟ <a href="#courier/signup">سجّل كمندوب مستقل</a>.</p>`;
}
function renderShop(){
  const r=S.catalog.restaurant;
  return intro(esc(r.name),`${esc(r.city)} · تجهيز تقديري ${r.prep} دقيقة · الدفع عند الاستلام`,`<span class="tag">${r.accepting?'يستقبل الطلبات':'متوقف مؤقتًا'}</span>`)+
  `<p class="muted"><a href="#shop">← كل المطاعم</a></p>
  <div class="layout"><section><h2 class="section-title">وش تحب تطلب؟</h2><div class="products">${S.catalog.products.length?S.catalog.products.map((p,i)=>`<article class="product"><div class="product-icon" aria-hidden="true">${['◈','◈','◇','▱'][i%4]}</div><h3>${esc(p.name)}</h3><p class="muted">${esc(p.description)}</p><div class="product-bottom"><span class="price">${price(p.price)}</span><div class="counter"><button data-cart="${p.id}" data-delta="1" aria-label="إضافة ${esc(p.name)}">+</button><span aria-live="polite">${S.cart.get(p.id)??0}</span><button data-cart="${p.id}" data-delta="-1" aria-label="إنقاص ${esc(p.name)}">−</button></div></div></article>`).join(''):empty('المنيو فارغ حاليًا','لم يضف هذا المطعم أصنافًا بعد.')}</div></section>
  <aside class="panel cart"><h2>سلة طلبك</h2>${renderCart()}<button class="button full" data-go="checkout" ${!S.cart.size||!r.accepting?'disabled':''}>متابعة الطلب ←</button><p class="note">بعد قبول المندوب، يصلك هنا طلب تأكيد أخير قبل بدء التجهيز.</p></aside></div>`;
}
function renderCart(){return S.cart.size ? [...S.cart].map(([id,q])=>{const p=S.catalog.products.find(x=>x.id===id);return `<div class="cart-line"><span>${esc(p.name)} × ${q}</span><span>${price(p.price*q)}</span></div>`;}).join('')+`<div class="cart-line muted"><span>رسوم التوصيل</span><span>${price(S.catalog.restaurant.fee)}</span></div><div class="total-line"><span>الإجمالي</span><span>${price(total()+S.catalog.restaurant.fee)}</span></div>`:'<p class="muted">سلتك فارغة. أضف أول صنف.</p>';}
function renderCheckout(){
  if(!S.cart.size)return empty('سلتك فارغة','ارجع إلى المنيو وأضف الأصناف.');
  return `<div class="checkout">${intro('خلّ طلبك يوصل.','أكمل التفاصيل ثم انتظر قبول المندوب.')}<form id="checkout" class="panel"><div class="form-grid">
  <label class="field">الاسم<input name="name" autocomplete="name" required minlength="2" maxlength="60"></label>
  <label class="field">رقم الجوال<input name="phone" type="tel" autocomplete="tel" required maxlength="16" placeholder="05xxxxxxxx" dir="ltr"></label>
  <label class="field wide">الحي<input name="district" autocomplete="address-level3" required minlength="2" maxlength="80" placeholder="مثال: النايفية"></label>
  <label class="field wide">العنوان بالتفصيل<textarea name="address" autocomplete="street-address" required minlength="8" maxlength="300" placeholder="الشارع، رقم المبنى، وعلامة قريبة"></textarea></label>
  <label class="field wide">ملاحظة للطلب <span class="muted">اختياري</span><input name="note" maxlength="300"></label></div>
  <div class="issue">التحصيل نقدًا للمندوب عند التسليم، أو عبر رابط دفع يشاركه معك المطعم لحسابه مباشرة. تجربة سير عمل فقط — استخدم بيانات اختبار.</div>${renderCart()}<p class="inline-error" id="form-error" role="alert"></p><button class="button full" type="submit">إرسال الطلب للمندوب</button></form></div>`;
}
function renderAuth(){
  const restaurant=S.role==='restaurant';
  const signup=S.sub==='signup';
  const tag=`<span class="tag">${restaurant?'مساحة المطعم':'مساحة المندوب'}</span>`;
  if(!signup) return `<div class="panel login">${tag}<h1>${restaurant?'أهلًا بفريق مطعمك':'مهمتك التالية هنا'}</h1><p>سجّل الدخول بحساب ${restaurant?'مطعمك':'مندوبك'} المستقل.</p>
  <form id="login">
  ${restaurant?'<label class="field">معرّف المطعم<input name="slug" required minlength="3" maxlength="40" pattern="[a-z0-9](-?[a-z0-9])*" placeholder="mini-gish" dir="ltr"></label>':'<label class="field">رقم الجوال<input name="phone" type="tel" required maxlength="16" placeholder="05xxxxxxxx" dir="ltr"></label>'}
  <label class="field">كلمة المرور<input name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="200"></label>
  <p id="form-error" class="inline-error" role="alert"></p>
  <button class="button full">دخول</button></form>
  <p class="note">حساب جديد؟ <a href="#${S.role}/signup">سجّل ${restaurant?'مطعمك':'كمندوب'} الآن</a>.</p></div>`;
  return `<div class="panel login">${tag}<h1>${restaurant?'سجّل مطعمك على وصلها':'انضم كمندوب مستقل'}</h1><p>${restaurant?'دقيقتان وتبدأ باستقبال الطلبات — تضيف المنيو بعد إنشاء الحساب.':'اعمل بجدولك، واقبل المهام من أي مطعم منضم للمنصة.'}</p>
  <form id="signup">
  <label class="field">${restaurant?'اسم المطعم':'الاسم'}<input name="name" required minlength="2" maxlength="60"></label>
  ${restaurant?'<label class="field">المدينة<input name="city" required minlength="2" maxlength="60"></label><label class="field">معرّف المطعم بالإنجليزية <span class="muted">يظهر في الرابط</span><input name="slug" required minlength="3" maxlength="40" pattern="[a-z0-9](-?[a-z0-9])*" placeholder="mini-gish" dir="ltr"></label>':'<label class="field">رقم الجوال<input name="phone" type="tel" required maxlength="16" placeholder="05xxxxxxxx" dir="ltr"></label>'}
  <label class="field">كلمة مرور <span class="muted">12 حرفًا على الأقل</span><input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200"></label>
  <p id="form-error" class="inline-error" role="alert"></p>
  <button class="button full">إنشاء الحساب</button></form>
  <p class="note">لديك حساب؟ <a href="#${S.role}">سجّل الدخول</a>.</p></div>`;
}
function orderActions(o){
  if(closed.includes(o.status))return '';
  let html=''; const b=(action,text,kind='')=>button(action,o.id,text,kind);
  if(S.role==='customer'){
    if(o.status==='reserved')html+=b('confirm','تأكيد الطلب للمطبخ');
    if(['awaiting_courier','reserved','confirmed'].includes(o.status))html+=b('cancel','إلغاء الطلب','secondary');
  }
  if(S.role==='restaurant'){
    if(o.status==='confirmed')html+=b('prepare','ابدأ التجهيز');
    if(o.status==='preparing')html+=b('ready','الطلب جاهز');
    if(o.status==='delivered'&&o.payment_status==='collected')html+=b('settle',`تأكيد استلام ${price(o.total-o.fee)}`);
    if(o.status==='delivery_failed')html+=b('confirm_return','تأكيد عودة الطلب دون تحصيل','secondary');
    if(['awaiting_courier','reserved','confirmed','preparing','ready'].includes(o.status))html+=b('cancel','إلغاء الطلب','danger');
  }
  if(S.role==='courier'){
    if(o.status==='awaiting_courier')html+=b('accept','قبول المهمة');
    if(o.status==='ready')html+=b('pickup','استلمت الطلب');
    if(o.status==='out_for_delivery'){
      if(['pending','failed'].includes(o.payment_status))html+=b('collect',`استلمت ${price(o.total)} نقدًا`);
      if(o.payment_status==='collected')html+=b('deliver','تم التسليم للعميل');
      if(o.payment_status==='pending')html+=b('payment_failed','تعذر التحصيل','secondary');
      if(['pending','failed'].includes(o.payment_status))html+=b('delivery_failed','تعذر التسليم','danger');
    }
  }
  return html?`<div class="actions">${html}</div>`:'';
}
function renderOrder(o,expanded=false){
  const isClosed=closed.includes(o.status);const green=['confirmed','ready','closed'].includes(o.status);const red=['cancelled','expired','delivery_failed'].includes(o.status);
  let inputs='';
  if(S.role==='courier'&&o.status==='out_for_delivery'&&['pending','failed'].includes(o.payment_status))inputs=`<div class="payment-panel"><label>سبب التعثر عند الحاجة<input class="reason" type="text" maxlength="200" placeholder="مثال: تعذر الوصول للعميل"></label></div>`;
  const timeline=`<ol class="timeline">${o.events.map(e=>`<li>${esc(e.detail)}<small>${time(e.at)}</small></li>`).join('')}</ol>`;
  return `<article class="order" data-order="${o.id}"><div class="order-head"><span class="order-id">#${o.id.slice(0,8).toUpperCase()}</span><span class="status ${green?'green':red?'red':''}">${labels[o.status]??esc(o.status)}</span></div>
  <div class="order-body"><div><h3>${esc(o.name??'طلب توصيل جديد')} <span class="muted">· ${esc(o.district)}</span></h3><p class="muted">${esc(o.restaurant.name)} · ${time(o.created)}</p>${o.address?`<p>${esc(o.address)}</p><p dir="ltr">${esc(o.phone)}</p>`:''}</div><strong class="price">${price(o.total)}</strong></div>
  <div class="order-items">${o.items.map(i=>`${esc(i.name)} ${esc(i.description)} × ${i.quantity}`).join(' • ')}</div>${o.note?`<p class="muted">ملاحظة: ${esc(o.note)}</p>`:''}
  <div class="muted">التحصيل: ${payLabels[o.payment_status]}</div>
  ${o.status==='reserved'&&S.role==='customer'?`<div class="issue">قبل المندوب المهمة. أكد طلبك قبل ${time(o.expires)} حتى يبدأ المطبخ.</div>`:''}
  ${o.status==='delivered'?'<p class="note">تم التسليم. اكتمال الطلب يتطلب تسوية المطعم مع المندوب.</p>':''}
  ${o.status==='delivery_failed'?'<div class="issue">الطلب متعثر. يعالج المطعم عودته.</div>':''}
  ${inputs}${orderActions(o)}${expanded?timeline:o.events.length?`<details><summary>سجل الطلب (${o.events.length})</summary>${timeline}</details>`:''}
  ${S.role==='customer'&&!expanded?`<a class="button secondary full" href="#track/${o.id}">${isClosed?'عرض الطلب':'متابعة الطلب'}</a>`:''}</article>`;
}
function renderProducts(){
  return `<div class="panel"><h2>المنيو</h2><div class="cards">${S.products.length?S.products.map(p=>`<div class="cart-line"><span>${esc(p.name)} <span class="muted">${esc(p.description)}</span></span><span>${price(p.price)} <button class="button secondary" data-action="remove_product" data-id="${p.id}">حذف</button></span></div>`).join(''):'<p class="muted">لا توجد أصناف بعد. أضف أول صنف بالأسفل.</p>'}</div>
  <form id="product" class="form-grid product-form"><label class="field">اسم الصنف<input name="name" required minlength="2" maxlength="60"></label><label class="field">السعر بالريال<input name="price" type="number" min="1" max="1000" step="0.5" required></label><label class="field wide">وصف مختصر<input name="description" maxlength="200"></label><button class="button full wide">إضافة صنف</button></form></div>`;
}
function renderBilling(){
  if(!S.billing)return '';
  const b=S.billing;
  return `<div class="panel"><h2>فاتورة هذا الشهر</h2><div class="stats"><div class="stat"><span>طلبات مكتملة</span><strong>${b.ordersCount}</strong></div><div class="stat"><span>رسوم الطلبات</span><strong>${price(b.orderFeeTotal)}</strong></div><div class="stat"><span>الإجمالي المستحق</span><strong>${price(b.total)}</strong></div></div><p class="muted billing-note">يشمل اشتراكًا شهريًا ثابتًا ${price(b.subscriptionFee)} + ${price(200)} عن كل طلب مكتمل. تُحصَّل بفاتورة دورية منفصلة، لا خصمًا من كل معاملة.</p></div>`;
}
function renderDashboard(){
  const restaurant=S.role==='restaurant';const waiting=S.orders.filter(o=>o.status==='awaiting_courier');
  const ongoing=S.orders.filter(o=>!closed.includes(o.status));const delivered=S.orders.filter(o=>o.status==='delivered');
  const r=restaurant?S.catalog?.restaurant:null;
  return intro(restaurant?'كل طلبات مطعمك أمامك.':'توصيلة واضحة، خطوة بخطوة.',restaurant?'تابع التجهيز والتسليم والتحصيل دون فقدان أي خطوة.':'اقبل المهمة من أي مطعم منضم، ثم استلم وسلّم.',`<button class="button secondary" data-logout>تسجيل الخروج</button>`)+
  `<div class="stats"><div class="stat"><span>${restaurant?'طلبات نشطة':'مهام متاحة'}</span><strong>${restaurant?ongoing.length:waiting.length}</strong></div><div class="stat"><span>${restaurant?'جاهزة للاستلام':'في عهدتك'}</span><strong>${restaurant?S.orders.filter(o=>o.status==='ready').length:ongoing.filter(o=>o.mine).length}</strong></div><div class="stat"><span>تسويات مفتوحة</span><strong>${delivered.length}</strong></div></div>
  ${restaurant&&r?`<div class="panel"><form id="settings" class="settings"><label><input name="accepting" type="checkbox" ${r.accepting?'checked':''}> استقبال طلبات جديدة</label><label>الحد المتزامن <input name="capacity" type="number" min="1" max="20" value="${r.capacity}" required></label><button class="button secondary">حفظ</button><span class="muted">الحد الحالي: ${r.capacity} طلبات · الطلبات القائمة تستمر عند الإيقاف</span></form></div>`:''}
  ${restaurant?renderBilling():''}
  ${restaurant?renderProducts():''}
  <div class="toolbar"><h2 class="section-title">${restaurant?'متابعة التشغيل':'المهام'}</h2><span class="muted">تحديث تلقائي كل 3 ثوانٍ</span></div><div class="cards">${ongoing.length?ongoing.map(o=>renderOrder(o)).join(''):empty('لا توجد طلبات نشطة',restaurant?'تظهر الطلبات هنا عند إنشائها من واجهة العميل.':'تظهر هنا مهام كل المطاعم المنضمة عند توفرها.')}</div>
  ${S.orders.some(o=>closed.includes(o.status))?`<details><summary>الطلبات السابقة (${S.orders.filter(o=>closed.includes(o.status)).length})</summary><div class="cards">${S.orders.filter(o=>closed.includes(o.status)).slice(0,15).map(o=>renderOrder(o)).join('')}</div></details>`:''}`;
}
function render(){
  document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===(S.page==='checkout'?'shop':S.page.startsWith('track')?'orders':S.page)));
  const eyebrow=document.querySelector('#page-eyebrow');
  eyebrow.textContent=S.role==='customer'&&S.catalog?.restaurant?`${S.catalog.restaurant.name} · ${S.catalog.restaurant.city}`:'وصّلها';
  document.querySelector('#page-heading').textContent=S.role==='customer'?'طلبات مرتبة. توصيل أوضح.':S.role==='restaurant'?'مساحة المطعم':'مساحة المندوب';
  if(S.session?.role==='anonymous'){main.innerHTML=renderAuth();return;}
  if(S.role==='customer'&&S.page==='shop'&&S.restaurantSlug)main.innerHTML=renderShop();
  else if(S.role==='customer'&&S.page==='shop')main.innerHTML=renderDirectory();
  else if(S.page==='checkout')main.innerHTML=renderCheckout();
  else if(S.page==='restaurant'||S.page==='courier')main.innerHTML=renderDashboard();
  else if(S.page==='track'){const order=S.orders.find(o=>o.id===S.sub);main.innerHTML=intro('طلبك، خطوة بخطوة.','تابع الحالة هنا. لا توجد رسائل واتساب فعلية في هذه النسخة.')+(order?renderOrder(order,true):empty('الطلب غير موجود','افتحه من الحساب أو المتصفح الذي أنشأ الطلب.'));}
  else main.innerHTML=intro('طلباتك.','تفاصيل كل طلب وتحديثاته في مكان واحد.')+`<div class="cards">${S.orders.length?S.orders.map(o=>renderOrder(o)).join(''):empty('لم تبدأ طلبك الأول بعد','انتقل إلى المطاعم واختر ما تحب.')}</div>`;
  S.rendered=JSON.stringify([S.orders,S.catalog?.restaurant,S.products,S.billing]);
}
async function route(){
  const generation=++S.generation;
  const segments=(location.hash.slice(1)||'shop').split('/');
  S.page=segments[0]; S.sub=segments[1];
  S.role=['restaurant','courier'].includes(S.page)?S.page:'customer';
  if(S.page==='shop'&&segments[1])S.restaurantSlug=decodeURIComponent(segments[1]);
  main.innerHTML='<div class="loading">جارٍ التحميل…</div>';
  try{
    const session=await api('/session');
    if(generation!==S.generation)return;S.session=session;
    if(S.role==='customer'){
      if(S.page==='shop'&&S.restaurantSlug)S.catalog=await api(`/catalog?restaurant=${encodeURIComponent(S.restaurantSlug)}`);
      else if(S.page==='shop')S.restaurants=(await api('/restaurants')).restaurants;
      else if(S.page==='checkout'&&S.restaurantSlug&&!S.catalog)S.catalog=await api(`/catalog?restaurant=${encodeURIComponent(S.restaurantSlug)}`);
    }
    if(session.role==='restaurant'&&S.page==='restaurant'){const me=await api('/restaurant/me');S.catalog={restaurant:me.restaurant};S.products=me.products;S.billing=await api('/restaurant/billing');}
    S.orders=session.role!=='anonymous'&&(S.role!=='customer'||!['shop','checkout'].includes(S.page))?(await api('/orders')).orders:[];
    if(generation!==S.generation)return;render();
  }catch(e){main.innerHTML=empty('تعذر تحميل المساحة',esc(e.message))+`<button class="button full" data-reload>إعادة المحاولة</button>`;}
}
async function reloadOrders(){
  const generation=S.generation;
  const data=await api('/orders');
  if(generation!==S.generation)return;
  S.orders=data.orders;
  if(S.session?.role==='restaurant'){S.billing=await api('/restaurant/billing');}
  const editing=main.contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
  if(!editing&&S.rendered!==JSON.stringify([S.orders,S.catalog?.restaurant,S.products,S.billing]))render();
}
main.addEventListener('click',async e=>{
  const el=e.target.closest('button');if(!el)return;
  if(el.hasAttribute('data-reload'))return route();
  if(el.dataset.cart){const n=Math.min(10,Math.max(0,(S.cart.get(el.dataset.cart)??0)+Number(el.dataset.delta)));if(n)S.cart.set(el.dataset.cart,n);else S.cart.delete(el.dataset.cart);return render();}
  if(el.dataset.go){location.hash=el.dataset.go;return;}
  if(S.busy)return;
  if(el.hasAttribute('data-logout')){try{await api('/logout',{body:{}});await route();}catch(error){toast(error.message,true);}return;}
  if(el.dataset.action==='remove_product'){
    if(!confirm('حذف هذا الصنف من المنيو؟'))return;
    S.busy=true;el.disabled=true;
    try{await api(`/restaurant/products/${el.dataset.id}`,{method:'DELETE'});const me=await api('/restaurant/me');S.products=me.products;render();toast('تم حذف الصنف.');}catch(error){toast(error.message,true);}finally{S.busy=false;}
    return;
  }
  if(!el.dataset.action)return;
  const o=S.orders.find(x=>x.id===el.dataset.id);if(!o)return;
  const action=el.dataset.action;let body={};const card=el.closest('[data-order]');
  if(action==='collect')body={amount:o.total};
  if(action==='settle')body={amount:o.total-o.fee};
  if(action==='delivery_failed')body={reason:card.querySelector('.reason')?.value??''};
  const confirms={cancel:'هل تريد إلغاء هذا الطلب؟',settle:`هل استلمت من المندوب ${price(o.total-o.fee)} فعليًا؟`,confirm_return:'هل عاد الطلب المتعثر للمطعم دون تحصيل؟'};
  if(confirms[action]&&!confirm(confirms[action]))return;
  S.busy=true;el.disabled=true;
  try{await api(`/orders/${o.id}/actions/${action}`,{body});await reloadOrders();render();toast('تم تحديث الطلب.');}catch(error){toast(error.message,true);}finally{S.busy=false;if(el.isConnected)el.disabled=false;}
});
main.addEventListener('submit',async e=>{
  e.preventDefault();if(S.busy)return;S.busy=true;const form=e.target;const submit=form.querySelector('button[type=submit],button:not([type])');if(submit)submit.disabled=true;
  const values=Object.fromEntries(new FormData(form));const errorEl=form.querySelector('#form-error');if(errorEl)errorEl.textContent='';
  try{
    if(form.id==='login'){
      const customer=await api('/session',{role:'customer'});
      const body=S.role==='restaurant'?{role:'restaurant',slug:values.slug,password:values.password}:{role:'courier',phone:values.phone,password:values.password};
      await api('/login',{role:'customer',csrf:customer.csrf,body});
      history.replaceState(null,'','#'+S.role);await route();
    }else if(form.id==='signup'){
      const customer=await api('/session',{role:'customer'});
      const path=S.role==='restaurant'?'/restaurants/signup':'/couriers/signup';
      await api(path,{role:'customer',csrf:customer.csrf,body:values});
      history.replaceState(null,'','#'+S.role);await route();
    }else if(form.id==='checkout'){
      const order=await api('/orders',{body:{...values,restaurant:S.restaurantSlug,items:[...S.cart].map(([id,quantity])=>({id,quantity}))}});S.cart.clear();location.hash=`track/${order.id}`;
    }else if(form.id==='settings'){
      await api('/restaurant/settings',{body:{accepting:values.accepting==='on',capacity:Number(values.capacity)}});const me=await api('/restaurant/me');S.catalog={restaurant:me.restaurant};await reloadOrders();render();toast('تم حفظ إعدادات الاستقبال.');
    }else if(form.id==='product'){
      await api('/restaurant/products',{body:{name:values.name,description:values.description??'',price:Math.round(Number(values.price)*100)}});
      const me=await api('/restaurant/me');S.products=me.products;form.reset();render();toast('تمت إضافة الصنف.');
    }
  }catch(error){if(errorEl)errorEl.textContent=error.message;else toast(error.message,true);}finally{S.busy=false;if(submit?.isConnected)submit.disabled=false;}
});
window.addEventListener('hashchange',route);
setInterval(()=>{
  if(S.busy||document.hidden||!S.session||S.session.role==='anonymous'||(S.role==='customer'&&['shop','checkout'].includes(S.page)))return;
  reloadOrders().then(()=>{S.offline=false;}).catch(error=>{if(!S.offline){toast(error.message,true);S.offline=true;}});
},3000);
route();
