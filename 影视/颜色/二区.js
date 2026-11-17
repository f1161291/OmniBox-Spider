// @name 二区
// @version 1.0.0
// @author omnibox-spider
// @description 二区 OmniBox 采集源（原二区 618303.xyz + 原五区 618406.xyz 同源合并，域名轮换）：MacCMS 魔改路由，XOR128 标题混淆；列表 kd= 直连、id= cloudfront 截 /m3u8/ 换备用域、v= 直连、m= reqplay API；含 qrtuv.com 时切 61800XX.xyz 备用域名池；封面明文直出，无本地代理
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/二区.js

/**
 * ============================================================================
 * 二区 OmniBox 采集源（由同名 Python 源适配）
 * ============================================================================
 *
 * 【实站事实（2026-11-17 实测）】
 *   主站：https://618303.xyz（原二区）与 https://618406.xyz（原五区）内容字节级完全一致，
 *         两者为同一站的轮换域名 → 合并进本源，按请求轮换，分散单域名失效风险。
 *         导航页仅壳，真实内容在 /index.php/vod/type/id/{tid}.html
 *   分类：链接 /index.php/vod/type/id/{tid}.html，锚文本为 XOR128 混淆，逐字符 ^128 还原
 *   列表：<a class="vodbox" href="/html/{cat}/{混淆标题}.html?{参数}">
 *         封面 <img data-original="...">，标题 <p class="km-script">（同为 XOR128）
 *   分页：/index.php/vod/type/id/{tid}/page/{n}.html；总页数 JS 变量 totalPages='N'||1
 *   搜索：/index.php/vod/type/id/1/wd/{encodeURIComponent(key)}/page/{n}.html
 *   播放参数（列表 href 的 query，实测多种并存）：
 *     v=  直连 m3u8（一区实测为 master playlist，含 RESOLUTION=1920x1080）
 *     kd= 直连 m3u8（二区/五区实测为 IP:Port 直链；含 qrtuv.com 时换备用域名池）
 *     id= cloudfront 完整 m3u8 URL（截 /m3u8/ 之后拼 61800XX.xyz 备用域，随合并一并启用）
 *     m=  播放 API 编号 → https://h5.xxoo475.org/api/v2/vod/reqplay/{m}
 *         （实测 retcode=0，data.httpurl 为可播 m3u8；短时高频会 302/403，重试一次）
 *     b=  封面 URL（二区/五区列表未带，脚本按 Python 逻辑自动补写）
 *
 * 【与 Python 版的关键差异（适配要点）】
 *   1) Python 版起本地 HTTP 代理转发图片，但实测封面是明文图且无防盗链
 *      （不带 Referer 亦 200），OmniBox 为一次性进程不适合常驻端口，
 *      因此直接返回图片原始 URL，无需代理、无需转 data:image。
 *   2) 详情页是无内容播放器壳：detail() 不额外请求网络，直接从 vod_id 的
 *      路径段与 query 解析标题/封面/播放地址（与 Python _parse_detail 一致）。
 *   3) play() 现场把 m= 换成 httpurl 直链（等价 Python playerContent），并读取
 *      manifest；若为 master playlist，按 RESOLUTION 高度降序排列 urls，
 *      最高清晰度恒为 urls[0]（硬性约定）。
 *   4) 原始 vod_id / playId 使用 base64 包装，避免长 URL 与 CJK 混淆标题在运输中失真。
 *   5) 全部日志走 OmniBox.log；本地缺 SDK 时只写 stderr，绝不写 stdout。
 *      统一 try/catch，异常返回空结构不崩溃。
 *
 * 【环境变量】
 *   SITE_HOST                 强制指定单域名（关闭轮换），缺省时在 618303/618406 间轮换
 *   Z2_UA             自定义 User-Agent
 *   Z2_REQUEST_TIMEOUT 普通请求超时毫秒，默认 25000
 *   Z2_COVER_TIMEOUT    manifest 探测超时毫秒，默认 12000
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

const PREFIX = '[z2]';
const ENV = 'Z2';

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

function normalizeHost(value, fallback) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return fallback;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return fallback; }
}

// 原二区(618303) 与原五区(618406) 实测内容字节级一致，合并为同源域名池轮换。
// SITE_HOST 显式指定时退化为单域名（关闭轮换）；否则每次 handler 调用轮换一个域名，
// 单域名失效时下一次调用自动落到另一个，且让 vod_id 中的封面/播放链接随之更新。
const SITE_HOST = normalizeHost(process.env.SITE_HOST || '', '');
const HOST_POOL = SITE_HOST ? [SITE_HOST] : ['https://618303.xyz', 'https://618406.xyz'];
let hostCursor = Math.floor(Math.random() * HOST_POOL.length);
let HOST = HOST_POOL[hostCursor];

/** 轮换到下一个域名，返回新 HOST */
function rotateHost() {
  if (HOST_POOL.length <= 1) { HOST = HOST_POOL[0]; return HOST; }
  hostCursor = (hostCursor + 1) % HOST_POOL.length;
  HOST = HOST_POOL[hostCursor];
  return HOST;
}

const UA = process.env[`${ENV}_UA`]
  || 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const REQUEST_TIMEOUT = numEnv(`${ENV}_REQUEST_TIMEOUT`, 25000, 3000, 120000);
const PROBE_TIMEOUT = numEnv(`${ENV}_COVER_TIMEOUT`, 12000, 2000, 60000);

const PLAY_API = 'https://h5.xxoo475.org/api/v2/vod/reqplay/';
const KD_DOMAINS = Array.from({ length: 29 }, (_, i) => `61800${String(i + 11).padStart(2, '0')}`);
const CFG = {
  fixKd: true,
  fixId: true, // 合并原五区后启用：id= cloudfront 截 /m3u8/ 换备用域（kd=/v=/m= 分支不受影响）
  homeFallbackTids: [],
};

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

/** XOR128：Python _xor128 = ''.join(chr(128 ^ ord(c)) for c in s) */
function xor128(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ 128);
  return out;
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

function parseQuery(s) {
  const out = {};
  const str = String(s || '');
  const i = str.indexOf('?');
  if (i < 0) return out;
  for (const part of str.slice(i + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch (_) { out[k] = v; }
  }
  return out;
}

function encodeVid(vid) { return `v1_${Buffer.from(String(vid || ''), 'utf8').toString('base64')}`; }

function decodeVodId(id) {
  const raw = String(id || '').trim();
  if (raw.startsWith('v1_')) {
    try { return Buffer.from(raw.slice(3), 'base64').toString('utf8'); }
    catch (_) { return ''; }
  }
  if (raw.startsWith('/html/')) return raw;
  if (/^https?:\/\//i.test(raw)) {
    try { const u = new URL(raw); return decodeEntities(u.pathname + u.search); }
    catch (_) { return raw; }
  }
  return '';
}

function encodePlay(url) { return `p1_${Buffer.from(String(url || ''), 'utf8').toString('base64')}`; }

function decodePlay(id) {
  const raw = String(id || '').trim();
  if (raw.startsWith('p1_')) {
    try { return Buffer.from(raw.slice(3), 'base64').toString('utf8'); }
    catch (_) { return ''; }
  }
  return raw;
}

/** Python _fix_kd：kd 含 qrtuv.com 时随机换 6180011~6180039.xyz 备用域 */
function fixKd(kd) {
  if (!CFG.fixKd || !/qrtuv\.com/i.test(kd)) return kd;
  try {
    const u = new URL(kd);
    const path = u.pathname.replace('/video/index', '');
    const host = KD_DOMAINS[Math.floor(Math.random() * KD_DOMAINS.length)];
    return `https://${host}.xyz/dddd${path}${u.search}`;
  } catch (_) { return kd; }
}

/** Python _fix_id：cloudfront 完整 m3u8 → 截 /m3u8/ 后拼随机备用域 */
function fixId(v) {
  if (!CFG.fixId) return v;
  const idx = String(v || '').indexOf('/m3u8/');
  if (idx < 0) return v;
  const host = KD_DOMAINS[Math.floor(Math.random() * KD_DOMAINS.length)];
  return `https://${host}.xyz${String(v).slice(idx)}`;
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

async function fetchHtml(url) {
  const res = await httpRequest(fixUrl(url), {
    headers: { Referer: `${HOST}/`, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${url}`);
  return String(res.body || '');
}

// ---------------------------------------------------------------------------
// 页面解析
// ---------------------------------------------------------------------------

function parseCategories(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="\/index\.php\/vod\/type\/id\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const tid = m[1];
    const name = stripTags(decodeEntities(xor128(m[2])));
    if (!name || seen.has(tid)) continue;
    seen.add(tid);
    out.push({ type_id: tid, type_name: name });
  }
  return out;
}

function parseList(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+class="vodbox"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img\b[^>]*data-original="([^"]+)"[^>]*>[\s\S]*?<p\s+class="km-script">([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    try {
      const href = decodeEntities(m[1]).trim();
      if (!href) continue;
      let pic = decodeEntities(m[2]).trim();
      if (pic.startsWith('//')) pic = `https:${pic}`;
      const name = stripTags(decodeEntities(xor128(m[3])));
      if (!name) continue;
      let vid = href;
      if (!/^https?:\/\//i.test(vid) && !vid.startsWith('/html/')) vid = fixUrl(vid);
      // Python：列表 href 无 b= 时自行附加，供详情壳还原封面
      if (!/(?:^|[?&])b=/.test(vid)) vid += `${vid.includes('?') ? '&' : '?'}b=${encodeURIComponent(pic)}`;
      if (seen.has(vid)) continue;
      seen.add(vid);
      out.push({ vod_id: encodeVid(vid), vod_name: name, vod_pic: fixUrl(pic), vod_remarks: '' });
    } catch (_) { /* 单条失败不影响整页 */ }
  }
  return out;
}

function parsePageCount(html, page) {
  const m = String(html || '').match(/totalPages\s*=\s*['"]?(\d+)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return Math.max(1, page);
}

/** 由 vod_id（播放器壳 URL）解析标题/封面/播放目标，不额外发请求 */
function parseShell(vid) {
  let name = '';
  const path = String(vid || '').split('?')[0];
  const mm = path.match(/\/html\/[^/]+\/(.+?)\.html$/i);
  if (mm) {
    try { name = stripTags(decodeEntities(xor128(decodeURIComponent(mm[1])))); }
    catch (_) { name = stripTags(decodeEntities(xor128(mm[1]))); }
  }
  const q = parseQuery(vid);
  const pic = fixUrl(q.b || '');
  let playUrl = '';
  if (q.id) playUrl = fixId(decodeEntities(q.id));
  else if (q.kd) playUrl = fixKd(decodeEntities(q.kd));
  else if (q.v) playUrl = decodeEntities(q.v);
  else if (q.m) playUrl = `${PLAY_API}${encodeURIComponent(String(q.m).trim())}`;
  return { name, pic, playUrl, query: q };
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

async function resolveApiPlay(apiUrl) {
  let url = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await httpRequest(apiUrl, { headers: { Referer: `${HOST}/` } });
      let j = null;
      try { j = JSON.parse(String(res.body || '').replace(/^\uFEFF/, '')); } catch (_) { j = null; }
      if (j && (j.retcode === 0 || j.retcode === 3)) {
        const data = j.data || {};
        const u = String(data.httpurl || data.httpurl_preview || '').trim();
        if (u) { url = u.replace('?300', ''); break; }
      } else break;
    } catch (e) {
      log('info', `[play] API 第 ${attempt + 1} 次失败: ${(e && e.message) || e}`);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// OmniBox handlers
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    const from = (context && context.from) || 'web';
    rotateHost();
    log('info', `[home] from=${from} host=${HOST}`);
    let html = '';
    try { html = await fetchHtml(`${HOST}/index.php/vod/type/id/1.html`); }
    catch (_) {}
    let list = parseList(html);
    // 分类 1 常为空列表，按备用分类补齐首屏
    for (const tid of CFG.homeFallbackTids) {
      if (list.length) break;
      try {
        const h = await fetchHtml(`${HOST}/index.php/vod/type/id/${tid}.html`);
        const l = parseList(h);
        if (l.length) list = l;
      } catch (_) {}
    }
    const cls = parseCategories(html);
    log('info', `[home] class=${cls.length} list=${list.length}`);
    return { class: cls, list };
  } catch (e) {
    log('error', `[home] 失败: ${(e && e.message) || e}`);
    return { class: [], list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  let page = Number(p.page || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const tid = String(p.categoryId || p.typeId || p.type_id || '1').trim();
  try {
    rotateHost();
    const url = `${HOST}/index.php/vod/type/id/${encodeURIComponent(tid)}/page/${page}.html`;
    log('info', `[category] tid=${tid} page=${page} host=${HOST}`);
    let html = '';
    try { html = await fetchHtml(url); } catch (_) {}
    let list = parseList(html);
    if (!list.length && page === 1) {
      try { list = parseList(await fetchHtml(`${HOST}/index.php/vod/type/id/${encodeURIComponent(tid)}.html`)); }
      catch (_) {}
    }
    const pagecount = parsePageCount(html, page);
    log('info', `[category] list=${list.length} pagecount=${pagecount}`);
    return { list, page, pagecount, limit: 20, total: pagecount * 20, type_name: '' };
  } catch (e) {
    log('error', `[category] 失败: ${(e && e.message) || e}`);
    return { list: [], page, pagecount: 0, limit: 20, total: 0 };
  }
}

async function detail(params, context) {
  const p = params || {};
  const videoId = String(p.videoId || p.vodId || p.id || '').trim();
  if (!videoId) return { list: [] };
  try {
    const vid = decodeVodId(videoId);
    if (!vid) {
      log('error', `[detail] 无法解析 videoId=${videoId}`);
      return { list: [] };
    }
    const shell = parseShell(vid);
    const name = shell.name || stripTags(videoId);
    const playId = encodePlay(shell.playUrl);
    log('info', `[detail] name=${name} playId=${playId.slice(0, 60)}`);
    return {
      list: [{
        vod_id: videoId,
        vod_name: name,
        vod_pic: shell.pic,
        type_name: '',
        vod_year: '',
        vod_area: '',
        vod_actor: '',
        vod_director: '',
        vod_content: '',
        vod_remarks: '',
        vod_play_from: 'h5api',
        vod_play_url: `正片$${playId}`,
        vod_play_sources: [{ name: 'h5api', episodes: [{ name: '正片', playId }] }],
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
    rotateHost();
    const url = `${HOST}/index.php/vod/type/id/1/wd/${encodeURIComponent(keyword)}/page/${page}.html`;
    log('info', `[search] keyword=${keyword} page=${page} host=${HOST}`);
    let html = '';
    try { html = await fetchHtml(url); } catch (_) {}
    const list = parseList(html);
    const pagecount = parsePageCount(html, page);
    log('info', `[search] list=${list.length} pagecount=${pagecount}`);
    return { list, page, pagecount, total: pagecount * 20 };
  } catch (e) {
    log('error', `[search] 失败: ${(e && e.message) || e}`);
    return { list: [], page, pagecount: 0, total: 0 };
  }
}

async function play(params, context) {
  const p = params || {};
  const playId = String(p.playId || p.id || p.vodId || '').trim();
  const flag = String(p.flag || 'h5api');
  const header = { 'User-Agent': UA, Referer: `${HOST}/` };
  if (!playId) {
    log('error', '[play] playId 为空');
    return { urls: [], flag, header, parse: 0 };
  }
  try {
    let target = decodePlay(playId);
    if (/reqplay/i.test(target)) target = await resolveApiPlay(target);
    if (!target) {
      log('error', '[play] 未能解析播放地址');
      return { urls: [], flag, header, parse: 0 };
    }

    let manifest = '';
    try {
      const res = await httpRequest(target, { headers: header, timeout: PROBE_TIMEOUT });
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
