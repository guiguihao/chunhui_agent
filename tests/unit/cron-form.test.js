import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCronForm,
  cronToForm,
  formToCron,
  parseDate,
  isPastDate,
  validateCronForm,
} from '../../webui/src/lib/cron-form.js';
import { isValidCron } from '../../src/services/cron-utils.js';

/**
 * 可视化选择器最终只产出 cron 字符串，所以这里守两条底线：
 *   1. 表单 → cron 必须永远是后端认的 5 段表达式
 *   2. cron → 表单 → cron 必须无损（否则打开页面保存一次就改坏了用户配置）
 */

describe('formToCron — 各模式生成表达式', () => {
  test('每天：时间 → 分 时 * * *', () => {
    assert.equal(formToCron({ mode: 'daily', time: '09:05' }), '5 9 * * *');
    assert.equal(formToCron({ mode: 'daily', time: '23:59' }), '59 23 * * *');
  });

  test('每周：多选星期并排序去重', () => {
    assert.equal(formToCron({ mode: 'weekly', time: '08:00', weekdays: [5, 1, 3, 1] }), '0 8 * * 1,3,5');
    // 0 = 周日，排序后应在最前
    assert.equal(formToCron({ mode: 'weekly', time: '08:00', weekdays: [1, 0] }), '0 8 * * 0,1');
  });

  test('每周：一个都没选视为不完整', () => {
    assert.equal(formToCron({ mode: 'weekly', time: '08:00', weekdays: [] }), '');
  });

  test('每月：指定几号', () => {
    assert.equal(formToCron({ mode: 'monthly', time: '07:30', monthDay: 15 }), '30 7 15 * *');
    assert.equal(formToCron({ mode: 'monthly', time: '07:30', monthDay: 32 }), '');
  });

  test('指定日期：换算成每年该月该日（cron 无年份）', () => {
    assert.equal(formToCron({ mode: 'yearly', time: '10:00', date: '2026-11-05' }), '0 10 5 11 *');
    assert.equal(formToCron({ mode: 'yearly', time: '10:00', date: '2027-02-29' }), '', '非法日期必须被拒');
    assert.equal(formToCron({ mode: 'yearly', time: '10:00', date: '' }), '');
  });

  test('间隔：分钟与小时', () => {
    assert.equal(formToCron({ mode: 'interval', everyValue: 5, everyUnit: 'minute' }), '*/5 * * * *');
    assert.equal(formToCron({ mode: 'interval', everyValue: 2, everyUnit: 'hour' }), '0 */2 * * *');
    assert.equal(formToCron({ mode: 'interval', everyValue: 60, everyUnit: 'minute' }), '');
    assert.equal(formToCron({ mode: 'interval', everyValue: 24, everyUnit: 'hour' }), '');
    assert.equal(formToCron({ mode: 'interval', everyValue: 0, everyUnit: 'minute' }), '');
  });

  test('自定义：原样返回并去除首尾空白', () => {
    assert.equal(formToCron({ mode: 'custom', custom: '  0 9 * * 1-5  ' }), '0 9 * * 1-5');
    assert.equal(formToCron({ mode: 'custom', custom: '' }), '');
  });

  test('非法时间不生成表达式', () => {
    assert.equal(formToCron({ mode: 'daily', time: '24:00' }), '');
    assert.equal(formToCron({ mode: 'daily', time: '9:5' }), '');
    assert.equal(formToCron({ mode: 'daily', time: '' }), '');
  });

  test('所有生成结果都能通过后端校验', () => {
    const forms = [
      createCronForm({ mode: 'daily', time: '09:00' }),
      createCronForm({ mode: 'weekly', time: '18:30', weekdays: [1, 2, 3] }),
      createCronForm({ mode: 'monthly', time: '00:00', monthDay: 31 }),
      createCronForm({ mode: 'yearly', time: '12:00', date: '2026-06-01' }),
      createCronForm({ mode: 'interval', everyValue: 15, everyUnit: 'minute' }),
      createCronForm({ mode: 'interval', everyValue: 6, everyUnit: 'hour' }),
    ];
    for (const form of forms) {
      const cron = formToCron(form);
      assert.ok(isValidCron(cron), `生成的表达式应合法: ${cron} (${form.mode})`);
    }
  });
});

describe('cronToForm — 反解与降级', () => {
  const ROUND_TRIP = [
    '0 9 * * *',
    '5 9 * * 1,3,5',
    '0 8 * * 0,6',
    '30 7 15 * *',
    '0 10 5 11 *',
    '*/5 * * * *',
    '0 */2 * * *',
  ];

  test('受支持的模式可无损往返', () => {
    for (const cron of ROUND_TRIP) {
      assert.equal(formToCron(cronToForm(cron)), cron, `往返后表达式应一致: ${cron}`);
    }
  });

  test('复杂写法降级为自定义并原样保留', () => {
    for (const cron of ['0 9 * * 1-5', '0 9 1,15 * *', '*/2 1-5 * * *', '0 0 9 * * *']) {
      const form = cronToForm(cron);
      assert.equal(form.mode, 'custom', `${cron} 应降级为自定义`);
      assert.equal(form.custom, cron, '降级后必须保留原表达式，不能改写');
    }
  });

  test('空值按默认模式初始化', () => {
    assert.equal(cronToForm('').mode, 'daily');
    assert.equal(cronToForm('', { preferMode: 'interval' }).mode, 'interval');
    assert.equal(cronToForm('   ').mode, 'daily');
  });

  test('指定日期反解出的年份取当前年', () => {
    const form = cronToForm('0 10 5 11 *');
    assert.equal(form.mode, 'yearly');
    assert.equal(form.date, `${new Date().getFullYear()}-11-05`);
  });
});

describe('validateCronForm — 错误码', () => {
  test('按模式返回可翻译的错误码', () => {
    assert.deepEqual(validateCronForm({ mode: 'daily', time: '09:00' }), { ok: true });
    assert.equal(validateCronForm({ mode: 'daily', time: '' }).code, 'time');
    assert.equal(validateCronForm({ mode: 'weekly', time: '09:00', weekdays: [] }).code, 'weekdays');
    assert.equal(validateCronForm({ mode: 'monthly', time: '09:00', monthDay: 0 }).code, 'monthDay');
    assert.equal(validateCronForm({ mode: 'yearly', time: '09:00', date: 'x' }).code, 'date');
    assert.equal(validateCronForm({ mode: 'interval', everyValue: 0, everyUnit: 'minute' }).code, 'interval');
    assert.equal(validateCronForm({ mode: 'custom', custom: 'nope' }).code, 'custom');
  });
});

describe('日期工具', () => {
  test('parseDate 拒绝不存在的日期', () => {
    assert.equal(parseDate('2026-11-05').month, 11);
    assert.equal(parseDate('2026-02-30'), null);
    assert.equal(parseDate('2026-13-01'), null);
    assert.equal(parseDate('2026/11/05'), null);
  });

  test('isPastDate 只对已过去的日期返回 true', () => {
    const now = new Date(2026, 10, 2); // 2026-11-02
    assert.equal(isPastDate('2026-11-01', now), true);
    assert.equal(isPastDate('2026-11-02', now), false);
    assert.equal(isPastDate('2026-11-03', now), false);
    assert.equal(isPastDate('', now), false);
  });
});
