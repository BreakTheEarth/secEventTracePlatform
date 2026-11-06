import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_EVENT_TYPE_KEYS, EVENT_TYPES, SYSTEM_LAYERS, calculateSnapshot, formatEventTitle, periodStarts, PERIODS } from '../shared/model.mjs';

const asOf = new Date('2026-10-16T04:00:00Z');
const event = (stage, date = '2026-10-15T02:00:00Z', severity = null) => ({ stage, occurred_at: date, severity });

test('事件类型移除应急响应并加入新增安全检测类型，历史类型仍可识别', () => {
  assert.deepEqual(EVENT_TYPES.slice(3).map(item => [item.key, item.label]), [
    ['REG', '监管通报'], ['FB', '人工反馈'], ['RASP', 'RASP'],
    ['WAF', 'WAF'], ['SAST', 'SAST'], ['DAST', 'DAST'], ['MAIL', 'MAIL'],
    ['TI', '威胁情报'],
  ]);
  assert.equal(formatEventTitle('2026-10-20T02:00:00Z', 'REG', 1), '26-OCT-REG-0001');
  assert.equal(formatEventTitle('2026-10-20T02:00:00Z', 'RASP', 2), '26-OCT-RASP-0002');
  assert.equal(formatEventTitle('2026-10-20T02:00:00Z', 'MAIL', 3), '26-OCT-MAIL-0003');
  assert.equal(formatEventTitle('2026-10-20T02:00:00Z', 'TI', 5), '26-OCT-TI-0005');
  assert.ok(!EVENT_TYPES.some(item => item.key === 'IR'));
  assert.ok(ALL_EVENT_TYPE_KEYS.includes('IR'));
  assert.equal(formatEventTitle('2026-10-20T02:00:00Z', 'IR', 4), '26-OCT-IR-0004');
});

test('50 个固定系统层的字段名称完整且唯一', () => {
  assert.equal(SYSTEM_LAYERS.length, 50);
  assert.equal(new Set(SYSTEM_LAYERS.map(layer => layer.id)).size, 50);
  assert.ok(SYSTEM_LAYERS.some(layer => layer.id === 'logs_half-year'));
  assert.ok(SYSTEM_LAYERS.some(layer => layer.id === 'redline_p4_month'));
});

test('空数据快照包含全部 50 个字段且均为 0', () => {
  const values = calculateSnapshot([], asOf);
  assert.deepEqual(Object.keys(values), SYSTEM_LAYERS.map(layer => layer.id));
  assert.ok(Object.values(values).every(value => value === 0));
});

test('主漏斗逐层包含，红线 P0–P4 为互斥分支', () => {
  const events = ['logs', 'risks', 'incidents', 'violations'].map(stage => event(stage));
  for (let i = 0; i < 5; i++) events.push(event('red_lines', undefined, `P${i}`));
  const result = calculateSnapshot(events, asOf);
  for (const { key: period } of PERIODS) {
    assert.equal(result[`logs_${period}`], 9);
    assert.equal(result[`risks_${period}`], 8);
    assert.equal(result[`incidents_${period}`], 7);
    assert.equal(result[`violations_${period}`], 6);
    assert.equal(result[`red_lines_${period}`], 5);
    assert.equal(Array.from({ length: 5 }, (_, i) => result[`redline_p${i}_${period}`]).reduce((a, b) => a + b), 5);
  }
});

test('上海时间的自然年、半年、季度、月份边界包含起点', () => {
  const starts = periodStarts(asOf);
  assert.equal(new Date(starts.year).toISOString(), '2025-12-31T16:00:00.000Z');
  assert.equal(new Date(starts['half-year']).toISOString(), '2026-06-30T16:00:00.000Z');
  assert.equal(new Date(starts.quarter).toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(starts.quarter, starts.month);
  const events = [
    event('logs', '2025-12-31T15:59:59.999Z'),
    event('logs', '2025-12-31T16:00:00.000Z'),
    event('logs', '2026-06-30T15:59:59.999Z'),
    event('logs', '2026-06-30T16:00:00.000Z'),
    event('logs', '2026-09-30T15:59:59.999Z'),
    event('logs', '2026-09-30T16:00:00.000Z'),
    event('logs', asOf.toISOString()),
    event('logs', '2026-10-16T04:00:00.001Z'),
  ];
  const values = calculateSnapshot(events, asOf);
  assert.equal(values.logs_all, 7);
  assert.equal(values.logs_year, 6);
  assert.equal(values['logs_half-year'], 4);
  assert.equal(values.logs_quarter, 2);
  assert.equal(values.logs_month, 2);
});

test('跨年与上半年自然周期使用上海时间', () => {
  const starts = periodStarts(new Date('2025-12-31T16:01:00Z'));
  assert.equal(new Date(starts.year).toISOString(), '2025-12-31T16:00:00.000Z');
  assert.equal(starts.year, starts['half-year']);
  assert.equal(starts.year, starts.quarter);
  assert.equal(starts.year, starts.month);
  const april = periodStarts(new Date('2026-03-31T16:00:00Z'));
  assert.equal(new Date(april.quarter).toISOString(), '2026-03-31T16:00:00.000Z');
  assert.equal(new Date(april['half-year']).toISOString(), '2025-12-31T16:00:00.000Z');
});

