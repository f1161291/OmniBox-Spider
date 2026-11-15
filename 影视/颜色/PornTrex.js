// @name PornTrex
// @version 1.0.1
// @author omnibox-spider
// @description porntrex.com 采集源：首页/分类/最新/搜索分页；详情页内联 flashvars 解析 480p/720p/1080p/2160p(4K) 多档 mp4 直链，按真实分辨率数值严格降序，最高档恒为 vod_play_sources[0] 与 play().urls[0]；【1.0.1】按要求删除 720 以下线路，仅保留 2160P/1080P/720P
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/PornTrex.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-15 实测，改代码前先读这段）
 * 1) 主域 https://www.porntrex.com，nginx + PHP（KVS Paysite 系），无 CF 盾，
 *    常规 UA + Referer 即可直连。响应下发 PHPSESSID。
 * 2) 路由：
 *      - 首页 /                     分页 /latest-updates/{N}/
 *      - 分类 /categories/{slug}/   分页 /categories/{slug}/{N}/
 *      - 搜索 /search/{关键词}/     分页 /search/{kw}/{N}/
 *    实测反例：/?s=、/?k= 返回首页；/search?k= 返回 404；/video/search?q= 空 body。
 *    关键词必须 encodeURIComponent 后放进路径段。
 * 3) 列表卡片：div[class*="video-item"] 或 div.thumb-item，内含
 *      a[href*="/video/"] -> https://www.porntrex.com/video/{数字id}/{slug}，vod_id 用 /video/{id}/{slug}。
 *    标题 span.video-item-title 文本 或 p.inf > a[title]；
 *    封面 img.cover[data-src]（协议相对 //ptx.cdntrex.com，需补 https:；img[src] 常为占位）；
 *    时长 div.durations / span.video-item-duration（去掉 <i> 图标）；
 *    观看数 div.viewsthumb / span.video-item-views；清晰度标 span.quality（1080p / 4K / 720p）。
 * 4) 分页：分页容器 <li class="page page-playlist" data-max="N"> 的 data-max 在第 1 页可用，
 *    但在第 2 页会漂移（47 -> 48），因此本源取所有分页 <a href="/.../{N}/"> 的最大页码，
 *    data-max 只作下限兜底。
 * 5) 【播放·核心】详情页内联 var flashvars = { ... }; ，用
 *      var flashvars\s*=\s*\{([\s\S]*?)\};  取块，再逐行 (\w+):\s*'([^']*)' 提键值。
 *    实测 4 档（4K 片源）：
 *      video_url        .../{id}.mp4/        video_url_text        '480p'
 *      video_alt_url    .../{id}_720p.mp4/   video_alt_url_text    '720p HD'
 *      video_alt_url2   .../{id}_1080p.mp4/  video_alt_url2_text   '1080p FHD'
 *      video_alt_url3   .../{id}_2160p.mp4/  video_alt_url3_text   '2160p 4K'   （仅 4K 片有）
 *    普通片只有前三档。get_file 直链取流时会 302 到 pcdn.cdntrex.com，
 *    脚本返回 get_file URL 即可（由播放器跟随，签名 expires/md5 随请求刷新）。
 * 6) 【最高分辨率优先】extractVideoVariants() 按 height 数值严格降序：
 *      2160p(4K) > 1080p > 720p > 480p。
 *    detail 的 vod_play_sources[0] 与 play 的 urls[0] 恒为当前片可用的最高档。
 *    不依赖对象键顺序，显式排序函数 sortVariantsByHeightDesc()。
 * 7) 缓存：home/category/search/detail 走短 TTL（getCache/setCache，失败安全降级）；
 *    play 不缓存（get_file 签名随时变）。
 *
 * 【环境变量】
 *  SITE_HOST            站点基址，默认 https://www.porntrex.com
 *  PORNTREX_CACHE_TTL   列表页缓存秒数，默认 300
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.catch 兜住。
 */

const crypto = require("crypto");

let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) { cheerio = null; }

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  OmniBox = { log() { /* 本地调试：不写 stdout */ }, sniffVideo: async () => "" };
}
let runner;
try { runner = require("spider_runner"); } catch (_) { runner = { run() {} }; }

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://www.porntrex.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return "https://www.porntrex.com"; }
}

const HOST = normalizeHost(process.env.SITE_HOST || "https://www.porntrex.com");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_TTL = Math.max(0, Number(process.env.PORNTREX_CACHE_TTL || 300) || 300);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.min(120, Math.round(BASE_TTL * 0.3)));
const CACHE_PREFIX = "ptx:page:";

// 内置常见分类兜底（抓 /categories/ 失败时用）
const CLASS_LIST = [
  { type_id: "latest-updates", type_name: "最新更新" },
  { type_id: "4k-porn", type_name: "4K 超清" },
  { type_id: "teen", type_name: "Teen" },
  { type_id: "milf", type_name: "MILF" },
  { type_id: "blowjob", type_name: "Blowjob" },
  { type_id: "anal", type_name: "Anal" },
  { type_id: "big-tits", type_name: "Big Tits" },
  { type_id: "lesbian", type_name: "Lesbian" },
  { type_id: "hardcore", type_name: "Hardcore" },
  { type_id: "amateur", type_name: "Amateur" },
  { type_id: "cumshot", type_name: "Cumshot" },
  { type_id: "creampie", type_name: "Creampie" },
  { type_id: "asian", type_name: "Asian" },
  { type_id: "ebony", type_name: "Ebony" },
  { type_id: "latina", type_name: "Latina" },
  { type_id: "threesome", type_name: "Threesome" },
  { type_id: "gangbang", type_name: "Gangbang" },
  { type_id: "analized", type_name: "Analized" },
  { type_id: "hd-porn", type_name: "HD" },
  { type_id: "ai", type_name: "AI" },
];

// flashvars 档位定义：字段后缀 -> 分辨率高度与显示名
// 【去掉 720 以下线路】480p（video_url）不再纳入，只保留 720P 及以上
const MIN_HEIGHT = 720;
const QUALITY_DEFS = [
  { key: "video_alt_url3", height: 2160, label: "2160P 4K" },
  { key: "video_alt_url2", height: 1080, label: "1080P FHD" },
  { key: "video_alt_url", height: 720, label: "720P HD" },
];

const PREFIX = "[ptx]";
function log(level, message) {
  const line = `${PREFIX}[${level}] ${message}`;
  try {
    if (typeof OmniBox.log === "function") {
      const p = OmniBox.log(level, line);
      if (p && typeof p.catch === "function") p.catch(() => {});
      return;
    }
  } catch (_) {}
  try { process.stderr.write(`${line}\n`); } catch (_) {}
}

function md5(text) {
  try { return crypto.createHash("md5").update(String(text)).digest("hex"); }
  catch (_) { return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32); }
}
function buildCacheKey(url) {
  const key = `${CACHE_PREFIX}${md5(url)}`;
  return Buffer.byteLength(key, "utf8") <= 200 ? key : `${CACHE_PREFIX}${md5(key)}`;
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
  try { if (ttl > 0 && typeof OmniBox.setCache === "function") await OmniBox.setCache(key, value, ttl); }
  catch (_) {}
}
function decodeHTML(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function cleanText(s) {
  return decodeHTML(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function absUrl(u) {
  const v = decodeHTML(String(u || "").trim());
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  if (v.startsWith("/")) return `${HOST}${v}`;
  return `${HOST}/${v}`;
}

async function requestText(url, options = {}) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: `${HOST}/`,
    ...(options.headers || {}),
  };
  const res = await OmniBox.request(url, {
    method: options.method || "GET", headers, timeout: options.timeout || 25000,
  });
  if (!res || Number(res.statusCode) !== 200) throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  return String(res.body || "");
}
async function fetchHtml(url, ttl) {
  const key = buildCacheKey(url);
  if (ttl > 0) { const c = await getCachedText(key); if (c) return c; }
  const html = await requestText(url);
  if (ttl > 0) await setCachedText(key, html, ttl);
  return html;
}
function loadHtml(html) {
  if (!cheerio) throw new Error("cheerio 不可用");
  return cheerio.load(html);
}

// ---------------------------------------------------------------------------
// 列表解析
// ---------------------------------------------------------------------------

function isDetailPath(pathname) {
  return /^\/video\/\d+\/[a-z0-9-]+\/?$/i.test(pathname);
}

function parseList(html, tag) {
  const $ = loadHtml(html);
  const list = [];
  const seen = new Set();
  $("div[class*='video-item'], div[class*='thumb-item'], div.video-preview-screen").each((_, node) => {
    const $box = $(node);
    const $a = $box.find("a[href*='/video/']").first();
    const href = $a.attr("href") || "";
    if (!href) return;
    let pathname = "";
    try { pathname = new URL(absUrl(href)).pathname.replace(/\/$/, ""); } catch (_) { return; }
    if (!isDetailPath(pathname)) return;
    if (seen.has(pathname)) return;
    seen.add(pathname);

    const title = cleanText(
      $box.find("span.video-item-title").first().text() ||
      $box.find("p.inf a[title]").first().attr("title") ||
      $a.attr("title") || $box.find("img[alt]").first().attr("alt") || ""
    );
    if (!title) return;

    const $img = $box.find("img[class*='cover']").first();
    let pic = $img.attr("data-src") || $img.attr("data-original") || "";
    if (!pic || /^data:/i.test(pic)) pic = $img.attr("src") || "";
    if (/^data:/i.test(pic)) pic = "";
    pic = absUrl(pic);

    // 时长：优先专属容器，再从整卡文本兜底抠 HH:MM:SS
    const durRaw = cleanText(
      $box.find("div.durations").first().text() || $box.find("span.video-item-duration").first().text() || ""
    );
    const durMatch = (durRaw.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) ||
      cleanText($box.text()).match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/));
    const dur = durMatch ? durMatch[0] : "";
    const views = cleanText(
      $box.find("div.viewsthumb").first().text() || $box.find("span.video-item-views").first().text() || ""
    );
    const quality = cleanText($box.find("span.quality").first().text());

    const remarks = [dur, views, quality].filter(Boolean).join(" · ");
    list.push({
      vod_id: pathname,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      vod_tag: "video",
      _tag: tag || "",
    });
  });
  return list;
}

function parsePageCount(html) {
  const $ = loadHtml(html);
  let max = 1;
  // 只认真实分页 <a> 的路径段页码（如 /search/teen/47/），忽略首页 AJAX 占位 data-max=41000
  $("div.pagination a[href], .pagination-holder a[href], li.page a[href]").each((_, n) => {
    const href = $(n).attr("href") || "";
    const m = href.match(/\/(?:search\/[^/]+|latest-updates|categories\/[^/]+)\/(\d+)\/?$/);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v > max && v < 10000) max = v;
    }
  });
  // data-max 是分页块的真实总页数（实测第 1 页 47，第 2 页漂移到 48），取较小者避免膨胀
  const dm = html.match(/<li[^>]*page-playlist[^>]*data-max="(\d+)"/i);
  if (dm) {
    const v = parseInt(dm[1], 10);
    if (Number.isFinite(v) && v > max && v < 10000) max = v;
  }
  // 全页路径段页码兜底（限制在合理范围，排除 41000 这类 AJAX 占位）
  for (const m of html.matchAll(/\/(?:search\/[^/]+|latest-updates|categories\/[^/]+)\/(\d+)\//g)) {
    const v = parseInt(m[1], 10);
    if (v > max && v < 10000) max = v;
  }
  return max;
}
function pageResult(list, page, pagecount) {
  return { page: Number(page) || 1, pagecount: Number(pagecount) || 1, total: list.length, limit: list.length, list };
}
function emptyPage(page) {
  return { page: Number(page) || 1, pagecount: 1, total: 0, limit: 0, list: [] };
}

// ---------------------------------------------------------------------------
// home / category / search
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    log("info", `[home] from=${context?.from || "web"}, host=${HOST}`);
    const html = await fetchHtml(`${HOST}/`, HOME_TTL);
    const list = parseList(html, "home");
    const filters = {};
    for (const c of CLASS_LIST) filters[c.type_id] = [];
    log("info", `[home] 返回分类=${CLASS_LIST.length}, 推荐=${list.length}`);
    return { class: CLASS_LIST, filters, list };
  } catch (e) {
    log("error", `[home] 失败: ${e?.message || e}`);
    return { class: CLASS_LIST, filters: {}, list: [] };
  }
}

function buildCategoryUrl(typeId, page) {
  const slug = String(typeId || "latest-updates").replace(/^\/+|\/+$/g, "") || "latest-updates";
  const base = slug === "latest-updates"
    ? `${HOST}/latest-updates/`
    : `${HOST}/categories/${slug}/`;
  return Number(page) > 1 ? `${base}${page}/` : base;
}

async function category(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const typeId = String(params?.categoryId || params?.type_id || "latest-updates");
    const url = buildCategoryUrl(typeId, page);
    log("info", `[category] typeId=${typeId}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[category] 请求 URL=${url}`);
    const html = await fetchHtml(url, CATEGORY_TTL);
    const list = parseList(html, "category");
    const pagecount = parsePageCount(html);
    log("info", `[category] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[category] 失败: ${e?.message || e}`);
    return emptyPage(page);
  }
}

async function search(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const keyword = String(params?.keyword || params?.wd || params?.q || "").trim();
    if (!keyword) { log("info", "[search] 关键词为空"); return emptyPage(page); }
    const kw = encodeURIComponent(keyword);
    const base = `${HOST}/search/${kw}/`;
    const url = page > 1 ? `${base}${page}/` : base;
    log("info", `[search] keyword=${keyword}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[search] 请求 URL=${url}`);
    const html = await fetchHtml(url, SEARCH_TTL);
    const list = parseList(html, "search");
    const pagecount = parsePageCount(html);
    log("info", `[search] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[search] 失败: ${e?.message || e}`);
    return emptyPage(page);
  }
}

// ---------------------------------------------------------------------------
// detail / play
// ---------------------------------------------------------------------------

function normalizeDetailPath(raw) {
  let s = decodeHTML(String(raw || "")).trim();
  if (!s) return "";
  if (s.includes("|||")) s = s.split("|||")[0];
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch (_) { return ""; }
  }
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\/$/, "");
  return isDetailPath(s) ? s : "";
}

/** 提取 var flashvars = {...} 里的键值对 */
function extractFlashvars(html) {
  const m = String(html || "").match(/var\s+flashvars\s*=\s*\{([\s\S]*?)\}\s*;/i);
  if (!m) return {};
  const out = {};
  const re = /(\w+)\s*:\s*'([^']*)'/g;
  let x;
  while ((x = re.exec(m[1])) !== null) out[x[1]] = decodeHTML(x[2]);
  return out;
}

/**
 * 按真实分辨率高度降序生成档位。
 * 关键：不依赖 flashvars 的键顺序，显式按 height 数值排序，2160p(4K) 恒为第一。
 */
function sortVariantsByHeightDesc(variants) {
  const arr = Array.isArray(variants) ? variants.slice() : [];
  return arr.sort((a, b) => {
    const ha = Number(a && a.height) || 0;
    const hb = Number(b && b.height) || 0;
    if (hb !== ha) return hb - ha;
    return String((a && a.key) || "").localeCompare(String((b && b.key) || ""));
  });
}

function extractVideoVariants(html) {
  const fv = extractFlashvars(html);
  const out = [];
  for (const d of QUALITY_DEFS) {
    if (d.height < MIN_HEIGHT) continue; // 【去掉 720 以下线路】双保险
    const u = String(fv[d.key] || "").trim();
    if (!u) continue;
    const abs = absUrl(u);
    if (!/\.mp4(\/|\?|$)/i.test(abs)) continue;
    // 允许站点 *_text 覆盖线路名，但高度以 QUALITY_DEFS 为准
    const textKey = d.key + "_text";
    const label = String(fv[textKey] || "").trim() || d.label;
    out.push({ key: d.key, name: label, height: d.height, url: abs });
  }
  return sortVariantsByHeightDesc(out);
}

async function detail(params, context) {
  const path = normalizeDetailPath(params?.videoId || params?.vod_id || params?.id);
  try {
    if (!path) { log("info", "[detail] videoId 为空"); return { list: [] }; }
    const detailUrl = `${HOST}${path}`;
    log("info", `[detail] path=${path}, from=${context?.from || "web"}`);
    log("info", `[detail] 请求 URL=${detailUrl}`);
    const html = await fetchHtml(detailUrl, DETAIL_TTL);
    const fv = extractFlashvars(html);
    const $ = loadHtml(html);
    const title = cleanText(
      $("meta[property='og:title']").attr("content") || fv.video_title ||
      cleanText($("title").text()).replace(/\s*\|\s*Porntrex.*$/i, "")
    ) || "PornTrex 视频";
    const pic = absUrl($("meta[property='og:image']").attr("content") || fv.preview_url || "");
    const desc = cleanText($("meta[property='og:description']").attr("content") || $("meta[name='description']").attr("content") || "");

    const variants = extractVideoVariants(html);
    log("info", `[detail] 档位=${variants.map((v) => `${v.name}(${v.height})`).join(" > ") || "(空)"}`);

    const sources = variants.length
      ? variants.map((v) => ({
          name: v.name,
          episodes: [{ name: v.name, playId: `${path}|||${v.url}` }],
        }))
      : [{ name: "播放页", episodes: [{ name: "播放", playId: detailUrl }] }];

    const top = variants[0];
    return {
      list: [{
        vod_id: path,
        vod_name: title,
        vod_pic: pic,
        vod_content: desc,
        vod_remarks: top ? `${top.name} · 最高画质` : "未解析到直链",
        vod_tag: "video",
        vod_play_sources: sources,
        vod_play_from: sources.map((s) => s.name).join("$$$"),
        vod_play_url: sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join("#")).join("$$$"),
      }],
    };
  } catch (e) {
    log("error", `[detail] 失败: ${e?.message || e}`);
    return { list: [] };
  }
}

function isMediaUrl(u) {
  return /\.(m3u8|mp4|webm|mkv|flv)(\/|\?|$)/i.test(String(u || ""));
}

async function play(params, context) {
  try {
    const raw = String(params?.playId || params?.play_id || params?.ids || "").trim();
    const flag = String(params?.flag || "ptx");
    log("info", `[play] playId=${raw.slice(0, 180)}, flag=${flag}, from=${context?.from || "web"}`);
    if (!raw) throw new Error("playId 不能为空");

    const header = { "User-Agent": UA, Referer: `${HOST}/`, Accept: "*/*" };

    // 直接透传媒体直链
    if (/^https?:\/\//i.test(raw) && isMediaUrl(raw)) {
      log("info", "[play] 命中媒体直链透传");
      return { urls: [{ name: "PornTrex", url: decodeHTML(raw) }], flag, header, parse: 0 };
    }

    let path = normalizeDetailPath(raw);
    let variants = [];
    if (raw.includes("|||")) {
      const direct = decodeHTML(raw.slice(raw.indexOf("|||") + 3).trim());
      // 回源拿全档（保证 urls[0] 恒为最高档），并把用户点选的那档也带上
      if (path) {
        try {
          const html = await fetchHtml(`${HOST}${path}`, 0);
          variants = extractVideoVariants(html);
        } catch (_) {}
      }
      if (!variants.length && isMediaUrl(direct)) {
        return { urls: [{ name: "PornTrex", url: direct }], flag, header, parse: 0 };
      }
    } else if (path) {
      const html = await fetchHtml(`${HOST}${path}`, 0);
      variants = extractVideoVariants(html);
    }

    if (!variants.length) throw new Error("详情页未解析到播放档位");

    const urls = sortVariantsByHeightDesc(variants).map((v) => ({ name: v.name, url: v.url }));
    log("info", `[play] urls=${urls.map((u) => u.name).join(" > ")}, urls[0]=${urls[0].name}`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag: params?.flag || "ptx", header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
