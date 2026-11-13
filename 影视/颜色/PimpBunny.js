// @name 🔞PimpBunny
// @version 1.0.2
// @author omnibox-spider
// @description PimpBunny（pimpbunny.com）OmniBox 源：WordPress-less 自建站 + bunny.net Shield 防护；支持 FlareSolverr 页面级破盾（FLARESOLVERR_URL / PIMPBUNNY_FLARESOLVERR_URL），缺省直连；首页/分类/搜索/详情解析 ui-card 卡片，详情解析 tb* 播放配置对象取 360p/480p/720p/1080p 直链。
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/PimpBunny.js
// @dependencies []

// 【环境变量】
//  PIMPBUNNY_HOST                 站点基址，默认 https://pimpbunny.com
//  PIMPBUNNY_FLARESOLVERR_URL     FlareSolverr 地址，例如 http://192.168.1.10:8191
//  FLARESOLVERR_URL               通用回退变量（与上面等价）
//  PIMPBUNNY_FLARESOLVERR_SESSION FlareSolverr session 名，默认 pimpbunny
//  PIMPBUNNY_FLARESOLVERR_TIMEOUT FlareSolverr 超时毫秒，默认 60000
//  PIMPBUNNY_CF_PAGE_TTL          破盾页面缓存秒数，默认 1800
//  PIMPBUNNY_UA                   自定义 UA
//  PIMPBUNNY_TIMEOUT              直连请求超时毫秒，默认 20000
//  PIMPBUNNY_CACHE_TTL            列表/搜索缓存秒数，默认 300
//  PIMPBUNNY_DETAIL_TTL           详情缓存秒数，默认 600

// OmniBox 宿主用 stdout 传 JSON 响应；部分版本 omnibox_sdk.log 会把日志写成
// JSON 字符串写进同一 stdout，Go 侧会报 cannot unmarshal string into struct。
// 这里在模块加载最早期做 stdout 消毒：日志字符串转 stderr，对象/数组响应放行。
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
function _safeStderr(chunk, encoding, cb) {
  try { return _origStderrWrite(chunk, encoding, cb); } catch (_) { return true; }
}
function _installStdoutGuard() {
  if (process.stdout.__pbGuard || process.stdout.__omniStdoutGuard) return;
  process.stdout.__pbGuard = true;
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

const PREFIX = "[pimpbunny]";
const SITE = normalizeHost(process.env.PIMPBUNNY_HOST || "https://pimpbunny.com");
const FS_URL = String(process.env.PIMPBUNNY_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || "").trim().replace(/\/+$/, "");
const FS_SESSION = String(process.env.PIMPBUNNY_FLARESOLVERR_SESSION || "pimpbunny").trim();
const FS_TIMEOUT = Math.max(10000, Number(process.env.PIMPBUNNY_FLARESOLVERR_TIMEOUT || 60000) || 60000);
const CF_PAGE_TTL = Math.max(60, Number(process.env.PIMPBUNNY_CF_PAGE_TTL || 1800) || 1800);
const UA = String(process.env.PIMPBUNNY_UA || process.env.SITE_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36").trim();
const TIMEOUT = Math.max(5000, Number(process.env.PIMPBUNNY_TIMEOUT || 20000) || 20000);
const CACHE_TTL = Math.max(30, Number(process.env.PIMPBUNNY_CACHE_TTL || 300) || 300);
const DETAIL_TTL = Math.max(60, Number(process.env.PIMPBUNNY_DETAIL_TTL || 600) || 600);

function logI(message) { try { process.stderr.write(`[info] ${PREFIX} ${message}\n`); } catch (_) {} }
function logE(message) { try { process.stderr.write(`[error] ${PREFIX} ${message}\n`); } catch (_) {} }

function normalizeHost(value) {
  let s = String(value || "").trim().replace(/\/+$/, "");
  if (!s) return "https://pimpbunny.com";
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
        return parsed;
      }
    }
  } catch (_) {}
  return null;
}
async function cacheSet(key, value, ttl = CACHE_TTL) {
  memCache.set(key, { value, expire: Date.now() + Math.max(1, ttl) * 1000 });
  while (memCache.size > 240) memCache.delete(memCache.keys().next().value);
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
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5, timeout: 60000 });

function browserHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    ...extra,
  };
}

function isBlockedHtml(body) {
  const head = String(body || "").slice(0, 6000);
  return /data-pow=|bunny-shield|Establishing a secure connection|cdn-challenge/i.test(head);
}

function httpGet(url, options = {}, redirectLeft = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ statusCode: 0, headers: {}, body: "", error: "URL 非法", source: "native" }); }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: browserHeaders(options.headers || {}),
      timeout: Math.max(1000, Number(options.timeout || TIMEOUT)),
      rejectUnauthorized: false,
      agent: u.protocol === "https:" ? HTTPS_AGENT : undefined,
    }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && loc && redirectLeft > 0) {
        res.resume();
        const next = absUrl(loc, u.href);
        if (next) return httpGet(next, options, redirectLeft - 1).then(resolve);
      }
      const chunks = [];
      const maxBytes = Math.max(65536, Number(options.maxBytes || 6 * 1024 * 1024));
      let bytes = 0;
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
          error: "",
          source: "native",
        });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ statusCode: 0, headers: {}, body: "", error: "timeout", source: "native" }); });
    req.on("error", (e) => resolve({ statusCode: 0, headers: {}, body: "", error: e.message || String(e), source: "native" }));
    req.end();
  });
}

/* ---------------- FlareSolverr ---------------- */

function cookiesToString(cookies) {
  if (!Array.isArray(cookies)) return "";
  return cookies.filter((c) => c && c.name).map((c) => `${c.name}=${c.value}`).join("; ");
}
function postJson(url, payload, timeout) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length, Accept: "application/json" },
      timeout,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let text = Buffer.concat(chunks).toString("utf8");
        try { resolve(JSON.parse(text)); } catch (_) { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}
async function flareGet(targetUrl) {
  if (!FS_URL) return null;
  const payload = { cmd: "request.get", url: targetUrl, maxTimeout: FS_TIMEOUT };
  if (FS_SESSION) payload.session = FS_SESSION;
  const started = Date.now();
  const res = await postJson(FS_URL + "/v1", payload, FS_TIMEOUT + 5000);
  if (!res) { logE(`[flare] 请求失败 url=${targetUrl.slice(0, 90)}`); return null; }
  if (res.status !== "ok") {
    logE(`[flare] 状态=${res.status || "?"} msg=${String(res.message || "").slice(0, 120)}`);
    return null;
  }
  const sol = res.solution || {};
  const body = String(sol.response || "");
  const cookie = cookiesToString(sol.cookies);
  const ua = str(sol.userAgent);
  logI(`[flare] 成功 url=${targetUrl.slice(0, 80)} status=${sol.status || 200} bodyLen=${body.length} cookies=${(sol.cookies || []).length} 耗时=${Date.now() - started}ms`);
  return {
    body,
    statusCode: Number(sol.status || 200),
    headers: sol.headers || {},
    cookie,
    ua,
  };
}

/* ---------------- 页面获取（带破盾与页面级缓存） ---------------- */

async function getPage(url, opts = {}) {
  const ttl = Math.max(30, Number(opts.ttl || CACHE_TTL));
  const useFlare = opts.flare !== false && !!FS_URL;
  const cacheKeyName = `pimpbunny:page:${sha1(url)}`;

  const cached = await cacheGet(cacheKeyName);
  if (cached && typeof cached.body === "string" && cached.body) {
    logI(`[page] 命中缓存 url=${url.slice(0, 90)} len=${cached.body.length} via=${cached.via || "?"}`);
    return cached;
  }

  // 第一次：优先直连（成本低），被盾再走 FlareSolverr。
  let direct = await httpGet(url, { timeout: TIMEOUT });
  if (direct.statusCode === 200 && direct.body && !isBlockedHtml(direct.body)) {
    await cacheSet(cacheKeyName, { body: direct.body, via: "direct" }, ttl);
    return { body: direct.body, via: "direct" };
  }

  if (useFlare) {
    logI(`[page] 直连被盾，转 FlareSolverr url=${url.slice(0, 90)} status=${direct.statusCode}`);
    const flared = await flareGet(url);
    if (flared && flared.statusCode === 200 && flared.body && !isBlockedHtml(flared.body)) {
      await cacheSet(cacheKeyName, { body: flared.body, via: "flare", cookie: flared.cookie || "", ua: flared.ua || "" }, ttl);
      return { body: flared.body, via: "flare" };
    }
    // FlareSolverr 给了 cookie 但页面仍是盾页时，用 cookie 补一次原生请求。
    if (flared && flared.cookie) {
      const withCookie = await httpGet(url, {
        timeout: TIMEOUT,
        headers: {
          Cookie: flared.cookie,
          ...(flared.ua ? { "User-Agent": flared.ua } : {}),
          Referer: SITE + "/",
        },
      });
      if (withCookie.statusCode === 200 && withCookie.body && !isBlockedHtml(withCookie.body)) {
        await cacheSet(cacheKeyName, { body: withCookie.body, via: "flare-cookie" }, ttl);
        return { body: withCookie.body, via: "flare-cookie" };
      }
    }
  } else {
    logI(`[page] 未配置 FLARESOLVERR_URL，直连被盾 status=${direct.statusCode} url=${url.slice(0, 90)}`);
  }

  throw new Error(`页面获取失败 status=${direct.statusCode} ${direct.error || ""}${FS_URL ? " (FlareSolverr 未解决)" : " (未配置 FLARESOLVERR_URL)"}`);
}

/* ---------------- 列表解析 ---------------- */

function pickImage(card) {
  const cands = [];
  const re = /(?:data-original|data-webp|data-src|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(card))) {
    const v = decodeHtml(m[1]);
    if (!v || /^data:image/i.test(v)) continue;
    const abs = absUrl(v);
    if (abs) cands.push(abs);
  }
  return cands[0] || "";
}
function parseCards(html, limit = 60) {
  const out = [];
  const seen = new Set();
  const cardRe = /<div class="ui-card-root[^"]*ui-card-video[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  let m;
  while ((m = cardRe.exec(html)) && out.length < limit) {
    const card = m[0];
    const linkM = card.match(/<a[^>]+class="[^"]*ui-card-link[^"]*"[^>]+href="([^"]+)"/i)
      || card.match(/<a[^>]+href="(https?:\/\/[^"]*\/videos\/[^"]+\/)"/i);
    if (!linkM) continue;
    const href = absUrl(decodeHtml(linkM[1]));
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const titleM = card.match(/class="[^"]*ui-card-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const altM = card.match(/<img[^>]+alt="([^"]*)"/i);
    const title = cleanText(titleM ? titleM[1] : (altM ? altM[1] : ""));
    if (!title) continue;
    const durM = card.match(/class="[^"]*ui-card-duration[^"]*"[^>]*>([^<]*)</i);
    const models = [...card.matchAll(/href="[^"]*\/onlyfans-creators\/[^"]*"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/gi)].map((x) => cleanText(x[1])).filter(Boolean);
    const viewM = card.match(/<span>\s*([\d.]+[KMB]?)\s*<\/span>/i);
    out.push({
      vod_id: href,
      vod_name: title,
      vod_pic: pickImage(card),
      vod_remarks: [durM ? cleanText(durM[1]) : "", models.join(" & ")].filter(Boolean).join(" · "),
      vod_actor: models.join(", "),
      vod_douban_score: viewM ? viewM[1] : "",
      type_name: "PimpBunny",
    });
  }
  return out;
}

function parsePageCount(html, page = 1) {
  let max = page;
  // 1) 分页控件里的最大页码（videos/、categories/<slug>/、search/<kw>/ 都覆盖）
  const re = /href="[^"]*?\/(?:videos\/|categories\/[^"/]+\/|search\/[^"/]+\/)?(\d+)\/?"/gi;
  let m;
  while ((m = re.exec(html))) {
    const n = toInt(m[1], 0);
    if (n > max && n < 100000) max = n;
  }
  // 2) 总数文案，例如 "98472 videos" / "29 categories"
  const countM = html.match(/([\d,]+)\s*(?:videos|categories)\b/i);
  if (countM) {
    const total = toInt(countM[1].replace(/,/g, ""), 0);
    if (total > 0) max = Math.max(max, Math.ceil(total / 28));
  }
  // 3) 搜索页是 ajax 分页，只有 from_videos 偏移：page = ceil(maxOffset / 28)
  const offsets = [...html.matchAll(/from_videos:(\d+)/g)].map((x) => toInt(x[1], 0)).filter((n) => n > 0);
  if (offsets.length) max = Math.max(max, ...offsets);
  return Math.max(1, max);
}

/* ---------------- 分类 ---------------- */

function parseCategories(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/categories\/([^"\/]+)\/?)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = str(m[2]);
    if (!slug || seen.has(slug)) continue;
    const name = cleanText(m[3]) || slug;
    if (!name || name.length > 40) continue;
    seen.add(slug);
    out.push({ type_id: `/categories/${slug}/`, type_name: name });
  }
  return out;
}

const FALLBACK_CATEGORIES = [
  { type_id: "/videos/", type_name: "最新视频" },
  { type_id: "/categories/exclusive/", type_name: "Exclusive" },
  { type_id: "/categories/lesbian/", type_name: "Lesbian" },
  { type_id: "/categories/anal/", type_name: "Anal" },
  { type_id: "/categories/big-boobs/", type_name: "Big Boobs" },
  { type_id: "/categories/milf/", type_name: "MILF" },
  { type_id: "/categories/teen/", type_name: "Teen" },
  { type_id: "/categories/4k/", type_name: "4K" },
  { type_id: "/categories/cosplay/", type_name: "Cosplay" },
  { type_id: "/categories/asian/", type_name: "Asian" },
  { type_id: "/categories/latina/", type_name: "Latina" },
  { type_id: "/categories/petite/", type_name: "Petite" },
  { type_id: "/categories/bdsm/", type_name: "BDSM" },
  { type_id: "/categories/threesome/", type_name: "Threesome" },
];

/* ---------------- 详情 ---------------- */

function parsePlayerConfig(html) {
  // 详情页形如：var tb7175d6b0e = {video_id: '623849', video_url: '...', ...};
  const m = html.match(/var\s+tb[0-9a-f]+\s*=\s*\{/i);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let quote = "";
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = true; quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        return parseLooseObject(raw);
      }
    }
  }
  return null;
}
function parseLooseObject(raw) {
  // 配置对象是 JS 字面量（单引号 + 未加引号 key），手工抽取需要的字段。
  const get = (key) => {
    const re = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|([^,}\\s]+))`, "i");
    const m = raw.match(re);
    if (!m) return "";
    return decodeHtml(m[1] ?? m[2] ?? m[3] ?? "");
  };
  const qualities = [];
  const push = (url, label, hd) => {
    const u = str(url);
    if (!u || !/^https?:\/\//i.test(u)) return;
    qualities.push({ url: absUrl(u), label: label || "原画", hd: !!hd });
  };
  push(get("video_url"), get("video_url_text") || "360p", false);
  push(get("video_alt_url"), get("video_alt_url_text") || "480p", false);
  push(get("video_alt_url2"), get("video_alt_url2_text") || "720p", get("video_alt_url2_hd") === "1");
  push(get("video_alt_url3"), get("video_alt_url3_text") || "1080p", get("video_alt_url3_fhd") === "1");
  return {
    videoId: get("video_id"),
    title: get("video_title"),
    categories: get("video_categories"),
    tags: get("video_tags"),
    models: get("video_models"),
    qualities,
    timeline: get("timeline_screens_url"),
  };
}

/* ---------------- 五个 handler ---------------- */

async function home(params, context) {
  try {
    logI(`[home] from=${context?.from || "web"} flare=${FS_URL ? "on" : "off"}`);
    const page = await getPage(SITE + "/", { ttl: CACHE_TTL });
    const list = parseCards(page.body, 24);
    let classes = parseCategories(page.body);
    if (classes.length < 3) {
      // 首页分类入口少时，再抓一次 /categories/ 补全。
      try {
        const cats = await getPage(SITE + "/categories/", { ttl: CACHE_TTL });
        classes = parseCategories(cats.body);
      } catch (err) { logE(`[home] 分类页失败: ${err.message || err}`); }
    }
    if (!classes.length) classes = FALLBACK_CATEGORIES.slice(0, 12);
    const classList = [{ type_id: "/videos/", type_name: "最新视频" }, ...classes.filter((c) => c.type_id !== "/videos/")];
    logI(`[home] list=${list.length} classes=${classList.length} via=${page.via}`);
    return { class: classList, list, filters: {} };
  } catch (err) {
    logE(`[home] 失败: ${err.message || err}`);
    return {
      class: [{ type_id: "/videos/", type_name: "最新视频" }, ...FALLBACK_CATEGORIES.slice(1, 10)],
      list: [],
      filters: {},
    };
  }
}

async function category(params, context) {
  const body = objectOf(params);
  const pageNo = Math.max(1, toInt(body.page ?? body.pg, 1));
  let typeId = str(body.categoryId ?? body.type_id ?? body.id ?? "/videos/");
  try {
    if (!typeId.startsWith("/")) typeId = "/" + typeId.replace(/^\/+/, "");
    if (!/\/$/.test(typeId)) typeId += "/";
    let url = absUrl(typeId);
    if (pageNo > 1) url = absUrl(typeId.replace(/\/+$/, "") + `/${pageNo}/`);
    logI(`[category] typeId=${typeId} page=${pageNo} url=${url}`);
    const page = await getPage(url, { ttl: CACHE_TTL });
    const list = parseCards(page.body, 60);
    const pagecount = parsePageCount(page.body, pageNo);
    logI(`[category] list=${list.length} pagecount=${pagecount} via=${page.via}`);
    return {
      page: pageNo,
      pagecount,
      total: list.length ? (pageNo - 1) * 28 + list.length : 0,
      limit: 28,
      list,
    };
  } catch (err) {
    logE(`[category] 失败 typeId=${typeId}: ${err.message || err}`);
    return { page: pageNo, pagecount: 0, total: 0, limit: 28, list: [] };
  }
}

async function search(params, context) {
  const body = objectOf(params);
  const keyword = str(body.keyword ?? body.wd ?? body.key ?? "");
  const pageNo = Math.max(1, toInt(body.page ?? body.pg, 1));
  if (!keyword) return { page: 1, pagecount: 0, total: 0, limit: 28, list: [] };
  try {
    const urls = [];
    const qBase = new URL(SITE + "/search/");
    qBase.searchParams.set("q", keyword);
    if (pageNo > 1) {
      const paged = new URL(qBase.href);
      paged.searchParams.set("from_videos", String((pageNo - 1) * 28 + 1));
      urls.push(paged.href);
    }
    urls.push(qBase.href);
    if (pageNo > 1) urls.push(absUrl(`/search/${encodeURIComponent(keyword)}/${pageNo}/`));
    urls.push(absUrl(`/search/${encodeURIComponent(keyword)}/`));
    let page = null;
    let usedUrl = "";
    let lastErr = null;
    for (const candidate of urls.filter(Boolean)) {
      try {
        page = await getPage(candidate, { ttl: CACHE_TTL });
        usedUrl = candidate;
        break;
      } catch (err) { lastErr = err; }
    }
    if (!page) throw (lastErr || new Error("搜索页获取失败"));
    logI(`[search] keyword=${keyword} page=${pageNo} url=${usedUrl} via=${page.via}`);
    const list = parseCards(page.body, 60);
    const pagecount = parsePageCount(page.body, pageNo);
    logI(`[search] keyword=${keyword} list=${list.length} pagecount=${pagecount} via=${page.via}`);
    return {
      page: pageNo,
      pagecount,
      total: list.length ? (pageNo - 1) * 28 + list.length : 0,
      limit: 28,
      list,
    };
  } catch (err) {
    logE(`[search] 失败 keyword=${keyword}: ${err.message || err}`);
    return { page: pageNo, pagecount: 0, total: 0, limit: 28, list: [] };
  }
}

async function detail(params, context) {
  const body = objectOf(params);
  let rawId = str(body.videoId ?? body.id ?? body.ids ?? "");
  if (!rawId) { logE("[detail] videoId 缺失"); return { list: [] }; }
  if (!/^https?:\/\//i.test(rawId)) rawId = absUrl(rawId);
  try {
    logI(`[detail] url=${rawId}`);
    const page = await getPage(rawId, { ttl: DETAIL_TTL });
    const html = page.body;
    const cfg = parsePlayerConfig(html) || { qualities: [] };

    const titleM = html.match(/class="[^"]*pages-view-video-video-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/"name":\s*"([^"]{1,200})"/i)
      || html.match(/<title>([^<]*)<\/title>/i);
    const name = cleanText(titleM ? titleM[1] : "") || "PimpBunny Video";
    const pic = absUrl((html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || "");
    const descM = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i);
    const description = descM ? decodeHtml(descM[1]) : "";
    const dateM = html.match(/"uploadDate":\s*"([^"]+)"/i);
    const dateText = dateM ? dateM[1] : "";
    const viewsM = html.match(/class="[^"]*pages-view-video-views[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const views = viewsM ? cleanText(viewsM[1]) : "";

    const qualities = (cfg.qualities || []).slice();
    // 从高到低排，最好画质在前；同画质保持上游顺序。
    qualities.sort((a, b) => {
      const qa = toInt((a.label || "").replace(/[^\d]/g, ""), 0);
      const qb = toInt((b.label || "").replace(/[^\d]/g, ""), 0);
      return qb - qa;
    });
    if (!qualities.length) {
      logE(`[detail] 未解析到播放直链 url=${rawId.slice(0, 90)}`);
      return { list: [] };
    }

    const episodes = qualities.map((q) => ({
      name: q.label || "原画",
      playId: q.url,
    }));
    const sources = [{ name: "PimpBunny", episodes }];

    const vod = {
      vod_id: (() => { try { const u = new URL(rawId); return u.pathname.replace(/^\/+/, ""); } catch (_) { return rawId; } })(),
      vod_name: name,
      vod_pic: pic,
      vod_content: description,
      vod_remarks: [dateText, views ? `观看 ${views}` : ""].filter(Boolean).join(" · "),
      vod_year: dateText ? dateText.slice(0, 4) : "",
      vod_actor: cfg.models || "",
      vod_area: "欧美",
      vod_lang: "英语",
      type_name: (cfg.categories || "").split(",")[0].trim() || "PimpBunny",
      vod_play_sources: sources,
      vod_play_from: "PimpBunny",
      vod_play_url: episodes.map((e) => `${e.name}$${e.playId}`).join("#"),
    };
    logI(`[detail] name=${name.slice(0, 50)} qualities=${qualities.map((q) => q.label).join("/")} via=${page.via}`);
    return { list: [vod] };
  } catch (err) {
    logE(`[detail] 失败 url=${rawId.slice(0, 90)}: ${err.message || err}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const body = objectOf(params);
  const raw = str(body.playId ?? body.id ?? body.url ?? "");
  const flag = str(body.flag ?? "PimpBunny") || "PimpBunny";
  try {
    if (!raw) throw new Error("playId 缺失");
    let url = raw;
    if (!/^https?:\/\//i.test(url)) url = absUrl(url);
    if (!url) throw new Error("播放地址为空");
    logI(`[play] url=${url.slice(0, 130)} flag=${flag}`);
    const isDirect = /\.(mp4|m3u8|ts|flv|m4s)(?:\?|\/|$)/i.test(url) || /\/get_file\//i.test(url);
    return {
      urls: [{ name: flag, url }],
      url,
      flag,
      header: {
        "User-Agent": UA,
        "Referer": SITE + "/",
        "Origin": SITE,
      },
      parse: isDirect ? 0 : 1,
    };
  } catch (err) {
    logE(`[play] 失败: ${err.message || err}`);
    return { urls: [], flag, header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
