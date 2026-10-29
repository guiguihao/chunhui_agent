import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  trimHistory, normalizeMessages, cleanHistory,
} from '../../src/services/session/history.js';

/**
 * 这是全项目最容易出错的一组纯函数：
 * tool_call 与 tool_result 必须严格配对，否则 OpenAI API 会直接报错。
 * 此前它们完全没有测试覆盖。
 */

describe('history.normalizeMessages', () => {
  test('保留正常对话', () => {
    const h = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    assert.deepEqual(normalizeMessages(h), h);
  });

  test('tool_call 全部有对应 result 时原样通过', () => {
    const h = [
      { role: 'user', content: '开灯' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ];
    const out = normalizeMessages(h);
    assert.equal(out.filter(m => m.role === 'tool').length, 1, 'tool 消息不应重复');
    assert.equal(out.find(m => m.role === 'assistant').tool_calls.length, 1);
  });

  test('孤立的 tool 消息（无对应 tool_call）必须被丢弃', () => {
    const h = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'ghost', content: '孤儿' },
    ];
    const out = normalizeMessages(h);
    assert.equal(out.some(m => m.role === 'tool'), false, '孤立 tool 消息必须清除');
  });

  // 注意：不完整的工具调用序列是被「整体丢弃」而非补齐。
  // 这是刻意为之 —— 伪造 tool_result 会让模型误以为工具已执行，
  // 丢弃才是保证 API 请求合法且语义正确的做法。
  test('缺 result 的 tool_call 整段被丢弃，不伪造结果', () => {
    const h = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c9', function: { name: 'f', arguments: '{}' } }] },
    ];
    const out = normalizeMessages(h);
    assert.equal(out.some(m => m.role === 'tool'), false, '不得伪造 tool_result');
    assert.equal(out.some(m => m.role === 'assistant' && m.tool_calls), false, '对应 assistant 一并丢弃');
  });

  test('多轮工具调用全部配对', () => {
    const h = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'a1', function: { name: 'f1', arguments: '{}' } },
        { id: 'a2', function: { name: 'f2', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'a1', content: 'r1' },
      { role: 'tool', tool_call_id: 'a2', content: 'r2' },
    ];
    const out = normalizeMessages(h);
    const toolIds = out.filter(m => m.role === 'tool').map(m => m.tool_call_id).sort();
    assert.deepEqual(toolIds, ['a1', 'a2']);
  });

  test('幂等：连续调用两次结果一致', () => {
    const h = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'p1', function: { name: 'f', arguments: '{}' } }] },
    ];
    const once = normalizeMessages(h);
    const twice = normalizeMessages(once);
    assert.equal(once.length, twice.length);
  });
});

describe('history.cleanHistory — 修复破裂的工具调用序列', () => {
  test('transaction\\uFFF0tool 缺失时移除该 assistant 及其孤儿 tool', () => {
    const h = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x1', function: { name: 'f', arguments: '{}' } }] },
    ];
    const out = cleanHistory(h);
    assert.equal(out.some(m => m.role === 'tool' && m.tool_call_id === 'x1'), false);
  });

  test('保留完整序列不误删', () => {
    const h = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'y1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'y1', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ];
    const out = cleanHistory(h);
    assert.equal(out.find(m => m.role === 'assistant' && m.content === 'done') !== undefined, true);
  });

  test('历史被截断到 tool 消息中间时可自愈', () => {
    const h = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'z1', function: { name: 'f1', arguments: '{}' } },
        { id: 'z2', function: { name: 'f2', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'z1', content: 'ok' },
      // z2 的 result 丢失
    ];
    const out = cleanHistory(h);
    for (const m of out.filter(x => x.role === 'tool')) {
      const hasOwner = out.some(a => a.role === 'assistant'
        && a.tool_calls?.some(tc => tc.id === m.tool_call_id));
      assert.ok(hasOwner, `tool ${m.tool_call_id} 必须能找到归属的 tool_call`);
    }
  });
});

describe('history.trimHistory', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));

  test('未超限时不裁剪', () => {
    const h = mk(10);
    assert.equal(trimHistory(h, 20).length, 10);
  });

  test('超限时长度不超过 maxLen', () => {
    const out = trimHistory(mk(100), 20);
    assert.ok(out.length <= 20, `实际 ${out.length}`);
  });

  // 已知限制：trimHistory 不做 system 消息特殊处理，超长时会连同最旧消息一并丢弃。
  // 目前会话历史中并不存放 system 消息（系统提示通过 requestOptions 单独传入），
  // 因此实际不会触发；此处以测试固化该前置约定。
  test('system 消息不在会话历史中（trimHistory 无特殊保护的前提）', () => {
    const h = [{ role: 'system', content: 'SYS' }, ...mk(100)];
    const out = trimHistory(h, 20);
    assert.equal(out[0].role, 'user', 'system 不会被特殊保留，故不得放入会话历史');
  });

  test('无 system 时保留最新消息', () => {
    const out = trimHistory(mk(100), 10);
    assert.equal(out[out.length - 1].content, 'm99', '应保留最后一条');
  });

  // 已知限制：字符总量上限 (60000) 只在「消息条数超过 maxLen」时才生效，
  // 条数少但单条极长的历史不会被压缩。当前由 CoreAgent 侧的单工具输出
  // 截断（20000 字符）兜底，故此处如实记录该行为。
  test('条数超限且字符超限时，最旧消息被丢弃', () => {
    const huge = Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(5000) }));
    const out = trimHistory(huge, 10);
    const total = out.reduce((s, m) => s + (m.content?.length || 0), 0);
    assert.ok(out.length <= 10, '条数必须符合上限');
    assert.ok(total < 40 * 5000, '字符总量必须被压缩');
  });

  test('条数未超限时字符上限不生效（现状，勿依赖）', () => {
    const huge = Array.from({ length: 30 }, () => ({ role: 'user', content: 'x'.repeat(5000) }));
    const out = trimHistory(huge, 100);
    assert.equal(out.length, 30, '条数未超限，不会触发字符裁剪');
  });
});
