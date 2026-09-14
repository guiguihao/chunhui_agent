# SmartHomeClaw - 智能家居 AI Agent

基于 **Qwen Code 无头模式** 驱动的智能家居 AI Agent，具有自主学习和决策能力。

## 特性

- 🤖 **AI 自主决策** - 基于 Qwen Code 无头模式，AI 自主学习和决策
- 🧠 **持久化记忆** - 自动学习并记录用户习惯，持久化到 `memory/` 目录
- ⏰ **Cron 定时任务** - 支持基于 Cron 表达式的自动化调度
- 💓 **心跳机制** - 定期静默自检，保障服务健康运行
- 🔌 **MCP Server 集成** - 可接入任意兼容 MCP 协议的智能家居服务端
- 🧩 **插件系统** - 提供标准化的第三方服务扩展接口

## 架构

```
┌──────────────────────────────────────────────────────┐
│              Node.js Agent                            │
│  - 调度中心  - 记忆管理  - 定时任务  - 心跳            │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│           Qwen Code 无头模式 (AI Brain)               │
│  qwen --continue -p "现在做什么？" --output-format json│
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│              MCP Server (mcp/ 目录)                   │
│  - 设备控制  - 状态查询  - 场景触发                   │
└──────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的配置
```

### 3. 初始化 MCP Server

```bash
npm run setup-mcp
```

### 4. 启动 Agent

```bash
npm start
```

## 目录结构

```
smarthomeaegnt/
├── src/
│   ├── agent.js                 # 主入口
│   ├── services/
│   │   ├── qwen-agent.js        # Qwen Code 无头模式封装
│   │   ├── scheduler.js         # Cron 定时任务
│   │   ├── heartbeat.js         # 心跳机制
│   │   └── memory.js            # 记忆管理
│   └── memory/                  # 记忆服务模块
├── mcp/                         # MCP Server 目录 (直接放入)
├── plugin/                      # 插件目录
├── memory/                      # 记忆存储
│   ├── USER_PROFILE.md          # 用户偏好
│   ├── HABITS.md                # 习惯记录
│   └── FACTS.md                 # 家居信息
├── config/
│   ├── agent.yaml               # Agent 基础配置
│   ├── heartbeat.yaml           # 心跳配置
│   ├── cron.yaml                # 定时任务配置
│   └── plugin.yaml              # 插件配置
├── scripts/
│   └── setup-mcp.js             # MCP 初始化脚本
├── tests/
│   └── test.js                  # 测试脚本
├── .env.example
├── package.json
└── README.md
```

## 配置说明

### config/agent.yaml

Agent 基础配置，包括 Qwen Code 输出格式、MCP 目录等。

### config/heartbeat.yaml

心跳机制配置，包括检查间隔和检查项。

### config/cron.yaml

定时任务配置，支持标准 Cron 表达式。

### config/plugin.yaml

插件配置，如飞书、微信等第三方服务。

## 使用 MCP Server

将 MCP Server 放入 `mcp/` 目录，然后运行：

```bash
npm run setup-mcp
```

会自动扫描并注册到 `.qwen/settings.json`。

## 开发

### 添加新插件

在 `plugin/` 目录下创建新目录，包含插件代码和配置。

### 添加新 MCP Server

在 `mcp/` 目录下放入 MCP Server 代码。

### 测试

```bash
npm test
```

## 依赖

- Node.js >= 18
- Qwen Code CLI (已安装)
- 其他依赖见 `package.json`

## 许可证

MIT
