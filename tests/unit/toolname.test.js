import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToolName, dedupeToolName } from '../../src/services/toolname.js';
import { toSessionId } from '../../src/services/coreagent.js';

describe('sanitizeToolName — 工具名规范化', () => {
  test('MCP 工具名保留合法连字符', () => {
    assert.equal(sanitizeToolName('mcp_ha-mcp_get_status'), 'mcp_ha-mcp_get_status');
  });
  test('非法字符替换为下划线', () => {
    assert.equal(sanitizeToolName('mcp_ha-mcp_device.get_status'), 'mcp_ha-mcp_device_get_status');
    assert.equal(sanitizeToolName('mcp:x/y'), 'mcp_x_y');
  });
  test('合并连续下划线并去掉首尾下划线', () => {
    assert.equal(sanitizeToolName('__a__b__'), 'a_b');
  });
  test('全非法字符兜底为 tool', () => {
    assert.equal(sanitizeToolName('___'), 'tool');
    assert.equal(sanitizeToolName(undefined), 'tool');
  });
  test('长度上限 64', () => {
    assert.ok(sanitizeToolName('a'.repeat(70)).length <= 64);
  });
  test('幂等：清洗两次结果一致（保证 toolMap 键与 LLM 名称一致）', () => {
    for (const raw of ['get_status', 'device.get_status', 'fan:set', 'a@b#c']) {
      const once = sanitizeToolName(`mcp_srv_${raw}`);
      assert.equal(sanitizeToolName(once), once, `${raw} 不满足幂等`);
    }
  });
});

describe('dedupeToolName — 清洗后重名处理', () => {
  test('依次分配唯一后缀', () => {
    const taken = new Set();
    assert.equal(dedupeToolName(taken, 'tool_x'), 'tool_x');
    assert.equal(dedupeToolName(taken, 'tool_x'), 'tool_x_2');
    assert.equal(dedupeToolName(taken, 'tool_x'), 'tool_x_3');
  });
  test('不重名时不受影响', () => {
    const taken = new Set(['a']);
    assert.equal(dedupeToolName(taken, 'b'), 'b');
  });
});

describe('toSessionId — 会话隔离 ID', () => {
  test('正常使用任务 ID', () => {
    assert.equal(toSessionId('cron', 'task_1779441378781'), 'cron_task_1779441378781');
  });
  test('路径穿越字符被清洗，绝不产生子路径', () => {
    const id = toSessionId('cron', '../../etc/passwd');
    assert.equal(id.includes('/'), false);
  });
  test('含空格的任务 ID 可用作文件名', () => {
    assert.equal(toSessionId('cron', 'task 001'), 'cron_task_001');
  });
  test('undefined 时返回前缀', () => {
    assert.equal(toSessionId('hb', undefined), 'hb');
  });

  // 关键：纯中文巡检项必须互不相同，否则会话隔离失效
  test('多个中文巡检项生成互不相同的 ID', () => {
    const names = ['系统健康', '安全巡检', '环境优化', '环境检查'];
    const ids = names.map(n => toSessionId('hb', n));
    assert.equal(new Set(ids).size, names.length, `生成的 ID: ${ids}`);
  });
  test('ID 不含 Windows/Unix 文件名非法字符', () => {
    for (const s of [toSessionId('cron', 'a/b\\c:d*e?f"g<h>i|j'), toSessionId('hb', '  ')]) {
      assert.equal(/[/?<>\\:*|"]/.test(s), false, s);
    }
  });
});
