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

// ─── AI 单篇摘要（新闻报道风格） ───
async function aiSummarizeOne(paper) {
  const prompt = `你是一位科学记者。请为以下研究撰写中文新闻报道，严格按以下格式输出（用 || 分隔三段，不要换行，不要其他内容）：

[导语一句话]||[要点2-3句话]||[意义一句话]

要求：
- 导语：一句话概括"发现了什么/做了什么"，要抓人，避免"研究表明"等套话
- 要点：方法+核心数据+发现，2-3句
- 意义：对普通人的价值或未来影响，一句话
- 专业术语换成普通人能懂的表达
- 每段不超过60字

原文信息：
标题：${paper.title}
作者：${paper.authors}
领域：${paper.category}
摘要：${paper.summary}

直接输出（格式：导语||要点||意义）：`;

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

// ─── AI 批量摘要（新闻报道风格）───
async function aiSummarizeBatch(batch) {
  const paperBlocks = batch
    .map((p, idx) => `[论文${idx + 1}]\n标题：${p.title}\n作者：${p.authors}\n领域：${p.category}\n摘要：${p.summary}`)
    .join('\n\n');

  const prompt = `你是一位科学记者。请为以下每篇研究撰写中文新闻报道，严格按JSON格式输出（只输出JSON，不要其他内容）：

每篇格式：{"index":N,"导语":"一句话抓人开场","要点":"方法+数据+发现，2-3句","意义":"对普通人的价值，一句话"}

要求：
- 导语：避免"研究表明""本研究发现"等套话，直接说发现了什么
- 要点：包含关键数据或方法，2-3句，每句不超过40字
- 意义：未来影响或实用价值，一句话
- 专业术语换成普通人能懂的表达

${paperBlocks}

输出JSON数组：`;

  const bodyWithPapers = prompt;

  console.log('[batch] 发送请求，batch size:', batch.length);

  const res = await aiPost('/chat/completions', {
    model: AI_MODEL,
    messages: [{ role: 'user', content: bodyWithPapers }],
    temperature: 0.3,
    max_tokens: 3000,
  });

  console.log('[batch] HTTP 状态:', res.status);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API错误 ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const reply = (json.choices && json.choices[0] && json.choices[0].message.content) || '';
  console.log('[batch] AI 回复:\n', reply.substring(0, 800));

  // JSON 解析（容错）
  let parsed = null;
  try {
    const jsonMatch = reply.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('[batch] JSON解析失败，尝试备用解析');
  }

  const results = [];
  batch.forEach((paper, idx) => {
    let parsedText = '';
    if (parsed && Array.isArray(parsed)) {
      const entry = parsed.find(e => e.index === idx);
      if (entry) {
        // 新格式：导语||要点||意义（结构化存储）
        if (entry.导语 && entry.要点 && entry.意义) {
          parsedText = `${entry.导语}||${entry.要点}||${entry.意义}`;
        } else if (entry.摘要) {
          // 兼容旧格式
          parsedText = entry.摘要;
        }
      }
    }
    results.push({ idx, doi: paper.doi, parsed: parsedText, matched: !!parsedText });
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

  // 用 doi 建立索引，确保写入正确的论文
  const doiToPaper = new Map(papersCache.map(p => [p.doi, p]));

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = papersNeedingSummary.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    console.log(`\n[AI] 批次 ${batchNum}/${totalBatches}，篇数: ${batch.length}`);

    try {
      const { reply, results } = await aiSummarizeBatch(batch);

      results.forEach(r => {
        const batchPaper = batch[r.idx];
        // 通过 doi 找到缓存中的论文（而不是用索引）
        const cachedPaper = doiToPaper.get(batchPaper.doi);
        if (cachedPaper && r.parsed) {
          cachedPaper.aiSummary = r.parsed;
          success++;
        } else {
          failed++;
          console.warn(`[AI] 论文 ${batchPaper.doi} 写入失败`);
        }
      });

      // 打印本批次解析详情
      results.forEach(r => {
        const status = r.parsed ? '✅' : '❌';
        console.log(`  ${status} 论文${r.idx + 1}: ${r.parsed ? r.parsed.substring(0, 40) + '...' : '解析为空'}`);
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
  console.log('[fetch] 开始获取最新 100 篇论文...');

  let collection = [];

  try {
    // 直接获取最新 100 篇
    const url = `${BIORXIV_API}/details/biorxiv/100`;
    console.log(`[fetch] 请求: ${url}`);
    
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ShuaShua/1.0' }
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    collection = data.collection || [];
    
    console.log(`[fetch] 成功！获取 ${collection.length} 篇论文`);

  } catch (e) {
    console.error(`[fetch] 获取失败: ${e.message}`);
    return false;
  }

  if (collection.length === 0) {
    console.error('[fetch] 未获取到任何论文');
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

// 🗑️ 清空缓存（重新开始）
app.get('/api/clear-cache', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ success: false, error: 'Forbidden' });
  papersCache = [];
  lastUpdateTime = 0;
  lastAISummaryTime = 0;
  // 删除缓存文件
  if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
  }
  res.json({ success: true, message: '缓存已清空，请调用 /api/refresh 重新获取论文' });
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

// 📥 下载当前缓存（用于备份到 Git，Zeabur 重启后恢复）
app.get('/api/download-cache', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    papers: papersCache,
    lastUpdate: lastUpdateTime,
    lastAISummaryTime: lastAISummaryTime,
    updateTime: new Date().toISOString()
  });
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
  console.log(`
🚀 bioRxiv 后端启动 | 端口 ${PORT}`);
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

  startScheduler();
});

// ─── 每日定时任务（早8点 + 晚8点）───
let lastScheduledRun = 0;

function scheduleNextRun() {
  const now = new Date();
  const targets = [8, 20].map(h => {
    const t = new Date(now);
    t.setHours(h, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t.getTime();
  });
  return Math.min(...targets) - now.getTime();
}

async function scheduledUpdate() {
  const today = new Date().toISOString().split('T')[0];
  if (String(lastScheduledRun) === today) {
    console.log(`[schedule] 今日(${today})已执行过，跳过`);
    return;
  }
  console.log(`[schedule] ⏰ 定时更新开始 (${new Date().toISOString()})`);
  try {
    const fetched = await fetchLatestPapers();
    if (fetched) {
      const result = await generateAISummaries(false);
      console.log(`[schedule] ✅ 完成：总结 ${result.success} 篇，失败 ${result.failed} 篇`);
    } else {
      console.log('[schedule] ⚠️ bioRxiv 不可达，跳过');
    }
  } catch (e) {
    console.error('[schedule] ❌ 异常:', e.message);
  }
  lastScheduledRun = today;
}

function startScheduler() {
  const ms = scheduleNextRun();
  console.log(`[schedule] 定时器已启动，距下次执行 ${Math.round(ms / 60000)} 分钟`);
  setTimeout(() => {
    scheduledUpdate();
    setInterval(scheduledUpdate, 24 * 60 * 60 * 1000);
  }, ms);
}
