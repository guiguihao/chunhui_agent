import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { formatEnvValue, parseEnvValue, patchEnvVars, readEnvVars } from '../../plugin/webui.js';

/**
 * 覆盖 WebUI 编辑 .env 的「读取 → 保存」往返流程。
 *
 * 历史缺陷：GET /api/env 会剥掉值的引号，POST /api/env 又直接拼 `key=value`。
 * 于是含 `#`、空格或引号的值第二次解析时会被截断或报错 —— 静默丢数据。
 */
const parseForUi = (content) => content.split('\n').map((line, idx) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return { idx, type: 'comment', raw: line };
  const eqPos = line.indexOf('=');
  if (eqPos === -1) return { idx, type: 'comment', raw: line };
  return {
    idx,
    type: 'var',
    key: line.slice(0, eqPos).trim(),
    value: parseEnvValue(line.slice(eqPos + 1)),
  };
});

const serializeForFile = (lines) => lines.map(l => (
  l.type === 'comment' ? l.raw : `${l.key}=${formatEnvValue(l.value)}`
)).join('\n');

describe('formatEnvValue — 保存时的安全字面量', () => {
  test('普通值不加引号', () => {
    assert.equal(formatEnvValue('sk-abc123'), 'sk-abc123');
    assert.equal(formatEnvValue('http://a.b/v1'), 'http://a.b/v1');
  });

  test('空值输出为空（保留 KEY= 结构）', () => {
    assert.equal(formatEnvValue(''), '');
    assert.equal(formatEnvValue(undefined), '');
  });

  test('含空格的值必须加引号', () => {
    assert.equal(formatEnvValue('a b c'), '"a b c"');
  });

  test('含 # 的值必须加引号，否则会被当注释截断', () => {
    assert.equal(formatEnvValue('abc #123'), '"abc #123"');
  });

  test('含双引号时改用单引号包裹（dotenv 不认 \\" 转义）', () => {
    assert.equal(formatEnvValue('say "hi"'), `'say "hi"'`);
  });

  test('含单引号时用双引号包裹', () => {
    assert.equal(formatEnvValue("it's here"), `"it's here"`);
  });

  test('反斜杠绝不能被转义', () => {
    assert.equal(formatEnvValue('C:\\path\\to\\x'), 'C:\\path\\to\\x');
  });
});

describe('.env 往返一致性（GET → POST → 重新解析）', () => {
  const cases = [
    ['PLAIN', 'simple_value'],
    ['WITH_SPACE', 'hello world'],
    ['WITH_HASH', 'token # not a comment'],
    ['WITH_QUOTE', 'say "hi"'],
    ['WITH_SQUOTE', "it's here"],
    ['BACKSLASH', 'C:\\path\\to\\x'],
    ['URL', 'http://192.168.1.1:8123/api'],
    ['EMPTY', ''],
    ['CHINESE', '中文值 带空格'],
  ];

  for (const [key, value] of cases) {
    test(`往返后值不变: ${key}`, () => {
      const original = `${key}=${formatEnvValue(value)}`;
      const lines = parseForUi(original);
      const saved = serializeForFile(lines);

      const reparsed = dotenv.parse(saved);
      assert.equal(reparsed[key], value, `写入内容: ${saved}`);
    });
  }

  test('多行文件整体往返不丢键', () => {
    const original = [
      '# 注释保留',
      'A=1',
      '',
      'B="x y"',
      'C=plain',
    ].join('\n');
    const saved = serializeForFile(parseForUi(original));
    const reparsed = dotenv.parse(saved);

    assert.deepEqual(Object.keys(reparsed).sort(), ['A', 'B', 'C']);
    assert.equal(reparsed.B, 'x y');
    assert.ok(saved.includes('# 注释保留'), '注释行必须保留');
  });

  test('修复前的写法会导致 # 之后被截断（回归对照）', () => {
    // 模拟旧实现：直接拼 key=value
    const broken = dotenv.parse('NOTE=abc #123');
    assert.equal(broken.NOTE, 'abc', '旧写法确实会丢掉 #123');

    // 新实现
    const fixed = dotenv.parse(`NOTE=${formatEnvValue('abc #123')}`);
    assert.equal(fixed.NOTE, 'abc #123');
  });
});

/**
 * patchEnvVars 是渠道配置弹窗的写入路径：只改指定 key，
 * 其余行（注释、空行、顺序、其他变量）必须原样保留 ——
 * 否则「改飞书凭证」会顺手抹掉别人的 API Key。
 */
describe('patchEnvVars — 按 key 就地更新', () => {
  const ORIGINAL = [
    '# 微信/飞书凭证',
    'FEISHU_APP_ID=cli_old',
    '',
    'FEISHU_APP_SECRET=old_secret',
    'DEEPSEEK_API_KEY=sk-keepme # 别动',
  ].join('\n');

  test('只改目标 key，注释与其他变量保持不变', () => {
    const out = patchEnvVars(ORIGINAL, { FEISHU_APP_ID: 'cli_new' });
    assert.ok(out.includes('# 微信/飞书凭证'));
    assert.ok(out.includes('DEEPSEEK_API_KEY=sk-keepme # 别动'));
    assert.ok(out.includes('FEISHU_APP_SECRET=old_secret'));

    const parsed = dotenv.parse(out);
    assert.equal(parsed.FEISHU_APP_ID, 'cli_new');
    assert.equal(parsed.FEISHU_APP_SECRET, 'old_secret');
  });

  test('文件里没有的 key 追加到末尾', () => {
    const out = patchEnvVars('A=1\n', { FEISHU_APP_SECRET: 'sec' });
    assert.equal(out, 'A=1\nFEISHU_APP_SECRET=sec\n');
    assert.equal(dotenv.parse(out).FEISHU_APP_SECRET, 'sec');
  });

  test('文件末尾没有换行时也不会和上一行粘在一起', () => {
    const out = patchEnvVars('A=1', { B: '2' });
    assert.equal(out, 'A=1\nB=2\n');
  });

  test('空字符串表示清空，写回 KEY= 结构', () => {
    const out = patchEnvVars(ORIGINAL, { FEISHU_APP_SECRET: '' });
    assert.ok(out.includes('FEISHU_APP_SECRET=\n'));
    assert.equal(dotenv.parse(out).FEISHU_APP_SECRET, '');
  });

  test('含空格 / # 的值必须加引号后才写回', () => {
    const out = patchEnvVars(ORIGINAL, { FEISHU_APP_SECRET: 'a b #c' });
    assert.equal(dotenv.parse(out).FEISHU_APP_SECRET, 'a b #c');
  });

  test('相似前缀的 key 不会被误改', () => {
    const src = 'FEISHU_APP_ID_OLD=x\nFEISHU_APP_ID=y\n';
    const out = patchEnvVars(src, { FEISHU_APP_ID: 'z' });
    const parsed = dotenv.parse(out);
    assert.equal(parsed.FEISHU_APP_ID_OLD, 'x');
    assert.equal(parsed.FEISHU_APP_ID, 'z');
  });

  test('undefined 表示不改（前端只提交部分字段时）', () => {
    const out = patchEnvVars(ORIGINAL, { FEISHU_APP_ID: undefined, FEISHU_APP_SECRET: 'new' });
    const parsed = dotenv.parse(out);
    assert.equal(parsed.FEISHU_APP_ID, 'cli_old');
    assert.equal(parsed.FEISHU_APP_SECRET, 'new');
  });
});

describe('readEnvVars — 只读取关心的变量', () => {
  test('返回指定 key 并剥掉引号', () => {
    const src = ['# c', 'FEISHU_APP_ID="cli_x"', "FEISHU_APP_SECRET='s e c'", 'OTHER=1'].join('\n');
    assert.deepEqual(readEnvVars(src, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']), {
      FEISHU_APP_ID: 'cli_x',
      FEISHU_APP_SECRET: 's e c',
    });
  });

  test('缺失的 key 不出现在结果里', () => {
    assert.deepEqual(readEnvVars('A=1', ['FEISHU_APP_ID']), {});
  });

  test('注释行不会被当成变量', () => {
    assert.deepEqual(readEnvVars('# FEISHU_APP_ID=cli_x', ['FEISHU_APP_ID']), {});
  });
});
