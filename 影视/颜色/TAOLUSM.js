// @name TAOLUSM
// @author 宝宝巴士
// @description taolusm.com（套路调教视频）：修复主域名不可达时请求挂死（加硬超时 + 失败日志不再静默 + 探测超时 6s）；从地址发布页 itaolu.com 被动拉取备用域名（全部域名失败才拉，分批 10 个探测）；首页/分类/搜索/详情/播放；列表 module-poster-item 取封面；详情 const source 取 preview_mp4，免费或有权限时补 /v/{id}/manifest 完整 m3u8
// @version 1.0.3
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/TAOLUSM.js
// @dependencies []
/**
 * ============================================================================
 * TAOLUSM（taolusm.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-17 实测）】
 *   SM 调教主题视频站，服务端渲染 + Vue 指令（类 GCAV 同源架构）。
 *   首页：/                       （lozad 懒加载，70 个 /v/{id} 链接）
 *   分类：/juqing  /zhibo  /japanese-korean  /western  /free  /mistress
 *   分类分页：{分类}?page={n}      （★ query 参数，实测 page=2 首 id 变化）
 *   搜索：/search?q={关键词}       （可带 &page=n）
 *   详情：/v/{id}
 *
 * 【列表卡片】
 *   <a href="https://taolusm.com/v/{id}" title="标题" data-id="{id}"
 *      class="module-poster-item module-item group relative">
 *     <img data-src="https://tl.skylines.pro/covers/{id}.webp"
 *          src="data:image/..."  ← 占位图，必须跳过>
 *   注意：图床是 tl.skylines.pro（不是 GCAV 的 gc.skylines.pro）。
 *
 * 【详情 / 播放】
 *   行内脚本：
 *     const source = "https://tl.skylines.pro/preview_mp4/{id}.mp4";  ← 预览片
 *   封面用 og:image（https://tl.skylines.pro/thumbnails/{id}.jpg）。
 *   免费片/有权限时 GET /v/{id}/manifest 返回完整 m3u8（同 GCAV 模式）；
 *   受限时返回 200 空体，此时只能播 preview_mp4。
 *   play() 三段式：直链 → sniffVideo → parse=1 兜底。
 *
 * 【地址发布页（防失联）】
 *   发布页 https://itaolu.com/ 的「套路视频」区块列出本条线的全部备用域名
 *   （taolusm.com / taolu.sale / tlsm.app / tlsm.shop / taolu.red / tlsm.one ... 共 20 个）。
 *   策略：不做定时刷新；只有所有已知域名都访问失败时，才去发布页拉新域名；
 *   候选域名分批探测（每批 10 个，批间 200ms），避免一次打太多请求。
 *
 * 【环境变量】
 *   TAOLU_HOST          主站，默认 https://taolusm.com
 *   TAOLU_HOSTS         追加备用域名（逗号分隔）
 *   TAOLU_PUBLISH_PAGE  发布页，默认 https://itaolu.com/
 *   TAOLU_PROBE_BATCH   发布页候选分批大小，默认 10
 *   TAOLU_COOKIE        站点登录态 Cookie（带上后有权限的片可拿完整 m3u8）
 *   TAOLU_UA            自定义 User-Agent
 * ============================================================================
 */

const https = require("https");
const http = require("http");
const zlib = require("zlib");

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  OmniBox = {
    log() { /* 本地调试：不写 stdout */ },
    getCache() { return null; },
    setCache() { return Promise.resolve(); },
    deleteCache() { return Promise.resolve(); },
  };
}
let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

/* ---------------- 基础配置 ---------------- */
function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://taolusm.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "https://taolusm.com";
  }
}

/* ---------------- 域名池与发布页发现（被动触发） ---------------- */
const PUBLISH_PAGE = String(process.env.TAOLU_PUBLISH_PAGE || "https://itaolu.com/").trim();
const PUBLISH_SECTION = "套路视频";  // 发布页 h1「套路视频 - 导航站」区块，含 taolusm/taolu/tlsm 系列 20 个域名
const HOSTS_CACHE_KEY = "taolusm:hosts:v1";
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
const PROBE_BATCH_SIZE = (() => {
  const n = Number(String(process.env.TAOLU_PROBE_BATCH || "").trim() || 10);
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 10;
})();
const PROBE_BATCH_DELAY = 200;
const PROBE_TIMEOUT = Math.max(3000, Number(process.env.TAOLU_PROBE_TIMEOUT || 6000) || 6000);

/**
 * 内置备用域名（2026-11-17 从发布页 itaolu.com「套路视频」区块抄录）。
 * 作用：发布页本身不可达时（实测部分网络 Node 直连会 ECONNRESET，
 * 宿主 SDK 也可能被拦），仍有一批已知域名可轮换，不至于直接抓瞎。
 * 可用 TAOLU_HOSTS 追加，TAOLU_NO_BUILTIN=1 关闭内置列表。
 */
const BUILTIN_HOSTS = String(process.env.TAOLU_NO_BUILTIN || "") === "1" ? [] : [
  "https://taolusm.com",
  "https://taolu.sale",
  "https://tlsm.app",
  "https://tlsm.shop",
  "https://taolu.red",
  "https://tlsm.one",
  "https://taolu.bio",
  "https://tlsm.run",
  "https://tlsm.club",
  "https://tlsm.live",
  "https://taolu.pro",
  "https://taolusm.pro",
  "https://tlsm.net",
  "https://wetaolu.pro",
  "https://taolu99.space",
  "https://taolu.dog",
  "https://taolu.one",
  "https://tlsm.xyz",
  "https://tlsm.tv",
  "https://91taolu.mom",
];

const HOST_POOL = (() => {
  const primary = normalizeHost(process.env.TAOLU_HOST || "https://taolusm.com");
  const extra = String(process.env.TAOLU_HOSTS || "")
    .split(",").map((x) => x.trim()).filter(Boolean).map(normalizeHost);
  return Array.from(new Set([primary, ...extra, ...BUILTIN_HOSTS.map(normalizeHost)]));
})();
let HOST = HOST_POOL[0];
let HOST_POOL_READY = false;
let hostsRefreshInFlight = null;
const hostHealth = Object.create(null);

const SITE_COOKIE = String(process.env.TAOLU_COOKIE || "").trim();
const UA = String(process.env.TAOLU_UA || "").trim()
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(level, msg) {
  try {
    Promise.resolve(OmniBox.log(level, `[taolusm] ${msg}`)).catch(() => {});
  } catch (_) {}
}
function logI(m) { log("info", m); }
function logE(m) { log("error", m); }

/* ---------------- HTTP ---------------- */
function decompressText(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch (_) {}
  return buf;
}
/** 硬超时包装：宿主 OmniBox.request 不受 timeout 参数约束时会一直挂住，必须自己 race */
const REQUEST_HARD_TIMEOUT = Math.max(3000, Number(process.env.TAOLU_REQUEST_TIMEOUT || 12000) || 12000);
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
    if (redirects > 4) return reject(new Error("重定向过多"));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const client = isHttps ? https : http;
    const headers = Object.assign({}, options.headers || {}, {
      "Accept-Encoding": "gzip, deflate, br",
    });
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
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
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: decompressText(Buffer.concat(chunks), res.headers["content-encoding"]).toString("utf-8"),
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.end();
  });
}

/**
 * 从发布页 HTML 里抽出「国产AV视频」区块的域名列表。
 * 结构：<h1>国产AV视频</h1> ... <span class="text-primary">gcav.sale </span>
 */
function extractSectionHosts(html, sectionName) {
  const text = String(html || "");
  const key = String(sectionName || "").trim();
  if (!text || !key) return [];

  // 只在 <h1>...</h1> 里找区块标题，避免命中 <title> 里的同名文字
  const h1Re = /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/gi;
  let headStart = -1;
  let bodyStart = -1;
  const heads = [];
  let m;
  while ((m = h1Re.exec(text)) !== null) {
    heads.push({ start: m.index, end: m.index + m[0].length, text: clean(m[1]) });
    if (headStart < 0 && String(m[1]).includes(key)) {
      headStart = m.index;
      bodyStart = m.index + m[0].length;
    }
  }
  if (headStart < 0) return [];

  // 区块结束：下一个 h1（同级标题）
  const next = heads.find((h) => h.start > headStart);
  const block = text.slice(bodyStart, next ? next.start : undefined);

  const out = [];
  const seen = new Set();
  const re = /<span[^>]*class="[^"]*text-primary[^"]*"[^>]*>([\s\S]{0,80}?)<\/span>/gi;
  while ((m = re.exec(block)) !== null) {
    const raw = String(m[1] || "").replace(/<[^>]+>/g, "").trim();
    if (!/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(raw)) continue;
    const host = normalizeHost(raw);
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** 同构校验：首页能抓到 /v/{id} 才算真站 */
async function probeHost(host) {
  try {
    const r = await withHardTimeout(
      nodeRequest(`${host}/`, {
        timeout: PROBE_TIMEOUT,
        headers: { "User-Agent": UA, Referer: `${host}/` },
      }),
      PROBE_TIMEOUT,
      `probe ${host}`
    );
    const body = String(r.body || "");
    return r.statusCode >= 200 && r.statusCode < 400
      && body.length > 3000
      && /\/v\/\d+/.test(body);
  } catch (_) { return false; }
}

async function restoreHostCache() {
  if (HOST_POOL_READY) return;
  HOST_POOL_READY = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === "string") { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (obj && Array.isArray(obj.hosts)) {
      for (const h of obj.hosts) {
        if (typeof h !== "string" || !/^https?:\/\//i.test(h)) continue;
        const host = normalizeHost(h);
        if (!HOST_POOL.includes(host)) HOST_POOL.push(host);
      }
    }
  } catch (_) {}
}

/**
 * 拉发布页：SDK 优先、Node 直连兜底。
 * 实测部分网络环境下 Node 直连 itaolu.com 会被 ECONNRESET，
 * 而宿主 request 走宿主自己的网络栈/代理能通，所以必须先试 SDK。
 */
async function fetchPublishPage(url) {
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: `${url.replace(/\/+$/, "")}/`,
  };
  const timeout = Math.max(5000, Number(process.env.TAOLU_PUBLISH_TIMEOUT || 12000) || 12000);
  const errors = [];

  // ① 宿主 SDK
  if (OmniBox && typeof OmniBox.request === "function") {
    try {
      const r = await withHardTimeout(
        Promise.resolve(OmniBox.request(url, { method: "GET", headers, timeout })),
        timeout,
        `publish sdk ${url}`
      );
      const body = typeof r?.body === "string" ? r.body : "";
      if (Number(r?.statusCode) === 200 && body.length > 500) return body;
      errors.push(`sdk HTTP ${r?.statusCode ?? "?"} len=${body.length}`);
    } catch (e) {
      errors.push(`sdk ${e?.message || e}`);
    }
  }

  // ② Node 直连
  try {
    const r = await withHardTimeout(
      nodeRequest(url, { timeout, headers }),
      timeout,
      `publish node ${url}`
    );
    const body = String(r.body || "");
    if (Number(r.statusCode) === 200 && body.length > 500) return body;
    errors.push(`node HTTP ${r.statusCode} len=${body.length}`);
  } catch (e) {
    errors.push(`node ${e?.message || e}`);
  }

  throw new Error(`发布页两条通道均失败: ${errors.join(" | ")}`);
}

async function discoverHosts() {
  const candidates = new Set();
  let publishOk = false;
  try {
    logI(`[hosts] 拉取发布页 ${PUBLISH_PAGE}`);
    const body = await fetchPublishPage(PUBLISH_PAGE);
    publishOk = true;
    const found = extractSectionHosts(body, PUBLISH_SECTION);
    found.forEach((h) => candidates.add(h));
    logI(`[hosts] 发布页「${PUBLISH_SECTION}」解析到 ${found.length} 个域名`);
  } catch (e) {
    logI(`[hosts] 发布页拉取失败: ${e?.message || e}`);
  }

  if (!publishOk) {
    // 发布页拿不到 ≠ 没有新域名：保持现有池，交给调用方继续轮换/重试
    logI("[hosts] 发布页不可用，保留现有域名池不变");
    return 0;
  }

  const newOnes = Array.from(candidates).filter((h) => !HOST_POOL.includes(h));
  if (!newOnes.length) {
    logI("[hosts] 发布页无新域名，无需探测");
    return 0;
  }
  logI(`[hosts] 待探测 ${newOnes.length} 个新域名，每批 ${PROBE_BATCH_SIZE} 个`);

  let added = 0;
  for (let i = 0; i < newOnes.length; i += PROBE_BATCH_SIZE) {
    const batch = newOnes.slice(i, i + PROBE_BATCH_SIZE);
    const batchNo = Math.floor(i / PROBE_BATCH_SIZE) + 1;
    logI(`[hosts] 探测批次 ${batchNo}: ${batch.length} 个`);
    const results = await Promise.allSettled(batch.map((h) => probeHost(h)));
    for (let k = 0; k < batch.length; k++) {
      if (results[k].status !== "fulfilled" || !results[k].value) continue;
      const host = batch[k];
      HOST_POOL.push(host);
      hostHealth[host] = { fail: 0, okAt: Date.now() };
      added++;
      logI(`[hosts] 发现可用站点 -> ${host}`);
    }
    if (i + PROBE_BATCH_SIZE < newOnes.length) {
      await new Promise((r) => setTimeout(r, PROBE_BATCH_DELAY));
    }
  }
  if (added) logI(`[hosts] 本次新增 ${added} 个，池共 ${HOST_POOL.length} 个`);
  try {
    await OmniBox.setCache(
      HOSTS_CACHE_KEY,
      { at: Date.now(), hosts: HOST_POOL.slice() },
      HOSTS_CACHE_TTL
    );
  } catch (_) {}
  return added;
}

async function ensureHostsFresh(force) {
  await restoreHostCache();
  if (!force) return 0;
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  hostsRefreshInFlight = (async () => {
    try {
      logI("[hosts] 全部域名不可达，从发布页拉取新域名");
      return await discoverHosts();
    } catch (e) {
      logI(`[hosts] 拉取新域名异常: ${e?.message || e}`);
      return 0;
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

function swapHost(url, from, to) {
  if (!from || !to || from === to) return url;
  if (url === from || url.startsWith(from + "/")) return to + url.slice(from.length);
  return url;
}

/* ---------------- 缓存 ---------------- */
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) {
    h = (Math.imul(31, h) + String(str).charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
const memCache = new Map();
function buildCacheKey(...parts) {
  const raw = parts.map((p) => String(p == null ? "" : p)).join("|");
  return `taolusm:${hashCode(raw)}`;
}
async function getCachedText(key) {
  if (memCache.has(key)) return memCache.get(key);
  try {
    const v = await OmniBox.getCache(key);
    if (typeof v === "string") { memCache.set(key, v); return v; }
  } catch (_) {}
  return "";
}
async function setCachedText(key, value, ttl) {
  if (!value) return;
  memCache.set(key, value);
  try { await OmniBox.setCache(key, value, Math.max(60, Number(ttl) || 600)); } catch (_) {}
}

const BASE_TTL = Math.max(0, Number(process.env.TAOLU_CACHE_TTL || 600) || 600);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.round(BASE_TTL * 1.5));

/* ---------------- 请求（域名轮换 + 被动触发） ---------------- */
function buildCookie(extra) {
  return [SITE_COOKIE, String(extra || "").trim()].filter(Boolean).join("; ").replace(/;\s*;/g, "; ").trim();
}

async function requestOnce(url, options, host) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    Referer: `${host}/`,
    ...(options.headers || {}),
  };
  const cookie = buildCookie(options.cookie);
  if (cookie) headers.Cookie = cookie;

  const timeout = Math.max(3000, Number(options.timeout) || REQUEST_HARD_TIMEOUT);
  let res = null;
  // 宿主 SDK 加硬超时：实测宿主 request 在网络卡住时会挂 100s+ 且无视 timeout
  if (OmniBox && typeof OmniBox.request === "function") {
    try {
      res = await withHardTimeout(
        Promise.resolve(OmniBox.request(url, {
          method: options.method || "GET",
          headers,
          timeout,
        })),
        timeout,
        `sdk ${url}`
      );
    } catch (e) {
      logI(`[request] SDK 失败(${host}): ${e?.message || e}`);
      res = null;
    }
  }
  if (!res) {
    res = await withHardTimeout(
      nodeRequest(url, { method: options.method || "GET", headers, timeout }),
      timeout,
      `node ${url}`
    );
  }
  if (!res || Number(res.statusCode) !== 200) {
    throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  }
  return String(res.body || "");
}

async function requestText(url, options = {}) {
  await restoreHostCache();

  const tryHosts = async (hosts) => {
    let lastErr = null;
    for (const host of hosts) {
      const target = swapHost(url, HOST, host);
      try {
        const body = await requestOnce(target, options, host);
        if (host !== HOST) {
          logI(`[hosts] 切换到可用域名 ${host}`);
          HOST = host;
        }
        hostHealth[host] = { fail: 0, okAt: Date.now() };
        return body;
      } catch (e) {
        lastErr = e;
        hostHealth[host] = hostHealth[host] || { fail: 0 };
        hostHealth[host].fail += 1;
        logI(`[hosts] ${host} 失败: ${e?.message || e}`);
      }
    }
    throw lastErr || new Error("请求失败");
  };

  const ordered = [HOST, ...HOST_POOL.filter((h) => h !== HOST)];
  try {
    return await tryHosts(ordered);
  } catch (firstErr) {
    await ensureHostsFresh(true);
    const more = [HOST, ...HOST_POOL.filter((h) => h !== HOST)];
    try {
      return await tryHosts(more);
    } catch (_) {
      throw firstErr;
    }
  }
}

async function fetchHtml(url, ttl, options = {}) {
  const key = buildCacheKey(url, buildCookie(options.cookie));
  if (ttl > 0) {
    const cached = await getCachedText(key);
    if (cached) {
      logI(`[cache] 命中: ${url}, len=${cached.length}`);
      return cached;
    }
  }
  const body = await requestText(url, options);
  await setCachedText(key, body, ttl);
  return body;
}

/* ---------------- 工具 ---------------- */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}
function clean(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function absUrl(u, base) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  try { return new URL(s, `${base}/`).href; } catch (_) { return s; }
}
function normalizeVideoId(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/\/v\/(\d+)/);
  if (m) return m[1];
  return /^\d+$/.test(s) ? s : "";
}
function toInt(v, d = 1) {
  const n = parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}
async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (!list.length) return results;
  const size = Math.max(1, Math.min(limit || 1, list.length));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      try {
        results[index] = await worker(list[index], index);
      } catch (e) {
        results[index] = { error: e };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/* ---------------- 封面 CDN 兜底 ----------------
 * 站点主域和图片 CDN 是两套解析：
 *   站点  → taolusm.com（有发布页可切换）
 *   图床  → tl.skylines.pro（CloudFront）/ tl-b.skylines.pro（Bunny）
 * 主域换到新地址后，图床仍可能不可达（CloudFront 常被墙）。
 * 处理：同一张图按 CDN 列表依次尝试；全部失败则抓回字节内联成 data URI，
 * 彻底不依赖用户侧能否访问 CDN。
 * ================================================ */
const COVER_INLINE = process.env.TAOLU_COVER_INLINE !== "0";
const COVER_TIMEOUT = Math.max(3000, Number(process.env.TAOLU_COVER_TIMEOUT || 8000) || 8000);
const COVER_CDN_HOSTS = String(process.env.TAOLU_COVER_HOSTS || "").trim()
  ? String(process.env.TAOLU_COVER_HOSTS).split(",").map((x) => x.trim()).filter(Boolean)
  : ["tl.skylines.pro", "tl-b.skylines.pro"];
const coverCache = new Map();

function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}
/** 抓图片原始字节（带 Referer，绕防盗链） */
function fetchImageBinary(urlStr, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error("图片重定向过多"));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const client = isHttps ? https : http;
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": UA,
        Referer: referer,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      },
      timeout: COVER_TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchImageBinary(new URL(res.headers.location, u.href).href, referer, redirects + 1)
          .then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let buf = raw;
        try {
          if (enc.includes("br")) buf = zlib.brotliDecompressSync(raw);
          else if (enc.includes("gzip")) buf = zlib.gunzipSync(raw);
          else if (enc.includes("deflate")) buf = zlib.inflateSync(raw);
        } catch (_) {}
        resolve({ statusCode: res.statusCode, body: buf });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("封面超时")); });
    req.end();
  });
}
/** 把图片 URL 换成同路径的另一个 CDN 域 */
function swapCoverCdn(url, fromHost, toHost) {
  try {
    const u = new URL(url);
    if (u.hostname !== fromHost) return url;
    u.hostname = toHost;
    return u.href;
  } catch (_) { return url; }
}

/**
 * 解决封面：
 *  1) 依次尝试各 CDN 域；
 *  2) 任一域返回真实图片字节 → 内联 data URI（避免用户侧再请求 CDN）；
 *  3) 全部失败 → 返回原始 URL（至少保留信息，不阻断列表）。
 */
async function resolveCover(url, refererHost) {
  if (!url || url.startsWith("data:")) return url || "";
  if (coverCache.has(url)) return coverCache.get(url);

  const referer = `${refererHost || HOST}/`;
  const candidates = [url];
  try {
    const host = new URL(url).hostname;
    for (const cdn of COVER_CDN_HOSTS) {
      if (cdn !== host) candidates.push(swapCoverCdn(url, host, cdn));
    }
  } catch (_) {}

  for (const cand of candidates) {
    try {
      const r = await withHardTimeout(
        fetchImageBinary(cand, referer),
        COVER_TIMEOUT + 1000,
        `cover ${cand}`
      );
      const mime = sniffImageMime(r.body);
      if (r.statusCode === 200 && mime) {
        if (!COVER_INLINE) {
          coverCache.set(url, cand);
          return cand;
        }
        const uri = `data:${mime};base64,${r.body.toString("base64")}`;
        if (coverCache.size >= 300) coverCache.delete(coverCache.keys().next().value);
        coverCache.set(url, uri);
        return uri;
      }
    } catch (_) {}
  }
  logI(`[cover] 全部 CDN 失败，保留原 URL: ${String(url).slice(0, 80)}`);
  coverCache.set(url, url);
  return url;
}

/** 批量处理列表封面（限并发，失败不阻断） */
async function resolveCovers(list, refererHost) {
  if (!Array.isArray(list) || !list.length) return list;
  const targets = list.filter((v) => v && v.vod_pic && !String(v.vod_pic).startsWith("data:"));
  if (!targets.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      try { item.vod_pic = await resolveCover(item.vod_pic, refererHost); } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, () => worker()));
  return list;
}

/* ---------------- 分类 ---------------- */
const CLASS_LIST = [
  { type_id: "juqing", type_name: "剧情调教" },
  { type_id: "zhibo", type_name: "直播实录" },
  { type_id: "mistress", type_name: "女主男奴" },
  { type_id: "japanese-korean", type_name: "日韩" },
  { type_id: "western", type_name: "欧美" },
  { type_id: "free", type_name: "免费专区" },
];
const CLASS_MAP = new Map(CLASS_LIST.map((c) => [c.type_id, c]));

/* ---------------- 列表解析 ---------------- */
/**
 * 正则解析卡片（不依赖 cheerio，宿主无该依赖也能工作）。
 * <a href="https://taolusm.com/v/{id}" title="..." data-id="{id}"
 *    class="module-poster-item module-item group relative">
 *   <img data-src="https://tl.skylines.pro/covers/{id}.webp" src="data:...">
 */
function parseListByRegex(html, categoryId) {
  const text = String(html || "");
  const list = [];
  const seen = new Set();
  const re = /<a\b[^>]*class="[^"]*module-poster-item[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const inner = m[1];
    const hrefM = /\bhref="([^"]+)"/i.exec(openTag);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    const idM = href.match(/\/v\/(\d+)/);
    if (!idM) continue;
    const dataIdM = /\bdata-id="([^"]*)"/i.exec(openTag);
    const id = String((dataIdM && dataIdM[1]) || idM[1]).trim();
    if (!id || seen.has(id)) continue;

    const titleM = /\btitle="([^"]*)"/i.exec(openTag);
    let name = clean((titleM && titleM[1]) || "");
    if (!name) {
      // 兜底：卡片内最后一段文本（标题在 <span class="text-secondary"> 里）
      const sp = /<span[^>]*class="[^"]*text-secondary[^"]*"[^>]*>([\s\S]{0,200}?)<\/span>/i.exec(inner);
      name = clean(sp ? sp[1] : "");
    }
    if (!name) continue;

    // 封面：只认 data-src / data-original，跳过 base64 占位
    let pic = "";
    const dsM = /<img\b[^>]*\bdata-src="([^"]+)"/i.exec(inner);
    const doM = /<img\b[^>]*\bdata-original="([^"]+)"/i.exec(inner);
    for (const cand of [dsM && dsM[1], doM && doM[1]]) {
      const v = decodeEntities(cand || "");
      if (v && !/^data:|placeholder/i.test(v)) { pic = v; break; }
    }

    const durM = /<span[^>]*class="[^"]*(?:duration|time)[^"]*"[^>]*>([^<]*)</i.exec(inner);
    const duration = clean(durM ? durM[1] : "");

    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: name,
      vod_pic: pic,
      type_id: String(categoryId || "juqing"),
      type_name: (CLASS_MAP.get(categoryId) || CLASS_LIST[0]).type_name,
      vod_remarks: duration || "",
    });
  }
  return list;
}

function parsePageCount(html, fallback = 1) {
  const text = String(html || "");
  let max = 0;
  const re = /[?&]page=(\d{1,6})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]) || 0;
    if (n > max && n < 100000) max = n;
  }
  // 没有分页链接时：本页有内容就认为还有下一页
  return max || Number(fallback) || 1;
}

/* ---------------- 详情 ---------------- */
/** 详情页行内脚本里的 const source（预览片；JS 字符串转义需还原） */
function parseSource(html) {
  const m = /const\s+source\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(String(html || ""));
  if (!m) return "";
  let s = m[1];
  try { s = JSON.parse(`"${s}"`); } catch (_) {
    s = s.replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
  }
  return /^https?:\/\//i.test(s) ? s : "";
}
function parseCover(html) {
  const s = String(html || "");
  const og = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i.exec(s);
  if (og && og[1]) return decodeEntities(og[1]);
  const img = /<img[^>]*\bdata-src="(https?:\/\/[^"]*\/covers\/[^"]+)"/i.exec(s);
  if (img) return decodeEntities(img[1]);
  return "";
}
function parseTitle(html) {
  const s = String(html || "");
  const h1 = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(s);
  if (h1) {
    const t = clean(h1[1]);
    if (t) return t;
  }
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(s);
  if (title) return clean(title[1]).split(/\s+-\s+/)[0].trim();
  return "";
}
function parseDesc(html) {
  const m = /<meta[^>]*name="description"[^>]*content="([^"]*)"/i.exec(String(html || ""));
  return m ? decodeEntities(m[1]).trim() : "";
}

/** 探测完整片权限：GET /v/{id}/manifest，返回 m3u8 纯文本即为有权限 */
async function probeManifest(videoId) {
  const id = normalizeVideoId(videoId);
  if (!id) return { hasAccess: false, manifest: "" };
  const key = buildCacheKey("manifest", id, SITE_COOKIE ? "auth" : "anon");
  const cached = await getCachedText(key);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (obj && typeof obj.hasAccess === "boolean") return obj;
    } catch (_) {}
  }
  let hasAccess = false;
  let manifest = "";
  try {
    const body = (await requestText(`${HOST}/v/${id}/manifest`)).trim();
    if (/^https?:\/\//i.test(body) || /\.m3u8/i.test(body)) {
      manifest = body.split(/\s+/)[0].trim();
      hasAccess = true;
    }
  } catch (e) {
    logI(`[manifest] ${id} 不可用: ${e?.message || e}`);
  }
  const result = { hasAccess, manifest };
  await setCachedText(key, JSON.stringify(result), DETAIL_TTL);
  return result;
}

async function fetchDetail(videoId) {
  const id = normalizeVideoId(videoId);
  if (!id) return null;
  const cacheKey = buildCacheKey("detail", id);
  const cached = await getCachedText(cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (obj && obj.vod_id) return obj;
    } catch (_) {}
  }

  const html = await fetchHtml(`${HOST}/v/${id}`, DETAIL_TTL);
  const title = parseTitle(html) || `TAOLUSM ${id}`;
  let pic = parseCover(html);
  if (pic) pic = await resolveCover(pic, HOST);
  const content = parseDesc(html);
  const preview = parseSource(html);
  const { hasAccess, manifest } = await probeManifest(id);

  const episodes = [];
  if (manifest) episodes.push({ name: "完整版", playId: manifest });
  if (preview) episodes.push({ name: manifest ? "预览" : "预览片", playId: preview });

  const vod = {
    vod_id: id,
    vod_name: title,
    vod_pic: pic,
    vod_content: content,
    vod_remarks: manifest ? "完整版" : "预览",
    vod_play_sources: episodes.length ? [{ name: "套路调教", episodes }] : [],
    vod_url: `${HOST}/v/${id}`,
    _hasAccess: hasAccess,
  };
  if (episodes.length) {
    vod.vod_play_from = "套路调教";
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join("#");
  }
  await setCachedText(cacheKey, JSON.stringify(vod), DETAIL_TTL);
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const p = params || {};
  const rawId = String(p.playId || p.id || p.url || "").trim();
  logI(`[play] playId=${rawId.slice(0, 110)} from=${context?.from || "web"}`);
  if (!rawId) return { parse: 0, jx: 0, urls: [] };

  const header = { "User-Agent": UA, Referer: `${HOST}/`, Origin: HOST };
  if (SITE_COOKIE) header.Cookie = SITE_COOKIE;

  // 明确媒体直链（m3u8 / mp4）→ 直接播
  if (/\.(m3u8|mp4)(\?|$)/i.test(rawId)) {
    return {
      parse: 0, jx: 0, flag: "套路调教",
      url: rawId,
      urls: [{ name: "正片", url: rawId }],
      header,
    };
  }

  // 纯数字 id → 现场解析详情
  if (/^\d+$/.test(rawId)) {
    try {
      const v = await fetchDetail(rawId);
      const first = v?.vod_play_sources?.[0]?.episodes?.[0];
      if (first) {
        return {
          parse: 0, jx: 0, flag: "套路调教",
          url: first.playId,
          urls: [{ name: first.name || "正片", url: first.playId }],
          header,
        };
      }
    } catch (e) {
      logI(`[play] 解析 id=${rawId} 失败: ${e?.message || e}`);
    }
  }

  // 网页 URL → 尝试 SDK 嗅探，失败再 parse=1
  try {
    if (OmniBox && typeof OmniBox.sniffVideo === "function") {
      const sniffed = await OmniBox.sniffVideo(rawId, header);
      const u = typeof sniffed === "string" ? sniffed : (sniffed && (sniffed.url || sniffed.videoUrl));
      if (u && /^https?:\/\//i.test(u)) {
        logI(`[play] SDK 嗅探成功 -> ${u.slice(0, 100)}`);
        return { parse: 0, jx: 0, flag: "套路调教", url: u, urls: [{ name: "正片", url: u }], header };
      }
    }
  } catch (e) {
    logI(`[play] SDK 嗅探失败，回退 parse=1: ${e?.message || e}`);
  }

  return {
    parse: 1, jx: 0, flag: "套路调教",
    url: rawId,
    urls: [{ name: "正片", url: rawId }],
    header,
  };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  try {
    logI(`[home] from=${context?.from || "web"} host=${HOST}`);
    const html = await fetchHtml(`${HOST}/`, HOME_TTL);
    let list = parseListByRegex(html, "juqing");
    list = await resolveCovers(list, HOST);
    logI(`[home] 返回 ${list.length} 条`);
    return { class: CLASS_LIST, filters: {}, list, parse: 0, jx: 0 };
  } catch (e) {
    logE(`[home] 失败: ${e?.message || e}`);
    return { class: CLASS_LIST, filters: {}, list: [], parse: 0, jx: 0 };
  }
}

async function category(params, context) {
  const p = params || {};
  const categoryId = String(p.categoryId || p.type_id || p.tid || "juqing").trim();
  const page = toInt(p.page, 1);
  try {
    logI(`[category] type=${categoryId} page=${page}`);
    const base = `${HOST}/${encodeURIComponent(categoryId)}`;
    const url = page > 1 ? `${base}?page=${page}` : base;
    const html = await fetchHtml(url, CATEGORY_TTL);
    const list = await resolveCovers(parseListByRegex(html, categoryId), HOST);
    const pagecount = parsePageCount(html, list.length ? page + 1 : page);
    logI(`[category] 返回 ${list.length} 条，pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    logE(`[category] 失败: ${e?.message || e}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === "string" ? params : (p.vod_id || p.id || p.videoId || "");
  const id = normalizeVideoId(raw);
  logI(`[detail] id=${id || "(空)"}`);
  if (!id) return { list: [] };
  try {
    const v = await fetchDetail(id);
    if (!v) return { list: [] };
    logI(`[detail] 成功: ${String(v.vod_name).slice(0, 40)}，${v.vod_play_sources?.[0]?.episodes?.length || 0} 线路`);
    return { list: [v] };
  } catch (e) {
    logE(`[detail] 失败: ${e?.message || e}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const wd = String(p.wd || p.keyword || p.k || "").trim();
  const page = toInt(p.page, 1);
  logI(`[search] wd=${wd} page=${page}`);
  if (!wd) return { page: 1, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const url = `${HOST}/search?q=${encodeURIComponent(wd)}${page > 1 ? `&page=${page}` : ""}`;
    const html = await fetchHtml(url, SEARCH_TTL);
    const list = await resolveCovers(parseListByRegex(html, "juqing"), HOST);
    const pagecount = parsePageCount(html, list.length ? page + 1 : page);
    logI(`[search] 返回 ${list.length} 条`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    logE(`[search] 失败: ${e?.message || e}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

const exported = { home, category, detail, search, play };
if (typeof module !== "undefined" && module.exports) module.exports = exported;
if (runner && typeof runner.run === "function") runner.run(exported);
