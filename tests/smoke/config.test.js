import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import cron from 'node-cron';
import { isValidCron } from '../../src/services/cron-utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = path.join(ROOT, 'config');

const load = async (name) => yaml.parse(await fs.readFile(path.join(CONFIG, name), 'utf8'));

describe('配置文件完整性', () => {
  test('所有 YAML 配置均可解析', async () => {
    for (const f of ['agent.yaml', 'cron.yaml', 'heartbeat.yaml', 'plugin.yaml']) {
      const parsed = await load(f);
      assert.ok(parsed && typeof parsed === 'object', `${f} 解析失败`);
    }
  });

  test('mcporter.json 合法且结构正确', async () => {
    const cfg = JSON.parse(await fs.readFile(path.join(CONFIG, 'mcporter.json'), 'utf8'));
    assert.ok(cfg.mcpServers, '缺少 mcpServers');
    assert.ok(typeof cfg.mcpServers === 'object');
  });

  test('agent.yaml 具备必需字段', async () => {
    const cfg = await load('agent.yaml');
    assert.ok(cfg.agent, '缺少 agent 节点');
    assert.ok(cfg.models, '缺少 models 节点（存放 provider 与模型定义）');
    assert.ok(cfg.agent.system_prompt, '缺少 agent.system_prompt');
  });

  test('models 节点至少包含一个可用的 provider', async () => {
    const cfg = await load('agent.yaml');
    const providers = Object.keys(cfg.models || {});
    assert.ok(providers.length > 0, 'models 下必须定义至少一个 provider');
  });
});

describe('Cron 表达式合法性', () => {
  // node-cron 对非法表达式会抛错，而 Scheduler.registerTasks 外层无保护，
  // 一条坏配置会让整个 Agent 启动失败，故在此提前拦截。
  test('cron.yaml 中所有任务的表达式有效', async () => {
    const cfg = await load('cron.yaml');
    for (const t of cfg.cron.tasks) {
      assert.ok(cron.validate(t.cron), `任务 ${t.id} 的表达式非法: ${t.cron}`);
    }
  });

  test('heartbeat.yaml 的 interval 有效', async () => {
    const cfg = await load('heartbeat.yaml');
    // 与 WebUI / 心跳服务同口径（5 段），不能用 node-cron 的 validate：
    // 后者接受 6 段带秒表达式，会造成「冒烟通过、保存被拒」
    assert.ok(isValidCron(cfg.heartbeat.interval),
      `heartbeat interval 非法: ${cfg.heartbeat.interval}`);
  });

  test('heartbeat interval 与注释语义一致（每 5 分钟）', async () => {
    const cfg = await load('heartbeat.yaml');
    // 历史缺陷：曾写为 "*/60"，实际是每小时一次，与「每5分钟」的注释不符
    assert.equal(cfg.heartbeat.interval, '*/5 * * * *');
  });

  test('heartbeat.yaml 中检查项的 interval 有效', async () => {
    const cfg = await load('heartbeat.yaml');
    for (const c of cfg.heartbeat.checks || []) {
      // interval 可留空（继承全局），填了就必须是合法 cron
      if (!c.interval) continue;
      assert.ok(isValidCron(c.interval),
        `检查项 ${c.name || '(未命名)'} 的 interval 非法: ${c.interval}`);
    }
  });

  test('heartbeat.yaml 中检查项的 enabled 为布尔值', async () => {
    const cfg = await load('heartbeat.yaml');
    for (const c of cfg.heartbeat.checks || []) {
      if (c.enabled === undefined) continue;
      assert.equal(typeof c.enabled, 'boolean',
        `检查项 ${c.name || '(未命名)'} 的 enabled 必须是布尔值`);
    }
  });

  test('cron.yaml 中不存在重复任务 ID', async () => {
    const cfg = await load('cron.yaml');
    const ids = cfg.cron.tasks.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, `存在重复 ID: ${ids}`);
  });

  test('每个定时任务都有 prompt', async () => {
    const cfg = await load('cron.yaml');
    for (const t of cfg.cron.tasks) {
      assert.ok(t.enabled === false || (t.prompt && t.prompt.length > 0),
        `启用的任务 ${t.id} 缺少 prompt`);
    }
  });
});
