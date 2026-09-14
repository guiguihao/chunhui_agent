import argparse
import time
import os
import sys
import random
import json
from playwright.sync_api import sync_playwright

def run_gemini_chat(messages, is_login_mode=False, headless=False, target_url="https://gemini.google.com/app"):
    # 统一使用 ~/.openclaw/browser/openclaw 存放持久化登录态 
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
            print(f"[ERROR] 启动浏览器失败！如果是第二次运行卡住，请确保没有其他打开了同级 user_data 目录的浏览器窗口残留: {e}")
            sys.exit(1)

        page = browser_context.pages[0] if browser_context.pages else browser_context.new_page()

        if is_login_mode:
            print(f"[INFO] 正在以【登录模式】打开目标页面 : {target_url}")
            print("[INFO] 请在弹出的浏览器窗口中手动登录您的 Google 账号。")
            print("[INFO] 确认登录完成后，直接手动关闭该浏览器窗口即可保存状态。")
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
        
        responses = []
        for idx, message in enumerate(messages):
            print(f"\n[INFO] === 第 {idx + 1} 轮对话 (共 {len(messages)} 轮) ===")
            
            # 1. 找到输入框并输入消息
            print(f"[INFO] 等待输入框加载...")
            try:
                input_selector = "rich-textarea p, div[contenteditable='true']"
                page.wait_for_selector(input_selector, timeout=20000)
                
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

                # 模仿人类慢动作思考或查看
                print(f"[INFO] 正在输入消息: '{message}'")
                time.sleep(random.uniform(1.2, 2.8)) 
                page.click(input_selector)
                
                # 模仿鼠标精准落位时间
                time.sleep(random.uniform(0.6, 1.2))
                
                # 使用更慢、更随机的键盘敲击延迟频率 (80ms - 150ms 之间)
                page.keyboard.type(message, delay=random.randint(80, 150))
                
                # 打完字后缓冲一下，再按回车
                time.sleep(random.uniform(1.5, 3.0))
                # 尝试点击发送按钮，如果找不到或失败，则按 Enter
                send_button_selectors = [
                     "button[aria-label='发送消息']", 
                     "button[aria-label='Send message']", 
                     "button:has-text('发送')",
                     ".send-button",
                     "button.send-button"
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
                browser_context.close()
                return None

            # 2. 等待 Gemini 的回复生成完毕
            print("[INFO] 正在等待回复生成...")
            last_text = ""
            try:
                time.sleep(3)
                response_selectors = [
                    "message-content.model-response-text .markdown",
                    ".message-content.model-response-text .markdown",
                    ".model-response-text .markdown",
                    "message-content .markdown",
                    ".markdown"
                ]
                print("[INFO] 等待网络请求平息并轮询提取回答文字 (预估需要 10-30 秒)...")
                
                stable_count = 0
                
                for _ in range(60):  # 轮询 60 次 (约 60 秒超时)
                    time.sleep(1.5)
                    current_text = ""
                    
                    for sel in response_selectors:
                        elements = page.query_selector_all(sel)
                        if elements:
                            current_text = elements[-1].inner_text()
                            if current_text.strip():
                                break
                                
                    if current_text and current_text == last_text:
                        stable_count += 1
                        if stable_count >= 8:  # 连续多次无变化认为生成完毕
                            break
                    else:
                        stable_count = 0
                        if current_text:
                            last_text = current_text
                            
                if not last_text:
                     print("[WARN] 抓取到的回复为空。当前页面上的所有可能回答区块都没有提取到文本。")
                else:
                     print("\n[INFO] 已获取第 {idx+1} 轮回复:\n")
                     print("========================================")
                     print(last_text)
                     print("========================================")
                
                responses.append(last_text)

            except Exception as e:
                 print(f"[ERROR] 等待提取回复时失败: {e}")
                 responses.append(None)
            
            # 轮次间稍微喘息一下
            if idx < len(messages) - 1:
                time.sleep(random.uniform(2.0, 5.0))

        # 3. 完成任务。静候 60 秒供用户阅读，然后自动退出
        print("\n[INFO] 所有轮次自动化操作已完成。")
        print("[INFO] **浏览器窗口将在 60 秒后自动关闭并释放锁。**")
        try:
            time.sleep(60)
        except KeyboardInterrupt:
            print("\n[INFO] 用户中断，正在关闭浏览器...")
        finally:
            browser_context.close()
            print("[INFO] 浏览器已关闭。")
        
        return responses if responses else None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 浏览器自动化脚本")
    parser.add_argument("--message", type=str, help="要发送给 Gemini 的消息内容")
    parser.add_argument("--url", type=str, default="https://gemini.google.com/app", help="目标页面的 url_id / 完整 URL")
    parser.add_argument("--login", action="store_true", help="启动交互界面并等待人为登录账号")
    parser.add_argument("--headless", action="store_true", help="配置自动化运行时是否在后台静默执行")

    args = parser.parse_args()

    if args.login:
        run_gemini_chat(None, is_login_mode=True, headless=False, target_url=args.url)
    else:
        if not args.message:
            print("[ERROR] 必须提供 --message 参数来指定要发送的内容，或者使用 --login 初始化。")
            parser.print_help()
            sys.exit(1)
            
        # 尝试解析为 JSON 数组
        try:
            message_list = json.loads(args.message)
            if not isinstance(message_list, list):
                message_list = [str(args.message)]
        except json.JSONDecodeError:
            message_list = [args.message]

        # 默认不加 --headless 时即有界面模式，满足始终打开需求
        reply = run_gemini_chat(message_list, is_login_mode=False, headless=args.headless, target_url=args.url)
        
        # 输出结构化 JSON 结果到 stdout，供外部程序解析
        result = {
            "success": reply is not None,
            "messages": message_list,
            "reply": reply
        }
        print("\n--- JSON_OUTPUT_BEGIN ---")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("--- JSON_OUTPUT_END ---")
