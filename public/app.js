const main=document.querySelector('#main');
const S={role:'customer',session:null,catalog:null,orders:[],cart:new Map(),page:'shop',busy:false,generation:0,rendered:''};
const pending=new Map();
const labels={awaiting_courier:'بانتظار المندوب',reserved:'بانتظار تأكيد العميل',confirmed:'مؤكد · للمطبخ',preparing:'قيد التجهيز',ready:'جاهز للاستلام',out_for_delivery:'في الطريق',delivered:'تم التسليم · تسوية مفتوحة',closed:'مكتمل',cancelled:'ملغى',expired:'انتهت المهلة',delivery_failed:'متعثر'};
const payLabels={pending:'لم يُحصّل بعد',cash_collected:'نقد في عهدة المندوب',card_collected:'إيصال بانتظار المطابقة',settled:'تمت التسوية',failed:'تعذر التحصيل'};
const devLabels={reserved:'الجهاز محجوز للطلب',with_courier:'الجهاز مع المندوب',pending_confirmation:'إعادة الجهاز بانتظار تأكيد المطعم'};
const closed=['closed','cancelled','expired'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price=v=>new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(v/100)+' ر.س';
const time=v=>new Intl.DateTimeFormat('ar-SA',{hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(v));
const total=()=>[...S.cart].reduce((n,[id,q])=>n+(S.catalog.products.find(p=>p.id===id)?.price??0)*q,0);
function toast(message,error=false){const el=document.querySelector('#toast');el.textContent=message;el.className=error?'error':'';el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.hidden=true,6000);}
async function api(path,{body,role=S.role,csrf=S.session?.csrf}={}) {
  const headers={'X-Wasselha-Role':role};const options={headers,signal:AbortSignal.timeout(12000)};
  const signature=role+path+JSON.stringify(body);
  if(body!==undefined){if(!pending.has(signature))pending.set(signature,crypto.randomUUID());Object.assign(headers,{'Content-Type':'application/json','X-CSRF-Token':csrf??'','Idempotency-Key':pending.get(signature)});options.method='POST';options.body=JSON.stringify(body);}
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
function renderShop(){
  const r=S.catalog.restaurant;
  return intro('كل جمعة تبدأ بلقمة.','اختر طلبك من ميني قيش، وتابع خطواته حتى التسليم.',`<span class="tag">${r.accepting?'يستقبل الطلبات':'متوقف مؤقتًا'}</span>`)+
  `<section class="hero"><div><h2>لمتكم تحلى.. بلقمتنا</h2><p>تجهيز تقديري ${r.prep} دقيقة بعد تأكيد الطلب · الدفع عند الاستلام</p></div><div class="hero-mark" aria-hidden="true">↗</div></section>
  <div class="layout"><section><h2 class="section-title">وش تحب تطلب؟</h2><div class="products">${S.catalog.products.map((p,i)=>`<article class="product"><div class="product-icon" aria-hidden="true">${['◈','◈','◇','▱'][i]??'◇'}</div><h3>${esc(p.name)}</h3><p class="muted">${esc(p.description)}</p><div class="product-bottom"><span class="price">${price(p.price)}</span><div class="counter"><button data-cart="${p.id}" data-delta="1" aria-label="إضافة ${esc(p.name)} ${esc(p.description)}">+</button><span aria-live="polite">${S.cart.get(p.id)??0}</span><button data-cart="${p.id}" data-delta="-1" aria-label="إنقاص ${esc(p.name)} ${esc(p.description)}">−</button></div></div></article>`).join('')}</div></section>
  <aside class="panel cart"><h2>سلة طلبك</h2>${renderCart()}<button class="button full" data-go="checkout" ${!S.cart.size||!r.accepting?'disabled':''}>متابعة الطلب ←</button><p class="note">بعد قبول المندوب، يصلك هنا طلب تأكيد أخير قبل بدء التجهيز.</p></aside></div>`;
}
function renderCart(){return S.cart.size ? [...S.cart].map(([id,q])=>{const p=S.catalog.products.find(x=>x.id===id);return `<div class="cart-line"><span>${esc(p.name)} × ${q}</span><span>${price(p.price*q)}</span></div>`;}).join('')+`<div class="cart-line muted"><span>توصيل تجريبي ثابت</span><span>${price(S.catalog.restaurant.fee)}</span></div><div class="total-line"><span>الإجمالي</span><span>${price(total()+S.catalog.restaurant.fee)}</span></div>`:'<p class="muted">سلتك فارغة. أضف أول صنف.</p>';}
function renderCheckout(){
  if(!S.cart.size)return empty('سلتك فارغة','ارجع إلى طلب جديد وأضف الأصناف.');
  return `<div class="checkout">${intro('خلّ طلبك يوصل.','أكمل التفاصيل ثم انتظر قبول المندوب.')}<form id="checkout" class="panel"><div class="form-grid">
  <label class="field">الاسم<input name="name" autocomplete="name" required minlength="2" maxlength="60"></label>
  <label class="field">رقم الجوال<input name="phone" type="tel" autocomplete="tel" required maxlength="16" placeholder="05xxxxxxxx" dir="ltr"></label>
  <label class="field wide">الحي<input name="district" autocomplete="address-level3" required minlength="2" maxlength="80" placeholder="مثال: النايفية"></label>
  <label class="field wide">العنوان بالتفصيل<textarea name="address" autocomplete="street-address" required minlength="8" maxlength="300" placeholder="الشارع، رقم المبنى، وعلامة قريبة"></textarea></label>
  <label class="field wide">ملاحظة للطلب <span class="muted">اختياري</span><input name="note" maxlength="300"></label>
  <div class="field wide"><span>الدفع عند الاستلام</span><div class="choices"><label class="choice"><input type="radio" name="payment" value="cash" checked> كاش</label><label class="choice"><input type="radio" name="payment" value="card"> شبكة · جهاز المطعم</label></div></div></div>
  <div class="issue">تجربة سير عمل فقط. استخدم بيانات اختبار، ولا ترسل طلبًا حقيقيًا من هذه النسخة.</div>${renderCart()}<p class="inline-error" id="form-error" role="alert"></p><button class="button full" type="submit">إرسال الطلب للمندوب</button></form></div>`;
}
function renderLogin(){const restaurant=S.role==='restaurant';return `<div class="panel login"><span class="tag">${restaurant?'مساحة المطعم':'مساحة المندوب'}</span><h1>${restaurant?'أهلًا بفريق ميني قيش':'مهمتك التالية هنا'}</h1><p>هذه المساحة محمية بكلمة مرور خاصة ${restaurant?'بالمطعم':'بالمندوب'}.</p><form id="login"><label class="field">كلمة المرور<input name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="200"></label><p id="form-error" class="inline-error" role="alert"></p><button class="button full">دخول ${restaurant?'المطعم':'المندوب'}</button></form></div>`;}
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
    if(o.status==='delivered'&&o.payment_status!=='settled')html+=b('settle',o.payment==='cash'?'تأكيد استلام النقد':'تأكيد مطابقة الإيصال');
    if(o.device?.state==='pending_confirmation')html+=b('confirm_device','تأكيد استلام جهاز الشبكة','secondary');
    if(o.status==='delivery_failed'&&!o.device)html+=b('confirm_return','تأكيد عودة الطلب دون تحصيل','secondary');
    if(['awaiting_courier','reserved','confirmed','preparing','ready'].includes(o.status))html+=b('cancel','إلغاء الطلب','danger');
  }
  if(S.role==='courier'){
    if(o.status==='awaiting_courier')html+=b('accept','قبول المهمة');
    if(o.status==='ready')html+=b('pickup','استلمت الطلب');
    if(o.status==='out_for_delivery'){
      if(['pending','failed'].includes(o.payment_status))html+=b('collect',o.payment==='cash'?'استلمت المبلغ نقدًا':'سجل نجاح عملية الشبكة');
      if(['cash_collected','card_collected'].includes(o.payment_status))html+=b('deliver','تم التسليم للعميل');
      if(o.payment_status==='pending')html+=b('payment_failed','تعذر التحصيل','secondary');
      if(['pending','failed'].includes(o.payment_status))html+=b('delivery_failed','تعذر التسليم','danger');
    }
    if(['delivered','delivery_failed'].includes(o.status)&&o.device?.state==='with_courier')html+=b('return_device','أعدت جهاز الشبكة','secondary');
  }
  return html?`<div class="actions">${html}</div>`:'';
}
function renderOrder(o,expanded=false){
  const isClosed=closed.includes(o.status);const green=['confirmed','ready','closed'].includes(o.status);const red=['cancelled','expired','delivery_failed'].includes(o.status);
  let inputs='';
  if(S.role==='courier'&&o.status==='ready'&&o.payment==='card')inputs=`<div class="payment-panel"><label><input class="device-received" type="checkbox"> استلمت جهاز الشبكة POS-01 مع الطلب</label></div>`;
  if(S.role==='courier'&&o.status==='out_for_delivery'&&['pending','failed'].includes(o.payment_status))inputs=`<div class="payment-panel">${o.payment==='card'?'<label>مرجع إيصال الشبكة<input class="receipt" type="text" minlength="4" maxlength="100" placeholder="مرجع العملية" dir="ltr"></label>':''}<label>سبب التعثر عند الحاجة<input class="reason" type="text" maxlength="200" placeholder="مثال: تعذر الوصول للعميل"></label></div>`;
  const timeline=`<ol class="timeline">${o.events.map(e=>`<li>${esc(e.detail)}<small>${time(e.at)}</small></li>`).join('')}</ol>`;
  return `<article class="order" data-order="${o.id}"><div class="order-head"><span class="order-id">#${o.id.slice(0,8).toUpperCase()}</span><span class="status ${green?'green':red?'red':''}">${labels[o.status]??esc(o.status)}</span></div>
  <div class="order-body"><div><h3>${esc(o.name??'طلب توصيل جديد')} <span class="muted">· ${esc(o.district)}</span></h3><p class="muted">${time(o.created)} · ${o.payment==='cash'?'كاش':'شبكة بجهاز المطعم'}</p>${o.address?`<p>${esc(o.address)}</p><p dir="ltr">${esc(o.phone)}</p>`:''}</div><strong class="price">${price(o.total)}</strong></div>
  <div class="order-items">${o.items.map(i=>`${esc(i.name)} ${esc(i.description)} × ${i.quantity}`).join(' • ')}</div>${o.note?`<p class="muted">ملاحظة: ${esc(o.note)}</p>`:''}
  <div class="muted">التحصيل: ${payLabels[o.payment_status]}${o.receipt?' · الإيصال: '+esc(o.receipt):''}</div>
  ${o.device?`<div class="tag">${devLabels[o.device.state]} · ${o.device.id}</div>`:''}
  ${o.status==='reserved'&&S.role==='customer'?`<div class="issue">قبل المندوب المهمة. أكد طلبك قبل ${time(o.expires)} حتى يبدأ المطبخ.</div>`:''}
  ${o.status==='delivered'?'<p class="note">تم التسليم. اكتمال الطلب يتطلب تسوية التحصيل وإغلاق عهدة الجهاز إن وجدت.</p>':''}
  ${o.status==='delivery_failed'?'<div class="issue">الطلب متعثر. تتم معالجة عودة الطلب والعهدة مع المطعم.</div>':''}
  ${inputs}${orderActions(o)}${expanded?timeline:o.events.length?`<details><summary>سجل الطلب (${o.events.length})</summary>${timeline}</details>`:''}
  ${S.role==='customer'&&!expanded?`<a class="button secondary full" href="#track/${o.id}">${isClosed?'عرض الطلب':'متابعة الطلب'}</a>`:''}</article>`;
}
function renderDashboard(){
  const restaurant=S.role==='restaurant';const waiting=S.orders.filter(o=>o.status==='awaiting_courier');
  const ongoing=S.orders.filter(o=>!closed.includes(o.status));const delivered=S.orders.filter(o=>o.status==='delivered');
  const r=S.catalog.restaurant;
  return intro(restaurant?'كل الطلبات أمامك.':'توصيلة واضحة، خطوة بخطوة.',restaurant?'تابع التجهيز والتسليم والتحصيل دون فقدان أي خطوة.':'اقبل المهمة، انتظر الجاهزية، ثم استلم وسلّم.',`<button class="button secondary" data-logout>تسجيل الخروج</button>`)+
  `<div class="stats"><div class="stat"><span>${restaurant?'طلبات نشطة':'مهام متاحة'}</span><strong>${restaurant?ongoing.length:waiting.length}</strong></div><div class="stat"><span>${restaurant?'جاهزة للاستلام':'في عهدتك'}</span><strong>${restaurant?S.orders.filter(o=>o.status==='ready').length:ongoing.filter(o=>o.mine).length}</strong></div><div class="stat"><span>تسويات مفتوحة</span><strong>${delivered.length}</strong></div></div>
  ${restaurant?`<div class="panel"><form id="settings" class="settings"><label><input name="accepting" type="checkbox" ${r.accepting?'checked':''}> استقبال طلبات جديدة</label><label>الحد المتزامن <input name="capacity" type="number" min="1" max="20" value="${r.capacity}" required></label><button class="button secondary">حفظ</button><span class="muted">الحد الحالي: ${r.capacity} طلبات · الطلبات القائمة تستمر عند الإيقاف</span></form></div>`:''}
  <div class="toolbar"><h2 class="section-title">${restaurant?'متابعة التشغيل':'المهام'}</h2><span class="muted">تحديث تلقائي كل 3 ثوانٍ</span></div><div class="cards">${ongoing.length?ongoing.map(o=>renderOrder(o)).join(''):empty('لا توجد طلبات نشطة','تظهر الطلبات هنا عند إنشائها من واجهة العميل.')}</div>
  ${S.orders.some(o=>closed.includes(o.status))?`<details><summary>الطلبات السابقة (${S.orders.filter(o=>closed.includes(o.status)).length})</summary><div class="cards">${S.orders.filter(o=>closed.includes(o.status)).slice(0,15).map(o=>renderOrder(o)).join('')}</div></details>`:''}`;
}
function render(){
  document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===(S.page==='checkout'?'shop':S.page.startsWith('track/')?'orders':S.page)));
  document.querySelector('#page-heading').textContent=S.role==='customer'?'طلبات مرتبة. توصيل أوضح.':S.role==='restaurant'?'مساحة المطعم':'مساحة المندوب';
  if(S.session?.role==='anonymous'){main.innerHTML=renderLogin();return;}
  if(S.page==='shop')main.innerHTML=renderShop();
  else if(S.page==='checkout')main.innerHTML=renderCheckout();
  else if(S.page==='restaurant'||S.page==='courier')main.innerHTML=renderDashboard();
  else if(S.page.startsWith('track/')){const order=S.orders.find(o=>o.id===S.page.slice(6));main.innerHTML=intro('طلبك، خطوة بخطوة.','تابع الحالة هنا. لا توجد رسائل واتساب فعلية في هذه النسخة.')+(order?renderOrder(order,true):empty('الطلب غير موجود','افتحه من الحساب أو المتصفح الذي أنشأ الطلب.'));}
  else main.innerHTML=intro('طلباتك.','تفاصيل كل طلب وتحديثاته في مكان واحد.')+`<div class="cards">${S.orders.length?S.orders.map(o=>renderOrder(o)).join(''):empty('لم تبدأ طلبك الأول بعد','انتقل إلى طلب جديد واختر من الأصناف المتاحة.')}</div>`;
  S.rendered=JSON.stringify([S.orders,S.catalog.restaurant]);
}
async function route(){
  const generation=++S.generation;
  S.page=location.hash.slice(1)||'shop';
  S.role=['restaurant','courier'].includes(S.page)?S.page:'customer';
  main.innerHTML='<div class="loading">جارٍ التحميل…</div>';
  try{
    const [session,catalog]=await Promise.all([api('/session'),api('/catalog')]);
    if(generation!==S.generation)return;S.session=session;S.catalog=catalog;
    S.orders=session.role!=='anonymous'&&(S.page!=='shop'&&S.page!=='checkout')?(await api('/orders')).orders:[];
    if(generation!==S.generation)return;render();
  }catch(e){main.innerHTML=empty('تعذر تحميل المساحة',esc(e.message))+`<button class="button full" data-reload>إعادة المحاولة</button>`;}
}
async function reloadOrders(){
  const generation=S.generation;
  const [data,catalog]=await Promise.all([api('/orders'),api('/catalog')]);
  if(generation!==S.generation)return;
  S.orders=data.orders;S.catalog=catalog;
  const editing=main.contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
  if(!editing&&S.rendered!==JSON.stringify([S.orders,S.catalog.restaurant]))render();
}
main.addEventListener('click',async e=>{
  const el=e.target.closest('button');if(!el)return;
  if(el.hasAttribute('data-reload'))return route();
  if(el.dataset.cart){const n=Math.min(10,Math.max(0,(S.cart.get(el.dataset.cart)??0)+Number(el.dataset.delta)));if(n)S.cart.set(el.dataset.cart,n);else S.cart.delete(el.dataset.cart);return render();}
  if(el.dataset.go){location.hash=el.dataset.go;return;}
  if(S.busy)return;
  if(el.hasAttribute('data-logout')){try{await api('/logout',{body:{}});await route();}catch(error){toast(error.message,true);}return;}
  if(!el.dataset.action)return;
  const o=S.orders.find(x=>x.id===el.dataset.id);if(!o)return;
  const action=el.dataset.action;let body={};const card=el.closest('[data-order]');
  if(action==='pickup')body={deviceReceived:Boolean(card.querySelector('.device-received')?.checked)};
  if(action==='collect')body={amount:o.total,receipt:card.querySelector('.receipt')?.value??''};
  if(action==='settle')body={amount:o.total};
  if(action==='delivery_failed')body={reason:card.querySelector('.reason')?.value??''};
  const confirms={cancel:'هل تريد إلغاء هذا الطلب؟',settle:`هل تحققت من استلام ومطابقة كامل المبلغ ${price(o.total)}؟`,confirm_device:'هل عاد جهاز الشبكة إلى المطعم فعلًا؟',confirm_return:'هل عاد الطلب المتعثر إلى المطعم دون تحصيل؟'};
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
      S.session=await api('/login',{role:'customer',csrf:customer.csrf,body:{role:S.role,password:values.password}});await route();
    }else if(form.id==='checkout'){
      const order=await api('/orders',{body:{...values,items:[...S.cart].map(([id,quantity])=>({id,quantity}))}});S.cart.clear();location.hash=`track/${order.id}`;
    }else if(form.id==='settings'){
      await api('/restaurant/settings',{body:{accepting:values.accepting==='on',capacity:Number(values.capacity)}});await reloadOrders();render();toast('تم حفظ إعدادات الاستقبال.');
    }
  }catch(error){if(errorEl)errorEl.textContent=error.message;else toast(error.message,true);}finally{S.busy=false;if(submit?.isConnected)submit.disabled=false;}
});
window.addEventListener('hashchange',route);
setInterval(()=>{
  if(S.busy||document.hidden||!S.session||S.session.role==='anonymous'||['shop','checkout'].includes(S.page))return;
  reloadOrders().then(()=>{S.offline=false;}).catch(error=>{if(!S.offline){toast(error.message,true);S.offline=true;}});
},3000);
route();
