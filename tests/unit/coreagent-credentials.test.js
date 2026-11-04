import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import CoreAgent from '../../src/services/coreagent.js';

/**
 * 覆盖真实部署事故：模型 provider 的 api_key_env 指向的变量在 .env 中缺失时，
 * 旧实现直接 new OpenAI({ apiKey: '' })，SDK 抛出
 * "Missing credentials. Please pass an `apiKey`..."——
 * 既不说哪个 provider，也不说缺哪个环境变量，容器只会无限 restart。
 */
const modelCfg = (over = {}) => ({
  model: 'Qwen/Qwen3.8-Flash-Next',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  apiKey: '',
  apiKeyEnv: 'MODELSCOPE_TOKEN1',
  providerName: 'moda',
  ...over,
});

const sessionDir = path.join(os.tmpdir(), 'ureal-cred-test');

describe('CoreAgent 启动凭据校验', () => {
  test('全部缺 key：报错点名环境变量，而不是 SDK 的 Missing credentials', () => {
    assert.throws(
      () => new CoreAgent({ primaryConfigs: [modelCfg()], sessionDir }),
      (err) => {
        assert.match(err.message, /MODELSCOPE_TOKEN1/);
        assert.match(err.message, /moda/);
        assert.doesNotMatch(err.message, /Missing credentials/);
        return true;
      },
    );
  });

  test('主模型缺 key 时降级到有 key 的 fallback（服务要能起来）', () => {
    const agent = new CoreAgent({
      primaryConfigs: [modelCfg()],
      fallbackConfigs: [
        modelCfg({
          model: 'deepseek-v4-flash',
          apiKey: 'sk-real',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          providerName: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
        }),
      ],
      sessionDir,
    });

    assert.equal(agent.primaryConfigs.length, 1, '无 key 的主模型必须被剔除');
    assert.equal(agent.primaryConfigs[0].model, 'deepseek-v4-flash');
    assert.equal(agent.model, 'deepseek-v4-flash');
  });

  test('部分主模型缺 key：只剔除该配置，轮询列表保持其余项', () => {
    const agent = new CoreAgent({
      primaryConfigs: [
        modelCfg(),
        modelCfg({ model: 'ZhipuAI/GLM-5.3-Flash', apiKey: 'ms-key' }),
      ],
      sessionDir,
    });

    assert.deepEqual(agent.primaryConfigs.map((c) => c.model), ['ZhipuAI/GLM-5.3-Flash']);
  });

  test('fallback 里的空 key 配置同样被剔除（否则切过去必失败）', () => {
    const agent = new CoreAgent({
      primaryConfigs: [modelCfg({ apiKey: 'k' })],
      fallbackConfigs: [modelCfg({ model: 'no-key-model' })],
      sessionDir,
    });

    assert.deepEqual(agent.fallbackConfigs, []);
  });

  test('热更新时新配置全无 key：保持旧配置，不重建坏 client', () => {
    const agent = new CoreAgent({
      primaryConfigs: [modelCfg({ apiKey: 'k' })],
      sessionDir,
    });
    const before = agent.client;

    agent.reloadModelConfig({ primaryConfigs: [modelCfg({ apiKey: '' })] });

    assert.equal(agent.client, before, '旧 client 必须保留');
    assert.equal(agent.primaryConfigs[0].apiKey, 'k');
  });
});
