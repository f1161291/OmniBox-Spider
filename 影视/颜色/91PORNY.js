// @name 91PORNY
// @version 1.0.1
// @author omnibox-spider
// @description 91porny.com（九色/91PORNY）采集源：自拍 /video、蝌蚪 /videos、精选 /vod 三频道 + 14 个自拍分类 + 蝌蚪分类 + 搜索分页；详情页 video[data-src] 直取签名 m3u8/mp4（viewhd 自动规范化为 view 避开 VIP 预告片）；列表广告卡过滤、分页页码/总数解析、短 TTL 缓存、直链→sniff→parse=1 三段式播放兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91PORNY.js
// @dependencies []

/**
 * 实站事实（2026-11-14 实测，改代码前先读这段）
 * 1) 站点走 Cloudflare，需要 UA + Referer；首页下发 JSESSIONID（cookie jar 复用，但详情页实测无 cookie 也能取到 data-src）。
 * 2) 三个频道、三种详情路由、三种播放形态：
 *      /video        -> /video/view/<hash> 或 /video/viewhd/<hash>   -> cdn2.jiuse3.cloud/s/<t>/<token>/hls/<id>/index.m3u8
 *      /videos       -> /videos/view/<id>/<slug>/                    -> cdn.cdnkdjs.com/get_file/.../<id>.mp4?t=..&m=..
 *      /vod          -> /vod/view/<short>                            -> cdn22.jiuse3.cloud/..../index.m3u8?t=..&m=..
 * 3) /video/viewhd/<hash> 给的是 VIP 预告片 //cdn2.jiuse2.cloud/hlsd/js10/index.m3u8（11 秒），
 *    必须规范化成 /video/view/<hash> 才是真片；videoShow.js 直接把 video[data-src] 喂给播放器，
 *    所以 data-src 就是真地址，不是旧 91porn.com 那种 strencode2 诱饵。
 * 4) 列表卡片统一 <div class="video-elem">，封面在 <div class="img" style="background-image:url('...')">，
 *    标题在 <a class="title ...">，时长 <small class="layer">，作者/日期在 <div class="text-muted">。
 *    同一页混有外链广告卡（href 为 https:// 第三方域名），必须只保留站内 /view 链接。
 * 5) 分页：<ul class="pagination"> 里的 href 末尾页码；搜索页另有「共计 N 个视频，第 a/b 页」。
 *    /video 默认即 hd 分类，分页走 /video/category/hd/<n>；/videos 排序走 /videos/<sort>/<n>；
 *    /videos 分类走 /videos/categories/<slug>/<n>；/vod?page=<n>；搜索 /search?keywords=<kw>&page=<n>。
 * 6) data-src 里的 & 被写成 &amp;，必须 decodeHTML 后再返回；带 query 的 m3u8/mp4 一律 parse=0。
 *
 * 【环境变量】（沿用仓库既有命名优先）
 *  PORNY_HOST / SITE_HOSTS   站点基址，默认 https://91porny.com；SITE_HOSTS 逗号分隔可容灾
 *  NINETYONE_UA              自定义 UA（与同目录 91Porn.js 共用）
 *  NINETYONE_COOKIE          手动指定 Cookie（可选，脚本也会自动收 JSESSIONID）
 *  PORNY_CACHE_TTL           列表页缓存秒数，默认 300
 *  PORNY_DETAIL_TTL          详情页缓存秒数，默认 90（签名链接短 TTL，别调太大）
 *  PORNY_PLAY_TTL            播放直链缓存秒数，默认 45
 *  PORNY_PLAY_MODE           direct | sniff | auto（默认 auto：直链优先，失败 sniff，再失败 parse=1）
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.resolve(...).catch() 兜住。
 */

const crypto = require('crypto');

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) {
  OmniBox = {
    log() { /* 本地调试：不写 stdout */ },
    getCache() { return null; },
    setCache() { return Promise.resolve(); },
    deleteCache() { return Promise.resolve(); },
    request() { return Promise.reject(new Error('omnibox_sdk 缺失')); },
    sniffVideo() { return Promise.resolve(''); },
  };
}
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const PREFIX = '[91porny]';
function safeLog(level, msg) {
  try {
    if (OmniBox && typeof OmniBox.log === 'function') {
      Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {});
      return;
    }
  } catch (_) { /* ignore */ }
  try { process.stderr.write(`${PREFIX}[${level}] ${msg}\n`); } catch (_) { /* ignore */ }
}
function logI(m) { safeLog('info', m); }
function logE(m) { safeLog('error', m); }

// ==================== 配置区域 ====================
const DEFAULT_HOST = 'https://91porny.com';
const HOSTS = (() => {
  const raw = String(process.env.SITE_HOSTS || process.env.PORNY_HOST || DEFAULT_HOST);
  const list = raw.split(/[,;]/).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map(s => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
  return Array.from(new Set(list.length ? list : [DEFAULT_HOST]));
})();
let PREFERRED = 0;

const UA = String(process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
const FIXED_COOKIE = String(process.env.NINETYONE_COOKIE || '').trim();
const CACHE_TTL = Math.max(0, Number(process.env.PORNY_CACHE_TTL || 300) || 300);
const DETAIL_TTL = Math.max(0, Number(process.env.PORNY_DETAIL_TTL || 90) || 90);
const PLAY_TTL = Math.max(0, Number(process.env.PORNY_PLAY_TTL || 45) || 45);
const PLAY_MODE = ['direct', 'sniff', 'auto'].includes(String(process.env.PORNY_PLAY_MODE || 'auto').trim().toLowerCase())
  ? String(process.env.PORNY_PLAY_MODE || 'auto').trim().toLowerCase() : 'auto';
const PAGE_SIZE = 24;
const TEASER_RE = /\/hlsd\/js\d+\/index\.m3u8/i;   // VIP 预告片，不是真片
const MEDIA_RE = /\.(m3u8|mp4)(\?|$)/i;

let SESSION_COOKIE = '';   // 自动收集的 JSESSIONID

// 分类：自拍 14 个真实侧栏项 + 蝌蚪排序/常用分类 + 精选
const CATEGORIES = [
  { type_id: 'video:latest', type_name: '自拍·最近更新' },
  { type_id: 'video:hd', type_name: '自拍·高清' },
  { type_id: 'video:hot-list', type_name: '自拍·当前最热' },
  { type_id: 'video:recent-favorite', type_name: '自拍·最近加精' },
  { type_id: 'video:recent-rating', type_name: '自拍·最近得分' },
  { type_id: 'video:nonpaid', type_name: '自拍·非付费' },
  { type_id: 'video:ori', type_name: '自拍·91原创' },
  { type_id: 'video:long-list', type_name: '自拍·10分钟以上' },
  { type_id: 'video:longer-list', type_name: '自拍·20分钟以上' },
  { type_id: 'video:month-discuss', type_name: '自拍·本月讨论' },
  { type_id: 'video:top-favorite', type_name: '自拍·本月收藏' },
  { type_id: 'video:most-favorite', type_name: '自拍·收藏最多' },
  { type_id: 'video:top-list', type_name: '自拍·本月最热' },
  { type_id: 'video:top-last', type_name: '自拍·上月最热' },
  { type_id: 'videos:top-rated', type_name: '蝌蚪·最高评分' },
  { type_id: 'videos:latest-updates', type_name: '蝌蚪·最近更新' },
  { type_id: 'videos:most-popular', type_name: '蝌蚪·最受欢迎' },
  { type_id: 'videos:japan-korea', type_name: '蝌蚪·日韩' },
  { type_id: 'videos:chinese', type_name: '蝌蚪·国产' },
  { type_id: 'videos:europe-america', type_name: '蝌蚪·欧美' },
  { type_id: 'videos:anime', type_name: '蝌蚪·动漫' },
  { type_id: 'videos:unpixelated', type_name: '蝌蚪·无码' },
  { type_id: 'videos:madou', type_name: '蝌蚪·麻豆' },
  { type_id: 'videos:swag', type_name: '蝌蚪·SWAG' },
  { type_id: 'vod', type_name: '精选视频' },
];
// ==================== 配置区域结束 ====================

// ==================== 工具函数 ====================
function decodeHTML(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function cleanText(s) {
  return decodeHTML(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function absUrl(u, host) {
  const v = decodeHTML(String(u || '').trim());
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  if (v.startsWith('/')) return `${host}${v}`;
  return `${host}/${v}`;
}
function shortKey(prefix, value) {
  let hash = '';
  try { hash = crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20); }
  catch (_) { hash = String(value).replace(/[^a-zA-Z0-9]/g, '').slice(-20); }
  return `${prefix}:${hash}`;   // 前缀:短哈希，控制 SDK key 长度
}
function safeInt(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}
function buildHeaders(host) {
  const h = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: `${host}/`,
  };
  const cookie = FIXED_COOKIE || SESSION_COOKIE;
  if (cookie) h.Cookie = cookie;
  return h;
}
function captureCookie(res) {
  if (SESSION_COOKIE || FIXED_COOKIE) return;
  try {
    const raw = res && res.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
    const arr = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
    for (const line of arr) {
      const m = /JSESSIONID=[^;]+/.exec(line);
      if (m) { SESSION_COOKIE = m[0]; logI(`已接收会话 cookie=${SESSION_COOKIE.slice(0, 24)}...`); return; }
    }
  } catch (_) { /* ignore */ }
}
function bodyText(res) {
  const b = res && res.body;
  if (typeof b === 'string') return b;
  if (b && typeof b.toString === 'function') return b.toString('utf8');
  return '';
}
// ==================== 工具函数结束 ====================

// ==================== 请求与缓存 ====================
async function fetchPage(path) {
  const errors = [];
  for (let off = 0; off < HOSTS.length; off++) {
    const i = (PREFERRED + off) % HOSTS.length;
    const host = HOSTS[i];
    const url = absUrl(path, host);
    try {
      const res = await OmniBox.request(url, { method: 'GET', headers: buildHeaders(host) });
      const text = bodyText(res);
      const code = Number(res && res.statusCode) || 0;
      if (code !== 200 || text.length < 500) {
        errors.push(`${host} HTTP ${code} len=${text.length}`);
        continue;
      }
      PREFERRED = i;
      captureCookie(res);
      return { body: text, host, url };
    } catch (e) {
      errors.push(`${host} ${e && e.message ? e.message : e}`);
    }
  }
  throw new Error(`全部基址失败: ${errors.join(' | ')}`);
}

async function cachedPage(path, ttl, tag) {
  const key = shortKey('porny:page', path);
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try {
      const hit = await OmniBox.getCache(key);
      if (hit && String(hit).length > 500) {
        logI(`[${tag}] 命中页面缓存 path=${path}`);
        return { body: String(hit), host: HOSTS[PREFERRED], url: absUrl(path, HOSTS[PREFERRED]), cached: true };
      }
    } catch (e) { logI(`[${tag}] 读缓存失败: ${e.message}`); }
  }
  const res = await fetchPage(path);
  if (ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, res.body, ttl); } catch (e) { logI(`[${tag}] 写缓存失败: ${e.message}`); }
  }
  return Object.assign({ cached: false }, res);
}

async function cachedText(key, ttl, producer) {
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try { const v = await OmniBox.getCache(key); if (v) return String(v); } catch (_) {}
  }
  const value = await producer();
  if (value && ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, value, ttl); } catch (_) {}
  }
  return value;
}
// ==================== 请求与缓存结束 ====================

// ==================== 列表解析 ====================
const CARD_LINK_RE = /href="(\/(?:video\/view(?:hd)?|videos\/view|vod\/view)\/[^"]+)"/i;

function parseCards(html, host) {
  const list = [];
  const seen = new Set();
  const blocks = String(html || '').split(/<div class="video-elem[^"]*">/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<div class="video-elem[^"]*">/i)[0].slice(0, 6000);
    const lm = CARD_LINK_RE.exec(block);
    if (!lm) continue;                    // 外链广告卡直接丢弃
    const vodId = decodeHTML(lm[1]).split('#')[0].trim();
    if (!vodId || seen.has(vodId)) continue;

    const titleM = /<a[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const title = cleanText(titleM ? titleM[1] : '');
    if (!title) continue;

    const imgM = /background-image:\s*url\(['"]?([^'")]+)['"]?\)/i.exec(block)
      || /<img[^>]*\bsrc="([^"]+)"/i.exec(block);
    const pic = imgM ? absUrl(imgM[1], host) : '';
    const durM = /<small[^>]*class="[^"]*\blayer\b[^"]*"[^>]*>([\s\S]*?)<\/small>/i.exec(block);
    const duration = cleanText(durM ? durM[1] : '');
    const authorM = /作者:\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(block) || /作者:\s*([^<\n]+)/i.exec(block);
    const author = cleanText(authorM ? authorM[1] : '');
    const dateM = /(\d{4}-\d{2}-\d{2})/i.exec(block);
    const viewsM = /([\d.]+万?)次播放/i.exec(block);

    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: title,
      vod_pic: pic,
      vod_tag: 'video',
      type_name: channelOf(vodId),
      vod_remarks: duration,
      vod_actor: author,
      vod_year: dateM ? dateM[1].slice(0, 4) : '',
      vod_time: dateM ? dateM[1] : '',
      vod_play_from: '九色',
      vod_content: [author ? `作者：${author}` : '', viewsM ? `${viewsM[1]}次播放` : ''].filter(Boolean).join(' · '),
    });
  }
  return list;
}
function channelOf(vodId) {
  if (vodId.startsWith('/videos/view')) return '蝌蚪窝';
  if (vodId.startsWith('/vod/view')) return '精选视频';
  return '91自拍';
}
function parsePageMeta(html) {
  const out = { pagecount: 0, total: 0 };
  const s = String(html || '');
  const totalM = /共计\s*([\d,]+)\s*个视频[^<]*第\s*\d+\s*\/\s*(\d+)\s*页/i.exec(s);
  if (totalM) {
    out.total = Number(totalM[1].replace(/,/g, '')) || 0;
    out.pagecount = Number(totalM[2]) || 0;
  }
  if (!out.pagecount) {
    const pag = /<ul class="pagination"[\s\S]*?<\/ul>/i.exec(s);
    if (pag) {
      const nums = [];
      const re = /href="([^"]+)"/gi;
      let m;
      while ((m = re.exec(pag[0])) !== null) {
        const u = decodeHTML(m[1]);
        const tail = /\/(\d+)\/?$/.exec(u);
        const q = /[?&]page=(\d+)/i.exec(u);
        const n = tail ? Number(tail[1]) : (q ? Number(q[1]) : 0);
        if (n > 0 && n < 100000) nums.push(n);
      }
      if (nums.length) out.pagecount = Math.max.apply(null, nums);
    }
  }
  if (!out.total && out.pagecount) out.total = out.pagecount * PAGE_SIZE;
  return out;
}
function categoryPath(tid, page) {
  const p = safeInt(page, 1);
  const id = String(tid || 'video:latest');
  if (id === 'vod') return `/vod?page=${p}`;
  if (id.startsWith('video:')) {
    const slug = id.slice(6);
    return p <= 1 ? `/video/category/${slug}` : `/video/category/${slug}/${p}`;
  }
  if (id.startsWith('videos:')) {
    const slug = id.slice(7);
    if (['top-rated', 'latest-updates', 'most-popular'].includes(slug)) return `/videos/${slug}/${p}`;
    return p <= 1 ? `/videos/categories/${slug}` : `/videos/categories/${slug}/${p}`;
  }
  return p <= 1 ? `/video/category/${id}` : `/video/category/${id}/${p}`;
}
// ==================== 列表解析结束 ====================

// ==================== 详情解析 ====================
/** 列表里的 /video/viewhd/<hash> 是 VIP 预告页，必须换成 /video/view/<hash> */
function normalizeDetailPath(vodId) {
  let v = decodeHTML(String(vodId || '')).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    try { const u = new URL(v); v = u.pathname + u.search; } catch (_) { return ''; }
    // 只接受本站路径
    if (!/^\/(?:video|videos|vod)\/view/.test(v)) return '';
  }
  if (!v.startsWith('/')) v = `/${v}`;
  if (!/^\/(?:video\/view(?:hd)?|videos\/view|vod\/view)\//.test(v)) return '';
  v = v.replace(/^\/video\/viewhd\//i, '/video/view/');
  return v;
}
function extractDataSrc(html) {
  const s = String(html || '');
  const videoTag = /<video[^>]*\bid=["']?video-play["']?[^>]*>/i.exec(s);
  let m = videoTag ? /\bdata-src=["']([^"']+)["']/i.exec(videoTag[0]) : null;
  if (!m) m = /\bdata-src=["']([^"']+)["']/i.exec(s);
  if (!m) return '';
  return decodeHTML(m[1]).trim();
}
function parseDetail(html, host, vodId) {
  const s = String(html || '');
  const titleM = /<h4[^>]*class="[^"]*container-title[^"]*"[^>]*>([\s\S]*?)<\/h4>/i.exec(s)
    || /<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i.exec(s)
    || /<title>([\s\S]*?)<\/title>/i.exec(s);
  let title = cleanText(titleM ? titleM[1] : '');
  title = title.replace(/\s*[-|]\s*91视频.*$/i, '').replace(/\s*[-|]\s*蝌蚪窝.*$/i, '').trim() || vodId;

  const picM = /\bdata-poster=["']([^"']+)["']/i.exec(s)
    || /<meta[^>]*property="og:image(?::secure_url)?"[^>]*content="([^"]+)"/i.exec(s);
  const pic = picM ? absUrl(picM[1], host) : '';

  const descM = /<meta[^>]*name="description"[^>]*content="([^"]+)"/i.exec(s)
    || /<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i.exec(s);
  const content = cleanText(descM ? descM[1] : '');

  const authorM = /作者:\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(s)
    || /<meta[^>]*name="twitter:creator"[^>]*content="([^"]+)"/i.exec(s);
  const actor = cleanText(authorM ? authorM[1] : '');

  const kwM = /<meta[^>]*name="keywords"[^>]*content="([^"]+)"/i.exec(s);
  const tags = cleanText(kwM ? kwM[1] : '');
  const dateM = /(\d{4}-\d{2}-\d{2})T?/i.exec(s);
  const durM = /<small[^>]*class="[^"]*\blayer\b[^"]*"[^>]*>([\s\S]*?)<\/small>/i.exec(s);

  return {
    vod_id: vodId,
    vod_name: title,
    vod_pic: pic,
    vod_tag: 'video',
    type_name: channelOf(vodId),
    vod_actor: actor,
    vod_year: dateM ? dateM[1].slice(0, 4) : '',
    vod_remarks: cleanText(durM ? durM[1] : ''),
    vod_content: [content, tags && tags !== title ? `标签：${tags}` : ''].filter(Boolean).join(' · '),
    vod_play_from: '九色',
    vod_play_url: `播放$${vodId}`,
    vod_play_sources: [{ name: '九色', episodes: [{ name: '播放', playId: vodId }] }],
  };
}
// ==================== 详情解析结束 ====================

// ==================== 五个 handler ====================
async function home(params, context) {
  const from = (context && context.from) || (params && params.source) || 'web';
  logI(`[home] 入口 params=${JSON.stringify(params || {})} from=${from}`);
  try {
    const res = await cachedPage('/', CACHE_TTL, 'home');
    const list = parseCards(res.body, res.host);
    logI(`[home] 返回 ${list.length} 条 cached=${res.cached}`);
    return { class: CATEGORIES, filters: {}, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, filters: {}, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  // 兼容宿主把筛选放在 filters / extend / ext 的三种写法
  const filters = p.filters || p.extend || p.ext || {};
  const tid = p.categoryId || p.type_id || p.tid
    || (filters && (filters.categoryId || filters.type_id || filters.tid))
    || 'video:latest';
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  const path = categoryPath(tid, page);
  logI(`[category] 入口 tid=${tid} page=${page} path=${path} from=${from} filters=${JSON.stringify(filters)}`);
  try {
    let res = await cachedPage(path, CACHE_TTL, 'category');
    let list = parseCards(res.body, res.host);
    if (!list.length) {
      logI(`[category] ${path} 首次 0 条，不读缓存重试一次`);
      res = await fetchPage(path);
      list = parseCards(res.body, res.host);
    }
    const meta = parsePageMeta(res.body);
    logI(`[category] 返回 ${list.length} 条 pagecount=${meta.pagecount} total=${meta.total}`);
    return {
      page,
      pagecount: meta.pagecount || page,
      total: meta.total || list.length,
      limit: PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const kw = String(p.keyword || p.wd || p.key || '').trim();
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  if (!kw) { logI('[search] 关键词为空，直接返回空结果'); return { page: 1, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] }; }
  const path = `/search?keywords=${encodeURIComponent(kw)}&page=${page}`;
  logI(`[search] 入口 kw=${kw} page=${page} from=${from}`);
  try {
    let res = await cachedPage(path, CACHE_TTL, 'search');
    let list = parseCards(res.body, res.host);
    if (!list.length) { res = await fetchPage(path); list = parseCards(res.body, res.host); }
    const meta = parsePageMeta(res.body);
    logI(`[search] "${kw}" 返回 ${list.length} 条 pagecount=${meta.pagecount} total=${meta.total}`);
    return {
      page,
      pagecount: meta.pagecount || page,
      total: meta.total || list.length,
      limit: PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.vod_id || p.id || p.videoId || '');
  const vodId = normalizeDetailPath(raw);
  const from = (context && context.from) || p.source || 'web';
  logI(`[detail] 入口 videoId=${vodId || '(空)'} from=${from}`);
  if (!vodId) return { list: [] };
  try {
    const res = await cachedPage(vodId, DETAIL_TTL, 'detail');
    const item = parseDetail(res.body, res.host, vodId);
    if (!item.vod_name || item.vod_name === vodId) {
      logI(`[detail] 页面无有效标题，疑似无效视频 videoId=${vodId}`);
    }
    const src = extractDataSrc(res.body);
    logI(`[detail] 标题="${item.vod_name.slice(0, 60)}" 封面=${item.vod_pic ? '有' : '无'} 直链=${src ? src.slice(0, 90) : '无'}`);
    return { list: [item] };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.playId || p.play_id || p.id || p.url || p.vod_id || '');
  const playId = decodeHTML(String(raw || '')).trim();
  const from = (context && context.from) || p.source || 'web';
  logI(`[play] 入口 playId=${playId.slice(0, 120)} from=${from} mode=${PLAY_MODE}`);
  if (!playId) return { urls: [], flag: '', header: {}, parse: 0, danmaku: [] };

  const header = { 'User-Agent': UA, Referer: `${HOSTS[PREFERRED]}/` };

  // 已经是媒体直链：直通，不再打详情页；VIP 预告片除外（不能把它当正片交出去）
  if (/^https?:\/\//i.test(playId) && MEDIA_RE.test(playId) && !TEASER_RE.test(playId)) {
    logI('[play] playId 即媒体直链，直通 parse=0');
    return { urls: [{ name: '直连', url: playId }], flag: '', header, parse: 0, danmaku: [] };
  }
  if (TEASER_RE.test(playId)) {
    logI(`[play] playId 是 VIP 预告片，丢弃: ${playId.slice(0, 100)}`);
    return { urls: [], flag: '', header, parse: 0, danmaku: [] };
  }

  const detailPath = normalizeDetailPath(playId);
  if (!detailPath) { logE(`[play] playId 非站内路径: ${playId.slice(0, 80)}`); return { urls: [], flag: '', header, parse: 0, danmaku: [] }; }

  // 三段式：① 详情页 data-src 直链 → ② SDK 嗅探 → ③ 播放页 parse=1 兜底
  const direct = await cachedText(shortKey('porny:play', detailPath), PLAY_TTL, async () => {
    if (PLAY_MODE === 'sniff') return '';
    try {
      const res = await fetchPage(detailPath);       // 播放不走页面缓存，避免签名过期
      const src = extractDataSrc(res.body);
      if (!src) { logI('[play] 详情页无 data-src'); return ''; }
      if (TEASER_RE.test(src)) { logI(`[play] 命中 VIP 预告片，丢弃: ${src}`); return ''; }
      const url = absUrl(src, res.host);
      if (!/^https?:\/\//i.test(url) || !MEDIA_RE.test(url)) {
        logI(`[play] data-src 非媒体地址，丢弃: ${url.slice(0, 100)}`);
        return '';
      }
      logI(`[play] 直链解析成功: ${url.slice(0, 120)}`);
      return url;
    } catch (e) { logI(`[play] 直链解析失败: ${e.message}`); return ''; }
  });

  if (direct) {
    return { urls: [{ name: '原画', url: direct }], flag: '', header, parse: 0, danmaku: [] };
  }

  const pageUrl = absUrl(detailPath, HOSTS[PREFERRED]);
  if (PLAY_MODE !== 'direct' && OmniBox && typeof OmniBox.sniffVideo === 'function') {
    try {
      const sniffed = await OmniBox.sniffVideo(pageUrl, header);
      const url = typeof sniffed === 'string' ? sniffed.trim() : (sniffed && sniffed.url ? String(sniffed.url) : '');
      if (url && /^https?:\/\//i.test(url)) {
        logI(`[play] SDK 嗅探成功: ${url.slice(0, 120)}`);
        return { urls: [{ name: '嗅探', url }], flag: '', header, parse: 0, danmaku: [] };
      }
      logI('[play] SDK 嗅探无结果，回退播放页 parse=1');
    } catch (e) { logI(`[play] SDK 嗅探异常: ${e.message}`); }
  }

  logI(`[play] 回退播放页交给播放器嗅探: ${pageUrl}`);
  return {
    urls: [{ name: '播放页', url: pageUrl }],
    flag: '',
    header,
    parse: 1,          // 仅 ok影视 app 有效；其它端忽略，属最后兜底
    danmaku: [],
  };
}
// ==================== 五个 handler 结束 ====================

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
