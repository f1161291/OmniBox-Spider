// @name 69吃瓜网
// @version 1.0.1
// @author omnibox-spider
// @description 69吃瓜网（d39cgxtrya69tg.cloudfront.net / 69cgua.com）OmniBox 采集源：WordPress Mirages 主题，分类/搜索/详情/播放全链路；图床前 100 字节 XOR 混淆，脚本内还原为 data:image；play 时重新访问详情签发新 ticket 并直出 m3u8（无需本地代理）
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/69吃瓜网.js

/**
 * ============================================================================
 * 69吃瓜网 OmniBox 采集源（由同名 Python 源适配）
 * ============================================================================
 *
 * 【实站事实（2026-11-17 实测）】
 *   主站：https://d39cgxtrya69tg.cloudfront.net/  （HTTP 200，首页约 312KB）
 *   同站品牌域：69cgua.com（页面 meta 中显示）
 *   列表：<article> 卡片，详情链接 a[href="/archives/{slug}/"].videoCardHitArea
 *         标题 h2.videoTitle；封面 div.videoCover[data-src]（懒加载）
 *   搜索：<article class="searchListCard">，链接 class=searchListCard__link，
 *         标题 div.searchListCard__title，封面 div.searchListCard__image[data-src]
 *   分类：/category/{slug}/，分页 /category/{slug}/{n}
 *   搜索：/search/{encodeURIComponent(keyword)}，分页 /search/{key}/{n}
 *   分页控件：<span class="paginationInfo">第 1/56 页</span>
 *   详情：/archives/{slug}/，播放器 div[data-url="{path}.m3u8?...&amp;ticket=..."]
 *         标题 data-video-title 或 <h1>；主图取 data-url 之前的 https://webimg... 图片
 *   m3u8：源站直出清单（#EXTM3U + #EXT-X-KEY URI="/enkey?...ticket=..."），
 *         密钥与 .ts 分片用 UA + Referer 可 200 直取，无需中转。
 *
 * 【与 Python 版的关键差异（适配要点）】
 *   1) Python 版在脚本内起本地 HTTP 代理做两件事：图片 XOR 解密、m3u8 实时换票。
 *      OmniBox 的 JS 源是一次性 stdin/stdout 进程，不适合常驻本地端口，
 *      因此改为：
 *        - 图片：本体抓二进制 → 前 100 字节 XOR(key=2019ysapp7527) → 嗅探真实类型
 *          → 输出 data:image/...;base64,...（与同仓库 51吃瓜.js / 每日大赛.js 一致）；
 *        - 播放：detail() 只把 slug 编进 playId，play() 执行时重新请求详情页，
 *          拿到刚签发的 data-url 再直出，等价于旧代理的「实时换票」；
 *          key URI 是相对路径，播放器会按 m3u8 真实域名解析，不再需要改写为绝对地址。
 *   2) 若 play() 取到的是 master playlist（#EXT-X-STREAM-INF），显式按 RESOLUTION
 *      高度降序排列 urls，最高清晰度恒为 urls[0]；本站实测为单码率 media playlist。
 *   3) 全部日志走 OmniBox.log；本地缺 SDK 时只写 stderr，绝不写 stdout
 *      （宿主用 stdout 读 handler 返回的 JSON）。
 *
 * 【环境变量】
 *   CG69_HOST                 站点地址，默认 https://d39cgxtrya69tg.cloudfront.net
 *   CG69_UA                   自定义 User-Agent
 *   CG69_REQUEST_TIMEOUT      普通请求超时毫秒，默认 25000
 *   CG69_COVER_DISABLE        设 1 关闭封面解密（回退原始 URL，仅排障用）
 *   CG69_COVER_TIMEOUT        封面抓取超时毫秒，默认 10000
 *   CG69_COVER_CONCURRENCY    封面并发数，默认 6
 * ============================================================================
 */

'use strict';

let OmniBox;
let HAS_SDK = false;
let HAS_CACHE = false;
try {
  OmniBox = require('omnibox_sdk');
  HAS_SDK = !!(OmniBox && typeof OmniBox.log === 'function');
  HAS_CACHE = !!(OmniBox && typeof OmniBox.getCache === 'function');
} catch (_) {
  // 本地调试兜底：只写 stderr，绝不写 stdout
  OmniBox = {};
}
let runner;
try { runner = require('spider_runner'); } catch (_) { runner = { run() {} }; }

const http = require('http');
const https = require('https');
const zlib = require('zlib');

const PREFIX = '[69cg]';

function log(level, message) {
  const line = `${PREFIX}[${level}] ${message}`;
  try {
    if (HAS_SDK && typeof OmniBox.log === 'function') {
      const p = OmniBox.log(level, line);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return;
    }
  } catch (_) {}
  try { process.stderr.write(`${line}\n`); } catch (_) {}
}

function numEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max || Number.MAX_SAFE_INTEGER, Math.max(min || 1, Math.round(n)));
}

function normalizeHost(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://d39cgxtrya69tg.cloudfront.net';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return 'https://d39cgxtrya69tg.cloudfront.net'; }
}

const HOST = normalizeHost(process.env.CG69_HOST || '');
const UA = process.env.CG69_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT = numEnv('CG69_REQUEST_TIMEOUT', 25000, 3000, 120000);
const COVER_DISABLE = /^(1|true|yes)$/i.test(process.env.CG69_COVER_DISABLE || '');
const COVER_TIMEOUT = numEnv('CG69_COVER_TIMEOUT', 10000, 2000, 60000);
const COVER_CONCURRENCY = numEnv('CG69_COVER_CONCURRENCY', 6, 1, 16);
const IMG_KEY = Buffer.from('2019ysapp7527', 'utf8');

const CATEGORIES = [
  { type_id: '/category/jinri/', type_name: '今日吃瓜' },
  { type_id: '/category/ai-egao/', type_name: 'AI成人短剧' },
  { type_id: '/category/tuite/', type_name: '推特网黄' },
  { type_id: '/category/xiaoyuan/', type_name: '校园黑料' },
  { type_id: '/category/wanghong/', type_name: '网红黑料' },
  { type_id: '/category/hot/', type_name: '热门大瓜' },
  { type_id: '/category/toboo/', type_name: '海角乱伦' },
  { type_id: '/category/mingxingheiliao/', type_name: '明星黑料' },
  { type_id: '/category/wuye/', type_name: '午夜AV' },
  { type_id: '/category/tanhua/', type_name: '91探花' },
  { type_id: '/category/lieqi/', type_name: '猎奇重口' },
  { type_id: '/category/dongman/', type_name: '成人动漫' },
  { type_id: '/category/meiri/', type_name: '每日大赛' },
];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return String(text == null ? '' : text)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch (_) { return ''; }
    });
}

function stripTags(text) {
  return decodeEntities(String(text || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function fixUrl(u) {
  if (!u) return '';
  const s = decodeEntities(String(u)).trim();
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return HOST + s;
  if (/^https?:\/\//i.test(s)) return s;
  return `${HOST}/${s}`;
}

function encodeSlug(slug) {
  return `arch_${Buffer.from(String(slug || ''), 'utf8').toString('base64')}`;
}

function decodeSlug(id) {
  const raw = String(id || '').trim();
  if (raw.startsWith('arch_')) {
    try { return Buffer.from(raw.slice(5), 'base64').toString('utf8'); }
    catch (_) { return ''; }
  }
  if (raw.startsWith('/archives/')) return raw;
  if (/^https?:\/\//i.test(raw)) {
    try { const u = new URL(raw); if (u.pathname.startsWith('/archives/')) return u.pathname; }
    catch (_) {}
  }
  return '';
}

/** 原生 http/https 请求：跟随重定向、解压 gzip/deflate/br，可返回原始 Buffer */
function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const redirects = Number(options.redirects || 0);
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const client = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    }, options.headers || {});
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers,
      timeout: Number(options.timeout || REQUEST_TIMEOUT),
      rejectUnauthorized: false,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u.href).href;
        return httpRequest(next, Object.assign({}, options, { redirects: redirects + 1 })).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const finish = (buf) => {
          resolve({ statusCode: code, headers: res.headers || {}, body: options.binary ? buf : buf.toString('utf8') });
        };
        try {
          if (enc === 'gzip') zlib.gunzip(raw, (e, x) => finish(e ? raw : x));
          else if (enc === 'deflate') zlib.inflate(raw, (e, x) => finish(e ? raw : x));
          else if (enc === 'br') zlib.brotliDecompress(raw, (e, x) => finish(e ? raw : x));
          else finish(raw);
        } catch (_) { finish(raw); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`请求超时: ${u.hostname}`)));
    req.end();
  });
}

async function fetchHtml(url) {
  const res = await httpRequest(fixUrl(url), {
    headers: { Referer: `${HOST}/`, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${url}`);
  return String(res.body || '');
}

// ---------------------------------------------------------------------------
// 封面：XOR 解密 → data URI
// ---------------------------------------------------------------------------

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString('ascii') === 'BM') return 'image/bmp';
  return '';
}

/** 与 Python 版 _decode_img 一致：仅前 100 字节按 IMG_KEY 循环异或 */
function decodeXorImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (sniffImageType(buf)) return { mime: sniffImageType(buf), body: buf }; // 本来就是明文图
  const out = Buffer.from(buf);
  const n = Math.min(100, out.length);
  for (let i = 0; i < n; i++) out[i] ^= IMG_KEY[i % IMG_KEY.length];
  const mime = sniffImageType(out);
  if (!mime) return null;
  return { mime, body: out };
}

const coverCache = new Map();

async function resolveCover(url) {
  if (!url) return '';
  if (COVER_DISABLE) return url;
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await httpRequest(fixUrl(url), {
      binary: true,
      timeout: COVER_TIMEOUT,
      headers: { Referer: `${HOST}/`, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    });
    if (res.statusCode !== 200 || !res.body || !res.body.length) {
      coverCache.set(url, url);
      return url;
    }
    const decoded = decodeXorImage(res.body);
    if (!decoded) {
      coverCache.set(url, url);
      return url;
    }
    const dataUri = `data:${decoded.mime};base64,${decoded.body.toString('base64')}`;
    coverCache.set(url, dataUri);
    return dataUri;
  } catch (e) {
    log('info', `[cover] 解密失败，回退原 URL: ${String(url).slice(0, 120)} (${e && e.message || e})`);
    coverCache.set(url, url);
    return url;
  }
}

async function resolveCovers(list) {
  if (COVER_DISABLE || !Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      const item = list[i];
      if (!item || !item.vod_pic) continue;
      const raw = item.vod_pic;
      // eslint-disable-next-line no-await-in-loop
      item.vod_pic = await resolveCover(raw);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(COVER_CONCURRENCY, list.length); i++) workers.push(worker());
  await Promise.all(workers);
  return list;
}

// ---------------------------------------------------------------------------
// 页面解析
// ---------------------------------------------------------------------------

function parseItems(html) {
  const out = [];
  const seen = new Set();
  const blocks = String(html || '').match(/<article\b[^>]*>[\s\S]*?<\/article>/g) || [];
  for (const blk of blocks) {
    try {
      if (!blk.includes('/archives/')) continue;
      const ms = blk.match(/<a\s+href="(\/archives\/[^"]+?)"[^>]*class="(?:videoCardHitArea|searchListCard__link)"/i)
        || blk.match(/<a[^>]*class="(?:videoCardHitArea|searchListCard__link)"[^>]*href="(\/archives\/[^"]+?)"/i);
      if (!ms) continue;
      const slug = ms[1];
      if (seen.has(slug)) continue;

      let title = '';
      const mt = blk.match(/videoTitle"[^>]*>([\s\S]*?)<\/h2>/i)
        || blk.match(/searchListCard__title[^>]*>([\s\S]*?)<\/div>/i);
      if (mt) title = stripTags(mt[1]);
      if (!title) {
        const ma = blk.match(/aria-label="(?:阅读文章：)?([^"]*)"/i);
        if (ma) title = decodeEntities(ma[1]).trim();
      }
      if (!title) continue;

      const mp = blk.match(/(?:videoCover|searchListCard__image)[^>]*?data-src="([^"]+)"/i);
      const pic = mp ? decodeEntities(mp[1]).trim() : '';

      seen.add(slug);
      out.push({
        vod_id: encodeSlug(slug),
        vod_name: title,
        vod_pic: fixUrl(pic),
        vod_remarks: '',
      });
    } catch (_) { /* 单条解析失败不影响整页 */ }
  }
  return out;
}

function parsePageCount(html, page) {
  const m = String(html || '').match(/第\s*\d+\s*\/\s*(\d+)\s*页/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  if (String(html || '').includes('nextBtn') || String(html || '').includes('rel="next"')) {
    return Math.max(page, 99);
  }
  return Math.max(1, page);
}

function extractM3u8(html) {
  const m = String(html || '').match(/data-url="([^"]+?\.m3u8[^"]*)"/i);
  if (!m) return '';
  return fixUrl(m[1]);
}

function extractDetailTitle(html) {
  const t = String(html || '').match(/data-video-title="([^"]*)"/i)
    || String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return t ? stripTags(t[1]) : '';
}

function extractDetailCover(html) {
  const pos = String(html || '').indexOf('data-url');
  if (pos < 0) return '';
  const ctx = String(html).slice(Math.max(0, pos - 3000), pos);
  const mp = ctx.match(/(?:data-src|src|poster)="(https:\/\/webimg[^"]+)"/i);
  return mp ? decodeEntities(mp[1]).trim() : '';
}

/** master playlist → 按 RESOLUTION 高度降序，最高清晰度恒为 urls[0] */
function parseMasterVariants(manifest, masterUrl) {
  const lines = String(manifest || '').split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t && !t.startsWith('#')) { uri = t; break; }
    }
    if (!uri) continue;
    const rm = line.match(/RESOLUTION\s*=\s*(\d+)x(\d+)/i);
    let absolute = '';
    try { absolute = new URL(uri, masterUrl).href; } catch (_) { absolute = fixUrl(uri); }
    variants.push({
      name: rm ? `${Number(rm[2])}P` : `线路${variants.length + 1}`,
      url: absolute,
      height: rm ? Number(rm[2]) : 0,
    });
  }
  if (!variants.length) return [];
  const dedup = new Map();
  for (const v of variants) if (!dedup.has(v.url)) dedup.set(v.url, v);
  return Array.from(dedup.values()).sort((a, b) => b.height - a.height);
}

function isLiveManifest(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('#EXTM3U')) return false;
  return /URI="[^"]*enkey\?[^"]*ticket=/i.test(s);
}

async function fetchFreshPlayUrl(slug) {
  const detailUrl = `${HOST}${slug.startsWith('/') ? slug : `/${slug}`}`;
  const html = await fetchHtml(detailUrl);
  return extractM3u8(html);
}

// ---------------------------------------------------------------------------
// OmniBox handlers
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    const from = (context && context.from) || 'web';
    log('info', `[home] from=${from}`);
    const html = await fetchHtml(`${HOST}/`);
    const list = await resolveCovers(parseItems(html));
    log('info', `[home] list=${list.length}`);
    return { class: CATEGORIES, list };
  } catch (e) {
    log('error', `[home] 失败: ${e && e.message || e}`);
    return { class: [], list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  let page = Number(p.page || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;
  try {
    let tid = String(p.categoryId || p.typeId || p.type_id || '/category/jinri/').trim();
    if (!tid.startsWith('/category/')) tid = `/category/${tid.replace(/^\/+/, '')}`;
    const base = `${HOST}${tid.replace(/\/+$/, '')}`;
    const url = page === 1 ? `${base}/` : `${base}/${page}`;
    log('info', `[category] tid=${tid} page=${page} url=${url}`);
    const html = await fetchHtml(url);
    const list = await resolveCovers(parseItems(html));
    const typeName = (CATEGORIES.find((c) => c.type_id === tid) || {}).type_name || tid;
    const pagecount = parsePageCount(html, page);
    log('info', `[category] list=${list.length} pagecount=${pagecount}`);
    return { list, page, pagecount, limit: 20, total: pagecount * 20, type_name: typeName };
  } catch (e) {
    log('error', `[category] 失败: ${e && e.message || e}`);
    return { list: [], page, pagecount: 0, limit: 20, total: 0 };
  }
}

async function detail(params, context) {
  const p = params || {};
  const videoId = String(p.videoId || p.vodId || p.id || '').trim();
  if (!videoId) return { list: [] };
  try {
    const slug = decodeSlug(videoId);
    if (!slug) {
      log('error', `[detail] 无法解析 videoId=${videoId}`);
      return { list: [] };
    }
    log('info', `[detail] videoId=${videoId} slug=${slug}`);
    const html = await fetchHtml(`${HOST}${slug.startsWith('/') ? slug : `/${slug}`}`);
    const m3u8 = extractM3u8(html);
    if (!m3u8) {
      log('error', `[detail] 未找到 data-url m3u8: ${slug}`);
      return { list: [] };
    }
    const name = extractDetailTitle(html) || videoId;
    const pic = await resolveCover(extractDetailCover(html));
    const playId = encodeSlug(slug);
    log('info', `[detail] name=${name} playId=${playId} m3u8=${m3u8.slice(0, 100)}`);
    return {
      list: [{
        vod_id: videoId,
        vod_name: name,
        vod_pic: pic,
        type_name: '',
        vod_year: '',
        vod_area: '',
        vod_actor: '',
        vod_director: '',
        vod_content: '',
        vod_remarks: '',
        vod_play_from: 'm3u8',
        vod_play_url: `正片$${playId}`,
        vod_play_sources: [{ name: 'm3u8', episodes: [{ name: '正片', playId }] }],
      }],
    };
  } catch (e) {
    log('error', `[detail] 失败: ${e && e.message || e}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const keyword = String(p.keyword || p.wd || p.key || p.search || '').trim();
  let page = Number(p.page || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!keyword) return { list: [], page, pagecount: 0, total: 0 };
  try {
    const base = `${HOST}/search/${encodeURIComponent(keyword)}`;
    const url = page === 1 ? base : `${base}/${page}`;
    log('info', `[search] keyword=${keyword} page=${page} url=${url}`);
    const html = await fetchHtml(url);
    const list = await resolveCovers(parseItems(html));
    const pagecount = parsePageCount(html, page);
    log('info', `[search] list=${list.length} pagecount=${pagecount}`);
    return { list, page, pagecount, total: pagecount * 20 };
  } catch (e) {
    log('error', `[search] 失败: ${e && e.message || e}`);
    return { list: [], page, pagecount: 0, total: 0 };
  }
}

async function play(params, context) {
  const p = params || {};
  const playId = String(p.playId || p.id || p.vodId || '').trim();
  const flag = String(p.flag || 'm3u8');
  const header = { 'User-Agent': UA, Referer: `${HOST}/` };
  if (!playId) {
    log('error', '[play] playId 为空');
    return { urls: [], flag, header, parse: 0 };
  }
  try {
    // 重新访问详情页签发新 ticket（替代 Python 版的本地换票代理）
    const slug = decodeSlug(playId);
    let playUrl = /^https?:\/\/.+\.m3u8/i.test(playId) ? playId : '';
    if (slug) playUrl = await fetchFreshPlayUrl(slug);
    if (!playUrl) {
      log('error', `[play] 未能取得 m3u8: playId=${playId}`);
      return { urls: [], flag, header, parse: 0 };
    }

    let manifest = '';
    try {
      const res = await httpRequest(playUrl, { headers: header, timeout: COVER_TIMEOUT });
      if (res.statusCode === 200) manifest = String(res.body || '');
    } catch (_) {}

    // 清单无效（JSON/广告/过期、非 #EXTM3U）时，再回详情签一次票（对齐 Python 版重试）
    if (slug && (!manifest || !manifest.trim().startsWith('#EXTM3U'))) {
      log('info', '[play] 清单无效，回详情刷新 ticket 后重试一次');
      const fresh = await fetchFreshPlayUrl(slug);
      if (fresh) {
        playUrl = fresh;
        try {
          const res2 = await httpRequest(playUrl, { headers: header, timeout: COVER_TIMEOUT });
          if (res2.statusCode === 200) manifest = String(res2.body || '');
        } catch (_) {}
      }
    }

    let urls;
    const variants = parseMasterVariants(manifest, playUrl);
    if (variants.length) {
      urls = variants.map((v) => ({ name: v.name, url: v.url }));
      log('info', `[play] 多码率按高度降序: ${urls.map((u) => u.name).join(',')}`);
    } else {
      urls = [{ name: '正片', url: playUrl }];
    }
    log('info', `[play] urls=${urls.length} first=${urls[0].url.slice(0, 100)} live=${isLiveManifest(manifest)}`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log('error', `[play] 失败: ${e && e.message || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
