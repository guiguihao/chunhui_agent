# SmartHomeClaw - 智能家居 AI Agent

基于 **Node.js + 大模型工具调用 (Function Calling)** 驱动的自主智能家居 AI 管家系统，具备长期记忆、MCP 工具扩展、自动化定时任务与多端交互能力。

---

## 🌟 核心特性

- 🤖 **多模型决策与高可用**：基于标准 OpenAI 兼容 API 驱动，支持 DeepSeek、OpenAI、NVIDIA NIM、Ollama 等主流模型，具备主备模型故障自动降级（Fallback）与轮询机制。
- 🔌 **MCP Server 深度集成**：内置 `mcporter` 客户端，开箱即用支持 Home Assistant (`ha-mcp`)、米家 (`miot-mcp`)、悠瑞智能家居 (`ureal-mcp`) 与小度度秘等标准 MCP 服务端。
- 🧠 **持久化分层记忆**：自动学习并沉淀用户习惯，划分为用户画像 (`USER_PROFILE.md`)、长期知识 (`KNOWLEDGE.md`)、事实记录 (`FACTS.md`) 与即时上下文 (`CONTEXT.md`)。
- ⚡ **扩展技能系统**：集成了百度搜索、基于 `browser-use` 的浏览器自动化、自媒体图文生成与推送等丰富技能扩展。
- ⏰ **定时调度与心跳巡检**：
  - **Cron 定时调度**：支持标准 Cron 表达式自动化任务，支持动态任务创建与持久化，执行结果自动广播通知。
  - **智能心跳自检**：定时巡检温湿度、水压、设备离线状态等指标，发现异常实时推送信使警报。
- 📱 **多渠道与可视化交互**：
  - **飞书 (Lark) 接入**：基于官方 SDK WebSocket 长连接，支持交互式卡片、打字机流式渐进更新与原生表格渲染。
  - **WebUI 控制台**：基于 React + Vite 的可视化控制台，支持会话监控、配置热重载、心跳与定时任务配置。

---

## 🏛️ 系统架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                          交互层 (Interface Layer)                       │
│        飞书机器人 (WebSocket)        │        WebUI 管理端 (React+Vite) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                       调度主控 (SmartHomeAgent)                        │
│   生命周期管理  │  配置热重载  │  消息广播中心 (MessengerBridge)        │
└─────────────────┬───────────────────────────────────┬──────────────────┘
                  │                                   │
        ┌─────────▼──────────────┐          ┌─────────▼──────────────┐
        │     定时任务调度器     │          │      心跳自检引擎      │
        │  (Scheduler/cron.yaml) │          │ (Heartbeat/heartbeat)  │
        └─────────┬──────────────┘          └─────────┬──────────────┘
                  │                                   │
┌─────────────────▼───────────────────────────────────▼──────────────────┐
│                        核心引擎 (CoreAgent)                            │
│  - System Prompt 组装与 README/记忆注入                                │
│  - 多轮上下文管理 (Session Manager)                                    │
│  - 工具调用循环 (Function Calling Loop, maxToolIterations: 10)         │
│  - 工作区安全沙箱 (Workspace Confinement Sandbox)                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
    ┌───────────────────────────────┼──────────────────────────────┐
    ▼                               ▼                              ▼
┌──────────────┐            ┌──────────────┐              ┌──────────────┐
│  记忆管理    │            │ 技能扩展系统 │              │ MCPorter 桥接│
│(MemoryService)│           │(SkillService)│              │ (MCP Server) │
├──────────────┤            ├──────────────┤              ├──────────────┤
│- 用户偏好画像│            │- 百度搜索    │              │- ha-mcp      │
│- 事实与知识库│            │- 浏览器操作  │              │- ureal-mcp   │
│- 即时对话背景│            │- 微信/小红书 │              │- miot-mcp    │
└──────────────┘            └──────────────┘              └──────────────┘
```

---

## 🚀 快速开始

### 1. 环境准备
- Node.js >= 18.0.0
- pnpm (推荐) 或 npm
- Python >= 3.10 (如需使用 Python 编写的 MCP Server 或技能脚本)

### 2. 安装依赖
```bash
pnpm install
# 或 npm install
```

### 3. 配置环境变量
复制示例配置文件并填入相应的 API Key 与凭证：
```bash
cp .env.example .env
```
配置项包括：
- `DEEPSEEK_API_KEY` / `NVIDIA_API_KEY`：大模型 API Key
- `HA_TOKEN`：Home Assistant 长效访问令牌
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书应用凭证（若启用飞书）
- `UREAL_TOKEN` / `UREAL_APP_KEY`：悠瑞智能家居 MCP 鉴权

### 4. 验证 MCP Server 配置
```bash
npm run setup-mcp
```

### 5. 启动服务
```bash
# 生产模式启动
npm start

# 开发监控模式（代码变动自动重载）
npm run dev
```

---

## 📁 目录结构

```
urealagent_new/
├── config/                      # 系统配置目录
│   ├── agent.yaml               # Agent 基础提示词与模型 Provider 配置
│   ├── mcporter.json            # MCP Server 注册与连接配置
│   ├── cron.yaml                # 定时任务配置（支持热更新回写）
│   ├── heartbeat.yaml           # 心跳自检规则与巡检项目
│   └── plugin.yaml              # 飞书、MCPorter、WebUI 等插件启用配置
├── memory/                      # 持久化长期记忆库 (Markdown)
│   ├── USER_PROFILE.md          # 用户画像与行为偏好
│   ├── KNOWLEDGE.md             # 长期业务经验与通用知识
│   ├── FACTS.md                 # 关键事实与设备硬件信息
│   └── CONTEXT.md               # 阶段性对话背景上下文
├── mcp/                         # 本地 MCP Server 源码与服务
│   ├── miot-mcp/                # 米家设备接入协议与服务端
│   └── ureal-mcp/               # 悠瑞智能家居控制与审计日志
├── plugin/                      # 外部通信与界面扩展插件
│   ├── feishu.js                # 飞书交互式卡片长连接服务
│   ├── mcporter.js              # MCPporter 客户端及工具动态发现
│   └── webui.js                 # WebUI 后端 API 与安全服务
├── skills/                      # 扩展技能目录 (Markdown/JS/Python)
│   ├── agent-browser/           # 浏览器自动化控制
│   ├── baidu-search/            # 百度搜索调用
│   ├── custom_gemini_action/    # 智能多媒体生成
│   ├── tasktodolist/            # 待办清单管理
│   ├── weather/                 # 天气与环境数据查询
│   └── ...
├── src/                         # 核心业务源码
│   ├── agent.js                 # 主控制程序与生命周期调度
│   └── services/                # 核心功能服务模块
│       ├── coreagent.js         # CoreAgent 模型循环与安全沙箱
│       ├── memory.js            # 记忆管理服务
│       ├── scheduler.js         # 定时任务执行引擎
│       ├── heartbeat.js         # 心跳自检服务
│       ├── skill.js             # 技能动态注册与调度
│       └── messenger.js         # 多通道消息路由广播器
├── webui/                       # WebUI 前端工程 (React + Vite)
├── workspace/                   # Agent 执行临时文件与报表输出沙箱
├── scripts/                     # 运维辅助与配置检查脚本
│   └── setup-mcp.js             # MCP Server 状态验证脚本
├── .env.example                 # 环境变量模板
├── package.json
└── README.md
```

---

## ⚙️ 核心配置说明

- **[config/agent.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/agent.yaml)**：定义管家姓名、核心行动准则、工作区路径、模型 Providers 及默认主/备模型配置。
- **[config/mcporter.json](file:///Volumes/ssd/project/xuexi/urealagent_new/config/mcporter.json)**：配置所连接的外部或本地 MCP 服务端（URL、命令、鉴权 Headers 等）。
- **[config/cron.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/cron.yaml)**：配置静态定时任务，支持 AI 动态添加与启停管理，数据自动持久化。
- **[config/heartbeat.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/heartbeat.yaml)**：配置自检间隔与自检 Prompt，异常时自动触发报警。
- **[config/plugin.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/plugin.yaml)**：配置飞书机器人、MCP 端口及 WebUI 服务端口。

---

## 🛡️ 安全与沙箱机制

1. **环境隔离**：所有敏感凭证（如 Home Assistant JWT Token、各类 API Key）严格通过 `.env` 注入，杜绝硬编码。
2. **文件系统沙箱**：CoreAgent 内置文件工具（`file_write` / `file_append` / `file_delete` / `file_edit`）被严格限定在 `workspace/` 目录下，严禁越权修改或覆盖系统源代码及核心配置文件。
3. **接口防越权**：WebUI 静态资源服务已拦截 `.env*`、`.git/`、`config/` 及各类密钥证书的读取访问。

---

## 📄 许可证

本项目基于 [MIT License](file:///Volumes/ssd/project/xuexi/urealagent_new/LICENSE) 开源。
