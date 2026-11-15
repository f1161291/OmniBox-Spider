// @name XNXX
// @version 1.0.1
// @author omnibox-spider
// @description xnxx.com 采集源：/hits 推荐 + /tags 常见标签分类 + /search/{kw} 搜索分页；详情页解析 html5player.setVideoHLS/High/Low，并二次请求 HLS master 解出真实 1080P/720P/480P 单档，按真实分辨率数值降序，最高档恒为 vod_play_sources[0] 与 play().urls[0]
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/XNXX.js
// @dependencies cheerio

/**
 * 实站事实（改代码前先读）
 * 1) 站点 https://www.xnxx.com 可直连，常规 UA + Referer 即可，无 CF 盾 / JS cookie 挑战。
 * 2) 【重要】主页 / 返回的是分类占位块（div.thumb-block.thumb-cat），没有真实视频列表。
 *    真列表入口：/hits（最热）、/best、/search/{keyword}、/tags、/channels。
 *    所以 home() 抓 /hits 作为推荐，绝不抓 /。
 * 3) 路由与分页（实测 + 夹具 /tmp/xnxx-hits.html、/tmp/xnxx-search.html）：
 *      - 推荐 /hits，翻页路径式 /hits/{N}，N 为 0-based（/hits/1 = 第 2 页，/hits/277 = 第 278 页）
 *      - 搜索 /search/{encodeURIComponent(keyword)}，翻页 /search/{kw}/{N}（同样 0-based）
 *        /search?k= 会 404，勿用。多词关键词同时尝试 %20 与 - 两种编码。
 *      - 标签分类：/tags 页里的 /search/{slug}（如 /search/anal、/search/amateur-blowjob）是真实列表入口，
 *        字母索引 /tags/{letter} 只是导航。内置常见 tag 兜底。
 *      - 排序修饰：/search/{sort}/{slug}，sort 例 hits/best/random/year/month/week/day/fullhd/hd-only...
 *    分页实现用 fetchListWithFallback()：路径式 /{N} 优先，无效降级 ?page=N，再降级基址。
 * 4) 列表卡片（两套 DOM 都要兼容）：
 *      A) /hits：div.thumb-block.video[data-video='{...json...}']，内 a.thumb-link[href]（详情 /video-{code}/{slug}），
 *         标题 a.title[title]，封面 img[data-src] / picture source[data-srcset]。
 *      B) /search：div.thumb-block（不带 .video），内 a[href^="/video-"]，标题 .thumb-under a[title]，
 *         封面 img[data-src]。
 *      两种卡片 img[src] 都是 blank.gif / lightbox-blank.gif 占位，必须跳过，只取 data-src / data-srcset。
 *      时长/观看数/清晰度在 .thumb-under .metadata。vod_id 用详情 pathname（/video-xxx/slug）。
 * 5) 【播放关键】详情页内联 html5player.setVideoXXX('URL')：
 *      setVideoHLS('...hls.m3u8')            -> HLS 自适应 master，【最高画质，排第一】
 *      setVideoUrlHigh('...video_360p.mp4')  -> 360P
 *      setVideoUrlLow('...video_240p.mp4')   -> 240P
 *    URL 带 ?secure=... 签名（随会话刷新），play() 每次从详情页现取（ttl=0，绝不缓存播放页）。
 *    setVideoURL('/video-.../slug') 是页面自身路径，不是媒体地址，解析时跳过。
 * 6) 【最高分辨率优先·1.0.1】setVideoHLS 指向的其实是 HLS master，实测内含
 *      RESOLUTION=1920x1080 / 1280x720 / 854x480 / 640x360 / 444x250 五档
 *      （hls-1080p.m3u8 等单档 playlist）。因此 enrichWithHlsVariants() 会二次请求
 *      master，用 parseHlsMaster() 把每档真实高度解出来，按数值严格降序排最前：
 *      1080P(HLS) > 720P(HLS) > 480P(HLS) > 360P(HLS) > 250P(HLS)，
 *      之后再跟固定 mp4 档（360P/240P），末尾保留 HLS 自适应 master 作兜底。
 *    detail() 的 vod_play_sources[0] 与 play() 的 urls[0] 恒为当前片真实最高档。
 *    若 master 请求失败，则安全降级回「HLS自适应 > 360P > 240P」。
 * 7) 缓存：home/category/search/detail 走短 TTL（getCache/setCache，失败安全降级）；play 不缓存。
 * 8) 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON。脚本绝不写 stdout：
 *    本地调试兜底给 log(){} / run(){} 假对象；日志一律 OmniBox.log(level,msg) + Promise.catch 兜住。
 *
 * 【环境变量】（复用仓库既有命名）
 *  SITE_HOST         站点基址，默认 https://www.xnxx.com
 *  SITE_COOKIE       可选站点 Cookie
 *  XNXX_CACHE_TTL    页面缓存秒数，默认 600（新增，避免与别的站点 TTL 串用；play 强制 0）
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
  // 本地调试兜底：空函数，绝不写 stdout
  OmniBox = { log() {} };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://www.xnxx.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "https://www.xnxx.com";
  }
}

const HOST = normalizeHost(process.env.SITE_HOST || "https://www.xnxx.com");
const SITE_COOKIE = String(process.env.SITE_COOKIE || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_TTL = Math.max(0, Number(process.env.XNXX_CACHE_TTL || 600) || 600);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.min(90, Math.round(BASE_TTL * 0.15)));
const TAGS_TTL = Math.max(0, Math.round(BASE_TTL * 2));
const PLAY_TTL = 0; // 签名链接随会话刷新，play 现取现用
const CACHE_PREFIX = "xnxx:page:";

// 档位 height：HLS 自适应 master 本身含 250p/360p/480p/720p/1080p 多档（实测），
// 解析出单档 playlist 后按真实高度排序；master 兜底权重设为 4000，恒排在已解档之后但在 mp4 之前。
const HLS_HEIGHT = 4000;
const HEIGHT_360 = 360;
const HEIGHT_240 = 240;

const SORT_WHITELIST = new Set([
  "hits", "best", "random", "year", "month", "week", "day",
  "0-10min", "10min+", "10-20min", "20min+", "hd-only", "fullhd", "hide_viewed_video",
]);

// /tags 抓不到时的兜底分类（type_id 会拼成 /search/{type_id}）
const DEFAULT_CLASS_LIST = [
  { type_id: "hits", type_name: "最热门" },
  { type_id: "best", type_name: "最佳影片" },
  { type_id: "teen", type_name: "Teen" },
  { type_id: "milf", type_name: "MILF" },
  { type_id: "anal", type_name: "Anal" },
  { type_id: "amateur", type_name: "Amateur" },
  { type_id: "blowjob", type_name: "Blowjob" },
  { type_id: "big-tits", type_name: "Big Tits" },
  { type_id: "big-ass", type_name: "Big Ass" },
  { type_id: "cumshot", type_name: "Cumshot" },
  { type_id: "creampie", type_name: "Creampie" },
  { type_id: "lesbian", type_name: "Lesbian" },
  { type_id: "threesome", type_name: "Threesome" },
  { type_id: "jav", type_name: "JAV / 日本" },
  { type_id: "asian", type_name: "Asian" },
  { type_id: "hentai", type_name: "Hentai" },
  { type_id: "pov", type_name: "POV" },
  { type_id: "squirt", type_name: "Squirt" },
  { type_id: "stepmom", type_name: "Stepmom" },
  { type_id: "hardcore", type_name: "Hardcore" },
];

// ---------------------------------------------------------------------------
// 日志 / 缓存 / 请求（绝不写 stdout）
// ---------------------------------------------------------------------------

function log(level, message) {
  try {
    if (typeof OmniBox.log === "function") {
      const p = OmniBox.log(level, `[xnxx][${level}] ${message}`);
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
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
  const key = `${CACHE_PREFIX}${md5(`${url}|${SITE_COOKIE}`)}`;
  if (Buffer.byteLength(key, "utf8") <= 200) return key;
  return `${CACHE_PREFIX}${md5(key)}`;
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

async function requestText(url) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: `${HOST}/`,
    Origin: HOST,
  };
  if (SITE_COOKIE) headers.Cookie = SITE_COOKIE;
  const res = await OmniBox.request(url, { method: "GET", headers, timeout: 20000 });
  if (!res || Number(res.statusCode) !== 200) {
    throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  }
  return String(res.body || "");
}

async function fetchHtml(url, ttl) {
  const key = buildCacheKey(url);
  if (ttl > 0) {
    const cached = await getCachedText(key);
    if (cached) return cached;
  }
  const html = await requestText(url);
  if (ttl > 0) await setCachedText(key, html, ttl);
  return html;
}

function loadHtml(html) {
  if (!cheerio) throw new Error("cheerio 不可用");
  return cheerio.load(html);
}

// ---------------------------------------------------------------------------
// 列表解析（兼容 /hits 的 .thumb-block.video 与 /search 的 .thumb-block 两套 DOM）
// ---------------------------------------------------------------------------

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isBlankPic(u) {
  return !u || /^data:/i.test(u) || /blank\.gif|lightbox-blank/i.test(u);
}

function pickPic($card) {
  const cands = [
    $card.find("img[data-src]").first().attr("data-src"),
    $card.find("picture source[data-srcset]").first().attr("data-srcset"),
    $card.find("source[data-srcset]").first().attr("data-srcset"),
    $card.find("img[data-sfwthumb]").first().attr("data-sfwthumb"),
  ];
  for (const raw of cands) {
    // srcset 可能带 ", 2x" 或 " 1x"，只取第一段 URL
    const v = String(raw || "").split(",")[0].trim().split(/\s+/)[0];
    if (!isBlankPic(v)) return v;
  }
  const src = String($card.find("img").first().attr("src") || "").trim();
  if (!isBlankPic(src)) return src;
  return "";
}

function pickTitle($card) {
  const cands = [
    $card.find("a.title[title]").first().attr("title"),
    $card.find("a.title").first().text(),
    $card.find("a[title]").first().attr("title"),
    $card.find(".thumb-under a[href^='/video-']").first().attr("title"),
    $card.find(".thumb-under p a").first().text(),
    $card.find("img[alt]").first().attr("alt"),
  ];
  for (const c of cands) {
    const v = cleanText(c);
    if (v) return v;
  }
  return "";
}

function parseList(html) {
  const $ = loadHtml(html);
  const list = [];
  const seen = new Set();
  $("div.thumb-block").each((_, node) => {
    const $card = $(node);
    const href = String($card.find("a[href^='/video-']").first().attr("href") || "").trim();
    if (!/^\/video-/i.test(href)) return; // 分类占位块 / 广告块，跳过
    const path = href.split("?")[0].split("#")[0];
    if (seen.has(path)) return;
    const title = pickTitle($card);
    if (!title) return;
    seen.add(path);
    const remarks = cleanText($card.find(".thumb-under .metadata").first().text() ||
      $card.find(".thumb-under").first().text());
    list.push({
      vod_id: path,
      vod_name: title,
      vod_pic: pickPic($card),
      vod_remarks: remarks,
      vod_tag: "video",
      vod_play_from: "XNXX",
    });
  });
  return list;
}

function parsePageCount(html) {
  const $ = loadHtml(html);
  let maxPage = 1;
  $(".pagination a").each((_, node) => {
    const $a = $(node);
    const t = parseInt(cleanText($a.text()), 10);
    if (!isNaN(t) && t > 0 && t < 100000) maxPage = Math.max(maxPage, t);
    const dp = parseInt($a.attr("data-page"), 10);
    if (!isNaN(dp) && dp >= 0) maxPage = Math.max(maxPage, dp + 1);
    const h = String($a.attr("href") || "");
    const m = h.match(/\/(\d+)(?:\?|$)/); // /hits/277 或 /search/teen/222（0-based，+1 得页码）
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10) + 1);
  });
  return Math.max(1, maxPage);
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

function emptyPage(page) {
  return { page: Number(page) || 1, pagecount: 1, total: 0, limit: 0, list: [] };
}

function readFilters(params) {
  try {
    return params?.filters || params?.extend || params?.ext || params?.filter || {};
  } catch (_) {
    return {};
  }
}

/**
 * 分页实测降级：page>1 时路径式 /{N} 优先 -> ?page=N（逐级降级，不回退裸基址，
 * 避免越界翻页时把第 1 页内容当成第 N 页）；page=1 直接请求裸基址。
 * 取第一个能解析出真实视频列表的响应；全部失败返回空 html（由上层兜住空结构）。
 */
async function fetchListWithFallback(bases, page, ttl) {
  const candidates = [];
  for (const base of bases) {
    if (page > 1) {
      candidates.push(`${HOST}${base}/${page - 1}`);
      candidates.push(`${HOST}${base}?page=${page}`);
    } else {
      candidates.push(`${HOST}${base}`);
    }
  }
  for (const url of candidates) {
    try {
      const html = await fetchHtml(url, ttl);
      if (html && parseList(html).length > 0) {
        log("info", `[list] 生效 URL=${url}`);
        return { html, usedUrl: url };
      }
      log("info", `[list] 无列表，降级: ${url}`);
    } catch (e) {
      log("info", `[list] 请求失败，降级: ${url} (${e?.message || e})`);
    }
  }
  return { html: "", usedUrl: "" };
}

function buildCategoryBases(typeId, sort) {
  const id = String(typeId || "hits").trim();
  const s = SORT_WHITELIST.has(String(sort || "").trim()) ? String(sort).trim() : "";
  if (id === "hits") return ["/hits"];
  if (id === "best") return ["/best"];
  if (id === "channels") return ["/channels"];
  if (id.startsWith("/search/") || id.startsWith("/tags/") || id.startsWith("/hits") || id.startsWith("/best")) {
    return [id];
  }
  const slug = encodeURIComponent(id);
  if (s) return [`/search/${s}/${slug}`, `/search/${slug}`]; // 排序修饰优先，失败降级普通标签
  return [`/search/${slug}`];
}

// ---------------------------------------------------------------------------
// 分类清单（/tags 动态补充 + 内置兜底）
// ---------------------------------------------------------------------------

async function loadClassList() {
  try {
    const html = await fetchHtml(`${HOST}/tags`, TAGS_TTL);
    const $ = loadHtml(html);
    const special = DEFAULT_CLASS_LIST.slice(0, 2); // hits / best 固定置顶
    const tags = [];
    const seen = new Set(special.map((x) => x.type_id));
    $("a[href^='/search/']").each((_, node) => {
      const href = String($(node).attr("href") || "");
      const m = href.match(/^\/search\/([a-z0-9_-]+)$/i);
      if (!m) return;
      const slug = m[1];
      if (seen.has(slug)) return;
      seen.add(slug);
      const name = cleanText($(node).text()) || slug;
      tags.push({ type_id: slug, type_name: name });
      if (tags.length >= 60) return false;
    });
    if (tags.length) return special.concat(tags);
  } catch (e) {
    log("info", `[class] /tags 抓取失败，使用内置兜底: ${e?.message || e}`);
  }
  return DEFAULT_CLASS_LIST;
}

// ---------------------------------------------------------------------------
// 播放档位解析（最高分辨率优先的核心）
// ---------------------------------------------------------------------------

function unescapeUrl(u) {
  return String(u || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/** 按 height 数值严格降序：HLS(2160) > 360P(360) > 240P(240) */
function sortVariantsByHeightDesc(variants) {
  const arr = Array.isArray(variants) ? variants.slice() : [];
  return arr.sort((a, b) => {
    const ha = Number(a && a.height) || 0;
    const hb = Number(b && b.height) || 0;
    if (hb !== ha) return hb - ha; // height 数值降序
    return String((a && a.key) || "").localeCompare(String((b && b.key) || ""));
  });
}

/**
 * 解析 XNXX 的 HLS master，把里面每一档 #EXT-X-STREAM-INF 的真实分辨率解出来，
 * 生成单档 playlist 绝对地址。实测 master 含 250p/360p/480p/720p/1080p，
 * 单档文件名形如 hls-1080p.m3u8，用 new URL 拼到 master 同目录即可。
 * 解析失败返回空数组，调用方仍保留 master 作为兜底线路。
 */
function parseHlsMaster(masterUrl, masterText) {
  const out = [];
  const text = String(masterText || "");
  if (!text.includes("#EXTM3U")) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const info = lines[i];
    if (!/^#EXT-X-STREAM-INF/.test(info.trim())) continue;
    const uri = lines[i + 1].trim();
    if (!uri || uri.charAt(0) === "#") continue;
    const mm = info.match(/RESOLUTION=\d+x(\d+)/i);
    const height = mm ? parseInt(mm[1], 10) : 0;
    if (!height) continue; // 无分辨率信息，跳过，交给 master 兜底
    let abs;
    try { abs = new URL(uri, masterUrl).toString(); } catch (_) { continue; }
    out.push({
      key: `hls${height}`,
      name: `${height}P(HLS)`,
      height,
      url: abs,
    });
  }
  return sortVariantsByHeightDesc(out);
}

/** 从详情页同步解析出基础档位（HLS master URL + 360p/240p mp4）。 */
function parseVariants(html) {
  const text = String(html || "");
  const grab = (setter) => {
    const re = new RegExp("html5player\\." + setter + "\\(\\s*['\"]([^'\"]+)['\"]", "i");
    const m = text.match(re);
    return m ? unescapeUrl(m[1]) : "";
  };
  let hls = grab("setVideoHLS");
  let high = grab("setVideoUrlHigh");
  let low = grab("setVideoUrlLow");

  // 通用 setter 全扫兜底：html5player.setVideo\w+\(\s*['"]([^'"]+)['"]
  const generic = /html5player\.setVideo\w+\(\s*['"]([^'"]+)['"]/gi;
  let m;
  const all = [];
  while ((m = generic.exec(text)) !== null) all.push(unescapeUrl(m[1]));
  for (const u of all) {
    if (!/^https?:\/\//i.test(u)) continue; // setVideoTitle / setVideoURL 等非媒体值跳过
    if (!hls && /\.m3u8|\/hls/i.test(u)) hls = u;
    if (!high && /360p/i.test(u)) high = u;
    if (!low && /240p/i.test(u)) low = u;
  }

  const out = [];
  if (hls) out.push({ key: "hls", name: "HLS自适应(最高)", height: HLS_HEIGHT, url: hls });
  if (high) out.push({ key: "360p", name: "360P", height: HEIGHT_360, url: high });
  if (low) out.push({ key: "240p", name: "240P", height: HEIGHT_240, url: low });
  return { base: sortVariantsByHeightDesc(out), hlsMaster: hls };
}

/**
 * 在基础档位上，额外拉取 HLS master 解出真实单档（1080P/720P/...），
 * 并把这些真实档排在所有线路最前面。master 本身降级为「自适应」兜底。
 * 网络失败安全降级：只返回基础档位，不抛错。
 */
async function enrichWithHlsVariants(baseVariants, hlsMaster) {
  if (!hlsMaster) return baseVariants;
  try {
    const masterText = await requestText(hlsMaster);
    const singles = parseHlsMaster(hlsMaster, masterText);
    if (!singles.length) return baseVariants;
    // master 降级为兜底（去掉过高的排序权重），避免与真实单档重复
    const rest = baseVariants
      .filter((v) => v.key !== "hls")
      .map((v) => ({ ...v }));
    return sortVariantsByHeightDesc([...singles, ...rest, {
      key: "hls", name: "HLS自适应", height: 1, url: hlsMaster,
    }]);
  } catch (e) {
    log("info", `[hls] master 解析失败，保留自适应线路: ${e?.message || e}`);
    return baseVariants;
  }
}

/** playId / vod_id -> 详情 pathname（/video-xxx/slug） */
function toPath(input) {
  let s = String(input || "").trim();
  if (!s) return "";
  s = s.split("|||")[0];
  if (/^xnxx:/i.test(s)) s = s.replace(/^xnxx:/i, "");
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch (_) {
      return "";
    }
  }
  if (!/^\/video-/i.test(s)) return "";
  return s.split("?")[0].split("#")[0];
}

// ---------------------------------------------------------------------------
// home / category / search
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    log("info", `[home] from=${context?.from || "web"}, host=${HOST}`);
    const classList = await loadClassList();
    const { html } = await fetchListWithFallback(["/hits"], 1, HOME_TTL);
    const list = html ? parseList(html) : [];
    const filters = {};
    for (const item of classList) {
      filters[item.type_id] = [
        {
          key: "sort",
          name: "排序",
          init: "",
          value: [
            { name: "默认", value: "" },
            { name: "最热", value: "hits" },
            { name: "最佳", value: "best" },
            { name: "随机", value: "random" },
            { name: "本年度", value: "year" },
            { name: "本月", value: "month" },
            { name: "本周", value: "week" },
            { name: "今日", value: "day" },
            { name: "仅高清", value: "hd-only" },
            { name: "全高清", value: "fullhd" },
          ],
        },
      ];
    }
    log("info", `[home] 返回分类=${classList.length}, 推荐=${list.length}`);
    return { class: classList, filters, list };
  } catch (e) {
    log("error", `[home] 失败: ${e?.message || e}`);
    return { class: DEFAULT_CLASS_LIST, filters: {}, list: [] };
  }
}

async function category(params, context) {
  try {
    const typeId = String(params?.categoryId || params?.type_id || params?.t || "hits").trim();
    const page = Number(params?.page) || 1;
    const f = readFilters(params);
    const sort = SORT_WHITELIST.has(String(f.sort || params?.sort || "").trim())
      ? String(f.sort || params?.sort).trim() : "";
    const bases = buildCategoryBases(typeId, sort);
    log("info", `[category] type_id=${typeId}, page=${page}, sort=${sort}, from=${context?.from || "web"}`);
    const { html } = await fetchListWithFallback(bases, page, CATEGORY_TTL);
    if (!html) return emptyPage(page);
    const list = parseList(html);
    const pagecount = parsePageCount(html);
    log("info", `[category] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[category] 失败: ${e?.message || e}`);
    return emptyPage(params?.page);
  }
}

async function search(params, context) {
  try {
    const page = Number(params?.page) || 1;
    const keyword = String(params?.keyword || params?.wd || params?.q || "").trim();
    if (!keyword) {
      log("info", "[search] 关键词为空，返回空结果");
      return emptyPage(page);
    }
    const enc = encodeURIComponent(keyword);
    const dash = encodeURIComponent(keyword.replace(/\s+/g, "-"));
    const bases = enc === dash ? [`/search/${enc}`] : [`/search/${enc}`, `/search/${dash}`];
    log("info", `[search] keyword=${keyword}, page=${page}, from=${context?.from || "web"}`);
    const { html } = await fetchListWithFallback(bases, page, SEARCH_TTL);
    if (!html) return emptyPage(page);
    const list = parseList(html);
    const pagecount = parsePageCount(html);
    log("info", `[search] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[search] 失败: ${e?.message || e}`);
    return emptyPage(params?.page);
  }
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

async function detail(params, context) {
  try {
    const raw = String(params?.vod_id || params?.id || params?.videoId || "").trim();
    const path = toPath(raw);
    log("info", `[detail] vod_id=${raw.slice(0, 160)}, path=${path}, from=${context?.from || "web"}`);
    if (!path) return { list: [] };

    const url = `${HOST}${path}`;
    const html = await fetchHtml(url, DETAIL_TTL);
    const $ = loadHtml(html);

    const titleFromSetter = (html.match(/html5player\.setVideoTitle\(\s*['"]([^'"]+)['"]/i) || [])[1] || "";
    const vod_name = cleanText(
      $("meta[property='og:title']").attr("content") || titleFromSetter ||
      cleanText($("title").text()).replace(/\s*-\s*XNXX\.COM\s*$/i, "")
    ) || "XNXX 视频";
    const vod_pic = String($("meta[property='og:image']").attr("content") || "").trim();
    const vod_content = cleanText(
      $(".video-description, #video-description, .description, .metadata-row.video-description").first().text() ||
      $("meta[name='description']").attr("content") || ""
    );
    const dur = Number($("meta[property='og:duration']").attr("content") || 0);
    const durText = dur > 0 ? `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}` : "";
    const hdText = cleanText($(".video-hd, .metadata .video-hd").first().text());
    const vod_remarks = [durText, hdText, "XNXX"].filter(Boolean).join(" · ");

    const parsed = parseVariants(html);
    // 异步拉 HLS master 解出真实 1080P/720P/480P 单档，按真实高度降序排最前
    const variants = await enrichWithHlsVariants(parsed.base, parsed.hlsMaster);
    const vod_play_sources = variants.map((v) => ({
      name: v.name,
      episodes: [{ name: v.name, playId: `xnxx:${path}|||${v.key}` }],
    }));

    log("info", `[detail] 线路=${vod_play_sources.map((s) => s.name).join(" > ") || "(空)"}`);
    return {
      list: [{ vod_id: path, vod_name, vod_pic, vod_content, vod_remarks, vod_play_sources }],
    };
  } catch (e) {
    log("error", `[detail] 失败: ${e?.message || e}`);
    return { list: [] };
  }
}

// ---------------------------------------------------------------------------
// play（每次现取详情页签名，urls[0] 恒为 HLS 最高档）
// ---------------------------------------------------------------------------

async function play(params, context) {
  const header = { "User-Agent": UA, Referer: `${HOST}/` };
  const flag = String(params?.flag || "xnxx");
  try {
    const raw = String(params?.playId || params?.play_id || params?.ids || params?.url || "").trim();
    log("info", `[play] playId=${raw.slice(0, 200)}, flag=${flag}, from=${context?.from || "web"}`);

    let path = toPath(raw);
    if (!path) path = toPath(params?.vod_id || params?.id || "");

    // 兜底：宿主直接把媒体直链塞进 playId
    if (!path && /^https?:\/\//i.test(raw) && /\.(m3u8|mp4)(\?|$)/i.test(raw)) {
      const direct = unescapeUrl(raw.split("|||")[0]);
      log("info", "[play] 命中媒体直链透传");
      return { urls: [{ name: "XNXX", url: direct }], flag, header, parse: 0 };
    }
    if (!path) throw new Error("playId 无法解析出详情路径");

    // 签名 URL 现取现用：ttl=0，绝不走缓存
    const html = await fetchHtml(`${HOST}${path}`, PLAY_TTL);
    const parsed = parseVariants(html);
    const variants = await enrichWithHlsVariants(parsed.base, parsed.hlsMaster);
    if (!variants.length) throw new Error("详情页未解析到播放档位");

    const urls = variants.map((v) => ({ name: v.name, url: v.url }));
    log("info", `[play] urls=${urls.map((u) => u.name).join(" > ")}, urls[0]=${urls[0].name}`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}
