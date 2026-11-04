import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebUIService from '../../plugin/webui.js';

/**
 * 覆盖新增的重启能力：
 *   - GET  /api/health  供前端轮询恢复状态
 *   - POST /api/restart 必须先返回响应再重启（否则浏览器只会看到连接中断）
 *
 * 用假的 agentInstance 驱动，避免真的拉起飞书 / MCP 子进程。
 */
const PORT = 18099;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('WebUI 健康检查', () => {
  let svc;
  let base;

  before(async () => {
    const fakeAgent = { _restarting: false, restart: async () => ({ success: true }) };
    svc = new WebUIService({ port: PORT }, fakeAgent);
    await svc.start();
    base = `http://127.0.0.1:${PORT}`;
  });

  after(async () => { await svc?.stop(); });

  test('健康检查返回 ok 与 pid', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pid, process.pid);
    assert.equal(data.restarting, false);
  });

  test('重启中的状态会被如实上报', async () => {
    svc.agentInstance._restarting = true;
    const data = await (await fetch(`${base}/api/health`)).json();
    assert.equal(data.restarting, true);
    svc.agentInstance._restarting = false;
  });
});

describe('WebUI 重启接口', () => {
  let svc;
  let base;
  let restartCalls;
  let restartResolve;

  before(async () => {
    restartCalls = 0;
    const fakeAgent = {
      _restarting: false,
      restart: () => {
        restartCalls++;
        return new Promise((resolve) => { restartResolve = resolve; });
      },
    };
    svc = new WebUIService({ port: PORT + 1 }, fakeAgent);
    await svc.start();
    base = `http://127.0.0.1:${PORT + 1}`;
  });

  after(async () => {
    restartResolve?.({ success: true });
    await svc?.stop();
  });

  test('接口先返回响应，再异步触发重启', async () => {
    const res = await fetch(`${base}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.restarting, true);

    // 响应到达时重启尚未开始（400ms 延迟），这正是关键设计：
    // 若同步重启，stop() 会关闭本连接，浏览器只能收到网络错误
    assert.equal(restartCalls, 0, '响应阶段不应已开始重启');

    await sleep(700);
    assert.equal(restartCalls, 1, '响应之后必须真正触发一次重启');
  });

  test('重启进行中重复请求返回 409', async () => {
    // 上一用例的重启尚未 resolve，_restarting 仍为 false（由真实 agent 维护），
    // 这里显式模拟进行中状态
    svc.agentInstance._restarting = true;
    const res = await fetch(`${base}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    svc.agentInstance._restarting = false;
  });

  test('agentInstance 不支持 restart 时返回 501', async () => {
    const bare = new WebUIService({ port: PORT + 2 }, {});
    await bare.start();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 2}/api/restart`, { method: 'POST' });
      assert.equal(res.status, 501);
    } finally {
      await bare.stop();
    }
  });
});

describe('WebUI 端口重试', () => {
  /**
   * 用桩替掉 app.listen 来测重试逻辑本身。
   * 不用真实端口冲突的原因：macOS 上 `::` 与 `0.0.0.0` 是两个独立 socket
   * （v6only=1），同一个端口号可以同时绑定两次，造不出 EADDRINUSE。
   */
  const stubListen = (service, errorCode) => {
    let attempts = 0;
    service.app = {
      listen() {
        attempts++;
        const emitter = new EventEmitter();
        emitter.close = (cb) => cb && cb();
        setImmediate(() => {
          const err = new Error('listen failed');
          err.code = errorCode;
          emitter.emit('error', err);
        });
        return emitter;
      },
    };
    return () => attempts;
  };

  test('EADDRINUSE 会重试到上限后抛错', async () => {
    const w = new WebUIService({ port: PORT + 4 }, { _restarting: false });
    const attempts = stubListen(w, 'EADDRINUSE');

    await assert.rejects(() => w.start(3, 10), (err) => err.code === 'EADDRINUSE');
    assert.equal(attempts(), 3, '应按最大次数重试');
    assert.equal(w.server, null, '失败后不应残留 server 句柄');
  });

  test('端口占用但重试期间释放则成功', async () => {
    const w = new WebUIService({ port: PORT + 4 }, { _restarting: false });
    let attempts = 0;
    w.app = {
      listen(port, cb) {
        attempts++;
        const emitter = new EventEmitter();
        emitter.close = (done) => done && done();
        if (attempts < 2) {
          setImmediate(() => {
            const err = new Error('busy');
            err.code = 'EADDRINUSE';
            emitter.emit('error', err);
          });
        } else {
          setImmediate(() => cb && cb());
        }
        return emitter;
      },
    };

    await w.start(3, 10);
    assert.equal(attempts, 2, '第二次应成功');
  });

  test('非端口占用类错误不重试', async () => {
    const w = new WebUIService({ port: PORT + 4 }, { _restarting: false });
    const attempts = stubListen(w, 'EACCES');

    await assert.rejects(() => w.start(3, 10), (err) => err.code === 'EACCES');
    assert.equal(attempts(), 1, 'EACCES 不应重试');
  });
});

describe('WebUI 心跳配置校验', () => {
  const port = 18188;
  let svc;
  let base;
  const cfgPath = new URL('../../config/heartbeat.yaml', import.meta.url);

  before(async () => {
    svc = new WebUIService({ port }, {});
    await svc.start();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => { await svc?.stop(); });

  const post = (body) => fetch(`${base}/api/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('空 interval 直接 400，且不改写配置文件', async () => {
    const fs = await import('node:fs/promises');
    const before = await fs.readFile(cfgPath, 'utf8');
    const res = await post({ enabled: true, interval: '', checks: [] });
    assert.equal(res.status, 400);
    assert.equal((await fs.readFile(cfgPath, 'utf8')), before, '非法请求不应落盘');
  });

  test('检查项 interval 非法时 400', async () => {
    const res = await post({
      enabled: true,
      interval: '*/5 * * * *',
      checks: [{ name: 'x', prompt: 'p', interval: 'bad cron' }],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /检查项/);
  });
});

describe('WebUI 端口可被重复绑定（软重启前提）', () => {
  test('stop() 后能在同一端口重新 start()', async () => {
    const port = PORT + 3;
    const first = new WebUIService({ port }, { _restarting: false });
    await first.start();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    // stop 必须等到端口真正释放，否则软重启会拿到 EADDRINUSE
    await first.stop();

    const second = new WebUIService({ port }, { _restarting: false });
    await second.start();
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    } finally {
      await second.stop();
    }
  });
});

describe('WebUI 技能管理接口', () => {
  const port = 18189;
  let svc;
  let base;
  let saved;

  const makeSkillSvc = () => ({
    _all: [
      { name: 'weather', type: 'md', description: '实时天气' },
      { name: 'baidu-search', type: 'md', description: '网页搜索' },
      { name: 'demo', type: 'md', description: '普通技能' },
    ],
    disabled: new Set(['baidu-search']),
    async listAll() { return this._all; },
    async list() { return this._all.filter(s => !this.disabled.has(s.name)); },
    getDisabled() { return [...this.disabled]; },
    setDisabled(names) { this.disabled = new Set(names); },
    async has(name) { return this._all.some(s => s.name === name); },
    // 与真实 SkillService 对齐：weather 属于基础能力，不可禁用
    isProtected(name) { return String(name) === 'weather'; },
  });

  before(async () => {
    saved = null;
    svc = new WebUIService({ port }, {
      _restarting: false,
      skill: makeSkillSvc(),
      saveSkillsDisabled: async (names) => { saved = [...names]; },
    });
    await svc.start();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => { await svc?.stop(); });

  const post = (body, url = base) => fetch(`${url}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('GET 列出全部技能与启用状态', async () => {
    const data = await (await fetch(`${base}/api/skills`)).json();
    assert.equal(data.skills.length, 3);
    assert.equal(data.skills.find(s => s.name === 'weather').enabled, true);
    assert.equal(data.skills.find(s => s.name === 'baidu-search').enabled, false);
    assert.equal(data.skills.find(s => s.name === 'weather').protected, true, '需告知前端不可禁用');
    assert.equal(data.skills.find(s => s.name === 'demo').protected, false);
    assert.deepEqual(data.disabled, ['baidu-search']);
  });

  test('禁用技能：先落盘再改内存', async () => {
    const res = await post({ name: 'demo', enabled: false });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(saved.sort(), ['baidu-search', 'demo'], '必须落盘');
    assert.deepEqual(svc.agentInstance.skill.getDisabled().sort(), ['baidu-search', 'demo']);
  });

  test('启用技能：从禁用名单移除', async () => {
    const res = await post({ name: 'demo', enabled: true });
    await res.json();
    assert.deepEqual(saved, ['baidu-search']);
    assert.deepEqual(svc.agentInstance.skill.getDisabled(), ['baidu-search']);
  });

  test('受保护技能返回 400 且不落盘', async () => {
    const before = saved;
    const res = await post({ name: 'weather', enabled: false });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不允许禁用/);
    assert.deepEqual(saved, before, '受保护技能不得写入配置');
    assert.deepEqual(svc.agentInstance.skill.getDisabled(), ['baidu-search']);
  });

  test('未知技能返回 404 且不改配置', async () => {
    const before = saved;
    const res = await post({ name: 'not-exist', enabled: false });
    assert.equal(res.status, 404);
    assert.equal(saved, before, '404 路径不得落盘');
  });

  test('落盘失败时不改内存（与工具侧同一条约定）', async () => {
    const failing = new WebUIService({ port: port + 1 }, {
      _restarting: false,
      skill: makeSkillSvc(),
      saveSkillsDisabled: async () => { throw new Error('EACCES: read-only'); },
    });
    await failing.start();
    try {
      const res = await post({ name: 'demo', enabled: false }, `http://127.0.0.1:${port + 1}`);
      assert.equal(res.status, 500);
      assert.deepEqual(
        failing.agentInstance.skill.getDisabled(),
        ['baidu-search'],
        '写盘失败不能留下"界面显示已禁用"的状态',
      );
    } finally {
      await failing.stop();
    }
  });
});
