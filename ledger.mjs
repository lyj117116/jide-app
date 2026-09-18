import {emptyLedger,reminders,zoned} from './public/ledger-model.js';
import {createHash} from 'node:crypto';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const check=(ok,message)=>{if(!ok)throw fail(400,message);};
const id=value=>{check(typeof value==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(value),'记录编号无效。');return value;};
const str=(value,max,required=false)=>{check(typeof value==='string'&&value.length<=max&&(!required||value.trim()),'填写内容为空或过长。');return value.trim();};
const date=value=>{check(typeof value==='string'&&/^20\d\d-\d\d-\d\d$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'日期无效，请选择2000年至2099年的日期。');return value;};
const month=value=>{date(value+'-01');return value;};
const money=(value,zero=false)=>{check(Number.isSafeInteger(value)&&value>=(zero?0:1)&&value<=99999999999,'金额无效或超出范围。');return value;};
function entry(v){check(v&&['expense','income','transfer','refund'].includes(v.kind),'账目类型无效。');const e={id:id(v.id),kind:v.kind,amount:money(v.amount),date:date(v.date),category:str(v.category,20,true),note:str(v.note||'',200),tag:str(v.tag||'',30),account:str(v.account||'',30),toAccount:str(v.toAccount||'',30),meal:v.meal||'',refundOf:v.refundOf||'',deleted:!!v.deleted};check(['','breakfast','lunch','dinner'].includes(e.meal),'餐次无效。');if(e.kind!=='expense')e.meal='';if(e.kind==='transfer')check(e.account&&e.toAccount&&e.account!==e.toAccount,'转出与转入账户需要不同。');if(e.kind!=='refund')e.refundOf='';else id(e.refundOf);return e;}
function validateRefunds(entries){for(const e of entries.filter(e=>!e.deleted&&e.kind==='refund')){const original=entries.find(x=>x.id===e.refundOf&&!x.deleted&&x.kind==='expense');check(original&&original.date<=e.date,'请关联有效的原消费，退款日期不能早于消费日期。');const sum=entries.filter(x=>!x.deleted&&x.kind==='refund'&&x.refundOf===original.id).reduce((s,x)=>s+x.amount,0);check(sum<=original.amount,'累计退款不能超过原消费金额。');e.category=original.category;}}
export function createLedger(db){
  db.exec(`CREATE TABLE IF NOT EXISTS ledgers(accountId TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_ops(accountId TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(accountId,id));
    CREATE TABLE IF NOT EXISTS ledger_claims(accountId TEXT NOT NULL,key TEXT NOT NULL,client TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(accountId,key));`);
  const load=accountId=>{const row=db.prepare('SELECT value FROM ledgers WHERE accountId=?').get(accountId);return row?JSON.parse(row.value):emptyLedger();};
  function mutate(accountId,input,now=new Date()){
    check(input&&typeof input==='object','请求无效。');id(input.id);
    db.exec('BEGIN IMMEDIATE');try{
      let state=load(accountId);
      const fingerprint=createHash('sha256').update(JSON.stringify({action:input.action,value:input.value,reminderKey:input.reminderKey||null})).digest('hex');
      const prior=db.prepare('SELECT fingerprint FROM ledger_ops WHERE accountId=? AND id=?').get(accountId,input.id);
      if(prior){if(prior.fingerprint!==fingerprint)throw fail(409,'这次提交已保存过其他内容，请刷新后编辑原账目。');db.exec('COMMIT');return state;}
      if(input.version!==state.version)throw fail(409,'账本已在其他页面更新。已刷新数据，请核对后再次保存。');
      const v=input.value;
      if(input.action==='entry'){
        const e=entry(v),old=state.entries.find(x=>x.id===e.id);if(old?.reminderKey)e.reminderKey=old.reminderKey;
        if(input.reminderKey){const r=reminders(state,now).find(x=>x.key===input.reminderKey);check(r,'这个提醒已处理或尚未到时间，请刷新查看。');check(e.kind==='expense','提醒只能记为支出。');if(r.type==='meal'){check(e.date===r.date&&e.meal===r.meal,'餐费日期或餐次不匹配。');}e.reminderKey=r.key;state.responses[r.key]={status:'done'};}
        if(old)state.entries[state.entries.indexOf(old)]={...e,createdAt:old.createdAt,updatedAt:now.toISOString()};else{check(state.entries.length<10000,'账目已达10000条上限，请联系维护者。');state.entries.push({...e,createdAt:now.toISOString(),updatedAt:now.toISOString()});}
        validateRefunds(state.entries);
      }else if(input.action==='bill'){
        check(v&&typeof v==='object','缴费项目无效。');const b={id:id(v.id),title:str(v.title,60,true),day:v.day,interval:v.interval,advance:v.advance,startMonth:month(v.startMonth),amount:money(v.amount,true),category:str(v.category,20,true),enabled:!!v.enabled};
        check(Number.isInteger(b.day)&&b.day>=1&&b.day<=31&&[1,2,3,6,12].includes(b.interval)&&[0,1,3,7].includes(b.advance),'缴费周期无效。');
        const old=state.bills.find(x=>x.id===b.id);if(old)state.bills[state.bills.indexOf(old)]=b;else{check(state.bills.length<100,'最多设置100个缴费项目。');state.bills.push(b);}
      }else if(input.action==='settings'){
        check(v&&typeof v.timeZone==='string','时区无效。');try{new Intl.DateTimeFormat('en',{timeZone:v.timeZone});}catch{throw fail(400,'时区无效。');}
        const meals={};for(const key of ['breakfast','lunch','dinner']){const m=v.meals?.[key];check(m&&/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time),'提醒时间无效。');meals[key]={enabled:!!m.enabled,time:m.time,weekdays:!!m.weekdays};}state.settings={timeZone:v.timeZone,meals};
      }else if(input.action==='budget'){
        month(v?.month);state.budgets[v.month]=money(v.amount,true);
      }else if(input.action==='respond'){
        const r=reminders(state,now).find(x=>x.key===v?.key);check(r,'这个提醒已处理或尚未到时间。');check(['skip','zero','snooze'].includes(v.status),'提醒操作无效。');check(v.status!=='zero'||r.type==='meal','固定缴费请选择本期跳过。');state.responses[r.key]={status:v.status,...(v.status==='snooze'?{until:now.getTime()+30*60000}:{})};
      }else throw fail(400,'不支持的账本操作。');
      state.version++;db.prepare('INSERT INTO ledgers VALUES(?,?) ON CONFLICT(accountId) DO UPDATE SET value=excluded.value').run(accountId,JSON.stringify(state));db.prepare('INSERT INTO ledger_ops VALUES(?,?,?)').run(accountId,input.id,fingerprint);db.exec('COMMIT');return state;
    }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
  }
  function claim(accountId,input,now=new Date()){
    const client=id(input?.client);check(Array.isArray(input.keys)&&input.keys.length<=100,'提醒请求无效。');const pending=new Set(reminders(load(accountId),now).map(x=>x.key));db.prepare('DELETE FROM ledger_claims WHERE expires<=?').run(now.getTime());const keys=[];
    for(const key of input.keys){if(!pending.has(key))continue;const row=db.prepare('SELECT * FROM ledger_claims WHERE accountId=? AND key=?').get(accountId,key);if(row&&row.client!==client)continue;db.prepare('INSERT INTO ledger_claims VALUES(?,?,?,?) ON CONFLICT(accountId,key) DO UPDATE SET expires=excluded.expires').run(accountId,key,client,now.getTime()+90000);keys.push(key);}return {keys};
  }
  return {load,mutate,claim};
}
