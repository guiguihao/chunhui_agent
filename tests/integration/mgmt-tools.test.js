import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleManagementTool } from '../../src/services/tools/dispatcher.js';
import { getAllTools } from '../../src/services/tools/registry.js';
import { readMcpServers } from '../../src/services/mcpconfig.js';

/**
 * mgmt_mcp_* / mgmt_skill_* 管理工具的分发与注册
 *
 * MCP 部分以真实文件为准（与 WebUI /api/mcp 同一事实来源），
 * 测试通过 chdir 到临时目录来避免使用仓库里的 config/mcporter.json。
 */

let tmpDir;
let origCwd;

const SAMPLE = {
  mcpServers: {
    'ha-mcp': {
      enabled: true,
      serverUrl: 'http://127.0.0.1:8123/api/mcp',
      headers: { Authorization: 'Bearer ${HA_TOKEN}' },
    },
    'miot-mcp': { enabled: false, command: 'python3', args: ['../mcp/x.py'] },
  },
};

before(async () => {
  origCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cfg-'));
  await fs.mkdir(path.join(tmpDir, 'config'));
  await fs.writeFile(
    path.join(tmpDir, 'config', 'mcporter.json'),
    JSON.stringify(SAMPLE, null, 2),
    'utf8',
  );
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origCwd);
});

function fakeMcpService() {
  return {
    config: {
      mcpServers: {
        'ha-mcp': { enabled: true, serverUrl: 'http://127.0.0.1:8123/api/mcp' },
        'miot-mcp': { enabled: false, command: 'python3' },
      },
    },
    toolMap: {
      'mcp_ha-mcp_get_state': { server: 'ha-mcp', toolName: 'get_state' },
      'mcp_ha-mcp_call_service': { server: 'ha-mcp', toolName: 'call_service' },
    },
  };
}

function fakeSkillService(initialDisabled = []) {
  const svc = {
    _all: [
      { name: 'weather', type: 'md', description: '实时天气' },
      { name: 'baidu-search', type: 'md', description: '网页搜索' },
      { name: 'demo', type: 'md', description: '普通技能' },
    ],
    disabled: new Set(initialDisabled),
    async listAll() { return this._all; },
    async list() { return this._all.filter((s) => !this.disabled.has(s.name)); },
    getDisabled() { return [...this.disabled]; },
    setDisabled(names) { this.disabled = new Set(names); },
    async has(name) { return this._all.some((s) => s.name === name); },
    // 与真实 SkillService 对齐：weather 属于基础能力，不可禁用
    isProtected(name) { return String(name) === 'weather'; },
  };
  return svc;
}

describe('mgmt_restart 软重启', () => {
  test('打标记延后执行，并回报预计延迟', async () => {
    const reasons = [];
    const out = await handleManagementTool(
      { requestRestart: (r) => reasons.push(r), restartDelayMs: 2500 },
      'mgmt_restart',
      { reason: '更新模型配置' },
    );

    assert.match(out, /已安排软重启：更新模型配置/);
    assert.match(out, /2\.5s/);
    assert.deepEqual(reasons, ['更新模型配置']);
  });

  test('缺省原因也能重启', async () => {
    const reasons = [];
    await handleManagementTool(
      { requestRestart: (r) => reasons.push(r) },
      'mgmt_restart',
      {},
    );
    assert.deepEqual(reasons, ['用户请求重启']);
  });

  test('当前环境不支持重启时明确拒绝', async () => {
    const out = await handleManagementTool({}, 'mgmt_restart', {});
    assert.match(out, /不支持软重启/);
    assert.match(out, /手动重启/);
  });
});

describe('mgmt_mcp_* 管理', () => {
  test('list 直接读 mcporter.json：不依赖 runtime，禁用项也能列出', async () => {
    const out = JSON.parse(await handleManagementTool({}, 'mgmt_mcp_list', {}));

    assert.equal(out.configPath, 'config/mcporter.json');
    assert.equal(out.servers.length, 2);
    const ha = out.servers.find(s => s.name === 'ha-mcp');
    assert.equal(ha.enabled, true);
    assert.equal(ha.url, 'http://127.0.0.1:8123/api/mcp');
    const miot = out.servers.find(s => s.name === 'miot-mcp');
    assert.equal(miot.enabled, false);
    assert.equal(miot.command, 'python3');
  });

  test('list 不回显 headers/env，只暴露是否配置了鉴权', async () => {
    const out = JSON.parse(await handleManagementTool({}, 'mgmt_mcp_list', {}));
    const ha = out.servers.find(s => s.name === 'ha-mcp');

    assert.equal(ha.authConfigured, true, '应提示配置了鉴权');
    assert.equal(ha.headers, undefined, 'token 不得进入模型上下文');
    assert.ok(!JSON.stringify(out).includes('Bearer'), 'headers 原文不得出现在输出里');
  });

  test('list 合并已注册工具（有 _mcpToolMap 时）', async () => {
    const out = JSON.parse(await handleManagementTool(
      { _mcpToolMap: fakeMcpService().toolMap },
      'mgmt_mcp_list',
      {},
    ));
    const ha = out.servers.find(s => s.name === 'ha-mcp');
    assert.equal(ha.registered, true);
    assert.deepEqual(ha.tools, ['call_service', 'get_state']);
    assert.equal(out.servers.find(s => s.name === 'miot-mcp').registered, false);
  });

  test('toggle 写入文件并保留 ${VAR} 占位符', async () => {
    const svc = fakeMcpService();
    const out = await handleManagementTool(
      { _mcpService: svc },
      'mgmt_mcp_toggle',
      { name: 'miot-mcp', enabled: 'true' },
    );

    assert.match(out, /已启用 MCP Server: miot-mcp/);
    assert.match(out, /mcporter\.json/);

    const { servers } = await readMcpServers();
    assert.equal(servers['miot-mcp'].enabled, true, '文件必须落盘');
    assert.equal(svc.config.mcpServers['miot-mcp'].enabled, true, '运行时内存同步');
    // 关键：不能把 _mcpService 里已替换成真实值的 headers 写回文件
    assert.equal(
      servers['ha-mcp'].headers.Authorization,
      'Bearer ${HA_TOKEN}',
      '占位符必须原样保留，真实 token 绝不能落盘',
    );
    servers['miot-mcp'].enabled = false;
    await fs.writeFile(
      path.join(tmpDir, 'config', 'mcporter.json'),
      JSON.stringify({ mcpServers: servers }, null, 2),
      'utf8',
    );
  });

  test('写入成功后请求软重启（不在工具里同步重启）', async () => {
    const reasons = [];
    const out = await handleManagementTool(
      { requestRestart: (reason) => reasons.push(reason) },
      'mgmt_mcp_toggle',
      { name: 'ha-mcp', enabled: false },
    );

    assert.match(out, /本轮回复后自动重启生效/);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /MCP Server 变更（ha-mcp）/);
  });

  test('失败路径不触发重启；无回调时提示手动重启', async () => {
    const reasons = [];
    const notFound = await handleManagementTool(
      { requestRestart: (r) => reasons.push(r) },
      'mgmt_mcp_toggle',
      { name: 'not-exist', enabled: true },
    );
    assert.match(notFound, /未找到 MCP Server/);
    assert.equal(reasons.length, 0, '没改成配置就不能重启');

    const noCallback = await handleManagementTool({}, 'mgmt_mcp_toggle', { name: 'ha-mcp', enabled: true });
    assert.match(noCallback, /请手动重启进程生效/);
  });

  test('remove 从文件删除 Server', async () => {
    const out = await handleManagementTool({}, 'mgmt_mcp_remove', { name: 'miot-mcp' });
    assert.match(out, /已删除 MCP Server: miot-mcp/);

    const { servers } = await readMcpServers();
    assert.ok(!('miot-mcp' in servers));
    assert.ok('ha-mcp' in servers, '不得误删其他 Server');
  });

  test('不存在的 Server 名被拒绝且不改文件', async () => {
    const before = await fs.readFile(path.join(tmpDir, 'config', 'mcporter.json'), 'utf8');
    const out = await handleManagementTool({}, 'mgmt_mcp_toggle', { name: 'not-exist', enabled: false });
    assert.match(out, /未找到 MCP Server/);
    assert.equal(
      await fs.readFile(path.join(tmpDir, 'config', 'mcporter.json'), 'utf8'),
      before,
      '失败路径不得触碰配置文件',
    );
  });

  test('配置文件缺失时给出可读错误而不是抛异常', async () => {
    await fs.rename(
      path.join(tmpDir, 'config', 'mcporter.json'),
      path.join(tmpDir, 'config', 'mcporter.json.bak'),
    );
    try {
      const out = await handleManagementTool({}, 'mgmt_mcp_list', {});
      assert.match(out, /读取 mcporter\.json 失败/);
    } finally {
      await fs.rename(
        path.join(tmpDir, 'config', 'mcporter.json.bak'),
        path.join(tmpDir, 'config', 'mcporter.json'),
      );
    }
  });
});

describe('mgmt_skill_* 管理', () => {
  test('list 展示全部技能与禁用状态', async () => {
    const out = JSON.parse(await handleManagementTool(
      { _skillService: fakeSkillService(['baidu-search']) },
      'mgmt_skill_list',
      {},
    ));

    assert.equal(out.skills.length, 3);
    assert.equal(out.skills.find(s => s.name === 'baidu-search').enabled, false);
    assert.deepEqual(out.disabled, ['baidu-search']);
  });

  test('toggle 禁用→启用 流转禁用名单并通知落盘', async () => {
    const svc = fakeSkillService();
    const seen = [];
    const ctx = {
      _skillService: svc,
      _onSkillsChanged: async (names) => { seen.push([...names]); },
    };

    await handleManagementTool(ctx, 'mgmt_skill_toggle', { name: 'demo', enabled: false });
    assert.deepEqual(seen.at(-1), ['demo']);
    assert.deepEqual(svc.getDisabled(), ['demo'], '内存状态必须立即生效');

    await handleManagementTool(ctx, 'mgmt_skill_toggle', { name: 'demo', enabled: true });
    assert.deepEqual(seen.at(-1), []);
    assert.deepEqual(svc.getDisabled(), []);
  });

  test('受保护技能禁止禁用，且不落盘', async () => {
    const svc = fakeSkillService();
    const seen = [];
    const out = await handleManagementTool(
      {
        _skillService: svc,
        _onSkillsChanged: async (names) => { seen.push([...names]); },
      },
      'mgmt_skill_toggle',
      { name: 'weather', enabled: false },
    );

    assert.match(out, /不允许禁用/);
    assert.equal(seen.length, 0, '必须在落盘前就拒绝');
    assert.deepEqual(svc.getDisabled(), []);
  });

  test('不存在的技能名被拒绝', async () => {
    const out = await handleManagementTool(
      { _skillService: fakeSkillService(), _onSkillsChanged: async () => {} },
      'mgmt_skill_toggle',
      { name: 'not-exist', enabled: false },
    );
    assert.match(out, /未找到技能/);
  });

  test('落盘回调抛错时不改内存状态', async () => {
    const svc = fakeSkillService();
    const out = await handleManagementTool(
      {
        _skillService: svc,
        _onSkillsChanged: async () => { throw new Error('EACCES: read-only'); },
      },
      'mgmt_skill_toggle',
      { name: 'demo', enabled: false },
    );

    assert.match(out, /写入 agent.yaml 失败/);
    assert.match(out, /未做任何修改/);
    assert.deepEqual(svc.getDisabled(), [], '落盘优先：写失败就不能切状态');
  });
});

describe('registry 注册管理工具', () => {
  test('有 _mcpService / _skillService 时注册对应管理工具', async () => {
    const names = (await getAllTools({
      _mcpService: fakeMcpService(),
      _mcpTools: [],
      _skillService: fakeSkillService(),
    })).map(t => t.function.name);

    for (const expected of ['mgmt_mcp_list', 'mgmt_mcp_toggle', 'mgmt_mcp_remove', 'mgmt_skill_list', 'mgmt_skill_toggle']) {
      assert.ok(names.includes(expected), `缺少 ${expected}`);
    }
  });

  test('MCP 管理工具不做服务门控（连不上时也要能排查），技能工具仍门控', async () => {
    const names = (await getAllTools({ _mcpTools: [] })).map(t => t.function.name);
    // _mcpService 只在成功发现工具后才注入，门控会让"看不到列表"变成无解
    assert.ok(names.includes('mgmt_mcp_list'));
    assert.ok(names.includes('mgmt_mcp_toggle'));
    assert.ok(!names.includes('mgmt_skill_toggle'), '技能工具仍依赖技能服务');
  });
});
