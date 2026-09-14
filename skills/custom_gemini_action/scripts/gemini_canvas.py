import argparse
import time
import os
import sys
import random
import json
from playwright.sync_api import sync_playwright

def run_gemini_canvas(messages, is_login_mode=False, headless=False, target_url="https://gemini.google.com/app"):
    # 获取项目根目录 (skills/custom_gemini_action/scripts/ -> project root)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", "..", ".."))
    workspace_dir = os.path.join(project_root, "workspace")

    user_data_dir = os.path.join(workspace_dir, "browser-profile")
    os.makedirs(user_data_dir, exist_ok=True)

    # 确保 messages 是列表
    if isinstance(messages, str):
        messages = [messages]

    with sync_playwright() as p:
        # 登录模式或用户希望可见时，headless 为 False
        launch_headless = False if (is_login_mode or not headless) else True

        print(f"[INFO] 正在启动独立浏览器实例 (headless={launch_headless})...")
        try:
            browser_context = p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=launch_headless,
                # 规避一些机器人检测
                args=["--disable-blink-features=AutomationControlled"]
            )
        except Exception as e:
            print(f"[ERROR] 启动浏览器失败！请确保没有其他打开了同级 user_data 目录的浏览器窗口残留: {e}")
            sys.exit(1)

        page = browser_context.pages[0] if browser_context.pages else browser_context.new_page()

        if is_login_mode:
            print(f"[INFO] 正在以【登录模式】打开目标页面 : {target_url}")
            page.goto(target_url)
            try:
                page.wait_for_event("close", timeout=0)
            except Exception:
                pass
            print("[INFO] 浏览器已关闭，登录状态保存完毕！")
            return None

        print("[INFO] 浏览器已启动，等待 10 秒后跳转目标页面...")
        time.sleep(10)
        print(f"[INFO] 正在导航至: {target_url}")
        page.goto(target_url)
        
        # ── 1. 输入框加载与工具激活 (仅执行一次) ──
        print(f"[INFO] 等待输入框加载...")
        input_selector = "rich-textarea p, div[contenteditable='true']"
        try:
            page.wait_for_selector(input_selector, timeout=20000)
            print("[INFO] 等待 15 秒以确保辅助工具菜单加载（确保能点击 Canvas）...")
            time.sleep(15)

            print("[INFO] 正在尝试激活 'Canvas' 工具...")
            tool_activated = False
            
            deselect_selectors = [
                "button[aria-label*='Deselect Canvas']",
                "button:has-text('Deselect Canvas')",
                "button.toolbox-drawer-item-deselect-button:has-text('Canvas')",
            ]
            for d_sel in deselect_selectors:
                if page.is_visible(d_sel):
                    print("[INFO] ✅ 检测到 'Canvas' 工具已经处于激活状态，无需再次点击。")
                    tool_activated = True
                    break
                    
            if not tool_activated:
                tools_btn_selectors = [
                    "button[aria-label='Tools']",
                    "button.toolbox-drawer-button",
                    "button:has-text('Tools')",
                ]
                tools_clicked = False
                for tb_sel in tools_btn_selectors:
                    try:
                        if page.is_visible(tb_sel):
                            page.click(tb_sel)
                            print(f"[INFO] 已点击 'Tools' 菜单按钮 ({tb_sel})")
                            time.sleep(3)
                            tools_clicked = True
                            break
                    except Exception:
                        pass
                
                if tools_clicked:
                    canvas_selectors = [
                        "button.toolbox-drawer-item-list-button:has-text('Canvas')",
                        "button[role='menuitemcheckbox']:has-text('Canvas')",
                        "button:has-text('Canvas')",
                    ]
                    for c_sel in canvas_selectors:
                        try:
                            loc = page.locator(c_sel).first
                            if loc.is_visible():
                                loc.click()
                                print(f"[INFO] ✅ 已在 Tools 菜单中选中 'Canvas' ({c_sel})")
                                time.sleep(2)
                                tool_activated = True
                                break
                        except Exception:
                            pass
                else:
                    print("[WARN] 未找到 Tools 按钮")

            if tool_activated:
                 print("[INFO] ✅ 'Canvas' 工具激活指令已发出")
            else:
                 print("[WARN] 未能激活 'Canvas' 工具，将继续以常规文本模式提交。")

        except Exception as tool_err:
             print(f"[INFO] 尝试激活工具时跳过或超时: {tool_err}")

        # ── 2. 多轮对话发送 ──
        for idx_m, message in enumerate(messages):
            print(f"\n[INFO] === 第 {idx_m + 1} 轮对话 (共 {len(messages)} 轮) ===")
            
            try:
                # 清理可能残留的文本
                try:
                    current_input = page.locator(input_selector).inner_text()
                    if current_input.strip():
                         print("[INFO] 输入框中有残留内容，正在清空...")
                         page.click(input_selector)
                         page.keyboard.press("Control+KeyA")
                         page.keyboard.press("Backspace")
                except Exception:
                    pass

                print(f"[INFO] 正在输入消息: '{message}'")
                time.sleep(random.uniform(1.2, 2.8)) 
                page.click(input_selector)
                time.sleep(random.uniform(0.6, 1.2))
                
                page.keyboard.type(message, delay=random.randint(80, 150))
                time.sleep(random.uniform(1.5, 3.0))

                # 发送
                send_button_selectors = [
                     "button[aria-label='发送消息']", 
                     "button[aria-label='Send message']", 
                     "button:has-text('发送')",
                     ".send-button"
                ]
                sent_via_button = False
                for btn_sel in send_button_selectors:
                    try:
                        if page.is_visible(btn_sel):
                            page.click(btn_sel)
                            print(f"[INFO] 已点击发送按钮 ({btn_sel})。")
                            sent_via_button = True
                            break
                    except Exception:
                        pass
                        
                if not sent_via_button:
                    page.keyboard.press("Enter")
                    print("[INFO] 未找到可用发送按钮，已按 Enter 键发送。")

            except Exception as e:
                print(f"[ERROR] 无法找到输入框或输入失败: {e}")
                continue

            # 等待当前轮次回复完成
            print("[INFO] 正在等待 Gemini 回复完成...")
            last_reply_text = ""
            reply_stable = 0
            for wait_i in range(120):
                time.sleep(1.5)
                try:
                    reply_text = page.evaluate("""() => {
                        const blocks = document.querySelectorAll('message-content, .model-response-text, .response-container');
                        if (blocks.length === 0) return '';
                        const last = blocks[blocks.length - 1];
                        return (last.innerText || '').trim();
                    }""")
                except Exception:
                    reply_text = ""

                if reply_text and reply_text == last_reply_text:
                    reply_stable += 1
                    if reply_stable >= 6:
                        print(f"[INFO] ✅ 回复已稳定")
                        break
                else:
                    reply_stable = 0
                    last_reply_text = reply_text

            if idx_m < len(messages) - 1:
                time.sleep(5)

        # ── 3. 提取 Canvas 内容 (所有轮次结束后) ──
        print("[INFO] 所有轮次发送完毕，正在准备提取 Canvas 面板内容...")
        try:
            print("[INFO] 额外等待 15 秒让 Canvas 面板展开...")
            time.sleep(15)

            # 智能切换到 'Code' 视图
            print("[INFO] 正在尝试切换到 'Code' (代码) 视图以提取源文件...")
            try:
                code_button_selectors = [
                    "button:has-text('Code')",
                    "button.code-immersive-tab-button",
                    "button[aria-label*='Code']",
                ]
                clicked_code = False
                for c_btn_sel in code_button_selectors:
                    try:
                        loc = page.locator(c_btn_sel).filter(has_text="Code").last
                        if loc.is_visible():
                            cls_name = loc.evaluate("el => el.className")
                            if "active" not in cls_name.lower(): 
                                loc.click()
                                print(f"[INFO] 🎯 成功点击 'Code' 面板切换按钮 ({c_btn_sel})")
                                clicked_code = True
                                time.sleep(4)
                                break
                            else:
                                print("[INFO] ✅ 'Code' 面板已经处于激活状态。")
                                clicked_code = True
                                break
                    except Exception:
                        pass
                if not clicked_code:
                    print("[WARN] 未能在侧栏找到 'Code' 按钮，可能是纯文本 Canvas，将直接执行提取。")
            except Exception as code_btn_err:
                print(f"[WARN] 切换 Code 视图时跳过: {code_btn_err}")

            def extract_canvas_text(pg):
                # Monaco 内存读取
                try:
                    js_monaco = """() => {
                        try {
                            if (window.monaco && window.monaco.editor) {
                                const models = window.monaco.editor.getModels();
                                if (models.length > 0) return models[0].getValue();
                            }
                            const cm6 = document.querySelector('.cm-content');
                            if (cm6 && cm6.cmView && cm6.cmView.view) {
                                return cm6.cmView.view.state.doc.toString();
                            }
                        } catch(e) {}
                        return '';
                    }"""
                    code_text = pg.evaluate(js_monaco)
                    if code_text and len(code_text.strip()) > 30:
                        return code_text.strip(), "js-monaco-memory-pull"
                except Exception:
                    pass

                # Share 复制法
                try:
                    pg.context.grant_permissions(['clipboard-read', 'clipboard-write'])
                    pg.evaluate("() => navigator.clipboard.writeText('')")
                    share_btn = pg.query_selector("canvas-actions button.share-button, immersive-panel button.share-button")
                    if share_btn and share_btn.is_visible():
                        share_btn.click()
                        time.sleep(2.0)
                        clicked_copy = pg.evaluate("""() => {
                            let copyBtn = document.querySelector('.cdk-overlay-container .copy-button') || document.querySelector('.copy-button');
                            if (copyBtn) { copyBtn.click(); return true; }
                            return false;
                        }""")
                        if clicked_copy:
                            time.sleep(2.0)
                            clip_text = pg.evaluate("async () => await navigator.clipboard.readText()")
                            if clip_text and len(clip_text.strip()) > 50:
                                return clip_text.strip(), "native-share-copy-button"
                except Exception:
                    pass

                # Ctrl+A + Ctrl+C
                try:
                    editor_area = pg.query_selector('.monaco-editor, .cm-content, [contenteditable="true"]')
                    if editor_area:
                        editor_area.focus()
                        time.sleep(0.5)
                        pg.keyboard.down("Control")
                        pg.keyboard.press("KeyA")
                        pg.keyboard.up("Control")
                        time.sleep(0.3)
                        pg.keyboard.down("Control")
                        pg.keyboard.press("KeyC")
                        pg.keyboard.up("Control")
                        time.sleep(1.2)
                        clip_text = pg.evaluate("async () => await navigator.clipboard.readText()")
                        if clip_text and len(clip_text.strip()) > 50:
                            return clip_text.strip(), "shortcuts-all-select-copy"
                except Exception:
                    pass

                return "", None

            last_canvas_text = ""
            stable_count = 0
            for i in range(40):
                time.sleep(2)
                current_text, matched_sel = extract_canvas_text(page)
                if current_text and current_text.strip() == last_canvas_text.strip():
                    stable_count += 1
                    if stable_count >= 5:
                        break
                else:
                    stable_count = 0
                    if current_text:
                        last_canvas_text = current_text

            if not last_canvas_text.strip():
                print("[WARN] 未能在 Canvas 侧边栏捕获到任何有效文本。")
                last_text = None
            else:
                print(f"\n[INFO] 🎉 已成功提取 Canvas 内容 ({len(last_canvas_text)} 字)")
                
                print("[INFO] 正在反问 Gemini 关于该文件的专属名称与后缀...")
                try:
                    textarea = page.query_selector('rich-textarea div[contenteditable="true"]')
                    if textarea:
                        question = "你的文件是该保存什么格式的, 给出一个文件名称和后缀。请简短在一行仅回答文件名，文件名格式为：`xxx.ext`,只要文件名，不要输出任何其他内容。"
                        textarea.focus()
                        page.keyboard.type(question)
                        time.sleep(0.5)
                        page.keyboard.press("Enter")
                        time.sleep(5.0)
                        
                        ans_text = page.evaluate("""() => {
                            const blocks = document.querySelectorAll('message-content, .model-response-text, .response-container');
                            const last = blocks[blocks.length - 1];
                            return (last.innerText || '').trim();
                        }""")
                        
                        import re
                        match_fn = re.search(r'([a-zA-Z0-9_\-\u4e00-\u9fa5]+\.[a-zA-Z0-9]{2,4})', ans_text)
                        filename = match_fn.group(1) if match_fn else "extracted_canvas_file.txt"
                        
                        target_dir = os.path.join(os.path.expanduser("~"), ".openclaw", "media", "geminiFile")
                        os.makedirs(target_dir, exist_ok=True)
                        save_path = os.path.join(target_dir, filename)
                        
                        with open(save_path, "w", encoding="utf-8") as f:
                            f.write(last_canvas_text)
                        print(f"\n[INFO] ✅ 文件已经落地保存:\n👉 {save_path}\n")
                        last_text = [save_path]
                except Exception as save_err:
                     print(f"[ERROR] 保存本地文件故障: {save_err}")
                     last_text = None

        except Exception as e:
            print(f"[ERROR] 提取 Canvas 内容时失败: {e}")
            last_text = None

        print("\n[INFO] 自动化操作已完成。")
        print("[INFO] **浏览器窗口将在 60 秒后自动关闭并释放锁。**")
        try:
            time.sleep(60)
        except KeyboardInterrupt:
            pass
        finally:
            browser_context.close()
            print("[INFO] 浏览器已关闭。")
        
        return last_text if last_text else None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini Canvas 自动化脚本")
    parser.add_argument("--message", type=str, help="要发送给 Canvas 的主题或消息")
    parser.add_argument("--url", type=str, default="https://gemini.google.com/app", help="目标页面的 url_id / 完整 URL")
    parser.add_argument("--login", action="store_true", help="启动交互界面并等待人为登录账号")
    parser.add_argument("--headless", action="store_true", help="无头模式")

    args = parser.parse_args()

    if args.login:
        run_gemini_canvas(None, is_login_mode=True, headless=False, target_url=args.url)
    else:
        if not args.message:
            print("[ERROR] 必须提供 --message 参数。")
            sys.exit(1)
        
        try:
            message_list = json.loads(args.message)
            if not isinstance(message_list, list):
                message_list = [str(args.message)]
        except json.JSONDecodeError:
            message_list = [args.message]

        reply = run_gemini_canvas(message_list, is_login_mode=False, headless=args.headless, target_url=args.url)
        
        result = {
            "success": reply is not None,
            "messages": message_list,
            "file_paths": reply
        }
        print("\n--- JSON_OUTPUT_BEGIN ---")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("--- JSON_OUTPUT_END ---")
