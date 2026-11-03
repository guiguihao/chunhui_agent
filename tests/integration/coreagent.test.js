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
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const out = handler(JSON.parse(body || '{}'));
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
  };
});

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
