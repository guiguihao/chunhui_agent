---
name: Generate_Xiaohongshu
description: 自动生成符合小红书风格的爆款文案、精美系列配图（3-9张），并自动组织内容文件夹以便发布。
---

# 技能：生成小红书爆文 (Generate_Xiaohongshu)

此技能旨在帮助用户快速创作具有“爆款潜质”的小红书内容。小红书的核心在于“高颜值图片”+“情绪化文案”+“实用干货”。

## 1. 文案创作规范

### 爆款标题
- **公式**：[情绪词] + [利益点] + [数字/反直觉] + [表情符号]
- **示例**：
  - “救命🆘！这个编程技巧真的好用到哭😭”
  - “杭州 0 元拍照圣地📷，美到不想走！”
  - “建议收藏！普通人也能翻身的 3 个底层逻辑🧠”

### 正文排版
- **第一段**：黄金 3 秒，直接切入痛点或抛出惊喜。
- **中间段**：多用表情符号作为列表符（如 ✅ 💡 ✨）。
- **结尾**：必须包含互动引导（如“大家怎么看？”、“评论区告诉我”）。
- **Hashtags**：包含 5-10 个相关标签（如 #小红书成长笔记 #干货分享）。

## 2. 执行步骤 (Execution Flow)

### 步骤 A：策划与文案
1. **内容获取**：
   - **如果用户提供了参考网址**：直接读取并提取该网址的核心内容作为素材，**无需**再进行额外的搜索。
   - **如果未提供网址**：利用 `baidu-search` 搜索主题相关的最新热点或干货。
2. **生成标题**：根据获取到的素材，提供 3-5 个不同风格的爆款标题。

### 步骤 B：用户确认选择标题
   - **如果用户提供了参考网址**：无需用户确认,直接使用参考网址内容的标题。
   - **如果用户未提供参考网址**：请用户确认选择标题。

### 步骤 C：撰写内容
1. 根据选定标题，撰写符合小红书语气的文案.
2. 内容保存至 `workspace/assets/xhs_[标题]/` 目录下，命名为 `content.md`

### 步骤 D：系列配图设计 (3-9 张)
小红书是视觉驱动的，必须生成一组图片,内容来源 `content.md`：
1. **封面图 (Cover)**：一律使用 `custom_gemini_action` 生成。**必须包含显眼的艺术字标题**，背景要精美、明亮。
2. **内容图 (Slides) 获取方式**：
   - **截图模式**：如果正文或主题提及特定的网页 (URL)，**必须优先**使用 `browser-use open <url>` 访问页面，并使用 `browser-use screenshot <path>` 获取真实网页截图。
   - **生图模式**：如果未提及网页，或需要概念性插图，使用 `custom_gemini_action` 生成插图。**文字要求**：每张图都必须依据该段落的干货内容，在图片中加入对应的关键文字或金句。
3. **风格与呈现**
   - 截图模式直接使用截图。
   - 生图模式（特别是技术类）：必须模拟 **macOS 桌面截图风格**，包含精致的 macOS 窗口（带红黄绿按钮）、VS Code 界面、终端或浏览器。所有干货文字必须通过 App 窗口自然呈现。
4. **保存路径**：图片保存至 `workspace/assets/xhs_[标题]/` 目录下，命名为 `1_cover.png`, `2.png`, `3.png` ...

### 步骤 C：文件组织
在文件夹内生成 `post_info.json`：
```json
{
  "title": "爆款标题",
  "content": "文案全文...",
  "tags": ["#标签1", "#标签2"],
  "images": ["1_cover.png", "2.png", "..."]
}
```

### 步骤 D：发送给用户
任务完成后，**必须**在最终的系统回复中输出以下内容，以便用户可以复制到飞书：
1. **完整文案**：直接输出排版好的小红书文案全文（含 Emoji 和 Hashtags）。
2. **图片路径**：以列表形式输出所有生成或截取的图片**本地绝对路径**（或真实 URL）。（提示：系统会自动读取这些路径并转化为飞书图片发送给用户）。

## 3. 提示词技巧 (Image Prompt Tips)

使用 `custom_gemini_action` 时，请在 Prompt 中加入以下关键词：
- **封面图**：`Xiaohongshu style cover, vibrant colors, bold aesthetic typography with clear text "[文章标题]", high quality photography, soft lighting.`
- **内容图**：`Aesthetic informational slide, featuring bold and readable text "[该页干货内容/金句]", minimalist design, high contrast, clean layout.`
- **技术类**：`Simulate a macOS desktop screenshot, featuring an elegant VS Code, Terminal, or Browser window with the standard red/yellow/green traffic light buttons. Display the text "[干货内容]" clearly inside the application window.`

> [!TIP]
> 1. 第一张图决定了点击率，一定要在 Prompt 中明确要求加入标题文字。
> 2. 小红书图片的比例通常为 3:4 或 1:1，请在生图时尽量引导。
> 3. 文案中不要使用“姐妹们”、“家人们”、“避雷”、“亲测有效”等过度泛滥的高频词汇。
> 4. **生图提示词中严禁包含任何标签 (Hashtags)，也绝对不要出现“收藏”、“分享”等字样。**
