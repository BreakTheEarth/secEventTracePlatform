import React, { useEffect, useRef, useState } from 'react';
import { Plus, FolderKanban, ArrowLeft, Link2, Upload } from 'lucide-react';
import { api, uploadFile } from './api';
import { formatDate } from '../shared/model.mjs';
import './campaigns.css';
import { CampaignPeriod } from './campaign-period';
import { isOwnerIdentifier } from '../shared/owners.mjs';

const stages = { risks: '安全风险', incidents: '安全事件' };
const allStageNames = {logs:'安全日志',...stages,violations:'安全违规',red_lines:'安全红线'};
const statuses = { tracking: '跟踪中', completed: '已完结' };
const relations = { risk_source: '风险来源 / 利用入口', post_incident: '事件后改进', related: '相关排查' };
const confidenceNames = { pending: '待确认', confirmed: '已确认', not_confirmed: '已排除' };
const scopeTypes = {company:'全公司',business:'业务线',service:'服务',assets:'资产群体',custom:'自定义群体',legacy:'历史范围（待确认类型）'};
const localTime = value => {if(!value)return '';const date=new Date(value);return Number.isFinite(date.getTime())?new Date(date.getTime()+28800000).toISOString().slice(0,19):'';};
const isOverdue = row => row.status==='tracking' && row.due_at && Date.parse(row.due_at)<Date.now();
const preventInputEnter = e => {if(e.key==='Enter'&&e.target.tagName==='INPUT')e.preventDefault();};
const campaignNamePreview = value => {const d=new Date(value+'+08:00');if(!Number.isFinite(d.getTime()))return '保存后自动生成';const local=new Date(d.getTime()+28800000);return `保存后自动生成 · ${String(local.getUTCFullYear()).slice(-2)}-${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][local.getUTCMonth()]}-SPC-XXXX`;};
const textOf = html => {const el=document.createElement('div');el.innerHTML=html;return el.textContent.trim();};
function ErrorLine({error}) {return error?<div className="inline-error" role="alert">{error}</div>:null;}
function Field({label,children,full=false}) {return <label className={`campaign-field ${full?'campaign-field-full':''}`}><span>{label}</span>{children}</label>;}
function Badge({campaign}) {return <span className={`campaign-status ${campaign.status}`}>{statuses[campaign.status]}</span>;}
function Rich({html}) {return <div className="rich-content campaign-rich" dangerouslySetInnerHTML={{__html:html||'<p>未填写</p>'}}/>;}
function Progress({campaign}) {const s=campaign.task_summary;return s.total?<div className="campaign-progress"><span>已完结 {s.completed} / 共 {s.total} 项</span><progress max={s.total} value={s.completed}/>{!s.tracking&&campaign.status==='tracking'&&<small>待办事件全部完结，待主单完结</small>}</div>:<span className="table-secondary">尚未拆分待办事件</span>;}
function Conflict({error,onRefresh}) {return <><ErrorLine error={error?.message}/>{error?.status===409&&<button type="button" className="text-button" onClick={onRefresh}>刷新记录并重新编辑（放弃本次未保存内容）</button>}</>;}
function useInlineUpload(campaign,task=null) {
  const versions=useRef({campaign:campaign?.version,task:task?.version});
  const [uploading,setUploading]=useState(false);
  const upload=async file=>{
    if(file.size>20*1024*1024)throw new Error('单个附件不能超过 20 MB。');
    setUploading(true);
    try{const asset=await uploadFile(`/campaigns/${campaign.id}/assets`,file,{'X-Campaign-Version':String(versions.current.campaign),...(task?{'X-Task-Id':String(task.id),'X-Task-Version':String(versions.current.task)}:{})});versions.current={campaign:asset.campaign_version,task:asset.task_version};return asset;}finally{setUploading(false);}
  };
  return {versions,upload,uploading};
}
export function CampaignLinkPicker({value,onChange,ui}) {
  const [search,setSearch]=useState('');
  const {data,error}=ui.useData(`/events/campaign-options?search=${encodeURIComponent(search)}`,0);
  return <div className="campaign-link-picker"><p className="field-hint">引用专项用于追溯来源或改进，不改变个人事件研判或统计数量。已完结专项需先重新打开才能新增关联。</p>
    <input className="form-input" aria-label="搜索关联专项" placeholder="搜索专项编号、名称、漏洞编号" value={search} onChange={e=>setSearch(e.target.value)}/>
    {error&&<ErrorLine error={error.message}/>}
    <select className="form-input" aria-label="添加关联专项" value="" onChange={e=>{const c=data.campaigns.find(c=>c.id===Number(e.target.value));if(c)onChange([...value,{campaign_id:c.id,title:c.title,code:c.code,status:c.status,relation:'related',confidence:'pending',note:''}]);}}><option value="">选择要关联的专项…</option>{data?.campaigns.filter(c=>!value.some(v=>v.campaign_id===c.id)).map(c=><option key={c.id} value={c.id} disabled={c.status==='completed'}>{c.code} · {c.title}{c.status==='completed'?'（已完结）':''}</option>)}</select>
    {value.map((link,i)=><div className="campaign-link-row" key={link.campaign_id}><strong>{link.code} · {link.title}</strong><button type="button" className="text-button" onClick={()=>onChange(value.filter((_,j)=>j!==i))}>解除引用</button><RelationFields value={link} onChange={next=>onChange(value.map((v,j)=>j===i?next:v))}/></div>)}
  </div>;
}
function RelationFields({value,onChange}) {return <div className="campaign-grid"><Field label="关联关系"><select className="form-input" value={value.relation} onChange={e=>onChange({...value,relation:e.target.value})}>{Object.entries(relations).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="确认情况"><select className="form-input" value={value.confidence} onChange={e=>onChange({...value,confidence:e.target.value})}>{Object.entries(confidenceNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label={`关联说明${value.relation==='risk_source'?' *':''}`} full><textarea className="form-input" required={value.relation==='risk_source'} maxLength={5000} value={value.note} onChange={e=>onChange({...value,note:e.target.value})}/></Field></div>;}

function CampaignTypePicker({types,value,onChange,onSaved,onBusy}) {
  const [mode,setMode]=useState(''),[name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const lock=useRef(false),selected=types.find(t=>t.id===value);
  async function remove(){
    if(lock.current||!selected)return;
    lock.current=true;setBusy(true);onBusy(true);setError('');
    try{
      const options=await api('/campaigns/options');
      onSaved({types:options.types});
      const current=options.types.find(t=>t.id===selected.id);
      if(!current){onChange('');setMode('');throw new Error('标签已删除，已刷新可选标签。');}
      if(!window.confirm(`删除标签“${current.name}”？${current.usage_count?`将把 ${current.usage_count} 个专项的类型改为“待定”（包含已完结记录），专项和任务仍保留。`:'该标签尚未被专项使用。'} 删除会立即生效，取消专项编辑不会撤销。`))return;
      const result=await api(`/campaign-types/${current.id}`,{method:'DELETE',body:JSON.stringify({version:current.version,usage_count:current.usage_count})});
      onSaved(result);onChange('');setMode('');setName('');
    }catch(err){setError(err.message);}finally{lock.current=false;setBusy(false);onBusy(false);}
  }
  async function save(){
    if(lock.current)return;
    lock.current=true;setBusy(true);onBusy(true);setError('');
    try {
      const result=await api(mode==='rename'?`/campaign-types/${selected.id}`:'/campaign-types',{method:mode==='rename'?'PUT':'POST',body:JSON.stringify({name,version:selected?.version})});
      onSaved(result);onChange(result.type.id);setMode('');setName('');
    }catch(err){setError(err.message);}finally{lock.current=false;setBusy(false);onBusy(false);}
  }
  return <div className="campaign-type-picker"><Field label="专项类型"><select className="form-input" disabled={busy} value={value} onChange={e=>{onChange(e.target.value?Number(e.target.value):'');setMode('');setError('');}}><option value="">待定（未分类）</option>{types.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><div className="campaign-type-actions"><button type="button" className="text-button" disabled={busy} onClick={()=>{setMode('add');setName('');setError('');}}>新增标签</button><button type="button" className="text-button" disabled={busy||!selected} onClick={()=>{setMode('rename');setName(selected.name);setError('');}}>编辑标签</button><button type="button" className="text-button campaign-delete" disabled={busy||!selected} onClick={remove}>删除标签</button></div>{mode&&<div className="campaign-type-editor"><label>{mode==='rename'?'重命名标签':'新标签名称'}<input aria-label="标签名称" className="form-input" maxLength={40} value={name} disabled={busy} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();save();}}}/></label><p className="field-hint">{mode==='rename'?'改名会同步所有引用该标签的专项（含已完结记录）。':'新增后所有专项均可使用。'} 标签独立保存，取消专项编辑不会撤销。</p><div className="campaign-type-actions"><button type="button" className="text-button" disabled={busy||!name.trim()} onClick={save}>{busy?'保存中…':'保存标签'}</button><button type="button" className="text-button" disabled={busy} onClick={()=>setMode('')}>取消标签编辑</button></div></div>}<ErrorLine error={error}/></div>;
}

export function CampaignForm({ui,initial=null,sourceEvent=null,onClose,onSaved,onRefresh}) {
  const {Modal,Button,RichTextEditor}=ui;
  const [form,setForm]=useState(()=>({importance:initial?.importance||'P2',lead_owner:initial?.lead_owner||'admin',occurred_at:localTime(initial?.occurred_at||new Date()),target_scope:initial?.scope_details?.map(s=>s.name+(s.note?`（${s.note}）`:'')).join('；')||initial?.scopes?.join('；')||'全公司',due_at:localTime(initial?.due_at),description_html:initial?.description_html||''}));
  const [tasks,setTasks]=useState([]),[error,setError]=useState(null),[busy,setBusy]=useState(false);
  const {versions,upload,uploading}=useInlineUpload(initial);
  const {data:options}=ui.useData('/campaigns/options',0);
  const [types,setTypes]=useState([]),[typeId,setTypeId]=useState(initial?.type_id??''),[typeBusy,setTypeBusy]=useState(false);
  const typeInitialized=useRef(false);
  useEffect(()=>{if(!options)return;setTypes(options.types);if(!typeInitialized.current){if(!initial)setTypeId(options.types.find(t=>t.name==='漏洞修复')?.id??options.types[0]?.id??'');typeInitialized.current=true;}},[options]);
  const typeSaved=result=>{setTypes(result.types);const changed=result.campaign_versions?.find(c=>c.id===initial?.id);if(changed&&versions.current.campaign===changed.before)versions.current.campaign=changed.after;};
  const update=(key,value)=>setForm(p=>({...p,[key]:value}));
  const scopeChanged=!initial||form.target_scope!==(initial.scope_details?.map(s=>s.name+(s.note?`（${s.note}）`:'')).join('；')||initial.scopes.join('；'));
  async function submit(e){e.preventDefault();if(busy||uploading||typeBusy||!options)return;setBusy(true);setError(null);try{const {target_scope,...fields}=form;const result=await api(initial?`/campaigns/${initial.id}`:'/campaigns',{method:initial?'PUT':'POST',body:JSON.stringify({...fields,type_id:typeId||null,type:types.find(t=>t.id===typeId)?.name||'待定',...(scopeChanged?{target_scope}:{scope_details:initial.scope_details}),version:versions.current.campaign,...(!initial?{tasks:tasks.map(({key,...t})=>t)}:{}),...(sourceEvent?{events:[{event_id:sourceEvent.id,relation:'post_incident',confidence:'confirmed',note:'由事件处置或复盘发起改进'}]}:{})})});onSaved(result.campaign);}catch(err){setError(err);}finally{setBusy(false);}}
  return <Modal title={initial?'编辑专项事件':'新建专项事件'} subtitle="一个专项、一个范围，逐行分配待办事件。" wide onClose={()=>!busy&&!uploading&&!typeBusy&&onClose()}><form className="campaign-main-form" onSubmit={submit} onKeyDown={preventInputEnter}><div className="modal-body"><fieldset disabled={busy||typeBusy} className="campaign-fieldset">
    <div className="form-section-label">基本信息 <span>BASE INFORMATION</span></div><label className="field-label">专项名称</label><div className="generated-title-preview"><strong>{initial?.title||campaignNamePreview(form.occurred_at)}</strong><span>{initial?'已保存名称保持不变':'保存时按发现月份和当月专项顺序自动生成'}</span></div>
    <div className="campaign-grid campaign-basic-grid"><Field label="总负责人 *"><input className="form-input" required maxLength={254} list="campaign-people" type="text" placeholder="填写总负责人账号或邮箱" value={form.lead_owner} onChange={e=>update('lead_owner',e.target.value)}/><datalist id="campaign-people">{options?.security_owners.map(x=><option key={x}>{x}</option>)}</datalist></Field><CampaignTypePicker types={types} value={typeId} onChange={setTypeId} onSaved={typeSaved} onBusy={setTypeBusy}/></div>
    <div className="form-section-label form-section-spaced">事件级别 <span>PRIORITY</span></div>
    <fieldset className="severity-picker event-severity-picker campaign-importance"><legend>事件级别 <em>必填 · P0 最高</em></legend>{['P0','P1','P2','P3','P4'].map((item,index)=><label key={item} className={`severity-option severity-option-${index}`}><input type="radio" name="campaign-importance" required checked={form.importance===item} onChange={()=>update('importance',item)}/><span>{item}</span><small>{['最高','高','中','低','最低'][index]}</small></label>)}</fieldset>
    <div className="form-section-label form-section-spaced">事件周期 <span>TIME RANGE</span></div><CampaignPeriod start={form.occurred_at} end={form.due_at} onChange={(occurred_at,due_at)=>setForm(p=>({...p,occurred_at,due_at}))}/>
    <div className="form-section-label form-section-spaced">目标范围 <span>一个整体范围</span></div><Field label="目标范围 *" full><input className="form-input" required maxLength={2000} placeholder="例如：全公司 / 支付业务线 / 所有使用某组件的服务" value={form.target_scope} onChange={e=>update('target_scope',e.target.value)}/></Field>
    {!initial&&<><div className="form-section-label form-section-spaced">子任务待办事件 <span>可在此逐行建立，也可保存后补充</span></div><DraftTodos tasks={tasks} onChange={setTasks}/></>}
    <div className="form-section-label form-section-spaced">详细内容</div><RichTextEditor label="详细内容" placeholder="统一填写背景、目标、漏洞说明、威胁情报引用和处置要求…" value={form.description_html} onChange={v=>update('description_html',v)} onUpload={initial?upload:undefined}/><p className="field-hint">{initial?'上传文件会即时保存，取消编辑后仍可在附件区管理。':'首次保存后可上传图片和附件。'} 待办事件不单独计入漏斗，事件级别不进入红线分布。</p>
    {initial&&!initial.lead_owner&&<p className="campaign-warning">历史记录尚未明确唯一总负责人，请确认后填写；原负责人信息保留在历史数据中。</p>}{sourceEvent&&<p className="field-hint">保存后关联来源事件：{sourceEvent.title||sourceEvent.event_id} · 事件后改进</p>}
    <Conflict error={error} onRefresh={()=>{onClose();onRefresh?.();}}/></fieldset></div><div className="modal-footer"><Button type="button" variant="secondary" disabled={busy||uploading||typeBusy||!options} onClick={onClose}>取消</Button><Button type="submit" disabled={busy||uploading||typeBusy||!options}>{busy?'保存中…':initial?'保存修改':'建立专项事件'}</Button></div></form></Modal>;
}
const taskPriorities={high:'高',medium:'中',low:'低'};
const taskNumber=task=>`1.${Number(task.code.split('-T').at(-1))}`;
function PrioritySelect({value,onChange,label,disabled=false}) {return <select className="form-input task-cell-control" aria-label={label} value={value||'medium'} disabled={disabled} onChange={e=>onChange(e.target.value)}>{Object.entries(taskPriorities).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select>;}
function TaskDeadline({label,value,onChange,disabled=false}) {
  return <input type="date" className="form-input task-cell-control task-deadline" aria-label={label} value={(value||'').slice(0,10)} disabled={disabled} onChange={e=>onChange(e.target.value?`${e.target.value}T${value?.split('T')[1]||'18:00:00'}`:'')}/>;
}
function DraftTodos({tasks,onChange}) {
  const edit=(key,field,value)=>onChange(tasks.map(t=>t.key===key?{...t,[field]:value}:t));
  return <div className="campaign-draft-todos"><div className="events-table-wrap"><table className="campaign-breakdown-table"><thead><tr>{['序号','任务分解 *','进度','优先级','负责人账号或邮箱 *','截止日期（选填）','操作'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{tasks.map((t,i)=><React.Fragment key={t.key}><tr><td className="task-sequence">1.{i+1}</td><td><input aria-label={`待办名称${i+1}`} className="form-input task-cell-control" placeholder="填写任务名称" required maxLength={500} value={t.title} onChange={e=>edit(t.key,'title',e.target.value)}/></td><td><select aria-label={`待办状态${i+1}`} className="form-input task-cell-control" value={t.status} onChange={e=>edit(t.key,'status',e.target.value)}>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></td><td><PrioritySelect label={`待办优先级${i+1}`} value={t.priority} onChange={v=>edit(t.key,'priority',v)}/></td><td><input aria-label={`待办负责人${i+1}`} className="form-input task-cell-control" required maxLength={254} type="text" placeholder="admin 或 owner@example.com" value={t.owner} onChange={e=>edit(t.key,'owner',e.target.value)}/></td><td><TaskDeadline label={`待办截止日期${i+1}`} value={t.due_at||''} onChange={v=>edit(t.key,'due_at',v)}/></td><td><button type="button" className="text-button" onClick={()=>onChange(tasks.filter(x=>x.key!==t.key))}>移除</button></td></tr><tr className="task-detail-row"><td colSpan={7}><details><summary>事件明细{t.details_text?' · 已填写':' · 选填'}</summary><textarea aria-label={`待办明细${i+1}`} className="form-input" rows={3} maxLength={10000} placeholder="填写排查、修复或验证的具体事项，支持换行" value={t.details_text} onChange={e=>edit(t.key,'details_text',e.target.value)}/></details></td></tr></React.Fragment>)}{!tasks.length&&<tr><td colSpan={7} className="task-empty">暂无任务，点击下方“添加任务”开始分工。</td></tr>}</tbody></table></div><div className="task-table-footer"><button type="button" className="text-button" disabled={tasks.length>=100} onClick={()=>onChange([...tasks,{key:crypto.randomUUID(),title:'',owner:'',status:'tracking',priority:'medium',details_text:'',due_at:''}])}>＋ 添加任务</button><span>明细按需展开填写，任务不单独计入漏斗</span></div></div>;
}
function taskText(html) {const doc=new DOMParser().parseFromString(html||'','text/html');doc.querySelectorAll('br').forEach(e=>e.replaceWith('\n'));doc.querySelectorAll('p,div,li,h2,h3').forEach(e=>e.append('\n'));return doc.body.textContent.trim();}
function TaskForm({ui,campaign,task=null,onClose,onSaved,onRefresh}) {
  const {Modal,Button,RichTextEditor}=ui;
  const [form,setForm]=useState(()=>({title:task?.title||'',owner:task?.owner||'',due_at:localTime(task?.due_at),status:task?.status||'tracking',priority:task?.priority||'medium',details_text:taskText(task?.description_html),description_html:task?.description_html||''}));
  const richLegacy=Boolean(task&&/<(?:a|img|table|strong|b|ul|ol|h[23]|pre)\b/i.test(task.description_html));
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(null),[busy,setBusy]=useState(false),[changed,setChanged]=useState(false);
  const {versions,upload,uploading}=useInlineUpload(campaign,task);
  const closed=campaign.status==='completed', update=(key,v)=>setForm(p=>({...p,[key]:v}));
  async function submit(e){e.preventDefault();if(uploading||busy)return;setBusy(true);setError(null);try{
    const body={title:form.title,owner:form.owner,due_at:form.due_at,priority:form.priority,...(!task?{status:form.status}:{}),...(richLegacy||task&&!changed?{description_html:form.description_html,...(!task?{acceptance:''}:{})}:{details_text:form.details_text}),version:versions.current.task,campaign_version:versions.current.campaign,...(closed?{reopen_campaign:confirmed,reason}:{})};
    if(!task&&richLegacy)body.scope=campaign.scopes.join('、');
    await api(`/campaigns/${campaign.id}/tasks${task?`/${task.id}`:''}`,{method:task?'PUT':'POST',body:JSON.stringify(body)});onSaved();
  }catch(err){setError(err);}finally{setBusy(false);}}
  return <Modal title={task?'编辑待办事件':'新增待办事件'} subtitle={`所属：${campaign.title} · 总负责人：${campaign.lead_owner||'待明确'}`} wide onClose={()=>!busy&&!uploading&&onClose()}><form onSubmit={submit} onKeyDown={preventInputEnter}><div className="modal-body"><fieldset disabled={busy} className="campaign-fieldset"><div className="events-table-wrap"><table className="campaign-breakdown-table"><thead><tr>{['序号','任务分解 *','进度','优先级','负责人账号或邮箱 *','截止日期（选填）'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody><tr><td className="task-sequence">{task?taskNumber(task):`1.${campaign.next_task_seq}`}</td><td><input aria-label="待办事件名称" className="form-input task-cell-control" required maxLength={500} placeholder="填写任务名称" value={form.title} onChange={e=>update('title',e.target.value)}/></td><td><select aria-label="待办状态" className="form-input task-cell-control" disabled={Boolean(task)} value={form.status} onChange={e=>update('status',e.target.value)}>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></td><td><PrioritySelect label="待办优先级" value={form.priority} onChange={v=>update('priority',v)}/></td><td><input aria-label="待办负责人" className="form-input task-cell-control" required maxLength={254} type="text" placeholder="admin 或 owner@example.com" value={form.owner} onChange={e=>update('owner',e.target.value)}/></td><td><TaskDeadline label="待办截止日期" value={form.due_at} onChange={v=>update('due_at',v)}/></td></tr></tbody></table></div><p className="field-hint">目标范围：{campaign.scopes.join('、')} · 待办截止日期可单独选择，也可留空。</p><details className="task-form-details"><summary>事件明细 · 选填</summary>{richLegacy?<><RichTextEditor label="事件明细" value={form.description_html} onChange={v=>update('description_html',v)} onUpload={upload}/><p className="field-hint">本条包含历史格式或附件，保留原富文本编辑，防止丢失已有内容。</p></>:<textarea aria-label="事件明细" className="form-input campaign-todo-detail" rows={4} maxLength={10000} placeholder="填写待办具体事项，按回车换行" value={form.details_text} onChange={e=>{setChanged(true);update('details_text',e.target.value);}}/>}
    </details>{closed&&<div className="campaign-warning"><label><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 确认新增待办时同时重新打开主单</label><textarea aria-label="重新打开原因" className="form-input" maxLength={5000} placeholder="重新打开原因（选填）" value={reason} onChange={e=>setReason(e.target.value)}/></div>}<Conflict error={error} onRefresh={()=>{onClose();onRefresh();}}/></fieldset></div><div className="modal-footer"><Button type="button" variant="secondary" disabled={busy||uploading} onClick={onClose}>取消</Button><Button type="submit" disabled={busy||uploading}>{busy?'保存中…':'保存待办事件'}</Button></div></form></Modal>;
}
function ActionDialog({ui,title,warning,confirmation,progress=false,reasonRequired=true,campaign,task,onClose,onSave,onRefresh}) {
  const {Modal,Button,RichTextEditor}=ui;
  const [reason,setReason]=useState(''),[html,setHtml]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(null),[busy,setBusy]=useState(false);
  const {versions,upload,uploading}=useInlineUpload(campaign,task);
  return <Modal title={title} subtitle="提交后保留记录人、时间与操作依据。" wide={progress} onClose={()=>!busy&&!uploading&&onClose()}><form onSubmit={async e=>{e.preventDefault();if(busy||uploading)return;setBusy(true);setError(null);try{if(progress&&!textOf(html)&&!html.includes('/api/campaign-assets/'))throw new Error('请填写跟踪内容。');await onSave({reason,confirmed,html,versions:versions.current});onClose();}catch(err){setError(err);}finally{setBusy(false);}}}><div className="modal-body"><fieldset className="campaign-fieldset" disabled={busy}>{warning&&<p className="campaign-warning">{warning}</p>}{progress?<RichTextEditor label="跟踪内容" value={html} onChange={setHtml} onUpload={upload}/>:<textarea className="form-input" aria-label="操作说明" rows={5} required={reasonRequired} maxLength={5000} placeholder={reasonRequired?"填写结论或原因":"操作说明（选填）"} value={reason} onChange={e=>setReason(e.target.value)}/>}<p className="field-hint">{progress?'支持富文本及证据附件。上传文件即时保存到当前记录。':reasonRequired?'结论与原因将写入历史，可先在详情附件区补充验证依据。':'说明可留空，系统会记录重新打开的操作者和时间。'}</p>{confirmation&&<label className="campaign-confirm"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{confirmation}</label>}<Conflict error={error} onRefresh={()=>{onClose();onRefresh();}}/></fieldset></div><div className="modal-footer"><Button type="button" variant="secondary" disabled={busy||uploading} onClick={onClose}>取消</Button><Button disabled={busy||uploading} type="submit">{busy?'提交中…':'确认提交'}</Button></div></form></Modal>;
}
function LinkEventDialog({ui,campaign,onClose,onSaved}) {
  const {Modal,Button}=ui;const [search,setSearch]=useState(''),[selected,setSelected]=useState(''),[link,setLink]=useState({relation:'related',confidence:'pending',note:''}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const {data}=ui.useData(`/events?search=${encodeURIComponent(search)}&page_size=30`,0);
  return <Modal title="关联已有事件" subtitle="关联用于追溯，不自动升级专项，不生成重复事件。" onClose={()=>!busy&&onClose()}><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await api(`/campaigns/${campaign.id}/events/${selected}`,{method:'PUT',body:JSON.stringify(link)});onSaved();}catch(err){setError(err.message);}finally{setBusy(false);}}}><div className="modal-body"><input aria-label="搜索事件" className="form-input" placeholder="搜索事件编号、标题" value={search} onChange={e=>setSearch(e.target.value)}/><select className="form-input" required aria-label="选择关联事件" value={selected} onChange={e=>{setSelected(e.target.value);const previous=campaign.events.find(x=>x.id===Number(e.target.value));if(previous)setLink(previous);}}><option value="">选择事件…</option>{data?.events.map(x=><option value={x.id} key={x.id}>{x.title||x.event_id} · {x.event_type}</option>)}</select><RelationFields value={link} onChange={setLink}/><ErrorLine error={error}/></div><div className="modal-footer"><Button variant="secondary" type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>保存关联</Button></div></form></Modal>;
}
function Evidence({campaign,task=null,assets,onChange,notify}) {
  const [busy,setBusy]=useState(false),canUpload=campaign.status==='tracking'&&(!task||task.status==='tracking');
  const files=assets.filter(x=>(x.task_id||null)===(task?.id||null));
  return <div className="campaign-evidence"><strong>证据附件</strong>{!files.length&&<small>尚无附件</small>}{files.map(x=><div key={x.id} className="campaign-asset">{x.deleted?<span>已删除平台文件 · {x.filename}</span>:<><a href={`/api/campaign-assets/${x.id}/download`} target="_blank" rel="noreferrer">{x.filename} · {Math.ceil(x.bytes/1024)} KB</a><button type="button" className="text-button" disabled={busy} onClick={async()=>{if(!confirm('删除平台附件后无法下载；服务器备份不会自动清除。确定删除？'))return;setBusy(true);try{await api(`/campaign-assets/${x.id}`,{method:'DELETE'});onChange();}catch(err){notify(err.message,'error');}finally{setBusy(false);}}}>删除</button></>}</div>)}{canUpload&&<label className={`button button-secondary campaign-upload ${busy?'is-disabled':''}`}><Upload size={14}/>{busy?'上传中…':'添加附件'}<input type="file" hidden disabled={busy} accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.doc,.docx,.txt" onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;setBusy(true);try{if(file.size>20*1024*1024)throw new Error('单个附件不能超过 20 MB。');await uploadFile(`/campaigns/${campaign.id}/assets`,file,task?{'X-Task-Id':String(task.id)}:{});onChange();}catch(err){notify(err.message,'error');}finally{setBusy(false);}}}/></label>}<small>每份最大 20 MB · 图片、PDF、ZIP、Word、TXT</small></div>;
}
const historyNames={title:'名称',type:'专项类型',stage:'研判层级',importance:'事件级别',lead:'总负责人',owners:'负责人列表',collaborators:'协同人员',details:'目标范围',scopes:'目标群体',occurredAt:'发现时间',dueAt:'计划完成',description:'详细内容',owner:'负责人',scope:'执行范围',description_html:'工作内容',acceptance:'完成标准',due_at:'计划完成时间',priority:'子任务优先级'};
function displayHistory(update) {
  try{
    if(update.kind==='edited')return Object.entries(JSON.parse(update.body)).map(([k,v])=>`${historyNames[k]||k}：${textOf(String(v.before||'空'))} → ${textOf(String(v.after||'空'))}`).join('\n')||'保存主单（字段未变化）';
    if(update.kind==='task_edited'){const v=JSON.parse(update.body.slice(update.body.indexOf('{')));return Object.entries(historyNames).filter(([k])=>Object.hasOwn(v.after,k)&&String(v.before[k]||'')!==String(v.after[k]||'')).map(([k,label])=>`${label}：${textOf(String(v.before[k]||'空'))} → ${textOf(String(v.after[k]||'空'))}`).join('\n')||'更新待办事件信息';}
  }catch{}
  return update.body;
}
function History({ui,updates,loadPath,notify,revision}) {
  const [older,setOlder]=useState([]),[busy,setBusy]=useState(false);
  useEffect(()=>setOlder([]),[revision,loadPath]);
  const rows=[...updates,...older];
  return <><div className="campaign-timeline">{rows.map(u=><article key={u.id}><div><strong>{u.username}</strong><span>{formatDate(u.created_at)} · {u.task_id?'待办事件 #'+u.task_id:'专项事件'}</span></div>{u.body_html?<Rich html={u.body_html}/>:<p>{displayHistory(u)}</p>}</article>)}</div>{(older.length?older.length%100===0:updates.length===100)&&<ui.Button variant="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await api(`${loadPath}${loadPath.includes('?')?'&':'?'}before=${rows.at(-1).id}`);setOlder(p=>[...p,...r.updates]);}catch(err){notify(err.message,'error');}finally{setBusy(false);}}}>加载更早历史</ui.Button>}</>;
}
function Pager({ui,page,total,onPage,loading}) {
  const {Button}=ui;return <div className="pagination"><span>共 {total||0} 项</span><div><Button variant="secondary" disabled={page<=1||loading} onClick={()=>onPage(page-1)}>上一页</Button><span>{page} / {Math.max(1,Math.ceil((total||0)/20))}</span><Button variant="secondary" disabled={page*20>=(total||0)||loading} onClick={()=>onPage(page+1)}>下一页</Button></div></div>;
}
function SelectFilter({label,value,onChange,values}) {return <select aria-label={label} className="form-input campaign-filter" value={value} onChange={e=>onChange(e.target.value)}><option value="">{label}</option>{Object.entries(values).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select>;}
function Facts({rows}) {return <dl className="detail-grid">{rows.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v||'未填写'}</dd></div>)}</dl>;}
export function Campaigns({ui,revision,onChange,notify,onEvent,focusId,onFocus,createSource,onSourceHandled}) {
  const {Button,PageHeading,Spinner,ErrorBlock,EmptyState}=ui;
  const defaults={importance:'',status:'',owner:'',task_owner:'',overdue:''};
  const [search,setSearch]=useState(''),[filters,setFilters]=useState(defaults),[page,setPage]=useState(1),[creating,setCreating]=useState(false),[editing,setEditing]=useState(null),[deleting,setDeleting]=useState(null);
  const deletingRef=useRef(false);
  const {data:options}=ui.useData('/campaigns/options',revision);
  const query=new URLSearchParams({...filters,search,page});
  const {data,loading,error,retry}=ui.useData(`/campaigns?${query}`,revision);
  const change=(key,v)=>{setFilters(p=>({...p,[key]:v}));setPage(1);};
  async function editMain(id){try{const r=await api(`/campaigns/${id}?workspace=true`);setEditing(r.campaign);}catch(err){notify(err.message,'error');}}
  async function removeMain(c){
    if(deletingRef.current)return;
    if(!window.confirm(`删除专项“${c.title}”？其子任务将一并隐藏，并从当前统计及事件引用中排除；历史和证据保留。`))return;
    deletingRef.current=true;setDeleting(c.id);
    try{await api(`/campaigns/${c.id}`,{method:'DELETE',body:JSON.stringify({version:c.version})});onChange();retry();notify('专项事件已删除。');}catch(err){notify(err.message,'error');if(err.status===409)retry();}finally{deletingRef.current=false;setDeleting(null);}
  }
  function saved(c){setEditing(null);setCreating(false);onSourceHandled();onFocus(c.id);onChange();notify('专项事件已保存。');}
  if(focusId)return <CampaignDetail key={focusId} id={focusId} ui={ui} revision={revision} onChange={onChange} notify={notify} onBack={()=>onFocus(null)} onEvent={onEvent}/>;
  return <><PageHeading eyebrow="SECURITY CAMPAIGNS" title="安全专项" description="主单统筹整体工作，待办事件逐项分派，具体安全事件独立关联。"><Button icon={Plus} onClick={()=>setCreating(true)}>新建专项事件</Button></PageHeading><div className="campaign-intro"><FolderKanban size={22}/><div><strong>一位总负责人，一张执行清单</strong><p>事件级别 P0–P4 · 主单与待办事件分别跟踪 · 每个专项计入日志 +1、风险 +1、事件 +1</p></div></div>
    <section className="panel"><div className="events-toolbar"><input className="form-input campaign-search" aria-label="搜索专项" placeholder="搜索编号、名称、漏洞编号" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/><SelectFilter label="全部事件级别" value={filters.importance} onChange={v=>change('importance',v)} values={Object.fromEntries([0,1,2,3,4].map(n=>[`P${n}`,`P${n}`]))}/><SelectFilter label="全部状态" value={filters.status} onChange={v=>change('status',v)} values={statuses}/></div><div className="events-filter-row">{[['owner','总负责人'],['task_owner','待办负责人']].map(([key,label])=><label key={key}>{label}<select value={filters[key]} onChange={e=>change(key,e.target.value)}><option value="">全部</option>{options?.security_owners.map(x=><option key={x}>{x}</option>)}</select></label>)}<label className="campaign-check"><input type="checkbox" checked={filters.overdue==='true'} onChange={e=>change('overdue',e.target.checked?'true':'')}/> 仅看逾期</label><button className="text-button" onClick={()=>{setFilters(defaults);setSearch('');setPage(1);}}>清空筛选</button></div>
    {error?<ErrorBlock error={error} retry={retry}/>:loading?<Spinner/>:!data?.campaigns.length?<EmptyState icon={FolderKanban} title="暂无匹配的专项事件" description="建立主单后，逐项分派待办事件。" action={<Button onClick={()=>setCreating(true)}>新建专项事件</Button>}/>:<div className="events-table-wrap"><table className="campaign-table"><thead><tr>{['编号 / 名称','总负责人 / 目标范围','事件级别','状态','待办事件进度','计划完成','最近更新','操作'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{data.campaigns.map(c=><tr key={c.id}><td><button className="text-button campaign-title" onClick={()=>onFocus(c.id)}>{c.title}</button><span className="table-secondary">{c.code} · {c.type}</span></td><td><strong>{c.lead_owner||'待明确总负责人'}</strong><span className="table-secondary">{c.scopes.join('、')}</span></td><td><span className={`severity-badge p${c.importance[1]}`}>{c.importance}</span></td><td><Badge campaign={c}/></td><td><Progress campaign={c}/></td><td className={isOverdue(c)?'campaign-overdue':''}>{c.due_at?formatDate(c.due_at):'未设置'}{isOverdue(c)&&<span className="table-secondary">已逾期</span>}</td><td>{formatDate(c.updated_at)}</td><td><div className="campaign-row-actions"><button className="text-button" onClick={()=>onFocus(c.id)}>详情 / 管理</button>{c.status==='tracking'&&<button className="text-button" onClick={()=>editMain(c.id)}>编辑</button>}<button className="text-button campaign-delete" disabled={deleting!==null} onClick={()=>removeMain(c)}>{deleting===c.id?'删除中…':'删除'}</button></div></td></tr>)}</tbody></table></div>}
    <Pager ui={ui} page={page} total={data?.total} onPage={setPage} loading={loading}/></section>{editing&&<CampaignForm ui={ui} initial={editing} onClose={()=>{setEditing(null);onChange();}} onSaved={saved} onRefresh={retry}/>} {(creating||createSource)&&<CampaignForm ui={ui} sourceEvent={createSource} onClose={()=>{setCreating(false);onSourceHandled();}} onSaved={saved} onRefresh={retry}/>}</>;
}
function CompactTaskRow({task,campaign,onOpen,onEdit,onAction,onSaved,busy}) {
  const [draft,setDraft]=useState(null),[saving,setSaving]=useState(false),[error,setError]=useState(null),[expanded,setExpanded]=useState(false);
  const lock=useRef(false),t=task,disabled=busy||saving;
  const change=(field,value)=>setDraft(p=>({...p,[field]:value}));
  async function save(){
    if(lock.current||busy)return;
    if(!draft.title.trim()||!isOwnerIdentifier(draft.owner.trim())){setError({message:'请填写任务名称和有效的负责人账号或邮箱。'});return;}
    lock.current=true;setSaving(true);setError(null);
    try{await api(`/campaigns/${campaign.id}/tasks/${t.id}`,{method:'PATCH',body:JSON.stringify(draft)});setDraft(null);onSaved();}catch(err){setError(err);}finally{lock.current=false;setSaving(false);}
  }
  return <><tr><td className="task-sequence" title={t.code}>{taskNumber(t)}</td><td>{draft?<input className="form-input task-cell-control" aria-label={`任务名称 ${t.code}`} maxLength={500} value={draft.title} disabled={disabled} onChange={e=>change('title',e.target.value)}/>:<button type="button" className="text-button task-name" onClick={()=>onOpen(t.id)}>{t.title}</button>}{isOverdue(t)&&<small className="campaign-overdue">已逾期</small>}</td><td><select aria-label={`任务进度 ${t.code}`} className="form-input task-cell-control" value={t.status} disabled={disabled||Boolean(draft)} onChange={()=>onAction('status',t)}>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></td><td>{draft?<PrioritySelect label={`任务优先级 ${t.code}`} disabled={disabled} value={draft.priority} onChange={v=>change('priority',v)}/>:<span className={`task-priority task-priority-${t.priority}`}>{taskPriorities[t.priority]||'中'}</span>}</td><td>{draft?<input className="form-input task-cell-control" aria-label={`任务负责人 ${t.code}`} type="text" placeholder="admin 或 owner@example.com" maxLength={254} value={draft.owner} disabled={disabled} onChange={e=>change('owner',e.target.value)}/>:<span>{t.owner}</span>}</td><td>{draft?<TaskDeadline label={`任务截止日期 ${t.code}`} value={draft.due_at} disabled={disabled} onChange={v=>change('due_at',v)}/>:<span className={isOverdue(t)?'campaign-overdue':''}>{t.due_at?localTime(t.due_at).slice(0,10):'未设置'}</span>}</td><td><div className="task-inline-actions">{draft?<><button type="button" className="text-button" disabled={disabled} onClick={save}>{saving?'保存中…':'保存'}</button><button type="button" className="text-button" disabled={saving} onClick={()=>{setDraft(null);setError(null);}}>取消</button></>:<>{t.status==='tracking'&&campaign.status==='tracking'&&<button type="button" className="text-button" disabled={disabled} onClick={()=>{setDraft({title:t.title,owner:t.owner,priority:t.priority||'medium',due_at:localTime(t.due_at),version:t.version});setError(null);}}>编辑</button>}<button type="button" className="text-button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起':'展开'}</button><button type="button" className="text-button campaign-delete" disabled={disabled} onClick={()=>onAction('remove',t)}>删除</button></>}</div></td></tr>{error&&<tr><td colSpan={7}><ErrorLine error={error.message}/>{error.status===409&&<button type="button" className="text-button" disabled={saving} onClick={()=>{setDraft(null);setError(null);onSaved();}}>刷新并重新编辑（放弃本次修改）</button>}</td></tr>}{expanded&&<tr className="task-detail-row"><td colSpan={7}><div className="task-expanded-content"><p><strong>事件明细</strong>　{t.details_summary||'未填写'}</p><p><strong>最新进展</strong>　{t.latest_update||'尚无跟踪记录'}</p><span>执行范围：{t.scope}　·　截止日期：{t.due_at?formatDate(t.due_at):'未设置'}</span><div className="task-inline-actions"><button type="button" className="text-button" onClick={()=>onOpen(t.id)}>完整详情 / 历史</button>{t.status==='tracking'&&campaign.status==='tracking'&&<><button type="button" className="text-button" disabled={disabled||Boolean(draft)} onClick={()=>onEdit(t.id)}>编辑事件明细</button><button type="button" className="text-button" disabled={disabled||Boolean(draft)} onClick={()=>onAction('progress',t)}>追加跟踪</button></>}</div></div></td></tr>}</>;
}
function TaskTable({ui,campaign,revision,onOpen,onEdit,onAction,onAdd,onSaved,busy}) {
  const {Spinner,ErrorBlock}=ui;
  const empty={search:'',owner:'',status:'',overdue:''};
  const [filters,setFilters]=useState(empty),[page,setPage]=useState(1);
  const {data,loading,error,retry}=ui.useData(`/campaigns/${campaign.id}/tasks?${new URLSearchParams({...filters,page})}`,revision);
  const change=(key,v)=>{setFilters(p=>({...p,[key]:v}));setPage(1);};
  return <><div className="campaign-section-heading"><div><h2>待办事件 <span>{campaign.task_summary.total} 项 · 跟踪中 {campaign.task_summary.tracking} 项</span></h2><p className="field-hint">逐行管理任务，展开查看明细与跟踪记录。{data?.overdue?`逾期 ${data.overdue} 项。`:''}</p></div></div><div className="campaign-task-filters"><input className="form-input campaign-search" aria-label="搜索待办事件" placeholder="搜索名称、编号、执行范围" value={filters.search} onChange={e=>change('search',e.target.value)}/><SelectFilter label="全部待办负责人" value={filters.owner} onChange={v=>change('owner',v)} values={Object.fromEntries((data?.owners||[]).map(x=>[x,x]))}/><SelectFilter label="待办事件状态" value={filters.status} onChange={v=>change('status',v)} values={statuses}/><label className="campaign-check"><input type="checkbox" checked={filters.overdue==='true'} onChange={e=>change('overdue',e.target.checked?'true':'')}/> 仅看逾期</label><button className="text-button" onClick={()=>{setFilters(empty);setPage(1);}}>清空筛选</button></div>
    {error?<ErrorBlock error={error} retry={retry}/>:loading?<Spinner/>:!data?.tasks.length?<div className="campaign-table-empty">暂无待办事件{campaign.task_summary.total?'符合当前筛选':'，点击“添加任务”开始分工'}。</div>:<div className="events-table-wrap"><table className="campaign-breakdown-table campaign-saved-tasks"><thead><tr>{['序号','任务分解','进度','优先级','负责人账号或邮箱','截止日期','操作'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{data.tasks.map(t=><CompactTaskRow key={`${t.id}:${t.version}`} task={t} campaign={campaign} busy={busy||loading} onOpen={onOpen} onEdit={onEdit} onAction={onAction} onSaved={onSaved}/>)}</tbody></table></div>}
    <div className="task-table-footer"><button type="button" className="text-button" disabled={busy||loading} onClick={onAdd}>＋ 添加任务</button><span>明细与跟踪记录可展开查看</span></div><Pager ui={ui} page={data?.page||page} total={data?.total} onPage={setPage} loading={loading}/></>;
}
function TaskDetail({ui,campaign,taskId,revision,assets,onClose,onEdit,onAction,onRefresh,notify,busy}) {
  const {Modal,Button,Spinner,ErrorBlock}=ui;
  const {data,error,retry}=ui.useData(`/campaigns/${campaign.id}/tasks/${taskId}`,revision);
  const t=data?.task;
  return <Modal title={t?.title||'待办事件详情'} subtitle={`${t?.code||''} · 所属主单：${campaign.title} · 总负责人：${campaign.lead_owner||'待明确'}`} wide onClose={onClose}><div className="modal-body campaign-task-detail">{error?<ErrorBlock error={error} retry={retry}/>:!t?<Spinner/>:<><div className="campaign-detail-top"><Badge campaign={t}/><span className="field-hint">独立跟进、独立验收</span><button className="text-button" onClick={onClose}>返回主单执行清单</button></div><Facts rows={[["负责人",t.owner],["优先级",taskPriorities[t.priority]||'中'],["执行范围",t.scope],["截止日期",t.due_at?formatDate(t.due_at):'未设置'],...(t.acceptance?[["历史完成标准",t.acceptance]]:[]),["完结时间",t.completed_at?formatDate(t.completed_at):'尚未完结']]}/><h3>事件明细</h3><Rich html={t.description_html}/>{t.conclusion&&<div className="campaign-conclusion"><strong>完结结论</strong><p>{t.conclusion}</p></div>}<Evidence campaign={campaign} task={t} assets={assets} onChange={onRefresh} notify={notify}/><div className="campaign-actions">{campaign.status==='tracking'&&t.status==='tracking'&&<><Button variant="secondary" onClick={()=>onEdit(t.id)}>编辑待办事件</Button><Button onClick={()=>onAction('progress',t)}>追加跟踪</Button></>}<Button variant="secondary" disabled={busy} onClick={()=>onAction('status',t)}>{t.status==='completed'?'重新打开待办事件':'完结待办事件'}</Button><button className="text-button campaign-delete" disabled={busy} onClick={()=>onAction('remove',t)}>删除待办事件</button></div><h3>跟踪记录与操作历史</h3><History ui={ui} updates={data.updates} loadPath={`/campaigns/${campaign.id}/tasks/${t.id}`} notify={notify} revision={revision}/></>}</div><div className="modal-footer"><Button variant="secondary" onClick={onClose}>返回执行清单</Button></div></Modal>;
}
function CampaignDetail({id,ui,revision,onChange,notify,onBack,onEvent}) {
  const {Button,PageHeading,Spinner,ErrorBlock}=ui;
  const {data,loading,error,retry}=ui.useData(`/campaigns/${id}?workspace=true`,revision),{data:assetData,retry:retryAssets}=ui.useData(`/campaigns/${id}/assets`,revision);
  const [dialog,setDialog]=useState(null),[tab,setTab]=useState('tasks'),[taskId,setTaskId]=useState(null),[opening,setOpening]=useState(false),[acting,setActing]=useState(false);
  const actingRef=useRef(false);
  const c=data?.campaign,assets=assetData?.assets||[];
  if(error)return <ErrorBlock error={error} retry={retry}/>;if(!c)return <Spinner/>;
  const refresh=()=>{onChange();retry();retryAssets();};
  const post=async(path,body,method='POST')=>{await api(`/campaigns/${id}${path}`,{method,body:JSON.stringify(body)});refresh();};
  async function editTask(taskId){setOpening(true);try{const r=await api(`/campaigns/${id}/tasks/${taskId}`);setDialog({kind:'task',task:r.task});}catch(err){notify(err.message,'error');}finally{setOpening(false);}}
  async function directAction(action,message){
    if(actingRef.current||loading)return;
    actingRef.current=true;setActing(true);
    try{await action();notify(message);}catch(err){notify(err.message,'error');if(err.status===409)refresh();}finally{actingRef.current=false;setActing(false);}
  }
  function removeMain(){
    if(actingRef.current||loading)return;
    if(!window.confirm(`删除专项“${c.title}”？其子任务将一并隐藏，并从当前统计及事件引用中排除；历史和证据保留。`))return;
    directAction(async()=>{await api(`/campaigns/${id}`,{method:'DELETE',body:JSON.stringify({version:c.version})});onChange();onBack();},'专项事件已删除。');
  }
  function taskAction(kind,t){
    if(actingRef.current||loading)return;
    if(kind==='progress'){setDialog({kind:'action',title:`追加跟踪 · ${t.title}`,progress:true,task:t,save:({html,versions})=>post(`/tasks/${t.id}/updates`,{body_html:html,version:versions.task,campaign_version:versions.campaign})});return;}
    if(kind==='remove'){
      if(!window.confirm(`删除待办“${t.title}”？删除后不计入进度，历史及证据保留。`))return;
      directAction(async()=>{await post(`/tasks/${t.id}`,{version:t.version},'DELETE');setTaskId(null);},'待办事件已删除。');return;
    }
    if(kind==='status'){
      const reopening=t.status==='completed',reopenCampaign=reopening&&c.status==='completed';
      if(reopenCampaign&&!window.confirm('重新跟踪此待办将同时重新打开主专项，是否继续？'))return;
      directAction(()=>post(`/tasks/${t.id}/status`,{version:t.version,campaign_version:c.version,status:reopening?'tracking':'completed',...(reopenCampaign?{reopen_campaign:true}:{})}),reopening?'待办事件已恢复跟踪。':'待办事件已完结。');
    }
  }
  function mainStatus(){if(actingRef.current||loading)return;if(c.status==='tracking'){directAction(()=>post('/status',{version:c.version,status:'completed'}),'专项事件已完结。');return;}setDialog({kind:'action',title:c.status==='completed'?'重新打开专项事件':'完结专项事件',reasonRequired:false,warning:c.status==='tracking'&&c.task_summary.tracking?`仍有 ${c.task_summary.tracking} 项待办事件跟踪中，提交时会检查并列出未完成项。`:'',save:({reason,versions})=>post('/status',{version:versions.campaign,status:c.status==='completed'?'tracking':'completed',reason})});}
  const saved=()=>{setDialog(null);refresh();};
  return <><button className="text-button campaign-back" onClick={onBack}><ArrowLeft size={15}/> 返回专项列表</button><PageHeading eyebrow={c.code} title={c.title} description={`${c.type} · 事件级别 ${c.importance} · 总负责人：${c.lead_owner||'待明确'}`}><Button variant="secondary" className="campaign-status-action" disabled={loading||acting} onClick={mainStatus}>{c.status==='completed'?'重新打开专项':'完结专项事件'}</Button>{c.status==='tracking'&&<Button disabled={loading||acting} onClick={()=>setDialog({kind:'edit'})}>编辑主单</Button>}<Button variant="secondary" className="campaign-delete-main" disabled={loading||acting} onClick={removeMain}>删除专项</Button></PageHeading>
    <section className="panel campaign-section campaign-workspace"><div className="campaign-detail-top"><Badge campaign={c}/><Progress campaign={c}/><span className="field-hint">总负责人 <strong>{c.lead_owner||'待明确'}</strong></span><button className="text-button" disabled={loading} onClick={refresh}>{loading?'正在刷新…':'刷新记录'}</button></div><nav className="campaign-tabs" aria-label="专项事件工作台">{[['tasks','待办事件'],['info','基本信息'],['events',`关联事件 (${c.events.length})`],['history','整体跟踪与历史']].map(([key,label])=><button key={key} aria-current={tab===key?'page':undefined} onClick={()=>setTab(key)}>{label}</button>)}</nav>
    {tab==='tasks'&&<TaskTable onSaved={refresh} busy={acting||loading} ui={ui} campaign={c} revision={revision} onOpen={setTaskId} onEdit={editTask} onAction={taskAction} onAdd={()=>setDialog({kind:'task'})}/>}
    {tab==='info'&&<><Facts rows={[["总负责人",c.lead_owner||'待明确'],["发现时间",formatDate(c.occurred_at)],["计划完成",c.due_at?formatDate(c.due_at):'未设置'],["完结时间",c.completed_at?formatDate(c.completed_at):'尚未完结'],["最近更新",formatDate(c.updated_at)]]}/><h3>目标范围</h3><div className="campaign-scope-summary">{c.scope_details.map((s,i)=><div key={i}><span>{scopeTypes[s.type]}</span><strong>{s.name}</strong>{s.note&&<p>{s.note}</p>}</div>)}</div><h3>详细内容</h3><Rich html={c.description_html}/>{c.conclusion&&<div className="campaign-conclusion"><strong>主单完结结论</strong><p>{c.conclusion}</p></div>}<Evidence campaign={c} assets={assets} onChange={refresh} notify={notify}/></>}
    {tab==='events'&&<><div className="campaign-section-heading"><h2>关联具体事件</h2>{c.status==='tracking'&&<Button variant="secondary" icon={Link2} onClick={()=>setDialog({kind:'link'})}>关联已有事件</Button>}</div><p className="field-hint">HIDS、DLP 等事件独立记录，关联用于追溯风险来源或事后改进，不自动确认因果。</p>{!c.events.length&&<p className="campaign-table-empty">尚无关联事件。</p>}{c.events.map(e=><div className="campaign-event" key={e.id}><button className="text-button" onClick={()=>onEvent(e)}>{e.title||e.event_id} · {e.event_type}</button><span>{e.event_id} · {formatDate(e.occurred_at)} · {allStageNames[e.stage]||e.stage}</span><span>{relations[e.relation]} · {confidenceNames[e.confidence]}</span><p>{e.note||'未补充说明'}</p>{c.status==='tracking'&&<button className="text-button" onClick={()=>setDialog({kind:'action',title:'解除事件关联',warning:'解除后双方记录和统计仍保留。',save:({reason})=>post(`/events/${e.id}`,{reason},'DELETE')})}>解除引用</button>}</div>)}</>}
    {tab==='history'&&<><div className="campaign-section-heading"><h2>整体跟踪与历史</h2>{c.status==='tracking'&&<Button onClick={()=>setDialog({kind:'action',title:'追加整体跟踪',progress:true,save:({html,versions})=>post('/updates',{body_html:html,version:versions.campaign})})}>追加整体跟踪</Button>}</div><p className="field-hint">展示主单及待办事件操作，待办事件详情中可单独查看本项记录。</p><History ui={ui} updates={c.updates} loadPath={`/campaigns/${id}/updates`} notify={notify} revision={revision}/></>}
    </section>{opening&&<p role="status">正在加载待办事件表单…</p>}
    {taskId&&!dialog&&<TaskDetail busy={acting||loading} key={taskId} ui={ui} campaign={c} taskId={taskId} revision={revision} assets={assets} onClose={()=>setTaskId(null)} onEdit={editTask} onAction={taskAction} onRefresh={refresh} notify={notify}/>}
    {dialog?.kind==='edit'&&<CampaignForm ui={ui} initial={c} onClose={()=>{setDialog(null);refresh();}} onSaved={saved} onRefresh={refresh}/>}
    {dialog?.kind==='task'&&<TaskForm ui={ui} campaign={c} task={dialog.task} onClose={()=>{setDialog(null);refresh();}} onSaved={saved} onRefresh={refresh}/>}
    {dialog?.kind==='action'&&<ActionDialog ui={ui} {...dialog} campaign={c} onSave={dialog.save} onClose={()=>{setDialog(null);refresh();}} onRefresh={refresh}/>}
    {dialog?.kind==='link'&&<LinkEventDialog ui={ui} campaign={c} onClose={()=>setDialog(null)} onSaved={saved}/>}
  </>;
}
