// @name 🔞麻豆社
// @version 1.0.1
// @author omnibox-spider
// @description 麻豆社（madou.club）OmniBox 源：WordPress/Mirages 主题首页·分类·搜索·详情；详情解析 dash.madou.club/share/<id> iframe，实时取 share 页 JWT 后拼 /videos/<id>/index.m3u8，parse=0 直链播放；内置 stdout 消毒。
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/麻豆社.js
// @dependencies []

// 【环境变量】
//  MADOU_HOST        站点基址，默认 https://madou.club
//  MADOU_DASH_HOST   播放域名，默认 https://dash.madou.club
//  MADOU_UA          自定义 UA（可选，默认内置桌面 Chrome UA）
//  MADOU_TIMEOUT     页面请求超时毫秒，默认 15000
//  MADOU_CACHE_TTL   列表/详情缓存秒数，默认 300
//  MADOU_TOKEN_TTL   播放 token 进程内缓存秒数，默认 70（share 页 JWT 约 100 秒有效）

// OmniBox 宿主用 stdout 传 JSON 响应；部分版本 omnibox_sdk.log 会把日志写成
// JSON 字符串写进同一 stdout，Go 侧会报 cannot unmarshal string into struct。
// 这里在模块加载最早期做 stdout 消毒：日志字符串转 stderr，对象/数组响应放行。
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
function _safeStderr(chunk, encoding, cb) {
  try { return _origStderrWrite(chunk, encoding, cb); } catch (_) { return true; }
}
function _installStdoutGuard() {
  if (process.stdout.__madouGuard || process.stdout.__omniStdoutGuard) return;
  process.stdout.__madouGuard = true;
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
      if (parsed === null || ["string", "number", "boolean"].includes(typeof parsed)) {
        return _safeStderr(chunk, encoding, cb);
      }
      return _origStdoutWrite(chunk, encoding, cb);
    }
    if (jsonStart(trimmed)) {
      state.inJson = true;
      state.pending = text;
      return _origStdoutWrite(chunk, encoding, cb);
    }
    return _safeStderr(chunk, encoding, cb);
  };
}
_installStdoutGuard();

const OmniBox = (() => {
  try { return require("omnibox_sdk"); } catch (_) { return {}; }
})();
let runner;
try { runner = require("spider_runner"); } catch (_) { runner = { run() {} }; }

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");

const PREFIX = "[madou]";
const SITE = normalizeHost(process.env.MADOU_HOST || "https://madou.club");
const DASH = normalizeHost(process.env.MADOU_DASH_HOST || "https://dash.madou.club");
const HOSTNAME = new URL(SITE).hostname;
const UA = String(process.env.MADOU_UA || process.env.SITE_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36").trim();
const TIMEOUT = Math.max(3000, Number(process.env.MADOU_TIMEOUT || 15000) || 15000);
const CACHE_TTL = Math.max(30, Number(process.env.MADOU_CACHE_TTL || 300) || 300);
const TOKEN_TTL = Math.max(20, Math.min(90, Number(process.env.MADOU_TOKEN_TTL || 70) || 70));

function logI(message) { try { process.stderr.write(`[info] ${PREFIX} ${message}\n`); } catch (_) {} }
function logE(message) { try { process.stderr.write(`[error] ${PREFIX} ${message}\n`); } catch (_) {} }

function normalizeHost(value) {
  let s = String(value || "").trim().replace(/\/+$/, "");
  if (!s) return "https://madou.club";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}
function absUrl(href, base = SITE) {
  try { return new URL(String(href || "").trim(), base).href; } catch (_) { return ""; }
}
function str(v) { return String(v == null ? "" : v).trim(); }
function toInt(v, d = 0) {
  const n = Number.parseInt(String(v == null ? "" : v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : d;
}
function objectOf(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") { try { const o = JSON.parse(v); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; } }
  return {};
}
function sha1(v) { return crypto.createHash("sha1").update(String(v || "")).digest("hex"); }

function decodeHtml(v) {
  return String(v || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();
}
function stripTags(v) {
  return decodeHtml(String(v || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
}
function cleanText(v) { return stripTags(v).replace(/\s+/g, " ").trim(); }

const memCache = new Map();
async function cacheGet(key) {
  const hit = memCache.get(key);
  if (hit) {
    if (Date.now() > hit.expire) memCache.delete(key);
    else return hit.value;
  }
  try {
    if (OmniBox && typeof OmniBox.getCache === "function") {
      const v = await OmniBox.getCache(key);
      if (v != null) {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        memCache.set(key, { value: parsed, expire: Date.now() + CACHE_TTL * 1000 });
        return parsed;
      }
    }
  } catch (_) {}
  return null;
}
async function cacheSet(key, value, ttl = CACHE_TTL) {
  memCache.set(key, { value, expire: Date.now() + Math.max(1, ttl) * 1000 });
  while (memCache.size > 200) memCache.delete(memCache.keys().next().value);
  try {
    if (OmniBox && typeof OmniBox.setCache === "function") {
      const p = OmniBox.setCache(key, JSON.stringify(value), ttl);
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (_) {}
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
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 60000 });
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 60000 });

function buildHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": SITE + "/",
    ...extra,
  };
}
async function sdkRequest(url, options = {}) {
  if (!OmniBox || typeof OmniBox.request !== "function") return null;
  try {
    const res = await OmniBox.request(url, {
      method: options.method || "GET",
      headers: buildHeaders({ ...(options.headers || {}), "Accept-Encoding": "identity" }),
    });
    if (!res) return null;
    let body = typeof res.body === "string" ? res.body : (Buffer.isBuffer(res.body) ? res.body.toString("utf8") : "");
    if (body && body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) {
      try { body = zlib.gunzipSync(Buffer.from(body, "binary")).toString("utf8"); } catch (_) {}
    }
    return {
      statusCode: Number(res.statusCode ?? res.status ?? 0),
      headers: res.headers || {},
      body,
      bytes: Buffer.byteLength(body),
      source: "sdk",
    };
  } catch (_) { return null; }
}
function nativeHttpGet(url, options = {}, redirectLeft = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ statusCode: 0, headers: {}, body: "", bytes: 0, error: "URL 非法", source: "native" }); }
    const mod = u.protocol === "https:" ? https : http;
    const timeout = Math.max(1000, Number(options.timeout || TIMEOUT));
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: buildHeaders(options.headers || {}),
      timeout,
      rejectUnauthorized: false,
      agent: u.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
    }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && loc && redirectLeft > 0) {
        res.resume();
        const next = absUrl(loc, u.href);
        if (next) return nativeHttpGet(next, options, redirectLeft - 1).then(resolve);
      }
      const chunks = [];
      let bytes = 0;
      const maxBytes = Math.max(1024, Number(options.maxBytes || 3 * 1024 * 1024));
      res.on("data", (c) => {
        bytes += c.length;
        if (bytes <= maxBytes) chunks.push(c);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({
          statusCode: status,
          headers: res.headers || {},
          body: decompress(raw, res.headers["content-encoding"]).toString("utf8"),
          bytes,
          source: "native",
        });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ statusCode: 0, headers: {}, body: "", bytes: 0, error: `超时 ${timeout}ms`, source: "native" }); });
    req.on("error", (e) => resolve({ statusCode: 0, headers: {}, body: "", bytes: 0, error: e.message || String(e), source: "native" }));
    req.end();
  });
}
function isBlockedHtml(body) {
  const head = String(body || "").slice(0, 20000);
  return /Just a moment|cf-challenge|Attention Required|Access denied|403 Forbidden|访问验证/i.test(head);
}
async function httpGet(url, options = {}) {
  const sdk = await sdkRequest(url, options);
  if (sdk && sdk.statusCode === 200 && sdk.body && !isBlockedHtml(sdk.body)) return sdk;
  const native = await nativeHttpGet(url, options);
  return native;
}
async function getHtml(url, ttl = CACHE_TTL) {
  const key = `madou:html:${sha1(url)}`;
  const cached = await cacheGet(key);
  if (cached && typeof cached.body === "string" && cached.body) return cached.body;
  const res = await httpGet(url, { timeout: TIMEOUT });
  if (res.statusCode !== 200 || !res.body || isBlockedHtml(res.body)) {
    throw new Error(`HTTP ${res.statusCode} ${res.error || ""} src=${res.source || "?"} len=${res.body.length}`);
  }
  await cacheSet(key, { body: res.body }, ttl);
  return res.body;
}

/* ---------------- 列表解析 ---------------- */

function pickImage(card) {
  const cands = [];
  const re = /(?:data-src|data-original|data-lazy-src|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(card))) {
    const v = decodeHtml(m[1]);
    if (!v || /^data:image/i.test(v) || /showcase\/img\/thumb\.png|showcase\/img\/logo|loading\.gif|placeholder/i.test(v)) continue;
    const abs = absUrl(v);
    if (abs) cands.push(abs);
  }
  return cands[0] || "";
}
function parseCards(html, limit = 100) {
  const out = [];
  const seen = new Set();
  const re = /<article[^>]*\bclass=["'][^"']*excerpt[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const card = m[1];
    let href = "";
    const linkM = card.match(/<a[^>]+class=["'][^"']*thumbnail[^"']*["'][^>]+href=["']([^"']+)["']/i)
      || card.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["']/i)
      || card.match(/<a[^>]+href=["'](https?:\/\/[^"']+\.html)["']/i);
    if (linkM) href = decodeHtml(linkM[1]);
    if (!href) continue;
    href = absUrl(href);
    if (!href) continue;
    let title = "";
    const h2 = card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2) title = cleanText(h2[1]);
    if (!title) {
      const at = card.match(/<img[^>]+alt=["']([^"']+)["']/i);
      if (at) title = decodeHtml(at[1]);
    }
    if (!title) continue;
    const id = videoIdFromUrl(href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const footer = card.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
    const footerText = footer ? cleanText(footer[1]) : "";
    const catM = footerText.match(/([^\s()]{2,20})\s*$/);
    const likeM = card.match(/class=["'][^"']*post-like[^"']*["'][\s\S]{0,200}?<span>([^<]*)<\/span>/i);
    out.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pickImage(card),
      vod_remarks: footerText.replace(/\s+/g, " ").slice(0, 40),
      vod_douban_score: likeM ? str(likeM[1]) : "",
      type_name: catM ? catM[1] : "麻豆社",
    });
  }
  return out;
}

function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!p || /\/(category|tag|author|page)\//.test("/" + p + "/")) return "";
    if (/^(likes|week|month|page|category|tag)$/i.test(p)) return "";
    if (!/\.html?$/i.test(p)) return "";
    return Buffer.from(p, "utf8").toString("base64url");
  } catch (_) { return ""; }
}
function urlFromVideoId(id) {
  const s = str(id);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  try {
    const p = Buffer.from(s, "base64url").toString("utf8");
    if (p && /\.html?$/i.test(p)) return new URL("/" + p.replace(/^\/+/, ""), SITE).href;
  } catch (_) {}
  if (/\.html?$/i.test(s)) return new URL("/" + s.replace(/^\/+/, ""), SITE).href;
  return "";
}

/* ---------------- 分类 / 筛选 ---------------- */

function parseNavCategories(html) {
  const out = [];
  const seen = new Set();
  const nav = html.match(/<div[^>]*class=["'][^"']*sitenav[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const seg = nav ? nav[1] : html;
  const re = /<li[^>]*class=["'][^"']*menu-item-object-category[^"']*["'][^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(seg))) {
    const href = absUrl(decodeHtml(m[1]));
    const name = cleanText(m[2]);
    if (!href || !name || seen.has(href)) continue;
    seen.add(href);
    out.push({ type_id: href, type_name: name });
  }
  return out;
}
function parsePageCount(html, page = 1) {
  let max = page;
  const re = /href=["']([^"']*\/page\/(\d+)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, toInt(m[2], page));
  return Math.max(1, max);
}
function buildCategoryPageUrl(typeId, page) {
  let base = str(typeId);
  if (!base) base = "likes";
  if (/^https?:\/\//i.test(base)) base = new URL(base).href.replace(/\/+$/, "");
  else base = new URL("/" + base.replace(/^\/+/, "").replace(/\/+$/, ""), SITE).href;
  if (page > 1) {
    if (/\/page\/\d+/.test(base)) base = base.replace(/\/page\/\d+/, `/page/${page}`);
    else base = base.replace(/\/+$/, "") + `/page/${page}`;
  }
  return base;
}

/* ---------------- 播放 ---------------- */

function parseSharePage(html) {
  const tokenM = html.match(/var\s+token\s*=\s*["']([^"']+)["']/i);
  const m3u8M = html.match(/var\s+m3u8\s*=\s*['"]([^'"]+)['"]/i);
  if (!m3u8M) return null;
  return {
    token: tokenM ? tokenM[1] : "",
    m3u8Path: m3u8M[1],
  };
}
function buildMediaUrl(m3u8Path, token) {
  let u = absUrl(m3u8Path, DASH);
  if (!u) return "";
  if (token) u += (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  return u;
}
async function resolvePlayUrl(shareUrl) {
  const key = `madou:share:${sha1(shareUrl)}`;
  const cached = await cacheGet(key);
  if (cached && cached.url && cached.expireAt && Date.now() < cached.expireAt) return cached;
  const res = await httpGet(shareUrl, { timeout: TIMEOUT });
  if (res.statusCode !== 200 || !res.body) {
    throw new Error(`share 页 HTTP ${res.statusCode} ${res.error || ""}`);
  }
  const share = parseSharePage(res.body);
  if (!share) throw new Error("share 页未找到 m3u8 变量");
  const url = buildMediaUrl(share.m3u8Path, share.token);
  if (!url) throw new Error("share 页 m3u8 地址为空");
  const rec = { url, token: share.token, expireAt: Date.now() + TOKEN_TTL * 1000 };
  memCache.set(key, { value: rec, expire: Date.now() + TOKEN_TTL * 1000 });
  return rec;
}

/* ---------------- 五个 handler ---------------- */

async function home(params, context) {
  try {
    logI(`[home] from=${context?.from || "web"} 入口`);
    const html = await getHtml(SITE + "/", CACHE_TTL);
    const list = parseCards(html, 24);
    const classes = parseNavCategories(html);
    const classList = [{ type_id: "likes", type_name: "点赞排行" }, ...classes];
    logI(`[home] list=${list.length} classes=${classList.length}`);
    return { class: classList, list, filters: {} };
  } catch (err) {
    logE(`[home] 失败: ${err.message || err}`);
    return { class: [], list: [], filters: {} };
  }
}

async function category(params, context) {
  const body = objectOf(params);
  const page = Math.max(1, toInt(body.page ?? body.pg, 1));
  const typeId = str(body.categoryId ?? body.type_id ?? body.id ?? "likes");
  try {
    const url = buildCategoryPageUrl(typeId, page);
    logI(`[category] typeId=${typeId} page=${page} url=${url}`);
    const html = await getHtml(url, CACHE_TTL);
    const list = parseCards(html, 100);
    const pagecount = parsePageCount(html, page);
    logI(`[category] list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total: list.length ? (page - 1) * 20 + list.length : 0, limit: 20, list };
  } catch (err) {
    logE(`[category] 失败 typeId=${typeId}: ${err.message || err}`);
    return { page, pagecount: 0, total: 0, limit: 20, list: [] };
  }
}

async function detail(params, context) {
  const body = objectOf(params);
  const rawId = str(body.videoId ?? body.id ?? body.ids ?? "");
  const url = urlFromVideoId(rawId);
  if (!url) { logE(`[detail] videoId 非法: ${rawId.slice(0, 100)}`); return { list: [] }; }
  try {
    const html = await getHtml(url, CACHE_TTL);
    const title = (html.match(/<h1[^>]*class=["'][^"']*article-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
      || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i));
    const name = title ? cleanText(title[1]) : "麻豆社视频";
    const iframe = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
    const shareUrl = iframe ? absUrl(decodeHtml(iframe[1])) : "";
    const shareId = (shareUrl.match(/\/share\/([A-Za-z0-9]+)/) || [])[1] || "";
    const poster = shareId ? `${DASH}/videos/${shareId}/poster.jpg` : "";
    const ogPic = str((html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "");
    const coverPic = str((html.match(/<img[^>]+(?:data-src|src)=["']([^"']*\/covers\/[^"']+)["']/i) || [])[1] || "");
    const pic = poster || (ogPic ? absUrl(ogPic) : "") || (coverPic ? absUrl(coverPic) : "");
    const catM = html.match(/<span[^>]*class=["'][^"']*item-3[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    const tags = [...html.matchAll(/<a[^>]+href=["'][^"']*\/tag\/[^"']+["'][^>]*>([^<]+)<\/a>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
    const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    const description = descM ? decodeHtml(descM[1]) : "";

    if (!shareUrl) {
      logE(`[detail] 未找到 iframe share 地址 url=${url}`);
      return { list: [] };
    }
    const playId = `${shareUrl}|||${Buffer.from(JSON.stringify({ n: name, u: url }), "utf8").toString("base64url")}`;
    const vod = {
      vod_id: rawId,
      vod_name: name,
      vod_pic: pic,
      vod_remarks: tags.slice(0, 3).join(" / "),
      vod_content: description,
      type_name: catM ? cleanText(catM[1]) : "麻豆社",
      vod_area: "国产",
      vod_lang: "国语",
      vod_play_sources: [{ name: "麻豆社", episodes: [{ name: "正片", playId }] }],
      vod_play_from: "麻豆社",
      vod_play_url: `正片$${playId}`,
    };
    logI(`[detail] name=${name} share=${shareUrl.slice(0, 70)}`);
    return { list: [vod] };
  } catch (err) {
    logE(`[detail] 失败 videoId=${rawId.slice(0, 80)}: ${err.message || err}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const body = objectOf(params);
  const keyword = str(body.keyword ?? body.wd ?? body.key ?? "");
  const page = Math.max(1, toInt(body.page ?? body.pg, 1));
  if (!keyword) return { page: 1, pagecount: 0, total: 0, limit: 20, list: [] };
  try {
    const base = new URL("/", SITE);
    base.searchParams.set("s", keyword);
    let url = base.href;
    if (page > 1) url = new URL(`/page/${page}?s=${encodeURIComponent(keyword)}`, SITE).href;
    logI(`[search] keyword=${keyword} page=${page} url=${url}`);
    const html = await getHtml(url, CACHE_TTL);
    const list = parseCards(html, 100);
    const pagecount = parsePageCount(html, page);
    logI(`[search] keyword=${keyword} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total: list.length ? (page - 1) * 20 + list.length : 0, limit: 20, list };
  } catch (err) {
    logE(`[search] 失败 keyword=${keyword}: ${err.message || err}`);
    return { page, pagecount: 0, total: 0, limit: 20, list: [] };
  }
}

async function play(params, context) {
  const body = objectOf(params);
  const raw = str(body.playId ?? body.id ?? body.url ?? "");
  const flag = str(body.flag ?? "麻豆社") || "麻豆社";
  try {
    if (!raw) throw new Error("playId 缺失");
    logI(`[play] 入口 playId=${raw.slice(0, 120)} flag=${flag}`);
    const shareUrl = absUrl(raw.split("|||")[0]);
    if (!shareUrl) throw new Error("share 地址为空");
    const resolved = await resolvePlayUrl(shareUrl);
    logI(`[play] m3u8=${resolved.url.slice(0, 140)}`);
    return {
      urls: [{ name: flag, url: resolved.url }],
      url: resolved.url,
      flag,
      header: {
        "User-Agent": UA,
        "Referer": SITE + "/",
        "Origin": SITE,
      },
      parse: 0,
    };
  } catch (err) {
    logE(`[play] 失败: ${err.message || err}`);
    return { urls: [], flag, header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
