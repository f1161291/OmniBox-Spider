// @name AVJiali
// @version 1.0.0
// @author omnibox-spider
// @description avjiali.com（AV Jiali 国产 AV / WordPress）采集源：首页推荐 + 29 个分类 + 全部视频分页 + 关键词搜索分页；详情页 JSON-LD 取标题/时长/演员/简介，公开层只有 77 秒 HD 预告片直链（明确标注），正片在 members.avjiali.com 会员墙后；列表广告过滤、短 TTL 缓存、直链→sniff→parse=1 三段式兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/AVJiali.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-15 实测，改代码前先读这段）
 * 1) 主域 https://avjiali.com，nginx，无 Cloudflare / JS cookie 挑战；常规 UA + Referer 即可。
 *    多语言路径 /zh/ /ja/ 也存在，但结构与主路径一致，本源统一走主路径。
 * 2) 路由（WordPress 伪静态）：
 *      - 全部视频   /chinese-av/           分页 /chinese-av/page/N/
 *      - 分类       /<slug>/              分页 /<slug>/page/N/（29 个，见 CLASS_LIST）
 *      - 分类索引   /categories/           （仅索引页，不用于取列表）
 *      - 模特       /model/<slug>/         分页同上（本源归到「模特」分类可选）
 *      - 搜索       /?s=<关键词>           分页 /page/N/?s=<关键词>
 *      - 详情       /avji-<code>/           例 /avji-an9-072/
 *    搜索必须用 ?s=（WordPress 原生）；/search?q= 会 301，别用。
 * 3) 列表卡片：<div class="thumb-videos flex"> > <div class="thumb"> >
 *      <a class="block2" title="..." href="https://avjiali.com/avji-xxx/">
 *        <img class="rounded" src="//static.avjiali.com/.../big.jpg" srcset="...">
 *      </a> ... <p>标题</p>
 *    封面优先 srcset 里的 2x（1200x675），回退 src；番号从 href 的 /avji-xxx/ 提取（大写）。
 *    页面上还有 join/signup 等外链，必须只保留 host 为本站且路径形如 /avji-.../ 的链接。
 * 4) 分页：<nav class="nav"> 里的 <a class="page-numbers" href="...page/N/">，
 *    取所有 N 的最大值即 pagecount；末页没有 next 也照常取最大页码。
 * 5) 详情页关键：这是付费会员站（导航有 join.avjiali.com / members.avjiali.com）。
 *    公开层 HTML 只提供**预告片**：
 *      - <video id="videohtml5tour" class="videoTrailer"> <source src="//trailers.avjiali.com/
 *        <token>/<exp>/content/videos/AVJI-XXX/avjiali_AVJI-XXX_en_trailer_hd.mp4">
 *      - JSON-LD (application/ld+json, @type=VideoObject) 里的 contentUrl 是
 *        static.avjiali.com/.../avjiali_AVJI-XXX_ja_trailer_hd.mp4（日语版预告）
 *      - JSON-LD 另有 duration:"PT61M12S"（正片 61 分钟）、uploadDate、actor[].name
 *    实测抽 4 个详情页（avji-an9-072 / avji-ency-012 / avji-240 / avji-home-004）
 *    全部只有 _trailer_hd.mp4，没有 m3u8，没有任何正片直链；
 *    ffprobe 实测 en_trailer 时长 76.893483 秒（约 77 秒），而 duration 标 61 分钟。
 *    结论：**这是会员授权，不是地址混淆**（与 91Porn 的 strencode2 解码场景本质不同），
 *    页面里根本不存在正片 URL，无法靠解码/构造路径拿到。
 * 6) 本源做法：
 *    - 播放返回两个可播线路：EN 预告（trailers 带签名）/ JA 预告（static 直链），均 parse=0；
 *    - 线路名与 vod_remarks / vod_content 明确写「预告·约77秒·正片需会员」，
 *      避免用户误以为播放器坏了；
 *    - SITE_COOKIE 若配了会员登录态，detail/play 会重新抓一次详情页，
 *      一旦页面里出现非 trailer 的媒体直链就自动改播正片（无需改代码）。
 * 7) data 里的 & 需 decodeHTML（&amp;）；带 query 的 mp4/m3u8 一律 parse=0。
 *
 * 【环境变量】（优先复用仓库既有命名）
 *  SITE_HOST          站点基址，默认 https://avjiali.com
 *  SITE_COOKIE        可选，members.avjiali.com 会员登录态；带上后若页面下发正片会自动切
 *  JIALI_CACHE_TTL    列表页缓存秒数，默认 600（本源独有问题，避免与其它站 TTL 串用）
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.catch 兜住。
 */

const crypto = require("crypto");

let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) { cheerio = null; }

let OmniBox;
try { OmniBox = require("omnibox_sdk"); }
catch (_) {
  OmniBox = { log() { /* 本地调试：不写 stdout */ }, sniffVideo: async () => "" };
}
let runner;
try { runner = require("spider_runner"); } catch (_) { runner = { run() {} }; }

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://avjiali.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return "https://avjiali.com"; }
}

const HOST = normalizeHost(process.env.SITE_HOST || "https://avjiali.com");
const SITE_COOKIE = String(process.env.SITE_COOKIE || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_TTL = Math.max(0, Number(process.env.JIALI_CACHE_TTL || 600) || 600);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.min(180, Math.round(BASE_TTL * 0.3)));
const CACHE_PREFIX = "jiali:page:";

// /categories/ 页实测的 29 个分类（英文 slug + 英文原名）
const CLASS_LIST = [
  { type_id: "chinese-av", type_name: "全部视频" },
  { type_id: "blowjob", type_name: "口交 Blowjob" },
  { type_id: "bondage", type_name: "束缚 Bondage" },
  { type_id: "close-up", type_name: "特写 Close Up" },
  { type_id: "creampie", type_name: "中出 Creampie" },
  { type_id: "cumshot", type_name: "射精 Cumshot" },
  { type_id: "facial-cumshot", type_name: "颜射 Facial" },
  { type_id: "fingering", type_name: "指交 Fingering" },
  { type_id: "foot-job", type_name: "足交 Foot Job" },
  { type_id: "hand-job", type_name: "手淫 Hand Job" },
  { type_id: "lesbians", type_name: "女同 Lesbians" },
  { type_id: "outdoor", type_name: "户外 Outdoor" },
  { type_id: "spread-pussy", type_name: "掰穴 Spread" },
  { type_id: "tits-job", type_name: "乳交 Tits Job" },
  { type_id: "toys", type_name: "玩具 Toys" },
  { type_id: "big-tits", type_name: "巨乳 Big Tits" },
  { type_id: "hairy-pussy", type_name: "多毛 Hairy" },
  { type_id: "piercing", type_name: "穿孔 Piercing" },
  { type_id: "shaved-pussy", type_name: "白虎 Shaved" },
  { type_id: "small-tits", type_name: "贫乳 Small Tits" },
  { type_id: "tattoos", type_name: "纹身 Tattoos" },
  { type_id: "trimmed-pussy", type_name: "修剪 Trimmed" },
  { type_id: "cheongsam", type_name: "旗袍 Cheongsam" },
  { type_id: "cosplay", type_name: "角色扮演 Cosplay" },
  { type_id: "housewife", type_name: "人妻 Housewife" },
  { type_id: "maid", type_name: "女仆 Maid" },
  { type_id: "nurse", type_name: "护士 Nurse" },
  { type_id: "office-lady", type_name: "OL Office Lady" },
  { type_id: "teacher", type_name: "教师 Teacher" },
  { type_id: "uniform-cosplay", type_name: "制服 Uniform" },
];

const PREFIX = "[jiali]";
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
function buildCacheKey(url, cookie) {
  const key = `${CACHE_PREFIX}${md5(`${url}|${cookie || ""}`)}`;
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
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: `${HOST}/`,
    ...(options.headers || {}),
  };
  if (SITE_COOKIE) headers.Cookie = SITE_COOKIE;
  const res = await OmniBox.request(url, {
    method: options.method || "GET", headers, timeout: options.timeout || 20000,
  });
  if (!res || Number(res.statusCode) !== 200) throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  return String(res.body || "");
}
async function fetchHtml(url, ttl) {
  const key = buildCacheKey(url, SITE_COOKIE);
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

/** 从详情 URL 提取番号，如 /avji-an9-072/ -> AVJI-AN9-072 */
function extractCode(href) {
  const m = String(href || "").match(/\/avji-([a-z0-9-]+)\/?/i);
  return m ? `AVJI-${m[1].toUpperCase()}` : "";
}

function isDetailPath(pathname) {
  return /^\/avji-[a-z0-9-]+\/?$/i.test(pathname);
}

function pickCover($a) {
  const $img = $a.find("img").first();
  const srcset = ($img.attr("srcset") || "").trim();
  if (srcset) {
    // 取 2x（1200x675）那张，画质更好
    const parts = srcset.split(",").map((x) => x.trim());
    const hi = parts.find((x) => /\b2x\s*$/i.test(x)) || parts[parts.length - 1];
    const u = (hi || "").split(/\s+/)[0];
    if (u && !/^data:/i.test(u)) return absUrl(u);
  }
  const src = ($img.attr("src") || "").trim();
  if (src && !/^data:/i.test(src)) return absUrl(src);
  return "";
}

function parseList(html, tag) {
  const $ = loadHtml(html);
  const list = [];
  const seen = new Set();
  $("div.thumb-videos").each((_, node) => {
    const $box = $(node);
    const $a = $box.find("a.block2").first();
    const href = $a.attr("href") || "";
    if (!href) return;
    // 只收本站详情链接，过滤 join/models/广告外链
    let pathname = "";
    try { pathname = new URL(absUrl(href)).pathname; } catch (_) { return; }
    if (!isDetailPath(pathname)) return;
    if (seen.has(pathname)) return;
    seen.add(pathname);

    const title = cleanText($a.attr("title") || $box.find("p").first().text() || $a.find("img").attr("alt") || "");
    if (!title) return;
    const pic = pickCover($a);
    const code = extractCode(pathname);

    list.push({
      vod_id: pathname,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: code ? `${code} · 预告` : "预告",
      vod_tag: "video",
      code,
      _tag: tag || "",
    });
  });
  return list;
}

function parsePageCount(html) {
  const $ = loadHtml(html);
  let max = 1;
  $("nav.nav a.page-numbers, a.page-numbers").each((_, node) => {
    const href = $(node).attr("href") || "";
    const m = href.match(/\/page\/(\d+)\/?/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
    const txt = parseInt($(node).text().trim(), 10);
    if (Number.isFinite(txt) && txt > max) max = txt;
  });
  // 兜底：全页找 page/N/
  for (const m of html.matchAll(/\/page\/(\d+)\/?/g)) max = Math.max(max, parseInt(m[1], 10));
  return max;
}
function pageResult(list, page, pagecount) {
  return {
    page: Number(page) || 1, pagecount: Number(pagecount) || 1,
    total: list.length, limit: list.length, list,
  };
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
  const slug = String(typeId || "chinese-av").replace(/^\/+|\/+$/g, "") || "chinese-av";
  const base = `${HOST}/${slug}/`;
  return Number(page) > 1 ? `${base}page/${page}/` : base;
}

async function category(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const typeId = String(params?.categoryId || params?.type_id || "chinese-av");
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
    // WordPress 原生搜索：/?s=KW，分页 /page/N/?s=KW
    const base = page > 1 ? `${HOST}/page/${page}/` : `${HOST}/`;
    const url = `${base}?s=${encodeURIComponent(keyword)}`;
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
  const s = decodeHTML(String(raw || "")).trim();
  if (!s) return "";
  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try { path = new URL(s).pathname; } catch (_) { return ""; }
  }
  if (!path.startsWith("/")) path = `/${path}`;
  if (!isDetailPath(path)) return "";
  return path.replace(/\/+$/, "") + "/";
}

/** 解析 JSON-LD VideoObject */
function parseJsonLd(html) {
  const $ = loadHtml(html);
  let out = {};
  $('script[type="application/ld+json"]').each((_, node) => {
    try {
      const d = JSON.parse($(node).html() || "{}");
      if (d && (d["@type"] === "VideoObject" || d.name)) out = d;
    } catch (_) {}
  });
  return out;
}

function parseDuration(iso) {
  const m = String(iso || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return "";
  const h = parseInt(m[1] || 0, 10), mi = parseInt(m[2] || 0, 10), s = parseInt(m[3] || 0, 10);
  const total = h * 3600 + mi * 60 + s;
  if (!total) return "";
  const mm = Math.floor(total / 60), ss = total % 60;
  return `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** 从详情页抽取所有可播媒体直链：区分预告片与正片 */
function extractMedia(html) {
  const trailers = [];
  const full = [];
  const push = (u, arr) => {
    const v = absUrl(decodeHTML(u));
    if (!v || !/\.(mp4|m3u8|webm|mkv|flv)(\?|$)/i.test(v)) return;
    if (!arr.includes(v)) arr.push(v);
  };
  // <video> 的 <source src>
  const $ = loadHtml(html);
  $("video source[src]").each((_, n) => push($(n).attr("src"), trailers));
  // JSON-LD contentUrl（ja 预告）
  const ld = parseJsonLd(html);
  if (ld.contentUrl) push(ld.contentUrl, trailers);
  // 全页裸直链
  for (const m of html.matchAll(/(?:https?:)?\/\/[^\s"'<>()]+\.(?:mp4|m3u8)[^\s"'<>()]*/gi)) {
    const u = m[0];
    if (/trailer/i.test(u)) push(u, trailers);
    else push(u, full); // 非 trailer 的直链 = 疑似正片
  }
  return { trailers, full, ld };
}

async function detail(params, context) {
  const path = normalizeDetailPath(params?.videoId || params?.vod_id);
  try {
    if (!path) { log("info", "[detail] videoId 为空"); return { list: [] }; }
    const detailUrl = `${HOST}${path}`;
    log("info", `[detail] path=${path}, from=${context?.from || "web"}`);
    log("info", `[detail] 请求 URL=${detailUrl}`);
    const html = await fetchHtml(detailUrl, DETAIL_TTL);
    const { trailers, full, ld } = extractMedia(html);
    const $ = loadHtml(html);
    const title = cleanText($("meta[property='og:title']").attr("content") || ld.name || "");
    const pic = absUrl($("meta[property='og:image']").attr("content") || ld.thumbnailUrl || "");
    const desc = cleanText($("meta[property='og:description']").attr("content") || ld.description || "");
    const actor = Array.isArray(ld.actor) ? ld.actor.map((a) => a && a.name).filter(Boolean).join("、") : "";
    const duration = parseDuration(ld.duration);
    const code = extractCode(path);
    const hasFull = full.length > 0;

    log("info", `[detail] title=${title || "(无)"}, 预告=${trailers.length}, 正片=${full.length}, duration=${duration || "-"}`);

    const sources = [];
    if (hasFull) {
      // 会员态拿到了正片：排第一，名称直接写正片
      sources.push({
        name: "正片❤️",
        episodes: full.map((u, i) => ({ name: `正片${full.length > 1 ? i + 1 : ""}`, playId: `${path}|||${u}` })),
      });
    }
    if (trailers.length) {
      sources.push({
        name: "预告（约77秒）",
        episodes: trailers.map((u, i) => ({
          name: /_ja_/i.test(u) ? "预告·日语版" : "预告·英语版",
          playId: `${path}|||${u}`,
        })),
      });
    }
    if (!sources.length) {
      sources.push({ name: "播放页", episodes: [{ name: "播放", playId: detailUrl }] });
    }

    const remarkParts = [code, duration].filter(Boolean);
    const remarks = hasFull
      ? [...remarkParts, "完整"].join(" · ")
      : [...remarkParts, "预告·约77秒"].join(" · ");
    const content = [
      desc,
      actor ? `演员：${actor}` : "",
      hasFull
        ? "会员登录态已生效，播放正片。"
        : "本站为付费会员站：公开页面仅提供约 77 秒 HD 预告片，正片位于 members.avjiali.com 会员墙后，页面内不存在正片直链。配置 SITE_COOKIE（会员登录态）后，若站点下发正片链接，脚本会自动切换。",
    ].filter(Boolean).join("\n");

    return {
      list: [{
        vod_id: path,
        vod_name: title || code || `AV Jiali ${path}`,
        vod_pic: pic,
        vod_content: content,
        vod_remarks: remarks,
        vod_tag: hasFull ? "完整" : "预告",
        vod_actor: actor,
        vod_duration: duration,
        vod_play_sources: sources,
        // 兼容宿主旧展示链路
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
  return /\.(m3u8|mp4|webm|mkv|flv)(\?|$)/i.test(String(u || ""));
}

async function play(params, context) {
  try {
    const raw = String(params?.playId || params?.play_id || params?.ids || "").trim();
    const flag = String(params?.flag || "jiali");
    log("info", `[play] playId=${raw.slice(0, 160)}, flag=${flag}, from=${context?.from || "web"}`);
    if (!raw) throw new Error("playId 不能为空");

    const headers = { "User-Agent": UA, Referer: `${HOST}/`, Accept: "*/*", Origin: HOST };
    let url = "";
    let path = "";
    if (raw.includes("|||")) {
      const i = raw.indexOf("|||");
      path = normalizeDetailPath(raw.slice(0, i));
      url = absUrl(decodeHTML(raw.slice(i + 3).trim()));
    } else if (/^https?:\/\//i.test(raw)) {
      url = decodeHTML(raw);
    } else {
      path = normalizeDetailPath(raw);
    }

    // 已是直链：直接返回
    if (url && isMediaUrl(url)) {
      const isTrailer = /trailer/i.test(url);
      log("info", `[play] 直链 parse=0, ${isTrailer ? "预告" : "正片"}: ${url.slice(0, 120)}`);
      return {
        urls: [{ name: isTrailer ? "预告（约77秒）" : "正片", url }],
        flag, header: headers, parse: 0,
      };
    }

    // 只有详情路径：回源重新解析（会员 Cookie 生效时能拿到正片）
    if (path) {
      const detailUrl = `${HOST}${path}`;
      log("info", `[play] 回源解析: ${detailUrl}`);
      const html = await fetchHtml(detailUrl, DETAIL_TTL);
      const { trailers, full } = extractMedia(html);
      const pick = full[0] || trailers[0] || "";
      if (pick && isMediaUrl(pick)) {
        const isTrailer = /trailer/i.test(pick);
        log("info", `[play] 解析到 ${isTrailer ? "预告" : "正片"}，parse=0`);
        return {
          urls: [{ name: isTrailer ? "预告（约77秒）" : "正片", url: pick }],
          flag, header: headers, parse: 0,
        };
      }
      // 拿不到直链：SDK 嗅探 → parse=1
      if (typeof OmniBox.sniffVideo === "function") {
        try {
          const sniffed = await OmniBox.sniffVideo(detailUrl, headers);
          const su = typeof sniffed === "string" ? sniffed.trim() : String(sniffed?.url || "");
          if (su && isMediaUrl(su)) {
            log("info", `[play] SDK 嗅探成功: ${su.slice(0, 120)}`);
            return { urls: [{ name: "嗅探", url: su }], flag, header: headers, parse: 0 };
          }
        } catch (e) { log("info", `[play] SDK 嗅探失败: ${e?.message || e}`); }
      }
      log("info", "[play] 未解出直链，回退 parse=1 嗅探");
      return { urls: [{ name: "播放页", url: detailUrl }], flag, header: headers, parse: 1 };
    }

    throw new Error("无法解析播放地址");
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag: params?.flag || "jiali", header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
