var api = require('../../utils/api.js')

var CATEGORY_LABELS = {
  'neuroscience':        { name: '神经科学',   icon: '🧠' },
  'cell biology':        { name: '细胞生物学', icon: '🔵' },
  'genetics':            { name: '遗传学',     icon: '🧬' },
  'molecular biology':   { name: '分子生物学', icon: '⚗️' },
  'biochemistry':        { name: '生物化学',   icon: '🧪' },
  'cancer biology':      { name: '肿瘤生物学', icon: '🎗️' },
  'microbiology':        { name: '微生物学',   icon: '🦠' },
  'immunology':          { name: '免疫学',     icon: '🛡️' },
  'evolutionary biology':{ name: '进化生物学', icon: '🌿' },
  'biophysics':          { name: '生物物理',   icon: '⚡' },
  'developmental biology':{ name: '发育生物学',icon: '🌱' },
  'genomics':            { name: '基因组学',   icon: '📊' },
  'bioinformatics':      { name: '生物信息学', icon: '💻' },
  'ecology':             { name: '生态学',     icon: '🌍' },
  'physiology':          { name: '生理学',     icon: '❤️' },
  'pharmacology and toxicology': { name: '药理学', icon: '💊' },
  'pathology':           { name: '病理学',     icon: '🔍' },
  'plant biology':       { name: '植物生物学', icon: '🌾' },
  'systems biology':     { name: '系统生物学', icon: '🕸️' },
  'synthetic biology':   { name: '合成生物学', icon: '🔧' },
  'bioengineering':      { name: '生物工程',   icon: '⚙️' },
  'epidemiology':        { name: '流行病学',   icon: '📈' },
  'scientific communication and education': { name: '科学传播', icon: '📢' }
}

function preparePaper(paper) {
  var cat = (paper.category || '').toLowerCase()
  var label = CATEGORY_LABELS[cat]
  paper.categoryTag  = label ? (label.icon + ' ' + label.name) : '🔬 科学前沿'
  paper.categoryIcon = label ? label.icon : '🔬'

  // 格式化日期标签
  var d = paper.date || ''
  var dateLabel = d
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
    var parts = d.split('-')
    var months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']
    dateLabel = parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日'
  }
  paper.dateLabel = dateLabel

  var ai = paper.aiSummary || ''

  if (ai.indexOf('||') > -1) {
    // 新闻格式：导语 || 要点 || 意义
    var parts = ai.split('||')
    paper.headline    = (parts[0] || '').trim()
    paper.newsPoints  = (parts[1] || '').trim()
    paper.newsMeaning = (parts[2] || '').trim()
    paper.hasNewsFormat = true
  } else if (ai) {
    // 旧格式（无分隔符）：截断到120字作为导语
    var h = ai.length > 120 ? ai.substring(0, 120) + '…' : ai
    paper.headline = h
    paper.newsPoints = ''
    paper.newsMeaning = ''
    paper.hasNewsFormat = false
  } else {
    // 无 AI 摘要：用论文标题（截断到80字）
    paper.headline = ((paper.title || '暂无标题').length > 80)
      ? paper.title.substring(0, 80) + '…'
      : (paper.title || '暂无标题')
    paper.newsPoints = ''
    paper.newsMeaning = ''
    paper.hasNewsFormat = false
  }

  return paper
}

Page({
  data: {
    papers: [],
    displayPapers: [],
    loading: true,
    refreshing: false,
    searchQuery: '',
    showSearch: false,

    // 展开状态
    expandedIndex: -1,

    // 主题
    themeColor: '#7c6af7',
    isDark: false,
    bgColor: '#f4f5f7',
    cardBg: '#ffffff',
    textColor: '#1a1a1a',
    summarySize: 28
  },

  onLoad: function() {
    var app = getApp()
    if (!app.globalData.themeColor) app.generateTheme()
    this.initTheme()
    this.initFontSize()
    this.loadPapers(false)
  },

  onShow: function() {
    this.initTheme()
    this.initFontSize()
    // 阅读记录跳转
    var app = getApp()
    var targetId = app.globalData.targetPaperId
    if (targetId) {
      app.globalData.targetPaperId = null
      var papers = this.data.displayPapers || []
      for (var i = 0; i < papers.length; i++) {
        if (papers[i].id === targetId) {
          this.openDetail(papers[i])
          break
        }
      }
    }
    // 检查是否需要静默刷新（超过30分钟未刷新则自动刷新）
    var lastFetch = app.globalData.lastPaperFetchTime || 0
    var now = Date.now()
    if (now - lastFetch > 30 * 60 * 1000 && !this.data.loading && !this.data.refreshing) {
      // 静默刷新，不显示loading
      var that = this
      api.getLatestPapers('biorxiv', '', 0, 200).then(function(res) {
        var papers = (res.data || []).map(preparePaper)
        papers.sort(function(a, b) { return new Date(b.date) - new Date(a.date) })
        that.setData({ papers: papers, displayPapers: papers, expandedIndex: -1 })
        getApp().globalData.allPapers = papers
        getApp().globalData.lastPaperFetchTime = Date.now()
      }).catch(function() {})
    }
  },

  initTheme: function() {
    var app = getApp()
    this.setData({
      themeColor: app.globalData.themeColor,
      isDark:     app.globalData.isDark,
      bgColor:    app.globalData.bgColor,
      cardBg:     app.globalData.cardBg,
      textColor:  app.globalData.textColor
    })
  },

  initFontSize: function() {
    var app = getApp()
    var level = app.globalData.fontSizeLevel || 'normal'
    var map = { small: 26, normal: 28, large: 30 }
    this.setData({ summarySize: map[level] || 28 })
  },

  loadPapers: function(isRefresh) {
    var that = this
    if (isRefresh) {
      that.setData({ refreshing: true })
    } else {
      that.setData({ loading: true })
    }
    api.getLatestPapers('biorxiv', '', 0, 200).then(function(res) {
      var papers = (res.data || []).map(preparePaper)
      papers.sort(function(a, b) { return new Date(b.date) - new Date(a.date) })
      that.setData({
        papers: papers,
        displayPapers: papers,
        loading: false,
        refreshing: false,
        expandedIndex: -1
      })
      getApp().globalData.allPapers = papers
      getApp().globalData.lastPaperFetchTime = Date.now()
      if (isRefresh) {
        wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
      }
    }).catch(function(err) {
      console.error('加载失败:', err)
      that.setData({ loading: false, refreshing: false })
      wx.showToast({ title: '网络波动，请稍后重试', icon: 'none', duration: 2000 })
    })
  },

  // 下拉刷新
  onPullDownRefresh: function() {
    var that = this
    api.getLatestPapers('biorxiv', '', 0, 200).then(function(res) {
      var papers = (res.data || []).map(preparePaper)
      papers.sort(function(a, b) { return new Date(b.date) - new Date(a.date) })
      that.setData({ papers: papers, displayPapers: papers, expandedIndex: -1 })
      getApp().globalData.lastPaperFetchTime = Date.now()
      wx.stopPullDownRefresh()
      wx.showToast({ title: '已刷新', icon: 'success', duration: 1200 })
    }).catch(function() {
      wx.stopPullDownRefresh()
    })
  },

  // 搜索
  onToggleSearch: function() {
    var closing = this.data.showSearch
    this.setData({ showSearch: !closing, searchQuery: '' })
    if (closing) {
      this.setData({ displayPapers: this.data.papers })
    }
  },

  searchTimer: null,
  onSearchInput: function(e) {
    var query = e.detail.value.toLowerCase().trim()
    this.setData({ searchQuery: query })
    if (!query) {
      this.setData({ displayPapers: this.data.papers })
      return
    }
    var local = this.data.papers.filter(function(p) {
      return (p.title && p.title.toLowerCase().indexOf(query) > -1) ||
             (p.headline && p.headline.toLowerCase().indexOf(query) > -1) ||
             (p.authors && p.authors.toLowerCase().indexOf(query) > -1) ||
             (p.source && p.source.toLowerCase().indexOf(query) > -1) ||
             (p.category && p.category.toLowerCase().indexOf(query) > -1)
    })
    this.setData({ displayPapers: local })
    var that = this
    if (that.searchTimer) clearTimeout(that.searchTimer)
    if (query.length >= 2) {
      that.searchTimer = setTimeout(function() {
        api.searchPapers(query).then(function(res) {
          if (!res || !res.data || res.data.length === 0) return
          that.setData({ displayPapers: res.data.map(preparePaper) })
        }).catch(function() {})
      }, 500)
    }
  },

  onClearSearch: function() {
    this.setData({ searchQuery: '', displayPapers: this.data.papers })
  },

  // 展开/收起卡片
  onCardTap: function(e) {
    var idx = e.currentTarget.dataset.index
    if (this.data.expandedIndex === idx) {
      this.setData({ expandedIndex: -1 })
    } else {
      this.setData({ expandedIndex: idx })
      var paper = this.data.displayPapers[idx]
      if (paper) getApp().addHistoryToCloud(paper)
    }
  },

  // 关闭详情
  onCloseDetail: function() {
    this.setData({ showDetail: false, detailPaper: null })
  },

  // 收藏（列表卡片上的快捷收藏）
  onFavoriteTap: function(e) {
    e.stopPropagation && e.stopPropagation()
    var idx = e.currentTarget.dataset.index
    var paper = this.data.displayPapers[idx]
    this._toggleFavorite(paper)
  },

  // 收藏（详情弹窗内）
  onDetailFavorite: function() {
    this._toggleFavorite(this.data.detailPaper)
  },

  _toggleFavorite: function(paper) {
    if (!paper) return
    var app = getApp()
    if (!app.globalData.userInfo) {
      wx.showModal({
        title: '需要登录',
        content: '收藏功能需要登录后使用，是否前往登录？',
        confirmText: '去登录',
        success: function(res) {
          if (res.confirm) wx.switchTab({ url: '/pages/login/login' })
        }
      })
      return
    }
    var favs = app.globalData.favorites
    var exists = false
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].id === paper.id) { exists = true; break }
    }
    if (exists) {
      app.removeFavoriteFromCloud(paper.id)
      wx.showToast({ title: '已取消收藏', icon: 'none' })
    } else {
      app.addFavoriteToCloud(paper)
      wx.showToast({ title: '已收藏 ♡', icon: 'none' })
    }
  },

  isFavorited: function(paperId) {
    var favs = getApp().globalData.favorites || []
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].id === paperId) return true
    }
    return false
  },

  // 复制链接（详情弹窗内）
  onCopyLink: function() {
    var paper = this.data.detailPaper
    var link = paper && paper.link
    if (link && /^https?:\/\/(www\.)?(doi\.org|biorxiv\.org)\//.test(link)) {
      wx.setClipboardData({
        data: link,
        success: function() { wx.showToast({ title: '链接已复制', icon: 'success' }) }
      })
    } else {
      wx.showToast({ title: '链接无效', icon: 'none' })
    }
  },

  // 复制链接（卡片上）
  onCopyLinkCard: function(e) {
    var index = e.currentTarget.dataset.index
    var paper = this.data.displayPapers[index]
    var link = paper && paper.link
    if (link && /^https?:\/\/(www\.)?(doi\.org|biorxiv\.org)\//.test(link)) {
      wx.setClipboardData({
        data: link,
        success: function() { wx.showToast({ title: '链接已复制', icon: 'success' }) }
      })
    } else {
      wx.showToast({ title: '链接无效', icon: 'none' })
    }
  },

  // 分享
  onShareAppMessage: function() {
    var paper = this.data.detailPaper || (this.data.displayPapers && this.data.displayPapers[0])
    if (!paper) return { title: '科学新知', path: '/pages/index/index' }
    var title = paper.headline.length > 50 ? paper.headline.substring(0, 47) + '…' : paper.headline
    return { title: title, path: '/pages/index/index?paperId=' + paper.id }
  }
})
