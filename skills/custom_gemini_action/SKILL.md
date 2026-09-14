---
name: custom_gemini_action
description: 利用 Playwright 持久化浏览器实例自动化操作 Google Gemini 页面。支持单/多轮消息发送、图片生成、Canvas 提取，并以函数返回值和 JSON stdout 双模式输出结果。
---

# 自定义 Gemini 自动化脚本

此 Skill 提供了一套基于 **Playwright `launch_persistent_context`** 的 Python 自动化工具。
它使用 `workspace/browser-profile` 目录持久化登录态，允许 `gemini_chat.py`、`gemini_image.py` 和 `gemini_canvas.py` 共享同一个 Google 账号登录槽，避免多轮冲突。

> [!IMPORTANT]
> **🚀 运行速度说明**：为了绝对规避自动化风控阈值，并给予工具激活（如 15~20秒）和内容渲染（如生图常配有 120s 满速缓冲）充裕的等待，**脚本在涉及交互和下载节点包含较长的内置缓冲 Sleep，整体执行速度较慢，请耐心等待, 脚本执行时间可能长达10分钟**。

---

## 1. 核心特性

- **多轮会话支持**：部分脚本 (`gemini_chat.py`, `gemini_image.py`) 支持传入 **JSON 字符串数组**，自动循环完成多轮交互。
- **持久化登录**：首次 `--login` 后，状态安全落盘，后续无需重复登录。
- **拟人化防封规避**：打字速度随机化、元素点击前加缓冲、防自动化特征剔除。
- **双保险发送**：优先抓取发送按钮进行精准命中，不成功则使用 Enter 键垫底。
- **双模式输出**：支持 Python 库内调用直接 `return`，及 shell 终端 stdout 输出结构化 JSON。

---

## 2. 聊天/问答 (`gemini_chat.py`)

用于向 Gemini 发送单条或连续多条对话指令。

### 2.1 首次登录（初始化）

```bash
python3 gemini_chat.py --login
```
在弹出的浏览器中手动登录 Google 账号，确认刷出聊天框后**直接手动关闭窗口**即可将状态归档。

### 2.2 发送消息

```bash
# 单一条目发送
python3 gemini_chat.py --message "请帮我写一段 Python 快速排序算法"

# 连续多轮对话发送 (转译传入 JSON 数组)
python3 gemini_chat.py --message '["请帮我设计一个商城数据库", "现在帮我生成 user 表的 create 语句"]'
```

**可选参数：**
- `--headless`：后台静默执行（不弹出浏览器窗口）。
- `--url`：指定在特定的会话 URL（或者新建会话）上执行操作。

### 2.3 数据返回布局

命令行执行后，stdout 会打出：

```
--- JSON_OUTPUT_BEGIN ---
{
  "success": true,
  "messages": ["你好"],
  "replies": ["你好！有什么我可以帮你的吗？"]
}
--- JSON_OUTPUT_END ---
```

外部程序可通过 `--- JSON_OUTPUT_BEGIN ---` 标记截获并解析。

### 2.4 Python 内部调用

```python
from gemini_chat import run_gemini_chat

# 内部调用支持传入列表
replies = run_gemini_chat(["你好，请自我介绍", "你最擅长什么？"])
for i, rep in enumerate(replies):
    print(f"第 {i+1} 轮回复: {rep}\n")
```

---

## 3. 图片生成 (`gemini_image.py`)

共享同一个 `user_data`。用于自动化唤醒 Gemini "Create image" 工具并批次下载。

### 3.1 使用方法

```bash
# 单图生成
python3 gemini_image.py --prompt "画一只穿宇航服的猫咪"

# 连续多轮衍生生图 (JSON 数组)
python3 gemini_image.py --prompt '["画一只可爱的柴犬", "给它背景换成赛博朋克城市"]'

# 指定保存目录与无头模式
python3 gemini_image.py --prompt "水彩风格的山水画" --output /path/to/save --headless
```

提取后的图片自动存档于：项目根目录下的 `workspace/media/geminiImage` 目录。

### 3.2 图片下载抗性机制

脚本智能识别：
- **`blob:` & `http`**：利用 JS 穿透式 `fetch` 读取转 Base64 写入，避开 cross-origin restriction。
- **`data:image`**：原生 Base64 截获解码。
- 同时增加 120 秒高清生图渲染缓冲，最大化下载高清原生图。

---

## 4. Canvas 解析与提取 (`gemini_canvas.py` - 单轮)

用于向 Gemini 发送提示词，并在 Gemini 画布组件生成代码/文档后，全量剥离侧边栏的文件内容。

### 4.1 核心攻关特性

- **多层级穿透抓取**：
  - **内设 API 读取**：Monaco Editor 内存层 `getModels()[0].getValue()` 反显（100%覆盖，防虚拟滚动折叠）。
  - **云层 Share 复制**：精确剥离侧边栏 `Share` -> `.copy-button`。
- **文件名自反问归航**：反问 Gemini 给该文件提供标准命名，正则高精度匹配后落盘。

### 4.2 使用方法

```bash
# 发送单轮设计指令
python3 gemini_canvas.py --message "写一个俄罗斯方块 html5 游戏"
```

内容会被沉淀记录到项目根目录下的 `workspace/media/geminiFile` 路径下的标准扩展名对应文件中。

---

## 5. 故障排查

| 症状 | 解决方法 |
|------|--------|
| `启动浏览器失败` / `已被锁(locked)` | 机器上其他打开了相同 `user_data` 目录的 Playwright 或 Chrome 进程有残留，杀死该 PID 即可 |
| `无法找到输入框` / `Timeout` | Gemini UI 版面可能发生大变化，需校准对应脚本的 `input_selector` |
| `Canvas 侧边栏未提取到数据` | Gemini 反应需要时间，或右侧并不是真正的划出式 Canvas 面板 |
