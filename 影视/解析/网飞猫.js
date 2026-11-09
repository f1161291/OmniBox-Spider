/**
 * @name 网飞猫
 * @version 1.1.2
 * @author omnibox-spider
 * @description 网飞猫（ncat22.com / ncat1.app）OmniBox Spider：cdndefend 850 JS 挑战动态解算 + 封面改用 RDUL 资源域名（主站 /vod1 图片 403）+ 前台 /channel /show /detail /play /search 全链路 + 实时搜索 t token + live 筛选 href + playSource 直链解析 + 三段式播放兜底 + 页面级缓存
 * @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/解析/网飞猫.js
 * @dependencies []
 */

// 【环境变量】
//  SITE_API            主站基址，默认 https://www.ncat22.com（复用通用采集站变量）
//  SITE_HOSTS          逗号分隔备用基址（沿用仓库既有容灾变量）
//  SITE_UA             自定义 User-Agent（可选）
//  SITE_COOKIE         站点额外 Cookie（可选，勿与 JS 挑战 cookie 混用）
//  SITE_TIMEOUT        单请求超时毫秒，默认 12000
//  SITE_CACHE_TTL      home/category/search/detail HTML 缓存秒数，默认 600
//  SITE_COOKIE_TTL     JS 挑战 cookie 缓存秒数，默认 1800
//  SITE_SEARCH_TOKEN_TTL 搜索 token 缓存秒数，默认 300
//  SITE_PLAY_MODE      auto | direct | sniff | parse，默认 auto
//  SITE_IMG_HOST       封面资源域名，默认从站点 rdul.js 动态读取并自动测速选活（可手动覆盖）
//  SITE_IMG_HOSTS      逗号分隔的封面资源域名候选（优先于自动发现）
//  SITE_IMG_PROXY      可选：封面代理前缀，最终 URL = 前缀 + 原始图片 URL（兜底用）
//  FLARESOLVERR_URL / SITE_FLARESOLVERR_URL  可选：850 挑战解算失败时的 FlareSolverr 兜底（有值才启用）
//  SITE_FLARE_TTL      FlareSolverr 页面缓存秒数，默认 3600

let OmniBox;
try {
  OmniBox = require('omnibox_sdk');
} catch (_) {
  OmniBox = {
    log(l, m) { console.log(`[${l}] ${m}`); },
    getCache() { return null; },
    setCache() { return Promise.resolve(); },
    deleteCache() { return Promise.resolve(); },
  };
}
let runner;
try {
  runner = require('spider_runner');
} catch (_) {
  runner = { run() {} };
}

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');

const PREFIX = '[网飞猫]';
const KEY_PREFIX = 'ncatv1';
const DEFAULT_HOST = 'https://www.ncat22.com';
const USER_AGENT = process.env.SITE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const EXTRA_COOKIE = String(process.env.SITE_COOKIE || '').trim();
const TIMEOUT = Number(process.env.SITE_TIMEOUT || 12000);
const CACHE_TTL = Number(process.env.SITE_CACHE_TTL || 600);
const JS_COOKIE_TTL = Number(process.env.SITE_COOKIE_TTL || 1800);
const SEARCH_TOKEN_TTL = Number(process.env.SITE_SEARCH_TOKEN_TTL || 300);
const PLAY_MODE = String(process.env.SITE_PLAY_MODE || 'auto').toLowerCase();
const FLARE_URL = String(process.env.SITE_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '').trim().replace(/\/+$/, '');
const FLARE_TTL = Number(process.env.SITE_FLARE_TTL || 3600);
const PLACEHOLDER_RE = /logo_placeholder|noneCoverImg|vkcyvs\.cn\/vod_pc_static_ncat\/images\/p\//i;
// 主站 www.ncat22.com 对 /vod1/... 图片请求直接 403（带 850 挑战 cookie 也一样）。
// 真实封面挂站点 rdul.js 的 window.RDUL 资源域名（vres.wkcyvs.cn 等），裸请求即 200。
const DEFAULT_IMG_HOSTS = ['https://vres.wkcyvs.cn', 'https://103.39.111.180:51050', 'https://103.39.111.184:51050'];
const IMG_HOST_OVERRIDE = normalizeHost(process.env.SITE_IMG_HOST || '');
const IMG_HOSTS_OVERRIDE = String(process.env.SITE_IMG_HOSTS || '').split(',').map(normalizeHost).filter(Boolean);
const IMG_PROXY = String(process.env.SITE_IMG_PROXY || '').trim().replace(/\/+$/, '');
// 同步默认值保证首屏立刻可用；后台再从 rdul.js 探测并更新为最快可用域名。
let ACTIVE_IMG_HOST = IMG_HOST_OVERRIDE || IMG_HOSTS_OVERRIDE[0] || DEFAULT_IMG_HOSTS[0];
let IMG_HOST_INITED = false;

function normalizeHost(s) {
  let v = String(s || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}
const SITE_API = normalizeHost(process.env.SITE_API || DEFAULT_HOST);
const HOSTS = Array.from(new Set([
  SITE_API,
  ...String(process.env.SITE_HOSTS || '').split(',').map(normalizeHost).filter(Boolean),
])).filter(Boolean);
const CONFIG_HOSTS = HOSTS.slice();
let PREFERRED = 0;
let LANDED_HOST = '';

const CLASS_LIST = [
  { type_id: '1', type_name: '电影' },
  { type_id: '2', type_name: '连续剧' },
  { type_id: '3', type_name: '动漫' },
  { type_id: '4', type_name: '综艺纪录' },
  { type_id: '6', type_name: '短剧' },
];

// /show/{id}-{type}-{area}-{lang}-{year}-{sort}-{page}.html
// 站点真实 href 里中文值是 URL 编码后的，这里按段拼装后统一 encodeURIComponent。
const FILTER_KEYS = ['type', 'area', 'lang', 'year', 'sort', 'page'];
const SORT_OPTIONS = ['综合', '最新', '最热', '评分'];
const ALL_MARK = ['全部', '不限', '所有', ''];
const runtimeHosts = HOSTS.slice();
const hostFail = new Map();
let JS_COOKIE = '';
let JS_COOKIE_PREFIX = '';
const pageMemCache = new Map();
const tokenMemCache = new Map();

function logI(m) { try { OmniBox.log('info', `${PREFIX} ${m}`); } catch (_) {} }
function logE(m) { try { OmniBox.log('error', `${PREFIX} ${m}`); } catch (_) {} }

function hostScope() { return CONFIG_HOSTS.join(',') + (LANDED_HOST ? '|' + LANDED_HOST : ''); }
function buildCacheKey(prefix, raw) {
  const s = String(raw || '');
  if (Buffer.byteLength(s, 'utf8') <= 120) return `${KEY_PREFIX}:${hostScope()}:${prefix}:${s}`;
  return `${KEY_PREFIX}:${hostScope()}:${prefix}:${crypto.createHash('sha1').update(s).digest('hex').slice(0, 28)}`;
}
async function cacheGetJson(prefix, raw) {
  const key = buildCacheKey(prefix, raw);
  try {
    const v = await OmniBox.getCache(key);
    if (v == null) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) { return null; }
}
async function cacheSetJson(prefix, raw, val, ttl) {
  try { await OmniBox.setCache(buildCacheKey(prefix, raw), JSON.stringify(val), ttl || CACHE_TTL); } catch (_) {}
}
function memGet(map, key, ttlMs) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > ttlMs) { map.delete(key); return null; }
  return hit.v;
}
function memSet(map, key, val, cap = 120) {
  map.set(key, { t: Date.now(), v: val });
  while (map.size > cap) map.delete(map.keys().next().value);
}

// ============================== HTTP 基础层 ==============================
function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) { return buf; }
  return buf;
}
function httpRequestRaw(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`非法 URL: ${urlStr}`)); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      ...(EXTRA_COOKIE || JS_COOKIE ? { Cookie: [EXTRA_COOKIE, JS_COOKIE].filter(Boolean).join('; ') } : {}),
      ...(options.headers || {}),
    };
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || TIMEOUT,
      rejectUnauthorized: false,
      servername: u.hostname,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(statusCode) && loc && redirectCount < 5) {
          let next;
          try { next = new URL(loc, u.href).href; } catch (_) { next = ''; }
          if (next) return httpRequestRaw(next, options, redirectCount + 1).then(resolve).catch(reject);
        }
        const raw = Buffer.concat(chunks);
        const bodyBuf = decompress(raw, res.headers['content-encoding']);
        resolve({ statusCode, headers: res.headers, body: bodyBuf.toString('utf8'), finalUrl: u.href });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时 ${TIMEOUT}ms`)); });
    req.on('error', (e) => reject(e));
    if (options.body != null) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}
async function postJson(urlStr, payload) {
  return httpRequestRaw(urlStr, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
    timeout: Math.max(TIMEOUT, 65000),
  });
}

// ============================== cdndefend 850 挑战 ==============================
function isChallenge(status, body) {
  const text = String(body || '').slice(0, 8000);
  return status === 850 || /Protected by cdndefend|cdndefend_js_cookie/i.test(text);
}

// 挑战页内联脚本形态：
//   const a0_0xXXXX=['PREFIX','cdndefend_js_cookie=','array'];
//   (function(arr,n){rotate(++n)})(a0_0xXXXX,0x178);
//   c = arr[2]; n1 = parseInt('0x'+c[0]); 循环 sha1(c+i) 命中 digest[n1]==0xb0 && digest[n1+1]==0xb
// 前缀每次挑战都不同，必须从当次 HTML 动态提取，绝不写死。
function solveJsChallenge(html) {
  const t = String(html || '');
  const m = t.match(/const\s+(a0_0x[\w]+)\s*=\s*\[([^\]]+)\]/);
  if (!m) return '';
  const name = m[1];
  const vals = (m[2].match(/'([^']*)'|"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
  if (vals.length < 3) return '';
  const rot = t.match(new RegExp('\\}\\(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',\\s*(0x[0-9a-fA-F]+|[0-9]+)\\)'));
  const n = rot ? Number(rot[1]) : 0x178;
  const arr = vals.slice();
  for (let k = 0; k < n; k++) arr.push(arr.shift());
  const cookiePrefix = arr.find((x) => /cdndefend_js_cookie=/i.test(x)) || 'cdndefend_js_cookie=';
  const c = arr[2] || '';
  if (!/^[0-9A-Fa-f]{20,}$/.test(c)) return '';
  const n1 = parseInt('0x' + c[0], 16);
  if (!Number.isFinite(n1)) return '';
  for (let i = 0; i < 3000000; i++) {
    const d = crypto.createHash('sha1').update(c + String(i)).digest();
    if (d[n1] === 0xb0 && d[n1 + 1] === 0xb) return `${cookiePrefix}${c}${i}`;
  }
  return '';
}

// 兼容 6661.js 的 vm 沙箱形态：若站点未来换成 document.cookie=... 直写，仍可捕获。
function evaluateInlineChallenge(html) {
  try {
    const sandbox = {
      document: {
        _c: '',
        get cookie() { return this._c; },
        set cookie(v) { this._c = String(v).split(';')[0]; },
        write() {}, writeln() {}, getElementById() { return { style: {}, set src(v) {} }; },
      },
      location: { reload() {}, href: '' },
      window: null, navigator: { userAgent: USER_AGENT },
      setTimeout() { return 1; }, setInterval() { return 1; },
      String, Number, Array, Object, JSON, Math, Date, RegExp, parseInt, parseFloat, isNaN,
      console: { log() {} },
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext('var window=this,self=this,globalThis=this,document=this.document,location=this.location,navigator=this.navigator;', ctx);
    const tags = String(html || '').match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const tag of tags) {
      if (/\bsrc\s*=/i.test(tag)) continue;
      const code = (tag.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i) || [])[1] || '';
      try { vm.runInContext(code, ctx, { timeout: 1200 }); } catch (_) {}
    }
    return sandbox.document._c || '';
  } catch (_) { return ''; }
}

async function loadJsCookie() {
  const mem = memGet(pageMemCache, '__js_cookie__', JS_COOKIE_TTL * 1000);
  if (mem) return mem;
  const cached = await cacheGetJson('js_cookie', 'cdndefend');
  if (cached && cached.value) {
    JS_COOKIE = cached.value;
    memSet(pageMemCache, '__js_cookie__', cached.value);
    return cached.value;
  }
  return '';
}
async function saveJsCookie(cookie) {
  JS_COOKIE = cookie;
  JS_COOKIE_PREFIX = cookie.split('=')[0] || '';
  memSet(pageMemCache, '__js_cookie__', cookie);
  await cacheSetJson('js_cookie', 'cdndefend', { value: cookie, ts: Date.now() }, JS_COOKIE_TTL);
}
async function ensureCookie() {
  if (!JS_COOKIE) await loadJsCookie();
  return JS_COOKIE;
}

// FlareSolverr 只作兜底：返回绕过后的整页，按 URL 缓存，不缓存 cookie 再自建请求重试。
async function flareGetPage(targetUrl) {
  if (!FLARE_URL) return null;
  const cached = await cacheGetJson('flare_page', targetUrl);
  if (cached && cached.body) {
    logI(`[cf] 命中页面缓存: ${targetUrl} body长度=${String(cached.body).length}`);
    return cached;
  }
  try {
    const res = await postJson(FLARE_URL, { cmd: 'request.get', url: targetUrl, maxTimeout: 60000 });
    const data = JSON.parse(res.body || '{}');
    const sol = data && data.solution;
    if (data.status !== 'ok' || !sol || !sol.response) {
      logE(`[cf] FlareSolverr 绕过失败: status=${data.status} message=${data.message || ''}`);
      return null;
    }
    const out = { body: String(sol.response), statusCode: Number(sol.status) || 200, headers: sol.headers || {}, finalUrl: targetUrl };
    logI(`[cf] FlareSolverr 已直接返回页面: ${targetUrl} status=${out.statusCode} body长度=${out.body.length}`);
    await cacheSetJson('flare_page', targetUrl, out, FLARE_TTL);
    logI(`[cf] 已缓存页面: ${targetUrl} TTL=${FLARE_TTL}`);
    return out;
  } catch (e) {
    logE(`[cf] FlareSolverr 请求异常: ${e.message}`);
    return null;
  }
}

async function requestWithCookie(url, options = {}) {
  await ensureCookie();
  let res;
  try { res = await httpRequestRaw(url, options); }
  catch (e) { return { statusCode: 0, body: '', headers: {}, finalUrl: url, error: e.message }; }
  if (!isChallenge(res.statusCode, res.body)) return res;
  logI(`[js] 检测到 cdndefend 850 挑战: ${url} status=${res.statusCode}`);
  let cookie = solveJsChallenge(res.body) || evaluateInlineChallenge(res.body);
  if (cookie) {
    logI(`[js] 已解算挑战 cookie: ${cookie.slice(0, 80)}...`);
    await saveJsCookie(cookie);
    try {
      const retry = await httpRequestRaw(url, { ...options, headers: { ...(options.headers || {}), Cookie: [EXTRA_COOKIE, cookie].filter(Boolean).join('; ') } });
      if (!isChallenge(retry.statusCode, retry.body)) { logI(`[js] 带 cookie 重试成功: status=${retry.statusCode} body长度=${String(retry.body).length}`); return retry; }
      logE(`[js] 带 cookie 重试仍为挑战页 status=${retry.statusCode}`);
    } catch (e) { logE(`[js] 带 cookie 重试异常: ${e.message}`); }
  } else {
    logE('[js] 挑战解算失败：未从当次 HTML 提取到有效前缀');
  }
  const flare = await flareGetPage(url);
  if (flare) return flare;
  return res;
}

// ============================== HTML 页面级缓存 ==============================
async function fetchHtml(pathOrUrl, label, ttl) {
  // ttl === 0 明确表示「不缓存」，播放页等动态链路用：不能回落到 CACHE_TTL。
  const noCache = Number(ttl) === 0;
  const effTTL = noCache ? 0 : (Number(ttl) || CACHE_TTL);
  const isAbs = /^https?:\/\//i.test(pathOrUrl);
  const cacheKey = isAbs ? pathOrUrl : `${hostScope()}|${pathOrUrl}`;
  const memKey = buildCacheKey('page', cacheKey);
  const memTTL = Math.min(effTTL, 300) * 1000;
  if (noCache) pageMemCache.delete(memKey);
  if (!noCache) {
    const hit = memGet(pageMemCache, memKey, memTTL);
    if (hit && hit.body) { logI(`[cache] 进程内命中 ${label} body长度=${String(hit.body).length}`); return hit; }
    const cached = await cacheGetJson('page', cacheKey);
    if (cached && cached.body) {
      memSet(pageMemCache, memKey, cached);
      logI(`[cache] SDK 命中 ${label} body长度=${String(cached.body).length}`);
      return cached;
    }
  }
  const hosts = [];
  for (let i = 0; i < runtimeHosts.length; i++) hosts.push(runtimeHosts[(PREFERRED + i) % runtimeHosts.length]);
  let lastErr = '';
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    const url = isAbs ? pathOrUrl : host + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
    const res = await requestWithCookie(url, { timeout: TIMEOUT });
    if (res.error) lastErr = res.error;
    if (res.body && !isChallenge(res.statusCode, res.body) && res.statusCode >= 200 && res.statusCode < 400) {
      const out = { body: res.body, statusCode: res.statusCode, headers: res.headers || {}, finalUrl: res.finalUrl || url };
      if (!noCache) {
        memSet(pageMemCache, memKey, out);
        await cacheSetJson('page', cacheKey, out, effTTL);
      }
      if (i > 0) { PREFERRED = (PREFERRED + i) % runtimeHosts.length; LANDED_HOST = host; }
      logI(`[http] ${label} 请求成功 host=${host} status=${res.statusCode} body长度=${String(res.body).length} url=${url}`);
      return out;
    }
    logE(`[http] ${label} 失败 host=${host} status=${res.statusCode} err=${res.error || ''} url=${url}`);
    hostFail.set(host, (hostFail.get(host) || 0) + 1);
  }
  logE(`[http] ${label} 全部基址失败 lastErr=${lastErr}`);
  return { body: '', statusCode: 0, headers: {}, finalUrl: '' };
}

function absUrl(href, base) {
  const s = String(href || '').replace(/&amp;/g, '&').trim();
  if (!s || /^(?:#|javascript:|data:|magnet:)/i.test(s)) return '';
  try { return new URL(s, base || SITE_API).href; } catch (_) { return ''; }
}
function cleanText(s) {
  return String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function decodeEntities(s) {
  return cleanText(String(s || '').replace(/<br\s*\/?>/gi, '\n'));
}
function isPlaceholderImg(u) { return !u || PLACEHOLDER_RE.test(u); }

// ============================== 封面资源域名（RDUL） ==============================
// 站点 rdul.js 暴露 window.RDUL = [资源域名...]，LazyImageLoader 会 HEAD /vod1/heartbeat.check
// 选最快域名后把 data-original 的相对路径换到该域名。脚本侧复刻同一链路：
// 主站 www.ncat22.com 的 /vod1/... 图片永远 403，必须走资源域名。
function parseRdulHosts(jsText) {
  const t = String(jsText || '');
  const m = t.match(/(?:window\.)?RDUL\s*=\s*\[([\s\S]*?)\]/i);
  if (!m) return [];
  const urls = m[1].match(/https?:\/\/[^"'\s,\]]+/gi) || [];
  return Array.from(new Set(urls.map(normalizeHost).filter(Boolean)));
}
function headImgHost(host) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/vod1/heartbeat.check', host); } catch (_) { return resolve(0); }
    const mod = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'HEAD', headers: { 'User-Agent': USER_AGENT },
      timeout: 4000, rejectUnauthorized: false, servername: u.hostname,
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400 ? Date.now() - started : 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}
async function initImgHost() {
  if (IMG_HOST_INITED) return ACTIVE_IMG_HOST;
  IMG_HOST_INITED = true;
  if (IMG_HOST_OVERRIDE || IMG_HOSTS_OVERRIDE.length) {
    logI(`[img] 使用手动配置封面域名=${ACTIVE_IMG_HOST} 候选=${JSON.stringify(IMG_HOSTS_OVERRIDE)}`);
    return ACTIVE_IMG_HOST;
  }
  try {
    const cached = await cacheGetJson('img_host', 'rdul');
    if (cached && cached.host) {
      ACTIVE_IMG_HOST = cached.host;
      logI(`[img] 命中缓存封面域名=${ACTIVE_IMG_HOST}`);
      return ACTIVE_IMG_HOST;
    }
    // rdul.js 在静态域名上，无需 850 cookie
    const res = await httpRequestRaw('https://vf.wkcyvs.cn/vod_pc_static_ncat/js/rdul.js?ver=123456666', { timeout: 6000 });
    const found = parseRdulHosts(res.body);
    let hosts = found.length ? found : DEFAULT_IMG_HOSTS.slice();
    logI(`[img] rdul.js 解析资源域名=${JSON.stringify(hosts)} status=${res.statusCode}`);
    if (hosts.length > 1) {
      const times = await Promise.all(hosts.map(headImgHost));
      const ranked = hosts.map((h, i) => ({ h, t: times[i] })).filter((x) => x.t > 0).sort((a, b) => a.t - b.t);
      logI(`[img] 测速结果=${JSON.stringify(hosts.map((h, i) => `${h}:${times[i] || 'fail'}`))}`);
      if (ranked.length) hosts = [ranked[0].h, ...hosts.filter((h) => h !== ranked[0].h)];
    }
    ACTIVE_IMG_HOST = hosts[0] || DEFAULT_IMG_HOSTS[0];
    await cacheSetJson('img_host', 'rdul', { host: ACTIVE_IMG_HOST, hosts, ts: Date.now() }, CACHE_TTL);
    logI(`[img] 已选定封面域名=${ACTIVE_IMG_HOST}`);
  } catch (e) {
    logE(`[img] 封面域名探测失败，回退默认: ${e.message}`);
    ACTIVE_IMG_HOST = DEFAULT_IMG_HOSTS[0];
  }
  return ACTIVE_IMG_HOST;
}
// 把 HTML 里的图片候选换成可直连的绝对 URL。
// - 已经是资源域名 / 其它外链 → 原样保留
// - 主站同源的相对 /vod1/... → 换到 ACTIVE_IMG_HOST（这就是修复「没有封面」的关键）
function mapImageUrl(c, base) {
  const raw = String(c || '').replace(/&amp;/g, '&').trim();
  if (!raw) return '';
  if (IMG_PROXY) return IMG_PROXY + (raw.startsWith('/') ? ACTIVE_IMG_HOST + raw : raw);
  let abs;
  try { abs = new URL(raw, base || SITE_API).href; } catch (_) { return ''; }
  try {
    const u = new URL(abs);
    const isSiteImg = /^\/vod1\//i.test(u.pathname) && u.hostname === new URL(SITE_API).hostname;
    if (isSiteImg || (raw.startsWith('/vod1/') && !/^https?:/i.test(raw))) {
      return ACTIVE_IMG_HOST.replace(/\/+$/, '') + u.pathname + u.search;
    }
  } catch (_) {}
  return abs;
}

// 站点卡片双图：第一张常是 #noneCoverImg 占位，真实封面在第二张的 data-original。
// 部分卡片真实封面挂在 <a data-original>，因此同时检查 self / 父级 a / 节点属性。
function pickImage(block, base) {
  const t = String(block || '');
  const candidates = [];
  const attrRe = /(?:data-original|data-src|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(t)) !== null) candidates.push(m[1]);
  const aAttr = t.match(/<a\b[^>]*\b(?:data-original|data-src)\s*=\s*["']([^"']+)["']/i);
  if (aAttr) candidates.unshift(aAttr[1]);
  for (const c of candidates) {
    if (isPlaceholderImg(c)) continue;
    const u = mapImageUrl(c, base);
    if (u) return u;
  }
  return '';
}
function extractId(href) {
  const m = String(href || '').match(/\/detail\/([^\/"'?#]+?)(?:\.html?)?$/i);
  return m ? m[1] : '';
}

// ============================== 列表卡片解析 ==============================
// 兼容三类卡片：v-item（首页/分类）、carousel-item（轮播）、search-result-item（搜索）
function parseVodCards(html, baseUrl, label) {
  const t = String(html || '');
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*\bhref\s*=\s*["']([^"']*\/detail\/[^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const attrs = m[1] || '';
    const href = m[2] || '';
    const body = m[3] || '';
    const id = extractId(href);
    if (!id || seen.has(id)) continue;
    let name = '';
    const titleMatches = body.match(/<div class="(?:v-item-title|carousel-item-title|title)"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (const tm of titleMatches) {
      if (/style\s*=\s*["'][^"']*display\s*:\s*none/i.test(tm)) continue;
      const v = cleanText(tm);
      if (v && !/kekys|可可影视|ncat|网飞猫/i.test(v)) { name = v; break; }
    }
    if (!name) {
      const imgAlt = body.match(/\balt\s*=\s*["']([^"']+)["']/i) || attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i);
      name = cleanText(imgAlt ? imgAlt[1] : '');
    }
    if (!name) continue;
    const pic = pickImage(body + attrs, baseUrl);
    const remarksMatch = body.match(/<div class="v-item-bottom"[^>]*>([\s\S]*?)<\/div>/i);
    const remarks = remarksMatch ? cleanText(remarksMatch[1]) : '';
    const scoreMatch = body.match(/豆瓣\s*[:：]?\s*([\d.]+)\s*分?/);
    const headerMatch = body.match(/<div class="search-result-item-header"[^>]*>([\s\S]*?)<\/div>/i);
    const header = headerMatch ? cleanText(headerMatch[1]) : '';
    const tagsMatch = body.match(/<div class="tags"[^>]*>([\s\S]*?)<\/div>/i);
    const tags = tagsMatch ? cleanText(tagsMatch[1]).replace(/\s*\/\s*/g, ' ').trim() : '';
    const yearM = tags.match(/\b(19|20)\d{2}\b/);
    seen.add(id);
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: pic,
      type_id: '',
      type_name: header || '',
      vod_remarks: remarks,
      vod_year: yearM ? yearM[0] : '',
      vod_douban_score: scoreMatch ? scoreMatch[1] : '',
    });
    if (out.length >= 120) break;
  }
  logI(`[parse] ${label} 卡片数=${out.length} 首条=${out[0] ? `${out[0].vod_id}:${out[0].vod_name}:${out[0].vod_pic ? '有图' : '无图'}` : '空'}`);
  return out;
}

function parseHomeList(html, baseUrl) {
  return parseVodCards(html, baseUrl, 'home');
}

// ============================== 筛选（live href 解析） ==============================
function parseFilterRows(html, categoryId) {
  const t = String(html || '');
  const rows = [];
  const rowRe = /<div class="filter-row">([\s\S]*?)<\/div>\s*<\/div>/gi;
  let rm;
  while ((rm = rowRe.exec(t)) !== null) {
    const block = rm[1];
    const side = block.match(/<strong>([\s\S]*?)<\/strong>/i);
    const label = cleanText(side ? side[1] : '').replace(/[:：]$/, '');
    const keyMap = { '类型': 'type', '地区': 'area', '语言': 'lang', '年份': 'year', '排序': 'sort' };
    const key = keyMap[label] || '';
    const options = [];
    const itemRe = /<a\s+href="([^"]+)"\s*class="filter-item[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let im;
    while ((im = itemRe.exec(block)) !== null) {
      const name = cleanText(im[2]);
      const href = im[1];
      const val = extractShowSegment(href, key);
      options.push({ n: name, v: val });
    }
    if (key && options.length) rows.push({ key, label, options });
  }
  logI(`[filter] categoryId=${categoryId} 解析筛选行=${rows.length} 明细=${rows.map((r) => `${r.key}:${r.options.length}`).join(',')}`);
  return rows;
}
function extractShowSegment(href, key) {
  const s = String(href || '');
  const m = s.match(/\/show\/([^"'?#]+?)\.html/i);
  if (!m) return '';
  let parts;
  try { parts = m[1].split('-').map(decodeURIComponent); } catch (_) { parts = m[1].split('-'); }
  const idx = { type: 1, area: 2, lang: 3, year: 4, sort: 5, page: 6 }[key];
  if (idx == null || !parts || parts.length <= idx) return '';
  const v = parts[idx] || '';
  if (key === 'sort') return /^[1-4]$/.test(v) ? v : '';
  if (key === 'page') return /^\d+$/.test(v) ? v : '';
  return ALL_MARK.includes(v) ? '' : v;
}
// OmniBox 前端约定：filters = { 分类ID: [ { key, name, init, value: [{ name, value }] } ] }
// value 内必须用 name/value，不能用 { n, v }，否则筛选按钮渲染后点击不生效。
function buildFiltersFromRows(rows, categoryId) {
  const filters = {};
  const list = [];
  (rows || []).forEach((r) => {
    const seen = new Set();
    const value = [];
    r.options.forEach((o) => {
      const name = o.n || '';
      const val = o.v || '';
      if (!name || seen.has(name + '|' + val)) return;
      seen.add(name + '|' + val);
      value.push({ name, value: val });
    });
    if (value.length) list.push({ key: r.key, name: r.label, init: '', value });
  });
  // 排序兜底：站点某些分类（短剧）筛选行不完整
  if (!list.some((x) => x.key === 'sort')) {
    list.push({
      key: 'sort', name: '排序', init: '',
      value: SORT_OPTIONS.map((n, i) => ({ name: n, value: String(i + 1) })),
    });
  }
  if (list.length) filters[categoryId] = list;
  return filters;
}
async function getFilterRowsCached(categoryId) {
  const key = `filters:${categoryId}`;
  const hit = memGet(pageMemCache, key, CACHE_TTL * 1000);
  if (hit) return hit;
  const cached = await cacheGetJson('filter_rows', categoryId);
  if (cached && Array.isArray(cached.rows)) { memSet(pageMemCache, key, cached.rows); return cached.rows; }
  const path = `/show/${categoryId}------.html`;
  const res = await fetchHtml(path, `filters:${categoryId}`, CACHE_TTL);
  const rows = parseFilterRows(res.body, categoryId);
  memSet(pageMemCache, key, rows);
  await cacheSetJson('filter_rows', categoryId, { rows }, CACHE_TTL);
  return rows;
}
function normalizeFilters(raw, categoryId, rows) {
  const f = (raw && typeof raw === 'object') ? raw : {};
  const merged = { ...f };
  // 宿主可能把分类 ID 作为 key 包一层
  if (merged[categoryId] && typeof merged[categoryId] === 'object') Object.assign(merged, merged[categoryId]);
  const out = { type: '', area: '', lang: '', year: '', sort: '' };
  const allowed = new Set(FILTER_KEYS);
  Object.keys(merged).forEach((k) => {
    if (!allowed.has(k) || k === 'page') return;
    let v = merged[k];
    // filters 值可能是 { name, value } / { n, v } / 数组（多选时取首项）
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === 'object') v = v.value ?? v.v ?? v.init ?? '';
    v = String(v == null ? '' : v).trim();
    if (!v || ALL_MARK.includes(v)) return;
    out[k] = v;
  });
  // 白名单：值必须是官网真实 href 里出现过的；sort 只接受 1-4
  (rows || []).forEach((r) => {
    if (!out[r.key]) return;
    const vals = r.options.map((o) => String(o.v || '')).filter(Boolean);
    if (!vals.length || !vals.includes(out[r.key])) {
      logI(`[filter] 非法 ${r.key}=${out[r.key]}，回退默认`);
      out[r.key] = '';
    }
  });
  if (!/^[1-4]$/.test(out.sort)) out.sort = '3';
  return out;
}
function buildShowPath(categoryId, f, page) {
  const seg = (v) => (/^https?:/i.test(v) ? '' : encodeURIComponent(String(v || '')));
  const parts = [String(categoryId), seg(f.type), seg(f.area), seg(f.lang), seg(f.year), String(f.sort || '3'), String(Math.max(1, Number(page) || 1))];
  return `/show/${parts.join('-')}.html`;
}
function decodeHtmlAttr(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function parsePageCount(html, currentPage) {
  const t = String(html || '');
  const m = t.match(/<a\s+href="([^"]+)"\s*class="page-item-next"/i);
  if (!m) return Math.max(1, Number(currentPage) || 1);
  const next = decodeHtmlAttr(m[1]);
  const p = extractShowSegment(next, 'page') || (next.match(/[?&]page=(\d+)/) || [])[1] || '';
  const n = Number(p);
  if (!n) return Math.max(1, Number(currentPage) || 1);
  return Math.max(Number(currentPage) || 1, n);
}

// ============================== 搜索 token ==============================
function extractSearchToken(html) {
  const t = String(html || '');
  const m = t.match(/<input[^>]*\bname=["']t["'][^>]*\bvalue=["']([^"']+)["']/i)
    || t.match(/<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']t["']/i);
  if (m) return m[1];
  const href = t.match(/href=["']\/search\?[^"']*?\bt=([^&"']+)/i);
  return href ? decodeURIComponent(href[1]) : '';
}
async function getSearchToken() {
  const hit = memGet(tokenMemCache, 'search_t', SEARCH_TOKEN_TTL * 1000);
  if (hit) return hit;
  const cached = await cacheGetJson('search_token', 'home');
  if (cached && cached.t) { memSet(tokenMemCache, 'search_t', cached.t); return cached.t; }
  // 无 t 的搜索页本身就会实时下发合法 token，且实测该 token 可跨关键词 / 跨页复用。
  // 用搜索页取 token 比请求 230KB 首页更轻，也避开首页偶发超时。
  const res = await fetchHtml('/search?k=%E7%83%AD%E9%97%A8', 'search_token', 120);
  let t = extractSearchToken(res.body);
  if (!t) {
    const home = await fetchHtml('/', 'search_token:home', 120);
    t = extractSearchToken(home.body);
  }
  if (t) {
    memSet(tokenMemCache, 'search_t', t);
    await cacheSetJson('search_token', 'home', { t, ts: Date.now() }, SEARCH_TOKEN_TTL);
  }
  logI(`[search] 提取 t token=${t ? t.slice(0, 12) + '...' : '空'}`);
  return t;
}
function buildSearchPath(keyword, page, token) {
  const q = new URLSearchParams();
  q.set('k', String(keyword || ''));
  const p = Math.max(1, Number(page) || 1);
  if (p > 1) q.set('page', String(p));
  if (token) q.set('t', token);
  return '/search?' + q.toString();
}
function parseSearchTotal(html) {
  const m = String(html || '').match(/找到<span class="highlight-text">\s*(\d+)\s*<\/span>/);
  return m ? Number(m[1]) : 0;
}
function parseSearchKeyword(html) {
  const m = String(html || '').match(/<title>([\s\S]*?)搜索结果/i);
  return m ? cleanText(m[1]) : '';
}
function parseSearchPageCount(html, page, total) {
  const t = String(html || '');
  const cur = Math.max(1, Number(page) || 1);
  // 站点分页链接的「下一页」只给 page+1，不能用它当总页数。
  // 结果区明确给了「找到 N 部影片」，每页 18 条，据此推算才是真实 pagecount。
  const byTotal = Math.ceil((Number(total) || 0) / 18);
  if (byTotal > 0) return Math.max(cur, byTotal);
  // total 缺失时，退化成「有下一页则 cur+1，无下一页则 cur」
  const nextMatch = t.match(/<a\s+href="([^"]+)"\s*class="page-item-next"/i);
  if (!nextMatch) return cur;
  const next = decodeHtmlAttr(nextMatch[1]);
  const m = next.match(/[?&]page=(\d+)/);
  const n = m ? Number(m[1]) : 0;
  return n ? Math.max(cur, n) : cur + 1;
}

// ============================== 详情 / 线路 ==============================
function parseDetailMeta(html, videoId, baseUrl) {
  const t = String(html || '');
  const titleBlock = t.match(/<div class="detail-title"[^>]*>([\s\S]*?)<\/div>/i);
  let vod_name = '';
  if (titleBlock) {
    const strongs = titleBlock[1].match(/<strong[^>]*>([\s\S]*?)<\/strong>/gi) || [];
    for (const s of strongs) {
      const v = cleanText(s);
      if (v && !/kekys|可可影视|ncat|𝕜|𝕪/i.test(v)) { vod_name = v; break; }
    }
  }
  if (!vod_name) {
    const mt = t.match(/<title>([\s\S]*?)<\/title>/i);
    vod_name = cleanText(mt ? mt[1] : '').replace(/-.*$/, '').trim();
  }
  const desc = t.match(/<div class="detail-desc"[^>]*>([\s\S]*?)<\/div>/i);
  const metaDesc = t.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  let vod_content = desc ? decodeEntities(desc[1]) : '';
  if (!vod_content && metaDesc) vod_content = cleanText(metaDesc[1]).replace(/^[^：:]+[：:]/, '');
  const rows = {};
  const rowRe = /<div class="detail-info-row-side">([\s\S]*?)<\/div>\s*<div class="detail-info-row-main">([\s\S]*?)<\/div>/gi;
  let rm;
  while ((rm = rowRe.exec(t)) !== null) {
    const k = cleanText(rm[1]).replace(/[:：]$/, '');
    rows[k] = cleanText(rm[2]);
  }
  const picBlock = t.match(/<div class="detail-pic"[^>]*>([\s\S]*?)<\/div>/i);
  const vod_pic = picBlock ? pickImage(picBlock[1], baseUrl) : '';
  const tagBlock = t.match(/<div class="detail-tags[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const tags = tagBlock
    ? (tagBlock[1].match(/<a\b[^>]*class="detail-tags-item"[^>]*>([\s\S]*?)<\/a>/gi) || [])
      .map((a) => cleanText((a.match(/>([\s\S]*?)<\/a>/i) || [])[1] || '')).filter(Boolean)
    : [];
  const year = tags.find((x) => /^(19|20)\d{2}$/.test(x)) || (rows['首映'] || '').match(/(19|20)\d{2}/)?.[0] || '';
  const area = tags.filter((x) => /国|大陆|香港|台湾|地区|洲$/.test(x) && !/^(19|20)\d{2}$/.test(x)).join('/');
  const type_name = tags.filter((x) => !/^(19|20)\d{2}$/.test(x) && !/国|大陆|香港|台湾|地区|洲$/.test(x)).join('/');
  const score = t.match(/豆瓣\s*[:：]?\s*([\d.]+)\s*分?/);
  return {
    vod_id: String(videoId),
    vod_name: vod_name || String(videoId),
    vod_pic,
    vod_content,
    vod_director: rows['导演'] || '',
    vod_actor: rows['演员'] || '',
    vod_area: area,
    vod_lang: rows['语言'] || '',
    vod_year: year,
    vod_remarks: rows['备注'] || '',
    vod_douban_score: score ? score[1] : '',
    type_name,
  };
}

function parseDetailSources(html, baseUrl) {
  const t = String(html || '');
  const sourceNames = [];
  const srcRe = /<a\s+href="#"\s*class="source-item[^"]*"[^>]*>\s*<span class="source-item-label">([\s\S]*?)<\/span>/gi;
  let sm;
  while ((sm = srcRe.exec(t)) !== null) sourceNames.push(cleanText(sm[1]));
  const lists = [];
  const listRe = /<div class="episode-list"[^>]*>([\s\S]*?)<\/div>/gi;
  let lm;
  while ((lm = listRe.exec(t)) !== null) {
    const eps = [];
    const epRe = /<a\s+href="([^"]+)"\s*class="episode-item[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/gi;
    let em;
    while ((em = epRe.exec(lm[1])) !== null) {
      const raw = em[1].replace(/&amp;/g, '&');
      eps.push({ name: cleanText(em[2]) || `第${eps.length + 1}集`, raw, url: absUrl(raw, baseUrl) });
    }
    lists.push(eps);
  }
  const sources = [];
  const n = Math.max(sourceNames.length, lists.length);
  for (let i = 0; i < n; i++) {
    const name = sourceNames[i] || `线路${i + 1}`;
    const eps = lists[i] || [];
    if (!eps.length) continue;
    sources.push({ name, episodes: eps });
  }
  logI(`[detail] 线路统计 sourceNames=${sourceNames.length} episodeLists=${lists.length} 有效线路=${sources.length} 线路名=${sources.slice(0, 6).map((s) => s.name).join(',')}`);
  return sources;
}

function encodePlayMeta(meta) {
  try { return Buffer.from(JSON.stringify(meta || {}), 'utf8').toString('base64'); } catch (_) { return ''; }
}
function splitPlayId(playId) {
  const raw = String(playId || '');
  const pos = raw.indexOf('|||');
  if (pos < 0) return { raw, meta: null };
  try { return { raw: raw.slice(0, pos), meta: JSON.parse(Buffer.from(raw.slice(pos + 3), 'base64').toString('utf8')) }; }
  catch (_) { return { raw: raw.slice(0, pos), meta: null }; }
}
function buildSourcesForHost(videoId, sources) {
  return (sources || []).map((line, li) => ({
    name: line.name,
    episodes: (line.episodes || []).map((ep, ei) => {
      const fid = `${videoId}#${line.name}#${ei}`;
      const meta = {
        sid: String(videoId), fid, v: '', e: ep.name, n: ei + 1, l: line.name,
        page: ep.url || '', li, ei,
      };
      return {
        name: ep.name,
        playId: `${ep.raw}|||${encodePlayMeta(meta)}`,
        _fid: fid,
        _rawName: ep.name,
        _rawUrl: ep.raw,
      };
    }),
  }));
}
function buildScrapeCandidates(sources) {
  const out = [];
  (sources || []).forEach((line) => {
    (line.episodes || []).forEach((ep, ei) => {
      const fid = `${line.name}#${ei}`;
      out.push({ fid, file_id: fid, file_name: ep.name || '', name: ep.name || '', format_type: 'video' });
    });
  });
  return out;
}
async function enrichDetail(videoId, vod, sources) {
  const candidates = buildScrapeCandidates(sources);
  if (!candidates.length) { logI('[scrape] scrapeCandidates 为空，跳过增强'); return; }
  if (typeof OmniBox.processScraping !== 'function' || typeof OmniBox.getScrapeMetadata !== 'function') {
    logI('[scrape] 宿主未提供 processScraping/getScrapeMetadata，跳过增强');
    return;
  }
  logI(`[scrape] 候选预览: ${candidates.slice(0, 3).map((c) => `${c.file_id}=>${c.file_name}`).join(' | ')} 共${candidates.length}条`);
  try {
    await OmniBox.processScraping(videoId, vod.vod_name || '', vod.vod_name || '', candidates);
    const md = await OmniBox.getScrapeMetadata(videoId);
    const mappings = (md && Array.isArray(md.videoMappings)) ? md.videoMappings : [];
    logI(`[scrape] mappingCount=${mappings.length} mappingPreview=${mappings.slice(0, 2).map((x) => `${x.fileId || ''}=>${x.episodeName || ''}`).join(' | ')}`);
    if (mappings.length) {
      const byFid = new Map();
      mappings.forEach((x) => { if (x && x.fileId) byFid.set(String(x.fileId), x); });
      (sources || []).forEach((line) => {
        (line.episodes || []).forEach((ep, ei) => {
          const hit = byFid.get(`${line.name}#${ei}`);
          if (hit && (hit.episodeName || hit.name)) ep.name = String(hit.episodeName || hit.name);
          if (hit && hit.episodeOverview) ep.episodeOverview = hit.episodeOverview;
          if (hit && hit.episodeAirDate) ep.episodeAirDate = hit.episodeAirDate;
          if (hit && hit.episodeStillPath) ep.episodeStillPath = hit.episodeStillPath;
        });
      });
    }
    const sd = (md && md.scrapeData) || {};
    if (sd.overview) vod.vod_content = String(sd.overview);
    else if (sd.description) vod.vod_content = String(sd.description);
    if (sd.title) vod.vod_name = String(sd.title);
    if (sd.poster || sd.backdrop) vod.vod_pic = String(sd.poster || sd.backdrop);
    if (sd.year) vod.vod_year = String(sd.year);
    if (sd.vote_average) vod.vod_douban_score = String(sd.vote_average);
    if (sd.genres) vod.type_name = Array.isArray(sd.genres) ? sd.genres.map((g) => g.name || g).join('/') : String(sd.genres);
    if (sd.cast) vod.vod_actor = Array.isArray(sd.cast) ? sd.cast.map((a) => a.name || a).join('/') : String(sd.cast);
    if (sd.crew) vod.vod_director = Array.isArray(sd.crew) ? sd.crew.map((a) => a.name || a).join('/') : String(sd.crew);
    if (sd.origin_country) vod.vod_area = Array.isArray(sd.origin_country) ? sd.origin_country.join('/') : String(sd.origin_country);
    if (sd.original_language) vod.vod_lang = String(sd.original_language);
    logI(`[scrape] 元数据回填结果 title=${vod.vod_name} actor=${String(vod.vod_actor).slice(0, 40)} director=${String(vod.vod_director).slice(0, 40)} area=${vod.vod_area} lang=${vod.vod_lang} type=${vod.type_name}`);
  } catch (e) { logE(`[scrape] 增强失败（不阻塞详情）: ${e.message}`); }
}

// ============================== 播放 ==============================
function isDirectMedia(u) {
  return /^(?:https?:)?\/\/[^\s"'<>]+\.(?:m3u8|mp4|flv|mkv|ts)(?:\?[^\s"'<>]*)?/i.test(String(u || ''))
    || /\.m3u8(?:\?|$)/i.test(String(u || ''));
}
function isWebPage(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return true;
  if (isDirectMedia(s)) return false;
  return /\/(?:play|player|parse|jiexi|detail)\//i.test(s) || !/\.(?:m3u8|mp4|flv|mkv|ts)(?:\?|$)/i.test(s);
}
// 播放页真实地址在 const playSource = { src: "https://.../index.m3u8", type: ... }
// 页面里还有 xgplayer 官方文档的 demo mp4 行注释，必须先剥掉 JS 注释，避免把示例视频当成真直链。
// 部分线路是 APP 专属（src:""），此时走 sniff / parse=1 兜底。
function stripJsComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\\])\/\/[^\r\n]*/g, '$1 ');
}
function extractPlayMedia(html, pageUrl) {
  const raw = String(html || '');
  const t = stripJsComments(raw);
  const candidates = [];
  const srcRe = /playSource\s*=\s*\{[\s\S]{0,400}?\bsrc\s*:\s*["']([^"']*)["']/gi;
  let m;
  while ((m = srcRe.exec(t)) !== null) candidates.push(m[1]);
  const anySrc = t.match(/\bsrc\s*:\s*["'](https?:[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (anySrc) candidates.unshift(anySrc[1]);
  // 只认带引号的媒体字符串；注释已剥离，这里不会命中 xgplayer 的 demo 行
  const mediaRe = /["']((?:https?:)?(?:\\?\/\\?\/|\/\/)[^"'\s<>()]+\.(?:m3u8|mp4|flv)(?:\?[^"'\s<>]*)?)["']/gi;
  let mm;
  while ((mm = mediaRe.exec(t)) !== null) candidates.push(mm[1]);
  for (const c of candidates) {
    const s = String(c || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/').trim();
    if (!s) continue;
    const abs = absUrl(s, pageUrl);
    if (abs && isDirectMedia(abs) && !/xgplayer_doc_video|xgplayer-demo|\/demo\//i.test(abs)) return abs;
  }
  return '';
}
function buildHeaders(target) {
  let origin = '';
  try { origin = new URL(target).origin; } catch (_) {}
  return {
    'User-Agent': USER_AGENT,
    'Referer': SITE_API + '/',
    'Origin': origin,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}
async function sniffVideo(url, header) {
  if (typeof OmniBox.sniffVideo !== 'function') return '';
  try {
    logI(`[play] sniff start: ${url}`);
    const r = await OmniBox.sniffVideo(url, header);
    let out = '';
    if (typeof r === 'string') out = r;
    else if (r && typeof r === 'object') out = r.url || r.playUrl || (Array.isArray(r.urls) && (r.urls[0]?.url || r.urls[0])) || '';
    logI(`[play] sniff result: ${out ? String(out).slice(0, 160) : '空'}`);
    return typeof out === 'string' ? out : '';
  } catch (e) { logE(`[play] sniff 异常: ${e.message}`); return ''; }
}
async function resolvePlayPage(pageUrl, label) {
  const res = await fetchHtml(pageUrl, label, 0); // 播放页不做长 TTL 缓存，避免脏链
  if (!res.body) return { media: '', pageUrl, body: '' };
  const media = extractPlayMedia(res.body, res.finalUrl || pageUrl);
  logI(`[play] 播放页解析 ${label} media=${media ? media.slice(0, 160) : '空(APP专属/网页兜底)'} body长度=${String(res.body).length}`);
  return { media, pageUrl: res.finalUrl || pageUrl, body: res.body };
}

// ============================== 五个 handler ==============================
async function home(params, context) {
  const from = (context && context.from) || 'web';
  logI(`[home] 入口 from=${from} params=${JSON.stringify(params || {})}`);
  try {
    await initImgHost();
    const res = await fetchHtml('/', 'home', CACHE_TTL);
    const list = parseHomeList(res.body, res.finalUrl || SITE_API);
    const filterPromises = CLASS_LIST.map((c) => getFilterRowsCached(c.type_id).catch((e) => { logE(`[home] filters ${c.type_id} 失败: ${e.message}`); return []; }));
    const rows = await Promise.all(filterPromises);
    const filters = {};
    CLASS_LIST.forEach((c, i) => Object.assign(filters, buildFiltersFromRows(rows[i], c.type_id)));
    logI(`[home] 返回 class=${CLASS_LIST.length} list=${list.length} filters分类数=${Object.keys(filters).length} from=${from}`);
    return { class: CLASS_LIST, list, filters };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CLASS_LIST, list: [], filters: {} };
  }
}

async function category(params, context) {
  const from = (context && context.from) || 'web';
  const categoryId = String((params && (params.categoryId ?? params.t ?? params.id)) || '1');
  const page = Number((params && (params.page ?? params.pg)) || 1) || 1;
  const rawFilters = (params && (params.filters || params.extend || params.ext || params.filter)) || {};
  logI(`[category] 入口 categoryId=${categoryId} page=${page} filters=${JSON.stringify(rawFilters)} from=${from}`);
  try {
    await initImgHost();
    const rows = await getFilterRowsCached(categoryId).catch(() => []);
    const f = normalizeFilters(rawFilters, categoryId, rows);
    const path = buildShowPath(categoryId, f, page);
    logI(`[category] 最终 filters=${JSON.stringify(f)} finalUrl=${SITE_API}${path}`);
    const res = await fetchHtml(path, `category:${categoryId}:${page}`, CACHE_TTL);
    const list = parseVodCards(res.body, res.finalUrl || SITE_API, `category:${categoryId}:${page}`);
    const pagecount = parsePageCount(res.body, page);
    logI(`[category] 返回 page=${page} pagecount=${pagecount} total=${list.length} list=${list.length}`);
    return { page, pagecount, total: list.length, list };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  const from = (context && context.from) || 'web';
  const rawId = String((params && (params.videoId ?? params.vod_id ?? params.id)) || '');
  logI(`[detail] 入口 videoId=${rawId} from=${from}`);
  if (!rawId) return { list: [] };
  try {
    await initImgHost();
    // 兼容宿主把完整详情 URL 或带 @@base64 的 id 传进来
    let path = '';
    let videoId = rawId;
    if (/^https?:\/\//i.test(rawId)) {
      const u = new URL(rawId);
      path = u.pathname + u.search;
      videoId = extractId(u.pathname) || rawId;
    } else if (rawId.includes('@@')) {
      const pos = rawId.indexOf('@@');
      videoId = rawId.slice(0, pos);
      try { const d = Buffer.from(rawId.slice(pos + 2), 'base64url').toString('utf8'); if (/\/detail\//.test(d)) path = d; } catch (_) {}
    }
    if (!path) path = `/detail/${encodeURIComponent(videoId)}.html`;
    const res = await fetchHtml(path, `detail:${videoId}`, CACHE_TTL);
    if (!res.body) { logE(`[detail] 详情 HTML 为空 videoId=${videoId}`); return { list: [] }; }
    const vod = parseDetailMeta(res.body, videoId, res.finalUrl || SITE_API);
    const sources = parseDetailSources(res.body, res.finalUrl || SITE_API);
    await enrichDetail(videoId, vod, sources);
    const playSources = buildSourcesForHost(videoId, sources);
    const epTotal = playSources.reduce((n, s) => n + s.episodes.length, 0);
    // 兼容旧展示链路
    const vod_play_from = playSources.map((s) => s.name).join('$$$');
    const vod_play_url = playSources.map((s) => s.episodes.map((e) => `${e.name}$${e._rawUrl}`).join('#')).join('$$$');
    logI(`[detail] 返回 vod_name=${vod.vod_name} pic=${vod.vod_pic ? '有' : '无'} content长度=${String(vod.vod_content).length} 线路=${playSources.length} 分集=${epTotal} actor=${String(vod.vod_actor).slice(0, 30)}`);
    return {
      list: [{
        ...vod,
        vod_play_sources: playSources,
        vod_play_from,
        vod_play_url,
      }],
    };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const from = (context && context.from) || 'web';
  const keyword = String((params && (params.keyword ?? params.wd ?? params.k)) || '').trim();
  const page = Number((params && (params.page ?? params.pg)) || 1) || 1;
  logI(`[search] 入口 keyword=${keyword} page=${page} from=${from}`);
  if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    await initImgHost();
    let token = await getSearchToken();
    let path = buildSearchPath(keyword, page, token);
    let res = await fetchHtml(path, `search:${keyword}:${page}`, 120); // 搜索结果短 TTL
    let list = parseVodCards(res.body, res.finalUrl || SITE_API, `search:${keyword}:${page}`);
    let total = parseSearchTotal(res.body);
    // t token 是页面实时下发的；失效时用当前返回页里的新 token 再试一次
    if (!list.length && !total) {
      const fresh = extractSearchToken(res.body);
      if (fresh && fresh !== token) {
        logI(`[search] 首次无结果，换用页面实时 token 重试: ${fresh.slice(0, 12)}...`);
        token = fresh;
        memSet(tokenMemCache, 'search_t', fresh);
        await cacheSetJson('search_token', 'home', { t: fresh, ts: Date.now() }, SEARCH_TOKEN_TTL);
        path = buildSearchPath(keyword, page, token);
        res = await fetchHtml(path, `search:${keyword}:${page}:retry`, 120);
        list = parseVodCards(res.body, res.finalUrl || SITE_API, `search:${keyword}:${page}:retry`);
        total = parseSearchTotal(res.body);
      }
    }
    // token 失效时站点会静默回落到默认热搜词：结果非空但标题关键词对不上，必须换 token 重试。
    const servedKeyword = parseSearchKeyword(res.body);
    if (servedKeyword && servedKeyword !== keyword) {
      const fresh = extractSearchToken(res.body);
      if (fresh && fresh !== token) {
        logI(`[search] 结果关键词不符(${servedKeyword})，换用页面实时 token 重试: ${fresh.slice(0, 12)}...`);
        token = fresh;
        memSet(tokenMemCache, 'search_t', fresh);
        await cacheSetJson('search_token', 'home', { t: fresh, ts: Date.now() }, SEARCH_TOKEN_TTL);
        path = buildSearchPath(keyword, page, token);
        res = await fetchHtml(path, `search:${keyword}:${page}:kwretry`, 120);
        list = parseVodCards(res.body, res.finalUrl || SITE_API, `search:${keyword}:${page}:kwretry`);
        total = parseSearchTotal(res.body);
      }
    }
    const pagecount = parseSearchPageCount(res.body, page, total);
    logI(`[search] 返回 keyword=${keyword} servedKeyword=${parseSearchKeyword(res.body) || keyword} page=${page} pagecount=${pagecount} total=${total} list=${list.length} token=${token ? '有' : '无'}`);
    return { page, pagecount, total, list };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  const from = (context && context.from) || 'web';
  const rawPlayId = String((params && (params.playId ?? params.url ?? params.id)) || '');
  const flag = String((params && params.flag) || 'play');
  logI(`[play] 入口 playId=${String(rawPlayId).slice(0, 200)} flag=${flag} from=${from}`);
  if (!rawPlayId) return { urls: [], flag, header: {}, parse: 0 };
  try {
    const { raw, meta } = splitPlayId(rawPlayId);
    const header = buildHeaders(SITE_API);
    // 1) 已经是明确媒体直链
    if (isDirectMedia(raw) && !/\/play\//i.test(raw)) {
      logI(`[play] 直链直通: ${raw.slice(0, 160)}`);
      return { urls: [{ name: meta?.e || '播放', url: raw }], flag, header, parse: 0 };
    }
    // 2) 播放页 / 短 playId -> 拼详情页 URL 并解析 playSource
    let pageUrl = '';
    if (/^https?:\/\//i.test(raw)) pageUrl = raw;
    else if (/\/play\//i.test(raw)) pageUrl = SITE_API + (raw.startsWith('/') ? raw : '/' + raw);
    else if (/^\d+-\d+-\d+$/.test(raw)) pageUrl = `${SITE_API}/play/${raw}.html`;
    else if (meta && meta.page) pageUrl = meta.page;
    if (!pageUrl) pageUrl = `${SITE_API}/play/${raw}.html`;

    const resolved = await resolvePlayPage(pageUrl, `play:${raw}`);
    const target = resolved.media || resolved.pageUrl;
    const finalHeader = buildHeaders(target);

    // 3) 明确媒体直链 -> parse=0
    if (resolved.media && PLAY_MODE !== 'sniff' && PLAY_MODE !== 'parse') {
      logI(`[play] playSource 直链返回 parse=0: ${resolved.media.slice(0, 160)}`);
      return { urls: [{ name: meta?.e || '播放', url: resolved.media }], flag, header: finalHeader, parse: 0 };
    }
    // 4) 网页型 -> SDK 嗅探
    if (PLAY_MODE !== 'parse' && isWebPage(target)) {
      const sniffed = await sniffVideo(target, finalHeader);
      if (sniffed && isDirectMedia(sniffed)) {
        logI(`[play] SDK 嗅探命中 parse=0: ${sniffed.slice(0, 160)}`);
        return { urls: [{ name: meta?.e || '播放', url: sniffed }], flag, header: finalHeader, parse: 0 };
      }
      logI('[play] sdk sniff failed / 未命中 -> parse=1 fallback');
    }
    // 5) parse=1 交给客户端嗅探（ok影视 app 有效）
    logI(`[play] 兜底返回网页型 parse=1: ${target.slice(0, 160)}`);
    return {
      urls: [{ name: meta?.e || '播放', url: target }],
      url: target,
      flag,
      header: finalHeader,
      parse: 1,
    };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    return { urls: [], url: '', flag, header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
