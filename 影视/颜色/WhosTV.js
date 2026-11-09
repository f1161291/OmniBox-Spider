// @name 🔞WhosTV
// @author OmniBox
// @description 站点：whos.tv（AV 影片百科 + 在线播放，影片库 34 万部，详情路径 /videos/{番号}，分页 /videos/page-N）。HTML 路由受 Cloudflare 托管挑战保护，本源采用「直连优先 + Reader 通道兜底」抓页面，视频流则完全直连（HLS，无需 Cookie/Referer）。支持首页、分类（排序/标签/演员）、详情、搜索、播放。
// @dependencies []
// @version 2.1.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/WhosTV.js

/**
 * ============================================================================
 * whos.tv OmniBox 源 v2.1.0
 *
 * ⚠️ v1.0.0 的方向是错的：当时只找到社区资源帖接口（磁力/网盘），
 * 误判站点为「资源帖站」。实际站点主体是 **AV 影片库**：
 *   - /videos                  影片库，共 34 万部，每页 12 条，分页 /videos/page-N
 *   - /videos/{番号}            影片详情 + 在线播放（例：/videos/rlmp-028）
 *   - /actresses/{演员}/frames  演员页，/makers/{厂商}，/tags/{标签}
 *   - 列表排序：?sort=newest|popular|rating|views
 *
 * ---------------------------------------------------------------------------
 * 站点实测要点（2026-11）：
 *
 * 1. Cloudflare 托管挑战（cf-mitigated: challenge）
 *    /videos、/videos/{code}、/actresses、/ajax/* 等 HTML 路由对普通 HTTP 客户端
 *    一律 403。已逐项验证无效：完整浏览器请求头、X-Requested-With、Accept: json、
 *    多语言前缀、Googlebot/bingbot/YandexBot UA、pycurl（不同 TLS 栈）、
 *    Node 原生 TLS。这是 JS 挑战，必须执行 JS 才能过。
 *    → 因此页面抓取走「双通道」：
 *      ① 直连（宿主 request / 原生 https）—— 若部署环境已有 cf_clearance 或站点放宽，直接命中
 *      ② Reader 通道（r.jina.ai，渲染后返回 HTML）—— 当前实测唯一稳定可用
 *    视频流本身**不需要挑战**，直连即可，所以播放链路不受影响。
 *
 * 2. 播放地址规律（已用 4 个番号交叉验证）
 *    og:image = https://v.hersav.me/images/av/{hash}.jpg
 *    HLS      = https://v.hersav.me/{hash}/{hash}.m3u8
 *    即：同一个 32 位 hash 既是封面名也是流路径名。
 *    m3u8 内容为 VOD，分片是 **.jpeg 后缀的 TS**（video0.jpeg / video1.jpeg…），
 *    实测 200 image/jpeg 721KB/片，Content-Type 被伪装但播放器可正常解码。
 *    无需 Referer、无需 Cookie（no-referer 请求同样 200）。
 *
 * 3. 列表页结构（raw HTML）
 *    卡片：a[href^="/videos/"] > .video-card-surface
 *      - 封面 img src = https://v.hersav.me/images/av/{hash}.jpg
 *      - 番号与标题：卡片内两个 span（第一个形如 rlmp-028）
 *      - 评分：lucide--star 后面的数字
 *    分页：/videos/page-{n}（?page=n 无效，实测返回首页）
 *
 * 4. 详情页结构
 *    data-subtitle="rlmp-028"        番号
 *    data-entity-id="341091"          影片 ID
 *    data-title="…"                   标题
 *    /actresses/{name}/frames         演员
 *    /makers/{name}                   厂商
 *    /tags/{name}                     标签
 *    <source src="…m3u8">             真实播放地址（raw HTML 里就有）
 *
 * 5. 封面（v2.1.0）
 *    列表页封面已从 <img src> 改为 <div data-cover-src="{XOR密文}">，
 *    密文需按 lazy-cover.js 算法解密（末 2 位 hex 作 key，逐字节异或）。
 *    若列表卡仍未取到封面（模板改版 / 解密失败），会自动回源详情页，
 *    从详情页 og:image（同为 images/av/{hash}.jpg）取封面补上。
 *
 * 6. 环境变量
 *    WHOSTV_HOST           站点域名
 *    WHOSTV_READER         页面兜底通道；默认 https://r.jina.ai（留空则只用直连）
 *    WHOSTV_DIRECT_FIRST   1=先试直连再回退 reader（默认 1）；0=直接用 reader
 *    WHOSTV_PROXY_URL      出口代理（HTTP CONNECT / SOCKS5），作用于页面抓取
 *    WHOSTV_COVER_FILL     列表缺封面时回源详情的最大补图条数（默认 12，0=关闭）
 * ============================================================================
 */

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  OmniBox = {
    log(level, message) {
      console.log(`[${level}] ${message}`);
    },
    async request() {
      throw new Error("omnibox_sdk 不可用");
    },
    async getCache() {
      return null;
    },
    async setCache() {},
  };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

const crypto = require("crypto");

/* ==========================================================================
 * 配置
 * ========================================================================== */

const HOST = String(process.env.WHOSTV_HOST || "https://whos.tv").replace(/\/+$/, "");
const UA = String(
  process.env.WHOSTV_USER_AGENT
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
const REQUEST_TIMEOUT = Number(process.env.WHOSTV_TIMEOUT || 30000);
const READER_TIMEOUT = Number(process.env.WHOSTV_READER_TIMEOUT || 90000);

// 页面兜底通道（Cloudflare 托管挑战下唯一稳定通路）
const READER_BASE = String(process.env.WHOSTV_READER || "https://r.jina.ai").replace(/\/+$/, "");
const DIRECT_FIRST = String(process.env.WHOSTV_DIRECT_FIRST || "1") !== "0";

// 出口代理（HTTP CONNECT / SOCKS5）：部分网络环境下直连 /api 也需要
const PROXY_URL = String(
  process.env.WHOSTV_PROXY_URL
  || process.env.UPSTREAM_HTTP_PROXY_URL
  || process.env.HTTP_PROXY_URL
  || "",
).trim();

const LIST_CACHE_TTL = Number(process.env.WHOSTV_LIST_CACHE_TTL || 900);
const DETAIL_CACHE_TTL = Number(process.env.WHOSTV_DETAIL_CACHE_TTL || 7200);
const PLAY_CACHE_TTL = Number(process.env.WHOSTV_PLAY_CACHE_TTL || 7200);

const PAGE_SIZE = 12; // 站点每页固定 12 条
const MAX_PAGE = 28424;

const CACHE_SCHEMA = "v2";
const CACHE_PREFIX = `whostv:${CACHE_SCHEMA}:`;

const SORT_OPTIONS = [
  { value: "newest", label: "最新发布" },
  { value: "popular", label: "人气最高" },
  { value: "rating", label: "评分最高" },
  { value: "views", label: "播放最多" },
];

const CLASS_LIST = [
  { type_id: "sort:newest", type_name: "最新发布" },
  { type_id: "sort:popular", type_name: "人气最高" },
  { type_id: "sort:rating", type_name: "评分最高" },
  { type_id: "sort:views", type_name: "播放最多" },
  { type_id: "rank:video", type_name: "影片排行榜" },
];

// 首页快捷标签（站点 /tags/{name} 路由）
const QUICK_TAGS = ["潮吹", "中出", "单体作品", "淫乱真实"];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

/* ==========================================================================
 * 基础设施
 * ========================================================================== */

function logInfo(message) {
  try {
    Promise.resolve(OmniBox.log("info", `[whostv] ${message}`)).catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function logError(message, error) {
  const detail = error && error.message ? ` | ${error.message}` : "";
  try {
    Promise.resolve(OmniBox.log("error", `[whostv] ${message}${detail}`)).catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function shortHash(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex").slice(0, 16);
}

function buildCacheKey(name, ...parts) {
  const raw = parts.filter((p) => p != null && p !== "").join("|");
  const base = `${CACHE_PREFIX}${name}`;
  if (!raw) return base;
  if (raw.length <= 120) return `${base}:${raw}`;
  return `${base}:h${shortHash(raw)}`;
}

async function getCachedJson(key) {
  try {
    const raw = await OmniBox.getCache(key);
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    return JSON.parse(String(raw));
  } catch (error) {
    logInfo(`缓存读取失败 ${key}: ${error.message}`);
    return null;
  }
}

async function setCachedJson(key, value, ttl) {
  try {
    await OmniBox.setCache(key, JSON.stringify(value), ttl);
    return true;
  } catch (error) {
    logInfo(`缓存写入失败 ${key}: ${error.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(input) {
  return String(input == null ? "" : input)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function normalizeText(input) {
  return decodeEntities(String(input == null ? "" : input).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/* ==========================================================================
 * 代理隧道（HTTP CONNECT + SOCKS5），零依赖
 * ========================================================================== */

function parseProxyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (error) {
    logInfo(`代理地址无效，忽略: ${error.message}`);
    return null;
  }
  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  const isSocks = protocol.indexOf("socks") === 0;
  return {
    protocol,
    host: parsed.hostname,
    port: Number(parsed.port || (isSocks ? 1080 : 7890)),
    auth: parsed.username || parsed.password
      ? {
        username: decodeURIComponent(parsed.username || ""),
        password: decodeURIComponent(parsed.password || ""),
      }
      : null,
    isSocks,
  };
}

function connectViaHttpProxy(proxy, host, port, timeout) {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on("timeout", () => fail(Object.assign(new Error("代理连接超时"), { code: "ETIMEDOUT" })));
    socket.on("error", fail);
    socket.on("connect", () => {
      const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (proxy.auth && proxy.auth.username) {
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString("base64")}`);
      }
      lines.push("Proxy-Connection: keep-alive", "", "");
      socket.write(lines.join("\r\n"));
    });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.indexOf("\r\n\r\n") < 0) return;
      socket.removeListener("data", onData);
      const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
      const code = Number((statusLine.match(/\s(\d{3})\s?/) || [])[1] || 0);
      if (code !== 200) {
        fail(new Error(`代理 CONNECT 失败: ${statusLine}`));
        return;
      }
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

function connectViaSocks5(proxy, host, port, timeout) {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let stage = "greeting";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on("timeout", () => fail(Object.assign(new Error("SOCKS5 连接超时"), { code: "ETIMEDOUT" })));
    socket.on("error", fail);
    socket.on("connect", () => {
      const withAuth = !!(proxy.auth && proxy.auth.username);
      socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    });
    const buildConnect = () => {
      const hostBuf = Buffer.from(host, "utf8");
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]);
    };
    const onData = (chunk) => {
      if (stage === "greeting") {
        if (chunk[0] !== 0x05) return fail(new Error("SOCKS5 版本不匹配"));
        if (chunk[1] === 0x02) {
          const user = Buffer.from(proxy.auth.username, "utf8");
          const pass = Buffer.from(proxy.auth.password, "utf8");
          stage = "auth";
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          return;
        }
        if (chunk[1] === 0x00) {
          stage = "connect";
          socket.write(buildConnect());
          return;
        }
        return fail(new Error(`SOCKS5 不支持认证 ${chunk[1]}`));
      }
      if (stage === "auth") {
        if (chunk[1] !== 0x00) return fail(new Error("SOCKS5 认证失败"));
        stage = "connect";
        socket.write(buildConnect());
        return;
      }
      if (stage === "connect") {
        if (chunk[1] !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${chunk[1]}`));
        socket.removeListener("data", onData);
        settled = true;
        socket.setTimeout(0);
        resolve(socket);
      }
    };
    socket.on("data", onData);
  });
}

/* ==========================================================================
 * 双通道页面抓取
 * ========================================================================== */

function isChallenge(body) {
  const text = String(body || "");
  return /Just a moment|cf-mitigated|challenge-platform|_cf_chl_opt/i.test(text);
}

async function fetchDirect(url, timeout) {
  const target = url.startsWith("http") ? url : `${HOST}${url}`;
  const res = await OmniBox.request(target, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: `${HOST}/`,
    },
    timeout: timeout || REQUEST_TIMEOUT,
  });
  const statusCode = Number((res && res.statusCode) || 0);
  const body = String((res && res.body) || "");
  if (statusCode === 200 && body && !isChallenge(body)) {
    return { ok: true, html: body, via: "direct" };
  }
  return {
    ok: false,
    via: "direct",
    statusCode,
    challenged: isChallenge(body),
  };
}

async function fetchViaReader(url) {
  if (!READER_BASE) return { ok: false, via: "reader", reason: "未配置 reader 通道" };
  const target = url.startsWith("http") ? url : `${HOST}${url}`;
  const readerUrl = `${READER_BASE}/${target}`;
  logInfo(`reader 通道抓取 ${target}`);

  const res = await OmniBox.request(readerUrl, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      // 要求 reader 返回渲染后的原始 HTML，而不是 markdown
      "X-Return-Format": "html",
      Accept: "text/html,*/*",
    },
    timeout: READER_TIMEOUT,
  });
  const statusCode = Number((res && res.statusCode) || 0);
  const body = String((res && res.body) || "");
  if (statusCode === 200 && body && !isChallenge(body)) {
    return { ok: true, html: body, via: "reader" };
  }
  return { ok: false, via: "reader", statusCode };
}

/**
 * 页面抓取：直连优先，失败回退 reader。
 * Cloudflare 托管挑战必须执行 JS 才能过，Node 侧无法自行解决；
 * reader 通道等价于「已通过挑战的浏览器」渲染后再取 HTML。
 */
async function fetchPage(url, { ttl = 0, cacheName = "page" } = {}) {
  const target = url.startsWith("http") ? url : `${HOST}${url}`;
  const cacheKey = ttl > 0 ? buildCacheKey(cacheName || "page", target) : "";

  if (cacheKey) {
    const cached = await getCachedJson(cacheKey);
    if (cached && cached.html) {
      logInfo(`命中页面缓存 ${cacheName} ${target}`);
      return cached.html;
    }
  }

  const attempts = DIRECT_FIRST ? ["direct", "reader"] : ["reader", "direct"];
  let lastError = null;

  for (const channel of attempts) {
    try {
      const result = channel === "direct"
        ? await fetchDirect(target)
        : await fetchViaReader(target);

      if (result.ok) {
        if (result.via === "reader") logInfo(`reader 通道成功 ${target}`);
        if (cacheKey) await setCachedJson(cacheKey, { html: result.html }, ttl);
        return result.html;
      }
      if (result.challenged) logInfo(`直连被 Cloudflare 挑战拦截，切换通道 ${target}`);
      else logInfo(`${channel} 通道失败 HTTP ${result.statusCode || "-"} ${target}`);
    } catch (error) {
      lastError = error;
      logInfo(`${channel} 通道异常 ${error.code || error.message} ${target}`);
    }
  }

  throw lastError || new Error(`页面抓取失败 @ ${target}`);
}

/* ==========================================================================
 * 列表解析
 * ========================================================================== */

/**
 * 从列表页截取卡片。不用 cheerio（少一个依赖），直接按结构正则切块：
 * 每个卡片是 <a href="/videos/{code}" ...> ... </a>，内部含封面与番号/标题。
 */
function parseVideoCards(html) {
  const text = String(html || "");
  const cards = [];
  const seen = new Set();

  // 以 <a href="/videos/CODE" 为锚点切分
  const anchorRe = /<a\s+href="\/videos\/([a-z0-9][a-z0-9._-]*)"[^>]*class="[^"]*group block[^"]*"[^>]*>([\s\S]{0,2600}?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(text)) !== null) {
    const code = match[1];
    const chunk = match[2];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    cards.push(mapCard(code, chunk));
  }

  // 兜底：class 顺序不同的卡片
  if (!cards.length) {
    const looseRe = /<a\s+href="\/videos\/([a-z0-9][a-z0-9._-]*)"[^>]*>([\s\S]{0,2600}?)<\/a>/gi;
    while ((match = looseRe.exec(text)) !== null) {
      const code = match[1];
      const chunk = match[2];
      if (!code || seen.has(code)) continue;
      if (!/hersav\.me\/images\/av\//i.test(chunk)) continue; // 只认带封面的卡片
      seen.add(code);
      cards.push(mapCard(code, chunk));
    }
  }

  return cards;
}

function mapCard(code, chunk) {
  // 封面两种形态：
  // 1. 旧版：<img src="https://v.hersav.me/images/av/{hash}.jpg">
  // 2. 新版：<div data-cover-src="{XOR 密文}">（前端 lazy-cover.js 解密后再换成 img）
  //    站点已切到第 2 种，必须解密，否则列表页封面全空。
  let pic = "";
  let hash = "";
  const imageMatch = chunk.match(/https:\/\/[^"'\s]+\/images\/av\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp)/i);
  if (imageMatch) {
    pic = imageMatch[0];
    hash = imageMatch[1];
  } else {
    const encMatch = chunk.match(/data-cover-src="([0-9a-f]+)"/i);
    if (encMatch) {
      const decoded = coolDecrypt(encMatch[1]);
      const hashMatch = decoded.match(/\/images\/av\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp)/i);
      if (hashMatch) {
        pic = decoded;
        hash = hashMatch[1];
      }
    }
  }

  const titleMatch = chunk.match(/alt="([^"]{2,})"/i);
  const ratingMatch = chunk.match(/lucide--star[\s\S]{0,220}?<span[^>]*>\s*([\d.]+)\s*<\/span>/i);

  // 卡片里第一个纯文本 span 通常就是番号
  let title = normalizeText(titleMatch ? titleMatch[1] : "");

  return {
    vod_id: code,
    vod_name: title || code.toUpperCase(),
    vod_pic: pic,
    vod_remarks: ratingMatch && Number(ratingMatch[1]) > 0 ? `★${ratingMatch[1]}` : "",
    _code: code,
    _hash: hash,
  };
}

/**
 * 站点的懒加载封面是 XOR 编码的（main.js / lazy-cover.js 里的 coolDecrypt）：
 * 取字符串最后 2 位作为密钥，其余每 2 位 hex 与密钥异或。
 */
function coolDecrypt(encoded) {
  const text = String(encoded || "");
  if (!text || text.length < 4) return "";
  const key = parseInt(text.slice(-2), 16);
  if (!Number.isFinite(key)) return "";
  const body = text.slice(0, -2);
  let out = "";
  for (let i = 0; i + 1 < body.length; i += 2) {
    out += String.fromCharCode(parseInt(body.substr(i, 2), 16) ^ key);
  }
  return out;
}

/**
 * 排行榜页的卡片结构不同于影片库网格（无 group block class、封面走 data-cover-src），
 * 用独立解析器处理。
 */
function parseRankCards(html) {
  const text = String(html || "");
  const cards = [];
  const seen = new Set();
  const re = /<a\s+href="\/videos\/([a-z0-9][a-z0-9._-]*)"[\s\S]{0,1800}?<\/a>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const code = match[1];
    if (!code || seen.has(code)) continue;
    const chunk = match[0];

    let pic = "";
    const direct = chunk.match(/https:\/\/[^"'\s]+\/images\/av\/[a-f0-9]{32}\.(?:jpg|jpeg|png|webp)/i);
    if (direct) {
      pic = direct[0];
    } else {
      const enc = chunk.match(/data-cover-src="([0-9a-f]+)"/i);
      if (enc) {
        const dec = coolDecrypt(enc[1]);
        if (/^https?:\/\//i.test(dec)) pic = dec;
      }
    }

    const titleMatch = chunk.match(/alt="([^"]{2,})"/i);
    seen.add(code);
    cards.push({
      vod_id: code,
      vod_name: normalizeText(titleMatch ? titleMatch[1] : "") || code.toUpperCase(),
      vod_pic: pic,
      vod_remarks: "",
      _code: code,
    });
  }
  return cards;
}

/**
 * 列表卡片偶尔拿不到封面（模板改版 / data-cover-src 缺失 / 解密失败）。
 * 按用户要求：这类条目回源详情页，从详情页的 og:image / images/av/{hash} 取封面。
 * 限并发 + 只补前 N 条，避免把 reader 通道打爆。
 */
async function fillMissingCovers(items, { concurrency = 3, maxFill = 12 } = {}) {
  const missing = (items || []).filter((item) => !item.vod_pic);
  if (!missing.length) return items;

  const targets = missing.slice(0, maxFill);
  logInfo(`列表缺封面 ${missing.length} 条，回源详情补 ${targets.length} 条`);

  const queue = targets.slice();
  const filled = new Map();

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) continue;
      try {
        const detail = await fetchVideoDetail(item.vod_id);
        if (detail && detail.pic) {
          filled.set(item.vod_id, detail.pic);
        }
      } catch (error) {
        logInfo(`补封面失败 ${item.vod_id}: ${error.message}`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, targets.length); i += 1) workers.push(worker());
  await Promise.all(workers);

  if (!filled.size) return items;
  logInfo(`补封面成功 ${filled.size}/${targets.length}`);
  return items.map((item) => (
    item.vod_pic ? item : Object.assign({}, item, { vod_pic: filled.get(item.vod_id) || "" })
  ));
}

function toVodList(items) {
  return (items || []).map((item) => ({
    vod_id: item.vod_id,
    vod_name: item.vod_name,
    vod_pic: item.vod_pic,
    vod_remarks: item.vod_remarks || "",
  }));
}

function buildListPath({ page = 1, sort = "" } = {}) {
  const pageNum = Math.max(1, Math.min(Number(page) || 1, MAX_PAGE));
  const base = pageNum > 1 ? `${HOST}/videos/page-${pageNum}` : `${HOST}/videos`;
  if (!sort || sort === "newest") return base;
  // 带排序参数时，页码参数实测无效（?page=2 返回首页），因此排序页只取第一页
  return `${base}?sort=${encodeURIComponent(sort)}`;
}

async function fetchListPage({ page = 1, sort = "" } = {}) {
  const url = buildListPath({ page, sort });
  logInfo(`拉取列表 page=${page} sort=${sort || "newest"} ${url}`);
  const html = await fetchPage(url, { ttl: LIST_CACHE_TTL, cacheName: "list" });
  const list = parseVideoCards(html);
  logInfo(`列表解析 page=${page} cards=${list.length}`);
  return { list, page: Number(page) || 1 };
}

/* ==========================================================================
 * 详情解析
 * ========================================================================== */

function extractStreamFromHtml(html) {
  const text = String(html || "");
  // 1. 优先 <source src="…m3u8">
  const sourceMatch = text.match(/<source[^>]+src="([^"]+\.m3u8[^"]*)"/i);
  if (sourceMatch) return decodeEntities(sourceMatch[1]);
  // 2. video 标签直接给 m3u8
  const videoMatch = text.match(/<video[^>]+src="([^"]+\.m3u8[^"]*)"/i);
  if (videoMatch) return decodeEntities(videoMatch[1]);
  // 3. 任意 m3u8 字面量
  const loose = text.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
  if (loose) return loose[0];
  // 4. 用封面 hash 推导
  const hashMatch = text.match(/images\/av\/([a-f0-9]{32})\./i);
  if (hashMatch) {
    const hash = hashMatch[1];
    return `https://v.hersav.me/${hash}/${hash}.m3u8`;
  }
  return "";
}

function parseDetailHtml(html, code) {
  const text = String(html || "");

  const codeMatch = text.match(/data-subtitle="([^"]+)"/i);
  const finalCode = codeMatch ? decodeEntities(codeMatch[1]) : code;

  const entityMatch = text.match(/data-entity-id="(\d+)"/i);
  const entityId = entityMatch ? entityMatch[1] : "";

  const titleMatch = text.match(/data-title="([^"]{2,})"/i);
  const ogTitleMatch = text.match(/og:title"\s+content="([^"]+)"/i);
  const pageTitleMatch = text.match(/<title>([^<]+)<\/title>/i);

  let title = normalizeText(titleMatch ? titleMatch[1] : "");
  if (!title && ogTitleMatch) {
    // og:title 形如「rlmp-028 标题… 作品资料、精彩画面、高清在线播放」
    title = normalizeText(ogTitleMatch[1])
      .replace(new RegExp(`^${finalCode}\\s*`, "i"), "")
      .replace(/\s*作品资料.*$/, "")
      .trim();
  }
  if (!title && pageTitleMatch) {
    title = normalizeText(pageTitleMatch[1])
      .replace(new RegExp(`^${finalCode}\\s*`, "i"), "")
      .replace(/\s*作品资料.*$/, "")
      .trim();
  }

  const imageMatch = text.match(/https:\/\/[^"'\s]+\/images\/av\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp)/i);
  const hash = imageMatch ? imageMatch[1] : "";
  const pic = imageMatch ? imageMatch[0] : "";

  const actresses = Array.from(new Set(
    (text.match(/\/actresses\/([^/"?#]+)\/frames/g) || [])
      .map((item) => decodeURIComponent(item.replace(/^\/actresses\//, "").replace(/\/frames$/, "")))
      .map((item) => normalizeText(item))
      .filter(Boolean),
  ));

  const makers = Array.from(new Set(
    (text.match(/\/makers\/([^"?#]+)/g) || [])
      .map((item) => decodeURIComponent(item.replace(/^\/makers\//, "")))
      .map((item) => normalizeText(item))
      .filter(Boolean),
  ));

  const tags = Array.from(new Set(
    (text.match(/\/tags\/([^"?#]+)/g) || [])
      .map((item) => decodeURIComponent(item.replace(/^\/tags\//, "")))
      .map((item) => normalizeText(item))
      .filter(Boolean),
  ));

  const durationMatch = text.match(/aria-valuemax="(\d{3,7}(?:\.\d+)?)"/);
  const duration = durationMatch ? Math.round(Number(durationMatch[1])) : 0;

  const description = (() => {
    const desc = text.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    return desc ? normalizeText(desc[1]) : "";
  })();

  const streamUrl = extractStreamFromHtml(text);

  return {
    code: finalCode,
    entityId,
    title: title || finalCode.toUpperCase(),
    pic,
    hash,
    actresses,
    makers,
    tags,
    duration,
    description,
    streamUrl,
  };
}

async function fetchVideoDetail(code) {
  const cacheKey = buildCacheKey("detail", code);
  const cached = await getCachedJson(cacheKey);
  if (cached && cached.code) {
    logInfo(`命中详情缓存 ${code}`);
    return cached;
  }

  const url = `${HOST}/videos/${encodeURIComponent(code)}`;
  const html = await fetchPage(url, { ttl: DETAIL_CACHE_TTL, cacheName: "detail" });
  const detail = parseDetailHtml(html, code);
  await setCachedJson(cacheKey, detail, DETAIL_CACHE_TTL);
  logInfo(`详情解析 ${code} title=${detail.title.slice(0, 30)} stream=${detail.streamUrl ? "有" : "无"} 演员=${detail.actresses.length}`);
  return detail;
}

/* ==========================================================================
 * 五个 handler
 * ========================================================================== */

async function home(params, context) {
  logInfo(`home 入口 from=${(context && context.from) || "web"}`);
  try {
    const { list } = await fetchListPage({ page: 1, sort: "newest" });
    const withCovers = await fillMissingCovers(list);
    logInfo(`home 结果 list=${withCovers.length} 有封面=${withCovers.filter((i) => i.vod_pic).length}`);
    return {
      class: CLASS_LIST,
      filters: buildFilters(),
      list: toVodList(withCovers),
    };
  } catch (error) {
    logError("home 失败", error);
    return { class: CLASS_LIST, list: [] };
  }
}

function buildFilters() {
  const sortValues = SORT_OPTIONS.map((item) => ({ name: item.label, value: item.value }));
  const tagValues = [{ name: "全部", value: "" }].concat(QUICK_TAGS.map((tag) => ({ name: tag, value: tag })));
  const filters = {};
  for (const item of CLASS_LIST) {
    filters[item.type_id] = [
      { key: "sort", name: "排序", value: sortValues },
      { key: "tag", name: "标签", value: tagValues },
    ];
  }
  return filters;
}

async function category(params, context) {
  const categoryId = String((params && params.categoryId) || "sort:newest");
  const page = Math.max(1, Number((params && params.page) || 1) || 1);
  const filters = (params && (params.filters || params.extend || params.ext || params.filter)) || {};

  let sort = categoryId.indexOf("sort:") === 0 ? categoryId.slice(5) : "newest";
  if (filters && typeof filters === "object" && filters.sort) sort = String(filters.sort);
  const tag = filters && typeof filters === "object" && filters.tag ? String(filters.tag).trim() : "";

  logInfo(`category 入口 categoryId=${categoryId} page=${page} sort=${sort} tag=${tag || "-"}`);

  try {
    if (categoryId.indexOf("rank:") === 0) {
      const rankPath = `${HOST}/ranking/video`;
      const html = await fetchPage(rankPath, { ttl: LIST_CACHE_TTL, cacheName: "rank" });
      let list = parseRankCards(html);
      if (!list.length) list = parseVideoCards(html);
      // 排行榜单页无分页，本地切片
      const start = (page - 1) * PAGE_SIZE;
      list = list.slice(start, start + PAGE_SIZE);
      list = await fillMissingCovers(list);
      logInfo(`category(rank) 结果 list=${list.length} 有封面=${list.filter((i) => i.vod_pic).length}`);
      return {
        page,
        pagecount: Math.max(1, Math.ceil((list.length || PAGE_SIZE) / PAGE_SIZE)),
        total: list.length,
        list: toVodList(list),
      };
    }

    if (tag) {
      // 标签页：/tags/{name}，先取了第一页；标签页也支持 /page-N 形态
      const tagPath = page > 1
        ? `${HOST}/tags/${encodeURIComponent(tag)}/page-${page}`
        : `${HOST}/tags/${encodeURIComponent(tag)}`;
      const html = await fetchPage(tagPath, { ttl: LIST_CACHE_TTL, cacheName: "tag" });
      const list = parseVideoCards(html);
      const withCovers = await fillMissingCovers(list);
      logInfo(`category(tag) 结果 tag=${tag} list=${withCovers.length} 有封面=${withCovers.filter((i) => i.vod_pic).length}`);
      return {
        page,
        pagecount: list.length >= PAGE_SIZE ? page + 1 : page,
        total: (page - 1) * PAGE_SIZE + list.length,
        list: toVodList(withCovers),
      };
    }

    const result = await fetchListPage({ page, sort });
    result.list = await fillMissingCovers(result.list);
    // 站点共 28424 页，pagecount 给一个足够大的值让宿主能继续翻页
    const pagecount = Math.max(page, page + (result.list.length >= PAGE_SIZE ? 1 : 0)) > page
      ? page + 1
      : page;
    logInfo(`category 结果 list=${result.list.length} 有封面=${result.list.filter((i) => i.vod_pic).length} pagecount=${pagecount}`);
    return {
      page,
      pagecount,
      total: Math.min(MAX_PAGE, page) * PAGE_SIZE,
      list: toVodList(result.list),
    };
  } catch (error) {
    logError(`category 失败 categoryId=${categoryId} page=${page}`, error);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  const rawId = String((params && params.videoId) || "").trim();
  logInfo(`detail 入口 videoId=${rawId} from=${(context && context.from) || "web"}`);
  if (!rawId) return { list: [] };

  // 兼容传入完整 URL
  const code = rawId.replace(/^https?:\/\/[^/]+\/videos\//i, "").replace(/[/?#].*$/, "").trim();
  if (!code) return { list: [] };

  try {
    const info = await fetchVideoDetail(code);

    const remarksParts = [];
    if (info.duration) {
      const minutes = Math.round(info.duration / 60);
      remarksParts.push(`${minutes}分钟`);
    }
    if (info.makers.length) remarksParts.push(info.makers[0]);

    const vod = {
      vod_id: info.code,
      vod_name: info.title || info.code,
      vod_pic: info.pic,
      vod_content: info.description || [info.code, ...info.tags].filter(Boolean).join(" · "),
      vod_year: "",
      vod_area: "日本",
      vod_lang: "日语",
      vod_remarks: remarksParts.join(" · "),
      type_name: info.tags.slice(0, 4).join("/") || "AV影片",
      vod_actor: info.actresses.join(","),
      vod_director: info.makers.join(","),
      vod_play_sources: [
        {
          name: "Whos在线",
          episodes: [{
            name: info.code.toUpperCase(),
            playId: `${info.code}|${info.streamUrl || ""}`,
            episodeName: info.title,
          }],
        },
      ],
    };

    // 兼容老展示链路
    vod.vod_play_from = "Whos在线";
    vod.vod_play_url = `${info.code.toUpperCase()}$${vod.vod_play_sources[0].episodes[0].playId}`;

    logInfo(`detail 结果 name=${vod.vod_name.slice(0, 30)} stream=${info.streamUrl ? "有" : "无"} 演员=${info.actresses.length}`);
    return { list: [vod] };
  } catch (error) {
    logError(`detail 失败 videoId=${rawId}`, error);
    return { list: [] };
  }
}

async function search(params, context) {
  const keyword = String((params && (params.keyword || params.wd || params.key)) || "").trim();
  const page = Math.max(1, Number((params && params.page) || 1) || 1);
  logInfo(`search 入口 keyword=${keyword} page=${page} from=${(context && context.from) || "web"}`);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

  try {
    // 站点实测：/videos?keyword= / ?search= / ?q= 等参数**全部被忽略**（返回首页同样 12 条）。
    // 真正可用的是演员页 /actresses/{名字}（返回该演员作品）。
    // 因此搜索策略：
    //   1) 番号形态（字母+数字）→ 直接按番号取详情页，命中即返回该片
    //   2) 其它关键词 → 先试演员页，再回到影片库首页做本地匹配兜底
    const kw = keyword.toLowerCase();
    const passThrough = (items) => items.filter((item) => `${item.vod_id} ${item.vod_name}`.toLowerCase().indexOf(kw) >= 0);

    let matched = [];

    // 1) 番号形态
    const looksLikeCode = /^[a-z]{2,10}[-_]?\d{2,6}$/i.test(keyword);
    if (looksLikeCode) {
      const code = keyword.toLowerCase().replace(/_/g, "-");
      try {
        const info = await fetchVideoDetail(code);
        if (info && info.title && info.title.toLowerCase() !== code) {
          matched = [{
            vod_id: info.code,
            vod_name: info.title,
            vod_pic: info.pic,
            vod_remarks: info.duration ? `${Math.round(info.duration / 60)}分钟` : "",
          }];
          logInfo(`search 番号直查命中 ${code}`);
        }
      } catch (error) {
        logInfo(`search 番号直查失败 ${code}: ${error.message}`);
      }
    }

    // 2) 演员页（仅日文/中文名有意义；纯 ASCII 且非番号的词走这里只会拿到列表页噪声）
    const looksLikeName = /[\u3040-\u30ff\u4e00-\u9fff]/.test(keyword);
    if (!matched.length && looksLikeName) {
      try {
        const actressPath = `${HOST}/actresses/${encodeURIComponent(keyword)}`;
        const html = await fetchPage(actressPath, { ttl: LIST_CACHE_TTL, cacheName: "actress" });
        // 必须确认页面确实是这个演员的资料页（标题里应出现该名字），
        // 否则站点会把不存在的路径渲染成通用列表，导致假命中。
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? decodeEntities(titleMatch[1]) : "";
        const isActressPage = pageTitle.indexOf(keyword) >= 0;
        const cards = isActressPage ? parseVideoCards(html) : [];
        if (cards.length) {
          matched = cards;
          logInfo(`search 演员页命中 ${keyword} cards=${cards.length}`);
        } else {
          logInfo(`search 演员页非该演员资料页，忽略 ${keyword} title=${pageTitle.slice(0, 40)}`);
        }
      } catch (error) {
        logInfo(`search 演员页未命中 ${keyword}: ${error.message}`);
      }
    }

    // 3) 影片库首页本地匹配兜底
    if (!matched.length) {
      const cards = await fetchListPage({ page: 1, sort: "newest" });
      const local = passThrough(cards.list);
      matched = local;
      logInfo(`search 本地匹配 ${keyword} cards=${cards.list.length} matched=${local.length}`);
    }

    const start = (page - 1) * PAGE_SIZE;
    const slice = matched.slice(start, start + PAGE_SIZE);
    const pagecount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));

    const withCovers = await fillMissingCovers(slice);
    logInfo(`search 结果 keyword=${keyword} total=${matched.length} list=${withCovers.length} 有封面=${withCovers.filter((i) => i.vod_pic).length}`);
    return {
      page,
      pagecount: matched.length ? pagecount : page,
      total: matched.length,
      list: toVodList(withCovers),
    };
  } catch (error) {
    logError(`search 失败 keyword=${keyword}`, error);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

/* ==========================================================================
 * 播放
 * ========================================================================== */

function looksLikeM3u8(url) {
  return /\.m3u8($|\?)/i.test(String(url || ""));
}

async function play(params, context) {
  const rawPlayId = String((params && (params.playId || params.id)) || "").trim();
  logInfo(`play 入口 playId=${rawPlayId.slice(0, 90)} from=${(context && context.from) || "web"}`);
  if (!rawPlayId) return { urls: [], flag: "Whos在线", parse: 0, header: {} };

  const [codePart, inlineUrl] = rawPlayId.split("|");
  const code = String(codePart || "").trim().replace(/^https?:\/\/[^/]+\/videos\//i, "").replace(/[/?#].*$/, "");

  const header = {
    "User-Agent": UA,
    Referer: `${HOST}/`,
  };

  try {
    let streamUrl = looksLikeM3u8(inlineUrl) ? inlineUrl : "";

    if (!streamUrl) {
      const cacheKey = buildCacheKey("play", code);
      const cached = await getCachedJson(cacheKey);
      if (cached && looksLikeM3u8(cached.streamUrl)) {
        streamUrl = cached.streamUrl;
        logInfo(`命中播放缓存 ${code}`);
      } else {
        const info = await fetchVideoDetail(code);
        if (info && looksLikeM3u8(info.streamUrl)) {
          streamUrl = info.streamUrl;
          await setCachedJson(cacheKey, { streamUrl }, PLAY_CACHE_TTL);
        }
      }
    }

    if (!streamUrl) throw new Error(`未解析到 m3u8（code=${code}）`);

    const urls = [{ name: "HLS 直连", url: streamUrl }];

    Promise.resolve()
      .then(() => OmniBox.addPlayHistory && OmniBox.addPlayHistory({
        vodId: code,
        title: code.toUpperCase(),
        episode: rawPlayId,
        episodeName: code.toUpperCase(),
        playUrl: streamUrl,
        playHeader: header,
      }))
      .then(() => logInfo(`播放记录写入成功 ${code}`))
      .catch((error) => logInfo(`播放记录写入失败 ${error.message}`));

    logInfo(`play 结果 code=${code} url=${streamUrl.slice(0, 80)}`);
    return {
      urls,
      flag: "Whos在线",
      parse: 0,
      header,
    };
  } catch (error) {
    logError(`play 失败 playId=${rawPlayId.slice(0, 60)}`, error);
    // 兜底：交给客户端嗅探详情页
    const pageUrl = code ? `${HOST}/videos/${code}` : "";
    if (pageUrl) {
      return {
        url: pageUrl,
        urls: [{ name: "页面嗅探", url: pageUrl }],
        flag: "Whos在线",
        parse: 1,
        header,
      };
    }
    return { urls: [], flag: "Whos在线", parse: 0, header };
  }
}
