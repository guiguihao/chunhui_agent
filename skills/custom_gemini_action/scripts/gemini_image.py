import argparse
import time
import os
import sys
import random
import json
import base64
from playwright.sync_api import sync_playwright

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False


def compress_image(filepath, quality=85, max_width=2048):
    """
    压缩图片：将 PNG 转为 JPEG，限制最大宽度，并按指定质量保存。
    原文件将被替换为压缩后的 JPEG 文件。

    Args:
        filepath: 原图片路径（PNG 或其他格式）
        quality:  JPEG 压缩质量 (1-95)，默认 85
        max_width: 图片最大宽度（像素），超出则等比缩放，默认 2048

    Returns:
        str: 压缩后的文件路径
    """
    if not PIL_AVAILABLE:
        print("[WARN] Pillow 未安装，跳过压缩。可运行 pip install Pillow 安装。")
        return filepath

    try:
        original_size = os.path.getsize(filepath)
        with Image.open(filepath) as img:
            # 转换为 RGB（PNG 可能含 Alpha 通道，JPEG 不支持）
            if img.mode in ("RGBA", "P", "LA"):
                background = Image.new("RGB", img.size, (255, 255, 255))
                if img.mode == "P":
                    img = img.convert("RGBA")
                background.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")

            # 等比缩放（仅缩小，不放大）
            w, h = img.size
            if w > max_width:
                scale = max_width / w
                new_size = (max_width, int(h * scale))
                img = img.resize(new_size, Image.LANCZOS)
                print(f"[INFO] 图片已缩放: {w}x{h} → {new_size[0]}x{new_size[1]}")

            # 保存为 JPEG（替换原文件路径，扩展名改为 .jpg）
            jpg_path = os.path.splitext(filepath)[0] + ".jpg"
            img.save(jpg_path, "JPEG", quality=quality, optimize=True)

        compressed_size = os.path.getsize(jpg_path)
        ratio = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0
        print(f"[INFO] ✅ 图片压缩完成: {os.path.basename(jpg_path)} "
              f"({original_size // 1024}KB → {compressed_size // 1024}KB, 压缩率 {ratio:.1f}%)")

        # 如果原文件与 jpg 路径不同，删除原 PNG
        if jpg_path != filepath and os.path.exists(filepath):
            os.remove(filepath)

        return jpg_path

    except Exception as e:
        print(f"[WARN] 图片压缩失败 ({filepath}): {e}，保留原文件。")
        return filepath

def run_gemini_image(prompts, is_login_mode=False, headless=False, output_dir=None, target_url="https://gemini.google.com/app"):
    """
    向 Gemini 发送图片生成请求，支持多轮提示词，等待生成完毕后下载所有生成的图片。

    Args:
        prompts: 图片生成提示词（字符串或字符串列表）
        is_login_mode: 是否为登录模式
        headless: 是否无头运行
        output_dir: 图片保存目录（默认为 ~/.openclaw/media/geminiImage/ 目录）
        target_url: 目标 Gemini 页面 URL

    Returns:
        list[str]: 成功下载的图片本地路径列表，失败返回 None
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", "..", ".."))
    workspace_dir = os.path.join(project_root, "workspace")

    user_data_dir = os.path.join(workspace_dir, "browser-profile")
    os.makedirs(user_data_dir, exist_ok=True)

    # 确保 prompts 是列表
    if isinstance(prompts, str):
        prompts = [prompts]

    # 设置图片输出目录
    if not output_dir:
        output_dir = os.path.join(workspace_dir, "media", "geminiImage")
    os.makedirs(output_dir, exist_ok=True)

    with sync_playwright() as p:
        launch_headless = False if (is_login_mode or not headless) else True

        print(f"[INFO] 正在启动独立浏览器实例 (headless={launch_headless})...")
        try:
            browser_context = p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=launch_headless,
                # 允许下载 & 规避机器人检测
                accept_downloads=True,
                args=["--disable-blink-features=AutomationControlled"]
            )
        except Exception as e:
            print(f"[ERROR] 启动浏览器失败！请确保没有其他打开了同级 user_data 目录的浏览器窗口残留: {e}")
            sys.exit(1)

        page = browser_context.pages[0] if browser_context.pages else browser_context.new_page()

        # ── 登录模式 ──
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

        # ── 打开页面 ──
        print("[INFO] 浏览器已启动，等待 10 秒后跳转目标页面...")
        time.sleep(10)
        print(f"[INFO] 正在导航至: {target_url}")
        page.goto(target_url)

        # ── 1. 工具激活 (仅需执行一次) ──
        print(f"[INFO] 等待输入框加载...")
        input_selector = "rich-textarea p, div[contenteditable='true']"
        try:
            page.wait_for_selector(input_selector, timeout=20000)
            print("[INFO] 等待 15 秒以确保辅助工具菜单加载（确保能点击 Create image）...")
            time.sleep(15)

            print("[INFO] 正在尝试激活 'Create image' 图片生成工具...")
            tool_activated = False
            
            deselect_selectors = [
                "button[aria-label*='Deselect Create image']",
                "button[aria-label*='Deselect Images']",
                "button:has-text('Deselect Create image')",
                "button:has-text('Deselect Images')",
            ]
            for d_sel in deselect_selectors:
                if page.is_visible(d_sel):
                    print("[INFO] ✅ 检测到 'Create image' 工具已经处于激活状态，无需再次点击。")
                    tool_activated = True
                    break
                    
            if not tool_activated:
                chip_selector = "button[aria-label*='Create image']"
                if page.is_visible(chip_selector):
                    page.click(chip_selector)
                    print("[INFO] ✅ 已点击首页快捷芯片 'Create image'")
                    time.sleep(2)
                    tool_activated = True
                
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
                                print(f"[INFO] 已点击 Tools 按钮 ({tb_sel})")
                                time.sleep(3)
                                tools_clicked = True
                                break
                        except Exception:
                            pass
                    
                    if tools_clicked:
                        images_selectors = [
                            "button.toolbox-drawer-item-list-button:has-text('Images')",
                            "button.toolbox-drawer-item-list-button:has-text('Image')",
                            "button[role='menuitemcheckbox']:has-text('Images')",
                            "button:has-text('Create image')",
                            "button:has-text('Images')",
                        ]
                        for img_sel in images_selectors:
                            try:
                                loc = page.locator(img_sel).first
                                if loc.is_visible():
                                    loc.click()
                                    print(f"[INFO] ✅ 已在 Tools 菜单中选中 'Images' ({img_sel})")
                                    time.sleep(2)
                                    tool_activated = True
                                    break
                            except Exception:
                                pass
                    else:
                        print("[WARN] 未找到 Tools 按钮")
            
            if tool_activated:
                deselect_btn = "button[aria-label*='Deselect']"
                time.sleep(1)
                if page.is_visible(deselect_btn):
                    print("[INFO] ✅ 确认 'Create image' 工具已激活（检测到 Deselect 芯片）")
            else:
                print("[WARN] 未能激活 'Create image' 工具，将以普通文本模式提交。")

        except Exception as tool_err:
            print(f"[INFO] 尝试激活工具时跳过或超时: {tool_err}")

        all_saved_paths = []

        # ── 2. 多轮提示词发送与图片下载 ──
        for idx_p, prompt in enumerate(prompts):
            print(f"\n[INFO] === 第 {idx_p + 1} 轮生图 (共 {len(prompts)} 轮) ===")
            
            try:
                # 清理残留文本
                current_input = page.locator(input_selector).inner_text()
                if current_input.strip():
                    print("[INFO] 输入框中有残留内容，正在清空...")
                    page.click(input_selector)
                    page.keyboard.press("Control+KeyA")
                    page.keyboard.press("Backspace")
            except Exception:
                pass

            try:
                print(f"[INFO] 正在输入提示词: '{prompt}'")
                time.sleep(random.uniform(1.2, 2.8))
                page.click(input_selector)
                time.sleep(random.uniform(0.6, 1.2))
                # Use clipboard paste instead of keyboard.type to avoid crash with emoji/long text
                try:
                    page.evaluate("""async (text) => {
                        await navigator.clipboard.writeText(text);
                    }""", prompt)
                    page.keyboard.press("Meta+v")
                except Exception:
                    page.keyboard.type(prompt, delay=random.randint(80, 150))
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
                print(f"[ERROR] 输入失败: {e}")
                continue

            print("[INFO] 消息已发送，正在等待 Gemini 生成图片...")
            last_img_count = 0
            stable_count = 0
            container_selectors = [".model-response-text", "message-content"]

            all_images = []
            for attempt in range(120):  # 最多等 3 分钟
                time.sleep(1.5)
                all_images = []
                last_container = None
                for c_sel in container_selectors:
                    elements = page.query_selector_all(c_sel)
                    if elements:
                        last_container = elements[-1]
                        break

                if last_container:
                    try:
                        elements = last_container.query_selector_all("img")
                        for el in elements:
                            src = el.get_attribute("src")
                            if src:
                                is_valid = src.startswith("blob:") or "googleusercontent.com" in src or src.startswith("data:image")
                                if is_valid:
                                    all_images.append({"src": src, "element": el})
                    except Exception:
                        pass

                current_count = len(all_images)
                if current_count > 0 and current_count == last_img_count:
                    stable_count += 1
                    if stable_count >= 10:
                        break
                else:
                    if current_count > last_img_count:
                        print(f"[INFO] 已检测到 {current_count} 张图片，继续等待...")
                    stable_count = 0
                    last_img_count = current_count

            if last_img_count == 0:
                print("[WARN] 未检测到任何生成的图片。")
                continue

            print("\n[INFO] 🎉 图片已生成完毕！等待 120 秒缓冲确保加载...")
            time.sleep(120)

            # 下载
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            print(f"[INFO] 开始下载 {last_img_count} 张图片...")
            
            last_container = None
            for c_sel in container_selectors:
                elements = page.query_selector_all(c_sel)
                if elements:
                    last_container = elements[-1]
                    break

            if last_container:
                try:
                    elements = last_container.query_selector_all("img")
                    final_images = []
                    for el in elements:
                        src = el.get_attribute("src")
                        if src and (src.startswith("blob:") or "googleusercontent.com" in src or src.startswith("data:image")):
                            final_images.append({"src": src, "element": el})
                    
                    for idx_i, img_info in enumerate(final_images):
                        src = img_info["src"]
                        el = img_info["element"]
                        filename = f"gemini_{timestamp}_p{idx_p+1}_{idx_i+1}.png"
                        filepath = os.path.join(output_dir, filename)

                        try:
                            # 悬停点击下载
                            el.scroll_into_view_if_needed()
                            el.hover()
                            time.sleep(1.5)
                            
                            download_selectors = ["button[aria-label*='下载']", "button[aria-label*='Download']"]
                            clicked_and_saved = False
                            for btn_sel in download_selectors:
                                try:
                                    btn_loc = page.locator(btn_sel).filter(has=page.locator(":visible")).last
                                    if btn_loc.is_visible():
                                        with page.expect_download(timeout=180000) as download_info:
                                            btn_loc.click()
                                        download = download_info.value
                                        download.save_as(filepath)
                                        filepath = compress_image(filepath)
                                        print(f"[INFO] ✅ 下载成功 (通过按钮): {filepath}")
                                        all_saved_paths.append(filepath)
                                        clicked_and_saved = True
                                        break
                                except Exception:
                                    pass
                            
                            if clicked_and_saved:
                                continue

                            # 降级 Fetch
                            if src.startswith("data:image"):
                                import base64
                                _, b64data = src.split(",", 1)
                                with open(filepath, "wb") as f:
                                    f.write(base64.b64decode(b64data))
                                filepath = compress_image(filepath)
                                print(f"[INFO] ✅ 已保存 (base64): {filepath}")
                                all_saved_paths.append(filepath)
                            elif src.startswith("blob:") or src.startswith("http"):
                                b64data = page.evaluate("""async (src) => {
                                    try {
                                        const resp = await fetch(src);
                                        const blob = await resp.blob();
                                        return new Promise((resolve) => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => resolve(reader.result);
                                            reader.readAsDataURL(blob);
                                        });
                                    } catch { return null; }
                                }""", src)
                                if b64data and "," in b64data:
                                    import base64
                                    _, raw = b64data.split(",", 1)
                                    with open(filepath, "wb") as f:
                                        f.write(base64.b64decode(raw))
                                    filepath = compress_image(filepath)
                                    print(f"[INFO] ✅ 已保存 (fetch): {filepath}")
                                    all_saved_paths.append(filepath)

                        except Exception as e:
                            print(f"[ERROR] 下载第 {idx_i + 1} 张图片出错: {e}")

                except Exception as e:
                    print(f"[ERROR] 收集图片列表失败: {e}")

            if idx_p < len(prompts) - 1:
                time.sleep(5)

        # ── 3. 收尾 ──
        if all_saved_paths:
            print(f"\n[INFO] 🎉 共成功保存 {len(all_saved_paths)} 张图片至: {output_dir}")
        else:
            print("\n[WARN] 本次未成功保存任何图片。")

        print("\n[INFO] 自动化操作已完成。")
        print("[INFO] **浏览器窗口将在 60 秒后自动关闭并释放锁。**")
        try:
            time.sleep(60)
        except KeyboardInterrupt:
            pass
        finally:
            browser_context.close()
            print("[INFO] 浏览器已关闭。")

        return all_saved_paths if all_saved_paths else None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 图片生成自动化脚本")
    parser.add_argument("--prompt", type=str, help="图片生成提示词")
    parser.add_argument("--output", type=str, default=None, help="图片保存目录（默认 ~/.openclaw/media/geminiImage/）")
    parser.add_argument("--url", type=str, default="https://gemini.google.com/app", help="目标页面的 url_id / 完整 URL")
    parser.add_argument("--login", action="store_true", help="启动交互界面并等待人为登录账号")
    parser.add_argument("--headless", action="store_true", help="后台静默执行（不弹出浏览器窗口）")

    args = parser.parse_args()

    if args.login:
        run_gemini_image(None, is_login_mode=True, headless=False, target_url=args.url)
    else:
        if not args.prompt:
            print("[ERROR] 必须提供 --prompt 参数来指定图片生成提示词，或者使用 --login 初始化。")
            parser.print_help()
            sys.exit(1)

        # 尝试解析为 JSON 数组
        try:
            prompt_list = json.loads(args.prompt)
            if not isinstance(prompt_list, list):
                prompt_list = [str(args.prompt)]
        except json.JSONDecodeError:
            prompt_list = [args.prompt]

        paths = run_gemini_image(prompt_list, is_login_mode=False, headless=args.headless, output_dir=args.output, target_url=args.url)

        # 输出结构化 JSON 结果到 stdout，供外部程序解析
        result = {
            "success": paths is not None,
            "prompts": prompt_list,
            "image_count": len(paths) if paths else 0,
            "image_paths": paths if paths else []
        }
        print("\n--- JSON_OUTPUT_BEGIN ---")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("--- JSON_OUTPUT_END ---")
