import http from 'node:http';
import https from 'node:https';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile=promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const idPattern = /^[a-zA-Z0-9_-]{8,100}$/;
export function validateTask(t) {
  if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim() || t.title.trim().length > 160) throw fail(400, '标题需要填写，最多160字。');
  if (typeof t.notes !== 'string' || t.notes.length > 5000) throw fail(400, '备注最多5000字。');
  if (typeof t.category!=='string'||!t.category.trim()||t.category.trim().length>20) throw fail(400, '分类需要填写，最多20字。');
  for (const k of ['important','done','deleted']) if (typeof t[k] !== 'boolean') throw fail(400, '待办状态无效。');
  const date = value => { if (value === null || value === '') return null; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail(400, '时间格式无效。'); return new Date(value).toISOString(); };
  if (t.plannedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(t.plannedDate) || !Number.isFinite(Date.parse(t.plannedDate)) || new Date(t.plannedDate).toISOString().slice(0,10) !== t.plannedDate)) throw fail(400, '计划日期无效。');
  const value={ title: t.title.trim(), notes: t.notes, category: t.category.trim(), important:t.important, done:t.done, deleted:t.deleted, plannedDate:t.plannedDate || null, dueUtc:date(t.dueUtc), reminderUtc:date(t.reminderUtc) };
  if(Object.hasOwn(t,'status')){if(!['todo','doing','waiting'].includes(t.status))throw fail(400,'处理状态无效。');value.status=t.status;}
  for(const key of ['deadlineUtc','followUpUtc','snoozedUntil'])if(Object.hasOwn(t,key))value[key]=date(t[key]);
  if(Object.hasOwn(t,'repeat')){if(!['none','daily','weekly','monthly'].includes(t.repeat))throw fail(400,'重复周期无效。');value.repeat=t.repeat;}
  return value;
}

// Calendar recurrence follows this computer's local timezone. Month ends clamp to the final day.
export function shiftCalendar(value,frequency,steps=1,dateOnly=false,anchorDay){
  if(!value)return null;const d=dateOnly?new Date(value+'T12:00:00'):new Date(value);
  if(frequency==='monthly'){const day=anchorDay||d.getDate();d.setDate(1);d.setMonth(d.getMonth()+steps);d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));}
  else d.setDate(d.getDate()+steps*(frequency==='weekly'?7:1));
  return dateOnly?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:d.toISOString();
}
export function nextOccurrence(task,now=new Date()){
  const anchorKey=['deadlineUtc','dueUtc','followUpUtc','plannedDate'].find(k=>task[k]);const anchor=anchorKey==='plannedDate'?task.plannedDate+'T23:59:59':task[anchorKey]||now.toISOString();let steps=1;
  while(new Date(shiftCalendar(anchor,task.repeat,steps,false,task.repeatAnchors?.[anchorKey]))<=now&&steps<50000)steps++;
  const advance=key=>shiftCalendar(task[key],task.repeat,steps,key==='plannedDate',task.repeatAnchors?.[key]);
  return {...task,id:'repeat_'+hash(task.id).slice(0,32),version:1,repeatAutoVersion:1,done:false,deleted:false,status:'todo',createdUtc:now.toISOString(),updatedUtc:now.toISOString(),completedUtc:null,plannedDate:task.plannedDate?advance('plannedDate'):shiftCalendar(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,task.repeat,steps,true),dueUtc:advance('dueUtc'),deadlineUtc:advance('deadlineUtc'),followUpUtc:advance('followUpUtc'),reminderUtc:advance('dueUtc'),snoozedUntil:null,repeatParentId:task.id};
}

export async function createApp({ dataDir = process.env.JIDE_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'JideTodoWeb'), host = '127.0.0.1', port = 4317, tls } = {}) {
  mkdirSync(dataDir, { recursive:true });
  const dbFile = path.join(dataDir, 'jide.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  if (!db.prepare('SELECT value FROM meta WHERE key=?').get('workspace')) db.prepare('INSERT INTO meta VALUES (?,?)').run('workspace',randomBytes(16).toString('hex'));
  const workspaceId = db.prepare('SELECT value FROM meta WHERE key=?').get('workspace').value;
  const backups = path.join(dataDir, 'backups');
  mkdirSync(backups, { recursive:true });
  // SQLite backup API provides a consistent copy even with WAL enabled.
  let lastBackup=null;
  async function snapshot() {
    const target = path.join(backups, 'jide-' + new Date().toISOString().slice(0,10) + '.sqlite');
    await backup(db, target);
    const files = readdirSync(backups).filter(n=>/^jide-\d{4}-\d{2}-\d{2}\.sqlite$/.test(n)).sort();
    for (const n of files.slice(0,-7)) unlinkSync(path.join(backups,n));
    lastBackup=new Date().toISOString();
  }
  await snapshot();
  let backupError = null;
  const backupTimer = setInterval(()=>snapshot().then(()=>backupError=null).catch(e=>{backupError=e.message;console.error('备份失败',e.message);}), 3600000);
  backupTimer.unref();
  let pairCode = null, pairExpires = 0;
  const attempts = new Map();
  const localIPs = Object.values(os.networkInterfaces()).flat().filter(x=>x?.family==='IPv4').map(x=>x.address);
  const allowedHosts = new Set(['localhost','127.0.0.1', ...localIPs]);
  const isLocal = req => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  function session(req) {
    const m = /(?:^|;\s*)jide_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    return m && db.prepare('SELECT expires FROM sessions WHERE token=? AND expires>?').get(hash(m[1]),Date.now());
  }
  function newSession(res) {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash(token),Date.now()+30*86400000);
    res.setHeader('Set-Cookie',`jide_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${tls?'; Secure':''}`);
  }
  async function body(req) {
    let size=0, chunks=[];
    for await (const chunk of req) { size+=chunk.length; if(size>2*1024*1024) throw fail(413,'数据过大，请分批导入。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400,'请求格式错误。'); }
  }
  const json = (res,code,value) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  function remoteAccess(){try{const info=JSON.parse(readFileSync(path.join(dataDir,'remote-access.json'),'utf8'));const url=new URL(info.url);if(url.protocol!=='https:'||!url.hostname.endsWith('.trycloudflare.com')||!Number.isInteger(info.pid)||info.pid<1)return null;process.kill(info.pid,0);return url.origin;}catch{return null;}}
  const getTask = id => {const r=db.prepare('SELECT value FROM tasks WHERE id=?').get(id);return r?JSON.parse(r.value):null;};
  const assets = new Map([['/','index.html'],['/app.js','app.js'],['/qrcode.js','qrcode.js'],['/style.css','style.css'],['/sw.js','sw.js'],['/manifest.webmanifest','manifest.webmanifest'],['/icon.svg','icon.svg'],['/icon-192.png','icon-192.png'],['/icon-512.png','icon-512.png']]);
  const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
  const handler = async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const origin = `${tls?'https':'http'}://${req.headers.host}`;
      const url = new URL(req.url,origin);
      if(!allowedHosts.has(url.hostname)) throw fail(403,'访问地址未授权。');
      if(!['GET','POST'].includes(req.method)) throw fail(405,'不支持的请求方式。');
      if(req.method==='POST' && (req.headers.origin !== origin || !/^application\/json\b/i.test(req.headers['content-type']||''))) throw fail(403,'请从记得页面执行操作。');
      const p=url.pathname;
      if(p==='/api/local-session' && req.method==='POST') {
        if(!isLocal(req) || !['localhost','127.0.0.1'].includes(url.hostname)) throw fail(403,'请在电脑本机打开页面，或使用配对码。');
        newSession(res);return json(res,200,{ok:true});
      }
      if(p==='/api/pair' && req.method==='POST') {
        const key=req.socket.remoteAddress, now=Date.now();
        let a=attempts.get(key); if(!a || now>a.until) a={count:0,until:now+60000};
        a.count++;attempts.set(key,a);if(a.count>10)throw fail(429,'尝试次数较多，请一分钟后再试。');
        const {code}=await body(req);
        if(typeof code!=='string' || !pairCode || now>pairExpires || !timingSafeEqual(Buffer.from(hash(code.toUpperCase().replace(/\s/g,''))),Buffer.from(hash(pairCode)))) throw fail(401,'配对码无效或已过期，请在电脑上重新生成。');
        pairCode=null;newSession(res);return json(res,200,{ok:true});
      }
      if(p.startsWith('/api/')) {
        if(!session(req))throw fail(401,'需要连接此电脑，请输入电脑上显示的配对码。');
        if(p==='/api/startup'){
          if(!isLocal(req))throw fail(403,'请在电脑本机设置开机启动。');
          if(process.platform!=='win32')return json(res,200,{supported:false,enabled:false});
          const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
          if(req.method==='POST'){const input=await body(req);if(typeof input.enabled!=='boolean')throw fail(400,'启动设置无效。');if(input.enabled){const command=`powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(here,'start.ps1')}" -Lan -NoBrowser`;await runFile('reg.exe',['add',key,'/v','JideTodoWeb','/t','REG_SZ','/d',command,'/f'],{windowsHide:true});}else{try{await runFile('reg.exe',['delete',key,'/v','JideTodoWeb','/f'],{windowsHide:true});}catch(e){if(e.code!==1)throw e;}}}
          let enabled=false;try{const r=await runFile('reg.exe',['query',key,'/v','JideTodoWeb'],{windowsHide:true});enabled=r.stdout.includes('start.ps1');}catch{}
          return json(res,200,{supported:true,enabled});
        }
        if(p==='/api/state' && req.method==='GET')return json(res,200,{workspaceId,tasks:db.prepare('SELECT value FROM tasks ORDER BY rowid').all().map(r=>JSON.parse(r.value)),backupError,serverTime:new Date().toISOString()});
        if(p==='/api/info' && req.method==='GET')return json(res,200,{workspaceId,local:isLocal(req),lan:host==='0.0.0.0',addresses:localIPs.filter(ip=>ip!=='127.0.0.1').map(ip=>`${tls?'https':'http'}://${ip}:${server.address().port}`),tls:!!tls,lastBackup,backupError,backupCount:readdirSync(backups).filter(n=>n.endsWith('.sqlite')).length,dataDir:isLocal(req)?dataDir:null,version:'0.3.1',remoteUrl:remoteAccess(),remoteMode:'temporary'});
        if(p==='/api/pair-code' && req.method==='POST') {
          if(!isLocal(req))throw fail(403,'请在电脑本机生成配对码。');
          pairCode=randomBytes(6).toString('hex').toUpperCase();pairExpires=Date.now()+10*60000;
          return json(res,200,{code:pairCode,expires:new Date(pairExpires).toISOString()});
        }
        if(p==='/api/logout' && req.method==='POST') {
          const m=/(?:^|;\s*)jide_session=([a-f0-9]{64})/.exec(req.headers.cookie||'');if(m)db.prepare('DELETE FROM sessions WHERE token=?').run(hash(m[1]));
          res.setHeader('Set-Cookie','jide_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return json(res,200,{ok:true});
        }
        if(p==='/api/op' && req.method==='POST') {
          const op=await body(req);
          if(!idPattern.test(op.id||'') || !idPattern.test(op.taskId||'') || !Number.isSafeInteger(op.baseVersion) || op.baseVersion<0)throw fail(400,'操作编号或版本无效。');
          if(op.intent!==undefined&&op.intent!=='restore')throw fail(400,'操作类型无效。');
          const value=validateTask(op.value), digest=hash(JSON.stringify({taskId:op.taskId,baseVersion:op.baseVersion,value,...(op.intent?{intent:op.intent}:{})}));
          const prior=db.prepare('SELECT * FROM operations WHERE id=?').get(op.id);
          if(prior){if(prior.digest!==digest)throw fail(409,'操作编号重复但内容不同。');return json(res,200,JSON.parse(prior.response));}
          db.exec('BEGIN IMMEDIATE');
          try {
            const current=getTask(op.taskId);
            if((current?.version||0)!==op.baseVersion){db.exec('ROLLBACK');return json(res,409,{error:'另一台设备也修改了这条待办，请选择保留方式。',current,conflict:true});}
            if(!current && db.prepare('SELECT count(*) AS n FROM tasks').get().n>=10000)throw fail(400,'已达到10000条记录上限，请先导出备份。');
            const now=new Date().toISOString();
            const task={status:'todo',deadlineUtc:null,followUpUtc:null,repeat:'none',...current,...value,id:op.taskId,version:op.baseVersion+1,createdUtc:current?.createdUtc||now,updatedUtc:now,completedUtc:value.done?(current?.completedUtc||now):null};
            if(task.repeat==='monthly'){task.repeatAnchors={...current?.repeatAnchors};for(const key of ['plannedDate','dueUtc','deadlineUtc','followUpUtc'])if(task[key]&&(!task.repeatAnchors[key]||current?.repeat!=='monthly'||current?.[key]!==task[key]))task.repeatAnchors[key]=new Date(key==='plannedDate'?task[key]+'T12:00:00':task[key]).getDate();}
            db.prepare('INSERT INTO tasks VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,value=excluded.value').run(task.id,task.version,JSON.stringify(task));
            if(op.intent!=='restore'&&task.repeat!=='none'&&task.done&&!task.deleted&&current&&!current.done){const next=nextOccurrence(task),existing=getTask(next.id);if(!existing&&db.prepare('SELECT count(*) AS n FROM tasks').get().n>=10000)throw fail(400,'记录已满，暂不能生成下一次重复事项。');if(!existing)db.prepare('INSERT INTO tasks VALUES (?,?,?)').run(next.id,1,JSON.stringify(next));else if(existing.deleted&&existing.repeatAutoCancelled&&existing.version===existing.repeatAutoVersion){const restored={...existing,deleted:false,repeatAutoCancelled:false,version:existing.version+1,repeatAutoVersion:existing.version+1,updatedUtc:now};db.prepare('UPDATE tasks SET version=?,value=? WHERE id=?').run(restored.version,JSON.stringify(restored),restored.id);}}
            if(op.intent!=='restore'&&current?.done&&!task.done){const child=getTask('repeat_'+hash(task.id).slice(0,32));if(child&&!child.deleted&&child.version===child.repeatAutoVersion){const cancelled={...child,deleted:true,repeatAutoCancelled:true,version:child.version+1,repeatAutoVersion:child.version+1,updatedUtc:now};db.prepare('UPDATE tasks SET version=?,value=? WHERE id=?').run(cancelled.version,JSON.stringify(cancelled),cancelled.id);}}
            const response={task};db.prepare('INSERT INTO operations VALUES (?,?,?)').run(op.id,digest,JSON.stringify(response));db.exec('COMMIT');return json(res,200,response);
          }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
        }
        throw fail(404,'接口不存在。');
      }
      if(req.method!=='GET'||!assets.has(p))throw fail(404,'页面不存在。');
      const filename=assets.get(p);
      res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-cache'});
      res.end(readFileSync(path.join(here,'public',filename)));
    } catch(e) { if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'保存未完成，请重试；原有数据保留。'});else res.end(); }
  };
  const server=tls?https.createServer({key:readFileSync(tls.key),cert:readFileSync(tls.cert)},handler):http.createServer(handler);
  server.requestTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,db,dataDir,snapshot,close:async()=>{clearInterval(backupTimer);await new Promise(r=>server.close(r));db.close();}};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const tls=process.env.JIDE_TLS_CERT&&process.env.JIDE_TLS_KEY?{cert:process.env.JIDE_TLS_CERT,key:process.env.JIDE_TLS_KEY}:undefined;
  const app=await createApp({host:process.argv.includes('--lan')?'0.0.0.0':'127.0.0.1',port:Number(process.env.JIDE_PORT||4317),tls});
  console.log(`记得网页版已启动：${tls?'https':'http'}://localhost:${app.server.address().port}\n数据目录：${app.dataDir}\n${process.argv.includes('--lan')?'已启用局域网访问。只在信任的网络使用；手机需配对。':'仅本机可访问。使用 --lan 启用同网络手机连接。'}`);
  const stop=()=>app.close().then(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
