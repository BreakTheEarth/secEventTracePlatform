export const METRICS = [
  { key: 'logs', label: '安全日志', description: '全部已填报记录', color: '#647a96' },
  { key: 'risks', label: '安全风险', description: '已识别风险及更高层级记录', color: '#3979ba' },
  { key: 'incidents', label: '安全事件', description: '已确认为事件及更高层级记录', color: '#247c8b' },
  { key: 'violations', label: '安全违规', description: '已确认为违规及红线记录', color: '#b5752c' },
  { key: 'red_lines', label: '安全红线', description: '已触及安全红线的记录', color: '#b94e4b' },
  { key: 'redline_p0', label: 'P0 严重事件', description: '安全红线中等级为 P0 的记录', color: '#ad3542' },
  { key: 'redline_p1', label: 'P1 高危事件', description: '安全红线中等级为 P1 的记录', color: '#b85d22' },
  { key: 'redline_p2', label: 'P2 中危事件', description: '安全红线中等级为 P2 的记录', color: '#a17a14' },
  { key: 'redline_p3', label: 'P3 低危事件', description: '安全红线中等级为 P3 的记录', color: '#237b74' },
  { key: 'redline_p4', label: 'P4 轻微事件', description: '安全红线中等级为 P4 的记录', color: '#647a96' },
];

export const STAGES = METRICS.slice(0, 5);
export const EVENT_TYPES = [
  { key: 'DLP', label: 'DLP', description: '数据防泄漏' },
  { key: 'EDR', label: 'EDR', description: '终端检测与响应' },
  { key: 'HIDS', label: 'HIDS', description: '主机入侵检测' },
  { key: 'REG', label: '监管通报', description: '监管部门或外部单位通报' },
  { key: 'FB', label: '人工反馈', description: '人工发现、反馈或补充上报' },
  { key: 'RASP', label: 'RASP', description: '运行时应用自我保护' },
  { key: 'WAF', label: 'WAF', description: 'Web 应用防火墙' },
  { key: 'SAST', label: 'SAST', description: '静态应用安全测试' },
  { key: 'DAST', label: 'DAST', description: '动态应用安全测试' },
  { key: 'MAIL', label: 'MAIL', description: '邮件安全事件' },
  { key: 'TI', label: '威胁情报', description: '威胁情报发现、研判或预警' },
];
export const EVENT_TYPE_KEYS = EVENT_TYPES.map(item => item.key);
// Retain historical values for display and title migration, while rejecting
// them in new submissions.
export const LEGACY_EVENT_TYPE_KEYS = ['IR'];
export const ALL_EVENT_TYPE_KEYS = [...EVENT_TYPE_KEYS, ...LEGACY_EVENT_TYPE_KEYS];
export const PERIODS = [
  { key: 'all', label: '全部时间', short: '全部' },
  { key: 'year', label: '本年', short: '本年' },
  { key: 'half-year', label: '本半年', short: '本半年' },
  { key: 'quarter', label: '本季度', short: '本季度' },
  { key: 'month', label: '本月', short: '本月' },
];
export const SYSTEM_LAYERS = METRICS.flatMap(metric =>
  PERIODS.map(period => ({
    id: `${metric.key}_${period.key}`,
    metric: metric.key,
    period: period.key,
    name: `${metric.label} · ${period.label}`,
    system: true,
  })),
);

const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const EVENT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function eventTitleBucket(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() + SHANGHAI_OFFSET);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatEventTitle(value, eventType, sequence) {
  const date = new Date(value);
  const type = String(eventType || '').toUpperCase();
  const number = Number(sequence);
  if (!Number.isFinite(date.getTime()) || !ALL_EVENT_TYPE_KEYS.includes(type) ||
      !Number.isSafeInteger(number) || number < 1 || number > 9999) return '';
  const local = new Date(date.getTime() + SHANGHAI_OFFSET);
  const year = String(local.getUTCFullYear()).slice(-2);
  const month = EVENT_MONTHS[local.getUTCMonth()];
  return `${year}-${month}-${type}-${String(number).padStart(4, '0')}`;
}

export function periodStarts(asOf = new Date()) {
  const local = new Date(asOf.getTime() + SHANGHAI_OFFSET);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const at = monthIndex => Date.UTC(year, monthIndex, 1) - SHANGHAI_OFFSET;
  return {
    all: -Infinity,
    year: at(0),
    'half-year': at(month < 6 ? 0 : 6),
    quarter: at(Math.floor(month / 3) * 3),
    month: at(month),
  };
}

export function calculateSnapshot(events, asOf = new Date()) {
  const starts = periodStarts(asOf);
  const values = Object.fromEntries(SYSTEM_LAYERS.map(layer => [layer.id, 0]));
  const cutoff = asOf.getTime();
  for (const event of events) {
    const time = new Date(event.occurred_at).getTime();
    const rank = STAGES.findIndex(stage => stage.key === event.stage);
    if (!Number.isFinite(time) || time > cutoff || rank < 0) continue;
    for (const period of PERIODS) {
      if (time < starts[period.key]) continue;
      for (let i = 0; i <= rank; i++) values[`${STAGES[i].key}_${period.key}`]++;
      if (event.stage === 'red_lines' && /^P[0-4]$/.test(event.severity || '')) {
        values[`redline_${event.severity.toLowerCase()}_${period.key}`]++;
      }
    }
  }
  return values;
}

export function formatNumber(number) {
  return new Intl.NumberFormat('zh-CN').format(number);
}

export function formatDate(value, dateOnly = false) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
  }).format(new Date(value));
}
