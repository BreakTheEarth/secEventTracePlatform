import { cleanRichText } from './content.mjs';
import { EVENT_TYPES, EVENT_TYPE_KEYS, LEGACY_EVENT_TYPE_KEYS } from '../shared/model.mjs';
import { isOwnerIdentifier } from '../shared/owners.mjs';

export class FormError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const fail = message => { throw new FormError(message); };

export function parseDiscoveryTime(value) {
  if (typeof value !== 'string') return fail('请选择有效的发现时间。');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return fail('发现时间格式无效。');
  const [, y, m, d, h, min, sec = '00', fraction = '', zone = '+08:00'] = match;
  const calendar = new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +sec));
  if (+y < 1970 || +y > 2100 || calendar.getUTCFullYear() !== +y || calendar.getUTCMonth() !== +m - 1 ||
      calendar.getUTCDate() !== +d || +h > 23 || +min > 59 || +sec > 59) return fail('发现时间不是有效的日期。');
  const normalized = new Date(`${y}-${m}-${d}T${h}:${min}:${sec}${fraction}${zone}`);
  if (!Number.isFinite(normalized.getTime())) return fail('发现时间格式无效。');
  return normalized.toISOString();
}

function owners(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return fail(`${label}须为账号或邮箱列表。`);
  }
  const result = [...new Set(value.map(item => item.trim()).filter(Boolean))];
  if (!result.length) return fail(`请至少填写一名${label}。`);
  if (result.length > 20) return fail(`${label}最多 20 人。`);
  if (result.some(item => !isOwnerIdentifier(item))) return fail(`${label}请填写有效账号或邮箱，每个地址不超过 254 字。`);
  return result;
}

export function normalizeReport(body, { existingEventType = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('表单内容无效。');
  if (['log_id','log_fetch_id','log_detail'].some(key => Object.hasOwn(body,key))) return fail('此版本仅支持手动记录，不接受外部日志关联字段。');
  const eventType = typeof body.event_type === 'string' && body.event_type.trim()
    ? body.event_type.trim().toUpperCase() : 'DLP';
  if (!EVENT_TYPE_KEYS.includes(eventType) &&
      !(eventType === existingEventType && LEGACY_EVENT_TYPE_KEYS.includes(eventType))) {
    return fail(`事件类型无效，请选择${EVENT_TYPES.map(item => item.label).join('、')}。`);
  }
  for (const key of ['security_risk', 'security_incident', 'security_violation', 'security_red_line']) {
    if (typeof body[key] !== 'boolean') return fail('四级风险判定必须填写“是”或“否”。');
  }
  if ((body.security_incident && !body.security_risk) || (body.security_violation && !body.security_incident) ||
      (body.security_red_line && !body.security_violation)) return fail('下级判定为“是”时，上级判定也必须为“是”。');
  const submittedSeverity = typeof body.severity === 'string' && body.severity ? body.severity.toUpperCase() : null;
  const severity = body.security_red_line ? submittedSeverity : null;
  if (body.security_red_line && !/^P[0-4]$/.test(severity || '')) return fail('安全红线事件请选择 P0–P4 事件等级。');
  if (typeof body.description_html !== 'string' || Buffer.byteLength(body.description_html) > 2 * 1024 * 1024) {
    return fail('详细描述必须是文本，且不能超过 2 MB。');
  }
  return {
    event_type: eventType,
    occurred_at: parseDiscoveryTime(body.discovered_at),
    stage: body.security_red_line ? 'red_lines' : body.security_violation ? 'violations'
      : body.security_incident ? 'incidents' : body.security_risk ? 'risks' : 'logs',
    severity, security_risk: body.security_risk, security_incident: body.security_incident,
    security_violation: body.security_violation, security_red_line: body.security_red_line,
    redline_confirmation_asset_id: body.redline_confirmation_asset_id == null || body.redline_confirmation_asset_id === ''
      ? null : Number.isSafeInteger(body.redline_confirmation_asset_id)
        ? body.redline_confirmation_asset_id : fail('红线确认书附件无效。'),
    security_owners: owners(body.security_owners, '安全负责人'),
    incident_owners: owners(body.incident_owners, '事件负责人'),
    description_html: cleanRichText(body.description_html),
  };
}
