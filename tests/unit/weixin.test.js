import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WeixinService, {
  normalizeWeixinAccountId,
  resolveWeixinStateDir,
  buildWeixinPrompt,
} from '../../plugin/weixin.js';

/**
 * 微信渠道只用 tmpdir，不触碰真实的 ~/.openclaw，也不联网。
 */

describe('weixin: 账号 ID 规范化', () => {
  test('与 SDK 一致：小写并把 @ . 换成 -', () => {
    assert.equal(normalizeWeixinAccountId('B0F5860FDECB@im.bot'), 'b0f5860fdecb-im-bot');
    assert.equal(normalizeWeixinAccountId('  x@im.wechat  '), 'x-im-wechat');
  });

  test('空值不抛异常', () => {
    assert.equal(normalizeWeixinAccountId(undefined), '');
    assert.equal(normalizeWeixinAccountId(null), '');
  });
});

describe('weixin: 状态目录解析', () => {
  test('OPENCLAW_STATE_DIR 优先于 CLAWDBOT_STATE_DIR 与默认值', () => {
    const env = { OPENCLAW_STATE_DIR: ' /tmp/a ', CLAWDBOT_STATE_DIR: '/tmp/b' };
    assert.equal(resolveWeixinStateDir(env, '/home/u'), '/tmp/a');
  });

  test('空白值视为未设置，回落到 CLAWDBOT_STATE_DIR', () => {
    const env = { OPENCLAW_STATE_DIR: '   ', CLAWDBOT_STATE_DIR: '/tmp/b' };
    assert.equal(resolveWeixinStateDir(env, '/home/u'), '/tmp/b');
  });

  test('都没有时回落到 ~/.openclaw', () => {
    assert.equal(resolveWeixinStateDir({}, '/home/u'), path.join('/home/u', '.openclaw'));
  });
});

describe('weixin: 入站消息拼装', () => {
  test('纯文本原样返回', () => {
    assert.equal(buildWeixinPrompt('  开灯  ', undefined), '开灯');
  });

  test('媒体消息带上类型与本地路径', () => {
    const prompt = buildWeixinPrompt('看看这个', {
      type: 'image',
      filePath: '/tmp/x.png',
      fileName: 'x.png',
    });
    assert.match(prompt, /^看看这个/);
    assert.match(prompt, /图片/);
    assert.match(prompt, /\/tmp\/x\.png/);
  });

  test('只有媒体时也要有内容，避免空 prompt', () => {
    const prompt = buildWeixinPrompt('', { type: 'file', filePath: '/tmp/a.pdf' });
    assert.match(prompt, /文件/);
    assert.ok(prompt.includes('/tmp/a.pdf'));
  });
});

describe('weixin: 凭据落盘', () => {
  let tmpDir;
  let service;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-test-'));
    service = new WeixinService({ enabled: true }, {}, { stateDir: tmpDir });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('按 SDK 的格式写入 accounts.json 与账号文件', async () => {
    await service._saveAccount('abc-im-bot', {
      token: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      userId: 'user-1',
    });

    const index = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'openclaw-weixin', 'accounts.json'), 'utf8'),
    );
    assert.deepEqual(index, ['abc-im-bot']);

    const accountPath = path.join(tmpDir, 'openclaw-weixin', 'accounts', 'abc-im-bot.json');
    const account = JSON.parse(await fs.readFile(accountPath, 'utf8'));
    assert.equal(account.token, 'tok');
    assert.equal(account.userId, 'user-1');
    assert.equal(account.baseUrl, 'https://ilinkai.weixin.qq.com');
    assert.ok(account.savedAt);

    // token 属敏感信息，必须是 600
    const stat = await fs.stat(accountPath);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  test('snapshot 能反映已登录状态', async () => {
    const snap = await service.snapshot();
    assert.equal(snap.loggedIn, true);
    assert.equal(snap.accountId, 'abc-im-bot');
    assert.equal(snap.running, false);
    assert.equal(snap.canPush, false);
  });

  test('重新登录时保留原有 userId（只覆盖 token）', async () => {
    await service._saveAccount('abc-im-bot', { token: 'tok2' });
    const account = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'openclaw-weixin', 'accounts', 'abc-im-bot.json'), 'utf8'),
    );
    assert.equal(account.token, 'tok2');
    assert.equal(account.userId, 'user-1');
  });

  test('未连接时 broadcast 不抛异常（不能拖垮其他渠道的广播）', async () => {
    const ok = await service.broadcast('hello');
    assert.equal(ok, false);
  });
});
