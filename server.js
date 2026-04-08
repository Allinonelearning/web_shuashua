const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const BIORXIV_API = 'https://api.biorxiv.org';
const CACHE_FILE = path.join(__dirname, 'papers_cache.json');

// 内存缓存
let papersCache = [];
let lastUpdateTime = 0;

// 格式化日期
function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
}

// 从文件加载缓存
function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cache = JSON.parse(data);
      papersCache = cache.papers || [];
      lastUpdateTime = cache.lastUpdate || 0;
      console.log(`[cache] 从文件加载 ${papersCache.length} 篇论文`);
    }
  } catch (e) {
    console.error('[cache] 读取缓存文件失败:', e.message);
  }
}

// 保存缓存到文件
function saveCacheToFile() {
  try {
    const data = {
      papers: papersCache,
      lastUpdate: lastUpdateTime,
      updateTime: new Date().toISOString()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    console.log(`[cache] 保存到文件: ${papersCache.length} 篇论文`);
  } catch (e) {
    console.error('[cache] 保存缓存文件失败:', e.message);
  }
}

// 从 bioRxiv 获取最新论文
async function fetchLatestPapers() {
  console.log('[fetch] 开始获取最新论文...');
  
  try {
    const url = `${BIORXIV_API}/details/biorxiv/300`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ShuaShuaWenXian/1.0'
      },
      timeout: 30000
    });
    
    const data = await response.json();
    
    if (data.collection && data.collection.length > 0) {
      papersCache = data.collection.map(item => ({
        id: item.doi || item.url,
        title: item.title || '无标题',
        authors: (item.authors || '').split(';').slice(0, 3).join(', '),
        date: formatDate(item.date),
        category: item.category || 'Biology',
        summary: item.abstract || '暂无摘要',
        link: `https://doi.org/${item.doi}`,
        doi: item.doi,
        license: item.license || ''
      }));
      
      lastUpdateTime = Date.now();
      saveCacheToFile();
      console.log(`[fetch] 获取成功: ${papersCache.length} 篇论文`);
      return true;
    }
  } catch (e) {
    console.error('[fetch] 获取失败:', e.message);
  }
  return false;
}

// 定时任务：每天 8:00, 12:00, 20:00 更新
function scheduleUpdates() {
  const updateTimes = [8, 12, 20]; // 早中晚
  
  function checkAndUpdate() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    // 整点时检查是否需要更新
    if (minute === 0 && updateTimes.includes(hour)) {
      console.log(`[schedule] 定时更新触发: ${hour}:00`);
      fetchLatestPapers();
    }
  }
  
  // 每分钟检查一次
  setInterval(checkAndUpdate, 60000);
  
  // 启动时如果缓存超过4小时，也更新一次
  if (Date.now() - lastUpdateTime > 4 * 60 * 60 * 1000) {
    console.log('[schedule] 缓存过期，启动更新');
    fetchLatestPapers();
  }
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cached_papers: papersCache.length,
    last_update: lastUpdateTime ? new Date(lastUpdateTime).toISOString() : 'never'
  });
});

// 获取最新论文
app.get('/api/latest', async (req, res) => {
  try {
    const { cursor = 0, perPage = 50 } = req.query;
    const c = parseInt(cursor) || 0;
    const p = parseInt(perPage) || 50;
    
    // 如果缓存为空或超过4小时未更新，同步获取
    if (papersCache.length === 0 || Date.now() - lastUpdateTime > 4 * 60 * 60 * 1000) {
      await fetchLatestPapers();
    }
    
    const data = papersCache.slice(c, c + p);
    
    res.json({
      success: true,
      data: data,
      total: papersCache.length,
      cursor: c + p
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
    
    const results = papersCache.filter(p =>
      p.title.toLowerCase().includes(query) ||
      p.authors.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query) ||
      p.summary.toLowerCase().includes(query)
    );
    
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

// 手动刷新缓存
app.get('/api/refresh', async (req, res) => {
  const ok = await fetchLatestPapers();
  res.json({ 
    success: ok, 
    message: ok ? '刷新成功' : '刷新失败',
    count: papersCache.length
  });
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

// 启动
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║        bioRxiv API 后端服务 (定时更新版)          ║
╠═══════════════════════════════════════════════════╣
║  📖 最新论文: http://localhost:${PORT}/api/latest    ║
║  🔍 搜索:    http://localhost:${PORT}/api/search     ║
║  🔄 手动刷新: http://localhost:${PORT}/api/refresh   ║
║  ❤️ 健康检查: http://localhost:${PORT}/api/health   ║
║                                                   ║
║  ⏰ 定时更新: 每天 8:00, 12:00, 20:00             ║
║  💾 缓存文件: papers_cache.json                   ║
╚═══════════════════════════════════════════════════╝
  `);
  
  // 启动时加载缓存
  loadCacheFromFile();
  
  // 启动定时任务
  scheduleUpdates();
  
  // 如果缓存为空，立即获取一次
  if (papersCache.length === 0) {
    console.log('[startup] 缓存为空，立即获取数据...');
    await fetchLatestPapers();
  }
});
