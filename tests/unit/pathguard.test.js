import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  isInside, isSensitive, isMediaFile, FileAccessPolicy,
} from '../../src/services/pathguard.js';

describe('pathguard.isInside — 杜绝前缀绕过', () => {
  test('同类目录名不得被误判为内部', () => {
    assert.equal(isInside('/proj/workspace', '/proj/workspace-evil/x'), false);
  });
  test('正常子路径通过', () => {
    assert.equal(isInside('/proj/workspace', '/proj/workspace/a/b.txt'), true);
  });
  test('默认排除根目录自身', () => {
    assert.equal(isInside('/proj/workspace', '/proj/workspace'), false);
  });
  test('显式 includeSelf 时允许根目录自身', () => {
    assert.equal(isInside('/proj/workspace', '/proj/workspace', true), true);
  });
  test('../ 逃逸被识别', () => {
    assert.equal(isInside('/proj/workspace', '/proj/workspace/../etc/passwd'), false);
  });
});

describe('pathguard.isSensitive — 敏感黑名单', () => {
  for (const p of [
    '/app/.env', '/app/.env.local', '/app/.npmrc',
    '/root/.ssh/id_rsa', path.join(os.homedir(), '.aws', 'credentials'),
    '/a/b/token.json', '/a/auth_data.json', '/a/secret.key', '/a/data.db',
    '/repo/.git/config',
  ]) {
    test(`拒绝 ${p.replace(os.homedir(), '~')}`, () => {
      assert.equal(isSensitive(p), true);
    });
  }
  test('普通文件不被误判', () => {
    assert.equal(isSensitive('/proj/workspace/notes.md'), false);
  });
});

describe('pathguard.isMediaFile', () => {
  test('识别图片后缀', () => {
    assert.equal(isMediaFile('/x/qr.png'), true);
    assert.equal(isMediaFile('/x/qr.jpg'), true);
  });
  test('非媒体返回 false', () => {
    assert.equal(isMediaFile('/x/config.json'), false);
  });
});

describe('FileAccessPolicy — 读/写沙箱', () => {
  const WS = '/proj/workspace';
  const p = new FileAccessPolicy({ workspaceDir: WS });

  // 修复前：file_read / file_list 完全没有沙箱，可读任意绝对路径
  for (const bad of ['/etc/passwd', '../package.json', '/proj/src/agent.js', '/proj/config/agent.yaml']) {
    test(`读操作拒绝越界路径 ${bad}`, () => {
      assert.equal(p.allowRead(bad).ok, false);
    });
  }

  test('读取凭据被拒', () => {
    const cred = path.join(os.homedir(), '.miot-mcp', 'auth_data.json');
    assert.equal(p.allowRead(cred).ok, false);
  });

  test('工作区根可被列举（file_list 默认 "."）', () => {
    assert.equal(p.allowRead('.').ok, true);
  });

  test('工作区内文件可读可写', () => {
    assert.equal(p.allowRead('report.md').ok, true);
    assert.equal(p.allowWrite('report.md').ok, true);
  });

  test('写操作禁止越界', () => {
    assert.equal(p.allowWrite('/tmp/x').ok, false);
  });

  test('前缀绕过：/proj/workspace-evil 不可写', () => {
    assert.equal(p.allowWrite('/proj/workspace-evil/a.txt').ok, false);
  });

  test('黑名单优先：工作区内的 .env 也禁止', () => {
    assert.equal(p.allowRead('/proj/workspace/.env').ok, false);
  });

  test('媒体只读目录：二维码图片放行', () => {
    const qr = path.join(os.homedir(), '.miot-mcp', 'qr.png');
    assert.equal(p.allowRead(qr).ok, true);
  });

  test('媒体只读目录：非媒体文件拒绝', () => {
    const cfg = path.join(os.homedir(), '.miot-mcp', 'config.json');
    assert.equal(p.allowRead(cfg).ok, false);
  });

  test('额外只读根目录按配置放行', () => {
    const p2 = new FileAccessPolicy({ workspaceDir: WS, readRoots: ['/data/reports'] });
    assert.equal(p2.allowRead('/data/reports/x.md').ok, true);
    assert.equal(p2.allowWrite('/data/reports/x.md').ok, false, '只读根目录不可写');
    assert.equal(p2.allowRead('/data/other/x.md').ok, false);
  });

  test('拒绝信息包含可读根目录，便于模型自助纠正', () => {
    const r = p.allowRead('/etc/passwd');
    assert.equal(r.ok, false);
    assert.ok(typeof r.reason === 'string' && r.reason.includes(WS));
  });
});
