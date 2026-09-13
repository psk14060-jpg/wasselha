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

const customer={role:'customer',actor_id:'customer-a'};
const merchant={role:'restaurant',actor_id:'restaurant-1'};
const courier={role:'courier',actor_id:'courier-1'};
const payload=(payment='cash')=>({name:'عميل اختبار',phone:'0500000000',district:'حي تجريبي',address:'شارع الاختبار مبنى 10',payment,items:[{id:'pizza42',quantity:1}]});
const key=()=>randomUUID();
const expected=(status=409)=>error=>error instanceof Fault&&error.status===status;
const action=(s,a,id,name,body={})=>s.act(a,key(),id,name,body);
const prepare=(s,order)=>{
  action(s,courier,order.id,'accept');action(s,customer,order.id,'confirm');
  action(s,merchant,order.id,'prepare');action(s,merchant,order.id,'ready');
  action(s,courier,order.id,'pickup',{deviceReceived:true});
};

test('server prices, duplicate submissions and changed-payload replay',t=>{
  const s=createStore();t.after(()=>s.close());const body=payload();body.total=1;body.items[0].price=1;
  const request=key();const a=s.createOrder(customer,request,body);const b=s.createOrder(customer,request,body);
  assert.equal(a.total,8000);assert.equal(a.id,b.id);assert.equal(s.orders(customer).length,1);
  assert.throws(()=>s.createOrder(customer,request,{...body,name:'عميل آخر'}),expected());
  assert.throws(()=>s.createOrder(merchant,key(),payload()),expected(403));
  assert.throws(()=>s.createOrder(customer,key(),{...payload(),items:[{id:'pizza42',quantity:-1}]}),expected(400));
});
test('cash journey requires courier, customer confirmation, collection and merchant settlement',t=>{
  const s=createStore();t.after(()=>s.close());const order=s.createOrder(customer,key(),payload());
  assert.throws(()=>action(s,merchant,order.id,'prepare'),expected());
  action(s,courier,order.id,'accept');assert.throws(()=>action(s,merchant,order.id,'prepare'),expected());
  action(s,customer,order.id,'confirm');action(s,merchant,order.id,'prepare');action(s,merchant,order.id,'ready');
  action(s,courier,order.id,'pickup');assert.throws(()=>action(s,courier,order.id,'deliver'),expected());
  assert.throws(()=>action(s,courier,order.id,'collect',{amount:7999}),expected(400));
  action(s,courier,order.id,'collect',{amount:8000});
  const delivered=action(s,courier,order.id,'deliver');assert.equal(delivered.status,'delivered');assert.equal(delivered.payment_status,'cash_collected');
  const next=s.createOrder(customer,key(),payload());assert.throws(()=>action(s,courier,next.id,'accept'),expected());
  const settled=action(s,merchant,order.id,'settle',{amount:8000});assert.equal(settled.status,'closed');
  assert.equal(action(s,courier,next.id,'accept').status,'reserved');
  assert.throws(()=>action(s,courier,order.id,'collect',{amount:8000}),expected());
});
test('POS reservation and physical custody are released only by merchant acknowledgement',t=>{
  const s=createStore();t.after(()=>s.close());const order=s.createOrder(customer,key(),payload('card'));
  assert.throws(()=>s.createOrder(customer,key(),payload('card')),expected());
  action(s,courier,order.id,'accept');action(s,customer,order.id,'confirm');action(s,merchant,order.id,'prepare');action(s,merchant,order.id,'ready');
  assert.throws(()=>action(s,courier,order.id,'pickup'),expected(400));
  action(s,courier,order.id,'pickup',{deviceReceived:true});
  assert.throws(()=>action(s,merchant,order.id,'confirm_device'),expected());
  action(s,courier,order.id,'collect',{amount:8000,receipt:'TEST-001'});action(s,courier,order.id,'deliver');
  assert.equal(s.device(merchant).state,'with_courier');
  assert.equal(action(s,merchant,order.id,'settle',{amount:8000}).status,'delivered');
  action(s,courier,order.id,'return_device');assert.equal(s.device(merchant).state,'pending_confirmation');
  assert.throws(()=>s.createOrder(customer,key(),payload('card')),expected());
  assert.equal(action(s,merchant,order.id,'confirm_device').status,'closed');assert.equal(s.device(merchant).state,'available');
  assert.ok(s.createOrder(customer,key(),payload('card')).id);
});
test('expiry releases both courier reservation and reserved terminal',t=>{
  let now=Date.now();const s=createStore(':memory:',()=>now);t.after(()=>s.close());
  const order=s.createOrder(customer,key(),payload('card'));action(s,courier,order.id,'accept');
  now+=181_000;
  assert.equal(s.order(customer,order.id).status,'expired');assert.equal(s.device(merchant).state,'available');
  assert.throws(()=>action(s,customer,order.id,'confirm'),expected());
  const next=s.createOrder(customer,key(),payload('card'));assert.equal(action(s,courier,next.id,'accept').status,'reserved');
});
test('capacity and pause gate intake while existing orders continue',t=>{
  const s=createStore();t.after(()=>s.close());s.settings(merchant,key(),{accepting:true,capacity:1});
  const order=s.createOrder(customer,key(),payload());assert.throws(()=>s.createOrder(customer,key(),payload()),expected());
  s.settings(merchant,key(),{accepting:false,capacity:2});assert.throws(()=>s.createOrder(customer,key(),payload()),expected());
  action(s,courier,order.id,'accept');assert.equal(action(s,customer,order.id,'confirm').status,'confirmed');
  assert.equal(action(s,merchant,order.id,'prepare').status,'preparing');
  assert.throws(()=>s.settings(courier,key(),{accepting:true,capacity:10}),expected(403));
});
test('other customers cannot inspect orders; unassigned couriers see no contact details',t=>{
  const s=createStore();t.after(()=>s.close());const order=s.createOrder(customer,key(),payload());
  const other={role:'customer',actor_id:'customer-b'};
  assert.equal(s.orders(other).length,0);assert.throws(()=>s.order(other,order.id),expected(404));
  const offer=s.order(courier,order.id);for(const field of ['name','phone','address','note','receipt','customer'])assert.equal(offer[field],undefined);
  assert.throws(()=>action(s,other,order.id,'cancel'),expected(403));
  action(s,courier,order.id,'accept');assert.equal(s.order(courier,order.id).phone,'0500000000');
  assert.throws(()=>s.order({role:'courier',actor_id:'courier-2'},order.id),expected(404));
});
test('failed delivery leaves custody open until the terminal and order return',t=>{
  const s=createStore();t.after(()=>s.close());const order=s.createOrder(customer,key(),payload('card'));prepare(s,order);
  action(s,courier,order.id,'payment_failed');assert.throws(()=>action(s,courier,order.id,'deliver'),expected());
  action(s,courier,order.id,'delivery_failed',{reason:'تعذر الوصول للعميل'});
  assert.throws(()=>action(s,merchant,order.id,'confirm_return'),expected());
  action(s,courier,order.id,'return_device');action(s,merchant,order.id,'confirm_device');
  assert.equal(action(s,merchant,order.id,'confirm_return').status,'cancelled');assert.equal(s.device(merchant).state,'available');
});
test('cancelling before pickup releases a reserved POS; courier cannot cancel for the customer',t=>{
  const s=createStore();t.after(()=>s.close());const order=s.createOrder(customer,key(),payload('card'));action(s,courier,order.id,'accept');
  assert.throws(()=>action(s,courier,order.id,'cancel'),expected(403));
  assert.equal(action(s,customer,order.id,'cancel').status,'cancelled');assert.equal(s.device(merchant).state,'available');
});
test('orders and sessions persist after closing and reopening the database',t=>{
  const dir=mkdtempSync(join(tmpdir(),'wasselha-db-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');
  let s=createStore(path);const session=s.createSession();const order=s.createOrder(session,key(),payload());s.close();
  s=createStore(path);assert.equal(s.getSession(session.token).actor_id,session.actor_id);assert.equal(s.order(session,order.id).id,order.id);s.close();
});

test('HTTP protects staff sessions and rejects CSRF; concurrent accepts produce one winner',async t=>{
  const {server,store}=buildServer({database:':memory:',restaurantPassword:'restaurant-test-secret-1',courierPassword:'courier-test-secret-2'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;const cookies=new Map(),sessions={};
  async function call(path,{role='customer',method='GET',body,headers={}}={}) {
    const res=await fetch(base+path,{method,headers:{'X-Wasselha-Role':role,...(body?{'Content-Type':'application/json','X-CSRF-Token':sessions[role]?.csrf??'','Idempotency-Key':key()}:{}),Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body?JSON.stringify(body):undefined});
    for(const value of res.headers.getSetCookie()){assert.match(value,/HttpOnly/);const [k,v]=value.split(';')[0].split('=');cookies.set(k,v);}
    return {status:res.status,body:await res.json()};
  }
  assert.equal((await call('/api/orders',{role:'restaurant'})).status,401);
  sessions.customer=(await call('/api/session')).body;
  assert.equal((await call('/api/orders',{method:'POST',body:payload(),headers:{'X-CSRF-Token':'forged'}})).status,403);
  assert.equal((await call('/api/orders',{method:'POST',body:payload(),headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await call('/api/login',{method:'POST',body:{role:'restaurant',password:'wrong-password'}})).status,401);
  const logged=await call('/api/login',{method:'POST',body:{role:'courier',password:'courier-test-secret-2'}});assert.equal(logged.status,200);sessions.courier=logged.body;
  const created=await call('/api/orders',{method:'POST',body:payload()});assert.equal(created.status,201);
  const order=created.body;
  const results=await Promise.all([call(`/api/orders/${order.id}/actions/accept`,{role:'courier',method:'POST',body:{}}),call(`/api/orders/${order.id}/actions/accept`,{role:'courier',method:'POST',body:{}})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call(`/api/orders/${order.id}`)).body.id,order.id);
});

test('standalone server starts and serves the application assets',async()=>{
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:':memory:',RESTAURANT_PASSWORD:'cli-restaurant-test-password',COURIER_PASSWORD:'cli-courier-test-password'},stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try {
    const [output]=await once(child.stdout,'data');const base=output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(base);
    const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
    for(const [path,marker] of [['/','وصّلها'],['/app.js','renderShop'],['/styles.css','--green']]) {
      const response=await fetch(base+path);assert.equal(response.status,200);assert.ok((await response.text()).includes(marker));
    }
  }finally{clearTimeout(timer);child.kill('SIGTERM');await once(child,'exit');}
});
