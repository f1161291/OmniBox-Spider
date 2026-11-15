// @name 91成人短剧
// @author 宝宝巴士
// @description 91crdj · 成人短剧/漫剧/真人剧/视频，原 ForwardWidget 源 bbbs.js 适配 OmniBox；1.3.0 修正播放源为 POST /api/videos/{id}/episodes/{n}/playback 取 streams.main 正片 m3u8，并修正 @downloadURL
// @version 1.3.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91成人短剧.js

/**
 * ==========================================================================
 * 91成人短剧 - OmniBox 爬虫脚本（新格式）
 * ==========================================================================
 * 数据来源: https://91crdjai.com（91crdj.com 已 301 迁移到 91crdjai.com；crdj.net 同样可用）
 * 改编自: ForwardWidget 脚本 bbbs.js（作者：宝宝巴士）
 * 站点特征:
 *   - WordPress 卡片式列表（<a class="card">），封面 data-src + 图床密文需反代解密
 *   - 详情页 ep-grid 集数链接，播放页内嵌 <script id="playInitialData" type="application/json">
 *   - 卡片链接可能指向 91crdjai.com，请求主域会自动跳转，无需特殊处理
 *   - 搜索仅支持第 1 页，频道分页到页尾后返回 404
 * 【1.3.0 修复·获取不到播放视频】根因是播放源走的是独立 POST 接口，旧实现全猜错了。
 *   前端证据（2026-11-15 实抓）：
 *     - 播放页 <script data-main="/static/web/js/pages/drama-play.js">
 *     - drama-play.js: requirejs([..., 'services/playback']) -> playback.episode(data.id, n)
 *     - services/playback.js 的 request() 明确：
 *         http({ url:'/api/videos/{id}/episodes/{n}/playback', method:'POST',
 *                contentType:'application/json', data: JSON.stringify({}), useToken:true })
 *   因此真实协议是：POST + JSON body {} + __EP__ 填「集数 n」（不是 current.videoId），
 *   不能带 ?fmt=json（那是页面「随便逛」用的另一套接口），也不是 GET。
 *   响应：{ data:{ streams:{ main, hevc, preview }, manifest_method:"GET", cdn:{...} }, status:1 }
 *   main 即正片 m3u8（AES-128 加密 HLS），里面的 \u0026 需还原成 &。
 *   实测 POST /api/videos/10073/episodes/1/playback -> 200，
 *   main = https://yd-zhqr-hls.hzjvlo.cn/videos5/....m3u8?auth_key=...&v=3...
 *   该 m3u8 200、首 ts 分片 1.2MB 200、AES key 16B 200 —— 播放链完整可用。
 *   旧实现用 GET + ?fmt=json + __EP__ 填 videoId，三处都不对，所以永远拿不到源，
 *   只能回退 parse=1 嗅探，表现为「获取不到播放视频」。
 *   本版改为 postPlayback() 走正确 POST，并做 3 次有限重试（站点偶发 302 限流）。
 *   页面 current.src 依然恒为空 ""，这是站点设计（正片只从 POST 接口下发），不是故障。
 * 核心功能:
 *   - home: 4 个频道分类 + 首页推荐
 *   - category: 频道分页列表（分页器解析总页数）
 *   - search: 站内搜索
 *   - detail: 详情页 ep-grid 集数解析 → vod_play_sources
 *   - play: 播放页 player JSON 提取直链，失败回退网页嗅探（parse=1）
 * 环境变量:
 *   - CRDJ_HOST: 源站地址，默认 https://91crdjai.com（91crdj.com 已 301 迁移；crdj.net 可作备用）
 *   - CRDJ_IMG_PROXY: 封面图解密反代前缀，设为空字符串关闭，默认走 ik.bug.qzz.io
 * ==========================================================================
 */

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

/**
 * 作用：导出 5 个标准 handler 并启动 runner。
 * runner 从 stdin 读取 method/params/context，分发到同名 handler。
 */
module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ==================== 站点配置 ====================

/** 源站地址（可被环境变量 CRDJ_HOST 覆盖，用于域名失效时切换备用域） */
const HOST = String(process.env.CRDJ_HOST || "https://91crdjai.com").replace(/\/+$/, "");

/** 封面图解密反代前缀（91 图床返回密文，直链不可用；设空关闭） */
const IMG_PROXY =
  process.env.CRDJ_IMG_PROXY !== undefined
    ? String(process.env.CRDJ_IMG_PROXY)
    : "https://ik.bug.qzz.io/img?url=";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/** 频道分类（对应 4 个列表模块） */
const CHANNELS = [
  { type_id: "duanju", type_name: "成人短剧" },
  { type_id: "manju", type_name: "成人漫剧" },
  { type_id: "zhenrenju", type_name: "真人剧" },
  { type_id: "shipin", type_name: "成人视频" },
];

/** 分类列表每页卡片数估算值（去重后实测约 22），仅用于 total 估算 */
const PAGE_LIMIT = 22;

/** 无效/占位封面特征串 */
const BAD_PIC = [
  "data:",
  "base64,",
  "load.gif",
  "loading.gif",
  "placeholder",
  "default.png",
  "nopic",
  "eisees",
  "spacer.gif",
  "blank.gif",
];

/** 封面一次性签名参数，剥离后得到稳定 URL */
const AUTH_KEYS = {
  auth_key: 1,
  authkey: 1,
  auth: 1,
  sign: 1,
  signature: 1,
  token: 1,
  expires: 1,
  expire: 1,
  e: 1,
  t: 1,
  ts: 1,
  time: 1,
};

// ==================== 通用工具 ====================

/** 统一日志：带 [91短剧][method] 前缀 */
function log(level, message) {
  return OmniBox.log(level, `[91短剧] ${message}`);
}

/** 空值安全取字符串并 trim */
function t(v) {
  return String(v == null ? "" : v).trim();
}

/**
 * 作用：安全转整数，非法值返回 0。
 */
function toInt(v) {
  var n = parseInt(t(v), 10);
  return isNaN(n) ? 0 : n;
}

/** 标准请求头；显式 identity 避免端上自动加 Accept-Encoding 却不解压导致拿到二进制 */
function headers(referer) {
  return {
    "User-Agent": UA,
    Referer: referer || HOST + "/",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "identity",
  };
}

/** 相对路径补全域名（只认 host 自身，跨域绝对链接另行处理） */
function absUrl(u) {
  u = t(u);
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("http") === 0) return u;
  if (u.charAt(0) === "/") return HOST + u;
  return HOST + "/" + u;
}

/** 大小写不明的响应头里按名取值 */
function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    var v = headers.get(name);
    if (v != null) return String(v);
  }
  for (var k in headers) {
    if (String(k).toLowerCase() === name.toLowerCase()) return String(headers[k] || "");
  }
  return "";
}

/** 去标签 + 常见 HTML 实体还原 */
function cleanText(s) {
  s = t(s).replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s.replace(/\s+/g, " ").trim();
}

/** 剥掉一次性签名参数，得到稳定可缓存的封面 URL */
function stripAuth(u) {
  u = t(u);
  var i = u.indexOf("?");
  if (i < 0) return u;
  var base = u.slice(0, i);
  var qs = u.slice(i + 1).split("&");
  var keep = [];
  for (var j = 0; j < qs.length; j++) {
    var part = qs[j];
    if (!part) continue;
    var k = part.split("=")[0].toLowerCase();
    if (AUTH_KEYS[k]) continue;
    keep.push(part);
  }
  return keep.length ? base + "?" + keep.join("&") : base;
}

/** 封面清洗：无效图过滤 → 补全域 → 剥签名参数 */
function cleanPic(u) {
  u = t(u).replace(/^["']|["']$/g, "");
  if (!u) return "";
  var low = u.toLowerCase();
  for (var i = 0; i < BAD_PIC.length; i++) {
    if (low.indexOf(BAD_PIC[i]) >= 0) return "";
  }
  return stripAuth(absUrl(u));
}

/** 封面走图床解密反代（密文图直链不可读，实测需经 ik.bug.qzz.io） */
function resolveCover(u) {
  var url = cleanPic(u);
  if (!url) return "";
  if (/zdmhyg|wirqed|eisees|pic\./i.test(url) && IMG_PROXY) {
    url = IMG_PROXY + encodeURIComponent(url);
  }
  return url;
}

/**
 * 函数：bodyToText
 * 作用：把响应体规整为 UTF-8 文本，防御端上返回未解压的 gzip/brotli 流。
 *   （实测：站点对 Accept-Encoding: gzip 返回压缩二进制，直接按字符串处理会解析出 0 卡片）
 * 入参：@param {any} body
 * 出参：@returns {string}
 */
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
 * 作用：请求 HTML 页面；站点偶发断连，失败自动重试一次，最终失败记录原因并返回 ""。
 *   - OmniBox.request 不跟随跳转（91crdj.com 全站 301 到 91crdjai.com），这里手动跟随
 *   - 响应体若为压缩二进制会先尝试解压，保证拿到可解析文本
 * 入参：@param {string} url @param {string} [referer]
 * 出参：@returns {Promise<string>} HTML 文本，失败为 ""
 */
async function fetchHtml(url, referer) {
  var lastError = "";
  for (var attempt = 1; attempt <= 2; attempt++) {
    var current = url;
    var hops = 0;
    var redirected = false;
    while (hops < 6) {
      hops++;
      try {
        var res = await OmniBox.request(current, {
          method: "GET",
          headers: headers(referer || HOST + "/"),
        });
        var status = Number(res && res.statusCode) || 0;
        var body = bodyToText(res && res.body);

        if (status >= 200 && status < 300 && body) {
          if (redirected) {
            await log("info", `[请求] 跳转后命中 ${current}`);
          }
          return body;
        }
        // 端上不跟随跳转：手动跟进 Location（301/302/307/308）
        if (status >= 300 && status < 400) {
          var loc = headerValue(res && res.headers, "location");
          if (loc) {
            current = absUrl(loc);
            redirected = true;
            continue;
          }
          lastError = "HTTP " + status + "（缺少 Location）len=" + body.length;
          break;
        }
        lastError = "HTTP " + status + " len=" + body.length;
        break;
      } catch (e) {
        lastError = (e && e.message) || String(e);
        break;
      }
    }
    if (redirected) {
      await log("warn", `[请求] 跳转链未取到内容 url=${url} → ${current} 原因=${lastError}`);
    }
  }
  await log("warn", `[请求] 失败 url=${url} 原因=${lastError}`);
  return "";
}

/**
 * 函数：postPlayback
 * 作用：调用站点真正的播放源接口（2026-11-15 实测修正）。
 *
 * 【这是本次「获取不到播放视频」的根因】
 * 前端 /static/web/js/pages/drama-play.js 里是
 *     requirejs([..., 'services/playback'], ...) -> playback.episode(data.id, n)
 * 而 services/playback.js 的 request() 明确是：
 *     http({ url: '/api/videos/{id}/episodes/{n}/playback',
 *            method: 'POST', contentType: 'application/json',
 *            data: JSON.stringify(data || {}), useToken: true })
 * 即：
 *   1) 必须是 POST，且 Content-Type: application/json，body 为 {}；
 *   2) __EP__ 填「集数 n」（1,2,3...），不是 current.videoId；
 *   3) 不能加 ?fmt=json（那是页面里「随便逛」用的另一套接口）；
 *   4) 响应是 { data: { streams: { main, hevc, preview }, manifest_method, cdn, ... }, status: 1 }；
 *      main 就是正片 m3u8，里面的 \u0026 必须还原成 &。
 *
 * 旧实现用 GET + ?fmt=json + 把 __EP__ 填成 videoId，三处都不对，所以永远拿不到源。
 * 站点偶发 302（限流），这里做有限重试。
 */
async function postPlayback(apiPath, ep, referer) {
  var url = absUrl(apiPath);
  var payload = "{}";
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var h = headers(referer || HOST + "/");
      h["Content-Type"] = "application/json";
      h["Accept"] = "application/json, text/plain, */*";
      h["Origin"] = HOST;
      h["Accept-Encoding"] = "identity";
      var res = await OmniBox.request(url, {
        method: "POST",
        headers: h,
        body: payload,
      });
      var status = Number(res && res.statusCode) || 0;
      var text = bodyToText(res && res.body);
      if (status === 200 && text) {
        var data;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (data) {
          var root = (data.data && typeof data.data === "object") ? data.data : data;
          var streams = root.streams || {};
          // main 优先，其次 hevc，最后 preview
          var pick = t(streams.main) || t(streams.hevc) || t(streams.preview);
          if (pick) {
            // \u0026 -> &，保证 URL 参数完整
            pick = pick.replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
            await log("info", `[playback] POST 命中 n=${ep} main=${pick.slice(0, 120)}`);
            return pick;
          }
          await log("warn", `[playback] POST 200 但 streams 为空 n=${ep} status=${data.status} msg=${data.msg || ""}`);
          return "";
        }
      }
      await log("warn", `[playback] 第${attempt}次 HTTP ${status} len=${text.length} url=${url}`);
    } catch (e) {
      await log("warn", `[playback] 第${attempt}次异常: ${(e && e.message) || e}`);
    }
  }
  return "";
}

// ==================== 列表/卡片解析 ====================

/** 从任意链接里拆出频道段与规范路径：/channel/id-slug/ 或 /channel/id/ */
function splitPath(href) {
  href = t(href);
  var m = href.match(/https?:\/\/[^/]+(\/.*)/);
  if (m) href = m[1];
  if (href.charAt(0) !== "/") href = "/" + href;
  var seg = href.split("/").filter(Boolean);
  if (seg.length < 2) return { channel: "", path: "" };
  return { channel: seg[0], path: "/" + seg[0] + "/" + seg[1] + "/" };
}

/** 从卡片块里按优先级取第一张有效封面（lazy 属性优先于 src） */
function pickPicFromBlock(block) {
  var attrs = ["data-original", "data-src", "data-echo", "data-lazy-src", "data-url", "data-thumb"];
  for (var i = 0; i < attrs.length; i++) {
    var re = new RegExp(attrs[i] + '\\s*=\\s*"([^"]+)"', "i");
    var m = block.match(re);
    if (m) {
      var p = resolveCover(m[1]);
      if (p) return p;
    }
  }
  var sm = block.match(/\bsrc\s*=\s*"([^"]+)"/i);
  return sm ? resolveCover(sm[1]) : "";
}

/**
 * 函数：parseCards
 * 作用：把列表页 HTML 里的 <a class="card"> 卡片解析为 OmniBox 标准视频项。
 * 入参：@param {string} html @param {string} [defaultChannel]
 * 出参：@returns {Array<Object>} VodItem 数组（vod_id 为站点路径）
 */
function parseCards(html, defaultChannel) {
  var items = [];
  var seen = {};
  if (!html) return items;

  // 按完整卡片开标签切分（捕获组把开标签留在 parts 里，href 在类名前后都兼容）
  var parts = html.split(/(<a[^>]*\bclass\s*=\s*"[^"]*\bcard\b[^"]*"[^>]*>)/i);
  for (var i = 1; i < parts.length; i += 2) {
    var openTag = parts[i] || "";
    var body = parts[i + 1] || "";
    var end = body.search(/<\/a>/i);
    if (end >= 0) body = body.slice(0, end);

    var hm = openTag.match(/href\s*=\s*"([^"]+)"/i);
    if (!hm) continue;
    var sp = splitPath(hm[1]);
    if (!sp.path) continue;
    if (seen[sp.path]) continue;
    if (/\/page\/\d+/.test(sp.path)) continue;

    var title = "";
    var tm =
      (openTag + body).match(/data-track-item-name\s*=\s*"([^"]*)"/i) ||
      (openTag + body).match(/\balt\s*=\s*"([^"]*)"/i) ||
      (openTag + body).match(/\btitle\s*=\s*"([^"]*)"/i);
    if (tm) title = cleanText(tm[1]);
    if (!title) {
      var pt = body.match(/<span class="p-title[^"]*">([\s\S]*?)<\/span>/i);
      if (pt) title = cleanText(pt[1]);
    }
    if (!title) title = sp.path;

    var remarks = "";
    var rm = body.match(/<span class="(?:badge|eps-flag)[^"]*">([\s\S]*?)<\/span>/i);
    if (rm) remarks = cleanText(rm[1]);

    var channel = sp.channel || defaultChannel || "";
    seen[sp.path] = 1;
    items.push({
      vod_id: sp.path,
      vod_name: title,
      vod_pic: pickPicFromBlock(openTag + body),
      vod_cover: pickPicFromBlock(openTag + body),
      vod_remarks: remarks,
      type_id: channel,
      type_name: (CHANNELS.find(function (c) { return c.type_id === channel; }) || {}).type_name || "",
    });
  }
  return items;
}

/** 从列表页分页器解析频道总页数（/channel/page/N/，取最大值），解析不到返回 0 */
function maxPageFromHtml(html, channel) {
  if (!html) return 0;
  var re = new RegExp("/" + channel + "/page/(\\d+)/", "g");
  var max = 0;
  var m;
  while ((m = re.exec(html))) max = Math.max(max, parseInt(m[1], 10) || 0);
  return max;
}

/** 估算总条数：(pagecount-1) * 每页条数 + 本页条数 */
function estimateTotal(pagecount, page, listLength) {
  if (!pagecount || pagecount <= 1) return listLength;
  return (pagecount - 1) * PAGE_LIMIT + listLength;
}

// ==================== 5 个标准 handler ====================

/**
 * 作用：首页 = 4 个频道分类 + 首页推荐卡片流。
 * 出参：@returns {Promise<{class: Array, list: Array}>}
 */
async function home(params, context) {
  try {
    var from = (context && context.from) || "web";
    await log("info", `[home] from=${from}`);
    var html = await fetchHtml(HOST + "/");
    var list = parseCards(html, "");
    if (html && !list.length) {
      // 有响应但没解析到卡片：多半是拿到防护页/压缩流，把现场打出来便于定位
      await log("warn", `[home] 页面非空但未解析到卡片 len=${html.length} head=${html.slice(0, 120).replace(/\s+/g, " ")}`);
    }
    await log("info", `[home] class=${CHANNELS.length} list=${list.length} host=${HOST}`);
    return { class: CHANNELS, list: list };
  } catch (e) {
    await log("error", `[home] 失败: ${(e && e.message) || e}`);
    return { class: CHANNELS, list: [] };
  }
}

/**
 * 作用：频道分页列表；总页数从分页器解析，页尾之后（站点 404）返回空列表。
 * 入参：@param {Object} params - { categoryId: 频道, page: 页码 }
 * 出参：@returns {Promise<{page, pagecount, total, list}>}
 */
async function category(params, context) {
  try {
    var categoryId = t(params && params.categoryId) || "duanju";
    var page = Math.max(1, parseInt((params && params.page) || 1, 10) || 1);
    if (!CHANNELS.some(function (c) { return c.type_id === categoryId; })) categoryId = "duanju";

    var url = page > 1 ? HOST + "/" + categoryId + "/page/" + page + "/" : HOST + "/" + categoryId + "/";
    await log("info", `[category] categoryId=${categoryId}, page=${page}, url=${url}`);
    var html = await fetchHtml(url);
    var list = parseCards(html, categoryId);
    if (!html) {
      // 请求失败或超出末页（站点 404）：pagecount=0 让端上停止翻页
      await log("warn", `[category] 第 ${page} 页无响应（已到末页或网络失败）`);
      return { page: page, pagecount: 0, total: 0, list: [] };
    }
    if (!list.length) {
      await log("warn", `[category] 页面非空但未解析到卡片 len=${html.length} head=${html.slice(0, 120).replace(/\s+/g, " ")}`);
    }
    var pagecount = maxPageFromHtml(html, categoryId) || (list.length ? page + 1 : page);
    await log("info", `[category] count=${list.length} pagecount=${pagecount}`);
    return { page: page, pagecount: pagecount, total: estimateTotal(pagecount, page, list.length), list: list };
  } catch (e) {
    await log("error", `[category] 失败: ${(e && e.message) || e}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 作用：站内搜索（站点仅支持第 1 页，翻页请求会 404，直接短路）。
 * 入参：@param {Object} params - { keyword/wd, page }
 * 出参：@returns {Promise<{page, pagecount, total, list}>}
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

    var url = HOST + "/search/?q=" + encodeURIComponent(keyword);
    await log("info", `[search] keyword=${keyword}, url=${url}`);
    var html = await fetchHtml(url);
    var list = parseCards(html, "");
    if (html && !list.length) {
      await log("warn", `[search] 页面非空但未解析到卡片 len=${html.length} head=${html.slice(0, 120).replace(/\s+/g, " ")}`);
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
 * 作用：详情页解析 → 单条 VodItem + ep-grid 集数 → vod_play_sources。
 * 入参：@param {Object} params - { videoId: 站点路径 /duanju/id-slug/ }
 * 出参：@returns {Promise<{list: Array}>}
 */
async function detail(params, context) {
  try {
    var videoId = t((params && (params.videoId || params.id)) || "");
    // 兼容完整 URL 形式入参：剥域只留路径
    var m = videoId.match(/https?:\/\/[^/]+(\/.*)/);
    if (m) videoId = m[1];
    if (!videoId) return { list: [] };

    await log("info", `[detail] videoId=${videoId}`);
    var url = absUrl(videoId);
    var html = await fetchHtml(url);
    if (!html) return { list: [] };

    // 标题：详情页 h1 优先
    var title = "";
    var hm =
      html.match(/<h1[^>]*class="[^"]*detail[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (hm) title = cleanText(hm[1]);
    title = title || videoId;

    // 封面：p-img 优先（og:image 常为 eisees 密文，会被过滤）
    var pic = "";
    var pimg = html.match(/<img class="p-img"[^>]*>/i);
    if (pimg) pic = pickPicFromBlock(pimg[0]);
    if (!pic) {
      var og = html.match(/<meta[^>]*og:image[^>]*content="([^"]+)"/i);
      if (og) pic = resolveCover(og[1]);
    }

    // 简介：og:description / description meta
    var desc = "";
    var dm =
      html.match(/<meta[^>]*og:description[^>]*content="([^"]*)"/i) ||
      html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i);
    if (dm) desc = cleanText(dm[1]).slice(0, 400);

    // 集数：ep-grid 内 href>数字</a>，只收属于当前剧的链接
    var grid = html.match(/<div class="ep-grid">([\s\S]*?)<\/div>/i);
    var scan = grid ? grid[1] : "";
    var eps = [];
    var seenEp = {};
    var re = /href="([^"]+)"[^>]*>\s*(\d+)\s*<\/a>/g;
    var em;
    while ((em = re.exec(scan))) {
      var href = em[1];
      var epNo = parseInt(em[2], 10) || 0;
      if (!epNo || seenEp[epNo]) continue;
      // 归属校验：链接需包含详情路径或其 id 段
      var idSeg = videoId.split("/").filter(Boolean)[1] || "";
      if (href.indexOf(videoId.replace(/\/$/, "")) < 0 && href.indexOf(videoId) < 0) {
        if (idSeg && href.indexOf(idSeg) < 0) continue;
      }
      seenEp[epNo] = 1;
      eps.push({ ep: epNo, href: absUrl(href) });
    }
    eps.sort(function (a, b) { return a.ep - b.ep; });
    if (!eps.length) {
      // 无集数网格：按单集处理，直拼第 1 集地址
      eps.push({ ep: 1, href: absUrl(videoId.replace(/\/?$/, "/") + "1/") });
    }

    var episodes = eps.map(function (item) {
      return { name: eps.length === 1 ? "正片" : "第" + item.ep + "集", playId: item.href };
    });

    var item = {
      vod_id: videoId,
      vod_name: title,
      vod_pic: pic,
      vod_cover: pic,
      vod_remarks: "更新至" + episodes.length + "集",
      vod_content: desc,
      vod_year: "",
      vod_area: "",
      vod_actor: "",
      vod_director: "",
      vod_play_from: "91在线",
      vod_play_url: episodes.map(function (e) { return e.name + "$" + e.playId; }).join("#"),
      vod_play_sources: [{ name: "91在线", episodes: episodes }],
    };
    await log("info", `[detail] id=${videoId} name=${title} episodes=${episodes.length}`);
    return { list: [item] };
  } catch (e) {
    await log("error", `[detail] 失败: ${(e && e.message) || e}`);
    return { list: [] };
  }
}

/**
 * 函数：extractM3u8
 * 作用：从播放页提取媒体地址，三级策略。
 *   1. player JSON 里的 "current":{"src":...}（当前站点主路径，已实测）
 *   2. MacCMS player_aaaa / player_data 变量（兼容老页面）
 *   3. 页面中任意裸 m3u8 链接兜底
 * 入参：@param {string} html
 * 出参：@returns {string} 媒体地址，未提取到返回 ""
 */
/**
 * 作用：从播放页 HTML 中提取播放源。
 * 关键事实（2026-11-15 实测）：
 *   站点把「集数信息」放在 <script id="playInitialData" type="application/json"> 里，
 *   结构是 { id, current:{ n,title,src,srcHevc,videoId,... }, eps:[...],
 *            playbackEndpoint:"/api/videos/{id}/episodes/__EP__/playback", ... }
 *   - current.src / srcHevc 恒为空 ""：正片不放在页面里，只从 POST playback 接口下发；
 *   - 因此 play() 拿到 playbackEndpoint + 集数 n 后，必须走 postPlayback() 的 POST 请求。
 * 注意：原正则 /"current"\s*:\s*\{[^{}]*"src"\s*:\s*"([^"]+)"/ 有两个致命问题：
 *   1) [^{}]* 不允许嵌套，而 current 里字段一多就会失配；
 *   2) 只匹配非空 src，遇到 src:"" 直接不命中，然后落到「整页搜 .m3u8」分支，
 *      而该站页面里根本没有裸 m3u8 文本 —— 最终必然回退 parse=1 嗅探，播放器也嗅不到，
 *      表现就是「视频无法播放」。
 * 因此改为：先整体解析 playInitialData JSON（括号配平，容忍嵌套），再逐级回退。
 */
function parsePlayInitialData(html) {
  if (!html) return null;
  var m = html.match(/<script[^>]+id="playInitialData"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  var raw = t(m[1]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * 作用：判断是否为可播放媒体直链。
 * 该站主源是明文 .m3u8，但部分线路带 query（?auth_key=... / ?v=1），
 * 不能只认「以 .m3u8 结尾」。
 */
function isMediaUrl(u) {
  u = t(u);
  if (!u) return false;
  if (!/^https?:\/\//i.test(u) && u.indexOf("//") !== 0) return false;
  return /\.(m3u8|mp4|flv|webm|mkv)(\?|#|$)/i.test(u) || /\/hls\//i.test(u) || /\.v1\./i.test(u);
}

/**
 * 作用：从播放页解析出播放直链与辅助信息。
 * 返回 { url, srcHevc, playbackEndpoint, videoId, dramaId, n, title, hasAds }
 * 其中 url 可能为空字符串（站点未下发 src 时），调用方需据此走二次取源。
 */
function extractPlayInfo(html) {
  var info = {
    url: "",
    srcHevc: "",
    playbackEndpoint: "",
    videoId: "",
    dramaId: "",
    n: 0,
    title: "",
  };
  if (!html) return info;

  var data = parsePlayInitialData(html);
  if (data) {
    var cur = data.current || {};
    info.url = t(cur.src || "").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    info.srcHevc = t(cur.srcHevc || "").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    info.videoId = t(cur.videoId || "");
    info.n = toInt(cur.n) || 0;
    info.title = t(cur.title || "");
    info.playbackEndpoint = t(data.playbackEndpoint || "");
    info.dramaId = t(data.id || "");
  }

  // 回退 1：老式 player_aaaa / player_data 全局对象
  if (!info.url) {
    var names = ["player_aaaa", "player_data"];
    for (var i = 0; i < names.length; i++) {
      var re = new RegExp(names[i] + "\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?\\s*</script>");
      var mm = html.match(re);
      if (mm) {
        try {
          var obj = JSON.parse(mm[1]);
          var u = t(obj.url || obj.link || "");
          if (isMediaUrl(u)) {
            info.url = u;
            break;
          }
        } catch (e) {}
      }
    }
  }

  // 回退 2：页面里裸的 m3u8 / mp4 文本（当前站点没有，但保留以兼容改版）
  if (!info.url) {
    var m3 = html.match(/(https?:\/\/[^'"\s<>]+?\.(?:m3u8|mp4)[^'"\s<>]*)/i);
    if (m3 && isMediaUrl(m3[1])) info.url = m3[1].replace(/\\\//g, "/").replace(/&amp;/g, "&");
  }

  return info;
}

/**
 * 作用：向后兼容旧调用点，返回纯 URL 字符串。
 */
function extractM3u8(html) {
  var info = extractPlayInfo(html);
  if (info.url) return info.url;
  if (info.srcHevc && isMediaUrl(info.srcHevc)) return info.srcHevc;
  return "";
}

/**
 * 作用：播放解析。playId 为集数页地址时现场提取 m3u8 直链（parse=0）；
 *   直接是媒体链接则原样返回；提取失败回退网页嗅探（parse=1）。
 * 入参：@param {Object} params - { playId, flag }
 * 出参：@returns {Promise<{urls, flag, header, parse}>}
 */
async function play(params, context) {
  var flag = t((params && params.flag) || "") || "91在线";
  var playId = t((params && (params.playId || params.url)) || "");
  if (!playId) {
    await log("error", `[play] playId 为空`);
    return { urls: [], flag: flag, header: {}, parse: 0 };
  }

  var playHeaders = { "User-Agent": UA, Referer: HOST + "/", Accept: "*/*" };

  try {
    // 已是媒体直链：UA 头直出
    if (isMediaUrl(playId)) {
      await log("info", `[play] 直链 parse=0 url=${playId}`);
      return { urls: [{ name: "播放", url: playId }], flag: flag, header: playHeaders, parse: 0 };
    }

    await log("info", `[play] playId=${playId}, flag=${flag}`);

    // ① 抓播放页，从 playInitialData 解析（原实现的正则在这里失配，是本次播放失败的主因）
    var html = await fetchHtml(playId, playId);
    var info = extractPlayInfo(html);

    if (!info.url && !info.srcHevc) {
      // 换 Referer 再试一次（播放页对来源敏感）
      html = await fetchHtml(playId, HOST + "/");
      info = extractPlayInfo(html);
    }

    await log(
      "info",
      `[play] playInitialData: src=${info.url ? "有" : "空"}, srcHevc=${info.srcHevc ? "有" : "空"}, ` +
        `videoId=${info.videoId || "-"}, n=${info.n || "-"}, endpoint=${info.playbackEndpoint || "-"}`
    );

    // ② 站点未在页面下发 src 时，POST playback 接口现取正片（实测唯一有效路径）
    //    __EP__ 填集数 n；接口为 POST + JSON body {}，不能用 GET / ?fmt=json
    if (!info.url && info.playbackEndpoint) {
      var epsToTry = [];
      if (info.n) epsToTry.push(info.n);
      // 从播放页路径末尾的 /{集数}/ 再兜底取一次
      var mEp = String(playId).match(/\/(\d+)\/?$/);
      if (mEp) {
        var nFromPath = toInt(mEp[1]);
        if (nFromPath && epsToTry.indexOf(nFromPath) < 0) epsToTry.push(nFromPath);
      }
      if (!epsToTry.length) epsToTry.push(1);

      for (var i = 0; i < epsToTry.length && !info.url; i++) {
        var ep = epsToTry[i];
        var apiPath = info.playbackEndpoint.replace("__EP__", String(ep));
        await log("info", `[play] POST playback 接口: ${apiPath} (n=${ep})`);
        var got = await postPlayback(apiPath, ep, playId);
        if (got) {
          info.url = got;
          await log("info", `[play] playback 接口命中正片: ${got.slice(0, 120)}`);
        }
      }
    }

    // ③ 主源为空但 HEVC 源可用时先用备用源，保证能播
    if (!info.url && info.srcHevc && isMediaUrl(info.srcHevc)) {
      await log("info", `[play] 主源为空，改用 srcHevc 备用源`);
      info.url = info.srcHevc;
    }

    if (info.url && isMediaUrl(info.url)) {
      var url = absUrl(info.url);
      await log("info", `[play] parse=0 url=${url}`);
      return {
        urls: [{ name: "在线", url: url }],
        flag: flag,
        header: { "User-Agent": UA, Referer: playId, Accept: "*/*" },
        parse: 0,
      };
    }

    // ④ 站点确未下发任何源：返回明确原因，避免端上误以为脚本坏了
    await log(
      "warn",
      `[play] 站点未下发播放源（src/srcHevc 均为空，playback 接口亦未返回直链）；` +
        `该情况属站点侧限制，回退播放页嗅探 url=${playId}`
    );
    return {
      urls: [{ name: "播放页", url: playId }],
      flag: flag,
      header: { "User-Agent": UA, Referer: playId },
      parse: 1,
    };
  } catch (e) {
    await log("error", `[play] 失败: ${(e && e.message) || e}`);
    return {
      urls: [{ name: "播放页", url: playId }],
      flag: flag,
      header: { "User-Agent": UA, Referer: playId },
      parse: 1,
    };
  }
}

/**
 * 作用：从 playback 接口响应里挖出可播放地址。
 * 该接口可能返回 JSON（{url|src|data:{url}}）或直跳 302 到真实 m3u8；
 * fetchHtml 已跟完跳转并把最终 body 返回，因此两种情况都要覆盖。
 */
function pickUrlFromJson(raw) {
  var body = t(raw);
  if (!body) return "";

  // 直接就是 m3u8 文本（被 302 带到真实源）
  if (/^#EXTM3U/i.test(body)) return "";

  // JSON 形态
  if (body.charAt(0) === "{" || body.charAt(0) === "[") {
    try {
      var obj = JSON.parse(body);
      var candidates = [
        obj && obj.url,
        obj && obj.src,
        obj && obj.data && obj.data.url,
        obj && obj.data && obj.data.src,
        obj && obj.result && obj.result.url,
        obj && obj.data && obj.data.playUrl,
      ];
      for (var i = 0; i < candidates.length; i++) {
        var c = t(candidates[i]).replace(/\\\//g, "/");
        if (isMediaUrl(c)) return c;
      }
    } catch (e) {}
    // JSON 里嵌的裸 m3u8
    var mj = body.match(/"(https?:\\?\/\\?\/[^"]+?\.(?:m3u8|mp4)[^"]*)"/i);
    if (mj) {
      var cand = mj[1].replace(/\\\//g, "/");
      if (isMediaUrl(cand)) return cand;
    }
  }

  // 纯文本或 HTML 里裸的 m3u8
  var m = body.match(/(https?:\/\/[^'"\s<>]+?\.(?:m3u8|mp4)[^'"\s<>]*)/i);
  if (m && isMediaUrl(m[1])) return m[1].replace(/\\\//g, "/").replace(/&amp;/g, "&");
  return "";
}