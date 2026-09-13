import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Fault extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const demand = (condition, message, status) => { if (!condition) throw new Fault(message, status); };
const digest = value => createHash('sha256').update(value).digest('hex');
const active = ['awaiting_courier', 'reserved', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivery_failed'];
const money = value => Number.isSafeInteger(value) && value >= 0;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const phonePattern = /^(?:\+?966|0)5\d{8}$/;

export const PLATFORM_ORDER_FEE = 200; // 2.00 ر.س بالهللة، يُحصَّل بفاتورة دورية لا كخصم من كل معاملة
export const PLATFORM_MONTHLY_FEE = 9900; // 99.00 ر.س

function hashPassword(password) {
  const salt = randomBytes(16);
  return { salt, hash: scryptSync(password, salt, 32) };
}
function verifyPassword(password, salt, hash) {
  return timingSafeEqual(scryptSync(password, salt, 32), hash);
}

export function createStore(filename = ':memory:', clock = () => Date.now()) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS restaurants(id TEXT PRIMARY KEY,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,city TEXT NOT NULL,password_salt BLOB NOT NULL,password_hash BLOB NOT NULL,accepting INTEGER NOT NULL DEFAULT 1,capacity INTEGER NOT NULL DEFAULT 6,fee INTEGER NOT NULL DEFAULT 1000,prep INTEGER NOT NULL DEFAULT 20,whatsapp_number TEXT,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS couriers(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT UNIQUE NOT NULL,password_salt BLOB NOT NULL,password_hash BLOB NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,price INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS products_restaurant ON products(restaurant_id);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,role TEXT NOT NULL,actor_id TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL,customer TEXT NOT NULL,courier TEXT,status TEXT NOT NULL,payment_status TEXT NOT NULL,total INTEGER NOT NULL,fee INTEGER NOT NULL,items TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,district TEXT NOT NULL,address TEXT NOT NULL,note TEXT NOT NULL,expires INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_restaurant ON orders(restaurant_id,created);
    CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer,created);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,key));
  `);
  const row = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const restaurantById = id => db.prepare('SELECT * FROM restaurants WHERE id=?').get(id);
  const restaurantBySlug = slug => db.prepare('SELECT * FROM restaurants WHERE slug=?').get(slug);
  const courierByPhone = phone => db.prepare('SELECT * FROM couriers WHERE phone=?').get(phone);
  const event = (id, actor, action, detail = '') => db.prepare('INSERT INTO events(order_id,actor,action,detail,at) VALUES(?,?,?,?,?)').run(id,actor,action,detail,clock());
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  function expire() {
    for (const order of db.prepare("SELECT * FROM orders WHERE status IN ('awaiting_courier','reserved') AND expires<=?").all(clock())) {
      db.prepare("UPDATE orders SET status='expired',expires=NULL,updated=? WHERE id=?").run(clock(),order.id);
      event(order.id,'system','expired','انتهت مهلة الطلب.');
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
    const owns = (actor.role==='restaurant' && order.restaurant_id===actor.actor_id) || (actor.role==='customer' && order.customer===actor.actor_id) || (actor.role==='courier' && order.courier===actor.actor_id);
    const offer = actor.role==='courier' && order.status==='awaiting_courier';
    demand(owns || offer,'الطلب غير متاح لهذا الحساب.',404);
    const {customer,courier,restaurant_id,...data}=order;
    data.items=JSON.parse(order.items);
    data.assigned=Boolean(courier);
    data.mine=courier===actor.actor_id;
    const restaurant=restaurantById(restaurant_id);
    data.restaurant={name:restaurant?.name??'مطعم محذوف',city:restaurant?.city??'',whatsappNumber:restaurant?.whatsapp_number??null};
    if (!owns) { delete data.name; delete data.phone; delete data.address; delete data.note; }
    data.events=owns ? db.prepare('SELECT action,detail,at FROM events WHERE order_id=? ORDER BY id').all(order.id) : [];
    return data;
  }
  function closeIfSettled(id) {
    const order=row(id);
    if (order.status==='delivered' && order.payment_status==='settled') {
      db.prepare("UPDATE orders SET status='closed',updated=? WHERE id=?").run(clock(),id);
      event(id,'system','closed','اكتمل الطلب والتحصيل.');
    }
  }
  function createRestaurant({name,city,slug,password}) {
    demand(typeof slug==='string' && slugPattern.test(slug),'معرّف المطعم يجب أن يكون أحرفًا إنجليزية صغيرة وأرقامًا وشرطات فقط (3-40 حرفًا).',400);
    demand(typeof name==='string' && name.trim().length>=2 && name.length<=60,'اسم المطعم غير صالح.',400);
    demand(typeof city==='string' && city.trim().length>=2 && city.length<=60,'اسم المدينة غير صالح.',400);
    demand(typeof password==='string' && password.length>=12 && password.length<=200,'كلمة المرور يجب ألا تقل عن 12 حرفًا.',400);
    demand(!restaurantBySlug(slug),'معرّف المطعم هذا مستخدم بالفعل. اختر معرّفًا آخر.');
    const {salt,hash}=hashPassword(password);
    const id=randomUUID();
    db.prepare('INSERT INTO restaurants(id,slug,name,city,password_salt,password_hash,accepting,capacity,fee,prep,created) VALUES(?,?,?,?,?,?,1,6,1000,20,?)').run(id,slug,name.trim(),city.trim(),salt,hash,clock());
    return restaurantById(id);
  }
  function authenticateRestaurant(slug,password) {
    const restaurant=restaurantBySlug(String(slug??''));
    if (!restaurant || !verifyPassword(password,restaurant.password_salt,restaurant.password_hash)) return undefined;
    return restaurant;
  }
  function createCourier({name,phone,password}) {
    demand(typeof name==='string' && name.trim().length>=2 && name.length<=60,'اسم المندوب غير صالح.',400);
    const cleanPhone=String(phone??'').replace(/[\s()-]/g,'');
    demand(phonePattern.test(cleanPhone),'أدخل رقم جوال سعودي صحيحًا.',400);
    demand(typeof password==='string' && password.length>=12 && password.length<=200,'كلمة المرور يجب ألا تقل عن 12 حرفًا.',400);
    demand(!courierByPhone(cleanPhone),'هذا الرقم مسجّل بالفعل. سجّل الدخول مباشرة.');
    const {salt,hash}=hashPassword(password);
    const id=randomUUID();
    db.prepare('INSERT INTO couriers(id,name,phone,password_salt,password_hash,created) VALUES(?,?,?,?,?,?)').run(id,name.trim(),cleanPhone,salt,hash,clock());
    return courierByPhone(cleanPhone);
  }
  function authenticateCourier(phone,password) {
    const courier=courierByPhone(String(phone??'').replace(/[\s()-]/g,''));
    if (!courier || !verifyPassword(password,courier.password_salt,courier.password_hash)) return undefined;
    return courier;
  }
  function createOrder(actor,key,body) {
    demand(actor.role==='customer','إنشاء الطلب متاح للعميل فقط.',403);
    return mutate(actor,key,'create_order',body,() => {
      demand(typeof body.restaurant==='string','اختر مطعمًا صحيحًا.',400);
      const restaurant=restaurantBySlug(body.restaurant);
      demand(restaurant,'المطعم غير موجود.',404);
      demand(Boolean(restaurant.accepting),'المطعم أوقف استقبال الطلبات مؤقتًا.');
      const count=db.prepare(`SELECT count(*) AS n FROM orders WHERE restaurant_id=? AND status IN (${active.map(()=>'?').join(',')})`).get(restaurant.id,...active).n;
      demand(count<restaurant.capacity,'المطعم وصل إلى طاقته الحالية. حاول لاحقًا.');
      for (const [field,min,max] of [['name',2,60],['district',2,80],['address',8,300]]) {
        demand(typeof body[field]==='string' && body[field].trim().length>=min && body[field].length<=max,'أكمل الاسم والحي والعنوان بشكل صحيح.',400);
      }
      const phone=String(body.phone??'').replace(/[\s()-]/g,'');
      demand(phonePattern.test(phone),'أدخل رقم جوال سعودي صحيحًا.',400);
      demand(typeof (body.note??'')==='string' && (body.note??'').length<=300,'الملاحظة أطول من المسموح.',400);
      demand(Array.isArray(body.items) && body.items.length>0 && body.items.length<=20,'أضف صنفًا إلى السلة.',400);
      const seen=new Set(); let total=restaurant.fee; let quantities=0;
      const items=body.items.map(item=>{
        demand(item && typeof item.id==='string' && Number.isInteger(item.quantity) && item.quantity>=1 && item.quantity<=10 && !seen.has(item.id),'كمية أو صنف غير صالح.',400);
        seen.add(item.id); quantities+=item.quantity;
        const product=db.prepare('SELECT * FROM products WHERE id=? AND restaurant_id=?').get(item.id,restaurant.id);
        demand(product,'الصنف غير متاح.',400); total+=product.price*item.quantity;
        return {...product,quantity:item.quantity};
      });
      demand(quantities<=20 && money(total),'تجاوز الطلب الحد المتاح لهذه التجربة.',400);
      const id=randomUUID(); const now=clock();
      db.prepare('INSERT INTO orders(id,restaurant_id,customer,status,payment_status,total,fee,items,name,phone,district,address,note,expires,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,restaurant.id,actor.actor_id,'awaiting_courier','pending',total,restaurant.fee,JSON.stringify(items),body.name.trim(),phone,body.district.trim(),body.address.trim(),body.note?.trim()??'',now+10*60_000,now,now);
      event(id,'customer','created','وصل الطلب؛ بانتظار قبول المندوب.');
      return view(row(id),actor);
    });
  }
  function act(actor,key,id,action,body={}) {
    return mutate(actor,key,`${id}:${action}`,body,()=>{
      let order=row(id); demand(order,'الطلب غير موجود.',404);
      const staff=actor.role==='restaurant' && order.restaurant_id===actor.actor_id;
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
          demand(!busy,'أكمل مهمتك الحالية وتسوية تحصيلها قبل قبول مهمة أخرى.');
          db.prepare("UPDATE orders SET courier=?,status='reserved',expires=?,updated=? WHERE id=? AND status='awaiting_courier'").run(actor.actor_id,clock()+3*60_000,clock(),id);
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
          set('out_for_delivery'); detail='استلم المندوب الطلب.'; break;
        case 'collect':
          requireRole(courier); requireState('out_for_delivery');
          demand(['pending','failed'].includes(order.payment_status),'تم تسجيل التحصيل من قبل.');
          demand(body.amount===order.total,'يجب تسجيل كامل المبلغ المستحق نقدًا.',400);
          db.prepare("UPDATE orders SET payment_status='collected',updated=? WHERE id=?").run(clock(),id);
          detail='سجل المندوب تحصيل المبلغ نقدًا، ويحتفظ برسوم توصيله منه فورًا.'; break;
        case 'payment_failed':
          requireRole(courier); requireState('out_for_delivery'); demand(order.payment_status==='pending','لا يمكن تسجيل تعثر بعد التحصيل.');
          db.prepare("UPDATE orders SET payment_status='failed',updated=? WHERE id=?").run(clock(),id);
          detail='تعذر التحصيل. التسليم متوقف إلى حين المعالجة.'; break;
        case 'deliver':
          requireRole(courier); requireState('out_for_delivery');
          demand(order.payment_status==='collected','سجل التحصيل أولًا أو بلّغ عن تعثر الدفع.');
          set('delivered'); detail='تم التسليم؛ تسوية المطعم مع المندوب ما زالت مفتوحة.'; break;
        case 'settle': {
          requireRole(staff); requireState('delivered');
          demand(order.payment_status==='collected','التحصيل غير قابل للتسوية الآن.');
          const dueToRestaurant=order.total-order.fee;
          demand(body.amount===dueToRestaurant,'قيمة التسوية يجب أن تطابق سعر الأصناف بعد خصم رسوم توصيل المندوب.',400);
          db.prepare("UPDATE orders SET payment_status='settled',updated=? WHERE id=?").run(clock(),id);
          detail='أكد المطعم استلام مستحقاته من المندوب.'; break;
        }
        case 'cancel':
          requireRole(customer || staff); customer ? requireState('awaiting_courier','reserved','confirmed') : requireState('awaiting_courier','reserved','confirmed','preparing','ready');
          set('cancelled'); detail='ألغي الطلب قبل التسليم.'; break;
        case 'delivery_failed':
          requireRole(courier); requireState('out_for_delivery'); demand(['pending','failed'].includes(order.payment_status),'تواصل مع المطعم لمعالجة طلب تم تحصيله.');
          demand(typeof body.reason==='string' && body.reason.trim().length>=5 && body.reason.length<=200,'اذكر سبب التعثر.',400);
          set('delivery_failed'); detail=body.reason.trim(); break;
        case 'confirm_return':
          requireRole(staff); requireState('delivery_failed');
          set('cancelled'); detail='أكد المطعم عودة الطلب المتعثر دون تحصيل.'; break;
        default: throw new Fault('الخطوة غير معروفة.',400);
      }
      event(id,actor.role,action,detail); closeIfSettled(id);
      return view(row(id),actor);
    });
  }
  return {
    db, close:()=>db.close(),
    restaurants:()=>db.prepare('SELECT slug,name,city,accepting FROM restaurants ORDER BY name').all(),
    me(actor) {
      demand(actor.role==='restaurant','غير مسموح.',403);
      const restaurant=restaurantById(actor.actor_id);
      demand(restaurant,'المطعم غير موجود.',404);
      const {password_salt,password_hash,...pub}=restaurant;
      return {restaurant:pub,products:db.prepare('SELECT * FROM products WHERE restaurant_id=? ORDER BY rowid').all(actor.actor_id)};
    },
    catalog(slug) {
      const restaurant=restaurantBySlug(slug);
      demand(restaurant,'المطعم غير موجود.',404);
      const {password_salt,password_hash,...pub}=restaurant;
      return {restaurant:pub,products:db.prepare('SELECT * FROM products WHERE restaurant_id=? ORDER BY rowid').all(restaurant.id)};
    },
    createRestaurant, authenticateRestaurant, createCourier, authenticateCourier,
    addProduct(actor,body) {
      demand(actor.role==='restaurant','غير مسموح.',403);
      demand(typeof body.name==='string' && body.name.trim().length>=2 && body.name.length<=60,'اسم الصنف غير صالح.',400);
      demand(typeof body.description==='string' && body.description.length<=200,'وصف الصنف طويل جدًا.',400);
      demand(Number.isInteger(body.price) && body.price>=100 && body.price<=100_000,'سعر الصنف يجب أن يكون بالهللة بين 1 و1000 ريال.',400);
      const id=randomUUID();
      db.prepare('INSERT INTO products(id,restaurant_id,name,description,price) VALUES(?,?,?,?,?)').run(id,actor.actor_id,body.name.trim(),body.description.trim(),body.price);
      return db.prepare('SELECT * FROM products WHERE id=?').get(id);
    },
    removeProduct(actor,productId) {
      demand(actor.role==='restaurant','غير مسموح.',403);
      const result=db.prepare('DELETE FROM products WHERE id=? AND restaurant_id=?').run(productId,actor.actor_id);
      demand(result.changes>0,'الصنف غير موجود.',404);
      return {ok:true};
    },
    createSession(role='customer',actorId=randomUUID()) {
      const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
      const session={role,actor_id:actorId,csrf,expires:clock()+24*3600_000};
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(clock());
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(token),role,actorId,csrf,session.expires);
      return {token,...session};
    },
    getSession:token=>token ? db.prepare('SELECT role,actor_id,csrf,expires FROM sessions WHERE token_hash=? AND expires>?').get(digest(token),clock()) : undefined,
    removeSession:token=>{if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));},
    orders(actor) { return transaction(()=>{expire();return db.prepare('SELECT * FROM orders ORDER BY created DESC').all().filter(o=>(actor.role==='restaurant'&&o.restaurant_id===actor.actor_id)||(actor.role==='customer'&&o.customer===actor.actor_id)||(actor.role==='courier'&&(o.status==='awaiting_courier'||o.courier===actor.actor_id))).map(o=>view(o,actor));}); },
    order(actor,id) {return transaction(()=>{expire();return view(row(id),actor);});},
    settings(actor,key,body) {
      demand(actor.role==='restaurant','غير مسموح.',403);
      return mutate(actor,key,'settings',body,()=>{
        demand(typeof body.accepting==='boolean' && Number.isInteger(body.capacity) && body.capacity>=1 && body.capacity<=20,'طاقة المطعم يجب أن تكون بين 1 و20 طلبًا.',400);
        const whatsapp=String(body.whatsappNumber??'').replace(/[\s()-]/g,'');
        demand(whatsapp==='' || phonePattern.test(whatsapp),'أدخل رقم واتساب سعودي صحيحًا (05xxxxxxxx).',400);
        db.prepare('UPDATE restaurants SET accepting=?,capacity=?,whatsapp_number=? WHERE id=?').run(Number(body.accepting),body.capacity,whatsapp||null,actor.actor_id);
        return restaurantById(actor.actor_id);
      });
    },
    billing(actor) {
      demand(actor.role==='restaurant','غير مسموح.',403);
      const now=new Date(clock());
      const start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1);
      const end=Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1);
      const closed=db.prepare("SELECT count(*) AS n FROM orders WHERE restaurant_id=? AND status='closed' AND updated>=? AND updated<?").get(actor.actor_id,start,end).n;
      const orderFeeTotal=closed*PLATFORM_ORDER_FEE;
      return {periodStart:start,periodEnd:end,ordersCount:closed,orderFeeTotal,subscriptionFee:PLATFORM_MONTHLY_FEE,total:orderFeeTotal+PLATFORM_MONTHLY_FEE};
    },
    createOrder, act
  };
}
