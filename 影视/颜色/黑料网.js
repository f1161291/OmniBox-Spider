// @name 黑料网
// @author 宝宝巴士
// @description 黑料网(heiliao.com) 采集源：官网同款二级菜单（6 分组 30 子分类）；首页/分类/搜索/详情；封面 qnlycc/biacea AES 解密内联；DPlayer config 直取 m3u8 多线路；多域名轮换（发布页 hlwi9.com 给的 3 条线路）
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/黑料网.js
// @dependencies axios,cheerio,crypto
/**
 * ============ 黑料网（heiliao.com）OmniBox 采集源 ============
 * 【站点事实（2026-11-24 实测）】
 *   Mirages 主题 SSR，title「黑料网 - 每日更新网红明星黑料吃瓜爆料」。
 *   - 主域 heiliao.com 对部分地区返回 451；发布页 hlwi9.com 给出 3 条可用线路：
 *       fyd4t.dfewgvwi.cc / sv8zj.czalhmpo.cc / d1vpyad429lawp.cloudfront.net
 *   - 分类 /{slug}/  详情 /archives/{id}/  搜索 /index/search?wd={kw}
 *   - 封面 img[z-image-loader-url] 指向 pic.biacea.cn，AES-128-CBC 密文（同爱交网 key/iv）
 *   - 详情 DPlayer config='{"video":{"url":m3u8,"urls":[{name,url}...],"pic":...}}'
 *     m3u8 带 auth_key 签名，直链可播（parse=0）
 */
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[hlw]';
const UA = String(process.env.HLW_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOSTS = String(process.env.HLW_HOSTS || 'https://fyd4t.dfewgvwi.cc,https://sv8zj.czalhmpo.cc,https://d1vpyad429lawp.cloudfront.net,https://heiliao.com')
  .split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
const TIMEOUT = Math.max(5000, Number(process.env.HLW_TIMEOUT || 15000) || 15000);
const COVER_INLINE = process.env.HLW_COVER_INLINE !== '0';
const COVER_KEY = Buffer.from(String(process.env.HLW_COVER_KEY || 'f5d965df75336270'), 'latin1');
const COVER_IV = Buffer.from(String(process.env.HLW_COVER_IV || '97b60394abc2fbe1'), 'latin1');

// 官网二级菜单：6 分组 30 子分类（slug 与官网一致）
const CATEGORY_GROUPS = [
  { id: 'group:hot', name: '热门推荐', subs: [
    ['最新黑料','hlcg'], ['今日热瓜','jrrs'], ['热门黑料','jqrm'], ['每日大赛','mrds'],
    ['日榜黑料','mrrb'], ['周榜精选','zbjx'], ['月榜热瓜','ybrg'],
  ]},
  { id: 'group:classic', name: '经典黑料', subs: [
    ['经典黑料','lsdg'], ['校园黑料','xycg'], ['明星丑闻','mxcw'], ['网红黑料','whhl'],
    ['反差专区','fczq'], ['探花专区','thzq'], ['厕拍抄底','cpcd'],
  ]},
  { id: 'group:original', name: '原创社区', subs: [
    ['有料局','youliao'], ['原创社区','ycsq'], ['独家爆料','djbl'], ['有求必应','yqby'],
    ['推特社区','ttsq'], ['网黄合集','whhj'],
  ]},
  { id: 'group:drama', name: '成人短剧', subs: [
    ['成人短剧','ysdj'], ['成人动漫','ttzz'], ['黑料小说','jqxs'], ['深夜综艺','syzy'],
  ]},
  { id: 'group:news', name: '社会资讯', subs: [
    ['社会新闻','shxw'], ['官场爆料','gchl'], ['全球奇闻','qqqw'], ['体育直播','sjb'],
  ]},
  { id: 'group:special', name: '特色专区', subs: [
    ['黑料课堂','hlkt'], ['黑料爆改','hlbg'],
  ]},
];
const TOP_CLASSES = CATEGORY_GROUPS.map((g) => ({ type_id: g.id, type_name: g.name }));
function buildClassFilters() {
  const filters = {};
  for (const g of CATEGORY_GROUPS) {
    filters[g.id] = [{
      key: 'sub', name: '子分类', init: '',
      value: [{ name: '全部', value: '' }, ...g.subs.map(([name, slug]) => ({ name, value: slug }))],
    }];
  }
  return filters;
}
function pickSub(p) {
  p = p || {};
  const src = p.filters || p.extend || p.ext || p.filter || {};
  if (typeof src !== 'object') return '';
  const sub = src.sub ?? src['子分类'];
  return String(Array.isArray(sub) ? (sub[0] || '') : (sub || '')).trim();
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) { try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {} }
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.name || v.title || v.value || '').trim();
  return String(v).trim();
}
function decodeHtml(s) {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").trim();
}
function absUrl(href, base) { try { return new URL(String(href || '').trim(), base).href; } catch (_) { return ''; } }

/** 带域名轮换的页面请求 */
async function fetchHtml(path) {
  const fullPath = path.startsWith('/') ? path : `/${path}`;
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const res = await axios.get(`${host}${fullPath}`, {
        timeout: TIMEOUT, validateStatus: () => true,
        headers: { 'User-Agent': UA, Referer: `${host}/`, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      if (res.status === 200 && res.data) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      throw new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('请求失败');
}

/** 封面 AES 解密（biacea/qnlycc 图床） */
async function resolveCover(url) {
  const u = String(url || '').trim();
  if (!u || !COVER_INLINE || !/^https?:/i.test(u)) return u;
  try {
    const res = await axios.get(u, {
      timeout: 8000, responseType: 'arraybuffer', validateStatus: () => true,
      headers: { 'User-Agent': UA, Referer: `${HOSTS[0]}/` },
    });
    if (res.status !== 200 || !res.data) return u;
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
    if (buf[0] === 0xff && buf[1] === 0xd8) return u; // 明文
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', COVER_KEY, COVER_IV);
      const out = Buffer.concat([d.update(buf), d.final()]);
      if (out.length > 100 && out[0] === 0xff && out[1] === 0xd8) return `data:image/jpeg;base64,${out.toString('base64')}`;
      if (out.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return `data:image/png;base64,${out.toString('base64')}`;
      if (out.slice(0, 4).toString() === 'RIFF' && out.slice(8, 12).toString() === 'WEBP') return `data:image/webp;base64,${out.toString('base64')}`;
    } catch (_) {}
  } catch (_) {}
  return u;
}
async function fillCovers(list) {
  if (!COVER_INLINE || !Array.isArray(list)) return list;
  let idx = 0;
  const workers = Array.from({ length: Math.min(4, list.length) }, async () => {
    while (idx < list.length) {
      const i = idx++;
      if (list[i].vod_pic) list[i].vod_pic = await resolveCover(list[i].vod_pic);
    }
  });
  await Promise.all(workers);
  return list;
}

/** 列表卡片（video-item） */
function parseList(html, base) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const out = [];
  const seen = new Set();
  $('.video-item').each((_, el) => {
    const $el = $(el);
    const a = $el.find('a[href*="/archives/"]').first();
    const href = text(a.attr('href'));
    const m = href.match(/\/archives\/(\d+)\//);
    if (!m || seen.has(m[1])) return;
    const id = m[1];
    const img = $el.find('img').first();
    const pic = text(img.attr('z-image-loader-url') || img.attr('data-src') || img.attr('src'));
    const title = text($el.find('h3.title').first().text() || img.attr('alt'));
    if (!title) return;
    seen.add(id);
    out.push({ vod_id: id, vod_name: title, vod_pic: pic ? absUrl(pic, base) : '', vod_remarks: '' });
  });
  return out;
}
function parsePageCount(html, page) {
  let max = page;
  const re = /\/page\/(\d+)\/?/gi;
  let m;
  while ((m = re.exec(String(html || '')))) max = Math.max(max, Number(m[1]) || page);
  return Math.max(1, max);
}

/* ---------------- 五方法 ---------------- */
async function home() {
  try {
    const html = await fetchHtml('/');
    const list = await fillCovers(parseList(html, HOSTS[0]).slice(0, 60));
    log('info', `home list=${list.length}`);
    return { class: TOP_CLASSES, filters: buildClassFilters(), list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: TOP_CLASSES, filters: buildClassFilters(), list: [] };
  }
}

async function category(params) {
  const p = params || {};
  let slug = String(p.categoryId || p.type_id || p.tid || '').trim();
  const sub = pickSub(p);
  if (sub) slug = sub;
  else if (/^group:/i.test(slug)) {
    const g = CATEGORY_GROUPS.find((x) => x.id === slug);
    slug = (g && g.subs[0]) ? g.subs[0][1] : '';
  }
  if (!slug) return home();
  const page = Math.max(1, Number(p.page || 1) || 1);
  try {
    let path = `/${slug.replace(/^\/+/, '')}/`;
    if (page > 1) path = `/${slug}/page/${page}/`;
    const html = await fetchHtml(path);
    const list = await fillCovers(parseList(html, HOSTS[0]));
    const pagecount = parsePageCount(html, page);
    log('info', `category ${slug} page=${page} list=${list.length}`);
    return { page, pagecount, total: pagecount * 20, limit: 20, list };
  } catch (e) {
    log('error', `category ${slug} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const keyword = String(p.keyword || p.wd || p.q || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!keyword) return { page: 1, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    // 站内搜索是 Vue 异步 API：POST /index/search_article（页面 HTML 只有模板无数据）
    const body = new URLSearchParams();
    body.append('word', keyword);
    body.append('page', String(page));
    body.append('oauth_type', 'web');
    let json = null;
    for (const host of HOSTS) {
      try {
        const res = await axios.post(`${host}/index/search_article`, body.toString(), {
          timeout: TIMEOUT, validateStatus: () => true,
          headers: {
            'User-Agent': UA, Referer: `${host}/index/search?wd=${encodeURIComponent(keyword)}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (res.status === 200 && res.data) {
          json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          break;
        }
      } catch (_) {}
    }
    const data = (json && json.data) || {};
    const rows = Array.isArray(data.list) ? data.list : [];
    let list = rows.map((it) => ({
      vod_id: String(it.id || '').trim(),
      vod_name: text(it.title),
      vod_pic: it.thumb ? absUrl(it.thumb, HOSTS[0]) : '',
      vod_remarks: '',
    })).filter((x) => x.vod_id && x.vod_name);
    list = await fillCovers(list);
    const pagecount = Math.max(1, Number(data.last_page || data.pagecount || page) || page);
    log('info', `search "${keyword}" page=${page} list=${list.length}`);
    return { page, pagecount, total: pagecount * 20, limit: 20, list };
  } catch (e) {
    log('error', `search ${keyword} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = String(p.videoId || p.vod_id || p.id || '').trim();
  if (!raw) return { list: [] };
  try {
    const id = (raw.match(/\/archives\/(\d+)\//) || [])[1] || raw;
    const html = await fetchHtml(`/archives/${id}/`);
    const $ = cheerio.load(html, { decodeEntities: false });
    const title = text($('h1').first().text() || $('title').first().text().split('-')[0]) || '视频';
    // DPlayer config='{"video":{"url":m3u8,"urls":[{name,url}...],"pic":...}}'
    let cfg = null;
    $('[config]').each((_, el) => {
      const rawCfg = text($(el).attr('config'));
      if (!rawCfg || rawCfg[0] !== '{') return;
      try { const j = JSON.parse(rawCfg); if (j && j.video) { cfg = j; return false; } } catch (_) {}
    });
    const video = cfg && cfg.video;
    const sources = [];
    if (video) {
      const eps = [];
      if (video.url) eps.push({ name: '线路1', playId: video.url });
      const extra = Array.isArray(video.urls) ? video.urls : [];
      for (const u of extra) {
        const name = text(u.name) || '备用线路';
        const url = text(u.url);
        if (url && !eps.some((e) => e.playId === url)) eps.push({ name, playId: url });
      }
      if (eps.length) sources.push({ name: '默认线路', episodes: eps });
    }
    let pic = video ? text(video.pic) : '';
    pic = await resolveCover(pic);
    const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const description = descM ? decodeHtml(descM[1]) : '';
    log('info', `detail ${id} title=${title} sources=${sources.length}`);
    return {
      list: [{
        vod_id: id, vod_name: title, vod_pic: pic, vod_content: description,
        vod_remarks: '', vod_play_from: sources.map((s) => s.name).join('$$$'),
        vod_play_url: sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$'),
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${raw} ${e.message}`);
    return { list: [] };
  }
}

async function play(params) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  const playId = String(p.playId || p.url || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  try {
    const url = /^https?:\/\//i.test(playId) ? playId : '';
    if (!url) throw new Error('非直链播放参数');
    log('info', `play url=${url.slice(0, 120)}`);
    return {
      urls: [{ name: '正片', url }], flag: 'default',
      header: { 'User-Agent': UA, Referer: `${HOSTS[0]}/` },
      parse: 0, danmaku: '',
    };
  } catch (e) {
    log('error', `play ${playId.slice(0, 40)} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
