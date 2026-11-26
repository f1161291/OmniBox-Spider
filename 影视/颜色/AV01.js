// @name AV01
// @version 1.0.2
// @author omnibox-spider
// @description av01.media（React SPA，HTML 仅 4948B 空壳）直连 /api/v1 JSON：最新/热门/标签榜单 + POST body query 搜索 + 单片详情；播放解析 HLS master 的 RESOLUTION，按高度数值降序，1080p 恒为 vod_play_sources[0] / urls[0]，免 token 直出 m3u8；【1.0.1】按要求删除 720 以下线路，仅保留 1080P/720P
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/AV01.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-15 实测，改代码前先读这段）
 * 1) https://www.av01.media/cn 是 React SPA，HTML 只有 4948B 空壳，无 SSR 数据，
 *    绝不解析 HTML，全部走 /api/v1 JSON。HOST 用 www.av01.media，封面域 static2.av01.tv。
 * 2) 列表接口（GET，返回 {videos:[...], pagination:{page,limit,total,totalPages}}）：
 *      /api/v1/videos/types/latest?page=N&limit=M    最新
 *      /api/v1/videos/types/hottest?page=N&limit=M   热门
 *      /api/v1/videos/tag/{id}?page=N&limit=M       标签（响应多一个 tag 字段）
 *    video 字段：id / dvd_id / title / title_translations.cn / seo_titles.cn /
 *      description(_translations.cn) / duration(秒) / views / actresses[] / tags[] /
 *      maker(_translations.cn) / cover(boolean，不是 URL！) / storage_base / hls_layout。
 *    标题优先级：seo_titles.cn -> title_translations.cn -> title（用户约定）。
 *    vod_id = "/video/{id}/{dvd_id小写}"；封面用
 *      https://static2.av01.tv/media/videos/tmb/{id}/1.jpg/format=jpeg/wlv=640
 *      （若 cover 以后变成完整 URL 则优先用它）。
 * 3) 搜索：POST /api/v1/videos/search?lang=cn，Content-Type: application/json，
 *      body {"query":"关键词","pagination":{"page":N,"limit":M}}。
 *    必须用 body.query；实测只传 q 会被忽略、静默返回最新列表（total=10000），
 *    脚本对这种「query 未生效」的形态做一次原生重发兜底。
 * 4) 详情：GET /api/v1/videos/{id} 返回单个 video 对象（比列表多 description 等字段），
 *    实测 200；失败安全降级为空元数据，不影响线路生成。
 * 5) 播放：GET /api/v1/videos/{id}/manifest/master.m3u8 返回 HLS master：
 *      #EXT-X-STREAM-INF:...RESOLUTION=640x360...  -> index90-sv1-v1-a1.m3u8?ro=0
 *      #EXT-X-STREAM-INF:...RESOLUTION=1280x720... -> index90-sv2-v1-a1.m3u8
 *      #EXT-X-STREAM-INF:...RESOLUTION=1920x1080...-> index90-sv3-v1-a1.m3u8
 *    单档完整 URL = https://www.av01.media/api/v1/videos/{id}/manifest/{variant 文件名}。
 *    免 token 即 200，不要附加 access_token。部分片只有一档 gen-variant.m3u8?ro=0
 *    （COVER_ONLY），master 可能没有 RESOLUTION，脚本回退成单档「默认」线路。
 * 6) 【最高分辨率优先】sortVariantsByHeightDesc() 按 RESOLUTION 的高度数值降序，
 *    同高度按 BANDWIDTH 降序、再按 master 原始顺序稳定排列；1080P 恒为第一个。
 *    detail() 的 vod_play_sources[0] 与 play() 的 urls[0] 都是最高档。
 * 7) 日志只走 OmniBox.log（Promise.catch 兜住），本地缺 SDK 时写 stderr；
 *    脚本绝不写 stdout（宿主靠 stdout 读 handler 返回的 JSON）。
 *    短 TTL 缓存走 OmniBox.getCache/setCache，任何缓存异常都安全降级。
 *
 * 【环境变量】（优先复用仓库既有命名）
 *  AV01_HOST        可选，站点基址，默认 https://www.av01.media
 *  AV01_CACHE_TTL   可选，列表/详情缓存基准秒数，默认 300；0 关闭缓存
 */

const crypto = require("crypto");

let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) { cheerio = null; }

let OmniBox;
let HAS_SDK = false;
try {
  OmniBox = require("omnibox_sdk");
  HAS_SDK = !!(OmniBox && typeof OmniBox.request === "function");
} catch (_) {
  // 本地调试兜底：假对象，log(){} / run(){}，绝不写 stdout
  OmniBox = { log() {} };
}
let runner;
try { runner = require("spider_runner"); } catch (_) { runner = { run() {} }; }

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://www.av01.media";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return "https://www.av01.media"; }
}

const HOST = normalizeHost(process.env.AV01_HOST || "https://www.av01.media");
const STATIC_HOST = "https://static2.av01.tv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_LIMIT = 24;
const BASE_TTL = Math.max(0, Number(process.env.AV01_CACHE_TTL || 300) || 0);
const LIST_TTL = BASE_TTL ? Math.max(60, Math.round(BASE_TTL * 0.4)) : 0;   // 120s
const SEARCH_TTL = BASE_TTL ? Math.max(30, Math.round(BASE_TTL * 0.2)) : 0; // 60s
const DETAIL_TTL = BASE_TTL;                                                // 300s
const MASTER_TTL = BASE_TTL ? Math.max(30, Math.round(BASE_TTL * 0.2)) : 0; // 60s
const CACHE_PREFIX = "av01:";

// 内置榜单：latest / hottest / 实测存在的标签 id（中文名来自 tags[].name_translations.cn）
const CLASS_LIST = [
  { type_id: "latest", type_name: "最新" },
  { type_id: "hottest", type_name: "热门" },
  { type_id: "tag:1", type_name: "中出内射" },
  { type_id: "tag:2", type_name: "巨乳" },
  { type_id: "tag:3", type_name: "人妻主妇" },
  { type_id: "tag:4", type_name: "3P／4P" },
  { type_id: "tag:6", type_name: "NTR戴绿帽" },
  { type_id: "tag:26", type_name: "痴女" },
  { type_id: "tag:94", type_name: "美少女" },
  { type_id: "tag:166", type_name: "口交吹箫" },
  { type_id: "tag:353", type_name: "颜射" },
  { type_id: "tag:424", type_name: "素人" },
  { type_id: "tag:559", type_name: "制服" },
  { type_id: "tag:599", type_name: "熟女" },
  { type_id: "tag:663", type_name: "角色扮演" },
  { type_id: "tag:777", type_name: "捆绑绳缚" },
  { type_id: "tag:3583805", type_name: "无码" },
  { type_id: "tag:527309", type_name: "4K" },
  { type_id: "tag:3583832", type_name: "Full HD" },
  { type_id: "tag:314727", type_name: "4小时以上" },
  { type_id: "tag:1453138", type_name: "个人拍摄" },
  { type_id: "tag:3585301", type_name: "LTX超清解码" },
];
const TAG_ID_RE = /^\d+$/;

const PREFIX = "[av01]";
function log(level, message) {
  const line = `${PREFIX}[${level}] ${message}`;
  try {
    if (HAS_SDK && typeof OmniBox.log === "function") {
      const p = OmniBox.log(level, line);
      if (p && typeof p.catch === "function") p.catch(() => {});
      return;
    }
  } catch (_) {}
  // 本地调试：只写 stderr，绝不写 stdout
  try { process.stderr.write(`${line}\n`); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 缓存 / 文本工具
// ---------------------------------------------------------------------------

function md5(text) {
  try { return crypto.createHash("md5").update(String(text)).digest("hex"); }
  catch (_) { return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32).padStart(32, "0"); }
}
function cacheKey(kind, raw) {
  const key = `${CACHE_PREFIX}${kind}:${md5(String(raw || ""))}`;
  return Buffer.byteLength(key, "utf8") <= 200 ? key : `${CACHE_PREFIX}${kind}:${md5(key)}`;
}
async function getCachedText(key) {
  try {
    if (typeof OmniBox.getCache === "function") {
      const v = await OmniBox.getCache(key);
      if (v != null && String(v).length > 0) return String(v);
    }
  } catch (_) {}
  return "";
}
async function setCachedText(key, value, ttl) {
  try { if (ttl > 0 && typeof OmniBox.setCache === "function") await OmniBox.setCache(key, String(value), ttl); }
  catch (_) {}
}
async function getCachedJson(key) {
  const raw = await getCachedText(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function setCachedJson(key, value, ttl) {
  try { await setCachedText(key, JSON.stringify(value), ttl); } catch (_) {}
}

/** cheerio 可用时用它解码实体/去标签，否则正则兜底；API 返回纯文本时零开销。 */
function cleanText(s) {
  const raw = String(s == null ? "" : s);
  if (!raw) return "";
  if (cheerio && /[<&]/.test(raw)) {
    try {
      const $ = cheerio.load(`<div id="__av01_t">${raw}</div>`);
      return String($("#__av01_t").text() || "").replace(/\s+/g, " ").trim();
    } catch (_) {}
  }
  return raw.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// HTTP：优先宿主 OmniBox.request，本地调试时用 node 原生 https 兜底
// ---------------------------------------------------------------------------

function nodeRequest(url, options) {
  return new Promise((resolve, reject) => {
    let https;
    let http;
    try { https = require("https"); http = require("http"); }
    catch (e) { reject(e); return; }
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const mod = u.protocol === "https:" ? https : http;
    const headers = Object.assign({}, options.headers || {});
    if (options.body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = String(Buffer.byteLength(String(options.body)));
    }
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: options.method || "GET",
      headers,
      timeout: options.timeout || 20000,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: Number(res.statusCode) || 0,
        headers: res.headers || {},
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    try { if (options.body) req.write(String(options.body)); req.end(); }
    catch (e) { reject(e); }
  });
}

async function requestText(url, options = {}) {
  const headers = Object.assign({
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "application/json, text/plain, */*",
    Referer: `${HOST}/`,
  }, options.headers || {});
  const opts = {
    method: options.method || "GET",
    headers,
    timeout: options.timeout || 20000,
    body: options.body,
  };
  let res;
  // forceNative：宿主 SDK 改写 POST body 时的自救重发通道
  if (!options.forceNative && typeof OmniBox.request === "function") {
    res = await OmniBox.request(url, opts);
  } else {
    res = await nodeRequest(url, opts);
  }
  const code = Number(res && res.statusCode) || 0;
  if (!res || code < 200 || code >= 300) {
    throw new Error(`HTTP ${code || "unknown"} @ ${String(url).slice(0, 160)}`);
  }
  return String(res.body == null ? "" : res.body);
}

async function requestJson(url, options = {}) {
  const text = await requestText(url, options);
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error(`返回非 JSON: ${text.slice(0, 100)}`); }
  if (!data || typeof data !== "object") throw new Error("JSON 结构异常");
  return data;
}

// ---------------------------------------------------------------------------
// 列表 / 详情数据映射
// ---------------------------------------------------------------------------

function pickTitle(v) {
  return cleanText(v && v.seo_titles && v.seo_titles.cn)
    || cleanText(v && v.title_translations && v.title_translations.cn)
    || cleanText(v && v.title)
    || String((v && v.dvd_id) || "").toUpperCase();
}

function pickCover(v) {
  const c = v && v.cover;
  if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim();
  if (c && typeof c === "object") {
    const u = c.url || c.src || c.path || "";
    if (typeof u === "string" && /^https?:\/\//i.test(u.trim())) return u.trim();
  }
  const id = v && v.id;
  return id ? `${STATIC_HOST}/media/videos/tmb/${id}/1.jpg/format=jpeg/wlv=640` : "";
}

function buildVodId(v) {
  const id = v && v.id;
  if (!id) return "";
  const slug = String((v && v.dvd_id) || "video").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "video";
  return `/video/${id}/${slug}`;
}

function formatDuration(seconds) {
  const n = Number(seconds) || 0;
  if (n <= 0) return "";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function toListItem(v) {
  const vodId = buildVodId(v);
  if (!vodId) return null;
  const code = String(v.dvd_id || "").toUpperCase();
  const duration = formatDuration(v.duration);
  return {
    vod_id: vodId,
    vod_name: pickTitle(v),
    vod_pic: pickCover(v),
    vod_remarks: [code, duration, v.views != null ? `${v.views}次` : ""].filter(Boolean).join(" · "),
    vod_tag: "video",
  };
}

function pageResult(list, page, pagecount, total, limit) {
  return {
    page: Number(page) || 1,
    pagecount: Math.max(1, Number(pagecount) || 1),
    total: Number(total) || list.length,
    limit: Number(limit) || list.length,
    list,
  };
}
function emptyPage(page, limit) {
  return { page: Number(page) || 1, pagecount: 1, total: 0, limit: Number(limit) || 0, list: [] };
}

function buildListUrl(categoryId, page, limit) {
  const cid = String(categoryId || "latest").trim();
  let path;
  if (/^hottest$/i.test(cid)) path = "types/hottest";
  else if (/^latest$/i.test(cid)) path = "types/latest";
  else {
    const m = cid.match(/^tag\s*:\s*(\d+)$/i) || (TAG_ID_RE.test(cid) ? [null, cid] : null);
    if (!m) { log("info", `[category] 未知 categoryId=${cid}，回退 latest`); path = "types/latest"; }
    else path = `tag/${m[1]}`;
  }
  return `${HOST}/api/v1/videos/${path}?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`;
}

/** 统一取 videos + pagination；postBody 非空时走 POST JSON。 */
async function fetchVideoList(url, ttl, postBody) {
  const key = cacheKey("list", `${url}|${postBody || ""}`);
  if (ttl > 0) {
    const cached = await getCachedJson(key);
    if (cached && Array.isArray(cached.videos)) {
      log("info", `[cache] 命中列表缓存: ${url.slice(0, 130)}`);
      return cached;
    }
  }
  const options = postBody
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: postBody }
    : {};
  let data = await requestJson(url, options);
  let out = { videos: Array.isArray(data.videos) ? data.videos : [], pagination: data.pagination || {} };

  // 搜索专用：body.query 若被宿主 SDK 改写/丢弃，服务端会静默返回最新列表
  // （实测 total=10000，而真实搜索 total 远小于此）。用原生请求重发一次自救。
  if (postBody && HAS_SDK && Number(out.pagination.total) >= 10000 && out.videos.length) {
    log("info", "[search] 疑似 query 未生效(total=10000)，用原生请求重发 POST body");
    try {
      data = await requestJson(url, Object.assign({}, options, { forceNative: true }));
      const retry = { videos: Array.isArray(data.videos) ? data.videos : [], pagination: data.pagination || {} };
      if (retry.videos.length) out = retry;
    } catch (e) { log("info", `[search] 原生重发失败，沿用原结果: ${e && e.message}`); }
  }

  if (ttl > 0) await setCachedJson(key, out, ttl);
  return out;
}

function parseVodId(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { id: "", slug: "", vodId: "" };
  if (s.includes("@")) s = s.split("@")[0];
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch (_) { return { id: "", slug: "", vodId: "" }; }
  }
  const m = s.match(/\/video\/(\d+)\/([^/?#]+)/i);
  if (m) return { id: m[1], slug: m[2], vodId: `/video/${m[1]}/${m[2]}` };
  const m2 = s.match(/\/api\/v1\/videos\/(\d+)/i);
  if (m2) return { id: m2[1], slug: "", vodId: `/video/${m2[1]}/video` };
  const digits = s.replace(/^\/+|\/+$/g, "");
  if (/^\d+$/.test(digits)) return { id: digits, slug: "", vodId: `/video/${digits}/video` };
  return { id: "", slug: "", vodId: "" };
}

// ---------------------------------------------------------------------------
// 【核心】HLS master 解析 + 最高分辨率优先排序
// ---------------------------------------------------------------------------

function buildVariantUrl(id, uri) {
  const u = String(uri || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  const base = `${HOST}/api/v1/videos/${id}/manifest/`;
  try { return new URL(u.replace(/^\.\/+/, "").replace(/^\/+/, ""), base).toString(); }
  catch (_) { return `${base}${u.replace(/^\/+/, "")}`; }
}

/** 解析 master 里每一条 #EXT-X-STREAM-INF + 紧随的 variant URI。 */
function parseMasterVariants(text, id) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF\s*:/i.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith("#")) j++;
    if (j >= lines.length) continue;
    const uri = lines[j];
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const rm = lines[i].match(/RESOLUTION\s*=\s*(\d+)\s*[xX]\s*(\d+)/i);
    const bm = lines[i].match(/BANDWIDTH\s*=\s*(\d+)/i);
    const width = rm ? parseInt(rm[1], 10) : 0;
    const height = rm ? parseInt(rm[2], 10) : 0;
    out.push({
      name: height > 0 ? `${height}P` : "默认",
      width,
      height,
      bandwidth: bm ? parseInt(bm[1], 10) : 0,
      uri,
      url: buildVariantUrl(id, uri),
    });
  }
  return out;
}

/**
 * 【最低分辨率门槛】按需求去掉 720 以下线路：显式 RESOLUTION 高度 < 720 的档位一律丢弃。
 * height=0 表示 master 没给 RESOLUTION 的单档（COVER_ONLY 的 gen-variant，实为 720p），
 * 这种保留，避免该片完全无线路。
 */
const MIN_HEIGHT = 720;

function filterMinHeight(variants) {
  return (Array.isArray(variants) ? variants : []).filter((v) => {
    const h = Number(v && v.height) || 0;
    return h === 0 || h >= MIN_HEIGHT;
  });
}

/**
 * 档位排序：按 RESOLUTION 的高度【数值降序】——1080 > 720 > 360 > 0(单档默认)。
 * 同高度按 BANDWIDTH 降序，再按 master 原始顺序稳定排列。
 * 这是「最高分辨率优先」的唯一排序入口，detail() 与 play() 共用。
 */
function sortVariantsByHeightDesc(variants) {
  return (Array.isArray(variants) ? variants : [])
    .map((v, index) => Object.assign({}, v, { _index: index }))
    .sort((a, b) => {
      const dh = (Number(b.height) || 0) - (Number(a.height) || 0);
      if (dh !== 0) return dh;
      const db = (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0);
      if (db !== 0) return db;
      return a._index - b._index;
    })
    .map((v) => { const o = Object.assign({}, v); delete o._index; return o; });
}

/** 重名档位补序号，避免线路名重复。 */
function uniqueVariantNames(variants) {
  const seen = Object.create(null);
  return variants.map((v) => {
    const base = v.name || "默认";
    const n = (seen[base] || 0) + 1;
    seen[base] = n;
    return Object.assign({}, v, { name: n > 1 ? `${base}-${n}` : base });
  });
}

/** 取 master → 解析 → 降序；失败/无档位时回退 COVER_ONLY 单档 gen-variant。 */
async function resolveVariants(id) {
  const masterUrl = `${HOST}/api/v1/videos/${id}/manifest/master.m3u8`;
  const key = cacheKey("master", id);
  let text = MASTER_TTL > 0 ? await getCachedText(key) : "";
  if (text) {
    log("info", `[master] 命中缓存 id=${id}, len=${text.length}`);
  } else {
    log("info", `[master] 请求 ${masterUrl}`);
    try {
      text = await requestText(masterUrl, {
        headers: { Accept: "application/x-mpegurl,application/vnd.apple.mpegurl,*/*" },
      });
    } catch (e) {
      log("error", `[master] 请求失败 id=${id}: ${e && e.message}`);
      text = "";
    }
    if (text && MASTER_TTL > 0) await setCachedText(key, text, MASTER_TTL);
  }

  // 【去掉 720 以下线路】先按高度过滤，再降序
  let variants = uniqueVariantNames(sortVariantsByHeightDesc(filterMinHeight(parseMasterVariants(text, id))));
  if (!variants.length) {
    const gm = String(text || "").match(/gen-variant\.m3u8(?:\?[^\s"'<>]*)?/i);
    const uri = gm ? gm[0] : "gen-variant.m3u8?ro=0";
    log("info", `[master] 未解析到 STREAM-INF，回退单档 ${uri} (id=${id})`);
    variants = [{
      name: "默认", width: 0, height: 0, bandwidth: 0, uri,
      url: buildVariantUrl(id, uri),
    }];
  }
  log("info", `[master] id=${id} 档位(高度降序)=${variants.map((v) => `${v.name}(h=${v.height})`).join(" > ")}`);
  return variants;
}

// ---------------------------------------------------------------------------
// 五个 handler
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    log("info", `[home] from=${context && context.from || "web"}, host=${HOST}`);
    const filters = {};
    for (const c of CLASS_LIST) filters[c.type_id] = [];
    const url = buildListUrl("latest", 1, DEFAULT_LIMIT);
    log("info", `[home] 请求 ${url}`);
    const data = await fetchVideoList(url, LIST_TTL, "");
    const list = data.videos.map(toListItem).filter(Boolean);
    log("info", `[home] 返回分类=${CLASS_LIST.length}, 推荐=${list.length}`);
    return { class: CLASS_LIST, filters, list };
  } catch (e) {
    log("error", `[home] 失败: ${e && e.message || e}`);
    return { class: CLASS_LIST, filters: {}, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const limit = Math.max(1, Math.min(60, Number(p.limit) || DEFAULT_LIMIT));
  try {
    const categoryId = String(p.categoryId || p.type_id || p.tid || "latest");
    const url = buildListUrl(categoryId, page, limit);
    log("info", `[category] categoryId=${categoryId}, page=${page}, limit=${limit}, from=${context && context.from || "web"}`);
    log("info", `[category] 请求 ${url}`);
    const data = await fetchVideoList(url, LIST_TTL, "");
    const list = data.videos.map(toListItem).filter(Boolean);
    const pag = data.pagination || {};
    const pagecount = Number(pag.totalPages) || Math.max(1, Math.ceil((Number(pag.total) || list.length) / limit));
    log("info", `[category] 返回 list=${list.length}, pagecount=${pagecount}, total=${pag.total || 0}`);
    return pageResult(list, page, pagecount, pag.total, Number(pag.limit) || limit);
  } catch (e) {
    log("error", `[category] 失败: ${e && e.message || e}`);
    return emptyPage(page, limit);
  }
}

async function search(params, context) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const limit = Math.max(1, Math.min(60, Number(p.limit) || DEFAULT_LIMIT));
  try {
    const keyword = String(p.keyword || p.wd || p.q || "").trim();
    if (!keyword) { log("info", "[search] 关键词为空"); return emptyPage(page, limit); }
    const url = `${HOST}/api/v1/videos/search?lang=cn`;
    // 必须用 body.query；q 无效（实测会静默返回最新列表）
    const postBody = JSON.stringify({ query: keyword, pagination: { page, limit } });
    log("info", `[search] keyword=${keyword}, page=${page}, limit=${limit}, from=${context && context.from || "web"}`);
    log("info", `[search] POST ${url} body=${postBody}`);
    const data = await fetchVideoList(url, SEARCH_TTL, postBody);
    const list = data.videos.map(toListItem).filter(Boolean);
    const pag = data.pagination || {};
    const pagecount = Number(pag.totalPages) || Math.max(1, Math.ceil((Number(pag.total) || list.length) / limit));
    log("info", `[search] 返回 list=${list.length}, pagecount=${pagecount}, total=${pag.total || 0}`);
    return pageResult(list, page, pagecount, pag.total, Number(pag.limit) || limit);
  } catch (e) {
    log("error", `[search] 失败: ${e && e.message || e}`);
    return emptyPage(page, limit);
  }
}

async function detail(params, context) {
  const p = params || {};
  try {
    const raw = String(p.videoId || p.vod_id || p.ids || "").trim();
    const { id, vodId } = parseVodId(raw);
    if (!id) { log("info", `[detail] videoId 无法解析: ${raw.slice(0, 120)}`); return { list: [] }; }
    log("info", `[detail] videoId=${vodId}, id=${id}, from=${context && context.from || "web"}`);

    // 元数据：详情 API 失败时安全降级为空对象，绝不阻塞线路生成
    let v = null;
    const detailUrl = `${HOST}/api/v1/videos/${id}`;
    const dk = cacheKey("detail", id);
    if (DETAIL_TTL > 0) {
      const cached = await getCachedJson(dk);
      if (cached && cached.id) { v = cached; log("info", `[detail] 命中详情缓存 id=${id}`); }
    }
    if (!v) {
      log("info", `[detail] 请求 ${detailUrl}`);
      try {
        v = await requestJson(detailUrl);
        if (DETAIL_TTL > 0) await setCachedJson(dk, v, DETAIL_TTL);
      } catch (e) {
        log("error", `[detail] 详情接口失败 id=${id}: ${e && e.message}`);
        v = {};
      }
    }

    const variants = await resolveVariants(id);
    // 【最高分辨率优先】按高度降序生成线路，1080P 恒为 vod_play_sources[0]
    const sources = variants.map((variant) => ({
      name: variant.name,
      episodes: [{ name: "正片", playId: `${vodId}@${variant.name}` }],
    }));

    const dvdId = String(v.dvd_id || "").toUpperCase() || (vodId.split("/").pop() || "").toUpperCase();
    const duration = formatDuration(v.duration);
    const actresses = Array.isArray(v.actresses)
      ? v.actresses.map((a) => (a && a.name_translations && a.name_translations.cn) || (a && a.name) || "").filter(Boolean).join("、")
      : "";
    const maker = (v.maker_translations && v.maker_translations.cn) || v.maker || "";
    const tags = Array.isArray(v.tags)
      ? v.tags.map((t) => (t && t.name_translations && t.name_translations.cn) || (t && t.name) || "").filter(Boolean).slice(0, 12).join("、")
      : "";
    const desc = cleanText((v.description_translations && v.description_translations.cn) || v.description || "");
    const content = [
      dvdId,
      desc,
      actresses ? `演员：${actresses}` : "",
      maker ? `厂商：${maker}` : "",
      tags ? `标签：${tags}` : "",
      `画质档位：${variants.map((x) => x.name).join(" / ")}（最高分辨率优先）`,
    ].filter(Boolean).join("\n");

    const vod = {
      vod_id: vodId,
      vod_name: pickTitle(v) || dvdId || `AV01 ${id}`,
      vod_pic: pickCover(Object.assign({ id }, v)),
      vod_content: content,
      vod_remarks: [dvdId, duration, variants[0] ? `${variants[0].name} 优先` : ""].filter(Boolean).join(" · "),
      vod_tag: "video",
      vod_actor: actresses,
      vod_duration: duration,
      vod_play_sources: sources,
      // 兼容宿主旧展示链路
      vod_play_from: sources.map((s) => s.name).join("$$$"),
      vod_play_url: sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join("#")).join("$$$"),
    };
    log("info", `[detail] 返回 1 条, 线路=${sources.map((s) => s.name).join(" > ")}, 首档=${sources[0] && sources[0].name}`);
    return { list: [vod] };
  } catch (e) {
    log("error", `[detail] 失败: ${e && e.message || e}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = params || {};
  const flag = String(p.flag || "av01");
  const header = { "User-Agent": UA, Referer: `${HOST}/` };
  try {
    const raw = String(p.playId || p.play_id || p.ids || p.vod_id || "").trim();
    log("info", `[play] playId=${raw.slice(0, 160)}, flag=${flag}, from=${context && context.from || "web"}`);
    if (!raw) throw new Error("playId 为空");

    // 已经是完整 m3u8 直链：直接返回
    if (/^https?:\/\//i.test(raw) && /\.m3u8(\?|$)/i.test(raw)) {
      log("info", "[play] playId 已是 m3u8 直链，parse=0");
      return { urls: [{ name: "直链", url: raw }], flag, header, parse: 0 };
    }

    const selected = raw.includes("@") ? raw.split("@").slice(1).join("@") : "";
    const { id } = parseVodId(raw);
    if (!id) throw new Error(`playId 无法解析出视频 id: ${raw.slice(0, 120)}`);
    log("info", `[play] id=${id}, 用户所选档位=${selected || "(未指定)"}`);

    const variants = await resolveVariants(id);
    // 【最高分辨率优先】urls[0] 恒为高度最高那一档（1080P）
    const urls = variants.map((v) => ({ name: v.name, url: v.url })).filter((x) => x.url);
    if (!urls.length) throw new Error("没有可用播放档位");
    log("info", `[play] urls(高度降序)=${urls.map((u) => `${u.name}->${u.url.slice(-46)}`).join(" | ")}`);
    log("info", `[play] 优先返回最高档 urls[0]=${urls[0].name}`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log("error", `[play] 失败: ${e && e.message || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
