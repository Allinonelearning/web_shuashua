const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const BIORXIV_API = 'https://api.biorxiv.org';

// 格式化日期为 YYYY-MM-DD
function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
}

// 获取最新论文
app.get('/api/latest', async (req, res) => {
  try {
    const { cursor = 0, perPage = 50 } = req.query;
    const c = parseInt(cursor) || 0;
    // 使用"最近N篇"格式：/details/biorxiv/{count}
    const url = `${BIORXIV_API}/details/biorxiv/${parseInt(perPage)}`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ShuaShuaWenXian/1.0'
      }
    });
    
    const data = await response.json();
    
    if (data.collection && data.collection.length > 0) {
      const papers = data.collection.map(item => ({
        id: item.doi || item.url,
        title: item.title || '无标题',
        authors: (item.authors || '').split(';').slice(0, 3).join(', '),
        date: formatDate(item.date),
        category: item.category || 'Biology',
        summary: item.abstract || '暂无摘要',
        link: `https://doi.org/${item.doi}`,
        doi: item.doi
      }));
      
      res.json({
        success: true,
        data: papers,
        total: data.collection.length,
        cursor: c + parseInt(perPage)
      });
    } else {
      res.json({ success: true, data: [], total: 0, cursor: c + parseInt(perPage) });
    }
  } catch (error) {
    console.error('Error fetching latest:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 搜索论文
app.get('/api/search', async (req, res) => {
  try {
    const { query, category = 'biorxiv', page = 0 } = req.query;
    
    if (!query) {
      return res.status(400).json({ success: false, error: 'Query is required' });
    }
    
    const url = `${BIORXIV_API}/search/${category}/${encodeURIComponent(query)}/${page}/50`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ShuaShuaWenXian/1.0'
      }
    });
    
    const data = await response.json();
    
    if (data.collection && data.collection.length > 0) {
      const papers = data.collection.map(item => ({
        id: item.doi || item.url,
        title: item.title || '无标题',
        authors: (item.authors || '').split(';').slice(0, 3).join(', '),
        date: formatDate(item.date),
        category: item.category || 'Biology',
        summary: item.abstract || '暂无摘要',
        link: `https://doi.org/${item.doi}`,
        doi: item.doi
      }));
      
      res.json({
        success: true,
        data: papers,
        total: data.total,
        page: parseInt(page)
      });
    } else {
      res.json({ success: true, data: [], total: 0, page: parseInt(page) });
    }
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`bioRxiv API Server running on port ${PORT}`);
});
