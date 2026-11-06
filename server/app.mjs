import { APP_VERSION } from '../shared/version.mjs';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  STAGES, PERIODS, SYSTEM_LAYERS, EVENT_TYPES, ALL_EVENT_TYPE_KEYS, calculateSnapshot, eventTitleBucket,
  formatEventTitle, periodStarts,
} from '../shared/model.mjs';
import { normalizeReport, FormError } from './report.mjs';
import { createReportingApi } from './reporting-api.mjs';
import { createCampaignModule } from './campaigns.mjs';

const scryptAsync = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const safeJSON = text => { try { return JSON.parse(text); } catch { return null; } };

export function createPlatform(options) {
  const { databasePath, adminUsername, adminPassword, sessionHours = 8, secureCookie = false } = options;
  const clock = options.clock || (() => new Date());
  if (!adminUsername || !adminPassword) throw new Error('管理员账号和密码不能为空，请检查 .env。');
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, occurred_at TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('logs','risks','incidents','violations','red_lines')),
      severity TEXT CHECK(severity IN ('P0','P1','P2','P3','P4')),
      event_type TEXT NOT NULL DEFAULT 'DLP',
      title_seq INTEGER,
      form_data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      CHECK((stage = 'red_lines' AND severity IS NOT NULL) OR (stage != 'red_lines' AND severity IS NULL))
    );
    CREATE INDEX IF NOT EXISTS records_occurred ON records(occurred_at);
    CREATE TABLE IF NOT EXISTS event_assets (
      id INTEGER PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
      event_id INTEGER REFERENCES records(id), filename TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, relative_path TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_assets_event ON event_assets(event_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS layers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, metric TEXT NOT NULL, period TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, values_json TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS protect_system_layers_delete
      BEFORE DELETE ON layers WHEN OLD.is_system = 1
      BEGIN SELECT RAISE(ABORT, 'System layers cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS protect_system_layers_update
      BEFORE UPDATE ON layers WHEN OLD.is_system = 1
      BEGIN SELECT RAISE(ABORT, 'System layers cannot be changed'); END;
  `);
  const recordColumns = new Set(db.prepare('PRAGMA table_info(records)').all().map(column => column.name));
  for (const [name, definition] of Object.entries({
    title: "TEXT NOT NULL DEFAULT ''",
    event_type: "TEXT NOT NULL DEFAULT 'DLP'", title_seq: 'INTEGER',
    security_owners: "TEXT NOT NULL DEFAULT '[]'", incident_owners: "TEXT NOT NULL DEFAULT '[]'",
    description_html: "TEXT NOT NULL DEFAULT ''", updated_at: 'TEXT',
    event_severity: "TEXT CHECK(event_severity IN ('P0','P1','P2','P3','P4'))",
    redline_confirmation_asset_id: 'INTEGER',
  })) {
    if (!recordColumns.has(name)) db.exec(`ALTER TABLE records ADD COLUMN ${name} ${definition}`);
  }
  // Preserve red-line grades when initializing an earlier beta schema.
  db.exec('UPDATE records SET event_severity = severity WHERE event_severity IS NULL AND severity IS NOT NULL');
  const admin = db.prepare('SELECT id, salt, password_hash FROM users WHERE username = ?').get(adminUsername);
  if (!admin) {
    const salt = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)')
      .run(adminUsername, salt, scryptSync(adminPassword, salt, 64).toString('hex'));
  } else if (!timingSafeEqual(scryptSync(adminPassword, admin.salt, 64), Buffer.from(admin.password_hash, 'hex'))) {
    const salt = randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE username = ?')
      .run(salt, scryptSync(adminPassword, salt, 64).toString('hex'), adminUsername);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
  }
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('default_funnel_enabled', 'true')").run();
  const enabled = () => db.prepare("SELECT value FROM settings WHERE key = 'default_funnel_enabled'").get().value === 'true';
  const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const migrateEventTitles = () => {
    if (setting('event_title_format_v1') === 'true') return;
    const rows = db.prepare('SELECT id,occurred_at,created_at FROM records ORDER BY occurred_at ASC,id ASC').all();
    const counters = new Map();
    db.exec('BEGIN IMMEDIATE');
    try {
      const readForm = db.prepare('SELECT form_data FROM records WHERE id=?');
      const update = db.prepare('UPDATE records SET title=?,event_type=?,title_seq=?,form_data=? WHERE id=?');
      for (const row of rows) {
        const occurredAt = Number.isFinite(new Date(row.occurred_at).getTime())
          ? row.occurred_at : row.created_at;
        const bucket = eventTitleBucket(occurredAt) || 'unknown';
        const sequence = (counters.get(bucket) || 0) + 1;
        counters.set(bucket, sequence);
        const title = formatEventTitle(occurredAt, 'DLP', sequence);
        const formData = safeJSON(readForm.get(row.id)?.form_data) || {};
        formData.title = title;
        formData.event_type = 'DLP';
        formData.title_seq = sequence;
        update.run(title, 'DLP', sequence, JSON.stringify(formData), row.id);
      }
      db.prepare("INSERT INTO settings (key,value) VALUES ('event_title_format_v1','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  migrateEventTitles();
  const createSystemLayers = () => {
    const insert = db.prepare('INSERT OR IGNORE INTO layers (id,name,metric,period,is_system) VALUES (?,?,?,?,1)');
    for (const layer of SYSTEM_LAYERS) insert.run(layer.id, layer.name, layer.metric, layer.period);
  };
  if (enabled()) createSystemLayers();

  const dataDirectory = databasePath === ':memory:' ? resolve('./data') : dirname(databasePath);
  const eventAssetDirectory = join(dataDirectory, 'integrations', 'event-assets');
  const json = value => {
    try { return JSON.parse(value); } catch { return null; }
  };

  const app = express();
  let reportingRouter = null;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', service: 'trace-security-operations', version: APP_VERSION });
  });
  app.use('/api/v1', (req, res, next) => reportingRouter ? reportingRouter(req, res, next) : next());
  const loginAttempts = new Map();
  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of loginAttempts) if (value.until <= now) loginAttempts.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }, 60000);
  pruneTimer.unref();
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookie, path: '/' };
  const sessionCookie = req => {
    const match = /(?:^|;\s*)trace_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '');
    return match?.[1];
  };
  const authenticated = (req, res, next) => {
    const rawToken = sessionCookie(req);
    const session = rawToken && db.prepare(`
      SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE token_hash = ? AND expires_at > ?
    `).get(digest(rawToken), Date.now());
    if (!session) return res.status(401).json({ error: '请先登录平台。' });
    req.user = { id: session.id, username: session.username };
    next();
  };

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const key = req.ip;
      const now = Date.now();
      const existing = loginAttempts.get(key);
      const attempt = existing && existing.until > now ? existing : { count: 0, until: now + 15 * 60000 };
      if (attempt.count >= 10) return res.status(429).json({ error: '登录尝试过多，请在 15 分钟后重试。' });
      attempt.count++;
      loginAttempts.set(key, attempt);
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 1024) {
        return res.status(400).json({ error: '请输入有效的用户名和密码。' });
      }
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
      const hash = await scryptAsync(password, user?.salt || 'unknown-user-salt', 64);
      if (!user || !timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex'))) {
        return res.status(401).json({ error: '用户名或密码不正确。' });
      }
      loginAttempts.delete(key);
      const previous = sessionCookie(req);
      if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(previous));
      const rawToken = token();
      const lifetime = Math.min(Math.max(Number(sessionHours) || 8, 1), 72) * 3600000;
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(rawToken), user.id, now + lifetime);
      res.cookie('trace_session', rawToken, { ...cookieOptions, maxAge: lifetime });
      res.json({ user: { id: user.id, username: user.username } });
    } catch (error) { next(error); }
  });
  app.use('/api', authenticated);
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/logout', (req, res) => {
    const rawToken = sessionCookie(req);
    if (rawToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(rawToken));
    res.clearCookie('trace_session', cookieOptions);
    res.json({ ok: true });
  });

  const campaigns = createCampaignModule({ app, db, dataDirectory });
  const eventValues = (asOf = clock()) => calculateSnapshot(db.prepare('SELECT occurred_at, stage, severity FROM records').all(), asOf);
  const getValues = (asOf = clock()) => {
    const values = eventValues(asOf), contribution = campaigns.contribution(asOf);
    for (const period of PERIODS) {
      values[`logs_${period.key}`] += contribution.logs[period.key];
      values[`risks_${period.key}`] += contribution.risks[period.key];
      values[`incidents_${period.key}`] += contribution.incidents[period.key];
    }
    return values;
  };
  app.get('/api/overview', (req, res) => {
    const period = PERIODS.some(item => item.key === req.query.period) ? req.query.period : 'month';
    const asOf = clock();
    const start = periodStarts(asOf)[period];
    const from = Number.isFinite(start) ? new Date(start).toISOString() : '';
    const to = asOf.toISOString();
    const counts = getValues(asOf);
    const recent = db.prepare(`
      SELECT id,event_id,title,occurred_at,stage,COALESCE(event_severity,severity) AS severity,created_at FROM records
      WHERE occurred_at >= ? AND occurred_at <= ? AND stage IN ('violations','red_lines')
      ORDER BY CASE COALESCE(event_severity,severity) WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 ELSE 5 END,
      occurred_at DESC LIMIT 5
    `).all(from, to);
    res.json({ period, as_of: to, values: counts, recent, enabled: enabled(), event_values: eventValues(asOf), campaign_values: campaigns.contribution(asOf) });
  });
  app.get('/api/events', (req, res) => {
    const search = String(req.query.search || '').slice(0, 100);
    const stage = STAGES.some(item => item.key === req.query.stage) ? req.query.stage : '';
    const severity = /^P[0-4]$/.test(String(req.query.severity || '')) ? req.query.severity : '';
    const eventType = ALL_EVENT_TYPE_KEYS.includes(String(req.query.event_type || '').toUpperCase())
      ? String(req.query.event_type).toUpperCase() : '';
    const securityOwner = String(req.query.security_owner || '').trim().slice(0, 254);
    const dateQuery = value => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
      if (!match) return null;
      const [, year, month, day] = match;
      const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 ||
          calendar.getUTCDate() !== Number(day)) return null;
      return new Date(`${value}T00:00:00+08:00`);
    };
    const occurredFrom = dateQuery(req.query.occurred_from);
    const occurredTo = dateQuery(req.query.occurred_to);
    if ((req.query.occurred_from && !occurredFrom) || (req.query.occurred_to && !occurredTo)) {
      return res.status(400).json({ error: '发生时间筛选必须填写有效日期。' });
    }
    if (occurredFrom && occurredTo && occurredFrom > occurredTo) {
      return res.status(400).json({ error: '发生时间范围的起始日期不能晚于结束日期。' });
    }
    const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 1000000));
    const pageSize = Math.max(1, Math.min(parseInt(req.query.page_size, 10) || 20, 100));
    const sort = ['occurred_asc', 'occurred_desc', 'severity_asc', 'severity_desc'].includes(req.query.sort)
      ? req.query.sort : 'occurred_desc';
    const clauses = [];
    const params = [];
    if (search) {
      clauses.push("(event_id LIKE ? ESCAPE '\\' OR form_data LIKE ? ESCAPE '\\')");
      const escaped = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(escaped, escaped);
    }
    if (stage) { clauses.push('stage = ?'); params.push(stage); }
    if (severity) { clauses.push('COALESCE(event_severity,severity) = ?'); params.push(severity); }
    if (eventType) { clauses.push('event_type = ?'); params.push(eventType); }
    if (securityOwner) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(records.security_owners) AS owner WHERE owner.value = ?)');
      params.push(securityOwner);
    }
    if (occurredFrom && Number.isFinite(occurredFrom.getTime())) {
      clauses.push('occurred_at >= ?'); params.push(occurredFrom.toISOString());
    }
    if (occurredTo && Number.isFinite(occurredTo.getTime())) {
      const end = new Date(occurredTo.getTime() + 86400000);
      clauses.push('occurred_at < ?'); params.push(end.toISOString());
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const importance = `CASE COALESCE(event_severity,severity) WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 ELSE 5 END`;
    const stageImportance = "CASE stage WHEN 'red_lines' THEN 0 WHEN 'violations' THEN 1 WHEN 'incidents' THEN 2 WHEN 'risks' THEN 3 ELSE 4 END";
    const orderBy = sort === 'occurred_asc'
      ? 'occurred_at ASC, id ASC'
      : sort === 'severity_asc'
        ? `${importance} DESC, ${stageImportance} DESC, occurred_at DESC, id DESC`
        : sort === 'severity_desc'
          ? `${importance} ASC, ${stageImportance} ASC, occurred_at DESC, id DESC`
          : 'occurred_at DESC, id DESC';
    const total = db.prepare(`SELECT count(*) AS count FROM records ${where}`).get(...params).count;
    const rows = db.prepare(`SELECT id,event_id,title,event_type,occurred_at,stage,COALESCE(event_severity,severity) AS severity,created_at,updated_at,
      security_owners,incident_owners,redline_confirmation_asset_id FROM records ${where}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map(row => {
        return row;
    });
    res.json({ events: rows, total, page, page_size: pageSize, sort });
  });
  app.get('/api/events/options', (req, res) => {
    const owners = new Set(['admin']);
    for (const row of db.prepare('SELECT security_owners FROM records').all()) {
      for (const owner of json(row.security_owners) || []) if (typeof owner === 'string' && owner.trim()) owners.add(owner.trim());
    }
    const eventTypes = [...EVENT_TYPES];
    if (db.prepare("SELECT 1 FROM records WHERE event_type='IR' LIMIT 1").get()) {
      eventTypes.push({ key: 'IR', label: '应急响应（历史）', description: '仅供历史记录筛选' });
    }
    res.json({ event_types: eventTypes, security_owners: [...owners].sort((a, b) => a.localeCompare(b, 'zh-CN')) });
  });
  const fullReport = row => ({
    ...row, event_type: ALL_EVENT_TYPE_KEYS.includes(row.event_type) ? row.event_type : 'DLP',
    severity: row.event_severity || row.severity, discovered_at: row.occurred_at,
    security_owners: json(row.security_owners) || [], incident_owners: json(row.incident_owners) || [],
    redline_confirmation_asset: row.redline_confirmation_asset_id
      ? db.prepare('SELECT id,filename,mime,bytes,sha256 FROM event_assets WHERE id=?').get(row.redline_confirmation_asset_id) || null
      : null,
    ...Object.fromEntries(['security_risk','security_incident','security_violation','security_red_line'].map((key, index) => [key,
      STAGES.findIndex(item => item.key === row.stage) > index])),
  });
  app.get('/api/event-form', (req, res) => {
    const securityOwners = new Set(['admin']);
    for (const row of db.prepare('SELECT security_owners FROM records').all()) {
      for (const owner of json(row.security_owners) || []) {
        if (typeof owner === 'string' && owner.trim()) securityOwners.add(owner.trim());
      }
    }
    res.json({
      status: 'ready',
      fields: ['event_type','security_risk','security_incident','security_violation','security_red_line',
        'severity','redline_confirmation_asset_id','discovered_at','security_owners','incident_owners','description_html'],
      event_types: EVENT_TYPES,
      security_owner_options: [...securityOwners].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    });
  });
  app.get('/api/events/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '该事件不存在。' });
    res.json({ event: fullReport(row) });
  });
  const richAssetIds = html => [...new Set([...String(html || '').matchAll(/\/api\/event-assets\/([1-9][0-9]*)\/download/g)].map(match => Number(match[1])))];
  function verifyRichAssets(html, userId) {
    const ids = richAssetIds(html);
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const assets = db.prepare(`SELECT id,owner_user_id FROM event_assets WHERE id IN (${placeholders})`).all(...ids);
    if (assets.length !== ids.length || assets.some(asset => asset.owner_user_id !== userId)) {
      throw new FormError('详细描述中的附件无效，请重新上传后再保存。');
    }
    return ids;
  }
  function bindRichAssets(ids, eventId) {
    if (!ids?.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE event_assets SET event_id = ? WHERE id IN (${placeholders})`).run(eventId, ...ids);
  }
  function verifyRedlineConfirmationAsset(assetId, userId, isRedLine) {
    if (assetId == null) {
      if (isRedLine) return null;
      return null;
    }
    if (!isRedLine) throw new FormError('只有安全红线事件可以上传红线确认书。');
    const asset = db.prepare('SELECT * FROM event_assets WHERE id=? AND owner_user_id=?').get(assetId, userId);
    const allowedTypes = new Map([
      ['image/png', /\.png$/i], ['image/jpeg', /\.jpe?g$/i], ['image/gif', /\.gif$/i],
      ['image/webp', /\.webp$/i], ['application/pdf', /\.pdf$/i],
    ]);
    if (!asset || !allowedTypes.get(asset.mime)?.test(asset.filename)) {
      throw new FormError('红线确认书必须是当前用户上传的常见图片或 PDF 文件。');
    }
    const absolutePath = resolve(dataDirectory, asset.relative_path);
    if (!absolutePath.startsWith(resolve(dataDirectory) + '/') || !existsSync(absolutePath)) {
      throw new FormError('红线确认书文件不存在，请重新上传。');
    }
    return asset.id;
  }
  function nextEventTitleSequence(occurredAt, excludeId = null) {
    const bucket = eventTitleBucket(occurredAt);
    let max = 0;
    for (const row of db.prepare('SELECT id,occurred_at,title_seq,title FROM records').all()) {
      if (excludeId != null && row.id === excludeId) continue;
      if (eventTitleBucket(row.occurred_at) !== bucket) continue;
      const sequence = Number(row.title_seq) ||
        Number(/^\d{2}-[A-Z]{3}-[A-Z0-9]+-(\d{4})$/.exec(row.title || '')?.[1]) || 0;
      max = Math.max(max, sequence);
    }
    return max + 1;
  }
  function saveReportData(body, userId, existing = null) {
    const report = normalizeReport(body, { existingEventType: existing?.event_type });
    const assetIds = verifyRichAssets(report.description_html, userId);
    const confirmationId = verifyRedlineConfirmationAsset(report.security_red_line
      ? (Object.hasOwn(body, 'redline_confirmation_asset_id') ? report.redline_confirmation_asset_id : existing?.redline_confirmation_asset_id) || null
      : null, userId, report.security_red_line);
    const sameMonth = existing && eventTitleBucket(existing.occurred_at) === eventTitleBucket(report.occurred_at);
    const sequence = sameMonth && existing.title_seq > 0 ? existing.title_seq : nextEventTitleSequence(report.occurred_at, existing?.id);
    const title = formatEventTitle(report.occurred_at, report.event_type, sequence);
    if (!title) throw new FormError('无法根据发现时间生成事件标题，请检查发现时间。');
    const now = new Date().toISOString();
    const values = [title, report.event_type, sequence, report.occurred_at, report.stage, report.severity, report.severity,
      JSON.stringify(report.security_owners), JSON.stringify(report.incident_owners), report.description_html,
      JSON.stringify({...report, title, title_seq:sequence, redline_confirmation_asset_id:confirmationId}), now, confirmationId];
    let id;
    if (existing) {
      db.prepare(`UPDATE records SET title=?,event_type=?,title_seq=?,occurred_at=?,stage=?,severity=?,event_severity=?,
        security_owners=?,incident_owners=?,description_html=?,form_data=?,updated_at=?,redline_confirmation_asset_id=? WHERE id=?`)
        .run(...values, existing.id);
      id = existing.id;
    } else {
      const eventId = `EVT-${now.slice(0,10).replace(/-/g,'')}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const result = db.prepare(`INSERT INTO records (title,event_type,title_seq,occurred_at,stage,severity,event_severity,
        security_owners,incident_owners,description_html,form_data,updated_at,redline_confirmation_asset_id,event_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values,eventId,now);
      id = Number(result.lastInsertRowid);
    }
    bindRichAssets(assetIds,id);
    if (confirmationId) db.prepare('UPDATE event_assets SET event_id=? WHERE id=?').run(id,confirmationId);
    return fullReport(db.prepare('SELECT * FROM records WHERE id=?').get(id));
  }
  function saveReport(req, res, existing = null) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const event = saveReportData(req.body, req.user.id, existing);
      if (Object.hasOwn(req.body, 'campaign_links')) campaigns.setEventLinks(event.id, req.body.campaign_links, req.user.id);
      db.exec('COMMIT');
      res.status(existing ? 200 : 201).json({ event });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const reportingApi = createReportingApi({ db, setting, dataDirectory, saveReport: (body, userId) => saveReportData(body, userId) });
  reportingRouter = reportingApi.router;
  reportingApi.registerAdminRoutes(app);
  app.post('/api/events', (req, res) => saveReport(req, res));
  app.post('/api/events/batch', (req, res, next) => {
    try {
      const reports = Array.isArray(req.body?.reports)
        ? req.body.reports
        : Array.isArray(req.body?.rows) && req.body?.shared && typeof req.body.shared === 'object'
          ? req.body.rows.map(row => ({
            ...req.body.shared,
            ...row,
            description_html: String(row.description_html || '').trim() || req.body.shared.description_html || '',
          }))
          : null;
      if (!Array.isArray(reports) || !reports.length || reports.length > 100) {
        return res.status(400).json({ error: '批量建单需要提供 1–100 条事件。' });
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const events = reports.map(report => saveReportData(report, req.user.id));
        db.exec('COMMIT');
        res.status(201).json({ events });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) { next(error); }
  });
  app.delete('/api/events', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
        ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
      return res.status(400).json({ error: '请选择有效的事件记录。' });
    }
    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const existing = db.prepare(`SELECT id FROM records WHERE id IN (${placeholders})`).all(...uniqueIds);
    if (existing.length !== uniqueIds.length) {
      return res.status(404).json({ error: '部分事件记录不存在，列表可能已更新，请刷新后重试。' });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of uniqueIds) campaigns.detachEvent(id, req.user.id);
      db.prepare(`UPDATE event_assets SET event_id=NULL WHERE event_id IN (${placeholders})`).run(...uniqueIds);
      db.prepare(`DELETE FROM records WHERE id IN (${placeholders})`).run(...uniqueIds);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ ok: true, deleted: uniqueIds.length });
  });
  app.put('/api/events/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '该事件不存在。' });
    saveReport(req, res, row);
  });
  app.post('/api/event-assets', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '上传文件不能为空。' });
      if (req.body.length > 20 * 1024 * 1024) return res.status(413).json({ error: '单个附件不能超过 20 MB。' });
      let filename = '';
      try { filename = decodeURIComponent(String(req.get('X-File-Name') || '')); } catch { filename = ''; }
      filename = basename(filename).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 200);
      const mime = String(req.get('X-File-Type') || 'application/octet-stream').toLowerCase().split(';')[0];
      const purpose = String(req.get('X-Asset-Purpose') || 'rich-text').trim().toLowerCase();
      const extension = /\.([a-z0-9]{1,10})$/i.exec(filename)?.[1]?.toLowerCase() || '';
      const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      const isImage = imageTypes.has(mime) && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension);
      const isZip = extension === 'zip' && ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(mime) &&
        req.body.subarray(0, 2).equals(Buffer.from('PK'));
      const isPdf = extension === 'pdf' && ['application/pdf', 'application/octet-stream'].includes(mime) &&
        req.body.subarray(0, 5).equals(Buffer.from('%PDF-'));
      const isDoc = extension === 'doc' && ['application/msword', 'application/octet-stream'].includes(mime) &&
        req.body.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      const isDocx = extension === 'docx' &&
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'].includes(mime) &&
        req.body.subarray(0, 2).equals(Buffer.from('PK'));
      let isText = false;
      if (extension === 'txt' && ['text/plain', 'application/octet-stream'].includes(mime)) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(req.body); isText = true; } catch { isText = false; }
      }
      const signatures = new Map([
        ['image/png', { extensions: ['png'], bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
        ['image/jpeg', { extensions: ['jpg', 'jpeg'], bytes: Buffer.from([0xff, 0xd8, 0xff]) }],
        ['image/gif', { extensions: ['gif'], bytes: Buffer.from('GIF8') }],
        ['image/webp', { extensions: ['webp'], bytes: Buffer.from('RIFF'), offset: 0 }],
        ['application/pdf', { extensions: ['pdf'], bytes: Buffer.from('%PDF-') }],
      ]);
      const confirmationType = signatures.get(mime);
      const signatureMatches = confirmationType && confirmationType.extensions.includes(extension) &&
        req.body.subarray(confirmationType.offset || 0, (confirmationType.offset || 0) + confirmationType.bytes.length).equals(confirmationType.bytes) &&
        (mime !== 'image/webp' || req.body.subarray(8, 12).equals(Buffer.from('WEBP')));
      if (purpose === 'redline-confirmation' && (!filename || !signatureMatches)) {
        return res.status(400).json({ error: '红线确认书仅支持真实的 PNG、JPG、GIF、WEBP 图片或 PDF 文件。' });
      }
      if (purpose === 'redline-confirmation' && req.body.length > 10 * 1024 * 1024) {
        return res.status(413).json({ error: '红线确认书不能超过 10 MB。' });
      }
      if (purpose !== 'redline-confirmation' && (!filename || (!isImage && !isZip && !isPdf && !isDoc && !isDocx && !isText))) {
        return res.status(400).json({ error: '仅支持 PNG、JPG、GIF、WEBP 图片、ZIP、DOC、DOCX、PDF 或 TXT 文件。' });
      }
      const sha256 = createHash('sha256').update(req.body).digest('hex');
      await mkdir(eventAssetDirectory, { recursive: true, mode: 0o700 });
      const relativePath = join('integrations', 'event-assets', `${sha256.slice(0, 24)}-${randomBytes(8).toString('hex')}.${extension}`);
      const absolutePath = join(dataDirectory, relativePath);
      const temporary = `${absolutePath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, req.body, { mode: 0o600 });
      await rename(temporary, absolutePath);
      try {
        const assetMime = purpose === 'redline-confirmation' ? mime
          : isImage ? mime
            : isZip ? 'application/zip'
              : isPdf ? 'application/pdf'
                : isDoc ? 'application/msword'
                  : isDocx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    : 'text/plain';
        const result = db.prepare(`INSERT INTO event_assets
          (owner_user_id,event_id,filename,mime,bytes,sha256,relative_path,created_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(req.user.id, null, filename, assetMime,
          req.body.length, sha256, relativePath, new Date().toISOString());
        const id = Number(result.lastInsertRowid);
        res.status(201).json({ id, filename, mime: assetMime, bytes: req.body.length,
          url: `/api/event-assets/${id}/download`,
          kind: assetMime.startsWith('image/') ? 'image' : assetMime === 'application/pdf' ? 'pdf'
            : assetMime === 'application/zip' ? 'zip' : 'document', purpose });
      } catch (error) {
        await unlink(absolutePath).catch(() => {});
        throw error;
      }
    } catch (error) { next(error); }
  });
  app.get('/api/event-assets/:id/download', async (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM event_assets WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: '事件附件不存在。' });
      const absolutePath = resolve(dataDirectory, row.relative_path);
      if (!absolutePath.startsWith(resolve(dataDirectory) + '/') || !existsSync(absolutePath)) return res.status(404).json({ error: '事件附件文件不存在。' });
      const disposition = row.mime.startsWith('image/') || row.mime === 'application/pdf' ? 'inline' : 'attachment';
      res.type(row.mime).setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
      res.send(await readFile(absolutePath));
    } catch (error) { next(error); }
  });
  app.delete('/api/event-assets/:id', async (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM event_assets WHERE id=? AND owner_user_id=?').get(req.params.id, req.user.id);
      if (!row) return res.status(404).json({ error: '事件附件不存在。' });
      db.prepare('UPDATE records SET redline_confirmation_asset_id=NULL WHERE redline_confirmation_asset_id=?').run(row.id);
      const absolutePath = resolve(dataDirectory, row.relative_path);
      if (!absolutePath.startsWith(resolve(dataDirectory) + '/')) return res.status(400).json({ error: '附件路径无效，未执行删除。' });
      await unlink(absolutePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      db.prepare('DELETE FROM event_assets WHERE id=?').run(row.id);
      res.json({ ok: true, id: row.id });
    } catch (error) { next(error); }
  });
  app.get('/api/model', (req, res) => res.json({
    enabled: enabled(),
    layers: db.prepare('SELECT id,name,metric,period,is_system FROM layers WHERE is_system = 1 ORDER BY rowid').all(),
    values: getValues(),
    snapshots: db.prepare('SELECT id, created_at FROM snapshots ORDER BY id DESC LIMIT 10').all(),
    timezone: 'Asia/Shanghai',
  }));
  app.patch('/api/model', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: '开关值必须为 true 或 false。' });
    db.exec('BEGIN IMMEDIATE');
    try {
      if (req.body.enabled) createSystemLayers();
      db.prepare("UPDATE settings SET value = ? WHERE key = 'default_funnel_enabled'").run(String(req.body.enabled));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ enabled: enabled(), count: db.prepare('SELECT count(*) AS count FROM layers WHERE is_system = 1').get().count });
  });
  app.get('/api/funnels/custom/layers', (req, res) => {
    res.json({ layers: db.prepare('SELECT id,name,metric,period FROM layers WHERE is_system = 0 ORDER BY rowid').all() });
  });
  app.delete('/api/funnels/layers/:id', (req, res) => {
    const layer = db.prepare('SELECT * FROM layers WHERE id = ?').get(req.params.id);
    if (!layer) return res.status(404).json({ error: '该漏斗层不存在。' });
    if (layer.is_system) return res.status(403).json({ error: '默认周期漏斗为系统层，不可删除。' });
    db.prepare('DELETE FROM layers WHERE id = ? AND is_system = 0').run(layer.id);
    res.json({ ok: true });
  });
  function freezeCurrentValues(asOf = clock()) {
    const values = getValues(asOf);
    const createdAt = asOf.toISOString();
    const result = db.prepare('INSERT INTO snapshots (created_at,values_json) VALUES (?,?)').run(createdAt, JSON.stringify(values));
    return { id: Number(result.lastInsertRowid), created_at: createdAt, timezone: 'Asia/Shanghai', values };
  }
  app.post('/api/snapshots', (req, res) => res.status(201).json(freezeCurrentValues()));
  app.get('/api/snapshots/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '该快照不存在。' });
    res.json({ id: row.id, created_at: row.created_at, timezone: 'Asia/Shanghai', values: safeJSON(row.values_json) });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use((error, req, res, next) => {
    if (!req.path.startsWith('/api/')) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大。' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: '请求格式不正确。' });
    if (error instanceof FormError) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    console.error('API error:', error.message);
    res.status(500).json({ error: '操作失败，请稍后重试。' });
  });
  return { app, db, close: () => { clearInterval(pruneTimer); db.close(); } };
}
