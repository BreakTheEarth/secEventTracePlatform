import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../server/app.mjs';
import { EVENT_TYPE_KEYS } from '../shared/model.mjs';
import { isOwnerIdentifier } from '../shared/owners.mjs';
import { createBatchTemplate, parseBatchXlsx } from '../src/batch-xlsx.js';
import ExcelJS from 'exceljs';

const event = (changes = {}) => ({
  event_type: 'DLP', discovered_at: '2026-10-22T10:00:00+08:00',
  security_risk: true, security_incident: true, security_violation: false, security_red_line: false,
  severity: null, security_owners: ['admin'], incident_owners: ['owner@example.com'], description_html: '',
  ...changes,
});

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trace-beta-test-'));
  const path = join(directory, 'test.sqlite');
  const platform = createPlatform({ databasePath: path, adminUsername: 'admin', adminPassword: 'test-password' });
  const server = platform.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) =>
    fetch(origin + '/api' + path, {
      method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  const login = await req('/auth/login', { username: 'admin', password: 'test-password' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    platform.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const json = async (path, body, method, headers) => {
    const response = await req(path, body, method, headers);
    const data = await response.json();
    assert.ok(response.ok, `${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  return { platform, req, json, origin, directory };
}

test('authentication protects business data; logout invalidates the isolated cookie', async t => {
  const { req, origin } = await setup(t);
  assert.equal((await fetch(origin + '/api/events')).status, 401);
  const health = await (await fetch(origin + '/api/health')).json();
  assert.equal(health.version, '0.1.0-beta.1');
  assert.equal((await req('/auth/me')).status, 200);
  await req('/auth/logout', {});
  assert.equal((await req('/events')).status, 401);
});

test('removed integrations have no routes or database tables', async t => {
  const { req, platform } = await setup(t);
  for (const path of ['/dashboard/config', '/dashboard/schedule', '/dashboard/push', '/dashboard/push/1', '/dlp/config', '/logs/lookup', '/logs/x/template', '/attachments/1/download', '/attachments/1']) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      assert.equal((await req(path, method === 'GET' ? undefined : {}, method)).status, 404, `${method} ${path}`);
    }
  }
  const tables = platform.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(!tables.some(name => ['log_fetches', 'attachments', 'scheduled_pushes'].includes(name)));
  const columns = platform.db.prepare('PRAGMA table_info(records)').all().map(row => row.name);
  assert.ok(!columns.some(name => ['log_id', 'log_fetch_id', 'log_detail_json', 'attachments_json'].includes(name)));
  assert.equal(platform.scheduler, undefined);
});

test('admin defaults work in single events, campaign leads, tasks and candidate lists', async t => {
  const { json } = await setup(t);
  const saved = (await json('/events', event())).event;
  assert.deepEqual(saved.security_owners, ['admin']);
  assert.ok(!Object.hasOwn(saved, 'log_id'));
  assert.ok((await json('/events/options')).security_owners.includes('admin'));
  const c = (await json('/campaigns', {
    lead_owner: 'admin', target_scope: '全公司', importance: 'P0', type: '漏洞修复',
    occurred_at: '2026-10-22T09:00:00+08:00', due_at: '2026-11-15T18:00:00+08:00',
    description_html: '<p>组件排查</p>', tasks: [{ title: '排查服务', owner: 'admin', due_at: null }],
  })).campaign;
  assert.equal(c.lead_owner, 'admin');
  assert.equal(c.tasks[0].owner, 'admin');
  assert.equal(c.tasks[0].due_at, null);
  assert.ok(isOwnerIdentifier('admin'));
  assert.ok(isOwnerIdentifier('owner@example.com'));
  for (const invalid of ['', 'not-an-email', 'a@@example.com', 'admin,user']) assert.ok(!isOwnerIdentifier(invalid));
});

test('all manual event types can be recorded without external queries', async t => {
  const { json } = await setup(t);
  for (const type of EVENT_TYPE_KEYS) {
    const saved = (await json('/events', event({ event_type: type }))).event;
    assert.equal(saved.event_type, type);
    assert.match(saved.title, new RegExp(`^26-OCT-${type}-\\d{4}$`));
    assert.match(saved.event_id, /^EVT-/);
  }
  const page = await json('/events?page_size=100');
  assert.equal(page.total, EVENT_TYPE_KEYS.length);
});

test('four-level classification, red-line grades and removed fields are validated', async t => {
  const { req, json } = await setup(t);
  for (const changes of [
    { security_risk: false }, { security_owners: [] }, { incident_owners: ['invalid'] },
    { discovered_at: '2026-02-30T10:00:00' }, { security_violation: true, security_red_line: true, severity: null },
    { log_id: 'example-id' },
  ]) assert.equal((await req('/events', event(changes))).status, 400);
  const saved = (await json('/events', event({ security_violation: true, security_red_line: true, severity: 'P1' }))).event;
  assert.equal(saved.stage, 'red_lines');
  const edited = (await json(`/events/${saved.id}`, event({ severity: 'P0' }), 'PUT')).event;
  assert.equal(edited.stage, 'incidents');
  assert.equal(edited.severity, null);
});

test('search, exact owners, date boundaries and page sizes work', async t => {
  const { json } = await setup(t);
  await json('/events', event({ description_html: '<p>service%_finding</p>', discovered_at: '2026-10-22T23:59:59+08:00' }));
  await json('/events', event({ security_owners: ['other@example.com'], discovered_at: '2026-10-23T00:00:00+08:00' }));
  assert.equal((await json('/events?search=service%25_')).total, 1);
  assert.equal((await json('/events?security_owner=admin')).total, 1);
  assert.equal((await json('/events?security_owner=ad')).total, 0);
  assert.equal((await json('/events?occurred_from=2026-10-22&occurred_to=2026-10-22')).total, 1);
  assert.equal((await json('/events?page_size=500')).page_size, 100);
});

test('batch creation is atomic and accepts admin across complete rows', async t => {
  const { req, json } = await setup(t);
  assert.equal((await req('/events/batch', { reports: [event(), event({ security_owners: [] })] })).status, 400);
  assert.equal((await json('/events')).total, 0);
  const result = await json('/events/batch', { reports: [event(), event({ event_type: 'HIDS' })] });
  assert.equal(result.events.length, 2);
  assert.notEqual(result.events[0].title, result.events[1].title);
});

test('XLSX accepts admin without requiring an email for the default security owner', async () => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await createBatchTemplate({ securityOwners: ['admin'] }));
  book.getWorksheet('批量建单').addRow(['2026-10-22 10:00:00', 'DLP', 'admin', 'owner@example.com', '是', '是', '否', '否', '', '手动记录']);
  const rows = await parseBatchXlsx(await book.xlsx.writeBuffer());
  assert.equal(rows[0].security_owners, 'admin');
});

test('local snapshots retain all 50 fields and remain frozen after deletion', async t => {
  const { json } = await setup(t);
  const saved = (await json('/events', event({ security_violation: true, security_red_line: true, severity: 'P0' }))).event;
  const snapshot = await json('/snapshots', {});
  assert.equal(Object.keys(snapshot.values).length, 50);
  assert.equal(snapshot.values.redline_p0_all, 1);
  await json('/events', { ids: [saved.id] }, 'DELETE');
  assert.equal((await json('/overview')).values.logs_all, 0);
  assert.equal((await json(`/snapshots/${snapshot.id}`)).values.redline_p0_all, 1);
});

test('text API keys support admin, idempotence, rotation and removal', async t => {
  const { json, req, origin } = await setup(t);
  const key = (await json('/reporting/keys', { name: 'Generic test integration', tags: ['test'] })).key;
  const token = (await json(`/reporting/keys/${key.id}/copy`, {})).token;
  await json('/reporting/config', { enabled: true }, 'PATCH');
  const payload = { ...event(), description_text: 'Test event' };
  delete payload.description_html;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'test-event-1' };
  const send = body => fetch(origin + '/api/v1/events', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await send(payload)).status, 201);
  const repeated = await send(payload);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).replayed, true);
  assert.equal((await send({ ...payload, description_text: 'changed' })).status, 409);
  assert.equal((await send({ ...payload, log_id: 'extra' })).status, 400);
  assert.equal((await json('/events')).total, 1);
  await json(`/reporting/keys/${key.id}/rotate`, {});
  assert.equal((await send(payload)).status, 401);
  await json(`/reporting/keys/${key.id}`, undefined, 'DELETE');
  assert.equal((await json('/reporting/config')).enabled, false);
  assert.equal((await req('/reporting/skill')).status, 200);
});

test('attachments and confirmation files remain private and bound-event deletion succeeds', async t => {
  const { req, json, origin, directory } = await setup(t);
  const pdf = Buffer.from('%PDF-1.4\nsample test data\n');
  const headers = { 'X-File-Name': 'confirmation.pdf', 'X-File-Type': 'application/pdf', 'X-Asset-Purpose': 'redline-confirmation' };
  const asset = await json('/event-assets', pdf, 'POST', headers);
  assert.equal((await fetch(origin + asset.url)).status, 401);
  const saved = (await json('/events', event({ security_violation: true, security_red_line: true, severity: 'P2', redline_confirmation_asset_id: asset.id }))).event;
  assert.equal(saved.redline_confirmation_asset.id, asset.id);
  assert.equal((await req(`/event-assets/${asset.id}/download`)).status, 200);
  await json('/events', { ids: [saved.id] }, 'DELETE');
  assert.equal((await json('/events')).total, 0);
  await json(`/event-assets/${asset.id}`, undefined, 'DELETE');
  assert.equal((await req(`/event-assets/${asset.id}/download`)).status, 404);
  assert.ok(directory);
});

test('HTML cleaning rejects scripts and external images while retaining supported text', async t => {
  const { json } = await setup(t);
  const saved = (await json('/events', event({ description_html: '<p><strong>Evidence</strong></p><script>bad()</script><img src="https://example.com/x.png"><a href="javascript:bad()">link</a>' }))).event;
  assert.match(saved.description_html, /<strong>Evidence/);
  assert.doesNotMatch(saved.description_html, /<script|javascript:|<img/);
});

test('public source defaults do not expose removed integration controls', () => {
  const source = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /defaultSecurityOwner = 'admin'/);
  assert.match(source, /security_owners: 'admin'/);
  assert.doesNotMatch(source, /获取 DLP 日志|DLP 日志 ID|推送到|定时推送计划|关联日志查询配置|附件会自动下载|获取日志时/);
  const campaignSource = readFileSync(new URL('../src/campaigns.jsx', import.meta.url), 'utf8');
  assert.match(campaignSource, /lead_owner:initial\?\.lead_owner\|\|'admin'/);
});
