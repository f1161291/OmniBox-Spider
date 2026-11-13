// @name 饭搭子影视
// @version 1.0.5
// @author omnibox-spider
// @description 饭搭子影视（fdzys.com）OmniBox Spider：官网 SSR 首页/分类/搜索/详情，播放页 player_aaaa 解直链，多线路自动探测 m3u8 + 首分片后自动选择最优线路；支持官方平台页面嗅探/parse=1 兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/饭搭子影视.js
// @dependencies []

// 【环境变量】站点是 HTML 前台而非 JSON 采集 API，因此站点地址使用 XXX_HOST 风格的 FDZYS_HOST，
// 不复用 SITE_API（SITE_API 在仓库语义里是采集站 JSON 接口）。
//  FDZYS_HOST            站点基址，默认 https://fdzys.com
//  SITE_UA / FDZYS_UA    请求 UA；优先复用已有 SITE_UA
//  FDZYS_COOKIE          可选站点 Cookie
//  FDZYS_HTTP_MODE       请求通道 auto|sdk|native，默认 auto（优先 OmniBox.request，失败回退裸 HTTPS）
//  FDZYS_TIMEOUT         普通页面请求超时毫秒，默认 15000
//  FDZYS_CACHE_TTL       页面缓存秒数，默认 300
//  FDZYS_DETAIL_TTL      详情/播放页缓存秒数，默认 600
//  FDZYS_FILTER_TTL      筛选定义缓存秒数，默认 1800
//  FDZYS_AUTO_PROBE      是否启用多线路自动探测，默认 1；设 0 直接取首选线路
//  FDZYS_MAX_ROUTES      自动探测最多线路数，默认 11
//  FDZYS_PROBE_LIMIT     线路探测并发数，默认 4
//  FDZYS_PROBE_TIMEOUT   单线路探测超时毫秒，默认 4000
//  FDZYS_PROBE_CACHE_TTL 线路探测结果缓存秒数，默认 600；设 0 关闭
//  FDZYS_PLAY_TTL        播放页解析结果缓存秒数，默认 180

// OmniBox 宿主用 stdout 传递 JSON 响应；部分版本的 omnibox_sdk.log 会把日志
// 序列化成 JSON 字符串写入同一 stdout，Go 宿主读 search/play 响应时先读到字符串，
// 报 "cannot unmarshal string into Go value of type models.SpiderSearchResponse"。
// 这里在模块加载最早期劫持 stdout：非对象/非数组的 JSON 字符串统一改走 stderr。
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
function _safeStderr(chunk, encoding, cb) {
  try { return _origStderrWrite(chunk, encoding, cb); } catch (_) { return true; }
}
function _installStdoutGuard() {
  if (process.stdout.__fdzysGuard || process.stdout.__omniStdoutGuard) return;
  process.stdout.__fdzysGuard = true;
  const state = { inJson: false, pending: "" };
  const parseOk = (text) => { try { JSON.parse(text); return true; } catch (_) { return false; } };
  const jsonStart = (text) => /^\{/.test(text) || /^\[\s*(?:\{|\[|"|-?\d|true|false|null|\])/.test(text);
  process.stdout.write = function (chunk, encoding, cb) {
    const text = String(chunk == null ? "" : chunk);
    if (state.inJson) {
      state.pending += text;
      if (parseOk(state.pending.trim())) { state.pending = ""; state.inJson = false; }
      return _origStdoutWrite(chunk, encoding, cb);
    }
    const trimmed = text.trim();
    if (!trimmed) return _origStdoutWrite(chunk, encoding, cb);
    let parsed;
    let complete = false;
    try { parsed = JSON.parse(trimmed); complete = true; } catch (_) {}
    if (complete) {
      // 完整 JSON：字符串/数字/布尔/null 是 SDK 日志，改走 stderr；对象/数组放行。
      if (parsed === null || ["string", "number", "boolean"].includes(typeof parsed)) {
        return _safeStderr(chunk, encoding, cb);
      }
      return _origStdoutWrite(chunk, encoding, cb);
    }
    if (jsonStart(trimmed)) {
      // runner 分片写 JSON 响应：进入透传状态，后续分片全部放行。
      state.inJson = true;
      state.pending = text;
      return _origStdoutWrite(chunk, encoding, cb);
    }
    // 其余纯文本统一视为日志，改走 stderr。
    return _safeStderr(chunk, encoding, cb);
  };
}
_installStdoutGuard();

const OmniBox = (() => {
  try { return require("omnibox_sdk"); } catch (_) { return {}; }
})();
let runner;
try { runner = require("spider_runner"); } catch (_) { runner = { run() {} }; }

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PREFIX = "[fdzys]";
const DEFAULT_HOST = "https://fdzys.com";
const SITE = normalizeHost(process.env.FDZYS_HOST || DEFAULT_HOST);
const UA = String(process.env.SITE_UA || process.env.FDZYS_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36").trim();
const COOKIE = String(process.env.FDZYS_COOKIE || "").trim();
const TIMEOUT = Math.max(3000, Number(process.env.FDZYS_TIMEOUT || 15000) || 15000);
const CACHE_TTL = Math.max(30, Number(process.env.FDZYS_CACHE_TTL || 300) || 300);
const DETAIL_TTL = Math.max(60, Number(process.env.FDZYS_DETAIL_TTL || 600) || 600);
const FILTER_TTL = Math.max(300, Number(process.env.FDZYS_FILTER_TTL || 1800) || 1800);
const PLAY_TTL = Math.max(30, Number(process.env.FDZYS_PLAY_TTL || 180) || 180);
const AUTO_PROBE = !["0", "false", "no", "off"].includes(String(process.env.FDZYS_AUTO_PROBE || "1").trim().toLowerCase());
const MAX_ROUTES = Math.max(1, Math.min(20, Number(process.env.FDZYS_MAX_ROUTES || 11) || 11));
const PROBE_LIMIT = Math.max(1, Math.min(8, Number(process.env.FDZYS_PROBE_LIMIT || 4) || 4));
const PROBE_TIMEOUT = Math.max(1000, Number(process.env.FDZYS_PROBE_TIMEOUT || 4000) || 4000);
const PROBE_CACHE_TTL = Math.max(0, Number(process.env.FDZYS_PROBE_CACHE_TTL || 600) || 0);
const HTTP_MODE = String(process.env.FDZYS_HTTP_MODE || 'auto').trim().toLowerCase();

// runner 用 stdout 传递 JSON 响应；日志全部写 stderr，避免异步日志污染下一集响应。
function logI(message) {
  try { process.stderr.write(`[info] ${PREFIX} ${message}\n`); } catch (_) {}
}
function logE(message) {
  try { process.stderr.write(`[error] ${PREFIX} ${message}\n`); } catch (_) {}
}

const CLASS_LIST = [
  { type_id: "movie/all", type_name: "电影", key: "movie" },
  { type_id: "tv/all", type_name: "电视剧", key: "tv" },
  { type_id: "dongman/all", type_name: "动漫片", key: "dongman" },
  { type_id: "zongyi/all", type_name: "综艺片", key: "zongyi" },
  { type_id: "tiyu/all", type_name: "体育", key: "tiyu" },
  { type_id: "duanju/all", type_name: "短剧", key: "duanju" },
];
const CATEGORY_KEYS = CLASS_LIST.map((c) => c.key);
const MAIN_PATH_RE = /^(movie|tv|dongman|zongyi|tiyu|duanju)(?:\/|$)/;
const FILTER_TITLE_KEY = { "类型": "type", "地区": "area", "语言": "lang", "年份": "year", "排序": "sort" };
const FILTER_ORDER = ["type", "area", "lang", "year", "sort"];
const TRUSTED_FROMS = new Set(["bilibili", "mgtv", "qiyi", "iqiyi", "qq", "youku"]);
const OFFICIAL_FROM_NAMES = {
  bilibili: "哔哩哔哩", mgtv: "芒果TV", qiyi: "爱奇艺", iqiyi: "爱奇艺",
  qq: "腾讯视频", youku: "优酷",
};

const memCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeHost(value) {
  let s = String(value || "").trim().replace(/\/+$/, "");
  if (!s) s = DEFAULT_HOST;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}
function absUrl(href, base = SITE) {
  try { return new URL(String(href || "").trim(), base).href; } catch (_) { return ""; }
}
function withTimeout(promise, ms, fallbackValue) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallbackValue), Math.max(500, ms));
    Promise.resolve(promise).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallbackValue);
    });
  });
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}
function cacheKey(prefix, raw) {
  return `fdzys:${prefix}:${sha1(raw).slice(0, 28)}`;
}
async function cacheGet(key) {
  const hit = memCache.get(key);
  if (hit) {
    if (Date.now() > hit.expire) memCache.delete(key);
    else return hit.value;
  }
  if (OmniBox && typeof OmniBox.getCache === "function") {
    try {
      const v = await withTimeout(Promise.resolve(OmniBox.getCache(key)), 800, null);
      if (v != null) {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        memCache.set(key, { value: parsed, expire: Date.now() + CACHE_TTL * 1000 });
        return parsed;
      }
    } catch (_) { /* SDK 缓存不可用时静默回退 */ }
  }
  return null;
}
async function cacheSet(key, value, ttlSeconds) {
  const ttl = Math.max(0, Number(ttlSeconds || CACHE_TTL));
  memCache.set(key, { value, expire: Date.now() + ttl * 1000 });
  while (memCache.size > 320) memCache.delete(memCache.keys().next().value);
  // SDK 持久缓存只做后台尽力而为，绝不 await 阻塞 handler 返回。
  try {
    if (OmniBox && typeof OmniBox.setCache === "function" && ttl > 0) {
      const p = OmniBox.setCache(key, JSON.stringify(value), ttl);
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (_) {}
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();
}
function stripTags(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}
function cleanText(value) { return stripTags(value).replace(/\s+/g, " ").trim(); }
function cleanVodName(value) {
  return cleanText(value)
    .replace(/(?:免费在线观看|高清播放|完整版|在线播放|高清电视剧|高清电影|饭搭子影视|_).*$/i, "")
    .replace(/\s*[|｜]\s*.*$/, "")
    .replace(/[\s_]+$/, "")
    .trim();
}
function objectOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const v = JSON.parse(value); return v && typeof v === "object" ? v : {}; } catch (_) { return {}; }
  }
  return {};
}
function str(value) { return String(value == null ? "" : value).trim(); }
function toInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}
function extractYear(value, fallback = "") {
  const maxYear = new Date().getFullYear() + 2;
  const m = String(value || "").match(/(?:^|\D)((?:19|20)\d{2})(?=$|\D)/);
  const y = m ? Number(m[1]) : 0;
  return y >= 1900 && y <= maxYear ? String(y) : fallback;
}
function unescapeLegacy(value) {
  let s = String(value || "").replace(/%u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  try { return decodeURIComponent(s); } catch (_) { return s; }
}
function decryptPlayerUrl(data) {
  let u = str(data && data.url) || str(data && data.url_next);
  if (!u) return "";
  try {
    const enc = String(data.encrypt ?? 0);
    if (enc === "1") u = unescapeLegacy(u);
    else if (enc === "2") u = unescapeLegacy(Buffer.from(u, "base64").toString("binary"));
  } catch (_) {}
  return u;
}

function decompress(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch (_) { return buf; }
  return buf;
}
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 12, maxFreeSockets: 6, timeout: 60000 });
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 12, maxFreeSockets: 6, timeout: 60000 });

function buildHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/json,application/vnd.apple.mpegurl,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": SITE + "/",
    ...(COOKIE ? { Cookie: COOKIE } : {}),
    ...extra,
  };
}

function nativeHttpGet(url, options = {}, redirectLeft = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ statusCode: 0, headers: {}, body: "", bytes: 0, error: "非法 URL" }); }
    const mod = u.protocol === "https:" ? https : http;
    const timeout = Math.max(500, Number(options.timeout || TIMEOUT));
    const maxBytes = Math.max(1024, Number(options.maxBytes || 4 * 1024 * 1024));
    const headers = buildHeaders(options.headers || {});
    const reqOptions = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers,
      timeout,
      rejectUnauthorized: false,
      agent: u.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
    };
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = mod.request(reqOptions, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && loc && redirectLeft > 0) {
        res.resume();
        const next = absUrl(loc, u.href);
        if (next) return nativeHttpGet(next, options, redirectLeft - 1).then(done);
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= maxBytes) chunks.push(chunk);
        else if (chunks.length && chunks[chunks.length - 1].length < maxBytes) {
          const remain = maxBytes - chunks.reduce((n, c) => n + c.length, 0);
          if (remain > 0) chunks.push(chunk.subarray(0, remain));
        }
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const body = decompress(raw, res.headers["content-encoding"]).toString("utf8");
        done({ statusCode: status, headers: res.headers || {}, body, bytes, error: "" });
      });
    });
    req.on("timeout", () => { req.destroy(); done({ statusCode: 0, headers: {}, body: "", bytes: 0, error: `超时 ${timeout}ms` }); });
    req.on("error", (err) => done({ statusCode: 0, headers: {}, body: "", bytes: 0, error: err.message || String(err) }));
    req.end();
  });
}

function isBlockedHtml(body) {
  const head = String(body || "").slice(0, 30000);
  return /Just a moment|cf-challenge|cf-browser-verification|Attention Required|Access denied|403 Forbidden|请开启 JavaScript|请稍候|访问验证/i.test(head);
}
async function sdkRequest(url, options = {}) {
  if (!OmniBox || typeof OmniBox.request !== "function") return null;
  const headers = { ...buildHeaders(options.headers || {}), "Accept-Encoding": "identity" };
  const task = Promise.resolve(OmniBox.request(url, { method: options.method || "GET", headers }));
  const res = await withTimeout(task, Math.min(Math.max(2000, Number(options.timeout || TIMEOUT)), 8000), null);
  if (!res) return null;
  let body = typeof res.body === "string" ? res.body
    : (Buffer.isBuffer(res.body) ? res.body.toString("utf8") : "");
  if (body && body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) {
    try { body = zlib.gunzipSync(Buffer.from(body, "binary")).toString("utf8"); } catch (_) {}
  }
  const status = Number(res.statusCode ?? res.status ?? 0);
  return { statusCode: status, headers: res.headers || {}, body, bytes: Buffer.byteLength(body), error: "", source: "sdk" };
}
async function httpGet(url, options = {}, redirectLeft = 3) {
  if (HTTP_MODE !== "native") {
    try {
      const r = await sdkRequest(url, options);
      if (r && r.statusCode === 200 && r.body && !isBlockedHtml(r.body)) return r;
      if (r && r.statusCode && r.statusCode !== 200 && !isBlockedHtml(r.body || "")) {
        logI(`[http] SDK 返回 HTTP ${r.statusCode}，回退裸请求 url=${String(url).slice(0, 100)}`);
      }
    } catch (err) {
      logI(`[http] SDK 通道不可用，回退裸请求 url=${String(url).slice(0, 100)} err=${err.message || err}`);
    }
    if (HTTP_MODE === "sdk") {
      return { statusCode: 0, headers: {}, body: "", bytes: 0, error: "SDK 请求失败", source: "sdk" };
    }
  }
  const native = await nativeHttpGet(url, options, redirectLeft);
  native.source = "native";
  return native;
}

async function getHtml(url, options = {}, ttl = CACHE_TTL) {
  const key = cacheKey("html", url);
  const cached = await cacheGet(key);
  if (cached && typeof cached.body === "string" && cached.body) return cached.body;
  let res = await httpGet(url, options);
  if ((res.statusCode !== 200 || !res.body || isBlockedHtml(res.body)) && HTTP_MODE !== "sdk") {
    logI(`[http] 首次响应异常，重试 url=${String(url).slice(0, 110)} status=${res.statusCode} src=${res.source || "?"}`);
    res = await httpGet(url, {
      ...options,
      headers: { ...(options.headers || {}), "Cache-Control": "no-cache", Accept: "text/html,application/xhtml+xml,*/*" },
    }, 3);
  }
  if (res.statusCode !== 200 || !res.body || isBlockedHtml(res.body)) {
    throw new Error(`HTTP ${res.statusCode} ${res.error || ""} bodyLen=${res.body.length} src=${res.source || "?"}`);
  }
  await cacheSet(key, { body: res.body }, ttl);
  return res.body;
}
async function getHtmlCached(url, ttl = CACHE_TTL) {
  return await getHtml(url, { timeout: TIMEOUT }, ttl);
}

function normalizeVodPath(input) {
  let s = str(input);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch (_) { return ""; }
  }
  s = s.split("?")[0].split("#")[0].replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2 && MAIN_PATH_RE.test(parts[0])) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 1 && /^[a-z0-9-]+$/i.test(parts[0])) return `movie/${parts[0]}`;
  return "";
}
function normalizeCategoryPath(input) {
  let s = str(input);
  if (!s) return "movie/all";
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch (_) { return "movie/all"; }
  }
  s = s.split("?")[0].split("#")[0].replace(/^\/+/, "").replace(/\/+$/, "");
  if (!MAIN_PATH_RE.test(s)) return "movie/all";
  const parts = s.split("/").filter(Boolean);
  if (parts.length === 1) return `${parts[0]}/all`;
  return parts.slice(0, 2).join("/");
}
function categoryKeyOf(pathOrId) {
  const parts = str(pathOrId).replace(/^https?:\/\/[^/]+\//i, "").split("/").filter(Boolean);
  return parts[0] || "movie";
}

function pickImage(block) {
  const candidates = [];
  const re = /(?:data-src|data-original|data-cover|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(block))) {
    const v = decodeHtml(m[1]);
    if (!v || /^data:image/i.test(v) || /loading\.png|placeholder|logo_placeholder|blank\.gif/i.test(v)) continue;
    const abs = absUrl(v);
    if (abs) candidates.push(abs);
  }
  return candidates[0] || "";
}
function extractCards(html, limit = 60) {
  const out = [];
  const seen = new Set();
  const addCard = (hrefRaw, body) => {
    const href = absUrl(decodeHtml(hrefRaw));
    if (!href) return;
    let pathname;
    try { pathname = new URL(href).pathname; } catch (_) { return; }
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !MAIN_PATH_RE.test(parts[0])) return;
    const vodId = `${parts[0]}/${parts[1]}`;
    if (seen.has(vodId)) return;
    const titleMatch = body.match(/<div[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const altMatch = body.match(/<img[^>]+alt=["']([^"']+)["']/i);
    const name = cleanText(titleMatch ? titleMatch[1] : (altMatch ? altMatch[1] : ""));
    if (!name || /^(全部|更多|首页|电影|电视剧|动漫|综艺|体育|短剧)$/.test(name)) return;
    const pic = pickImage(body);
    const bottomMatch = body.match(/<div[^>]*class="[^"]*bottom[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    const bottom = cleanText(bottomMatch ? bottomMatch[1] : "");
    const year = extractYear(bottom);
    const scoreMatch = body.match(/(\d\.\d)\s*分?/);
    seen.add(vodId);
    out.push({
      vod_id: vodId,
      vod_name: name,
      vod_pic: pic,
      type_id: `${parts[0]}/all`,
      type_name: CLASS_LIST.find((c) => c.key === parts[0])?.type_name || parts[0],
      vod_remarks: bottom.replace(/\s+/g, " ").slice(0, 30) || year,
      vod_year: year,
      vod_douban_score: scoreMatch ? scoreMatch[1] : "",
      vod_subtitle: bottom.replace(/\s+/g, " ").slice(0, 80),
    });
  };
  const cardRe = /<div\s+class="myui-vodbox-content"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi;
  let m;
  while ((m = cardRe.exec(html))) {
    if (/content-card|card-info|card-img/i.test(m[2])) addCard(m[1], m[2]);
    if (out.length >= limit) break;
  }
  if (out.length < limit) {
    const genericRe = /<a\s+href="([^"]+\/(?:movie|tv|dongman|zongyi|tiyu|duanju)\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = genericRe.exec(html))) {
      if (/content-card|card-info|card-img/i.test(m[2])) addCard(m[1], m[2]);
      if (out.length >= limit) break;
    }
  }
  return out;
}
function parsePageCount(html, page = 1, listLen = 0) {
  let max = page;
  for (const m of String(html).matchAll(/[?&]page=(\d+)/g)) max = Math.max(max, Number(m[1]) || page);
  if (listLen >= 20 && max <= page) max = page + 1;
  return Math.max(1, max);
}

function slugFromFilterHref(href) {
  try {
    const p = new URL(href, SITE).pathname.replace(/\/+$/, "");
    const last = p.split("/").pop() || "";
    if (last === "all") return "";
    if (last.startsWith("all-")) return last.slice(4);
    return last;
  } catch (_) { return ""; }
}
function parseFilterGroups(html) {
  const groups = [];
  const boxRe = /<div\s+class="filter-box"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = boxRe.exec(html))) {
    const box = m[1];
    const titleM = box.match(/<div\s+class="filter-title"[^>]*>([\s\S]*?)<\/div>/i);
    const title = cleanText(titleM ? titleM[1] : "");
    const key = FILTER_TITLE_KEY[title];
    if (!key) continue;
    const options = [];
    const aRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = aRe.exec(box))) {
      const href = absUrl(decodeHtml(a[1]));
      const name = cleanText(a[2]) || "全部";
      const value = name === "全部" ? "" : (slugFromFilterHref(href) || name);
      options.push({ name, value, _href: href });
    }
    if (options.length) groups.push({ key, name: title, init: "", value: options, _order: FILTER_ORDER.indexOf(key) });
  }
  return groups.sort((a, b) => a._order - b._order);
}
function publicFilterGroups(groups) {
  return groups.map((g) => ({
    key: g.key,
    name: g.name,
    init: "",
    value: g.value.map((v) => ({ name: v.name, value: v.value })),
  }));
}
function fallbackFilterGroups() {
  const common = [
    { key: "type", name: "类型", init: "", value: [
      { name: "全部", value: "" }, { name: "动作", value: "dongzuo" }, { name: "喜剧", value: "xiju" },
      { name: "爱情", value: "aiqing" }, { name: "科幻", value: "kehuan" }, { name: "恐怖片", value: "kongbupian" },
      { name: "剧情", value: "juqing" }, { name: "战争", value: "zhanzheng" },
    ] },
    { key: "area", name: "地区", init: "", value: [
      { name: "全部", value: "" }, { name: "大陆", value: "dalu" }, { name: "香港", value: "xianggang" },
      { name: "台湾", value: "taiwan" }, { name: "美国", value: "meiguo" }, { name: "日本", value: "riben" },
      { name: "韩国", value: "hanguo" },
    ] },
    { key: "lang", name: "语言", init: "", value: [
      { name: "全部", value: "" }, { name: "国语", value: "guoyu" }, { name: "英语", value: "yingyu" },
      { name: "粤语", value: "yueyu" }, { name: "日语", value: "riyu" }, { name: "韩语", value: "hanyu" },
    ] },
    { key: "year", name: "年份", init: "", value: [
      { name: "全部", value: "" }, { name: "2026", value: "2026" }, { name: "2025", value: "2025" },
      { name: "2024", value: "2024" }, { name: "2023", value: "2023" }, { name: "2022", value: "2022" },
      { name: "2021", value: "2021" }, { name: "2020", value: "2020" },
    ] },
  ];
  return common;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { __error: err }; }
    }
  });
  await Promise.all(workers);
  return results;
}
function staticFiltersMap() {
  const out = {};
  for (const c of CLASS_LIST) out[c.type_id] = fallbackFilterGroups();
  return out;
}
async function getFiltersMapCached() {
  const key = cacheKey("filters", "all");
  const cached = await cacheGet(key);
  if (cached && typeof cached === "object") return cached;
  const rows = await mapLimit(CLASS_LIST, 2, async (item) => {
    try {
      const html = await getHtmlCached(`${SITE}/${item.key}/all`, FILTER_TTL);
      const groups = parseFilterGroups(html);
      return [item.type_id, groups.length ? publicFilterGroups(groups) : fallbackFilterGroups()];
    } catch (err) {
      logE(`[filters] ${item.key} 获取失败: ${err.message || err}`);
      return [item.type_id, fallbackFilterGroups()];
    }
  });
  const out = {};
  for (const row of rows) {
    if (!row) continue;
    const [id, groups] = row;
    if (id && groups) out[id] = groups;
  }
  await cacheSet(key, out, FILTER_TTL);
  return out;
}

function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']*)["']`, "i");
  const m = html.match(re);
  return m ? decodeHtml(m[1]) : "";
}
function firstMatch(html, re, group = 1) {
  const m = html.match(re);
  return m ? decodeHtml(m[group]) : "";
}
function extractPlayerData(html) {
  const marker = /var\s+player_aaaa\s*=\s*/i;
  const m = marker.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}
function parseRoutes(html) {
  const bySid = new Map();
  const liRe = /<li\b[^>]*data-sid="(\d+)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const sid = Number(m[1]);
    if (!sid) continue;
    const body = m[2].replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "");
    const fromM = body.match(/data-from="([^"]+)"/i);
    const spanM = body.match(/<span[^>]*>([^<]+)<\/span>/i);
    let name = cleanText(spanM ? spanM[1] : stripTags(body));
    if (!name || name.length > 20 || /^[-<>\s]+$/.test(name)) continue;
    const from = str(fromM ? fromM[1] : (bySid.get(sid)?.from || ""));
    const official = OFFICIAL_FROM_NAMES[from.toLowerCase()];
    if (official && (!/[\u4e00-\u9fa5]/.test(name) || name.toLowerCase() === from.toLowerCase())) {
      name = official;
    }
    const existing = bySid.get(sid);
    const better = !existing || (!/[\u4e00-\u9fa5]/.test(existing.name) && /[\u4e00-\u9fa5]/.test(name));
    if (better) {
      bySid.set(sid, {
        sid,
        name,
        from,
        order: existing?.order ?? bySid.size,
      });
    }
  }
  return [...bySid.values()].sort((a, b) => a.order - b.order || a.sid - b.sid);
}

function parsePanes(html, detailPath) {
  const slug = detailPath.split("/").filter(Boolean).pop() || "";
  const starts = [];
  const paneRe1 = /<div\b[^>]*class="[^"]*tab-pane[^"]*"[^>]*data-sid="(\d+)"[^>]*>/gi;
  const paneRe2 = /<div\b[^>]*data-sid="(\d+)"[^>]*class="[^"]*tab-pane[^"]*"[^>]*>/gi;
  for (const re of [paneRe1, paneRe2]) {
    let m;
    while ((m = re.exec(html))) starts.push({ index: m.index, end: m.index + m[0].length, sid: Number(m[1]) });
  }
  starts.sort((a, b) => a.index - b.index);
  const bySid = new Map();
  for (let i = 0; i < starts.length; i++) {
    const pane = starts[i];
    if (!pane.sid) continue;
    const nextIndex = i + 1 < starts.length ? starts[i + 1].index : Math.min(html.length, pane.end + 400000);
    const body = html.slice(pane.end, nextIndex);
    const list = bySid.get(pane.sid) || [];
    const seen = new Set(list.map((x) => `${x.href}|${x.name}`));
    const aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = aRe.exec(body))) {
      const rawHref = decodeHtml(a[1]);
      const href = absUrl(rawHref);
      const name = cleanText(a[2]);
      if (!href || !name || name.length > 30) continue;
      if (!slug || !href.includes(slug)) continue;
      if (/gbook|javascript:|#playlist|rss|about\.html/i.test(href)) continue;
      const key = `${href}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ href, name });
    }
    bySid.set(pane.sid, list);
  }
  return bySid;
}
function episodeKey(href) {
  try {
    const u = new URL(href, SITE);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts.pop() || "";
    const num = last.match(/(\d+)/);
    return num ? `n:${num[1]}` : `s:${last}`;
  } catch (_) { return `s:${String(href || "")}`; }
}
function buildEpisodePlayUrl(href, sid) {
  const u = new URL(absUrl(href || "", SITE) || SITE);
  if (sid) u.searchParams.set("sid", String(sid));
  return u.toString();
}
function makeToken(mode, detailPath, episodeHref, episodeName, sid, lineName) {
  return [
    "fdzys", "v1", mode,
    encodeURIComponent(detailPath),
    encodeURIComponent(episodeHref),
    encodeURIComponent(episodeName || "立即播放"),
    String(sid || 1),
    encodeURIComponent(lineName || "自动优选"),
  ].join(":");
}
function parseToken(value) {
  const s = str(value);
  if (!s.startsWith("fdzys:v1:")) return null;
  const p = s.split(":");
  if (p.length < 8) return null;
  const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
  return {
    mode: p[2] || "auto",
    detailPath: dec(p[3] || ""),
    episodeHref: dec(p[4] || ""),
    episodeName: dec(p[5] || ""),
    sid: Number(p[6] || 1) || 1,
    lineName: dec(p.slice(7).join(":") || ""),
  };
}
function buildLegacyPlayFields(sources) {
  const from = [];
  const url = [];
  const list = [];
  for (const s of sources || []) {
    if (!s || !Array.isArray(s.episodes) || !s.episodes.length) continue;
    from.push(str(s.name));
    url.push(s.episodes.map((e) => `${str(e.name)}$${str(e.playId)}`).join("#"));
    list.push(s.episodes.map((e) => ({ name: str(e.name), url: str(e.playId) })));
  }
  return {
    vod_play_from: from.join("$$$"),
    vod_play_url: url.join("$$$"),
    vod_play_list: list,
  };
}

function isM3u8(url) { return /\.m3u8(?:\?|#|$)/i.test(str(url)); }
function isDirectMedia(url) { return /\.(m3u8|mp4|m4s|ts|flv|mkv|avi|mov|webm|wmv)(?:\?|#|$)/i.test(str(url)); }
function isTrustedFrom(from) { return TRUSTED_FROMS.has(str(from).toLowerCase()); }

async function sniffOrExtract(url, headers) {
  try {
    if (OmniBox && typeof OmniBox.sniffVideo === "function") {
      const r = await OmniBox.sniffVideo(url, headers);
      const sniffed = typeof r === "string" ? r : (r && (r.url || r.playUrl || (Array.isArray(r.urls) && r.urls[0] && r.urls[0].url)));
      if (sniffed && str(sniffed) !== str(url)) {
        const abs = absUrl(sniffed, url);
        if (abs && isDirectMedia(abs)) return abs;
      }
    }
  } catch (err) {
    logI(`[sniff] SDK 嗅探跳过 url=${str(url).slice(0, 100)} err=${err.message || err}`);
  }
  try {
    const res = await httpGet(url, { timeout: PROBE_TIMEOUT, maxBytes: 512 * 1024, headers: { ...headers, "Accept-Encoding": "identity" } });
    if (res.statusCode !== 200 || !res.body) return "";
    const body = res.body.replace(/\\\//g, "/");
    const player = extractPlayerData(body);
    if (player && player.url) {
      const u = decryptPlayerUrl(player);
      if (u && isDirectMedia(u)) return absUrl(u, url);
    }
    const m = body.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i) || body.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if (m) {
      const u = decodeHtml(m[0]).replace(/[),;'"]+$/, "");
      if (u && isDirectMedia(u)) return absUrl(u, url);
    }
  } catch (err) {
    logI(`[sniff] 页面提取跳过 url=${str(url).slice(0, 100)} err=${err.message || err}`);
  }
  return "";
}

function playlistLines(body) {
  return String(body || "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean);
}
async function probeM3u8(url, headers, depth = 0) {
  const t0 = Date.now();
  const res = await httpGet(url, {
    timeout: PROBE_TIMEOUT,
    maxBytes: 128 * 1024,
    headers: { ...headers, Range: "bytes=0-65535", "Accept-Encoding": "identity" },
  });
  const ms = Date.now() - t0;
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.body) {
    return { ok: false, status: res.statusCode, ms, kind: "m3u8-manifest", url, error: res.error || "manifest unavailable" };
  }
  const lines = playlistLines(res.body);
  if (!lines.some((line) => /^#EXTM3U\b/i.test(line))) {
    return { ok: false, status: res.statusCode, ms, kind: "m3u8-manifest", url, error: "not m3u8" };
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^#EXT-X-STREAM-INF\b/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("#")) continue;
        const variant = absUrl(lines[j], url);
        if (variant && depth < 1 && variant !== url) {
          const nested = await probeM3u8(variant, headers, depth + 1);
          return { ...nested, url: nested.url || variant, parent: url, ms: Date.now() - t0 };
        }
        break;
      }
    }
  }
  let segment = "";
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    segment = absUrl(line, url);
    if (segment) break;
  }
  if (!segment) {
    return { ok: true, status: res.statusCode, ms, kind: "m3u8-manifest", url, segment: false, partial: true };
  }
  const segRes = await httpGet(segment, {
    timeout: PROBE_TIMEOUT,
    maxBytes: 4096,
    headers: { ...headers, Range: "bytes=0-1023", "Accept-Encoding": "identity" },
  });
  const segMs = Date.now() - t0;
  const ok = segRes.statusCode >= 200 && segRes.statusCode < 300 && segRes.bytes > 0;
  return {
    ok,
    status: segRes.statusCode,
    ms: segMs,
    kind: "m3u8",
    url,
    segment: segment,
    segmentOk: ok,
    partial: false,
    error: ok ? "" : (segRes.error || `segment HTTP ${segRes.statusCode}`),
  };
}
async function probeMedia(url, from, headers, opts = {}) {
  const direct = opts.direct !== false;
  const depth = Number(opts.depth || 0);
  const t0 = Date.now();
  if (isTrustedFrom(from) && !direct) {
    return { ok: true, score: 900, kind: "trusted-page", url, ms: 0, parse: 1, direct: false };
  }
  if (direct && isM3u8(url)) {
    const r = await probeM3u8(url, headers, 0);
    const score = r.ok ? (10000 - Math.min(r.ms, 8000) + (r.segmentOk ? 1200 : 0)) : 200;
    return { ...r, score, parse: 0, direct: true };
  }
  if (direct && isDirectMedia(url)) {
    const res = await httpGet(url, {
      timeout: PROBE_TIMEOUT,
      maxBytes: 4096,
      headers: { ...headers, Range: "bytes=0-1023", "Accept-Encoding": "identity" },
    });
    const ok = res.statusCode >= 200 && res.statusCode < 300 && res.bytes > 0;
    return {
      ok,
      score: ok ? 9000 - Math.min(Date.now() - t0, 8000) : 180,
      status: res.statusCode,
      ms: Date.now() - t0,
      kind: "direct-media",
      url,
      parse: 0,
      direct: true,
      error: ok ? "" : (res.error || `HTTP ${res.statusCode}`),
    };
  }
  if (depth < 2) {
    const sniffed = await sniffOrExtract(url, headers);
    if (sniffed && sniffed !== url) {
      const nested = await probeMedia(sniffed, from, headers, { direct: true, depth: depth + 1 });
      return { ...nested, url: sniffed, fromPage: url, score: Math.max(nested.score || 0, 1200) };
    }
  }
  if (isTrustedFrom(from)) {
    return { ok: true, score: 900, kind: "trusted-page", url, ms: Date.now() - t0, parse: 1, direct: false };
  }
  return { ok: false, score: 50, kind: "page", url, ms: Date.now() - t0, parse: 1, direct: false };
}

async function probeMediaCached(url, from, headers, opts = {}) {
  const direct = opts.direct !== false;
  const rawKey = `${url}|${from || ""}|${direct ? 1 : 0}|${opts.depth || 0}`;
  const key = cacheKey("probe", rawKey);
  if (PROBE_CACHE_TTL > 0) {
    const cached = await cacheGet(key);
    if (cached && typeof cached === "object" && typeof cached.score === "number") return cached;
  }
  const result = await probeMedia(url, from, headers, opts);
  if (PROBE_CACHE_TTL > 0) {
    const ttl = result.ok ? PROBE_CACHE_TTL : Math.min(60, PROBE_CACHE_TTL);
    await cacheSet(key, result, ttl);
  }
  return result;
}

async function resolvePlayPageInfo(playUrl, ttl = PLAY_TTL) {
  const key = cacheKey("play", playUrl);
  const cached = await cacheGet(key);
  if (cached && typeof cached === "object") return cached;
  const out = { url: "", pageUrl: playUrl, from: "", sid: 0, nid: 0, direct: false, title: "" };
  try {
    const html = await getHtml(playUrl, { timeout: TIMEOUT }, ttl);
    const data = extractPlayerData(html);
    if (data) {
      const media = decryptPlayerUrl(data);
      out.url = media || playUrl;
      out.direct = !!media;
      out.from = str(data.from || "");
      out.sid = Number(data.sid || 0) || 0;
      out.nid = Number(data.nid || 0) || 0;
      out.title = str((data.vod_data || {}).vod_name || "");
    } else {
      out.url = playUrl;
      out.direct = false;
    }
  } catch (err) {
    logE(`[play-page] 解析失败 url=${str(playUrl).slice(0, 120)} err=${err.message || err}`);
    out.url = playUrl;
  }
  await cacheSet(key, out, ttl);
  return out;
}

function findEpisodeInPane(episodes, token) {
  const list = Array.isArray(episodes) ? episodes : [];
  if (!list.length) return { href: token.episodeHref, name: token.episodeName || "立即播放" };
  const want = episodeKey(token.episodeHref);
  return list.find((e) => episodeKey(e.href) === want)
    || list.find((e) => str(e.name) === str(token.episodeName))
    || list[0];
}
async function collectAutoCandidates(token) {
  const detailUrl = `${SITE}/${token.detailPath.replace(/^\/+/, "")}`;
  const html = await getHtmlCached(detailUrl, DETAIL_TTL);
  let routes = parseRoutes(html);
  const panes = parsePanes(html, token.detailPath);
  if (!routes.length) {
    const sids = [...panes.keys()].sort((a, b) => a - b);
    routes = sids.length ? sids.map((sid, i) => ({ sid, name: `线路${sid}`, from: "", order: i }))
      : [{ sid: 1, name: "默认线路", from: "", order: 0 }];
  }
  routes = routes.slice(0, MAX_ROUTES);
  const candidates = [];
  for (const route of routes) {
    const episodes = panes.get(route.sid) || [];
    const ep = findEpisodeInPane(episodes, token);
    const playUrl = buildEpisodePlayUrl(ep.href || token.episodeHref, route.sid);
    candidates.push({
      sid: route.sid,
      name: str(route.name) || `线路${route.sid}`,
      from: str(route.from || ""),
      playUrl,
      routeOrder: route.order ?? routes.indexOf(route),
    });
  }
  if (!candidates.length) {
    candidates.push({
      sid: token.sid || 1,
      name: token.lineName || "默认线路",
      from: "",
      playUrl: buildEpisodePlayUrl(token.episodeHref || detailUrl, token.sid || 1),
      routeOrder: 0,
    });
  }
  return candidates;
}

async function resolveCategoryUrl(categoryId, filters, page) {
  let path = normalizeCategoryPath(categoryId);
  let currentUrl = `${SITE}/${path}`;
  const selected = objectOf(filters);
  for (const key of FILTER_ORDER) {
    const raw = str(selected[key] ?? selected[`${key}Id`] ?? "");
    if (!raw || raw === "全部") continue;
    const html = await getHtmlCached(currentUrl, CACHE_TTL);
    const groups = parseFilterGroups(html);
    const group = groups.find((g) => g.key === key);
    if (!group) { logI(`[category] 筛选组缺失 key=${key} url=${currentUrl}`); continue; }
    const decodedRaw = decodeURIComponent(raw);
    const target = group.value.find((v) => str(v.value) === raw || str(v.name) === raw || str(v.name) === decodedRaw)
      || group.value.find((v) => v._href && decodeURIComponent(v._href).includes(decodedRaw))
      || group.value.find((v) => v.value && raw.includes(str(v.value)));
    if (!target || !target._href) { logI(`[category] 筛选值未命中 key=${key} value=${raw}`); continue; }
    currentUrl = target._href;
  }
  const u = new URL(currentUrl, SITE);
  if (page > 1) u.searchParams.set("page", String(page));
  else u.searchParams.delete("page");
  return u.toString();
}

async function home(params, context) {
  try {
    logI(`[home] from=${context?.from || "web"} 入口 httpMode=${HTTP_MODE}`);
    const html = await getHtmlCached(`${SITE}/`, CACHE_TTL);
    const list = extractCards(html, 24);
    // 首屏直接用静态筛选项，避免并发抓 6 个分类页拖垮宿主首屏；
    // 真实筛选 href 在 category() 里按当前页 live chaining 获取。
    const filters = staticFiltersMap();
    getFiltersMapCached().catch(() => {});
    logI(`[home] class=${CLASS_LIST.length} list=${list.length} filters=${Object.keys(filters).length} src=${httpGet.lastSource || "?"}`);
    return { class: CLASS_LIST.map((c) => ({ type_id: c.type_id, type_name: c.type_name })), list, filters };
  } catch (err) {
    logE(`[home] 失败: ${err.message || err}`);
    return { class: CLASS_LIST.map((c) => ({ type_id: c.type_id, type_name: c.type_name })), list: [], filters: {} };
  }
}

async function category(params, context) {
  const body = objectOf(params);
  const page = Math.max(1, toInt(body.page ?? body.pg, 1));
  const categoryId = str(body.categoryId ?? body.type_id ?? body.id ?? body.tid ?? "movie/all");
  const filters = objectOf(body.filters ?? body.extend ?? body.ext ?? body.filter ?? {});
  try {
    logI(`[category] categoryId=${categoryId} page=${page} filters=${JSON.stringify(filters).slice(0, 180)}`);
    const finalUrl = await resolveCategoryUrl(categoryId, filters, page);
    const html = await getHtmlCached(finalUrl, CACHE_TTL);
    const list = extractCards(html, 60);
    const pagecount = parsePageCount(html, page, list.length);
    const total = list.length ? (page - 1) * 20 + list.length + (pagecount > page ? 1 : 0) : 0;
    logI(`[category] finalUrl=${finalUrl} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total, limit: 20, list };
  } catch (err) {
    logE(`[category] 失败 categoryId=${categoryId}: ${err.message || err}`);
    return { page, pagecount: 0, total: 0, limit: 20, list: [] };
  }
}

async function search(params, context) {
  const body = objectOf(params);
  const keyword = str(body.keyword ?? body.wd ?? body.key ?? "").trim();
  const page = Math.max(1, toInt(body.page ?? body.pg, 1));
  if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    let url = `${SITE}/yu-${encodeURIComponent(keyword)}-xianguan-de-yingpian-shippin-zhibo`;
    if (page > 1) url += `?page=${page}`;
    logI(`[search] keyword=${keyword} page=${page} url=${url}`);
    const html = await getHtmlCached(url, CACHE_TTL);
    const list = extractCards(html, 60);
    const pagecount = parsePageCount(html, page, list.length);
    const total = list.length ? (page - 1) * 20 + list.length + (pagecount > page ? 1 : 0) : 0;
    logI(`[search] keyword=${keyword} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total, limit: 20, list };
  } catch (err) {
    logE(`[search] 失败 keyword=${keyword}: ${err.message || err}`);
    return { page, pagecount: 0, total: 0, limit: 20, list: [] };
  }
}

async function detail(params, context) {
  const body = objectOf(params);
  const rawId = str(body.videoId ?? body.id ?? body.ids ?? (Array.isArray(body.ids) ? body.ids[0] : ""));
  const detailPath = normalizeVodPath(rawId);
  if (!detailPath) { logE(`[detail] videoId 为空或非法 raw=${rawId.slice(0, 120)}`); return { list: [] }; }
  try {
    const url = `${SITE}/${detailPath}`;
    logI(`[detail] videoId=${rawId} url=${url}`);
    const html = await getHtmlCached(url, DETAIL_TTL);
    const player = extractPlayerData(html) || {};
    const vodData = objectOf(player.vod_data);
    const routes = parseRoutes(html);
    const panes = parsePanes(html, detailPath);
    let routeList = routes.length ? routes : [...panes.keys()].sort((a, b) => a - b).map((sid, i) => ({ sid, name: `线路${sid}`, from: "", order: i }));
    if (!routeList.length) routeList = [{ sid: 1, name: "默认线路", from: "", order: 0 }];

    let masterSid = routeList[0].sid;
    let masterEpisodes = panes.get(masterSid) || [];
    for (const route of routeList) {
      const eps = panes.get(route.sid) || [];
      if (eps.length > masterEpisodes.length) { masterSid = route.sid; masterEpisodes = eps; }
    }
    if (!masterEpisodes.length) masterEpisodes = [{ href: `${SITE}/${detailPath}`, name: "立即播放" }];

    const sources = [];
    const autoEpisodes = masterEpisodes.map((ep) => ({
      name: str(ep.name) || "立即播放",
      playId: makeToken("auto", detailPath, ep.href, str(ep.name) || "立即播放", masterSid, "自动优选"),
    }));
    sources.push({ name: "自动优选", episodes: autoEpisodes });
    for (const route of routeList) {
      const eps = (panes.get(route.sid) || []).length ? panes.get(route.sid) : masterEpisodes;
      const lineName = str(route.name) || `线路${route.sid}`;
      const episodes = eps.map((ep) => ({
        name: str(ep.name) || "立即播放",
        playId: makeToken("line", detailPath, ep.href, str(ep.name) || "立即播放", route.sid, lineName),
      }));
      if (episodes.length) sources.push({ name: lineName, episodes });
    }

    const ogTitle = metaContent(html, "og:title");
    const titleText = firstMatch(html, /<title>([\s\S]*?)<\/title>/i);
    const name = cleanVodName(vodData.vod_name || ogTitle || titleText.split("_")[0]) || detailPath;
    const pic = absUrl(metaContent(html, "og:image") || firstMatch(html, /<img[^>]+(?:data-src|src)=["']([^"']*upload\/vod\/[^"']+)["']/i));
    const content = decodeHtml(metaContent(html, "description") || firstMatch(html, /<div[^>]*class="[^"]*vod-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i));
    const cls = str(vodData.vod_class || "");
    const year = extractYear(cls) || extractYear(metaContent(html, "keywords"));
    const vod = {
      vod_id: detailPath,
      vod_name: name,
      vod_pic: pic,
      type_id: `${detailPath.split("/")[0]}/all`,
      type_name: CLASS_LIST.find((c) => c.key === detailPath.split("/")[0])?.type_name || "",
      vod_year: year,
      vod_area: cls.split(/[,，]/).find((x) => /大陆|香港|台湾|美国|日本|韩国|英国|法国|德国|泰国|印度/.test(x)) || "",
      vod_lang: cls.split(/[,，]/).find((x) => /国语|英语|粤语|闽南语|韩语|日语|法语|德语/.test(x)) || "",
      vod_actor: str(vodData.vod_actor || ""),
      vod_director: str(vodData.vod_director || ""),
      vod_content: content,
      vod_remarks: str(player.note || (year ? `${year} HD` : "HD")),
      vod_play_sources: sources,
      ...buildLegacyPlayFields(sources),
    };
    const episodeCount = sources.reduce((n, s) => n + (s.episodes?.length || 0), 0);
    logI(`[detail] path=${detailPath} name=${name} routes=${routeList.length} sources=${sources.length} episodes=${episodeCount}`);
    return { list: [vod] };
  } catch (err) {
    logE(`[detail] 失败 videoId=${rawId}: ${err.message || err}`);
    return { list: [] };
  }
}

function extractSniffedUrl(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  return str(result.url || result.playUrl || (Array.isArray(result.urls) && result.urls[0] && result.urls[0].url));
}
function playHeaders() {
  return {
    "User-Agent": UA,
    "Referer": SITE + "/",
    "Accept": "*/*",
    ...(COOKIE ? { Cookie: COOKIE } : {}),
  };
}

async function playSinglePlayPage(playUrl, flag) {
  const header = playHeaders();
  const info = await resolvePlayPageInfo(playUrl);
  let finalUrl = str(info.url || playUrl);
  let parse = isDirectMedia(finalUrl) ? 0 : 1;
  if (!isDirectMedia(finalUrl)) {
    const sniffed = await sniffOrExtract(finalUrl, header);
    if (sniffed && isDirectMedia(sniffed)) {
      finalUrl = sniffed;
      parse = 0;
    }
  }
  return {
    urls: [{ name: flag || "播放", url: finalUrl }],
    url: finalUrl,
    flag: flag || "播放",
    header,
    parse,
    playUrl: "",
  };
}

async function play(params, context) {
  const body = objectOf(params);
  const rawId = str(body.playId ?? body.id ?? body.url ?? "");
  const flag = str(body.flag ?? "自动优选") || "自动优选";
  try {
    logI(`[play] 入口 playId=${rawId.slice(0, 180)} flag=${flag} from=${context?.from || "web"}`);
    if (!rawId) throw new Error("playId 缺失");
    if (/^https?:\/\//i.test(rawId) && !rawId.includes(new URL(SITE).hostname)) {
      return { urls: [{ name: flag, url: rawId }], url: rawId, flag, header: playHeaders(), parse: isDirectMedia(rawId) ? 0 : 1, playUrl: "" };
    }
    const token = parseToken(rawId);
    if (!token) {
      const pageUrl = /^https?:\/\//i.test(rawId) ? rawId : absUrl(rawId, SITE + "/");
      return await playSinglePlayPage(pageUrl, flag);
    }
    if (token.mode !== "auto") {
      const pageUrl = buildEpisodePlayUrl(token.episodeHref, token.sid);
      return await playSinglePlayPage(pageUrl, token.lineName || flag);
    }

    const candidates = await collectAutoCandidates(token);
    logI(`[play][auto] 候选线路=${candidates.length} autoProbe=${AUTO_PROBE ? 1 : 0} limit=${PROBE_LIMIT} firstUrl=${String(candidates[0]?.playUrl || "").slice(0, 130)}`);
    const header = playHeaders();
    if (!AUTO_PROBE) {
      const first = candidates[0];
      return await playSinglePlayPage(first.playUrl, first.name || "自动优选");
    }

    const probed = await mapLimit(candidates, PROBE_LIMIT, async (candidate) => {
      try {
        const info = await resolvePlayPageInfo(candidate.playUrl);
        const mediaUrl = str(info.url || candidate.playUrl);
        const direct = !!info.direct && isDirectMedia(mediaUrl);
        const from = str(info.from || candidate.from || "");
        const fallbackProbe = { ok: false, score: 20, kind: "timeout", url: mediaUrl, ms: PROBE_TIMEOUT * 3, error: "线路探测总超时" };
        const probe = await withTimeout(
          probeMediaCached(mediaUrl, from, header, { direct, depth: 0 }),
          PROBE_TIMEOUT * 3 + 1200,
          fallbackProbe,
        );
        const finalUrl = str(probe.url || mediaUrl);
        const parse = isDirectMedia(finalUrl) ? 0 : (probe.parse ?? 1);
        return {
          ...candidate,
          url: finalUrl,
          score: Number(probe.score || 0),
          ok: !!probe.ok,
          kind: str(probe.kind || ""),
          ms: Number(probe.ms || 0),
          parse,
          from,
          error: str(probe.error || ""),
        };
      } catch (err) {
        logE(`[play][auto] 线路失败 sid=${candidate.sid} name=${candidate.name}: ${err.message || err}`);
        return { ...candidate, url: candidate.playUrl, score: 40, ok: false, kind: "error", ms: 0, parse: 1, from: candidate.from, error: err.message || String(err) };
      }
    });

    const results = probed.filter(Boolean).sort((a, b) => {
      const ap = Number(a.parse ?? 1) === 0 ? 1 : 0;
      const bp = Number(b.parse ?? 1) === 0 ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.score - a.score) || (a.routeOrder - b.routeOrder) || (a.sid - b.sid);
    });
    const good = results.filter((r) => r.url).slice(0, MAX_ROUTES);
    if (!good.length) throw new Error("所有线路均未返回地址");
    const best = good[0];
    const urls = good.map((r) => ({ name: str(r.name) || `线路${r.sid}`, url: str(r.url) }));
    const finalParse = best.parse ?? (isDirectMedia(best.url) ? 0 : 1);
    logI(`[play][auto] 选中线路 sid=${best.sid} name=${best.name} score=${best.score} kind=${best.kind} ms=${best.ms} parse=${finalParse} url=${str(best.url).slice(0, 140)}`);
    return {
      urls,
      url: str(best.url),
      flag: best.name || flag,
      header,
      parse: finalParse,
      playUrl: "",
    };
  } catch (err) {
    logE(`[play] 失败 playId=${rawId.slice(0, 160)}: ${err.message || err}`);
    return { urls: [], url: "", flag, header: playHeaders(), parse: 0, playUrl: "" };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
