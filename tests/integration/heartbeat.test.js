import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import Heartbeat, { DYNAMIC_CHECK_NAME } from '../../src/services/heartbeat.js';
import { handleManagementTool } from '../../src/services/tools/dispatcher.js';

/**
 * 重点覆盖历史 bug：mgmt_heartbeat_get/set 读写的是一个无人消费的字段，
 * AI 调用后会收到「已更新心跳任务」但实际巡检内容完全没变。
 *
 * 注意：node-cron 的定时任务会持有定时器，若不显式 stop() 会让测试进程无法退出，
 * 因此统一登记并集中清理。
 */
const created = [];
const mkHeartbeat = (agent, config) => {
  const hb = new Heartbeat(agent, config);
  created.push(hb);
  return hb;
};
after(() => { for (const hb of created) hb.stop(); });

const fakeAgent = (sink) => ({
  decide: async (prompt, opts) => {
    sink.push({ prompt, sessionId: opts.sessionId });
    return { response: 'ok' };
  },
});

describe('Heartbeat 动态巡检', () => {
  test('setTaskContent 后内容真正被执行', async () => {
    const executed = [];
    const hb = mkHeartbeat(fakeAgent(executed), { enabled: true, interval: '* * * * *' });

    await hb.setTaskContent('检查所有灯是否关闭');
    assert.equal(hb.getTaskContent(), '检查所有灯是否关闭');
    assert.ok(hb.dynamicTask, '动态任务必须被创建并调度');

    await hb.beat();
    assert.equal(executed[0]?.prompt, '检查所有灯是否关闭', '巡检内容必须真正被执行');
  });

  test('动态巡检使用独立会话，避免与定时任务共用上下文', async () => {
    const executed = [];
    const hb = mkHeartbeat(fakeAgent(executed), { enabled: true, interval: '* * * * *' });
    await hb.setTaskContent('巡检内容');
    await hb.beat();
    assert.equal(executed[0]?.sessionId, `hb_${DYNAMIC_CHECK_NAME}`);
  });

  test('清空内容后动态任务被撤销', async () => {
    const hb = mkHeartbeat(fakeAgent([]), { enabled: true, interval: '* * * * *' });
    await hb.setTaskContent('x');
    await hb.setTaskContent('');
    assert.equal(hb.dynamicTask, null);
  });

  test('变更必须触发持久化回调', async () => {
    let persisted = null;
    const hb = mkHeartbeat({}, { enabled: false });
    hb.setOnDynamicChanged((c) => { persisted = c; });
    await hb.setTaskContent('巡检B');
    assert.equal(persisted, '巡检B');
  });

  test('从配置恢复 dynamic_prompt 并重新调度', () => {
    const hb = mkHeartbeat({}, { enabled: false, dynamic_prompt: '来自配置的巡检' });
    assert.equal(hb.getTaskContent(), '来自配置的巡检');
    hb.enabled = true;
    hb.start();
    assert.ok(hb.dynamicTask, '启动后必须恢复调度');
  });
});

describe('Heartbeat 检查项 enabled / interval', () => {
  test('缺省 enabled 视为启用（兼容老配置）', () => {
    const hb = mkHeartbeat({}, { enabled: true, interval: '* * * * *', checks: [{ name: 'legacy', prompt: 'p' }] });
    hb.start();
    assert.equal(hb.tasks.length, 1);
  });

  test('enabled:false 的检查项不参与调度', () => {
    const hb = mkHeartbeat({}, {
      enabled: true,
      interval: '* * * * *',
      checks: [
        { name: 'on', prompt: 'p' },
        { name: 'off', prompt: 'p', enabled: false },
      ],
    });
    hb.start();
    assert.equal(hb.tasks.length, 1, '停用项不应创建定时任务');
  });

  test('手动触发（beat）也跳过停用项', async () => {
    const executed = [];
    const hb = mkHeartbeat(fakeAgent(executed), {
      enabled: false,
      checks: [
        { name: 'on', prompt: 'A' },
        { name: 'off', prompt: 'B', enabled: false },
      ],
    });
    await hb.beat();
    assert.deepEqual(executed.map(e => e.prompt), ['A']);
  });

  test('单项 interval 非法时回退全局且不影响后续检查项', () => {
    const hb = mkHeartbeat({}, {
      enabled: true,
      interval: '* * * * *',
      checks: [
        { name: 'bad', prompt: 'p', interval: 'bogus' },
        { name: 'good', prompt: 'p', interval: '*/2 * * * *' },
      ],
    });
    assert.doesNotThrow(() => hb.start(), '一条坏配置不应中断整个心跳启动');
    assert.equal(hb.tasks.length, 2);
  });

  test('热更新某项 enabled 会重建调度', () => {
    const checks = [{ name: 'A', prompt: 'p' }, { name: 'B', prompt: 'p' }];
    const hb = mkHeartbeat({}, { enabled: true, interval: '* * * * *', checks });
    hb.start();
    assert.equal(hb.tasks.length, 2);

    hb.updateConfig({
      enabled: true,
      interval: '* * * * *',
      checks: [{ name: 'A', prompt: 'p' }, { name: 'B', prompt: 'p', enabled: false }],
    });
    assert.equal(hb.tasks.length, 1, '停用 B 后应只剩 A 一个任务');
  });
});

describe('Heartbeat 全局 interval 与时区', () => {
  test('全局 interval 非法时回退默认值，不中断启动', () => {
    const hb = mkHeartbeat({}, {
      enabled: true,
      interval: 'not a cron',
      checks: [{ name: 'A', prompt: 'p' }],
    });
    assert.doesNotThrow(() => hb.start(), '全局 bad interval 不应抛穿 start()');
    assert.equal(hb.interval, '*/5 * * * *');
    assert.equal(hb.tasks.length, 1, '回退后静态检查项仍应被调度');
  });

  test('6 段带秒表达式同样按非法处理（与 WebUI 口径一致）', () => {
    const hb = mkHeartbeat({}, {
      enabled: true,
      interval: '0 */5 * * * *',
      checks: [{ name: 'A', prompt: 'p' }],
    });
    hb.start();
    assert.equal(hb.interval, '*/5 * * * *');
  });

  test('时区可配置，默认 Asia/Shanghai', () => {
    assert.equal(new Heartbeat({}, { enabled: false }).timezone, 'Asia/Shanghai');
    assert.equal(new Heartbeat({}, { enabled: false, timezone: 'UTC' }).timezone, 'UTC');
  });
});

describe('Heartbeat 日期规则（周末/法定假日）', () => {
  test('规则不满足时跳过检查项（手动触发同样生效）', async () => {
    const executed = [];
    const hb = mkHeartbeat(fakeAgent(executed), {
      enabled: false,
      checks: [{ name: 'A', prompt: 'p', weekend: 'exclude' }],
    });
    hb.setHolidayService({ shouldRun: async () => ({ run: false, reason: 'weekend', known: true }) });

    await hb.beat();

    assert.deepEqual(executed, [], '周末不应执行检查项');
  });

  test('未设置日期规则时不查询节假日服务', async () => {
    let queried = 0;
    const executed = [];
    const hb = mkHeartbeat(fakeAgent(executed), {
      enabled: false,
      checks: [{ name: 'A', prompt: 'p' }],
    });
    hb.setHolidayService({
      shouldRun: async () => { queried += 1; return { run: false, reason: 'x' }; },
    });

    await hb.beat();

    assert.equal(queried, 0);
    assert.equal(executed.length, 1);
  });
});

describe('Heartbeat 告警内容完整性', () => {
  test('广播必须带上 JSON 之外的完整正文', async () => {
    const text = '```json\n{"is_warning": true, "reply": "测试：消息桥接器与心跳推送功能正常"}\n```\n\n'
      + '链路第 33 次确认正常。空调巡检与壁挂炉哨兵当前没有在跑。';
    let received = null;
    const hb = mkHeartbeat({ decide: async () => ({ response: text }) }, { enabled: false });
    hb.setOnWarning((msg, payload, meta) => { received = { msg, meta }; });

    await hb._runCheck({ name: '系统告警测试', prompt: 'p' });

    assert.equal(received.msg, '测试：消息桥接器与心跳推送功能正常');
    assert.equal(received.meta.check, '系统告警测试');
    assert.match(received.meta.detail, /链路第 33 次确认正常/, '正文不能被丢弃');
    assert.doesNotMatch(received.meta.detail, /```/, 'JSON 围栏不应再贴一遍');
  });

  test('正文与结论完全相同时不重复附带', async () => {
    let received = null;
    const hb = mkHeartbeat(
      { decide: async () => ({ is_warning: true, reply: '仅一句结论' }) },
      { enabled: false },
    );
    hb.setOnWarning((msg, payload, meta) => { received = { msg, meta }; });

    await hb._runCheck({ name: 'X', prompt: 'p' });

    assert.equal(received.msg, '仅一句结论');
    assert.equal(received.meta.detail, '');
  });
});

describe('Heartbeat 结构化更新（mgmt_heartbeat_update）', () => {
  const base = () => ({
    enabled: false,
    interval: '* * * * *',
    checks: [{ name: 'A', prompt: 'p1' }],
  });

  test('按 name 更新检查项，未提交的字段保持原值', async () => {
    const hb = mkHeartbeat({}, base());
    const changes = await hb.applyToolPatch({
      check: { name: 'A', interval: '*/10 * * * *', weekend: 'exclude' },
    });

    assert.ok(changes.length > 0);
    assert.equal(hb.checks[0].prompt, 'p1', '未提交的 prompt 不能被清空');
    assert.equal(hb.checks[0].interval, '*/10 * * * *');
    assert.equal(hb.checks[0].weekend, 'exclude');
  });

  test('新增检查项，同名重复提交不产生副本', async () => {
    const hb = mkHeartbeat({}, base());
    await hb.applyToolPatch({ check: { name: 'B', prompt: 'p2' } });
    await hb.applyToolPatch({ check: { name: 'B', prompt: 'p2x' } });

    assert.equal(hb.checks.length, 2);
    assert.equal(hb.checks.find(c => c.name === 'B').prompt, 'p2x');
  });

  test('删除检查项；删除不存在的名字会明确说明而不是静默成功', async () => {
    const hb = mkHeartbeat({}, base());
    await hb.applyToolPatch({ remove_check: 'A' });
    assert.equal(hb.checks.length, 0);

    const changes = await hb.applyToolPatch({ remove_check: '不存在的项' });
    assert.match(changes.join(' '), /未找到检查项/);
  });

  test('非法 interval 抛错且不修改配置', async () => {
    const hb = mkHeartbeat({}, base());
    await assert.rejects(() => hb.applyToolPatch({ interval: '99 * * * *' }), /interval 非法/);
    assert.equal(hb.interval, '* * * * *');

    await assert.rejects(
      () => hb.applyToolPatch({ check: { name: 'A', interval: '0 */5 * * * *' } }),
      /interval 非法/,
      '6 段表达式同样按非法处理',
    );
  });

  test('缺 prompt 的新检查项直接拒绝', async () => {
    const hb = mkHeartbeat({}, base());
    await assert.rejects(() => hb.applyToolPatch({ check: { name: 'C' } }), /缺少 prompt/);
    assert.equal(hb.checks.length, 1);
  });

  test('enabled / dynamic_prompt 一起更新：停调度并触发持久化回调', async () => {
    let persisted = 0;
    const hb = mkHeartbeat({}, { enabled: true, interval: '* * * * *', checks: [{ name: 'A', prompt: 'p' }] });
    hb.setOnConfigChanged(() => { persisted += 1; });
    hb.start();
    assert.equal(hb.tasks.length, 1);

    await hb.applyToolPatch({ enabled: false, dynamic_prompt: '巡检X' });

    assert.equal(hb.enabled, false);
    assert.equal(hb.getTaskContent(), '巡检X');
    assert.equal(hb.tasks.length, 0, '关闭后必须停掉调度');
    assert.equal(persisted, 1, '配置变更必须落盘');
  });

  test('全局 interval 传空串时忽略并在变更说明里回话', async () => {
    const hb = mkHeartbeat({}, base());
    const changes = await hb.applyToolPatch({ interval: '   ' });

    assert.match(changes.join(' '), /已忽略本次提交/);
    assert.equal(hb.interval, '* * * * *', '空串不是"继承全局"，原值必须保留');
  });

  test('没有任何可识别字段时返回空变更，不乱动配置', async () => {
    const hb = mkHeartbeat({}, base());
    assert.deepEqual(await hb.applyToolPatch({}), []);
    assert.equal(hb.checks[0].prompt, 'p1');
  });

  test('dispatcher 能路由 update 并由 get 返回完整配置', async () => {
    const hb = mkHeartbeat({}, { enabled: false, interval: '* * * * *', checks: [] });

    const out = await handleManagementTool(
      { _heartbeat: hb },
      'mgmt_heartbeat_update',
      { check: { name: 'C', prompt: 'pc' } },
    );
    assert.match(out, /已更新心跳配置/);

    const snapshot = JSON.parse(
      await handleManagementTool({ _heartbeat: hb }, 'mgmt_heartbeat_get', {}),
    );
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.interval, '* * * * *');
    assert.equal(snapshot.checks.length, 1);
    assert.equal(snapshot.checks[0].name, 'C');
  });
});

describe('Heartbeat 配置热更新', () => {
  const CHECKS = [{ name: 'A', prompt: 'p' }];

  test('禁用后再启用（interval 未变）不得永久停摆', () => {
    const hb = mkHeartbeat({}, { enabled: true, interval: '* * * * *', checks: CHECKS });
    hb.start();
    const initial = hb.tasks.length;
    assert.ok(initial > 0);

    hb.updateConfig({ interval: '* * * * *', checks: CHECKS, enabled: false });
    assert.equal(hb.tasks.length, 0, '禁用后应停止');

    hb.updateConfig({ interval: '* * * * *', checks: CHECKS, enabled: true });
    assert.equal(hb.tasks.length, initial, '重新启用后必须恢复调度');
  });

  test('interval 变更触发重启', () => {
    const hb = mkHeartbeat({}, { enabled: true, interval: '*/5 * * * *', checks: CHECKS });
    hb.start();
    hb.updateConfig({ interval: '*/10 * * * *', checks: CHECKS, enabled: true });
    assert.equal(hb.interval, '*/10 * * * *');
    assert.ok(hb.tasks.length > 0);
  });

  test('热更新不会丢失动态巡检内容', () => {
    const hb = mkHeartbeat({}, { enabled: true, interval: '* * * * *', checks: CHECKS });
    hb.setTaskContent('动态内容');
    hb.updateConfig({
      enabled: true, interval: '* * * * *', checks: CHECKS, dynamic_prompt: undefined,
    });
    assert.equal(hb.getTaskContent(), '动态内容', '未提供该字段时不应清空');
  });
});
