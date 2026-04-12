const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── AI 摘要配置 ───
const AI_API_KEY = process.env.AI_API_KEY || 'sk-vEvVBRVOEfZdtoipoKZnVxEQQOZdPmOYUDFqwx0IWIOnir2x';
const AI_BASE_URL = 'https://api.chatanywhere.org/v1';
const AI_MODEL = 'gpt-5.1-ca';
const AI_TIMEOUT_MS = 45000;

function aiPost(endpoint, body) {
  return fetch(AI_BASE_URL + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + AI_API_KEY
    },
    body: JSON.stringify(body),
    timeout: AI_TIMEOUT_MS
  });
}

// ─── CORS ───
const ALLOWED_ORIGINS = [
  'https://servicewechat.com',
  'https://mp.weixin.qq.com',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const BIORXIV_API = 'https://api.biorxiv.org';
const CACHE_FILE = path.join(__dirname, 'papers_cache.json');

// 内存缓存
let papersCache = [];
let lastUpdateTime = 0;
let lastAISummaryTime = 0;

// 格式化日期
function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
}

// 获取日期范围字符串
function getDateRange(days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return `${start.toISOString().split('T')[0]}/${end.toISOString().split('T')[0]}`;
}

// 从文件加载缓存
function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cache = JSON.parse(data);
      papersCache = cache.papers || [];
      lastUpdateTime = cache.lastUpdate || 0;
      lastAISummaryTime = cache.lastAISummaryTime || 0;
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
      lastAISummaryTime: lastAISummaryTime,
      updateTime: new Date().toISOString()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[cache] 保存缓存文件失败:', e.message);
  }
}

// ─── AI 生成中文摘要 ───
async function generateAISummaries(forceRegenerate = false) {
  const papersNeedingSummary = papersCache.filter(p => !p.aiSummary || forceRegenerate);
  const total = papersNeedingSummary.length;

  if (total === 0) {
    console.log('[AI] 所有论文已有摘要，跳过');
    return;
  }

  console.log(`[AI] 开始生成摘要，共 ${total} 篇待处理...`);
  let success = 0;
  let failed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < papersNeedingSummary.length; i += BATCH_SIZE) {
    const batch = papersNeedingSummary.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    console.log(`[AI] 批次 ${batchNum}/${totalBatches}（${batch.length} 篇）`);

    const batchText = batch
      .map((p, idx) => `[论文${idx + 1}]\n标题：${p.title}\n作者：${p.authors}\n分类：${p.category}\n原始摘要：${p.summary}`)
      .join('\n\n');

    const prompt = `你是一位生物医学学术助手。请为以下论文生成简洁的中文摘要（每篇 100-150 字），包含：研究背景、主要方法和关键发现。

${batchText}

请严格按以下格式输出（只输出摘要，不要其他内容）：
论文1摘要：...
论文2摘要：...
论文3摘要：...
论文4摘要：...
论文5摘要：...`;

    try {
      const res = await aiPost('/chat/completions', {
        model: AI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API错误 ${res.status}: ${errText}`);
      }

      const json = await res.json();
      const reply = (json.choices && json.choices[0] && json.choices[0].message.content) || '';

      batch.forEach((paper, idx) => {
        const regex = new RegExp(`论文${idx + 1}摘要[：:]\s*([\\s\\S]*?)(?=论文${idx + 2}摘要|$)`, 'i');
        const match = reply.match(regex);
        if (match) {
          paper.aiSummary = match[1].trim().replace(/^["""]|["""]$/g, '');
          success++;
        } else {
          failed++;
        }
      });

      saveCacheToFile();
      console.log(`[AI] 批次 ${batchNum} 完成，成功 ${success}，失败 ${failed}`);

    } catch (e) {
      console.error(`[AI] 批次 ${batchNum} 失败: ${e.message}`);
      failed += batch.length;
    }

    if (i + BATCH_SIZE < papersNeedingSummary.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  lastAISummaryTime = Date.now();
  saveCacheToFile();
  console.log(`[AI] 摘要生成完成！成功 ${success} 篇，失败 ${failed} 篇`);
}

// 从 bioRxiv 获取论文（尝试多个端点）
async function fetchLatestPapers() {
  console.log('[fetch] 开始获取最新论文...');

  // 方法1：日期范围端点（过去30天）
  const tryDateRange = async () => {
    const dateRange = getDateRange(30);
    console.log(`[fetch] 尝试日期范围: ${dateRange}`);
    const url = `${BIORXIV_API}/details/biorxiv/${dateRange}/0/json`;
    console.log(`[fetch] URL: ${url}`);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ShuaShuaWenXian/1.0'
      },
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.collection && data.collection.length > 0) {
      return data.collection;
    }
    return null;
  };

  // 方法2：数字端点（最近N篇）
  const tryNumeric = async () => {
    console.log('[fetch] 尝试数字端点: /details/biorxiv/100');
    const url = `${BIORXIV_API}/details/biorxiv/100`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ShuaShuaWenXian/1.0'
      },
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.collection && data.collection.length > 0) {
      return data.collection;
    }
    return null;
  };

  try {
    let collection = null;
    let method = '';

    try {
      collection = await tryDateRange();
      method = '日期范围';
    } catch (e) {
      console.log(`[fetch] 日期范围失败: ${e.message}`);
    }

    if (!collection) {
      try {
        collection = await tryNumeric();
        method = '数字';
      } catch (e) {
        console.log(`[fetch] 数字端点失败: ${e.message}`);
      }
    }

    if (!collection) {
      // 方法3：更短的时间范围
      const shortRange = getDateRange(7);
      console.log(`[fetch] 尝试短范围: ${shortRange}`);
      const url = `${BIORXIV_API}/details/biorxiv/${shortRange}/0/json`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ShuaShuaWenXian/1.0'
        },
        timeout: 30000
      });
      const data = await response.json();
      if (data.collection && data.collection.length > 0) {
        collection = data.collection;
        method = '短日期范围';
      }
    }

    if (collection) {
      console.log(`[fetch] 成功（${method}），共 ${collection.length} 篇`);

      // 保留已有摘要
      const existingMap = new Map(papersCache.map(p => [p.id, p]));

      papersCache = collection.map(item => {
        const id = item.doi || item.url;
        const existing = existingMap.get(id);
        return {
          id: id,
          title: item.title || '无标题',
          authors: (item.authors || '').split(';').slice(0, 3).join(', '),
          date: formatDate(item.date),
          category: item.category || 'Biology',
          summary: item.abstract || '暂无摘要',
          link: `https://doi.org/${item.doi}`,
          doi: item.doi,
          license: item.license || '',
          aiSummary: existing ? existing.aiSummary : ''
        };
      });

      lastUpdateTime = Date.now();
      saveCacheToFile();
      console.log(`[fetch] 处理完成: ${papersCache.length} 篇论文`);
      return true;
    }

    console.error('[fetch] 所有端点均返回空数据');
  } catch (e) {
    console.error(`[fetch] 获取失败: ${e.message}`);
  }
  return false;
}

// 定时任务
function scheduleUpdates() {
  const updateTimes = [8, 12, 20];

  function checkAndUpdate() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    if (minute === 0 && updateTimes.includes(hour)) {
      console.log(`[schedule] 定时更新触发: ${hour}:00`);
      fetchLatestPapers().then(ok => {
        if (ok) generateAISummaries();
      });
    }
  }

  setInterval(checkAndUpdate, 60000);

  if (Date.now() - lastUpdateTime > 4 * 60 * 60 * 1000) {
    console.log('[schedule] 缓存过期，启动更新');
    fetchLatestPapers().then(ok => {
      if (ok) generateAISummaries();
    });
  }
}

// ─── API 路由 ───

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cached_papers: papersCache.length,
    last_update: lastUpdateTime ? new Date(lastUpdateTime).toISOString() : 'never',
    last_ai_summary: lastAISummaryTime ? new Date(lastAISummaryTime).toISOString() : 'never',
    ai_ready: papersCache.filter(p => p.aiSummary).length
  });
});

app.get('/api/latest', async (req, res) => {
  try {
    const { cursor = 0, perPage = 50 } = req.query;
    const c = parseInt(cursor) || 0;
    const p = Math.min(parseInt(perPage) || 50, 200);

    if (papersCache.length === 0 || Date.now() - lastUpdateTime > 4 * 60 * 60 * 1000) {
      await fetchLatestPapers();
      generateAISummaries().catch(() => {});
    }

    res.json({
      success: true,
      data: papersCache.slice(c, c + p),
      total: papersCache.length,
      cursor: c + p
    });
  } catch (error) {
    console.error('[latest error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const query = (req.query.query || '').trim().toLowerCase();
    if (!query) return res.json({ success: true, data: [], total: 0 });

    const results = papersCache.filter(p =>
      p.title.toLowerCase().includes(query) ||
      p.authors.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query) ||
      p.summary.toLowerCase().includes(query) ||
      (p.aiSummary && p.aiSummary.toLowerCase().includes(query))
    );

    res.json({ success: true, data: results.slice(0, 20), total: results.length });
  } catch (error) {
    console.error('[search error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  const ok = await fetchLatestPapers();
  if (ok) await generateAISummaries(req.query.forceAI === '1');

  res.json({
    success: ok,
    message: ok ? '刷新成功' : '刷新失败',
    count: papersCache.length,
    aiReady: papersCache.filter(p => p.aiSummary).length
  });
});

app.get('/api/ai-summary', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  await generateAISummaries(req.query.force === '1');

  res.json({
    success: true,
    total: papersCache.length,
    aiReady: papersCache.filter(p => p.aiSummary).length
  });
});

app.get('/api/categories', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'biorxiv', name: 'Biology', nameCn: '生物学' },
      { id: 'medrxiv', name: 'Medicine', nameCn: '医学' }
    ]
  });
});

// ─── 启动 ───
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║       bioRxiv API 后端服务 (AI摘要版)            ║
╠═══════════════════════════════════════════════════╣
║  📖 最新论文: http://localhost:${PORT}/api/latest    ║
║  🔍 搜索:    http://localhost:${PORT}/api/search     ║
║  🔄 手动刷新: http://localhost:${PORT}/api/refresh   ║
║  🤖 AI摘要:  http://localhost:${PORT}/api/ai-summary║
║  ❤️ 健康检查: http://localhost:${PORT}/api/health   ║
║                                                   ║
║  ⏰ 定时更新: 每天 8:00, 12:00, 20:00            ║
║  💾 缓存文件: papers_cache.json                   ║
╚═══════════════════════════════════════════════════╝
  `);

  loadCacheFromFile();
  scheduleUpdates();

  if (papersCache.length === 0) {
    console.log('[startup] 缓存为空，立即获取数据...');
    await fetchLatestPapers();
  }

  const missing = papersCache.filter(p => !p.aiSummary).length;
  if (missing > 0) {
    console.log(`[startup] 发现 ${missing} 篇论文缺少 AI 摘要，后台生成中...`);
    generateAISummaries().catch(e => console.error('[startup] AI摘要生成失败:', e.message));
  }
});
