import { cleanRichText, escapeHTML } from './content.mjs';
import { migrateCampaignsV2, campaignPlainText } from './campaign-migration.mjs';
import { FormError, parseDiscoveryTime } from './report.mjs';
import { createCampaignAssets } from './campaign-assets.mjs';
import { createCampaignTypes } from './campaign-types.mjs';
import { PERIODS, periodStarts } from '../shared/model.mjs';
import { isOwnerIdentifier } from '../shared/owners.mjs';

const reject = (message, status = 400) => { const error = new FormError(message); error.status = status; throw error; };
const requiredText = (value, label, limit = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) reject(`${label}必填且不能超过 ${limit} 字。`);
  return value.trim();
};
const optionalText = (value, label, limit = 500) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > limit) reject(`${label}不能超过 ${limit} 字。`);
  return value.trim();
};
const cleanArray = (value, label, max = 20) => {
  if (!Array.isArray(value) || value.length > max) reject(`${label}格式无效或数量过多。`);
  const result = [...new Set(value.map(item => requiredText(item, label, 100)))];
  if (!result.length) reject(`请至少填写一项${label}。`);
  return result;
};
const singleOwner = (value, label) => {
  const name = requiredText(value, label, 254);
  if (/[\n,，、;；]/.test(name)) reject(`${label}只能填写一人，请只保留一名负责人。`);
  if (!isOwnerIdentifier(name)) reject(`${label}请填写有效账号或邮箱。`);
  return name;
};
const validDate = value => value ? parseDiscoveryTime(value) : null;
const taskPriority = value => {
  if(!['high','medium','low'].includes(value))reject('子任务优先级仅支持高、中、低。');
  return value;
};
const requiredDeadline = value => {
  if (!value) reject('请选择截止日期。');
  return parseDiscoveryTime(value);
};
const validatePeriod = (start, end) => {
  if (Date.parse(end) < Date.parse(start)) reject('计划完成时间不能早于发现时间。');
};
const cleanRich = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * 1024 * 1024) reject('详细内容必须是文本且不超过 2 MB。');
  return cleanRichText(value, { campaignAssets: true }).replace(/<a\b[^>]*href="\/api\/(?!campaign-assets\/)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1');
};
const now = () => new Date().toISOString();
const json = value => { try { return JSON.parse(value); } catch { return []; } };
const codePart = value => { const local = new Date(value.getTime() + 8 * 3600000); return `${String(local.getUTCFullYear()).slice(-2)}-${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][local.getUTCMonth()]}`; };
const importanceRank = "CASE importance WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END";

export function createCampaignModule({ app, db, dataDirectory }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_campaigns (
      id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('risks','incidents')),
      importance TEXT NOT NULL CHECK(importance IN ('P0','P1','P2','P3','P4')),
      security_owners TEXT NOT NULL, scopes TEXT NOT NULL, occurred_at TEXT NOT NULL, due_at TEXT,
      objective TEXT NOT NULL, description_html TEXT NOT NULL, reference_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'tracking' CHECK(status IN ('tracking','completed')),
      conclusion TEXT, completed_at TEXT, completed_by TEXT, next_task_seq INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS campaigns_occurred ON security_campaigns(occurred_at);
    CREATE TABLE IF NOT EXISTS security_campaign_tasks (
      id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES security_campaigns(id),
      code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, owner TEXT NOT NULL, collaborators TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL, description_html TEXT NOT NULL, acceptance TEXT NOT NULL, due_at TEXT,
      status TEXT NOT NULL DEFAULT 'tracking' CHECK(status IN ('tracking','completed')),
      conclusion TEXT, completed_at TEXT, completed_by TEXT, removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS campaign_tasks_parent ON security_campaign_tasks(campaign_id,removed);
    CREATE TABLE IF NOT EXISTS security_campaign_updates (
      id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES security_campaigns(id),
      task_id INTEGER REFERENCES security_campaign_tasks(id), user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS campaign_updates_parent ON security_campaign_updates(campaign_id,id);
    CREATE TABLE IF NOT EXISTS security_campaign_event_links (
      id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES security_campaigns(id),
      event_id INTEGER NOT NULL REFERENCES records(id), relation TEXT NOT NULL CHECK(relation IN ('risk_source','post_incident','related')),
      confidence TEXT NOT NULL CHECK(confidence IN ('pending','confirmed','not_confirmed')),
      note TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
      UNIQUE(campaign_id,event_id)
    );
    CREATE INDEX IF NOT EXISTS campaign_links_event ON security_campaign_event_links(event_id);
    CREATE TRIGGER IF NOT EXISTS campaign_close_guard BEFORE UPDATE OF status ON security_campaigns
    WHEN NEW.status='completed' AND EXISTS(SELECT 1 FROM security_campaign_tasks WHERE campaign_id=NEW.id AND removed=0 AND status='tracking')
    BEGIN SELECT RAISE(ABORT,'Campaign has tracking tasks'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_task_insert_guard BEFORE INSERT ON security_campaign_tasks
    WHEN NEW.removed=0 AND NEW.status='tracking' AND (SELECT status FROM security_campaigns WHERE id=NEW.campaign_id)='completed'
    BEGIN SELECT RAISE(ABORT,'Reopen parent campaign first'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_task_reopen_guard BEFORE UPDATE OF status,removed ON security_campaign_tasks
    WHEN NEW.removed=0 AND NEW.status='tracking' AND (SELECT status FROM security_campaigns WHERE id=NEW.campaign_id)='completed'
    BEGIN SELECT RAISE(ABORT,'Reopen parent campaign first'); END;
  `);

  migrateCampaignsV2(db);

  const appendUpdate = db.prepare(`INSERT INTO security_campaign_updates (campaign_id,task_id,user_id,kind,body,created_at)
    VALUES (?,?,?,?,?,?)`);
  const updateCampaign = (id, userId, kind, body, taskId = null) => appendUpdate.run(id, taskId, userId, kind, body, now());
  const campaignTypes=createCampaignTypes({app,db,reject,updateCampaign});
  const serializeTask = row => row && ({ ...row, collaborators_list: json(row.collaborators_json), removed: Boolean(row.removed) });
  const serializeCampaign = (row, summaryOnly = false, workspace = false) => {
    if (!row) return null;
    if(summaryOnly){
      const summary=db.prepare("SELECT count(*) AS total,coalesce(sum(status='completed'),0) AS completed,coalesce(sum(status='tracking'),0) AS tracking FROM security_campaign_tasks WHERE campaign_id=? AND removed=0").get(row.id);
      const {security_owners,scopes,description_html,objective,reference_text,collaborators_json,scope_details,search_text,...campaign}=row;
      return {...campaign,security_owners:json(security_owners),scopes:json(scopes),collaborators:json(collaborators_json),scope_details:json(scope_details),task_summary:summary};
    }
    const tasks = workspace ? [] : db.prepare('SELECT * FROM security_campaign_tasks WHERE campaign_id=? AND removed=0 ORDER BY id').all(row.id).map(serializeTask);
    const events = db.prepare(`SELECT l.id AS link_id,l.relation,l.confidence,l.note,l.created_at AS linked_at,
      r.id,r.event_id,r.title,r.event_type,r.occurred_at,r.stage FROM security_campaign_event_links l
      JOIN records r ON r.id=l.event_id WHERE l.campaign_id=? ORDER BY l.id DESC`).all(row.id);
    const updates = db.prepare(`SELECT u.id,u.task_id,u.kind,u.body,u.body_html,u.created_at,u.user_id,users.username
      FROM security_campaign_updates u JOIN users ON users.id=u.user_id WHERE u.campaign_id=? ORDER BY u.id DESC LIMIT 100`).all(row.id);
    const { security_owners, scopes, collaborators_json, scope_details, search_text, ...campaign } = row;
    return { ...campaign, security_owners: json(security_owners), scopes: json(scopes), collaborators:json(collaborators_json), scope_details:json(scope_details), tasks, events, updates,
      task_summary: workspace ? serializeCampaign(row, true).task_summary : { total: tasks.length, completed: tasks.filter(task => task.status === 'completed').length,
        tracking: tasks.filter(task => task.status === 'tracking').length } };
  };
  const getCampaign = id => db.prepare('SELECT * FROM security_campaigns WHERE id=? AND deleted=0').get(id);
  const getTask = id => db.prepare('SELECT t.* FROM security_campaign_tasks t JOIN security_campaigns c ON c.id=t.campaign_id WHERE t.id=? AND t.removed=0 AND c.deleted=0').get(id);
  const checkVersion = (row, version) => {
    if (!Number.isSafeInteger(version) || version !== row.version) reject('记录已被更新，请刷新后再操作。', 409);
  };
  function people(value = []) {
    if(!Array.isArray(value)||value.length>20)reject('协同人员须为最多20人的列表。');
    return [...new Set(value.map(x=>requiredText(x,'协同人员',100)))];
  }
  function scopeDetails(value,legacy,target) {
    if(target!==undefined)return [{type:'custom',name:requiredText(target,'目标范围',2000),note:''}];
    if(value===undefined)return cleanArray(legacy,'目标群体',30).map(name=>({type:'custom',name,note:''}));
    if(!Array.isArray(value)||!value.length||value.length>30)reject('请填写1至30项目标群体。');
    return value.map(item=>{
      if(!item||!['company','business','service','assets','custom','legacy'].includes(item.type))reject('群体类型无效。');
      return {type:item.type,name:requiredText(item.name,'群体名称',100),note:optionalText(item.note,'范围说明',2000)};
    });
  }
  function verifyAssets(html,campaignId,taskId,creating=false) {
    const ids=[...new Set([...html.matchAll(/\/api\/campaign-assets\/([1-9][0-9]*)\/download/g)].map(x=>Number(x[1])))];
    for(const id of ids){
      const asset=db.prepare('SELECT * FROM security_campaign_assets WHERE id=? AND deleted=0').get(id);
      if(creating||!asset||asset.campaign_id!==campaignId||(asset.task_id||null)!==taskId)reject('详细内容的附件不属于当前专项记录，请重新选择。');
    }
  }
  function progressBody(body,campaignId,taskId){
    if(body.body_html!==undefined){const html=cleanRich(body.body_html);verifyAssets(html,campaignId,taskId);const text=campaignPlainText(html);if(!text&&!html.includes('/api/campaign-assets/'))reject('请填写跟踪内容。');return {html,text:text||'添加证据附件'};}
    return {html:'',text:requiredText(body.body,'跟踪内容',10000)};
  }
  const ownerOptions = () => {
    const values = new Set(['admin']);
    for (const row of db.prepare('SELECT security_owners FROM records UNION ALL SELECT security_owners FROM security_campaigns WHERE deleted=0').all()) {
      for (const name of json(row.security_owners)) if (typeof name === 'string') values.add(name);
    }
    for (const row of db.prepare('SELECT t.owner,t.collaborators FROM security_campaign_tasks t JOIN security_campaigns c ON c.id=t.campaign_id WHERE t.removed=0 AND c.deleted=0').all()) {
      values.add(row.owner);
      for (const name of row.collaborators.split('\n').filter(Boolean)) values.add(name);
    }
    return [...values].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  };

  app.get('/api/campaigns/options', (req, res) => res.json({ security_owners: ownerOptions(),types:campaignTypes.list() }));
  app.get('/api/campaigns', (req, res) => {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const importance = /^P[0-4]$/.test(String(req.query.importance || '')) ? req.query.importance : '';
    const status = ['tracking', 'completed'].includes(req.query.status) ? req.query.status : '';
    const clauses = ['c.deleted=0'], params = [];
    if (search) { clauses.push("(c.code LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.search_text LIKE ? ESCAPE '\\')"); const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`; params.push(term, term, term); }
    if (importance) { clauses.push('c.importance=?'); params.push(importance); }
    if (status) { clauses.push('c.status=?'); params.push(status); }
    if (req.query.owner) { clauses.push('c.lead_owner=?'); params.push(String(req.query.owner)); }
    if(req.query.overdue==='true'){clauses.push("c.status='tracking' AND c.due_at IS NOT NULL AND c.due_at<?");params.push(now());}
    if (req.query.task_owner) { clauses.push('EXISTS (SELECT 1 FROM security_campaign_tasks t WHERE t.campaign_id=c.id AND t.removed=0 AND t.owner=?)'); params.push(String(req.query.task_owner)); }
    const page=Math.max(1,Math.min(100000,parseInt(req.query.page,10)||1)), pageSize=20;
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) AS count FROM security_campaigns c ${where}`).get(...params).count;
    const rows = db.prepare(`SELECT c.* FROM security_campaigns c ${where}
      ORDER BY CASE c.status WHEN 'tracking' THEN 0 ELSE 1 END,${importanceRank},CASE WHEN c.status='tracking' AND c.due_at IS NOT NULL AND c.due_at<? THEN 0 ELSE 1 END,c.updated_at DESC,c.id DESC
      LIMIT ? OFFSET ?`).all(...params,now(),pageSize,(page-1)*pageSize);
    res.json({ campaigns: rows.map(row => serializeCampaign(row,true)), total, page, page_size:pageSize });
  });
  app.post('/api/campaigns', (req, res) => {
    const body = req.body || {};
    const type = optionalText(body.type, '专项类型', 40) || '待定';
    if(body.stage!==undefined&&!['risks','incidents'].includes(body.stage))reject('专项不支持该研判层级。');
    const stage = 'incidents';
    const importance = /^P[0-4]$/.test(body.importance || '') ? body.importance : null;
    if (!importance) reject('请选择事件级别 P0–P4。');
    const lead = singleOwner(body.lead_owner, '总负责人');
    const collaborators = people(body.collaborators);
    const owners = [lead,...collaborators.filter(x=>x!==lead)];
    const details = scopeDetails(body.scope_details, body.scopes, body.target_scope);
    const scopes = details.map(x=>x.name);
    const occurredAt = body.occurred_at === undefined ? now() : parseDiscoveryTime(body.occurred_at);
    if (Date.parse(occurredAt) > Date.now()) reject('专项发现时间不能晚于当前时间。');
    const dueAt = requiredDeadline(body.due_at);
    validatePeriod(occurredAt,dueAt);
    const objective = '';
    const description = cleanRich(body.description_html ?? '');
    verifyAssets(description, null, null);
    const reference = '';
    if (body.tasks !== undefined && !Array.isArray(body.tasks)) reject('子任务格式无效。');
    if (body.events !== undefined && !Array.isArray(body.events)) reject('关联事件格式无效。');
    const tasks = body.tasks || [];
    if (tasks.length > 100) reject('单个专项最多创建 100 个子任务。');
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const selectedType=campaignTypes.resolve(body);
      const month = codePart(new Date(occurredAt));
      const prefix = `${month}-SPC-`;
      const latest = db.prepare("SELECT code FROM security_campaigns WHERE code LIKE ? ORDER BY code DESC LIMIT 1").get(`${prefix}%`);
      const sequence = latest ? Number(latest.code.slice(prefix.length)) + 1 : 1;
      if (sequence > 9999) reject('本月专项编号已用完，请联系管理员。');
      const code = `${prefix}${String(sequence).padStart(4, '0')}`;
      const title = code;
      const result = db.prepare(`INSERT INTO security_campaigns
        (code,title,type,stage,importance,security_owners,scopes,occurred_at,due_at,objective,description_html,reference_text,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code,title,type,stage,importance,JSON.stringify(owners),JSON.stringify(scopes),occurredAt,dueAt,objective,description,reference,timestamp,timestamp);
      const id = Number(result.lastInsertRowid);
      db.prepare('UPDATE security_campaigns SET type=?,type_id=? WHERE id=?').run(selectedType.name,selectedType.id,id);
      db.prepare('UPDATE security_campaigns SET lead_owner=?,collaborators_json=?,scope_details=?,search_text=?,content_version=2 WHERE id=?').run(lead,JSON.stringify(collaborators),JSON.stringify(details),campaignPlainText(description),id);
      for (const taskBody of tasks) insertTask(id, taskBody, req.user.id, true);
      updateCampaign(id, req.user.id, 'created', '建立安全专项');
      const events = Array.isArray(body.events) ? body.events : [];
      if (events.length > 100) reject('单个专项最多关联 100 条事件。');
      for (const event of events) saveEventLink(id, event, req.user.id);
      db.exec('COMMIT');
      res.status(201).json({ campaign: serializeCampaign(getCampaign(id)) });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  app.delete('/api/campaigns/:id', (req, res) => {
    const id=Number(req.params.id),campaign=getCampaign(id);
    if(!campaign)reject('安全专项不存在。',404);
    checkVersion(campaign,req.body?.version);
    db.exec('BEGIN IMMEDIATE');
    try {
      checkVersion(getCampaign(id),req.body.version);
      const links=db.prepare('SELECT event_id,relation,confidence,note FROM security_campaign_event_links WHERE campaign_id=?').all(id);
      updateCampaign(id,req.user.id,'deleted',`删除专项事件 ${campaign.code}；保留历史和证据，解除引用：${JSON.stringify(links)}`);
      db.prepare('DELETE FROM security_campaign_event_links WHERE campaign_id=?').run(id);
      db.prepare('UPDATE security_campaigns SET deleted=1,deleted_at=?,deleted_by=?,version=version+1,updated_at=? WHERE id=?').run(now(),req.user.id,now(),id);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    res.json({ok:true});
  });
  app.get('/api/campaigns/:id', (req, res) => {
    const campaign = getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: '安全专项不存在。' });
    const result=serializeCampaign(campaign,false,req.query.workspace==='true');
    if(req.query.workspace==='true')delete result.tasks;
    res.json({ campaign: result });
  });
  app.put('/api/campaigns/:id', (req, res) => {
    const id = Number(req.params.id), row = getCampaign(id);
    if (!row) return res.status(404).json({ error: '安全专项不存在。' });
    checkVersion(row, req.body?.version);
    const body = req.body || {};
    if(body.stage!==undefined&&!['risks','incidents'].includes(body.stage))reject('专项不支持该研判层级。');
    const stage = 'incidents';
    const importance = /^P[0-4]$/.test(body.importance || '') ? body.importance : null;
    if (!importance) reject('请选择事件级别 P0–P4。');
    const occurredAt = body.occurred_at === undefined ? row.occurred_at : parseDiscoveryTime(body.occurred_at);
    if (Date.parse(occurredAt) > Date.now()) reject('专项发现时间不能晚于当前时间。');
    const changes = {
      title: row.title, type: body.type===undefined?row.type:(optionalText(body.type,'专项类型',40)||'待定'), stage, importance,
      lead: singleOwner(body.lead_owner,'总负责人'), collaborators: JSON.stringify(people(body.collaborators ?? json(row.collaborators_json))),
      owners: JSON.stringify([singleOwner(body.lead_owner,'总负责人'),...people(body.collaborators ?? json(row.collaborators_json)).filter(x=>x!==body.lead_owner.trim())]),
      details: JSON.stringify(scopeDetails(body.scope_details,body.scopes,body.target_scope)), scopes: JSON.stringify(scopeDetails(body.scope_details,body.scopes,body.target_scope).map(x=>x.name)), occurredAt, dueAt: requiredDeadline(body.due_at),
      objective: row.objective, description: cleanRich(body.description_html ?? ''),
      reference: row.reference_text,
    };
    validatePeriod(changes.occurredAt,changes.dueAt);
    verifyAssets(changes.description,id,null);
    if (row.status === 'completed') reject('已完结专项请先重新打开，再修改内容。', 409);
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      checkVersion(getCampaign(id),body.version);
      if(getCampaign(id).status==='completed')reject('专项已完结，请刷新后重新打开。',409);
      const selectedType=campaignTypes.resolve(body,row);
      changes.type=selectedType.name;
      db.prepare(`UPDATE security_campaigns SET title=?,type=?,stage=?,importance=?,security_owners=?,scopes=?,occurred_at=?,due_at=?,
        objective=?,description_html=?,reference_text=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(changes.title,changes.type,changes.stage,changes.importance,changes.owners,changes.scopes,changes.occurredAt,changes.dueAt,
          changes.objective,changes.description,changes.reference,timestamp,id,row.version);
      db.prepare('UPDATE security_campaigns SET lead_owner=?,collaborators_json=?,scope_details=?,search_text=? WHERE id=?').run(changes.lead,changes.collaborators,changes.details,campaignPlainText(changes.description),id);
      db.prepare('UPDATE security_campaigns SET type_id=? WHERE id=?').run(selectedType.id,id);
      const before={lead:row.lead_owner,collaborators:row.collaborators_json,details:row.scope_details,title:row.title,type:row.type,stage:row.stage,importance:row.importance,owners:row.security_owners,scopes:row.scopes,occurredAt:row.occurred_at,dueAt:row.due_at,objective:row.objective,description:row.description_html,reference:row.reference_text};
      updateCampaign(id, req.user.id, 'edited', JSON.stringify(Object.fromEntries(Object.entries(changes).filter(([key,value])=>value!==before[key]).map(([key,value])=>[key,{before:before[key],after:value}]))));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ campaign: serializeCampaign(getCampaign(id)) });
  });

  function insertTask(campaignId, body = {}, userId, initial = false) {
    if(!body||typeof body!=='object'||Array.isArray(body))reject('子任务格式无效。');
    const campaign = getCampaign(campaignId);
    if (!campaign) reject('安全专项不存在。', 404);
    if (campaign.status === 'completed' && !initial) reject('该专项已完结，新增子任务前请先重新打开专项。', 409);
    const simple = body.details_text !== undefined;
    const description = simple ? `<p>${escapeHTML(optionalText(body.details_text,'事件明细',10000)).replace(/\n/g,'<br>')}</p>` : cleanRich(body.description_html ?? '');
    const status = body.status ?? 'tracking';
    const priority = taskPriority(body.priority===undefined?'medium':body.priority);
    if(!['tracking','completed'].includes(status))reject('待办状态仅支持跟踪中或已完结。');
    const task = {
      title: requiredText(body.title, '子任务标题'), owner: singleOwner(body.owner, '跟进负责人'),
      collaborators: optionalText(body.collaborators, '协同人员', 1000), scope: requiredText(body.scope || json(campaign.scopes).join('、'), '执行范围', 2000),
      description, acceptance: optionalText(body.acceptance,'完成标准',2000),
      dueAt: validDate(body.due_at),
    };
    if (db.prepare('SELECT count(*) AS n FROM security_campaign_tasks WHERE campaign_id=? AND removed=0').get(campaignId).n >= 100) reject('单个专项最多 100 个有效子任务。');
    verifyAssets(task.description,campaignId,null,true);
    const seq = campaign.next_task_seq;
    const code = `${campaign.code}-T${String(seq).padStart(3, '0')}`;
    const timestamp = now();
    const result = db.prepare(`INSERT INTO security_campaign_tasks
      (campaign_id,code,title,owner,collaborators,scope,description_html,acceptance,due_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(campaignId,code,task.title,task.owner,task.collaborators,task.scope,task.description,task.acceptance,task.dueAt,timestamp,timestamp);
    db.prepare('UPDATE security_campaign_tasks SET collaborators_json=? WHERE id=?').run(JSON.stringify(people(body.collaborators_list ?? (body.collaborators ? body.collaborators.split(/[\n,，、;；]+/) : []))),Number(result.lastInsertRowid));
    const taskId = Number(result.lastInsertRowid);
    db.prepare('UPDATE security_campaign_tasks SET priority=? WHERE id=?').run(priority,taskId);
    if(status==='completed'){
      const reason = optionalText(body.conclusion,'完结结论',10000)||campaignPlainText(task.description)||'完结待办事件';
      db.prepare("UPDATE security_campaign_tasks SET status='completed',conclusion=?,completed_at=?,completed_by=? WHERE id=?").run(reason,timestamp,String(userId),taskId);
      updateCampaign(campaignId,userId,'task_completed',`初始完结待办 ${code}：${reason}`,taskId);
    }
    db.prepare('UPDATE security_campaigns SET next_task_seq=next_task_seq+1,version=version+1,updated_at=? WHERE id=?').run(timestamp,campaignId);
    updateCampaign(campaignId,userId,'task_created',`新增子任务 ${code}：${task.title}`,Number(result.lastInsertRowid));
    return getTask(Number(result.lastInsertRowid));
  }
  app.get('/api/campaigns/:id/tasks', (req,res)=>{
    const id=Number(req.params.id);if(!getCampaign(id))reject('专项事件不存在。',404);
    const clauses=['t.campaign_id=?','t.removed=0'],params=[id];
    if(req.query.owner){clauses.push('t.owner=?');params.push(String(req.query.owner));}
    if(['tracking','completed'].includes(req.query.status)){clauses.push('t.status=?');params.push(req.query.status);}
    if(req.query.overdue==='true'){clauses.push("t.status='tracking' AND t.due_at IS NOT NULL AND t.due_at<?");params.push(now());}
    const search=String(req.query.search||'').trim().slice(0,100);
    if(search){clauses.push("(instr(t.title,?)>0 OR instr(t.code,?)>0 OR instr(t.scope,?)>0)");params.push(search,search,search);}
    const where=clauses.join(' AND '),total=db.prepare(`SELECT count(*) AS n FROM security_campaign_tasks t WHERE ${where}`).get(...params).n;
    const pages=Math.max(1,Math.ceil(total/20)),page=Math.min(pages,Math.max(1,parseInt(req.query.page,10)||1));
    const tasks=db.prepare(`SELECT t.id,t.code,t.title,t.owner,t.scope,t.status,t.priority,t.due_at,t.version,t.updated_at,t.description_html,
      (SELECT u.body FROM security_campaign_updates u WHERE u.task_id=t.id AND u.kind IN ('task_update','task_completed','task_reopened') ORDER BY u.id DESC LIMIT 1) AS latest_update
      FROM security_campaign_tasks t WHERE ${where} ORDER BY t.id ASC LIMIT 20 OFFSET ?`).all(...params,(page-1)*20);
    const owners=db.prepare('SELECT DISTINCT owner FROM security_campaign_tasks WHERE campaign_id=? AND removed=0 ORDER BY owner').all(id).map(x=>x.owner);
    const overdue=db.prepare("SELECT count(*) AS n FROM security_campaign_tasks WHERE campaign_id=? AND removed=0 AND status='tracking' AND due_at<?").get(id,now()).n;
    res.json({tasks:tasks.map(({description_html,...task})=>({...task,details_summary:campaignPlainText(description_html).slice(0,240)})),total,page,page_size:20,owners,overdue});
  });
  app.get('/api/campaigns/:id/tasks/:taskId',(req,res)=>{
    const task=getTask(Number(req.params.taskId));if(!task||task.campaign_id!==Number(req.params.id))reject('执行专项不存在。',404);
    const before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
    const updates=db.prepare(`SELECT u.*,users.username FROM security_campaign_updates u JOIN users ON users.id=u.user_id WHERE u.task_id=? AND u.id<? ORDER BY u.id DESC LIMIT 100`).all(task.id,before);
    res.json({task:serializeTask(task),updates});
  });
  app.post('/api/campaigns/:id/tasks', (req, res) => {
    const id = Number(req.params.id);
    const initialParent = getCampaign(id);
    if (!initialParent) reject('安全专项不存在。', 404);
    if(req.body?.campaign_version!==undefined)checkVersion(initialParent, req.body.campaign_version);
    db.exec('BEGIN IMMEDIATE');
    try {
      const parent=getCampaign(id);
      checkVersion(parent, initialParent.version);
      if(parent?.status==='completed' && req.body?.reopen_campaign===true){
        const reason=optionalText(req.body.reason,'重新打开原因',5000)||'新增待办事件，重新打开专项';
        db.prepare("UPDATE security_campaigns SET status='tracking',conclusion=NULL,completed_at=NULL,completed_by=NULL,version=version+1,updated_at=? WHERE id=?").run(now(),id);
        updateCampaign(id,req.user.id,'reopened',reason);
      }
      const task = insertTask(id,req.body,req.user.id); db.exec('COMMIT'); res.status(201).json({ task: serializeTask(task) });
    }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  app.patch('/api/campaigns/:id/tasks/:taskId', (req,res)=>{
    const campaignId=Number(req.params.id),taskId=Number(req.params.taskId),campaign=getCampaign(campaignId),task=getTask(taskId),body=req.body||{};
    if(!campaign||!task||task.campaign_id!==campaignId)reject('子任务不存在。',404);
    checkVersion(task,body.version);
    if(campaign.status!=='tracking'||task.status!=='tracking')reject('请先重新打开专项及子任务，再修改任务内容。',409);
    const changes={title:requiredText(body.title,'任务名称'),owner:singleOwner(body.owner,'负责人'),priority:taskPriority(body.priority),due_at:validDate(body.due_at===undefined?task.due_at:body.due_at)};
    db.exec('BEGIN IMMEDIATE');
    try {
      checkVersion(getTask(taskId),body.version);
      db.prepare('UPDATE security_campaign_tasks SET title=?,owner=?,priority=?,due_at=?,version=version+1,updated_at=? WHERE id=?').run(changes.title,changes.owner,changes.priority,changes.due_at,now(),taskId);
      db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),campaignId);
      updateCampaign(campaignId,req.user.id,'task_edited',`更新子任务 ${task.code}：${JSON.stringify({before:task,after:changes})}`,taskId);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.json({task:serializeTask(getTask(taskId))});
  });
  app.put('/api/campaigns/:id/tasks/:taskId', (req, res) => {
    const campaignId = Number(req.params.id), taskId = Number(req.params.taskId);
    const campaign = getCampaign(campaignId), row = getTask(taskId);
    if (!campaign || !row || row.campaign_id !== campaignId) reject('子任务不存在。',404);
    checkVersion(row,req.body?.version);
    if (campaign.status === 'completed' || row.status === 'completed') reject('请先重新打开专项及子任务，再修改任务内容。',409);
    const body = req.body || {};
    const priority=taskPriority(body.priority===undefined?row.priority:body.priority);
    const simple = body.details_text !== undefined;
    const description = simple ? `<p>${escapeHTML(optionalText(body.details_text,'事件明细',10000)).replace(/\n/g,'<br>')}</p>` : cleanRich(body.description_html ?? row.description_html);
    const values = [requiredText(body.title,'待办名称'),singleOwner(body.owner,'跟进负责人'),
      optionalText(body.collaborators ?? row.collaborators,'协同人员',1000),requiredText(body.scope || row.scope,'执行范围',2000),
      description,body.acceptance===undefined?row.acceptance:optionalText(body.acceptance,'完成标准',2000),validDate(body.due_at === undefined ? row.due_at : body.due_at)];
    verifyAssets(values[4],campaignId,taskId);
    db.exec('BEGIN IMMEDIATE');
    try {
      checkVersion(getTask(taskId),body.version);
      if(getCampaign(campaignId).status==='completed'||getTask(taskId).status==='completed')reject('专项或子任务已完结，请刷新。',409);
      db.prepare(`UPDATE security_campaign_tasks SET title=?,owner=?,collaborators=?,scope=?,description_html=?,acceptance=?,due_at=?,
        version=version+1,updated_at=? WHERE id=? AND version=?`).run(...values,now(),taskId,row.version);
      db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),campaignId);
      db.prepare('UPDATE security_campaign_tasks SET priority=? WHERE id=?').run(priority,taskId);
      db.prepare('UPDATE security_campaign_tasks SET collaborators_json=? WHERE id=?').run(JSON.stringify(people(body.collaborators_list ?? (body.collaborators ? body.collaborators.split(/[\n,，、;；]+/) : json(row.collaborators_json)))),taskId);
      updateCampaign(campaignId,req.user.id,'task_edited',`更新子任务 ${row.code}：${JSON.stringify({before:row,after:body})}`,taskId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ task: serializeTask(getTask(taskId)) });
  });
  app.post('/api/campaigns/:id/tasks/:taskId/updates', (req, res) => {
    const campaignId = Number(req.params.id), taskId = Number(req.params.taskId), campaign = getCampaign(campaignId), task = getTask(taskId);
    if (!campaign || !task || task.campaign_id !== campaignId) reject('子任务不存在。',404);
    if (campaign.status !== 'tracking' || task.status !== 'tracking') reject('只有跟踪中的专项和子任务可以追加跟踪记录。',409);
    if(req.body?.version!==undefined)checkVersion(task,req.body.version);
    if(req.body?.campaign_version!==undefined)checkVersion(campaign,req.body.campaign_version);
    const progress=progressBody(req.body,campaignId,taskId);
    const body = progress.text;
    db.exec('BEGIN IMMEDIATE');
    try {
    checkVersion(getTask(taskId),task.version);
    checkVersion(getCampaign(campaignId),campaign.version);
    const update=updateCampaign(campaignId,req.user.id,'task_update',body,taskId);
    db.prepare('UPDATE security_campaign_updates SET body_html=? WHERE id=?').run(progress.html,Number(update.lastInsertRowid));
    db.prepare('UPDATE security_campaign_tasks SET updated_at=?,version=version+1 WHERE id=?').run(now(),taskId);
    db.prepare('UPDATE security_campaigns SET updated_at=?,version=version+1 WHERE id=?').run(now(),campaignId);
    db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ ok:true });
  });
  app.post('/api/campaigns/:id/tasks/:taskId/status', (req, res) => changeTaskStatus({
    campaignId:Number(req.params.id),taskId:Number(req.params.taskId),body:req.body || {},userId:req.user.id,res,
  }));
  app.delete('/api/campaigns/:id/tasks/:taskId',(req,res)=>{
    const id=Number(req.params.id),taskId=Number(req.params.taskId),campaign=getCampaign(id),task=getTask(taskId);
    if(!campaign||!task||task.campaign_id!==id)reject('子任务不存在。',404);
    checkVersion(task,req.body?.version);
    const reason=optionalText(req.body?.reason,'删除原因',5000)||'删除待办事件';
    db.exec('BEGIN IMMEDIATE');
    try{
      checkVersion(getTask(taskId),req.body.version);
      checkVersion(getCampaign(id),campaign.version);
      db.prepare('UPDATE security_campaign_tasks SET removed=1,version=version+1,updated_at=? WHERE id=?').run(now(),taskId);
      updateCampaign(id,req.user.id,'task_removed',`移除 ${task.code}：${reason}`,taskId);
      db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.json({ok:true});
  });
  app.post('/api/campaigns/:id/updates',(req,res)=>{
    const id=Number(req.params.id),campaign=getCampaign(id);
    if(!campaign)reject('专项不存在。',404);
    if(campaign.status!=='tracking')reject('请先重新打开专项，再追加跟踪。',409);
    if(req.body?.version!==undefined)checkVersion(campaign,req.body.version);
    const progress=progressBody(req.body,id,null);
    const body=progress.text;
    db.exec('BEGIN IMMEDIATE');
    try{
      checkVersion(getCampaign(id),campaign.version);
      const update=updateCampaign(id,req.user.id,'progress',body);
      db.prepare('UPDATE security_campaign_updates SET body_html=? WHERE id=?').run(progress.html,Number(update.lastInsertRowid));
      db.prepare('UPDATE security_campaigns SET updated_at=?,version=version+1 WHERE id=?').run(now(),id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.status(201).json({ok:true});
  });
  app.get('/api/campaigns/:id/updates',(req,res)=>{
    const id=Number(req.params.id);if(!getCampaign(id))reject('专项不存在。',404);
    const before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
    res.json({updates:db.prepare(`SELECT u.*,users.username FROM security_campaign_updates u JOIN users ON users.id=u.user_id
      WHERE u.campaign_id=? AND u.id<? ORDER BY u.id DESC LIMIT 100`).all(id,before)});
  });
  function changeTaskStatus({campaignId,taskId,body,userId,res}) {
    const campaign=getCampaign(campaignId), task=getTask(taskId);
    if (!campaign || !task || task.campaign_id!==campaignId) reject('子任务不存在。',404);
    checkVersion(task,body.version);
    if(body.campaign_version!==undefined)checkVersion(campaign,body.campaign_version);
    const next=body.status;
    if (!['tracking','completed'].includes(next) || next===task.status) reject('子任务状态变更无效。');
    const reason=next==='completed'?(optionalText(body.reason,'完结说明',5000)||'完结待办事件'):(optionalText(body.reason,'重新打开原因',5000)||'重新打开待办事件');
    if (campaign.status==='completed' && !(body.reopen_campaign===true && next==='tracking')) reject('专项已完结，请同时确认重新打开专项。',409);
    db.exec('BEGIN IMMEDIATE');
    try {
      checkVersion(getTask(taskId),body.version);
      checkVersion(getCampaign(campaignId),campaign.version);
      if (campaign.status==='completed') {
        db.prepare("UPDATE security_campaigns SET status='tracking',conclusion=NULL,completed_at=NULL,completed_by=NULL,version=version+1,updated_at=? WHERE id=?").run(now(),campaignId);
        updateCampaign(campaignId,userId,'reopened',`因重新打开子任务 ${task.code} 而重新跟踪专项`);
      }
      const timestamp=now();
      db.prepare(`UPDATE security_campaign_tasks SET status=?,conclusion=?,completed_at=?,completed_by=?,version=version+1,updated_at=? WHERE id=?`)
        .run(next,next==='completed'?reason:null,next==='completed'?timestamp:null,next==='completed'?String(userId):null,timestamp,taskId);
      db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(timestamp,campaignId);
      updateCampaign(campaignId,userId,next==='completed'?'task_completed':'task_reopened',`${next==='completed'?'完结':'重新打开'}子任务 ${task.code}：${reason}`,taskId);
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    res.json({campaign:serializeCampaign(getCampaign(campaignId))});
  }
  app.post('/api/campaigns/:id/status', (req,res)=>{
    const id=Number(req.params.id),row=getCampaign(id);
    if(!row)return res.status(404).json({error:'安全专项不存在。'});
    checkVersion(row,req.body?.version);
    const next=req.body?.status;
    if(!['tracking','completed'].includes(next)||next===row.status)reject('专项状态变更无效。');
    const reason=next==='completed'?(optionalText(req.body?.reason,'完结说明',5000)||'完结专项事件'):(optionalText(req.body?.reason,'重新打开原因',5000)||'重新打开专项事件');
    const active=db.prepare("SELECT count(*) AS count FROM security_campaign_tasks WHERE campaign_id=? AND removed=0 AND status='tracking'").get(id).count;
    if(next==='completed'&&active){const pending=db.prepare("SELECT title,owner FROM security_campaign_tasks WHERE campaign_id=? AND removed=0 AND status='tracking' ORDER BY id").all(id);reject(`还有 ${active} 个执行专项跟踪中：${pending.map(t=>`${t.title}（${t.owner}）`).join('、')}，暂不能完结。`,409);}
    const timestamp=now();
    db.exec('BEGIN IMMEDIATE');
    try{
      checkVersion(getCampaign(id),req.body.version);
      const remaining=db.prepare("SELECT count(*) AS count FROM security_campaign_tasks WHERE campaign_id=? AND removed=0 AND status='tracking'").get(id).count;
      if(next==='completed'&&remaining)reject(`还有 ${remaining} 个子任务跟踪中，请刷新。`,409);
      db.prepare(`UPDATE security_campaigns SET status=?,conclusion=?,completed_at=?,completed_by=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(next,next==='completed'?reason:null,next==='completed'?timestamp:null,next==='completed'?String(req.user.id):null,timestamp,id,row.version);
      updateCampaign(id,req.user.id,next==='completed'?'completed':'reopened',reason);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    res.json({campaign:serializeCampaign(getCampaign(id))});
  });
  function saveEventLink(campaignId,body,userId){
    if(!body||typeof body!=='object'||Array.isArray(body))reject('关联事件格式无效。');
    const eventId=Number(body.event_id),event=db.prepare('SELECT id FROM records WHERE id=?').get(eventId);
    if(!event)reject('关联事件不存在。',404);
    const relation=['risk_source','post_incident','related'].includes(body.relation)?body.relation:null;
    const confidence=body.confidence ?? 'pending';
    if(!['pending','confirmed','not_confirmed'].includes(confidence))reject('关联确认情况无效。');
    if(!relation)reject('事件关联类型无效。');
    const note=relation==='risk_source'?requiredText(body.note,'风险来源/利用入口说明',5000):optionalText(body.note,'关联说明',5000);
    db.prepare(`INSERT INTO security_campaign_event_links (campaign_id,event_id,relation,confidence,note,created_by,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(campaign_id,event_id) DO UPDATE SET relation=excluded.relation,confidence=excluded.confidence,note=excluded.note`)
      .run(campaignId,eventId,relation,confidence,note,userId,now());
  }
  app.put('/api/campaigns/:id/events/:eventId', (req,res)=>{
    const campaignId=Number(req.params.id),eventId=Number(req.params.eventId),campaign=getCampaign(campaignId);
    if(!campaign)return res.status(404).json({error:'安全专项不存在。'});
    if(campaign.status==='completed')reject('已完结专项请先重新打开，再调整关联。',409);
    db.exec('BEGIN IMMEDIATE');
    try{checkVersion(getCampaign(campaignId),campaign.version);saveEventLink(campaignId,{...req.body,event_id:eventId},req.user.id);updateCampaign(campaignId,req.user.id,'event_linked',`关联事件 ${eventId}：${JSON.stringify(req.body)}`);db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),campaignId);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    res.json({campaign:serializeCampaign(getCampaign(campaignId))});
  });
  app.delete('/api/campaigns/:id/events/:eventId', (req,res)=>{
    const campaignId=Number(req.params.id),eventId=Number(req.params.eventId),campaign=getCampaign(campaignId);
    if(!campaign)return res.status(404).json({error:'安全专项不存在。'});
    if(campaign.status==='completed')reject('已完结专项请先重新打开，再解除关联。',409);
    db.exec('BEGIN IMMEDIATE');
    try {
    checkVersion(getCampaign(campaignId),campaign.version);
    const event=db.prepare('SELECT event_id FROM records WHERE id=?').get(eventId);
    const result=db.prepare('DELETE FROM security_campaign_event_links WHERE campaign_id=? AND event_id=?').run(campaignId,eventId);
    if(!result.changes)reject('事件关联不存在。',404);
    updateCampaign(campaignId,req.user.id,'event_unlinked',`解除事件关联 ${event?.event_id || eventId}`);
    db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),campaignId);
    db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    res.json({ok:true});
  });
  app.get('/api/events/:id/campaigns',(req,res)=>{
    const event=db.prepare('SELECT id FROM records WHERE id=?').get(Number(req.params.id));
    if(!event)return res.status(404).json({error:'事件不存在。'});
    const rows=db.prepare(`SELECT c.id,c.code,c.title,c.stage,c.importance,c.status,l.relation,l.confidence,l.note
      FROM security_campaign_event_links l JOIN security_campaigns c ON c.id=l.campaign_id WHERE l.event_id=? AND c.deleted=0 ORDER BY c.updated_at DESC`).all(event.id);
    res.json({campaigns:rows});
  });
  app.get('/api/events/campaign-options',(req,res)=>{
    const q=String(req.query.search||'').trim().slice(0,100),term=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
    const rows=db.prepare(`SELECT id,code,title,stage,importance,status FROM security_campaigns
      WHERE deleted=0 AND (?='' OR code LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR search_text LIKE ? ESCAPE '\\') ORDER BY CASE status WHEN 'tracking' THEN 0 ELSE 1 END,${importanceRank},updated_at DESC LIMIT 30`)
      .all(q,term,term,term);
    res.json({campaigns:rows});
  });

  createCampaignAssets({app,db,dataDirectory,getCampaign,getTask,updateCampaign,reject});

  return {
    setEventLinks(eventId,links,userId){
      if(!Array.isArray(links)||links.length>100)reject('关联专项格式无效，最多 100 项。');
      const seen=new Set();
      for(const link of links){
        if(!link||typeof link!=='object'||Array.isArray(link))reject('关联专项格式无效。');
        const id=Number(link.campaign_id);if(!Number.isSafeInteger(id)||seen.has(id))reject('关联专项编号无效或重复。');seen.add(id);
        const campaign=getCampaign(id);if(!campaign)reject('关联专项不存在。',404);
        const previous=db.prepare('SELECT * FROM security_campaign_event_links WHERE campaign_id=? AND event_id=?').get(id,eventId);
        if(campaign.status==='completed'){
          if(!previous||previous.relation!==link.relation||previous.confidence!==link.confidence||previous.note!==(link.note||''))reject('已完结专项请先重新打开，再新增或调整关联。',409);
          continue;
        }
        saveEventLink(id,{...link,event_id:eventId},userId);
        if(!previous||previous.relation!==link.relation||previous.confidence!==link.confidence||previous.note!==(link.note||'')){
          updateCampaign(id,userId,'event_linked',`新增或更新事件关联 ${eventId}：${link.note||''}`);
          db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),id);
        }
      }
      for(const row of db.prepare('SELECT campaign_id FROM security_campaign_event_links WHERE event_id=?').all(eventId)){
        if(seen.has(row.campaign_id))continue;
        if(getCampaign(row.campaign_id)?.status==='completed')reject('已完结专项请先重新打开，再解除关联。',409);
        db.prepare('DELETE FROM security_campaign_event_links WHERE campaign_id=? AND event_id=?').run(row.campaign_id,eventId);
        updateCampaign(row.campaign_id,userId,'event_unlinked',`解除事件关联 ${eventId}`);
        db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),row.campaign_id);
      }
    },
    detachEvent(eventId,userId){
      const event=db.prepare('SELECT event_id FROM records WHERE id=?').get(eventId);
      for(const row of db.prepare('SELECT campaign_id FROM security_campaign_event_links WHERE event_id=?').all(eventId)){
        updateCampaign(row.campaign_id,userId,'event_deleted',`事件 ${event?.event_id||eventId} 被删除，已解除引用`);
        db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(now(),row.campaign_id);
      }
      db.prepare('DELETE FROM security_campaign_event_links WHERE event_id=?').run(eventId);
    },
    contribution(asOf=new Date()){
    const starts=periodStarts(asOf),values=Object.fromEntries(['logs','risks','incidents'].map(layer=>[layer,Object.fromEntries(PERIODS.map(period=>[period.key,0]))]));
    const rows=db.prepare('SELECT occurred_at FROM security_campaigns WHERE deleted=0').all();
    for(const row of rows){const time=Date.parse(row.occurred_at);if(!Number.isFinite(time)||time>asOf.getTime())continue;
      for(const period of PERIODS){if(time<starts[period.key])continue;values.logs[period.key]++;values.risks[period.key]++;values.incidents[period.key]++;}}
    return values;
  }};
}
