import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import CoreAgent from '../../src/services/coreagent.js';

/**
 * 端到端验证 CoreAgent.decide 的健壮性
 * 使用本地 HTTP 桩替代 OpenAI —— decide() 每轮都会重建 client，无法用对象桩。
 */
let server;
let baseUrl;
let DIR;

before(async () => {
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ureal-core-'));

  let handler = () => ({ choices: [{ message: { role: 'assistant', content: 'default' } }] });
  let compressCalls = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      // 摘要请求：统计自动压缩是否被触发的唯一可靠信号
      if (JSON.stringify(payload.messages || []).includes('对话摘要助手')) compressCalls++;
      const out = handler(payload);
      if (out.__httpError) {
        res.statusCode = out.__httpError;
        return res.end(JSON.stringify({ error: { message: '服务端故障' } }));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  // 暴露给各测试用的脚本助手
  globalThis.__coreTest = {
    setScript: (...responses) => {
      let n = 0;
      handler = () => responses[Math.min(n++, responses.length - 1)];
    },
    toolCall: (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name, arguments: args } },
    ] } }] }),
    text: (content) => ({ choices: [{ message: { role: 'assistant', content } }] }),
    httpError: (code) => ({ __httpError: code }),
    getCompressCalls: () => compressCalls,
    resetCompressCalls: () => { compressCalls = 0; },
  };
});

/** 预置一份会话历史，用于验证压缩触发条件 */
async function seedSession(sessionId, count) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `历史消息 ${i}` });
  }
  await fs.writeFile(path.join(DIR, `${sessionId}.json`), JSON.stringify(msgs));
}

after(async () => {
  server?.close();
  if (DIR) await fs.rm(DIR, { recursive: true, force: true });
});

const mk = () => new CoreAgent({
  name: 'test', sessionDir: DIR, systemPrompt: 'hi {name}',
  primaryConfigs: [{ model: 'm', baseUrl, apiKey: 'k' }],
});

describe('CoreAgent 工具执行健壮性', () => {
  test('arguments 为 undefined 时不崩溃（历史 TypeError 缺陷）', async () => {
    const { setScript, toolCall, text } = globalThis.__coreTest;
    setScript(toolCall('mgmt_cron_list', undefined), text('处理完毕'));
    const r = await mk().decide('测试', { sessionId: 'args_undef' });
    assert.equal(r.response, '处理完毕');
  });

  test('工具内部抛异常被降级为错误文本，不击穿 decide', async () => {
    const { setScript, toolCall, text } = globalThis.__coreTest;
    setScript(toolCall('boom_tool', '{}'), text('已恢复'));
    const a = mk();
    a._handleToolCall = async () => { throw new Error('爆炸'); };
    const r = await a.decide('测试', { sessionId: 'tool_throws' });
    assert.equal(r.response, '已恢复');
  });

  test('工具失败原因会回传给模型（工具重构后 ctx 缺失曾导致静默失败）', async () => {
    const hist = JSON.parse(await fs.readFile(path.join(DIR, 'tool_throws.json'), 'utf8'));
    const toolMsg = hist.find(m => m.role === 'tool');
    assert.ok(toolMsg, '必须存在 tool 消息');
    assert.ok(toolMsg.content.includes('工具执行错误'), `实际: ${toolMsg.content}`);
  });

  test('管理工具在缺少依赖时应返回明确提示而非异常', async () => {
    const { setScript, toolCall, text } = globalThis.__coreTest;
    setScript(toolCall('mgmt_cron_list', '{}'), text('ok'));
    const a = mk();
    await a.decide('列出任务', { sessionId: 'mgmt_check' });
    const hist = JSON.parse(await fs.readFile(path.join(DIR, 'mgmt_check.json'), 'utf8'));
    const toolMsg = hist.find(m => m.role === 'tool');
    assert.ok(toolMsg.content.length > 0, '应返回可读结果');
    assert.ok(!toolMsg.content.includes('ctx is not defined'),
      '不得泄漏内部引用错误（说明工具分发器缺少上下文字段）');
  });
});

describe('CoreAgent 异常持久化', () => {
  test('决策循环异常时仍会保存会话快照', async () => {
    const { setScript, toolCall, httpError } = globalThis.__coreTest;
    setScript(toolCall('mgmt_cron_list', '{}'), httpError(500));
    const a = mk();
    let threw = false;
    try {
      await a.decide('测试', { sessionId: 'loop_error' });
    } catch {
      threw = true;
    }
    assert.ok(threw, '异常应向上抛出');
    const hist = JSON.parse(await fs.readFile(path.join(DIR, 'loop_error.json'), 'utf8'));
    assert.ok(hist.some(m => m.role === 'tool'), '已完成的工具结果必须落盘');
  });
});

describe('CoreAgent 工具调用标记泄漏', () => {
  // 线上真实形态：模型把 tool_calls 写成了正文里的 DSML 标记
  const LEAK = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="mcp_ha-mcp_render_template">',
    '<｜｜DSML｜｜ parameter name="template" string="true">{% for e in [1] %}{{ e }}{% endfor %}</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');

  test('标记被剔除并纠偏重试，最终回复不含标记', async () => {
    const { setScript, text } = globalThis.__coreTest;
    setScript(text(LEAK), text('灯已关闭'));
    const r = await mk().decide('关灯', { sessionId: 'leak_only' });
    assert.equal(r.response, '灯已关闭');

    const hist = JSON.parse(await fs.readFile(path.join(DIR, 'leak_only.json'), 'utf8'));
    assert.ok(!JSON.stringify(hist).includes('DSML'), '会话历史里不得残留标记');
  });

  test('收敛轮仍未收敛时，兜底回复也不含标记', async () => {
    const { setScript, text } = globalThis.__coreTest;
    setScript(text(LEAK), text(LEAK));
    const r = await mk().decide('关灯', { sessionId: 'leak_forever', maxToolIterations: 2 });
    assert.ok(r.response);
    assert.ok(!r.response.includes('DSML'), `实际: ${r.response}`);
    assert.ok(!r.response.includes('{% for'), `实际: ${r.response}`);
  });
});

describe('CoreAgent 自动压缩触发频率', () => {
  test('超过 20 条但未超配置预算时不压缩（旧实现每轮都压）', async () => {
    const { setScript, text, getCompressCalls, resetCompressCalls } = globalThis.__coreTest;
    resetCompressCalls();
    await seedSession('compress_skip', 24); // + 本轮 prompt = 25 条，旧阈值 >20 会触发
    setScript(text('收到'));
    const r = await mk().decide('继续', { sessionId: 'compress_skip' });
    assert.equal(r.response, '收到');
    assert.equal(getCompressCalls(), 0, '未超 max_context_turns 预算就不该额外调用摘要模型');
  });

  test('超预算时压缩一次，压缩后不再连轮重复压缩', async () => {
    const { setScript, text, getCompressCalls, resetCompressCalls } = globalThis.__coreTest;
    resetCompressCalls();
    await seedSession('compress_once', 45); // + prompt = 46 > 40（默认 max_context_turns=20 → 40 条）
    setScript(text('早前聊过开灯'), text('第一轮'), text('第二轮'));

    const a = mk();
    const r1 = await a.decide('继续', { sessionId: 'compress_once' });
    assert.equal(r1.response, '第一轮');
    assert.equal(getCompressCalls(), 1);

    // 压缩后历史 = [摘要] + 最近 3 条，增量远低于预算 → 第二轮不得再次摘要
    const r2 = await a.decide('再来一次', { sessionId: 'compress_once' });
    assert.equal(r2.response, '第二轮');
    assert.equal(getCompressCalls(), 1, '摘要一旦存在，不应每轮重新摘要');
  });

  test('工具消息不占对话额度：41 条总消息但只有 21 条对话时不压缩', async () => {
    const { setScript, text, getCompressCalls, resetCompressCalls } = globalThis.__coreTest;
    resetCompressCalls();

    // 10 轮「问 → 空 assistant(tool_calls) → tool → 答」= 40 条消息，其中 20 条是工具管道
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `问 ${i}` });
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'x', arguments: '{}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: `结果 ${i}` });
      msgs.push({ role: 'assistant', content: `答 ${i}` });
    }
    await fs.writeFile(path.join(DIR, 'budget_tool.json'), JSON.stringify(msgs));

    setScript(text('收到'));
    const r = await mk().decide('继续', { sessionId: 'budget_tool' });
    assert.equal(r.response, '收到');
    assert.equal(getCompressCalls(), 0, '工具消息不应消耗对话额度');
  });

  test('保留窗口按对话条数计，窗口内的工具消息一并保留', async () => {
    const { setScript, text, getCompressCalls, resetCompressCalls } = globalThis.__coreTest;
    resetCompressCalls();

    // 42 条纯对话 + 1 个工具回合（空 assistant(tool_calls) + tool + 有正文的 assistant）
    // 对话条数 = 42 + 1 + 本轮 prompt = 44 > 40 → 触发压缩
    const msgs = [];
    for (let i = 0; i < 42; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `历史消息 ${i}` });
    }
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    });
    msgs.push({ role: 'tool', tool_call_id: 't1', content: '工具结果 1' });
    msgs.push({ role: 'assistant', content: '工具后回答' });
    await fs.writeFile(path.join(DIR, 'keep_window.json'), JSON.stringify(msgs));

    setScript(text('旧事摘要'), text('第一轮'));
    await mk().decide('继续', { sessionId: 'keep_window' });
    assert.equal(getCompressCalls(), 1);

    const hist = JSON.parse(await fs.readFile(path.join(DIR, 'keep_window.json'), 'utf8'));
    assert.ok(hist[0].compressed);
    assert.ok(
      hist.some(m => m.role === 'tool' && m.content === '工具结果 1'),
      '窗口内的工具消息必须和它的回合一起保留',
    );
    assert.ok(
      hist.some(m => m.content === '工具后回答'),
      '窗口内的对话消息不得被摘要吃掉',
    );
  });

  test('压缩后保留摘要标记，且最近 10 条原文不参与压缩', async () => {
    const hist = JSON.parse(await fs.readFile(path.join(DIR, 'compress_once.json'), 'utf8'));
    assert.ok(hist[0].compressed, '首条必须是压缩标记的摘要');
    assert.ok(hist[0].content.includes('早前聊过开灯'));

    // 期望结构：[摘要] + 最近 10 条 + 本轮问答；回合边界回退可能多留 1~2 条
    assert.ok(hist.length >= 11, `最近 10 条必须原样保留，实际 ${hist.length} 条`);
    assert.ok(hist.length <= 14, `压缩后历史应显著变短，实际 ${hist.length} 条`);
    assert.ok(
      hist.slice(1).some(m => m.content === '历史消息 44'),
      '倒数第一条旧消息必须逐字保留，不能被摘要吃掉',
    );
  });
});

describe('CoreAgent 工具触发的软重启', () => {
  test('requestRestart 不立即执行，在本轮收尾后延时回调', async () => {
    const { setScript, text } = globalThis.__coreTest;
    const seen = [];

    const agent = new CoreAgent({
      name: 'test', sessionDir: DIR, systemPrompt: 'hi {name}',
      primaryConfigs: [{ model: 'm', baseUrl, apiKey: 'k' }],
      restartDelayMs: 5,
    });
    agent.setOnRestartRequested(async (reason) => { seen.push(reason); });

    // 模拟工具调用期间打标记
    agent.requestRestart('MCP Server 变更（ha-mcp）');
    setScript(text('配置已更新'));
    const r = await agent.decide('改配置', { sessionId: 'restart_req' });

    assert.equal(r.response, '配置已更新');
    assert.equal(seen.length, 0, '本轮回复生成前绝不能重启，否则回复与连接一起断');

    await new Promise((done) => setTimeout(done, 40));
    assert.deepEqual(seen, ['MCP Server 变更（ha-mcp）']);
  });

  test('未注册重启回调时只告警，不影响本轮结果', async () => {
    const { setScript, text } = globalThis.__coreTest;
    const agent = new CoreAgent({
      name: 'test', sessionDir: DIR, systemPrompt: 'hi {name}',
      primaryConfigs: [{ model: 'm', baseUrl, apiKey: 'k' }],
      restartDelayMs: 5,
    });
    agent.requestRestart('无回调场景');
    setScript(text('照常回复'));

    const r = await agent.decide('继续', { sessionId: 'restart_nohandler' });
    assert.equal(r.response, '照常回复');
    assert.equal(agent._pendingRestart, null, '标记必须被消费，否则后续每轮都会触发');
  });
});

describe('CoreAgent 会话隔离', () => {
  test('不同 sessionId 写入独立文件且不互相污染', async () => {
    const { setScript, text } = globalThis.__coreTest;
    const a = mk();
    for (const sid of ['cron_taskA', 'cron_taskB', 'hb_安全巡检']) {
      setScript(text(`R-${sid}`));
      await a.decide(`任务 ${sid}`, { sessionId: sid });
    }
    const files = (await fs.readdir(DIR)).filter(f => /^(cron_|hb_)/.test(f));
    assert.equal(files.length, 3);

    for (const f of files) {
      const content = await fs.readFile(path.join(DIR, f), 'utf8');
      const leaked = content.includes('R-cron_taskA') && f !== 'cron_taskA.json';
      assert.equal(leaked, false, `${f} 不应包含其他会话内容`);
    }
  });

  test('未指定 sessionId 时才使用 default', async () => {
    const { setScript, text } = globalThis.__coreTest;
    setScript(text('默认会话'));
    await mk().decide('测试', {});
    const exists = await fs.access(path.join(DIR, 'default.json')).then(() => true).catch(() => false);
    assert.ok(exists, 'default 会话应仍然存在，用于主对话');
  });
});
