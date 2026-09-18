import http from 'node:http';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,readdirSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createApp} from './engine.mjs';
import {createLedger} from './ledger.mjs';
import {createWechatAuth} from './wechat-auth.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const derive=promisify(scrypt);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const assets=new Map([['/','index.html'],['/privacy','privacy.html'],['/app.js','app.js'],['/qrcode.js','qrcode.js'],['/style.css','style.css'],['/sw.js','sw.js'],['/manifest.webmanifest','manifest.webmanifest'],['/icon.svg','icon.svg'],['/icon-192.png','icon-192.png'],['/icon-512.png','icon-512.png']]);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
for(const file of ['ledger-ui.js','ledger-model.js','ledger.css'])assets.set('/'+file,file);
const cookieName='jide_account';
function username(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_]{3,32}$/.test(value))throw fail(400,'账号为3至32位英文字母、数字或下划线。');return value.toLowerCase();}
function password(value){if(typeof value!=='string'||value.length<12||value.length>128)throw fail(400,'密码请填写12至128个字符。');return value;}
async function body(req){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>2*1024*1024)throw fail(413,'请求内容过大。');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail(400,'请求格式无效。');}}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};

export async function createAccountApp({dataDir=process.env.JIDE_ACCOUNTS_DATA||path.join(process.env.LOCALAPPDATA||os.homedir(),'JideTodoAccounts'),port=4319,host='127.0.0.1',publicOrigin=null,registrationOpen=false,maxAccounts=50,lanHosts=null}={}){
  if(publicOrigin&&typeof publicOrigin!=='function'){const u=new URL(publicOrigin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('JIDE_PUBLIC_ORIGIN must be an HTTPS origin.');publicOrigin=u.origin;}
  // 局域网模式：仅当显式传入 lanHosts（形如 ['192.168.1.154:4391']）时才额外放行这些 Host，
  // 默认 null 表示只认回环地址，与原有严格隔离行为完全一致。
  const allowedHosts=Array.isArray(lanHosts)?new Set(lanHosts.map(h=>String(h).toLowerCase()).filter(Boolean)):null;
  if(!publicOrigin&&host!=='127.0.0.1'&&!allowedHosts)throw new Error('Preview without HTTPS must bind to loopback.');
  mkdirSync(dataDir,{recursive:true});mkdirSync(path.join(dataDir,'backups'),{recursive:true});
  const db=new DatabaseSync(path.join(dataDir,'accounts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,displayName TEXT NOT NULL,salt TEXT NOT NULL,passwordHash TEXT NOT NULL,recoveryHash TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions(tokenHash TEXT PRIMARY KEY,accountId TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY,hits INTEGER NOT NULL,until INTEGER NOT NULL);`);
  const ledger=createLedger(db);
  // 小程序登录：只有配置了 AppID 与密钥才会启用，未配置时 wechat 为 null，网页版行为完全不变
  const wechat=createWechatAuth({db,appid:process.env.JIDE_WX_APPID,secret:process.env.JIDE_WX_SECRET,registrationOpen:registrationOpen||process.env.JIDE_WX_OPEN==='true',maxAccounts,hashPassword:passwordHash});
  const workspaces=new Map();let hashJobs=0,lastBackup=null,backupError=null;
  async function snapshot(){const dir=path.join(dataDir,'backups');await backup(db,path.join(dir,'accounts-'+new Date().toISOString().slice(0,10)+'.sqlite'));for(const file of readdirSync(dir).filter(n=>/^accounts-\d{4}-\d{2}-\d{2}\.sqlite$/.test(n)).sort().slice(0,-7))unlinkSync(path.join(dir,file));lastBackup=new Date().toISOString();}
  await snapshot();const timer=setInterval(()=>snapshot().then(()=>backupError=null).catch(()=>backupError='账号备份暂未成功，请联系维护者。'),3600000);timer.unref();
  async function passwordHash(value,salt){if(hashJobs>=2)throw fail(503,'登录请求较多，请稍后重试。');hashJobs++;try{return(await derive(value,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024})).toString('hex');}finally{hashJobs--;}}
  function limit(key,max){const now=Date.now();db.prepare('DELETE FROM auth_limits WHERE until<?').run(now);const row=db.prepare('SELECT * FROM auth_limits WHERE key=?').get(key);if(row&&row.hits>=max)throw fail(429,'尝试次数较多，请15分钟后再试。');db.prepare('INSERT INTO auth_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1').run(key,1,now+15*60000);}
  // 小程序用 Authorization 头带令牌，网页版继续用 Cookie；两者共用同一套账号
  function session(req){const bearer=wechat?wechat.accountByToken(req):null;if(bearer)return bearer;const token=new RegExp('(?:^|;\\s*)'+cookieName+'=([a-f0-9]{64})(?:;|$)').exec(req.headers.cookie||'')?.[1];if(!token)return null;const account=db.prepare('SELECT a.*,s.tokenHash FROM auth_sessions s JOIN accounts a ON a.id=s.accountId WHERE s.tokenHash=? AND s.expires>?').get(digest(token),Date.now());return account||null;}
  function setSession(res,accountId){db.prepare('DELETE FROM auth_sessions WHERE expires<?').run(Date.now());const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(digest(token),accountId,Date.now()+30*86400000);res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${publicOrigin?'; Secure':''}`);}
  const profile=a=>({id:a.id,username:a.username,displayName:a.displayName});
  async function workspace(id){
    if(!workspaces.has(id)){
      const pending=(async()=>{const app=await createApp({dataDir:path.join(dataDir,'users',id),port:0});const origin='http://127.0.0.1:'+app.server.address().port;const r=await fetch(origin+'/api/local-session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});if(!r.ok){await app.close();throw new Error('Workspace initialization failed.');}return {app,origin,cookie:r.headers.get('set-cookie').split(';')[0]};})();
      workspaces.set(id,pending);pending.catch(()=>workspaces.delete(id));
    }return workspaces.get(id);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const loopback=`http://127.0.0.1:${server.address().port}`,localhost=`http://localhost:${server.address().port}`;
      let origin=typeof publicOrigin==='function'?publicOrigin():publicOrigin;
      if(publicOrigin){try{const u=new URL(origin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error();origin=u.origin;}catch{throw fail(503,'体验入口正在连接，请稍后重试。');}}
      else{
        // 局域网模式下，请求自带的 Host 若在显式白名单内，则以它为 origin（手机通过局域网 IP 访问时即走此分支）。
        const reqHost=String(req.headers.host||'').toLowerCase();
        if(allowedHosts&&allowedHosts.has(reqHost))origin='http://'+reqHost;
        else origin=req.headers.host===new URL(localhost).host?localhost:loopback;
      }
      if(req.headers.host!==new URL(origin).host||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))throw fail(403,'访问地址未授权。');
      const route=new URL(req.url,origin).pathname;
      if(!['GET','POST'].includes(req.method))throw fail(405,'不支持的请求方式。');
      // 小程序发不出可信 Origin，令牌本身就是凭据；网页版仍按 Origin 校验，行为不变
      if(req.method==='POST'){
        if(!/^application\/json\b/i.test(req.headers['content-type']||''))throw fail(403,'请求格式无效。');
        if(req.headers.origin!==origin&&!(wechat&&wechat.accountByToken(req)))throw fail(403,'请在记得页面内操作。');
      }
      if(route==='/health'&&req.method==='GET')return json(res,200,{ok:true,version:'0.5.0-preview'});
      if(route==='/api/auth/config'&&req.method==='GET')return json(res,200,{registrationOpen,preview:!publicOrigin});
      if(['/api/auth/register','/api/auth/login','/api/auth/recover'].includes(route)&&req.method==='POST'){
        limit('ip:'+req.socket.remoteAddress,60);const input=await body(req),name=username(input.username);limit('account:'+name,12);
        if(route.endsWith('/register')){
          if(!registrationOpen)throw fail(403,'当前暂未开放注册。');
          password(input.password);const displayName=typeof input.displayName==='string'?input.displayName.trim():'';if(displayName.length>40)throw fail(400,'昵称最多40个字符。');
          if(db.prepare('SELECT count(*) AS n FROM accounts').get().n>=maxAccounts)throw fail(403,'本轮体验名额已满。');
          if(db.prepare('SELECT id FROM accounts WHERE username=?').get(name))throw fail(409,'这个账号已被使用，请换一个。');
          const salt=randomBytes(16).toString('hex'),pw=await passwordHash(input.password,salt),id=randomBytes(16).toString('hex'),recovery=randomBytes(24).toString('hex');
          // Recheck after asynchronous hashing; unique constraint also protects concurrent registrations.
          if(db.prepare('SELECT count(*) AS n FROM accounts').get().n>=maxAccounts)throw fail(403,'本轮体验名额已满。');
          try{db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)').run(id,name,displayName||name,salt,pw,digest(recovery),new Date().toISOString());}catch(e){if(e.code?.startsWith('ERR_SQLITE'))throw fail(409,'这个账号已被使用，请换一个。');throw e;}
          setSession(res,id);return json(res,201,{account:{id,username:name,displayName:displayName||name},recoveryCode:recovery});
        }
        const account=db.prepare('SELECT * FROM accounts WHERE username=?').get(name);
        if(route.endsWith('/recover')){
          password(input.password);if(!account||typeof input.recoveryCode!=='string'||!timingSafeEqual(Buffer.from(digest(input.recoveryCode.trim())),Buffer.from(account.recoveryHash)))throw fail(401,'账号或恢复码不正确。');
          const salt=randomBytes(16).toString('hex'),pw=await passwordHash(input.password,salt),recovery=randomBytes(24).toString('hex');
          db.exec('BEGIN IMMEDIATE');try{const result=db.prepare('UPDATE accounts SET salt=?,passwordHash=?,recoveryHash=? WHERE id=? AND recoveryHash=?').run(salt,pw,digest(recovery),account.id,account.recoveryHash);if(result.changes!==1)throw fail(409,'恢复码已更新，请使用最新的恢复码。');db.prepare('DELETE FROM auth_sessions WHERE accountId=?').run(account.id);db.exec('COMMIT');}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
          setSession(res,account.id);return json(res,200,{account:profile(account),recoveryCode:recovery});
        }
        const candidate=typeof input.password==='string'&&input.password.length<=128?input.password:'';
        const pw=await passwordHash(candidate,account?.salt||'00000000000000000000000000000000');
        if(!account||!timingSafeEqual(Buffer.from(pw),Buffer.from(account.passwordHash))||db.prepare('SELECT passwordHash FROM accounts WHERE id=?').get(account.id)?.passwordHash!==pw)throw fail(401,'账号或密码不正确。');
        db.prepare('DELETE FROM auth_limits WHERE key=?').run('account:'+name);setSession(res,account.id);return json(res,200,{account:profile(account)});
      }
      if(route.startsWith('/api/')){
        const account=session(req);if(!account)throw fail(401,'请登录你的账号。');
        if(route==='/api/auth/me'&&req.method==='GET')return json(res,200,{account:profile(account)});
        if(req.headers['x-jide-workspace']!==account.id)return json(res,409,{error:'当前账号已改变，请重新登录后继续。',accountChanged:true});
        if(route==='/api/ledger'&&req.method==='GET')return json(res,200,ledger.load(account.id));
        if(route==='/api/ledger/op'&&req.method==='POST')return json(res,200,ledger.mutate(account.id,await body(req)));
        if(route==='/api/ledger/claim'&&req.method==='POST')return json(res,200,ledger.claim(account.id,await body(req)));
        if(route==='/api/auth/logout'&&req.method==='POST'){if(account.tokenHash)db.prepare('DELETE FROM auth_sessions WHERE tokenHash=?').run(account.tokenHash);if(wechat)wechat.revoke(req);res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${publicOrigin?'; Secure':''}`);return json(res,200,{ok:true});}
        if(route==='/api/auth/password'&&req.method==='POST'){
          limit('password:'+account.id,10);const input=await body(req);password(input.password);const old=typeof input.currentPassword==='string'&&input.currentPassword.length<=128?input.currentPassword:'';
          if(!timingSafeEqual(Buffer.from(await passwordHash(old,account.salt)),Buffer.from(account.passwordHash)))throw fail(401,'当前密码不正确。');
          const salt=randomBytes(16).toString('hex'),pw=await passwordHash(input.password,salt);
          db.exec('BEGIN IMMEDIATE');try{const result=db.prepare('UPDATE accounts SET salt=?,passwordHash=? WHERE id=? AND passwordHash=?').run(salt,pw,account.id,account.passwordHash);if(result.changes!==1)throw fail(409,'密码已在其他设备修改，请重新登录。');db.prepare('DELETE FROM auth_sessions WHERE accountId=?').run(account.id);db.exec('COMMIT');}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}setSession(res,account.id);return json(res,200,{ok:true});
        }
        if(!(req.method==='GET'&&['/api/state','/api/info'].includes(route)||req.method==='POST'&&route==='/api/op'))throw fail(404,'接口不存在。');
        const w=await workspace(account.id);
        if(!w.authAt)w.authAt=Date.now();
        if(Date.now()-w.authAt>29*86400000){const renewed=await fetch(w.origin+'/api/local-session',{method:'POST',headers:{Origin:w.origin,'Content-Type':'application/json'},body:'{}'});if(!renewed.ok)throw new Error('Workspace session renewal failed.');w.cookie=renewed.headers.get('set-cookie').split(';')[0];w.authAt=Date.now();}
        let payload;if(req.method==='POST')payload=JSON.stringify(await body(req));
        const r=await fetch(w.origin+route,{method:req.method,headers:{Cookie:w.cookie,Origin:w.origin,'Content-Type':'application/json'},body:payload,signal:AbortSignal.timeout(15000)});const value=await r.json();
        if(route==='/api/state'&&r.ok)value.workspaceId=account.id;
        if(route==='/api/info'&&r.ok)return json(res,200,{workspaceId:account.id,account:profile(account),version:'0.5.0-preview',lastBackup:value.lastBackup,backupError:value.backupError||backupError,accountBackup:lastBackup});
        return json(res,r.status,value);
      }
      // 容错：把常见的等价写法归一到已登记的路径，避免用户补全文件名时看到「页面不存在」。
      let assetPath=route;
      if(assetPath==='/index.html'||assetPath==='/index.htm'||assetPath==='/home'||assetPath==='/index')assetPath='/';
      if(assetPath==='/privacy.html')assetPath='/privacy';
      if(assetPath==='/favicon.ico'){res.writeHead(204,{'Cache-Control':'no-store'});return res.end();}
      if(req.method!=='GET'||!assets.has(assetPath))throw fail(404,'页面不存在。');
      const file=assets.get(assetPath);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(readFileSync(path.join(here,'public',file)));
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'暂时无法完成，请稍后重试。'});else res.end();}
  });
  server.requestTimeout=20000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,db,dataDir,snapshot,close:async()=>{clearInterval(timer);await new Promise(r=>server.close(r));for(const promise of workspaces.values()){try{await(await promise).app.close();}catch{}}db.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const preview=process.argv.includes('--preview');
  const app=await createAccountApp({port:Number(process.env.PORT||4319),host:process.env.HOST||'127.0.0.1',publicOrigin:process.env.JIDE_PUBLIC_ORIGIN||null,registrationOpen:preview||process.env.JIDE_REGISTRATION_OPEN==='true'});
  console.log('记得账号体验版已启动：http://localhost:'+app.server.address().port);const stop=()=>app.close().then(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
