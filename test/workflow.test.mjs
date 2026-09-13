import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStore, Fault } from '../src/store.mjs';
import { buildServer } from '../src/server.mjs';

const key=()=>randomUUID();
const expected=(status=409)=>error=>error instanceof Fault&&error.status===status;
const action=(s,a,id,name,body={})=>s.act(a,key(),id,name,body);
let phoneSeq=0;
const phone=()=>`05${String(10000000+(phoneSeq++)).slice(0,8)}`;

function bootRestaurant(s,overrides={}) {
  const restaurant=s.createRestaurant({name:'ميني قيش',city:'الأحساء',slug:`mini-gish-${randomUUID().slice(0,8)}`,password:'restaurant-test-password-1',...overrides});
  const staff={role:'restaurant',actor_id:restaurant.id};
  const product=s.addProduct(staff,{name:'كب بيتزا',description:'42 قطعة',price:6500});
  return {restaurant,staff,product};
}
function bootCourier(s) {
  const courier=s.createCourier({name:'مندوب تجربة',phone:phone(),password:'courier-test-password-1'});
  return {courier,actor:{role:'courier',actor_id:courier.id}};
}
const payload=(restaurant,product,over={})=>({name:'عميل اختبار',phone:'0500000000',district:'حي تجريبي',address:'شارع الاختبار مبنى 10',restaurant:restaurant.slug,items:[{id:product.id,quantity:1}],...over});
const prepare=(s,merchant,courier,order)=>{
  action(s,courier,order.id,'accept');action(s,{role:'customer',actor_id:order.customer_actor??'customer-a'},order.id,'confirm');
  action(s,merchant,order.id,'prepare');action(s,merchant,order.id,'ready');
  action(s,courier,order.id,'pickup');
};

test('orders price from server data, reject duplicate submissions and changed-payload replay',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,staff,product}=bootRestaurant(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const body=payload(restaurant,product);body.total=1;body.items[0].price=1;
  const request=key();const a=s.createOrder(customer,request,body);const b=s.createOrder(customer,request,body);
  assert.equal(a.total,7500);assert.equal(a.id,b.id);assert.equal(s.orders(customer).length,1);
  assert.throws(()=>s.createOrder(customer,request,{...body,name:'عميل آخر'}),expected());
  assert.throws(()=>s.createOrder(staff,key(),payload(restaurant,product)),expected(403));
  assert.throws(()=>s.createOrder(customer,key(),{...payload(restaurant,product),items:[{id:product.id,quantity:-1}]}),expected(400));
  assert.throws(()=>s.createOrder(customer,key(),{...payload(restaurant,product),restaurant:'no-such-restaurant'}),expected(404));
});

test('cash journey requires courier, customer confirmation, collection and merchant settlement',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,staff,product}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const order=s.createOrder(customer,key(),payload(restaurant,product));
  assert.throws(()=>action(s,staff,order.id,'prepare'),expected());
  action(s,courier,order.id,'accept');assert.throws(()=>action(s,staff,order.id,'prepare'),expected());
  action(s,customer,order.id,'confirm');action(s,staff,order.id,'prepare');action(s,staff,order.id,'ready');
  action(s,courier,order.id,'pickup');assert.throws(()=>action(s,courier,order.id,'deliver'),expected());
  assert.throws(()=>action(s,courier,order.id,'collect',{amount:7499}),expected(400));
  action(s,courier,order.id,'collect',{amount:7500});
  const delivered=action(s,courier,order.id,'deliver');assert.equal(delivered.status,'delivered');assert.equal(delivered.payment_status,'collected');
  const next=s.createOrder(customer,key(),payload(restaurant,product));assert.throws(()=>action(s,courier,next.id,'accept'),expected());
  assert.throws(()=>action(s,staff,order.id,'settle',{amount:7500}),expected(400));
  const settled=action(s,staff,order.id,'settle',{amount:6500});assert.equal(settled.status,'closed');
  assert.equal(action(s,courier,next.id,'accept').status,'reserved');
  assert.throws(()=>action(s,courier,order.id,'collect',{amount:7500}),expected());
});

test('independent courier works across restaurants but only one active task at a time',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant:r1,staff:staff1,product:p1}=bootRestaurant(s);
  const {restaurant:r2,staff:staff2,product:p2}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const order1=s.createOrder(customer,key(),payload(r1,p1));
  const order2=s.createOrder(customer,key(),payload(r2,p2));
  action(s,courier,order1.id,'accept');
  assert.throws(()=>action(s,courier,order2.id,'accept'),expected());
  action(s,customer,order1.id,'confirm');action(s,staff1,order1.id,'prepare');action(s,staff1,order1.id,'ready');
  action(s,courier,order1.id,'pickup');action(s,courier,order1.id,'collect',{amount:order1.total});action(s,courier,order1.id,'deliver');
  action(s,staff1,order1.id,'settle',{amount:order1.total-order1.fee});
  assert.equal(action(s,courier,order2.id,'accept').status,'reserved');
  assert.throws(()=>action(s,staff2,order2.id,'prepare'),expected(),'restaurant two cannot act on an order that is still awaiting its own confirmation step');
});

test('expiry releases the courier reservation so another courier can accept',t=>{
  let now=Date.now();const s=createStore(':memory:',()=>now);t.after(()=>s.close());
  const {restaurant,product}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const order=s.createOrder(customer,key(),payload(restaurant,product));action(s,courier,order.id,'accept');
  now+=181_000;
  assert.equal(s.order(customer,order.id).status,'expired');
  assert.throws(()=>action(s,customer,order.id,'confirm'),expected());
  const next=s.createOrder(customer,key(),payload(restaurant,product));assert.equal(action(s,courier,next.id,'accept').status,'reserved');
});

test('capacity and pause gate intake per restaurant, without affecting other restaurants',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant:r1,staff:staff1,product:p1}=bootRestaurant(s);
  const {restaurant:r2,product:p2}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  s.settings(staff1,key(),{accepting:true,capacity:1});
  const order=s.createOrder(customer,key(),payload(r1,p1));assert.throws(()=>s.createOrder(customer,key(),payload(r1,p1)),expected());
  assert.ok(s.createOrder(customer,key(),payload(r2,p2)).id,'restaurant two is unaffected by restaurant one reaching capacity');
  s.settings(staff1,key(),{accepting:false,capacity:2});assert.throws(()=>s.createOrder(customer,key(),payload(r1,p1)),expected());
  action(s,courier,order.id,'accept');assert.equal(action(s,customer,order.id,'confirm').status,'confirmed');
  assert.equal(action(s,staff1,order.id,'prepare').status,'preparing');
  assert.throws(()=>s.settings({role:'courier',actor_id:courier.actor_id},key(),{accepting:true,capacity:10}),expected(403));
});

test('other customers cannot inspect orders; unassigned couriers see no contact details',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,product}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const order=s.createOrder(customer,key(),payload(restaurant,product));
  const other={role:'customer',actor_id:'customer-b'};
  assert.equal(s.orders(other).length,0);assert.throws(()=>s.order(other,order.id),expected(404));
  const offer=s.order(courier,order.id);for(const field of ['name','phone','address','note'])assert.equal(offer[field],undefined);
  assert.throws(()=>action(s,other,order.id,'cancel'),expected(403));
  action(s,courier,order.id,'accept');assert.equal(s.order(courier,order.id).phone,'0500000000');
  const {actor:otherCourier}=bootCourier(s);
  assert.throws(()=>s.order(otherCourier,order.id),expected(404));
});

test('failed delivery lets the restaurant close the order without payment',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,staff,product}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const order=s.createOrder(customer,key(),payload(restaurant,product));
  action(s,courier,order.id,'accept');action(s,customer,order.id,'confirm');action(s,staff,order.id,'prepare');action(s,staff,order.id,'ready');action(s,courier,order.id,'pickup');
  action(s,courier,order.id,'payment_failed');assert.throws(()=>action(s,courier,order.id,'deliver'),expected());
  action(s,courier,order.id,'delivery_failed',{reason:'تعذر الوصول للعميل'});
  assert.equal(action(s,staff,order.id,'confirm_return').status,'cancelled');
});

test('cancelling before pickup works for the customer, not the courier',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,product}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  const order=s.createOrder(customer,key(),payload(restaurant,product));action(s,courier,order.id,'accept');
  assert.throws(()=>action(s,courier,order.id,'cancel'),expected(403));
  assert.equal(action(s,customer,order.id,'cancel').status,'cancelled');
});

test('restaurant sets a WhatsApp number, exposed to the customer on the order for a manual ping',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,staff,product}=bootRestaurant(s);
  const customer={role:'customer',actor_id:'customer-a'};
  assert.throws(()=>s.settings(staff,key(),{accepting:true,capacity:6,whatsappNumber:'not-a-phone'}),expected(400));
  s.settings(staff,key(),{accepting:true,capacity:6,whatsappNumber:'0511111111'});
  assert.equal(s.catalog(restaurant.slug).restaurant.whatsapp_number,'0511111111');
  const order=s.createOrder(customer,key(),payload(restaurant,product));
  assert.equal(order.restaurant.whatsappNumber,'0511111111');
});

test('billing totals monthly subscription plus a flat fee per closed order',t=>{
  const s=createStore();t.after(()=>s.close());
  const {restaurant,staff,product}=bootRestaurant(s);
  const {actor:courier}=bootCourier(s);
  const customer={role:'customer',actor_id:'customer-a'};
  let bill=s.billing(staff);assert.equal(bill.ordersCount,0);assert.equal(bill.total,9900);
  const order=s.createOrder(customer,key(),payload(restaurant,product));
  action(s,courier,order.id,'accept');action(s,customer,order.id,'confirm');action(s,staff,order.id,'prepare');action(s,staff,order.id,'ready');
  action(s,courier,order.id,'pickup');action(s,courier,order.id,'collect',{amount:order.total});action(s,courier,order.id,'deliver');
  action(s,staff,order.id,'settle',{amount:order.total-order.fee});
  bill=s.billing(staff);assert.equal(bill.ordersCount,1);assert.equal(bill.orderFeeTotal,200);assert.equal(bill.total,10100);
});

test('restaurants and couriers persist after closing and reopening the database',t=>{
  const dir=mkdtempSync(join(tmpdir(),'wasselha-db-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');
  let s=createStore(path);const {restaurant,product}=bootRestaurant(s);const session=s.createSession();
  const order=s.createOrder(session,key(),payload(restaurant,product));s.close();
  s=createStore(path);
  assert.equal(s.getSession(session.token).actor_id,session.actor_id);
  assert.equal(s.order(session,order.id).id,order.id);
  assert.equal(s.authenticateRestaurant(restaurant.slug,'restaurant-test-password-1').id,restaurant.id);
  s.close();
});

test('HTTP: restaurant and courier self-signup, CSRF protection, concurrent accepts produce one winner',async t=>{
  const {server,store}=buildServer({database:':memory:'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;const cookies=new Map(),sessions={};
  async function call(path,{role='customer',method,body,headers={}}={}) {
    const res=await fetch(base+path,{method:method??(body?'POST':'GET'),headers:{'X-Wasselha-Role':role,...(body!==undefined||method==='DELETE'?{'X-CSRF-Token':sessions[role]?.csrf??'',...(body!==undefined?{'Content-Type':'application/json','Idempotency-Key':key()}:{})}:{}),Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body?JSON.stringify(body):undefined});
    for(const value of res.headers.getSetCookie()){assert.match(value,/HttpOnly/);const [k,v]=value.split(';')[0].split('=');cookies.set(k,v);}
    return {status:res.status,body:await res.json()};
  }
  assert.equal((await call('/api/orders',{role:'restaurant'})).status,401);
  sessions.customer=(await call('/api/session')).body;
  const slug=`mini-gish-${randomUUID().slice(0,8)}`;
  const signedUp=await call('/api/restaurants/signup',{role:'customer',body:{name:'ميني قيش',city:'الأحساء',slug,password:'restaurant-test-password-1'}});
  assert.equal(signedUp.status,201);sessions.restaurant=signedUp.body;
  assert.equal((await call('/api/orders',{method:'POST',body:{},headers:{'X-CSRF-Token':'forged'}})).status,403);
  assert.equal((await call('/api/orders',{method:'POST',body:{restaurant:slug},headers:{Origin:'https://other.example'}})).status,403);
  const product=await call('/api/restaurant/products',{role:'restaurant',method:'POST',body:{name:'كب بيتزا',description:'42 قطعة',price:6500}});
  assert.equal(product.status,201);
  const courierSignup=await call('/api/couriers/signup',{role:'customer',body:{name:'مندوب تجربة',phone:'0511111111',password:'courier-test-password-1'}});
  assert.equal(courierSignup.status,201);sessions.courier=courierSignup.body;
  assert.equal((await call('/api/login',{role:'customer',method:'POST',body:{role:'restaurant',slug,password:'wrong-password'}})).status,401);
  const order=await call('/api/orders',{method:'POST',body:{name:'عميل اختبار',phone:'0500000000',district:'حي',address:'شارع الاختبار مبنى 10',restaurant:slug,items:[{id:product.body.id,quantity:1}]}});
  assert.equal(order.status,201);
  const results=await Promise.all([call(`/api/orders/${order.body.id}/actions/accept`,{role:'courier',method:'POST',body:{}}),call(`/api/orders/${order.body.id}/actions/accept`,{role:'courier',method:'POST',body:{}})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call(`/api/orders/${order.body.id}`)).body.id,order.body.id);
  assert.equal((await call('/api/restaurants')).body.restaurants.some(r=>r.slug===slug),true);
});

test('standalone server starts and serves the application assets',async()=>{
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:':memory:'},stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try {
    const [output]=await once(child.stdout,'data');const base=output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(base);
    const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
    for(const [path,marker] of [['/','وصّلها'],['/app.js','renderShop'],['/styles.css','--green']]) {
      const response=await fetch(base+path);assert.equal(response.status,200);assert.ok((await response.text()).includes(marker));
    }
  }finally{clearTimeout(timer);child.kill('SIGTERM');await once(child,'exit');}
});
