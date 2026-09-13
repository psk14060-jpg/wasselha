import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createStore, Fault } from './store.mjs';

const roles=['customer','restaurant','courier'];
const publicRoot=new URL('../public/',import.meta.url);
const assets=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/styles.css',['styles.css','text/css']],['/icon.svg',['icon.svg','image/svg+xml']]]);
export function buildServer(config={}) {
  const store=config.store??createStore(config.database??process.env.DATABASE_PATH??'./data/wasselha.sqlite');
  const passwords={restaurant:config.restaurantPassword??process.env.RESTAURANT_PASSWORD,courier:config.courierPassword??process.env.COURIER_PASSWORD};
  if(Object.values(passwords).some(p=>typeof p!=='string'||p.length<12)) throw new Error('شغّل npm run setup أولًا. يلزم تعيين كلمتي مرور مختلفتين لا تقلان عن 12 حرفًا.');
  if(passwords.restaurant===passwords.courier) throw new Error('يجب أن تختلف كلمة مرور المطعم عن كلمة مرور المندوب.');
  const salt=randomBytes(24);
  const hashes=Object.fromEntries(Object.entries(passwords).map(([k,v])=>[k,scryptSync(v,salt,32)]));
  const secure=config.secure??process.env.COOKIE_SECURE==='true';
  const attempts=new Map();
  const rate=(req,kind,max)=>{
    const now=Date.now(); const key=`${kind}:${req.socket.remoteAddress}`;
    if(attempts.size>1000) for(const [k,v] of attempts) if(v.until<now) attempts.delete(k);
    if(attempts.size>1000) throw new Fault('الخدمة مشغولة. حاول لاحقًا.',429);
    let data=attempts.get(key); if(!data||data.until<now) {data={count:0,until:now+15*60_000}; attempts.set(key,data);}
    if(++data.count>max) throw new Fault('محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',429);
  };
  const cookie=(role,token,age=86400)=>`wasselha_${role}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  async function bodyOf(req) {
    if(!String(req.headers['content-type']??'').startsWith('application/json')) throw new Fault('صيغة الطلب غير مدعومة.',415);
    let text=''; for await(const chunk of req) {text+=chunk; if(Buffer.byteLength(text)>20_000) throw new Fault('الطلب أكبر من المسموح.',413);}
    try {const body=JSON.parse(text); if(!body||typeof body!=='object'||Array.isArray(body))throw new Error(); return body;} catch{throw new Fault('بيانات الطلب غير صالحة.',400);}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health') return json(res,200,{ok:true,service:'wasselha'});
      if(req.method==='GET'&&assets.has(url.pathname)) {
        const [file,type]=assets.get(url.pathname);res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-cache'});return res.end(readFileSync(new URL(file,publicRoot)));
      }
      if(!url.pathname.startsWith('/api/')) throw new Fault('الصفحة غير موجودة.',404);
      const role=String(req.headers['x-wasselha-role']??'customer');
      if(!roles.includes(role)) throw new Fault('الدور غير صالح.',400);
      const cookies=Object.fromEntries(String(req.headers.cookie??'').split(';').map(p=>p.trim().split('=')).filter(p=>p.length===2));
      const token=cookies[`wasselha_${role}`];
      let session=store.getSession(token);
      if(session&&session.role!==role) session=undefined;
      if(req.method==='GET'&&url.pathname==='/api/session') {
        if(!session&&role==='customer') {rate(req,'session',100);session=store.createSession();res.setHeader('Set-Cookie',cookie('customer',session.token));}
        return json(res,200,session?{role:session.role,csrf:session.csrf,demo:true}:{role:'anonymous',requestedRole:role,demo:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/catalog') return json(res,200,store.catalog());
      if(!session) throw new Fault('انتهت الجلسة. افتح الصفحة من جديد أو سجل الدخول.',401);
      if(req.method==='POST') {
        const origin=req.headers.origin;
        if(origin&&new URL(origin).host!==req.headers.host) throw new Fault('مصدر الطلب غير مسموح.',403);
        if(req.headers['x-csrf-token']!==session.csrf) throw new Fault('تعذر التحقق من الجلسة. حدّث الصفحة.',403);
        const body=await bodyOf(req); const key=req.headers['idempotency-key'];
        if(url.pathname==='/api/login') {
          rate(req,'login',12);
          if(!['restaurant','courier'].includes(body.role)||typeof body.password!=='string'||body.password.length>200) throw new Fault('بيانات الدخول غير صحيحة.',401);
          if(!timingSafeEqual(scryptSync(body.password,salt,32),hashes[body.role])) throw new Fault('بيانات الدخول غير صحيحة.',401);
          const previous=cookies[`wasselha_${body.role}`]; store.removeSession(previous);
          const next=store.createSession(body.role,body.role==='restaurant'?'restaurant-1':'courier-1');
          res.setHeader('Set-Cookie',cookie(body.role,next.token));return json(res,200,{role:next.role,csrf:next.csrf,demo:true});
        }
        if(url.pathname==='/api/logout') {store.removeSession(token);res.setHeader('Set-Cookie',cookie(role,'',0));return json(res,200,{ok:true});}
        if(url.pathname==='/api/orders') {rate(req,'orders',60);return json(res,201,store.createOrder(session,key,body));}
        if(url.pathname==='/api/restaurant/settings') return json(res,200,store.settings(session,key,body));
        const action=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})\/actions\/([a-z_]+)$/);
        if(action) return json(res,200,store.act(session,key,action[1],action[2],body));
      }
      if(req.method==='GET') {
        if(url.pathname==='/api/orders') return json(res,200,{orders:store.orders(session)});
        if(url.pathname==='/api/restaurant/device') return json(res,200,store.device(session));
        const order=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})$/);
        if(order) return json(res,200,store.order(session,order[1]));
      }
      throw new Fault('المسار غير موجود.',404);
    }catch(error) {
      if(res.headersSent) return res.end();
      if(!(error instanceof Fault)) console.error('Request failed:',error.code??error.name);
      json(res,error instanceof Fault?error.status:500,{error:error instanceof Fault?error.message:'تعذر إكمال العملية. حاول مرة أخرى.'});
    }
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;
  return {server,store};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {server,store}=buildServer();
  const port=Number(process.env.PORT??3000),host=process.env.HOST??'127.0.0.1';
  server.listen(port,host,()=>console.log(`وصّلها يعمل على http://${host}:${server.address().port} — نسخة تجريبية`));
  const stop=()=>server.close(()=>{store.close();process.exit(0);});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
