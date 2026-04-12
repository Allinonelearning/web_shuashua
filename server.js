const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── AI 摘要配置 ───
const AI_API_KEY = process.env.AI_API_KEY || 'sk-vEvVBRVOEfZdtoipoKZnVxEQQOZdPmOYUDFqwx0IWIOnir2x';
const AI_BASE_URL = 'https://api.chatanywhere.org/v1';
const AI_MODEL = 'gpt-4o-mini';
const AI_TIMEOUT_MS = 60000; // 60秒超时

// 用 AbortController 实现超时
async function aiPost(endpoint, body, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(AI_BASE_URL + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs / 1000}s）`);
    }
    throw err;
  }
}

// ─── CORS ───
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (['https://servicewechat.com', 'https://mp.weixin.qq.com'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const BIORXIV_API = 'https://api.biorxiv.org';
const CACHE_FILE = path.join(__dirname, 'papers_cache.json');

// ─── 内存缓存 ───
let papersCache = [];
let lastUpdateTime = 0;
let lastAISummaryTime = 0;

function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      papersCache = cache.papers || [];
      lastUpdateTime = cache.lastUpdate || 0;
      lastAISummaryTime = cache.lastAISummaryTime || 0;
      console.log(`[cache] 加载 ${papersCache.length} 篇，已有中文总结 ${papersCache.filter(p => p.aiSummary).length} 篇`);
    }
  } catch (e) {
    console.error('[cache] 加载失败:', e.message);
  }
}

function saveCacheToFile() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      papers: papersCache,
      lastUpdate: lastUpdateTime,
      lastAISummaryTime: lastAISummaryTime,
      updateTime: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error('[cache] 保存失败:', e.message);
  }
}

// ─── AI 单篇摘要（用于 debug） ───
async function aiSummarizeOne(paper) {
  const prompt = `请为以下论文生成简洁的中文总结（100-150字），包含：研究背景、主要方法、关键发现。

标题：${paper.title}
作者：${paper.authors}
分类：${paper.category}
原始摘要：${paper.summary}

请直接输出中文总结，不要前缀：`;

  console.log('[debug] 发送请求到:', AI_BASE_URL + '/chat/completions');
  console.log('[debug] 模型:', AI_MODEL);

  const res = await aiPost('/chat/completions', {
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 500,
  });

  console.log('[debug] HTTP 状态:', res.status);
  const rawText = await res.text();
  console.log('[debug] 原始响应:', rawText.substring(0, 500));

  if (!res.ok) {
    throw new Error(`API错误 ${res.status}: ${rawText}`);
  }

  const json = JSON.parse(rawText);
  const reply = (json.choices && json.choices[0] && json.choices[0].message.content) || '';
  return { raw: reply, parsed: reply.trim() };
}

// ─── AI 批量摘要 ───
async function aiSummarizeBatch(batch) {
  const paperBlocks = batch
    .map((p, idx) => `[论文${idx + 1}]\n标题：${p.title}\n作者：${p.authors}\n分类：${p.category}\n原始摘要：${p.summary}`)
    .join('\n\n');

  const outputFormat = batch.map((_, idx) => `论文${idx + 1}摘要：...`).join('\n');

  const prompt = `你是一位生物医学学术助手。请为以下论文生成简洁的中文总结（每篇100-150字），包含：研究背景、主要方法、关键发现。

${paperBlocks}

请严格按以下格式输出（只输出摘要，不要其他内容）：
${outputFormat}`;

  console.log('[batch] 发送请求，batch size:', batch.length);

  const res = await aiPost('/chat/completions', {
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2000,
  });

  console.log('[batch] HTTP 状态:', res.status);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API错误 ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const reply = (json.choices && json.choices[0] && json.choices[0].message.content) || '';

  console.log('[batch] AI 回复原文:');
  console.log(reply);
  console.log('---');

  const results = [];
  batch.forEach((paper, idx) => {
    const escapedIdx = idx + 1;
    const nextIdx = idx + 2;
    const regex = new RegExp(`论文${escapedIdx}摘要[：:]\\s*([\\s\\S]*?)(?=论文${nextIdx}摘要|$)`, 'i');
    const match = reply.match(regex);
    const parsed = match ? match[1].trim().replace(/^["""]|["""]$/g, '') : '';
    results.push({ idx, doi: paper.doi, parsed, matched: !!match });
  });

  return { reply, results };
}

async function generateAISummaries(forceRegenerate = false) {
  const sorted = [...papersCache].sort((a, b) => new Date(b.date) - new Date(a.date));
  const top100 = sorted.slice(0, 100);
  const papersNeedingSummary = forceRegenerate ? top100 : top100.filter(p => !p.aiSummary);
  const total = papersNeedingSummary.length;

  if (total === 0) {
    console.log('[AI] 所有论文已有中文总结，跳过');
    return { success: 0, failed: 0, skipped: 0 };
  }

  console.log(`[AI] 开始生成，共 ${total} 篇（最新100篇中）...`);
  let success = 0, failed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = papersNeedingSummary.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    console.log(`\n[AI] 批次 ${batchNum}/${totalBatches}，篇数: ${batch.length}`);

    try {
      const { reply, results } = await aiSummarizeBatch(batch);

      results.forEach(r => {
        const paper = papersNeedingSummary[r.idx];
        if (r.parsed) {
          paper.aiSummary = r.parsed;
          success++;
        } else {
          failed++;
          console.warn(`[AI] 论文 ${r.doi} 解析失败（matched=${r.matched}）`);
        }
      });

      saveCacheToFile();
      console.log(`[AI] 批次 ${batchNum} 完成。累计成功 ${success}，失败 ${failed}`);

    } catch (e) {
      console.error(`[AI] 批次 ${batchNum} 异常:`, e.message);
      failed += batch.length;
    }

    if (i + BATCH_SIZE < total) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  lastAISummaryTime = Date.now();
  saveCacheToFile();
  console.log(`[AI] 完成！成功 ${success}，失败 ${failed}`);
  return { success, failed, skipped: total - success - failed };
}

// ─── bioRxiv 获取 ───
function formatDate(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toISOString().split('T')[0];
}

function getDateRange(days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return `${start.toISOString().split('T')[0]}/${end.toISOString().split('T')[0]}`;
}

async function fetchFromBioRxiv(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ShuaShua/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.collection || [];
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchLatestPapers() {
  console.log('[fetch] 开始获取论文...');

  const strategies = [
    { label: '日期范围30天', fn: () => fetchFromBioRxiv(`${BIORXIV_API}/details/biorxiv/${getDateRange(30)}/0/json`) },
    { label: '日期范围7天', fn: () => fetchFromBioRxiv(`${BIORXIV_API}/details/biorxiv/${getDateRange(7)}/0/json`) },
    { label: '数字端点100', fn: () => fetchFromBioRxiv(`${BIORXIV_API}/details/biorxiv/100`) },
  ];

  let collection = null;
  for (const s of strategies) {
    try {
      console.log(`[fetch] 尝试: ${s.label}`);
      const data = await s.fn();
      if (data.length > 0) {
        collection = data;
        console.log(`[fetch] 成功！共 ${collection.length} 篇`);
        break;
      }
    } catch (e) {
      console.log(`[fetch] ${s.label} 失败: ${e.message}`);
    }
  }

  if (!collection) {
    console.error('[fetch] 所有策略均失败');
    return false;
  }

  const existingMap = new Map(papersCache.map(p => [p.id, p]));
  papersCache = collection.map(item => {
    const id = item.doi || item.url;
    const existing = existingMap.get(id);
    return {
      id,
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
  return true;
}

// ─── API 路由 ───

// ❤️ 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    papers: papersCache.length,
    withSummary: papersCache.filter(p => p.aiSummary).length,
    lastUpdate: lastUpdateTime ? new Date(lastUpdateTime).toISOString() : null,
    lastAISummary: lastAISummaryTime ? new Date(lastAISummaryTime).toISOString() : null
  });
});

// 📋 论文列表
app.get('/api/latest', async (req, res) => {
  try {
    const { cursor = 0, perPage = 50 } = req.query;
    const c = parseInt(cursor) || 0;
    const p = Math.min(parseInt(perPage) || 50, 200);

    if (papersCache.length === 0 || Date.now() - lastUpdateTime > 4 * 60 * 60 * 1000) {
      console.log('[api] 缓存为空/过期，执行 fetchLatestPapers');
      await fetchLatestPapers();
    }

    res.json({ success: true, data: papersCache.slice(c, c + p), total: papersCache.length, cursor: c + p });
  } catch (e) {
    console.error('[api/latest]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 🔍 搜索
app.get('/api/search', (req, res) => {
  const q = (req.query.query || '').trim().toLowerCase();
  if (!q) return res.json({ success: true, data: [], total: 0 });
  const results = papersCache.filter(p =>
    p.title.toLowerCase().includes(q) || p.authors.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q) ||
    (p.aiSummary && p.aiSummary.toLowerCase().includes(q))
  );
  res.json({ success: true, data: results.slice(0, 20), total: results.length });
});

// 🧪 DEBUG：单篇测试（关键！）
// 用法: /api/debug-summary?index=0
// 返回：AI 原始回复 + 解析结果
app.get('/api/debug-summary', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  const idx = parseInt(req.query.index) || 0;
  if (!papersCache[idx]) {
    return res.status(400).json({ success: false, error: `论文 index=${idx} 不存在（共${papersCache.length}篇）` });
  }

  const paper = papersCache[idx];
  console.log(`\n[debug] 测试第 ${idx} 篇: ${paper.title.substring(0, 60)}...`);

  try {
    const result = await aiSummarizeOne(paper);
    res.json({
      success: true,
      index: idx,
      doi: paper.doi,
      title: paper.title,
      rawReply: result.raw,
      parsedSummary: result.parsed,
      hasSummary: !!result.parsed
    });
  } catch (e) {
    console.error('[debug] 失败:', e.message);
    res.status(500).json({ success: false, index: idx, error: e.message });
  }
});

// 🔄 手动刷新论文
app.get('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ success: false, error: 'Forbidden' });
  const ok = await fetchLatestPapers();
  res.json({ success: ok, count: papersCache.length, message: ok ? '刷新成功' : '刷新失败（bioRxiv不可达）' });
});

// 📝 生成中文总结（最新100篇中缺总结的）
app.get('/api/ai-summary', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ success: false, error: 'Forbidden' });

  console.log('\n[api/ai-summary] 开始生成中文总结...');
  try {
    const result = await generateAISummaries(req.query.force === '1');
    res.json({
      success: true,
      ...result,
      total: papersCache.length,
      withSummary: papersCache.filter(p => p.aiSummary).length
    });
  } catch (e) {
    console.error('[api/ai-summary]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 手动给单篇论文补充中文总结
app.get('/api/ai-summary-one', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ success: false, error: 'Forbidden' });

  const idx = parseInt(req.query.index) || 0;
  if (!papersCache[idx]) return res.status(400).json({ success: false, error: '论文不存在' });

  const paper = papersCache[idx];
  try {
    const result = await aiSummarizeOne(paper);
    if (result.parsed) {
      paper.aiSummary = result.parsed;
      saveCacheToFile();
    }
    res.json({ success: !!result.parsed, index: idx, raw: result.raw, parsed: result.parsed });
  } catch (e) {
    res.status(500).json({ success: false, index: idx, error: e.message });
  }
});

// ─── 启动 ───
app.listen(PORT, async () => {
  console.log(`\n🚀 bioRxiv 后端启动 | 端口 ${PORT}`);
  console.log(`   API: https://shuashua.zeabur.app/api`);
  console.log(`   论文: https://shuashua.zeabur.app/api/latest`);
  console.log(`   健康: https://shuashua.zeabur.app/api/health`);
  console.log(`   DEBUG: https://shuashua.zeabur.app/api/debug-summary?secret=shuashua_refresh_secret&index=0\n`);

  loadCacheFromFile();

  if (papersCache.length === 0) {
    console.log('[startup] 缓存为空，正在获取论文...');
    await fetchLatestPapers();
  }

  if (papersCache.length > 0 && papersCache.filter(p => p.aiSummary).length === 0) {
    console.log('[startup] 暂无中文总结，立即生成...');
    generateAISummaries().catch(e => console.error('[startup] 失败:', e.message));
  }
});
