// @name 海角网
// @author 宝宝巴士
// @description hjw01.com（海角网）：首页/分类/标签/分页/详情/播放；列表 xqbj-list-rows 取标题/封面；详情页 DPlayer data-config 直取带签名 m3u8；封面图床 pic.gyezbp.cn 为 AES-128-CBC 密文，脚本内解密转 data:image
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/海角网.js
// @dependencies crypto
/**
 * ============================================================================
 * 海角网（www.hjw01.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-18 实测）】
 *   海角系视频站，Vue 主题（haijiao3）+ DPlayer 播放器，服务端渲染。
 *   首页：/                        314KB，101 个 /archives/ 链接
 *   分类：/category/{slug}/        12 个（hjaidj/hjby/hjcg/hjdm/hjkp/hjll/hjth/hjwh/hjyc/lmyq/yczm/zthj）
 *   标签：/tag/{关键词}/
 *   分页：/page/{n}/               实测末页 1081
 *   详情：/archives/{id}/
 *
 * 【列表卡片】
 *   <div class="xqbj-list-rows">
 *     <div class="xqbj-list-rows-image">
 *       <a href="/archives/{id}/" title="标题">
 *         <h3>标题</h3>
 *         <img z-image-loader-url="`https://pic.gyezbp.cn/upload_01/xiao/...jpeg`">
 *   注意：图片属性值外面还包了一层反引号（Vue 绑定写法），解析时要剥掉。
 *
 * 【详情 / 播放（关键）】
 *   详情页 DPlayer 的 data-config 是**单引号包裹的 JSON**，内部用 \" 转义：
 *     data-config='{"video":{"url":"https:\/\/hls.xxx.cn\/videos5\/...\/x.m3u8?auth_key=...","type":"hls"}}'
 *   ⚠️ 提取坑：正则 [^']+ 会在内部的 \' 处提前截断，
 *      必须定位到 "data-config='" 之后、再找 "'>" 作为结束标记。
 *   video.url 就是带 auth_key 签名的 m3u8 直链：
 *     实测 HTTP 200，标准 HLS（5346B），含 EXT-X-KEY（AES-128 加密流，另有 key URI）。
 *   ⚠️ 并非所有帖子都有 video.url（部分帖子是图文或需付费解锁），
 *      这类帖子 vod_play_sources 为空，属正常现象。
 *
 * 【封面（AES 加密图床）】
 *   图床 pic.gyezbp.cn 返回 binary/octet-stream，是 AES-128-CBC 密文。
 *   密钥与 51吃瓜 / 每日大赛 同一套：
 *     key=f5d965df75336270  iv=97b60394abc2fbe1（CBC + Pkcs7）
 *   站点 app.config.js 里的 media_key / media_iv 正是这两个（数字串转字符即得）。
 *   实测解密后为标准 JPEG。脚本抓取后解密转 data:image 内联。
 *
 * 【环境变量】
 *   HJW_HOST         站点地址，默认 https://www.hjw01.com
 *   HJW_COVER_INLINE 封面内联解密，默认 1；设 0 关闭（回退原始 URL）
 *   HJW_UA           自定义 User-Agent
 * ============================================================================
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) {
  OmniBox = {
    log() {},
    getCache() { return null; },
    setCache() { return Promise.resolve(); },
    deleteCache() { return Promise.resolve(); },
  };
}
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const PREFIX = '[hjw]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const HOST = String(process.env.HJW_HOST || 'https://www.hjw01.com').replace(/\/+$/, '');
const UA = String(process.env.HJW_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* 封面图床 AES 密钥（与 51吃瓜 / 每日大赛 同一图床方案） */
const COVER_AES_KEY = Buffer.from('f5d965df75336270', 'latin1');
const COVER_AES_IV = Buffer.from('97b60394abc2fbe1', 'latin1');
const COVER_INLINE = process.env.HJW_COVER_INLINE !== '0';
const COVER_CONCURRENCY = (() => {
  const n = Number(String(process.env.HJW_COVER_CONCURRENCY || '').trim() || 6);
  return Number.isFinite(n) && n > 0 ? Math.min(12, Math.floor(n)) : 6;
})();
const COVER_TIMEOUT = 8000;

/* ---------------- HTTP ---------------- */
function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) {}
  return buf;
}
function nodeRequest(urlStr, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${HOST}/`,
    }, options.headers || {});
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: options.timeout || 20000,
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return nodeRequest(new URL(res.headers.location, u.href).href, options, redirects + 1)
          .then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: decompress(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.end();
  });
}
async function fetchHtml(url) {
  if (OmniBox && typeof OmniBox.request === 'function') {
    try {
      const r = await OmniBox.request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        timeout: 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return body;
    } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  }
  const r = await nodeRequest(url);
  return String(r.body || '');
}

/* ---------------- 工具 ---------------- */
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function fixUrl(u) {
  let s = String(u || '').replace(/&amp;/gi, '&').trim();
  if (!s) return '';
  s = s.replace(/\\\//g, '/').replace(/`/g, '').trim();
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return HOST + s;
  return s;
}

/* ---------------- 封面解密 ---------------- */
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
function fetchBinary(urlStr, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('图片重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: COVER_TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchBinary(new URL(res.headers.location, u.href).href, referer, redirects + 1)
          .then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: decompress(Buffer.concat(chunks), res.headers['content-encoding']),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('封面超时')); });
    req.end();
  });
}
function decryptCover(raw) {
  const plain = sniffImageMime(raw);
  if (plain) return { mime: plain, body: raw };
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', COVER_AES_KEY, COVER_AES_IV);
    const out = Buffer.concat([d.update(raw), d.final()]);
    const mime = sniffImageMime(out);
    if (mime) return { mime, body: out };
  } catch (_) {}
  return null;
}
const coverCache = new Map();
async function resolveCover(url) {
  if (!url || !COVER_INLINE) return url || '';
  if (url.startsWith('data:')) return url;
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await fetchBinary(url, `${HOST}/`);
    if (res.statusCode !== 200 || !res.body || !res.body.length) {
      coverCache.set(url, url);
      return url;
    }
    const dec = decryptCover(res.body);
    if (!dec) { coverCache.set(url, url); return url; }
    const uri = `data:${dec.mime};base64,${dec.body.toString('base64')}`;
    if (coverCache.size >= 300) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(url, uri);
    return uri;
  } catch (e) {
    logI(`[cover] 失败 ${String(url).slice(0, 70)}: ${e.message}`);
    coverCache.set(url, url);
    return url;
  }
}
async function resolveCovers(list) {
  if (!COVER_INLINE || !Array.isArray(list) || !list.length) return list;
  const targets = list.filter((v) => v && v.vod_pic && !String(v.vod_pic).startsWith('data:'));
  if (!targets.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      try { item.vod_pic = await resolveCover(item.vod_pic); } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, targets.length) }, () => worker()));
  return list;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: 'home', type_name: '首页推荐' },
  { type_id: 'hjll', type_name: '海角乱伦' },
  { type_id: 'hjcg', type_name: '海角吃瓜' },
  { type_id: 'hjth', type_name: '海角偷欢' },
  { type_id: 'hjby', type_name: '海角白嫖' },
  { type_id: 'hjdm', type_name: '海角动漫' },
  { type_id: 'hjkp', type_name: '海角看片' },
  { type_id: 'hjwh', type_name: '海角网黄' },
  { type_id: 'hjyc', type_name: '海角原创' },
  { type_id: 'hjaidj', type_name: 'AI短剧' },
  { type_id: 'lmyq', type_name: '绿帽淫妻' },
  { type_id: 'yczm', type_name: '原创自拍' },
  { type_id: 'zthj', type_name: '专题合集' },
];

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  // 卡片：<a href="/archives/{id}/" title="..."> ... <h3>...</h3> ... <img z-image-loader-url="`url`">
  const re = /<a\b[^>]*href="\/archives\/(\d+)\/"[^>]*>([\s\S]{0,1600}?)<\/a>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const block = m[2];

    const titleAttr = /\btitle="([^"]*)"/i.exec(openTag);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    let title = cleanText((titleAttr && titleAttr[1]) || (h3 && h3[1]) || '');
    if (!title) continue;
    // 过滤「回家的路」这类公告卡片
    if (/回家的路|认准官方|安全直达/.test(title)) continue;

    let pic = '';
    const imgM = /<img\b[^>]*(?:z-image-loader-url|data-src|data-original|src)="([^"]+)"/i.exec(block);
    if (imgM) pic = fixUrl(imgM[1]);

    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: '',
      vod_tag: 'video',
      vod_url: `${HOST}/archives/${id}/`,
    });
  }
  return list;
}
/**
 * 分页总数。
 * 首页有 /page/N/ 链接（实测末页 1081）；但分类/标签页是 JS 无限滚动，
 * 页面里没有分页链接，此时按「本页有内容就认为还有下一页」估算。
 */
function parsePageCount(html, fallback) {
  const s = String(html || '');
  let max = 0;
  const re = /\/page\/(\d+)\//g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (n > max && n < 100000) max = n;
  }
  if (max > 0) return max;
  const fb = Number(fallback);
  return Number.isFinite(fb) && fb > 0 ? fb : 1;
}

/**
 * 从详情页提取 DPlayer 的 video.url。
 * data-config='{...}' 是单引号包裹、内部用 \" 转义的 JSON，
 * 不能用 [^']+ 直接匹配（会在内部转义引号处截断），
 * 必须定位 data-config=' 之后、以 "'>" 作为结束标记。
 */
function parseVideoUrl(html) {
  const s = String(html || '');
  const at = s.indexOf('data-config=');
  if (at >= 0) {
    const q = s.indexOf("'", at);
    if (q >= 0) {
      const end = s.indexOf("'>", q + 1);
      if (end > q) {
        const raw = s.slice(q + 1, end);
        try {
          const cfg = JSON.parse(raw);
          const v = (cfg && cfg.video) || {};
          const u = String(v.url || '');
          if (u) return fixUrl(u);
        } catch (_) {
          // JSON 解析失败时退化为正则找 m3u8
          const mm = /"url"\s*:\s*"([^"]*\.m3u8[^"]*)"/i.exec(raw);
          if (mm) return fixUrl(mm[1]);
        }
      }
    }
  }
  // 兜底：全页找 m3u8
  const m8 = /(https?:(?:\\\/|\/){2}[^"'\s\\]+\.m3u8[^"'\s\\]*)/i.exec(s);
  if (m8) return fixUrl(m8[1]);
  return '';
}
function parseTitle(html) {
  const s = String(html || '');
  const h1 = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(s);
  if (h1) {
    const t = cleanText(h1[1]);
    if (t) return t;
  }
  const t = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(s);
  if (t) return cleanText(t[1]).replace(/\s*\|\s*海角网.*$/i, '').trim();
  return '';
}
function parseCover(html) {
  const s = String(html || '');
  const og = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i.exec(s);
  if (og && og[1] && !/social-default/i.test(og[1])) return fixUrl(og[1]);
  const img = /<img[^>]*\bz-image-loader-url="([^"]*pic\.[^"]+)"/i.exec(s);
  if (img) return fixUrl(img[1]);
  return og && og[1] ? fixUrl(og[1]) : '';
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(id) {
  const cacheKey = `hjw:detail:${id}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id) {
        // m3u8 带 auth_key 时效，检查是否临期
        const u = obj.vod_play_sources?.[0]?.episodes?.[0]?.playId || '';
        const exp = (u.match(/auth_key=(\d+)/) || [])[1];
        if (!exp || Number(exp) * 1000 > Date.now() + 60000) return obj;
      }
    }
  } catch (_) {}

  const html = await fetchHtml(`${HOST}/archives/${id}/`);
  if (!html) return null;

  const title = parseTitle(html) || `海角网 ${id}`;
  let pic = parseCover(html);
  if (pic) pic = await resolveCover(pic);

  const media = parseVideoUrl(html);
  const descM = /<meta[^>]*name="description"[^>]*content="([^"]*)"/i.exec(html);
  const content = cleanText(descM ? descM[1] : '');

  const vod = {
    vod_id: String(id),
    vod_name: title,
    vod_pic: pic,
    vod_content: content,
    vod_remarks: media ? '可播放' : '无视频',
    vod_play_sources: media ? [{ name: '海角网', episodes: [{ name: '正片', playId: media }] }] : [],
    vod_url: `${HOST}/archives/${id}/`,
  };
  if (media) {
    vod.vod_play_from = '海角网';
    vod.vod_play_url = `正片$${media}`;
  }
  // 签名有时效，缓存 10 分钟
  try { await OmniBox.setCache(cacheKey, vod, 600); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const p = params || {};
  const raw = String(p.playId || p.id || p.url || '').trim();
  logI(`play playId=${raw.slice(0, 110)} from=${(context && context.from) || 'web'}`);
  if (!raw) return { parse: 0, jx: 0, urls: [] };

  const header = { 'User-Agent': UA, Referer: `${HOST}/` };

  if (/\.(m3u8|mp4|ts)(\?|$)/i.test(raw)) {
    return { parse: 0, jx: 0, flag: '海角网', url: raw, urls: [{ name: '正片', url: raw }], header };
  }
  if (/^\d+$/.test(raw)) {
    try {
      const v = await fetchDetail(raw);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) return {
        parse: 0, jx: 0, flag: '海角网',
        url: first.playId,
        urls: [{ name: '正片', url: first.playId }],
        header,
      };
    } catch (e) { logI(`[play] 解析失败: ${e.message}`); }
  }
  return { parse: 1, jx: 0, flag: '海角网', url: raw, urls: [{ name: '正片', url: raw }], header };
}

/* ---------------- 五方法 ---------------- */
async function home(params, context) {
  try {
    logI(`home from=${(context && context.from) || 'web'}`);
    const html = await fetchHtml(`${HOST}/`);
    let list = parseList(html);
    list = await resolveCovers(list);
    logI(`home 返回 ${list.length} 条`);
    return { class: CLASSES, filters: {}, list, parse: 0, jx: 0 };
  } catch (e) {
    logE(`home 失败: ${e.message}`);
    return { class: CLASSES, filters: {}, list: [], parse: 0, jx: 0 };
  }
}

async function category(params, context) {
  const p = params || {};
  const typeId = String(p.categoryId || p.type_id || p.tid || 'home').trim();
  const page = Math.max(1, Number(p.page || 1));
  try {
    logI(`category type=${typeId} page=${page}`);
    // ⚠️ 实测分类页不支持分页：/category/{slug}/page/2/ 返回 404
    // （404 页面里仍带侧栏推荐链接，容易误判成有内容，这里显式固定单页）
    const path = typeId && typeId !== 'home'
      ? `/category/${encodeURIComponent(typeId)}/`
      : '/';
    const html = await fetchHtml(`${HOST}${path}`);
    let list = parseList(html);
    list = await resolveCovers(list);
    const pagecount = 1;
    logI(`category 返回 ${list.length} 条（分类页无分页，pagecount=1）`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    logE(`category 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.vod_id || p.id || p.videoId || '');
  logI(`detail id=${String(raw).slice(0, 80)}`);
  if (!raw) return { list: [] };
  let id = String(raw);
  const um = /\/archives\/(\d+)/i.exec(id);
  if (um) id = um[1];
  if (!/^\d+$/.test(id)) return { list: [] };
  try {
    const v = await fetchDetail(id);
    if (!v) return { list: [] };
    logI(`detail 成功: ${String(v.vod_name).slice(0, 40)}，线路 ${v.vod_play_sources.length}`);
    return { list: [v] };
  } catch (e) {
    logE(`detail 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const wd = String(p.wd || p.keyword || p.k || '').trim();
  const page = Math.max(1, Number(p.page || 1));
  logI(`search wd=${wd} page=${page}`);
  if (!wd) return { page: 1, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    let url = `${HOST}/search/${encodeURIComponent(wd)}/`;
    if (page > 1) url = `${HOST}/search/${encodeURIComponent(wd)}/page/${page}/`;
    const html = await fetchHtml(url);
    let list = parseList(html);
    list = await resolveCovers(list);
    // 搜索结果页若有 /page/N/ 链接才认多页，否则单页
    const pagecount = parsePageCount(html, 1);
    logI(`search 返回 ${list.length} 条，pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    logE(`search 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
