#!/usr/bin/env python3
"""
Rin Content Uploader
用于上传内容和图片到 Rin 项目的 Python 脚本
适用于 OpenClaw 等 agent
"""

import requests
import json
from typing import Optional, List, Dict, Any
import mimetypes
import os


class RinClient:
    def __init__(self, base_url: str, username: Optional[str] = None, password: Optional[str] = None, token: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        
        if token:
            self.session.headers['Authorization'] = f'Bearer {token}'
        elif username and password:
            self._login(username, password)
    
    def _login(self, username: str, password: str):
        """登录获取 token"""
        response = self.session.post(
            f'{self.base_url}/api/auth/login',
            json={'username': username, 'password': password}
        )
        print(f"登录响应状态码: {response.status_code}")
        print(f"登录响应内容: {response.text}")
        
        response.raise_for_status()
        data = response.json()
        if data.get('success') and data.get('token'):
            self.session.headers['Authorization'] = f"Bearer {data['token']}"
            print(f"登录成功！用户: {data['user']['username']}")
        else:
            raise Exception("登录失败")
    
    def upload_image(self, image_path: str) -> str:
        """上传图片，返回图片 URL"""
        filename = os.path.basename(image_path)
        mime_type, _ = mimetypes.guess_type(image_path)
        
        with open(image_path, 'rb') as f:
            files = {
                'file': (filename, f, mime_type),
                'key': (None, filename)
            }
            response = self.session.post(
                f'{self.base_url}/api/storage',
                files=files
            )
        
        print(f"上传图片响应状态码: {response.status_code}")
        print(f"响应内容: {response.text}")
        
        response.raise_for_status()
        return response.json()['url']
    
    def create_feed(
        self,
        title: str,
        content: str,
        summary: Optional[str] = None,
        tags: Optional[List[str]] = None,
        draft: bool = False,
        listed: bool = True,
        alias: Optional[str] = None,
        created_at: Optional[str] = None
    ) -> Dict[str, Any]:
        """创建内容（Feed）"""
        data = {
            'title': title,
            'content': content,
            'summary': summary or '',
            'tags': tags or [],
            'draft': draft,
            'listed': listed
        }
        
        if alias:
            data['alias'] = alias
        if created_at:
            data['createdAt'] = created_at
        
        response = self.session.post(
            f'{self.base_url}/api/feed',
            json=data
        )
        
        response.raise_for_status()
        return response.json()
    
    def update_feed(
        self,
        feed_id: int,
        title: Optional[str] = None,
        content: Optional[str] = None,
        summary: Optional[str] = None,
        tags: Optional[List[str]] = None,
        draft: Optional[bool] = None,
        listed: Optional[bool] = None,
        alias: Optional[str] = None,
        top: Optional[int] = None,
        created_at: Optional[str] = None
    ) -> bool:
        """更新内容"""
        data: Dict[str, Any] = {}
        
        if title is not None:
            data['title'] = title
        if content is not None:
            data['content'] = content
        if summary is not None:
            data['summary'] = summary
        if tags is not None:
            data['tags'] = tags
        if draft is not None:
            data['draft'] = draft
        if listed is not None:
            data['listed'] = listed
        if alias is not None:
            data['alias'] = alias
        if top is not None:
            data['top'] = top
        if created_at is not None:
            data['createdAt'] = created_at
        
        response = self.session.post(
            f'{self.base_url}/api/feed/{feed_id}',
            json=data
        )
        
        response.raise_for_status()
        return True
    
    def get_feed(self, feed_id: int) -> Dict[str, Any]:
        """获取单个内容"""
        response = self.session.get(f'{self.base_url}/api/feed/{feed_id}')
        response.raise_for_status()
        return response.json()
    
    def delete_feed(self, feed_id: int) -> bool:
        """删除内容"""
        response = self.session.delete(f'{self.base_url}/api/feed/{feed_id}')
        response.raise_for_status()
        return True
    
    def list_feeds(self, page: int = 1, limit: int = 20, feed_type: Optional[str] = None) -> Dict[str, Any]:
        """列出内容"""
        params = {'page': page, 'limit': limit}
        if feed_type:
            params['type'] = feed_type
        
        response = self.session.get(f'{self.base_url}/api/feed', params=params)
        response.raise_for_status()
        return response.json()


def main():
    """示例用法"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Rin 内容上传工具')
    parser.add_argument('--url', required=True, help='Rin 站点 URL')
    parser.add_argument('--username', help='用户名')
    parser.add_argument('--password', help='密码')
    parser.add_argument('--token', help='认证 Token')
    
    subparsers = parser.add_subparsers(title='命令', dest='command')
    
    # 上传图片命令
    upload_parser = subparsers.add_parser('upload-image', help='上传图片')
    upload_parser.add_argument('image', help='图片文件路径')
    
    # 创建内容命令
    create_parser = subparsers.add_parser('create', help='创建内容')
    create_parser.add_argument('--title', required=True, help='标题')
    create_parser.add_argument('--content', required=True, help='内容 (Markdown格式')
    create_parser.add_argument('--summary', help='摘要')
    create_parser.add_argument('--tags', nargs='+', help='标签')
    create_parser.add_argument('--draft', action='store_true', help='设为草稿')
    create_parser.add_argument('--image', help='先上传图片并插入到内容开头')
    
    args = parser.parse_args()
    
    # 初始化客户端
    client = RinClient(args.url, args.username, args.password, args.token)
    
    if args.command == 'upload-image':
        url = client.upload_image(args.image)
        print(f"图片上传成功: {url}")
    elif args.command == 'create':
        content = args.content
        if args.image:
            img_url = client.upload_image(args.image)
            content = f"![图片]({img_url})\n\n{content}"
        
        result = client.create_feed(
            title=args.title,
            content=content,
            summary=args.summary,
            tags=args.tags or [],
            draft=args.draft
        )
        print(f"内容创建成功: ID={result['insertedId']}")


if __name__ == '__main__':
    main()
