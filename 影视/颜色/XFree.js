// @name XFree
// @version 1.0.0
// @author omnibox-spider
// @description xfree.com 采集源（结构完备 + 明确降级）：KVS/flashvars 多档 mp4，1080P>720P>480P 最高分辨率优先；当前出口被 CF 拦截，源结构已就绪，换出口或配 FLARESOLVERR_URL 后即可用
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/XFree.js
// @dependencies cheerio
// 当前出口被 Cloudflare challenge 拦截（HTTP 403 "Just a moment"，实测换 Chrome/Googlebot/facebook UA 全部 403，无可用 API/镜像）；
// 源结构已就绪，换出口 IP 或配 FLARESOLVERR_URL 后即可用；命中 CF 时打清晰日志并安全返回空结构。
// 环境变量：XFREE_HOST（默认 https://www.xfree.com）、XFREE_COOKIE（可选 cf_clearance）、XFREE_PROXY_URL（提示用）、FLARESOLVERR_URL（可选页面级绕过）。
// 日志一律 OmniBox.log(level,msg) + Promise.catch 兜住；绝不向标准输出写日志。

/**
 * 实站事实与降级口径（诚实交付，不假装抓到数据）
 * 1) https://www.xfree.com/ 当前出口返回 403 + cf-mitigated: challenge，body 为 "Just a moment..."；
 *    实测换 Chrome / Googlebot / facebook UA 全部 403；robots 只给 llms.txt 与 sitemap，
 *    没有可直接取数的 JSON API 或镜像。因此本源完整实现五方法 + 完整解析结构，
 *    但请求失败/命中 challenge 一律 log(error) 一条清晰日志并安全返回空结构，绝不崩。
 * 2) 恢复通路：
 *    - 换出口 IP（干净出口），或由宿主/运行环境注入 XFREE_PROXY_URL 走代理出口；
 *    - 配 XFREE_COOKIE=cf_clearance=...（CF cookie 常与 UA/IP/路径强绑定，单独复用可能仍 403）；
 *    - 配 FLARESOLVERR_URL：按「页面级缓存」方案直接使用 solution.response，
 *      不做「只缓存 cookie 再自建请求重试」这种已证伪的模式。
 * 3) 站点结构（通用 KVS / xfree 形态）：
 *    - 列表卡片 div.thumb / div[class*="thumb"] / div.wall__item / li[class*="video"]，
 *      卡内 a[href] 指向详情，img data-src（回退 data-original / src）为封面，
 *      [class*="duration"] 为时长，标题取 a[title] / 标题节点 / img alt / 卡片文本。
 *    - 详情页 var flashvars = { video_url, video_alt_url, video_alt_url2, ... } 三档 mp4：
 *      video_alt_url2=1080p、video_alt_url=720p、video_url=480p。
 *    - 分类 /categories/{slug}/、搜索 /search/{kw}/、路径分页 /{N}/；分类清单抓不到时用内置兜底。
 * 4) 【最高分辨率优先】QUALITY_DEFS 固定 1080>720>480（兼容 alt_url3/4 更高档），
 *    heightFromUrl() 从 URL 读真实高度，sortVariantsByHeightDesc() 按 height 数值降序；
 *    detail 的 vod_play_sources[0] 与 play 的 urls[0] 恒为最高档 1080P。
 * 5) 缓存：home/category/search/detail/分类清单走 getCache/setCache 短 TTL，失败安全降级；
 *    play 不缓存（签名/时效），FlareSolverr 绕过页按 URL 单独缓存 3600s。
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
  // 本地调试兜底：全空实现，绝不写 stdout
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
const DEFAULT_HOST = "https://www.xfree.com";

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_HOST;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return DEFAULT_HOST;
  }
}

const HOST = normalizeHost(process.env.XFREE_HOST || DEFAULT_HOST);
const COOKIE = String(process.env.XFREE_COOKIE || "").trim();
const PROXY_URL = String(process.env.XFREE_PROXY_URL || "").trim();
const FLARESOLVERR_URL = String(
  process.env.XFREE_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || ""
).trim();

const BASE_TTL = Math.max(0, Number(process.env.XFREE_CACHE_TTL || 300) || 300);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.round(BASE_TTL * 0.8);
const SEARCH_TTL = Math.round(BASE_TTL * 0.6);
const DETAIL_TTL = Math.min(90, Math.round(BASE_TTL * 0.3));
const CLASSES_TTL = Math.max(BASE_TTL, 1800);
const CF_PAGE_TTL = Math.max(60, Number(process.env.XFREE_CF_PAGE_CACHE_TTL || 3600) || 3600);
const CACHE_PREFIX = "xf:page:";
const CF_PAGE_PREFIX = "xf:cfpage:";

// 分类清单抓取失败时的内置常见分类兜底（通用 KVS slug 形态）
const FALLBACK_CLASSES = [
  { type_id: "all", type_name: "全部" },
  { type_id: "amateurs", type_name: "业余" },
  { type_id: "teen", type_name: "Teen" },
  { type_id: "big-tits", type_name: "Big Tits" },
  { type_id: "big-ass", type_name: "Big Ass" },
  { type_id: "anal", type_name: "Anal" },
  { type_id: "milf", type_name: "MILF" },
  { type_id: "blowjob", type_name: "Blowjob" },
  { type_id: "creampie", type_name: "Creampie" },
  { type_id: "lesbian", type_name: "Lesbian" },
  { type_id: "blonde", type_name: "Blonde" },
  { type_id: "brunette", type_name: "Brunette" },
  { type_id: "cumshot", type_name: "Cumshot" },
  { type_id: "doggystyle", type_name: "Doggystyle" },
  { type_id: "hentai", type_name: "Hentai" },
  { type_id: "pov", type_name: "POV" },
  { type_id: "solo", type_name: "Solo" },
  { type_id: "threesome", type_name: "Threesome" },
  { type_id: "squirt", type_name: "Squirt" },
  { type_id: "facial", type_name: "Facial" },
  { type_id: "public", type_name: "Public" },
  { type_id: "tattoo", type_name: "Tattoo" },
  { type_id: "ebony", type_name: "Ebony" },
  { type_id: "asian", type_name: "Asian" },
  { type_id: "latina", type_name: "Latina" },
  { type_id: "mature", type_name: "Mature" },
];

// flashvars 多档定义：严格按 1080 > 720 > 480 降序声明，另兼容更高档
const QUALITY_DEFS = [
  { key: "video_alt_url2", height: 1080 },
  { key: "video_alt_url", height: 720 },
  { key: "video_url", height: 480 },
  { key: "video_alt_url3", height: 1440 },
  { key: "video_alt_url4", height: 2160 },
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ---------------------------------------------------------------------------
// 日志 / 缓存 / HTTP / CF 降级
// ---------------------------------------------------------------------------

function log(level, message) {
  try {
    if (typeof OmniBox.log !== "function") return;
    const p = OmniBox.log(level, `[xfree] ${message}`);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

/** 命中 CF / 请求失败时的唯一清晰日志出口（用户可在宿主日志里直接搜这句话）。 */
function logDegrade(reason, url) {
  const fl = FLARESOLVERR_URL
    ? `FLARESOLVERR_URL 已配置(${FLARESOLVERR_URL})，将尝试页面级绕过`
    : "FLARESOLVERR_URL 未配置";
  const px = PROXY_URL ? `XFREE_PROXY_URL 已配置(${PROXY_URL})` : "XFREE_PROXY_URL 未配置";
  const ck = COOKIE ? "XFREE_COOKIE(cf_clearance) 已配置" : "XFREE_COOKIE(cf_clearance) 未配置";
  log(
    "error",
    `Cloudflare 403 challenge，需换出口 IP 或配 FLARESOLVERR_URL；${reason} @ ${url}；${fl}；${px}；${ck}；源结构已就绪，安全返回空结构`
  );
}

function md5(text) {
  try {
    return require("crypto").createHash("md5").update(String(text)).digest("hex");
  } catch (_) {
    return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32) || "cachekey";
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
    if (ttl > 0 && value && typeof OmniBox.setCache === "function") {
      const p = OmniBox.setCache(key, value, ttl);
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (_) {}
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(String(text || ""));
  } catch (_) {
    return String(text || "");
  }
}

function absoluteUrl(value) {
  const s = decodeEntities(String(value || "").trim());
  if (!s) return "";
  if (/^\/\//.test(s)) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return `${HOST}${s}`;
  return s;
}

function normalizeVideoId(raw) {
  let s = String(raw || "").trim().replace(/^xf:/i, "");
  if (!s) return "";
  if (s.includes("|||")) s = s.slice(0, s.indexOf("|||")).trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = `${u.pathname}${u.search || ""}`;
    } catch (_) {
      s = s.replace(/^https?:\/\/[^/]+/i, "");
    }
  }
  if (!s.startsWith("/")) s = `/${s}`;
  return s;
}

/**
 * CF challenge 判定：只用强特征，避免把正常页面里的 Cloudflare Turnstile
 * (challenges.cloudflare.com/turnstile) 误判成 challenge。
 */
function isCfChallenge(html, statusCode) {
  const code = Number(statusCode || 0);
  if (code === 403 || code === 503 || code === 429) return true;
  return /Just a moment|_cf_chl_opt|cdn-cgi\/challenge-platform|cf-mitigated|Enable JavaScript and cookies|Checking your browser|cf_chl_(?:tk|rt_tk|f_tk)/i.test(
    String(html || "")
  );
}

/** FlareSolverr：仅在 FLARESOLVERR_URL 有值时启用，直接取 solution.response，不重试 cookie。 */
async function solveWithFlareSolverr(url) {
  const base = FLARESOLVERR_URL.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const endpoint = `${base}/v1`;
  const payload = JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 });
  try {
    const res = await OmniBox.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: payload,
      timeout: 70000,
    });
    if (!res || Number(res.statusCode) !== 200) {
      log("error", `[cf] FlareSolverr 绕过失败: HTTP ${res && res.statusCode != null ? res.statusCode : "unknown"}`);
      return "";
    }
    let data;
    try {
      data = JSON.parse(String(res.body || ""));
    } catch (_) {
      log("error", "[cf] FlareSolverr 返回非 JSON，绕过失败");
      return "";
    }
    if (!data || data.status !== "ok" || !data.solution) {
      log("error", `[cf] FlareSolverr 绕过失败: status=${data && data.status}, message=${(data && data.message) || ""}`);
      return "";
    }
    const sol = data.solution;
    const body = String(sol.response || "");
    const cookies = Array.isArray(sol.cookies) ? sol.cookies.length : 0;
    const ua = String(sol.userAgent || "");
    log("info", `[cf] FlareSolverr 返回: status=${sol.status || ""}, cookies=${cookies}, ua=${ua.slice(0, 80)}, body长度=${body.length}, message=${data.message || ""}`);
    if (!body || isCfChallenge(body, Number(sol.status) || 200)) {
      log("error", "[cf] FlareSolverr 返回的仍是 challenge 页面，绕过失败");
      return "";
    }
    return body;
  } catch (e) {
    log("error", `[cf] FlareSolverr 绕过失败: ${(e && e.message) || e}`);
    return "";
  }
}

async function fetchCfPageCached(url) {
  const key = `${CF_PAGE_PREFIX}${md5(url)}`;
  const cached = await getCachedText(key);
  if (cached) {
    log("info", `[cf] 命中页面缓存: ${url}, body长度=${cached.length}`);
    return cached;
  }
  const body = await solveWithFlareSolverr(url);
  if (!body) return "";
  log("info", `[cf] FlareSolverr 已直接返回页面内容: ${url}, body长度=${body.length}`);
  await setCachedText(key, body, CF_PAGE_TTL);
  log("info", `[cf] 已缓存页面: ${url}, TTL=${CF_PAGE_TTL}`);
  return body;
}

async function useCfFallback(url, ttl, key) {
  if (!FLARESOLVERR_URL) return "";
  try {
    const body = await fetchCfPageCached(url);
    if (body && ttl > 0) await setCachedText(key, body, Math.min(ttl, CF_PAGE_TTL));
    return body;
  } catch (e) {
    log("error", `[cf] 降级链路异常: ${(e && e.message) || e}`);
    return "";
  }
}

/** 统一 HTML 入口：短 TTL 缓存 + CF 判定 + 清晰降级日志 + 可选 FlareSolverr 页面级绕过。 */
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
  };
  if (COOKIE) headers.Cookie = COOKIE;
  if (PROXY_URL) log("info", `[http] XFREE_PROXY_URL 已配置(${PROXY_URL})，请由宿主/运行环境注入代理出口`);

  let res = null;
  let code = 0;
  let html = "";
  try {
    res = await OmniBox.request(url, { method: "GET", headers, timeout: 20000 });
    code = Number((res && res.statusCode) || 0);
    html = String((res && res.body) || "");
  } catch (e) {
    logDegrade(`请求异常(${(e && e.message) || e})`, url);
    return useCfFallback(url, ttl, key);
  }
  if (code !== 200 || isCfChallenge(html, code)) {
    logDegrade(`HTTP ${code || "unknown"}`, url);
    return useCfFallback(url, ttl, key);
  }
  if (ttl > 0 && html) await setCachedText(key, html, ttl);
  return html;
}

// ---------------------------------------------------------------------------
// 列表解析（通用 KVS / xfree 形态）
// ---------------------------------------------------------------------------

function isDetailHref(href) {
  const h = String(href || "").trim();
  if (!h || /^(#|javascript:|mailto:)/i.test(h)) return false;
  if (/\/(?:categories|tags?|search|playlist|creators|legal|contact-us|academy|partners|agencies)\//i.test(h)) return false;
  return /\/(?:video|videos?|watch|view|play|clip)\b|\/video\?|\/\d+\.html?$/i.test(h);
}

function looksLikeViews(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  return /^(?:[\d.,]+\s*[kKmMbB]?|[\d.,]+\s*(?:次|观看|views?|played)|\d{1,2}:\d{2}(?::\d{2})?)$/i.test(s);
}

function pickImage($c, $a, $img) {
  const candidates = [];
  const push = (v) => { if (v) candidates.push(String(v).trim()); };
  push($img.attr("data-src"));
  push($img.attr("data-original"));
  push($img.attr("data-lazy-src"));
  const srcset = $img.attr("srcset");
  if (srcset) push(String(srcset).split(/[,\s]+/)[0]);
  push($img.attr("src"));
  push($a.attr("data-src"));
  push($a.attr("data-original"));
  push($a.attr("data-poster"));
  for (const v of candidates) {
    if (/placeholder|blank|noneCover|loading|data:image|1x1\.gif/i.test(v)) continue;
    const abs = absoluteUrl(v);
    if (abs) return abs;
  }
  return "";
}

function pickText($c, selectors) {
  for (const sel of selectors) {
    try {
      const t = String($c.find(sel).first().text() || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 40);
    } catch (_) {}
  }
  return "";
}

function pickTitle($, $c, $a, $img, href) {
  const clean = (s) => decodeEntities(String(s || "")).replace(/\s+/g, " ").trim();
  const stripTags = (s) =>
    clean(String(s || "").replace(/#[^\s#]+/g, " "))
      .replace(/^\s*[\d.,]+\s*[kKmM]?\s+/, "")
      .replace(/[\s·|\-]+$/g, "")
      .trim();

  let t = clean($a.attr("title"));
  if (t && !looksLikeViews(t)) return t.slice(0, 160);

  t = clean($c.find('[class*="title"], h1, h2, h3, h4').first().text());
  if (t && t.length >= 4 && !looksLikeViews(t)) return stripTags(t).slice(0, 160);

  const altClean = stripTags($img.attr("alt"));
  if (altClean && altClean.length >= 8) return altClean.slice(0, 160);

  const cardText = stripTags($c.text());
  if (cardText && cardText.length >= 8) {
    const parts = cardText.split(/[·|]/).map((x) => x.trim()).filter(Boolean);
    const best = parts.sort((a, b) => b.length - a.length)[0] || cardText;
    if (!looksLikeViews(best)) return best.slice(0, 160);
  }

  try {
    const u = new URL(href, HOST);
    const p = u.searchParams.get("title") || "";
    if (p) return clean(decodeURIComponentSafe(p).replace(/[-_]+/g, " ")).slice(0, 160);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    if (seg) return clean(decodeURIComponentSafe(seg.replace(/\.html?$/i, "").replace(/[-_]+/g, " "))).slice(0, 160);
  } catch (_) {}

  const aText = clean($a.text());
  if (aText && !looksLikeViews(aText)) return aText.slice(0, 160);
  return "XFree 视频";
}

/** cheerio 不可用时的极简正则兜底（仍走安全结构，绝不崩）。 */
function parseListRegex(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"']*(?:\/video|\/watch|\/play\/)[^"']*)["'][^>]*>[\s\S]{0,900}?<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null && out.length < 60) {
    const id = normalizeVideoId(m[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const im = m[0].match(/(?:data-src|data-original|src)=["']([^"']+)["']/i);
    out.push({
      vod_id: id,
      vod_name: decodeEntities(id).slice(0, 160),
      vod_pic: im ? absoluteUrl(im[1]) : "",
      vod_remarks: "",
      vod_tag: "video",
      vod_play_from: "XFree",
    });
  }
  return out;
}

function parseListPage(html) {
  const raw = String(html || "");
  if (!raw) return { list: [], pagecount: 1 };
  if (!cheerio) return { list: parseListRegex(raw), pagecount: parsePageCount(raw, 1) };

  const list = [];
  const seen = new Set();
  try {
    const $ = cheerio.load(raw);
    const cards = new Set();
    $(
      'div.thumb, div[class*="thumb"], div.wall__item, div[class*="wall__item"], li[class*="video"], div[class*="video-item"], article'
    ).each((_, el) => cards.add(el));
    if (cards.size === 0) {
      $("a[href]").each((_, el) => {
        if (!isDetailHref($(el).attr("href"))) return;
        const box = $(el).closest("div, li, article").get(0);
        cards.add(box || el);
      });
    }

    cards.forEach((card) => {
      try {
        const $c = $(card);
        const $a = $c.find("a[href]").filter((_, el) => isDetailHref($(el).attr("href"))).first();
        if (!$a.length) return;
        const href = String($a.attr("href") || "").trim();
        const vodId = normalizeVideoId(href);
        if (!vodId || seen.has(vodId)) return;
        seen.add(vodId);

        const $img = $c.find("img").first();
        const pic = pickImage($c, $a, $img);
        const title = pickTitle($, $c, $a, $img, href);
        const duration = pickText($c, [
          '[class*="duration"]', '[class*="time"]', ".duration", ".time", "span.video-duration",
        ]);
        const views = pickText($c, ['[class*="views"]', '[class*="played"]', '[class*="view-count"]']);
        list.push({
          vod_id: vodId,
          vod_name: title,
          vod_pic: pic,
          vod_remarks: [duration, views].filter(Boolean).join(" · "),
          vod_tag: "video",
          vod_play_from: "XFree",
        });
      } catch (_) {}
    });
  } catch (_) {
    return { list: parseListRegex(raw), pagecount: parsePageCount(raw, 1) };
  }
  if (list.length === 0) return { list: parseListRegex(raw), pagecount: parsePageCount(raw, 1) };
  return { list, pagecount: parsePageCount(raw, 1) };
}

function parsePageCount(html, page) {
  let max = 0;
  const raw = String(html || "");
  const push = (n) => {
    const x = Number(n);
    if (Number.isFinite(x) && x > 0 && x <= 500 && x > max) max = x;
  };
  let m;
  const re1 = /[?&]page=(\d{1,3})/gi;
  while ((m = re1.exec(raw)) !== null) push(m[1]);
  const re2 = /\/page\/(\d{1,3})\/?/gi;
  while ((m = re2.exec(raw)) !== null) push(m[1]);
  if (cheerio && raw.length < 3000000) {
    try {
      const $ = cheerio.load(raw);
      $("a[href]").each((_, el) => {
        const h = String($(el).attr("href") || "");
        const mm = h.match(/\/(\d{1,3})\/?(?:\?|#|$)/);
        if (mm) push(mm[1]);
      });
    } catch (_) {}
  }
  return Math.max(1, max, Number(page) || 1);
}

// ---------------------------------------------------------------------------
// 分类清单
// ---------------------------------------------------------------------------

function slugToName(slug) {
  return String(slug || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseClassesHtml(html) {
  const out = [];
  const seen = new Set();
  const push = (slug, name) => {
    let s = String(slug || "").trim().replace(/^\/+|\/+$/g, "");
    if (!s || s.length > 40 || seen.has(s.toLowerCase())) return;
    if (/^(?:cs|de|es|fr|it|pt|zh|ja|ko|ru)-/i.test(s)) return;
    seen.add(s.toLowerCase());
    const n = String(name || "").replace(/\s+/g, " ").trim();
    out.push({ type_id: s, type_name: (n || slugToName(s)).slice(0, 40) });
  };

  if (cheerio) {
    try {
      const $ = cheerio.load(html);
      $("a[href]").each((_, el) => {
        const h = String($(el).attr("href") || "");
        const m = h.match(/\/(?:categories|tags?)\/([^/?#"']+)/i);
        if (m) push(decodeURIComponentSafe(m[1]), $(el).text());
      });
    } catch (_) {}
  }
  if (out.length === 0) {
    const re = /\/(?:categories|tags?)\/([^/?#"'\s]+)/gi;
    let m;
    while ((m = re.exec(String(html || ""))) !== null && out.length < 120) {
      push(decodeURIComponentSafe(m[1]), "");
    }
  }
  return out.slice(0, 120);
}

async function fetchClasses() {
  try {
    const html = await fetchHtml(`${HOST}/categories/`, CLASSES_TTL);
    const list = parseClassesHtml(html);
    if (list.length) {
      log("info", `[classes] 抓到分类=${list.length}`);
      return list;
    }
  } catch (e) {
    log("error", `[classes] 抓取失败: ${(e && e.message) || e}`);
  }
  log("info", `[classes] 使用内置兜底分类=${FALLBACK_CLASSES.length}`);
  return FALLBACK_CLASSES.slice();
}

// ---------------------------------------------------------------------------
// flashvars 多档解析 + 【最高分辨率优先】排序
// ---------------------------------------------------------------------------

function cleanMediaUrl(value) {
  let s = decodeEntities(String(value || "").trim());
  s = s
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\?/g, "?")
    .replace(/\\&/g, "&")
    .replace(/&amp;/gi, "&")
    .replace(/\\+$/, "");
  if (/%3a%2f%2f|%2f%2f/i.test(s.slice(0, 48))) {
    const decoded = decodeURIComponentSafe(s);
    if (decoded) s = decoded;
  }
  if (/^\/\//.test(s)) s = `https:${s}`;
  return s.trim();
}

function extractFlashvarsBlock(html) {
  const raw = String(html || "");
  const m = raw.match(/(?:var\s+|let\s+|const\s+)?flashvars\w*\s*=\s*\{/i);
  if (!m) return "";
  const start = raw.indexOf("{", m.index);
  if (start < 0) return "";
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  return end > start ? raw.slice(start, end + 1) : "";
}

function extractVarUrl(scope, key) {
  const raw = String(scope || "");
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']([^"']+)["']`, "i"),
    new RegExp(`${k}=([^&"'\\s<>]+)`, "i"),
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m || !m[1]) continue;
    const u = cleanMediaUrl(m[1]);
    if (/^https?:\/\//i.test(u) && !/challenges\.cloudflare\.com/i.test(u)) return u;
  }
  return "";
}

/** 从 URL 里读取真实高度（1080p / 720 / 480 ...），读不到时由 QUALITY_DEFS 兜底。 */
function heightFromUrl(url) {
  const m = String(url || "").match(/(?:^|[^0-9])(240|360|480|540|720|1080|1440|2160)[pP]?(?=[\/._?&#-]|$)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return n >= 144 && n <= 4320 ? n : 0;
}

/** 【档位排序：明确函数】按 height 数值降序（1080 > 720 > 480），同高再按 width 降序。 */
function sortVariantsByHeightDesc(variants) {
  const arr = Array.isArray(variants) ? variants.slice() : [];
  return arr.sort((a, b) => {
    const ha = Number(a && a.height) || 0;
    const hb = Number(b && b.height) || 0;
    if (hb !== ha) return hb - ha;
    return (Number(b && b.width) || 0) - (Number(a && a.width) || 0);
  });
}

/** 解析 flashvars 的 video_url / video_alt_url / video_alt_url2 多档，返回降序数组。 */
function extractVideoVariants(html) {
  const raw = String(html || "");
  const block = extractFlashvarsBlock(raw) || raw;
  const found = [];
  const seen = new Map();

  for (const def of QUALITY_DEFS) {
    const url = extractVarUrl(block, def.key);
    if (!url) continue;
    const h = heightFromUrl(url) || def.height;
    const prev = seen.get(url);
    if (prev) {
      if (h > prev.height) {
        prev.height = h;
        prev.label = `${h}P`;
        prev.key = def.key;
      }
      continue;
    }
    const v = { key: def.key, height: h, width: 0, label: `${h}P`, url };
    seen.set(url, v);
    found.push(v);
  }

  // 兜底：flashvars 缺失时从整页抓 mp4/m3u8 直链（ld+json contentUrl / <video src> / CDN 链接）
  if (found.length === 0) {
    const flat = raw.replace(/\\\//g, "/");
    const re = /https?:\/\/[^\s"'<>()]+\.(?:mp4|m3u8)(?:\?[^\s"'<>()]*)?/gi;
    const extra = new Set();
    let m;
    while ((m = re.exec(flat)) !== null && extra.size < 8) {
      const u = cleanMediaUrl(m[0]);
      if (!/^https?:\/\//i.test(u) || extra.has(u)) continue;
      extra.add(u);
      const h = heightFromUrl(u) || 480;
      const v = { key: "fallback", height: h, width: 0, label: `${h}P`, url: u };
      seen.set(u, v);
      found.push(v);
    }
  }

  return sortVariantsByHeightDesc(found);
}

function extractMeta(html, path) {
  const out = { name: "", pic: "", content: "", duration: "", poster: "" };
  const raw = String(html || "");
  if (cheerio) {
    try {
      const $ = cheerio.load(raw);
      out.name = String($("meta[property='og:title']").attr("content") || "").trim();
      out.pic = String($("meta[property='og:image']").attr("content") || "").trim();
      out.content = String(
        $("meta[property='og:description']").attr("content") ||
        $("meta[name='description']").attr("content") || ""
      ).trim();
      if (!out.name) out.name = String($("h1").first().text() || $("title").first().text() || "").trim();
      $('script[type="application/ld+json"]').each((_, el) => {
        if (out.name && out.pic && out.content) return;
        try {
          const j = JSON.parse($(el).html() || "{}");
          const items = Array.isArray(j) ? j : [j];
          for (const it of items) {
            if (!it || it["@type"] !== "VideoObject") continue;
            out.name = out.name || String(it.name || it.headline || "");
            out.content = out.content || String(it.description || "");
            const thumb = it.thumbnailUrl || it.thumbnailURL;
            const first = Array.isArray(thumb) ? thumb[0] : thumb;
            out.pic = out.pic || String(first || "");
            const cu = it.contentUrl;
            if (!out.poster && cu) out.poster = absoluteUrl(Array.isArray(cu) ? cu[0] : cu);
          }
        } catch (_) {}
      });
      const poster = $("video").first().attr("poster") || $("img[data-type='poster']").first().attr("src") || "";
      if (poster) out.poster = absoluteUrl(poster);
      out.duration = String($("meta[itemprop='duration']").attr("content") ||
        $('[class*="duration"]').first().text() || "").replace(/\s+/g, " ").trim();
    } catch (_) {}
  }
  if (!out.name) {
    const t = raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ||
      raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) out.name = decodeEntities(t[1]).trim();
  }
  if (!out.pic) {
    const p = raw.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
    if (p) out.pic = decodeEntities(p[1]).trim();
  }
  if (!out.content) {
    const d = raw.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=(?:'([^']*)'|"([^"]*)")/i);
    if (d) out.content = decodeEntities(d[1] || d[2] || "").trim();
  }
  if (!out.name) {
    try {
      const u = new URL(path, HOST);
      out.name = decodeURIComponentSafe(u.searchParams.get("title") || "").replace(/[-_]+/g, " ").trim();
    } catch (_) {}
  }
  if (!out.name) out.name = `XFree ${path}`;
  out.name = decodeEntities(out.name).slice(0, 200);
  out.content = decodeEntities(out.content).slice(0, 2000);
  out.pic = absoluteUrl(out.pic) || absoluteUrl(out.poster);
  return out;
}

function parsePlayId(raw) {
  let s = String(raw || "").trim().replace(/^xf:/i, "");
  let left = s;
  let hint = "";
  if (s.includes("|||")) {
    const i = s.indexOf("|||");
    left = s.slice(0, i).trim();
    hint = s.slice(i + 3).trim();
  }
  if (/^https?:\/\//i.test(left) && /\.(?:mp4|m3u8)(?:\?|#|$)/i.test(left)) {
    return { path: "", hint, direct: cleanMediaUrl(left) };
  }
  return { path: normalizeVideoId(left), hint, direct: "" };
}

// ---------------------------------------------------------------------------
// URL 构造 / 空结构
// ---------------------------------------------------------------------------

function buildCategoryUrl(slug, page) {
  const s = String(slug || "").trim().replace(/^\/+|\/+$/g, "");
  const p = Number(page) || 1;
  if (!s) return p > 1 ? `${HOST}/${p}/` : `${HOST}/`;
  const seg = encodeURIComponent(s);
  return p > 1 ? `${HOST}/categories/${seg}/${p}/` : `${HOST}/categories/${seg}/`;
}

function buildSearchUrl(keyword, page) {
  const seg = encodeURIComponent(String(keyword || "").trim());
  const p = Number(page) || 1;
  return p > 1 ? `${HOST}/search/${seg}/${p}/` : `${HOST}/search/${seg}/`;
}

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

// ---------------------------------------------------------------------------
// home / category / search
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    log("info", `[home] from=${(context && context.from) || "web"}, host=${HOST}`);
    const [homeRes, classRes] = await Promise.allSettled([
      fetchHtml(`${HOST}/`, HOME_TTL),
      fetchClasses(),
    ]);
    const html = homeRes.status === "fulfilled" ? homeRes.value : "";
    const classes = classRes.status === "fulfilled" && classRes.value && classRes.value.length
      ? classRes.value
      : FALLBACK_CLASSES.slice();
    const parsed = html ? parseListPage(html) : { list: [], pagecount: 1 };
    log("info", `[home] 分类=${classes.length}, 推荐=${parsed.list.length}`);
    return { class: classes, filters: {}, list: parsed.list };
  } catch (e) {
    log("error", `[home] 失败: ${(e && e.message) || e}`);
    return { class: FALLBACK_CLASSES.slice(), filters: {}, list: [] };
  }
}

async function category(params, context) {
  const page = Number(params && params.page) || 1;
  try {
    const slug = String((params && (params.categoryId || params.type_id || params.t)) || "").trim();
    const url = buildCategoryUrl(slug, page);
    log("info", `[category] slug=${slug || "(全部)"}, page=${page}, from=${(context && context.from) || "web"}`);
    log("info", `[category] 请求 URL=${url}`);
    const html = await fetchHtml(url, CATEGORY_TTL);
    if (!html) return emptyPage(page);
    const parsed = parseListPage(html);
    log("info", `[category] list=${parsed.list.length}, pagecount=${parsed.pagecount}`);
    return pageResult(parsed.list, page, Math.max(parsed.pagecount, page));
  } catch (e) {
    log("error", `[category] 失败: ${(e && e.message) || e}`);
    return emptyPage(page);
  }
}

async function search(params, context) {
  const page = Number(params && params.page) || 1;
  try {
    const keyword = String((params && (params.keyword || params.wd || params.q)) || "").trim();
    if (!keyword) {
      log("info", "[search] 关键词为空，返回空结果");
      return emptyPage(page);
    }
    const url = buildSearchUrl(keyword, page);
    log("info", `[search] keyword=${keyword}, page=${page}, from=${(context && context.from) || "web"}`);
    log("info", `[search] 请求 URL=${url}`);
    const html = await fetchHtml(url, SEARCH_TTL);
    if (!html) return emptyPage(page);
    const parsed = parseListPage(html);
    log("info", `[search] list=${parsed.list.length}, pagecount=${parsed.pagecount}`);
    return pageResult(parsed.list, page, Math.max(parsed.pagecount, page));
  } catch (e) {
    log("error", `[search] 失败: ${(e && e.message) || e}`);
    return emptyPage(page);
  }
}

// ---------------------------------------------------------------------------
// detail / play
// ---------------------------------------------------------------------------

async function detail(params, context) {
  try {
    const path = normalizeVideoId(params && (params.videoId || params.vod_id || params.id));
    if (!path || path === "/") {
      log("info", "[detail] videoId 为空，返回空结构");
      return { list: [] };
    }
    const detailUrl = `${HOST}${path}`;
    log("info", `[detail] videoId=${path}, from=${(context && context.from) || "web"}`);
    log("info", `[detail] 请求 URL=${detailUrl}`);

    const html = await fetchHtml(detailUrl, DETAIL_TTL);
    if (!html) {
      log("info", "[detail] 详情页不可用（请求失败/命中 CF），返回空结构");
      return { list: [] };
    }

    const variants = extractVideoVariants(html);
    if (variants.length === 0) {
      log("error", `[detail] 未解析到 flashvars 多档 mp4: ${detailUrl}，返回空结构`);
      return { list: [] };
    }

    const meta = extractMeta(html, path);
    // 每档一条线路；variants 已按 height 降序 => vod_play_sources[0] 恒为最高分辨率
    const sources = variants.map((v) => ({
      name: v.label,
      episodes: [{ name: v.label, playId: `xf:${path}|||${v.key}` }],
    }));
    const top = variants[0].label;
    const remarks = [top ? `${top} 最高分辨率优先` : "解析中", meta.duration].filter(Boolean).join(" · ");
    log("info", `[detail] title=${meta.name || "(无)"}, 档位=${variants.map((v) => v.label).join(">")}, 线路=${sources.length}`);

    return {
      list: [{
        vod_id: path,
        vod_name: meta.name,
        vod_pic: meta.pic,
        vod_content: meta.content,
        vod_remarks: remarks,
        vod_tag: "video",
        vod_play_from: "XFree",
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log("error", `[detail] 失败: ${(e && e.message) || e}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const flag = String((params && params.flag) || "xfree");
  const header = {
    "User-Agent": UA,
    Referer: `${HOST}/`,
    Origin: HOST,
    Accept: "*/*",
  };
  if (COOKIE) header.Cookie = COOKIE;
  try {
    const raw = String((params && (params.playId || params.play_id || params.ids)) || "").trim();
    const parsed = parsePlayId(raw);
    log("info", `[play] playId=${raw.slice(0, 200)}, hint=${parsed.hint || "(无)"}, flag=${flag}, from=${(context && context.from) || "web"}`);

    if (parsed.direct) {
      log("info", "[play] playId 为媒体直链，直接返回（单档即最高档）, parse=0");
      return { urls: [{ name: "最高档", url: parsed.direct }], flag, header, parse: 0 };
    }
    if (!parsed.path || parsed.path === "/") throw new Error("playId 无法解析出详情路径");

    // play 不做结果缓存（签名/时效），每次现取；CF 页面级缓存仍可命中
    const detailUrl = `${HOST}${parsed.path}`;
    const html = await fetchHtml(detailUrl, 0);
    if (!html) {
      log("info", "[play] 详情页不可用（请求失败/命中 CF），返回空 urls");
      return { urls: [], flag, header, parse: 0 };
    }

    const variants = sortVariantsByHeightDesc(extractVideoVariants(html));
    if (variants.length === 0) {
      log("error", `[play] 详情页未解析到 flashvars 多档: ${detailUrl}`);
      return { urls: [], flag, header, parse: 0 };
    }
    // 【最高分辨率优先】urls 恒按 height 降序，urls[0] 恒为最高档（1080P）；
    // hint 只用于日志/宿主选档提示，不改变降序，保证 play() 优先返回最高档。
    const urls = variants.map((v) => ({ name: v.label, url: v.url }));
    log("info", `[play] 档位顺序=${urls.map((u) => u.name).join(" > ")}, urls[0]=${urls[0].name}（最高分辨率优先）, hint=${parsed.hint || "(无)"}, parse=0`);
    return { urls, flag, header, parse: 0 };
  } catch (e) {
    log("error", `[play] 失败: ${(e && e.message) || e}`);
    return { urls: [], flag, header, parse: 0 };
  }
}
