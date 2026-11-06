import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { batchTextHtml, createBatchTemplate, parseBatchXlsx } from '../src/batch-xlsx.js';
import { EVENT_TYPES } from '../shared/model.mjs';

async function filledTemplate(rows, options = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createBatchTemplate());
  if (options.date1904) workbook.properties.date1904 = true;
  workbook.getWorksheet('批量建单').addRows(rows);
  return workbook.xlsx.writeBuffer();
}

test('XLSX 模板有统一列名、动态选项下拉和填写说明，不把示例数据作为工单导入', async () => {
  const buffer = await createBatchTemplate({ securityOwners: ['security.a@example.com', 'security.b@example.com'] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['批量建单', '选项', '填写说明']);
  assert.deepEqual(workbook.getWorksheet('批量建单').getRow(1).values.slice(1),
    ['发现时间', '事件类型', '安全负责人', '事件负责人', '安全风险', '安全事件', '安全违规', '安全红线', '事件等级', '详细内容']);
  assert.equal(workbook.getWorksheet('批量建单').getCell('B2').dataValidation.type, 'list');
  assert.equal(workbook.getWorksheet('批量建单').getCell('B2').dataValidation.formulae[0], 'EventTypeOptions');
  assert.equal(workbook.getWorksheet('批量建单').getCell('B101').dataValidation.errorStyle, 'stop');
  assert.equal(workbook.getWorksheet('批量建单').getCell('C2').dataValidation.formulae[0], 'SecurityOwnerOptions');
  assert.equal(workbook.getWorksheet('批量建单').getCell('C2').dataValidation.showErrorMessage, undefined);
  assert.equal(workbook.getWorksheet('批量建单').getCell('E2').dataValidation.formulae[0], 'RiskDecisionOptions');
  assert.match(workbook.getWorksheet('批量建单').getCell('F2').dataValidation.formulae[0], /E2/);
  assert.match(workbook.getWorksheet('批量建单').getCell('I2').dataValidation.formulae[0], /H2/);
  assert.equal(workbook.getWorksheet('批量建单').getCell('I2').dataValidation.formulae[0], '=IF(H2="是",SeverityOptions,BlankSeverityOptions)');
  assert.equal(workbook.definedNames.getRanges('BlankSeverityOptions').ranges[0], "'选项'!$F$3");
  assert.equal(workbook.getWorksheet('选项').getCell('F3').text, '');
  assert.equal(workbook.definedNames.getRanges('EventTypeOptions').ranges[0], `'选项'!$B$2:$B$${EVENT_TYPES.length + 1}`);
  assert.deepEqual(workbook.getWorksheet('选项').getColumn(2).values.slice(2), EVENT_TYPES.map(item => item.key));
  assert.equal(workbook.getWorksheet('选项').getCell('A2').text, 'security.a@example.com');
  assert.equal(workbook.getWorksheet('选项').getCell('B2').text, 'DLP');
  assert.match(workbook.getWorksheet('填写说明').getCell('B8').text, /创建事件后可逐条编辑/);
  assert.match(workbook.getWorksheet('填写说明').getCell('B3').text, /每行必填：发现时间、事件类型、安全负责人、事件负责人/);
  await assert.rejects(parseBatchXlsx(buffer), /至少需要填写一条事件/);
});

test('Excel 文本、日期时间和富文本负责人均按显示内容导入，保留换行和空白覆盖内容', async () => {
  const buffer = await filledTemplate([
    ['2026-10-20 10:11:12', 'RASP', 'security.one@example.com', 'zhangsan@example.com', '是', '是', '否', '否', '', ''],
    [new Date('2026-10-20T11:22:33Z'), 'MAIL', { richText: [{ text: 'security.two' }, { text: '@example.com' }] }, { richText: [{ text: 'lisi' }, { text: '@example.com' }] }, '是', '是', '否', '否', '', '第一行\n第二行 <说明>'],
    ['2026-10-21 12:00:00', '威胁情报', 'intel@example.com', 'wangwu@example.com', '是', '是', '是', '是', 'P2', '情报预警'],
  ]);
  assert.deepEqual(await parseBatchXlsx(buffer), [
    { discovered_at: '2026-10-20T10:11:12', event_type: 'RASP', security_owners: 'security.one@example.com', incident_owners: 'zhangsan@example.com', security_risk: true, security_incident: true, security_violation: false, security_red_line: false, severity: '', description_html: '' },
    { discovered_at: '2026-10-20T11:22:33', event_type: 'MAIL', security_owners: 'security.two@example.com', incident_owners: 'lisi@example.com', security_risk: true, security_incident: true, security_violation: false, security_red_line: false, severity: '', description_html: '第一行\n第二行 <说明>' },
    { discovered_at: '2026-10-21T12:00:00', event_type: 'TI', security_owners: 'intel@example.com', incident_owners: 'wangwu@example.com', security_risk: true, security_incident: true, security_violation: true, security_red_line: true, severity: 'P2', description_html: '情报预警' },
  ]);
});

test('1904 日期系统的 Excel 日期导入不偏移，空行不计入工单数', async () => {
  const buffer = await filledTemplate([
    [new Date('2026-10-20T23:59:59Z'), 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['2026/10/21 00:00:00', 'MAIL', 'security.two@example.com', 'lisi@example.com', '否', '否', '否', '否', '', '独立内容'],
  ], { date1904: true });
  const rows = await parseBatchXlsx(buffer);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].discovered_at, '2026-10-20T23:59:59');
  assert.equal(rows[1].discovered_at, '2026-10-21T00:00:00');
});

test('外部 Excel 的数值日期支持两种日期系统，保持秒级上海时间', async () => {
  for (const date1904 of [false, true]) {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = date1904;
    const sheet = workbook.addWorksheet('外部数据');
    sheet.addRow(['发现时间', '事件类型', '安全负责人', '事件负责人', '安全风险', '安全事件', '安全违规', '安全红线', '事件等级', '详细内容']);
    const serial = (Date.UTC(2026, 9, 20, 10, 11, 12) - Date.UTC(1899, 11, 30)) / 86400000 - (date1904 ? 1462 : 0);
    sheet.addRow([serial, 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', '外部内容']);
    const rows = await parseBatchXlsx(await workbook.xlsx.writeBuffer());
    assert.equal(rows[0].discovered_at, '2026-10-20T10:11:12');
  }
});

test('Excel 导入报告错误行并拒绝无效日期、超过 100 条及无效文件', async () => {
  for (const values of [['2026-02-30 10:00:00', 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', ''], ['2026-10-20 25:00:00', 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', ''],
    ['2026-10-20 10:00:00', 'RASP', 'security.one@example.com', '', '否', '否', '否', '否', '', '']]) {
    await assert.rejects(parseBatchXlsx(await filledTemplate([values])), /第 2 行/);
  }
  const hundred = Array.from({ length: 100 }, () => ['2026-10-20 10:00:00', 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', '']);
  assert.equal((await parseBatchXlsx(await filledTemplate(hundred))).length, 100);
  await assert.rejects(parseBatchXlsx(await filledTemplate([...hundred, hundred[0]])), /最多导入 100/);
  await assert.rejects(parseBatchXlsx(Buffer.from('invalid')), /无法读取/);
  await assert.rejects(parseBatchXlsx(new Uint8Array(5 * 1024 * 1024 + 1)), /5 MB/);
});

test('Excel 要求完整字段，支持类型名称并拒绝非法、历史类型和错误风险关系', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('旧模板');
  sheet.addRow(['发现时间', '事件类型', '安全负责人', '事件负责人', '安全风险', '安全事件', '安全违规', '安全红线', '事件等级', '详细内容']);
  sheet.addRow(['2026-10-21 00:00:00', '监管通报', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', '沿用新模板']);
  const byLabel = await parseBatchXlsx(await workbook.xlsx.writeBuffer());
  assert.equal(byLabel[0].event_type, 'REG');
  for (const type of ['IR', '无效类型', 'WAF,MAIL']) {
    await assert.rejects(parseBatchXlsx(await filledTemplate([['2026-10-21 00:00:00', type, 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', '', '']])), /第 2 行的事件类型无效/);
  }
  await assert.rejects(parseBatchXlsx(await filledTemplate([['2026-10-21 00:00:00', 'RASP', '', 'zhangsan@example.com', '否', '否', '否', '否', '', '']])), /安全负责人和事件负责人/);
  await assert.rejects(parseBatchXlsx(await filledTemplate([['2026-10-21 00:00:00', 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '是', '否', '否', '', '']])), /层级关系/);
  await assert.rejects(parseBatchXlsx(await filledTemplate([['2026-10-21 00:00:00', 'RASP', 'security.one@example.com', 'zhangsan@example.com', '否', '否', '否', '否', 'P1', '']])), /非红线/);
});

test('批量填入的内容保留换行，将 HTML 符号作为文字显示', () => {
  assert.equal(batchTextHtml(''), '');
  assert.equal(batchTextHtml('  \n '), '');
  assert.equal(batchTextHtml('第一行 <说明>\n第二行 & 内容'), '<p>第一行 &lt;说明&gt;<br>第二行 &amp; 内容</p>');
});

test('XLSX负责人邮箱校验显示错误行，支持多个邮箱分隔',async()=>{
  for(const owner of ['张三','invalid','a@@example.com'])await assert.rejects(parseBatchXlsx(await filledTemplate([['2026-10-20 10:00:00','RASP','security@example.com',owner,'否','否','否','否','','']])),/第 2 行负责人.*邮箱/);
  const rows=await parseBatchXlsx(await filledTemplate([['2026-10-20 10:00:00','RASP','security@example.com','one@example.com；two+ops@example.com','否','否','否','否','','']]));
  assert.equal(rows.length,1);
});
