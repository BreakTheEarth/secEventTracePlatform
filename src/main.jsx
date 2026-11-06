import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDown, ArrowRight, ArrowUpRight, BellOff, Check,
  ChevronLeft, ChevronRight, CircleAlert, Clock3, Database,
  CalendarDays, FileCheck2, FileSpreadsheet, Filter, GitBranch, Layers3, LayoutDashboard, LoaderCircle,
  LockKeyhole, LogOut, Menu, Plus, Search, Shield, ShieldAlert, ShieldCheck, Radio,
  SlidersHorizontal, Upload, X, Eye, EyeOff, Info, Trash2, ListPlus, FileImage,
} from 'lucide-react';
import { api, uploadFile } from './api';
import { batchTextHtml, createBatchTemplate, parseBatchXlsx } from './batch-xlsx';
import { METRICS, STAGES, PERIODS, EVENT_TYPES, formatNumber as n, formatDate } from '../shared/model.mjs';
import './styles.css';
import { Campaigns, CampaignLinkPicker } from './campaigns';
import { isOwnerIdentifier } from '../shared/owners.mjs';
import { APP_VERSION_LABEL } from '../shared/version.mjs';

const PAGE_NAMES = { overview: '风险概览', events: '事件记录', campaigns: '安全专项', model: '运营配置' };
const PAGE_ICONS = { overview: LayoutDashboard, events: FileSpreadsheet, campaigns: Layers3, model: GitBranch };
const SEVERITY_NAMES = ['严重', '高危', '中危', '低危', '轻微'];
const eventTypeName = key => EVENT_TYPES.find(item => item.key === key)?.label || (key === 'IR' ? '应急响应（历史）' : key) || '未标注';
const initialPage = () => Object.hasOwn(PAGE_NAMES, location.hash.slice(1).split('/')[0]) ? location.hash.slice(1).split('/')[0] : 'overview';

function Brand({ light = false }) {
  return <div className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-symbol"><span /><span /><span /></span><span className="brand-word">trace<span className="brand-dot">.</span></span></div>;
}

function Button({ children, icon: Icon, variant = 'primary', className = '', ...props }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{Icon && <Icon size={16} />}{children}</button>;
}

function Spinner({ text = '正在加载…' }) {
  return <div className="loading"><LoaderCircle className="spin" size={22} /><span>{text}</span></div>;
}

function ErrorBlock({ error, retry }) {
  return <div className="error-block" role="alert"><CircleAlert size={20} /><div><strong>暂时无法完成操作</strong><p>{error.message || error}</p></div>{retry && <Button variant="secondary" onClick={retry}>重试</Button>}</div>;
}

function Login({ onLogin }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
      onLogin(data.user);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="login-page">
    <section className="login-story">
      <Brand light />
      <div className="login-story-content">
        <div className="eyebrow"><span className="tiny-line" /> SECURITY OPERATIONS</div>
        <h1>从事件记录，<br />走向闭环处置<span>。</span></h1>
        <p>记录日常安全事件、研判与处置过程。</p>
        <div className="login-funnel" aria-hidden="true">
          {STAGES.map((stage, i) => <div className="login-funnel-row" key={stage.key} style={{ '--i': i }}><span>{String(i + 1).padStart(2, '0')}</span><div style={{ width: `${100 - i * 15}%` }} /><span>{stage.label}</span></div>)}
          <span className="login-funnel-caption">安全风险 · 安全事件 · 安全违规 · 安全红线</span>
        </div>
      </div>
      <div className="login-story-bottom"><span>TRACE / 数据安全运营工作空间</span><span>01 — 05</span></div>
    </section>
    <section className="login-form-section">
      <div className="login-mobile-brand"><Brand /></div>
      <div className="login-form-wrap">
        <div className="login-lock"><LockKeyhole size={23} strokeWidth={1.6} /></div>
        <div className="eyebrow muted">YOUR SECURITY WORKSPACE</div>
        <h2>登录工作空间</h2>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="username">用户名</label>
          <input id="username" name="username" autoComplete="username" placeholder="请输入用户名" required maxLength={100} disabled={busy} autoFocus />
          <label className="field-label" htmlFor="password">密码</label>
          <div className="password-field"><input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="请输入密码" required maxLength={1024} disabled={busy} /><button type="button" aria-label={show ? '隐藏密码' : '显示密码'} onClick={() => setShow(!show)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
          {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <Button type="submit" className="login-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <>登 录 <ArrowRight size={17} /></>}</Button>
        </form>
        <div className="login-security"><ShieldCheck size={14} /><span>身份验证后进入安全运营平台</span></div>
      </div>
    </section>
  </div>;
}

function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState(initialPage);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [revision, setRevision] = useState(0);
  const [campaignFocus, setCampaignFocus] = useState(() => Number(location.hash.split('/')[1]) || null);
  const [campaignSource, setCampaignSource] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef();
  const notify = useCallback((message, type = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => {
    api('/auth/me').then(data => setUser(data.user)).catch(error => {
      if (error.status !== 401) notify(error.message, 'error');
    }).finally(() => setChecking(false));
    const expire = () => { setUser(null); setSelectedEvent(null); setFormOpen(false); setBatchOpen(false); notify('登录已失效，请重新登录。', 'error'); };
    const onHash = () => { setCampaignFocus(Number(location.hash.split('/')[1])||null); setPage(initialPage()); setMobileOpen(false); };
    window.addEventListener('session-expired', expire);
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('session-expired', expire); window.removeEventListener('hashchange', onHash); clearTimeout(toastTimer.current); };
  }, [notify]);
  const navigate = next => { location.hash = next; setPage(next); setMobileOpen(false); };
  const navigateCampaign = id => { const hash=id?`campaigns/${id}`:'campaigns'; location.hash=hash;setCampaignFocus(id);setPage('campaigns');setMobileOpen(false); };
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
      setUser(null);
      setFormOpen(false); setBatchOpen(false); setSelectedEvent(null); setCampaignSource(null); setCampaignFocus(null);
    } catch (error) { notify(error.message, 'error'); }
  }
  if (checking) return <div className="boot-screen"><Brand /><Spinner text="正在验证身份…" /></div>;
  if (!user) return <><Login onLogin={setUser} />{toast && <Toast toast={toast} onClose={() => setToast(null)} />}</>;
  return <div className="app-shell">
    {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <a href="#overview" className="brand-link" aria-label="Trace 首页" onClick={() => navigate('overview')}><Brand /></a>
      <div className="workspace-label"><span className="workspace-monogram"><ShieldCheck size={17} /></span><div><strong>安全运营工作空间</strong></div><LockKeyhole size={12} /></div>
      <div className="nav-label">工作台 <span>WORKSPACE</span></div>
      <nav aria-label="主导航">{Object.entries(PAGE_NAMES).map(([key, label]) => {
        const Icon = PAGE_ICONS[key];
        return <a href={`#${key}`} key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => navigate(key)}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{page === key && <span className="nav-active-dot" />}</a>;
      })}</nav>
      <div className="sidebar-bottom"><div className="local-status"><span className="status-dot" /> 安全运营平台 <span className="version">{APP_VERSION_LABEL}</span></div><div className="user-row"><div className="avatar">{user.username[0].toUpperCase()}</div><div className="user-name"><strong>{user.username}</strong><span>平台管理员</span></div><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut size={17} /></button></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><span>工作空间</span><ChevronRight size={13} /><strong>{PAGE_NAMES[page]}</strong></div><div className="topbar-right"><span><LockKeyhole size={13} /> 鉴权已开启</span><span className="topbar-divider" /><span className="time-zone">Asia / Shanghai</span></div></header>
      <main className="main-content" key={page}>
        {page === 'overview' && <Overview revision={revision} navigate={navigate} notify={notify} />}
        {page === 'events' && <Events revision={revision} onCreate={() => setFormOpen(true)} onBatchCreate={() => setBatchOpen(true)} onEvent={(event, mode = 'detail') => setSelectedEvent({ event, mode })} onChange={() => setRevision(value => value + 1)} notify={notify} />}
        {page === 'campaigns' && <Campaigns ui={campaignUi} revision={revision} onChange={() => setRevision(value => value + 1)} notify={notify} focusId={campaignFocus} onFocus={navigateCampaign} createSource={campaignSource} onSourceHandled={() => setCampaignSource(null)} onEvent={event => setSelectedEvent({ event, mode: 'detail' })} />}
        {page === 'model' && <Model revision={revision} onChange={() => setRevision(value => value + 1)} notify={notify} />}
      <footer className="page-footer"><span><span className="footer-dot" /> TRACE · 安全运营事件平台</span></footer>
      </main>
    </div>
    {formOpen && <EventFormModal onClose={() => setFormOpen(false)} onSuccess={() => { setRevision(value => value + 1); setFormOpen(false); notify('事件已保存。'); }} />}
    {batchOpen && <BatchEventModal onClose={() => setBatchOpen(false)} onSuccess={count => { setRevision(value => value + 1); setBatchOpen(false); notify(`已批量创建 ${count} 个事件。`); }} />}
    {selectedEvent && <EventModal key={`${selectedEvent.event.id}-${selectedEvent.mode}`} event={selectedEvent.event} initialEditing={selectedEvent.mode === 'edit'} onCampaign={campaign => { setSelectedEvent(null); navigateCampaign(campaign.id); }} onImprovement={event => { setSelectedEvent(null); setCampaignFocus(null); setCampaignSource(event); navigate('campaigns'); }} onClose={() => setSelectedEvent(null)} onUpdated={() => { setRevision(value => value + 1); setSelectedEvent(null); notify('事件已更新。'); }} />}
    {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
  </div>;
}

function useData(path, revision) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [retryId, setRetryId] = useState(0);
  useEffect(() => {
    let active = true;
    setState(previous => ({ ...previous, loading: true, error: null }));
    api(path).then(data => { if (active) setState({ data, error: null, loading: false }); })
      .catch(error => { if (active) setState({ data: null, error, loading: false }); });
    return () => { active = false; };
  }, [path, revision, retryId]);
  return { ...state, retry: () => setRetryId(value => value + 1) };
}

function PageHeading({ eyebrow, title, description, children }) {
  return <div className="page-heading"><div><div className="eyebrow muted">{eyebrow}</div><h1>{title}<span className="heading-dot">.</span></h1>{description && <p>{description}</p>}</div><div className="page-actions">{children}</div></div>;
}

function PeriodSelect({ value, onChange }) {
  return <div className="period-control" role="group" aria-label="统计周期">{PERIODS.map(period => <button key={period.key} aria-pressed={value === period.key} className={value === period.key ? 'selected' : ''} onClick={() => onChange(period.key)}>{period.short}</button>)}</div>;
}

function Overview({ revision, navigate, notify }) {
  const [period, setPeriod] = useState('month');
  const { data, error, loading, retry } = useData(`/overview?period=${period}`, revision);
  const values = data?.values || {};
  const count = key => values[`${key}_${period}`] || 0;
  const redLines = count('red_lines');
  const cards = [
    { key: 'logs', label: '安全日志', icon: Database, type: 'neutral' },
    { key: 'risks', label: '安全风险', icon: ShieldAlert, type: 'sage' },
    { key: 'incidents', label: '安全事件', icon: FileCheck2, type: 'green' },
    { key: 'red_lines', label: '安全红线', icon: Shield, type: 'clay' },
  ];
  return <>
    <PageHeading eyebrow="SECURITY OPERATIONS" title="风险概览" />
    <div className="overview-toolbar"><div className="section-eyebrow"><span className="status-dot" /> 运营数据总览</div><PeriodSelect value={period} onChange={setPeriod} /></div>
    {error ? <ErrorBlock error={error} retry={retry} /> : <>
      <div className="stats-grid">{cards.map(card => <article className={`stat-card stat-${card.type}`} key={card.key}><div className="stat-card-top"><span>{card.label}</span><div className="stat-icon"><card.icon size={17} strokeWidth={1.6} /></div></div><div className="stat-value">{loading ? <span className="skeleton-number" /> : n(count(card.key))}<span>条</span></div></article>)}</div>
      <div className="overview-primary-grid">
        <section className="panel funnel-panel"><div className="panel-heading"><div><div className="panel-title"><Filter size={18} /><h2>风险研判分层</h2></div></div><button className="text-button" onClick={() => navigate('model')}>运营配置 <ArrowUpRight size={14} /></button></div>
          {!data?.enabled && !loading ? <div className="disabled-funnel"><BellOff size={25} /><strong>默认周期漏斗已关闭</strong><p>事件数据继续保留，可在运营配置中重新开启。</p><Button variant="secondary" onClick={() => navigate('model')}>前往运营配置</Button></div> : <div className="funnel-content">
            <div className="funnel-table-head"><span>研判层级</span><span>风险来源占比</span><span>记录数</span><span>占风险比</span></div>
            {STAGES.filter(stage => stage.key !== 'logs').map((stage, index) => {
              const value = count(stage.key);
              const previous = count('risks');
              const rate = previous ? (value / previous * 100).toFixed(1) : null;
              return <div className={`funnel-row ${stage.key === 'red_lines' ? 'funnel-row-redline' : ''}`} key={stage.key}>
                <div className="funnel-label"><span>{String(index + 1).padStart(2, '0')}</span><strong>{stage.label}</strong></div>
                <div className="funnel-track"><div className="funnel-bar" style={{ width: `${count('risks') ? Math.min(100,value / count('risks') * 100) : 0}%`, background: stage.color }} /><span className="funnel-track-line" /></div>
                <strong className="funnel-count">{loading ? '—' : n(value)}</strong><span className="funnel-rate">{index === 0 ? '—' : rate === null ? '—' : `${rate}%`}</span>
              </div>;
            })}
            <div className="campaign-source-note">安全日志：具体事件 {n(data?.event_values?.[`logs_${period}`]||0)} + 专项 {n(data?.campaign_values?.logs?.[period]||0)}<br />安全风险：具体事件 {n(data?.event_values?.[`risks_${period}`]||0)} + 专项 {n(data?.campaign_values?.risks?.[period]||0)}<br />安全事件：具体事件 {n(data?.event_values?.[`incidents_${period}`]||0)} + 专项 {n(data?.campaign_values?.incidents?.[period]||0)}</div><div className="funnel-bottom"><div><span className="mini-icon"><ArrowDown size={14} /></span><span>红线占全部风险 <strong>{count('risks') ? (redLines / count('risks') * 100).toFixed(1) : '0.0'}%</strong></span></div></div>
          </div>}
        </section>
        <section className="panel severity-panel"><div className="panel-heading"><div><div className="panel-title"><ShieldAlert size={18} /><h2>红线风险分布</h2></div></div></div><div className="severity-list">{SEVERITY_NAMES.map((name, index) => {
          const countValue = count(`redline_p${index}`);
          return <div className="severity-item" key={name}><div className="severity-main"><span className={`severity-badge p${index}`}>P{index}</span><span>{name}事件</span><strong>{loading ? '—' : n(countValue)}<span>条</span></strong></div><div className="severity-track"><span style={{ width: `${redLines ? countValue / redLines * 100 : 0}%`, background: METRICS[index + 5].color }} /></div></div>;
        })}</div></section>
      </div>
      <div className="data-caption"><Clock3 size={12} /><span>{data?.as_of ? `统计截至 ${formatDate(data.as_of)}（上海时间）` : '正在计算统计数据'}</span></div>
    </>}
  </>;
}

function EmptyState({ icon: Icon = FileSpreadsheet, title, description, compact = false, action }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-icon"><Icon size={26} strokeWidth={1.25} /></div><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function StageBadge({ event }) {
  const stage = STAGES.find(item => item.key === event.stage);
  return <span className={`stage-badge stage-${event.stage}`}>{event.severity && <b>{event.severity}</b>}{stage?.label || event.stage}</span>;
}

function EventOwnersCell({ value }) {
  let owners = value;
  if (typeof owners === 'string') {
    try { owners = JSON.parse(owners); } catch { owners = []; }
  }
  const names = Array.isArray(owners)
    ? owners.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()) : [];
  return <td className="event-owners-cell">{names.length
    ? names.map((name, index) => <span key={`${index}-${name}`}>{name}</span>)
    : <span className="event-owners-empty">未填写</span>}</td>;
}

function Events({ revision, onCreate, onBatchCreate, onEvent, onChange, notify }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [stage, setStage] = useState('');
  const [eventType, setEventType] = useState('');
  const [securityOwner, setSecurityOwner] = useState('');
  const [occurredFrom, setOccurredFrom] = useState('');
  const [occurredTo, setOccurredTo] = useState('');
  const [sort, setSort] = useState('occurred_desc');
  const [pageSize, setPageSize] = useState(20);
  const [pageSizeInput, setPageSizeInput] = useState('20');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { const id = setTimeout(() => { setDebounced(search); setPage(1); }, 250); return () => clearTimeout(id); }, [search]);
  const { data: options } = useData('/events/options', revision);
  const query = new URLSearchParams({
    search: debounced, stage, event_type: eventType, security_owner: securityOwner,
    occurred_from: occurredFrom, occurred_to: occurredTo, sort, page, page_size: pageSize,
  });
  const { data, error, loading, retry } = useData(`/events?${query}`, revision);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / pageSize));
  useEffect(() => {
    if (data && !loading && page > pages) setPage(pages);
  }, [data, loading, page, pages]);
  function applyPageSize() {
    const value = Math.max(1, Math.min(100, parseInt(pageSizeInput, 10) || 20));
    setPageSizeInput(String(value));
    setPageSize(value);
    setPage(1);
  }
  const currentIds = data?.events?.map(event => event.id) || [];
  const allCurrentSelected = currentIds.length > 0 && currentIds.every(id => selectedIds.has(id));
  function toggleSelected(id) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleCurrentPage() {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (allCurrentSelected) currentIds.forEach(id => next.delete(id));
      else currentIds.forEach(id => next.add(id));
      return next;
    });
  }
  async function deleteEvents(ids, confirmation) {
    if (deleting || !ids.length || !window.confirm(confirmation)) return;
    setDeleting(true);
    try {
      const result = await api('/events', { method: 'DELETE', body: JSON.stringify({ ids }) });
      setSelectedIds(previous => new Set([...previous].filter(id => !ids.includes(id))));
      onChange();
      notify(`已删除 ${result.deleted} 条事件记录，风险漏斗已更新。`);
    } catch (err) { notify(err.message, 'error'); }
    finally { setDeleting(false); }
  }
  function deleteSelected() {
    return deleteEvents([...selectedIds], `确定删除选中的 ${selectedIds.size} 条事件记录吗？删除后将从风险漏斗统计中移除。`);
  }
  function deleteEvent(event) {
    return deleteEvents([event.id], `确定删除事件“${event.title || event.event_id}”（${event.event_id}）吗？删除后将从风险漏斗统计中移除。`);
  }
  return <>
    <PageHeading eyebrow="EVENT RECORDS" title="事件记录"><div className="page-action-group"><Button variant="secondary" icon={ListPlus} onClick={onBatchCreate}>批量建单</Button><Button icon={Plus} onClick={onCreate}>上报事件</Button></div></PageHeading>
    <section className="panel events-panel">
      <div className="events-toolbar">
        <div className="search-field"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索事件编号或填报内容" aria-label="搜索事件" />{search && <button className="icon-button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div>
        <div className="select-field"><SlidersHorizontal size={15} /><select value={eventType} aria-label="按事件类型筛选" onChange={event => { setEventType(event.target.value); setPage(1); }}><option value="">全部事件类型</option>{(options?.event_types || EVENT_TYPES).map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select></div>
        <div className="select-field"><select value={securityOwner} aria-label="按安全负责人筛选" onChange={event => { setSecurityOwner(event.target.value); setPage(1); }}><option value="">全部安全负责人</option>{(options?.security_owners || []).map(owner => <option value={owner} key={owner}>{owner}</option>)}</select></div>
        <div className="select-field"><select value={stage} aria-label="按研判层级筛选" onChange={event => { setStage(event.target.value); setPage(1); }}><option value="">全部研判层级</option>{STAGES.map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select></div>
        <div className="select-field"><select value={sort} aria-label="事件排序" onChange={event => { setSort(event.target.value); setPage(1); }}><option value="occurred_desc">发生时间：新到旧</option><option value="occurred_asc">发生时间：旧到新</option><option value="severity_desc">重要程度：高到低</option><option value="severity_asc">重要程度：低到高</option></select></div>
        <span className="record-count">共 <strong>{n(data?.total || 0)}</strong> 条记录</span>
        {selectedIds.size > 0 && <Button variant="danger" icon={Trash2} disabled={deleting} onClick={deleteSelected}>删除已选（{selectedIds.size}）</Button>}
      </div>
      <div className="events-filter-row"><label>发生时间从 <input type="date" max={occurredTo || undefined} value={occurredFrom} onChange={event => { setOccurredFrom(event.target.value); setPage(1); }} /></label><label>到 <input type="date" min={occurredFrom || undefined} value={occurredTo} onChange={event => { setOccurredTo(event.target.value); setPage(1); }} /></label><label>每页 <input className="page-size-input" type="number" min="1" max="100" step="1" aria-label="每页展示条数" value={pageSizeInput} onChange={event => setPageSizeInput(event.target.value)} onBlur={applyPageSize} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /> 条 <span>（最多 100）</span></label><button className="text-button" onClick={() => { setSearch(''); setDebounced(''); setStage(''); setEventType(''); setSecurityOwner(''); setOccurredFrom(''); setOccurredTo(''); setSort('occurred_desc'); setPageSize(20); setPageSizeInput('20'); setPage(1); }}>清空筛选</button></div>
      {error ? <ErrorBlock error={error} retry={retry} /> : loading ? <Spinner text="正在读取事件记录…" /> : !data?.events.length ? <EmptyState title={search || stage || eventType || securityOwner || occurredFrom || occurredTo ? '没有符合条件的事件' : '暂无事件记录'} description={search || stage || eventType || securityOwner || occurredFrom || occurredTo ? '尝试更换筛选条件。' : '通过表单逐条填写事件，保存后会在这里汇总。'} action={search || stage || eventType || securityOwner || occurredFrom || occurredTo ? <Button variant="secondary" onClick={() => { setSearch(''); setDebounced(''); setStage(''); setEventType(''); setSecurityOwner(''); setOccurredFrom(''); setOccurredTo(''); setPage(1); }}>清空筛选</Button> : <div className="page-action-group"><Button variant="secondary" icon={ListPlus} onClick={onBatchCreate}>批量建单</Button><Button icon={Plus} onClick={onCreate}>上报事件</Button></div>} /> : <div className="events-table-wrap"><table className="events-table"><thead><tr><th className="selection-cell"><input type="checkbox" aria-label="选择当前页全部事件" checked={allCurrentSelected} onChange={toggleCurrentPage} /></th><th>事件标题 / 编号</th><th>事件类型</th><th>发现时间</th><th>安全负责人</th><th>事件负责人</th><th>研判层级</th><th>红线确认书</th><th>记录时间</th><th>操作</th></tr></thead><tbody>{data.events.map(event => <tr key={event.id}><td className="selection-cell"><input type="checkbox" aria-label={`选择事件 ${event.event_id}`} checked={selectedIds.has(event.id)} onChange={() => toggleSelected(event.id)} /></td><td><button className="event-title-button" onClick={() => onEvent(event)}>{event.title || event.event_id}</button><span className="table-secondary mono">{event.event_id}</span></td><td><span className="event-type-tag">{eventTypeName(event.event_type)}</span></td><td className="date-cell">{formatDate(event.occurred_at)}</td><EventOwnersCell value={event.security_owners} /><EventOwnersCell value={event.incident_owners} /><td><StageBadge event={event} /></td><td>{event.stage === 'red_lines' ? event.redline_confirmation_asset_id ? <span className="confirmation-status has"><FileImage size={13} />已上传</span> : <span className="confirmation-status">未上传</span> : <span className="table-secondary">不适用</span>}</td><td className="date-cell">{formatDate(event.created_at)}</td><td><div className="event-row-actions"><button className="text-button" onClick={() => onEvent(event)}>详情</button><button className="text-button" onClick={() => onEvent(event, 'edit')}>编辑</button><button className="text-button delete-event-button" disabled={deleting} onClick={() => deleteEvent(event)}>删除</button></div></td></tr>)}</tbody></table></div>}
      {data?.total > 0 && !loading && <div className="pagination"><span>每页 {pageSize} 条 · 共 {n(data.total)} 条</span><div><button className="icon-button" disabled={page <= 1} aria-label="上一页" onClick={() => setPage(page - 1)}><ChevronLeft size={17} /></button><span>{page} / {pages}</span><button className="icon-button" disabled={page >= pages} aria-label="下一页" onClick={() => setPage(page + 1)}><ChevronRight size={17} /></button></div></div>}
    </section>
  </>;
}

function Model({ revision, onChange, notify }) {
  const { data, error, loading, retry } = useData('/model', revision);
  const { data: reportingConfig, error: reportingError } = useData('/reporting/config', revision);
  const { data: reportingKeys, error: reportingKeysError } = useData('/reporting/keys', revision);
  const [busy, setBusy] = useState(false);
  const [reportingBusy, setReportingBusy] = useState(false);
  const [reportingKeyForm, setReportingKeyForm] = useState({ name: '', tags: '' });
  const [reportingKeyEdits, setReportingKeyEdits] = useState({});
  async function toggle() {
    setBusy(true);
    try {
      const result = await api('/model', { method: 'PATCH', body: JSON.stringify({ enabled: !data.enabled }) });
      notify(result.enabled ? `默认周期漏斗已开启，${result.count} 个系统层已就绪。` : '默认周期漏斗已关闭，系统层定义已保留。');
      onChange();
    } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); }
  }
  async function updateReportingEnabled(enabled) {
    setReportingBusy(true);
    try {
      await api('/reporting/config', { method: 'PATCH', body: JSON.stringify({ enabled }) });
      notify(enabled ? '事件上报 API 已开启。' : '事件上报 API 已关闭。');
      onChange();
    } catch (err) { notify(err.message, 'error'); } finally { setReportingBusy(false); }
  }
  async function createReportingKey(event) {
    event.preventDefault();
    const name = reportingKeyForm.name.trim();
    const tags = reportingKeyForm.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
    if (!name) { notify('请填写 API 名称。', 'error'); return; }
    setReportingBusy(true);
    try {
      const result = await api('/reporting/keys', { method: 'POST', body: JSON.stringify({ name, tags }) });
      setReportingKeyForm({ name: '', tags: '' });
      notify('API 密钥已生成，可在下方列表直接复制使用。');
      onChange();
    } catch (err) { notify(err.message, 'error'); } finally { setReportingBusy(false); }
  }
  async function rotateReportingKey(id, name) {
    if (!window.confirm(`重新生成“${name}”会立即使该密钥的旧值失效。继续吗？`)) return;
    setReportingBusy(true);
    try {
      await api(`/reporting/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: '{}' });
      notify('密钥已重新生成，可从对应列表行复制使用。');
      onChange();
    } catch (err) { notify(err.message, 'error'); } finally { setReportingBusy(false); }
  }
  async function deleteReportingKey(id, name) {
    if (!window.confirm(`确定删除“${name}”吗？使用此密钥的上报请求将立即失效。`)) return;
    setReportingBusy(true);
    try {
      await api(`/reporting/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      notify('指定 API 密钥已删除。');
      onChange();
    } catch (err) { notify(err.message, 'error'); } finally { setReportingBusy(false); }
  }
  async function saveReportingKey(id) {
    const item = reportingKeyEdits[id];
    if (!item?.name.trim()) { notify('API 名称不能为空。', 'error'); return; }
    setReportingBusy(true);
    try {
      await api(`/reporting/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({
        name: item.name.trim(), tags: item.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      }) });
      notify('API 名称和标签已保存。');
      onChange();
    } catch (err) { notify(err.message, 'error'); } finally { setReportingBusy(false); }
  }
  async function copyReportingKey(id) {
    try {
      const result = await api(`/reporting/keys/${encodeURIComponent(id)}/copy`, { method: 'POST', body: '{}' });
      await navigator.clipboard.writeText(result.token);
      notify('对应 API 密钥已复制。');
    } catch { notify('浏览器未允许复制，请选中密钥后手动复制。', 'error'); }
  }
  return <>
    <PageHeading eyebrow="OPERATIONS CONFIGURATION" title="运营配置"/>
    {error ? <ErrorBlock error={error} retry={retry} /> : loading && !data ? <Spinner /> : data && <>
      <section className="model-switch-panel"><div className="model-emblem"><GitBranch size={27} strokeWidth={1.5} /></div><div className="model-switch-copy"><div><h2>默认周期漏斗</h2></div><p>10 类指标 · 5 个统计周期</p></div><div className="switch-area"><span>{data.enabled ? '已开启' : '已关闭'}</span><button type="button" role="switch" aria-checked={data.enabled} aria-label="默认周期漏斗开关" className={`toggle ${data.enabled ? 'on' : ''}`} disabled={busy || loading} onClick={toggle}><span /></button></div></section>
      <section className="panel integration-config-panel">
        <div className="panel-heading"><div><div className="panel-title"><Radio size={18} /><h2>事件上报 API</h2><span className={`config-status ${reportingConfig?.enabled ? 'is-ready' : ''}`}>{reportingConfig?.enabled ? '已开启' : '已关闭'}</span></div><p>单条文本上报</p></div></div>
        {reportingError ? <div className="config-error">API 配置读取失败：{reportingError.message}</div> : <div className="integration-config-body">
          <div className="reporting-toolbar"><div><strong>POST /api/v1/events</strong><span>已创建 {reportingConfig?.key_count || 0} 个独立密钥</span></div><label className="reporting-toggle"><input type="checkbox" checked={Boolean(reportingConfig?.enabled)} disabled={reportingBusy || (!reportingConfig?.configured && !reportingConfig?.enabled)} onChange={event => updateReportingEnabled(event.target.checked)} /><span>启用接口</span></label></div>
          <form className="reporting-create-form" onSubmit={createReportingKey}><label><span>新 API 名称</span><input value={reportingKeyForm.name} onChange={event => setReportingKeyForm(previous => ({ ...previous, name: event.target.value }))} placeholder="例如：生产告警接入" type="text" maxLength={80} required /></label><label><span>标签（逗号分隔，可选）</span><input value={reportingKeyForm.tags} onChange={event => setReportingKeyForm(previous => ({ ...previous, tags: event.target.value }))} placeholder="生产、EDR、值班系统" /></label><Button variant="secondary" disabled={reportingBusy}>{reportingBusy ? '处理中…' : '生成 API 密钥'}</Button></form>
          {reportingKeysError ? <div className="config-error">密钥列表读取失败：{reportingKeysError.message}</div> : <div className="reporting-table-wrap">
            <div className="reporting-key-header"><span>名称</span><span>标签</span><span>密钥</span><span>最近使用</span><span>操作</span></div>
            <div className="reporting-key-list">{(reportingKeys?.keys || []).map(key => {
              const edit = reportingKeyEdits[key.id] || { name: key.name, tags: key.tags.join(', ') };
              return <div className="reporting-key-row" key={key.id}><input aria-label={`${key.name} 名称`} value={edit.name} onChange={event => setReportingKeyEdits(previous => ({ ...previous, [key.id]: { ...edit, name: event.target.value } }))} /><input aria-label={`${key.name} 标签`} value={edit.tags} onChange={event => setReportingKeyEdits(previous => ({ ...previous, [key.id]: { ...edit, tags: event.target.value } }))} placeholder="添加标签" /><span className="reporting-key-hint">{key.token_hint}<small>创建于 {new Date(key.created_at).toLocaleString('zh-CN')}</small></span><span className="reporting-key-meta">{key.last_used_at ? new Date(key.last_used_at).toLocaleString('zh-CN') : '尚未使用'}</span><div className="reporting-key-actions"><button type="button" onClick={() => saveReportingKey(key.id)} disabled={reportingBusy}>保存</button><button type="button" onClick={() => copyReportingKey(key.id)} disabled={reportingBusy}>复制</button><button type="button" onClick={() => rotateReportingKey(key.id, key.name)} disabled={reportingBusy}>重生成</button><button type="button" onClick={() => deleteReportingKey(key.id, key.name)} disabled={reportingBusy}>删除</button></div></div>;
            })}</div>
          </div>}
          <div className="reporting-actions"><a className="button button-secondary" href="/api/reporting/skill" download="SKILL.md">下载 AI 调用说明（SKILL.md）</a></div>
          <p className="integration-config-note">删除或重生成后，旧密钥立即失效。请求格式见 <a href="/api/reporting/skill" download="SKILL.md">SKILL.md</a>。</p>
        </div>}
      </section>

    </>}
  </>;
}

function Modal({ title, subtitle, children, onClose, wide = false }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element.open) element.showModal();
    const cancel = event => { event.preventDefault(); };
    element.addEventListener('cancel', cancel, true);
    return () => { element.removeEventListener('cancel', cancel, true); element.close(); };
  }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'modal-wide' : ''}`}><div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={20} /></button></div>{children}</dialog>;
}

function localDateTimeValue(value = new Date().toISOString()) {
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 19);
}

function eventTitlePreview(value, eventType) {
  const date = String(value || '').split('T')[0];
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  if (!match) return `保存后自动生成 · ${eventType}-XXXX`;
  return `保存后自动生成 · ${match[1].slice(-2)}-${monthNames[Number(match[2]) - 1]}-${eventType}-XXXX`;
}

function DateTimeField({ value, onChange }) {
  const [date = '', time = '00:00:00'] = String(value || '').split('T');
  const updateDate = next => onChange(`${next}T${time || '00:00:00'}`);
  const updateTime = next => onChange(`${date}T${next || '00:00:00'}`);
  const useNow = () => onChange(localDateTimeValue());
  return <div className="datetime-picker">
    <div className="datetime-picker-main">
      <label><CalendarDays size={16} /><span>日期</span><input aria-label="发现日期" type="date" value={date} onChange={event => updateDate(event.target.value)} required /></label>
      <span className="datetime-separator">·</span>
      <label><Clock3 size={16} /><span>时间</span><input aria-label="发现时间" type="time" step="1" value={time} onChange={event => updateTime(event.target.value)} required /></label>
    </div>
    <button type="button" className="datetime-now" onClick={useNow}>使用当前时间</button>
    <span className="datetime-zone">上海时间 · 精确到秒</span>
  </div>;
}

function RichTextEditor({ value, onChange, onUpload, label = '详细描述', placeholder = '可填写人工研判、处置经过和补充说明…' }) {
  const editor = useRef(null);
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  useEffect(() => {
    if (editor.current && editor.current.innerHTML !== value) editor.current.innerHTML = value || '';
  }, [value]);
  const command = (name, argument = null) => {
    editor.current?.focus();
    document.execCommand(name, false, argument);
    onChange(editor.current?.innerHTML || '');
  };
  async function selectFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !onUpload) return;
    setUploading(true); setUploadError('');
    try {
      const asset = await onUpload(file);
      const url = String(asset.url).replace(/"/g, '&quot;');
      const filename = String(asset.filename || file.name).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
      command('insertHTML', asset.kind === 'image'
        ? `<p><img src="${url}" alt="${filename}" /></p>`
        : `<p><a href="${url}">${filename}</a></p>`);
    } catch (error) {
      setUploadError(error.message);
    } finally { setUploading(false); }
  }
  return <div className="rich-editor">
    <div className="rich-toolbar" role="toolbar" aria-label={`${label}格式工具`} onMouseDown={event => event.preventDefault()}>
      <button type="button" onClick={() => command('formatBlock', 'p')}>正文</button>
      <button type="button" onClick={() => command('formatBlock', 'h3')}>标题</button>
      <span />
      <button type="button" onClick={() => command('bold')}><b>B</b></button>
      <button type="button" onClick={() => command('italic')}><i>I</i></button>
      <button type="button" onClick={() => command('underline')}><u>U</u></button>
      <span />
      <button type="button" onClick={() => command('insertUnorderedList')}>• 列表</button>
      <button type="button" onClick={() => command('formatBlock', 'blockquote')}>引用</button>
      <button type="button" onClick={() => command('formatBlock', 'pre')}>代码</button>
      <button type="button" onClick={() => { const url = window.prompt('输入链接地址（https:// 或 http://）'); if (url && /^https?:\/\//i.test(url.trim())) command('createLink', url.trim()); }}>链接</button>
      <span />
      {onUpload && <button type="button" className="rich-upload-button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />} {uploading ? '上传中…' : '上传附件'}</button>}
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,.zip,.doc,.docx,.pdf,.txt"
        onCancel={event => { event.preventDefault(); event.stopPropagation(); }} onChange={selectFile} />
    </div>
    <div ref={editor} className="rich-content" contentEditable suppressContentEditableWarning role="textbox"
      aria-label={label} aria-multiline="true" data-placeholder={placeholder}
      onPaste={event => { event.preventDefault(); command('insertText', event.clipboardData.getData('text/plain')); }}
      onInput={event => onChange(event.currentTarget.innerHTML)} />
    {uploadError && <div className="rich-upload-error"><CircleAlert size={14} />{uploadError}</div>}
  </div>;
}

function OwnerInput({ label, value, onChange, placeholder }) {
  const [rows, setRows] = useState(() => value.length ? value : ['']);
  useEffect(() => {
    setRows(value.length ? value : ['']);
  }, [value.join('\u0000')]);
  const sync = nextRows => {
    const names = [...new Set(nextRows.map(item => item.trim()).filter(Boolean))].slice(0, 20);
    onChange(names);
  };
  const updateRow = (index, nextValue) => {
    const nextRows = rows.map((item, rowIndex) => rowIndex === index ? nextValue : item);
    setRows(nextRows);
    sync(nextRows);
  };
  const addRow = () => {
    if (rows.length >= 20) return;
    setRows([...rows, '']);
  };
  const removeRow = index => {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
    const visibleRows = nextRows.length ? nextRows : [''];
    setRows(visibleRows);
    sync(visibleRows);
  };
  return <div className="owner-field"><label className="field-label">{label} <em>必填</em></label><div className="owner-input-wrap">{rows.map((item, index) => <div className="owner-row" key={`${label}-${index}`}><input value={item} aria-label={`${label}${index + 1}`}
    ref={input => { input?.setCustomValidity(item.trim() ? '' : `请填写${label}，或删除多余空行。`); }}
    onChange={event => updateRow(index, event.target.value)} placeholder={index === 0 ? placeholder : '继续填写 admin 或有效邮箱'} type="text" maxLength={254} required /><button type="button" className="owner-row-remove" onClick={() => removeRow(index)} disabled={rows.length === 1 && !item} aria-label={`删除${label}第${index + 1}行`}>删除</button></div>)}<button type="button" className="owner-add" onClick={addRow} disabled={rows.length >= 20}>＋ 添加一行</button></div><span className="field-hint">填写 admin 或有效邮箱，每行一个，可手动添加或删除。</span></div>;
}

function RiskChoice({ label, checked, disabled, onChange, hint }) {
  return <div className={`risk-choice ${disabled ? 'is-disabled' : ''}`}><div><strong>{label}</strong><span>{hint}</span></div><div className="yes-no-choice" role="group" aria-label={label}>{[true, false].map(value => <button key={String(value)} type="button" aria-pressed={checked === value} disabled={disabled} onClick={() => onChange(value)}>{value ? '是' : '否'}</button>)}</div></div>;
}

function RedlineConfirmationField({ asset, assetId, uploading, onUpload, onClear }) {
  const input = useRef(null);
  return <div className="redline-confirmation-field">
    <div className="field-label"><FileImage size={15} />红线确认书 <span className="optional-label">可选，支持常见图片或 PDF</span></div>
    {assetId ? <div className="redline-confirmation-file">{asset?.mime === 'application/pdf' ? <FileCheck2 size={16} /> : <FileImage size={16} />}<span>{asset?.filename || '已上传红线确认书'}</span><a href={`/api/event-assets/${assetId}/download`} target="_blank" rel="noreferrer">查看</a><button type="button" onClick={onClear}>移除</button></div>
      : <button type="button" className="redline-upload-button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}{uploading ? '上传中…' : '上传确认书'}</button>}
    <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf"
      onCancel={event => { event.preventDefault(); event.stopPropagation(); }} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpload(file); }} />
    <span className="field-hint">支持 PNG、JPG、GIF、WEBP 或 PDF，最大 10 MB。用于记录红线确认凭证，选填，不影响事件保存。</span>
  </div>;
}

function EventFormModal({ onClose, onSuccess, initialEvent = null }) {
  const defaultSecurityOwner = 'admin';
  const [form, setForm] = useState({
    event_type: 'DLP', security_risk: false, security_incident: false,
    security_violation: false, security_red_line: false, severity: '',
    discovered_at: localDateTimeValue(), security_owners: [defaultSecurityOwner], incident_owners: [], description_html: '', redline_confirmation_asset_id: null,
    ...(initialEvent ? { ...initialEvent, event_type: initialEvent.event_type || 'DLP', title: '', security_owners: initialEvent.security_owners?.length ? initialEvent.security_owners : [defaultSecurityOwner], severity: initialEvent.security_red_line ? initialEvent.severity || '' : '',
      discovered_at: localDateTimeValue(initialEvent.discovered_at), redline_confirmation_asset_id: initialEvent.redline_confirmation_asset?.id || null } : {}),
  });
  const [campaignLinks, setCampaignLinks] = useState([]);
  const [campaignLinksReady, setCampaignLinksReady] = useState(!initialEvent);
  const [campaignLinksError, setCampaignLinksError] = useState('');
  useEffect(() => { if (!initialEvent) return; let active=true; api(`/events/${initialEvent.id}/campaigns`).then(data=>{if(active){setCampaignLinks(data.campaigns.map(c=>({...c,campaign_id:c.id})));setCampaignLinksReady(true);}}).catch(err=>{if(active)setCampaignLinksError(err.message);});return()=>{active=false;}; }, [initialEvent?.id]);
  const [redlineAsset, setRedlineAsset] = useState(initialEvent?.redline_confirmation_asset || null);
  const [redlineUploading, setRedlineUploading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [assetUploading, setAssetUploading] = useState(false);
  const closeEventForm = () => {
    if (saving || assetUploading || redlineUploading) return;
    onClose();
  };
  const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  function setRiskLevel(key, value) {
    const next = { ...form, [key]: value };
    if (key === 'security_risk' && !value) { next.security_incident = false; next.security_violation = false; next.security_red_line = false; }
    if (key === 'security_incident' && !value) { next.security_violation = false; next.security_red_line = false; }
    if (key === 'security_violation' && !value) next.security_red_line = false;
    if (!next.security_red_line) {
      next.redline_confirmation_asset_id = null;
      setRedlineAsset(null);
    }
    if (!next.security_red_line) next.severity = '';
    setForm(next);
  }
  async function submit(event) {
    event.preventDefault();
    if (saving || !event.currentTarget.form.reportValidity()) return;
    if (form.security_red_line && !/^P[0-4]$/.test(form.severity)) { setSaveError('安全红线事件请选择 P0–P4 事件等级。'); return; }
    if (!form.security_owners.some(name => name.trim())) { setSaveError('请至少填写一名安全负责人。'); return; }
    if (form.security_owners.some(value=>!isOwnerIdentifier(value.trim())) || form.incident_owners.some(value=>!isOwnerIdentifier(value.trim()))) { setSaveError('负责人请填写有效账号或邮箱。'); return; }
    if (!form.incident_owners.some(name => name.trim())) { setSaveError('请至少填写一名事件负责人。'); return; }
    setSaving(true); setSaveError('');
    try {
      await api(initialEvent ? `/events/${initialEvent.id}` : '/events', { method: initialEvent ? 'PUT' : 'POST', body: JSON.stringify({ ...form, ...(campaignLinksReady ? { campaign_links: campaignLinks } : {}) }) });
      onSuccess();
    } catch (error) { setSaveError(error.message); }
    finally { setSaving(false); }
  }
  async function uploadRichAsset(file) {
    const name = file.name.toLowerCase();
    const isImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) &&
      /\.(png|jpe?g|gif|webp)$/.test(name);
    const isZip = /\.zip$/.test(name);
    const isDocument = /\.(doc|docx|pdf|txt)$/.test(name);
    if (!isImage && !isZip && !isDocument) throw new Error('仅支持 PNG、JPG、GIF、WEBP 图片、ZIP、DOC、DOCX、PDF 或 TXT 文件。');
    if (file.size > 20 * 1024 * 1024) throw new Error('单个附件不能超过 20 MB。');
    setAssetUploading(true);
    try {
      const asset = await uploadFile('/event-assets', file);
      return asset;
    }
    finally { setAssetUploading(false); }
  }
  async function uploadRedlineConfirmation(file) {
    setSaveError('');
    try {
      const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
      if (!allowed.has(file.type) || !/\.(png|jpe?g|gif|webp|pdf)$/i.test(file.name)) throw new Error('红线确认书仅支持 PNG、JPG、GIF、WEBP 图片或 PDF 文件。');
      if (file.size > 10 * 1024 * 1024) throw new Error('红线确认书不能超过 10 MB。');
      setRedlineUploading(true);
      const asset = await uploadFile('/event-assets', file, { 'X-Asset-Purpose': 'redline-confirmation' });
      setRedlineAsset(asset);
      update('redline_confirmation_asset_id', asset.id);
    } catch (error) { setSaveError(error.message); }
    finally { setRedlineUploading(false); }
  }
  async function clearRedlineConfirmation() {
    if (!form.redline_confirmation_asset_id) return;
    try {
      await api(`/event-assets/${form.redline_confirmation_asset_id}`, { method: 'DELETE' });
      setRedlineAsset(null);
      update('redline_confirmation_asset_id', null);
    } catch (error) { setSaveError(error.message); }
  }
  return <Modal title={initialEvent ? '编辑事件' : '上报事件'} subtitle="填写事件信息，系统将按发现时间进入风险漏斗。" onClose={closeEventForm} wide>
    <form onSubmit={event => event.preventDefault()} onKeyDown={event => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.target instanceof HTMLInputElement && !['radio', 'checkbox', 'button', 'submit'].includes(event.target.type)) {
        event.preventDefault();
        event.target.blur();
      }
    }}>
      <div className="modal-body incident-form">
        <div className="form-section-label">基本信息 <span>BASE INFORMATION</span></div>
        <label className="field-label">事件标题</label>
        <div className="generated-title-preview"><strong>{eventTitlePreview(form.discovered_at, form.event_type)}</strong><span>保存时按发现月份和当月事件顺序自动生成</span></div>
        <label className="field-label" htmlFor="event-type">事件类型 <em>必填</em></label>
        <select id="event-type" className="form-input" value={form.event_type} onChange={event => update('event_type',event.target.value)} required>
          {form.event_type === 'IR' && <option value="IR">应急响应（历史类型，仅保留当前记录）</option>}
          {EVENT_TYPES.map(item => <option key={item.key} value={item.key}>{item.label} · {item.description}</option>)}
        </select>
        <div className="form-section-label form-section-spaced">风险判定 <span>RISK CLASSIFICATION</span></div>
        <div className="risk-tree">
          <RiskChoice label="安全风险" checked={form.security_risk} onChange={value => setRiskLevel('security_risk', value)} hint="识别安全风险" />
          <div className="risk-child level-2"><RiskChoice label="安全事件" checked={form.security_incident} disabled={!form.security_risk} onChange={value => setRiskLevel('security_incident', value)} hint="确认安全事件" /></div>
          <div className="risk-child level-3"><RiskChoice label="安全违规" checked={form.security_violation} disabled={!form.security_incident} onChange={value => setRiskLevel('security_violation', value)} hint="确认违规行为" /></div>
          <div className="risk-child level-4"><RiskChoice label="安全红线" checked={form.security_red_line} disabled={!form.security_violation} onChange={value => setRiskLevel('security_red_line', value)} hint="触及安全红线" /></div>
        </div>
        <fieldset className={`severity-picker event-severity-picker ${!form.security_red_line ? 'is-optional' : ''}`}><legend>事件等级 <em>{form.security_red_line ? '必填' : '非红线无需填写'}</em></legend>{['P0', 'P1', 'P2', 'P3', 'P4'].map((item, index) => <label key={item} className={`severity-option severity-option-${index}`}><input type="radio" name="severity" required={form.security_red_line} disabled={!form.security_red_line} checked={form.severity === item} onChange={() => update('severity', item)} /><span>{item}</span><small>{SEVERITY_NAMES[index]}</small></label>)}</fieldset>
        {form.security_red_line && <RedlineConfirmationField asset={redlineAsset} assetId={form.redline_confirmation_asset_id} uploading={redlineUploading} onUpload={uploadRedlineConfirmation} onClear={clearRedlineConfirmation} />}
        <div className="form-section-label form-section-spaced">责任与时间 <span>OWNERSHIP & TIME</span></div>
        <label className="field-label" htmlFor="discovered-at">发现时间 <em>必填</em></label>
        <DateTimeField value={form.discovered_at} onChange={value => update('discovered_at', value)} />
        <div className="owner-grid"><OwnerInput label="安全负责人" value={form.security_owners} onChange={value => update('security_owners', value)} placeholder="输入安全负责人账号或邮箱" /><OwnerInput label="事件负责人" value={form.incident_owners} onChange={value => update('incident_owners', value)} placeholder="输入事件负责人账号或邮箱" /></div>
        <div className="form-section-label form-section-spaced">关联安全专项 <span>可选</span></div>
        {campaignLinksReady ? <CampaignLinkPicker ui={campaignUi} value={campaignLinks} onChange={setCampaignLinks} /> : <p className="field-hint">{campaignLinksError || '正在读取已有专项关联…'}{campaignLinksError && ' 保存事件时保留原关联。'}</p>}
        <div className="form-section-label form-section-spaced">详细描述 <span>RICH TEXT</span></div>
        <RichTextEditor value={form.description_html} onChange={value => update('description_html', value)} onUpload={uploadRichAsset} />
        {assetUploading && <p className="field-hint">附件正在上传，请稍候…</p>}
        {saveError && <div className="inline-error save-error"><CircleAlert size={15} />{saveError}</div>}
      </div>
      <div className="modal-footer"><span><LockKeyhole size={13} /> 填写完成后点击保存</span><Button type="button" variant="secondary" disabled={saving || assetUploading || redlineUploading} onClick={closeEventForm}>取消</Button><Button type="button" onClick={submit} icon={saving || assetUploading || redlineUploading ? LoaderCircle : Check} disabled={saving || assetUploading || redlineUploading}>{saving ? '保存中…' : assetUploading || redlineUploading ? '附件上传中…' : initialEvent ? '保存修改' : '保存上报事件'}</Button></div>
    </form>
  </Modal>;
}

function batchOwners(value) {
  return [...new Set(String(value || '').split(/[\n,，、;；]+/).map(item => item.trim()).filter(Boolean))].slice(0, 20);
}

async function downloadBatchTemplate(options = {}) {
  const url = URL.createObjectURL(new Blob([await createBatchTemplate(options)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '安全运营批量建单模板.xlsx';
  anchor.click();
  URL.revokeObjectURL(url);
}

function newBatchRow() {
  return {
    discovered_at: localDateTimeValue(), event_type: 'DLP', security_owners: 'admin', incident_owners: '',
    security_risk: false, security_incident: false, security_violation: false, security_red_line: false,
    severity: '', description_html: '',
  };
}

function BatchEventModal({ onClose, onSuccess }) {
  const { data: eventOptions } = useData('/events/options', 0);
  const [rows, setRows] = useState([newBatchRow()]);
  const [spreadsheetBusy, setSpreadsheetBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  function updateRow(index, key, value) {
    setRows(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
  }
  function setRiskLevel(index, key, value) {
    setRows(previous => previous.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const next = { ...row, [key]: value };
      if (key === 'security_risk' && !value) {
        next.security_incident = false; next.security_violation = false; next.security_red_line = false;
      }
      if (key === 'security_incident' && !value) {
        next.security_violation = false; next.security_red_line = false;
      }
      if (key === 'security_violation' && !value) next.security_red_line = false;
      if (!next.security_red_line) next.severity = '';
      return next;
    }));
  }
  async function importExcel(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSpreadsheetBusy(true); setError('');
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('请上传 .xlsx 格式的 Excel 文件。');
      if (file.size > 5 * 1024 * 1024) throw new Error('XLSX 文件不能超过 5 MB。');
      const imported = await parseBatchXlsx(await file.arrayBuffer());
      setRows(imported);
      setError('');
    } catch (importError) { setError(importError.message); }
    finally { setSpreadsheetBusy(false); }
  }
  async function downloadTemplate() {
    setSpreadsheetBusy(true); setError('');
    try {
      const options = await api('/events/options');
      await downloadBatchTemplate({ securityOwners: options.security_owners });
    }
    catch (downloadError) { setError(`Excel 模板生成失败：${downloadError.message}`); }
    finally { setSpreadsheetBusy(false); }
  }
  async function submit() {
    if (saving || spreadsheetBusy) return;
    if (!rows.length || rows.length > 100) { setError('批量建单数量必须为 1–100 条。'); return; }
    for (const [index, row] of rows.entries()) {
      const number = index + 1;
      if (!row.discovered_at || !row.event_type || !batchOwners(row.security_owners).length || !batchOwners(row.incident_owners).length) {
        setError(`第 ${number} 条请填写发现时间、事件类型、安全负责人和事件负责人。`); return;
      }
      if ([...batchOwners(row.security_owners),...batchOwners(row.incident_owners)].some(value=>!isOwnerIdentifier(value))) { setError(`第 ${number} 条负责人请填写有效账号或邮箱。`); return; }
      if ((row.security_incident && !row.security_risk) || (row.security_violation && !row.security_incident) ||
          (row.security_red_line && !row.security_violation)) {
        setError(`第 ${number} 条风险判定不符合层级关系：事件依赖风险、违规依赖事件、红线依赖违规。`); return;
      }
      if (row.security_red_line ? !/^P[0-4]$/.test(row.severity) : Boolean(row.severity)) {
        setError(`第 ${number} 条${row.security_red_line ? '红线事件必须选择事件等级 P0–P4' : '非红线事件不能填写事件等级'}。`); return;
      }
    }
    setSaving(true); setError('');
    try {
      const result = await api('/events/batch', { method: 'POST', body: JSON.stringify({ reports: rows.map(row => ({
        ...row,
        security_owners: batchOwners(row.security_owners),
        incident_owners: batchOwners(row.incident_owners),
        description_html: batchTextHtml(row.description_html),
      })) }) });
      onSuccess(result.events.length);
    } catch (submitError) { setError(submitError.message); }
    finally { setSaving(false); }
  }
  return <Modal title="批量建单" subtitle="每行填写一条完整事件记录；文件可在创建后逐条添加。" onClose={() => !saving && !spreadsheetBusy && onClose()} wide>
    <div className="modal-body batch-form">
      <div className="batch-intro"><ListPlus size={20} /><div><strong>逐条填写完整事件信息</strong><p>每一行创建一个独立工单。类型、时间、负责人、风险判定和内容都按行填写；红线确认书及其他文件请在工单创建后逐条上传。</p></div></div>
      <div className="batch-toolbar"><Button variant="secondary" disabled={saving || spreadsheetBusy} onClick={downloadTemplate}>下载 Excel 模板（.xlsx）</Button><label className={`button button-secondary batch-import-button ${saving || spreadsheetBusy ? 'is-disabled' : ''}`}><Upload size={16} />导入 Excel 文件<input type="file" hidden disabled={saving || spreadsheetBusy} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importExcel} /></label><span>{spreadsheetBusy ? '正在处理 Excel…' : '最多 100 行 · 5 MB'}</span></div>
      <div className="batch-row-list">{rows.map((row, index) => <section className="batch-row" key={`batch-row-${index}`}>
        <div className="batch-row-head"><span className="batch-row-number">{String(index + 1).padStart(2, '0')}</span><strong>事件 {index + 1}</strong><button type="button" className="batch-row-remove" onClick={() => setRows(previous => previous.filter((_, rowIndex) => rowIndex !== index))} disabled={rows.length === 1}>删除此行</button></div>
        <div className="batch-fields">
          <label className="batch-field"><span>发现时间 <em>必填</em></span><input type="datetime-local" step="1" value={row.discovered_at} onChange={event => updateRow(index, 'discovered_at', event.target.value)} /></label>
          <label className="batch-field"><span>事件类型 <em>必填</em></span><select value={row.event_type} onChange={event => updateRow(index, 'event_type', event.target.value)}><option value="">请选择</option>{(eventOptions?.event_types || EVENT_TYPES).map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>
          <label className="batch-field"><span>安全负责人 <em>必填</em></span><input list="batch-security-owner-options" value={row.security_owners} onChange={event => updateRow(index, 'security_owners', event.target.value)} placeholder="admin 或有效邮箱，多人用逗号分隔" /></label>
          <label className="batch-field"><span>事件负责人 <em>必填</em></span><input value={row.incident_owners} onChange={event => updateRow(index, 'incident_owners', event.target.value)} placeholder="admin 或有效邮箱，多人用逗号分隔" /></label>
          <div className="batch-field batch-field-wide"><span>风险判定 <em>必填</em></span><div className="batch-risk-tree">
            <RiskChoice label="安全风险" checked={row.security_risk} onChange={value => setRiskLevel(index, 'security_risk', value)} hint="基础判定" />
            <div className="risk-child level-2"><RiskChoice label="安全事件" checked={row.security_incident} disabled={!row.security_risk} onChange={value => setRiskLevel(index, 'security_incident', value)} hint="依赖安全风险" /></div>
            <div className="risk-child level-3"><RiskChoice label="安全违规" checked={row.security_violation} disabled={!row.security_incident} onChange={value => setRiskLevel(index, 'security_violation', value)} hint="依赖安全事件" /></div>
            <div className="risk-child level-4"><RiskChoice label="安全红线" checked={row.security_red_line} disabled={!row.security_violation} onChange={value => setRiskLevel(index, 'security_red_line', value)} hint="依赖安全违规" /></div>
          </div></div>
          <fieldset className={`severity-picker event-severity-picker batch-field batch-field-wide ${!row.security_red_line ? 'is-optional' : ''}`}><legend>事件等级 <em>{row.security_red_line ? '红线事件必填' : '仅红线事件填写'}</em></legend>{['P0', 'P1', 'P2', 'P3', 'P4'].map((item, level) => <label key={item} className={`severity-option severity-option-${level}`}><input type="radio" name={`batch-severity-${index}`} disabled={!row.security_red_line} checked={row.severity === item} onChange={() => updateRow(index, 'severity', item)} /><span>{item}</span><small>{SEVERITY_NAMES[level]}</small></label>)}</fieldset>
          <label className="batch-field batch-field-wide"><span>详细内容 <small>可留空；按纯文本导入</small></span><textarea value={row.description_html} onChange={event => updateRow(index, 'description_html', event.target.value)} placeholder="填写该事件的背景、发现情况、研判和处置记录" /></label>
        </div>
      </section>)}</div>
      <datalist id="batch-security-owner-options">{(eventOptions?.security_owners || []).map(owner => <option value={owner} key={owner} />)}</datalist>
      <button type="button" className="batch-add-row" onClick={() => setRows(previous => [...previous, newBatchRow()])} disabled={rows.length >= 100}>＋ 添加一行</button>
      {error && <div className="inline-error save-error"><CircleAlert size={15} />{error}</div>}
    </div>
    <div className="modal-footer"><span><LockKeyhole size={13} />确认后将一次性创建 {rows.length} 个独立工单</span><Button type="button" variant="secondary" disabled={saving || spreadsheetBusy} onClick={onClose}>取消</Button><Button type="button" icon={saving ? LoaderCircle : Check} disabled={saving || spreadsheetBusy} onClick={submit}>{saving ? '创建中…' : '确认批量建单'}</Button></div>
  </Modal>;
}

function EventModal({ event, initialEditing = false, onClose, onUpdated, onCampaign, onImprovement }) {
  const { data, loading, error, retry } = useData(`/events/${event.id}`, 0);
  const [editing, setEditing] = useState(initialEditing);
  const { data: campaignData, error: campaignError } = useData(`/events/${event.id}/campaigns`, 0);
  const detail = data?.event;
  if (editing && detail) return <EventFormModal initialEvent={detail} onClose={initialEditing ? onClose : () => setEditing(false)} onSuccess={onUpdated} />;
  return <Modal title={editing ? '编辑事件' : '事件详情'} subtitle={event.event_id} onClose={onClose} wide>
    <div className="modal-body">{loading ? <Spinner /> : error ? <ErrorBlock error={error} retry={retry} /> : detail && <>
      <div className="event-detail-title"><div><h3>{detail.title || detail.event_id}</h3><span className="event-type-tag">{eventTypeName(detail.event_type)} · {detail.event_type || 'DLP'}</span></div><StageBadge event={detail} /></div>
      <dl className="detail-grid">{[['事件编号', detail.event_id], ['事件类型', eventTypeName(detail.event_type)], ['事件类型代码', detail.event_type || 'DLP'], ['发现时间', `${formatDate(detail.occurred_at)}（上海时间）`], ['研判层级', STAGES.find(item => item.key === detail.stage)?.label], ['安全负责人', detail.security_owners.join('、') || '未填写'], ['事件负责人', detail.incident_owners.join('、') || '未填写'], ['事件等级', detail.severity ? `${detail.severity} · ${SEVERITY_NAMES[Number(detail.severity[1])]}事件` : '未填写'], ['记录时间', formatDate(detail.created_at)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {detail.security_red_line && <div className="redline-detail-card"><strong><FileImage size={15} />红线确认书</strong>{detail.redline_confirmation_asset ? <a href={`/api/event-assets/${detail.redline_confirmation_asset.id}/download`} target="_blank" rel="noreferrer">{detail.redline_confirmation_asset.mime === 'application/pdf' ? <FileCheck2 size={14} /> : <FileImage size={14} />}{detail.redline_confirmation_asset.filename} · 查看文件</a> : <span>未上传（可选）</span>}</div>}
      <div className="detail-description"><h3>关联安全专项</h3>{campaignError ? <p className="inline-error">{campaignError.message}</p> : campaignData?.campaigns.length ? campaignData.campaigns.map(c=><div className="campaign-event" key={c.id}><button className="text-button" onClick={()=>onCampaign(c)}>{c.code} · {c.title}</button><span>{{risk_source:'风险来源 / 利用入口',post_incident:'事件后改进',related:'相关排查'}[c.relation]} · {{pending:'待确认',confirmed:'已确认',not_confirmed:'已排除'}[c.confidence]} · {c.status==='tracking'?'跟踪中':'已完结'}</span><p>{c.note}</p></div>) : <p>未关联专项</p>}<Button variant="secondary" onClick={()=>onImprovement(detail)}>新建改进专项</Button></div>
      <div className="detail-description"><h3>详细描述</h3>{detail.description_html ? <div className="rich-content" dangerouslySetInnerHTML={{ __html: detail.description_html }} /> : <p>未填写</p>}</div>
    </>}</div><div className="modal-footer"><Button variant="secondary" onClick={onClose}>关闭</Button>{detail && <Button onClick={() => setEditing(true)}>编辑事件</Button>}</div>
  </Modal>;
}

function Toast({ toast, onClose }) {
  return <div className={`toast toast-${toast.type}`} role="status">{toast.type === 'error' ? <CircleAlert size={18} /> : <Check size={18} />}<span>{toast.message}</span><button className="icon-button" aria-label="关闭提示" onClick={onClose}><X size={15} /></button></div>;
}

const campaignUi = { Modal, Button, RichTextEditor, RiskChoice, useData, PageHeading, Spinner, ErrorBlock, EmptyState };

createRoot(document.getElementById('root')).render(<App />);
