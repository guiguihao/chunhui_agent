import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import MemoryService from '../../src/services/memory.js';

const setup = async (opts = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-'));
  return { dir, svc: new MemoryService({ directory: dir, ...opts }) };
};

describe('MemoryService 记忆生命周期', () => {
  test('未超阈值时不归档', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 5000 });
    try {
      await svc.init();
      await svc.writeFile('FACTS.md', '# FACTS\n\n## 一段\n内容不多\n');
      const moved = await svc.archiveOverflow('FACTS.md');
      assert.equal(moved, 0, '不该触发归档');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('超阈值时最旧章节被移入 _archive/，最新章节保留', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 80 });
    try {
      await svc.init();
      const content = [
        '# FACTS',
        '',
        '## 最旧的章节',
        'OLD-SECTION-MARKER',
        '',
        '## 中间章节',
        'MID-SECTION-MARKER',
        '',
        '## 最新章节',
        'NEW-SECTION-MARKER',
        '',
      ].join('\n');
      await svc.writeFile('FACTS.md', content);

      const moved = await svc.archiveOverflow('FACTS.md');
      assert.ok(moved > 0, '应归档至少一个章节');

      const kept = await svc.loadFacts();
      assert.ok(kept.includes('NEW-SECTION-MARKER'), '最新章节必须保留');
      assert.ok(!kept.includes('OLD-SECTION-MARKER'), '最旧章节应被移出');
      assert.ok(kept.startsWith('# FACTS'), '文件头必须保留');

      const archived = await fs.readdir(path.join(dir, '_archive'));
      assert.ok(archived.length > 0, '必须生成归档文件');
      const archiveText = await fs.readFile(path.join(dir, '_archive', archived[0]), 'utf8');
      assert.ok(archiveText.includes('OLD-SECTION-MARKER'), '旧章节应存在于归档中');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('archive_after_chars 为 0 时关闭归档', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 0 });
    try {
      await svc.init();
      await svc.writeFile('FACTS.md', '# FACTS\n\n## A\n' + 'x'.repeat(500) + '\n\n## B\n' + 'y'.repeat(500));
      const moved = await svc.archiveOverflow('FACTS.md');
      assert.equal(moved, 0, '关闭后不应归档');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('单个超长章节无法拆分时不误删内容', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 50 });
    try {
      await svc.init();
      await svc.writeFile('FACTS.md', '# FACTS\n\n## 唯一章节\n' + 'z'.repeat(500));
      const moved = await svc.archiveOverflow('FACTS.md');
      assert.equal(moved, 0, '无法拆分时不应修改文件');
      const kept = await svc.loadFacts();
      assert.ok(kept.includes('z'.repeat(500)), '内容必须完整');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MemoryService 上下文注入裁剪', () => {
  test('默认按 max_context_chars 裁剪并保留最新内容', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 0, max_context_chars: 200 });
    try {
      await svc.init();
      await svc.writeFile('KNOWLEDGE.md', '# KNOWLEDGE\n\n' + 'A'.repeat(1000) + '\nEND-MARKER');
      const all = await svc.getAll();
      assert.ok(all.knowledge.length < 1000, '必须被裁剪');
      assert.ok(all.knowledge.includes('END-MARKER'), '必须保留最新内容');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('maxChars=0 时返回全文（便于 WebUI 等场景）', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 0, max_context_chars: 50 });
    try {
      await svc.init();
      await svc.writeFile('KNOWLEDGE.md', '# K\n\n' + 'B'.repeat(500));
      const all = await svc.getAll({ maxChars: 0 });
      assert.ok(all.knowledge.length >= 500, '应为全文');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('内容短于阈值时不发生裁剪', async () => {
    const { dir, svc } = await setup({ archive_after_chars: 0, max_context_chars: 5000 });
    try {
      await svc.init();
      await svc.writeFile('FACTS.md', '# FACTS\n\n短内容');
      const all = await svc.getAll();
      assert.ok(!all.facts.includes('较早内容已省略'), '不应出现省略提示');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
