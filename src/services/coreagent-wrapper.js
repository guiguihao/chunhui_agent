import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import dotenv from 'dotenv';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const BASE_SYSTEM_PROMPT = `你是一个极其聪明、动作果断的 SmartHomeClaw 智能家居 AI 管家，名叫 "{agent_name}"。
你驻留在用户的家庭服务器中，通过各种工具感知并控制物理世界。

### 行动准则
1. **探测优先**：如果用户的意图涉及查询，**严禁**反向询问用户以获取信息。你拥有工具，应该**立即调用工具**自助查询，然后给出结论。
2. **拒绝平庸**：不要做一个只会复读和确认的复读机。你的价值在于通过后台操作减少用户的认知负担。
3. **静默多步执行**：如果一个任务需要多步，请在一次回复前连续调用所有必要工具，直接汇报最终结果。
4. **歧义处理**：只有当工具返回依然存在无法确定的多项选择时，才礼貌地请用户选择。

### 你的能力清单
1. **定时任务 (Cron)**：mgmt_cron_list / mgmt_cron_add / mgmt_cron_remove / mgmt_cron_toggle
2. **心跳巡检 (Heartbeat)**：mgmt_heartbeat_get / mgmt_heartbeat_set
3. **长期记忆 (Memory)**：memory_* 工具

### 实时环境
- **当前时间**：{current_time}
- **记忆与历史**：
{memory_context}

请开始你的服务。**少说话，多干活**，做一个让用户感到"省心"的管家。`;

class OpenAIModelAgent {
  constructor(config = {}) {
    this.name = config.name || 'SmartHomeClaw';
    this.maxContextTurns = config.maxContextTurns || 20;
    this.maxToolIterations = config.maxToolIterations || 10;
    this.sessionDir = config.sessionDir || './sessions';
    this._sessions = {};

    this.openai = new OpenAI({
      baseURL: config.baseUrl || process.env.OPENAI_BASE_URL,
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      timeout: config.timeout || 60000,
    });
    this.model = config.model || 'gpt-4o';

    this.systemPrompt = config.systemPrompt || '';
  }

  async init() {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  _buildSystemPrompt(additionalCtx = '') {
    return BASE_SYSTEM_PROMPT
      .replace('{agent_name}', this.name)
      .replace('{current_time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
      .replace('{memory_context}', additionalCtx || '无');
  }

  async decide(prompt, options = {}) {
    const sessionId = options.sessionId || 'default';

    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = [];
    }

    const history = this._sessions[sessionId];

    if (history.length > this.maxContextTurns * 2) {
      history.splice(0, history.length - this.maxContextTurns * 2);
    }

    const systemParts = [this._buildSystemPrompt()];
    if (options.appendSystemPrompt) {
      systemParts.push(options.appendSystemPrompt);
    }

    const systemMsg = {
      role: 'system',
      content: systemParts.join('\n\n'),
    };

    const tools = [
      {
        type: 'function',
        function: {
          name: 'memory_get_user_profile',
          description: '获取用户偏好设置',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_update_user_profile',
          description: '更新用户偏好设置',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '新的偏好内容' },
            },
            required: ['content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_get_habits',
          description: '获取用户习惯记录',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_update_habits',
          description: '更新用户习惯记录',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '新的习惯内容' },
            },
            required: ['content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_get_facts',
          description: '获取重要事实记录',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_update_facts',
          description: '更新重要事实记录',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '新的事实内容' },
            },
            required: ['content'],
          },
        },
      },
    ];

    history.push({ role: 'user', content: prompt });

    const apiMessages = [systemMsg];
    for (const msg of history) {
      if (msg.tool_calls) {
        apiMessages.push({
          role: msg.role,
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        });
      } else if (msg.tool_call_id) {
        apiMessages.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        });
      } else {
        apiMessages.push({
          role: msg.role,
          content: msg.content || '',
        });
      }
    }

    let finalResponse = '';

    for (let i = 0; i < this.maxToolIterations; i++) {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: apiMessages,
        tools: tools,
        temperature: 0.7,
      });

      const choice = response.choices[0];
      const msgToStore = {
        role: choice.message.role,
        content: choice.message.content,
      };

      if (choice.message.tool_calls) {
        msgToStore.tool_calls = choice.message.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }

      history.push(msgToStore);

      if (msgToStore.tool_calls && msgToStore.tool_calls.length > 0) {
        for (const toolCall of msgToStore.tool_calls) {
          const tName = toolCall.function.name;
          let tArgs = {};
          try {
            tArgs = JSON.parse(toolCall.function.arguments);
          } catch {}

          const tRes = `[模拟工具响应] ${tName}(${JSON.stringify(tArgs)}) - 请在实际集成时连接真实工具`;
          console.log(`[OpenAIAgent] 工具调用: ${tName} → ${tRes}`);

          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: tRes,
          });

          apiMessages.push(msgToStore);
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: tRes,
          });
        }
        continue;
      } else {
        finalResponse = msgToStore.content || '';
        break;
      }
    }

    return this.parseOutput(finalResponse);
  }

  async continue(sessionId, prompt) {
    return this.decide(prompt, { sessionId });
  }

  parseOutput(output) {
    if (!output) return { response: '无响应' };

    try {
      return JSON.parse(output);
    } catch {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          return { response: output };
        }
      }
      return { response: output };
    }
  }

  async clearHistory(sessionId = 'default') {
    if (this._sessions[sessionId]) {
      this._sessions[sessionId] = [];
    }
  }
}

export default OpenAIModelAgent;