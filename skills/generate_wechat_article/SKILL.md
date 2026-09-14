---
name: generate_wechat_article
description: 根据给定主题自动撰写微信公众号文章，并利用API接口自动上传封面图片、将图文内容一键保存至微信草稿箱的自动化技能。
---

# 技能：生成微信公众号文章 (Generate WeChat Article)

此技能将指导助理利用其文案创作能力，结合项目中的 `wechat_api.py` 接口，实现从“文章创作”到“草稿箱保存”的一站式自动化流程。

## 1. 需求分析与内容创作

### 多标题策略
- **任务**：针对主题生成 3-5 个不同风格的标题供用户选择（或直接点击最吸引人的）。
- **风格**：如“功能解析型”、“行业观察型”、“共鸣情感型”、“反直觉标题党”。

### 文章排版 (WeChat HTML 标准)
微信草稿箱 API 接受 HTML 字符串。请遵循以下排版规范：
- **标题**：使用 `<h3>` 作为段落小标题，可搭配内联样式 `style="color: #0052d9;"`（腾讯蓝）。
- **正文**：严格使用 `<p>` 包裹段落，避免大段文字，保持呼吸感。
- **重点内容**：使用 `<strong>` 加粗，或使用 `<span style="background-color: #fdf6ec;">` 底部浅色背景高亮。
- **列表**：使用 `<ul>` 和 `<li>`。
- **摘要 (Digest)**：自动提炼 54 字以内摘要。如果为空，微信会自动抓取正文前 54 字。

## 2. 执行顺序与步骤 (Execution Flow)

### 步骤 A：文案创作
1. **生成标题**：根据主题生成 3-5 个标题，用户确认选定一个。
2. **撰写正文**：根据选定标题，先搜索网络再进行创作,保证真实可靠。 撰写带有 HTML 标签的完整正文，确保段落结构清晰。

### 步骤 B：封面图文设计
1. **封面底图生成**：使用 `custom_gemini_action` 生成一张 16:9 比例、富有质感的底图。
2. **合成文字（图文封面）**：在生成的封面底图上，利用 `custom_gemini_action` 的 Prompt 明确要求包含**选定的标题文字**（例如：`Add clear, elegant bold text '文章标题' in the center with contrast background`），确保封面具有冲击力。文字必须是中文，且必须是标题的中文。
3. **保存文件**：将最终生成的封面图保存为文章文件夹内的 `cover.png`。

### 步骤 C：正文配图与混排
根据正文内容，必须在关键段落插入 1-3 张配图：
1. **获取图片 (截图 vs 生图)**：
   - **截图模式**：如果正文或主题提及特定的网页 (URL)，**必须优先**使用 `browser-use open <url>` 访问页面，并使用 `browser-use screenshot <path>` 获取真实网页截图。
   - **生图模式**：如果未提及网页，或需要概念性插图，使用 `custom_gemini_action` 生成插图。**Prompt 要求**：必须模拟 **macOS 桌面截图风格**，画面应包含精致的 macOS 窗口（带红黄绿按钮）、VS Code 界面、终端或浏览器，所有内容需通过 App 窗口呈现，展现出专业、现代的编程或办公氛围。
2. **保存与占位**：
   - 将生成的图片或截图保存到文章文件夹内（例如 `img1.png`, `img2.png`）。
   - 在 HTML 中使用唯一的占位符（如 `IMAGE_PLACEHOLDER_1`）。**必须**将占位符放入 HTML 的 `<img>` 标签中，例如：`<p style="text-align: center;"><img src="IMAGE_PLACEHOLDER_1" style="width: 100%; border-radius: 8px;"></p>`。
   - 记录映射关系。

### 步骤 D：一键上传与存入草稿箱
1. **准备配置文件**：在文章文件夹内生成 `article_meta.json`，格式如下：
   ```json
   {
       "title": "文章标题",
       "author": "作者名",
       "digest": "54字以内的摘要",
       "image_mapping": {
           "IMAGE_PLACEHOLDER_1": "img1.png",
           "IMAGE_PLACEHOLDER_2": "img2.png"
       }
   }
   ```


> [!TIP]
> 1. HTML 中的代码块建议使用 `<pre>` 标签。
> 2. 文章文件夹由标题命名，存放在项目根目录下的 `workspace/assets/` 目录。
> 3. 所有的图片路径在 `article_meta.json` 中可以使用相对于该文件夹的路径。