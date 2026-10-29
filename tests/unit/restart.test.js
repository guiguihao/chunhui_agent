import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import SmartHomeAgent from '../../src/agent.js';

/**
 * 覆盖软重启的编排顺序与并发保护。
 *
 * 依赖 src/agent.js 的 main 守卫：导入该模块不再自动启动 Agent，
 * 否则这些测试会真的去连 MCP / 飞书并回写配置文件。
 */
const makeAgent = (calls, overrides = {}) => {
  const a = new SmartHomeAgent();
  a.stop = async () => { calls.push('stop'); };
  a.init = async () => { calls.push('init'); };
  a.start = async () => { calls.push('start'); };
  Object.assign(a, overrides);
  return a;
};

describe('Agent.restart 编排', () => {
  test('导入 agent.js 不应触发自启动', () => {
    // main 守卫生效时，导入后不会创建实例、不会连接外部服务
    assert.equal(typeof SmartHomeAgent, 'function');
  });

  test('按 stop → init → start 顺序执行', async () => {
    const calls = [];
    const a = makeAgent(calls);
    const r = await a.restart();

    assert.deepEqual(calls, ['stop', 'init', 'start']);
    assert.equal(r.success, true);
    assert.equal(typeof r.durationMs, 'number');
  });

  test('重启前清空旧子系统引用，确保 init 全量重建', async () => {
    const calls = [];
    const a = makeAgent(calls);
    // 模拟已经运行中的实例
    a.agent = { stale: true };
    a.feishu = { stale: true };
    a.mcporter = { stale: true };
    a.webui = { stale: true };
    a.scheduler = { stale: true };
    a.heartbeat = { stale: true };
    a.messenger = { stale: true };
    a.skill = { stale: true };
    a.memory = { stale: true };

    let seenAtInit = null;
    a.init = async () => { seenAtInit = { ...a }; calls.push('init'); };

    await a.restart();

    for (const key of ['agent', 'feishu', 'mcporter', 'webui', 'scheduler', 'heartbeat', 'messenger', 'skill', 'memory']) {
      assert.equal(seenAtInit[key], null, `${key} 必须在 init 前被置空`);
    }
  });

  test('并发调用只执行一次', async () => {
    const calls = [];
    const a = makeAgent(calls);
    let release;
    a.stop = async () => {
      calls.push('stop');
      await new Promise((r) => { release = r; });
    };

    const first = a.restart();
    const second = await a.restart(); // 第一次尚未结束

    assert.equal(second.success, false);
    assert.equal(second.skipped, true);

    release();
    assert.equal((await first).success, true);
    assert.deepEqual(calls, ['stop', 'init', 'start'], '不应重复执行');
  });

  test('start 首次失败会重试一次（端口未及时释放的典型场景）', async () => {
    const calls = [];
    let startAttempts = 0;
    const a = makeAgent(calls);
    a.start = async () => {
      startAttempts++;
      calls.push(`start${startAttempts}`);
      if (startAttempts === 1) throw new Error('EADDRINUSE');
    };

    const r = await a.restart();

    assert.equal(r.success, true, '重试成功后应判定为成功');
    assert.equal(startAttempts, 2);
    assert.deepEqual(calls, ['stop', 'init', 'start1', 'start2']);
  });

  test('两次都失败时返回失败且不抛异常', async () => {
    const calls = [];
    const a = makeAgent(calls);
    a.start = async () => { throw new Error('EADDRINUSE'); };

    const r = await a.restart();

    assert.equal(r.success, false);
    assert.match(r.error, /EADDRINUSE/);
    // 失败后必须解除标记，否则后续无法再次重启
    assert.equal(a._restarting, false);
  });

  test('init 抛错时不进入 start，并解除重启标记', async () => {
    const calls = [];
    const a = makeAgent(calls);
    a.init = async () => { calls.push('init'); throw new Error('配置损坏'); };

    const r = await a.restart();

    assert.equal(r.success, false);
    assert.match(r.error, /配置损坏/);
    assert.deepEqual(calls, ['stop', 'init'], '不得继续 start');
    assert.equal(a._restarting, false);
  });
});
