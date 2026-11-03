import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasToolCallMarkup,
  parseToolCallMarkup,
  stripToolCallMarkup,
} from '../../src/services/toolmarkup.js';

// 线上真实泄漏样本（DeepSeek 把工具调用写成纯文本）
const DSML_SAMPLE = `
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="mcp_ha-mcp_render_template">
<｜｜DSML｜｜ parameter name="template" string="true">{% for e in ['switch.a','switch.b'] %}{{ e }} = {{ states(e) }}
{% endfor %}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

test('stripToolCallMarkup 清空整段 DSML 标记', () => {
  assert.equal(stripToolCallMarkup(DSML_SAMPLE), '');
});

test('stripToolCallMarkup 保留正文，只删标记块', () => {
  const text = `灯已经关了。${DSML_SAMPLE}\n如需再开请告诉我。`;
  const cleaned = stripToolCallMarkup(text);
  assert.ok(cleaned.includes('灯已经关了。'));
  assert.ok(cleaned.includes('如需再开请告诉我。'));
  assert.ok(!cleaned.includes('DSML'));
  assert.ok(!cleaned.includes('{% for'));
});

test('stripToolCallMarkup 处理 ASCII 竖线与未闭合块', () => {
  const closed = '<||DSML|| calls>\n<||DSML|| invoke name="x">\n</||DSML|| invoke>\n</||DSML|| calls>';
  assert.equal(stripToolCallMarkup(closed), '');

  const truncated = '结论在此。\n<||DSML|| calls>\n<||DSML|| invoke name="x">\n<||DSML|| parameter name="a">1';
  assert.equal(stripToolCallMarkup(truncated), '结论在此。');
});

test('stripToolCallMarkup 清理 <tool_call> 与 XML invoke 形式', () => {
  assert.equal(stripToolCallMarkup('<tool_call>{"name":"a","arguments":{}}</tool_call>'), '');
  assert.equal(
    stripToolCallMarkup('前文\n<invoke name="turn_on">\n<parameter name="entity">light.a</parameter>\n</invoke>\n后文'),
    '前文\n\n后文',
  );
});

test('stripToolCallMarkup 不误伤普通文本', () => {
  const text = '温度 24.5°C\n| 设备 | 状态 |\n| --- | --- |\n| 客厅灯 | 开 |';
  assert.equal(stripToolCallMarkup(text), text);
});

test('hasToolCallMarkup 识别标记', () => {
  assert.equal(hasToolCallMarkup(DSML_SAMPLE), true);
  assert.equal(hasToolCallMarkup('<tool_call>{}</tool_call>'), true);
  assert.equal(hasToolCallMarkup('一切正常，无需操作。'), false);
  assert.equal(hasToolCallMarkup(''), false);
  assert.equal(hasToolCallMarkup(null), false);
});

test('parseToolCallMarkup 还原工具名与参数', () => {
  const calls = parseToolCallMarkup(DSML_SAMPLE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].function.name, 'mcp_ha-mcp_render_template');

  const args = JSON.parse(calls[0].function.arguments);
  assert.equal(args.template, "{% for e in ['switch.a','switch.b'] %}{{ e }} = {{ states(e) }}\n{% endfor %}");
});

test('parseToolCallMarkup 参数类型：非 string 标注按 JSON 解析', () => {
  const text = '<invoke name="set_brightness">'
    + '<parameter name="entity_id" string="true">light.a</parameter>'
    + '<parameter name="value">80</parameter>'
    + '<parameter name="force">true</parameter>'
    + '</invoke>';
  const [call] = parseToolCallMarkup(text);
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.entity_id, 'light.a');
  assert.equal(args.value, 80);
  assert.equal(args.force, true);
});

test('parseToolCallMarkup 支持多调用与 JSON 形态', () => {
  const multi = '<invoke name="a"><parameter name="x">1</parameter></invoke>'
    + '<invoke name="b"><parameter name="y" string="true">2</parameter></invoke>';
  const calls = parseToolCallMarkup(multi);
  assert.deepEqual(calls.map(c => c.function.name), ['a', 'b']);

  const json = '<tool_call>{"name":"light_on","arguments":{"entity":"light.a"}}</tool_call>';
  const [single] = parseToolCallMarkup(json);
  assert.equal(single.function.name, 'light_on');
  assert.equal(JSON.parse(single.function.arguments).entity, 'light.a');
});

test('parseToolCallMarkup 无可还原内容时返回空数组', () => {
  assert.deepEqual(parseToolCallMarkup('普通回复'), []);
  assert.deepEqual(parseToolCallMarkup(''), []);
  assert.deepEqual(parseToolCallMarkup(null), []);
  assert.deepEqual(parseToolCallMarkup('<tool_call>not json</tool_call>'), []);
});
