import { isOwnerIdentifier } from '../shared/owners.mjs';
import { EVENT_TYPES } from '../shared/model.mjs';

const HEADERS = [
  '发现时间', '事件类型', '安全负责人', '事件负责人', '安全风险', '安全事件', '安全违规', '安全红线',
  '事件等级', '详细内容',
];
const RISK_FIELDS = ['security_risk', 'security_incident', 'security_violation', 'security_red_line'];
const LEGACY_HEADERS = {
  discovered_at: ['发现时间', '时间', 'discovered_at'],
  event_type: ['事件类型', 'event_type'],
  security_owners: ['安全负责人', '安全负责人（可选）', 'security_owners'],
  incident_owners: ['事件负责人', '负责人', 'incident_owners'],
  description_html: ['该工单详细内容（可选）', '该工单详细内容(可选)', '详细内容', '内容', 'description'],
};

async function workbookClass() {
  const { default: ExcelJS } = await import('exceljs');
  return ExcelJS.Workbook;
}

function discoveryTime(value, date1904 = false) {
  if (typeof value === 'number') {
    value = new Date(Date.UTC(1899, 11, 30) + Math.round((value + (date1904 ? 1462 : 0)) * 86400) * 1000);
  }
  if (value instanceof Date) {
    // Excel dates are wall-clock values. Keep their displayed date/time in Shanghai.
    if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 1970 || value.getUTCFullYear() > 2100) return '';
    return value.toISOString().slice(0, 19);
  }
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value || '').trim());
  if (!match) return '';
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (+year < 1970 || +year > 2100 || calendar.getUTCFullYear() !== +year ||
      calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day ||
      +hour > 23 || +minute > 59 || +second > 59) return '';
  return calendar.toISOString().slice(0, 19);
}

function parseRiskValue(value, row, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['是', 'yes', 'true', '1', 'y'].includes(normalized)) return true;
  if (['否', 'no', 'false', '0', 'n'].includes(normalized)) return false;
  throw new Error(`第 ${row} 行“${label}”只能填写“是”或“否”。`);
}

export async function parseBatchXlsx(buffer) {
  if (buffer.byteLength > 5 * 1024 * 1024) throw new Error('XLSX 文件不能超过 5 MB。');
  const Workbook = await workbookClass();
  const workbook = new Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw new Error('无法读取该 XLSX 文件，请另存为 .xlsx 后重试。'); }
  const sheet = workbook.getWorksheet('批量建单') || workbook.worksheets[0];
  if (!sheet) throw new Error('XLSX 文件没有可读取的工作表。');
  const columns = new Map();
  sheet.getRow(1).eachCell((cell, column) => columns.set(cell.text.trim().toLowerCase(), column));
  const find = names => names.map(name => columns.get(name.toLowerCase())).find(column => column != null);
  const riskColumns = RISK_FIELDS.map(key => find([{
    security_risk: '安全风险', security_incident: '安全事件', security_violation: '安全违规', security_red_line: '安全红线',
  }[key], key]));
  const columnsFor = Object.fromEntries(Object.entries(LEGACY_HEADERS).map(([key, names]) => [key, find(names)]));
  if (!columnsFor.discovered_at || !columnsFor.incident_owners) throw new Error('模板必须包含“发现时间”和“事件负责人”列。');
  const riskColumnCount = riskColumns.filter(column => column != null).length;
  if (riskColumnCount !== 0 && riskColumnCount !== RISK_FIELDS.length) {
    throw new Error('XLSX 模板的风险判定列不完整，请下载最新版批量建单模板。');
  }
  const hasRiskSchema = riskColumnCount === RISK_FIELDS.length;
  if (!hasRiskSchema) throw new Error('XLSX 模板缺少完整风险判定列，请下载最新版批量建单模板。');
  const imported = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const cellText = column => column ? row.getCell(column).text.trim() : '';
    const timeText = cellText(columnsFor.discovered_at);
    const eventType = cellText(columnsFor.event_type).toUpperCase();
    const securityOwners = cellText(columnsFor.security_owners);
    const owner = cellText(columnsFor.incident_owners);
    const content = cellText(columnsFor.description_html);
    const riskValues = hasRiskSchema ? riskColumns.map(cellText) : [];
    const severityText = cellText(find(['事件等级', 'severity'])).toUpperCase();
    if (![timeText, eventType, securityOwners, owner, content, ...riskValues, severityText].some(Boolean)) return;
    if (imported.length === 100) throw new Error('单次最多导入 100 条事件，请分批导入。');
    const value = row.getCell(columnsFor.discovered_at).value?.result ?? row.getCell(columnsFor.discovered_at).value;
    const discoveredAt = discoveryTime(value, workbook.properties.date1904);
    if (!discoveredAt) throw new Error(`第 ${number} 行缺少有效的发现时间。`);
    if (!securityOwners || !owner) throw new Error(`第 ${number} 行请填写安全负责人和事件负责人。`);
    for (const value of [securityOwners,owner]) if (value.split(/[\n,，、;；]+/).map(x=>x.trim()).filter(Boolean).some(x=>!isOwnerIdentifier(x))) throw new Error(`第 ${number} 行负责人请填写有效账号或邮箱。`);
    const selectedType = EVENT_TYPES.find(item => item.key === eventType || item.label.toUpperCase() === eventType)?.key || '';
    if (!selectedType) throw new Error(`第 ${number} 行的事件类型无效，请从选项列表中选择。`);
    const securityRisk = hasRiskSchema ? riskColumns.map((column, index) => parseRiskValue(cellText(column), number,
      ['安全风险', '安全事件', '安全违规', '安全红线'][index])) : [false, false, false, false];
    const [security_risk, security_incident, security_violation, security_red_line] = securityRisk;
    if ((security_incident && !security_risk) || (security_violation && !security_incident) ||
        (security_red_line && !security_violation)) {
      throw new Error(`第 ${number} 行风险判定不符合层级关系：事件依赖风险、违规依赖事件、红线依赖违规。`);
    }
    if (security_red_line ? !/^P[0-4]$/.test(severityText) : Boolean(severityText)) {
      throw new Error(`第 ${number} 行${security_red_line ? '安全红线事件必须填写 P0–P4 事件等级' : '非红线事件的事件等级必须留空'}。`);
    }
    imported.push({ discovered_at: discoveredAt, event_type: selectedType, security_owners: securityOwners,
      incident_owners: owner, security_risk, security_incident, security_violation, security_red_line,
      severity: security_red_line ? severityText : '', description_html: content });
  });
  if (!imported.length) throw new Error('模板至少需要填写一条事件。');
  return imported;
}

export async function createBatchTemplate({ securityOwners = ['admin'] } = {}) {
  const Workbook = await workbookClass();
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('批量建单', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = HEADERS.map((header, index) => ({ header, width: [23, 16, 38, 38, 13, 13, 13, 13, 15, 62][index] }));
  sheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.getColumn(2).numFmt = '@';
  for (const column of [3, 4, 9, 10]) sheet.getColumn(column).numFmt = '@';
  sheet.getColumn(10).alignment = { vertical: 'top', wrapText: true };
  const options = workbook.addWorksheet('选项');
  options.addRow(['安全负责人列表', '事件类型选项', '类型说明', '布尔选项', '事件等级']);
  const ownerOptions = [...new Set(securityOwners.map(item => String(item).trim()).filter(Boolean))];
  ownerOptions.forEach((owner, index) => { options.getCell(`A${index + 2}`).value = owner; });
  EVENT_TYPES.forEach((item, index) => {
    options.getCell(`B${index + 2}`).value = item.key;
    options.getCell(`C${index + 2}`).value = `${item.label} · ${item.description}`;
  });
  options.getCell('D2').value = '是';
  options.getCell('D3').value = '否';
  ['P0', 'P1', 'P2', 'P3', 'P4'].forEach((level, index) => { options.getCell(`E${index + 2}`).value = level; });
  options.getCell('F1').value = '否选项';
  options.getCell('F2').value = '否';
  options.getColumn(1).width = 32;
  options.getColumn(2).width = 18;
  options.getColumn(3).width = 48;
  options.getColumn(4).width = 16;
  options.getColumn(5).width = 16;
  options.getColumn(6).width = 14;
  workbook.definedNames.add(`'选项'!$B$2:$B$${EVENT_TYPES.length + 1}`, 'EventTypeOptions');
  workbook.definedNames.add("'选项'!$D$2:$D$3", 'RiskDecisionOptions');
  workbook.definedNames.add("'选项'!$E$2:$E$6", 'SeverityOptions');
  workbook.definedNames.add("'选项'!$F$2:$F$2", 'NoOnlyOptions');
  workbook.definedNames.add("'选项'!$F$3:$F$3", 'BlankSeverityOptions');
  if (ownerOptions.length) workbook.definedNames.add(`'选项'!$A$2:$A$${ownerOptions.length + 1}`, 'SecurityOwnerOptions');
  options.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  options.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245FB8' } };
  sheet.dataValidations.add('B2:B101', {
    type: 'list', allowBlank: false, showErrorMessage: true, errorStyle: 'stop',
    errorTitle: '事件类型无效', error: '请从下拉列表中选择一个事件类型。', formulae: ['EventTypeOptions'],
  });
  sheet.dataValidations.add('E2:E101', {
    type: 'list', allowBlank: false, showErrorMessage: true, errorStyle: 'stop',
    errorTitle: '判定值无效', error: '请从下拉列表选择“是”或“否”。', formulae: ['RiskDecisionOptions'],
  });
  for (const [column, parent] of [['F', 'E'], ['G', 'F'], ['H', 'G']]) sheet.dataValidations.add(`${column}2:${column}101`, {
    type: 'list', allowBlank: false, showErrorMessage: true, errorStyle: 'stop',
    errorTitle: '风险层级不匹配', error: '仅当上一级判定为“是”时，才可以将本级判定为“是”。',
    formulae: [`=IF(${parent}2="是",RiskDecisionOptions,NoOnlyOptions)`],
  });
  sheet.dataValidations.add('I2:I101', {
    type: 'list', allowBlank: true, showErrorMessage: true, errorStyle: 'stop',
    errorTitle: '事件等级不匹配', error: '仅安全红线事件可选等级，红线事件必须选择 P0–P4。',
    formulae: ['=IF(H2="是",SeverityOptions,BlankSeverityOptions)'],
  });
  if (ownerOptions.length) sheet.dataValidations.add('C2:C101', {
    type: 'list', allowBlank: true, showErrorMessage: false, formulae: ['SecurityOwnerOptions'],
  });
  sheet.getRow(1).height = 36;
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245FB8' } };
  sheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  const instructions = workbook.addWorksheet('填写说明');
  instructions.columns = [{ header: '填写项', width: 32 }, { header: '说明', width: 100 }];
  instructions.addRows([
    ['批量建单', '“批量建单”工作表每行生成一个独立事件工单。所有字段按行填写；上传文件需在工单创建后逐条进入编辑页面添加。'],
    ['必填字段', '每行必填：发现时间、事件类型、安全负责人、事件负责人、安全风险、安全事件、安全违规、安全红线。详细内容可留空；红线事件还须填写事件等级。'],
    ['事件类型', '从下拉选项单选，使用类型代码，例如 DLP、RASP、TI（威胁情报）。类型说明见“选项”工作表。'],
    ['负责人', '每行填写该工单的安全负责人账号或邮箱和事件负责人账号或邮箱。安全负责人可从下拉列表选择，也可手动填写；多人使用顿号、逗号、分号或换行分隔。'],
    ['风险判定', '从下拉列表填写“是”或“否”。判定必须逐级关联：安全事件=是要求安全风险=是；安全违规=是要求安全事件=是；安全红线=是要求安全违规=是。'],
    ['事件等级', '仅安全红线=是时必须填写 P0–P4。非红线事件请留空。事件等级仅适用于安全红线。'],
    ['详细内容', '填写纯文本内容，保留换行。文件不在表格中上传；创建事件后可逐条编辑并添加附件或红线确认书。'],
    ['导入限制', '每次最多 100 条，文件最大 5 MB。导入后可以逐条修改字段，确认后批量创建；任一行不合法时整批不创建。'],
  ]);
  instructions.getColumn(2).alignment = { vertical: 'top', wrapText: true };
  instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245FB8' } };
  instructions.eachRow((row, number) => { row.height = number === 1 ? 28 : 46; });
  return workbook.xlsx.writeBuffer();
}

export function batchTextHtml(value) {
  const escaped = String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  return escaped.trim() ? `<p>${escaped.replace(/\r\n?|\n/g, '<br>')}</p>` : '';
}
