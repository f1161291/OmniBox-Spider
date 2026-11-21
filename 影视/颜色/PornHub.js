// @name PornHub
// @version 1.0.1
// @author omnibox-spider
// @description cn.pornhub.com 采集源：首页推荐 + 17 个分类（巨乳/巨屌/内射/女同等）+ 排序 + 搜索分页；列表取 pcVideoListItem 卡片（带 viewkey、封面、时长、观看数、评分），详情页从 flashvars_{id} 解析 mediaDefinitions 的 HLS 直链（仅保留 1080P/720P，1080P 优先）
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/PornHub.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-14 实测，改代码前先读这段）
 * 1) 主域 https://cn.pornhub.com（pornhub.com 的简体中文镜像）。常规 UA + Referer 即可，无 CF 盾、无 JS cookie 挑战。
 * 2) 路由：
 *      - 首页 /
 *      - 分类 /video?c=<分类ID>（见 CLASS_LIST，17 个；c=111 日本人 / c=8 巨乳 / c=7 巨屌 等）
 *      - 排序 /video?o=ht（最热）/o=mv（最多观看）/o=tr（最多收藏）/o=cm（最近）/o=lg（最长）
 *      - 分类+排序可叠加：/video?c=8&o=mv
 *      - 分页 /video?c=8&page=2（翻页靠 pagination3 区块的 ?page=N，末页没有下一页链接）
 *      - 搜索 /video/search?search=<关键词>&page=N（中文需 encodeURIComponent）
 *    注意：分类详情页 URL 用 query 形式 /video?c=，不要拼成 /categories/{slug}。
 * 3) 列表卡片：<li class="pcVideoListItem ... " data-video-id="{id}" data-video-vkey="{viewkey}">
 *      - 标题：a.title （如 title="Hot Brunette ..." 或内部 span.title > a）
 *      - 链接：/view_video.php?viewkey={viewkey}（唯一稳定 id 用 viewkey，不是数字 id）
 *      - 封面：img[data-image]（高清）/ img[src]（兜底）
 *      - 时长：<var class="duration">10:51</var>（在 <div class="marker-overlays"> 内）
 *      - 观看数：<span class="views"><var>341K</var> 次观看</span>
 *      - 评分：<span class="rating-container"> ... <span class="value">{n}</span>
 *      - 广告卡特征：没有 data-video-vkey 的 li，或带 data-ad 属性；本源只取带 vkey 的。
 * 4) 详情页：<meta property="og:title"> / og:image 取标题与封面；flashvars_{id} = { ... } 内联 JSON 含
 *      video_title / video_duration(秒) / rating(%) / video_id。
 *      mediaDefinitions 数组里每项是一档清晰度：
 *        { format:"hls", quality:"720", defaultQuality:true/false, videoUrl:"https://ev-h.phncdn.com/hls/.../720P_4000K_xxxx.mp4/master.m3u8?validfrom=...&validto=...&ipa=1&hdl=-1&hash=..." }
 *      实测有 1080/720/480/240 四档 HLS（另有 mp4 分组走 get_media，本源只用 HLS）。
 *      【1.0.1】按需求只保留 1080P 与 720P 两档，顺序固定为 1080P → 720P；
 *      480/240 与未知档位在解析阶段直接丢弃，不再展示给用户。
 * 5) 【播放关键事实·必须读】视频 CDN（ev-h.phncdn.com / ev.phncdn.com / pix-fl.phncdn.com 等）
 *      在「本机出口 192.9.131.57 / Oracle 圣何塞」下 HTTP 层被连接重置（TLS 握手成功、但 GET 直接
 *      TCP RST），签名未过期（validto 在 ~1 小时内）也无法取流。
 *      => 这不是脚本 bug，是运行环境对 Pornhub CDN 的链路限制。OmniBox 宿主侧若用不同出口（如
 *         用户本地网络 / 支持该 CDN 的代理）即可正常播放，因此脚本仍如实返回 HLS 直链（parse=0）。
 *      => 若宿主回源取流失败，应在「HOST_PROXY_URL / PORNHUB_PROXY_URL」里配一个能访问该 CDN 的
 *         出口；OmniBox.request 带代理时由宿主注入，脚本不改 URL。
 * 6) 列表/详情/搜索走短 TTL 缓存（PORNHUB_CACHE_TTL，默认 600）；play 不缓存（签名链接随会话刷新）。
 *
 * 【环境变量】（优先复用仓库既有命名）
 *  SITE_HOST          站点基址，默认 https://cn.pornhub.com；主域轮换（如 pornhub.com）改这里
 *  SITE_COOKIE        可选，站点登录态 Cookie（影响是否出现 Premium / 会员片，普通片不需要）
 *  PORNHUB_CACHE_TTL  页面缓存秒数，默认 600（新增，避免与别的站点 TTL 串用）
 *  PORNHUB_PROXY_URL  可选，能访问 Pornhub 视频 CDN 的出口（仅提示用场，由宿主 OmniBox.request 注入）
 *  HOST_PROXY_URL    通用代理（同上，仅提示）
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.catch 兜住。
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
  OmniBox = { log() { /* 本地调试：日志不写 stdout */ } };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://cn.pornhub.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "https://cn.pornhub.com";
  }
}

const HOST = normalizeHost(process.env.SITE_HOST || "https://cn.pornhub.com");
const SITE_COOKIE = String(process.env.SITE_COOKIE || "").trim();
// 视/听首页分类：简体中文镜像实测的 17 个分类（id 来自 /video?c=NNN，名称来自 a 标签 alt）
const CLASS_LIST = [
  { type_id: "ht", type_name: "最热门" },
  { type_id: "mv", type_name: "最多观看" },
  { type_id: "tr", type_name: "最多收藏" },
  { type_id: "111", type_name: "日本人" },
  { type_id: "8", type_name: "巨乳" },
  { type_id: "7", type_name: "巨屌" },
  { type_id: "10", type_name: "捆绑" },
  { type_id: "15", type_name: "内射中出" },
  { type_id: "17", type_name: "黑人女" },
  { type_id: "22", type_name: "手淫" },
  { type_id: "24", type_name: "公众野战" },
  { type_id: "27", type_name: "女同" },
  { type_id: "28", type_name: "熟女" },
  { type_id: "29", type_name: "辣妈" },
  { type_id: "35", type_name: "爆菊" },
  { type_id: "65", type_name: "3P" },
  { type_id: "69", type_name: "潮吹" },
  { type_id: "80", type_name: "轮交" },
  { type_id: "86", type_name: "卡通" },
  { type_id: "181", type_name: "老少欢" },
];

const SORT_OPTIONS = [
  { name: "默认", value: "" },
  { name: "最新上架", value: "cm" },
  { name: "最多观看", value: "mv" },
  { name: "最热", value: "ht" },
  { name: "最多收藏", value: "tr" },
  { name: "最长", value: "lg" },
];
const SORT_WHITELIST = new Set(SORT_OPTIONS.map((o) => o.value).filter(Boolean));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_TTL = Math.max(0, Number(process.env.PORNHUB_CACHE_TTL || 600) || 600);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.min(180, Math.round(BASE_TTL * 0.3)));
const CACHE_PREFIX = "ph:page:";

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ---------------------------------------------------------------------------
// 日志 / 缓存 / 请求
// ---------------------------------------------------------------------------

function log(level, message) {
  const line = `[ph][${level}] ${message}`;
  try {
    if (typeof OmniBox.log === "function") {
      const p = OmniBox.log(level, line);
      if (p && typeof p.catch === "function") p.catch(() => {});
      return;
    }
  } catch (_) {}
  try {
    process.stderr.write(`${line}\n`);
  } catch (_) {}
}

function md5(text) {
  try {
    const crypto = require("crypto");
    return crypto.createHash("md5").update(String(text)).digest("hex");
  } catch (_) {
    return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32);
  }
}

function buildCacheKey(url, cookie) {
  const key = `${CACHE_PREFIX}${md5(`${url}|${cookie || ""}`)}`;
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
      await OmniBox.setCache(key, value, ttl);
    }
  } catch (_) {}
}

function buildCookie(extra) {
  return [SITE_COOKIE, String(extra || "").trim()]
    .filter(Boolean)
    .join("; ")
    .replace(/;\s*;/g, ";")
    .trim();
}

async function requestText(url, options = {}) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: `${HOST}/`,
    Origin: HOST,
    ...(options.headers || {}),
  };
  const cookie = buildCookie(options.cookie);
  if (cookie) headers.Cookie = cookie;

  const res = await OmniBox.request(url, {
    method: options.method || "GET",
    headers,
    timeout: options.timeout || 20000,
  });
  if (!res || Number(res.statusCode) !== 200) {
    throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  }
  return String(res.body || "");
}

async function fetchHtml(url, ttl) {
  const key = buildCacheKey(url, SITE_COOKIE);
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
// 列表解析（首页 / 分类 / 搜索通用）
// ---------------------------------------------------------------------------

function pickCardImages($el) {
  // 高清优先 data-image，其次 data-src，最后 src；最后过滤 1x1 占位图
  const cands = [
    $el.find("img[data-image]").first().attr("data-image"),
    $el.find("img[data-src]").first().attr("data-src"),
    $el.find("img").first().attr("src"),
  ].map((x) => (x || "").trim()).filter(Boolean);
  for (const c of cands) {
    if (/^data:image/.test(c)) continue; // 跳过 base64 占位图
    return c;
  }
  return cands[0] || "";
}

function parseList(html, tag) {
  const $ = loadHtml(html);
  const list = [];
  const seen = new Set();

  $("li.pcVideoListItem").each((_, node) => {
    const $li = $(node);
    const viewkey = ($li.attr("data-video-vkey") || "").trim();
    if (!viewkey) return; // 广告卡 / 推荐卡无 vkey，跳过
    if (seen.has(viewkey)) return;
    seen.add(viewkey);

    const $link = $li.find("a[href*='view_video.php?viewkey=']").first();
    const href = $link.attr("href") || "";
    if (!/viewkey=/.test(href)) return;
    const title = ($link.attr("title") || $li.find("span.title a").text() || "").trim();
    if (!title) return;

    const pic = pickCardImages($li);
    const duration = ($li.find("var.duration").first().text() || "").trim();
    const views = ($li.find("span.views var").first().text() || "").trim();
    const ratingRaw = ($li.find("span.rating-container span.value").first().text() || "").trim();
    const rating = ratingRaw ? `${ratingRaw}%` : "";

    const remarks = [duration, views ? `${views}观看` : "", rating]
      .filter(Boolean)
      .join(" · ");

    list.push({
      vod_id: `ph:${viewkey}`,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      vod_tag: "video",
      vod_play_from: "PornHub",
      viewkey,
      _tag: tag || "",
    });
  });

  return list;
}

function parsePageCount(html) {
  const $ = loadHtml(html);
  // 末页判断：分页区没有「下一页」可用链接
  const pages = new Set();
  $("a[href*='page=']").each((_, node) => {
    const m = ($(node).attr("href") || "").match(/[?&]page=(\d+)/);
    if (m) pages.add(parseInt(m[1], 10));
  });
  let pagecount = pages.size ? Math.max(...pages) : 1;

  // 兜底：翻页标签里最大的页码（如 <a ...>342</a>）
  $(".pagination3 a, .paginationGated a, .page_number a").each((_, node) => {
    const t = parseInt($(node).text().trim(), 10);
    if (!isNaN(t) && t > pagecount) pagecount = t;
  });
  return pagecount;
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

// ---------------------------------------------------------------------------
// home / category / search
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    const from = context?.from || "web";
    log("info", `[home] from=${from}, host=${HOST}`);
    const url = `${HOST}/`;
    const html = await fetchHtml(url, HOME_TTL);
    const list = parseList(html, "home");
    const filters = {};
    for (const item of CLASS_LIST) {
      filters[item.type_id] = [
        { key: "sort", name: "排序", init: "", value: SORT_OPTIONS },
      ];
    }
    log("info", `[home] 返回分类=${CLASS_LIST.length}, 推荐=${list.length}`);
    return { class: CLASS_LIST, filters, list };
  } catch (e) {
    log("error", `[home] 失败: ${e?.message || e}`);
    return { class: CLASS_LIST, filters: {}, list: [] };
  }
}

function buildCategoryUrl(categoryId, page, sort) {
  const u = new URL(`${HOST}/video`);
  // 纯数字 = 分类 id；其它视为排序 o=
  if (/^\d+$/.test(String(categoryId))) {
    u.searchParams.set("c", String(categoryId));
  } else if (categoryId) {
    u.searchParams.set("o", String(categoryId));
  }
  if (sort && SORT_WHITELIST.has(sort)) u.searchParams.set("o", sort);
  if (Number(page) > 1) u.searchParams.set("page", String(page));
  return u.toString();
}

async function category(params, context) {
  try {
    const categoryId = String(params?.categoryId || params?.type_id || "ht");
    const page = Number(params?.page) || 1;
    const filters = readFilters(params);
    const sort = normalizeSort(filters.sort || filters.o || params?.sort);
    const url = buildCategoryUrl(categoryId, page, sort);
    log("info", `[category] categoryId=${categoryId}, page=${page}, sort=${sort}, from=${context?.from || "web"}`);
    log("info", `[category] 请求 URL=${url}`);

    const html = await fetchHtml(url, CATEGORY_TTL);
    const list = parseList(html, "category");
    const pagecount = parsePageCount(html);
    log("info", `[category] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[category] 失败: ${e?.message || e}`);
    return emptyPage(params?.page);
  }
}

function readFilters(params) {
  try {
    return params?.filters || params?.extend || params?.ext || {};
  } catch (_) {
    return {};
  }
}

function normalizeSort(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return SORT_WHITELIST.has(v) ? v : "";
}

async function search(params, context) {
  try {
    const page = Number(params?.page) || 1;
    const keyword = String(params?.keyword || params?.wd || params?.q || "").trim();
    if (!keyword) {
      log("info", "[search] 关键词为空，返回空结果");
      return emptyPage(page);
    }
    const url = new URL(`${HOST}/video/search`);
    url.searchParams.set("search", keyword);
    if (page > 1) url.searchParams.set("page", String(page));
    const finalUrl = url.toString();
    log("info", `[search] keyword=${keyword}, page=${page}, from=${context?.from || "web"}`);
    log("info", `[search] 请求 URL=${finalUrl}`);

    const html = await fetchHtml(finalUrl, SEARCH_TTL);
    const list = parseList(html, "search");
    const pagecount = parsePageCount(html);
    log("info", `[search] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[search] 失败: ${e?.message || e}`);
    return emptyPage(params?.page);
  }
}

// ---------------------------------------------------------------------------
// detail / play
// ---------------------------------------------------------------------------

function normalizeViewkey(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/viewkey=([a-z0-9]+)/i);
  if (m) return m[1];
  return s.replace(/^ph:/i, "").trim();
}

// 从详情页 HTML 提取 flashvars_{id} 里的 mediaDefinitions（HLS 多档），返回 [{quality,url,def}]
function parseMediaDefinitions(html) {
  // 找 flashvars_数字 = { ... mediaDefinitions:[ ... ] ... }
  const start = html.search(/flashvars_\d+\s*=\s*\{/);
  if (start < 0) return [];
  // 从 { 开始做括号配平
  let i = html.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let k = i; k < html.length; k++) {
    const ch = html[k];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = k; break; }
    }
  }
  if (end < 0) return [];
  const objText = html.slice(i, end + 1);
  const arrMatch = objText.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\}\s*\])(\s*,|\s*\})/);
  if (!arrMatch) return [];
  let arrStr = arrMatch[1];
  // 把转义斜杠还原
  arrStr = arrStr.replace(/\\"/g, '"').replace(/\\\/"/g, '\\"');
  let arr;
  try {
    arr = JSON.parse(arrStr);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const d of arr) {
    const fmt = String(d.format || "").toLowerCase();
    if (fmt !== "hls") continue;
    let url = String(d.videoUrl || "").replace(/\\/g, "");
    if (!/^https?:\/\//i.test(url)) continue;
    const q = String(d.quality || "").trim();
    // 只保留 1080P / 720P 两档，低清（240/480）与未知档一律丢弃
    if (q !== "1080" && q !== "720") continue;
    out.push({ quality: q, def: !!d.defaultQuality, url });
  }
  // 1080P 固定优先，其次 720P；同档内保持站点原顺序
  const RANK = { "1080": 0, "720": 1 };
  out.sort((a, b) => (RANK[a.quality] ?? 99) - (RANK[b.quality] ?? 99));
  return out;
}

async function detail(params, context) {
  const viewkey = normalizeViewkey(params?.videoId || params?.vod_id);
  try {
    if (!viewkey) {
      log("info", "[detail] viewkey 为空，返回空结构");
      return { list: [] };
    }
    const detailUrl = `${HOST}/view_video.php?viewkey=${viewkey}`;
    log("info", `[detail] viewkey=${viewkey}, from=${context?.from || "web"}`);
    log("info", `[detail] 请求 URL=${detailUrl}`);

    const html = await fetchHtml(detailUrl, DETAIL_TTL);
    const $ = loadHtml(html);

    const title = ($("meta[property='og:title']").attr("content") || "").trim();
    const pic = ($("meta[property='og:image']").attr("content") || "").trim();
    const desc = ($("meta[property='og:description']").attr("content") || "").trim();

    const media = parseMediaDefinitions(html);
    log("info", `[detail] title=${title || "(无)"}, HLS档数=${media.length}`);
    if (media.length === 0) {
      // 解析失败时仍返回卡片信息，播放阶段再二次尝试
      log("info", "[detail] 未解析到 mediaDefinitions，仅返回基础信息");
      return {
        list: [{
          vod_id: `ph:${viewkey}`,
          vod_name: title || `PornHub ${viewkey}`,
          vod_pic: pic,
          vod_content: desc,
          vod_remarks: "解析中",
          vod_tag: "video",
          vod_play_sources: [{
            name: "PornHub",
            episodes: [{ name: "正片", playId: `ph:${viewkey}` }],
          }],
        }],
      };
    }

    const sources = media.map((m) => ({
      name: `${m.quality}P`,
      episodes: [{ name: `${m.quality}P`, playId: `ph:${viewkey}|||${m.url}` }],
    }));

    return {
      list: [{
        vod_id: `ph:${viewkey}`,
        vod_name: title || `PornHub ${viewkey}`,
        vod_pic: pic,
        vod_content: desc,
        vod_remarks: media.length ? `${media.length} 档 HLS` : "",
        vod_tag: "video",
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log("error", `[detail] 失败: ${e?.message || e}`);
    return { list: [] };
  }
}

function isMediaUrl(url) {
  return /\.(m3u8|mp4|webm|mkv|flv)(\?|$)/i.test(url);
}

async function play(params, context) {
  try {
    const raw = String(params?.playId || params?.play_id || params?.ids || "").trim();
    const flag = String(params?.flag || "ph");
    log("info", `[play] playId=${raw.slice(0, 200)}, flag=${flag}, from=${context?.from || "web"}`);
    if (!raw) throw new Error("playId 不能为空");

    // 格式：ph:{viewkey}|||{url}  或  ph:{viewkey}
    let url = "";
    let viewkey = "";
    if (raw.includes("|||")) {
      const idx = raw.indexOf("|||");
      viewkey = normalizeViewkey(raw.slice(0, idx));
      url = raw.slice(idx + 3).trim();
    } else {
      viewkey = normalizeViewkey(raw);
    }

    const headers = {
      "User-Agent": UA,
      Referer: `${HOST}/`,
      Origin: HOST,
      Accept: "*/*",
    };

    // 直链场景：已带 URL 且是媒体直链
    if (url && isMediaUrl(url)) {
      log("info", `[play] 命中 HLS 直链，parse=0: ${url.slice(0, 140)}`);
      return {
        urls: [{ name: "PornHub", url }],
        flag,
        header: headers,
        parse: 0,
      };
    }

    // 仅 viewkey：回源详情页重新解析 mediaDefinitions（优先 1080P，其次 720P）
    if (viewkey) {
      const detailUrl = `${HOST}/view_video.php?viewkey=${viewkey}`;
      const html = await fetchHtml(detailUrl, DETAIL_TTL);
      const media = parseMediaDefinitions(html);
      if (media.length) {
        // parseMediaDefinitions 已按 1080P → 720P 排好序，直接取第一档
        const pick = media[0];
        log("info", `[play] 回源解析到 HLS，quality=${pick.quality}P，parse=0`);
        return {
          urls: [{ name: `${pick.quality}P`, url: pick.url }],
          flag,
          header: headers,
          parse: 0,
        };
      }
      // 实在拿不到直链，给播放页让客户端嗅探
      log("info", "[play] 未解析到媒体直链，回退 parse=1 嗅探");
      return {
        urls: [{ name: "PornHub", url: detailUrl }],
        flag,
        header: headers,
        parse: 1,
      };
    }

    throw new Error("无法解析播放地址");
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag: params?.flag || "ph", header: {}, parse: 0 };
  }
}
