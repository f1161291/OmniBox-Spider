// @name 橙果短剧
// @author 宝宝巴士
// @description 橙果短剧 · 原创/魔改/漫剧/真人/AI/片库，原 ForwardWidget 源适配 OmniBox
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/other/blob/main/PY/橙果短剧.js

/**
 * ==========================================================================
 * 橙果短剧 - OmniBox 爬虫脚本（新格式）
 * ==========================================================================
 * 数据来源: https://chengguodj.com
 * 改编自: ForwardWidget 脚本（作者：宝宝巴士）
 * 站点特征:
 *   - Nuxt SSR：数据在 <script id="__NUXT_DATA__"> 的 JSON 数组里，值多为索引引用
 *   - 频道列表: /频道 与 /频道/page-N（?page= 会被忽略，必须用 page-N）
 *   - 搜索是路径式: /search/{关键词}（原 ?keyword= 形式已失效，实测 SSR 恒空）；仅 1 页
 *   - 详情 /drama/{slug}: 内含结构化 episodes 数组（play_route 为完整 /play/{slug}/{N}）
 *   - 播放 /play/{slug}/{N}: Nuxt 数组里有完整 m3u8 字符串
 *   - 封面走站内反代 /_img/{base64url(图片地址)}（实测可用）
 *   - 站方 BFF API（wj-api-cgdjweb.yvyjdhr.com）返回加密载荷，不走，坚持 SSR HTML
 * 环境变量:
 *   - CGDJ_HOST: 源站地址，默认 https://chengguodj.com
 * ==========================================================================
 */

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

/**
 * 作用：导出 5 个标准 handler 并启动 runner。
 */
module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ==================== 站点配置 ====================

const SITE = String(process.env.CGDJ_HOST || "https://chengguodj.com").replace(/\/+$/, "");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

/** 频道分类（6 个原列表模块；home.list 用内容最全的片库） */
const CHANNELS = [
  { type_id: "yuanchuang", type_name: "原创短剧" },
  { type_id: "mogai", type_name: "魔改短剧" },
  { type_id: "manju", type_name: "漫剧" },
  { type_id: "zhenren", type_name: "真人短剧" },
  { type_id: "aiduanju", type_name: "AI短剧" },
  { type_id: "browse", type_name: "片库索引" },
];

// ==================== 通用工具 ====================

function log(level, message) {
  return OmniBox.log(level, `[橙果短剧] ${message}`);
}

function t(v) {
  return String(v == null ? "" : v).trim();
}

function headers(ref) {
  return {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: ref || SITE + "/",
    "Accept-Encoding": "identity",
  };
}

function absUrl(u) {
  u = t(u)
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\/g, "");
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("http") === 0) return u;
  if (u.charAt(0) === "/") return SITE + u;
  return SITE + "/" + u;
}

/** 大小写不明的响应头里按名取值 */
function headerValue(hdrs, name) {
  if (!hdrs) return "";
  if (typeof hdrs.get === "function") {
    var v = hdrs.get(name);
    if (v != null) return String(v);
  }
  for (var k in hdrs) {
    if (String(k).toLowerCase() === name.toLowerCase()) return String(hdrs[k] || "");
  }
  return "";
}

/** 响应体规整为文本；压缩流（gzip/brotli）先解压 */
function bodyToText(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  try {
    var zlib = require("zlib");
    var buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        return zlib.gunzipSync(buf).toString("utf-8");
      } catch (e) {}
    }
    try {
      return zlib.brotliDecompressSync(buf).toString("utf-8");
    } catch (e) {}
    return buf.toString("utf-8");
  } catch (e) {
    return String(body);
  }
}

/**
 * 函数：fetchHtml
 * 作用：统一请求页面：手动跟随 3xx、压缩体解压、失败记录原因返回 ""。
 */
async function fetchHtml(url, referer) {
  var lastError = "";
  for (var attempt = 1; attempt <= 2; attempt++) {
    var current = url;
    var hops = 0;
    while (hops < 6) {
      hops++;
      try {
        var res = await OmniBox.request(current, {
          method: "GET",
          headers: headers(referer || SITE + "/"),
        });
        var status = Number(res && res.statusCode) || 0;
        var body = bodyToText(res && res.body);

        if (status === 404) {
          await log("warn", `[请求] 404 url=${current}`);
          return "";
        }
        if (status >= 300 && status < 400) {
          var loc = headerValue(res && res.headers, "location");
          if (loc) {
            current = absUrl(loc);
            continue;
          }
          lastError = "HTTP " + status + "（缺少 Location）";
          break;
        }
        if (status >= 200 && status < 300 && body) return body;
        lastError = "HTTP " + status + " len=" + body.length;
        break;
      } catch (e) {
        var emsg = (e && e.message) || String(e);
        if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|unreachable/i.test(emsg)) {
          await log("error", `[请求] 网络不可达 url=${current} 原因=${emsg}`);
          return "";
        }
        lastError = emsg;
        break;
      }
    }
  }
  await log("error", `[请求] 失败 url=${url} 原因=${lastError}`);
  return "";
}

// ==================== Nuxt 数据解析 ====================

/** 提取 __NUXT_DATA__ JSON 数组 */
function parseNuxtArr(html) {
  var m = String(html || "").match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(t(m[1]));
  } catch (e) {
    return null;
  }
}

/** 索引引用解包：值是数组下标则取元素，否则原样返回（同时兼容内联值） */
function nuxtVal(arr, idx) {
  if (typeof idx === "number" && idx >= 0 && idx < arr.length) return arr[idx];
  return idx;
}

/** 从卡片对象里取数字型集数（多种字段名兼容，对象型跳过） */
function pickEps(item, arr) {
  var keys = ["total_episode_count", "total_episodes", "published_episode_count", "latest_episode_number"];
  for (var i = 0; i < keys.length; i++) {
    if (!(keys[i] in item)) continue;
    var v = nuxtVal(arr, item[keys[i]]);
    if (typeof v === "number" && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return 0;
}

/** 从卡片对象里取封面（支持 {url} 对象与内联字符串两种形态） */
function pickCover(item, arr) {
  var c = nuxtVal(arr, item.cover);
  if (c && typeof c === "object") {
    var u = nuxtVal(arr, c.url);
    if (u && typeof u === "string") return u;
    var fb = nuxtVal(arr, c.fallback_url);
    if (fb && typeof fb === "string") return fb;
  }
  if (typeof c === "string" && c) return c;
  var s = nuxtVal(arr, item.cover_fallback_url);
  return typeof s === "string" ? s : "";
}

/**
 * 函数：extractListFromNuxt
 * 作用：Nuxt 数组 → 视频 VodItem 数组。
 *   兼容索引引用（频道页）与内联值（搜索热词区）两种形态；
 *   路径字段 detail_route / route / slug 三选一。
 */
function extractListFromNuxt(html) {
  var arr = parseNuxtArr(html);
  if (!arr || !arr.length) return [];
  var items = [];
  var seen = {};

  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    if (!item || typeof item !== "object") continue;
    if (!("title" in item)) continue;
    if (!("slug" in item) && !("detail_route" in item) && !("route" in item)) continue;

    var title = nuxtVal(arr, item.title);
    if (!title || typeof title !== "string") continue;
    title = t(title);
    if (!title) continue;

    var dramaPath = "";
    if ("detail_route" in item) {
      var dr = nuxtVal(arr, item.detail_route);
      if (dr && typeof dr === "string") dramaPath = dr;
    }
    if (!dramaPath && "route" in item) {
      var rt = nuxtVal(arr, item.route);
      if (rt && typeof rt === "string" && rt.indexOf("/drama/") === 0) dramaPath = rt;
    }
    if (!dramaPath) {
      var slug0 = nuxtVal(arr, item.slug);
      if (slug0 && typeof slug0 === "string") dramaPath = "/drama/" + slug0;
    }
    if (!dramaPath) continue;
    dramaPath = t(dramaPath);
    if (seen[dramaPath]) continue;
    seen[dramaPath] = 1;

    var pic = pickCover(item, arr);
    var eps = pickEps(item, arr);
    var remarks = eps ? "全" + eps + "集" : "";

    items.push({
      vod_id: dramaPath,
      vod_name: title,
      vod_pic: proxyImg(pic),
      vod_cover: proxyImg(pic),
      vod_remarks: remarks,
      type_id: "",
      type_name: "",
    });
  }
  return items;
}

/**
 * 函数：pagecountFromNuxt
 * 作用：从 Nuxt 分页容器解析总页数。
 *   频道页: {page, total, total_pages}；搜索页: {dramas_has_more}（仅 1 页）。
 */
function pagecountFromNuxt(html, page, hasItems) {
  var arr = parseNuxtArr(html);
  if (!arr) return hasItems ? page : 0;
  for (var i = 0; i < arr.length; i++) {
    var v = arr[i];
    if (!v || typeof v !== "object" || !("pagination" in v)) continue;
    var p = nuxtVal(arr, v.pagination);
    if (!p || typeof p !== "object") continue;
    var totalPages = nuxtVal(arr, p.total_pages);
    if (typeof totalPages === "number" && totalPages > 0) return totalPages;
    var hasMore = nuxtVal(arr, p.dramas_has_more);
    if (hasMore === true) return page + 1;
    return hasItems ? page : 0;
  }
  return hasItems ? page : 0;
}

// ==================== 封面站内反代 ====================

/** 站内封面反代 /_img/base64url（图片防盗链，站方自带解密入口） */
function proxyImg(raw) {
  raw = absUrl(raw);
  if (!raw) return "";
  if (raw.indexOf(SITE + "/_img/") === 0) return raw;
  try {
    return SITE + "/_img/" + base64UrlEncode(raw);
  } catch (e) {
    return raw;
  }
}

function base64UrlEncode(str) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var utf8 = unescape(encodeURIComponent(str));
  var out = "";
  for (var i = 0; i < utf8.length; i += 3) {
    var c1 = utf8.charCodeAt(i);
    var c2 = i + 1 < utf8.length ? utf8.charCodeAt(i + 1) : 0;
    var c3 = i + 2 < utf8.length ? utf8.charCodeAt(i + 2) : 0;
    var e1 = c1 >> 2;
    var e2 = ((c1 & 3) << 4) | (c2 >> 4);
    var e3 = ((c2 & 15) << 2) | (c3 >> 6);
    var e4 = c3 & 63;
    if (i + 1 >= utf8.length) {
      e3 = 64;
      e4 = 64;
    } else if (i + 2 >= utf8.length) {
      e4 = 64;
    }
    out += chars.charAt(e1) + chars.charAt(e2) + (e3 === 64 ? "=" : chars.charAt(e3)) + (e4 === 64 ? "=" : chars.charAt(e4));
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ==================== 列表加载 ====================

function catUrl(tid, page) {
  page = parseInt(page, 10) || 1;
  if (page <= 1) return SITE + "/" + tid;
  return SITE + "/" + tid + "/page-" + page;
}

async function loadChannel(tid, page) {
  var url = catUrl(tid, page);
  await log("info", `[category] tid=${tid}, page=${page}, url=${url}`);
  var html = await fetchHtml(url);
  var list = extractListFromNuxt(html);
  if (!html) return { page: page, pagecount: 0, total: 0, list: [] };
  if (!list.length) {
    await log("warn", `[category] 页面非空但未解析到条目 len=${html.length}`);
  }
  var pagecount = pagecountFromNuxt(html, page, list.length > 0);
  await log("info", `[category] count=${list.length} pagecount=${pagecount}`);
  return { page: page, pagecount: pagecount, total: pagecount > 1 ? (pagecount - 1) * 30 + list.length : list.length, list: list };
}

// ==================== 5 个标准 handler ====================

/**
 * 作用：首页 = 6 个频道分类 + 片库第一页推荐（593 部全量库，比单频道丰富）。
 */
async function home(params, context) {
  try {
    var from = (context && context.from) || "web";
    await log("info", `[home] from=${from}`);
    var html = await fetchHtml(catUrl("browse", 1));
    var list = extractListFromNuxt(html);
    if (html && !list.length) {
      await log("warn", `[home] 页面非空但未解析到条目 len=${html.length}`);
    }
    await log("info", `[home] class=${CHANNELS.length} list=${list.length}`);
    return { class: CHANNELS, list: list };
  } catch (e) {
    await log("error", `[home] 失败: ${(e && e.message) || e}`);
    return { class: CHANNELS, list: [] };
  }
}

/**
 * 作用：频道分页列表。categoryId 为频道名（yuanchuang/mogai/manju/zhenren/aiduanju/browse）。
 */
async function category(params, context) {
  try {
    var categoryId = t((params && params.categoryId) || "") || "browse";
    if (!CHANNELS.some(function (c) { return c.type_id === categoryId; })) categoryId = "browse";
    var page = Math.max(1, parseInt((params && params.page) || 1, 10) || 1);
    return await loadChannel(categoryId, page);
  } catch (e) {
    await log("error", `[category] 失败: ${(e && e.message) || e}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 作用：搜索。站点是路径式路由 /search/{关键词}（仅 1 页，翻页直接短路）。
 */
async function search(params, context) {
  try {
    var keyword = t((params && (params.keyword || params.wd || params.q)) || "");
    var page = Math.max(1, parseInt((params && params.page) || 1, 10) || 1);
    if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };
    if (page > 1) {
      await log("info", `[search] keyword=${keyword}, page=${page} 超出范围（仅 1 页）`);
      return { page: page, pagecount: 1, total: 0, list: [] };
    }

    var url = SITE + "/search/" + encodeURIComponent(keyword);
    await log("info", `[search] keyword=${keyword}, url=${url}`);
    var html = await fetchHtml(url);
    var list = extractListFromNuxt(html);
    if (html && !list.length) {
      await log("warn", `[search] 页面非空但未解析到条目 len=${html.length}`);
    }
    await log("info", `[search] count=${list.length}`);
    if (!list.length) return { page: 1, pagecount: 0, total: 0, list: [] };
    return { page: 1, pagecount: 1, total: list.length, list: list };
  } catch (e) {
    await log("error", `[search] 失败: ${(e && e.message) || e}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 作用：详情。集数优先取结构化 episodes 数组（play_route 为完整播放路径），
 *   依次回退 total_episode_count 拼路径、/play/ 链接扫描、"N集" 正则。
 * 入参：@param {Object} params - { videoId: /drama/{slug} }
 */
async function detail(params, context) {
  try {
    var videoId = t((params && (params.videoId || params.id)) || "");
    var m = videoId.match(/https?:\/\/[^/]+(\/.*)/);
    if (m) videoId = m[1];
    if (!videoId) return { list: [] };

    await log("info", `[detail] videoId=${videoId}`);
    var html = await fetchHtml(absUrl(videoId));
    if (!html) return { list: [] };
    var arr = parseNuxtArr(html);
    var slug = videoId.replace(/\/+$/, "").split("/").pop();

    // 标题/简介/封面：取详情页 drama 对象（slug 匹配），回退 <title>/meta
    var title = "";
    var desc = "";
    var pic = "";
    if (arr) {
      for (var di = 0; di < arr.length; di++) {
        var dv = arr[di];
        if (!dv || typeof dv !== "object") continue;
        if (!("slug" in dv) || !("title" in dv)) continue;
        if (nuxtVal(arr, dv.slug) !== slug) continue;
        var dt = nuxtVal(arr, dv.title);
        if (dt && typeof dt === "string") title = t(dt);
        var intro = nuxtVal(arr, dv.intro);
        if (intro && typeof intro === "string") desc = t(intro).slice(0, 400);
        pic = pickCover(dv, arr);
        break;
      }
    }
    if (!title) {
      var tm = html.match(/<title>([^<]+)<\/title>/i);
      if (tm) title = t(tm[1].split("-")[0]).replace(/在线观看/g, "").trim();
    }
    if (!title) title = videoId;
    if (!pic) {
      var og = html.match(/property="og:image"\s+content="([^"]+)"/i);
      if (og) pic = og[1];
    }
    if (!desc) {
      var md = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      if (md) desc = t(md[1]).slice(0, 400);
    }
    if (!pic && arr) {
      for (var pi = 0; pi < arr.length; pi++) {
        var pv = arr[pi];
        if (typeof pv === "string" && /\.(jpg|jpeg|png|webp)/i.test(pv) && pv.indexOf("http") === 0) {
          pic = pv;
          break;
        }
      }
    }

    // 集数：结构化 episodes 数组优先
    var episodes = [];
    if (arr) {
      for (var ei = 0; ei < arr.length; ei++) {
        var v = arr[ei];
        if (!Array.isArray(v) || !v.length) continue;
        var f = nuxtVal(arr, v[0]);
        if (!f || typeof f !== "object" || !("number" in f) || !("play_route" in f)) continue;
        for (var vi = 0; vi < v.length; vi++) {
          var ep = nuxtVal(arr, v[vi]);
          if (!ep || typeof ep !== "object") continue;
          var num = nuxtVal(arr, ep.number);
          var route = nuxtVal(arr, ep.play_route);
          if (!route || typeof route !== "string") continue;
          episodes.push({ name: "第" + (parseInt(num, 10) || vi + 1) + "集", playId: route });
        }
        if (episodes.length) break;
      }
    }
    // 回退 1：total_episode_count 拼 /play/{slug}/{N}
    if (!episodes.length && arr) {
      for (var ti = 0; ti < arr.length; ti++) {
        var tv = arr[ti];
        if (!tv || typeof tv !== "object" || !("total_episode_count" in tv)) continue;
        var tot = nuxtVal(arr, tv.total_episode_count);
        if (typeof tot === "number" && tot > 0) {
          for (var epn = 1; epn <= tot; epn++) {
            episodes.push({ name: "第" + epn + "集", playId: "/play/" + slug + "/" + epn });
          }
          break;
        }
      }
    }
    // 回退 2：扫描页内 /play/ 链接
    if (!episodes.length) {
      var links = html.match(/href=["'](\/play\/[^"']+)["']/gi) || [];
      var seenEp = {};
      for (var li = 0; li < links.length; li++) {
        var hm = links[li].match(/href=["'](\/play\/[^"']+)["']/i);
        if (!hm || seenEp[hm[1]]) continue;
        seenEp[hm[1]] = 1;
        var pn = hm[1].split("/").pop();
        episodes.push({ name: /^\d+$/.test(pn) ? "第" + pn + "集" : pn, playId: hm[1] });
      }
    }
    // 回退 3："N集" 正则推断
    if (!episodes.length) {
      var totM = html.match(/(\d+)\s*(?:集|话)/);
      var maxEp = totM ? parseInt(totM[1], 10) : 1;
      if (maxEp > 200) maxEp = 40;
      for (var ce = 1; ce <= maxEp; ce++) {
        episodes.push({ name: "第" + ce + "集", playId: "/play/" + slug + "/" + ce });
      }
    }

    await log("info", `[detail] ${videoId} name=${title} episodes=${episodes.length}`);
    return {
      list: [
        {
          vod_id: videoId,
          vod_name: title,
          vod_pic: proxyImg(pic),
          vod_cover: proxyImg(pic),
          vod_remarks: "全" + episodes.length + "集",
          vod_content: desc,
          vod_year: "",
          vod_area: "",
          vod_play_from: "默认",
          vod_play_url: episodes.map(function (e) { return e.name + "$" + e.playId; }).join("#"),
          vod_play_sources: [{ name: "默认", episodes: episodes }],
        },
      ],
    };
  } catch (e) {
    await log("error", `[detail] 失败: ${(e && e.message) || e}`);
    return { list: [] };
  }
}

/**
 * 函数：resolvePlay
 * 作用：播放页解析 m3u8。
 *   1. Nuxt 数组里 http 开头且含 .m3u8 的字符串
 *   2. 页面裸 m3u8 链接正则兜底
 */
function resolvePlay(html) {
  var arr = parseNuxtArr(html);
  if (arr) {
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (typeof v === "string" && v.indexOf(".m3u8") >= 0 && v.indexOf("http") === 0) {
        return v.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
      }
    }
  }
  var m = String(html || "").match(/["'](https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*)["']/i);
  return m ? m[1].replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/") : "";
}

/**
 * 作用：播放。playId 为 /play/{slug}/{N} 路径，现场解析 m3u8 直链（parse=0）；
 *   失败回退网页嗅探（parse=1）。
 */
async function play(params, context) {
  var flag = t((params && params.flag) || "") || "默认";
  var playId = t((params && (params.playId || params.url || params.id)) || "");
  if (!playId) {
    await log("error", `[play] playId 为空`);
    return { urls: [], flag: flag, header: {}, parse: 0 };
  }
  try {
    // 已是直链
    if (/^https?:\/\//i.test(playId) && /\.m3u8/i.test(playId)) {
      await log("info", `[play] 直链 parse=0 url=${playId}`);
      return {
        urls: [{ name: "默认", url: playId }],
        flag: flag,
        header: { "User-Agent": UA, Referer: SITE + "/" },
        parse: 0,
      };
    }

    var pageUrl = absUrl(playId);
    await log("info", `[play] playId=${playId}, flag=${flag}`);
    var html = await fetchHtml(pageUrl);
    var url = resolvePlay(html);
    if (url) {
      await log("info", `[play] parse=0 url=${url.slice(0, 120)}`);
      return {
        urls: [{ name: "默认", url: url }],
        flag: flag,
        header: { "User-Agent": UA, Referer: SITE + "/" },
        parse: 0,
      };
    }
    await log("warn", `[play] 未解出直链，回退嗅探 parse=1 url=${pageUrl}`);
    return {
      urls: [{ name: "播放页", url: pageUrl }],
      flag: flag,
      header: { "User-Agent": UA, Referer: SITE + "/" },
      parse: 1,
    };
  } catch (e) {
    await log("error", `[play] 失败: ${(e && e.message) || e}`);
    return {
      urls: [{ name: "播放页", url: absUrl(playId) }],
      flag: flag,
      header: { "User-Agent": UA, Referer: SITE + "/" },
      parse: 1,
    };
  }
}