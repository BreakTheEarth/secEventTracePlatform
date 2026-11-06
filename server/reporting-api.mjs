import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import { dirname, join } from 'node:path';
import { normalizeReport, FormError } from './report.mjs';

const FIELDS = ['event_type', 'discovered_at', 'security_risk', 'security_incident', 'security_violation',
  'security_red_line', 'severity', 'security_owners', 'incident_owners', 'description_text'];
const hash = value => createHash('sha256').update(value).digest('hex');
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function parseApiReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FormError('仅支持一个事件 JSON 对象，不支持数组或批量上报。');
  const unknown = Object.keys(body).filter(key => !FIELDS.includes(key));
  if (unknown.length) throw new FormError(`不支持的字段：${unknown.join('、')}。仅支持文本，不接收日志、文件或附件字段。`);
  const missing = FIELDS.filter(key => key !== 'severity' && !Object.hasOwn(body, key));
  if (missing.length) throw new FormError(`缺少必填字段：${missing.join('、')}。`);
  if (typeof body.event_type !== 'string' || !body.event_type.trim()) throw new FormError('请明确填写事件类型 event_type。');
  if (typeof body.description_text !== 'string' || !body.description_text.trim() ||
      Buffer.byteLength(body.description_text) > 256 * 1024) throw new FormError('详细文本不能为空，且不能超过 256 KB。');
  if (!body.security_red_line && body.severity != null) throw new FormError('非红线事件 severity 必须为 null 或省略，避免等级被忽略。');
  const report = { ...body, description_html: `<p>${escapeText(body.description_text).replace(/\r\n|\r|\n/g, '<br>')}</p>` };
  normalizeReport(report);
  return report;
}

export function createReportingApi({ db, setting, saveReport, dataDirectory }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reporting_api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
      token_hash TEXT UNIQUE NOT NULL, token_hint TEXT NOT NULL, created_at TEXT NOT NULL,
      rotated_at TEXT NOT NULL, last_used_at TEXT, token_encrypted TEXT
    );
    CREATE TABLE IF NOT EXISTS api_reports (
      record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
      idempotency_key TEXT UNIQUE, request_hash TEXT NOT NULL,
      submitted_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const keyColumns = new Set(db.prepare('PRAGMA table_info(reporting_api_keys)').all().map(column => column.name));
  if (!keyColumns.has('token_encrypted')) db.exec('ALTER TABLE reporting_api_keys ADD COLUMN token_encrypted TEXT');
  const legacyHash = setting('reporting_api_token_hash');
  if (legacyHash && !db.prepare('SELECT 1 FROM reporting_api_keys WHERE token_hash=?').get(legacyHash)) {
    const legacyTimestamp = setting('reporting_api_rotated_at') || new Date().toISOString();
    db.prepare(`INSERT INTO reporting_api_keys(id,name,tags_json,token_hash,token_hint,created_at,rotated_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), '旧版 API 密钥', '[]', legacyHash,
        setting('reporting_api_token_hint') || '旧密钥（仅历史）', legacyTimestamp, legacyTimestamp);
  }
  if (legacyHash) db.prepare("DELETE FROM settings WHERE key IN ('reporting_api_token_hash','reporting_api_token_hint','reporting_api_rotated_at')").run();
  const set = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  let encryptionKey = null;
  function getEncryptionKey() {
    if (encryptionKey) return encryptionKey;
    if (!dataDirectory) return (encryptionKey = randomBytes(32));
    const keyPath = join(dataDirectory, 'integrations', 'reporting-api.key');
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    try {
      encryptionKey = readFileSync(keyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const created = randomBytes(32);
      try { writeFileSync(keyPath, created, { flag: 'wx', mode: 0o600 }); encryptionKey = created; }
      catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        encryptionKey = readFileSync(keyPath);
      }
    }
    if (encryptionKey.length !== 32) throw new Error('事件 API 密钥加密文件格式无效。');
    chmodSync(keyPath, 0o600);
    return encryptionKey;
  }
  const encryptToken = raw => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
  };
  const decryptToken = value => {
    const [iv, tag, encrypted] = String(value || '').split('.').map(part => Buffer.from(part, 'base64url'));
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !encrypted?.length) throw new FormError('此密钥无法恢复，请重新生成。');
    try {
      const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch { throw new FormError('密钥加密校验失败，请重新生成此密钥。'); }
  };
  const listKeys = () => db.prepare('SELECT id,name,tags_json,token_hint,created_at,rotated_at,last_used_at FROM reporting_api_keys ORDER BY created_at,id')
    .all().map(row => ({ ...row, tags: JSON.parse(row.tags_json) || [] }));
  const config = () => ({
    enabled: setting('reporting_api_enabled') === 'true',
    configured: Boolean(db.prepare('SELECT 1 FROM reporting_api_keys LIMIT 1').get()),
    key_count: db.prepare('SELECT count(*) AS n FROM reporting_api_keys').get().n,
    endpoint: '/api/v1/events',
  });
  const router = Router();
  router.use((req, res, next) => {
    const raw = /^Bearer ([A-Za-z0-9_-]{20,200})$/i.exec(req.get('Authorization') || '')?.[1];
    const expected = raw && db.prepare('SELECT id,token_hash FROM reporting_api_keys WHERE token_hash=?').get(hash(raw));
    if (!expected || expected.token_hash.length !== 64 || !timingSafeEqual(Buffer.from(hash(raw)), Buffer.from(expected.token_hash))) {
      return res.status(401).json({ error: '缺少或无效的事件上报 API 密钥。' });
    }
    if (!config().enabled) return res.status(403).json({ error: '事件上报 API 已关闭。' });
    db.prepare('UPDATE reporting_api_keys SET last_used_at=? WHERE id=?').run(new Date().toISOString(), expected.id);
    next();
  });
  router.post('/events', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: '仅支持 Content-Type: application/json 的文本事件，不支持上传文件。' });
    const report = parseApiReport(req.body);
    const key = req.get('Idempotency-Key') || null;
    if (key !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new FormError('Idempotency-Key 须为 1–128 位字母、数字或 . _ : -。');
    const requestHash = hash(JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, req.body[field] ?? null]))));
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = key && db.prepare('SELECT * FROM api_reports WHERE idempotency_key=?').get(key);
      if (previous) {
        db.exec('COMMIT');
        if (previous.request_hash !== requestHash) return res.status(409).json({ error: '该 Idempotency-Key 已用于不同的上报内容，请检查请求或为新事件使用新标识。' });
        return res.status(200).json({ ...JSON.parse(previous.response_json), replayed: true });
      }
      const event = saveReport(report, null);
      const response = { event: { id: event.id, event_id: event.event_id, title: event.title,
        ...req.body, severity: event.severity, created_at: event.created_at }, replayed: false };
      db.prepare('INSERT INTO api_reports(record_id,idempotency_key,request_hash,submitted_json,response_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(event.id, key, requestHash, JSON.stringify(req.body), JSON.stringify(response), event.created_at);
      const saved = JSON.parse(event.form_data);
      db.prepare('UPDATE records SET form_data=? WHERE id=?')
        .run(JSON.stringify({ ...saved, source: 'api', submitted_fields: req.body }), event.id);
      db.exec('COMMIT');
      return res.status(201).json(response);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  router.use((req, res) => res.status(404).json({ error: '事件上报 API 仅开放 POST /api/v1/events。' }));

  function registerAdminRoutes(app) {
    app.get('/api/reporting/config', (req, res) => res.json(config()));
    app.get('/api/reporting/keys', (req, res) => res.json({ keys: listKeys() }));
    app.patch('/api/reporting/config', (req, res) => {
      if (typeof req.body?.enabled !== 'boolean') throw new FormError('开关值必须为 true 或 false。');
      if (req.body.enabled && !config().configured) throw new FormError('请先生成至少一个 API 密钥，再开启事件上报。');
      set('reporting_api_enabled', String(req.body.enabled));
      res.json(config());
    });
    const makeKey = (name, tags, existingId = null) => {
      const raw = `evt_${randomBytes(32).toString('base64url')}`;
      const now = new Date().toISOString();
      const id = existingId || randomUUID();
      const hint = `${raw.slice(0, 7)}…${raw.slice(-4)}`;
      if (existingId) {
        db.prepare(`UPDATE reporting_api_keys SET name=?,tags_json=?,token_hash=?,token_hint=?,rotated_at=?,last_used_at=NULL,token_encrypted=? WHERE id=?`)
          .run(name, JSON.stringify(tags), hash(raw), hint, now, encryptToken(raw), id);
      } else {
        db.prepare(`INSERT INTO reporting_api_keys(id,name,tags_json,token_hash,token_hint,created_at,rotated_at,token_encrypted)
          VALUES (?,?,?,?,?,?,?,?)`).run(id, name, JSON.stringify(tags), hash(raw), hint, now, now, encryptToken(raw));
      }
      return { id };
    };
    const parseMetadata = body => {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80 || /[\r\n\0]/.test(name)) throw new FormError('API 名称须为 1–80 个字符，且不能包含换行。');
      const rawTags = body.tags === undefined ? [] : body.tags;
      if (!Array.isArray(rawTags) || rawTags.length > 20 || rawTags.some(tag => typeof tag !== 'string' || tag.trim().length > 40 || /[\r\n\0]/.test(tag))) {
        throw new FormError('标签须为最多 20 个文本标签，每个不超过 40 个字符。');
      }
      const tags = [...new Set(rawTags.map(tag => tag.trim()).filter(Boolean))];
      return { name, tags };
    };
    app.post('/api/reporting/keys', (req, res) => {
      const { name, tags } = parseMetadata(req.body);
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = makeKey(name, tags);
        db.exec('COMMIT');
        const created = listKeys().find(key => key.id === result.id);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(201).json({ key: created });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    app.patch('/api/reporting/keys/:id', (req, res) => {
      const existing = db.prepare('SELECT id FROM reporting_api_keys WHERE id=?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: '该 API 密钥不存在或已删除。' });
      const { name, tags } = parseMetadata(req.body);
      db.prepare('UPDATE reporting_api_keys SET name=?,tags_json=? WHERE id=?').run(name, JSON.stringify(tags), existing.id);
      res.json({ key: listKeys().find(key => key.id === existing.id) });
    });
    app.post('/api/reporting/keys/:id/copy', (req, res) => {
      const row = db.prepare('SELECT token_encrypted,token_hash FROM reporting_api_keys WHERE id=?').get(req.params.id);
      if (!row) return res.status(404).json({ error: '该 API 密钥不存在或已删除。' });
      if (!row.token_encrypted) throw new FormError('此旧密钥无法复制，请先重新生成该密钥。');
      const tokenValue = decryptToken(row.token_encrypted);
      if (hash(tokenValue) !== row.token_hash) throw new FormError('密钥校验失败，请重新生成该密钥。');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ token: tokenValue });
    });
    app.post('/api/reporting/keys/:id/rotate', (req, res) => {
      const existing = db.prepare('SELECT id,name,tags_json FROM reporting_api_keys WHERE id=?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: '该 API 密钥不存在或已删除。' });
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = makeKey(existing.name, JSON.parse(existing.tags_json) || [], existing.id);
        db.exec('COMMIT');
        const rotated = listKeys().find(key => key.id === result.id);
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ key: rotated });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    app.delete('/api/reporting/keys/:id', (req, res) => {
      const result = db.prepare('DELETE FROM reporting_api_keys WHERE id=?').run(req.params.id);
      if (!result.changes) return res.status(404).json({ error: '该 API 密钥不存在或已删除。' });
      if (db.prepare('SELECT count(*) AS n FROM reporting_api_keys').get().n === 0) set('reporting_api_enabled', 'false');
      res.json({ ok: true, id: req.params.id, ...config() });
    });
    app.delete('/api/reporting/keys', (req, res) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        set('reporting_api_enabled', 'false');
        db.prepare('DELETE FROM reporting_api_keys').run();
        db.prepare("DELETE FROM settings WHERE key IN ('reporting_api_token_hash','reporting_api_token_hint','reporting_api_rotated_at')").run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      res.json(config());
    });
    app.get('/api/reporting/skill', async (req, res, next) => {
      try {
        const document = await readFile(new URL('../docs/skills/report-security-event/SKILL.md', import.meta.url), 'utf8');
        res.type('text/markdown').attachment('SKILL.md').send(document);
      } catch (error) { next(error); }
    });
  }
  return { router, registerAdminRoutes };
}
