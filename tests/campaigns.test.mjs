import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { PERIODS, calculateSnapshot, SYSTEM_LAYERS } from '../shared/model.mjs';

const campaign = (changes={}) => ({title:'0day 群体排查',type:'漏洞应对',stage:'risks',importance:'P0',lead_owner:'security.a@example.com',collaborators:[],security_owners:['security.a@example.com'],scopes:['全公司','支付服务'],occurred_at:'2026-09-30T16:00:00Z',due_at:'2026-11-01T18:00:00+08:00',objective:'排查受影响服务并修复验证',description_html:'<p>验证后闭环</p>',reference_text:'CVE-2026-TEST',...changes});
const task = (changes={}) => ({title:'支付组件升级',owner:'fix.b@example.com',collaborators:'协同丙',scope:'支付服务所有实例',description_html:'<p>升级并验证</p>',acceptance:'全部实例升级且检测通过',due_at:'',...changes});
const report = (changes={})=>({event_type:'HIDS',security_risk:true,security_incident:true,security_violation:false,security_red_line:false,severity:'',discovered_at:'2026-10-01T01:00:00',security_owners:['security.a@example.com'],incident_owners:['asset.b@example.com'],description_html:'<p>入侵排查</p>',...changes});
async function setup(t,options={}) {
  const directory=mkdtempSync(join(tmpdir(),'trace-campaign-'));
  const platform=createPlatform({databasePath:join(directory,'test.sqlite'),adminUsername:'admin',adminPassword:'test-pass',clock:()=>new Date('2026-10-22T08:00:00Z'),...options});
  const server=platform.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;let cookie='';
  async function req(path,body,method=body===undefined?'GET':'POST',headers={}) {
    return fetch(base+'/api'+path,{method,headers:{Cookie:cookie,...(Buffer.isBuffer(body)?{'Content-Type':'application/octet-stream'}:body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  }
  const login=await req('/auth/login',{username:'admin',password:'test-pass'});cookie=login.headers.get('set-cookie').split(';')[0];
  async function json(path,body,method) {const r=await req(path,body,method);const data=await r.json();assert.ok(r.ok,`${method||'GET'} ${path}: ${r.status} ${JSON.stringify(data)}`);return data;}
  t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});platform.close();rmSync(directory,{recursive:true,force:true});});
  return {req,json,db:platform.db,base,directory,platform};
}

test('专项创建校验、上海月份编号、搜索转义、分页和责任筛选',async t=>{
  const {req,json}=await setup(t);
  for(const changes of [{stage:'red_lines'},{importance:'P5'},{lead_owner:''},{scopes:[]},{occurred_at:'2099-01-01T00:00:00'},{tasks:{}},{events:{}},{tasks:[task({owner:''})]}])assert.equal((await req('/campaigns',campaign(changes))).status,400);
  const {campaign:c}=await json('/campaigns',campaign({title:'CVE 100%_排查',description_html:'<p>CVE 100%_排查</p>',tasks:[task()]}));
  assert.equal(c.code,'26-OCT-SPC-0001');assert.equal(c.tasks[0].code,`${c.code}-T001`);assert.equal(c.status,'tracking');assert.equal(c.tasks[0].owner,'fix.b@example.com');
  assert.equal((await json('/campaigns?search=100%25_')).total,1);
  assert.equal((await json('/campaigns?search=not_found')).total,0);
  assert.equal((await json('/campaigns?owner='+encodeURIComponent('security.a@example.com'))).total,1);
  assert.equal((await json('/campaigns?task_owner='+encodeURIComponent('fix.b@example.com'))).total,1);
  assert.equal((await json('/campaigns?task_owner=other')).total,0);
  assert.equal((await json('/events')).total,0);
  for(let i=0;i<20;i++)await json('/campaigns',campaign());
  assert.equal((await json('/campaigns')).campaigns.length,20);assert.equal((await json('/campaigns?page=2')).campaigns.length,1);
});

test('父子完结、显式重新跟踪、结论历史、移除和编号不复用',async t=>{
  const {req,json}=await setup(t);let c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  const base=`/campaigns/${c.id}`,taskId=c.tasks[0].id,taskBase=`${base}/tasks/${taskId}`;
  assert.equal((await req(base+'/status',{version:c.version,status:'completed',reason:'仍在修复'})).status,409);
  c=(await json(taskBase+'/status',{version:c.tasks[0].version,status:'completed',reason:'已验证全部修复'})).campaign;
  assert.equal(c.status,'tracking');assert.equal(c.task_summary.tracking,0);
  assert.equal((await req(taskBase,task({version:c.tasks[0].version}),'PUT')).status,409);
  c=(await json(base+'/status',{version:c.version,status:'completed',reason:'专项验证通过'})).campaign;
  assert.equal((await req(base+'/tasks',task())).status,409);
  assert.equal((await req(taskBase+'/status',{version:c.tasks[0].version,status:'tracking',reason:'复测失败'})).status,409);
  c=(await json(taskBase+'/status',{version:c.tasks[0].version,status:'tracking',reason:'复测失败',reopen_campaign:true})).campaign;
  assert.equal(c.status,'tracking');assert.equal(c.tasks[0].status,'tracking');assert.equal(c.conclusion,null);assert.equal(c.tasks[0].conclusion,null);
  assert.ok(c.updates.some(u=>u.body==='专项验证通过'));assert.ok(c.updates.some(u=>u.body.includes('已验证全部修复')));
  await json(taskBase,{version:c.tasks[0].version,reason:'误建任务'},'DELETE');
  const created=(await json(base+'/tasks',task())).task;assert.ok(created.code.endsWith('T002'));
  c=(await json(base)).campaign;assert.equal(c.task_summary.total,1);assert.ok(c.updates.some(u=>u.kind==='task_removed'));
});

test('无子任务可完结，新建任务必须明确重开且原子回滚',async t=>{
  const {req,json}=await setup(t);let c=(await json('/campaigns',campaign())).campaign;const base=`/campaigns/${c.id}`;
  assert.deepEqual(c.task_summary,{total:0,completed:0,tracking:0});
  c=(await json(base+'/status',{version:c.version,status:'completed',reason:'未受影响'})).campaign;
  assert.equal((await req(base+'/tasks',task({owner:'',reopen_campaign:true,reason:'补排查'}))).status,400);
  assert.equal((await json(base)).campaign.status,'completed');
  await json(base+'/tasks',task({reopen_campaign:true,reason:'新增受影响服务'}));
  c=(await json(base)).campaign;assert.equal(c.status,'tracking');assert.equal(c.tasks.length,1);
});

test('版本校验防止覆盖，字段变化和子任务跟踪保留历史',async t=>{
  const {req,json}=await setup(t);let c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;const base=`/campaigns/${c.id}`;
  const first=c;
  c=(await json(base,{...c,importance:'P4',scopes:['核心服务']},'PUT')).campaign;
  assert.equal((await req(base,{...first,title:'过期编辑'},'PUT')).status,409);
  assert.ok(c.updates.some(u=>u.kind==='edited'&&JSON.parse(u.body).importance.before==='P0'));
  await json(`${base}/tasks/${c.tasks[0].id}/updates`,{body:'升级完成，等待复测'});
  const updated=(await json(base)).campaign;
  assert.ok(updated.updates.some(u=>u.kind==='task_update'&&u.body==='升级完成，等待复测'));
  assert.equal((await req(`${base}/tasks/${c.tasks[0].id}/status`,{version:c.tasks[0].version,status:'completed',reason:'过期提交'})).status,409);
});

test('事件先建或专项先建均可关联，多对多、更新关系与删除解除不重复计数',async t=>{
  const {req,json,db}=await setup(t);
  const c=(await json('/campaigns',campaign())).campaign;
  const e=(await json('/events',report({campaign_links:[{campaign_id:c.id,relation:'risk_source',confidence:'pending',note:'怀疑由该 0day 进入'}]}))).event;
  const c2=(await json('/campaigns',campaign({events:[{event_id:e.id,relation:'post_incident',confidence:'confirmed',note:'复盘改进'}]}))).campaign;
  assert.equal((await json(`/events/${e.id}/campaigns`)).campaigns.length,2);
  await json(`/campaigns/${c.id}/events/${e.id}`,{relation:'risk_source',confidence:'confirmed',note:'日志验证该入口'},'PUT');
  assert.equal((await json(`/campaigns/${c.id}`)).campaign.events.length,1);
  const values=(await json('/overview')).values;
  assert.equal(values.risks_all,3);assert.equal(values.incidents_all,3);assert.equal(values.logs_all,3);
  assert.equal((await req(`/campaigns/${c.id}/events/${e.id}`,{relation:'risk_source',confidence:'confirmed',note:''},'PUT')).status,400);
  assert.equal((await req('/events',report({campaign_links:[{campaign_id:999999,relation:'related',confidence:'pending',note:''}]}))).status,404);
  assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,1);
  assert.equal((await req('/campaigns',campaign({tasks:[task()],events:[{event_id:99999,relation:'related'}]}))).status,404);
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaigns').get().n,2);
  await json(`/campaigns/${c2.id}/events/${e.id}`,{},'DELETE');
  assert.equal((await json(`/events/${e.id}/campaigns`)).campaigns.length,1);
  await json('/events',{ids:[e.id]},'DELETE');
  assert.equal((await json(`/campaigns/${c.id}`)).campaign.events.length,0);
  assert.ok((await json(`/campaigns/${c.id}`)).campaign.updates.some(u=>u.kind==='event_deleted'));
});

test('专项贡献日志、风险与事件，50 字段、上海周期、等级状态和子任务均不影响口径',async t=>{
  const {json,db}=await setup(t);
  let c=(await json('/campaigns',campaign())).campaign;
  let overview=await json('/overview');const before=overview.values;
  assert.equal(Object.keys(before).length,50);assert.equal(before.logs_all,1);assert.equal(before.risks_all,1);assert.equal(before.incidents_all,1);
  assert.equal(before.risks_month,1);assert.equal(before.redline_p0_all,0);
  const event=(await json('/events',report())).event;
  overview=await json('/overview');assert.equal(overview.values.risks_all,2);assert.equal(overview.values.incidents_all,2);
  c=(await json(`/campaigns/${c.id}`,{...c,stage:'incidents',importance:'P4'},'PUT')).campaign;
  const after=(await json('/overview')).values;assert.equal(after.risks_all,2);assert.equal(after.incidents_all,2);
  await json(`/campaigns/${c.id}/status`,{version:c.version,status:'completed',reason:'完成'});
  assert.deepEqual((await json('/overview')).values,after);
  const eventOnly=calculateSnapshot(db.prepare('SELECT * FROM records').all());
  for(const key of Object.keys(after))if(!key.startsWith('logs_')&&!key.startsWith('risks_')&&!key.startsWith('incidents_'))assert.equal(after[key],eventOnly[key],key);
  assert.equal(SYSTEM_LAYERS.length,50);
  const old=(await json('/snapshots',{}));
  const snapshotId=old.snapshot?.id||old.id;
  assert.ok(snapshotId);
  const frozen=db.prepare('SELECT values_json FROM snapshots WHERE id=?').get(snapshotId).values_json;
  c=(await json(`/campaigns/${c.id}`)).campaign;
  await json(`/campaigns/${c.id}/status`,{version:c.version,status:'tracking',reason:'继续观察'});
  await json(`/campaigns/${c.id}/tasks`,task());
  assert.deepEqual((await json('/overview')).values,after);
  assert.equal(db.prepare('SELECT values_json FROM snapshots WHERE id=?').get(snapshotId).values_json,frozen);
  assert.equal((await json(`/events/${event.id}/campaigns`)).campaigns.length,0);
});

test('证据附件鉴权、归属、伪装文件拦截、下载、删除状态和审计',async t=>{
  const {req,json,base,directory,db}=await setup(t);
  const c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  const c2=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  const path=`/campaigns/${c.id}/assets`,headers={'X-File-Name':encodeURIComponent('验证证据.txt')};
  assert.equal((await fetch(base+'/api'+path)).status,401);
  assert.equal((await req(path,Buffer.from('plain'),'POST',{'X-File-Name':'fake.png','X-File-Type':'image/png'})).status,400);
  assert.equal((await req(path,Buffer.from('proof'),'POST',{...headers,'X-Task-Id':String(c2.tasks[0].id)})).status,404);
  const upload=await req(path,Buffer.from('验证通过'),'POST',{...headers,'X-Task-Id':String(c.tasks[0].id)});assert.equal(upload.status,201);const asset=await upload.json();
  assert.equal((await req(`/campaign-assets/${asset.id}/download`)).status,200);
  const row=db.prepare('SELECT * FROM security_campaign_assets WHERE id=?').get(asset.id);
  assert.ok(existsSync(join(directory,'integrations','campaign-assets',row.storage_key)));
  assert.equal((await json(`/campaigns/${c.id}/assets`)).assets[0].task_id,c.tasks[0].id);
  await json(`/campaign-assets/${asset.id}`,{},'DELETE');
  assert.equal((await req(`/campaign-assets/${asset.id}/download`)).status,404);
  assert.equal((await json(`/campaigns/${c.id}/assets`)).assets[0].deleted,1);
  assert.ok(!existsSync(join(directory,'integrations','campaign-assets',row.storage_key)));
  assert.ok((await json(`/campaigns/${c.id}`)).campaign.updates.some(u=>u.kind==='asset_deleted'));
});

test('跨专项子任务操作被拒，富文本不能引用事件附件，未来与非法日期被拒',async t=>{
  const {req,json}=await setup(t);
  const c=(await json('/campaigns',campaign({tasks:[task()],description_html:'<script>alert(1)</script><img src="/api/event-assets/1/download"><a href="/api/event-assets/1/download">不归属</a>'}))).campaign;
  assert.ok(!c.description_html.includes('event-assets'));assert.ok(!c.description_html.includes('<script'));
  const c2=(await json('/campaigns',campaign())).campaign;
  for(const suffix of ['', '/status','/updates'])assert.equal((await req(`/campaigns/${c2.id}/tasks/${c.tasks[0].id}${suffix}`,{version:1,status:'completed',reason:'越界',body:'越界'},suffix?'POST':'PUT')).status,404);
  assert.equal((await req('/campaigns',campaign({occurred_at:'2026-02-30T00:00:00'}))).status,400);
  assert.equal((await req('/campaigns',campaign({due_at:'invalid'}))).status,400);
});


test('统计按上海月半年季度切换，未来记录不计入，数据层阻止父子状态冲突',async t=>{
  const {json,db}=await setup(t);
  const c=(await json('/campaigns',campaign({occurred_at:'2026-09-30T15:59:59Z',tasks:[task()]}))).campaign;
  assert.equal((await json('/overview')).values.logs_month,0);assert.equal((await json('/overview')).values.risks_month,0);
  await json(`/campaigns/${c.id}`,{...c,occurred_at:'2026-09-30T16:00:00Z'},'PUT');
  assert.equal((await json('/overview')).values.logs_month,1);assert.equal((await json('/overview')).values.risks_month,1);
  assert.throws(()=>db.prepare("UPDATE security_campaigns SET status='completed' WHERE id=?").run(c.id),/tracking tasks/);
  db.prepare("UPDATE security_campaigns SET occurred_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(c.id);
  assert.equal((await json('/overview')).values.logs_all,0);assert.equal((await json('/overview')).values.risks_all,0);
});

test('V2 单值总负责人、结构化群体、统一内容检索与精简工作台',async t=>{
  const {req,json}=await setup(t);
  for(const lead_owner of ['', ['a@example.com'], '甲、乙'])assert.equal((await req('/campaigns',campaign({lead_owner}))).status,400);
  const {campaign:c}=await json('/campaigns',campaign({objective:undefined,reference_text:undefined,collaborators:['协同甲'],scope_details:[{type:'service',name:'支付服务',note:'所有生产实例'}],description_html:'<h3>CVE-2026-V2</h3><p>A&amp;B 组件排查</p>',tasks:[task()]}));
  assert.equal(c.lead_owner,'security.a@example.com');assert.deepEqual(c.collaborators,['协同甲']);assert.equal(c.objective,'');assert.equal(c.reference_text,'');assert.equal(c.scope_details[0].note,'所有生产实例');
  assert.equal((await json('/campaigns?search=CVE-2026-V2')).total,1);
  assert.equal((await json('/campaigns?search=A%26B')).total,1);
  const workspace=(await json(`/campaigns/${c.id}?workspace=true`)).campaign;
  assert.ok(!Object.hasOwn(workspace,'tasks'));assert.equal(workspace.task_summary.total,1);
  assert.ok(!Object.hasOwn((await json('/campaigns')).campaigns[0],'description_html'));
  assert.equal((await req(`/campaigns/${c.id}/tasks`,task({owner:'甲;乙'}))).status,400);
  assert.equal((await req(`/campaigns/${c.id}/tasks`,task({description_html:'<p><br></p>'}))).status,201);
});

test('V2 执行专项独立列表分页筛选、详情与富文本跟踪记录',async t=>{
  const {req,json}=await setup(t);
  const c=(await json('/campaigns',campaign({due_at:'2026-10-01T00:00:00+08:00',tasks:Array.from({length:23},(_,i)=>task({title:`执行${i}`,due_at:'2026-10-01T00:00:00+08:00',owner:i%2?'b@example.com':'a@example.com',collaborators_list:['c@example.com','d@example.com']}))}))).campaign;
  const base=`/campaigns/${c.id}/tasks`,first=c.tasks[0];
  const list=await json(base);assert.equal(list.total,23);assert.equal(list.tasks.length,20);assert.equal(list.overdue,23);assert.ok(!Object.hasOwn(list.tasks[0],'description_html'));
  assert.equal((await json(base+'?page=2')).tasks.length,3);assert.equal((await json(base+'?page=99')).page,2);
  assert.equal((await json(base+'?owner='+encodeURIComponent('a@example.com'))).total,12);
  assert.equal((await json(base+'?search='+encodeURIComponent('执行22'))).total,1);
  assert.equal((await json(base+'?overdue=true')).total,23);
  await json(`${base}/${first.id}/updates`,{version:first.version,campaign_version:c.version,body_html:'<p>已升级 <b>18/20</b> 台</p>'});
  const detail=await json(`${base}/${first.id}`);assert.deepEqual(detail.task.collaborators_list,['c@example.com','d@example.com']);assert.ok(detail.updates.some(u=>u.body_html.includes('<b>18/20</b>')));
  assert.ok((await json(base)).tasks[0].latest_update.includes('18/20'));
  assert.equal((await json(`${base}/${c.tasks[1].id}`)).updates.filter(u=>u.kind==='task_update').length,0);
  const other=(await json('/campaigns',campaign())).campaign;
  assert.equal((await req(`/campaigns/${other.id}/tasks/${first.id}`)).status,404);
});

test('V2 富文本证据隔离、版本保护、行内图片与删除引用同步',async t=>{
  const {req,json}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  const base=`/campaigns/${c.id}`,tid=c.tasks[0].id;
  let r=await req(base+'/assets',Buffer.from('evidence'),'POST',{'X-File-Name':'proof.txt','X-Campaign-Version':String(c.version),'X-Task-Id':String(tid),'X-Task-Version':String(c.tasks[0].version)});
  assert.equal(r.status,201);const a=await r.json();assert.equal(a.kind,'file');assert.equal(a.campaign_version,c.version+1);
  assert.equal((await req(base+'/assets',Buffer.from('stale'),'POST',{'X-File-Name':'proof.txt','X-Campaign-Version':String(c.version)})).status,409);
  c=(await json(base)).campaign;
  const html=`<p>验证证据 <a href="${a.url}">证据</a></p>`;
  assert.equal((await req(base,{...c,description_html:html},'PUT')).status,400);
  await json(`${base}/tasks/${tid}`,{...c.tasks[0],description_html:html},'PUT');
  c=(await json(base)).campaign;
  await json(`${base}/tasks/${tid}/updates`,{version:c.tasks[0].version,body_html:html});
  const c2=(await json('/campaigns',campaign())).campaign;
  assert.equal((await req(`/campaigns/${c2.id}/updates`,{body_html:html})).status,400);
  await json(`/campaign-assets/${a.id}`,{},'DELETE');
  const d=await json(`${base}/tasks/${tid}`);
  assert.ok(d.task.description_html.includes('已删除平台文件'));assert.ok(!d.task.description_html.includes(a.url));assert.ok(d.updates.some(u=>u.body_html.includes('已删除平台文件')));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
  const response=await req(base+'/assets',png,'POST',{'X-File-Name':'proof.png'});const image=await response.json();assert.equal(image.kind,'image');
  const download=await req(`/campaign-assets/${image.id}/download`);assert.equal(download.headers.get('content-disposition'),'inline');assert.equal(download.headers.get('content-type'),'image/png');
});

test('V2 历史迁移合并内容、保留旧字段与记录标识，可重复执行',async t=>{
  const {db,json}=await setup(t);
  const {migrateCampaignsV2,mergeCampaignContent,campaignPlainText}=await import('../server/campaign-migration.mjs');
  const c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  db.prepare("UPDATE security_campaigns SET security_owners=?,objective=?,description_html=?,reference_text=?,content_version=1 WHERE id=?").run(JSON.stringify(['a@example.com','b@example.com']),'目标 <script>原样文本</script>','<p>漏洞背景 A&amp;B</p><a href="https://example.com/CVE">公告</a>','CVE-2026-OLD',c.id);
  const before=db.prepare('SELECT code,status,version,created_at,updated_at FROM security_campaigns WHERE id=?').get(c.id);
  const updates=db.prepare('SELECT count(*) AS n FROM security_campaign_updates').get().n;
  migrateCampaignsV2(db);
  const row=db.prepare('SELECT * FROM security_campaigns WHERE id=?').get(c.id);
  assert.equal(row.lead_owner,'');assert.deepEqual(JSON.parse(row.collaborators_json),['a@example.com','b@example.com']);assert.equal(JSON.parse(row.scope_details)[0].type,'legacy');
  assert.ok(row.description_html.includes('&lt;script&gt;'));assert.ok(row.description_html.includes('https://example.com/CVE'));assert.ok(row.description_html.includes('CVE-2026-OLD'));assert.ok(row.search_text.includes('A&B'));assert.equal(row.reference_text,'CVE-2026-OLD');
  assert.deepEqual(db.prepare('SELECT code,status,version,created_at,updated_at FROM security_campaigns WHERE id=?').get(c.id),before);
  migrateCampaignsV2(db);assert.equal(db.prepare('SELECT description_html FROM security_campaigns WHERE id=?').get(c.id).description_html,row.description_html);
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaign_updates').get().n,updates);assert.equal((await json(`/campaigns/${c.id}`)).campaign.tasks[0].id,c.tasks[0].id);
  assert.equal(campaignPlainText(mergeCampaignContent('同一内容','<p>同一内容</p>','同一内容')),'同一内容');
});

test('V2 旧富文本被相同纯文本重复填写时优先保留格式版本',async t=>{
  const {db,json}=await setup(t);
  const {campaignPlainText,migrateCampaignsV2}=await import('../server/campaign-migration.mjs');
  const c=(await json('/campaigns',campaign())).campaign;
  db.prepare("UPDATE security_campaigns SET objective=?,description_html=?,reference_text=?,content_version=1 WHERE id=?").run('纯文本相同','<p><strong>纯文本相同</strong></p>','纯文本相同',c.id);
  migrateCampaignsV2(db);const row=db.prepare('SELECT description_html FROM security_campaigns WHERE id=?').get(c.id);
  assert.equal((row.description_html.match(/纯文本相同/g)||[]).length,1);assert.ok(row.description_html.includes('<strong>纯文本相同</strong>'));assert.equal(campaignPlainText(row.description_html),'纯文本相同');
});

test('V3 自动命名、类型待定、单一范围及多状态待办与主单原子创建',async t=>{
  const {json,req,db}=await setup(t);
  const body={lead_owner:'lead@example.com',target_scope:'支付业务线的全部服务',stage:'risks',importance:'P0',occurred_at:'2026-09-30T16:00:00Z',due_at:'2026-10-03T18:00:00+08:00',description_html:'<p>CVE-V3 背景与处置</p>',tasks:[{title:'组件修复',owner:'fix.b@example.com',status:'tracking',details_text:'第一行排查\n第二行修复 <script>保留文本</script>'},{title:'公网排查',owner:'check.c@example.com',status:'completed',details_text:'已完成核验\n未发现暴露实例'}]};
  const c=(await json('/campaigns',body)).campaign;
  assert.equal(c.title,'26-OCT-SPC-0001');assert.equal(c.title,c.code);assert.equal(c.type,'待定');assert.deepEqual(c.scopes,['支付业务线的全部服务']);assert.equal(c.tasks.length,2);assert.equal(c.tasks[0].owner,'fix.b@example.com');assert.equal(c.tasks[0].acceptance,'');assert.equal(c.tasks[0].scope,c.scopes[0]);assert.ok(c.tasks[0].description_html.includes('<br>'));assert.ok(c.tasks[0].description_html.includes('&lt;script&gt;'));assert.equal(c.tasks[1].status,'completed');assert.ok(c.tasks[1].conclusion.includes('未发现暴露实例'));assert.ok(c.tasks[1].completed_at);assert.equal(c.status,'tracking');assert.equal(c.task_summary.completed,1);
  const list=await json(`/campaigns/${c.id}/tasks`);assert.ok(list.tasks[0].details_summary.includes('第一行排查'));
  const stats=(await json('/overview')).values;assert.equal(stats.risks_all,1);assert.equal(stats.incidents_all,1);assert.equal(stats.logs_all,1);assert.equal(stats.redline_p0_all,0);
  for(const change of [{target_scope:''},{due_at:''},{tasks:[body.tasks[0],{...body.tasks[1],owner:''}]},{tasks:[{...body.tasks[0],status:'other'}]}])assert.equal((await req('/campaigns',{...body,...change})).status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaigns').get().n,1);
  const next=(await json('/campaigns',{...body,title:'不允许自定义标题',tasks:[]})).campaign;assert.equal(next.title,'26-OCT-SPC-0002');
});

test('V3 简化编辑保留旧名称、协同、范围备注、验收标准和富文本附件',async t=>{
  const {json,req,db}=await setup(t);
  let c=(await json('/campaigns',campaign({collaborators:['历史协同'],tasks:[task()]}))).campaign;
  db.prepare('UPDATE security_campaigns SET title=? WHERE id=?').run('历史自定义名称',c.id);
  c=(await json(`/campaigns/${c.id}`)).campaign;
  const {collaborators,...rest}=c;
  c=(await json(`/campaigns/${c.id}`,{...rest,title:'恶意改名',due_at:'2026-10-30T00:00:00+08:00'},'PUT')).campaign;
  assert.equal(c.title,'历史自定义名称');assert.deepEqual(c.collaborators,['历史协同']);
  assert.equal((await req(`/campaigns/${c.id}`,{...c,due_at:''},'PUT')).status,400);
  const updated=(await json(`/campaigns/${c.id}/tasks/${c.tasks[0].id}`,{title:'修复待办',owner:'new.owner@example.com',version:c.tasks[0].version,details_text:'排查完成\n等待验证'},'PUT')).task;
  assert.equal(updated.acceptance,c.tasks[0].acceptance);assert.equal(updated.collaborators,c.tasks[0].collaborators);assert.deepEqual(updated.collaborators_list,c.tasks[0].collaborators_list);assert.ok(updated.description_html.includes('<br>'));
});

test('V3 独立待办简化编辑可保留证据链接并且已完结操作保持约束',async t=>{
  const {json,req}=await setup(t);
  let c=(await json('/campaigns',{lead_owner:'a@example.com',target_scope:'全公司',stage:'risks',importance:'P1',occurred_at:'2026-10-01T00:00:00+08:00',due_at:'2026-11-01T18:00:00+08:00',tasks:[{title:'修复',owner:'b@example.com',details_text:'核查\n修复'}]})).campaign;
  const path=`/campaigns/${c.id}/tasks/${c.tasks[0].id}`;
  const r=await req(`/campaigns/${c.id}/assets`,Buffer.from('evidence'),'POST',{'X-File-Name':'proof.txt','X-Task-Id':String(c.tasks[0].id)});const asset=await r.json();assert.equal(r.status,201);
  let detail=await json(path);
  detail=await json(path,{title:detail.task.title,owner:detail.task.owner,version:detail.task.version,description_html:`<p>证据 <a href="${asset.url}">验证文件</a></p>`},'PUT');
  detail=await json(path,{title:'重命名待办',owner:'c@example.com',version:detail.task.version,description_html:detail.task.description_html},'PUT');assert.ok(detail.task.description_html.includes(asset.url));
  c=(await json(path+'/status',{version:detail.task.version,status:'completed',reason:'核验完成'})).campaign;
  assert.equal((await req(path,{title:'禁止修改',owner:'b@example.com',version:c.tasks[0].version,details_text:'不能改'},'PUT')).status,409);
  c=(await json(`/campaigns/${c.id}/status`,{version:c.version,status:'completed',reason:'全部核验'})).campaign;
  assert.equal((await req(path+'/status',{version:c.tasks[0].version,campaign_version:c.version-1,status:'tracking',reason:'复测',reopen_campaign:true})).status,409);
  c=(await json(path+'/status',{version:c.tasks[0].version,campaign_version:c.version,status:'tracking',reason:'复测',reopen_campaign:true})).campaign;
  assert.equal(c.status,'tracking');assert.equal(c.tasks[0].status,'tracking');
});

test('V4 无层级或旧风险请求均创建为事件；历史风险迁移幂等且保留原层级',async t=>{
  const {json,db}=await setup(t);
  const {migrateCampaignsV2}=await import('../server/campaign-migration.mjs');
  let c=(await json('/campaigns',campaign({stage:undefined}))).campaign;
  assert.equal(c.stage,'incidents');
  c=(await json(`/campaigns/${c.id}`,{...c,stage:'risks'},'PUT')).campaign;
  assert.equal(c.stage,'incidents');
  db.prepare("UPDATE security_campaigns SET stage='risks',legacy_stage=NULL WHERE id=?").run(c.id);
  const before=db.prepare('SELECT code,version,status,description_html,occurred_at FROM security_campaigns WHERE id=?').get(c.id);
  migrateCampaignsV2(db);migrateCampaignsV2(db);
  const row=db.prepare('SELECT * FROM security_campaigns WHERE id=?').get(c.id);
  assert.equal(row.stage,'incidents');assert.equal(row.legacy_stage,'risks');
  assert.deepEqual(db.prepare('SELECT code,version,status,description_html,occurred_at FROM security_campaigns WHERE id=?').get(c.id),before);
  const values=(await json('/overview')).values;assert.equal(values.risks_all,1);assert.equal(values.incidents_all,1);
});

test('V4 父子直接完结无需结论，阻止未完成主单且已完结子任务可删除',async t=>{
  const {json,req,db}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  const path=`/campaigns/${c.id}`,tp=`${path}/tasks/${c.tasks[0].id}`;
  assert.equal((await req(path+'/status',{version:c.version,status:'completed'})).status,409);
  c=(await json(tp+'/status',{version:c.tasks[0].version,status:'completed'})).campaign;
  assert.ok(c.tasks[0].completed_at);assert.ok(c.tasks[0].completed_by);
  c=(await json(path+'/status',{version:c.version,status:'completed'})).campaign;
  assert.ok(c.completed_at);assert.equal(c.status,'completed');assert.ok(c.updates.some(u=>u.kind==='completed'));
  const snapshot=(await json('/overview')).values;
  await json(tp,{version:c.tasks[0].version},'DELETE');
  assert.equal((await req(tp)).status,404);
  c=(await json(path)).campaign;assert.equal(c.task_summary.total,0);assert.equal(c.status,'completed');
  assert.deepEqual((await json('/overview')).values,snapshot);
  assert.equal(db.prepare('SELECT removed FROM security_campaign_tasks WHERE id=?').get(Number(tp.split('/').at(-1))).removed,1);
});

test('V4 删除主单解除引用、排除统计、拒绝所有读写且保留证据审计与冻结快照',async t=>{
  const {json,req,db,directory}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task()]}))).campaign;
  const path=`/campaigns/${c.id}`,tp=`${path}/tasks/${c.tasks[0].id}`;
  const e=(await json('/events',report({campaign_links:[{campaign_id:c.id,relation:'related',confidence:'pending',note:'相关'}]}))).event;
  const asset=await (await req(path+'/assets',Buffer.from('evidence'),'POST',{'X-File-Name':'proof.txt'})).json();
  c=(await json(path)).campaign;
  const snapshot=await json('/snapshots',{}),sid=snapshot.snapshot?.id||snapshot.id;
  const frozen=db.prepare('SELECT values_json FROM snapshots WHERE id=?').get(sid).values_json;
  assert.equal((await req(path,{},'DELETE')).status,409);
  assert.equal((await req(path,{version:c.version-1},'DELETE')).status,409);
  await json(path,{version:c.version},'DELETE');
  assert.equal((await json('/campaigns')).total,0);
  assert.equal((await json('/events/campaign-options')).campaigns.length,0);
  assert.equal((await json(`/events/${e.id}/campaigns`)).campaigns.length,0);
  assert.equal((await json('/events')).total,1);
  const values=(await json('/overview')).values;assert.equal(values.risks_all,1);assert.equal(values.incidents_all,1);
  assert.equal(db.prepare('SELECT values_json FROM snapshots WHERE id=?').get(sid).values_json,frozen);
  for(const suffix of ['', '/tasks',`/tasks/${c.tasks[0].id}`,'/assets','/updates'])assert.equal((await req(path+suffix)).status,404,suffix);
  for(const [url,body,method] of [[path,{version:c.version},'DELETE'],[path,c,'PUT'],[path+'/tasks',task(),'POST'],[path+'/status',{version:c.version,status:'completed'},'POST'],[tp+'/updates',{body:'test'},'POST'],[tp+'/status',{version:1,status:'completed'},'POST'],[tp,{version:1},'DELETE'],[path+'/updates',{body:'test'},'POST']])assert.equal((await req(url,body,method)).status,404,url);
  assert.equal((await req(`/campaign-assets/${asset.id}/download`)).status,404);
  assert.equal((await req(`/campaign-assets/${asset.id}`,{},'DELETE')).status,404);
  assert.equal((await req('/events',report({campaign_links:[{campaign_id:c.id,relation:'related',confidence:'pending',note:''}]}))).status,404);
  assert.equal((await json('/events')).total,1);
  const row=db.prepare('SELECT * FROM security_campaigns WHERE id=?').get(c.id);assert.equal(row.deleted,1);assert.ok(row.deleted_at);assert.ok(row.deleted_by);
  assert.ok(db.prepare("SELECT body FROM security_campaign_updates WHERE campaign_id=? AND kind='deleted'").get(c.id).body.includes('解除引用'));
  const stored=db.prepare('SELECT storage_key FROM security_campaign_assets WHERE id=?').get(asset.id);
  assert.ok(existsSync(join(directory,'integrations','campaign-assets',stored.storage_key)));
  const next=(await json('/campaigns',campaign())).campaign;assert.ok(next.code.endsWith('0002'));assert.notEqual(next.id,c.id);
});

test('V4 子任务删除隐藏对应证据且不影响其他子任务，完结主单也可删除',async t=>{
  const {json,req,db}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task(),task({title:'另一项'})]}))).campaign;
  const path=`/campaigns/${c.id}`,tp=`${path}/tasks/${c.tasks[0].id}`;
  const asset=await (await req(path+'/assets',Buffer.from('proof'),'POST',{'X-File-Name':'proof.txt','X-Task-Id':String(c.tasks[0].id)})).json();
  c=(await json(path)).campaign;
  assert.equal((await req(tp,{version:c.tasks[0].version-1},'DELETE')).status,409);
  await json(tp,{version:c.tasks[0].version},'DELETE');
  assert.equal((await json(path+'/assets')).assets.length,0);assert.equal((await req(`/campaign-assets/${asset.id}/download`)).status,404);
  c=(await json(path)).campaign;assert.equal(c.tasks.length,1);
  c=(await json(`${path}/tasks/${c.tasks[0].id}/status`,{version:c.tasks[0].version,status:'completed'})).campaign;
  c=(await json(path+'/status',{version:c.version,status:'completed'})).campaign;
  await json(path,{version:c.version},'DELETE');assert.equal((await json('/overview')).values.incidents_all,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaign_tasks').get().n,2);
});

test('专项类型默认三项、新增与去重校验、选择保存、重命名同步及版本审计',async t=>{
  const {json,req,db,base}=await setup(t);
  const defaults=(await json('/campaigns/options')).types;
  assert.deepEqual(defaults.map(t=>t.name),['漏洞修复','入侵应急','监管检查']);
  assert.equal((await fetch(base+'/api/campaign-types',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'越权'})})).status,401);
  for(const name of ['', '  ', 'x'.repeat(41), '待定', null, 123])assert.equal((await req('/campaign-types',{name})).status,400);
  assert.equal((await req('/campaign-types',{name:' 漏洞修复 '})).status,409);
  const created=await json('/campaign-types',{name:'  专项排查  '});assert.equal(created.type.name,'专项排查');
  const label=created.type;
  assert.equal((await json('/campaigns/options')).types.length,4);
  let c=(await json('/campaigns',campaign({type_id:label.id,type:label.name}))).campaign;
  assert.equal(c.type_id,label.id);assert.equal(c.type,label.name);
  const before=(await json('/overview')).values;
  c=(await json(`/campaigns/${c.id}/status`,{version:c.version,status:'completed'})).campaign;
  const old=c;
  const renamed=await json(`/campaign-types/${label.id}`,{name:'全量排查',version:label.version},'PUT');
  assert.equal(renamed.type.id,label.id);assert.equal(renamed.type.version,2);
  assert.deepEqual(renamed.campaign_versions,[{id:c.id,before:c.version,after:c.version+1}]);
  c=(await json(`/campaigns/${c.id}`)).campaign;
  assert.equal(c.type,'全量排查');assert.equal(c.type_id,label.id);assert.equal(c.version,old.version+1);assert.equal(c.status,'completed');
  assert.ok(c.updates.some(u=>u.kind==='type_renamed'&&u.body.includes('专项排查 → 全量排查')));
  assert.deepEqual((await json('/overview')).values,before);
  assert.equal((await req(`/campaigns/${c.id}/status`,{version:old.version,status:'tracking',reason:'旧版重开'})).status,409);
  assert.equal((await req(`/campaign-types/${label.id}`,{name:'过期覆盖',version:1},'PUT')).status,409);
  assert.equal((await req(`/campaign-types/${label.id}`,{name:'漏洞修复',version:2},'PUT')).status,409);
  assert.equal((await req('/campaigns',campaign({type_id:label.id,type:'专项排查'}))).status,409);
  assert.equal((await req('/campaigns',campaign({type_id:99999}))).status,409);
  const next=(await json('/campaigns',campaign({type_id:label.id,type:'全量排查'}))).campaign;
  assert.equal(next.type,'全量排查');
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaign_type_updates WHERE type_id=?').get(label.id).n,2);
});

test('专项类型旧客户端新增原子回滚，改名默认标签后重启不会重新生成旧名',async t=>{
  const {json,req,db,platform}=await setup(t);
  const {createCampaignTypes}=await import('../server/campaign-types.mjs');
  const old=(await json('/campaigns',campaign({type:'历史类型'}))).campaign;
  const labels=(await json('/campaigns/options')).types;
  assert.ok(labels.some(t=>t.name==='历史类型'&&t.id===old.type_id));
  assert.equal((await req('/campaigns',campaign({type:'不应保存的类型',events:[{event_id:99999,relation:'related'}]}))).status,404);
  assert.ok(!(await json('/campaigns/options')).types.some(t=>t.name==='不应保存的类型'));
  const defaultLabel=labels[0];await json(`/campaign-types/${defaultLabel.id}`,{name:'漏洞治理',version:1},'PUT');
  // Re-run module initialization to exercise the same persisted-schema path as restart.
  const before=db.prepare('SELECT * FROM security_campaigns ORDER BY id').all();
  const types=createCampaignTypes({app:platform.app,db,reject:message=>{throw Error(message);},updateCampaign:()=>{}});
  assert.equal(types.list()[0].name,'漏洞治理');assert.ok(!types.list().some(t=>t.name==='漏洞修复'));
  assert.deepEqual(db.prepare('SELECT * FROM security_campaigns ORDER BY id').all(),before);
  let c=(await json(`/campaigns/${old.id}`,{...old,type_id:labels[1].id,type:labels[1].name},'PUT')).campaign;
  assert.equal(c.type,labels[1].name);
  c=(await json(`/campaigns/${old.id}`,{...c,type_id:null,type:'待定'},'PUT')).campaign;
  assert.equal(c.type_id,null);assert.equal(c.type,'待定');
});

test('紧凑任务表优先级默认中、多行创建校验及失败原子回滚',async t=>{
  const {json,req,db}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task(),task({priority:'high'}),task({priority:'low'})]}))).campaign;
  assert.deepEqual(c.tasks.map(t=>t.priority),['medium','high','low']);
  assert.deepEqual((await json(`/campaigns/${c.id}/tasks`)).tasks.map(t=>t.priority).sort(),['high','low','medium']);
  const count=db.prepare('SELECT count(*) AS n FROM security_campaigns').get().n;
  for(const priority of ['P0','urgent','',null,0])assert.equal((await req('/campaigns',campaign({tasks:[task(),task({priority})]}))).status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaigns').get().n,count);
  const {migrateCampaignsV2}=await import('../server/campaign-migration.mjs');
  migrateCampaignsV2(db);assert.deepEqual((await json(`/campaigns/${c.id}`)).campaign.tasks.map(t=>t.priority),['medium','high','low']);
});

test('行内编辑仅更新任务表字段，保留富文本附件、状态、范围与完成标准，防跨专项/冲突',async t=>{
  const {json,req,db}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task({description_html:'<p><strong>格式保留</strong></p>'})]}))).campaign;
  const path=`/campaigns/${c.id}/tasks/${c.tasks[0].id}`,initial=c.tasks[0];
  const asset=await(await req(`/campaigns/${c.id}/assets`,Buffer.from('proof'),'POST',{'X-File-Name':'proof.txt','X-Task-Id':String(initial.id)})).json();
  let row=(await json(path)).task;
  row=(await json(path,{...row,description_html:`<p><strong>格式保留</strong><a href="${asset.url}">证据</a></p>`},'PUT')).task;
  const values=(await json('/overview')).values;
  const patch={title:'组件核查',owner:'fix.c@example.com',priority:'high',version:row.version};
  for(const priority of [undefined,'P1',null])assert.equal((await req(path,{...patch,priority},'PATCH')).status,400);
  const result=(await json(path,patch,'PATCH')).task;
  for(const key of ['description_html','scope','acceptance','due_at','status','conclusion','code','collaborators_json'])assert.equal(result[key],row[key],key);
  assert.equal(result.priority,'high');assert.equal(result.owner,'fix.c@example.com');assert.equal(result.title,'组件核查');
  assert.equal((await req(path,patch,'PATCH')).status,409);
  assert.equal((await req(path,{...patch,version:result.version,owner:'甲，乙'},'PATCH')).status,400);
  const other=(await json('/campaigns',campaign())).campaign;
  assert.equal((await req(`/campaigns/${other.id}/tasks/${result.id}`,{...patch,version:result.version},'PATCH')).status,404);
  const undoPriority=(await json(path,{...result,priority:undefined},'PUT')).task;assert.equal(undoPriority.priority,'high');
  const updated=(await json(`/campaigns/${c.id}`)).campaign;
  assert.ok(updated.updates.some(u=>u.kind==='task_edited'&&u.body.includes('high')));
  await json(path+'/status',{version:undoPriority.version,status:'completed'});
  assert.equal((await req(path,{...patch,version:undoPriority.version+1},'PATCH')).status,409);
  assert.equal((await req(`/campaign-assets/${asset.id}/download`)).status,200);
  // The second campaign changes counts; edits and child status do not.
  const after=(await json('/overview')).values;
  assert.equal(after.risks_all,values.risks_all+1);assert.equal(after.incidents_all,values.incidents_all+1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM security_campaign_assets').get().n,1);
});

test('删除标签原子清除专项分类、保留记录统计与审计，校验版本与引用数量',async t=>{
  const {json,req,db,base}=await setup(t);
  const label=(await json('/campaigns/options')).types[0];
  let c=(await json('/campaigns',campaign({type_id:label.id,type:label.name,tasks:[task()]}))).campaign;
  c=(await json(`/campaigns/${c.id}/tasks/${c.tasks[0].id}/status`,{version:c.tasks[0].version,status:'completed'})).campaign;
  c=(await json(`/campaigns/${c.id}/status`,{version:c.version,status:'completed'})).campaign;
  const before=(await json('/overview')).values,old=c;
  assert.equal((await fetch(base+`/api/campaign-types/${label.id}`,{method:'DELETE'})).status,401);
  assert.equal((await req(`/campaign-types/${label.id}`,{version:label.version},'DELETE')).status,409);
  assert.equal((await req(`/campaign-types/${label.id}`,{version:99,usage_count:1},'DELETE')).status,409);
  assert.equal((await req(`/campaign-types/${label.id}`,{version:label.version,usage_count:0},'DELETE')).status,409);
  assert.equal((await json(`/campaigns/${c.id}`)).campaign.type_id,label.id);
  const result=await json(`/campaign-types/${label.id}`,{version:label.version,usage_count:1},'DELETE');
  assert.equal(result.affected,1);assert.deepEqual(result.campaign_versions,[{id:c.id,before:c.version,after:c.version+1}]);
  c=(await json(`/campaigns/${c.id}`)).campaign;
  assert.equal(c.type,'待定');assert.equal(c.type_id,null);assert.equal(c.status,'completed');assert.equal(c.tasks[0].id,old.tasks[0].id);
  assert.ok(c.updates.some(u=>u.kind==='type_deleted'&&u.body.includes(label.name)));
  assert.deepEqual((await json('/overview')).values,before);
  assert.ok(!(await json('/campaigns/options')).types.some(t=>t.id===label.id));
  assert.equal((await req(`/campaign-types/${label.id}`,{version:1,usage_count:0},'DELETE')).status,404);
  assert.equal((await req(`/campaign-types/${label.id}`,{version:1,name:'改名'},'PUT')).status,404);
  assert.equal((await req('/campaigns',campaign({type_id:label.id,type:label.name}))).status,409);
  assert.equal((await req('/campaigns',campaign({type:label.name}))).status,409);
  assert.equal(db.prepare('SELECT deleted FROM security_campaign_types WHERE id=?').get(label.id).deleted,1);
  assert.equal(db.prepare('SELECT new_name FROM security_campaign_type_updates WHERE type_id=? ORDER BY id DESC').get(label.id).new_name,'[已删除]');
});

test('未使用标签删除及默认标签重启不复活；显式新增同名标签可用且不恢复旧专项分类',async t=>{
  const {json,req,db,platform}=await setup(t);
  const {createCampaignTypes}=await import('../server/campaign-types.mjs');
  const unused=(await json('/campaigns/options')).types[1];
  await json(`/campaign-types/${unused.id}`,{version:unused.version,usage_count:0},'DELETE');
  const label=(await json('/campaign-types',{name:'排查类型'})).type;
  let c=(await json('/campaigns',campaign({type_id:label.id,type:label.name}))).campaign;
  await json(`/campaign-types/${label.id}`,{version:label.version,usage_count:1},'DELETE');
  const module=createCampaignTypes({app:platform.app,db,reject:m=>{throw Error(m);},updateCampaign:()=>{}});
  assert.ok(!module.list().some(t=>t.name===unused.name||t.name===label.name));
  const revived=(await json('/campaign-types',{name:label.name})).type;
  assert.equal(revived.id,label.id);assert.equal(revived.version,3);
  c=(await json(`/campaigns/${c.id}`)).campaign;assert.equal(c.type_id,null);assert.equal(c.type,'待定');
  const next=(await json('/campaigns',campaign({type_id:revived.id,type:revived.name}))).campaign;
  assert.equal(next.type_id,revived.id);
  assert.equal((await req(`/campaign-types/${revived.id}`,{version:1,usage_count:1},'DELETE')).status,409);
});

test('主专项开始结束构成完整区间，拒绝倒置；编辑主单不改变子待办独立日期',async t=>{
  const {req,json,db}=await setup(t);
  for(const due_at of [undefined,null,'','invalid','2026-02-30T18:00:00','2026-09-01T18:00:00+08:00'])assert.equal((await req('/campaigns',campaign({due_at}))).status,400);
  let c=(await json('/campaigns',campaign({tasks:[task({due_at:null}),task({due_at:'2026-11-02T18:00:00+08:00'})]}))).campaign;
  const original=c.occurred_at,code=c.code,childDates=c.tasks.map(t=>t.due_at);
  for(const due_at of [null,'','2026-01-01T18:00:00+08:00'])assert.equal((await req(`/campaigns/${c.id}`,{...c,due_at},'PUT')).status,400);
  c=(await json(`/campaigns/${c.id}`,{...c,occurred_at:'2026-10-02T10:00:00+08:00',due_at:'2026-11-01T18:00:00+08:00'},'PUT')).campaign;
  assert.notEqual(c.occurred_at,original);assert.equal(c.code,code);assert.deepEqual(c.tasks.map(t=>t.due_at),childDates);
  db.prepare('UPDATE security_campaigns SET due_at=NULL WHERE id=?').run(c.id);
  assert.equal((await json(`/campaigns/${c.id}`)).campaign.due_at,null);
  c=(await json(`/campaigns/${c.id}`,{...c,due_at:'2026-11-01T18:00:00+08:00'},'PUT')).campaign;
  assert.ok(c.due_at);
});

test('空待办明细可创建、修改、初始完结及无原因重开，保留父子联动保护和操作历史',async t=>{
  const {req,json}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[{title:'排查',owner:'a@example.com',details_text:''},{title:'验证',owner:'b@example.com',status:'completed',details_text:'   '}]}))).campaign;
  const path=`/campaigns/${c.id}`,tp=`${path}/tasks/${c.tasks[0].id}`;
  assert.equal(c.tasks[1].status,'completed');assert.equal(c.tasks[1].conclusion,'完结待办事件');
  let item=(await json(tp,{title:'排查',owner:'a@example.com',details_text:'',version:c.tasks[0].version},'PUT')).task;
  assert.equal(item.description_html,'<p></p>');
  c=(await json(tp+'/status',{version:item.version,status:'completed'})).campaign;
  c=(await json(path+'/status',{version:c.version,status:'completed'})).campaign;
  assert.equal((await req(tp+'/status',{version:c.tasks[0].version,status:'tracking'})).status,409);
  c=(await json(tp+'/status',{version:c.tasks[0].version,campaign_version:c.version,status:'tracking',reopen_campaign:true})).campaign;
  assert.equal(c.status,'tracking');assert.equal(c.tasks[0].status,'tracking');
  item=(await json(tp,{title:'再次排查',owner:'a@example.com',details_text:'',version:c.tasks[0].version},'PUT')).task;
  c=(await json(tp+'/status',{version:item.version,status:'completed'})).campaign;
  c=(await json(path+'/status',{version:c.version,status:'completed'})).campaign;
  c=(await json(path+'/status',{version:c.version,status:'tracking'})).campaign;
  assert.ok(c.updates.some(u=>u.kind==='reopened'&&u.body==='重新打开专项事件'));
  c=(await json(path+'/status',{version:c.version,status:'completed'})).campaign;
  assert.equal((await req(path+'/tasks',{title:'新增',owner:'c@example.com',details_text:'',reopen_campaign:true,campaign_version:c.version})).status,201);
  c=(await json(path)).campaign;assert.equal(c.status,'tracking');assert.equal(c.tasks.length,3);
  const rich=(await json(path+'/tasks',{title:'富文本空明细',owner:'d@example.com',description_html:''})).task;
  assert.equal(rich.description_html,'');
  assert.equal((await req(path+'/tasks',{title:'超长',owner:'d@example.com',details_text:'x'.repeat(10001)})).status,400);
  const overview=await json('/overview');
  for(const period of PERIODS)for(const layer of ['logs','risks','incidents'])assert.equal(overview.values[`${layer}_${period.key}`],overview.campaign_values[layer][period.key]);
});

test('子待办截止日期独立选填、可清空，行内修改及主单编辑互不覆盖，逾期筛选仅计已填日期',async t=>{
  const {json,req}=await setup(t);
  let c=(await json('/campaigns',campaign({tasks:[task({due_at:undefined}),task({due_at:''}),task({due_at:'2026-01-01T18:00:00+08:00'})]}))).campaign;
  const path=`/campaigns/${c.id}`,tp=`${path}/tasks/${c.tasks[0].id}`;
  assert.equal(c.tasks[0].due_at,null);assert.equal(c.tasks[1].due_at,null);
  assert.equal((await json(path+'/tasks?overdue=true')).total,1);
  let item=(await json(tp,{title:c.tasks[0].title,owner:c.tasks[0].owner,priority:'medium',version:c.tasks[0].version,due_at:'2026-02-01T18:00:00+08:00'},'PATCH')).task;
  assert.equal(item.due_at,'2026-02-01T10:00:00.000Z');
  const original=item;
  assert.equal((await req(tp,{...item,due_at:'2026-02-30T18:00:00'},'PATCH')).status,400);
  item=(await json(tp,{title:item.title,owner:item.owner,priority:'high',version:item.version},'PATCH')).task;
  assert.equal(item.due_at,original.due_at);
  c=(await json(path)).campaign;
  c=(await json(path,{...c,due_at:'2026-12-01T18:00:00+08:00'},'PUT')).campaign;
  assert.equal(c.tasks[0].due_at,item.due_at);assert.equal(c.tasks[1].due_at,null);
  item=(await json(tp,{...item,due_at:''},'PUT')).task;assert.equal(item.due_at,null);
  item=(await json(tp,{...item,due_at:'2026-03-01T18:00:00+08:00'},'PUT')).task;
  item=(await json(tp,{...item,due_at:null},'PATCH')).task;assert.equal(item.due_at,null);
  assert.equal((await json(path+'/tasks?overdue=true')).total,1);
  const extra=(await json(path+'/tasks',{title:'单独新增',owner:'todo@example.com',details_text:''})).task;
  assert.equal(extra.due_at,null);
});

test('专项与子待办校验单个负责人，创建编辑和行内编辑一致，支持长邮箱',async t=>{
  const {json,req}=await setup(t);
  for(const value of ['姓名','missing-at','a@@example.com','a@example..com','a@example.com,b@example.com','a @example.com','a..b@example.com']){
    assert.equal((await req('/campaigns',campaign({lead_owner:value}))).status,400,value);
    assert.equal((await req('/campaigns',campaign({tasks:[task({owner:value})]}))).status,400,value);
  }
  const email=`${'a'.repeat(50)}@${'b'.repeat(50)}.example.com`;
  let c=(await json('/campaigns',campaign({lead_owner:email,tasks:[task({owner:email})]}))).campaign;
  assert.equal(c.lead_owner,email);assert.equal(c.tasks[0].owner,email);
  const path=`/campaigns/${c.id}`,tp=`${path}/tasks/${c.tasks[0].id}`;
  assert.equal((await req(path,{...c,lead_owner:'姓名'},'PUT')).status,400);
  assert.equal((await req(tp,{...c.tasks[0],owner:'姓名'},'PUT')).status,400);
  assert.equal((await req(tp,{...c.tasks[0],owner:'姓名'},'PATCH')).status,400);
  const item=(await json(tp,{...c.tasks[0],owner:'  new+ops@example.com  '},'PATCH')).task;
  assert.equal(item.owner,'new+ops@example.com');
});
