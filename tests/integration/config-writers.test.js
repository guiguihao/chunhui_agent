import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import SmartHomeAgent from '../../src/agent.js';

/**
 * 配置回写（agent.yaml / heartbeat.yaml）
 *
 * 线上事故回归：`doc.setIn(['agent','skills'], {})` 占位会生成非集合节点，
 * 随后 setIn 子路径抛 "Expected YAML collection at skills" → WebUI 技能开关 500。
 */

let tmpDir;
let origCwd;

const AGENT_YAML = `# 测试用 agent 配置
agent:
  name: "ureal"
  skills:
    directory: "./skills"
  system_prompt: |
    ### 你的能力
    1. 定时任务：mgmt_cron_list
    2. 记忆：memory_*

# 记忆系统配置
memory:
  directory: "./memory"
`;

before(async () => {
  origCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-writer-'));
  await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
  process.chdir(tmpDir);
});

after(async () => {
  process.chdir(origCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const writeAgentYaml = (text) => fs.writeFile(path.join(tmpDir, 'config', 'agent.yaml'), text, 'utf8');
const readAgentYaml = () => fs.readFile(path.join(tmpDir, 'config', 'agent.yaml'), 'utf8');

describe('saveSkillsDisabled', () => {
  test('已有 skills 块：写入 disabled 且保留 system_prompt 与注释', async () => {
    await writeAgentYaml(AGENT_YAML);
    const agent = new SmartHomeAgent();

    await agent.saveSkillsDisabled(['weather']);

    const raw = await readAgentYaml();
    const parsed = yaml.parse(raw);
    assert.deepEqual(parsed.agent.skills.disabled, ['weather']);
    assert.equal(parsed.agent.skills.directory, './skills', '不得破坏同级的其他键');
    assert.ok(parsed.agent.system_prompt.includes('mgmt_cron_list'));
    assert.ok(raw.includes('# 测试用 agent 配置'), '注释必须保留');
  });

  test('完全没有 skills 键：自动创建，不再抛 Expected YAML collection', async () => {
    await writeAgentYaml('agent:\n  name: "ureal"\n');
    const agent = new SmartHomeAgent();

    await agent.saveSkillsDisabled(['baidu-search']);

    const parsed = yaml.parse(await readAgentYaml());
    assert.deepEqual(parsed.agent.skills.disabled, ['baidu-search']);
  });

  test('skills 写成 null 时也能自愈重建', async () => {
    await writeAgentYaml('agent:\n  name: "ureal"\n  skills:\n');
    const agent = new SmartHomeAgent();

    await agent.saveSkillsDisabled(['weather']);

    const parsed = yaml.parse(await readAgentYaml());
    assert.deepEqual(parsed.agent.skills.disabled, ['weather']);
  });

  test('值未变化时不写文件（避免无意义 diff 与 WebUI 并发覆盖）', async () => {
    await writeAgentYaml(AGENT_YAML);
    const agent = new SmartHomeAgent();

    await agent.saveSkillsDisabled(['weather']);
    const first = await readAgentYaml();

    await agent.saveSkillsDisabled(['weather']);
    assert.equal(await readAgentYaml(), first, '第二次内容必须完全相同');
  });

  test('清空禁用名单写回空数组', async () => {
    await writeAgentYaml(AGENT_YAML);
    const agent = new SmartHomeAgent();

    await agent.saveSkillsDisabled(['weather']);
    await agent.saveSkillsDisabled([]);

    const parsed = yaml.parse(await readAgentYaml());
    assert.deepEqual(parsed.agent.skills.disabled, []);
  });
});

describe('saveHeartbeatConfig', () => {
  const HB_YAML = `# 心跳配置
heartbeat:
  enabled: true
  interval: "*/50 * * * *"
  checks:
    - name: 系统告警测试
      prompt: 检查
`;

  test('缺失 heartbeat 块时重建而不抛异常', async () => {
    await fs.writeFile(path.join(tmpDir, 'config', 'heartbeat.yaml'), '# 空配置\n', 'utf8');
    const agent = new SmartHomeAgent();
    agent.heartbeat = {
      enabled: true,
      interval: '*/30 * * * *',
      checks: [],
      getTaskContent: () => '巡检内容',
    };

    await agent.saveHeartbeatConfig();

    const raw = await fs.readFile(path.join(tmpDir, 'config', 'heartbeat.yaml'), 'utf8');
    const parsed = yaml.parse(raw) || {};  // 纯注释文件 parse 结果是 null
    assert.equal(parsed.heartbeat.interval, '*/30 * * * *');
    assert.equal(parsed.heartbeat.dynamic_prompt, '巡检内容');
    assert.ok(raw.includes('# 空配置'), '注释必须保留');
  });

  test('只改 dynamic_prompt 时不动 checks 与其上注释', async () => {
    await fs.writeFile(path.join(tmpDir, 'config', 'heartbeat.yaml'), HB_YAML, 'utf8');
    const agent = new SmartHomeAgent();
    agent.heartbeat = {
      enabled: true,
      interval: '*/50 * * * *',
      checks: [{ name: '系统告警测试', prompt: '检查' }],
      getTaskContent: () => '新的巡检内容',
    };

    await agent.saveHeartbeatConfig();

    const raw = await fs.readFile(path.join(tmpDir, 'config', 'heartbeat.yaml'), 'utf8');
    const parsed = yaml.parse(raw);
    assert.equal(parsed.heartbeat.dynamic_prompt, '新的巡检内容');
    assert.equal(parsed.heartbeat.checks.length, 1);
    assert.ok(raw.includes('# 心跳配置'), '注释必须保留');
  });
});
