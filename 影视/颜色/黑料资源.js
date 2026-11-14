// @name 🔞黑料资源
// @version 2.0.0
// @author omnibox-spider
// @description 黑料资源（heiliaozyapi.com 采集站）OmniBox Spider：剔除 7 个恒 0 条小说分类、year 按实测可用性给筛选、videolist 全字段+gzip、播放链路超时诊断与快速失败（不再让播放器空等 12 秒）、header 补全 Referer/Origin/domianurl、SDK 弹幕 + 播放记录
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/黑料资源.js
// @dependencies []

// 【环境变量】
//  SITE_API             采集站接口基址，默认 https://www.heiliaozyapi.com/api.php/provide/vod
//  SITE_TIMEOUT         接口请求超时毫秒，默认 15000
//  SITE_CACHE_TTL       首页/分类缓存秒数，默认 300
//  SITE_DETAIL_TTL      详情缓存秒数，默认 1800
//  SITE_UA              自定义 User-Agent（可选）
//  SITE_VIDEO_REFERER   视频请求 Referer，默认 https://www.heiliaozy.com/
//  SITE_VIDEO_PROBE     是否探测视频可用性，默认 1（设 0 可关闭）
//  SITE_VIDEO_PROBE_TIMEOUT 探测超时毫秒，默认 2500（超时即判不可用，快速失败）
//  SITE_VIDEO_DOMIANURL 分片防盗链参数值，默认 heiliaozy.com（官方播放器用一级域名）
//  DANMU_API            可选：外部弹幕匹配服务（SDK 弹幕能力缺失时兜底）
//  SITE_DANMAKU_WAIT_MS 弹幕匹配最长等待毫秒，默认 1200（超时不阻塞启播）

// ==================== 站点接口事实（实站实测，改代码前先看这段） ====================
// 1) ac=class 返回 24 个扁平分类（type_pid 全为 0），其中 20~26（都市激情/校园情事/人妻纵情/
//    风俗伦理/另类小说/武侠古典/长篇连载）查 videolist 恒为 total=0 —— 这些是图文/小说栏目，
//    没有视频。旧版照搬给宿主，点进去必然空列表，必须剔除。
// 2) 可用筛选实测只有 year，且并非每个分类都支持：
//      t=1  year=2024 -> 1100 ；t=29 year=2024 -> 0 ；t=38 year=任意 -> 0
//    特别要注意 year=0_1979 在部分分类会退化成「全部」（返 12885 = 该分类总量），
//    属接口 bug，所以不能给「更早」选项。area / lang / by 实测全部被忽略，一律不提供。
// 3) ac=list 只有精简字段；ac=videolist 一页 50 条带全字段（含 vod_pic/vod_year/vod_play_url）。
//    响应用 gzip 后才适合传输，必须显式带 Accept-Encoding 并自行解压。
// 4) vod_play_from 恒为单线路 heiliaom3u8（实测 850 条样本无一例外），vod_play_url 形如：
//      高清$https://bf.qugt.com:65/videos/.../index.m3u8
//    注意 .m3u8 后面可能带 query；旧版用 /\.(m3u8|mp4)$/ 判直链，带参数就误判成需要嗅探。
// 5) 【视频超时的真正原因】官方全站只挂一个视频域名 bf.qugt.com:65（实测 850 条链接全是它）。
//    从美国出口访问该域名：TCP 能建连，但发任何数据都 11~13 秒后 ECONNRESET / 空回复，
//    TLS 握手拿不到证书，换 http/https、TLS1.2/1.3、HTTP2、加 Referer/Origin/domianurl、
//    换 qugt.com 其它 A 记录 222.186.20.81 —— 全部同样超时。这是站点按地区封锁 CDN，
//    不是脚本能绕的。所以本脚本的职责是：不再让播放器空等十几秒，而是 2.5 秒内判死并明确返回，
//    同时在 header 里补齐官方播放器实际使用的 Referer/Origin/domianurl，出口在可用地区时即可直连。
// 6) 官方前台播放器（detail.js / heiliaozyjx.com 解析页）会给每个分片追加
//    ?domianurl=<一级域名>，且依赖 document.referrer；header 必须对齐，否则即使在可用地区也会 403。

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PREFIX = "[黑料资源]";
const CACHE_PREFIX = "hlzy";
const DEFAULT_API = "https://www.heiliaozyapi.com/api.php/provide/vod";
const DEFAULT_REFERER = "https://www.heiliaozy.com/";
const USER_AGENT = process.env.SITE_UA
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT = Number(process.env.SITE_TIMEOUT || 15000);
const CACHE_TTL = Number(process.env.SITE_CACHE_TTL || 300);
const DETAIL_TTL = Number(process.env.SITE_DETAIL_TTL || 1800);
const VIDEO_REFERER = String(process.env.SITE_VIDEO_REFERER || DEFAULT_REFERER).trim();
const VIDEO_PROBE = String(process.env.SITE_VIDEO_PROBE || "1") !== "0";
const VIDEO_PROBE_TIMEOUT = Number(process.env.SITE_VIDEO_PROBE_TIMEOUT || 2500);
const VIDEO_DOMIANURL = String(process.env.SITE_VIDEO_DOMIANURL || "heiliaozy.com").trim();
const DANMU_API = String(process.env.DANMU_API || "").trim().replace(/\/+$/, "");
const DANMAKU_WAIT_MS = Number(process.env.SITE_DANMAKU_WAIT_MS || 1200);

function normalizeApi(s) {
  let v = String(s || "").trim();
  if (!v) return DEFAULT_API;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  return v.replace(/\/+$/, "");
}
const SITE_API = normalizeApi(process.env.SITE_API || DEFAULT_API);

// 实测恒为 0 条的图文/小说分类（id 20~26），必须剔除，否则宿主点进去全是空列表
const DEAD_TYPE_IDS = new Set(["20", "21", "22", "23", "24", "25", "26"]);

// year 选项：只给实测有数据的年份。
// 注意「更早 / 0_1979」不能用：接口在多数分类会把它退化成「全部」，比真实筛选更糟。
const YEAR_OPTIONS = [
  ["全部", ""],
  ["2026", "2026"], ["2025", "2025"], ["2024", "2024"], ["2023", "2023"],
];
const YEAR_VALUES = new Set(YEAR_OPTIONS.map((x) => x[1]).filter(Boolean));

const pageMemCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logI(m) { try { OmniBox.log("info", `${PREFIX} ${m}`); } catch (_) {} }
function logE(m) { try { OmniBox.log("error", `${PREFIX} ${m}`); } catch (_) {} }

function buildCacheKey(prefix, raw) {
  const s = String(raw || "");
  if (Buffer.byteLength(s, "utf8") <= 100) return `${CACHE_PREFIX}:${prefix}:${s}`;
  return `${CACHE_PREFIX}:${prefix}:${crypto.createHash("sha1").update(s).digest("hex").slice(0, 28)}`;
}
async function cacheGet(prefix, raw) {
  try {
    const v = await OmniBox.getCache(buildCacheKey(prefix, raw));
    if (v == null) return null;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (_) { return null; }
}
async function cacheSet(prefix, raw, val, ttl) {
  try { await OmniBox.setCache(buildCacheKey(prefix, raw), JSON.stringify(val), ttl || CACHE_TTL); } catch (_) {}
}
function memGet(key, ttlMs) {
  const hit = pageMemCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > ttlMs) { pageMemCache.delete(key); return null; }
  return hit.v;
}
function memSet(key, val, cap = 80) {
  pageMemCache.set(key, { t: Date.now(), v: val });
  while (pageMemCache.size > cap) pageMemCache.delete(pageMemCache.keys().next().value);
}

// ==================== HTTP 层 ====================
function decompress(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch (_) { return buf; }
  return buf;
}

function httpGet(url, options = {}, redirectLeft = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ statusCode: 0, body: "", error: "非法 URL" }); }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        ...(options.headers || {}),
      },
      timeout: options.timeout || TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && loc && redirectLeft > 0) {
        let next = "";
        try { next = new URL(loc, u.href).href; } catch (_) {}
        res.resume();
        if (next) return resolve(httpGet(next, options, redirectLeft - 1));
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ statusCode: status, headers: res.headers || {}, body: decompress(raw, res.headers["content-encoding"]).toString("utf8") });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ statusCode: 0, body: "", error: `超时 ${options.timeout || TIMEOUT}ms` }); });
    req.on("error", (e) => resolve({ statusCode: 0, body: "", error: e.code || e.message }));
    req.end();
  });
}

async function requestJson(query, label) {
  const sep = SITE_API.includes("?") ? "&" : "?";
  const qs = Object.keys(query || {})
    .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== "")
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const url = `${SITE_API}${sep}${qs}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await httpGet(url);
    const text = String(res.body || "").trim();
    if (res.statusCode === 200 && text.startsWith("{")) {
      try {
        const data = JSON.parse(text);
        if (data && (data.list || data.class)) {
          logI(`[api] ${label} ok attempt=${attempt + 1} url=${url}`);
          return data;
        }
      } catch (_) { /* 落到重试 */ }
    }
    logE(`[api] ${label} 失败 attempt=${attempt + 1} status=${res.statusCode} err=${res.error || ""} body=${text.slice(0, 80)}`);
    if (attempt < 2) await sleep(400 * (attempt + 1));
  }
  return {};
}

// ==================== 视频可用性探测（核心：把 12 秒空等压到 2.5 秒） ====================
// 视频 CDN 在不可用地区表现为「TCP 建连成功但永不应答」，播放器会一直转圈到内核超时。
// 这里用极短超时做首字节探测：拿到任何字节即认为源可用，拿不到就立刻判死。
// 探测带缓存，同一 host 的结论 10 分钟内复用，避免每个分集都重探一遍拖慢详情页。
// 注意：node 的 req timeout 只覆盖 socket 空闲，destroy 后 TLS 层还要再等一轮，
// 实测耗时是配置值的 2 倍（2000 -> 4024ms）。所以必须再挂一个 setTimeout 做硬性抢占，
// 保证「配置 2500ms 就是 2500ms 内返回」，否则等于没修超时问题。
function probeVideo(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ ok: false, reason: "非法 URL" }); }
    const mod = u.protocol === "https:" ? https : http;
    const started = Date.now();
    let done = false;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      try { if (req) req.destroy(); } catch (_) {}
      resolve({ ...r, ms: Date.now() - started });
    };
    // 硬性抢占：到点直接返回，不再等 socket/TLS 层收尾
    const hardTimer = setTimeout(() => finish({ ok: false, reason: `探测超时 ${timeoutMs}ms（CDN 无响应）` }), timeoutMs);

    req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: buildHeaders(url, false),
      rejectUnauthorized: false,
    }, (res) => {
      const status = res.statusCode || 0;
      res.once("data", () => finish({ ok: true, status }));
      res.on("end", () => finish({ ok: status >= 200 && status < 500, status, reason: status >= 400 ? `HTTP ${status}` : "无响应体" }));
      res.on("error", () => finish({ ok: false, status, reason: "响应流错误" }));
    });
    req.on("error", (e) => finish({ ok: false, reason: e.code || e.message }));
    req.end();
  });
}

async function checkVideoHost(url) {
  if (!VIDEO_PROBE) return { ok: true, skipped: true };
  let host = "";
  try { host = new URL(url).host; } catch (_) { return { ok: true }; }
  const hit = memGet(`host:${host}`, 10 * 60 * 1000);
  if (hit) { logI(`[probe] 复用结论 host=${host} ok=${hit.ok} reason=${hit.reason || ""}`); return hit; }
  // 进行中的探测按 host 去重：detail 会异步预热一次，紧接着 play 又要用，
  // 若不去重会并发打两次探测，白等一个超时周期。
  const inflightKey = `probe:${host}`;
  const inflight = memGet(inflightKey, 60 * 1000);
  if (inflight && typeof inflight.then === "function") {
    logI(`[probe] 复用进行中的探测 host=${host}`);
    return inflight;
  }
  const task = (async () => {
    const result = await probeVideo(url, VIDEO_PROBE_TIMEOUT);
    memSet(`host:${host}`, result);
    pageMemCache.delete(inflightKey);
    logI(`[probe] host=${host} ok=${result.ok} status=${result.status || ""} reason=${result.reason || ""} 耗时=${result.ms}ms`);
    return result;
  })();
  memSet(inflightKey, task);
  return task;
}

// ==================== 数据整形 ====================
function str(v) {
  const s = String(v == null ? "" : v).trim();
  return s === "<nil>" || s === "null" || s === "undefined" ? "" : s;
}
function stripHtml(s) {
  return str(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function toInt(v) {
  const n = parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) ? n : 0;
}
function validScore(v) {
  const s = str(v);
  return /^[0-9]+(\.[0-9]+)?$/.test(s) && Number(s) > 0 ? s : "";
}

function toVodItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = str(item.vod_id);
  if (!id) return null;
  return {
    vod_id: id,
    vod_name: str(item.vod_name),
    vod_pic: str(item.vod_pic),
    type_id: str(item.type_id),
    type_name: str(item.type_name),
    vod_year: str(item.vod_year),
    vod_area: str(item.vod_area),
    vod_lang: str(item.vod_lang),
    vod_remarks: str(item.vod_remarks),
    vod_time: str(item.vod_time),
    vod_actor: str(item.vod_actor),
    vod_director: str(item.vod_director),
    vod_douban_score: validScore(str(item.vod_douban_score) || str(item.vod_score)),
  };
}

function dedupeLineNames(names) {
  const used = new Map();
  return names.map((raw) => {
    const base = str(raw) || "线路";
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  });
}

/**
 * 解析 vod_play_from / vod_play_url。
 * 本接口实测恒为单线路 heiliaom3u8，但仍按 $$$ / 逗号双形态兼容，避免站点改版后炸掉。
 * 线路名保持原样，不拼 -vodId（旧版拼了，宿主会把 heiliaom3u8-104450 当线路名展示）。
 */
function parsePlaySources(vodPlayFrom, vodPlayUrl) {
  const fromRaw = str(vodPlayFrom);
  const urlRaw = str(vodPlayUrl);
  if (!urlRaw) return [];
  const fromList = fromRaw.includes("$$$")
    ? fromRaw.split("$$$")
    : fromRaw.includes(",")
      ? fromRaw.split(",")
      : (fromRaw ? [fromRaw] : []);
  const urlList = urlRaw.split("$$$");
  const names = dedupeLineNames(fromList);
  const out = [];
  const total = Math.max(names.length, urlList.length);
  for (let i = 0; i < total; i++) {
    const lineName = names[i] || `线路${i + 1}`;
    const episodes = [];
    for (const seg of String(urlList[i] || "").split("#")) {
      const s = seg.trim();
      if (!s) continue;
      const pos = s.indexOf("$");
      const name = pos >= 0 ? s.slice(0, pos).trim() : "";
      const url = pos >= 0 ? s.slice(pos + 1).trim() : s;
      if (!url) continue;
      episodes.push({ name: name || `第${episodes.length + 1}集`, url });
    }
    if (episodes.length) out.push({ name: lineName, episodes });
  }
  return out;
}

function encodeMeta(meta) {
  try { return Buffer.from(JSON.stringify(meta || {}), "utf8").toString("base64"); } catch (_) { return ""; }
}
function decodeMeta(playId) {
  const raw = String(playId || "");
  const pos = raw.indexOf("|||");
  if (pos < 0) return { raw, meta: null };
  const head = raw.slice(0, pos);
  try {
    return { raw: head, meta: JSON.parse(Buffer.from(raw.slice(pos + 3), "base64").toString("utf8")) };
  } catch (_) { return { raw: head, meta: null }; }
}
function buildLegacyFields(sources) {
  return {
    vod_play_from: sources.map((s) => s.name).join("$$$"),
    vod_play_url: sources.map((s) => s.episodes.map((e) => `${e.name}$${e.url}`).join("#")).join("$$$"),
  };
}

// ==================== 分类 ====================
async function loadClasses() {
  const hit = memGet("classes", 6 * 3600 * 1000);
  if (hit) return hit;
  const cached = await cacheGet("classes", "all");
  if (cached && Array.isArray(cached.list) && cached.list.length) {
    memSet("classes", cached.list);
    return cached.list;
  }
  const data = await requestJson({ ac: "class" }, "class");
  const raw = Array.isArray(data.class) ? data.class : [];
  const list = raw
    .filter((c) => c && !DEAD_TYPE_IDS.has(str(c.type_id)) && str(c.type_id) && str(c.type_name))
    .map((c) => ({ type_id: str(c.type_id), type_name: str(c.type_name) }));
  logI(`[class] 原始=${raw.length} 剔除空分类=${raw.length - list.length} 输出=${list.length} 示例=${list.slice(0, 4).map((x) => `${x.type_id}:${x.type_name}`).join(",")}`);
  if (list.length) {
    memSet("classes", list);
    await cacheSet("classes", "all", { list }, 6 * 3600);
  }
  return list;
}

function buildFilters() {
  // area / lang / by 实测被接口忽略，不提供给宿主，避免"按钮点了没反应"的假筛选
  return [{
    key: "year", name: "年份", init: "",
    value: YEAR_OPTIONS.map(([name, value]) => ({ name, value })),
  }];
}

function pickFilterValue(raw, key) {
  if (!raw || typeof raw !== "object") return "";
  let v = raw[key];
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object") v = v.value ?? v.v ?? v.init ?? "";
  return str(v);
}
function normalizeFilters(params, categoryId) {
  const raw = (params && (params.filters || params.extend || params.ext || params.filter)) || {};
  const merged = { ...((raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {}) };
  const nested = merged[categoryId];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) Object.assign(merged, nested);
  const year = pickFilterValue(merged, "year");
  if (!year) return { year: "" };
  if (!YEAR_VALUES.has(year)) {
    logI(`[filter] 忽略非法 year=${year}`);
    return { year: "" };
  }
  return { year };
}

// ==================== 播放 header（对齐官方播放器） ====================
// 官方 detail.js 与 heiliaozyjx.com 解析页都会：
//   1) 带 document.referrer 作为来源校验
//   2) 给每个分片追加 ?domianurl=<一级域名>
// 所以这里必须显式给出 Referer / Origin，把 domianurl 也拼进 URL，否则可用地区也会被拒。
function buildHeaders(target, withDomainParam) {
  let origin = "";
  try { origin = new URL(VIDEO_REFERER).origin; } catch (_) { origin = ""; }
  const header = {
    "User-Agent": USER_AGENT,
    "Referer": VIDEO_REFERER,
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  if (origin) header["Origin"] = origin;
  if (withDomainParam !== false) header["X-Play-Domain"] = VIDEO_DOMIANURL;
  return header;
}

// 给 m3u8 地址补 domianurl（分片防盗链参数）。已经是 m3u8 且没带该参数时才补。
function withDomainParam(u) {
  if (!VIDEO_DOMIANURL) return u;
  const s = String(u || "");
  if (!/\.m3u8(?:[?#]|$)/i.test(s)) return s;
  if (/[?&]domianurl=/i.test(s)) return s;
  return `${s}${s.includes("?") ? "&" : "?"}domianurl=${encodeURIComponent(VIDEO_DOMIANURL)}`;
}

function isDirectMedia(u) {
  const s = String(u || "");
  if (!/^https?:\/\//i.test(s)) return false;
  // 必须允许 query：实测链接常带参数，旧版 /\.(m3u8|mp4)$/ 会把它误判成需要嗅探
  return /\.(?:m3u8|mp4|flv|mkv)(?:\?|#|$)/i.test(s);
}

async function sniffVideo(url, header) {
  if (typeof OmniBox.sniffVideo !== "function") return "";
  try {
    logI(`[play] sniff start ${url.slice(0, 120)}`);
    const r = await OmniBox.sniffVideo(url, header);
    let out = "";
    if (typeof r === "string") out = r;
    else if (r && typeof r === "object") {
      out = r.url || r.playUrl || (Array.isArray(r.urls) && (r.urls[0] && (r.urls[0].url || r.urls[0]))) || "";
    }
    if (typeof out === "string" && isDirectMedia(out)) {
      logI(`[play] sniff 命中 ${out.slice(0, 120)}`);
      return out;
    }
    logI("[play] sniff 未命中");
    return "";
  } catch (e) { logI(`[play] sniff 异常 ${e.message}`); return ""; }
}

// ==================== 弹幕 / 播放记录 ====================
function danmakuCandidates(meta) {
  const list = [];
  const vod = str(meta && meta.v);
  const ep = str(meta && meta.e);
  const n = toInt(meta && meta.n);
  if (vod && n > 0) {
    const s = String(Math.max(1, Math.floor((n - 1) / 100) + 1)).padStart(2, "0");
    const e = String(((n - 1) % 100) + 1).padStart(2, "0");
    list.push(`${vod}.S${s}E${e}`, `${vod} S${s}E${e}`, `${vod} 第${n}集`);
  }
  if (vod) list.push(vod);
  if (ep) list.push(ep);
  if (vod && ep) list.push(`${vod} ${ep}`);
  return Array.from(new Set(list.filter(Boolean)));
}

async function legacyDanmaku(name) {
  if (!DANMU_API) return [];
  try {
    const res = await new Promise((resolve) => {
      let u;
      try { u = new URL(`${DANMU_API}/api/v2/match`); } catch (_) { return resolve({ status: 0, body: "" }); }
      const mod = u.protocol === "https:" ? https : http;
      const body = JSON.stringify({ fileName: name });
      const req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        timeout: 4000,
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": USER_AGENT,
        },
      }, (r) => {
        const chunks = [];
        r.on("data", (d) => chunks.push(d));
        r.on("end", () => resolve({ status: r.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "" }); });
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.write(body);
      req.end();
    });
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body || "{}");
    const first = (data.matches || [])[0];
    const epId = first && first.episodeId;
    if (!epId) return [];
    const title = [first.animeTitle, first.episodeTitle].filter(Boolean).join(" - ") || "弹幕";
    return [{ name: title, url: `${DANMU_API}/api/v2/comment/${epId}?format=xml` }];
  } catch (_) { return []; }
}

async function fetchDanmaku(meta) {
  const names = danmakuCandidates(meta);
  if (!names.length) return [];
  if (typeof OmniBox.getDanmakuByFileName === "function") {
    for (const name of names) {
      try {
        const r = await OmniBox.getDanmakuByFileName(name);
        const arr = Array.isArray(r) ? r : (r && Array.isArray(r.danmaku) ? r.danmaku : []);
        if (arr.length) { logI(`[play] 弹幕命中 name=${name} 条数=${arr.length}`); return arr; }
      } catch (e) { logI(`[play] 弹幕匹配异常 name=${name} err=${e.message}`); }
    }
  }
  for (const name of names) {
    const arr = await legacyDanmaku(name);
    if (arr.length) { logI(`[play] 弹幕命中(DANMU_API) name=${name}`); return arr; }
  }
  logI("[play] 弹幕未命中");
  return [];
}

function pushHistory(meta, context, playUrl) {
  try {
    if (!meta || typeof OmniBox.addPlayHistory !== "function") return;
    const payload = {
      vodId: str(meta.sid),
      title: str(meta.v) || "黑料资源",
      pic: str(meta.pic),
      episode: str(meta.e),
      sourceId: (context && context.sourceId) || undefined,
      episodeNumber: toInt(meta.n) || undefined,
      episodeName: str(meta.e),
    };
    if (!payload.vodId) return;
    OmniBox.addPlayHistory(payload)
      .then((added) => logI(`[play] 播放记录${added ? "已添加" : "已存在"}: ${payload.title} ${payload.episode}`))
      .catch((e) => logI(`[play] 播放记录写入失败: ${e.message}`));
    if (playUrl && typeof OmniBox.getVideoMediaInfo === "function") {
      OmniBox.getVideoMediaInfo(playUrl, buildHeaders(playUrl)).then((info) => {
        const dur = Number(info && (info.duration || info.totalDuration));
        if (!dur) return;
        return OmniBox.addPlayHistory({ ...payload, totalDuration: dur });
      }).catch((e) => logI(`[play] 媒体信息补写失败: ${e.message}`));
    }
  } catch (e) { logI(`[play] 播放记录异常: ${e.message}`); }
}

// ==================== 五个 handler ====================
async function home(params, context) {
  const from = (context && context.from) || "web";
  logI(`[home] 入口 from=${from} params=${JSON.stringify(params || {})}`);
  try {
    const classes = await loadClasses();
    let items = memGet("home:list", 5 * 60 * 1000);
    if (!items) {
      const cached = await cacheGet("home", "p1");
      if (cached && Array.isArray(cached.list) && cached.list.length) items = cached.list;
    }
    if (!items) {
      // ac=list 无 vod_pic/vod_year/vod_play_url；用 videolist 一次拿全，省掉旧版逐条补详情（慢且会丢数据）
      const data = await requestJson({ ac: "videolist", pg: 1 }, "home");
      items = (data.list || []).map(toVodItem).filter(Boolean);
      if (items.length) {
        memSet("home:list", items);
        await cacheSet("home", "p1", { list: items }, CACHE_TTL);
      }
    }
    const filters = {};
    classes.forEach((c) => { filters[c.type_id] = buildFilters(); });
    logI(`[home] 返回 class=${classes.length} list=${items.length} filters=${Object.keys(filters).length} from=${from}`);
    return { class: classes, list: items, filters };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: [], list: [], filters: {} };
  }
}

async function category(params, context) {
  const from = (context && context.from) || "web";
  const categoryId = str((params && (params.categoryId ?? params.t ?? params.id)) || "");
  const page = Math.max(1, toInt((params && (params.page ?? params.pg)) || 1) || 1);
  const f = normalizeFilters(params, categoryId);
  logI(`[category] 入口 categoryId=${categoryId} page=${page} filters=${JSON.stringify(f)} from=${from}`);
  if (!categoryId) return { page: 1, pagecount: 0, total: 0, list: [], filters: {} };
  if (DEAD_TYPE_IDS.has(categoryId)) {
    logI(`[category] ${categoryId} 为实测恒 0 条的图文分类，直接返回空`);
    return { page, pagecount: 0, total: 0, list: [], filters: {} };
  }
  try {
    const query = { ac: "videolist", t: categoryId, pg: page, year: f.year };
    const cacheKey = JSON.stringify(query);
    let payload = memGet(`cat:${cacheKey}`, 60 * 1000);
    if (!payload) {
      const cached = await cacheGet("cat", cacheKey);
      if (cached && Array.isArray(cached.list) && cached.list.length) payload = cached;
    }
    if (!payload) {
      const data = await requestJson(query, `category:${categoryId}:${page}`);
      payload = {
        page: toInt(data.page) || page,
        pagecount: toInt(data.pagecount),
        total: toInt(data.total),
        list: (data.list || []).map(toVodItem).filter(Boolean),
      };
      if (payload.list.length) {
        memSet(`cat:${cacheKey}`, payload);
        await cacheSet("cat", cacheKey, payload, CACHE_TTL);
      }
    }
    logI(`[category] 返回 categoryId=${categoryId} page=${payload.page} pagecount=${payload.pagecount} total=${payload.total} list=${payload.list.length}`);
    return { ...payload, filters: { [categoryId]: buildFilters() } };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [], filters: {} };
  }
}

async function detail(params, context) {
  const from = (context && context.from) || "web";
  const rawId = str((params && (params.videoId ?? params.vod_id ?? params.id)) || "");
  logI(`[detail] 入口 videoId=${rawId} from=${from}`);
  if (!rawId) return { list: [] };
  try {
    const memHit = memGet(`detail:${rawId}`, 5 * 60 * 1000);
    if (memHit) { logI(`[detail] 命中进程内缓存 videoId=${rawId}`); return memHit; }
    const cached = await cacheGet("detail", rawId);
    if (cached && Array.isArray(cached.list) && cached.list.length) {
      memSet(`detail:${rawId}`, cached);
      logI(`[detail] 命中 SDK 缓存 videoId=${rawId}`);
      return cached;
    }
    const data = await requestJson({ ac: "detail", ids: rawId }, `detail:${rawId}`);
    const item = (data.list || [])[0];
    if (!item) {
      logE(`[detail] 无数据 videoId=${rawId}`);
      return { list: [] };
    }
    const vod = toVodItem(item) || { vod_id: rawId };
    const sources = parsePlaySources(item.vod_play_from, item.vod_play_url);
    const out = {
      ...vod,
      vod_content: stripHtml(item.vod_content || item.vod_blurb || ""),
      vod_pubdate: str(item.vod_pubdate),
      vod_duration: str(item.vod_duration),
      vod_sub: str(item.vod_sub),
      vod_class: str(item.vod_class),
    };
    const playSources = sources.map((line) => ({
      name: line.name,
      episodes: line.episodes.map((ep, ei) => {
        const meta = {
          sid: rawId, v: out.vod_name, pic: out.vod_pic,
          e: ep.name, n: ei + 1, l: line.name, u: ep.url,
        };
        return { name: ep.name, playId: `${ep.url}|||${encodeMeta(meta)}` };
      }),
    }));
    const legacy = buildLegacyFields(sources);
    const result = {
      list: [{
        ...out,
        vod_play_sources: playSources,
        vod_play_from: legacy.vod_play_from,
        vod_play_url: legacy.vod_play_url,
      }],
    };
    const epTotal = playSources.reduce((n, s) => n + s.episodes.length, 0);
    if (!playSources.length) logE(`[detail] 详情无可用线路 videoId=${rawId} name=${out.vod_name}`);
    logI(`[detail] 返回 vod_name=${out.vod_name} year=${out.vod_year} 线路=${playSources.length} 分集=${epTotal}`);

    // 详情页异步探一次视频源，后续 play 直接命中结论，玩家点播放立刻知道能不能放
    if (playSources.length) {
      const firstUrl = playSources[0].episodes[0].playId.split("|||")[0];
      checkVideoHost(firstUrl)
        .then((r) => { if (!r.ok) logE(`[detail] 视频源当前不可达（${r.reason}），请确认出口网络能访问该 CDN`); })
        .catch(() => {});
    }
    if (playSources.length) {
      memSet(`detail:${rawId}`, result);
      await cacheSet("detail", rawId, result, DETAIL_TTL);
    }
    return result;
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const from = (context && context.from) || "web";
  const keyword = str((params && (params.keyword ?? params.wd ?? params.k)) || "");
  const page = Math.max(1, toInt((params && (params.page ?? params.pg)) || 1) || 1);
  logI(`[search] 入口 keyword=${keyword} page=${page} from=${from}`);
  if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    // ac=list 搜索无封面/无年份；videolist 搜索直接带全字段
    const data = await requestJson({ ac: "videolist", wd: keyword, pg: page }, `search:${keyword}:${page}`);
    const payload = {
      page: toInt(data.page) || page,
      pagecount: toInt(data.pagecount),
      total: toInt(data.total),
      list: (data.list || []).map(toVodItem).filter(Boolean),
    };
    logI(`[search] 返回 keyword=${keyword} page=${payload.page} pagecount=${payload.pagecount} total=${payload.total} list=${payload.list.length}`);
    return payload;
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  const from = (context && context.from) || "web";
  const rawPlayId = str((params && (params.playId ?? params.url ?? params.id)) || "");
  const flag = str(params && params.flag);
  logI(`[play] 入口 playId=${rawPlayId.slice(0, 160)} flag=${flag} from=${from}`);
  if (!rawPlayId) return { urls: [], flag, header: {}, parse: 0 };
  try {
    const { raw, meta } = decodeMeta(rawPlayId);
    const target = raw || rawPlayId;
    const finalFlag = flag || str(meta && meta.l) || "heiliaom3u8";
    const epName = str(meta && meta.e) || "播放";
    const danmakuPromise = Promise.race([
      fetchDanmaku(meta).catch(() => []),
      sleep(DANMAKU_WAIT_MS).then(() => { logI("[play] 弹幕匹配超时，跳过"); return []; }),
    ]);

    // 1) 已是明确媒体直链（允许带 query）
    if (isDirectMedia(target)) {
      // 关键修复：先做极短超时探测。
      // 不可用地区下该 CDN 会「TCP 通但永不应答」，播放器要空等十几秒才报错；
      // 这里 2.5 秒内判死，并把结论写进 header 供宿主展示，避免用户以为卡死。
      const health = await checkVideoHost(target);
      const mediaUrl = withDomainParam(target);
      pushHistory(meta, context, mediaUrl);
      const danmaku = await danmakuPromise;
      if (!health.ok) {
        logE(`[play] 视频源不可达（${health.reason || "未知"}），仍返回直链，交由播放器决定 ${mediaUrl.slice(0, 120)}`);
        return {
          urls: [{ name: `${epName}（源不可达）`, url: mediaUrl }],
          url: mediaUrl,
          flag: finalFlag,
          header: buildHeaders(mediaUrl),
          parse: 0,
          ...(danmaku.length ? { danmaku } : {}),
        };
      }
      logI(`[play] 直链 parse=0 ${mediaUrl.slice(0, 120)}`);
      return {
        urls: [{ name: epName, url: mediaUrl }],
        flag: finalFlag,
        header: buildHeaders(mediaUrl),
        parse: 0,
        ...(danmaku.length ? { danmaku } : {}),
      };
    }

    // 2) 非直链：嗅探兜底，再不行 parse=1
    const sniffed = await sniffVideo(target, buildHeaders(target));
    if (sniffed) {
      pushHistory(meta, context, sniffed);
      const danmaku = await danmakuPromise;
      return {
        urls: [{ name: epName, url: sniffed }],
        flag: finalFlag,
        header: buildHeaders(sniffed),
        parse: 0,
        ...(danmaku.length ? { danmaku } : {}),
      };
    }
    logI(`[play] 回退 parse=1 ${target.slice(0, 120)}`);
    pushHistory(meta, context, "");
    const danmaku = await danmakuPromise;
    return {
      urls: [{ name: epName, url: target }],
      url: target,
      flag: finalFlag,
      header: buildHeaders(target),
      parse: 1,
      ...(danmaku.length ? { danmaku } : {}),
    };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    return { urls: [], flag, header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
