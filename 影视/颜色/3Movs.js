// @name 3Movs
// @version 1.0.0
// @author omnibox-spider
// @description 3Movs（KVS/PHP）采集源：首页/分类/最新/搜索五方法；分类翻页严格 ?from=N，搜索翻页走 mode=async；详情内联 flashvars 解析 video_url(720P High Quality)/video_alt_url(360P Low Quality)，按 height 数值降序，最高档恒为 vod_play_sources[0] 与 urls[0]
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/3Movs.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-15 实测，改代码前先读这段）
 * 1) https://www.3movs.com/（nginx 1.14 + PHP 8.2，KVS 系，可直连），常规 UA + Referer 即可。
 * 2) 列表卡片：div.item.thumb > div.th > a.wrap_image[href][title]，真实封面在 img[data-src]；
 *    img[src] 是 1x1 占位 base64（data:image/gif;base64,R0lGODlhAQAB...）必须跳过；
 *    div.time 是时长，a.title 是标题，i.icon-eye 后的 span 是观看数。
 *    详情 URL 形如 /videos/{数字id}/{slug}/，vod_id 统一用这个 pathname。
 * 3) 分类 URL /categories/{slug}/；【重要】/categories/x/2/ 实测 404，
 *    翻页只能用 ?from=N（如 /categories/amateur/?from=2），脚本绝不生成数字路径。
 *    最新 /latest-updates/{N}/ 与全部 /videos/{N}/ 是路径分页，可用。
 * 4) 搜索只有 /search_videos/?q={keyword} 可用（/?s=、/search?k= 全 404）。
 *    翻页是 AJAX：/search_videos/?q=X&mode=async&function=get_block&
 *    block_id=list_videos_videos_list_search_result&from_videos=N（N 即页码）。
 *    搜索结果必须限定在 #list_videos_videos_list_search_result_items 内，
 *    否则会混入 #list_videos_recommended_videos_items 推荐区；翻页拿不到就 page=1 降级。
 * 5) 总页数 = 分页块 title="Page N" 的最大值（实测 /videos 5069、latest 3647、
 *    amateur 71、搜索 amateur 1662）。title="Next 10 pages" 不会被误算。
 * 6) 【播放】详情页内联 var flashvars = {...}; 只有两档 mp4：
 *      video_url      = High Quality (720p，文件名 {id}.mp4)        -> 最高，排第一
 *      video_alt_url  = Low Quality  (360p，文件名 {id}_lq.mp4)
 *    flashvars 里还有 preview_height1='720' / preview_height2='360' 可校验高度。
 *    URL 形如 https://www.3movs.com/get_file/8/<hash>/<bucket>/<id>/<id>.mp4/?v-acctoken=...
 *    直接 parse=0 返回即可（302 由播放器跟随），脚本不自行跟随、不二次请求。
 * 7) 【最高分辨率优先】sortQualitiesByHeightDesc() 按 height 数值降序；
 *    detail() 的 vod_play_sources[0] 与 play() 的 urls[0] 恒为 720P High Quality。
 * 8) 日志只走 OmniBox.log（Promise.catch 兜住），本地缺 SDK 时用 log(){} 假对象，
 *    绝不写 stdout（宿主靠 stdout 读 handler 返回的 JSON）；禁止 console.log。
 *    短 TTL 缓存走 OmniBox.getCache/setCache，任何缓存异常都安全降级。
 *    cheerio 缺失时用正则兜底解析卡片，不崩；flashvars/元数据一律正则，不依赖 cheerio。
 *
 * 【环境变量】（优先复用仓库既有命名）
 *  SITE_HOST        可选，站点基址，默认 https://www.3movs.com
 *  3MOVS_CACHE_TTL  可选，页面缓存基准秒数，默认 300；0 关闭缓存
 */

const crypto = require("crypto");

let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) { cheerio = null; }

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  // 本地调试兜底：log(){} 假对象，绝不写 stdout
  OmniBox = { log() {} };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://www.3movs.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "https://www.3movs.com";
  }
}

const HOST = normalizeHost(process.env.SITE_HOST || "https://www.3movs.com");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_LIMIT = 24;
const BASE_TTL = Math.max(0, Number(process.env["3MOVS_CACHE_TTL"] || 300) || 0);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = BASE_TTL ? Math.max(60, Math.round(BASE_TTL * 0.6)) : 0;
const SEARCH_TTL = BASE_TTL ? Math.max(30, Math.round(BASE_TTL * 0.4)) : 0;
// 播放 token 会变，详情页缓存刻意压短；detail() 与 play() 共用同一份 HTML 缓存
const DETAIL_TTL = BASE_TTL ? Math.max(30, Math.min(120, Math.round(BASE_TTL * 0.4))) : 0;
const CACHE_PREFIX = "3movs:";

const SEARCH_CONTAINER = "#list_videos_videos_list_search_result_items";
const CLASS_CONTAINER = "#list_videos_common_videos_list_items";
const RECOMMEND_CONTAINER = "#list_videos_recommended_videos_items";

// 固定前置的两个「榜单」分类，其余从 /categories/ 页动态补齐
const BUILTIN_CLASS = [
  { type_id: "latest-updates", type_name: "最新更新" },
  { type_id: "videos", type_name: "全部视频" },
];
// 动态分类抓取失败时的兜底（实测存在的 slug）
const FALLBACK_CATEGORIES = [
  "amateur", "anal", "asian", "big-ass", "big-cock", "big-tits", "blowjob",
  "cumshot", "hardcore", "lesbian", "milf", "mom", "pov", "teen", "threesome",
  "bathroom", "bdsm", "casting", "compilation", "cosplay", "deepthroat",
  "ebony", "gangbang", "handjob", "interracial", "latin", "mature", "outdoor",
  "public", "squirting", "toys", "vintage",
];

/**
 * 画质档位定义。height 用于「按高度数值降序」排序，rank 用于同高度时稳定兜底。
 * video_url = High Quality 720P；video_alt_url = Low Quality 360P。
 */
const QUALITY_DEFS = [
  { key: "hq", field: "video_url", textField: "video_url_text", fallbackName: "High Quality", height: 720, rank: 0 },
  { key: "lq", field: "video_alt_url", textField: "video_alt_url_text", fallbackName: "Low Quality", height: 360, rank: 1 },
];

/** 【核心】按 height 数值降序；同高度按 rank、再按原始顺序稳定排列。 */
function sortQualitiesByHeightDesc(list) {
  return (Array.isArray(list) ? list.slice() : [])
    .map((q, i) => Object.assign({}, q, { _i: i }))
    .sort((a, b) => {
      const dh = (Number(b.height) || 0) - (Number(a.height) || 0);
      if (dh !== 0) return dh;
      const dr = (Number(a.rank) || 0) - (Number(b.rank) || 0);
      if (dr !== 0) return dr;
      return a._i - b._i;
    })
    .map((q) => { const o = Object.assign({}, q); delete o._i; return o; });
}

const PREFIX = "[3movs]";
function log(level, message) {
  const line = `${PREFIX}[${level}] ${message}`;
  try {
    if (OmniBox && typeof OmniBox.log === "function") {
      const p = OmniBox.log(level, line);
      if (p && typeof p.catch === "function") p.catch(() => {});
      return;
    }
  } catch (_) {}
  // 仅当宿主连 log 都没有时退到 stderr；绝不写 stdout
  try { process.stderr.write(`${line}\n`); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function md5(text) {
  try { return crypto.createHash("md5").update(String(text)).digest("hex"); }
  catch (_) { return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32).padStart(32, "0"); }
}

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(href) {
  const s = String(href || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return `https:${s}`;
  return `${HOST}${s.startsWith("/") ? s : `/${s}`}`;
}

function safeImg(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  if (/^data:/i.test(s)) return "";                 // 1x1 占位 base64
  if (/R0lGODlhAQAB/i.test(s)) return "";
  if (/1x1|blank\.gif|placeholder/i.test(s)) return "";
  return absUrl(s);
}

/** 从任意 href / 裸 id 归一化出 /videos/{id}/{slug}/ 这个 pathname。 */
function toVodId(href) {
  const s = String(href || "").trim().split("#")[0];
  if (!s) return "";
  let pathname = s;
  try {
    if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
      pathname = /^https?:\/\//i.test(s) ? new URL(s).pathname : s.split("?")[0];
    }
  } catch (_) { return ""; }
  const m = pathname.match(/^\/videos\/\d+(?:\/[^/]*)?\/?/i);
  return m ? m[0] : "";
}

function normalizeVodId(raw) {
  const s = String(raw || "").trim().split("#")[0];
  if (!s) return "";
  const fromPath = toVodId(s);
  if (fromPath) return fromPath;
  if (/^\d+$/.test(s)) return `/videos/${s}/`;      // 纯数字 id 容错
  return "";
}

function buildDetailUrl(vodId) {
  return absUrl(vodId);
}

/** 分类/榜单 URL：分类严格 ?from=N，绝不生成 /categories/x/N/。 */
function buildCategoryUrl(categoryId, page) {
  const p = Math.max(1, Number(page) || 1);
  let slug = String(categoryId || "latest-updates").trim();
  if (/^https?:\/\//i.test(slug)) {
    try { slug = new URL(slug).pathname; } catch (_) {}
  }
  slug = slug.replace(/^cat:/i, "").replace(/^\/?categories\//i, "").replace(/^\/+|\/+$/g, "");
  const low = slug.toLowerCase();
  if (low === "latest-updates" || low === "latest" || low === "new") {
    return p <= 1 ? `${HOST}/latest-updates/` : `${HOST}/latest-updates/${p}/`;
  }
  if (low === "videos" || low === "all" || low === "latest-videos") {
    return p <= 1 ? `${HOST}/videos/` : `${HOST}/videos/${p}/`;
  }
  if (!slug) slug = "amateur";
  const base = `${HOST}/categories/${slug}/`;
  return p <= 1 ? base : `${base}?from=${p}`;
}

function buildSearchUrl(keyword, page) {
  const p = Math.max(1, Number(page) || 1);
  const q = encodeURIComponent(String(keyword || ""));
  if (p <= 1) return `${HOST}/search_videos/?q=${q}`;
  // 搜索分页是 AJAX，from_videos=N 中 N 为页码（分页块 data-parameters 实测）
  return `${HOST}/search_videos/?q=${q}&mode=async&function=get_block&block_id=list_videos_videos_list_search_result&from_videos=${p}`;
}

/** 总页数 = title="Page N" 最大值；"Next 10 pages" / "Next page" 不匹配。 */
function parsePageCount(html) {
  let max = 0;
  const re = /title=["']Page\s*(\d+)["']/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const n = Number(m[1]) || 0;
    if (n > max) max = n;
  }
  return Math.max(1, max);
}

function isNotFoundPage(html) {
  const head = String(html || "").slice(0, 30000);
  return /<title>\s*404 Error|Page is not found|404 Not Found/i.test(head);
}

function emptyPage(page, limit) {
  return { page: Math.max(1, Number(page) || 1), pagecount: 1, total: 0, limit: Math.max(1, Number(limit) || DEFAULT_LIMIT), list: [] };
}

function pageResult(list, page, pagecount, total, limit) {
  return {
    page: Math.max(1, Number(page) || 1),
    pagecount: Math.max(1, Number(pagecount) || 1),
    total: Math.max(0, Number(total) || 0),
    limit: Math.max(1, Number(limit) || DEFAULT_LIMIT),
    list: Array.isArray(list) ? list : [],
  };
}

// ---------------------------------------------------------------------------
// 缓存（失败安全降级）
// ---------------------------------------------------------------------------

function cacheKey(kind, raw) {
  const key = `${CACHE_PREFIX}${kind}:${md5(String(raw || ""))}`;
  return Buffer.byteLength(key, "utf8") <= 200 ? key : `${CACHE_PREFIX}${kind}:${md5(key)}`;
}

async function getCachedText(key) {
  try {
    if (OmniBox && typeof OmniBox.getCache === "function") {
      const v = await OmniBox.getCache(key);
      if (v != null && String(v).length > 0) return String(v);
    }
  } catch (_) {}
  return "";
}

async function setCachedText(key, value, ttl) {
  try {
    if (ttl > 0 && OmniBox && typeof OmniBox.setCache === "function") {
      await OmniBox.setCache(key, String(value), ttl);
    }
  } catch (_) {}
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
    try { req.end(); } catch (e) { reject(e); }
  });
}

async function requestText(url, options) {
  const opt = options || {};
  const opts = {
    method: "GET",
    headers: Object.assign({
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: `${HOST}/`,
    }, opt.headers || {}),
    timeout: opt.timeout || 20000,
  };
  let res;
  if (OmniBox && typeof OmniBox.request === "function") {
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

async function fetchHtml(url, ttl) {
  const key = cacheKey("page", url);
  if (ttl > 0) {
    const cached = await getCachedText(key);
    if (cached) {
      log("info", `[cache] 命中 ${String(url).slice(0, 120)} len=${cached.length}`);
      return cached;
    }
  }
  log("info", `[http] GET ${url}`);
  const html = await requestText(url);
  if (isNotFoundPage(html)) throw new Error(`目标返回 404 页 @ ${String(url).slice(0, 140)}`);
  if (ttl > 0) await setCachedText(key, html, ttl);
  return html;
}

// ---------------------------------------------------------------------------
// 列表卡片解析（cheerio 主路径 + 正则兜底）
// ---------------------------------------------------------------------------

function pickImage($, $img, $a) {
  const cands = [
    $img.attr("data-src"), $img.attr("data-webp"), $img.attr("data-original"),
    $a.attr("data-src"), $a.attr("data-original"), $a.attr("data-poster"),
    $img.attr("src"),
  ];
  for (const c of cands) {
    const u = safeImg(c);
    if (u) return u;
  }
  return "";
}

function dedupeCards(list) {
  const seen = Object.create(null);
  const out = [];
  for (const item of list) {
    if (!item || !item.vod_id || seen[item.vod_id]) continue;
    seen[item.vod_id] = 1;
    out.push(item);
  }
  return out;
}

function toCard(vodId, title, pic, duration, views) {
  return {
    vod_id: vodId,
    vod_name: title || vodId,
    vod_pic: pic || "",
    vod_remarks: [duration, views ? `${views}次观看` : "", "720P 优先"].filter(Boolean).join(" · "),
    vod_tag: "video",
  };
}

function parseCardsRegex(html) {
  const out = [];
  const re = /<a\s+class="[^"]*wrap_image[^"]*"[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const vodId = toVodId(m[1]);
    if (!vodId) continue;
    const body = m[3] || "";
    const picM = body.match(/data-src=["']([^"']+)["']/i) || body.match(/data-webp=["']([^"']+)["']/i);
    const pic = safeImg(picM && picM[1]);
    const timeM = body.match(/class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\//i);
    const duration = cleanText(timeM && timeM[1]);
    const eyeM = body.match(/icon-eye[\s\S]{0,120}?<span[^>]*>([\s\S]*?)<\/span>/i);
    const views = cleanText(eyeM && eyeM[1]);
    out.push(toCard(vodId, cleanText(m[2]), pic, duration, views));
  }
  return dedupeCards(out);
}

function cssId(selector) {
  const m = String(selector || "").match(/#([\w-]+)/);
  return m ? m[1] : "";
}

/** 正则兜底用：定位 <div ... id="ID"> 片段的大致 [start,end)。 */
function findIdSpan(html, id) {
  const s = String(html || "");
  const needle = `id="${id}"`;
  const pos = s.indexOf(needle);
  if (pos < 0) return null;
  const start = Math.max(0, s.lastIndexOf("<", pos));
  const tail = s.slice(pos + needle.length);
  // 结束边界：下一个并列的 .thumbs / .pagination 容器
  const m = tail.match(/<div\s+class="[^"]*(?:thumbs|pagination)[^"]*"\s+id=/i);
  const end = m ? pos + needle.length + m.index : s.length;
  return { start, end };
}

/** cheerio 缺失时，用字符串切片实现同样的容器限定 / 推荐区排除。 */
function preprocessForRegex(html, o) {
  let s = String(html || "");
  const cid = cssId(o.container);
  if (cid) {
    const span = findIdSpan(s, cid);
    if (!span) return o.strict ? "" : s;   // strict：容器缺失即视为无结果，绝不回退全页
    s = s.slice(span.start, span.end);
  }
  const eid = cssId(o.exclude);
  if (eid) {
    for (let guard = 0; guard < 20; guard += 1) {
      const span = findIdSpan(s, eid);
      if (!span) break;
      s = s.slice(0, span.start) + s.slice(span.end);
    }
  }
  return s;
}

/**
 * @param {string} html
 * @param {object} opts { container: 主结果容器 css, exclude: 需排除的容器 css,
 *                        strict: 容器缺失时返回空而非回退全页（搜索/分类必开） }
 */
function parseCards(html, opts) {
  const o = opts || {};
  if (!html) return [];
  if (!cheerio) {
    log("info", "[parse] cheerio 不可用，走正则兜底");
    return parseCardsRegex(preprocessForRegex(html, o));
  }
  try {
    const $ = cheerio.load(html);
    let $cards = null;
    let containerFound = false;
    if (o.container) {
      const $box = $(o.container).first();
      if ($box.length) {
        containerFound = true;
        // 容器自身可能就是 .item.thumb 的父节点，也可能自身带该 class
        $cards = $box.find(".item.thumb");
        if (!$cards.length && $box.hasClass("item") && $box.hasClass("thumb")) $cards = $box;
      }
    }
    if (o.strict && o.container) {
      // 搜索页/404 页整页只有推荐区时，绝不能把推荐卡片当成结果
      if (!containerFound) {
        log("info", `[parse] 容器 ${o.container} 缺失，strict 模式返回空`);
        return [];
      }
    } else if (!$cards || !$cards.length) {
      $cards = $(".item.thumb");
      if (o.exclude) {
        try { $cards = $cards.not($(o.exclude).find(".item.thumb")); } catch (_) {}
      }
    }
    const out = [];
    $cards.each((_, el) => {
      try {
        const $c = $(el);
        const $a = $c.find("a.wrap_image").first();
        if (!$a.length) return;
        const vodId = toVodId($a.attr("href"));
        if (!vodId) return;
        const $title = $c.find("a.title").first();
        const $img = $a.find("img").first();
        const title = cleanText($a.attr("title") || $title.attr("title") || $title.text() || $img.attr("alt") || "");
        const pic = pickImage($, $img, $a);
        const duration = cleanText($c.find("div.time").first().text());
        let views = cleanText($c.find("i.icon-eye").first().next("span").text());
        if (!views) {
          views = cleanText($c.find(".list_item").filter((__, x) => $(x).find("i.icon-eye").length > 0).first().find("span").text());
        }
        out.push(toCard(vodId, title, pic, duration, views));
      } catch (_) {}
    });
    return dedupeCards(out);
  } catch (e) {
    log("error", `[parse] cheerio 解析失败，走正则兜底: ${e && e.message}`);
    return parseCardsRegex(preprocessForRegex(html, o));
  }
}

/** 从首页 / /categories/ 页解析分类导航，文本尾部带数量（如 "Amateur 2,546"）。 */
function parseCategories(html) {
  const out = [];
  const seen = Object.create(null);
  const re = /<a[^>]*href="(?:https?:\/\/[^"']*?)?(\/categories\/[a-z0-9-]+\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const sm = m[1].match(/\/categories\/([^/]+)\//);
    if (!sm) continue;
    const slug = sm[1];
    if (seen[slug]) continue;
    seen[slug] = 1;
    let name = cleanText(m[2]).replace(/\s+[\d,]+\s*$/, "").trim();
    if (!name) name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({ type_id: `cat:${slug}`, type_name: name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 详情页 flashvars / 元数据（纯正则，不依赖 cheerio）
// ---------------------------------------------------------------------------

function extractFlashvars(html) {
  const m = String(html || "").match(/var\s+flashvars\s*=\s*\{([\s\S]*?)\}\s*;/i);
  return m ? m[1] : "";
}

/** 精确取 flashvars 的某个 key；不会误命中 video_url_hd / video_url_text。 */
function pickFlashvar(block, key) {
  if (!block || !key) return "";
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|[,{\\s])" + esc + "\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'", "m");
  const m = String(block).match(re);
  if (!m) return "";
  return m[1]
    .replace(/\\\//g, "/")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function normalizeMediaUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  return absUrl(s);
}

/** 解析两档 mp4，并按 height 降序（720P High Quality 恒第一）。 */
function parseQualities(html) {
  const block = extractFlashvars(html);
  if (!block) {
    log("error", "[flashvars] 未找到 var flashvars 块");
    return [];
  }
  const out = [];
  for (let i = 0; i < QUALITY_DEFS.length; i += 1) {
    const def = QUALITY_DEFS[i];
    const raw = pickFlashvar(block, def.field);
    if (!raw) continue;
    const url = normalizeMediaUrl(raw);
    if (!/^https?:\/\//i.test(url)) continue;
    const text = cleanText(pickFlashvar(block, def.textField)) || def.fallbackName;
    const parsedHeight = Number(pickFlashvar(block, `preview_height${i + 1}`)) || 0;
    const height = parsedHeight > 0 ? parsedHeight : def.height;
    out.push({ key: def.key, name: `${text} (${height}P)`, height, url, rank: def.rank });
  }
  const sorted = sortQualitiesByHeightDesc(out);
  log("info", `[flashvars] 档位(高度降序)=${sorted.map((q) => `${q.name}`).join(" > ") || "(空)"}`);
  return sorted;
}

function metaContent(html, key) {
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regs = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${esc}["']`, "i"),
  ];
  for (const re of regs) {
    const m = String(html || "").match(re);
    if (m && m[1]) return cleanText(m[1]);
  }
  return "";
}

function parseDetailMeta(html, vodId) {
  const block = extractFlashvars(html);
  let name = cleanText(pickFlashvar(block, "video_title")) || metaContent(html, "og:title");
  if (!name) {
    const h1 = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    name = cleanText(h1 && h1[1]);
  }
  if (!name) name = `3Movs ${vodId}`;

  const pic = safeImg(metaContent(html, "og:image") || pickFlashvar(block, "preview_url"));
  const desc = metaContent(html, "description") || metaContent(html, "og:description") || cleanText(pickFlashvar(block, "video_title"));
  const categories = cleanText(pickFlashvar(block, "video_categories"));
  const tags = cleanText(pickFlashvar(block, "video_tags"));
  const content = [
    desc,
    categories ? `分类：${categories}` : "",
    tags ? `标签：${tags}` : "",
    "画质档位：High Quality (720P) / Low Quality (360P)（最高分辨率优先）",
  ].filter(Boolean).join("\n");

  let duration = "";
  const dm = String(html || "").match(/icon-clock[\s\S]{0,160}?<span[^>]*>([\s\S]*?)<\/span>/i);
  if (dm) duration = cleanText(dm[1]);
  let views = "";
  const vm = String(html || "").match(/icon-eye[\s\S]{0,160}?<span[^>]*>([\s\S]*?)<\/span>/i);
  if (vm) views = cleanText(vm[1]);

  return {
    name,
    pic,
    content,
    remarks: [duration, views ? `${views}次观看` : "", "720P 优先"].filter(Boolean).join(" · "),
  };
}

// ---------------------------------------------------------------------------
// 五个 handler，签名统一 (params, context)
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    log("info", `[home] host=${HOST}, from=${(context && context.from) || "web"}`);
    const homeUrl = `${HOST}/`;
    const catsUrl = `${HOST}/categories/`;
    const [homeHtml, catsHtml] = await Promise.all([
      fetchHtml(homeUrl, HOME_TTL).catch((e) => { log("error", `[home] 首页失败: ${e && e.message}`); return ""; }),
      fetchHtml(catsUrl, HOME_TTL).catch((e) => { log("error", `[home] 分类页失败: ${e && e.message}`); return ""; }),
    ]);

    let dynamic = parseCategories(catsHtml);
    if (!dynamic.length) dynamic = parseCategories(homeHtml);
    if (!dynamic.length) {
      dynamic = FALLBACK_CATEGORIES.map((slug) => ({
        type_id: `cat:${slug}`,
        type_name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      }));
    }
    const seen = Object.create(null);
    const klass = [];
    for (const c of BUILTIN_CLASS.concat(dynamic)) {
      if (seen[c.type_id]) continue;
      seen[c.type_id] = 1;
      klass.push(c);
    }
    const filters = {};
    for (const c of klass) filters[c.type_id] = [];

    const list = parseCards(homeHtml, { exclude: RECOMMEND_CONTAINER }).slice(0, 36);
    log("info", `[home] 返回 分类=${klass.length}, 推荐=${list.length}, 首图=${(list[0] && list[0].vod_pic || "").slice(0, 90)}`);
    return { class: klass, filters, list };
  } catch (e) {
    log("error", `[home] 失败: ${(e && e.message) || e}`);
    return { class: BUILTIN_CLASS, filters: {}, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const limit = Math.max(1, Math.min(60, Number(p.limit) || DEFAULT_LIMIT));
  try {
    const categoryId = String(p.categoryId || p.type_id || p.tid || p.id || "latest-updates");
    const url = buildCategoryUrl(categoryId, page);
    log("info", `[category] categoryId=${categoryId}, page=${page}, limit=${limit}, from=${(context && context.from) || "web"}`);
    const html = await fetchHtml(url, CATEGORY_TTL);
    const container = /\/categories\//i.test(url) ? CLASS_CONTAINER : "";
    const list = parseCards(html, { container, exclude: RECOMMEND_CONTAINER, strict: !!container });
    const pagecount = parsePageCount(html);
    const total = pagecount * limit;
    log("info", `[category] 返回 list=${list.length}, pagecount=${pagecount}, total=${total}`);
    return pageResult(list, page, pagecount, total, limit);
  } catch (e) {
    log("error", `[category] 失败: ${(e && e.message) || e}`);
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
    log("info", `[search] keyword=${keyword}, page=${page}, limit=${limit}, from=${(context && context.from) || "web"}`);

    let url = buildSearchUrl(keyword, page);
    let html = "";
    try {
      html = await fetchHtml(url, SEARCH_TTL);
    } catch (e) {
      log("error", `[search] 第 ${page} 页请求失败: ${(e && e.message) || e}`);
      html = "";
    }
    let list = parseCards(html, { container: SEARCH_CONTAINER, exclude: RECOMMEND_CONTAINER, strict: true });
    let actualPage = page;
    let pagecount = parsePageCount(html);

    // 翻页拿不到就 page=1 降级，不崩
    if (page > 1 && (!list.length || !html)) {
      log("info", "[search] AJAX 翻页无结果，降级到 page=1");
      url = buildSearchUrl(keyword, 1);
      try {
        html = await fetchHtml(url, SEARCH_TTL);
      } catch (e) {
        log("error", `[search] 降级页请求失败: ${(e && e.message) || e}`);
        html = "";
      }
      list = parseCards(html, { container: SEARCH_CONTAINER, exclude: RECOMMEND_CONTAINER, strict: true });
      actualPage = 1;
      pagecount = parsePageCount(html);
    }
    const total = pagecount * limit;
    log("info", `[search] 返回 page=${actualPage}, list=${list.length}, pagecount=${pagecount}, total=${total}`);
    return pageResult(list, actualPage, pagecount, total, limit);
  } catch (e) {
    log("error", `[search] 失败: ${(e && e.message) || e}`);
    return emptyPage(1, limit);
  }
}

async function detail(params, context) {
  const p = params || {};
  try {
    const raw = String(p.videoId || p.vod_id || p.ids || "").trim();
    const vodId = normalizeVodId(raw);
    if (!vodId) { log("info", `[detail] videoId 无法解析: ${raw.slice(0, 120)}`); return { list: [] }; }
    log("info", `[detail] vod_id=${vodId}, from=${(context && context.from) || "web"}`);

    const detailUrl = buildDetailUrl(vodId);
    let html = "";
    try {
      html = await fetchHtml(detailUrl, DETAIL_TTL);
    } catch (e) {
      log("error", `[detail] 详情页请求失败: ${(e && e.message) || e}`);
      return { list: [] };
    }

    // 【最高分辨率优先】按 height 降序生成线路，720P High Quality 恒为 vod_play_sources[0]
    const qualities = parseQualities(html);
    if (!qualities.length) {
      log("error", "[detail] flashvars 未解析到可用档位");
      return { list: [] };
    }
    const sources = qualities.map((q) => ({
      name: q.name,
      episodes: [{ name: "正片", playId: `${vodId}#${q.key}` }],
    }));
    const meta = parseDetailMeta(html, vodId);
    const vod = {
      vod_id: vodId,
      vod_name: meta.name,
      vod_pic: meta.pic,
      vod_content: meta.content,
      vod_remarks: meta.remarks,
      vod_tag: "video",
      vod_play_sources: sources,
      // 兼容宿主旧展示链路
      vod_play_from: sources.map((s) => s.name).join("$$$"),
      vod_play_url: sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join("#")).join("$$$"),
    };
    log("info", `[detail] 返回 1 条, 线路=${sources.map((s) => s.name).join(" > ")}, 首档=${sources[0].name}`);
    return { list: [vod] };
  } catch (e) {
    log("error", `[detail] 失败: ${(e && e.message) || e}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = params || {};
  const flag = String(p.flag || "3movs");
  const header = { "User-Agent": UA, Referer: `${HOST}/` };
  try {
    const raw = String(p.playId || p.play_id || p.ids || p.vod_id || "").trim();
    log("info", `[play] playId=${raw.slice(0, 160)}, flag=${flag}, from=${(context && context.from) || "web"}`);
    if (!raw) throw new Error("playId 为空");

    // 已经是 get_file 的 mp4 直链：直接返回，不跟随 302
    if (/^https?:\/\//i.test(raw) && /\/get_file\/|\.mp4(\?|$)/i.test(raw)) {
      log("info", "[play] playId 已是 mp4 直链，parse=0");
      return { urls: [{ name: "直链", url: raw }], flag, header, parse: 0 };
    }

    const hashIdx = raw.indexOf("#");
    const selectedKey = hashIdx >= 0 ? raw.slice(hashIdx + 1) : "";
    const vodId = normalizeVodId(hashIdx >= 0 ? raw.slice(0, hashIdx) : raw);
    if (!vodId) throw new Error(`playId 无法解析出详情 pathname: ${raw.slice(0, 120)}`);
    log("info", `[play] vod_id=${vodId}, 用户所选档位=${selectedKey || "(未指定)"}, 按最高分辨率优先返回`);

    const html = await fetchHtml(buildDetailUrl(vodId), DETAIL_TTL);
    // 【最高分辨率优先】urls[0] 恒为 height 最高那一档（720P High Quality）
    const qualities = parseQualities(html);
    const urls = qualities.map((q) => ({ name: q.name, url: q.url })).filter((u) => u.url);
    if (!urls.length) throw new Error("没有可用播放档位");
    log("info", `[play] urls(高度降序)=${urls.map((u) => `${u.name}->${u.url.slice(-52)}`).join(" | ")}`);
    log("info", `[play] 优先返回最高档 urls[0]=${urls[0].name}`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log("error", `[play] 失败: ${(e && e.message) || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
