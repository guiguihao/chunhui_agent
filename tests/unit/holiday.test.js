import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import HolidayService, {
  formatDateInTz,
  isWeekendDate,
  normalizeDayRule,
} from '../../src/services/holiday.js';

/**
 * 节假日日历的判定直接决定「排除周末/法定假日」的任务跑不跑，
 * 这里不联网：用临时 yaml + 注入的 fetch 覆盖正常路径和降级路径。
 */

let dir;
let filePath;
let cachePath;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holiday-'));
  filePath = path.join(dir, 'holidays.yaml');
  cachePath = path.join(dir, 'cache.json');
  await fs.writeFile(filePath, [
    'holidays:',
    '  "2026":',
    '    holidays:',
    '      - 2026-10-01',
    '      - 2026-10-02',
    '      - 2026-10-03',
    '    workdays:',
    '      - 2026-10-10',
    'remote:',
    '  enabled: false',
    '',
  ].join('\n'), 'utf8');
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const makeService = async (overrides = {}) => {
  const service = new HolidayService({
    filePath,
    cachePath,
    remoteEnabled: false,
    timeoutMs: 50,
    ...overrides,
  });
  await service.init();
  return service;
};

// yaml 里写了 remote.enabled: false，会覆盖构造参数（文件优先是刻意设计），
// 需要验证远程分支的用例必须显式打开开关
const makeRemoteService = async (overrides = {}) => {
  const service = await makeService(overrides);
  service.remote.enabled = true;
  return service;
};

describe('日期与时区工具', () => {
  test('formatDateInTz 按目标时区取日期', () => {
    const noon = new Date('2026-11-02T16:30:00Z'); // 上海时间 11-03 00:30
    assert.equal(formatDateInTz(noon, 'Asia/Shanghai'), '2026-11-03');
    assert.equal(formatDateInTz(noon, 'UTC'), '2026-11-02');
  });

  test('isWeekendDate 只看周六日', () => {
    assert.equal(isWeekendDate('2026-10-03'), true); // 周六
    assert.equal(isWeekendDate('2026-10-04'), true); // 周日
    assert.equal(isWeekendDate('2026-10-05'), false);
  });

  test('normalizeDayRule 兜底非法值', () => {
    assert.equal(normalizeDayRule('exclude'), 'exclude');
    assert.equal(normalizeDayRule('bogus'), 'any');
    assert.equal(normalizeDayRule(undefined), 'any');
  });
});

describe('shouldRun — 周末规则', () => {
  test('排除周末：普通周六跳过，调休上班的周六照常', async () => {
    const service = await makeService();
    const saturday = await service.shouldRun('2026-10-03', { weekend: 'exclude' });
    assert.equal(saturday.run, false);
    assert.equal(saturday.reason, 'weekend');

    const makeUpWorkday = await service.shouldRun('2026-10-10', { weekend: 'exclude' });
    assert.equal(makeUpWorkday.run, true, '调休补班的周六不应被当成周末');
  });

  test('仅周末：调休上班日不算周末', async () => {
    const service = await makeService();
    assert.equal((await service.shouldRun('2026-10-03', { weekend: 'only' })).run, true);
    assert.equal((await service.shouldRun('2026-10-10', { weekend: 'only' })).run, false);
    assert.equal((await service.shouldRun('2026-10-05', { weekend: 'only' })).run, false);
  });
});

describe('shouldRun — 法定假日规则', () => {
  test('排除假日：假期跳过，普通工作日执行', async () => {
    const service = await makeService();
    const holiday = await service.shouldRun('2026-10-01', { holiday: 'exclude' });
    assert.equal(holiday.run, false);
    assert.equal(holiday.reason, 'holiday');
    assert.equal((await service.shouldRun('2026-10-09', { holiday: 'exclude' })).run, true);
  });

  test('仅假日：只在该年的放假日期执行', async () => {
    const service = await makeService();
    assert.equal((await service.shouldRun('2026-10-01', { holiday: 'only' })).run, true);
    assert.equal((await service.shouldRun('2026-10-09', { holiday: 'only' })).run, false);
  });

  test('两条规则可叠加：排除周末 + 排除假日 = 仅工作日', async () => {
    const service = await makeService();
    const rules = { weekend: 'exclude', holiday: 'exclude' };
    assert.equal((await service.shouldRun('2026-10-01', rules)).run, false, '假日');
    assert.equal((await service.shouldRun('2026-10-03', rules)).run, false, '周末');
    assert.equal((await service.shouldRun('2026-10-09', rules)).run, true, '普通工作日');
  });

  test('无规则时直接放行，不触发数据加载', async () => {
    const service = await makeService();
    const verdict = await service.shouldRun('2031-01-01', {});
    assert.equal(verdict.run, true);
    assert.equal(service.years.has('2031'), false, 'any 规则不应去加载该年份数据');
  });

  test('数据缺失时放行并标记 known:false（不静默漏跑）', async () => {
    const service = await makeService();
    const verdict = await service.shouldRun('2031-06-01', { holiday: 'exclude' });
    assert.equal(verdict.run, true);
    assert.equal(verdict.known, false);
  });
});

describe('远程数据源', () => {
  const remotePayload = {
    holiday: {
      '01-01': { holiday: true, date: '2032-01-01' },
      '01-04': { holiday: false, date: '2032-01-04' },
    },
  };

  test('缺年份时按需拉取并写入缓存', async () => {
    let calls = 0;
    const service = await makeRemoteService({
      cachePath: path.join(dir, 'remote-cache.json'),
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => remotePayload };
      },
    });

    const info = await service.ensureYear(2032);
    assert.equal(calls, 1);
    assert.equal(info.known, true);
    assert.equal(info.holidays.has('2032-01-01'), true);
    assert.equal(info.workdays.has('2032-01-04'), true);

    // 同一年再次获取走内存，不再请求
    await service.ensureYear(2032);
    assert.equal(calls, 1);

    const cache = JSON.parse(await fs.readFile(path.join(dir, 'remote-cache.json'), 'utf8'));
    assert.equal(cache['2032'].holidays.length, 1);
  });

  test('缓存可在离线下复用', async () => {
    const cacheOnly = await makeService({
      remoteEnabled: false,
      cachePath: path.join(dir, 'remote-cache.json'),
    });
    assert.equal(cacheOnly.getStatus(2032).known, true);
    assert.equal(cacheOnly.getStatus(2032).source, 'cache');
  });

  test('接口失败时放行且短期不重复请求', async () => {
    let calls = 0;
    const service = await makeRemoteService({
      cachePath: path.join(dir, 'fail-cache.json'),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });

    const first = await service.ensureYear(2033);
    assert.equal(first.known, false);
    await service.ensureYear(2033);
    assert.equal(calls, 1, '失败后 6 小时内不应反复打网络');
  });

  test('返回结构不符合预期时按缺失处理', async () => {
    const service = await makeRemoteService({
      cachePath: path.join(dir, 'shape-cache.json'),
      fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0 }) }),
    });
    const info = await service.ensureYear(2034);
    assert.equal(info.known, false);
  });
});

describe('本地文件优先', () => {
  test('文件里的年份覆盖缓存来源', async () => {
    const service = await makeService({ cachePath: path.join(dir, 'remote-cache.json') });
    const status = service.getStatus(2026);
    assert.equal(status.source, 'file');
    assert.equal(service.getStatus(2032).source, 'cache');
  });
});
