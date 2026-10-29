import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import Heartbeat, { DYNAMIC_CHECK_NAME } from '../../src/services/heartbeat.js';

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
