// @name 91porna
// @version 1.0.1
// @author omnibox-spider
// @description 91porna 分流站采集源：5 个内置镜像域名健康度轮换（web5/web6/web8/web9/061a），不再从发布页/地址页拉取新域名；/comic/index/detail?video_key= 详情，POST /api/videos/{id}/playback 取 streams.main 正片 m3u8；分类/搜索/分页、短 TTL 缓存、最高档直出
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91porna.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-15 实测，改代码前先读这段）
 * 1) 这是 91porna 分流体系，与老 91porn.com（view_video.php?viewkey= / strencode2）**不是同一套程序**。
 *    实测 5 个分流域名全部 HTTP 200、返回同一套站：
 *      https://web5.rgwgedvt.cc    主入口
 *      https://web6.jddhvwbzx.cc   极速线路
 *      https://web8.jddhvwbzx.cc   智能路由
 *      https://web9.jddhvwbzx.cc   兜底线路（负载高）
 *      https://061a.rgwgedvt.cc    页脚标注的「91porn最新地址」
 *    5 个域名的 POST /api/videos/451950/playback 全部返回 status:1 + streams.main，可安全轮换。
 *    页脚原文：<strong>91porn最新地址：</strong><a href="https://061a.rgwgedvt.cc">...
 *    说明：061a 作为内置域名放在首位，脚本不再从 /comic/index/links 等地址页动态拉取更多备用域。
 * 2) 路由（Tailwind + 自研前端）：
 *      - 首页 /
 *      - 分类 /comic/index/video?category={slug}   （play 正在播放 / now_month_hot 热门 /
 *        original 国产原创 / new_update 更多；另 /comic/index/av 日本AV）
 *      - 分页 ?page=N（实测生效；?p=N 无效）
 *      - 搜索 /comic/index/search?keyword={kw}     （中文需 encodeURIComponent）
 *      - 详情 /comic/index/detail?video_key={数字id}
 * 3) 列表卡片：<ul class="video-items"> > li > div.video-item
 *      a[href*="/comic/index/detail?video_key="] 为详情链接；
 *      封面 img[data-src]（img[src] 是 /static/web/images/poster_loading.svg 占位，必须跳过）；
 *      标题 div.line-clamp-2 文本 或 img[alt]；时长在 poster 底部 div 文本（如 15:42）。
 *      vod_id 用 "video_key={id}" 或纯数字 id，play() 据此拼接口。
 * 4) 【播放·核心】详情页 HTML 里没有裸 m3u8/mp4。有 JSON <script id="cdn-config"> 带
 *      data-video_cdn_auth_key="x-cdn-auth" / data-video_cdn_auth_value=... / data-cdn_app="065"，
 *      并引入 xgplayer.js + hls.js + 内联混淆脚本。解混淆后的主播放器调用是：
 *        start(el, function(){ return request('/api/videos/{id}/playback', {}) }, ...)
 *      其中 request() 为 fetch(path,{method:'POST',credentials:'same-origin',
 *        headers:{'Content-Type':'application/json'},body:JSON.stringify({})}),
 *      并校验 result.status===1 && result.data.manifest_method==='GET'。
 *    实测 POST /api/videos/451950/playback -> 200：
 *      { data:{ streams:{ main:"https://yd-jhph-hls.hzjvlo.cn/videos5/....m3u8?auth_key=...\\u0026v=3...",
 *                        hevc:"", preview:"..." }, cdn:{app:"065",authKey:"x-cdn-auth",...} }, status:1 }
 *    main 即正片 m3u8（AES-128 加密 HLS），里面的 \u0026 必须还原成 &。
 *    实测 m3u8 HTTP 200（37814B），ts 分片与 crypt.key 均 200，播放链完整可用。
 *    注意：另有 /api/posts/{id}/playback 与 /api/media/playback/previews 两套接口，
 *    分别给「文章内嵌视频」和「卡片悬停预览」用，主播放走 /api/videos/{id}/playback。
 * 5) 【域名轮换】HOSTS 按健康度排序：被判定失败/拦截的域名在 PORNA_ROTATE_COOLDOWN（默认 600s）
 *    内降权；成功过的域名写回 PREFERRED，后续请求优先复用它。全部域名失败时，
 *    不再从地址页拉取新域名，仅在本脚本内置域名池内重试。
 *
 * 【环境变量】
 *  PORNA_HOSTS             逗号分隔覆盖默认 5 域名（优先级最高）
 *  PORNA_HOST              单域名覆盖（简写）
 *  PORNA_CACHE_TTL         列表页缓存秒数，默认 300
 *  PORNA_ROTATE_COOLDOWN   失败域名降权秒数，默认 600
 *  SITE_COOKIE             可选，站点登录态 Cookie
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

function normalizeHost(v) {
  const raw = String(v || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return ""; }
}

// 默认 5 个分流域名（实测全部可用）。061a 是页脚标注的「最新地址」，放首位。
const DEFAULT_HOSTS = [
  "https://061a.rgwgedvt.cc",
  "https://web5.rgwgedvt.cc",
  "https://web6.jddhvwbzx.cc",
  "https://web8.jddhvwbzx.cc",
  "https://web9.jddhvwbzx.cc",
];

const HOSTS = (() => {
  const raw = String(process.env.PORNA_HOSTS || process.env.PORNA_HOST || "").trim();
  const list = raw
    ? raw.split(/[,;]/).map(normalizeHost).filter(Boolean)
    : DEFAULT_HOSTS.map(normalizeHost).filter(Boolean);
  return Array.from(new Set(list.length ? list : DEFAULT_HOSTS));
})();

const SITE_COOKIE = String(process.env.SITE_COOKIE || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// 注意：不能用 Number(env) || 300 —— 环境变量为 "0" 时会被 || 吃掉变成 300，
// 导致 PORNA_CACHE_TTL=0 无法关闭缓存。先判空再取数。
const BASE_TTL = (() => {
  const raw = String(process.env.PORNA_CACHE_TTL || "").trim();
  if (raw === "") return 300;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300;
})();
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.min(120, Math.round(BASE_TTL * 0.3)));
const ROTATE_COOLDOWN = (() => {
  const raw = String(process.env.PORNA_ROTATE_COOLDOWN || "").trim();
  const n = raw === "" ? 600 : Number(raw);
  return Math.max(60, Number.isFinite(n) ? n : 600) * 1000;
})();
const CACHE_PREFIX = "porna:page:";

const CLASS_LIST = [
  { type_id: "play", type_name: "正在播放" },
  { type_id: "now_month_hot", type_name: "热门排行榜" },
  { type_id: "original", type_name: "国产原创" },
  { type_id: "new_update", type_name: "最新更新" },
  { type_id: "av", type_name: "日本AV" },
];

const PREFIX = "[91porna]";
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

// ---------------------------------------------------------------------------
// 域名轮换：健康度排序 + 跨请求记忆
// ---------------------------------------------------------------------------

const hostHealth = Object.create(null);
let PREFERRED = 0;

function markHost(host, ok, reason) {
  if (!host) return;
  const h = hostHealth[host] || (hostHealth[host] = { fail: 0, okAt: 0, blockedAt: 0 });
  if (ok) { h.fail = 0; h.okAt = Date.now(); h.blockedAt = 0; return; }
  h.fail = Number(h.fail || 0) + 1;
  if (/403|401|429|blocked|challenge|拦截/i.test(String(reason || ""))) h.blockedAt = Date.now();
}

/** 排序：未拦截 > 优选 > 失败少 > 配置顺序 */
function buildHostOrder() {
  const now = Date.now();
  return HOSTS.map((host, idx) => {
    const h = hostHealth[host] || {};
    return {
      idx, host,
      blocked: (h.blockedAt && now - h.blockedAt < ROTATE_COOLDOWN) ? 1 : 0,
      preferred: idx === PREFERRED ? 0 : 1,
      fails: Number(h.fail || 0),
    };
  }).sort((a, b) =>
    a.blocked - b.blocked || a.preferred - b.preferred || a.fails - b.fails || a.idx - b.idx
  ).map((x) => x.idx);
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
function absUrl(u, host) {
  const v = decodeHTML(String(u || "").trim());
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  if (v.startsWith("/")) return `${host}${v}`;
  return `${host}/${v}`;
}
function isMediaUrl(u) {
  return /\.(m3u8|mp4|webm|mkv|flv)(\?|#|$)/i.test(String(u || ""));
}

function buildHeaders(host, refererPath, extra) {
  const h = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: `${host}${refererPath || "/"}`,
    ...(extra || {}),
  };
  if (SITE_COOKIE) h.Cookie = SITE_COOKIE;
  return h;
}

/**
 * 通用请求：按健康度顺序轮换域名，任一失败自动切下一个。
 * 返回 { body, host, statusCode }；全部失败抛错。
 */
async function requestWithRotation(path, options = {}) {
  const order = buildHostOrder();
  if (HOSTS.length > 1) {
    log("info", `[rotate] 尝试顺序: ${order.map((i) => HOSTS[i]).join(" -> ")}`);
  }
  let lastErr = null;
  for (const idx of order) {
    const host = HOSTS[idx];
    const url = `${host}${path}`;
    try {
      const res = await OmniBox.request(url, {
        method: options.method || "GET",
        headers: buildHeaders(host, options.refererPath || "/", options.headers),
        body: options.body,
        timeout: options.timeout || 20000,
      });
      const status = Number(res && res.statusCode) || 0;
      const body = String((res && res.body) || "");
      if (status >= 200 && status < 300 && (body.length >= 200 || options.allowShort)) {
        markHost(host, true);
        if (idx !== PREFERRED) { PREFERRED = idx; log("info", `[rotate] 切换优选域名 -> ${host}`); }
        return { body, host, statusCode: status };
      }
      markHost(host, false, `HTTP ${status}`);
      log("info", `[rotate] ${host} HTTP ${status} len=${body.length}，切下一个`);
      lastErr = new Error(`HTTP ${status} @ ${host}`);
    } catch (e) {
      markHost(host, false, e && e.message);
      log("info", `[rotate] ${host} 异常 ${(e && e.message) || e}，切下一个`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("所有分流域名均不可用");
}

async function fetchHtml(path, ttl, refererPath) {
  const key = buildCacheKey(path);
  if (ttl > 0) { const c = await getCachedText(key); if (c) return c; }
  const r = await requestWithRotation(path, { refererPath });
  if (ttl > 0) await setCachedText(key, r.body, ttl);
  return r.body;
}

// ---------------------------------------------------------------------------
// 列表解析
// ---------------------------------------------------------------------------

function loadHtml(html) {
  if (!cheerio) throw new Error("cheerio 不可用");
  return cheerio.load(html);
}

function parseList(html, tag) {
  const $ = loadHtml(html);
  const list = [];
  const seen = new Set();
  $("div.video-item").each((_, node) => {
    const $box = $(node);
    const $link = $box.find("a[href*='/comic/index/detail?video_key=']").first();
    const href = $link.attr("href") || "";
    const m = href.match(/video_key=(\d+)/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return;
    seen.add(id);

    const $img = $box.find("img[data-src]").first();
    let pic = ($img.attr("data-src") || "").trim();
    if (!pic || /^data:/i.test(pic) || /poster_loading/i.test(pic)) {
      pic = ($img.attr("src") || "").trim();
    }
    if (/^data:/i.test(pic) || /poster_loading/i.test(pic)) pic = "";
    pic = absUrl(pic, HOSTS[PREFERRED]);

    const title = cleanText(
      $box.find("div.line-clamp-2").first().text() || $img.attr("alt") || $link.attr("title") || ""
    );
    if (!title) return;

    const durMatch = cleanText($box.text()).match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
    const duration = durMatch ? durMatch[0] : "";

    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: duration ? `${duration} · 高清` : "高清",
      vod_tag: "video",
      _tag: tag || "",
    });
  });
  return list;
}

function parsePageCount(html) {
  const $ = loadHtml(html);
  let max = 1;
  $("a[href*='page=']").each((_, n) => {
    const m = ($(n).attr("href") || "").match(/[?&]page=(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
    const txt = parseInt($(n).text().trim(), 10);
    if (Number.isFinite(txt) && txt > max && txt < 100000) max = txt;
  });
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
    log("info", `[home] from=${context?.from || "web"}, hosts=${HOSTS.length}`);
    const html = await fetchHtml("/", HOME_TTL, "/");
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
  const slug = String(typeId || "play").replace(/[^a-z0-9_]/gi, "") || "play";
  const base = slug === "av"
    ? "/comic/index/av"
    : `/comic/index/video?category=${slug}`;
  if (Number(page) > 1) return `${base}${base.includes("?") ? "&" : "?"}page=${page}`;
  return base;
}

async function category(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const typeId = String(params?.categoryId || params?.type_id || "play");
    const path = buildCategoryUrl(typeId, page);
    log("info", `[category] typeId=${typeId}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[category] 请求 ${path}`);
    const html = await fetchHtml(path, CATEGORY_TTL, path);
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
    let path = `/comic/index/search?keyword=${encodeURIComponent(keyword)}`;
    if (page > 1) path += `&page=${page}`;
    log("info", `[search] keyword=${keyword}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[search] 请求 ${path}`);
    const html = await fetchHtml(path, SEARCH_TTL, path);
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
// detail / play：POST /api/videos/{id}/playback 取 streams.main
// ---------------------------------------------------------------------------

function normalizeVideoId(raw) {
  let s = decodeHTML(String(raw || "")).trim();
  if (!s) return "";
  if (s.includes("|||")) s = s.split("|||")[0];
  const m = s.match(/video_key=(\d+)/) || s.match(/^(\d{3,})$/);
  return m ? m[1] : "";
}

/** POST 播放接口：按域名轮换，取 response.data.streams.main */
async function postPlayback(videoId, refererPath) {
  const path = `/api/videos/${videoId}/playback`;
  const order = buildHostOrder();
  let lastErr = null;
  for (const idx of order) {
    const host = HOSTS[idx];
    try {
      const res = await OmniBox.request(`${host}${path}`, {
        method: "POST",
        headers: buildHeaders(host, refererPath || "/", {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          Origin: host,
        }),
        body: "{}",
        timeout: 20000,
      });
      const status = Number(res && res.statusCode) || 0;
      const text = String((res && res.body) || "");
      if (status === 200 && text) {
        let data;
        try { data = JSON.parse(text); } catch (_) { data = null; }
        if (data) {
          const root = (data.data && typeof data.data === "object") ? data.data : data;
          const streams = root.streams || {};
          const pick = String(streams.main || streams.hevc || streams.preview || "").trim();
          if (pick) {
            const url = pick.replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
            markHost(host, true);
            if (idx !== PREFERRED) PREFERRED = idx;
            log("info", `[playback] ${host} 命中正片 main=${url.slice(0, 120)}`);
            return url;
          }
          log("info", `[playback] ${host} 200 但 streams 为空 status=${data.status} msg=${data.msg || ""}`);
        }
      }
      markHost(host, false, `HTTP ${status}`);
      log("info", `[playback] ${host} HTTP ${status} len=${text.length}，切下一个`);
      lastErr = new Error(`HTTP ${status}`);
    } catch (e) {
      markHost(host, false, e && e.message);
      log("info", `[playback] ${host} 异常: ${(e && e.message) || e}，切下一个`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("所有分流域名的 playback 接口均不可用");
}

async function detail(params, context) {
  const id = normalizeVideoId(params?.videoId || params?.vod_id || params?.id);
  try {
    if (!id) { log("info", "[detail] videoId 为空"); return { list: [] }; }
    const path = `/comic/index/detail?video_key=${id}`;
    log("info", `[detail] id=${id}, from=${context?.from || "web"}`);
    const html = await fetchHtml(path, DETAIL_TTL, path);
    const $ = loadHtml(html);
    const title = cleanText(
      $("meta[property='og:title']").attr("content") ||
      cleanText($("title").text()).replace(/\s*A片\s*-\s*91.*$/i, "") || ""
    ) || `91porna ${id}`;
    const pic = absUrl($("meta[property='og:image']").attr("content") || "", HOSTS[PREFERRED]);
    const desc = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "");

    // 分集：本类站单片为主；若页面里出现同一剧的其它 video_key，可作为选集
    const epIds = Array.from(new Set(
      (html.match(/video_key=(\d+)/g) || []).map((x) => x.match(/(\d+)/)[1])
    )).filter((x) => x === id).slice(0, 1);
    const sources = [{
      name: "91porna",
      episodes: epIds.map((eid) => ({ name: "正片", playId: eid })),
    }];

    log("info", `[detail] title=${title.slice(0, 40)}, 线路=${sources.length}`);
    return {
      list: [{
        vod_id: id,
        vod_name: title,
        vod_pic: pic,
        vod_content: desc,
        vod_remarks: "高清正片",
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

async function play(params, context) {
  try {
    const raw = String(params?.playId || params?.play_id || params?.ids || "").trim();
    const flag = String(params?.flag || "91porna");
    log("info", `[play] playId=${raw.slice(0, 120)}, flag=${flag}, from=${context?.from || "web"}`);
    if (!raw) throw new Error("playId 不能为空");

    const header = { "User-Agent": UA, Referer: `${HOSTS[PREFERRED]}/`, Accept: "*/*" };

    // 已是媒体直链：直接透传
    if (/^https?:\/\//i.test(raw) && isMediaUrl(raw)) {
      log("info", "[play] 命中媒体直链透传");
      return { urls: [{ name: "91porna", url: decodeHTML(raw) }], flag, header, parse: 0 };
    }

    const id = normalizeVideoId(raw);
    if (!id) throw new Error("无法从 playId 解析出 video_key");

    let url = "";
    try {
      url = await postPlayback(id, `/comic/index/detail?video_key=${id}`);
    } catch (e) {
      log("info", `[play] playback 内置域名池全部失败（不再从地址页拉取）: ${e?.message || e}`);
    }

    if (url && isMediaUrl(url)) {
      log("info", `[play] parse=0 url=${url.slice(0, 120)}`);
      return { urls: [{ name: "正片", url }], flag, header, parse: 0 };
    }

    // 兜底：SDK 嗅探 -> parse=1
    const pageUrl = `${HOSTS[PREFERRED]}/comic/index/detail?video_key=${id}`;
    if (typeof OmniBox.sniffVideo === "function") {
      try {
        const sniffed = await OmniBox.sniffVideo(pageUrl, header);
        const su = typeof sniffed === "string" ? sniffed.trim() : String(sniffed?.url || "");
        if (su && isMediaUrl(su)) {
          log("info", `[play] SDK 嗅探成功: ${su.slice(0, 120)}`);
          return { urls: [{ name: "嗅探", url: su }], flag, header, parse: 0 };
        }
      } catch (e) { log("info", `[play] SDK 嗅探失败: ${e?.message || e}`); }
    }
    log("warn", "[play] 未拿到正片直链，回退播放页嗅探 parse=1");
    return { urls: [{ name: "播放页", url: pageUrl }], flag, header, parse: 1 };
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag: params?.flag || "91porna", header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
