import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Scheduler, { mergeConfiguredTasks } from '../../src/services/scheduler.js';

/**
 * 重点覆盖历史 bug：saveCronTasks 会把「未注册」的任务（即配置里 enabled:false 的）
 * 从 cron.yaml 中静默抹除，造成不可逆的配置丢失。
 */
const FIXTURE = [
  { id: 'enabled_a', name: '启用的A', cron: '0 7 * * *', enabled: true, prompt: 'pa' },
  { id: 'disabled_b', name: '禁用的B', cron: '0 8 * * *', enabled: false, prompt: 'pb' },
  { id: 'disabled_c', name: '禁用的C', cron: '0 9 * * *', enabled: false, prompt: 'pc' },
];

const build = () => {
  const s = new Scheduler();
  s.registerTasks(FIXTURE, async () => {});
  return s;
};

describe('Scheduler 禁用任务持久化', () => {
  test('禁用任务同样被注册（否则持久化时会丢失）', () => {
    const s = build();
    assert.equal(s.listTasks().length, 3);
    s.stopAll();
  });

  test('listTasks 正确反映启用状态', () => {
    const s = build();
    const map = Object.fromEntries(s.listTasks().map(t => [t.id, t.enabled]));
    assert.equal(map.enabled_a, true);
    assert.equal(map.disabled_b, false);
    s.stopAll();
  });

  test('disable 后可被持久化（此前会导致重启后复活）', () => {
    const s = build();
    s.disable('enabled_a');
    assert.equal(s.listTasks().find(t => t.id === 'enabled_a').enabled, false);
    s.stopAll();
  });

  test('禁用的任务可被 enable 救回（此前会报“任务不存在”）', () => {
    const s = build();
    assert.equal(s.enable('disabled_b'), true);
    const t = s.listTasks().find(x => x.id === 'disabled_b');
    assert.equal(t.enabled, true);
    assert.equal(t.running, true);
    s.stopAll();
  });

  test('startAll 不拉起被禁用的任务', () => {
    const s = build();
    s.startAll();
    const running = s.listTasks().filter(t => t.running).map(t => t.id);
    assert.deepEqual(running, ['enabled_a']);
    s.stopAll();
  });

  test('回写后全部任务（含禁用）仍在 YAML 中', async () => {
    const s = build();
    s.disable('enabled_a');
    const written = s.listTasks().map(t => ({ id: t.id, enabled: t.enabled !== false }));
    assert.equal(written.length, 3, '回写集合必须包含全部 3 条');
    assert.deepEqual(written.filter(t => !t.enabled).map(t => t.id).sort(),
      ['disabled_b', 'disabled_c', 'enabled_a']);
    s.stopAll();
  });
});

describe('saveCronTasks 快照合并', () => {
  test('注册失败的任务不会被保存流程抹掉', () => {
    const s = new Scheduler();
    // 只有合法任务能注册成功；bad 会抛错并被 registerTasks 记入 failed
    const { failed } = s.registerTasks([
      { id: 'ok', name: '正常', cron: '0 7 * * *', enabled: true, prompt: 'p' },
      { id: 'bad', name: '非法', cron: 'not-a-cron', enabled: true, prompt: 'p' },
    ], async () => {});

    assert.equal(failed.length, 1);
    const listed = s.listTasks();
    assert.equal(listed.length, 1);

    const merged = mergeConfiguredTasks(listed, [
      { id: 'ok', name: '正常', cron: '0 7 * * *', enabled: true, prompt: 'p' },
      { id: 'bad', name: '非法', cron: 'not-a-cron', enabled: true, prompt: 'p' },
    ]);
    assert.equal(merged.length, 2, '配置中存在但注册失败的任务必须保留');
    assert.deepEqual(merged.map(t => t.id), ['ok', 'bad'], '保持原顺序，补充项追加在后');
    s.stopAll();
  });

  test('重复 id 不会被合并成两条', () => {
    const merged = mergeConfiguredTasks(
      [{ id: 'a', cron: '0 7 * * *' }],
      [{ id: 'a', cron: '0 7 * * *' }, { id: 'b', cron: '0 8 * * *' }]
    );
    assert.deepEqual(merged.map(t => t.id), ['a', 'b']);
  });

  test('配置为空/缺省时保持原快照不变', () => {
    const listed = [{ id: 'a', cron: '0 7 * * *' }];
    assert.deepEqual(mergeConfiguredTasks(listed, undefined), listed);
    assert.deepEqual(mergeConfiguredTasks(listed, []), listed);
  });
});

describe('Scheduler 生命周期', () => {
  test('unregister 后任务彻底移除', () => {
    const s = new Scheduler();
    s.register('tmp1', '0 7 * * *', async () => {}, { autoStart: false });
    assert.equal(s.listTasks().length, 1);
    s.unregister('tmp1');
    assert.equal(s.listTasks().length, 0);
  });

  test('register 非法 cron 表达式会抛错（调用方需自行兜底）', () => {
    const s = new Scheduler();
    assert.throws(() => s.register('bad', 'not-a-cron', async () => {}, { autoStart: false }));
  });
});

describe('真实 cron.yaml 回归', () => {
  test('现有配置中的禁用任务全部保留', async () => {
    const yaml = (await import('yaml')).default;
    const raw = await fs.readFile(new URL('../../config/cron.yaml', import.meta.url), 'utf8');
    const tasks = yaml.parse(raw).cron.tasks;
    const s = new Scheduler();
    s.registerTasks(tasks, async () => {});
    const ids = s.listTasks().map(t => t.id);
    for (const t of tasks) {
      assert.ok(ids.includes(t.id), `任务 ${t.id} 丢失`);
    }
    s.stopAll();
  });
});
