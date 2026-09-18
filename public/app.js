import {createLedgerUI} from './ledger-ui.js';
const $=id=>document.getElementById(id);
const uid=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const localDateTime=value=>{if(!value)return '';const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
let db,tasks=[],outbox=[],view='today',category='',search='',online=false,busy=false,workspaceId=null,toastTimer,authRequired=false,backupWarning=null,serverInfo=null,lastError='',editorBase=null,statusFilter='',lastSync=null,editorInitial='',snoozeId=null,snoozeIsEdit=false,restoreCandidates=[],extraCategories=[];
const titles={today:'今天要做',all:'全部待办',next:'接下来',important:'重要事项',waiting:'等对方回复',unplanned:'尚未安排',done:'已完成',trash:'回收站'};
const statusNames={todo:'待处理',doing:'进行中',waiting:'等对方回复'};
const dateOffset=n=>{const d=new Date();d.setDate(d.getDate()+n);return localDateTime(d.toISOString()).slice(0,10);};
let channel=null,account=null,accountLocked=true,authMode='login',recoveryValue='';const accountEvents='BroadcastChannel' in window?new BroadcastChannel('jide-account-session'):null;
function transaction(names,fn){return new Promise((resolve,reject)=>{const tx=db.transaction(names,'readwrite');let error;tx.oncomplete=resolve;tx.onabort=()=>reject(error||tx.error||new Error('保存失败'));tx.onerror=()=>{};try{fn(tx);}catch(e){error=e;tx.abort();}});}
async function rows(name){return request(db.transaction(name).objectStore(name).getAll());}
async function meta(key){return request(db.transaction('meta').objectStore('meta').get(key));}
async function putMeta(key,value){return transaction(['meta'],tx=>tx.objectStore('meta').put({key,value}));}
function toast(message,undo){$('toast').replaceChildren(element('span','',message));if(undo)$('toast').append(button('撤销','toast-undo',async()=>{await undo();toast('已撤销');}));$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,undo?10000:4500);}
const active=t=>!t.done&&!t.deleted;
function bucket(t){if(t.deadlineUtc&&Date.parse(t.deadlineUtc)<Date.now()||t.plannedDate&&t.plannedDate<today())return 'overdue';const dates=[t.dueUtc,t.deadlineUtc,t.status==='waiting'?t.followUpUtc:null].filter(Boolean).map(x=>localDateTime(x).slice(0,10));if(t.plannedDate===today()||dates.some(x=>x<=today()))return 'today';if(t.plannedDate||dates.length)return 'next';return 'unplanned';}
const isToday=t=>['today','overdue'].includes(bucket(t));
function matches(t,f){if(f==='trash')return t.deleted;if(f==='done')return t.done&&!t.deleted;if(!active(t))return false;return f==='today'?isToday(t):f==='important'?t.important:f==='next'?bucket(t)==='next':f==='unplanned'?bucket(t)==='unplanned':f==='waiting'?t.status==='waiting':true;}
function taskValue(t){return {title:t.title,notes:t.notes||'',category:t.category||'工作',important:!!t.important,done:!!t.done,deleted:!!t.deleted,plannedDate:t.plannedDate||null,dueUtc:t.dueUtc||null,reminderUtc:t.reminderUtc||null,status:t.status||'todo',deadlineUtc:t.deadlineUtc||null,followUpUtc:t.followUpUtc||null,repeat:t.repeat||'none',snoozedUntil:t.snoozedUntil||null};}
async function api(url,body){if(accountLocked&&!url.startsWith('/api/auth/'))throw new Error('请先登录你的账号。');const headers={};if(account)headers['X-Jide-Workspace']=account.id;const options={credentials:'same-origin',cache:'no-store',headers,signal:AbortSignal.timeout(15000)};if(body!==undefined){options.method='POST';headers['Content-Type']='application/json';options.body=JSON.stringify(body);}const res=await fetch(url,options);const value=await res.json();if(!res.ok){if(value.accountChanged||res.status===401&&!url.startsWith('/api/auth/'))lockAccount(value.error||'请重新登录。');throw Object.assign(new Error(value.error||'连接失败'),{status:res.status,...value});}return value;}
async function refresh(){[tasks,outbox]=await Promise.all([rows('tasks'),rows('outbox')]);render();}
async function mutate(id,change,expectedBase,intent){
  if(accountLocked||!workspaceId)throw new Error('请先登录你的账号。');
  const now=new Date().toISOString();let changed,previous;
  await transaction(['tasks','outbox'],tx=>{const store=tx.objectStore('tasks');const r=store.get(id);r.onsuccess=()=>{try{const old=expectedBase||r.result;previous=old;const t=change(old);if(!t)return;const version=old?.version||0;const next={...taskValue(t),id,version:version+1,createdUtc:old?.createdUtc||now,updatedUtc:now,completedUtc:t.done?(old?.completedUtc||now):null};changed=next;store.put(next);tx.objectStore('outbox').add({id:uid(),taskId:id,baseVersion:version,value:taskValue(next),created:now,...(intent?{intent}:{})});}catch{tx.abort();}};});
  await refresh();channel?.postMessage('change');void sync();return {changed,previous};
}
function newTask(title){return {title,notes:'',category:category||'工作',important:false,done:false,deleted:false,plannedDate:today(),dueUtc:null,reminderUtc:null,status:'todo',deadlineUtc:null,followUpUtc:null,repeat:'none'};}
async function changeWithUndo(id,patch,message,expectedBase){const result=await mutate(id,old=>({...old,...patch}),expectedBase);if(!result.changed)return;toast(message,async()=>{const current=tasks.find(t=>t.id===id);if(!current||current.version!==result.changed.version)throw new Error('这条待办已有其他修改，请打开详情核对。');const prior=taskValue(result.previous||{});const revert=Object.fromEntries(Object.keys(patch).map(k=>[k,prior[k]??null]));await mutate(id,old=>({...old,...revert}),current);});}
async function mergeServer(remote){
  const previous=(await meta('workspace'))?.value;
  if(previous && previous!==remote.workspaceId)throw new Error('此地址连接到了另一份清单。请先导出本机备份，再断开并重新配对。');
  await putMeta('workspace',remote.workspaceId);workspaceId=remote.workspaceId;backupWarning=remote.backupError;
  await transaction(['tasks','outbox'],tx=>{const q=tx.objectStore('outbox').getAll();q.onsuccess=()=>{const pending=new Set(q.result.map(o=>o.taskId));for(const t of remote.tasks){if(!pending.has(t.id))tx.objectStore('tasks').put(t);}};});
}
async function performSync(){
  busy=true;renderStatus();
  try{
    await mergeServer(await api('/api/state'));authRequired=false;online=true;lastError='';
    const pending=await rows('outbox');const blocked=new Set(pending.filter(o=>o.conflict).map(o=>o.taskId));
    for(const op of pending.slice(0,500)){
      if(blocked.has(op.taskId))continue;
      try{
        const result=await api('/api/op',{id:op.id,taskId:op.taskId,baseVersion:op.baseVersion,value:op.value,...(op.intent?{intent:op.intent}:{})});
        await transaction(['tasks','outbox'],tx=>{tx.objectStore('outbox').delete(op.seq);const r=tx.objectStore('tasks').get(op.taskId);r.onsuccess=()=>{if(!r.result||r.result.version<=result.task.version)tx.objectStore('tasks').put(result.task);};});
      }catch(e){
        if(e.conflict){blocked.add(op.taskId);await transaction(['outbox'],tx=>{tx.objectStore('outbox').put({...op,conflict:true,current:e.current});});}
        else throw e;
      }
    }
    await mergeServer(await api('/api/state'));
    lastSync=new Date().toISOString();await putMeta('lastSync',lastSync);
  }catch(e){online=false;lastError=e.status?e.message:(e.name==='TypeError'||e.name==='TimeoutError'?'暂时无法连接服务':e.message);if(e.status===401)authRequired=true;}
  finally{busy=false;await refresh();channel?.postMessage('refresh');}
}
async function sync(){if(!db||busy||accountLocked)return;if(navigator.locks){await navigator.locks.request('jide-sync-'+account.id,{ifAvailable:true},async lock=>{if(lock&&!busy)await performSync();});}else await performSync();}
function renderStatus(){
  $('sync-text').textContent=busy?'正在同步…':authRequired?'需要重新登录':!online?'未连接 · 已存本机':outbox.length?`${outbox.length}项待同步`:'已同步';
  $('sync-dot').className='status-dot '+(!busy&&online&&!outbox.length?'ok':'warn');
  $('sync-button').title=(lastSync?'最近同步：'+new Date(lastSync).toLocaleString('zh-CN')+'。':'')+'点击立即同步';
  const notice=$('connection-notice');let message='';
  if(!online&&!busy)message=(workspaceId?`已存此设备，${new Set(outbox.map(o=>o.taskId)).size}条待办等待同步。连接恢复后自动补传。`:'请先登录你的账号。')+(lastError?' '+lastError:'');
  if(backupWarning)message+=' 自动备份失败，请先导出备份并检查磁盘空间。';
  notice.textContent=message;notice.hidden=!message;
}
function element(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function button(text,className,fn,label){const e=element('button',className,text);e.type='button';if(label)e.setAttribute('aria-label',label);e.addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>toast(e.message)));return e;}
async function toggleTaskWithFeedback(id,field){
  const t=tasks.find(t=>t.id===id);if(!t)return;if(field==='done'&&t.deleted)return changeWithUndo(id,{deleted:false},'已还原待办');const selected=!t[field];
  return changeWithUndo(id,{[field]:selected},field==='done'?(selected?'已标为完成，可在“已完成”中查看':'已恢复为未完成'):(selected?'已标为重要，可在“重要事项”中查看':'已取消重要标记'));
}
const displayTime=value=>new Date(value).toLocaleString('zh-CN',{...(new Date(value).getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{}),month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function describe(t){if(t.deleted)return '回收站 · 可还原';if(t.done)return '已完成';if(t.snoozedUntil&&Date.parse(t.snoozedUntil)>Date.now())return '延后至 '+displayTime(t.snoozedUntil);if(t.reminderUtc&&t.dueUtc&&t.reminderUtc>t.dueUtc&&Date.parse(t.reminderUtc)>Date.now())return '延后至 '+displayTime(t.reminderUtc);if(t.dueUtc)return (Date.parse(t.dueUtc)<Date.now()?'已到提醒时间 · ':'提醒 · ')+displayTime(t.dueUtc);if(t.plannedDate)return t.plannedDate===today()?'今天安排 · 未设提醒':t.plannedDate+'安排 · 未设提醒';return '尚未安排 · 未设提醒';}
function categories(){return [...new Set(['工作','生活','其他',...extraCategories,...tasks.map(t=>t.category)])];}
function renderCategories(){
  const names=categories();const sig=JSON.stringify([names,category]);if($('categories').dataset.signature!==sig){$('categories').dataset.signature=sig;$('categories').replaceChildren();for(const name of ['',...names]){const b=button(name||'全部',category===name?'selected':'',()=>{category=name;render();});b.dataset.category=name;$('categories').append(b);}$('category-options').replaceChildren(...names.map(n=>{const o=element('option');o.value=n;return o;}));}
  $('quick-category-note').textContent='记入'+(category||'工作');
}
function taskRow(t,pendingIds,conflictIds){
  const row=element('article','task-row'+(t.done?' done':''));row.dataset.taskId=t.id;
  const check=button('', 'task-check',()=>toggleTaskWithFeedback(t.id,'done'),t.deleted?'还原 '+t.title:(t.done?'取消完成 ':'完成 ')+t.title);check.dataset.action='check';check.title=t.deleted?'还原这条待办':t.done?'取消完成，恢复为待办':'标记为完成';if(!t.deleted)check.setAttribute('aria-pressed',String(t.done));check.append(element('span','',t.deleted?'↶':'✓'));if(t.deleted)check.firstChild.classList.add('restore-symbol');
  const content=element('div','task-content');const main=button('','task-main',()=>openEditor(t.id),'编辑 '+t.title);main.dataset.action='edit';main.append(element('span','task-title',t.title));
  const metadata=element('span','task-meta');metadata.append(element('span','badge '+(t.category==='生活'?'life':t.category==='其他'?'other':''),t.category),element('span','due',describe(t)));
  if(t.deadlineUtc&&!t.done)metadata.append(element('span','due'+(Date.parse(t.deadlineUtc)<Date.now()?' overdue':''),'截止 · '+displayTime(t.deadlineUtc)));
  if(t.status==='waiting'&&t.followUpUtc&&!t.done)metadata.append(element('span','followup','跟进 · '+displayTime(t.followUpUtc)));
  if(t.repeat&&t.repeat!=='none')metadata.append(element('span','badge',({daily:'每天重复',weekly:'每周重复',monthly:'每月重复'})[t.repeat]));
  if(pendingIds.has(t.id))metadata.append(element('span','pending',conflictIds.has(t.id)?'需处理冲突':'待同步'));main.append(metadata);if(t.notes)main.append(element('p','task-notes',t.notes));content.append(main);
  if(active(t)){const tools=element('div','task-actions');const select=element('select','task-status');select.setAttribute('aria-label','处理状态 '+t.title);select.dataset.action='status';for(const [value,label] of Object.entries(statusNames)){const o=element('option','',label);o.value=value;select.append(o);}select.value=t.status||'todo';select.addEventListener('change',()=>changeWithUndo(t.id,{status:select.value},'状态已改为'+statusNames[select.value]).catch(e=>toast(e.message)));tools.append(select,button('改到明天','row-shortcut',()=>changeWithUndo(t.id,{plannedDate:dateOffset(1)},'已改到明天；原提醒和截止时间保持不变')));const remind=button('改提醒','row-shortcut',()=>openSnooze(t.id,true));remind.dataset.action='remind';tools.append(remind);content.append(tools);}
  row.append(check,content);if(!t.deleted){const star=button(t.important?'★':'☆','star-button'+(t.important?' active':''),()=>toggleTaskWithFeedback(t.id,'important'),t.important?'取消重要标记':'标为重要');star.dataset.action='star';star.title=t.important?'取消重要标记':'标为重要，优先显示';star.setAttribute('aria-pressed',String(t.important));row.append(star);}return row;
}
function renderList(list,pendingIds,conflictIds){
  const existing=new Map([...$('task-list').children].map(e=>[e.dataset.key,e]));const desired=[];let group=null;const groupNames={overdue:'已逾期 / 往日未完成',today:'今天安排',next:'接下来',unplanned:'尚未安排'};
  for(const t of list){const b=bucket(t);if(['today','all','next'].includes(view)&&group!==b){group=b;const key='group-'+b;const h=existing.get(key)||element('h2','list-group',groupNames[b]);h.dataset.key=key;desired.push(h);}
    const key=t.id;const signature=JSON.stringify([t,pendingIds.has(t.id),conflictIds.has(t.id),describe(t),bucket(t)]);let row=existing.get(key);if(!row||row.dataset.signature!==signature){const focused=row?.contains(document.activeElement)?document.activeElement.dataset.action:null;row=taskRow(t,pendingIds,conflictIds);row.dataset.signature=signature;if(focused)row.dataset.restoreFocus=focused;}row.dataset.key=key;desired.push(row);
  }
  let cursor=$('task-list').firstChild;for(const node of desired){if(node===cursor)cursor=cursor.nextSibling;else $('task-list').insertBefore(node,cursor);}const keep=new Set(desired);for(const node of [...$('task-list').children])if(!keep.has(node))node.remove();for(const row of desired){if(row.dataset.restoreFocus){row.querySelector(`[data-action="${row.dataset.restoreFocus}"]`)?.focus({preventScroll:true});delete row.dataset.restoreFocus;}}
}
function render(){
  $('date-label').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  $('view-title').replaceChildren(document.createTextNode(titles[view]),element('span','title-dot','.'));$('breadcrumb-view').textContent=titles[view];
  $('view-subtitle').textContent={today:'先处理眼前的事，往日未完成的安排也会保留。',all:'所有还没完成的事情，都在这里。',next:'给接下来的日子，留一点从容。',important:'把注意力留给真正重要的事。',waiting:'记录下次跟进时间，别让等待变成遗忘。',unplanned:'先记下来，等想清楚了再安排时间。',done:'每一件完成的小事，都算数。',trash:'误删的事情可以还原，原来的内容仍然保留。'}[view];renderCategories();
  for(const f of Object.keys(titles)){$('count-'+f).textContent=tasks.filter(t=>matches(t,f)).length;document.querySelector(`[data-filter="${f}"]`).classList.toggle('active',view===f);}
  const count=tasks.filter(t=>active(t)&&isToday(t)).length;const done=tasks.filter(t=>t.done&&!t.deleted&&t.completedUtc&&localDateTime(t.completedUtc).slice(0,10)===today()).length;
  $('stat-today').textContent=count;$('stat-done').textContent=done;$('stat-overdue').textContent=tasks.filter(t=>active(t)&&t.dueUtc&&Date.parse(t.dueUtc)<=Date.now()).length;
  const percent=count+done?Math.round(done/(count+done)*100):0;$('day-progress').value=percent;$('progress-label').textContent=count+done?`${percent}%`:'还没有安排';
  const pendingIds=new Set(outbox.map(o=>o.taskId));const conflictIds=new Set(outbox.filter(o=>o.conflict).map(o=>o.taskId));
  const ranks={overdue:0,today:1,next:2,unplanned:3};const list=tasks.filter(t=>matches(t,view)&&(!category||t.category===category)&&(!statusFilter||(t.status||'todo')===statusFilter)&&(!search||(t.title+' '+t.notes).toLocaleLowerCase().includes(search))).sort((a,b)=>ranks[bucket(a)]-ranks[bucket(b)]||Number(b.important)-Number(a.important)||(a.deadlineUtc||a.dueUtc||a.plannedDate||'9999').localeCompare(b.deadlineUtc||b.dueUtc||b.plannedDate||'9999')||b.createdUtc.localeCompare(a.createdUtc));
  renderList(list,pendingIds,conflictIds);
  $('empty').hidden=list.length>0;$('empty-title').textContent=search||category?'没有找到匹配的待办':view==='today'?'今天，从一件小事开始':view==='done'?'完成的事情，会留在这里':view==='trash'?'回收站是空的':'这里还没有待办';
  $('empty-description').textContent=search||category?'换个关键词或分类试试。':view==='trash'?'删除的待办可以在这里找回。':'记下要做的事，让脑袋轻松一点。';$('empty-add').hidden=!!search||!!category||['done','trash'].includes(view);
  $('conflict-notice').hidden=!conflictIds.size;$('conflict-message').textContent=`${conflictIds.size}条待办在两端有不同修改，内容已保留。`;
  renderStatus();renderReminders();if(document.body.dataset.module==='ledger')$('breadcrumb-view').textContent='我的账本';
  else if(document.body.dataset.module==='mine')$('breadcrumb-view').textContent='我的';
}
function showDialog(id){if(!$(id).open)$(id).showModal();}
function openEditor(id){
  const t=id?tasks.find(t=>t.id===id):newTask('');if(!t)return;
  if(t.deleted){toast('请先点击左侧还原按钮，再编辑待办。');return;}
  editorBase=id?structuredClone(t):null;$('edit-id').value=id||'';$('editor-heading').textContent=id?'编辑待办':'记一件事';$('edit-title').value=t.title;$('edit-category').value=t.category;$('edit-important').checked=t.important;$('edit-planned').value=t.plannedDate||'';$('edit-due').value=localDateTime(t.dueUtc);$('edit-deadline').value=localDateTime(t.deadlineUtc);$('edit-followup').value=localDateTime(t.followUpUtc);$('edit-status').value=t.status||'todo';$('edit-repeat').value=t.repeat||'none';$('edit-notes').value=t.notes;$('edit-error').textContent='';$('trash-task').hidden=!id;updateEditorFields();syncPlanChips();
  // 已有提醒/截止/跟进/重复/备注时自动展开折叠区，避免用户看不到已填内容。
  const more=$('ed-more');
  if(more)more.open=!!(t.dueUtc||t.deadlineUtc||t.followUpUtc||t.notes||(t.repeat&&t.repeat!=='none'));
  editorInitial=editorSignature();showDialog('editor');$('edit-title').focus();
}
function editorSignature(){return JSON.stringify([...$('editor-form').querySelectorAll('input,textarea,select')].map(e=>e.type==='checkbox'?e.checked:e.value));}
function editorDirty(){return $('editor').open&&editorSignature()!==editorInitial;}
function closeEditor(){if(editorDirty())showDialog('leave-editor');else $('editor').close();}
function updateEditorFields(){$('follow-up-field').hidden=$('edit-status').value!=='waiting';$('repeat-note').hidden=$('edit-repeat').value==='none';}function bind(id,event,fn){$(id).addEventListener(event,e=>{if(event==='submit')e.preventDefault();Promise.resolve().then(()=>fn(e)).catch(error=>toast(error.message));});}
bind('quick-form','submit',async()=>{const title=$('quick-title').value.trim(),submit=$('quick-form').querySelector('button');if(!title||submit.disabled)return;submit.disabled=true;try{const plan=$('quick-plan').value;await mutate(uid(),()=>({...newTask(title),plannedDate:plan==='none'?null:plan==='tomorrow'?dateOffset(1):today()}));$('quick-title').value='';statusFilter='';$('status-filter').value='';view=plan==='none'?'unplanned':plan==='tomorrow'?'next':'today';render();$('quick-title').focus();}finally{submit.disabled=false;}});
for(const id of ['new-task','empty-add'])bind(id,'click',()=>openEditor());
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.dataset.close==='editor'?closeEditor():$(b.dataset.close).close()));
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.filter;render();}));
document.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(x=>x.classList.toggle('selected',x===b));render();}));
bind('search','input',()=>{search=$('search').value.toLocaleLowerCase().trim();render();});
bind('status-filter','change',()=>{statusFilter=$('status-filter').value;render();});
bind('manage-categories','click',async()=>{const input=prompt('填写新分类名称（最多20字）');if(input===null)return;const name=input.trim();if(!name||name.length>20)throw new Error('分类需要填写，最多20字。');extraCategories=[...new Set([...extraCategories,name])];await putMeta('categories',extraCategories);category=name;render();toast('已添加分类，新增待办会归入此分类');});
bind('edit-status','change',updateEditorFields);bind('edit-repeat','change',updateEditorFields);
$('editor').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
bind('continue-editing','click',()=>$('leave-editor').close());bind('discard-editor','click',()=>{$('leave-editor').close();$('editor').close();});
window.addEventListener('beforeunload',e=>{if(editorDirty()){e.preventDefault();e.returnValue='';}});
document.querySelectorAll('[data-plan]').forEach(b=>b.addEventListener('click',()=>{$('edit-planned').value=b.dataset.plan==='none'?'':b.dataset.plan==='tomorrow'?dateOffset(1):today();syncPlanChips();}));
// 「安排到」按钮组需要回显当前选中项：打开编辑时、点按钮时、手改日期时都要同步。
function syncPlanChips(){
  const planned=$('edit-planned').value;
  const todayValue=today();
  for(const b of document.querySelectorAll('.ed-chips [data-plan]')){
    const key=b.dataset.plan;
    const on=key==='none'?planned==='':key==='today'?planned===todayValue:planned===dateOffset(1);
    b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));
  }
}
$('edit-planned').addEventListener('change',syncPlanChips);
$('edit-planned').addEventListener('input',syncPlanChips);
document.querySelectorAll('[data-remind]').forEach(b=>b.addEventListener('click',()=>{const key=b.dataset.remind;let date=new Date();if(key==='none'){$('edit-due').value='';return;}if(key==='hour')date.setHours(date.getHours()+1);if(key==='tomorrow'){date.setDate(date.getDate()+1);date.setHours(9,0,0,0);}if(key==='afternoon'){date.setHours(15,0,0,0);if(date<=new Date())date.setDate(date.getDate()+1);}if(key==='before'){if(!$('edit-deadline').value){toast('请先填写截止时间');return;}date=new Date(new Date($('edit-deadline').value).getTime()-1800000);}$('edit-due').value=localDateTime(date.toISOString());}));
bind('editor-form','submit',async()=>{
  const submit=$('editor-form').querySelector('[type="submit"]');if(submit.disabled)return;
  const id=$('edit-id').value||uid(),title=$('edit-title').value.trim();if(!title){$('edit-error').textContent='先写下要做的事情。';return;}
  const entered=$('edit-due').value;const due=entered?new Date(entered).toISOString():null;
  const toUtc=id=>$(id).value?new Date($(id).value).toISOString():null;
  const patch={title,category:$('edit-category').value.trim(),important:$('edit-important').checked,plannedDate:$('edit-planned').value||null,notes:$('edit-notes').value.trim(),dueUtc:due,status:$('edit-status').value,deadlineUtc:toUtc('edit-deadline'),followUpUtc:toUtc('edit-followup'),repeat:$('edit-repeat').value};
  if(!patch.category){$('edit-error').textContent='请填写分类';return;}
  submit.disabled=true;try{await mutate(id,old=>({...newTask(title),...old,...patch,reminderUtc:old?.dueUtc===due?old.reminderUtc:due,snoozedUntil:old?.dueUtc===due&&old?.followUpUtc===patch.followUpUtc?old?.snoozedUntil:null}),editorBase);$('editor').close();toast('已保存');}finally{submit.disabled=false;}
});
bind('trash-task','click',async()=>{const id=$('edit-id').value;await changeWithUndo(id,{deleted:true},'已移入回收站，可随时还原',editorBase);$('editor').close();});
bind('sync-button','click',async()=>{if(authRequired){lockAccount('请重新登录。');return;}await sync();if(online&&!outbox.length)toast('已同步');});
bind('open-settings','click',async()=>{showDialog('settings');$('account-profile').textContent=account.displayName+' · '+account.username;$('last-sync-info').textContent=lastSync?'最近成功同步：'+new Date(lastSync).toLocaleString('zh-CN'):'还没有成功同步记录';try{const info=await api('/api/info');$('backup-status').textContent=info.backupError||'最近自动备份：'+new Date(info.lastBackup).toLocaleString('zh-CN');}catch{$('backup-status').textContent='暂时无法确认备份状态，仍可导出本机清单。';}});
bind('change-password','click',()=>{$('password-form').reset();$('password-error').textContent='';showDialog('password-dialog');});
bind('password-form','submit',async()=>{const submit=$('password-form').querySelector('button');submit.disabled=true;try{await api('/api/auth/password',{currentPassword:$('current-password').value,password:$('new-password').value});$('password-form').reset();$('password-dialog').close();toast('密码已修改，其他设备需要重新登录。');}catch(e){$('password-error').textContent=e.message;}finally{submit.disabled=false;}});
function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=element('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
bind('export','click',async()=>{await refresh();download(`记得备份-${today()}.json`,{format:'jide-web',formatVersion:2,exportedAt:new Date().toISOString(),workspaceId,tasks,pendingOperations:outbox});toast('已生成备份，请保管好下载的文件');});
bind('import-button','click',()=>$('import-file').click());
function normalizeImport(data){
  let list;if(data.format==='jide-web'&&data.formatVersion===2)list=data.tasks;else if(data.FormatVersion===1&&Array.isArray(data.Items))list=data.Items.map(t=>({id:t.Id,title:t.Title,notes:t.Notes||'',category:t.Category,important:t.Important,done:t.Done,deleted:t.Deleted,plannedDate:t.PlannedDate,dueUtc:t.DueUtc,reminderUtc:t.ReminderUtc}));else throw new Error('请选择记得网页版或桌面版导出的 JSON 备份。');
  if(!Array.isArray(list)||list.length>10000)throw new Error('备份内容无效或记录过多。');
  const seen=new Set();return list.map(t=>{if(!t||!(/^[a-zA-Z0-9_-]{8,100}$/.test(t.id||''))||seen.has(t.id)||typeof t.title!=='string'||!t.title.trim()||t.title.trim().length>160||typeof t.notes!=='string'||t.notes.length>5000||typeof t.category!=='string'||!t.category.trim()||t.category.length>20)throw new Error('备份包含无效或重复记录，尚未导入。');seen.add(t.id);for(const k of ['important','done','deleted'])if(typeof t[k]!=='boolean')throw new Error('备份状态无效，尚未导入。');for(const k of ['dueUtc','reminderUtc','deadlineUtc','followUpUtc','snoozedUntil'])if(t[k]&&(!Number.isFinite(Date.parse(t[k]))))throw new Error('备份时间无效，尚未导入。');if(t.status&&!Object.hasOwn(statusNames,t.status)||t.repeat&&!['none','daily','weekly','monthly'].includes(t.repeat))throw new Error('备份处理状态或重复周期无效。');if(t.plannedDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(t.plannedDate)||!Number.isFinite(Date.parse(t.plannedDate))||new Date(t.plannedDate).toISOString().slice(0,10)!==t.plannedDate))throw new Error('备份计划日期无效，尚未导入。');return {...taskValue(t),id:t.id};});
}
bind('import-file','change',async()=>{const f=$('import-file').files[0];$('import-file').value='';if(!f)return;if(!workspaceId)throw new Error('请先登录你的账号。');if(f.size>20*1024*1024)throw new Error('文件超过20MB限制。');const list=normalizeImport(JSON.parse(await f.text()));await refresh();const current=new Map(tasks.map(t=>[t.id,t]));restoreCandidates=list.map(t=>({incoming:t,current:current.get(t.id)})).filter(x=>!x.current||JSON.stringify(taskValue(x.current))!==JSON.stringify(taskValue(x.incoming)));
  if(!restoreCandidates.length){toast('已合并0条新记录，已有编号保持不变');return;}
  $('restore-summary').textContent=`备份中${list.length}条记录，其中${restoreCandidates.filter(x=>!x.current).length}条新记录、${restoreCandidates.filter(x=>x.current).length}条内容不同。`;$('restore-list').replaceChildren();
  for(const [index,c] of restoreCandidates.entries()){const card=element('section','restore-card');const label=element('label','check-label');const check=element('input');check.type='checkbox';check.checked=!c.current;check.dataset.restoreIndex=index;label.append(check,document.createTextNode((c.current?'恢复已有：':'新增：')+c.incoming.title));card.append(label);const summary=t=>`${t.title}\n${t.notes||'无备注'}\n${t.deleted?'已删除':t.done?'已完成':statusNames[t.status||'todo']} · ${t.category}\n计划：${t.plannedDate||'无'}；截止：${t.deadlineUtc?displayTime(t.deadlineUtc):'无'}；提醒：${t.dueUtc?displayTime(t.dueUtc):'无'}`;if(c.current)card.append(element('p','','当前：'+summary(c.current)));card.append(element('p','','备份：'+summary(c.incoming)));$('restore-list').append(card);}showDialog('restore-dialog');
});
bind('apply-restore','click',async()=>{const selected=[...$('restore-list').querySelectorAll('input:checked')].map(e=>restoreCandidates[Number(e.dataset.restoreIndex)]);if(!selected.length)throw new Error('请勾选要恢复的记录。');if(tasks.length+selected.filter(c=>!c.current).length>10000)throw new Error('恢复后将超过10000条上限。');$('apply-restore').disabled=true;let count=0;try{download(`恢复前备份-${Date.now()}.json`,{format:'jide-web',formatVersion:2,tasks:await rows('tasks'),pendingOperations:await rows('outbox'),exportedAt:new Date().toISOString()});for(const c of selected){await mutate(c.incoming.id,()=>c.incoming,c.current||{id:c.incoming.id,version:0},'restore');count++;}$('restore-dialog').close();toast(`已恢复${count}条，等待同步确认`);}catch(e){throw new Error(`已处理${count}条，其余未完成：${e.message}`);}finally{$('apply-restore').disabled=false;}});
// 添加到主屏：优先使用浏览器的原生安装提示（Chromium 系），iOS Safari 不支持则只显示文字引导。
let deferredInstall=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;const b=$('a2hs-button');if(b)b.hidden=false;});
bind('a2hs-button','click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('a2hs-button').hidden=true;});
if(window.matchMedia('(display-mode: standalone)').matches){const tip=$('a2hs-tip');if(tip)tip.textContent='你已经在从主屏打开记得。';const b=$('a2hs-button');if(b)b.hidden=true;}
bind('logout','click',async()=>{await refresh();if(outbox.length)throw new Error('还有未同步的修改，请先同步或导出备份。');if(!confirm('退出当前账号？你的清单会继续保存在服务端。'))return;await api('/api/auth/logout',{});accountEvents?.postMessage({type:'logout',id:account.id});lockAccount('已退出账号。');location.reload();});
bind('review-conflicts','click',()=>{renderConflicts();showDialog('conflicts');});
function renderConflicts(){
  $('conflict-list').replaceChildren();const seen=new Set();
  for(const o of outbox.filter(x=>x.conflict)){if(seen.has(o.taskId))continue;seen.add(o.taskId);const mine=tasks.find(t=>t.id===o.taskId),remote=o.current;const card=element('div','conflict-card');card.append(element('h3','',mine?.title||'待办'),element('p','',`此设备：${mine?.title}\n${mine?.notes||'无备注'}\n${mine?.deleted?'已移入回收站':mine?.done?'已完成':'未完成'}`),element('p','',`已同步版本：${remote?.title||'记录不存在'}\n${remote?.notes||'无备注'}\n${remote?.deleted?'已移入回收站':remote?.done?'已完成':'未完成'}`));
    card.append(button('保留两份','primary',()=>resolveConflict(o,true)),button('只保留已同步版本','secondary',async()=>{if(confirm('放弃此设备对这条待办的修改，仅保留已同步版本？'))await resolveConflict(o,false);}));$('conflict-list').append(card);
  }
}
async function resolveConflict(op,keepBoth){
  await transaction(['tasks','outbox'],tx=>{const r=tx.objectStore('tasks').get(op.taskId);r.onsuccess=()=>{const mine=r.result;if(keepBoth&&mine){const id=uid(),now=new Date().toISOString(),value={...taskValue(mine),title:mine.title.slice(0,151)+'（本机副本）'};tx.objectStore('tasks').put({...value,id,version:1,createdUtc:now,updatedUtc:now});tx.objectStore('outbox').add({id:uid(),taskId:id,baseVersion:0,value,created:now});}if(op.current)tx.objectStore('tasks').put(op.current);else tx.objectStore('tasks').delete(op.taskId);const q=tx.objectStore('outbox').getAll();q.onsuccess=()=>{for(const o of q.result)if(o.taskId===op.taskId)tx.objectStore('outbox').delete(o.seq);};};});
  await refresh();renderConflicts();if(!outbox.some(o=>o.conflict))$('conflicts').close();channel?.postMessage('change');void sync();toast(keepBoth?'已保留已同步版本和本机副本':'已保留已同步版本');
}
function renderReminders(){if(accountLocked){$('reminders').replaceChildren();return;}
  const due=tasks.filter(t=>active(t)&&reminderTime(t)<=Date.now()).sort((a,b)=>reminderTime(a)-reminderTime(b)).slice(0,3);
  const signature=due.map(t=>t.id+t.updatedUtc).join(',');if($('reminders').dataset.signature===signature)return;$('reminders').dataset.signature=signature;$('reminders').replaceChildren();
  for(const t of due){const card=element('div','reminder-card');card.append(element('small','',t.status==='waiting'&&t.followUpUtc&&Date.parse(t.followUpUtc)<=Date.now()?'该跟进了 · 页面内提醒':'到时间了 · 页面内提醒'),element('h3','',t.title),button('完成','primary',()=>toggleTaskWithFeedback(t.id,'done')),button('10分钟后提醒','secondary',()=>snooze(t.id,new Date(Date.now()+600000))),button('更多时间','text-button',()=>openSnooze(t.id)),button('查看','text-button',()=>openEditor(t.id)));$('reminders').append(card);}
}
function reminderTime(t){const reminder=t.dueUtc?Math.max(Date.parse(t.dueUtc),Date.parse(t.reminderUtc||t.dueUtc)):Infinity;const follow=t.status==='waiting'&&t.followUpUtc?Date.parse(t.followUpUtc):Infinity;return Math.max(Math.min(reminder,follow),t.snoozedUntil?Date.parse(t.snoozedUntil):0);}
function openSnooze(id,edit=false){snoozeId=id;snoozeIsEdit=edit;const t=tasks.find(x=>x.id===id);if(!t)return;$('snooze-heading').textContent=edit?'修改提醒时间':'稍后提醒';$('snooze-task-title').textContent=t.title;$('snooze-time').value=localDateTime(new Date(Date.now()+3600000).toISOString());showDialog('snooze-dialog');}
async function snooze(id,date,edit=false){if(!Number.isFinite(date.getTime())||date<=new Date())throw new Error('请选择将来的提醒时间。');const t=tasks.find(x=>x.id===id);const patch={snoozedUntil:date.toISOString()};if(edit||!t.dueUtc&&!(t.status==='waiting'&&t.followUpUtc)){patch.dueUtc=date.toISOString();patch.reminderUtc=date.toISOString();}await changeWithUndo(id,patch,'提醒已改到 '+displayTime(date.toISOString()));if($('snooze-dialog').open)$('snooze-dialog').close();}
document.querySelectorAll('[data-snooze]').forEach(b=>b.addEventListener('click',()=>{let date=new Date();if(b.dataset.snooze==='tomorrow'){date.setDate(date.getDate()+1);date.setHours(9,0,0,0);}else date=new Date(Date.now()+Number(b.dataset.snooze)*60000);snooze(snoozeId,date,snoozeIsEdit).catch(e=>toast(e.message));}));
bind('snooze-form','submit',()=>snooze(snoozeId,new Date($('snooze-time').value),snoozeIsEdit));
function lockAccount(message){ledgerUI.lock();ledgerUI.setView('memo');accountLocked=true;online=false;authRequired=true;document.body.dataset.auth='guest';for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();$('reminders').replaceChildren();$('auth-message').textContent=message||'请登录你的账号。';$('auth-password').value='';}
function authModeSet(mode){authMode=mode;$('auth-name-field').hidden=mode!=='register';$('auth-recovery-field').hidden=mode!=='recover';$('auth-recovery').required=mode==='recover';$('auth-heading').textContent=mode==='register'?'开始自己的清单':mode==='recover'?'找回自己的账号':'回到自己的清单';$('auth-password-label').textContent=mode==='recover'?'设置新密码':'密码';$('auth-password').autocomplete=mode==='login'?'current-password':'new-password';$('auth-submit').textContent=mode==='register'?'创建我的清单':mode==='recover'?'重设密码':'登录并进入';$('auth-error').textContent='';document.querySelectorAll('[data-auth-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.authMode===mode));}
document.querySelectorAll('[data-auth-mode]').forEach(b=>b.addEventListener('click',()=>authModeSet(b.dataset.authMode)));
bind('auth-recover-button','click',()=>authModeSet('recover'));
bind('auth-form','submit',async()=>{const submit=$('auth-submit');if(submit.disabled)return;submit.disabled=true;$('auth-error').textContent='';try{const result=await api('/api/auth/'+authMode,{username:$('auth-username').value.trim(),password:$('auth-password').value,displayName:$('auth-name').value,recoveryCode:$('auth-recovery').value.trim()});$('auth-password').value='';$('auth-recovery').value='';accountEvents?.postMessage({type:'login',id:result.account.id});if(result.recoveryCode){recoveryValue=result.recoveryCode;$('recovery-code').textContent=recoveryValue;$('auth-entry').hidden=true;$('recovery-panel').hidden=false;}else location.reload();}catch(e){$('auth-error').textContent=e.message;}finally{submit.disabled=false;}});
bind('download-recovery','click',()=>{const blob=new Blob(['记得账号：'+$('auth-username').value.trim()+'\n恢复码：'+recoveryValue+'\n请妥善保管，不要转发给他人。'],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='记得-账号恢复码.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
bind('recovery-continue','click',()=>location.reload());
accountEvents?.addEventListener('message',e=>{if(account&&(e.data.type==='logout'&&e.data.id===account.id||e.data.type==='login'&&e.data.id!==account.id))lockAccount('另一个页面已切换或退出账号，请重新登录。未同步记录仍保留在原账号的本机缓存中。');});
async function boot(){
  try{const config=await api('/api/auth/config');document.querySelector('[data-auth-mode="register"]').hidden=!config.registrationOpen;const result=await api('/api/auth/me');account=result.account;}catch(e){lockAccount(e.status===401?'登录后继续自己的清单。':'暂时无法连接服务。请联网后再登录。');return;}
  try{
    const open=indexedDB.open('jide-account-'+account.id,1);open.onupgradeneeded=()=>{const d=open.result;d.createObjectStore('tasks',{keyPath:'id'});d.createObjectStore('outbox',{keyPath:'seq',autoIncrement:true});d.createObjectStore('meta',{keyPath:'key'});};db=await request(open);db.onversionchange=()=>db.close();
    workspaceId=account.id;lastSync=(await meta('lastSync'))?.value||null;extraCategories=(await meta('categories'))?.value||[];accountLocked=false;channel='BroadcastChannel' in window?new BroadcastChannel('jide-changes-'+account.id):null;$('current-account-name').textContent=account.displayName;await refresh();await sync();if(!accountLocked){document.body.dataset.auth='ready';await ledgerUI.init();ledgerUI.initPreferences();ledgerUI.setView('memo');}
    if('serviceWorker' in navigator&&isSecureContext){try{await navigator.serviceWorker.register('/sw.js');}catch{toast('页面缓存未成功启用，请保持联网。');}}
    setInterval(()=>{if(!document.hidden)void sync();},5000);setInterval(renderReminders,1000);window.addEventListener('online',()=>void sync());document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!accountLocked){render();void sync();}});
    channel?.addEventListener('message',async e=>{if(accountLocked)return;await refresh();if(e.data==='change')void sync();});
  }catch(e){lockAccount('暂时无法读取本机缓存，请检查浏览器存储空间后刷新。');}
}
if(new URLSearchParams(location.search).has('compact'))document.body.classList.add('compact');
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();$('search').focus();}});
const ledgerUI=createLedgerUI({api,toast,getAccount:()=>account,getLastSync:()=>lastSync,download});
void boot();
