import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import yaml from 'yaml';
import { patchDefaultModel } from '../../plugin/webui.js';

/**
 * 回归：前端修改默认模型后不生效
 *
 * 原实现的正则只匹配列表写法（default: 换行 + "- xxx"），
 * 而项目实际使用的是标量写法 `default: "provider/model"`，
 * 于是保存时整段被跳过、文件没变，但接口仍返回成功。
 */

describe('patchDefaultModel — 标量写法', () => {
  test('替换同一行的标量值', () => {
    const src = 'models:\n  default: "deepseek/deepseek-v4-flash"\n  fallback: "x"\n';
    const out = patchDefaultModel(src, 'nvidia/openai/gpt-oss-120b');

    assert.ok(out.includes('default: "nvidia/openai/gpt-oss-120b"'), out);
    assert.ok(out.includes('fallback: "x"'), '其他字段不受影响');
  });

  test('未加引号的标量同样可替换', () => {
    const out = patchDefaultModel('models:\n  default: deepseek/x\n', 'p/m');
    assert.ok(out.includes('default: "p/m"'));
  });

  test('保留行尾注释', () => {
    const out = patchDefaultModel('models:\n  default: "old"  # 主模型\n', 'p/m');
    assert.ok(out.includes('# 主模型'), '注释不能丢');
    assert.ok(out.includes('default: "p/m"'));
  });

  test('替换后仍是合法 YAML 且值正确', () => {
    const src = 'models:\n  default: "old/m"\n  providers:\n    - name: p\n';
    const parsed = yaml.parse(patchDefaultModel(src, 'new/m'));
    assert.equal(parsed.models.default, 'new/m');
  });
});

describe('patchDefaultModel — 列表写法', () => {
  test('替换首项', () => {
    const src = 'models:\n  default:\n    - "old/m"\n    - "second/m"\n';
    const out = patchDefaultModel(src, 'new/m');

    const parsed = yaml.parse(out);
    assert.equal(parsed.models.default[0], 'new/m');
    assert.equal(parsed.models.default[1], 'second/m', '其余轮询项不受影响');
  });

  test('无引号的列表项同样可替换', () => {
    const out = patchDefaultModel('models:\n  default:\n    - old/m\n', 'new/m');
    assert.equal(yaml.parse(out).models.default[0], 'new/m');
  });
});

describe('patchDefaultModel — 定位失败必须返回 null', () => {
  test('配置中不存在 default 时返回 null', () => {
    assert.equal(patchDefaultModel('models:\n  fallback: "x"\n', 'p/m'), null);
  });

  test('default 为空值时不误吃（应返回 null，交给调用方报错）', () => {
    const src = 'models:\n  default:\n  fallback: "x"\n';
    assert.equal(patchDefaultModel(src, 'p/m'), null);
  });

  test('真实配置文件可被正确替换（端到端校验）', async () => {
    const real = await fs.readFile(new URL('../../config/agent.yaml', import.meta.url), 'utf8');
    const out = patchDefaultModel(real, 'test/provider-model');

    assert.notEqual(out, null, '必须能在真实 agent.yaml 中定位 models.default');
    const parsed = yaml.parse(out);
    assert.equal(parsed.models.default, 'test/provider-model');
    // providers 等其余结构必须完好
    assert.ok(Array.isArray(parsed.models.providers) && parsed.models.providers.length > 0);
    assert.ok(parsed.agent.system_prompt.length > 0);
  });
});
