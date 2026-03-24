"""
bioRxiv API 后端服务
刷刷文献小程序后端

启动方式：
    python server.py
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
from urllib.request import urlopen, Request
from urllib.error import URLError
import ssl
from datetime import datetime, timedelta
import re

# 配置
PORT = 3000
BIORXIV_API = 'https://api.biorxiv.org'

# CORS 头
HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'User-Agent': 'ShuaShuaWenXian/1.0',
    'Accept': 'application/json'
}


def fetch_biorxiv(url):
    """请求 bioRxiv API"""
    try:
        req = Request(url, headers={'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json'})
        ctx = ssl.create_default_context()
        with urlopen(req, context=ctx, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        print(f"请求错误: {e}")
        return None


def format_paper(item):
    """格式化论文数据"""
    authors = item.get('authors', '')
    if isinstance(authors, str) and ';' in authors:
        authors = ', '.join(authors.split(';')[:3])
    
    return {
        'id': item.get('doi', ''),
        'title': item.get('title', '无标题'),
        'authors': authors,
        'date': item.get('date', ''),
        'category': item.get('category', 'Biology'),
        'summary': item.get('abstract', '暂无摘要'),
        'link': f"https://doi.org/{item.get('doi', '')}" if item.get('doi') else '',
        'doi': item.get('doi', ''),
        'type': item.get('type', ''),
        'version': item.get('version', '')
    }


class BioRxivHandler(SimpleHTTPRequestHandler):
    
    def send_json(self, data, status=200):
        self.send_response(status)
        for key in ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers', 'Content-Type']:
            if key in HEADERS:
                self.send_header(key, HEADERS[key])
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def do_OPTIONS(self):
        self.send_response(200)
        for key in ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers']:
            if key in HEADERS:
                self.send_header(key, HEADERS[key])
        self.end_headers()
    
    def do_GET(self):
        if self.path.startswith('/api/'):
            self.handle_api()
        else:
            super().do_GET()
    
    def handle_api(self):
        path = self.path.split('?')[0]
        params = {}
        if '?' in self.path:
            query = self.path.split('?')[1]
            for param in query.split('&'):
                if '=' in param:
                    key, value = param.split('=', 1)
                    params[key] = value
        
        # 健康检查
        if path == '/api/health':
            self.send_json({'status': 'ok', 'timestamp': datetime.now().isoformat()})
            return
        
        # 获取最新论文 (按日期范围)
        if path == '/api/latest':
            server = params.get('category', 'biorxiv')
            # 默认获取最近一个月的论文
            end_date = datetime.now().strftime('%Y-%m-%d')
            start_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
            cursor = int(params.get('cursor', 0))
            per_page = int(params.get('perPage', 20))
            
            url = f'{BIORXIV_API}/details/{server}/{start_date}/{end_date}/{cursor}/{per_page}'
            print(f'请求: {url}')
            
            data = fetch_biorxiv(url)
            if data and data.get('collection'):
                papers = [format_paper(item) for item in data['collection']]
                self.send_json({
                    'success': True,
                    'data': papers,
                    'total': int(data.get('messages', [{}])[0].get('total', len(papers))) if data.get('messages') else len(papers),
                    'cursor': int(data.get('messages', [{}])[0].get('cursor', cursor + per_page)) if data.get('messages') else cursor + per_page,
                    'page': cursor
                })
            else:
                self.send_json({'success': True, 'data': [], 'total': 0, 'cursor': 0, 'page': 0})
            return
        
        # 搜索论文
        if path == '/api/search':
            query = params.get('query', '')
            server = params.get('category', 'biorxiv')
            
            if not query:
                self.send_json({'success': False, 'error': 'Query is required'}, 400)
                return
            
            # 搜索也使用日期范围 + cursor
            end_date = datetime.now().strftime('%Y-%m-%d')
            start_date = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d')
            cursor = int(params.get('cursor', 0))
            per_page = int(params.get('perPage', 20))
            
            # URL encode query
            query_encoded = query.replace(' ', '+')
            url = f'{BIORXIV_API}/search/{server}/{query_encoded}/{start_date}/{end_date}/{cursor}/{per_page}'
            print(f'搜索请求: {url}')
            
            data = fetch_biorxiv(url)
            if data and data.get('collection'):
                papers = [format_paper(item) for item in data['collection']]
                self.send_json({
                    'success': True,
                    'data': papers,
                    'total': int(data.get('messages', [{}])[0].get('total', len(papers))) if data.get('messages') else len(papers),
                    'cursor': cursor + per_page,
                    'page': cursor
                })
            else:
                self.send_json({'success': True, 'data': [], 'total': 0, 'cursor': 0, 'page': 0})
            return
        
        # 获取分类列表
        if path == '/api/categories':
            self.send_json({
                'success': True,
                'data': [
                    {'id': 'biorxiv', 'name': 'Biology', 'nameCn': '生物'},
                    {'id': 'medrxiv', 'name': 'Medicine', 'nameCn': '医学'},
                    {'id': 'chemrxiv', 'name': 'Chemistry', 'nameCn': '化学'},
                    {'id': 'psyarxiv', 'name': 'Psychology', 'nameCn': '心理'},
                    {'id': 'socarxiv', 'name': 'Social Science', 'nameCn': '社会科学'},
                    {'id': 'engrxiv', 'name': 'Engineering', 'nameCn': '工程'}
                ]
            })
            return
        
        self.send_json({'success': False, 'error': 'Unknown API'}, 404)
    
    def log_message(self, format, *args):
        print(f'[{datetime.now().strftime("%H:%M:%S")}] {args[0]}')


def main():
    server = HTTPServer(('0.0.0.0', PORT), BioRxivHandler)
    print(f'''
╔═══════════════════════════════════════════════════╗
║         bioRxiv API 后端服务                      ║
╠═══════════════════════════════════════════════════╣
║  📖 最新论文: http://localhost:{PORT}/api/latest    ║
║  🔍 搜索论文: http://localhost:{PORT}/api/search   ║
║  📋 分类列表: http://localhost:{PORT}/api/categories║
║  ❤️ 健康检查: http://localhost:{PORT}/api/health   ║
╚═══════════════════════════════════════════════════╝
    ''')
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')
        server.shutdown()


if __name__ == '__main__':
    main()
