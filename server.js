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
const AI_TIMEOUT_MS = 90000; // 90秒超时

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
    if (err.name === 'AbortError') throw new Error(`AI 请求超时（${timeoutMs / 1000}s）`);
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

function getCategoryCN(category) {
  return category || 'General Biology';
}
function formatDate(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toISOString().split('T')[0];
}

async function fetchFromServer(startDate, endDate, cursor, perPage) {
  const url = `https://api.biorxiv.org/details/biorxiv/${startDate}/${endDate}/${cursor}/${perPage}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ShuaShua/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchLatestPapers() {
  console.log('[fetch] 开始获取最新论文...');

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 60);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];
  console.log(`[fetch] 日期范围: ${startStr} ~ ${endStr}`);

  let allItems = [];
  let cursor = 0;
  const perPage = 100;
  const maxItems = 100;

  while (allItems.length < maxItems && cursor < 500) {
    try {
      console.log(`[fetch] 第 ${cursor / perPage + 1} 页 (cursor=${cursor})...`);
      const data = await fetchFromServer(startStr, endStr, cursor, perPage);
            const collection = (data.collection || []).map(item => ({ ...item, _source: getCategoryCN(item.category) }));

      if (collection.length === 0) break;
      allItems = allItems.concat(collection);
      console.log(`[fetch] 本页 ${collection.length} 篇，累计 ${allItems.length} 篇`);
      if (collection.length < perPage) break;
      cursor += perPage;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`[fetch] 第 ${cursor / perPage + 1} 页失败: ${e.message}`);
      break;
    }
  }

  if (allItems.length === 0) {
    console.error('[fetch] bioRxiv 未返回任何论文');
    return false;
  }

  allItems = allItems.slice(0, maxItems);
  console.log(`[fetch] 共获取 ${allItems.length} 篇论文，开始处理...`);

  // 用 id 建立索引，保留已有 aiSummary（旧论文摘要不丢失）
  const existingMap = new Map(papersCache.map(p => [p.id, p]));
  const newIds = new Set();

  const allPapers = allItems.map(item => {
    const id = item.doi || item.url;
    const existing = existingMap.get(id);
    newIds.add(id);
    const title = item.title || '无标题';
    const abstractText = item.abstract || '(原文摘要暂不可用)';
    const authorsText = (item.authors || '').split(';').slice(0, 5).join(', ');

    return {
      id,
      title,
      authors: authorsText,
      date: formatDate(item.date),
      category: item.category || 'Biology',
      summary: abstractText,
      link: `https://doi.org/${item.doi}`,
      doi: item.doi,
      license: item.license || '',
      source: item._source || getCategoryCN(item.category) || '科学前沿',
      aiSummary: existing ? existing.aiSummary : ''
    };
  });

  // 合并：新论文 + 旧论文（不在新批次中的也保留，aiSummary 不丢）
  const oldPapers = papersCache.filter(p => !newIds.has(p.id));
  papersCache = [...allPapers, ...oldPapers];

  // 统一 source：旧数据有 "bioRxiv · 中文分类"，全部统一为纯英文分类名
  papersCache.forEach(p => {
    if (p.source && p.source.startsWith('bioRxiv · ')) {
      p.source = p.source.replace('bioRxiv · ', '');
    }
  });

  lastUpdateTime = Date.now();
  saveCacheToFile();
  console.log(`[fetch] 处理完成，共 ${papersCache.length} 篇（新增 ${allItems.length}，保留旧论文 ${oldPapers.length}），已有总结 ${papersCache.filter(p => p.aiSummary).length} 篇`);
  return true;
}

// ─── AI 单篇摘要 ───
async function aiSummarizeOne(paper) {
  // 兜底摘要文本
  const summaryText = paper.summary && paper.summary !== '(原文摘要暂不可用)'
    ? paper.summary
    : `标题：${paper.title}。这是一篇关于${paper.category || '科学'}领域的研究。`;

  const prompt = `你是一位科学记者。请为以下研究撰写中文新闻报道。

格式要求（严格按此格式，用 || 分隔）：
导语（一句话，30-50字，要抓人，避免"研究表明""本研究发现"等套话）||要点（方法+关键数据+主要发现，80-120字，分句用逗号分隔）||意义（对普通人意味着什么、未来影响，一句话，30字以内）

输出示例：
中美科学家联合团队在海洋中发现了一种新型可降解塑料分解菌||这种细菌能在常温下分解常见塑料，分解速度是现有方法的3倍||未来可能帮助解决塑料污染问题

写作要求：
- 导语直接说发现了什么，不要"本研究发现""研究表明"
- 术语换成通俗表达
- 客观报道，不夸大
- 每段不超过规定字数

标题：${paper.title}
作者：${paper.authors}
领域：${paper.category}
摘要：${summaryText}

直接输出（仅输出内容，不要任何解释）：`;

  const res = await aiPost('/chat/completions', {
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 600,
  });

  const rawText = await res.text();
  if (!res.ok) throw new Error(`AI API 错误 ${res.status}: ${rawText.substring(0, 200)}`);

  const json = JSON.parse(rawText);
  const reply = (json.choices && json.choices[0] && json.choices[0].message.content) || '';
  return reply.trim();
}

// ─── AI 批量摘要（使用简单分隔符，避免 JSON 解析）───
async function aiSummarizeBatch(batch) {
  const paperBlocks = batch.map((p, idx) => {
    const s = p.summary && p.summary !== '(原文摘要暂不可用)' 
      ? p.summary.substring(0, 600) 
      : `${p.title}`;
    return `【${idx}】${p.title}\n摘要：${s}`;
  }).join('\n\n');

  // 简单 prompt，只要求一行一个导语
  const prompt = `为每篇研究写一句中文新闻导语（25-40字，像新闻标题那样直接说发现了什么，禁止"研究表明""本研究发现"）。

${paperBlocks}

输出要求：必须为每篇输出一行，格式必须是 "序号|导语"，不能遗漏任何一篇，不能添加解释。
输出示例（5篇必须输出5行）：
0|新研究发现XXX
1|科学家首次发现YYY
2|研究揭示ZZZ的作用机制
3|实验证实AAA可降低BBB风险
4|科学家开发出新型CCC方法

只输出这${batch.length}行：`;

  const res = await aiPost('/chat/completions', {
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 600,
  });

  const rawText = await res.text();
  if (!res.ok) throw new Error(`AI API 错误 ${res.status}: ${rawText.substring(0, 200)}`);

  const json = JSON.parse(rawText);
  const reply = (json.choices && json.choices[0] && json.choices[0].message.content) || '';
  
  // 解析每行结果
  const results = [];
  const lines = reply.trim().split('\n').filter(l => l.includes('|'));
  lines.forEach(line => {
    const match = line.match(/^(\d+)\|(.+)$/);
    if (match) {
      results.push({ i: parseInt(match[1]), headline: match[2].trim() });
    }
  });

  return { rawText: reply, parsedArr: results };
}

// ─── 主生成函数（完整版：批量 + 单篇兜底 + 多次尝试）───
async function generateAISummaries(forceRegenerate = false) {
  // 取最新论文（去重后），最多取 200 篇
  const sorted = [...papersCache].sort((a, b) => new Date(b.date) - new Date(a.date));
  const candidates = sorted.slice(0, 200);

  // 分离：已有完整总结 / 需要生成
  const hasFullSummary = p => p.aiSummary && p.aiSummary.split('||').filter(s => s.trim()).length >= 2;
  const needsSummary = forceRegenerate ? candidates : candidates.filter(p => !hasFullSummary(p));
  const alreadyDone = candidates.filter(p => hasFullSummary(p));

  console.log(`[AI] 共 ${candidates.length} 篇候选，已有完整总结 ${alreadyDone.length} 篇，需生成 ${needsSummary.length} 篇`);

  if (needsSummary.length === 0) {
    console.log('[AI] 所有论文已有中文总结');
    return { success: 0, failed: 0, skipped: 0 };
  }

  // 建立 doi → paper 索引
  const doiMap = new Map(papersCache.map(p => [p.doi, p]));

  let success = 0, failed = 0, retried = 0;
  const BATCH_SIZE = 5;
  const MAX_RETRIES = 1;

  for (let i = 0; i < needsSummary.length; i += BATCH_SIZE) {
    const batch = needsSummary.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(needsSummary.length / BATCH_SIZE);

    console.log(`\n[AI] 批次 ${batchNum}/${totalBatches}，处理 ${batch.length} 篇：`);
    batch.forEach((p, bi) => console.log(`  [${bi}] ${p.title.substring(0, 50)}...`));

    let batchSuccess = 0;

    try {
      const { rawText, parsedArr } = await aiSummarizeBatch(batch);

      if (parsedArr && parsedArr.length > 0) {
        // 批量成功：写入 headline
        parsedArr.forEach(entry => {
          const paper = batch[entry.i];
          if (!paper || !entry.headline) return;
          const cached = doiMap.get(paper.doi);
          if (cached) {
            cached.aiSummary = entry.headline + '||';
            batchSuccess++;
            console.log(`  ✅ [${entry.i}] ${entry.headline.substring(0, 35)}...`);
          }
        });
        success += batchSuccess;

        // 同步补充完整摘要（points + meaning），不再依赖异步
        if (batchSuccess > 0) {
          const succeededPapers = parsedArr.filter(e => e.headline).map(e => batch[e.i]);
          for (const paper of succeededPapers) {
            const cached = doiMap.get(paper.doi);
            if (!cached || !cached.aiSummary) continue;
            const parts = cached.aiSummary.split('||');
            if (parts.length >= 3 && parts[1].trim() && parts[2].trim()) continue;
            try {
              const full = await aiSummarizeOne(paper);
              if (full && full.includes('||') && full.split('||').length >= 3) {
                cached.aiSummary = full;
                console.log(`  📝 [补充完整] ${paper.doi}`);
              }
            } catch (e) {
              console.warn(`  ⚠️  补充失败: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 600));
          }
        }

        if (batchSuccess < batch.length) {
          const failedBatch = batch.filter((p, pi) => !parsedArr.find(e => e.i === pi && e.headline));
          const extra = await fillMissingSummaries(failedBatch, doiMap);
          success += extra.success;
          failed += extra.failed;
        }
      } else {
        console.warn(`[AI] 批次 ${batchNum} 批量失败，降级为逐篇处理`);
        const extra = await fillMissingSummaries(batch, doiMap, MAX_RETRIES);
        success += extra.success;
        failed += extra.failed;
        retried += extra.retried;
      }
    } catch (e) {
      console.error(`[AI] 批次 ${batchNum} 异常: ${e.message}`);
      const extra = await fillMissingSummaries(batch, doiMap, MAX_RETRIES);
      success += extra.success;
      failed += extra.failed;
      retried += extra.retried;
    }

    saveCacheToFile();
    console.log(`[AI] 批次 ${batchNum} 完成。累计成功 ${success}，失败 ${failed}`);
    if (i + BATCH_SIZE < needsSummary.length) await new Promise(r => setTimeout(r, 1200));
  }

  lastAISummaryTime = Date.now();
  saveCacheToFile();
  console.log(`\n[AI] 全部完成！成功 ${success}，失败 ${failed}`);
  return { success, failed, retried, total: papersCache.length };
}

// ─── 补充完整摘要（后台异步执行）───
async function enrichSummaries(papers, doiMap) {
  for (const paper of papers) {
    if (!paper || !paper.doi) continue;
    const cached = doiMap.get(paper.doi);
    if (!cached) continue;
    
    // 已有完整摘要则跳过
    if (cached.aiSummary && cached.aiSummary.split('||').length >= 3) continue;
    
    try {
      const full = await aiSummarizeOne(paper);
      if (full.includes('||')) {
        cached.aiSummary = full;
        console.log(`[enrich] ${paper.doi}: 已补充完整摘要`);
      }
    } catch (e) {
      console.warn(`[enrich] ${paper.doi}: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 800));
  }
  saveCacheToFile();
}

// ─── 单篇兜底处理（可多重试）───
async function fillMissingSummaries(papers, doiMap, retries = 1) {
  let success = 0, failed = 0, retried = 0;

  for (const paper of papers) {
    const cached = doiMap.get(paper.doi);
    let attempt = 0;
    let lastError = null;

    while (attempt <= retries) {
      attempt++;
      try {
        const result = await aiSummarizeOne(paper);
        if (result && result.includes('||')) {
          if (cached) cached.aiSummary = result;
          success++;
          console.log(`  ✓ 单篇成功: ${result.split('||')[0].substring(0, 30)}...`);
          break;
        } else {
          lastError = '格式无效: ' + result.substring(0, 30);
          console.warn(`  ⚠️  格式重试 (${attempt}/${retries + 1}): ${lastError}`);
        }
      } catch (e) {
        lastError = e.message;
        console.warn(`  ✗ 单篇失败 (${attempt}/${retries + 1}): ${lastError}`);
      }

      if (attempt <= retries) {
        retried++;
        await new Promise(r => setTimeout(r, 2000)); // 重试前等待
      }
    }

    if (attempt > retries && !success) {
      // AI 生成失败，写入原始摘要作为兜底
      const originalSummary = (paper.summary && paper.summary !== '(原文摘要暂不可用)')
        ? paper.summary.substring(0, 500)
        : paper.title;
      if (cached) cached.aiSummary = originalSummary;
      failed++;
      console.log(`  ↩ 论文 ${paper.doi} 写入原始摘要（${originalSummary.length}字）`);
    }
  }

  return { success, failed, retried };
}

// ─── API 路由 ───

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

app.get('/api/latest', async (req, res) => {
  try {
    const { cursor = 0, perPage = 50 } = req.query;
    const c = parseInt(cursor) || 0;
    const p = Math.min(parseInt(perPage) || 50, 200);

    // 缓存超过4小时，或数据为空，则重新获取
    if (papersCache.length === 0 || Date.now() - lastUpdateTime > 4 * 60 * 60 * 1000) {
      console.log('[api/latest] 缓存为空/过期，重新获取...');
      await fetchLatestPapers();
    }

    res.json({ success: true, data: papersCache.slice(c, c + p), total: papersCache.length, cursor: c + p });
  } catch (e) {
    console.error('[api/latest]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/search', (req, res) => {
  const q = (req.query.query || '').trim().toLowerCase();
  if (!q) return res.json({ success: true, data: [], total: 0 });
  const results = papersCache.filter(p =>
    p.title.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) ||
    (p.aiSummary && p.aiSummary.toLowerCase().includes(q)) ||
    p.summary.toLowerCase().includes(q)
  );
  res.json({ success: true, data: results.slice(0, 20), total: results.length });
});

// 单篇调试接口
app.get('/api/debug-summary', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  const idx = parseInt(req.query.index) || 0;
  if (!papersCache[idx]) return res.status(400).json({ error: `论文 index=${idx} 不存在（共${papersCache.length}篇）` });

  const paper = papersCache[idx];
  console.log(`\n[debug] 测试第 ${idx} 篇: ${paper.title.substring(0, 60)}...`);
  try {
    const result = await aiSummarizeOne(paper);
    res.json({ success: true, index: idx, doi: paper.doi, title: paper.title, raw: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 手动刷新论文（抓取 + 生成摘要）
app.get('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  const ok = await fetchLatestPapers();
  if (!ok) return res.json({ success: false, error: '抓取失败' });

  // 自动生成缺失的摘要
  const result = await generateAISummaries(false);
  res.json({
    success: true,
    count: papersCache.length,
    summaryDone: result.success,
    summaryFailed: result.failed,
    totalWithSummary: papersCache.filter(p => p.aiSummary).length
  });
});

// 清空缓存
app.get('/api/clear-cache', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  papersCache = [];
  lastUpdateTime = 0;
  lastAISummaryTime = 0;
  if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  res.json({ success: true, message: '缓存已清空' });
});

// 生成中文总结
app.get('/api/ai-summary', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  try {
    const result = await generateAISummaries(req.query.force === '1');
    res.json({
      success: true,
      ...result,
      withSummary: papersCache.filter(p => p.aiSummary).length
    });
  } catch (e) {
    console.error('[api/ai-summary]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 单篇生成总结
app.get('/api/ai-summary-one', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  const idx = parseInt(req.query.index) || 0;
  if (!papersCache[idx]) return res.status(400).json({ error: '论文不存在' });

  try {
    const result = await aiSummarizeOne(papersCache[idx]);
    if (result.includes('||')) {
      papersCache[idx].aiSummary = result;
      saveCacheToFile();
    }
    res.json({ success: result.includes('||'), index: idx, raw: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 下载缓存
app.get('/api/download-cache', async (req, res) => {
  const secret = process.env.REFRESH_SECRET || 'shuashua_refresh_secret';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  res.json({ papers: papersCache, lastUpdate: lastUpdateTime, lastAISummaryTime, updateTime: new Date().toISOString() });
});

// ─── 启动 ───
app.listen(PORT, async () => {
  console.log(`\n🚀 科学新知后端启动 | 端口 ${PORT}`);
  loadCacheFromFile();

  if (papersCache.length === 0) {
    console.log('[startup] 缓存为空，正在获取论文...');
    await fetchLatestPapers();
  }

  if (papersCache.length > 0 && papersCache.filter(p => p.aiSummary).length === 0) {
    console.log('[startup] 暂无中文总结，立即生成...');
    generateAISummaries().catch(e => console.error('[startup] AI 生成失败:', e.message));
  }

  startScheduler();
});

// ─── 每日定时任务（早 8 点 + 晚 8 点）───
let lastScheduledRunHours = new Set(); // 记录今天已执行的整点小时

function nextRunOfHour(hour) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime() - now.getTime();
}

function scheduleHour(hour) {
  const ms = nextRunOfHour(hour);
  console.log(`[schedule] ${hour}:00 定时任务，距 ${Math.round(ms / 60000)} 分钟`);
  setTimeout(async () => {
    const today = new Date().toISOString().split('T')[0];
    const key = `${today}-${hour}`;
    if (!lastScheduledRunHours.has(key)) {
      lastScheduledRunHours.add(key);
      console.log(`[schedule] ⏰ ${hour}:00 定时更新开始`);
      try {
        const fetched = await fetchLatestPapers();
        if (fetched) {
          const result = await generateAISummaries(false);
          console.log(`[schedule] ✅ 完成：成功 ${result.success}，失败 ${result.failed}`);
        }
      } catch (e) {
        console.error('[schedule] ❌ 异常:', e.message);
      }
    }
    // 重新计算下一天同一时间
    scheduleHour(hour);
  }, ms);
}

function startScheduler() {
  scheduleHour(8);
  scheduleHour(20);
}
