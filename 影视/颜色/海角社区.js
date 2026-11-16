// @name 海角社区
// @author 宝宝巴士
// @description 海角社区（hjsqn.com）：修复主域名不可达时请求挂死（加硬超时 + 失败日志不再静默）；从地址发布页 hjsq2.co 自动获取最新域名并健康轮转；首页排行/往期列表/搜索/详情/播放；DPlayer data-config 取 /media/m3u8/ 代理直链；封面图床 AES-128-CBC 内联解密
// @version 1.0.3
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/海角社区.js
// @dependencies crypto
/**
 * ============================================================================
 * 海角社区（hjsqn.com）OmniBox 采集源
 * ============================================================================
 *
 * 【地址发布页（防失联，本需求核心）】
 *   发布页：https://hjsq2.co/  （title「海角网 海角乱伦 海角社区」）
 *   页面里给出当前可用入口：
 *     https://hjsqn.com/   主站（真实视频站，21KB 首页 + 162 个 video/item）
 *     https://hjsqw.com/   备用（当前网络不可达）
 *     minuo.cc             图片/CDN 侧域名
 *   还有官方地址仓库：https://gitlab.com/hjsqn-com1/hjsqn-com
 *   脚本首次请求即抓发布页解析域名，做同构校验（首页能抓到 /archives/{id}）
 *   后并入轮换池；默认每 6 小时刷新，全挂时立即强制刷新并重试。
 *
 * 【路由】
 *   首页：/                        （热门搜索 + 排行榜，无封面）
 *   往期：/archives/               （li > .date + a.history-text > h3，56 条/页）
 *   往期分页：/archives/page/{n}/  （实测末页 73）
 *   搜索：/search/{关键词}
 *   详情：/archives/{id}/
 *
 * 【播放】
 *   详情页 DPlayer 的 data-config 里：
 *     video.url      = /media/m3u8/?url={URL编码的原m3u8}&exp=...&token=...
 *     video.h_265    = 同款代理的 H265 线路
 *   站点用 /media/m3u8/ 做代理（实测 HTTP 200，标准 HLS 9222B）。
 *   直接把该代理地址交给播放器即可（parse=0），需带 Referer。
 *
 * 【封面（关键）】
 *   详情页 og:image 指向 expose.eisees.com，该域名实测返回 200 但 **0 字节**；
 *   同一张图在 xi.dzuxta.cn 上有带 auth_key 签名的版本：
 *     https://xi.dzuxta.cn/upload_01/xiao/.../xxx.jpeg?auth_key=...
 *   该图床是 AES-128-CBC 加密密文（Content-Type: binary/octet-stream），
 *   密钥与 51吃瓜/每日大赛同款：key=f5d965df75336270 iv=97b60394abc2fbe1（CBC+Pkcs7）。
 *   脚本从详情页 HTML 里按同名文件匹配出 xi.dzuxta.cn 的签名地址，抓取后解密转 data:image。
 *
 * 【环境变量】
 *   HJ_PUBLISH_PAGE     发布页，默认 https://hjsq2.co/
 *   HJ_HOST             主站，默认 https://hjsqn.com
 *   HJ_MIRRORS          追加备用域名（逗号分隔）
 *   HJ_HOSTS_REFRESH    发布页刷新间隔（小时），默认 6；0=每次都刷
 *   HJ_COVER_INLINE     封面内联解密，默认 1；设 0 关闭（回退原始 URL）
 *   HJ_COOKIE           站点 cookie（可选）
 *   HJ_UA               自定义 User-Agent
 * ============================================================================
 */

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

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const PREFIX = '[haijiao]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.HJ_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE = String(process.env.HJ_COOKIE || '').trim();
const PRIMARY = (process.env.HJ_HOST || 'https://hjsqn.com').replace(/\/+$/, '');
const PUBLISH_PAGE = (process.env.HJ_PUBLISH_PAGE || 'https://hjsq2.co/').trim();
const GITLAB_ADDR = 'https://gitlab.com/hjsqn-com1/hjsqn-com';

/* 封面图床 AES 密钥（与 51吃瓜 / 每日大赛共用同一图床方案） */
const COVER_AES_KEY = Buffer.from('f5d965df75336270', 'latin1');
const COVER_AES_IV = Buffer.from('97b60394abc2fbe1', 'latin1');
const COVER_INLINE = process.env.HJ_COVER_INLINE !== '0';
const COVER_CONCURRENCY = (() => {
  const n = Number(String(process.env.HJ_COVER_CONCURRENCY || '').trim() || 6);
  return Number.isFinite(n) && n > 0 ? Math.min(12, Math.floor(n)) : 6;
})();
const COVER_TIMEOUT = 8000;

/* ---------------- 域名池 ---------------- */
/**
 * 内置备用域名（2026-11-17 实测可用）：发布页本身不可达时兜底，
 * 避免「主域挂了 + 发布页也拉不到」时直接抓瞎。HJ_NO_BUILTIN=1 关闭。
 */
const BUILTIN_HOSTS = String(process.env.HJ_NO_BUILTIN || '') === '1' ? [] : [
  'https://hjsqn.com',
  'https://hjsqw.com',
];
const HOSTS = (() => {
  const extra = String(process.env.HJ_MIRRORS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, '');
  return Array.from(new Set([PRIMARY, ...extra.map(norm), ...BUILTIN_HOSTS.map(norm)]));
})();
let PREFERRED = 0;
const hostHealth = Object.create(null);
const COOLDOWN = 10 * 60 * 1000;

function buildHostOrder() {
  const now = Date.now();
  return HOSTS.map((host, idx) => {
    const h = hostHealth[host] || {};
    return {
      idx,
      blocked: h.blockAt && (now - h.blockAt) < COOLDOWN ? 1 : 0,
      preferred: idx === PREFERRED ? 0 : 1,
      fails: Number(h.fail || 0),
    };
  }).sort((a, b) => a.blocked - b.blocked || a.preferred - b.preferred || a.fails - b.fails || a.idx - b.idx)
    .map((s) => s.idx);
}
function markHost(host, ok, reason) {
  if (!host) return;
  const h = hostHealth[host] || (hostHealth[host] = { fail: 0, okAt: 0, blockAt: 0 });
  if (ok) { h.fail = 0; h.okAt = Date.now(); h.blockAt = 0; return; }
  h.fail = Number(h.fail || 0) + 1;
  if (/403|拦截|blocked/i.test(String(reason || ''))) h.blockAt = Date.now();
}

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
/** 硬超时包装：宿主 OmniBox.request 不受 timeout 约束时会挂住，必须自己 race */
const REQUEST_HARD_TIMEOUT = Math.max(3000, Number(process.env.HJ_REQUEST_TIMEOUT || 12000) || 12000);
function withHardTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`请求超时(${ms}ms) ${label || ""}`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${u.origin}/`,
    }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {});
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
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
async function httpGet(url, options = {}) {
  const timeout = Math.max(3000, Number(options.timeout) || REQUEST_HARD_TIMEOUT);
  if (OmniBox && typeof OmniBox.request === 'function') {
    try {
      const r = await withHardTimeout(
        Promise.resolve(OmniBox.request(url, {
          method: 'GET',
          headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
            COOKIE ? { Cookie: COOKIE } : {}, options.headers || {}),
          timeout,
        })),
        timeout,
        `sdk ${url}`
      );
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return { statusCode: Number(r.statusCode) || 200, body, headers: r.headers || {} };
    } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  }
  return withHardTimeout(
    nodeRequest(url, Object.assign({}, options, { timeout })),
    timeout,
    `node ${url}`
  );
}

/* ---------------- 发布页域名发现（被动触发） ----------------
 * 策略：不做定时刷新。每次请求先尝试所有已知域名；
 * 全部失败时才去发布页拉新域名，分批探测（每批 10 个，批间间隔 200ms）
 * 避免一次性打太多请求。
 * HJ_PROBE_BATCH 控制批次大小，默认 10。
 * =============================================================== */
const HOSTS_CACHE_KEY = 'haijiao:hosts:v1';
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
const PROBE_BATCH_SIZE = (() => {
  const n = Number(String(process.env.HJ_PROBE_BATCH || '').trim() || 10);
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 10;
})();
const PROBE_BATCH_DELAY = 200; // ms，批间间隔，避免一次性打太多
let hostsRefreshInFlight = null;
let hostsCacheRestored = false;

/** 从发布页/仓库页抽取候选域名（排除第三方） */
function extractDomains(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    let h = String(raw || '').toLowerCase().trim()
      .replace(/^https?:\/\//i, '').split(/[/\s"'`#?]/)[0];
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h)) return;
    if (/gitlab|github|discord|telegram|t\.me|x\.com|twitter|google|yandex|googletagmanager|cloudflare|minuo\.cc/i.test(h)) return;
    if (seen.has(h)) return;
    seen.add(h);
    out.push(`https://${h}`);
  };
  let m;
  const re1 = /<a[^>]*href=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = re1.exec(s)) !== null) add(m[1]);
  const re2 = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
  while ((m = re2.exec(s)) !== null) add(m[1]);
  return out;
}
/** 同构校验：首页能抓到 /archives/{id} 才算真站 */
async function probeMainSite(host) {
  try {
    const r = await httpGet(`${host}/`, { timeout: 12000 });
    const b = String(r.body || '');
    return r.statusCode >= 200 && r.statusCode < 400
      && b.length > 5000
      && /\/archives\/\d+/.test(b);
  } catch (_) { return false; }
}
/** 分批并发探测：每批 PROBE_BATCH_SIZE 个，批间间隔 PROBE_BATCH_DELAY ms */
async function probeBatch(batch) {
  const results = await Promise.allSettled(batch.map((h) => probeMainSite(h)));
  const ok = [];
  for (let i = 0; i < batch.length; i++) {
    if (results[i].status === 'fulfilled' && results[i].value) ok.push(batch[i]);
  }
  return ok;
}

async function discoverHosts() {
  const candidates = new Set();
  for (const page of [PUBLISH_PAGE, GITLAB_ADDR]) {
    try {
      const r = await httpGet(page, { timeout: 15000 });
      const body = String(r.body || '');
      if (!body) continue;
      const found = extractDomains(body);
      found.forEach((d) => candidates.add(d));
      logI(`[hosts] ${page} 解析到 ${found.length} 个候选`);
    } catch (e) {
      logI(`[hosts] ${page} 拉取失败: ${e.message}`);
    }
  }

  const newOnes = Array.from(candidates).filter((h) => !HOSTS.includes(h));
  if (!newOnes.length) {
    logI('[hosts] 发布页无新域名，无需探测');
    return 0;
  }
  logI(`[hosts] 待探测 ${newOnes.length} 个新域名，每批 ${PROBE_BATCH_SIZE} 个`);

  let added = 0;
  for (let i = 0; i < newOnes.length; i += PROBE_BATCH_SIZE) {
    const batch = newOnes.slice(i, i + PROBE_BATCH_SIZE);
    const batchNo = Math.floor(i / PROBE_BATCH_SIZE) + 1;
    logI(`[hosts] 探测批次 ${batchNo}: ${batch.length} 个`);
    const ok = await probeBatch(batch);
    for (const h of ok) {
      HOSTS.push(h);
      hostHealth[h] = { fail: 0, okAt: 0, blockAt: 0 };
      added++;
      logI(`[hosts] 发现可用主站 -> ${h}`);
    }
    if (i + PROBE_BATCH_SIZE < newOnes.length) {
      await new Promise((r) => setTimeout(r, PROBE_BATCH_DELAY));
    }
  }
  if (added) logI(`[hosts] 本次新增 ${added} 个，池共 ${HOSTS.length} 个`);
  return added;
}
async function restoreHostsCache() {
  if (hostsCacheRestored) return;
  hostsCacheRestored = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === 'string') { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (obj && Array.isArray(obj.hosts)) {
      for (const h of obj.hosts) {
        if (typeof h === 'string' && /^https?:\/\//i.test(h) && !HOSTS.includes(h)) HOSTS.push(h);
      }
    }
    // at 字段保留但不再用于定时判断（策略改为被动触发）
  } catch (_) {}
}
/**
 * 拉取新域名（被动触发模式）。
 * force=false 时直接返回（不做定时刷新）；
 * force=true 时并发标记，避免重复触发。
 */
async function ensureHostsFresh(force) {
  await restoreHostsCache();
  if (!force) return 0;
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  hostsRefreshInFlight = (async () => {
    try {
      logI('[hosts] 全部域名不可达，从发布页拉取新域名');
      const added = await discoverHosts();
      await OmniBox.setCache(
        HOSTS_CACHE_KEY,
        { at: Date.now(), hosts: HOSTS.slice() },
        HOSTS_CACHE_TTL
      );
      return added;
    } catch (e) {
      logI(`[hosts] 拉取新域名异常: ${e.message}`);
      return 0;
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

/* ---------------- 带轮换的抓取 ---------------- */
async function fetchHtml(urlOrPath) {
  const isFull = /^https?:\/\//i.test(urlOrPath);
  const path = isFull ? new URL(urlOrPath).pathname + new URL(urlOrPath).search : urlOrPath;
  // 不做定时刷新；仅在全部域名失败时触发 discoverHosts（见下方重试逻辑）

  const tryAll = async () => {
    for (const idx of buildHostOrder()) {
      const host = HOSTS[idx];
      const url = isFull ? `${host}${path}` : host + urlOrPath;
      try {
        logI(`拉取 ${url}`);
        const r = await httpGet(url);
        const body = String(r.body || '');
        if (r.statusCode === 404) return { body: '', host, statusCode: 404 };
        if (r.statusCode >= 200 && r.statusCode < 400 && body.length >= 200) {
          markHost(host, true);
          PREFERRED = idx;
          return { body, host, statusCode: r.statusCode };
        }
        markHost(host, false, `HTTP ${r.statusCode}`);
      } catch (e) {
        markHost(host, false, e.message);
        logI(`${host} 请求异常: ${e.message}`);
      }
    }
    return null;
  };
  const hit = await tryAll();
  if (hit) return hit;
  if (!globalThis.__hjForceAt || Date.now() - globalThis.__hjForceAt >= 60000) {
    globalThis.__hjForceAt = Date.now();
    logI('所有候选域名不可达，强制刷新发布页域名池');
    await ensureHostsFresh(true);
    const retry = await tryAll();
    if (retry) return retry;
  }
  logE('所有候选域名均不可达');
  return { body: '', host: HOSTS[PREFERRED] || PRIMARY, statusCode: 0 };
}

/* ---------------- 工具 ---------------- */
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function fixUrl(u, host) {
  let s = String(u || '').replace(/&amp;/gi, '&').trim();
  if (!s) return '';
  s = s.replace(/\\\//g, '/');
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/') && host) return host + s;
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
async function resolveCover(url, host) {
  if (!url || !COVER_INLINE) return url || '';
  if (url.startsWith('data:')) return url;
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await fetchBinary(url, `${host}/`);
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
async function resolveCovers(list, host) {
  if (!COVER_INLINE || !Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const item = list[cursor++];
      if (item && item.vod_pic) {
        try { item.vod_pic = await resolveCover(item.vod_pic, host); } catch (_) {}
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, list.length) }, () => worker()));
  return list;
}

/**
 * 列表态补封面：往期/搜索列表页本身不含缩略图，封面只在详情页 og:image 里。
 * 只对前 N 条（默认 12）并发抓详情页取封面，避免拖慢列表；N=0 关闭。
 */
const COVER_FILL_COUNT = (() => {
  const raw = String(process.env.HJ_COVER_FILL || '').trim();
  const n = raw === '' ? 12 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(30, Math.floor(n)) : 12;
})();
async function fillListCovers(list, host) {
  if (!COVER_INLINE || !COVER_FILL_COUNT || !Array.isArray(list) || !list.length) return list;
  const targets = list.slice(0, COVER_FILL_COUNT).filter((v) => v && !v.vod_pic && v.vod_id);
  if (!targets.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      try {
        const r = await httpGet(`${host}/archives/${item.vod_id}/`, { timeout: 12000 });
        const body = String(r.body || '');
        if (!body) continue;
        let pic = pickCover(body);
        if (pic) item.vod_pic = await resolveCover(pic, host);
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, () => worker()));
  return list;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: 'home', type_name: '首页热门' },
  { type_id: 'archives', type_name: '往期合集' },
];

/* ---------------- 列表解析 ---------------- */
/** 往期列表：<li><div class="date">11-17</div><a class="history-text" href="/archives/{id}"><h3>标题</h3></a></li> */
function parseArchiveList(html, host) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  const re = /<div class="date">([^<]*)<\/div>\s*<a[^>]*class="[^"]*history-text[^"]*"[^>]*href="\/archives\/(\d+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const date = cleanText(m[1]);
    const id = m[2];
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(m[3]);
    const title = cleanText(h3 ? h3[1] : m[3]);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: '',
      vod_remarks: date,
      vod_tag: 'video',
      vod_url: `${host}/archives/${id}`,
    });
  }
  return list;
}
/** 首页/搜索的排行榜卡片（无封面）：a.rank-card > .rank-card-title + 热度 */
function parseRankCards(html, host) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  const re = /<a[^>]*href="\/archives\/(\d+)"[^>]*class="[^"]*rank-card[^"]*"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const id = m[1];
    const block = m[2];
    const t = /<div[^>]*class="[^"]*rank-card-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const title = cleanText(t ? t[1] : '');
    if (!id || !title || seen.has(id)) continue;
    const heat = /<span>([\d.]+[KM]?)<\/span>/i.exec(block);
    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: '',
      vod_remarks: heat ? heat[1] : '',
      vod_tag: 'video',
      vod_url: `${host}/archives/${id}`,
    });
  }
  return list;
}
/** 分页：/archives/page/{n}/ */
function parsePageCount(html) {
  const s = String(html || '');
  let max = 1;
  const re = /\/archives\/page\/(\d+)\//g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max && n < 100000) max = n;
  }
  return max;
}

/**
 * 从详情页 HTML 里找出封面：
 *   og:image 指向 expose.eisees.com（实测 0 字节不可用），
 *   按同名文件匹配 xi.dzuxta.cn 的带 auth_key 签名版本（可用且需 AES 解密）。
 */
function pickCover(html) {
  const s = String(html || '');
  const og = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i.exec(s);
  const ogUrl = og ? fixUrl(og[1]) : '';
  const fileName = ogUrl ? ogUrl.split('/').pop().split('?')[0] : '';
  if (fileName) {
    const xi = new RegExp(`(https://[a-z0-9.-]*dzuxta\\.cn[^"\\s\\\\]*${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"\\s\\\\]*)`, 'i').exec(s);
    if (xi) return fixUrl(xi[1]);
  }
  // 兜底：任意 xi.dzuxta.cn 的 xiao 图
  const anyXi = /(https:\/\/[a-z0-9.-]*dzuxta\.cn\/upload_01\/xiao\/[^"\s\\]+\.(?:jpe?g|png|webp)[^"\s\\]*)/i.exec(s);
  if (anyXi) return fixUrl(anyXi[1]);
  return ogUrl;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(id) {
  const cacheKey = `haijiao:detail:${id}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id && obj.vod_play_sources?.[0]?.episodes?.[0]?.playId) return obj;
    }
  } catch (_) {}

  const { body, host } = await fetchHtml(`/archives/${id}/`);
  if (!body) return null;

  const tm = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
  let title = cleanText(tm ? tm[1] : '').replace(/\s*[|｜]\s*海角.*$/, '').trim();
  const h1 = /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i.exec(body);
  if (h1) {
    const t = cleanText(h1[1]);
    if (t) title = t;
  }

  const desc = /<meta[^>]*name="description"[^>]*content="([^"]*)"/i.exec(body);
  const content = cleanText(desc ? desc[1] : '');

  let pic = pickCover(body);
  if (pic) pic = await resolveCover(pic, host);

  // 播放：DPlayer data-config 的 video.url / video.h_265
  const media = [];
  const cfgRe = /data-config='([^']+)'/gi;
  let cm;
  while ((cm = cfgRe.exec(body)) !== null) {
    try {
      const raw = cm[1].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
      const cfg = JSON.parse(raw);
      const v = cfg && cfg.video;
      if (v) {
        if (v.url) media.push({ url: fixUrl(v.url, host), name: 'H264/1080P' });
        if (v.h_265) media.push({ url: fixUrl(v.h_265, host), name: 'H265' });
      }
    } catch (_) {}
  }
  // 兜底：直接找 /media/m3u8/ 代理链接
  if (!media.length) {
    const re = /(\/media\/m3u8\/\?url=[^"'\s\\]+)/gi;
    let mm;
    while ((mm = re.exec(body)) !== null) {
      const u = fixUrl(mm[1], host);
      if (!media.some((x) => x.url === u)) media.push({ url: u, name: '线路' });
    }
  }

  const episodes = media.map((x, i) => ({ name: media.length > 1 ? x.name : '正片', playId: x.url }));
  const vod = {
    vod_id: String(id),
    vod_name: title || `海角 ${id}`,
    vod_pic: pic,
    vod_content: content,
    vod_remarks: episodes.length ? `${episodes.length} 线路` : '',
    vod_play_sources: episodes.length ? [{ name: '海角社区', episodes }] : [],
    vod_url: `${host}/archives/${id}/`,
  };
  if (episodes.length) {
    vod.vod_play_from = '海角社区';
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join('#');
  }
  try { await OmniBox.setCache(cacheKey, vod, 900); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 100)} from=${(context && context.from) || 'web'}`);
  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const host = HOSTS[PREFERRED] || PRIMARY;
  let url = fixUrl(rawId, host);
  if (url.startsWith('/')) url = host + url;

  const header = { 'User-Agent': UA, Referer: `${host}/` };

  // /media/m3u8/ 代理 或 直链
  if (/\/media\/m3u8\/|\.m3u8(\?|$)/i.test(url)) {
    return { parse: 0, jx: 0, flag: '海角社区', url, urls: [{ name: '正片', url }], header };
  }
  if (/\.(mp4|ts)(\?|$)/i.test(url)) {
    return { parse: 0, jx: 0, flag: '海角社区', url, urls: [{ name: '正片', url }], header };
  }
  // 数字 id → 现场解析
  if (/^\d+$/.test(url)) {
    try {
      const v = await fetchDetail(url);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) return {
        parse: 0, jx: 0, flag: '海角社区',
        url: first.playId,
        urls: [{ name: '正片', url: first.playId }],
        header,
      };
    } catch (_) {}
  }
  return { parse: 1, jx: 0, flag: '海角社区', url, urls: [{ name: '正片', url }], header };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const { body, host } = await fetchHtml('/');
    list = parseRankCards(body, host);
    list = await resolveCovers(list, host);
    logI(`home 返回 ${list.length} 条`);
  } catch (e) {
    logE(`home 异常: ${e.message}`);
  }
  return { class: cls, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const typeId = String((params && (params.categoryId || params.type_id || params.tid)) || 'home').trim();
  const page = Math.max(1, Number((params && params.page) || 1));
  logI(`category type=${typeId} page=${page}`);
  let list = [];
  let pagecount = 1;
  try {
    let path;
    if (typeId === 'archives') path = page > 1 ? `/archives/page/${page}/` : '/archives/';
    else path = page > 1 ? `/page/${page}/` : '/';
    const { body, host } = await fetchHtml(path);
    list = parseArchiveList(body, host);
    if (!list.length) list = parseRankCards(body, host);
    list = await fillListCovers(list, host);
    list = await resolveCovers(list, host);
    pagecount = parsePageCount(body);
    logI(`category 返回 ${list.length} 条，共 ${pagecount} 页`);
  } catch (e) {
    logE(`category 异常: ${e.message}`);
  }
  return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
}

async function detail(params, context) {
  const idRaw = String((params && (params.id || params.vod_id || params.videoId)) || '').trim();
  logI(`detail id=${idRaw}`);
  if (!idRaw) return { list: [] };
  let id = idRaw;
  const um = /\/archives\/(\d+)/i.exec(idRaw);
  if (um) id = um[1];
  if (!/^\d+$/.test(id)) return { list: [] };
  try {
    const v = await fetchDetail(id);
    if (!v) return { list: [] };
    logI(`detail 成功: ${v.vod_name.slice(0, 40)}，${v.vod_play_sources[0]?.episodes?.length || 0} 线路`);
    return { list: [v] };
  } catch (e) {
    logE(`detail 异常: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const wd = String((params && (params.wd || params.keyword || params.k)) || '').trim();
  const page = Math.max(1, Number((params && params.page) || 1));
  logI(`search wd=${wd} page=${page}`);
  if (!wd) return { page, pagecount: 1, total: 0, limit: 0, list: [] };
  let list = [];
  try {
    const path = page > 1
      ? `/search/${encodeURIComponent(wd)}?page=${page}`
      : `/search/${encodeURIComponent(wd)}`;
    const { body, host } = await fetchHtml(path);
    list = parseRankCards(body, host);
    if (!list.length) list = parseArchiveList(body, host);
    list = await fillListCovers(list, host);
    list = await resolveCovers(list, host);
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount: list.length >= 10 ? page + 1 : page, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
