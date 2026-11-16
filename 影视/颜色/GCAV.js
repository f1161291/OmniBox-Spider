// @name GCAV
// @version 1.2.1
// @author omnibox-spider
// @description gcav.me 采集源：修复主域名不可达时请求挂死（加硬超时 + 失败日志不再静默 + 探测超时 6s）；新增地址发布页 itaolu.com 被动拉取备用域名（全部域名失败才拉，分批 10 个探测，13 个 gcav 备用域）；修复宿主缺 cheerio 时列表返回 0 条导致封面全空（新增正则兜底解析 + Node 直连兜底）；六大频道 + 排序筛选 + 搜索分页；列表 a.cover-group 取标题/封面/时长/热度；详情页 const source 解析 cloudfront / bunny 双线路预览直链，免费或带登录态时补 /v/{id}/manifest 完整 m3u8；播放直链→sniff→parse=1 三段式兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/GCAV.js
// @dependencies cheerio

/**
 * 实站事实（2026-11-14 实测，改代码前先读这段）
 * 1) 主域 https://gcav.me（BunnyCDN，无 CF 盾、无 JS cookie 挑战），需要常规 UA + Referer。
 * 2) 频道路由：/video 最新、/amateur 国产自拍、/model-live 主播实录、/free 免费试看、
 *    /japanese-uncensored 日本无码、/western 欧美。排序 ?sort=new|hot|favorites，分页 ?page=N。
 *    搜索 /search?q=<关键词>&page=N&sort=...，关键词必须 encodeURIComponent。
 * 3) 列表卡片 <a class="...cover-group" href="https://gcav.me/v/{id}" title="..." data-id="{id}">：
 *    真实封面在 img[data-src]（img[src] 是 1x1 base64 占位图，必须跳过）；
 *    右下角 div 是时长，左下角 span 是观看数；详情页另有同结构的相关推荐区。
 * 4) 分页总数在 <form class="query-form"><input name="page"> ... <span id="price-currency"> / 1466 </span>；
 *    末页/搜索无结果时没有这个 form，兜底取所有 [?&]page=N 链接的最大值。
 * 5) 详情页：<meta property="og:title">（尾部带 " | 国产原创AV"）、og:image、h1 标题、h2 简介；
 *    播放地址在行内脚本 const source = "https:\/\/...\/preview_mp4\/{id}.mp4"（JS 字符串转义需还原）；
 *    const has_access = true|false 决定是否免费。
 * 6) 播放线路按钮 <button data-cdn="cloudfront|bunny">线路1|线路2</button>：
 *    点击写 cookie video_cdn_preference=<cdn> 后 reload。
 *      cloudfront -> https://gc.skylines.pro/preview_mp4/{id}.mp4（无签名）
 *      bunny      -> https://gc-b.skylines.pro/preview_mp4/{id}.mp4?token=...&expires=...（带签名，仍按直链处理）
 *    带 query 的 mp4/m3u8 一律 parse=0，不要因为 ?token= 误判成网页。
 * 7) 免费视频（has_access=true）或带登录 Cookie 时，GET /v/{id}/manifest 返回完整 m3u8 纯文本；
 *    VIP 受限视频返回 200 + content-length: 0（空 body）。无权限时只能拿到 preview_mp4 预览片。
 * 8) 【1.1.0 实测的关键事实】预览片不是前端截断，而是服务端只生成了 60 秒文件：
 *      预览 https://gc.skylines.pro/preview_mp4/{id}.mp4
 *        content-range: bytes 0-0/11567498  → 文件总长 11.5 MB
 *        ffprobe duration = 60.000544 秒（60552/60551/59843 三个 id 全是 60.000544s）
 *      完整 https://gc.skylines.pro/videos/{id}/{uuid}/manifest.m3u8（免费片 580 → 39 分钟）
 *    那个 {uuid} 由服务端按会话权限动态签发，VIP 片详情页（117 KB）里 grep 不到任何 UUID；
 *    伪造 cookie（vip=1/subscribed=1/has_access=1/premium=true）与 POST/XHR/Range 变体
 *    实测全部返回空 body。也就是说：**这是授权问题，不是混淆问题**，
 *    与 91Porn 那种「真源藏在页面里、解码即可」的情况本质不同，无法靠解码解决。
 *    本源的做法：免费片给完整 m3u8，VIP 片明确标注「预览·60秒」并优先把免费片排前面，
 *    配置 SITE_COOKIE（会员登录态）后 manifest 通过即自动切完整版。
 * 9) 【1.1.0 实测的分布】首页 37 个卡片里只有 5 个免费（580/930/1652/21154/41964，
 *    正好是 /free 频道那 5 个），其余 32 个全是 VIP 预览片；/free 频道本身 5/5 全免费。
 *    也就是说免费片占比约 13%，且会重复出现在首页。据此：
 *      - home 并行抓「首页 + /free」，把 /free 全部记为免费并置顶，零额外探测成本；
 *      - 首页其余条目只做有限探测（GCAV_PROBE_LIMIT，默认 10），够把混在里面的免费片捞出来；
 *      - 列表项的 vod_tag / vod_remarks 直接标「免费完整」或「预览60s」。
 * 10) 播放页缓存保守：home/category/search/detail 走短 TTL 缓存，play 不缓存（签名链接随时可能换）。
 *
 * 【环境变量】（优先复用仓库既有命名）
 *  SITE_HOST        站点基址，默认 https://gcav.me；主域轮换时改这里即可
 *  SITE_COOKIE      可选，站点登录态 Cookie（含 gcav_session）；带上后 /v/{id}/manifest
 *                   对 VIP 片有机会返回完整正片 —— 这是拿到完整片的唯一途径
 *  GCAV_FREE_FIRST  是否把免费片排在前面，默认 1（开启）；设 0 关闭
 *  GCAV_CACHE_TTL   页面缓存秒数，默认 600；新增变量，因为本源按页面类型再乘系数，
 *                   与仓库里其它站点专属 TTL（PORNY_CACHE_TTL 等）语义不同，避免串用别人的配置
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.catch 兜住。
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const zlib = require("zlib");

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
  OmniBox = {
    log() { /* 本地调试：日志不写 stdout */ },
  };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

function normalizeHost(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://gcav.me";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "https://gcav.me";
  }
}

/* ---------------- 域名池与发布页发现（被动触发） ----------------
 * 发布页 https://itaolu.com/ 的「国产AV视频」区块列出了全部备用域名
 * （gcav.me / gcav.sale / gcav.app / gcav.shop / gcav.red / cnav.live /
 *   gcav.live / gcav.run / gcav.club / gcav.pro / gcav.bio / gavs.lol / gcav.lol）。
 * 策略与海角社区一致：不做定时刷新；只有所有已知域名都访问失败时，
 * 才去发布页拉新域名，候选域名分批探测（每批 10 个，批间 200ms）。
 * =============================================================== */
const PUBLISH_PAGE = String(process.env.GCAV_PUBLISH_PAGE || "https://itaolu.com/").trim();
const PUBLISH_SECTION = "国产AV视频";
const HOSTS_CACHE_KEY = "gcav:hosts:v1";
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
const PROBE_BATCH_SIZE = (() => {
  const n = Number(String(process.env.GCAV_PROBE_BATCH || "").trim() || 10);
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 10;
})();
const PROBE_BATCH_DELAY = 200;
const PROBE_TIMEOUT = Math.max(3000, Number(process.env.GCAV_PROBE_TIMEOUT || 6000) || 6000);

/** 域名池：第一个是当前 HOST，其余为备用 */
const HOST_POOL = (() => {
  const primary = normalizeHost(process.env.SITE_HOST || "https://gcav.me");
  const extra = String(process.env.SITE_HOSTS || "")
    .split(",").map((x) => x.trim()).filter(Boolean).map(normalizeHost);
  return Array.from(new Set([primary, ...extra]));
})();
let HOST = HOST_POOL[0];           // 当前生效域名（12 处引用都用它）
let HOST_POOL_READY = false;       // 是否已尝试从缓存恢复过
let hostsRefreshInFlight = null;
const hostHealth = Object.create(null);

const SITE_COOKIE = String(process.env.SITE_COOKIE || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE_TTL = Math.max(0, Number(process.env.GCAV_CACHE_TTL || 600) || 600);
const HOME_TTL = BASE_TTL;
const CATEGORY_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const SEARCH_TTL = Math.max(0, Math.round(BASE_TTL * 0.8));
const DETAIL_TTL = Math.max(0, Math.min(120, Math.round(BASE_TTL * 0.2)));
const CACHE_PREFIX = "gcav:page:";
// 免费片是否排前面（1=开，默认；实测 /free 频道 5/5 均 has_access=true，可放心前置）
const FREE_FIRST = String(process.env.GCAV_FREE_FIRST || "1").trim() !== "0";
// 列表阶段批量探测 access 的上限，避免首页被 N 个详情请求拖慢
const ACCESS_PROBE_LIMIT = Math.max(0, Number(process.env.GCAV_PROBE_LIMIT || 10) || 10);
const ACCESS_PROBE_CONCURRENCY = 4;
const PREVIEW_SECONDS = 60;

const CLASS_LIST = [
  // 免费试看置顶：该频道实测 has_access 全为 true，manifest 直接给完整 m3u8
  { type_id: "free", type_name: "免费完整❤️" },
  { type_id: "video", type_name: "最新视频（含VIP预览）" },
  { type_id: "model-live", type_name: "主播实录" },
  { type_id: "amateur", type_name: "国产自拍" },
  { type_id: "japanese-uncensored", type_name: "日本无码" },
  { type_id: "western", type_name: "欧美" },
];

const SORT_OPTIONS = [
  { name: "默认", value: "" },
  { name: "最新上架", value: "new" },
  { name: "最多观看", value: "hot" },
  { name: "最多收藏", value: "favorites" },
];
const SORT_WHITELIST = new Set(SORT_OPTIONS.map((o) => o.value).filter(Boolean));

const DEFAULT_CDN_LINES = [
  { code: "cloudfront", name: "线路1" },
  { code: "bunny", name: "线路2" },
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// ---------------------------------------------------------------------------
// 日志 / 缓存 / 请求
// ---------------------------------------------------------------------------

function log(level, message) {
  const line = `[gcav][${level}] ${message}`;
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
    return crypto.createHash("md5").update(String(text)).digest("hex");
  } catch (_) {
    return String(text).replace(/[^a-zA-Z0-9]/g, "").slice(-32);
  }
}

// 缓存 key 统一走「可读前缀 + 短哈希」，避免长 URL / cookie 触发宿主 key 长度上限
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

function decompressText(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch (_) {}
  return buf;
}
/** Node 直连（http/https），带重定向跟随与解压 */
function nodeRequest(urlStr, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error("重定向过多"));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const client = isHttps ? https : http;
    const headers = Object.assign({}, options.headers || {}, {
      "Accept-Encoding": "gzip, deflate, br",
    });
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers,
      timeout: options.timeout || 20000,
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return nodeRequest(new URL(res.headers.location, u.href).href, options, redirects + 1)
          .then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: decompressText(Buffer.concat(chunks), res.headers["content-encoding"]).toString("utf-8"),
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.end();
  });
}

/* ---------------- 发布页域名发现（被动触发） ---------------- */

/**
 * 从发布页 HTML 里抽出「国产AV视频」区块的域名列表。
 * 结构：<h1>国产AV视频</h1> ... <span class="text-primary">gcav.sale </span>
 * 到下一个 <h1> 之前都属于该区块。
 */
function extractSectionHosts(html, sectionName) {
  const text = String(html || "");
  const key = String(sectionName || "").trim();
  if (!text || !key) return [];

  // 只在 <h1>...</h1> 里找区块标题，避免命中 <title> 里的同名文字
  const h1Re = /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/gi;
  let headStart = -1;
  let bodyStart = -1;
  const heads = [];
  let m;
  while ((m = h1Re.exec(text)) !== null) {
    heads.push({ start: m.index, end: m.index + m[0].length });
    if (headStart < 0 && String(m[1]).includes(key)) {
      headStart = m.index;
      bodyStart = m.index + m[0].length;
    }
  }
  if (headStart < 0) return [];

  const next = heads.find((h) => h.start > headStart);
  const block = text.slice(bodyStart, next ? next.start : undefined);

  const out = [];
  const seen = new Set();
  const re = /<span[^>]*class="[^"]*text-primary[^"]*"[^>]*>([\s\S]{0,80}?)<\/span>/gi;
  while ((m = re.exec(block)) !== null) {
    const raw = String(m[1] || "").replace(/<[^>]+>/g, "").trim();
    if (!/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(raw)) continue;
    const host = normalizeHost(raw);
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** 同构校验：首页能抓到 /v/{id} 才算真站 */
async function probeGcavHost(host) {
  try {
    const r = await withHardTimeout(
      nodeRequest(`${host}/`, {
        timeout: PROBE_TIMEOUT,
        headers: { "User-Agent": UA, Referer: `${host}/` },
      }),
      PROBE_TIMEOUT,
      `probe ${host}`
    );
    const body = String(r.body || "");
    return r.statusCode >= 200 && r.statusCode < 400
      && body.length > 3000
      && /\/v\/\d+/.test(body);
  } catch (_) { return false; }
}

async function restoreHostCache() {
  if (HOST_POOL_READY) return;
  HOST_POOL_READY = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === "string") { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (obj && Array.isArray(obj.hosts)) {
      for (const h of obj.hosts) {
        if (typeof h !== "string" || !/^https?:\/\//i.test(h)) continue;
        const host = normalizeHost(h);
        if (!HOST_POOL.includes(host)) HOST_POOL.push(host);
      }
    }
  } catch (_) {}
}

/** 分批探测候选域名：每批 PROBE_BATCH_SIZE 个，批间 sleep */
async function discoverGcavHosts() {
  const candidates = new Set();
  try {
    log("info", `[hosts] 拉取发布页 ${PUBLISH_PAGE}`);
    const r = await nodeRequest(PUBLISH_PAGE, {
      timeout: 15000,
      headers: { "User-Agent": UA, Referer: `${PUBLISH_PAGE.replace(/\/+$/, "")}/` },
    });
    const body = String(r.body || "");
    const found = extractSectionHosts(body, PUBLISH_SECTION);
    found.forEach((h) => candidates.add(h));
    log("info", `[hosts] 发布页「${PUBLISH_SECTION}」解析到 ${found.length} 个域名`);
  } catch (e) {
    log("info", `[hosts] 发布页拉取失败: ${e?.message || e}`);
  }

  const newOnes = Array.from(candidates).filter((h) => !HOST_POOL.includes(h));
  if (!newOnes.length) {
    log("info", "[hosts] 发布页无新域名，无需探测");
    return 0;
  }
  log("info", `[hosts] 待探测 ${newOnes.length} 个新域名，每批 ${PROBE_BATCH_SIZE} 个`);

  let added = 0;
  for (let i = 0; i < newOnes.length; i += PROBE_BATCH_SIZE) {
    const batch = newOnes.slice(i, i + PROBE_BATCH_SIZE);
    const batchNo = Math.floor(i / PROBE_BATCH_SIZE) + 1;
    log("info", `[hosts] 探测批次 ${batchNo}: ${batch.length} 个`);
    const results = await Promise.allSettled(batch.map((h) => probeGcavHost(h)));
    for (let k = 0; k < batch.length; k++) {
      if (results[k].status !== "fulfilled" || !results[k].value) continue;
      const host = batch[k];
      HOST_POOL.push(host);
      hostHealth[host] = { fail: 0, okAt: Date.now() };
      added++;
      log("info", `[hosts] 发现可用站点 -> ${host}`);
    }
    if (i + PROBE_BATCH_SIZE < newOnes.length) {
      await new Promise((r) => setTimeout(r, PROBE_BATCH_DELAY));
    }
  }
  if (added) log("info", `[hosts] 本次新增 ${added} 个，池共 ${HOST_POOL.length} 个`);
  try {
    await OmniBox.setCache(
      HOSTS_CACHE_KEY,
      { at: Date.now(), hosts: HOST_POOL.slice() },
      HOSTS_CACHE_TTL
    );
  } catch (_) {}
  return added;
}

/** 仅在 force=true 时拉发布页；并发去重 */
async function ensureHostsFresh(force) {
  await restoreHostCache();
  if (!force) return 0;
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  hostsRefreshInFlight = (async () => {
    try {
      log("info", "[hosts] 全部域名不可达，从发布页拉取新域名");
      return await discoverGcavHosts();
    } catch (e) {
      log("info", `[hosts] 拉取新域名异常: ${e?.message || e}`);
      return 0;
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

/** 切换到池中下一个域名 */
function rotateHost() {
  if (HOST_POOL.length <= 1) return false;
  const idx = HOST_POOL.indexOf(HOST);
  HOST = HOST_POOL[(idx + 1) % HOST_POOL.length];
  log("info", `[hosts] 切换域名 -> ${HOST}`);
  return true;
}

/** 硬超时包装：宿主 OmniBox.request 不受 timeout 参数约束时会一直挂住，必须自己 race */
const REQUEST_HARD_TIMEOUT = Math.max(3000, Number(process.env.GCAV_REQUEST_TIMEOUT || 12000) || 12000);
function withHardTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`请求超时(${ms}ms) ${label || ""}`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 单次尝试（不轮换），供 requestText 复用 */
async function requestOnce(url, options, host) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    Referer: `${host}/`,
    ...(options.headers || {}),
  };
  const cookie = buildCookie(options.cookie);
  if (cookie) headers.Cookie = cookie;

  const timeout = Math.max(3000, Number(options.timeout) || REQUEST_HARD_TIMEOUT);
  let res = null;

  // 优先宿主 SDK（能继承宿主 cookie/代理），但必须加硬超时：
  // 实测宿主 request 会在网络卡住时挂 100s+ 且无视 timeout 参数，
  // 导致 home 直接被宿主判超时，也轮不到域名切换。
  if (OmniBox && typeof OmniBox.request === "function") {
    try {
      res = await withHardTimeout(
        Promise.resolve(OmniBox.request(url, {
          method: options.method || "GET",
          headers,
          timeout,
        })),
        timeout,
        `sdk ${url}`
      );
    } catch (e) {
      log("info", `[request] SDK 失败(${host}): ${e?.message || e}`);
      res = null;
    }
  }

  // SDK 不可用/失败/超时 → Node 直连（同样硬超时）
  if (!res) {
    res = await withHardTimeout(
      nodeRequest(url, { method: options.method || "GET", headers, timeout }),
      timeout,
      `node ${url}`
    );
  }
  if (!res || Number(res.statusCode) !== 200) {
    throw new Error(`HTTP ${res?.statusCode ?? "unknown"} @ ${url}`);
  }
  return String(res.body || "");
}

/** 把某个 host 形式的 URL 换成另一个 host */
function swapHost(url, from, to) {
  if (!from || !to || from === to) return url;
  if (url === from || url.startsWith(from + "/")) return to + url.slice(from.length);
  return url;
}

/**
 * 请求：先用当前 HOST；失败则依次轮换池内其它域名；
 * 全部失败才去发布页拉新域名（被动触发），再重试一轮。
 */
async function requestText(url, options = {}) {
  // 首次调用时恢复缓存域名池
  await restoreHostCache();

  const tryHosts = async (hosts) => {
    let lastErr = null;
    for (const host of hosts) {
      const target = swapHost(url, HOST, host);
      try {
        const body = await requestOnce(target, options, host);
        if (host !== HOST) {
          log("info", `[hosts] 切换到可用域名 ${host}`);
          HOST = host;
        }
        hostHealth[host] = { fail: 0, okAt: Date.now() };
        return body;
      } catch (e) {
        lastErr = e;
        hostHealth[host] = hostHealth[host] || { fail: 0 };
        hostHealth[host].fail += 1;
        log("info", `[hosts] ${host} 失败: ${e?.message || e}`);
      }
    }
    throw lastErr || new Error("请求失败");
  };

  const ordered = [HOST, ...HOST_POOL.filter((h) => h !== HOST)];
  try {
    return await tryHosts(ordered);
  } catch (firstErr) {
    // 全部已知域名失败 → 发布页拉新域名后重试
    await ensureHostsFresh(true);
    const more = [HOST, ...HOST_POOL.filter((h) => h !== HOST)];
    try {
      return await tryHosts(more);
    } catch (_) {
      throw firstErr;
    }
  }
}

async function fetchHtml(url, ttl, options = {}) {
  const key = buildCacheKey(url, buildCookie(options.cookie));
  if (ttl > 0) {
    const cached = await getCachedText(key);
    if (cached) {
      log("info", `[cache] 命中页面缓存: ${url}, len=${cached.length}`);
      return cached;
    }
  }
  const body = await requestText(url, options);
  await setCachedText(key, body, ttl);
  return body;
}

// 限并发：detail 里线路 + manifest 的请求不把并发打满
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (e) {
        results[index] = { error: e };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// 通用解析
// ---------------------------------------------------------------------------

function clean(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function pickImage($, node) {
  const el = $(node);
  const candidates = [
    el.find("img").first().attr("data-src"),
    el.find("img").first().attr("data-original"),
    el.attr("data-original"),
    el.attr("data-src"),
    el.find("img").first().attr("src"),
  ];
  for (const item of candidates) {
    const value = decodeEntities(item);
    if (value && !/^data:|placeholder/i.test(value)) return value;
  }
  return "";
}

/**
 * 正则兜底解析：宿主未安装 cheerio 时使用。
 * 站点卡片形态稳定：
 *   <a class="... cover-group" href="https://gcav.me/v/{id}" title="标题" data-id="{id}">
 *     <img data-src="https://gc.skylines.pro/thumbnails/{id}.jpg" src="data:image/png;base64,..." alt="标题">
 * 注意 img[src] 是 1x1 base64 占位图，必须跳过，只认 data-src / data-original。
 */
function parseListByRegex(html, categoryId) {
  const text = String(html || "");
  const list = [];
  const seen = new Set();
  // 注意：真实标签跨多行且 class 以空格开头（如 class=" flex gap-2 ... cover-group"），
  // 不能给 class 值内部加 \b 边界，否则匹配不到。
  const re = /<a\b[^>]*class="[^"]*cover-group[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const inner = m[1];
    const hrefM = /\bhref="([^"]+)"/i.exec(openTag);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    const idM = href.match(/\/v\/(\d+)/);
    if (!idM) continue;
    const dataIdM = /\bdata-id="([^"]*)"/i.exec(openTag);
    const id = String((dataIdM && dataIdM[1]) || idM[1]).trim();
    if (!id || seen.has(id)) continue;

    const titleM = /\btitle="([^"]*)"/i.exec(openTag);
    const altM = /<img\b[^>]*\balt="([^"]*)"/i.exec(inner);
    const name = clean(decodeEntities((titleM && titleM[1]) || "") || (altM && altM[1]) || "");
    if (!name) continue;

    // 封面：只认 data-src / data-original，跳过 base64 占位
    let pic = "";
    const dsM = /<img\b[^>]*\bdata-src="([^"]+)"/i.exec(inner);
    const doM = /<img\b[^>]*\bdata-original="([^"]+)"/i.exec(inner);
    const aDoM = /\bdata-original="([^"]+)"/i.exec(openTag);
    const aDsM = /\bdata-src="([^"]+)"/i.exec(openTag);
    for (const cand of [dsM && dsM[1], doM && doM[1], aDoM && aDoM[1], aDsM && aDsM[1]]) {
      const v = decodeEntities(cand || "");
      if (v && !/^data:|placeholder/i.test(v)) { pic = v; break; }
    }

    const durM = /<span[^>]*class="[^"]*bottom-1[^"]*right-1[^"]*"[^>]*>([^<]*)</i.exec(inner);
    const viewsM = /<span[^>]*class="[^"]*bottom-1[^"]*left-1[^"]*"[^>]*>[\s\S]{0,120}?<span[^>]*>([^<]*)</i.exec(inner);
    const duration = clean(durM ? durM[1] : "");
    const views = clean(viewsM ? viewsM[1] : "");

    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: name,
      vod_pic: pic,
      type_id: String(categoryId || "video"),
      type_name: (CLASS_LIST.find((c) => c.type_id === categoryId) || CLASS_LIST[0]).type_name,
      vod_remarks: duration || "",
      vod_subtitle: [views, duration].filter(Boolean).join(" / "),
    });
  }
  return list;
}

function parseList(html, categoryId) {
  // 宿主未内置 cheerio 时走正则兜底，避免整页返回 0 条（表现为「封面全空」）
  if (!cheerio) {
    const fallback = parseListByRegex(html, categoryId);
    if (fallback.length) {
      log("info", `[parseList] cheerio 不可用，正则兜底解析 ${fallback.length} 条`);
    }
    return fallback;
  }
  const $ = cheerio.load(html);
  const list = [];
  const seen = new Set();

  $("a.cover-group").each((_, node) => {
    const a = $(node);
    const href = decodeEntities(a.attr("href") || "");
    const matched = href.match(/\/v\/(\d+)/);
    if (!matched) return;
    const id = String(a.attr("data-id") || matched[1]).trim();
    if (!id || seen.has(id)) return;
    seen.add(id);

    const name = clean(
      decodeEntities(a.attr("title") || "") ||
      clean(a.find("img").first().attr("alt") || "") ||
      clean(a.find(".line-clamp-2").first().text() || "")
    );
    if (!name) return;

    const duration = clean(a.find('[class*="bottom-1"][class*="right-1"]').first().text() || "");
    const views = clean(a.find('[class*="bottom-1"][class*="left-1"] span').first().text() || "");
    const pic = pickImage($, node);

    list.push({
      vod_id: id,
      vod_name: name,
      vod_pic: pic,
      type_id: String(categoryId || "video"),
      type_name: (CLASS_LIST.find((c) => c.type_id === categoryId) || CLASS_LIST[0]).type_name,
      vod_remarks: duration || "",
      vod_subtitle: [views, duration].filter(Boolean).join(" / "),
    });
  });

  return list;
}

function parsePageCount(html, fallback = 1) {
  let count = 0;
  const direct = String(html || "").match(/id="price-currency"[^>]*>\s*\/\s*(\d{1,6})/);
  if (direct) count = Number(direct[1]) || 0;
  if (!count) {
    const numbers = [...String(html || "").matchAll(/[?&](?:amp;)?page=(\d{1,6})/g)]
      .map((m) => Number(m[1]) || 0)
      .filter(Boolean);
    if (numbers.length) count = Math.max(...numbers);
  }
  return count || Number(fallback) || 1;
}

function parseSource(html) {
  const matched = String(html || "").match(/const\s+source\s*=\s*"((?:[^"\\]|\\.)*)"/);
  if (!matched) return "";
  let raw = matched[1];
  try {
    raw = JSON.parse(`"${raw}"`);
  } catch (_) {
    raw = raw.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
  }
  return decodeEntities(raw).trim();
}

function parseHasAccess(html) {
  return /const\s+has_access\s*=\s*true\b/.test(String(html || ""));
}

function parseCdnLines(html) {
  const lines = [];
  if (cheerio) {
    const $ = cheerio.load(html);
    $("[data-cdn]").each((_, node) => {
      const code = clean($(node).attr("data-cdn") || "").toLowerCase();
      const name = clean($(node).text() || "");
      if (code && !lines.some((l) => l.code === code)) {
        lines.push({ code, name: name || `线路${lines.length + 1}` });
      }
    });
  }
  return lines.length ? lines : DEFAULT_CDN_LINES.slice();
}

function parseDetail(html, videoId) {
  const empty = {
    vod_id: videoId,
    vod_name: `GCAV ${videoId}`,
    vod_pic: "",
    vod_content: "",
    vod_remarks: "",
    source: "",
    hasAccess: false,
    lines: DEFAULT_CDN_LINES.slice(),
  };
  if (!cheerio) {
    const og = String(html || "").match(/og:title"\s+content="([^"]*)"/);
    return {
      ...empty,
      vod_name: clean(decodeEntities(og?.[1] || "").replace(/\s*\|\s*国产原创AV\s*$/, "")) || empty.vod_name,
      source: parseSource(html),
      hasAccess: parseHasAccess(html),
    };
  }

  const $ = cheerio.load(html);
  const ogTitle = clean(decodeEntities($('meta[property="og:title"]').attr("content") || ""));
  const h1 = clean($("h1").first().text() || "");
  const name = ogTitle.replace(/\s*\|\s*国产原创AV\s*$/, "").trim() || h1 || empty.vod_name;
  const pic = decodeEntities(
    $('meta[property="og:image"]').attr("content") ||
    $("video#player").attr("data-poster") ||
    ""
  );
  const content = clean($("h2").first().text() || "");
  const statTexts = $("div.flex.flex-wrap.gap-4 span")
    .map((_, node) => clean($(node).text() || ""))
    .get()
    .filter(Boolean);
  const duration = statTexts.find((t) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) || "";

  return {
    vod_id: videoId,
    vod_name: name,
    vod_pic: pic,
    vod_content: content,
    vod_remarks: duration,
    source: parseSource(html),
    hasAccess: parseHasAccess(html),
    lines: parseCdnLines(html),
  };
}

function normalizeSort(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return SORT_WHITELIST.has(value) ? value : "";
}

function readFilters(params) {
  const raw = params?.filters || params?.extend || params?.ext || params?.filter || {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function buildCategoryUrl(categoryId, page, sort) {
  const path = CLASS_LIST.some((c) => c.type_id === categoryId) ? categoryId : "video";
  const url = new URL(`${HOST}/${path}`);
  if (sort) url.searchParams.set("sort", sort);
  if (Number(page) > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

function normalizeVideoId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^\d+$/.test(value)) return value;
  const matched = value.match(/\/v\/(\d+)/) || value.match(/^gcav:(\d+)$/i);
  return matched ? matched[1] : value;
}

function encodePlayId(url, meta) {
  const payload = Buffer.from(JSON.stringify(meta || {}), "utf8").toString("base64");
  return `${url}|||${payload}`;
}

function decodePlayId(playId) {
  const raw = String(playId || "");
  const parts = raw.split("|||");
  let meta = {};
  if (parts[1]) {
    try {
      meta = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) || {};
    } catch (_) {}
  }
  return { url: decodeEntities(parts[0]), meta };
}

function isMediaUrl(url) {
  const value = String(url || "").trim();
  if (!value) return false;
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch (_) {
    pathname = value.split(/[?#]/)[0];
  }
  return /\.(m3u8|mp4|mpd|m4v|webm|ts|mov|mkv)$/i.test(pathname);
}

function buildPlayHeaders() {
  const headers = {
    "User-Agent": UA,
    Referer: `${HOST}/`,
    Origin: HOST,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  if (SITE_COOKIE) headers.Cookie = SITE_COOKIE;
  return headers;
}

function buildLegacyFields(sources) {
  return {
    vod_play_from: sources.map((s) => s.name).join("$$$"),
    vod_play_url: sources
      .map((s) => (s.episodes || []).map((e) => `${e.name}$${e.playId}`).join("#"))
      .join("$$$"),
  };
}

// ---------------------------------------------------------------------------
// access 探测与免费优先排序
// ---------------------------------------------------------------------------

/**
 * 探测单个视频是否有完整片权限（同时拿 manifest，避免二次请求）。
 * @returns {Promise<{hasAccess:boolean, manifest:string}>}
 */
async function probeAccess(videoId) {
  const id = normalizeVideoId(videoId);
  if (!id) return { hasAccess: false, manifest: "" };
  const key = `gcav:access:${id}:${SITE_COOKIE ? "auth" : "anon"}`;
  const cached = await getCachedText(key);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (obj && typeof obj.hasAccess === "boolean") return obj;
    } catch (_) {}
  }
  let hasAccess = false;
  let manifest = "";
  try {
    const body = (await requestText(`${HOST}/v/${id}/manifest`)).trim();
    if (/^https?:\/\//i.test(body) || /\.m3u8/i.test(body)) {
      manifest = body.split(/\s+/)[0].trim();
      hasAccess = true;
    }
  } catch (e) {
    log("info", `[probe] ${id} manifest 不可用: ${e?.message || e}`);
  }
  const result = { hasAccess, manifest };
  await setCachedText(key, JSON.stringify(result), DETAIL_TTL);
  return result;
}

/** 给列表项打 access 标记：只探前 N 个，失败的按预览处理，绝不阻断列表 */
async function markAccess(list, tag) {
  if (!Array.isArray(list) || !list.length) return list;
  const limit = Math.min(ACCESS_PROBE_LIMIT, list.length);
  if (limit <= 0) return list;
  let ok = 0;
  const targets = list.slice(0, limit);
  const results = await mapLimit(targets, ACCESS_PROBE_CONCURRENCY, async (item) => {
    const r = await probeAccess(item.vod_id);
    if (r.hasAccess) ok += 1;
    return r;
  });
  targets.forEach((item, i) => {
    const r = results[i] || { hasAccess: false };
    item._hasAccess = !!r.hasAccess;
  });
  log("info", `[${tag}] access 探测完成: 探测=${limit}/${list.length}, 免费=${ok}`);
  return list;
}

/** 免费片排前；同组内保持站点原顺序（稳定排序） */
function sortFreeFirst(list, tag) {
  if (!FREE_FIRST || !Array.isArray(list) || list.length <= 1) return list;
  const free = list.filter((x) => x._hasAccess === true);
  const rest = list.filter((x) => x._hasAccess !== true);
  if (!free.length) return list;
  log("info", `[${tag}] 免费优先排序: 免费=${free.length}, 其余=${rest.length}`);
  return free.concat(rest);
}

/** 列表项补充可见标记（vod_remarks 展示给用户） */
function decorateListRemarks(item) {
  if (!item) return item;
  const base = String(item.vod_remarks || "").replace(/\s*·?\s*(完整|预览.*)$/, "").trim();
  const mark = item._hasAccess === true ? "完整" : `预览${PREVIEW_SECONDS}s`;
  item.vod_remarks = [base, mark].filter(Boolean).join(" · ");
  item.vod_tag = item._hasAccess === true ? "免费完整" : "VIP预览";
  return item;
}

function emptyPage(page = 1) {
  return { page: Number(page) || 1, pagecount: 0, total: 0, list: [] };
}

function pageResult(list, page, pagecount) {
  const size = list.length || 30;
  return {
    page: Number(page) || 1,
    pagecount: Number(pagecount) || 1,
    total: (Number(pagecount) || 1) * size,
    list,
  };
}

// ---------------------------------------------------------------------------
// 五个 handler
// ---------------------------------------------------------------------------

async function home(params, context) {
  try {
    const from = context?.from || "web";
    log("info", `[home] from=${from}, host=${HOST}, freeFirst=${FREE_FIRST}`);
    const homeUrl = `${HOST}/`;
    const freeUrl = `${HOST}/free`;
    log("info", `[home] 请求 URL=${homeUrl} + ${freeUrl}`);

    // 首页 + /free 并行抓：/free 整页都是免费完整片，是免费内容最可靠的来源
    const [homeHtml, freeHtml] = await Promise.all([
      fetchHtml(homeUrl, HOME_TTL),
      fetchHtml(freeUrl, HOME_TTL).catch((e) => {
        log("info", `[home] /free 抓取失败，仅用首页: ${e?.message || e}`);
        return "";
      }),
    ]);

    const freeList = freeHtml ? parseList(freeHtml, "free") : [];
    const freeIds = new Set(freeList.map((v) => v.vod_id));
    let list = parseList(homeHtml, "video");

    // 首页里落在 /free 名单上的，直接认定免费，不再探测
    list.forEach((item) => {
      if (freeIds.has(item.vod_id)) item._hasAccess = true;
    });

    // 剩余的做有限探测，把混在首页里的其它免费片捞出来
    const unknown = list.filter((item) => item._hasAccess !== true);
    if (unknown.length && ACCESS_PROBE_LIMIT > 0) {
      const targets = unknown.slice(0, ACCESS_PROBE_LIMIT);
      const results = await mapLimit(targets, ACCESS_PROBE_CONCURRENCY, async (item) => {
        try { return await probeAccess(item.vod_id); } catch (_) { return { hasAccess: false, manifest: "" }; }
      });
      targets.forEach((item, i) => {
        const r = results[i];
        if (r && r.hasAccess) item._hasAccess = true;
        else item._hasAccess = false;
      });
    }

    let merged = list;
    if (FREE_FIRST && freeList.length) {
      // /free 独有的免费片补到最前（去重），保证首屏一定有完整片可看
      const have = new Set(list.map((v) => v.vod_id));
      const extra = freeList
        .filter((v) => !have.has(v.vod_id))
        .map((v) => ({ ...v, _hasAccess: true }));
      merged = sortFreeFirst(extra.concat(list), "home");
      log("info", `[home] 合并 /free: 新增免费=${extra.length}, 首页免费=${list.filter((v) => v._hasAccess === true).length}`);
    } else {
      merged = sortFreeFirst(list, "home");
    }

    merged = merged.map(decorateListRemarks);

    const filters = {};
    for (const item of CLASS_LIST) {
      filters[item.type_id] = [
        { key: "sort", name: "排序", init: "", value: SORT_OPTIONS },
      ];
    }
    const freeCount = merged.filter((v) => v._hasAccess === true).length;
    log("info", `[home] 返回分类=${CLASS_LIST.length}, 推荐=${merged.length}, 免费=${freeCount}`);
    return { class: CLASS_LIST, filters, list: merged };
  } catch (e) {
    log("error", `[home] 失败: ${e?.message || e}`);
    return { class: [], filters: {}, list: [] };
  }
}

async function category(params, context) {
  const page = Number(params?.page) || 1;
  try {
    const categoryId = String(params?.categoryId || params?.t || "video").trim();
    const filters = readFilters(params);
    const sort = normalizeSort(filters.sort || filters.by || params?.sort);
    const url = buildCategoryUrl(categoryId, page, sort);
    log("info", `[category] categoryId=${categoryId}, page=${page}, filters=${JSON.stringify(filters)}, from=${context?.from || "web"}`);
    log("info", `[category] 请求 URL=${url}`);

    const html = await fetchHtml(url, CATEGORY_TTL);
    let list = parseList(html, categoryId);
    // 免费频道整页都是完整片，不必逐条探测；其它频道探测后免费排前
    if (categoryId === "free") {
      list.forEach((item) => { item._hasAccess = true; });
    } else {
      list = await markAccess(list, "category");
      list = sortFreeFirst(list, "category");
    }
    list = list.map(decorateListRemarks);
    const pagecount = parsePageCount(html, 1);
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
    if (!keyword) {
      log("info", "[search] 关键词为空，返回空结果");
      return emptyPage(page);
    }
    const filters = readFilters(params);
    const sort = normalizeSort(filters.sort || params?.sort);
    const url = new URL(`${HOST}/search`);
    url.searchParams.set("q", keyword);
    if (page > 1) url.searchParams.set("page", String(page));
    if (sort) url.searchParams.set("sort", sort);
    const finalUrl = url.toString();
    log("info", `[search] keyword=${keyword}, page=${page}, quick=${params?.quick ? 1 : 0}, from=${context?.from || "web"}`);
    log("info", `[search] 请求 URL=${finalUrl}`);

    const html = await fetchHtml(finalUrl, SEARCH_TTL);
    let list = parseList(html, "video");
    list = await markAccess(list, "search");
    list = sortFreeFirst(list, "search").map(decorateListRemarks);
    const pagecount = parsePageCount(html, 1);
    log("info", `[search] 返回 list=${list.length}, pagecount=${pagecount}`);
    return pageResult(list, page, pagecount);
  } catch (e) {
    log("error", `[search] 失败: ${e?.message || e}`);
    return emptyPage(page);
  }
}

async function detail(params, context) {
  const videoId = normalizeVideoId(params?.videoId);
  try {
    if (!videoId) {
      log("info", "[detail] videoId 为空，返回空结构");
      return { list: [] };
    }
    const detailUrl = `${HOST}/v/${videoId}`;
    log("info", `[detail] videoId=${videoId}, from=${context?.from || "web"}`);
    log("info", `[detail] 请求 URL=${detailUrl}`);

    const html = await fetchHtml(detailUrl, DETAIL_TTL);
    const info = parseDetail(html, videoId);
    log("info", `[detail] title=${info.vod_name}, source=${info.source ? "命中" : "未命中"}, hasAccess=${info.hasAccess}, lines=${info.lines.map((l) => l.code).join(",")}`);

    // 各线路带 video_cdn_preference cookie 重取详情；cloudfront 复用已抓到的页面，避免重复请求
    const lineResults = await mapLimit(info.lines, 3, async (line) => {
      if (line.code === "cloudfront") {
        return { line, source: info.source, hasAccess: info.hasAccess, html };
      }
      const lineHtml = await fetchHtml(detailUrl, DETAIL_TTL, {
        cookie: `video_cdn_preference=${line.code}`,
      });
      return {
        line,
        source: parseSource(lineHtml),
        hasAccess: parseHasAccess(lineHtml),
        html: lineHtml,
      };
    });

    // 完整版 m3u8：免费片直接给；VIP 片带 SITE_COOKIE 再试一次。
    // probeAccess 内部按 id 缓存，列表阶段猜过的这里不会再打一遍。
    let manifest = "";
    let probed = null;
    try {
      probed = await probeAccess(videoId);
      manifest = probed.manifest || "";
    } catch (e) {
      log("info", `[detail] manifest 不可用: ${e?.message || e}`);
    }
    const hasFull = !!(manifest || info.hasAccess || (probed && probed.hasAccess));
    log("info", `[detail] manifest=${manifest ? "命中完整片" : "无完整片（仅预览可用）"}, hasFull=${hasFull}`);

    const sources = [];
    for (const item of lineResults) {
      if (!item || item.error || !item.source) {
        log("info", `[detail] 线路 ${item?.line?.code || "unknown"} 无 source，跳过`);
        continue;
      }
      const line = item.line;
      const meta = {
        id: videoId,
        title: info.vod_name,
        pic: info.vod_pic,
        line: line.code,
        lineName: line.name,
        kind: hasFull ? "full" : "preview",
      };
      // 有完整片时线路名不动；只有预览时把限制写在线路名上，避免用户以为播放器坏了
      const lineLabel = hasFull ? line.name : `${line.name}（预览${PREVIEW_SECONDS}s）`;
      sources.push({
        name: lineLabel,
        episodes: [
          {
            name: hasFull ? "正片" : `预览${PREVIEW_SECONDS}s`,
            playId: encodePlayId(item.source, meta),
          },
        ],
      });
    }

    if (manifest) {
      // 完整片排最前：用户点开默认就是正片，不用自己找
      sources.unshift({
        name: "完整版❤️",
        episodes: [
          {
            name: "完整版",
            playId: encodePlayId(manifest, {
              id: videoId,
              title: info.vod_name,
              pic: info.vod_pic,
              line: "manifest",
              lineName: "完整版",
              kind: "full",
            }),
          },
        ],
      });
    }

    if (!sources.length) {
      // 兜底：把播放页交给客户端嗅探，保证详情页至少有线路可点
      log("info", "[detail] 所有线路均未解出 source，回退播放页嗅探");
      sources.push({
        name: "页面嗅探",
        episodes: [
          {
            name: "播放",
            playId: encodePlayId(detailUrl, {
              id: videoId,
              title: info.vod_name,
              pic: info.vod_pic,
              line: "page",
              lineName: "页面嗅探",
              kind: "page",
            }),
          },
        ],
      });
    }

    const legacy = buildLegacyFields(sources);
    // 预览限制写进 remarks/content，宿主的详情页一眼可见，不会误判成播放故障
    const remarks = hasFull
      ? [info.vod_remarks, "完整"].filter(Boolean).join(" · ")
      : [info.vod_remarks, `预览${PREVIEW_SECONDS}s·VIP可看完整`].filter(Boolean).join(" · ");
    const content = hasFull
      ? info.vod_content
      : [info.vod_content, `本片为 VIP 资源，未登录仅提供 ${PREVIEW_SECONDS} 秒预览；配置 SITE_COOKIE 后可自动切完整版。`]
        .filter(Boolean).join("\n");
    const vod = {
      vod_id: videoId,
      vod_name: info.vod_name,
      vod_pic: info.vod_pic,
      type_id: "video",
      type_name: "GCAV",
      vod_content: content,
      vod_remarks: remarks,
      vod_tag: hasFull ? "完整" : "VIP预览",
      vod_play_sources: sources,
      ...legacy,
    };
    log("info", `[detail] 返回线路=${sources.length}, 分集=${sources.reduce((n, s) => n + s.episodes.length, 0)}`);
    return { list: [vod] };
  } catch (e) {
    log("error", `[detail] 失败: ${e?.message || e}`);
    return { list: [] };
  }
}

async function play(params, context) {
  try {
    const raw = String(params?.playId || params?.play_id || params?.ids || "").trim();
    const flag = String(params?.flag || "gcav");
    log("info", `[play] playId=${raw.slice(0, 160)}, flag=${flag}, from=${context?.from || "web"}`);
    if (!raw) throw new Error("playId 不能为空");

    let { url, meta } = decodePlayId(raw);
    if (!/^https?:\/\//i.test(url)) {
      // 兼容纯数字 id / gcav:123 的旧调用
      const id = normalizeVideoId(url || raw);
      if (/^\d+$/.test(id)) {
        const detailUrl = `${HOST}/v/${id}`;
        log("info", `[play] 兼容纯 id，回源详情页: ${detailUrl}`);
        const html = await requestText(detailUrl);
        url = parseSource(html) || detailUrl;
        meta = { id, title: `GCAV ${id}`, line: "fallback", lineName: "默认", kind: "preview" };
      }
    }
    if (!url) throw new Error("未解析出播放地址");

    const headers = buildPlayHeaders();
    log("info", `[play] resolved url=${url.slice(0, 200)}`);

    // 播放前二次确认：若这次拿到了完整 manifest（含配了 SITE_COOKIE 后刚生效），
    // 直接切正片，而不是回放 60 秒预览。
    if (meta.kind !== "full" && meta.id) {
      try {
        const probed = await probeAccess(meta.id);
        if (probed.manifest && isMediaUrl(probed.manifest)) {
          log("info", `[play] 二次探测拿到完整片，切换正片: ${probed.manifest.slice(0, 140)}`);
          recordHistory({ ...meta, kind: "full", lineName: "完整版" }, probed.manifest);
          return {
            urls: [{ name: "完整版", url: probed.manifest }],
            flag,
            header: headers,
            parse: 0,
          };
        }
      } catch (e) {
        log("info", `[play] 二次探测失败，继续用现有地址: ${e?.message || e}`);
      }
    }

    if (isMediaUrl(url)) {
      const isPreview = meta.kind !== "full";
      log("info", `[play] 命中媒体直链，parse=0, kind=${meta.kind || "unknown"}`);
      recordHistory(meta, url);
      return {
        urls: [{
          name: isPreview ? `预览${PREVIEW_SECONDS}s（VIP可看完整）` : (meta.lineName || "完整版"),
          url,
        }],
        flag,
        header: headers,
        parse: 0,
      };
    }

    // 播放页 / 解析页：先 SDK 嗅探，再交播放器 sniff
    if (typeof OmniBox.sniffVideo === "function") {
      try {
        log("info", `[play] SDK 嗅探开始: ${url}`);
        const sniffed = await OmniBox.sniffVideo(url, headers);
        const sniffedUrl = typeof sniffed === "string"
          ? sniffed.trim()
          : String(sniffed?.url || sniffed?.data?.url || "").trim();
        if (sniffedUrl && isMediaUrl(sniffedUrl)) {
          log("info", `[play] SDK 嗅探成功: ${sniffedUrl.slice(0, 160)}`);
          recordHistory(meta, sniffedUrl);
          return {
            urls: [{ name: meta.lineName || "播放", url: sniffedUrl }],
            flag,
            header: headers,
            parse: 0,
          };
        }
        log("info", "[play] SDK 嗅探未拿到媒体地址，走 parse=1 兜底");
      } catch (e) {
        log("error", `[play] SDK 嗅探失败: ${e?.message || e}`);
      }
    }

    log("info", "[play] sdk sniff failed -> parse=1 fallback");
    recordHistory(meta, url);
    return {
      urls: [{ name: meta.lineName || "播放", url }],
      flag,
      header: headers,
      parse: 1,
    };
  } catch (e) {
    log("error", `[play] 失败: ${e?.message || e}`);
    return { urls: [], flag: String(params?.flag || "gcav"), header: {}, parse: 1 };
  }
}

// 播放记录异步写，不阻塞启播；成功 / 已存在 / 失败分别留日志
function recordHistory(meta, url) {
  if (typeof OmniBox.addPlayHistory !== "function") return;
  const episode = String(meta.kind === "full" ? "完整版" : (meta.lineName || "预览"));
  const payload = {
    vodId: String(meta.id || ""),
    title: String(meta.title || ""),
    episode,
    episodeName: episode,
    pic: String(meta.pic || ""),
  };
  try {
    const p = OmniBox.addPlayHistory(payload);
    if (p && typeof p.then === "function") {
      p.then((r) => {
        const state = r && (r.exists || r.duplicate || r.code === 1) ? "记录已存在" : "添加成功";
        log("info", `[play] 播放记录${state}: id=${payload.vodId}, episode=${episode}, url=${url.slice(0, 100)}`);
      }).catch((e) => {
        log("error", `[play] 播放记录添加失败: ${e?.message || e}`);
      });
    }
  } catch (e) {
    log("error", `[play] 播放记录异常: ${e?.message || e}`);
  }
}
