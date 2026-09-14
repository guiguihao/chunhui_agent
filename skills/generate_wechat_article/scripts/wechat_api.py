import requests
import json
import os

class WeChatAPI:
    def __init__(self, app_id: str, app_secret: str, access_token: str = None):
        """
        初始化微信公众号 API 客户端
        :param app_id: 公众号的 appid
        :param app_secret: 公众号的 secret
        :param access_token: 如果已有可用的 access_token 可直接传入，否则会自动获取
        """
        self.app_id = app_id
        self.app_secret = app_secret
        self.access_token = access_token or self.get_access_token()

    def get_access_token(self) -> str:
        """
        获取公众号的 access_token
        注意：实际生产环境中，access_token 必须进行全局缓存（如存在 Redis 中），有效期通常为 7200 秒，不可每次调用都强制刷新。
        """
        url = f"https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={self.app_id}&secret={self.app_secret}"
        response = requests.get(url)
        data = response.json()
        if "access_token" in data:
            return data["access_token"]
        else:
            raise Exception(f"获取 access_token 失败: {data}")

    def add_material(self, file_path: str, media_type: str = "image") -> dict:
        """
        新增永久素材 (支持图片、语音、视频、缩略图)
        注意：新增永久图文素材的接口现已被微信官方废弃，取而代之的是【草稿箱】功能。此接口主要用于上传图片、视频等供草稿箱引用。
        :param file_path: 本地文件路径
        :param media_type: 媒体文件类型，分别有图片（image）、语音（voice）、视频（video）和缩略图（thumb）
        :return: 微信 API 的返回结果，包含 media_id 等信息
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"文件不存在: {file_path}")

        url = f"https://api.weixin.qq.com/cgi-bin/material/add_material?access_token={self.access_token}&type={media_type}"
        
        with open(file_path, "rb") as f:
            files = {
                "media": f
            }
            # 对于视频类型(video)，还需要同时传递一个包含 title 和 introduction 的 description 参数
            if media_type == "video":
                description = {
                    "title": "视频标题",
                    "introduction": "视频描述"
                }
                # 注意：微信要求传入的 description 值是一个 JSON 字符串，而不是一个文件
                files["description"] = (None, json.dumps(description, ensure_ascii=False))

            response = requests.post(url, files=files)
            
        return response.json()

    def add_draft(self, articles: list) -> dict:
        """
        新增草稿箱文章
        :param articles: 文章列表
        :return: 微信 API 的返回结果
        """
        url = f"https://api.weixin.qq.com/cgi-bin/draft/add?access_token={self.access_token}"
        payload = {"articles": articles}
        headers = {'Content-Type': 'application/json; charset=utf-8'}
        response = requests.post(
            url, 
            data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers=headers
        )
        return response.json()

    def upload_full_article(self, title: str, author: str, digest: str, content_html: str, cover_path: str, image_mapping: dict = None) -> dict:
        """
        一键上传完整文章（自动处理封面、插图上传与 URL 替换）
        :param title: 文章标题
        :param author: 作者
        :param digest: 摘要
        :param content_html: HTML 正文
        :param cover_path: 封面本地路径
        :param image_mapping: 插图映射 { "占位符": "本地路径" }
        :return: 微信 API 返回结果
        """
        # 1. 上传封面
        print(f"正在上传封面: {cover_path}")
        res_cover = self.add_material(cover_path, "image")
        thumb_media_id = res_cover.get("media_id")
        if not thumb_media_id:
            raise Exception(f"封面上传失败: {res_cover}")

        # 2. 上传插图并替换 URL
        final_content = content_html
        if image_mapping:
            for placeholder, local_path in image_mapping.items():
                print(f"正在上传插图: {local_path}")
                res_img = self.add_material(local_path, "image")
                img_url = res_img.get("url")
                if img_url:
                    final_content = final_content.replace(placeholder, img_url)
                else:
                    print(f"警告：图片 {local_path} 上传失败，跳过替换。")

        # 3. 提交草稿
        articles = [
            {
                "title": title,
                "author": author,
                "digest": digest,
                "content": final_content,
                "thumb_media_id": thumb_media_id,
                "need_open_comment": 1
            }
        ]
        print(f"正在提交草稿: {title}")
        return self.add_draft(articles)


if __name__ == "__main__":
    import argparse
    from dotenv import load_dotenv
    
    # 显式定位项目根目录的 .env（scripts/ -> generate_wechat_article/ -> skills/ -> project root）
    _script_dir = os.path.dirname(os.path.abspath(__file__))
    _project_root = os.path.abspath(os.path.join(_script_dir, "..", "..", ".."))
    load_dotenv(os.path.join(_project_root, ".env"))
    
    parser = argparse.ArgumentParser(description="微信公众号文章上传工具")
    parser.add_argument("--dir", help="文章目录路径 (应包含 article_meta.json, article.html, cover.png)")
    
    args = parser.parse_args()
    
    APP_ID = os.getenv("WECHAT_APP_ID")
    APP_SECRET = os.getenv("WECHAT_APP_SECRET")
    
    if not APP_ID or not APP_SECRET:
        print("错误：请确保环境变量中已配置 WECHAT_APP_ID 和 WECHAT_APP_SECRET")
        exit(1)

    try:
        wechat = WeChatAPI(APP_ID, APP_SECRET)
        
        if args.dir:
            # 自动化模式：读取目录下的约定文件
            meta_path = os.path.join(args.dir, "article_meta.json")
            html_path = os.path.join(args.dir, "article.html")
            cover_path = os.path.join(args.dir, "cover.png")
            
            if not all(os.path.exists(p) for p in [meta_path, html_path, cover_path]):
                print(f"错误：目录 {args.dir} 中缺少必要文件 (meta.json/html/cover.png)")
                exit(1)
                
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            with open(html_path, "r", encoding="utf-8") as f:
                content_html = f.read()
            
            # 这里的 image_mapping 也可以从 meta 中读取
            image_mapping = meta.get("image_mapping", {})
            # 如果提供了相对路径，转为绝对路径
            for k, v in image_mapping.items():
                if not os.path.isabs(v):
                    image_mapping[k] = os.path.join(args.dir, v)
            
            result = wechat.upload_full_article(
                title=meta["title"],
                author=meta.get("author", "AI Assistant"),
                digest=meta.get("digest", ""),
                content_html=content_html,
                cover_path=cover_path,
                image_mapping=image_mapping
            )
            print("上传成功:", json.dumps(result, ensure_ascii=False))
        else:
            print("未提供参数。请使用 --dir [文章目录] 进行上传。")
            
    except Exception as e:
        print(f"操作失败: {e}")
