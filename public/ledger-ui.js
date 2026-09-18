import {cents,totals,reminders,mealNames,zoned,shiftMonth} from './ledger-model.js';
const $=id=>document.getElementById(id),money=n=>(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
// 生成随机编号。
// 注意：crypto.randomUUID 只在「安全上下文」（HTTPS 或 localhost）可用，
// 通过局域网 IP（如 192.168.x.x）访问时不存在，直接调用会导致整个脚本崩溃。
// 因此优先用 getRandomValues（非安全上下文也可用），并保留逐级兜底。
const uid=()=>{
  try{
    if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID().replaceAll('-','');
    if(typeof crypto!=='undefined'&&typeof crypto.getRandomValues==='function')return Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  }catch{}
  // 最后兜底：仅用于本地记录编号，不承担加密用途。
  return Date.now().toString(16)+Math.random().toString(16).slice(2,10);
};
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
export function createLedgerUI({api,toast,getAccount,getLastSync,openSettings,download}){
  let state=null,active=false,locked=true,loading=false,mutation=false,editing=null,recordKey=null,promptKeys=[],sessionSeen=new Set(),client=uid(),requestId=null;
  // 金额隐藏：只影响显示，不影响任何计算与保存。偏好存在本机 localStorage。
  const HIDE_KEY='jide-hide-amount';
  let hideAmount=false;
  try{hideAmount=localStorage.getItem(HIDE_KEY)==='1';}catch{}
  const money=n=>hideAmount?'••••':(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const applyHide=()=>{document.body.dataset.hideAmount=hideAmount?'1':'0';};
  const workspace=document.querySelector('main .workspace');workspace.id='memo-workspace';document.querySelector('#filters').insertAdjacentHTML('afterend','<div id=ledger-side hidden><p class=ledger-side-note>随手记账，按时缴费。<br>让每一笔开销都有去处。</p></div>');
  document.querySelector('.topbar').insertAdjacentHTML('afterend','<nav class="module-switch" aria-label="应用入口"><button id="enter-memo" class="selected" aria-pressed="true">✓ 备忘录</button><button id="enter-ledger" aria-pressed="false">¥ 记账 <span id="ledger-badge" hidden>有待处理</span></button></nav>');
  // 手机底部标签栏：备忘录｜记账｜我的。窄屏显示，桌面隐藏（由 CSS 控制）。
  document.body.insertAdjacentHTML('beforeend',`<nav class="mobile-tabs" aria-label="手机导航">
    <button data-tab="memo" class="selected" aria-pressed="true"><span class="tab-icon">✓</span><span class="tab-label">备忘录</span></button>
    <button data-tab="ledger" aria-pressed="false"><span class="tab-icon">¥</span><span class="tab-label">记账</span><span id="ledger-tab-badge" hidden></span></button>
    <button data-tab="mine" aria-pressed="false"><span class="tab-icon">☺</span><span class="tab-label">我的</span></button>
  </nav>`);
  workspace.insertAdjacentHTML('afterend',`<section id="ledger-workspace" class="workspace" hidden aria-label="我的记账">
    <div class="page-heading"><div><p class="eyebrow">把每一笔，记在心里</p><h1>我的账本<span class="title-dot">.</span></h1><p class="subtitle">日常开销、固定缴费，在这里慢慢理清。</p></div><button id="ledger-add" class="primary">＋ 记一笔</button></div>
    <p id="ledger-status" class="field-note" role="status">正在读取账本…</p>
    <div class="ledger-toolbar"><label>查看月份 <input id="ledger-month" type="month" min="2000-01" max="2099-12"></label><div class="button-row"><button id="ledger-refresh" class="text-button">刷新账本</button><button id="ledger-export" class="text-button">导出账本</button><button id="ledger-settings-open" class="secondary">缴费与提醒</button></div></div>
    <section class="summary-strip ledger-summary" aria-label="本月收支"><div><span class="stat-name">收入</span><strong id="ledger-income">—</strong></div><div><span class="stat-name">净支出</span><strong id="ledger-expense">—</strong></div><div><span class="stat-name">收支结余</span><strong id="ledger-balance">—</strong></div><div><span class="stat-name">预算剩余</span><strong id="ledger-left">未设置</strong><button id="ledger-budget-open" class="text-button">设置预算</button></div></section>
    <p class="summary-caveat">按已记录的账目统计，不是银行卡真实余额。转账不计入收支。</p>
    <p id="ledger-comparison" class="field-note"></p><div id="ledger-due" class="ledger-due" hidden><div><strong id="ledger-due-title"></strong><p>记一笔，或安排稍后再提醒。</p></div><button id="ledger-due-open" class="secondary">查看提醒</button></div>
    <section class="ledger-breakdown" aria-label="支出分类"><h2>钱花在哪里</h2><div id="ledger-categories"></div></section>
    <div class="ledger-toolbar"><h2>账目明细</h2><div class="ledger-filters"><select id="ledger-kind" aria-label="账目类型"><option value="">全部类型</option><option value="expense">支出</option><option value="income">收入</option><option value="refund">退款</option><option value="transfer">转账</option><option value="trash">回收站</option></select><input id="ledger-search" type="search" placeholder="搜索分类、备注或场景" aria-label="搜索账目"></div></div>
    <div id="ledger-list" class="task-list"></div><p id="ledger-empty" class="empty-state">还没有账目。先记一笔今天的开销吧。</p>
    <footer class="page-footer"><span>人民币 · 转账不计入收支，退款按到账月抵减支出</span><span>记账需要联网，显示“已保存”后才算入账</span></footer>
  </section>
  <section id="mine-workspace" class="workspace" hidden aria-label="我的">
    <div class="page-heading"><div><p class="eyebrow">你的记录，都在这里</p><h1>我的<span class="title-dot">.</span></h1><p class="subtitle">账号、显示偏好与本机清单备份。</p></div></div>
    <section class="settings-section" id="mine-stats-section"><h3>我的记录</h3><div class="mine-stats" id="mine-stats"></div></section>
    <section class="settings-section"><h3>账号</h3><p id="mine-account"></p><p class="field-note">手机和电脑登录同一账号即可同步。每个账号拥有独立清单与账本。</p><div class="button-row"><button id="mine-change-password" class="secondary">修改密码</button><button id="mine-logout" class="danger-text">退出账号</button></div></section>
    <section class="settings-section"><h3>显示偏好</h3><label class="check-label"><input id="mine-hide-amount" type="checkbox"> 隐藏金额</label><p class="field-note">打开后，账本与统计中的金额会显示为「¥••••」。适合在地铁、办公室等公共场合使用。此设置保存在本机。</p></section>
    <section class="settings-section"><h3>备份与恢复</h3><p id="mine-backup-status"></p><p>导出自己的清单；导入时先预览，再选择要恢复的事项。</p><div class="button-row"><button id="mine-export" class="secondary">导出 JSON 备份</button><button id="mine-import-button" class="secondary">导入 / 恢复预览</button></div><p id="mine-last-sync" class="field-note"></p></section>
    <section class="settings-section"><h3>添加到手机主屏</h3><p id="mine-a2hs-tip">在手机上打开本页面后，用浏览器的「添加到主屏幕」即可像 App 一样使用。</p><p class="field-note">iPhone：Safari 底部「分享」→「添加到主屏幕」。安卓：浏览器菜单 →「添加到主屏幕」。</p></section>
  </section>`);
  document.body.insertAdjacentHTML('beforeend',`<dialog id="ledger-editor" aria-labelledby="ledger-editor-title"><form id="ledger-form">
    <div class="dialog-heading"><h2 id="ledger-editor-title">记一笔</h2><button type="button" data-ledger-close="ledger-editor" class="icon-button" aria-label="关闭记账">×</button></div>
    <div class="le-body">
      <div class="le-kind-switch" role="group" aria-label="账目类型"><button type="button" data-kind="expense" class="selected">支出</button><button type="button" data-kind="income">收入</button><button type="button" data-kind="transfer">转账</button><button type="button" data-kind="refund">退款</button><select id="le-kind" class="sr-only" tabindex="-1" aria-hidden="true"><option value="expense">支出</option><option value="income">收入</option><option value="transfer">转账</option><option value="refund">退款</option></select></div>
      <label class="le-amount-field">金额（元）<input id="le-amount" inputmode="decimal" placeholder="0.00" required maxlength="12" autocomplete="off"></label>
      <div class="le-quick-cats" id="le-cat-row" role="group" aria-label="常用分类"></div>
      <p class="le-divider">以上必填，下面可以只填日期</p>
      <label>分类<input id="le-category" list="ledger-category-options" maxlength="20" required><datalist id="ledger-category-options"><option>餐饮</option><option>交通</option><option>购物</option><option>住房</option><option>水电</option><option>娱乐</option><option>医疗</option><option>人情</option><option>工资</option><option>其他</option></datalist></label>
      <div class="form-row"><label>日期<input id="le-date" type="date" min="2000-01-01" max="2099-12-31" required></label><label id="le-meal-field">餐次<select id="le-meal"><option value="">其他／不区分</option><option value="breakfast">早餐</option><option value="lunch">午饭</option><option value="dinner">晚饭</option></select></label></div>
      <label id="le-refund-field" hidden>关联原消费<select id="le-refund"></select></label>
      <details class="le-more" id="le-more"><summary>更多选项<span class="le-more-hint">账户、场景、备注</span></summary>
        <div class="form-row"><label>付款／收款账户<input id="le-account" list="ledger-account-options" maxlength="30" placeholder="如微信、银行卡"><datalist id="ledger-account-options"><option>微信</option><option>支付宝</option><option>银行卡</option><option>现金</option></datalist></label><label id="le-to-field" hidden>转入账户<input id="le-to" list="ledger-account-options" maxlength="30"></label></div>
        <label>场景<input id="le-tag" maxlength="30" placeholder="如旅行、工作、装修"></label><label>备注<input id="le-note" maxlength="200" placeholder="这笔钱用在了哪里"></label>
      </details>
      <p id="le-error" class="form-error" role="alert"></p>
    </div>
    <div class="dialog-actions"><button type="button" id="le-delete" class="danger-text" hidden>移入回收站</button><button id="le-submit" type="submit" class="primary">保存账目</button></div>
  </form></dialog>
  <dialog id="ledger-reminder-settings" aria-labelledby="ledger-reminder-title"><div class="dialog-heading"><h2 id="ledger-reminder-title">缴费与提醒</h2><button data-ledger-close="ledger-reminder-settings" class="icon-button" aria-label="关闭提醒设置">×</button></div>
    <p class="field-note">到时间后，在记账页面内提示；关闭网页或锁屏时不保证提醒送达。设置会同步到同一账号。</p>
    <h3>日常记账习惯</h3><form id="meal-settings-form"><label>提醒时区<select id="meal-zone"><option value="Asia/Shanghai">中国标准时间（上海）</option></select></label><div id="meal-settings-fields"></div><button type="submit" class="primary">保存日常提醒</button><p id="meal-settings-error" class="form-error" role="alert"></p></form>
    <section class="settings-section"><div class="ledger-toolbar"><h3>固定缴费</h3><button id="bill-add" class="secondary">＋ 添加缴费</button></div><div id="bill-list"></div></section>
  </dialog>
  <dialog id="bill-editor" aria-labelledby="bill-title"><form id="bill-form"><div class="dialog-heading"><h2 id="bill-title">固定缴费</h2><button type="button" data-ledger-close="bill-editor" class="icon-button" aria-label="关闭缴费编辑">×</button></div>
    <label>缴费名称<input id="bill-name" required maxlength="60" placeholder="房租、水电、宽带……"></label><div class="form-row"><label>每期金额（可留空）<input id="bill-amount" inputmode="decimal" placeholder="付款时再填"></label><label>分类<input id="bill-category" list="ledger-category-options" required maxlength="20"></label></div>
    <div class="form-row"><label>每月几号<input id="bill-day" type="number" min="1" max="31" required></label><label>周期<select id="bill-interval"><option value="1">每月</option><option value="2">每两个月</option><option value="3">每季度</option><option value="6">每半年</option><option value="12">每年</option></select></label></div>
    <div class="form-row"><label>从哪月开始<input id="bill-start" type="month" min="2000-01" max="2099-12" required></label><label>提前提醒<select id="bill-advance"><option value="0">当天</option><option value="1">提前1天</option><option value="3">提前3天</option><option value="7">提前7天</option></select></label></div>
    <label class="check-label"><input id="bill-enabled" type="checkbox" checked>启用此缴费提醒</label><p class="field-note">遇到没有31日的月份，按当月最后一天提醒。只有确认已缴费才入账；未处理的往期缴费会保留。</p><p id="bill-error" class="form-error" role="alert"></p><button class="primary" type="submit">保存缴费提醒</button></form></dialog>
  <dialog id="ledger-prompts" aria-labelledby="ledger-prompts-title"><div class="dialog-heading"><div><p class="eyebrow">留一点时间，记下今天</p><h2 id="ledger-prompts-title">有几笔开销要记一下</h2></div><button id="ledger-prompts-close" class="icon-button" aria-label="全部稍后提醒">×</button></div><p class="field-note">已记过的餐费不再提醒；午饭和晚饭错过时会在这里一起显示。</p><div id="ledger-prompt-list"></div><p id="ledger-prompt-error" class="form-error" role="alert"></p><button id="ledger-prompts-later" class="text-button">全部30分钟后提醒</button></dialog>
  <dialog id="ledger-budget" aria-labelledby="ledger-budget-title"><form id="ledger-budget-form"><div class="dialog-heading"><h2 id="ledger-budget-title">设置月预算</h2><button type="button" data-ledger-close="ledger-budget" class="icon-button" aria-label="关闭预算设置">×</button></div><p id="budget-month-label"></p><label>预算金额（元）<input id="budget-amount" inputmode="decimal" required></label><p class="field-note">填写0可取消本月预算。预算仅作为提示，不影响记账。</p><p id="budget-error" class="form-error" role="alert"></p><button class="primary">保存预算</button></form></dialog>`);
  for(const [key,name] of Object.entries(mealNames))$('meal-settings-fields').insertAdjacentHTML('beforeend',`<div class="meal-setting"><label class="check-label"><input id="meal-${key}-enabled" type="checkbox">${name}提醒</label><label>提醒时间<input id="meal-${key}-time" type="time" required></label><label class="check-label"><input id="meal-${key}-weekdays" type="checkbox">仅工作日</label></div>`);
  const event=(id,type,fn)=>$(id).addEventListener(type,e=>{if(type==='submit')e.preventDefault();Promise.resolve(fn(e)).catch(err=>toast(err.message));});
  const actionButton=(text,fn,cls='text-button')=>{const b=node('button',cls,text);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;};
  const today=()=>zoned(new Date(),state?.settings.timeZone||'Asia/Shanghai').date;
  // setView 支持三视图：'memo' | 'ledger' | 'mine'
  function setView(target){
    const value=target==='ledger';                       // 是否处于记账模块
    active=value;
    $('filters').hidden=value||target==='mine';
    $('ledger-side').hidden=!value;
    document.querySelector('.nav-label').textContent=value?'我的账本':'我的清单';
    workspace.hidden=value||target==='mine';
    $('ledger-workspace').hidden=!value;
    $('mine-workspace').hidden=target!=='mine';
    document.body.dataset.module=target;
    $('enter-memo').classList.toggle('selected',target==='memo');
    $('enter-ledger').classList.toggle('selected',value);
    $('enter-memo').setAttribute('aria-pressed',String(target==='memo'));
    $('enter-ledger').setAttribute('aria-pressed',String(value));
    for(const b of document.querySelectorAll('.mobile-tabs [data-tab]')){
      const on=b.dataset.tab===target;
      b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));
    }
    if(target==='ledger'){$('breadcrumb-view').textContent='我的账本';void refresh(true);}
    else $('ledger-prompts').close();
    if(target==='mine')renderMine();
  }
  const setModule=value=>setView(value?'ledger':'memo');
  for(const b of document.querySelectorAll('.mobile-tabs [data-tab]'))b.addEventListener('click',()=>setView(b.dataset.tab));
  event('enter-memo','click',()=>setModule(false));event('enter-ledger','click',()=>setModule(true));document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>setModule(false)));
  let originalForm='',billEditing=null,entryVersion=0,billVersion=0,settingsVersion=0,budgetVersion=0,entryOp=null,entryPayload='';
  const signature=()=>JSON.stringify([...$('ledger-form').querySelectorAll('input,select')].map(e=>e.value));
  function closeEditor(){if(signature()!==originalForm&&!confirm('这笔账还没有保存，确定放弃吗？'))return;$('ledger-editor').close();if(recordKey){const r=reminders(state).find(x=>x.key===recordKey);if(r)void respond(r,'snooze');}}
  document.querySelectorAll('[data-ledger-close]').forEach(b=>b.onclick=()=>{if(b.dataset.ledgerClose==='ledger-editor')closeEditor();else $(b.dataset.ledgerClose).close();});
  $('ledger-editor').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
  window.addEventListener('beforeunload',e=>{if($('ledger-editor').open&&signature()!==originalForm){e.preventDefault();e.returnValue='';}});
  function fields(){const kind=$('le-kind').value;$('le-meal-field').hidden=kind!=='expense';$('le-to-field').hidden=kind!=='transfer';$('le-to').required=kind==='transfer';$('le-account').required=kind==='transfer';$('le-refund-field').hidden=kind!=='refund';$('le-refund').required=kind==='refund';}
  function openEntry(entry=null,reminder=null){
    if(!state)throw new Error('请先联网读取账本。');entryVersion=state.version;entryOp=null;entryPayload='';editing=entry?structuredClone(entry):null;recordKey=reminder?.key||null;requestId=uid();$('ledger-form').reset();$('le-error').textContent='';$('ledger-editor-title').textContent=reminder?(reminder.type==='meal'?reminder.title:'确认缴费 · '+reminder.title):entry?'编辑账目':'记一笔';
    $('le-kind').value=entry?.kind||'expense';$('le-kind').disabled=!!reminder;$('le-amount').value=entry?String(entry.amount/100):reminder?.amount?String(reminder.amount/100):'';$('le-date').value=entry?.date||today();$('le-date').disabled=reminder?.type==='meal';$('le-category').value=entry?.category||reminder?.category||'餐饮';$('le-meal').value=entry?.meal||reminder?.meal||'';$('le-meal').disabled=reminder?.type==='meal';$('le-account').value=entry?.account||'';$('le-to').value=entry?.toAccount||'';$('le-tag').value=entry?.tag||'';$('le-note').value=entry?.note||(reminder?.type==='bill'?reminder.title+' · '+reminder.date.slice(0,7):'');
    $('le-refund').replaceChildren(node('option','','请选择原消费'));$('le-refund').firstChild.value='';for(const e of state.entries.filter(e=>!e.deleted&&e.kind==='expense')){const o=node('option','',`${e.date} ${e.note||e.category} ¥${money(e.amount)}`);o.value=e.id;$('le-refund').append(o);}$('le-refund').value=entry?.refundOf||'';$('le-delete').hidden=!entry;fields();
    // 类型按钮与常用分类同步到当前值
    syncKindButtons();renderEditorCats($('le-category').value);
    // 已有内容或特殊类型时自动展开「更多选项」，避免用户看不到已填信息。
    const more=$('le-more');
    if(more)more.open=!!(entry?.account||entry?.toAccount||entry?.tag||entry?.note)||['transfer','refund'].includes($('le-kind').value);
    originalForm=signature();$('ledger-editor').showModal();$('le-amount').focus();
  }
  async function save(action,value,extra={},operationId=uid()){
    if(mutation)throw new Error('正在保存，请稍候。');if(locked)throw new Error('请先登录。');mutation=true;
    try{const next=await api('/api/ledger/op',{id:operationId,version:state.version,action,value,...extra});if(locked)return;if(!state||next.version>=state.version)state=next;render();$('ledger-status').textContent='账本已保存 · '+new Date().toLocaleTimeString('zh-CN');return next;}catch(e){if(e.status===409)await refresh(false);if(!e.status)e.message='暂时无法连接，内容仍在编辑框。请联网后重试。';throw e;}finally{mutation=false;}
  }
  event('ledger-add','click',()=>{if(window.matchMedia('(max-width:760px)').matches&&typeof openQuickSheet==='function'){openQuickSheet();}else openEntry();});event('le-kind','change',()=>{fields();$('le-category').value={expense:'餐饮',income:'工资',transfer:'转账',refund:'退款'}[$('le-kind').value];});
  // 类型改为按钮组：省去一次点开下拉，手机上一眼看清有哪些选择。
  const KIND_LABEL={expense:'支出',income:'收入',transfer:'转账',refund:'退款'};
  function syncKindButtons(){
    const value=$('le-kind').value;
    for(const b of document.querySelectorAll('.le-kind-switch [data-kind]'))b.classList.toggle('selected',b.dataset.kind===value);
  }
  for(const b of document.querySelectorAll('.le-kind-switch [data-kind]'))b.addEventListener('click',()=>{
    if($('le-kind').disabled)return;
    $('le-kind').value=b.dataset.kind;
    $('le-category').value={expense:'餐饮',income:'工资',transfer:'转账',refund:'退款'}[b.dataset.kind];
    fields();syncKindButtons();renderEditorCats($('le-category').value);
  });
  // 记账弹窗内的常用分类快捷按钮，与快速面板共用同一份分类表。
  function renderEditorCats(selected){
    const row=$('le-cat-row');if(!row)return;row.replaceChildren();
    for(const name of QUICK_CATS){
      const b=node('button','quick-cat'+(name===selected?' selected':''),name);b.type='button';
      b.onclick=()=>{$('le-category').value=name;renderEditorCats(name);};
      row.append(b);
    }
  }
  event('le-category','input',()=>renderEditorCats($('le-category').value));
  event('ledger-form','submit',async()=>{$('le-submit').disabled=true;try{const value={id:editing?.id||requestId,kind:$('le-kind').value,amount:cents($('le-amount').value.trim()),date:$('le-date').value,category:$('le-category').value,meal:$('le-meal').value,account:$('le-account').value,toAccount:$('le-to').value,refundOf:$('le-refund').value,tag:$('le-tag').value,note:$('le-note').value,deleted:false};const payload=JSON.stringify(value);if(payload!==entryPayload){entryOp=uid();entryPayload=payload;}await save('entry',value,{version:entryVersion,...(recordKey?{reminderKey:recordKey}:{})},entryOp);$('ledger-editor').close();toast('已保存这笔账');await refresh(false);}catch(e){if(e.status===409)entryVersion=state.version;$('le-error').textContent=e.message;}finally{$('le-submit').disabled=false;}});
  event('le-delete','click',async()=>{if(!confirm('将这笔账移入回收站？可以在明细的回收站中恢复。'))return;try{await save('entry',{...editing,deleted:true},{version:entryVersion});$('ledger-editor').close();toast('已移入回收站');}catch(e){if(e.status===409)entryVersion=state.version;$('le-error').textContent=e.message;}});
  function render(){if(!state||locked)return;const month=$('ledger-month').value,summary=totals(state.entries,month),budget=state.budgets[month]||0;
    $('ledger-income').textContent=money(summary.income);$('ledger-expense').textContent=money(summary.expense);$('ledger-balance').textContent=money(summary.balance);$('ledger-left').textContent=budget?money(budget-summary.expense):'未设置';$('ledger-left').classList.toggle('over-budget',budget>0&&summary.expense>budget);
    const previous=totals(state.entries,shiftMonth(month,-1)),diff=summary.expense-previous.expense;$('ledger-comparison').textContent=`比上月净支出${diff>=0?'多':'少'} ¥${money(Math.abs(diff))}（按当前已录入账目比较）${budget&&summary.expense>=budget*.8?' · '+(summary.expense>budget?'已超出预算':'本月预算已使用80%以上'):''}`;
    const due=reminders(state);$('ledger-badge').hidden=!due.length;$('ledger-due').hidden=!due.length;$('ledger-due-title').textContent=`${due.length}项记账／缴费提醒待处理`;
    const tabBadge=$('ledger-tab-badge');if(tabBadge){tabBadge.hidden=!due.length;tabBadge.textContent=due.length>9?'9+':String(due.length);}
    const cats=new Map();for(const e of state.entries.filter(e=>!e.deleted&&e.date.startsWith(month)&&['expense','refund'].includes(e.kind)))cats.set(e.category,(cats.get(e.category)||0)+(e.kind==='refund'?-e.amount:e.amount));$('ledger-categories').replaceChildren();for(const [cat,amount] of [...cats].sort((a,b)=>b[1]-a[1]))$('ledger-categories').append(actionButton(`${cat}　¥${money(amount)}`,()=>{$('ledger-search').value=cat;render();},'category-pill'));if(!cats.size)$('ledger-categories').append(node('p','field-note','记下第一笔后，这里会显示分类支出。'));
    const search=$('ledger-search').value.trim().toLowerCase(),kind=$('ledger-kind').value;const list=state.entries.filter(e=>(kind==='trash'?e.deleted:!e.deleted)&&e.date.startsWith(month)&&(kind===''||kind==='trash'||e.kind===kind)&&(!search||[e.category,e.note,e.tag,e.account].join(' ').toLowerCase().includes(search))).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt));
    $('ledger-list').replaceChildren();$('ledger-empty').hidden=!!list.length;for(const e of list){const row=node('article','ledger-row');const main=node('div','ledger-row-main');main.append(node('strong','',e.note||e.category),node('p','field-note',`${e.date} · ${e.category}${e.meal?' · '+mealNames[e.meal]:''}${e.tag?' · '+e.tag:''}${e.account?' · '+e.account:''}${e.kind==='transfer'?' → '+e.toAccount:''}`));const side=node('div','ledger-row-side');side.append(node('strong',e.kind==='income'?'ledger-positive':'',`${{expense:'−',income:'＋',refund:'退 ',transfer:'转 '}[e.kind]}¥${money(e.amount)}`),actionButton(e.deleted?'恢复':'编辑',()=>e.deleted?save('entry',{...e,deleted:false}):openEntry(e)));row.append(main,side);$('ledger-list').append(row);}
    if($('ledger-prompts').open)renderPrompts();
  }
  async function refresh(prompt=false){if(locked||loading)return;loading=true;try{const next=await api('/api/ledger');if(locked)return;if(!state||next.version>=state.version)state=next;for(const [key,r] of Object.entries(state.responses))if(r.status==='snooze')sessionSeen.delete(key);if(!$('ledger-month').value)$('ledger-month').value=today().slice(0,7);render();$('ledger-status').textContent='账本已同步 · '+new Date().toLocaleTimeString('zh-CN');if(active)$('breadcrumb-view').textContent='我的账本';}catch(e){$('ledger-status').textContent='账本未同步：'+e.message;}finally{loading=false;}if(prompt)await maybePrompt();}
  async function maybePrompt(manual=false){if(!state||locked||!active||document.hidden||document.querySelector('dialog[open]'))return;const due=reminders(state).filter(r=>manual||!sessionSeen.has(r.key));if(!due.length)return;try{const claim=await api('/api/ledger/claim',{client,keys:due.slice(0,100).map(r=>r.key)});if(locked||!active||document.hidden||document.querySelector('dialog[open]'))return;promptKeys=claim.keys;for(const key of promptKeys)sessionSeen.add(key);if(!promptKeys.length)return;renderPrompts();$('ledger-prompt-error').textContent='';$('ledger-prompts').showModal();}catch{/* Never show an unverified reminder while disconnected. */}}
  function renderPrompts(){const due=reminders(state).filter(r=>promptKeys.includes(r.key));$('ledger-prompt-list').replaceChildren();if(!due.length){$('ledger-prompts').close();return;}for(const r of due){const card=node('section','ledger-prompt-card');card.append(node('h3','',r.title),node('p','field-note',r.type==='bill'?`${r.date}到期${r.overdue?' · 已过期':''}${r.amount?' · ¥'+money(r.amount):' · 金额付款时填写'}`:r.date+' · 记下餐费，今天的账更清楚'));const actions=node('div','button-row');actions.append(actionButton(r.type==='bill'?'已缴费，记一笔':'填写金额',()=>{$('ledger-prompts').close();openEntry(null,r);},'primary'));if(r.type==='meal')actions.append(actionButton('今天没花钱',()=>respond(r,'zero')));actions.append(actionButton('30分钟后',()=>respond(r,'snooze')),actionButton(r.type==='bill'?'本期跳过':'今天跳过',()=>respond(r,'skip')));card.append(actions);$('ledger-prompt-list').append(card);}}
  async function respond(r,status){try{await save('respond',{key:r.key,status});sessionSeen.delete(r.key);renderPrompts();}catch(e){$('ledger-prompt-error').textContent=e.message;}}
  async function allLater(){for(const r of reminders(state).filter(r=>promptKeys.includes(r.key)))await respond(r,'snooze');}
  event('ledger-prompts-close','click',allLater);event('ledger-prompts-later','click',allLater);$('ledger-prompts').addEventListener('cancel',e=>{e.preventDefault();void allLater();});event('ledger-due-open','click',()=>maybePrompt(true));
  event('ledger-month','change',()=>{if($('ledger-month').value)render();});event('ledger-kind','change',render);event('ledger-search','input',render);event('ledger-refresh','click',()=>refresh(true));
  event('ledger-export','click',async()=>{await refresh(false);if(!state)throw new Error('暂时没有可导出的账本。');const data={format:'jide-ledger',formatVersion:1,exportedAt:new Date().toISOString(),...state};const a=node('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='记得账本-'+today()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);toast('已导出当前账本与提醒设置');});
  event('ledger-budget-open','click',()=>{if(!state)return;budgetVersion=state.version;$('budget-month-label').textContent=$('ledger-month').value;$('budget-amount').value=String((state.budgets[$('ledger-month').value]||0)/100);$('budget-error').textContent='';$('ledger-budget').showModal();});
  event('ledger-budget-form','submit',async()=>{try{await save('budget',{month:$('ledger-month').value,amount:cents($('budget-amount').value.trim())},{version:budgetVersion});$('ledger-budget').close();toast('已保存月预算');}catch(e){if(e.status===409)budgetVersion=state.version;$('budget-error').textContent=e.message;}});
  function renderSettings(){if(!state)return;settingsVersion=state.version;const zone=state.settings.timeZone;if(![...$('meal-zone').options].some(o=>o.value===zone)){const o=node('option','',zone);o.value=zone;$('meal-zone').append(o);}const localZone=Intl.DateTimeFormat().resolvedOptions().timeZone;if(![...$('meal-zone').options].some(o=>o.value===localZone)){const o=node('option','',localZone+'（本机时区）');o.value=localZone;$('meal-zone').append(o);}$('meal-zone').value=zone;
    for(const [key,config] of Object.entries(state.settings.meals)){for(const attr of ['enabled','weekdays'])$(`meal-${key}-${attr}`).checked=config[attr];$(`meal-${key}-time`).value=config.time;}$('meal-settings-error').textContent='';renderBills();
  }
  function renderBills(){$('bill-list').replaceChildren();for(const b of state.bills){const row=node('div','ledger-row');const text=node('div');text.append(node('strong','',b.title+(b.enabled?'':'（已停用）')),node('p','field-note',`每${b.interval}个月 · ${b.day}日 · ${b.amount?'¥'+money(b.amount):'金额待填'}`));row.append(text,actionButton('编辑',()=>openBill(b)));$('bill-list').append(row);}if(!state.bills.length)$('bill-list').append(node('p','field-note','把房租、水电、网费加进来，到期就不会忘。'));}
  event('ledger-settings-open','click',()=>{if(!state)throw new Error('请先联网读取账本。');renderSettings();$('ledger-reminder-settings').showModal();});
  event('meal-settings-form','submit',async()=>{const meals={};for(const key of Object.keys(mealNames))meals[key]={enabled:$(`meal-${key}-enabled`).checked,weekdays:$(`meal-${key}-weekdays`).checked,time:$(`meal-${key}-time`).value};try{await save('settings',{timeZone:$('meal-zone').value,meals},{version:settingsVersion});settingsVersion=state.version;sessionSeen.clear();toast('已保存日常提醒');}catch(e){if(e.status===409)settingsVersion=state.version;$('meal-settings-error').textContent=e.message;}});
  function openBill(b=null){billVersion=state.version;billEditing=b?structuredClone(b):null;$('bill-form').reset();$('bill-name').value=b?.title||'';$('bill-amount').value=b?.amount?String(b.amount/100):'';$('bill-category').value=b?.category||'住房';$('bill-day').value=b?.day||5;$('bill-interval').value=b?.interval||1;$('bill-start').value=b?.startMonth||today().slice(0,7);$('bill-advance').value=b?.advance??1;$('bill-enabled').checked=b?.enabled??true;$('bill-error').textContent='';$('bill-editor').showModal();}
  event('bill-add','click',()=>openBill());event('bill-form','submit',async()=>{const submit=$('bill-form').querySelector('[type="submit"]');submit.disabled=true;try{await save('bill',{id:billEditing?.id||uid(),title:$('bill-name').value,amount:$('bill-amount').value.trim()?cents($('bill-amount').value.trim()):0,category:$('bill-category').value,day:Number($('bill-day').value),interval:Number($('bill-interval').value),startMonth:$('bill-start').value,advance:Number($('bill-advance').value),enabled:$('bill-enabled').checked},{version:billVersion});settingsVersion=state.version;$('bill-editor').close();renderBills();toast('已保存缴费提醒');}catch(e){if(e.status===409)billVersion=state.version;$('bill-error').textContent=e.message;}finally{submit.disabled=false;}});
  setInterval(async()=>{if(locked||document.hidden)return;if(active){await refresh(false);if($('ledger-prompts').open||$('ledger-editor').open&&recordKey){try{await api('/api/ledger/claim',{client,keys:$('ledger-editor').open?[recordKey]:promptKeys});}catch{}}await maybePrompt();}},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!locked)void refresh(active);});window.addEventListener('online',()=>{if(!locked)void refresh(active);});
  // ———— 「我的」面板 ————
  function renderMine(){
    const who=getAccount?.();
    $('mine-account').textContent=who?((who.displayName||'')+' · '+(who.username||'')):'';
    $('mine-hide-amount').checked=hideAmount;
    const synced=getLastSync?.();
    $('mine-last-sync').textContent=synced?'最近成功同步：'+new Date(synced).toLocaleString('zh-CN'):'还没有成功同步记录';
    if(!state||locked){$('mine-stats').replaceChildren();$('mine-backup-status').textContent='正在读取账本…';return;}
    $('mine-backup-status').textContent=state.backupError||'账本数据已随账号保存在服务端。';
    $('mine-stats').replaceChildren();
    const entries=state.entries.filter(e=>!e.deleted);
    const days=new Set(entries.map(e=>e.date));
    const month=today().slice(0,7);
    const monthDays=new Set(entries.filter(e=>e.date.startsWith(month)).map(e=>e.date));
    // 连续记录天数：从今天（或最近有记录的一天）往前连续计数，最多回溯 400 天。
    const anchor=[...days].sort().reverse()[0];
    let streak=0;
    if(anchor){let cursor=anchor;for(let i=0;i<400;i++){if(!days.has(cursor))break;streak++;const d=new Date(cursor+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);cursor=d.toISOString().slice(0,10);}}
    const stat=(label,value,note)=>{const box=node('div','mine-stat');box.append(node('span','stat-name',label),node('strong','',String(value)));if(note)box.append(node('span','field-note',note));return box;};
    $('mine-stats').append(
      stat('本月记账天数',monthDays.size+' 天'),
      stat('本月笔数',entries.filter(e=>e.date.startsWith(month)).length+' 笔'),
      stat('已记录天数',days.size+' 天',streak>1?`最近连续 ${streak} 天`:null)
    );
  }
  event('mine-hide-amount','change',()=>{
    hideAmount=$('mine-hide-amount').checked;
    try{localStorage.setItem(HIDE_KEY,hideAmount?'1':'0');}catch{}
    applyHide();render();toast(hideAmount?'已隐藏金额':'已显示金额');
  });
  event('mine-change-password','click',()=>{if(openSettings)$('change-password').click();else openSettingsDialog();});
  event('mine-export','click',()=>$('export').click());
  event('mine-import-button','click',()=>$('import-file').click());
  event('mine-logout','click',()=>$('logout').click());
  // ———— 快捷记账：金额优先 ————
  document.body.insertAdjacentHTML('beforeend',`<div id="quick-sheet" class="quick-sheet" hidden>
    <div class="quick-sheet-head"><strong>记一笔</strong><div><button id="quick-sheet-full" class="text-button">更多选项</button><button id="quick-sheet-close" class="icon-button" aria-label="关闭快速记账">×</button></div></div>
    <label class="quick-amount-label">金额（元）<input id="quick-amount" inputmode="decimal" enterkeyhint="done" placeholder="0.00" autocomplete="off"></label>
    <div id="quick-cats" class="quick-cats"></div>
    <p id="quick-sheet-note" class="field-note"></p>
    <button id="quick-sheet-save" class="primary">保存这笔账</button>
  </div>`);
  const QUICK_CATS=['餐饮','交通','购物','生活','娱乐','住房'];
  function renderQuickCats(selected){
    $('quick-cats').replaceChildren();
    for(const name of QUICK_CATS){
      const b=node('button','quick-cat'+(name===selected?' selected':''),name);b.type='button';
      b.onclick=()=>renderQuickCats(name);$('quick-cats').append(b);
    }
    $('quick-cats').dataset.selected=selected;
  }
  function openQuickSheet(){
    if(!state)throw new Error('请先联网读取账本。');
    renderQuickCats('餐饮');
    $('quick-amount').value='';
    $('quick-sheet-note').textContent='日期默认今天（'+today()+'）。';
    $('quick-sheet').hidden=false;document.body.classList.add('sheet-open');
    $('quick-amount').focus();
  }
  function closeQuickSheet(){$('quick-sheet').hidden=true;document.body.classList.remove('sheet-open');}
  event('quick-sheet-close','click',closeQuickSheet);
  event('quick-sheet-full','click',()=>{closeQuickSheet();openEntry();});
  event('quick-sheet-save','click',async()=>{
    const amount=$('quick-amount').value.trim(),category=$('quick-cats').dataset.selected||'餐饮';
    if(!amount)throw new Error('请先填写金额。');
    const value={id:uid(),kind:'expense',amount:cents(amount),date:today(),category,meal:'',account:'',toAccount:'',refundOf:'',tag:'',note:'',deleted:false};
    await save('entry',value,{version:state.version});
    closeQuickSheet();toast('已记下 ¥'+cents(amount)/100);await refresh(false);
  });
  event('quick-amount','keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('quick-sheet-save').click();}});
  return {init:async()=>{locked=false;await refresh(false);},initPreferences:()=>applyHide(),lock:()=>{locked=true;state=null;sessionSeen.clear();$('ledger-list').replaceChildren();for(const id of ['ledger-income','ledger-expense','ledger-balance','ledger-left'])$(id).textContent='—';},refresh,setView,renderMine};
}
