import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatEnvValue,
  parseEnvValue,
  listEnvEntries,
  getEnvValue,
  patchEnvVars,
  deleteEnvVars,
  maskEnvValue,
  isValidEnvKey,
} from '../../src/services/envfile.js';
import { handleToolCall } from '../../src/services/tools/dispatcher.js';

describe('.env 读写原语', () => {
  test('格式化与解析严格对称', () => {
    // 简单值不加引号
    assert.equal(formatEnvValue('abc'), 'abc');
    assert.equal(parseEnvValue('abc'), 'abc');
    // 含空格 / # / 引号必须加引号，否则 dotenv 会把 # 之后当注释
    assert.equal(formatEnvValue('a b'), '"a b"');
    assert.equal(formatEnvValue('abc #123'), '"abc #123"');
    assert.equal(parseEnvValue('"abc #123"'), 'abc #123');
    // 值本身含双引号时改用单引号包裹
    assert.equal(formatEnvValue('say "hi"'), `'say "hi"'`);
    // 空值写成 KEY=
    assert.equal(formatEnvValue(''), '');
  });

  test('同名键以最后一次出现为准', () => {
    const text = 'A=1\nA=2\nB=3\n';
    assert.equal(getEnvValue(text, 'A'), '2');
    assert.deepEqual(listEnvEntries(text), [
      { key: 'A', value: '2' },
      { key: 'B', value: '3' },
    ]);
    assert.equal(getEnvValue(text, 'NOPE'), null);
  });

  test('patch 就地更新并保留注释、顺序，未命中则追加', () => {
    const text = '# 顶部注释\nA=1\n\n# 段落\nB=2';
    const out = patchEnvVars(text, { A: 'a b', C: '3' });
    const lines = out.split('\n');
    assert.equal(lines[0], '# 顶部注释');
    assert.equal(lines[1], 'A="a b"', '必须保留原位并加引号');
    assert.equal(lines[3], '# 段落');
    assert.ok(out.endsWith('C=3\n'), '新变量追加到末尾');
    assert.equal(getEnvValue(out, 'B'), '2', '其它变量不受影响');
  });

  test('patch 会改写同名重复行，避免「改了却不生效」', () => {
    const out = patchEnvVars('A=1\nA=1\n', { A: '2' });
    assert.equal(out, 'A=2\nA=2\n');
  });

  test('delete 删除整行且只删目标键', () => {
    const text = '# keep\nA=1\nB=2\nA=3\n';
    const { text: out, removed } = deleteEnvVars(text, ['A']);
    assert.deepEqual(removed, ['A']);
    assert.equal(out, '# keep\nB=2\n');
    // 不存在的键不算 removed
    assert.deepEqual(deleteEnvVars(text, ['X']).removed, []);
  });

  test('掩码不泄露原值', () => {
    assert.equal(maskEnvValue(''), '(空)');
    assert.equal(maskEnvValue('short'), '****');
    const masked = maskEnvValue('sk-1234567890abcdef');
    assert.ok(!masked.includes('234567890abc'), masked);
  });

  test('变量名校验', () => {
    assert.equal(isValidEnvKey('OPENAI_API_KEY'), true);
    assert.equal(isValidEnvKey('_x1'), true);
    assert.equal(isValidEnvKey('1ABC'), false);
    assert.equal(isValidEnvKey('A-B'), false);
    assert.equal(isValidEnvKey('A B'), false);
  });
});

describe('env_* 工具', () => {
  const makeEnv = async (content = '') => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envtool-'));
    const file = path.join(dir, '.env');
    await fs.writeFile(file, content, 'utf8');
    const reloads = [];
    const ctx = {
      _envPath: file,
      _onEnvChanged: async () => { reloads.push(1); return { updated: ['X'], removed: [] }; },
    };
    return { dir, file, ctx, reloads };
  };

  test('list 返回掩码值，get 返回明文', async () => {
    const { dir, ctx } = await makeEnv('OPENAI_API_KEY=sk-abcdefghijklmn\nDEBUG=true\n');
    try {
      const list = await handleToolCall(ctx, 'env_list', {});
      assert.match(list, /OPENAI_API_KEY=sk-\*\*\*\*lmn/);
      assert.match(list, /DEBUG=\*\*\*\*/, '短值应完全掩码');

      const got = await handleToolCall(ctx, 'env_get', { key: 'OPENAI_API_KEY' });
      assert.match(got, /OPENAI_API_KEY=sk-abcdefghijklmn/);
      assert.match(await handleToolCall(ctx, 'env_get', { key: 'NOPE' }), /未找到变量/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('set 新增/修改并触发热加载', async () => {
    const { dir, file, ctx, reloads } = await makeEnv('# 注释\nA=1\n');
    try {
      const created = await handleToolCall(ctx, 'env_set', { key: 'B', value: 'hello world' });
      assert.match(created, /已新增/);
      assert.match(created, /已同步到进程内存/);

      const updated = await handleToolCall(ctx, 'env_set', { key: 'A', value: '2' });
      assert.match(updated, /已更新/);

      const content = await fs.readFile(file, 'utf8');
      assert.equal(content, '# 注释\nA=2\nB="hello world"\n');
      assert.equal(reloads.length, 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('set 拒绝非法变量名与含换行的值（防注入多行）', async () => {
    const { dir, file, ctx, reloads } = await makeEnv('A=1\n');
    try {
      assert.match(await handleToolCall(ctx, 'env_set', { key: '1BAD', value: 'x' }), /非法的变量名/);
      assert.match(
        await handleToolCall(ctx, 'env_set', { key: 'A', value: 'x\nB=2' }),
        /不能包含换行/,
      );
      assert.equal(await fs.readFile(file, 'utf8'), 'A=1\n', '被拒绝的写入不得落盘');
      assert.equal(reloads.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('delete 删除变量并触发热加载；不存在时给出提示', async () => {
    const { dir, file, ctx, reloads } = await makeEnv('A=1\nB=2\n');
    try {
      const out = await handleToolCall(ctx, 'env_delete', { key: 'A' });
      assert.match(out, /已删除环境变量: A/);
      assert.equal(await fs.readFile(file, 'utf8'), 'B=2\n');
      assert.equal(reloads.length, 1);

      assert.match(await handleToolCall(ctx, 'env_delete', { key: 'A' }), /未找到变量/);
      assert.equal(reloads.length, 1, '未发生修改时不应触发热加载');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('无热加载回调时明确提示需重启', async () => {
    const { dir, ctx } = await makeEnv('A=1\n');
    try {
      const out = await handleToolCall({ _envPath: ctx._envPath }, 'env_set', { key: 'B', value: '2' });
      assert.match(out, /需重启进程才生效/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
