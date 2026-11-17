// @name 七区
// @version 1.0.0
// @author omnibox-spider
// @description 七区 / 沉浸式短剧剧场（618603.xyz）OmniBox 采集源：MacCMS art 路由，站点封面 AES-128-CBC 加密，脚本内解密为 data:image；详情 episodes 数组提取 m3u8，按 RESOLUTION 高度降序取最高清晰度；无本地代理
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/七区.js

/**
 * ============================================================================
 * 七区 / 沉浸式短剧剧场 OmniBox 采集源（由同名 Python 源适配）
 * ============================================================================
 *
 * 【实站事实（2026-11-17 实测）】
 *   主站：https://618603.xyz （首页为壳，真实内容 /index.php/art/type/id/{tid}.html）
 *   分类：4=全部 / 30=AI成人视频 / 31=AI成人短剧 / 51=AI成人漫剧（锚文本明文）
 *   列表：<a href="/index.php/art/detail/id/{n}.html" class="flex flex-col group">
 *           封面 <img data-original="https://new2.drleao.cn/....jpg.webp">（AES 密文）
 *           集数 <span ...>完结 · 1集</span>，标题 <h3>...</h3>
 *   分页：/index.php/art/type/id/{tid}/page/{n}.html；totalPages=parseInt('62',10)||1
 *   搜索：/index.php/art/type/id/4/wd/{encodeURIComponent(key)}/page/{n}.html
 *   详情：/index.php/art/detail/id/{n}.html，<h1> 标题；播放器数据 JS：
 *         const episodes = [{"number":"...cloudfront.net/....m3u8","title":"全1集"}]
 *         另有兜底路由 /html/duanju.html?vk={m3u8}&k={标题}-{集名}
 *   封面加密：AES-128-CBC + PKCS7，KEY=f5d965df75336270，IV=97b60394abc2fbe1
 *             （站点自身 JS 与 Python 源一致；实测密文 229824B → 明文 229818B 合法 WebP）
 *
 * 【与 Python 版的关键差异（适配要点）】
 *   1) Python 用本地 HTTP 代理 + 后台线程预热解密封面；OmniBox 是一次性进程，
 *      改为在解析列表/详情时直接抓二进制 → Node crypto AES-128-CBC 解密 →
 *      嗅探图片类型 → 输出 data:image/...;base64,...（并发受控），无常驻端口。
 *      解密失败自动回退原始 URL，单张失败不影响整页。
 *   2) play() 对 episodes 里的 m3u8 读取 manifest；若为 master playlist，
 *      按 RESOLUTION 高度降序排列 urls，最高清晰度恒为 urls[0]（硬性约定）。
 *   3) 全部日志走 OmniBox.log；本地缺 SDK 时只写 stderr，绝不写 stdout。
 *      统一 try/catch，异常返回空结构不崩溃。
 *
 * 【环境变量】
 *   SITE_HOST                 站点地址，默认 https://618603.xyz
 *   Z7_UA                     自定义 User-Agent
 *   Z7_REQUEST_TIMEOUT        普通请求超时毫秒，默认 25000
 *   Z7_COVER_DISABLE          设 1 关闭封面解密（回退原 URL，仅排障用）
 *   Z7_COVER_TIMEOUT          封面抓取超时毫秒，默认 12000
 *   Z7_COVER_CONCURRENCY      封面并发数，默认 4
 * ============================================================================
 */

'use strict';

let OmniBox;
let HAS_SDK = false;
try {
  OmniBox = require('omnibox_sdk');
  HAS_SDK = !!(OmniBox && typeof OmniBox.log === 'function');
} catch (_) {
  OmniBox = {};
}
let runner;
try { runner = require('spider_runner'); } catch (_) { runner = { run() {} }; }

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const PREFIX = '[z7]';
const ENV = 'Z7';

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
  if (!raw) return 'https://618603.xyz';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return 'https://618603.xyz'; }
}

const HOST = normalizeHost(process.env.SITE_HOST || '');
const UA = process.env[`${ENV}_UA`]
  || 'Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const REQUEST_TIMEOUT = numEnv(`${ENV}_REQUEST_TIMEOUT`, 25000, 3000, 120000);
const COVER_DISABLE = /^(1|true|yes)$/i.test(process.env[`${ENV}_COVER_DISABLE`] || '');
const COVER_TIMEOUT = numEnv(`${ENV}_COVER_TIMEOUT`, 12000, 2000, 60000);
const COVER_CONCURRENCY = numEnv(`${ENV}_COVER_CONCURRENCY`, 4, 1, 12);
const IMG_KEY = Buffer.from('f5d965df75336270', 'utf8');
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'utf8');

const JUNK = new Set([
  '首页', '登录', '注册', '搜索', '下载', '更多好址', '最新地址', '最多观看', '最多喜欢',
  '最多点赞', '最多评论', '最长时间', '最新更新', '排行', '全部', '下一页', '上一页',
  '二维码', '返回', '详情', '展开', '更多', '菜单', '关于',
]);
const DEFAULT_CATEGORIES = [
  { type_id: '4', type_name: '全部' },
  { type_id: '30', type_name: 'AI成人视频' },
  { type_id: '31', type_name: 'AI成人短剧' },
  { type_id: '51', type_name: 'AI成人漫剧' },
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

function safeName(s) {
  return stripTags(s).replace(/\$/g, ' ').replace(/#/g, ' ').trim();
}

function badName(s) {
  const n = stripTags(s);
  if (!n || n.includes('{') || n.includes('search_term_string')) return true;
  return JUNK.has(n);
}

function fixUrl(u, base) {
  if (!u) return '';
  const s = decodeEntities(String(u)).trim();
  if (s.startsWith('//')) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try { return new URL(s, base || `${HOST}/`).href; }
  catch (_) { return `${HOST}/${s.replace(/^\/+/, '')}`; }
}

function encodeId(url) { return `q7_${Buffer.from(String(url || ''), 'utf8').toString('base64')}`; }

function decodeId(id) {
  const raw = String(id || '').trim();
  if (raw.startsWith('q7_')) {
    try { return Buffer.from(raw.slice(3), 'base64').toString('utf8'); }
    catch (_) { return ''; }
  }
  return raw;
}

/** 原生 http/https：跟随重定向、解压 gzip/deflate/br，可返回 Buffer */
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
        const finish = (buf) => resolve({
          statusCode: code,
          headers: res.headers || {},
          body: options.binary ? buf : buf.toString('utf8'),
        });
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

async function fetchHtml(url, base) {
  const res = await httpRequest(fixUrl(url, base), {
    headers: { Referer: `${HOST}/`, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${url}`);
  return String(res.body || '');
}

// ---------------------------------------------------------------------------
// 封面：AES-128-CBC 解密 → data URI
// ---------------------------------------------------------------------------

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function decryptCover(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (sniffImageType(buf)) return { mime: sniffImageType(buf), body: buf }; // 本来就是明文
  if (buf.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV);
    const out = Buffer.concat([decipher.update(buf), decipher.final()]); // 自动去 PKCS7
    const mime = sniffImageType(out);
    return mime ? { mime, body: out } : null;
  } catch (_) { return null; }
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
    const decoded = decryptCover(res.body);
    if (!decoded) {
      coverCache.set(url, url);
      return url;
    }
    const dataUri = `data:${decoded.mime};base64,${decoded.body.toString('base64')}`;
    coverCache.set(url, dataUri);
    return dataUri;
  } catch (e) {
    log('info', `[cover] 解密失败，回退原 URL: ${String(url).slice(0, 110)} (${(e && e.message) || e})`);
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

function parseCategories(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="\/index\.php\/art\/type\/id\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const tid = m[1];
    const name = safeName(m[2]);
    if (!name || badName(name) || seen.has(tid)) continue;
    seen.add(tid);
    out.push({ type_id: tid, type_name: name });
  }
  return out.length ? out : DEFAULT_CATEGORIES;
}

function pickPic(frag, base) {
  const s = String(frag || '').replace(/<!--[\s\S]*?-->/g, '');
  const m = s.match(/<img\b[^>]*?(?:data-original|data-original-src|data-background|data-src|poster|src)\s*=\s*["']([^"']+)["']/i)
    || s.match(/background-image\s*:\s*url\((["']?)([^"')]+)\1\)/i);
  if (!m) return '';
  const u = (m[2] || m[1] || '').trim();
  if (!u || /loading|placeholder|blank|noimage|static\/.*images/i.test(u)) return '';
  return fixUrl(u, base);
}

function parseCards(html, pageUrl) {
  const out = [];
  const seen = new Set();
  // 详情链接含 /art/detail/id/N.html 或 /id/N.html（Python _is_detail 等价）
  const re = /<a\b[^>]*href="([^"]*(?:\/art\/detail\/id\/\d+|id\/\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    try {
      const href = m[1];
      if (/\/type\/id\//i.test(href)) continue;
      const detailUrl = fixUrl(href, pageUrl);
      if (seen.has(detailUrl)) continue;
      const block = m[0];
      let name = '';
      const h = block.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
      if (h) name = safeName(h[1]);
      if (!name) name = safeName((block.match(/title\s*=\s*["']([^"']+)["']/i) || [])[1] || '');
      if (!name) name = safeName(block.replace(/^<a[^>]*>/, '').replace(/<\/a>$/, ''));
      if (badName(name)) continue;
      const pic = pickPic(block, pageUrl);
      const rem = safeName((block.match(/<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '');
      seen.add(detailUrl);
      out.push({
        vod_id: encodeId(detailUrl),
        vod_name: name,
        vod_pic: pic,
        vod_remarks: badName(rem) ? '' : rem,
      });
    } catch (_) { /* 单条失败不影响整页 */ }
  }
  return out;
}

function parsePageCount(html, page) {
  let m = String(html || '').match(/totalPages\s*=\s*parseInt\(\s*['"]?(\d+)/i)
    || String(html || '').match(/totalPages\s*=\s*(\d+)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return Math.max(1, page);
}

function pageTitle(html) {
  const m = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  let t = stripTags(m[1]);
  if (m[0].toLowerCase().includes('<title')) {
    for (const sep of [' - ', '–', '_', '|']) {
      if (t.includes(sep)) { t = t.split(sep)[0].trim(); break; }
    }
  }
  return t;
}

function description(html) {
  let m = String(html || '').match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([\s\S]*?)["']/i)
    || String(html || '').match(/<meta[^>]+content\s*=\s*["']([\s\S]*?)["'][^>]*name\s*=\s*["']description["']/i);
  if (m) return stripTags(m[1]);
  m = String(html || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? stripTags(m[1]) : '';
}

function isMedia(u) {
  return /^https?:\/\//i.test(String(u || '')) && /\.(?:m3u8|mp4)(?:\?|$)/i.test(String(u));
}

/** 还原 base64 / URL 编码的播放地址（Python _decode_url） */
function decodeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  for (let i = 0; i < 3; i++) {
    if (isMedia(s) || /^https?:\/\//i.test(s)) return s;
    let s2 = '';
    try { s2 = decodeURIComponent(s); } catch (_) { s2 = ''; }
    if (s2 && s2 !== s) { s = s2.trim(); continue; }
    try {
      s2 = Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64').toString('utf8').trim();
    } catch (_) { s2 = ''; }
    if (s2 && s2 !== s) { s = s2; continue; }
    break;
  }
  return s;
}

/** 从详情页提取播放线路：episodes 数组 / player_JS / 直链 / 播放页链接 */
function extractLines(html, pageUrl) {
  const lines = [];
  const seenUrl = new Set();
  const push = (name, url) => {
    if (!url || seenUrl.has(url)) return;
    seenUrl.add(url);
    lines.push({ name: safeName(name) || `第${lines.length + 1}集`, playId: encodeId(url) });
  };

  // 1) const episodes = [{"number":"...m3u8","title":"全1集"}, ...]
  const epBlocks = String(html || '').match(/episodes\s*=\s*(\[[\s\S]*?\])/gi) || [];
  for (const blk of epBlocks) {
    let arr = null;
    try { arr = JSON.parse(blk.replace(/^episodes\s*=\s*/i, '')); } catch (_) { arr = null; }
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const u = decodeUrl(it.number || it.url || it.m3u8 || it.link || '');
      if (u) push(it.title || it.name || '正片', fixUrl(u, pageUrl));
    }
  }

  // 2) player_xxx = { url: '...', flag: '...', name: '...' }
  const t = String(html || '').replace(/\\\//g, '/');
  for (const m of t.matchAll(/player_[a-zA-Z0-9_]+\s*=\s*(\{[\s\S]*?\})\s*;/g)) {
    let j = null;
    try { j = JSON.parse(m[1]); } catch (_) {
      try { j = JSON.parse(m[1].replace(/'/g, '"')); } catch (_) { j = null; }
    }
    if (!j || typeof j !== 'object') continue;
    const u = decodeUrl(j.url || '');
    if (!u) continue;
    push(j.flag || j.from || '线路', fixUrl(u, pageUrl));
  }

  // 3) 页面内直链 m3u8/mp4
  for (const m of t.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi)) {
    push('正片', fixUrl(m[0].trim(), pageUrl));
  }

  // 4) /html/duanju.html?vk={m3u8} 之类播放路由
  for (const m of String(html || '').matchAll(/href="([^"]*\/html\/[^"?]+\?[^"]*vk=[^"&]+[^"]*)"/gi)) {
    let href = m[1].replace(/&amp;/g, '&');
    const vk = (href.match(/[?&]vk=([^&]+)/) || [])[1] || '';
    const u = decodeUrl(vk);
    if (u) push((href.match(/[?&]k=([^&]+)/) || [])[1] || '正片', fixUrl(u, pageUrl));
  }
  return lines;
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
    try { absolute = new URL(uri, masterUrl).href; } catch (_) { absolute = fixUrl(uri, masterUrl); }
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

// ---------------------------------------------------------------------------
// OmniBox handlers
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    const from = (context && context.from) || 'web';
    log('info', `[home] from=${from}`);
    let html = '';
    try { html = await fetchHtml(`${HOST}/index.php/art/type/id/4.html`); }
    catch (_) { try { html = await fetchHtml(`${HOST}/`); } catch (_) {} }
    let list = parseCards(html, `${HOST}/`);
    if (!list.length) {
      try { list = parseCards(await fetchHtml(`${HOST}/index.php/art/type/id/30.html`), `${HOST}/`); }
      catch (_) {}
    }
    const cls = parseCategories(html);
    const out = await resolveCovers(list);
    log('info', `[home] class=${cls.length} list=${out.length}`);
    return { class: cls, list: out };
  } catch (e) {
    log('error', `[home] 失败: ${(e && e.message) || e}`);
    return { class: DEFAULT_CATEGORIES, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  let page = Number(p.page || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const tid = String(p.categoryId || p.typeId || p.type_id || '4').trim();
  try {
    const urls = page === 1
      ? [`${HOST}/index.php/art/type/id/${tid}.html`]
      : [
          `${HOST}/index.php/art/type/id/${tid}/page/${page}.html`,
          `${HOST}/index.php/art/type/id/${tid}.html?page=${page}`,
        ];
    let html = '';
    let used = '';
    for (const u of urls) {
      try {
        const h = await fetchHtml(u);
        if (h) { html = h; used = u; break; }
      } catch (_) {}
    }
    const list = await resolveCovers(parseCards(html, used || `${HOST}/`));
    const pagecount = parsePageCount(html, page);
    log('info', `[category] tid=${tid} page=${page} list=${list.length} pagecount=${pagecount}`);
    return { list, page, pagecount, limit: 30, total: pagecount * 30, type_name: '' };
  } catch (e) {
    log('error', `[category] 失败: ${(e && e.message) || e}`);
    return { list: [], page, pagecount: 0, limit: 30, total: 0 };
  }
}

async function detail(params, context) {
  const p = params || {};
  const videoId = String(p.videoId || p.vodId || p.id || '').trim();
  if (!videoId) return { list: [] };
  try {
    const url = fixUrl(decodeId(videoId));
    if (!/^https?:\/\//i.test(url)) return { list: [] };
    const html = await fetchHtml(url, `${HOST}/`);
    const name = pageTitle(html) || '未知';
    const pic = await resolveCover(pickPic(html, url));
    const lines = extractLines(html, url);
    const good = lines.filter((x) => x.playId);
    const playFrom = good.map((x) => x.name).join('$$$') || '线路1';
    const playUrl = good.length
      ? good.map((x) => `${x.name}$${x.playId}`).join('#')
      : `正片$${encodeId(url)}`;
    log('info', `[detail] name=${name} lines=${good.length}`);
    return {
      list: [{
        vod_id: videoId,
        vod_name: safeName(name),
        vod_pic: pic,
        type_name: '',
        vod_year: '',
        vod_area: '',
        vod_actor: '',
        vod_director: '',
        vod_content: safeName(description(html)),
        vod_remarks: good.length ? '' : '需解析',
        vod_play_from: playFrom,
        vod_play_url: playUrl,
      }],
    };
  } catch (e) {
    log('error', `[detail] 失败: ${(e && e.message) || e}`);
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
    const url = `${HOST}/index.php/art/type/id/4/wd/${encodeURIComponent(keyword)}/page/${page}.html`;
    log('info', `[search] keyword=${keyword} page=${page}`);
    let html = '';
    try { html = await fetchHtml(url); } catch (_) {}
    const list = await resolveCovers(parseCards(html, `${HOST}/`));
    const pagecount = parsePageCount(html, page);
    log('info', `[search] list=${list.length} pagecount=${pagecount}`);
    return { list, page, pagecount, total: pagecount * 30 };
  } catch (e) {
    log('error', `[search] 失败: ${(e && e.message) || e}`);
    return { list: [], page, pagecount: 0, total: 0 };
  }
}

async function play(params, context) {
  const p = params || {};
  const playId = String(p.playId || p.id || p.vodId || '').trim();
  const flag = String(p.flag || '线路1');
  const header = { 'User-Agent': UA, Referer: `${HOST}/`, 'Accept-Encoding': 'identity' };
  if (!playId) {
    log('error', '[play] playId 为空');
    return { urls: [], flag, header, parse: 0 };
  }
  try {
    let target = decodeId(playId);
    if (!target) return { urls: [], flag, header, parse: 0 };
    // 非直链（如播放页）→ 现场抓页面提直链
    if (!isMedia(target)) {
      try {
        const html = await fetchHtml(target, `${HOST}/`);
        const lines = extractLines(html, target);
        if (lines.length) target = decodeId(lines[0].playId);
      } catch (_) {}
    }
    if (!isMedia(target)) {
      log('error', `[play] 未取得媒体直链: ${target.slice(0, 120)}`);
      return { urls: [], flag, header, parse: 1, url: target };
    }

    let manifest = '';
    try {
      const res = await httpRequest(target, { headers: header, timeout: COVER_TIMEOUT });
      if (res.statusCode === 200) manifest = String(res.body || '');
    } catch (_) {}

    let urls;
    const variants = parseMasterVariants(manifest, target);
    if (variants.length) {
      urls = variants.map((v) => ({ name: v.name, url: v.url }));
      log('info', `[play] 多码率按高度降序: ${urls.map((u) => u.name).join(',')}`);
    } else {
      urls = [{ name: '正片', url: target }];
    }
    log('info', `[play] urls=${urls.length} first=${urls[0].url.slice(0, 110)} live=${manifest.trim().startsWith('#EXTM3U')}`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log('error', `[play] 失败: ${(e && e.message) || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
