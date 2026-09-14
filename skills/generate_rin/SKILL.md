---
name: 生成Rin博客文章
description: 根据给定主题自动撰写博客文章，并利用脚本接口自动上传封面图片、将Markdown内容一键发布或保存至Rin博客草稿箱的自动化技能。
---

# 技能：生成Rin博客文章 (Generate Rin Article)

此技能将指导助理利用其文案创作能力，结合项目中的 `rin_uploader.py` 脚本，实现从“文章创作”到“博客发布”的一站式自动化流程。

## 1. 需求分析与内容创作

### 文章构思策略
- **任务**：针对主题构思博客文章的结构并撰写引人入胜的内容。
- **风格**：如“技术教程型”、“生活随笔型”、“知识科普型”或“深度分析型”。

### 文章排版 (Markdown 标准)
Rin 博客接受标准的 Markdown 字符串。请遵循以下排版规范：
- **标题**：使用 `#` 到 `###` 标签作为文章层级划分，避免在一级标题外过度使用 `#`。
- **正文**：使用标准 Markdown 格式，注重阅读体验，段落间保持合理间距。
- **重点内容**：使用 `**粗体**` 加粗，或使用反引号包裹关键代码、术语进行高亮。
- **列表**：使用无序 `-` 或有序 `1.` 列表整理结构化信息。
- **代码块**：使用带有对应语言标识的围栏代码块。
- **摘要 (Summary)**：提炼文章核心亮点，用于博客列表展示。
- **标签 (Tags)**：根据内容提取 2-4 个相关标签，便于检索和分类。

## 2. 执行顺序与步骤 (Execution Flow)

### 步骤 A：文案创作
1. **构思文章**：根据给定的主题，可以先搜索网络获取准确及时的资料，保证内容真实可靠。
2. **撰写正文**：撰写符合 Markdown 规范的完整正文，确保逻辑连贯。
3. **内容留档**：为避免在终端中直接传入超长文本导致转义错误，将写好的 Markdown 内容保存到项目中的专属文件夹内（例如 `workspace/assets/<文章标题>/content.md`）。

### 步骤 B：封面与配图设计
1. **封面底图生成**：如果需要，使用 `custom_gemini_action` 生成一张贴合主题、富有质感的封面底图。
2. **配图获取 (截图 vs 生图)**：
   - **截图模式**：如果正文或主题提及特定的网页 (URL)，优先使用 `browser-use open <url>` 访问页面，并使用 `browser-use screenshot <path>` 获取真实网页截图。
   - **生图模式**：如果未提及网页或需要概念性插图，使用 `custom_gemini_action` 生成插图。
3. **保存文件**：将最终生成的封面图及配图保存至同名文件夹内（例如 `workspace/assets/<文章标题>/cover.png`）。

### 步骤 C：一键发布与草稿处理
在此步骤中，调用位于 `skills/generate_rin/scripts/rin_uploader.py` 的脚本。

1. **上传正文内插图（按需）**：
   如果正文中需要插入图片，先逐个上传图片并获取链接：
   ```bash
   python skills/generate_rin/scripts/rin_uploader.py --url <网站地址> --token <Token> upload-image workspace/assets/<文章标题>/img1.png
   ```
   然后将控制台输出的图片 URL 填入到 Markdown 对应位置中：`![插图说明](图片URL)`。

2. **执行发布命令**：
   使用 Python 脚本创建并发布文章，可利用 `cat` 读取并传入之前保存的 Markdown 文件：
   ```bash
   python skills/generate_rin/scripts/rin_uploader.py --url <网站地址> --token <Token> create \
       --title "文章标题" \
       --content "$(cat workspace/assets/<文章标题>/content.md)" \
       --summary "这里是摘要" \
       --tags 标签1 标签2 \
       --image workspace/assets/<文章标题>/cover.png
   ```
   *说明：如当前文章未最终定稿，需要存为草稿，请在命令末尾追加 `--draft` 参数。*

> [!TIP]
> 1. 文章和图片等资源建议统一存放在 `workspace/assets/` 目录下按标题命名的子文件夹中，以保持项目工作区整洁。
> 2. `--tags` 参数支持传入多个标签，使用空格分隔即可。
> 3. `rin_uploader.py` 除了支持 `--token` 认证外，也支持 `--username` 和 `--password`。实际使用时根据用户的提供情况进行选择。
