// @name XHamster
// @version 1.0.0
// @author omnibox-spider
// @description xhamster.com 采集源：initials JSON 列表 + 分类/搜索分页 + HLS master 多档（1080P 最高分辨率优先）
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/XHamster.js
// @dependencies cheerio

/**
 * 实站事实（2026-11 实测，改代码前先读）
 * 1) 站点 Svelte SSR，可直连。列表/首页/分类/搜索数据都在
 *    <script id='initials-script'>window.initials={...}</script> 这个 JSON 里。
 *    - 主页列表: layoutPage.videoListProps.videoThumbProps
 *    - 搜索列表: searchResult.videoThumbProps
 *    - 分类列表: pagesCategoryComponent.trendingVideoListProps.videoThumbProps
 *    用递归 findThumbArray() 找第一个「值为数组且元素含 pageURL/title」的 videoThumbProps。
 *    每项 {id,duration(秒),title,pageURL,thumbURL,imageURL,views}；封面 imageURL 优先、thumbURL 兜底。
 *    vod_id = pageURL 的 pathname（/videos/xxx）；duration 秒转 HH:MM:SS。
 * 2) 分页：主页 /{N}；分类 /categories/{slug}/{N}（?page= 无效）；
 *    搜索 /search/{encodeURIComponent(kw)}，分页 ?page={N}。
 *    总页数递归找 lastPageNumber / maxPages。
 * 3) 分类清单抓 https://xhamster.com/categories 的 href="/categories/xxx"（页面里是绝对 URL），
 *    失败时用内置常见分类兜底。
 * 4) 播放：详情页 <link rel="preload" href="..._TPL_.av1.mp4.m3u8"> 是明文 HLS master，
 *    multi= 段自带 144p/240p/480p/720p/1080p 五档；单档 playlist = master 里 _TPL_ 换成 1080p 等。
 *    签名带过期时间戳 => play() 每次从详情页现取（ttl=0，不缓存）。
 *    兜底：<noscript><video ... src="...480p.h264.mp4">。
 * 5) 【最高分辨率优先】sortVariantsByHeightDesc() 按 height 数值降序，1080p 恒为第一档；
 *    detail 的 vod_play_sources[0] 与 play 的 urls[0] 都是 1080P；master 自适应线路追加在末尾。
 * 6) 日志一律 OmniBox.log(level,msg) + Promise.catch 兜住；绝不写 stdout。
 *    缓存仅用于 home/category/search/detail/分类清单（短 TTL），play 不缓存。
 *
 * 【环境变量】XHAMSTER_HOST（可选，默认 https://xhamster.com）、XHAMSTER_CACHE_TTL（可选，默认 600）。
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  本地调试兜底的假 OmniBox / runner 只提供空函数。
 */

let cheerio = null;
try {
  cheerio = require("cheerio");
} catch (_) {
  cheerio = null;
}

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  // 本地调试兜底：空 log / 空缓存 / 空请求，绝不写 stdout
  OmniBox = {
    log() {},
    getCache() { return ""; },
    setCache() {},
    request() { return null; },
  };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://xhamster.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "https://xhamster.com";
  }
}

const HOST = normalizeHost(process.env.XHAMSTER_HOST || "https://xhamster.com");
const BASE_TTL = Math.max(0, Number(process.env.XHAMSTER_CACHE_TTL || 600) || 600);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.round(BASE_TTL * 0.8);
const SEARCH_TTL = Math.round(BASE_TTL * 0.8);
const DETAIL_TTL = Math.min(90, Math.round(BASE_TTL * 0.15));
const CLASSES_TTL = Math.max(BASE_TTL, 1800);
const CACHE_PREFIX = "xh:page:";

// 分类清单抓取失败时的内置兜底（slug 来自 /categories/ 页面实测）
const FALLBACK_CLASSES = [
  { type_id: "amateur", type_name: "Amateur" },
  { type_id: "anal", type_name: "Anal" },
  { type_id: "asian", type_name: "Asian" },
  { type_id: "bbw", type_name: "BBW" },
  { type_id: "big-tits", type_name: "Big Tits" },
  { type_id: "creampie", type_name: "Creampie" },
  { type_id: "granny", type_name: "Granny" },
  { type_id: "hentai", type_name: "Hentai" },
  { type_id: "homemade", type_name: "Homemade" },
  { type_id: "lesbian", type_name: "Lesbian" },
  { type_id: "mature", type_name: "Mature" },
  { type_id: "milf", type_name: "MILF" },
  { type_id: "mom", type_name: "Mom" },
  { type_id: "old-young", type_name: "Old & Young" },
  { type_id: "teen", type_name: "Teen" },
  { type_id: "threesome", type_name: "Threesome" },
  { type_id: "blowjob", type_name: "Blowjob" },
  { type_id: "cumshot", type_name: "Cumshot" },
  { type_id: "hardcore", type_name: "Hardcore" },
  { type_id: "interracial", type_name: "Interracial" },
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ---------------------------------------------------------------------------
// 日志 / 缓存 / HTTP
// ---------------------------------------------------------------------------

function log(level, message) {
  try {
    if (typeof OmniBox.log !== "function") return;
    const p = OmniBox.log(level, `[xh][${level}] ${message}`);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

function md5(text) {
  try {
    return require("crypto").createHash("md5").update(String(text)).digest("hex");
  } catch (_) {
    return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32);
  }
}

function buildCacheKey(url) {
  const key = `${CACHE_PREFIX}${md5(url)}`;
  return Buffer.byteLength(key, "utf8") <= 200 ? key : `${CACHE_PREFIX}${md5(key)}`;
}

async function getCachedText(key) {
  try {
    if (typeof OmniBox.getCache === "function") {
      const value = await OmniBox.getCache(key);
      if (value != null && String(value).length > 0) return String(value);
    }
  } catch (_) {}
  return "";
}

async function setCachedText(key, value, ttl) {
  try {
    if (ttl > 0 && typeof OmniBox.setCache === "function") {
      const p = OmniBox.setCache(key, value, ttl);
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (_) {}
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchHtml(url, ttl) {
  const key = buildCacheKey(url);
  if (ttl > 0) {
    const cached = await getCachedText(key);
    if (cached) return cached;
  }
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: `${HOST}/`,
    Origin: HOST,
  };
  const res = await OmniBox.request(url, {
    method: "GET",
    headers,
    timeout: 20000,
  });
  if (!res || Number(res.statusCode) !== 200) {
    throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  }
  const html = String(res.body || "");
  if (ttl > 0 && html) await setCachedText(key, html, ttl);
  return html;
}

// ---------------------------------------------------------------------------
// initials JSON 提取与递归查找
// ---------------------------------------------------------------------------

function extractInitials(html) {
  try {
    const m = String(html || "").match(
      /<script id=['"]initials-script['"]>\s*window\.initials\s*=\s*([\s\S]*?);?<\/script>/i
    );
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function isThumb(item) {
  return !!item && typeof item === "object" &&
    typeof item.pageURL === "string" && typeof item.title === "string";
}

function isThumbArray(value) {
  return Array.isArray(value) && value.some(isThumb);
}

// 第一轮：只认键名 videoThumbProps 的数组（主页/分类/搜索都挂在这个键下），
// 避免命中 crossListingThumbsProps.photos 或 additionalItems 里的小推荐数组。
function findNamedThumbArray(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNamedThumbArray(item);
      if (found) return found;
    }
    return null;
  }
  if (isThumbArray(node.videoThumbProps)) return node.videoThumbProps;
  for (const key of Object.keys(node)) {
    const found = findNamedThumbArray(node[key]);
    if (found) return found;
  }
  return null;
}

// 第二轮兜底：遍历任意值为数组且元素含 pageURL/title 的对象值。
function findAnyThumbArray(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    if (isThumbArray(node)) return node;
    for (const item of node) {
      const found = findAnyThumbArray(item);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    if (isThumbArray(node[key])) return node[key];
    const found = findAnyThumbArray(node[key]);
    if (found) return found;
  }
  return null;
}

// 递归遍历 JSON，找到第一个「值为数组且元素含 pageURL/title」的 videoThumbProps。
function findThumbArray(node) {
  return findNamedThumbArray(node) || findAnyThumbArray(node);
}

// 递归找总页数：lastPageNumber / maxPages
function findPageCount(node) {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      const v = findPageCount(item);
      if (v) return v;
    }
    return 0;
  }
  for (const key of ["lastPageNumber", "maxPages"]) {
    const n = Number(node[key]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  for (const key of Object.keys(node)) {
    const v = findPageCount(node[key]);
    if (v) return v;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 列表项映射 / DOM 兜底
// ---------------------------------------------------------------------------

function normalizeVideoPath(raw) {
  let s = String(raw || "").trim().replace(/^xh:/i, "");
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch (_) {
      s = s.replace(/^https?:\/\/[^/]+/i, "");
    }
  }
  if (!s) return "/";
  if (!s.startsWith("/")) s = `/${s}`;
  return s;
}

function formatDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  const total = Math.floor(n);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function formatViews(views) {
  if (views == null || views === "") return "";
  if (typeof views === "number" || /^\d+$/.test(String(views))) {
    const n = Number(views);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M 观看`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K 观看`;
    return `${n} 观看`;
  }
  return `${String(views).trim()} 观看`;
}

function toVod(item) {
  const path = normalizeVideoPath(item.pageURL);
  const title = String(item.title || "").trim() || `XHamster ${item.id || ""}`.trim();
  const pic = String(item.imageURL || item.thumbURL || "").trim();
  const duration = formatDuration(item.duration);
  const views = formatViews(item.views);
  return {
    vod_id: path,
    vod_name: title,
    vod_pic: pic,
    vod_remarks: [duration, views].filter(Boolean).join(" · "),
    vod_tag: "video",
    vod_play_from: "XHamster",
  };
}

// JSON 解析失败时的 DOM 兜底
function parseListDom(html) {
  const list = [];
  if (!cheerio) return list;
  try {
    const $ = cheerio.load(html);
    const seen = new Set();
    $('div[class*="thumb-list__item"]').each((_, node) => {
      const $item = $(node);
      const $a = $item.find('a[class*="video-thumb-info__name"][title]').first();
      const title = ($a.attr("title") || $a.text() || "").trim();
      const href = $a.attr("href") || "";
      if (!title || !href) return;
      const path = normalizeVideoPath(href);
      if (path === "/" || seen.has(path)) return;
      seen.add(path);
      const pic = ($item.find('img[class*="thumb-image-container__image"]').first().attr("src") || "").trim();
      const duration = ($item.find('div[class*="thumb-image-container__duration"]').first().text() || "").trim();
      list.push({
        vod_id: path,
        vod_name: title,
        vod_pic: pic,
        vod_remarks: duration,
        vod_tag: "video",
        vod_play_from: "XHamster",
      });
    });
  } catch (_) {}
  return list;
}

function parseListPage(html) {
  const json = extractInitials(html);
  if (json) {
    const arr = findThumbArray(json);
    if (arr && arr.length) {
      const list = [];
      const seen = new Set();
      for (const item of arr) {
        if (!isThumb(item)) continue;
        const vod = toVod(item);
        if (seen.has(vod.vod_id)) continue;
        seen.add(vod.vod_id);
        list.push(vod);
      }
      return { list, pagecount: findPageCount(json) || 1 };
    }
  }
  return { list: parseListDom(html), pagecount: 1 };
}

// ---------------------------------------------------------------------------
// 分类清单
// ---------------------------------------------------------------------------

function slugToName(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseClassesHtml(html) {
  const out = [];
  const seen = new Set();
  const push = (slug, name) => {
    const s = String(slug || "").trim().toLowerCase();
    if (!s || s === "categories" || seen.has(s)) return;
    seen.add(s);
    const n = String(name || "").replace(/\s+/g, " ").trim();
    out.push({ type_id: s, type_name: (n || slugToName(s)).slice(0, 40) });
  };

  if (cheerio) {
    try {
      const $ = cheerio.load(html);
      $('a[href*="/categories/"]').each((_, node) => {
        const href = $(node).attr("href") || "";
        const m = href.match(/\/categories\/([a-z0-9][a-z0-9-]*)\/?(?:\?|#|$)/i);
        if (!m) return;
        push(m[1], $(node).text());
      });
    } catch (_) {}
  }
  // cheerio 不可用或没抓到时的正则兜底
  if (out.length === 0) {
    const re = /href=["']([^"']*\/categories\/[a-z0-9][a-z0-9-]*)\/?["']/gi;
    let m;
    while ((m = re.exec(String(html || ""))) !== null) {
      const sm = m[1].match(/\/categories\/([a-z0-9][a-z0-9-]*)/i);
      if (sm) push(sm[1], "");
    }
  }
  // 页面里分类极多（实测 655 条），只取前 120 条热门，避免宿主分类栏爆炸
  return out.slice(0, 120);
}

async function fetchClasses() {
  try {
    const html = await fetchHtml(`${HOST}/categories`, CLASSES_TTL);
    const list = parseClassesHtml(html);
    if (list.length) {
      log("info", `[classes] 抓到分类=${list.length}`);
      return list;
    }
  } catch (e) {
    log("error", `[classes] 抓取失败: ${e?.message || e}`);
  }
  log("info", `[classes] 使用内置兜底分类=${FALLBACK_CLASSES.length}`);
  return FALLBACK_CLASSES.slice();
}

// ---------------------------------------------------------------------------
// 播放：HLS master / 档位解析 / 排序
// ---------------------------------------------------------------------------

function extractMasterUrl(html) {
  const raw = String(html || "");
  if (cheerio) {
    try {
      const $ = cheerio.load(raw);
      const href = $('link[rel="preload"][href*="_TPL_"]').first().attr("href");
      if (href) return decodeEntities(href);
    } catch (_) {}
  }
  const m = raw.match(/<link[^>]+rel=["']preload["'][^>]*href=["']([^"']*_TPL_[^"']*\.m3u8[^"']*)["']/i) ||
    raw.match(/href=["']([^"']*_TPL_[^"']*\.m3u8[^"']*)["']/i);
  return m ? decodeEntities(m[1]) : "";
}

function extractNoscriptMp4(html) {
  const raw = String(html || "");
  const m = raw.match(/<video[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) ||
    raw.match(/<noscript>[\s\S]{0,1200}?src=["']([^"']+\.mp4[^"']*)["']/i);
  return m ? decodeEntities(m[1]) : "";
}

function extractMeta(html) {
  const out = { title: "", pic: "", desc: "" };
  const raw = String(html || "");
  if (cheerio) {
    try {
      const $ = cheerio.load(raw);
      out.title = ($("meta[property='og:title']").attr("content") || "").trim();
      out.pic = ($("meta[property='og:image']").attr("content") || "").trim();
      out.desc = ($("meta[property='og:description']").attr("content") ||
        $("meta[name='description']").attr("content") || "").trim();
    } catch (_) {}
  }
  if (!out.title) {
    const t = raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ||
      raw.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
    if (t) out.title = decodeEntities(t[1]).trim();
  }
  if (!out.pic) {
    const p = raw.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i) ||
      raw.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:image["']/i);
    if (p) out.pic = decodeEntities(p[1]).trim();
  }
  if (!out.desc) {
    const d = raw.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=(?:'([^']*)'|"([^"]*)")/i);
    if (d) out.desc = decodeEntities(d[1] || d[2] || "").trim();
  }
  return out;
}

/**
 * 【档位排序：明确函数】按 height 数值降序（1080 > 720 > 480 > 240 > 144），
 * 同高度再按 width 降序。保证 1080p 恒为第一个。
 */
function sortVariantsByHeightDesc(variants) {
  const arr = Array.isArray(variants) ? variants.slice() : [];
  return arr.sort((a, b) => {
    const ha = Number(a && a.height) || 0;
    const hb = Number(b && b.height) || 0;
    if (hb !== ha) return hb - ha;
    return (Number(b && b.width) || 0) - (Number(a && a.width) || 0);
  });
}

/** 从 master URL 的 multi= 段解析各档，并生成单档 playlist（_TPL_ 替换为档位名），按高度降序返回。 */
function parseVariants(masterUrl) {
  const raw = [];
  const m = String(masterUrl || "").match(/multi=([^/]+)/i);
  if (m) {
    for (const seg of m[1].split(",")) {
      const p = seg.match(/(\d+)x(\d+):(\d+)p/i);
      if (!p) continue;
      raw.push({
        width: Number(p[1]),
        height: Number(p[2]),
        label: `${p[3]}p`,
      });
    }
  }
  // multi= 段缺失或损坏时按站点固定五档兜底
  if (raw.length === 0) {
    for (const q of [1080, 720, 480, 240, 144]) {
      raw.push({ width: 0, height: q, label: `${q}p` });
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const v of raw) {
    if (seen.has(v.label)) continue;
    seen.add(v.label);
    uniq.push(v);
  }
  return sortVariantsByHeightDesc(uniq).map((v) => ({
    ...v,
    url: String(masterUrl).replace("_TPL_", v.label),
  }));
}

function qualityName(label) {
  return String(label || "").replace(/p$/i, "P").toUpperCase();
}

// ---------------------------------------------------------------------------
// home / category / search
// ---------------------------------------------------------------------------

function emptyPage(page) {
  return { page: Number(page) || 1, pagecount: 1, total: 0, limit: 0, list: [] };
}

function pageResult(list, page, pagecount) {
  return {
    page: Number(page) || 1,
    pagecount: Number(pagecount) || 1,
    total: list.length,
    limit: list.length,
    list,
  };
}

async function home(params, context) {
  try {
    log("info", `[home] from=${context?.from || "web"}, host=${HOST}`);
    const [homeRes, classRes] = await Promise.allSettled([
      fetchHtml(`${HOST}/`, HOME_TTL),
      fetchClasses(),
    ]);
    const html = homeRes.status === "fulfilled" ? homeRes.value : "";
    const classes = classRes.status === "fulfilled" && classRes.value.length
      ? classRes.value
      : FALLBACK_CLASSES.slice();
    const parsed = html ? parseListPage(html) : { list: [], pagecount: 1 };
    log("info", `[home] 分类=${classes.length}, 推荐=${parsed.list.length}`);
    return { class: classes, filters: {}, list: parsed.list };
  } catch (e) {
    log("error", `[home] 失败: ${e?.message || e}`);
    return { class: FALLBACK_CLASSES.slice(), filters: {}, list: [] };
  }
}

function buildCategoryUrl(slug, page) {
  const s = String(slug || "").trim().replace(/^\/+|\/+$/g, "");
  const p = Number(page) || 1;
  if (!s) return p > 1 ? `${HOST}/${p}` : `${HOST}/`;
  const seg = encodeURIComponent(s);
  return p > 1 ? `${HOST}/categories/${seg}/${p}` : `${HOST}/categories/${seg}`;
}

async function category(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const slug = String(params?.categoryId || params?.type_id || params?.t || "").trim();
    const url = buildCategoryUrl(slug, page);
    log("info", `[category] slug=${slug || "(首页)"}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[category] 请求 URL=${url}`);
    const html = await fetchHtml(url, CATEGORY_TTL);
    const parsed = parseListPage(html);
    log("info", `[category] list=${parsed.list.length}, pagecount=${parsed.pagecount}`);
    return pageResult(parsed.list, page, parsed.pagecount);
  } catch (e) {
    log("error", `[category] 失败: ${e?.message || e}`);
    return emptyPage(page);
  }
}

async function search(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const keyword = String(params?.keyword || params?.wd || params?.q || "").trim();
    if (!keyword) {
      log("info", "[search] 关键词为空，返回空结果");
      return emptyPage(page);
    }
    let url = `${HOST}/search/${encodeURIComponent(keyword)}`;
    if (page > 1) url += `?page=${page}`;
    log("info", `[search] keyword=${keyword}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[search] 请求 URL=${url}`);
    const html = await fetchHtml(url, SEARCH_TTL);
    const parsed = parseListPage(html);
    log("info", `[search] list=${parsed.list.length}, pagecount=${parsed.pagecount}`);
    return pageResult(parsed.list, page, parsed.pagecount);
  } catch (e) {
    log("error", `[search] 失败: ${e?.message || e}`);
    return emptyPage(page);
  }
}

// ---------------------------------------------------------------------------
// detail / play
// ---------------------------------------------------------------------------

async function detail(params, context) {
  try {
    const raw = params?.videoId || params?.vod_id || params?.id || "";
    const path = normalizeVideoPath(raw);
    if (path === "/") {
      log("info", "[detail] videoId 为空，返回空结构");
      return { list: [] };
    }
    const detailUrl = `${HOST}${path}`;
    log("info", `[detail] videoId=${path}, from=${context?.from || "web"}`);
    log("info", `[detail] 请求 URL=${detailUrl}`);

    const html = await fetchHtml(detailUrl, DETAIL_TTL);
    const meta = extractMeta(html);
    const master = extractMasterUrl(html);
    const mp4 = master ? "" : extractNoscriptMp4(html);

    const variants = master ? parseVariants(master) : [];
    const sources = variants.map((v) => ({
      name: qualityName(v.label),
      episodes: [{
        name: qualityName(v.label),
        playId: `xh:${path}|||${v.label}`,
      }],
    }));
    if (master) {
      // master 自适应放最后；vod_play_sources[0] 恒为 1080P 单档（最高分辨率）
      sources.push({
        name: "1080P自适应(最高)",
        episodes: [{
          name: "1080P自适应(最高)",
          playId: `xh:${path}|||master`,
        }],
      });
    } else if (mp4) {
      sources.push({
        name: "480P",
        episodes: [{ name: "480P", playId: `xh:${path}|||mp4` }],
      });
    }

    const top = variants.length ? qualityName(variants[0].label) : (mp4 ? "480P" : "");
    log("info", `[detail] title=${meta.title || "(无)"}, master=${master ? "有" : "无"}, 档位=${variants.map((v) => v.label).join(">")}, 线路=${sources.length}`);
    return {
      list: [{
        vod_id: path,
        vod_name: meta.title || `XHamster ${path.split("/").pop()}`,
        vod_pic: meta.pic,
        vod_content: meta.desc,
        vod_remarks: top ? `${top} 最高分辨率优先` : "解析中",
        vod_tag: "video",
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log("error", `[detail] 失败: ${e?.message || e}`);
    return { list: [] };
  }
}

function parsePlayId(raw) {
  const s = String(raw || "").trim();
  let left = s;
  let hint = "";
  if (s.includes("|||")) {
    const idx = s.indexOf("|||");
    left = s.slice(0, idx);
    hint = s.slice(idx + 3).trim();
  }
  return { path: normalizeVideoPath(left), hint };
}

async function play(params, context) {
  const flag = String(params?.flag || "xhamster");
  const header = {
    "User-Agent": UA,
    Referer: `${HOST}/`,
    Origin: HOST,
    Accept: "*/*",
  };
  try {
    const raw = params?.playId || params?.play_id || params?.ids || "";
    const { path, hint } = parsePlayId(raw);
    log("info", `[play] playId=${String(raw).slice(0, 200)}, hint=${hint || "(无)"}, flag=${flag}, from=${context?.from || "web"}`);
    if (!path || path === "/") throw new Error("playId 无法解析出详情路径");

    // 签名带过期时间戳：play() 每次从详情页现取，ttl=0 不缓存
    const detailUrl = `${HOST}${path}`;
    const html = await fetchHtml(detailUrl, 0);
    const master = extractMasterUrl(html);

    if (!master) {
      const mp4 = extractNoscriptMp4(html);
      if (!mp4) throw new Error("详情页未解析到 HLS master 或 noscript mp4");
      log("info", `[play] master 缺失，回退 noscript mp4: ${mp4.slice(0, 140)}`);
      return { urls: [{ name: "480P", url: mp4 }], flag, header, parse: 0 };
    }

    // parseVariants 已按 height 数值降序：urls[0] 恒为 1080P 单档 playlist
    const variants = parseVariants(master);
    const urls = variants.map((v) => ({
      name: `${qualityName(v.label)} 单档`,
      url: v.url,
    }));
    urls.push({ name: "1080P自适应(最高)", url: master });
    // 用户点「1080P自适应(最高)」线路时把 master 提到首位；它同样是最高档，
    // 不破坏 urls[0] 最高分辨率优先。其余档位一律 1080P 单档优先。
    if (hint === "master") urls.unshift(urls.pop());
    log("info", `[play] 档位顺序=${urls.map((u) => u.name).join(" > ")}, urls[0]=${urls[0].name}, parse=0`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}
