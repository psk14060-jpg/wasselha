import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Fault extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const demand = (condition, message, status) => { if (!condition) throw new Fault(message, status); };
const digest = value => createHash('sha256').update(value).digest('hex');
const active = ['awaiting_courier', 'reserved', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivery_failed'];
const money = value => Number.isSafeInteger(value) && value >= 0;

export function createStore(filename = ':memory:', clock = () => Date.now()) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS restaurant(id INTEGER PRIMARY KEY CHECK(id=1), accepting INTEGER NOT NULL, capacity INTEGER NOT NULL, fee INTEGER NOT NULL, prep INTEGER NOT NULL);
    INSERT OR IGNORE INTO restaurant VALUES(1,1,6,1500,25);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,price INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,role TEXT NOT NULL,actor_id TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,customer TEXT NOT NULL,courier TEXT,status TEXT NOT NULL,payment TEXT NOT NULL,payment_status TEXT NOT NULL,total INTEGER NOT NULL,fee INTEGER NOT NULL,items TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,district TEXT NOT NULL,address TEXT NOT NULL,note TEXT NOT NULL,receipt TEXT NOT NULL DEFAULT '',expires INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer,created);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
    CREATE TABLE IF NOT EXISTS device(id TEXT PRIMARY KEY,state TEXT NOT NULL,order_id TEXT,courier TEXT);
    INSERT OR IGNORE INTO device VALUES('POS-01','available',NULL,NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,key));
  `);
  const seed = db.prepare('INSERT OR IGNORE INTO products VALUES(?,?,?,?)');
  for (const p of [
    ['pizza42','كب بيتزا','42 قطعة',6500],['pizza28','كب بيتزا','28 قطعة',4700],
    ['kabaji','ميني كباجي','سكر وجبن سائل',3500],['boats','قوارب','18 قطعة — أجبان وحمسات',3500]
  ]) seed.run(...p);
  const row = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const device = () => db.prepare('SELECT * FROM device WHERE id=?').get('POS-01');
  const settings = () => db.prepare('SELECT * FROM restaurant WHERE id=1').get();
  const event = (id, actor, action, detail = '') => db.prepare('INSERT INTO events(order_id,actor,action,detail,at) VALUES(?,?,?,?,?)').run(id,actor,action,detail,clock());
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  function expire() {
    for (const order of db.prepare("SELECT * FROM orders WHERE status IN ('awaiting_courier','reserved') AND expires<=?").all(clock())) {
      db.prepare("UPDATE orders SET status='expired',expires=NULL,updated=? WHERE id=?").run(clock(),order.id);
      db.prepare("UPDATE device SET state='available',order_id=NULL,courier=NULL WHERE order_id=? AND state='reserved'").run(order.id);
      event(order.id,'system','expired','انتهت مهلة الطلب؛ تم تحرير الحجز.');
    }
  }
  function mutate(actor, key, action, body, fn) {
    demand(typeof key==='string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key),'تعذر التحقق من معرّف العملية. أعد المحاولة.',400);
    return transaction(() => {
      expire();
      const scope = `${actor.role}:${actor.actor_id}:${action}`;
      const hash=digest(JSON.stringify(body));
      const prior=db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope,key);
      if (prior) { demand(prior.hash===hash,'معرّف العملية مستخدم لطلب مختلف.'); return JSON.parse(prior.response); }
      const result=fn();
      db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope,key,hash,JSON.stringify(result));
      return result;
    });
  }
  function view(order, actor) {
    demand(order,'الطلب غير موجود.',404);
    const owns = actor.role==='restaurant' || (actor.role==='customer' && order.customer===actor.actor_id) || (actor.role==='courier' && order.courier===actor.actor_id);
    const offer = actor.role==='courier' && order.status==='awaiting_courier';
    demand(owns || offer,'الطلب غير متاح لهذا الحساب.',404);
    const {customer,courier,...data}=order;
    data.items=JSON.parse(order.items);
    data.assigned=Boolean(courier);
    data.mine=courier===actor.actor_id;
    if (!owns) { delete data.name; delete data.phone; delete data.address; delete data.note; delete data.receipt; }
    const d=device();
    data.device=order.id===d.order_id ? {id:d.id,state:d.state} : null;
    data.events=owns ? db.prepare('SELECT action,detail,at FROM events WHERE order_id=? ORDER BY id').all(order.id) : [];
    return data;
  }
  function closeIfSettled(id) {
    const order=row(id);
    if (order.status==='delivered' && order.payment_status==='settled' && device().order_id!==id) {
      db.prepare("UPDATE orders SET status='closed',updated=? WHERE id=?").run(clock(),id);
      event(id,'system','closed','اكتمل الطلب والتحصيل والعهدة.');
    }
  }
  function createOrder(actor,key,body) {
    demand(actor.role==='customer','إنشاء الطلب متاح للعميل فقط.',403);
    return mutate(actor,key,'create_order',body,() => {
      const s=settings();
      demand(Boolean(s.accepting),'المطعم أوقف استقبال الطلبات مؤقتًا.');
      const count=db.prepare(`SELECT count(*) AS n FROM orders WHERE status IN (${active.map(()=>'?').join(',')})`).get(...active).n;
      demand(count<s.capacity,'المطعم وصل إلى طاقته الحالية. حاول لاحقًا.');
      demand(['cash','card'].includes(body.payment),'اختر كاش أو شبكة.',400);
      for (const [field,min,max] of [['name',2,60],['district',2,80],['address',8,300]]) {
        demand(typeof body[field]==='string' && body[field].trim().length>=min && body[field].length<=max,'أكمل الاسم والحي والعنوان بشكل صحيح.',400);
      }
      const phone=String(body.phone??'').replace(/[\s()-]/g,'');
      demand(/^(?:\+?966|0)5\d{8}$/.test(phone),'أدخل رقم جوال سعودي صحيحًا.',400);
      demand(typeof (body.note??'')==='string' && (body.note??'').length<=300,'الملاحظة أطول من المسموح.',400);
      demand(Array.isArray(body.items) && body.items.length>0 && body.items.length<=20,'أضف صنفًا إلى السلة.',400);
      const seen=new Set(); let total=s.fee; let quantities=0;
      const items=body.items.map(item=>{
        demand(item && typeof item.id==='string' && Number.isInteger(item.quantity) && item.quantity>=1 && item.quantity<=10 && !seen.has(item.id),'كمية أو صنف غير صالح.',400);
        seen.add(item.id); quantities+=item.quantity;
        const product=db.prepare('SELECT * FROM products WHERE id=?').get(item.id);
        demand(product,'الصنف غير متاح.',400); total+=product.price*item.quantity;
        return {...product,quantity:item.quantity};
      });
      demand(quantities<=20 && money(total),'تجاوز الطلب الحد المتاح لهذه التجربة.',400);
      if (body.payment==='card') demand(device().state==='available','جهاز الشبكة مشغول حاليًا. يمكنك اختيار الكاش أو المحاولة لاحقًا.');
      const id=randomUUID(); const now=clock();
      db.prepare('INSERT INTO orders(id,customer,status,payment,payment_status,total,fee,items,name,phone,district,address,note,expires,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,actor.actor_id,'awaiting_courier',body.payment,'pending',total,s.fee,JSON.stringify(items),body.name.trim(),phone,body.district.trim(),body.address.trim(),body.note?.trim()??'',now+10*60_000,now,now);
      if (body.payment==='card') db.prepare("UPDATE device SET state='reserved',order_id=? WHERE id='POS-01'").run(id);
      event(id,'customer','created','وصل الطلب؛ بانتظار قبول المندوب.');
      return view(row(id),actor);
    });
  }
  function act(actor,key,id,action,body={}) {
    return mutate(actor,key,`${id}:${action}`,body,()=>{
      let order=row(id); demand(order,'الطلب غير موجود.',404);
      const staff=actor.role==='restaurant';
      const customer=actor.role==='customer' && order.customer===actor.actor_id;
      const courier=actor.role==='courier' && order.courier===actor.actor_id;
      const requireRole=ok=>demand(ok,'هذه الخطوة غير متاحة لهذا الحساب.',403);
      const requireState=(...states)=>demand(states.includes(order.status),'تغيرت حالة الطلب. حدّث الصفحة وتحقق من الخطوة المتاحة.');
      const set=(status)=>db.prepare('UPDATE orders SET status=?,updated=? WHERE id=?').run(status,clock(),id);
      let detail='';
      switch(action) {
        case 'accept': {
          requireRole(actor.role==='courier'); requireState('awaiting_courier');
          const busy=db.prepare("SELECT count(*) AS n FROM orders WHERE courier=? AND status NOT IN ('closed','cancelled','expired')").get(actor.actor_id).n;
          demand(!busy && !device().courier,'أكمل مهمتك الحالية وتسوية عهدتك قبل قبول مهمة أخرى.');
          db.prepare("UPDATE orders SET courier=?,status='reserved',expires=?,updated=? WHERE id=? AND status='awaiting_courier'").run(actor.actor_id,clock()+3*60_000,clock(),id);
          if(order.payment==='card') db.prepare('UPDATE device SET courier=? WHERE order_id=?').run(actor.actor_id,id);
          detail='قبل المندوب المهمة. لدى العميل 3 دقائق للتأكيد.'; break;
        }
        case 'confirm':
          requireRole(customer); requireState('reserved');
          db.prepare("UPDATE orders SET status='confirmed',expires=NULL,updated=? WHERE id=?").run(clock(),id);
          detail='أكد العميل الطلب. أصبح متاحًا للمطبخ.'; break;
        case 'prepare': requireRole(staff); requireState('confirmed'); set('preparing'); detail='بدأ المطبخ تجهيز الطلب.'; break;
        case 'ready': requireRole(staff); requireState('preparing'); set('ready'); detail='الطلب جاهز للاستلام.'; break;
        case 'pickup':
          requireRole(courier); requireState('ready');
          if(order.payment==='card') {
            demand(body.deviceReceived===true,'أكد استلام جهاز الشبكة مع الطلب.',400);
            demand(device().order_id===id && device().state==='reserved','حجز جهاز الشبكة غير صالح.');
            db.prepare("UPDATE device SET state='with_courier' WHERE order_id=?").run(id);
          }
          set('out_for_delivery'); detail=order.payment==='card'?'استلم المندوب الطلب وجهاز الشبكة.':'استلم المندوب الطلب.'; break;
        case 'collect':
          requireRole(courier); requireState('out_for_delivery');
          demand(['pending','failed'].includes(order.payment_status),'تم تسجيل التحصيل من قبل.');
          demand(body.amount===order.total,'يجب تسجيل كامل المبلغ المستحق.',400);
          if(order.payment==='card') demand(typeof body.receipt==='string' && body.receipt.trim().length>=4 && body.receipt.length<=100,'أدخل مرجع إيصال جهاز الشبكة.',400);
          db.prepare('UPDATE orders SET payment_status=?,receipt=?,updated=? WHERE id=?').run(order.payment==='cash'?'cash_collected':'card_collected',order.payment==='card'?body.receipt.trim():'',clock(),id);
          detail='سجل المندوب التحصيل؛ بانتظار مطابقة المطعم.'; break;
        case 'payment_failed':
          requireRole(courier); requireState('out_for_delivery'); demand(order.payment_status==='pending','لا يمكن تسجيل تعثر بعد التحصيل.');
          db.prepare("UPDATE orders SET payment_status='failed',updated=? WHERE id=?").run(clock(),id);
          detail='تعذر التحصيل. التسليم متوقف إلى حين المعالجة.'; break;
        case 'deliver':
          requireRole(courier); requireState('out_for_delivery');
          demand(['cash_collected','card_collected'].includes(order.payment_status),'سجل التحصيل أولًا أو بلّغ عن تعثر الدفع.');
          set('delivered'); detail='تم التسليم؛ التحصيل والعهدة ما زالا بحاجة إلى تسوية.'; break;
        case 'settle':
          requireRole(staff); requireState('delivered');
          demand(['cash_collected','card_collected'].includes(order.payment_status),'التحصيل غير قابل للتسوية الآن.');
          demand(body.amount===order.total,'قيمة التسوية يجب أن تطابق كامل الطلب.',400);
          db.prepare("UPDATE orders SET payment_status='settled',updated=? WHERE id=?").run(clock(),id);
          detail=order.payment==='cash'?'أكد المطعم استلام النقد كاملًا.':'أكد المطعم مطابقة إيصال الشبكة.'; break;
        case 'return_device':
          requireRole(courier); requireState('delivered','delivery_failed');
          demand(device().order_id===id && device().state==='with_courier','الجهاز ليس في عهدة هذا الطلب.');
          db.prepare("UPDATE device SET state='pending_confirmation' WHERE order_id=?").run(id);
          detail='أبلغ المندوب عن إعادة الجهاز؛ بانتظار تأكيد المطعم.'; break;
        case 'confirm_device':
          requireRole(staff); demand(device().order_id===id && device().state==='pending_confirmation','لم يبلغ المندوب عن إعادة الجهاز بعد.');
          db.prepare("UPDATE device SET state='available',order_id=NULL,courier=NULL WHERE order_id=?").run(id);
          detail='أكد المطعم استلام الجهاز؛ أصبح متاحًا.'; break;
        case 'cancel':
          requireRole(customer || staff); customer ? requireState('awaiting_courier','reserved','confirmed') : requireState('awaiting_courier','reserved','confirmed','preparing','ready');
          set('cancelled'); db.prepare("UPDATE device SET state='available',order_id=NULL,courier=NULL WHERE order_id=? AND state='reserved'").run(id);
          detail='ألغي الطلب قبل استلام المندوب؛ تم تحرير الحجز.'; break;
        case 'delivery_failed':
          requireRole(courier); requireState('out_for_delivery'); demand(['pending','failed'].includes(order.payment_status),'تواصل مع المطعم لمعالجة طلب تم تحصيله.');
          demand(typeof body.reason==='string' && body.reason.trim().length>=5 && body.reason.length<=200,'اذكر سبب التعثر.',400);
          set('delivery_failed'); detail=body.reason.trim(); break;
        case 'confirm_return':
          requireRole(staff); requireState('delivery_failed');
          demand(device().order_id!==id,'أكد عودة جهاز الشبكة أولًا.');
          set('cancelled'); detail='أكد المطعم عودة الطلب المتعثر دون تحصيل.'; break;
        default: throw new Fault('الخطوة غير معروفة.',400);
      }
      event(id,actor.role,action,detail); closeIfSettled(id);
      return view(row(id),actor);
    });
  }
  return {
    db, close:()=>db.close(),
    catalog:()=>({restaurant:{name:'ميني قيش',city:'الأحساء',...settings()},products:db.prepare('SELECT * FROM products ORDER BY rowid').all(),demo:true}),
    createSession(role='customer',actorId=randomUUID()) {
      const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
      const session={role,actor_id:actorId,csrf,expires:clock()+24*3600_000};
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(clock());
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(token),role,actorId,csrf,session.expires);
      return {token,...session};
    },
    getSession:token=>token ? db.prepare('SELECT role,actor_id,csrf,expires FROM sessions WHERE token_hash=? AND expires>?').get(digest(token),clock()) : undefined,
    removeSession:token=>{if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));},
    orders(actor) { return transaction(()=>{expire();return db.prepare('SELECT * FROM orders ORDER BY created DESC').all().filter(o=>actor.role==='restaurant'||(actor.role==='customer'&&o.customer===actor.actor_id)||(actor.role==='courier'&&(o.status==='awaiting_courier'||o.courier===actor.actor_id))).map(o=>view(o,actor));}); },
    order(actor,id) {return transaction(()=>{expire();return view(row(id),actor);});},
    device:actor=>{demand(actor.role==='restaurant','غير مسموح.',403);return device();},
    settings(actor,key,body) {
      demand(actor.role==='restaurant','غير مسموح.',403);
      return mutate(actor,key,'settings',body,()=>{
        demand(typeof body.accepting==='boolean' && Number.isInteger(body.capacity) && body.capacity>=1 && body.capacity<=20,'طاقة المطعم يجب أن تكون بين 1 و20 طلبًا.',400);
        db.prepare('UPDATE restaurant SET accepting=?,capacity=? WHERE id=1').run(Number(body.accepting),body.capacity); return settings();
      });
    }, createOrder, act
  };
}
