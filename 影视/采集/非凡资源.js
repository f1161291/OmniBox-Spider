// @name 🎬非凡资源
// @version 2.0.0
// @author omnibox-spider
// @description 非凡资源（ffzyapi.com 采集站）OmniBox Spider：ac=videolist 全字段直取、叶子分类（父分类接口恒 0 条已剔除）、year/area/今日更新筛选、分享页 const url 解 m3u8、直链 parse=0 + 嗅探兜底、SDK 弹幕 + 播放记录、页面级缓存
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/非凡资源.js
// @dependencies []

// 【环境变量】
//  SITE_API            采集站接口基址，默认 https://api.ffzyapi.com/api.php/provide/vod（沿用通用采集站变量）
//  SITE_TIMEOUT        单请求超时毫秒，默认 15000
//  SITE_CACHE_TTL      首页/分类缓存秒数，默认 300
//  SITE_DETAIL_TTL     详情缓存秒数，默认 1800
//  SITE_UA             自定义 User-Agent（可选）
//  DANMU_API           可选：外部弹幕匹配服务（SDK 弹幕能力不可用时的旧链路兜底）
//  SITE_DANMAKU_WAIT_MS 弹幕匹配最长等待毫秒，默认 1200（超时不阻塞启播）

// ==================== 采集站接口事实（实站实测，改代码前先看这段） ====================
// 1) ac=list 只返回精简字段：无 vod_pic / vod_year / vod_area / vod_lang / vod_douban_score / vod_play_url。
//    所以列表页一律走 ac=videolist，一次拿到完整字段；不需要旧版那套"拿 detail 逐条补字段"
//    （首屏 3 秒起步，且 ac=detail&ids= 默认 limit=20，传 40 个 id 只回前 20 条，补详情本身会丢数据）。
// 2) ac=class 返回 31 个分类，但父分类（type_pid=0：电影片/连续剧/综艺片/动漫片）查 videolist 恒为 total=0。
//    只有 type_pid!=0 的叶子分类有数据。旧版把父分类也照搬给宿主，点进去必然空列表。
// 3) 线上可用筛选参数只有 year 与 area。lang / by / order / sort 实测全部被忽略（total 不变），
//    因此不提供给宿主，避免"按钮点了没反应"的假筛选。
// 4) h=<小时数> 是「最近 N 小时更新」，默认排序本身就是 vod_time 倒序。
// 5) vod_play_from / vod_play_url 在 ac=videolist 与 ac=detail 下都用 $$$ 分隔线路、# 分隔分集、$ 分隔集名与地址；
//    但 ac=list 下 vod_play_from 是逗号分隔（feifan,ffm3u8）——旧版按 $$$ 判断，整串被当成一个线路名。
// 6) 线路 feifan 给的是分享页 URL（/share/<hash>），页内 const url = "/path/index.m3u8?sign=..." 才是真地址；
//    线路 ffm3u8 直接给 m3u8。两者都可能带 query，旧版用 /\.(m3u8|mp4)$/ 判直链，带 sign 就误判成需要解析。
// 7) 部分 CDN 对裸请求 403（区域限制），分享页解出来的 m3u8 也可能 403 —— 站点侧限制，脚本只能兜底到 sniff / parse=1。

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PREFIX = "[非凡资源]";
const CACHE_PREFIX = "ffzy";
const DEFAULT_API = "https://api.ffzyapi.com/api.php/provide/vod";
const USER_AGENT = process.env.SITE_UA
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT = Number(process.env.SITE_TIMEOUT || 15000);
const CACHE_TTL = Number(process.env.SITE_CACHE_TTL || 300);
const DETAIL_TTL = Number(process.env.SITE_DETAIL_TTL || 1800);
const DANMU_API = String(process.env.DANMU_API || "").trim().replace(/\/+$/, "");
const DANMAKU_WAIT_MS = Number(process.env.SITE_DANMAKU_WAIT_MS || 1200);

function normalizeApi(s) {
  let v = String(s || "").trim();
  if (!v) return DEFAULT_API;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  return v.replace(/\/+$/, "");
}
const SITE_API = normalizeApi(process.env.SITE_API || DEFAULT_API);

// 父分类名（只用于给叶子分类加前缀；父分类本身不进 class 列表）
const PARENT_NAMES = { "1": "电影", "2": "剧集", "3": "综艺", "4": "动漫" };

// 实测可用的筛选值（未列出的值接口会返回 total=0 或直接忽略参数）
const YEAR_OPTIONS = [
  ["全部", ""],
  ["2026", "2026"], ["2025", "2025"], ["2024", "2024"], ["2023", "2023"],
  ["2022", "2022"], ["2021", "2021"], ["2020", "2020"],
  ["10年代", "2010_2019"], ["00年代", "2000_2009"], ["90年代", "1990_1999"],
  ["80年代", "1980_1989"], ["更早", "0_1979"],
];
const AREA_OPTIONS = [
  ["全部", ""],
  ["大陆", "大陆"], ["香港", "香港"], ["台湾", "台湾"],
  ["美国", "美国"], ["日本", "日本"], ["韩国", "韩国"], ["英国", "英国"],
  ["法国", "法国"], ["德国", "德国"], ["泰国", "泰国"], ["印度", "印度"],
  ["俄罗斯", "俄罗斯"], ["意大利", "意大利"], ["西班牙", "西班牙"],
  ["加拿大", "加拿大"], ["澳大利亚", "澳大利亚"], ["墨西哥", "墨西哥"],
  ["新西兰", "新西兰"], ["越南", "越南"], ["新加坡", "新加坡"],
];
const YEAR_VALUES = new Set(YEAR_OPTIONS.map((x) => x[1]).filter(Boolean));
const AREA_VALUES = new Set(AREA_OPTIONS.map((x) => x[1]).filter(Boolean));

const VIRTUAL_NEW = "new";
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
// 采集站偶发返回非 JSON（网关错误页 / 空 body），必须重试并安全降级；
// 旧版 JSON.parse 一抛就把整个 handler 判空，表现为"首页偶尔全白"。
// 另外 ac=videolist 单页响应实测 657~685KB，裸传 8~45 秒；带 gzip 后压到 ~190KB、2~5 秒，
// 所以必须显式要 gzip 并自己解压（node 的 http 不会自动解）。
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
        const body = decompress(raw, res.headers["content-encoding"]).toString("utf8");
        resolve({ statusCode: status, headers: res.headers || {}, body, bytes: raw.length });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ statusCode: 0, body: "", error: `超时 ${options.timeout || TIMEOUT}ms` }); });
    req.on("error", (e) => resolve({ statusCode: 0, body: "", error: e.message }));
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

function requestText(url, referer) {
  return httpGet(url, { headers: referer ? { Referer: referer } : {} });
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

// 列表项（ac=videolist 才有完整字段）
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

// 同名线路补序号，避免宿主把两条同名字段折叠成一条
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
 * 解析 vod_play_from($$$ 或逗号) / vod_play_url($$$ 分线路、# 分集、$ 分集名与地址)。
 * 这里只产出「干净线路名 + 分集原始地址」，不再给线路名拼 `-vodId` 后缀：
 * 拼了既会让宿主把 `feifan-98541` 当线路名展示，又会在 ac=list 的逗号格式下彻底对不上。
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
      let name;
      let url;
      if (pos >= 0) {
        name = s.slice(0, pos).trim();
        url = s.slice(pos + 1).trim();
      } else {
        url = s;
      }
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

// 兼容旧展示链路：干净线路名 + 原样 vod_play_url（不带 -vodId 后缀）
function buildLegacyFields(sources) {
  const vod_play_from = sources.map((s) => s.name).join("$$$");
  const vod_play_url = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.url}`).join("#")).join("$$$");
  return { vod_play_from, vod_play_url };
}

// ==================== 分类 ====================
async function loadClasses(force) {
  const hit = memGet("classes", 6 * 3600 * 1000);
  if (hit && !force) return hit;
  if (!force) {
    const cached = await cacheGet("classes", "all");
    if (cached && Array.isArray(cached.list) && cached.list.length) {
      memSet("classes", cached.list);
      return cached.list;
    }
  }
  const data = await requestJson({ ac: "class" }, "class");
  const raw = Array.isArray(data.class) ? data.class : [];
  const leaves = raw.filter((c) => c && str(c.type_pid) !== "0" && str(c.type_id) && str(c.type_name));
  const list = leaves.map((c) => {
    const parent = PARENT_NAMES[str(c.type_pid)] || "";
    const name = str(c.type_name);
    return {
      type_id: str(c.type_id),
      type_name: parent && !name.startsWith(parent) ? `${parent}·${name}` : name,
    };
  });
  // 虚拟分类：今日更新（h=24）
  list.unshift({ type_id: VIRTUAL_NEW, type_name: "今日更新" });
  logI(`[class] 原始=${raw.length} 叶子=${leaves.length} 输出=${list.length} 示例=${list.slice(0, 4).map((x) => `${x.type_id}:${x.type_name}`).join(",")}`);
  if (list.length > 1) {
    memSet("classes", list);
    await cacheSet("classes", "all", { list }, 6 * 3600);
  }
  return list;
}

function buildFilters(categoryId) {
  const area = {
    key: "area", name: "地区", init: "",
    value: AREA_OPTIONS.map(([name, value]) => ({ name, value })),
  };
  if (categoryId === VIRTUAL_NEW) {
    // 今日更新本身就是 h=24 时间流，只留地区筛选
    return [area];
  }
  const year = {
    key: "year", name: "年份", init: "",
    value: YEAR_OPTIONS.map(([name, value]) => ({ name, value })),
  };
  return [year, area];
}

// 宿主可能传 {filters} / {extend} / {ext} / {filter}，值可能是 string / {name,value} / 数组
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
  const out = { year: "", area: "" };
  const year = pickFilterValue(merged, "year");
  const area = pickFilterValue(merged, "area");
  if (year) {
    if (YEAR_VALUES.has(year)) out.year = year;
    else logI(`[filter] 忽略非法 year=${year}`);
  }
  if (area) {
    if (AREA_VALUES.has(area)) out.area = area;
    else logI(`[filter] 忽略非法 area=${area}`);
  }
  return out;
}

// ==================== 播放 ====================
function isDirectMedia(u) {
  const s = String(u || "");
  if (!/^https?:\/\//i.test(s)) return false;
  // 必须允许带 query：实测 m3u8 常带 ?sign=xxx，旧版 /\.(m3u8|mp4)$/ 会把它误判成需要解析
  return /\.(?:m3u8|mp4|flv|mkv)(?:\?|#|$)/i.test(s);
}
function isSharePage(u) { return /\/share\//i.test(String(u || "")); }

function buildHeaders(target) {
  let referer = `${SITE_API}/`;
  let origin = "";
  try {
    const u = new URL(target);
    origin = u.origin;
    referer = `${u.origin}/`;
  } catch (_) {}
  return {
    "User-Agent": USER_AGENT,
    "Referer": referer,
    "Origin": origin,
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
}

// 分享页形态：<script> const url = "/20260707/513_xxx/index.m3u8?sign=xxx"; </script>
// 403 页（区域限制）要判掉，避免把错误页当播放页。
function extractShareMedia(html, pageUrl) {
  const t = String(html || "");
  if (!t || /<title>\s*403/i.test(t) || /The region has been denied/i.test(t)) return "";
  const patterns = [
    /(?:const|let|var)\s+url\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /(?:const|let|var)\s+url\s*=\s*["']([^"']+)["']/i,
    /["']((?:https?:)?\/\/[^"'\s]+\.(?:m3u8|mp4)(?:\?[^"'\s]*)?)["']/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let abs = "";
    try { abs = new URL(m[1].replace(/\\\//g, "/"), pageUrl).href; } catch (_) {}
    if (abs && isDirectMedia(abs)) return abs;
  }
  return "";
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

// 旧链路：DANMU_API 兼容（仅在 SDK 弹幕能力缺失或全部未命中时使用）
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

// 播放记录异步写，绝不阻塞启播
function pushHistory(meta, context, playUrl) {
  try {
    if (!meta || typeof OmniBox.addPlayHistory !== "function") return;
    const payload = {
      vodId: str(meta.sid),
      title: str(meta.v) || "非凡资源",
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
    const classes = await loadClasses(false);
    let items = memGet("home:list", 5 * 60 * 1000);
    if (!items) {
      const cached = await cacheGet("home", "p1");
      if (cached && Array.isArray(cached.list) && cached.list.length) items = cached.list;
    }
    if (!items) {
      // 用 videolist 而不是 list：一次就带全 vod_pic/vod_year/vod_area/lang/score，
      // 不再需要旧版那套"拿 detail 批量补字段"（慢，且 ids 超 20 条会丢数据）
      const data = await requestJson({ ac: "videolist", pg: 1 }, "home");
      items = (data.list || []).map(toVodItem).filter(Boolean);
      if (items.length) {
        memSet("home:list", items);
        await cacheSet("home", "p1", { list: items }, CACHE_TTL);
      }
    }
    const filters = {};
    classes.forEach((c) => { filters[c.type_id] = buildFilters(c.type_id); });
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
  try {
    const query = categoryId === VIRTUAL_NEW
      ? { ac: "videolist", h: 24, pg: page, year: f.year, area: f.area }
      : { ac: "videolist", t: categoryId, pg: page, year: f.year, area: f.area };
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
    return { ...payload, filters: { [categoryId]: buildFilters(categoryId) } };
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
    logI(`[detail] 返回 vod_name=${out.vod_name} year=${out.vod_year} area=${out.vod_area} 线路=${playSources.length} 分集=${epTotal} 简介长度=${String(out.vod_content).length}`);
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
    // ac=list 搜索只回精简字段（无封面/无年份/无 play_url），ac=videolist 搜索直接带全字段
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
    const finalFlag = flag || str(meta && meta.l) || "非凡资源";
    const epName = str(meta && meta.e) || "播放";
    // 弹幕并行跑并加超时上限，绝不能让弹幕匹配拖慢启播
    const danmakuPromise = Promise.race([
      fetchDanmaku(meta).catch(() => []),
      sleep(DANMAKU_WAIT_MS).then(() => { logI("[play] 弹幕匹配超时，跳过"); return []; }),
    ]);

    // 1) 已是明确媒体直链（允许带 query）
    if (isDirectMedia(target)) {
      logI(`[play] 直链 parse=0 ${target.slice(0, 120)}`);
      pushHistory(meta, context, target);
      const danmaku = await danmakuPromise;
      return {
        urls: [{ name: epName, url: target }],
        flag: finalFlag,
        header: buildHeaders(target),
        parse: 0,
        ...(danmaku.length ? { danmaku } : {}),
      };
    }

    // 2) 分享页：解析页内 const url 得到真 m3u8
    if (isSharePage(target)) {
      const res = await requestText(target, target);
      const media = res.statusCode === 200 ? extractShareMedia(res.body, target) : "";
      logI(`[play] 分享页解析 status=${res.statusCode} media=${media ? media.slice(0, 120) : "空"}`);
      if (media) {
        pushHistory(meta, context, media);
        const danmaku = await danmakuPromise;
        return {
          urls: [{ name: epName, url: media }],
          flag: finalFlag,
          header: buildHeaders(media),
          parse: 0,
          ...(danmaku.length ? { danmaku } : {}),
        };
      }
      // 分享页 403（区域限制）/ 结构变化 -> 交给 SDK 嗅探
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
      logI(`[play] 分享页无法直解且嗅探未命中，回退 parse=1 ${target.slice(0, 120)}`);
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
    }

    // 3) 兜底：非直链非分享页 -> 嗅探，再不行 parse=1
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
