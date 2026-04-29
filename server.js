const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── AI 摘要配置 ───
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.chatanywhere.org/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4.1-mini';
const AI_TIMEOUT_MS = 150000; // 150秒超时

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

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname);
const CACHE_FILE = path.join(CACHE_DIR, 'papers_cache.json');

// ─── GitHub Gist 持久化配置 ───
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const GIST_FILENAME = 'papers_cache.json';

// ─── 内存缓存 ───
let papersCache = [];
let lastUpdateTime = 0;
let lastAISummaryTime = 0;
let gistSaveTimer = null; // 防抖：避免频繁写入 Gist
let lastFetchError = '';  // 上次抓取的错误信息

function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      papersCache = cache.papers || [];
      lastUpdateTime = cache.lastUpdate || 0;
      lastAISummaryTime = cache.lastAISummaryTime || 0;
      console.log(`[cache:file] 加载 ${papersCache.length} 篇，已有中文总结 ${papersCache.filter(p => p.aiSummary).length} 篇`);
      return true;
    }
  } catch (e) {
    console.error('[cache:file] 加载失败:', e.message);
  }
  return false;
}

async function loadCacheFromGist() {
  if (!GIST_TOKEN || !GIST_ID) {
    console.log('[cache:gist] 未配置 GIST_TOKEN/GIST_ID，跳过');
    return false;
  }
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ShuaShua/1.0'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gist = await res.json();
    const file = gist.files && gist.files[GIST_FILENAME];
    if (!file || !file.content) throw new Error('Gist 中无缓存文件');
    const cache = JSON.parse(file.content);
    papersCache = cache.papers || [];
    lastUpdateTime = cache.lastUpdate || 0;
    lastAISummaryTime = cache.lastAISummaryTime || 0;
    console.log(`[cache:gist] ✅ 从 Gist 加载 ${papersCache.length} 篇，已有中文总结 ${papersCache.filter(p => p.aiSummary).length} 篇`);
    // 同步到本地文件
    saveCacheToLocal();
    return true;
  } catch (e) {
    console.error(`[cache:gist] 加载失败: ${e.message}`);
    return false;
  }
}

function saveCacheToLocal() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      papers: papersCache,
      lastUpdate: lastUpdateTime,
      lastAISummaryTime: lastAISummaryTime,
      updateTime: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error('[cache:file] 保存失败:', e.message);
  }
}

async function saveCacheToGist() {
  if (!GIST_TOKEN || !GIST_ID) return;
  try {
    const payload = JSON.stringify({
      papers: papersCache,
      lastUpdate: lastUpdateTime,
      lastAISummaryTime: lastAISummaryTime,
      updateTime: new Date().toISOString()
    });
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ShuaShua/1.0'
      },
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: { content: payload }
        }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[cache:gist] 保存失败: HTTP ${res.status} ${err.substring(0, 100)}`);
    } else {
      console.log(`[cache:gist] ✅ 已同步到 Gist（${papersCache.length} 篇）`);
    }
  } catch (e) {
    console.error(`[cache:gist] 保存异常: ${e.message}`);
  }
}

// 防抖保存：本地即时写，Gist 延迟 30 秒合并写入
function saveCacheToFile() {
  saveCacheToLocal();
  if (GIST_TOKEN && GIST_ID) {
    if (gistSaveTimer) clearTimeout(gistSaveTimer);
    gistSaveTimer = setTimeout(saveCacheToGist, 30000);
  }
}

function getCategoryCN(category) {
  return category || 'General Biology';
}
function formatDate(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toISOString().split('T')[0];
}

// ─── RSS 方式抓取 bioRxiv ───
async function fetchFromRSS() {
  const url = 'https://connect.biorxiv.org/biorxiv_xml.php?subject=all';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    console.log(`[fetch:rss] 请求: ${url}`);
    const response = await fetch(url, {
      headers: { 'Accept': 'application/xml', 'User-Agent': 'ShuaShua/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
    const xml = await response.text();
    
    // 解析 RSS XML
    const items = [];
    const itemRegex = /<item\s+rdf:about="([^"]+)">([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const link = match[1];
      const body = match[2];
      
      const getTag = (tag) => {
        const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        if (!m) return '';
        const raw = m[1].trim();
        if (raw.startsWith('<![CDATA[') && raw.endsWith(']]>')) {
          return raw.slice(9, -3).trim();
        }
        return raw;
      };
      
      const doiMatch = link.match(/10\.\d{4,}\/[^?#]+/);
      // 去掉 v1/v2 等版本后缀
      const doi = doiMatch ? doiMatch[0].replace(/v\d+$/, '') : '';
      
      items.push({
        title: getTag('title'),
        link,
        description: getTag('description'),
        creators: getTag('dc:creator'),
        date: getTag('dc:date'),
        doi,
        _source: 'bioRxiv'
      });
    }
    
    console.log(`[fetch:rss] ✅ 解析到 ${items.length} 篇`);
    return items;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('RSS 超时(30s)');
    throw err;
  }
}

async function fetchLatestPapers() {
  console.log('[fetch] 开始获取最新论文（RSS 模式）...');
  lastFetchError = '';

  let rssItems = [];
  try {
    rssItems = await fetchFromRSS();
  } catch (e) {
    console.error(`[fetch] RSS 抓取失败: ${e.message}`);
    lastFetchError = e.message;
    return false;
  }

  // 过滤掉 title 为空的论文
  const validItems = rssItems.filter(item => {
    const title = (item.title || '').trim();
    if (!title || title === 'null' || title.length < 5) {
      console.warn(`[fetch] 跳过无效标题: "${title}" DOI=${item.doi}`);
      return false;
    }
    return true;
  });

  if (validItems.length === 0) {
    console.error('[fetch] RSS 返回空数据');
    lastFetchError = 'RSS 返回空数据';
    return false;
  }

  // 用 doi 建立索引，保留已有 aiSummary
  const existingMap = new Map(papersCache.map(p => [p.id, p]));
  const newIds = new Set();

  const allPapers = validItems.map(item => {
    const id = item.doi; // doi 作为唯一 id
    const existing = existingMap.get(id);
    newIds.add(id);
    const title = item.title || '无标题';
    const abstractText = item.description || '(原文摘要暂不可用)';
    // 清理 description 中的 HTML 标签
    const cleanAbstract = abstractText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 作者列表处理
    const authorsText = (item.creators || '').split(',').slice(0, 5).join(', ').replace(/\s+/g, ' ').trim();

    return {
      id,
      title,
      authors: authorsText,
      date: item.date || formatDate(new Date()),
      category: 'Biology',
      summary: cleanAbstract.substring(0, 2000),
      link: item.link,
      doi: id,
      license: '',
      source: 'bioRxiv',
      aiSummary: existing ? existing.aiSummary : ''
    };
  });

  // 合并：新论文 + 旧论文（aiSummary 不丢）
  // 旧论文也过滤掉无标题的
  const oldPapers = papersCache.filter(p => !newIds.has(p.id) && p.title && p.title !== '无标题' && p.title.length >= 5);
  papersCache = [...allPapers, ...oldPapers];

  lastUpdateTime = Date.now();
  saveCacheToFile();
  console.log(`[fetch] 处理完成，共 ${papersCache.length} 篇（新增 ${allPapers.length}，保留旧论文 ${oldPapers.length}），已有总结 ${papersCache.filter(p => p.aiSummary).length} 篇`);
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
导语（一句话，25-40字，要抓人，**标题即结论，禁止以"科学家发现""研究表明""本研究发现"开头，禁止用逗号分隔多个句子，禁止使用"和"连接长句，标题长度不超过40字**）||要点（方法+关键数据+主要发现，80-120字，分句用逗号分隔）||意义（对普通人意味着什么、未来影响，一句话，30字以内）

输出示例（注意开头多样化，不要重复）：
新型蛋白质可延缓细胞老化，延长健康寿命||这种蛋白质能激活细胞修复机制，在动物实验中延长寿命约25%||未来或可用于延缓人类衰老
一种可降解塑料的细菌在海洋中被发现||该细菌常温下分解PET塑料，效率是现有方法的3倍||有望用于治理海洋塑料污染
AI预测模型能提前预警阿尔茨海默病风险||通过血液标志物组合分析，准确率达85%，提前5年预警||高危人群可尽早干预

写作要求：
- 导语直接说结论/发现，不用"科学家发现"
- 术语换成通俗表达
- 客观报道，不夸大

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
  if (!reply.trim()) {
    console.warn(`[AI] 空回复，原始响应: ${rawText.substring(0, 300)}`);
  }
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
  const prompt = `为每篇研究写一句中文新闻导语（25-40字，像新闻标题那样直接说发现了什么，禁止"科学家发现""研究表明""本研究发现""一项新研究"开头，禁止用逗号分隔多个句子，禁止使用"和"连接长句，每行不超过40字）。

${paperBlocks}

输出要求：必须为每篇输出一行，格式必须是 "序号|导语"，不能遗漏任何一篇，不能添加解释。
输出示例（注意导语开头要多样化，不要都是"新研究发现"开头）：
0|新型蛋白质可延缓细胞老化
1|海洋细菌能高效分解塑料
2|AI提前5年预警阿尔茨海默病风险
3|量子传感器实现原子级精度测量
4|新型催化剂让太阳能转化率翻倍

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
  // 过滤掉无标题的论文（防止 AI 瞎猜生成重复内容）
  const needsSummary = (forceRegenerate ? candidates : candidates.filter(p => !hasFullSummary(p)))
    .filter(p => p.title && p.title !== '无标题' && p.title.length >= 5);
  const alreadyDone = candidates.filter(p => hasFullSummary(p));

  console.log(`[AI] 共 ${candidates.length} 篇候选，已有完整总结 ${alreadyDone.length} 篇，需生成 ${needsSummary.length} 篇`);

  if (needsSummary.length === 0) {
    console.log('[AI] 所有论文已有中文总结');
    return { success: 0, failed: 0, skipped: 0 };
  }

  // 建立 doi → paper 索引
  const doiMap = new Map(papersCache.map(p => [p.doi, p]));

  let success = 0, failed = 0;

  for (let i = 0; i < needsSummary.length; i++) {
    const paper = needsSummary[i];
    console.log(`\n[AI] ${i + 1}/${needsSummary.length}：${paper.title.substring(0, 50)}...`);

    try {
      const result = await aiSummarizeOne(paper);
      if (result && result.includes('||') && result.split('||').filter(s => s.trim()).length >= 2) {
        const cached = doiMap.get(paper.doi);
        if (cached) cached.aiSummary = result;
        success++;
        console.log(`  ✅ ${result.split('||')[0].substring(0, 35)}...`);
      } else if (result) {
        // 只有导语没有完整三段，也先存着
        const cached = doiMap.get(paper.doi);
        if (cached) cached.aiSummary = result;
        success++;
        console.log(`  ⚠️ 部分成功: ${result.substring(0, 35)}...`);
      } else {
        failed++;
        console.warn(`  ❌ 返回为空`);
      }
    } catch (e) {
      console.error(`  ❌ 失败: ${e.message}`);
      // 超时类错误，等3秒重试一次
      if (e.message && (e.message.includes('524') || e.message.includes('超时') || e.message.includes('aborted'))) {
        console.log(`  ⏳ 等待3秒后重试...`);
        await new Promise(r => setTimeout(r, 3000));
        try {
          const result = await aiSummarizeOne(paper);
          if (result && result.includes('||')) {
            const cached = doiMap.get(paper.doi);
            if (cached) cached.aiSummary = result;
            success++;
            console.log(`  ✅ 重试成功: ${result.split('||')[0].substring(0, 35)}...`);
          } else {
            failed++;
          }
        } catch (e2) {
          console.error(`  ❌ 重试也失败: ${e2.message}`);
          failed++;
        }
      } else {
        failed++;
      }
    }

    // 每篇之间间隔1秒，避免速率限制
    if (i < needsSummary.length - 1) await new Promise(r => setTimeout(r, 1000));
    // 每10篇存一次
    if ((i + 1) % 10 === 0) saveCacheToFile();
  }

  lastAISummaryTime = Date.now();
  saveCacheToFile();
  console.log(`\n[AI] 全部完成！成功 ${success}，失败 ${failed}`);
  return { success, failed, total: papersCache.length };
}

// ─── 补充完整摘要（后台异步执行）───
async function enrichSummaries(papers, doiMap) {
  for (const paper of papers) {
    if (!paper || !paper.doi) continue;
    const cached = doiMap.get(paper.doi);
    if (!cached) continue;
    
    // 已有完整摘要则跳过；只有 headline 没有完整内容则补全（不要覆盖已有的 headline）
    const parts = (cached.aiSummary || '').split('||').filter(s => s.trim());
    if (parts.length >= 3) continue;
    if (parts.length >= 1 && parts.length < 3) {
      // 已有 headline，尝试补全 points + meaning
      try {
        const full = await aiSummarizeOne(paper);
        if (full && full.includes('||') && full.split('||').filter(s => s.trim()).length >= 2) {
          // 保留原有 headline，只追加 points + meaning
          const existingHeadline = cached.aiSummary.split('||')[0];
          cached.aiSummary = existingHeadline + '||' + full.split('||').slice(1).join('||');
          console.log(`[enrich] ${paper.doi}: 补全摘要（保留原导语）`);
        }
      } catch (e) {
        console.warn(`[enrich] ${paper.doi}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800));
      continue;
    }
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
    lastAISummary: lastAISummaryTime ? new Date(lastAISummaryTime).toISOString() : null,
    lastFetchError: lastFetchError || null
  });
});

app.get('/api/latest', async (req, res) => {
  try {
    const { cursor = 0, perPage = 50 } = req.query;
    const c = parseInt(cursor) || 0;
    const p = Math.min(parseInt(perPage) || 50, 200);

    // 用户访问只返回缓存，不触发刷新（刷新由定时任务负责）
    // 如果缓存为空，返回空数组而不是阻塞等待
    if (papersCache.length === 0) {
      return res.json({ success: true, data: [], total: 0, cursor: 0, message: '缓存为空，请等待定时任务刷新' });
    }

    // 返回时去掉 summary 字段（前端不用，减少 60%+ 响应体积）
    const sliced = papersCache.slice(c, c + p).map(({ summary, ...rest }) => rest);
    res.json({ success: true, data: sliced, total: papersCache.length, cursor: c + p });
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
  if (!ok) return res.json({ success: false, error: lastFetchError || '抓取失败' });

  // 自动生成缺失的摘要
  const result = await generateAISummaries(false);

  // 刷新后立即同步到 Gist
  await saveCacheToGist();

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

  // 优先从 Gist 加载（持久化），失败则从本地文件
  const gistLoaded = await loadCacheFromGist();
  if (!gistLoaded) {
    loadCacheFromFile();
  }

  if (papersCache.length === 0) {
    console.log('[startup] 缓存为空，正在获取论文...');
    await fetchLatestPapers();
  }

  // 只有在没有任何 AI 摘要时才自动生成（避免浪费 token）
  if (papersCache.length > 0 && papersCache.filter(p => p.aiSummary).length === 0) {
    console.log('[startup] 暂无中文总结，立即生成...');
    generateAISummaries().catch(e => console.error('[startup] AI 生成失败:', e.message));
  } else {
    console.log(`[startup] 已有 ${papersCache.filter(p => p.aiSummary).length}/${papersCache.length} 篇摘要，跳过 AI 生成`);
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
