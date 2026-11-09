// @name APP电影
// @author OmniBox
// @description 站点：app.movie（MacCMS blueghost 模板，裸域 302 → www.appmovie.art）；首页 / 分类四维筛选 / 搜索 / 详情多线路 / 播放直链
// @version 1.1.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/解析/app-movie.js
// @dependencies: cheerio

/**
 * ============================================================================
 * APP电影 (app.movie / www.appmovie.art)
 * ----------------------------------------------------------------------------
 * 站点接口情况（2026-11 实测）：
 * - 站点自带采集 API（/api.php/provide/vod/…）被 openresty 拦成 403，因此本脚本走前台 HTML。
 * - 裸域 https://app.movie 会 302 到 https://www.appmovie.art，脚本内置主备域自动切换。
 *
 * 真实前台路由：
 * - 首页      /                                            4 个板块 × 12 张卡片
 * - 分类列表  /index.php/vod/type/id/{tid}.html             无筛选入口
 * - 分类筛选  /index.php/vod/show/{area}/{by}/{class}/id/{tid}/page/{n}/year/{year}.html
 *             实测样式：show/area/大陆/by/hits/class/悬疑/id/1/year/2020.html
 *                       show/class/剧情/id/1/page/2.html
 * - 详情      /index.php/vod/detail/id/{vid}.html
 *             meta 在 .stui-content__detail；线路 = div.stui-pannel 内 h3.title + ul.stui-content__playlist
 * - 播放      /index.php/vod/play/id/{vid}/sid/{sid}/nid/{nid}.html
 *             <script>var player_data={...,"url":"https:\/\/…\/index.m3u8","from":"xlm3u8",…}</script> 直接给直链
 * - 搜索      /index.php/vod/search.html?wd=X  与  /index.php/vod/search/page/{n}/wd/{X}.html
 *
 * 筛选维度（按站点前台按钮实测，分类间词表不同）：
 * - class 类型：GENRES（电影/剧集/综艺/动漫 各一套，电影含 26 项，剧集含 16 项）
 * - area  地区：AREAS（电影用「大陆」，剧集用「内地」，综艺/动漫各自一套）
 * - year  年份：2000+ 动态生成
 * - by    排序：time | hits | score
 * 「分类」（动作片 / 国产剧 …）不是筛选参数而是另一个 id，因此作为独立 type_id 暴露在 home.class。
 *
 * 环境变量：
 * - APPMOVIE_HOST        可选  覆盖站点地址，例如 https://app.movie；不配则使用内置主备域列表
 * - APPMOVIE_CACHE_OFF   可选  设为 1 关闭本脚本的页面缓存（默认开启）
 *
 * 缓存策略：
 * - home 300s / category 300s / search 120s / detail 600s
 * - play() 默认不缓存（播放链路优先级最高，避免脏缓存影响起播）
 * - 走 SDK getCache/setCache，失败自动降级进程内 Map；超长 key 会先哈希归一化再进缓存
 *
 * 变更记录：
 * - 1.1.0 适配新版前台：
 *         1) 主备域自动切换（www.appmovie.art ↔ app.movie），403/空页自动换域；
 *         2) 详情按「面板配对」解析真实线路名（心浪云播 / 闪电播放 / 无尽云播 / 光速云播 …），
 *            修掉旧版正则跨面板导致线路名退化成「线路N」的问题；
 *         3) category 接入 类型/地区/年份/排序 四维筛选 + show 路由 + 正确 pagecount（1/N 与尾页双兜底）；
 *         4) play 解析 player_data JSON 直链（parse=0），失败再 SDK 嗅探，最后回退客户端嗅探（parse=1）；
 *         5) playId 透传 base64 meta（sid/v/e/i/ln），支持异步写播放记录；
 *         6) home/category/detail/search 接入 SDK 缓存（失败降级为进程内 Map）；
 *         7) detail 兼容 videoId / video_id / ids / id / 纯数字，并回填 legacy vod_play_from / vod_play_url / vod_play_list。
 * - 1.0.6 初版（详情线路名会被折叠成线路N，play 依赖全局 url 正则，无筛选）。
 * ============================================================================
 */

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  OmniBox = { log(level, message) { console.log(`[${level}] ${message}`); } };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

// cheerio 为可选依赖：有就用来解析，没有则走内置正则解析器（两条路径输出结构完全一致）
let cheerio = null;
try {
  cheerio = require("cheerio");
} catch (_) {
  cheerio = null;
}

const LOG_TAG = "[appmovie]";

function logInfo(message) {
  try { OmniBox.log("info", `${LOG_TAG} ${message}`); } catch (_) {}
}

function logError(message, detail) {
  try { OmniBox.log("error", `${LOG_TAG} ${message}${detail ? `: ${detail}` : ""}`); } catch (_) {}
}

// ==================== 站点配置 ====================

const DEFAULT_HOSTS = ["https://www.appmovie.art", "https://app.movie"];
const ENV_HOST = String(process.env.APPMOVIE_HOST || "").trim().replace(/\/+$/, "");
const HOSTS = ENV_HOST ? [ENV_HOST, ...DEFAULT_HOSTS.filter((h) => h !== ENV_HOST)] : DEFAULT_HOSTS;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const PAGE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

// 媒体请求头：m3u8 站点实测不校验 Referer，但仍带上，兼容少数需要同源 Referer 的 CDN
function playHeaders() {
  return {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": `${activeHost}/`,
  };
}

const TTL = { home: 300, category: 300, search: 120, detail: 600 };
const CACHE_PREFIX = "appmovie:";
// 如需整体关闭缓存：设置环境变量 APPMOVIE_CACHE_OFF=1
const CACHE_OFF = String(process.env.APPMOVIE_CACHE_OFF || "") === "1";

let activeHost = HOSTS[0];

// ==================== 分类 ====================

const CLASS_LIST = [
  { type_id: "1", type_name: "电影" },
  { type_id: "2", type_name: "连续剧" },
  { type_id: "3", type_name: "综艺" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "6", type_name: "动作片" },
  { type_id: "7", type_name: "喜剧片" },
  { type_id: "8", type_name: "爱情片" },
  { type_id: "9", type_name: "科幻片" },
  { type_id: "10", type_name: "恐怖片" },
  { type_id: "11", type_name: "剧情片" },
  { type_id: "12", type_name: "战争片" },
  { type_id: "20", type_name: "纪录片" },
  { type_id: "13", type_name: "国产剧" },
  { type_id: "14", type_name: "港台剧" },
  { type_id: "15", type_name: "日韩剧" },
  { type_id: "16", type_name: "欧美剧" },
];

// 站点前台「按类型」词表（分类间不同，不要互相复用）
const GENRES = {
  movie: ["喜剧", "爱情", "恐怖", "动作", "科幻", "剧情", "战争", "警匪", "犯罪", "动画", "奇幻", "武侠", "冒险", "枪战", "悬疑", "惊悚", "经典", "青春", "文艺", "微电影", "古装", "历史", "运动", "农村", "儿童", "网络电影"],
  tv: ["古装", "战争", "青春偶像", "喜剧", "家庭", "犯罪", "动作", "奇幻", "剧情", "历史", "经典", "乡村", "情景", "商战", "网剧", "其他"],
  variety: ["选秀", "情感", "访谈", "播报", "旅游", "音乐", "美食", "纪实", "曲艺", "生活", "游戏互动", "财经", "求职"],
  anime: ["情感", "科幻", "热血", "推理", "搞笑", "冒险", "萝莉", "校园", "动作", "机战", "运动", "战争", "少年", "少女", "社会", "原创", "亲子", "益智", "励志", "其他"],
};

// 站点前台「按地区」词表（电影用「大陆」，剧集用「内地」，不能混用）
const AREAS = {
  movie: ["大陆", "香港", "台湾", "美国", "法国", "英国", "日本", "韩国", "德国", "泰国", "印度", "意大利", "西班牙", "加拿大", "其他"],
  tv: ["内地", "韩国", "香港", "台湾", "日本", "美国", "泰国", "英国", "新加坡", "其他"],
  variety: ["内地", "港台", "日韩", "欧美"],
  anime: ["国产", "日本", "欧美", "其他"],
};

const SORT_OPTIONS = [
  { name: "时间", value: "time" },
  { name: "人气", value: "hits" },
  { name: "评分", value: "score" },
];
const SORT_VALUES = SORT_OPTIONS.map((s) => s.value);

// 分类 → 词表分组：6~12,20 属于电影；13~16 属于剧集
function groupOfTid(tid) {
  const id = String(tid || "").trim();
  if (id === "2" || ["13", "14", "15", "16"].indexOf(id) >= 0) return "tv";
  if (id === "3") return "variety";
  if (id === "4") return "anime";
  return "movie";
}

function buildYearOptions() {
  const currentYear = new Date().getFullYear();
  const list = [{ name: "全部", value: "" }];
  for (let y = currentYear + 1; y >= currentYear - 14; y--) {
    list.push({ name: `${y}年`, value: String(y) });
  }
  return list;
}

function buildOptionList(values) {
  return [{ name: "全部", value: "" }].concat(
    (values || []).filter(Boolean).map((v) => ({ name: String(v), value: String(v) }))
  );
}

function buildFilters(tid) {
  const group = groupOfTid(tid);
  return [
    { key: "class", name: "类型", init: "", value: buildOptionList(GENRES[group]) },
    { key: "area", name: "地区", init: "", value: buildOptionList(AREAS[group]) },
    { key: "year", name: "年份", init: "", value: buildYearOptions() },
    { key: "by", name: "排序", init: "", value: SORT_OPTIONS.map((s) => ({ name: s.name, value: s.value })) },
  ];
}

const FILTERS = {};
CLASS_LIST.forEach((item) => {
  FILTERS[String(item.type_id)] = buildFilters(String(item.type_id));
});

// ==================== 通用工具 ====================

function firstDefined() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function safeString(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function cleanText(value) {
  return safeString(value).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function sanitizeLegacyPlayText(value) {
  return cleanText(value).replace(/[#$]/g, " ");
}

function encodeMeta(obj) {
  try {
    return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64");
  } catch (_) {
    return "";
  }
}

function decodeMeta(str) {
  try {
    if (!str) return null;
    const text = Buffer.from(String(str), "base64").toString("utf8");
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : null;
  } catch (_) {
    return null;
  }
}

// 短哈希，避免把超长 key 直接喂给宿主缓存（实战里出现过 256 字节上限）
function shortHash(input) {
  const str = safeString(input);
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

function buildCacheKey(...parts) {
  const raw = parts.map((p) => safeString(p)).join("|");
  if (raw.length <= 180) return CACHE_PREFIX + raw;
  const key = `${CACHE_PREFIX}h:${shortHash(raw)}`;
  logInfo(`缓存 key 过长已哈希归一化 originalBytes=${raw.length} normalized=${key}`);
  return key;
}

function normalizeVideoId(raw) {
  const s = safeString(raw).split("|||")[0].trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\d+$/.test(s)) return `/index.php/vod/detail/id/${s}.html`;
  if (s.charAt(0) === "/") return s;
  return `/${s}`;
}

function normalizeTid(raw) {
  const s = safeString(raw).trim();
  const hit = s.match(/id\/(\d+)/i);
  if (hit) return hit[1];
  const digits = s.replace(/[^0-9]/g, "");
  if (digits) return digits;
  return "1";
}

function resolveUrl(target) {
  const s = safeString(target).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return `https:${s}`;
  if (s.charAt(0) === "/") return activeHost + s;
  return `${activeHost}/${s}`;
}

function absAssetUrl(url) {
  const s = safeString(url).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return `https:${s}`;
  if (s.charAt(0) === "/") return activeHost + s;
  return s;
}

// 站点卡片里会同时挂占位图（load.gif / noneCoverImg）与真实封面，必须过滤占位图
const PLACEHOLDER_IMG = /load\.gif|blank\.gif|placeholder|nonecoverimg|spacer\.gif|img\/load\./i;

function pickImageFromCandidates(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const value = safeString(candidates[i]).trim();
    if (!value) continue;
    if (PLACEHOLDER_IMG.test(value)) continue;
    if (/^data:image/i.test(value)) continue;
    return absAssetUrl(value);
  }
  return "";
}

function isMediaUrl(url) {
  return /\.(m3u8|mp4|flv|avi|mkv|ts|m4v)(\?|#|$)/i.test(safeString(url));
}

// player_data.url 在 HTML 里是 JSON 转义形态，也可能是 JS 拼接，做一层统一清洗
function normalizeUrlValue(value) {
  let s = safeString(value).trim();
  if (!s) return "";
  s = s.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
  s = s.replace(/^["']|["']$/g, "").trim();
  if (s.indexOf("//") === 0) s = `https:${s}`;
  if (/^\/(?!\/)/.test(s)) s = activeHost + s;
  return s;
}

// ==================== 缓存（SDK 优先，进程内 Map 兜底） ====================

const MEM_CACHE = new Map();
const MEM_CACHE_MAX = 100;

async function cacheGet(key) {
  if (!CACHE_OFF && OmniBox && typeof OmniBox.getCache === "function") {
    try {
      const hit = await OmniBox.getCache(key);
      if (hit) return typeof hit === "string" ? hit : safeString(hit);
    } catch (e) {
      logInfo(`读缓存失败，降级进程内缓存 key=${key} err=${e && e.message}`);
    }
  }
  const item = MEM_CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > item.ttl * 1000) {
    MEM_CACHE.delete(key);
    return null;
  }
  return item.value;
}

async function cacheSet(key, value, ttl) {
  if (!value) return;
  if (MEM_CACHE.size > MEM_CACHE_MAX) {
    const oldest = MEM_CACHE.keys().next().value;
    MEM_CACHE.delete(oldest);
  }
  MEM_CACHE.set(key, { value: value, ts: Date.now(), ttl: ttl || 300 });
  if (!CACHE_OFF && OmniBox && typeof OmniBox.setCache === "function") {
    try {
      await OmniBox.setCache(key, value, ttl || 300);
    } catch (e) {
      logInfo(`写缓存失败（不影响主链路）key=${key} err=${e && e.message}`);
    }
  }
}

// ==================== HTTP ====================

function pickResponseBody(res) {
  if (res === undefined || res === null) return "";
  if (typeof res === "string") return res;
  const body = "body" in res ? res.body : ("data" in res ? res.data : res);
  if (body === undefined || body === null) return "";
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return safeString(body);
}

function nativeGet(url, headers, depth) {
  const depthNow = depth || 0;
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return resolve("");
    }
    const mod = parsed.protocol === "https:" ? require("https") : require("http");
    const zlib = require("zlib");
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: Object.assign({}, headers, { "Accept-Encoding": "gzip, deflate, br" }),
      },
      (res) => {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && depthNow < 3) {
          const next = res.headers.location.indexOf("http") === 0 ? res.headers.location : new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(nativeGet(next, headers, depthNow + 1));
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          const enc = safeString(res.headers["content-encoding"]).toLowerCase();
          try {
            if (enc.indexOf("gzip") >= 0) buf = zlib.gunzipSync(buf);
            else if (enc.indexOf("deflate") >= 0) buf = zlib.inflateSync(buf);
            else if (enc.indexOf("br") >= 0) buf = zlib.brotliDecompressSync(buf);
          } catch (_) {}
          resolve(Buffer.from(buf).toString("utf8"));
        });
      }
    );
    req.on("error", () => resolve(""));
    req.setTimeout(15000, () => {
      try { req.destroy(); } catch (_) {}
      resolve("");
    });
    req.end();
  });
}

async function httpGet(url, refererHost) {
  const headers = Object.assign({}, PAGE_HEADERS, {
    Referer: `${refererHost || activeHost}/`,
  });
  if (OmniBox && typeof OmniBox.request === "function") {
    try {
      const res = await OmniBox.request(url, { method: "GET", headers: headers });
      const body = pickResponseBody(res);
      const status = res && typeof res === "object" ? res.statusCode : undefined;
      if (body && (!status || status === 200)) return body;
      logInfo(`SDK 请求未返回可用内容 status=${status} len=${body ? body.length : 0}`);
    } catch (e) {
      logInfo(`SDK 请求异常，尝试原生请求 err=${e && e.message}`);
    }
  }
  try {
    return await nativeGet(url, headers, 0);
  } catch (e) {
    logError("原生请求失败", e && e.message);
    return "";
  }
}

// 403 页只有 500 多字节，空列表页也是这个量级，这里给出下限判断
function isUsablePage(html) {
  const body = safeString(html);
  if (body.length < 800) return false;
  if (/<title>\s*40[0-9]\b/i.test(body) || /<center>40[0-9] Forbidden/i.test(body)) return false;
  return body.indexOf("stui") >= 0 || body.indexOf("<html") >= 0;
}

// 统一入口：主备域容灾 + 可选缓存
async function fetchPage(path, ttl) {
  const key = buildCacheKey("page", path);
  const useCache = !CACHE_OFF && ttl > 0;
  if (useCache) {
    const cached = await cacheGet(key);
    if (cached) {
      logInfo(`命中页面缓存 ${path}`);
      return cached;
    }
  }
  const ordered = [activeHost].concat(HOSTS.filter((h) => h !== activeHost));
  for (let i = 0; i < ordered.length; i++) {
    const host = ordered[i];
    const url = path.indexOf("http") === 0 ? path : host + path;
    const started = Date.now();
    const html = await httpGet(url, host);
    const ok = isUsablePage(html);
    logInfo(`GET ${url} status=usable:${ok} len=${safeString(html).length} cost=${Date.now() - started}ms`);
    if (ok) {
      if (host !== activeHost) logInfo(`切换主域 ${activeHost} -> ${host}`);
      activeHost = host;
      if (useCache) await cacheSet(key, html, ttl);
      return html;
    }
  }
  logError(`抓取失败（全部域名均不可用）path=${path}`);
  return "";
}

// ==================== HTML 解析 ====================

function parseCards(html) {
  if (!html) return [];
  if (cheerio) {
    try {
      const list = parseCardsCheerio(html);
      logInfo(`parseCards(cheerio) -> ${list.length}`);
      return list;
    } catch (e) {
      logError("cheerio 解析卡片失败，回退正则", e && e.message);
    }
  }
  const list = parseCardsRegex(html);
  logInfo(`parseCards(regex) -> ${list.length}`);
  return list;
}

function parseCardsCheerio(html) {
  const $ = cheerio.load(html);
  const list = [];
  const seen = {};
  $(".stui-vodlist__item").each((_, el) => {
    const $el = $(el);
    const $thumb = $el.find("a.stui-vodlist__thumb").first();
    const $link = $thumb.length ? $thumb : $el.find("a[href*='/vod/detail/']").first();
    const href = safeString($link.attr("href") || $el.find("h4 a").attr("href") || "").trim();
    if (!href || href.indexOf("/vod/detail/") < 0) return;
    if (seen[href]) return;
    const title = cleanText(firstDefined($link.attr("title"), $el.find("h4 a").attr("title"), $el.find("h4 a").text(), $link.text()));
    if (!title) return;
    const $img = $link.find("img").first();
    const pic = pickImageFromCandidates([
      $link.attr("data-original"),
      $link.attr("data-src"),
      $link.attr("data-original-douban"),
      $link.attr("data-original-lanlan"),
      $img.attr("data-original"),
      $img.attr("data-src"),
      $img.attr("src"),
      $link.attr("src"),
    ]);
    seen[href] = true;
    list.push({
      vod_id: href,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: cleanText($el.find(".pic-text").first().text()),
    });
  });
  return list;
}

function parseCardsRegex(html) {
  const list = [];
  const seen = {};
  const blocks = safeString(html).split(/<li[^>]*class="[^"]*stui-vodlist__item[^"]*"[^>]*>/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split(/<\/li>/i)[0];
    const hrefHit = block.match(/href="([^"]*\/vod\/detail\/[^"]*)"/i);
    if (!hrefHit) continue;
    const href = hrefHit[1];
    if (seen[href]) continue;
    const titleHit =
      block.match(/title="([^"]+)"/i) ||
      block.match(/<h4[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = cleanText(titleHit ? titleHit[1] : "");
    if (!title) continue;
    const pic = pickImageFromCandidates([
      (block.match(/data-original="([^"]+)"/i) || [])[1],
      (block.match(/data-src="([^"]+)"/i) || [])[1],
      (block.match(/data-original-douban="([^"]+)"/i) || [])[1],
      (block.match(/src="([^"]+)"/i) || [])[1],
    ]);
    const remarkHit = block.match(/<span class="pic-text[^"]*">([\s\S]*?)<\/span>/i);
    seen[href] = true;
    list.push({
      vod_id: href,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: cleanText(remarkHit ? remarkHit[1] : ""),
    });
  }
  return list;
}

// 分类/搜索页总页数：
// 1) 优先 <span class="num">1/2147</span>
// 2) 退到分页 ul.stui-page 内「尾页 / 最大页码」
// 3) 最后兜底为当前页
// 注意：不要在全页做 /page/(\d+) 泛匹配取最大值，页脚等位置的无关 /page/ 链接会把 pagecount 撑大。
function parsePageCount(html, currentPage) {
  const page = Math.max(1, parseInt(currentPage, 10) || 1);
  const body = safeString(html);
  let total = 0;

  if (cheerio) {
    try {
      const $ = cheerio.load(body);
      const numText = $("span.num").first().text() || "";
      const numHit = numText.match(/(\d+)\s*\/\s*(\d+)/);
      if (numHit) total = parseInt(numHit[2], 10) || 0;
      if (!total) {
        $("ul.stui-page").each((_, ul) => {
          if (total) return;
          const $ul = $(ul);
          let maxInBlock = 0;
          $ul.find("a").each((__, a) => {
            const hit = safeString($(a).attr("href")).match(/\/page\/(\d+)/);
            if (hit) maxInBlock = Math.max(maxInBlock, parseInt(hit[1], 10) || 0);
          });
          if (maxInBlock > 0) total = maxInBlock;
        });
      }
    } catch (_) {}
  }

  if (!total) {
    const numHit = body.match(/<span class="num">\s*(\d+)\s*\/\s*(\d+)\s*<\/span>/i);
    if (numHit) total = parseInt(numHit[2], 10) || 0;
  }
  if (!total) {
    const blocks = body.match(/<ul[^>]*class="[^"]*stui-page[^"]*"[^>]*>[\s\S]*?<\/ul>/gi) || [];
    for (let i = 0; i < blocks.length && !total; i++) {
      let maxInBlock = 0;
      const re = /\/page\/(\d+)/g;
      let m;
      while ((m = re.exec(blocks[i])) !== null) {
        maxInBlock = Math.max(maxInBlock, parseInt(m[1], 10) || 0);
      }
      if (maxInBlock > 0) total = maxInBlock;
    }
  }

  return Math.max(page, total || page);
}

// 详情页播放线路必须「按面板配对」：h3.title（线路名）+ 同一个 panel 内的 ul.stui-content__playlist
function parsePlaySources(html) {
  if (!html) return [];
  if (cheerio) {
    try {
      const sources = parsePlaySourcesCheerio(html);
      if (sources.length) return sources;
    } catch (e) {
      logError("cheerio 解析线路失败，回退正则", e && e.message);
    }
  }
  return parsePlaySourcesRegex(html);
}

function pushPlaySource(sources, name, episodes) {
  const list = (episodes || []).filter((ep) => ep && ep.playId);
  if (!list.length) return;
  sources.push({ name: cleanText(name) || `线路${sources.length + 1}`, episodes: list });
}

function parsePlaySourcesCheerio(html) {
  const $ = cheerio.load(html);
  const sources = [];
  $("div.stui-pannel").each((_, panel) => {
    const $panel = $(panel);
    const $head = $panel.find("div.stui-pannel__head h3.title").first();
    const $ul = $panel.find("ul.stui-content__playlist").first();
    if (!$head.length || !$ul.length) return;
    const lineName = cleanText($head.text());
    const episodes = [];
    $ul.find("li a").each((__, a) => {
      const href = safeString($(a).attr("href")).trim();
      if (!href) return;
      episodes.push({ name: cleanText($(a).text()) || `第${episodes.length + 1}集`, playId: href });
    });
    pushPlaySource(sources, lineName, episodes);
  });
  return sources;
}

function parsePlaySourcesRegex(html) {
  const body = safeString(html);
  const sources = [];
  const re = /<ul[^>]*class="[^"]*stui-content__playlist[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const ulStart = m.index;
    const ulHtml = m[1];
    // 最近一个前置 h3.title 就是这条线路的名字（跨面板问题就在这一步被避免）
    const before = body.slice(0, ulStart);
    const heads = [];
    const headRe = /<h3[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi;
    let hm;
    while ((hm = headRe.exec(before)) !== null) heads.push(cleanText(hm[1]));
    const lineName = heads.length ? heads[heads.length - 1] : "";
    const episodes = [];
    const epRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let em;
    while ((em = epRe.exec(ulHtml)) !== null) {
      episodes.push({ name: cleanText(em[2]) || `第${episodes.length + 1}集`, playId: em[1].trim() });
    }
    pushPlaySource(sources, lineName, episodes);
  }
  return sources;
}

// 站点把「类型 / 地区 / 年份」三项塞在同一个 <p class="data"> 里，
// 因此必须按「标签 → 取值」逐项抽取，不能只取 p 里的第一个 span/a，
// 否则地区、年份会静默丢失（旧版 cheerio 分支就是这么漏的）。
function pickLabeledValue(blockHtml, label) {
  const re = new RegExp(
    `<span[^>]*>\\s*${label}\\s*[:：]?\\s*<\\/span>\\s*(?:<a[^>]*>([\\s\\S]*?)<\\/a>|([^<]*))`,
    "i"
  );
  const hit = safeString(blockHtml).match(re);
  if (!hit) return "";
  const first = hit[1];
  if (first !== undefined && first !== null && cleanText(first) !== "") return cleanText(first);
  return cleanText(hit[2]);
}

function parseDetailMeta(html) {
  const meta = {
    vod_name: "",
    vod_pic: "",
    type_name: "",
    vod_area: "",
    vod_year: "",
    vod_remarks: "",
    vod_actor: "",
    vod_director: "",
    vod_content: "",
  };
  if (!html) return meta;

  const body = safeString(html);
  let block = "";
  let content = "";
  let $ = null;

  if (cheerio) {
    try {
      $ = cheerio.load(body);
      const $detail = $("div.stui-content__detail").first();
      if ($detail.length) block = safeString($detail.html());
      meta.vod_name = cleanText($detail.find("h3.title").first().text() || $("h3.title").first().text());
      const $thumb = $("div.stui-content__thumb").first();
      const $img = $thumb.find("img").first();
      meta.vod_pic = pickImageFromCandidates([
        $thumb.find("a.pic").attr("data-original"),
        $img.attr("data-original"),
        $img.attr("data-src"),
        $img.attr("src"),
        $detail.find("img").first().attr("data-original"),
      ]);
      content = cleanText($("div.stui-content__desc").first().text());
    } catch (e) {
      logError("cheerio 解析详情失败，回退正则", e && e.message);
    }
  }

  if (!block) {
    const hit =
      body.match(/<div class="stui-content__detail[^"]*">([\s\S]*?)<div class="playbtn/i) ||
      body.match(/<div class="stui-content__detail[^"]*">([\s\S]*?)<\/div>/i);
    block = hit ? hit[1] : body;
  }

  if (!meta.vod_name) {
    const nameHit =
      body.match(/<div class="stui-content__detail[^"]*">[\s\S]*?<h3 class="title">\s*([^<]+?)\s*<\/h3>/i) ||
      body.match(/<h3 class="title">\s*([^<]+?)\s*<\/h3>/i);
    meta.vod_name = cleanText(nameHit ? nameHit[1] : "");
  }

  if (!meta.vod_pic) {
    const thumbHit = body.match(/<div class="stui-content__thumb[\s\S]{0,1200}?<\/div>/i);
    if (thumbHit) {
      const imgHit = thumbHit[0].match(/data-original="([^"]+)"/i) || thumbHit[0].match(/data-src="([^"]+)"/i);
      meta.vod_pic = pickImageFromCandidates([imgHit ? imgHit[1] : ""]);
    }
  }

  meta.type_name = pickLabeledValue(block, "类型");
  meta.vod_area = pickLabeledValue(block, "地区");
  meta.vod_year = pickLabeledValue(block, "年份").replace(/[^0-9]/g, "").slice(0, 4);
  meta.vod_remarks = pickLabeledValue(block, "状态") || pickLabeledValue(block, "集数");
  meta.vod_actor = pickLabeledValue(block, "主演");
  meta.vod_director = pickLabeledValue(block, "导演");

  if (!content) {
    const descHit = body.match(/<div class="stui-content__desc[^"]*">([\s\S]*?)<\/div>/i);
    content = cleanText(descHit ? descHit[1] : "");
  }
  if (!content) content = pickLabeledValue(block, "简介");
  meta.vod_content = content;
  return meta;
}

// 播放页：var player_data={"flag":…,"url":"https:\/\/…\/index.m3u8","from":"xlm3u8","encrypt":0}
function extractPlayerData(html) {
  const body = safeString(html);
  if (!body) return null;
  const hit =
    body.match(/var\s+player_data\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i) ||
    body.match(/var\s+player_data\s*=\s*(\{[\s\S]*?\})\s*;?\s*var\s/i) ||
    body.match(/var\s+player_data\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/?/i);
  if (hit) {
    try {
      const obj = JSON.parse(hit[1]);
      if (obj && typeof obj === "object") return obj;
    } catch (e) {
      logInfo(`player_data JSON 解析失败，改字段抽取 err=${e && e.message}`);
    }
  }
  // JSON.parse 失败时退到字段抽取，但必须：
  // 1) 只在 player_data 附近找（详情页 var maccms={"url":"app.movie",…} 会污染全页匹配）
  // 2) url 必须是像 URL 的字符串，否则视为没找到，交给上层嗅探兜底
  const anchor = body.search(/player_data/i);
  if (anchor < 0) return null;
  const scope = body.slice(anchor, anchor + 3000);
  const urlHit = scope.match(/"url"\s*:\s*"([^"]+)"/i);
  if (!urlHit) return null;
  const rawUrl = safeString(urlHit[1]).trim();
  if (!/^(https?:)?\/\//i.test(rawUrl.replace(/\\\//g, "/"))) {
    logInfo(`player_data 字段抽取到的 url 不像地址，忽略: ${rawUrl}`);
    return null;
  }
  const fromHit = scope.match(/"from"\s*:\s*"([^"]*)"/i);
  const encHit = scope.match(/"encrypt"\s*:\s*(\d+)/i);
  const nextHit = scope.match(/"url_next"\s*:\s*"([^"]+)"/i);
  return {
    url: rawUrl,
    url_next: nextHit ? nextHit[1] : "",
    from: fromHit ? fromHit[1] : "",
    encrypt: encHit ? parseInt(encHit[1], 10) : 0,
  };
}

function buildLegacyPlayFields(playSources) {
  const sources = Array.isArray(playSources) ? playSources : [];
  if (!sources.length) return { vod_play_from: "", vod_play_url: "", vod_play_list: [] };
  const fromNames = [];
  const urlGroups = [];
  sources.forEach((source) => {
    const episodes = Array.isArray(source && source.episodes) ? source.episodes : [];
    const items = episodes
      .map((ep, index) => {
        const playId = safeString(ep && ep.playId);
        if (!playId) return "";
        const name = sanitizeLegacyPlayText((ep && ep.name) || `第${index + 1}集`) || `第${index + 1}集`;
        return `${name}$${playId}`;
      })
      .filter(Boolean);
    if (!items.length) return;
    fromNames.push(sanitizeLegacyPlayText((source && source.name) || "默认线路") || "默认线路");
    urlGroups.push(items.join("#"));
  });
  return {
    vod_play_from: fromNames.join("$$$"),
    vod_play_url: urlGroups.join("$$$"),
    vod_play_list: sources.map((source) => ({
      name: source && source.name,
      episodes: Array.isArray(source && source.episodes) ? source.episodes.map((ep) => Object.assign({}, ep)) : [],
    })),
  };
}

// ==================== playId 透传 meta ====================

function makePlayId(rawPlayId, meta) {
  const encoded = encodeMeta(meta);
  if (!encoded) return rawPlayId;
  return `${rawPlayId}|||${encoded}`;
}

function splitPlayId(rawPlayId) {
  const raw = safeString(rawPlayId).trim();
  const idx = raw.indexOf("|||");
  if (idx < 0) return { target: raw, meta: null };
  return { target: raw.slice(0, idx), meta: decodeMeta(raw.slice(idx + 3)) };
}

function attachPlayHistory(meta, params) {
  try {
    if (!meta || !OmniBox || typeof OmniBox.addPlayHistory !== "function") return;
    const vodId = safeString(firstDefined(meta.sid, params && params.vodId)).trim();
    const title = safeString(firstDefined(meta.v, params && params.vodName)).trim();
    const episode = safeString(firstDefined(meta.e, params && params.episodeName)).trim();
    if (!vodId || !title || !episode) return;
    const payload = { vodId: vodId, title: title, episode: episode, episodeName: episode };
    const episodeNumber = parseInt(meta.i, 10);
    if (episodeNumber > 0) payload.episodeNumber = episodeNumber;
    OmniBox.addPlayHistory(payload)
      .then(() => logInfo(`播放记录写入成功 vodId=${vodId} episode=${episode}`))
      .catch((e) => logError("播放记录写入失败", e && e.message));
  } catch (e) {
    logError("播放记录写入异常", e && e.message);
  }
}

// ==================== 筛选参数归一化 ====================

function parseFilterSource(raw) {
  if (!raw) return {};
  // 防御：数组不能按下标当成筛选键（宿主有可能把 filters 传成数组）
  if (Array.isArray(raw)) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
      return obj;
    } catch (_) {
      return {};
    }
  }
  return {};
}

// sources 支持数组形式（params.filters / extend / ext / filter 多来源合并）
function normalizeFilters(sources) {
  const list = Array.isArray(sources) ? sources : [sources];
  const merged = {};
  list.forEach((item) => Object.assign(merged, parseFilterSource(item)));
  return merged;
}

function pickIn(value, allowed) {
  const v = safeString(value).trim();
  if (!v) return "";
  return (allowed || []).indexOf(v) >= 0 ? v : "";
}

function pickYear(value) {
  const v = safeString(value).trim().replace(/[^0-9]/g, "");
  if (v.length !== 4) return "";
  const year = parseInt(v, 10);
  const nowYear = new Date().getFullYear();
  if (!year || year < 1900 || year > nowYear + 2) return "";
  return String(year);
}

function normalizeCategoryFilters(tid, rawFilters) {
  const group = groupOfTid(tid);
  const raw = normalizeFilters(rawFilters);
  const result = {
    class: pickIn(firstDefined(raw.class, raw.type), GENRES[group]),
    area: pickIn(raw.area, AREAS[group]),
    year: pickYear(raw.year),
    by: pickIn(firstDefined(raw.by, raw.sort), SORT_VALUES),
  };
  const dropped = [];
  Object.keys(raw).forEach((k) => {
    if (["class", "type", "area", "year", "by", "sort"].indexOf(k) < 0) dropped.push(k);
  });
  if (dropped.length) logInfo(`忽略未知筛选键: ${dropped.join(",")}`);
  return result;
}

// 站点前台自产链接的顺序：area → by → class → id → page → year
function buildCategoryPath(tid, page, filters) {
  const segments = [];
  if (filters.area) segments.push(`area/${encodeURIComponent(filters.area)}`);
  if (filters.by) segments.push(`by/${encodeURIComponent(filters.by)}`);
  if (filters.class) segments.push(`class/${encodeURIComponent(filters.class)}`);
  segments.push(`id/${encodeURIComponent(tid)}`);
  if (page > 1) segments.push(`page/${page}`);
  if (filters.year) segments.push(`year/${encodeURIComponent(filters.year)}`);
  return `/index.php/vod/show/${segments.join("/")}.html`;
}

// ==================== 五个 handler ====================

async function home(params, context) {
  const from = (context && context.from) || "web";
  logInfo(`home 入参 params=${JSON.stringify(params || {})} from=${from}`);
  try {
    const html = await fetchPage("/", TTL.home);
    const list = parseCards(html).slice(0, 60);
    logInfo(`home 完成 分类=${CLASS_LIST.length} 推荐=${list.length}`);
    return { class: CLASS_LIST, list: list, filters: FILTERS };
  } catch (e) {
    logError("home 失败", e && e.message);
    return { class: CLASS_LIST, list: [], filters: FILTERS };
  }
}

async function category(params, context) {
  const p = params || {};
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  const tid = normalizeTid(firstDefined(p.categoryId, p.category_id, p.type_id, p.tid, p.id, "1"));
  const filters = normalizeCategoryFilters(tid, [p.filters, p.extend, p.ext, p.filter]);
  const path = buildCategoryPath(tid, page, filters);
  logInfo(`category 入参 categoryId=${tid} page=${page} filters=${JSON.stringify(filters)} path=${path}`);
  try {
    const html = await fetchPage(path, TTL.category);
    const list = parseCards(html);
    const pagecount = parsePageCount(html, page);
    logInfo(`category 完成 tid=${tid} page=${page} pagecount=${pagecount} list=${list.length}`);
    return { page: page, pagecount: pagecount, total: list.length, list: list, filters: FILTERS[tid] || buildFilters(tid) };
  } catch (e) {
    logError("category 失败", e && e.message);
    return { page: page, pagecount: page, total: 0, list: [], filters: FILTERS[tid] || buildFilters(tid) };
  }
}

function collectDetailIds(params) {
  const p = params || {};
  const raw = firstDefined(p.videoId, p.video_id, p.vod_id, p.ids, p.id, p.vid);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => safeString(v)).filter(Boolean);
  return safeString(raw).split(",").map((s) => s.trim()).filter(Boolean);
}

async function detail(params, context) {
  const p = params || {};
  const ids = collectDetailIds(p);
  logInfo(`detail 入参 params=${JSON.stringify(p)} ids=${JSON.stringify(ids)}`);
  if (!ids.length) {
    logError("detail 未拿到 videoId");
    return { list: [] };
  }
  const result = [];
  for (let i = 0; i < ids.length; i++) {
    const rawId = ids[i];
    const path = normalizeVideoId(rawId);
    if (!path) continue;
    try {
      const html = await fetchPage(path, TTL.detail);
      if (!html) {
        logError(`detail 页面为空 id=${rawId}`);
        continue;
      }
      const meta = parseDetailMeta(html);
      let playSources = parsePlaySources(html);
      const numHit = path.match(/\/id\/(\d+)/);
      const videoId = numHit ? numHit[1] : String(rawId).replace(/[^0-9]/g, "");
      const vodName = meta.vod_name || "";
      const pic = meta.vod_pic || "";

      // 每集带一份轻量 meta，play() 才能命中刮削/播放记录链路
      playSources = playSources.map((source, sIdx) => ({
        name: source.name,
        episodes: source.episodes.map((ep, eIdx) => ({
          name: ep.name,
          playId: makePlayId(ep.playId, {
            sid: videoId,
            ln: source.name || `线路${sIdx + 1}`,
            v: vodName,
            e: ep.name,
            i: eIdx + 1,
          }),
        })),
      }));

      const legacy = buildLegacyPlayFields(playSources);
      const lineNames = playSources.map((s) => s.name);
      const episodeCount = playSources.reduce((sum, s) => sum + s.episodes.length, 0);
      logInfo(`detail 解析 id=${videoId} name=${vodName} lineOrder=${JSON.stringify(lineNames)} episodes=${episodeCount}`);

      const vod = {
        vod_id: videoId || String(rawId),
        videoId: videoId || String(rawId),
        vod_name: vodName,
        vod_pic: pic,
        type_name: meta.type_name,
        vod_year: meta.vod_year,
        vod_area: meta.vod_area,
        vod_remarks: meta.vod_remarks,
        vod_actor: meta.vod_actor,
        vod_director: meta.vod_director,
        vod_content: meta.vod_content,
        vod_play_from: legacy.vod_play_from,
        vod_play_url: legacy.vod_play_url,
        vod_play_list: legacy.vod_play_list,
        vod_play_sources: playSources,
      };
      if (!playSources.length) {
        logInfo(`detail 无线路 id=${videoId} htmlLen=${html.length} hasPlaylist=${html.indexOf("stui-content__playlist") >= 0}`);
      }
      result.push(vod);
    } catch (e) {
      logError(`detail 失败 id=${rawId}`, e && e.message);
    }
  }
  logInfo(`detail 完成 返回=${result.length}`);
  return { list: result };
}

async function search(params, context) {
  const p = params || {};
  const keyword = safeString(firstDefined(p.keyword, p.wd, p.key, p.word)).trim();
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  logInfo(`search 入参 keyword=${keyword} page=${page}`);
  if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };
  const path =
    page > 1
      ? `/index.php/vod/search/page/${page}/wd/${encodeURIComponent(keyword)}.html`
      : `/index.php/vod/search.html?wd=${encodeURIComponent(keyword)}`;
  try {
    const html = await fetchPage(path, TTL.search);
    const list = parseCards(html);
    const pagecount = parsePageCount(html, page);
    logInfo(`search 完成 keyword=${keyword} page=${page} pagecount=${pagecount} list=${list.length}`);
    return { page: page, pagecount: pagecount, total: list.length, list: list };
  } catch (e) {
    logError("search 失败", e && e.message);
    return { page: page, pagecount: page, total: 0, list: [] };
  }
}

function buildPlayResult(mediaUrl, name, flag, meta, params) {
  attachPlayHistory(meta, params);
  return {
    urls: [{ name: name || "播放", url: mediaUrl }],
    flag: flag || "play",
    header: playHeaders(),
    parse: 0,
  };
}

async function play(params, context) {
  const p = params || {};
  const flag = p.flag || "play";
  const rawPlayId = safeString(firstDefined(p.playId, p.url, p.id, p.videoId)).trim();
  const split = splitPlayId(rawPlayId);
  const meta = split.meta;
  const target = split.target;
  logInfo(`play 入参 playId=${rawPlayId ? rawPlayId.slice(0, 120) : "(空)"} flag=${flag} hasMeta=${!!meta}`);
  if (!target) return { urls: [], flag: flag, parse: 0 };

  // 1) 已经是媒体直链
  if (isMediaUrl(target)) {
    logInfo(`playId 即媒体直链: ${target}`);
    return buildPlayResult(target, "直链", flag, meta, p);
  }

  try {
    const url = resolveUrl(target);
    logInfo(`play 请求播放页: ${url}`);
    const html = await httpGet(url, activeHost);

    // 2) 站点 player_data 直链
    if (html) {
      const pd = extractPlayerData(html);
      if (pd) {
        const media = normalizeUrlValue(pd.url);
        logInfo(`player_data 命中 from=${pd.from || ""} encrypt=${pd.encrypt} url=${media}`);
        if (media && isMediaUrl(media)) {
          return buildPlayResult(media, pd.from || "播放", flag, meta, p);
        }
        if (media) {
          logInfo(`player_data.url 非媒体直链，先尝试 SDK 嗅探: ${media}`);
          const sniffedFromPlayer = await sniffWithSdk(media, p, flag, meta);
          if (sniffedFromPlayer) return sniffedFromPlayer;
        }
      } else {
        logInfo("未找到 player_data，尝试页面内 m3u8 兜底");
        const fallbackHit =
          html.match(/["']url["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
          html.match(/https?:[\\/]{2}[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/i);
        if (fallbackHit) {
          const media = normalizeUrlValue(fallbackHit[1] || fallbackHit[0]);
          if (media && isMediaUrl(media)) {
            logInfo(`页面 m3u8 兜底命中: ${media}`);
            return buildPlayResult(media, "页面直链", flag, meta, p);
          }
        }
      }
    }

    // 3) SDK 嗅探播放页
    const sniffed = await sniffWithSdk(url, p, flag, meta);
    if (sniffed) return sniffed;

    // 4) 回退客户端嗅探
    logInfo(`回退客户端嗅探: ${url}`);
    attachPlayHistory(meta, p);
    return { urls: [{ name: "播放页", url: url }], flag: flag, header: playHeaders(), parse: 1 };
  } catch (e) {
    logError("play 失败", e && e.message);
    const fallbackUrl = resolveUrl(target);
    attachPlayHistory(meta, p);
    return { urls: [{ name: "播放页", url: fallbackUrl }], flag: flag, header: playHeaders(), parse: 1 };
  }
}

async function sniffWithSdk(url, params, flag, meta) {
  try {
    if (!OmniBox || typeof OmniBox.sniffVideo !== "function") return null;
    const sniffed = await OmniBox.sniffVideo(url, playHeaders());
    const sniffUrl =
      safeString(sniffed && sniffed.url) ||
      safeString(sniffed && Array.isArray(sniffed.urls) && sniffed.urls[0] && sniffed.urls[0].url);
    if (!sniffUrl) {
      logInfo(`SDK 嗅探未命中: ${url}`);
      return null;
    }
    logInfo(`SDK 嗅探成功: ${sniffUrl}`);
    const result = {
      urls: [{ name: "嗅探线路", url: sniffUrl }],
      flag: flag || "play",
      header: (sniffed && sniffed.header) || playHeaders(),
      parse: isMediaUrl(sniffUrl) ? 0 : 1,
    };
    attachPlayHistory(meta, params);
    return result;
  } catch (e) {
    logError(`SDK 嗅探失败 ${url}`, e && e.message);
    return null;
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
