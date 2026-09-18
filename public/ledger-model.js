// Shared, deterministic calendar and ledger calculations. All money is integer cents.
export const mealNames={breakfast:'早餐',lunch:'午饭',dinner:'晚饭'};
export const defaults=()=>({timeZone:'Asia/Shanghai',meals:{breakfast:{enabled:false,time:'08:30',weekdays:false},lunch:{enabled:false,time:'13:00',weekdays:false},dinner:{enabled:false,time:'18:00',weekdays:false}}});
export const emptyLedger=()=>({version:0,entries:[],bills:[],budgets:{},settings:defaults(),responses:{}});
export function zoned(now,timeZone){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};}
export function monthDay(month,day){const [y,m]=month.split('-').map(Number);return `${month}-${String(Math.min(day,new Date(Date.UTC(y,m,0)).getUTCDate())).padStart(2,'0')}`;}
export function shiftDay(date,days){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function shiftMonth(month,n){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);}
export function reminders(state,now=new Date()){
  const {date,time}=zoned(now,state.settings.timeZone),result=[],weekend=[0,6].includes(new Date(date+'T12:00:00Z').getUTCDay());
  const available=key=>{const r=state.responses[key];return !r||r.status==='snooze'&&r.until<=now.getTime();};
  for(const [meal,config] of Object.entries(state.settings.meals)){
    const key=`meal:${date}:${meal}`;
    if(config.enabled&&time>=config.time&&(!config.weekdays||!weekend)&&available(key)&&!state.entries.some(e=>!e.deleted&&e.kind==='expense'&&e.date===date&&e.meal===meal))result.push({key,type:'meal',time:config.time,title:`今天${mealNames[meal]}花了多少？`,date,meal,category:'餐饮',amount:0});
  }
  for(const bill of state.bills.filter(b=>b.enabled)){
    // Include unpaid earlier periods and early reminders crossing a month boundary.
    for(let n=0;n<1200;n+=bill.interval){const month=shiftMonth(bill.startMonth,n);if(month>shiftMonth(date.slice(0,7),1))break;const due=monthDay(month,bill.day),key=`bill:${bill.id}:${month}`;
      if(shiftDay(due,-bill.advance)>date||!available(key)||state.entries.some(e=>!e.deleted&&e.reminderKey===key))continue;
      result.push({key,type:'bill',title:bill.title,date:due,billId:bill.id,category:bill.category,amount:bill.amount,overdue:due<date});
    }
  }
  return result.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'00:00').localeCompare(b.time||'00:00')||a.key.localeCompare(b.key));
}
export function totals(entries,month){const list=entries.filter(e=>!e.deleted&&e.date.startsWith(month));const income=list.filter(e=>e.kind==='income').reduce((s,e)=>s+e.amount,0),spent=list.filter(e=>e.kind==='expense').reduce((s,e)=>s+e.amount,0),refund=list.filter(e=>e.kind==='refund').reduce((s,e)=>s+e.amount,0);return {income,expense:spent-refund,refund,balance:income-spent+refund};}
export function cents(value){if(!/^\d{1,9}(\.\d{1,2})?$/.test(String(value)))throw new Error('金额请填写数字，最多两位小数。');const [a,b='']=String(value).split('.');return Number(a)*100+Number(b.padEnd(2,'0'));}
