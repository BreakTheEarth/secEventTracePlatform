import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const shanghaiToday = () => new Date(Date.now()+28800000).toISOString().slice(0,10);
const monthOf = value => new Date(`${(value || shanghaiToday()).slice(0,7)}-01T12:00:00`);
const moveMonth = (date,delta) => new Date(date.getFullYear(),date.getMonth()+delta,1,12);
const duration = (start,end) => { if(!start||!end)return '请选择完整时间区间'; const diff=Date.parse(end)-Date.parse(start); if(!Number.isFinite(diff)||diff<0)return '请选择有效的起止时间'; const days=Math.floor(diff/86400000),hours=Math.floor(diff%86400000/3600000);return `周期 ${days} 天${hours?` ${hours} 小时`:''}`; };
function RangeDialog({start,end,onClose,onApply}) {
  const ref=useRef(null),[draft,setDraft]=useState({start:start.slice(0,10),end:end.slice(0,10)}),[active,setActive]=useState('start'),[month,setMonth]=useState(()=>monthOf(start));
  useEffect(()=>{const dialog=ref.current;dialog.showModal();return ()=>dialog.close();},[]);
  const today=shanghaiToday();
  const selectDay=day=>{if(active==='start'||!draft.start){setDraft({start:day,end:''});setActive('end');}else{setDraft(p=>({...p,end:day}));setActive('start');}};
  const apply=()=>{if(!draft.start||!draft.end)return;const first=`${draft.start}T${start.split('T')[1]||'00:00:00'}`,last=`${draft.end}T${end.split('T')[1]||'18:00:00'}`;onApply(first,last<first?first:last);};
  return createPortal(<dialog ref={ref} className="campaign-range-dialog" aria-labelledby="campaign-range-title" onCancel={e=>{e.preventDefault();onClose();}}>
    <header><h2 id="campaign-range-title">选择时间区间</h2><button type="button" className="text-button" onClick={onClose}>关闭</button></header>
    <div className="campaign-range-nav"><button type="button" aria-label="上个月" onClick={()=>setMonth(moveMonth(month,-1))}>←</button><strong aria-live="polite">{draft.start||'开始日期'} → {draft.end||'结束日期'}</strong><button type="button" aria-label="下个月" onClick={()=>setMonth(moveMonth(month,1))}>→</button></div>
    <div className="campaign-range-months">{[0,1].map(delta=>{const date=moveMonth(month,delta),days=new Date(date.getFullYear(),date.getMonth()+1,0).getDate(),offset=(date.getDay()+6)%7;return <section className="campaign-range-month" key={dayKey(date)}><h3>{date.getFullYear()} 年 {date.getMonth()+1} 月</h3><div className="campaign-range-grid">{['一','二','三','四','五','六','日'].map(d=><span key={d}>{d}</span>)}{Array.from({length:offset},(_,i)=><span key={'blank'+i}/>)}{Array.from({length:days},(_,i)=>{const key=dayKey(new Date(date.getFullYear(),date.getMonth(),i+1)),disabled=active==='start'?key>today:key<draft.start;return <button type="button" key={key} disabled={disabled} aria-label={key} aria-pressed={key===draft.start||key===draft.end} className={draft.start&&draft.end&&key>=draft.start&&key<=draft.end?'in-range':''} onClick={()=>selectDay(key)}>{i+1}</button>;})}</div></section>;})}</div>
    <footer><button type="button" className="text-button" onClick={()=>{setDraft({start:'',end:''});setActive('start');}}>清空日期</button><span role="status">{active==='end'?'请选择结束日期':'先选开始，再选结束'} · 上海时间</span><button type="button" className="campaign-range-apply" disabled={!draft.start||!draft.end} onClick={apply}>应用区间</button></footer>
  </dialog>,document.body);
}
export function CampaignPeriod({start,end,onChange}) {
  const [open,setOpen]=useState(false);
  return <section className="campaign-period" aria-label="事件周期"><button type="button" className="campaign-period-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}><span>发现日期 → 计划完成日期</span><strong>{start.slice(0,10)||'选择发现日期'} → {end.slice(0,10)||'选择完成日期'}</strong><span>选择时间区间 ↗</span></button><div className="campaign-period-tools"><span>{duration(start,end)} · 上海时间</span></div><details className="campaign-period-precise"><summary>调整具体时间</summary><div className="campaign-period-inputs"><label><span>发现时间 *</span><input className="form-input" aria-label="周期开始时间" type="datetime-local" step="1" required onInvalid={e=>{e.currentTarget.closest('details').open=true;}} max={new Date(Date.now()+28800000).toISOString().slice(0,19)} value={start} onChange={e=>onChange(e.target.value,end)}/></label><span className="campaign-period-arrow">→</span><label><span>计划完成时间 *</span><input className="form-input" aria-label="周期结束时间" type="datetime-local" step="1" min={start} required onInvalid={e=>{e.currentTarget.closest('details').open=true;}} value={end} onChange={e=>onChange(start,e.target.value)}/></label></div></details>{open&&<RangeDialog start={start} end={end} onClose={()=>setOpen(false)} onApply={(a,b)=>{onChange(a,b);setOpen(false);}}/>}</section>;
}
