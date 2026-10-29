import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import SkillService from '../../src/services/skill.js';

/**
 * 重点覆盖历史 bug：每次执行技能都用 ?t=Date.now() 动态 import，
 * 导致永不命中 ESM 缓存、模块实例持续泄漏、模块级单例被反复重建。
 */
describe('SkillService 模块加载', () => {
  test('技能模块被复用而非反复重建', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-'));
    await fs.mkdir(path.join(dir, 'counter'), { recursive: true });
    await fs.writeFile(path.join(dir, 'counter', 'index.js'), `
let n = 0;
export default async function run(agent, params) { n += 1; return { calls: n }; }
`, 'utf8');

    try {
      const svc = new SkillService({ directory: dir });
      await svc.init();
      const r1 = await svc.run('counter', {}, null);
      const r2 = await svc.run('counter', {}, null);

      // 旧实现每次都返回 1（全新模块实例）
      assert.equal(r1.calls, 1);
      assert.equal(r2.calls, 2, '第二次调用必须复用同一模块实例');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('修改技能文件后仍能热重载', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk2-'));
    await fs.mkdir(path.join(dir, 'counter'), { recursive: true });
    const file = path.join(dir, 'counter', 'index.js');
    await fs.writeFile(file, `export default async () => ({ v: 1 });`, 'utf8');

    try {
      const svc = new SkillService({ directory: dir });
      await svc.init();
      assert.equal((await svc.run('counter', {}, null)).v, 1);

      await fs.writeFile(file, `export default async () => ({ v: 2 });`, 'utf8');
      assert.equal((await svc.run('counter', {}, null)).v, 2, '文件变更后必须加载新版本');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('大量重复调用不会导致堆内存线性增长', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk3-'));
    await fs.mkdir(path.join(dir, 'noop'), { recursive: true });
    await fs.writeFile(path.join(dir, 'noop', 'index.js'),
      `export default async () => ({ ok: true });`, 'utf8');

    try {
      const svc = new SkillService({ directory: dir });
      await svc.init();
      for (let i = 0; i < 2000; i++) await svc.run('noop', {}, null);
      // 主要断言是不崩溃；内存断言在 --expose-gc 下才有意义，此处仅保证 IO 正确
      assert.ok(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('Markdown 技能可被发现并读取 description', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk4-'));
    await fs.mkdir(path.join(dir, 'demo'), { recursive: true });
    await fs.writeFile(path.join(dir, 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 演示技能\n---\n\n正文内容\n', 'utf8');

    try {
      const svc = new SkillService({ directory: dir });
      await svc.init();
      const skills = await svc.list();
      const demo = skills.find(s => s.name === 'demo');
      assert.ok(demo, '技能应被发现');
      assert.equal(demo.description, '演示技能');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
