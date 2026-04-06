const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const BIORXIV_API = 'https://api.biorxiv.org';

// 内存缓存
let papersCache = [];
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30分钟

// 格式化论文
function formatPaper(item) {
  let authors = item.authors || '';
  if (authors.includes(';')) {
    const parts = authors.split(';').map(a => a.trim()).slice(0, 4);
    authors = parts.join(', ');
    if (authors.split(';').length > 4) authors += ' et al.';
  }
  return {
    id: item.doi || '',
    title: item.title || '无标题',
    authors: authors,
    date: item.date || '',
    category: item.category || 'Biology',
    summary: item.abstract || '暂无摘要',
    link: item.doi ? `https://doi.org/${item.doi}` : '',
    doi: item.doi || ''
  };
}

// 获取最近N天日期范围（用 2025 年作为安全上限）
function getDateRange(days = 14) {
  const now = new Date();
  // bioRxiv API 对 2026 年超时，限制到 2025-12-31
  const maxEnd = new Date('2025-12-31');
  const end = now > maxEnd ? maxEnd : now;
  const start = new Date(end - days * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0]
  };
}

// 从 bioRxiv 获取论文
async function fetchPapers(start, end, cursor = 0, limit = 40) {
  const url = `${BIORXIV_API}/details/biorxiv/${start}/${end}/${cursor}/${limit}`;
  console.log(`[fetch] ${url}`);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30秒超时
  
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ShuaShuaWenXian/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    const data = await res.json();
    if (data && data.collection && data.collection.length > 0) {
      return data.collection.map(formatPaper);
    }
    return [];
  } catch (e) {
    clearTimeout(timeout);
    console.error(`[fetch error] ${e.message}`);
    return [];
  }
}

// 更新缓存
async function refreshCache() {
  const now = Date.now();
  if (now - cacheTime < CACHE_TTL && papersCache.length > 0) {
    return papersCache;
  }
  
  console.log('[cache] 开始刷新...');
  const { start, end } = getDateRange(7);
  
  const batch1 = await fetchPapers(start, end, 0, 50);
  const batch2 = await fetchPapers(start, end, 50, 50);
  
  let all = [...batch1, ...batch2];
  
  // 去重
  const seen = new Set();
  all = all.filter(p => {
    if (seen.has(p.doi)) return false;
    seen.add(p.doi);
    return true;
  });
  
  // 按日期降序
  all.sort((a, b) => b.date.localeCompare(a.date));
  
  papersCache = all;
  cacheTime = now;
  console.log(`[cache] 刷新完成: ${all.length} 篇`);
  return all;
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cached_papers: papersCache.length
  });
});

// 获取最新论文
app.get('/api/latest', async (req, res) => {
  try {
    const cursor = parseInt(req.query.cursor) || 0;
    const perPage = parseInt(req.query.perPage) || 20;
    
    // 如果缓存为空，同步获取
    if (papersCache.length === 0) {
      await refreshCache();
    }
    
    const total = papersCache.length;
    const data = papersCache.slice(cursor, cursor + perPage);
    
    // 后台刷新（异步）
    refreshCache().catch(e => console.error('[background refresh error]', e));
    
    res.json({
      success: true,
      data: data,
      total: total,
      cursor: cursor + perPage
    });
  } catch (error) {
    console.error('[latest error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 搜索论文
app.get('/api/search', async (req, res) => {
  try {
    const query = (req.query.query || '').trim().toLowerCase();
    
    if (!query) {
      return res.json({ success: true, data: [], total: 0 });
    }
    
    // 先在缓存中搜索
    let results = papersCache.filter(p =>
      p.title.toLowerCase().includes(query) ||
      p.authors.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query) ||
      p.summary.toLowerCase().includes(query)
    );
    
    // 如果缓存结果太少，从 API 获取更多
    if (results.length < 5) {
      const { start, end } = getDateRange(30);
      const apiPapers = await fetchPapers(start, end, 0, 100);
      const newResults = apiPapers.filter(p =>
        p.title.toLowerCase().includes(query) ||
        p.authors.toLowerCase().includes(query) ||
        p.category.toLowerCase().includes(query) ||
        p.summary.toLowerCase().includes(query) &&
        !results.find(r => r.doi === p.doi)
      );
      results = [...results, ...newResults];
    }
    
    res.json({
      success: true,
      data: results.slice(0, 20),
      total: results.length
    });
  } catch (error) {
    console.error('[search error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 分类列表
app.get('/api/categories', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'biorxiv', name: 'Biology', nameCn: '生物学' },
      { id: 'medrxiv', name: 'Medicine', nameCn: '医学' }
    ]
  });
});

// 启动时预加载
async function startup() {
  console.log('[startup] 预加载论文...');
  await refreshCache();
  console.log(`[startup] 就绪，缓存 ${papersCache.length} 篇`);
}

// 启动
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║           bioRxiv API 后端服务 (Node.js)          ║
╠═══════════════════════════════════════════════════╣
║  📖 最新论文: http://localhost:${PORT}/api/latest    ║
║  🔍 搜索:    http://localhost:${PORT}/api/search     ║
║  ❤️ 健康检查: http://localhost:${PORT}/api/health   ║
║                                                   ║
║  ⚡ 启动预加载 + 后台自动更新（30分钟）            ║
╚═══════════════════════════════════════════════════╝
  `);
  
  startup().catch(e => console.error('[startup error]', e));
});
