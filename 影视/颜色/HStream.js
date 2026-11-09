// @name 🔞HStream
// @author OmniBox
// @description 站点：hstream.moe（英文/日文双语标题，HD/4K 英语字幕动漫）。支持首页、分类、详情、搜索、播放；播放走站点 /player/api 会话鉴权，输出 720P 直连 mp4 以及 1080P/2160P DASH 备用线路。
// @dependencies cheerio
// @version 1.2.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/HStream.js

/**
 * ============================================================================
 * hstream.moe OmniBox 源 v1.2.0
 *
 * 站点要点（已实测）：
 * 1. 前台是 Laravel + Livewire：
 *    - 列表/分类/搜索统一走 GET /search?search=&order=&tags[0]=&studios[0]=&page=N
 *    - 详情为 /hentai/{slug}，剧集合集为 /hentai/{seriesSlug}（带 Episodes (n) 区块）
 * 2. 播放必须两次请求：
 *    a) 先拿一次会话：GET / 或 /contact → 收集 set-cookie（XSRF-TOKEN + hstream_session）
 *       同时从页面里取 hidden input[name=_token]
 *    b) POST /player/api  body={"episode_id":"<e_id>","_token":"<token>"}
 *       Cookie 必须带 hstream_session，X-Requested-With 必须为 XMLHttpRequest
 *       → 返回 { title, poster, stream_url, stream_domains[], interpolated, interpolated_uhd, extra_subtitles }
 * 3. e_id 来源：
 *    - 详情页 <input id="e_id" type="hidden" value="2032">
 *    - 搜索页卡片 div[wire:key="episode-2032"]（可直接命中，省一次详情请求）
 * 4. 媒体资源（实测 206 可播）：
 *    - {domain}/{stream_url}/x264.720p.mp4        ← 兼容性最好，主推
 *    - {domain}/{stream_url}/720/manifest.mpd     ← DASH(x264)
 *    - {domain}/{stream_url}/1080|2160/manifest.mpd ← DASH(AV1，部分播放器不支持)
 *    - {domain}/{stream_url}/1080i|2160i/manifest.mpd ← 48fps 插帧档（interpolated 标记）
 *    - 字幕：{domain}/{stream_url}/eng.vtt（其余语言 .vtt 实测 404，故不下发）
 * 5. 部分老片子详情页返回 "Please login to view this hentai!"（无 e_id），
 *    这类页面仍可展示标题/封面/剧集列表，播放时按无 e_id 安全降级。
 * 6. sitemap 里存在历史别名 slug（xxx-r-1），这类页面会被首页模板顶掉，
 *    详情/播放链路会自动尝试等价正规 slug（xxx-1 / xxx）。
 *
 * 网络容错（v1.1.0 起）：
 * - 站点前置 Cloudflare，长连接复用容易被对端 RST（read ECONNRESET）。
 *   这里统一做「宿主请求 -> 短退避重试 -> 原生 https 直连(agent:false)」三级兜底。
 * - HSTREAM_RETRY_TIMES=3        重试次数
 * - HSTREAM_RETRY_DELAY_MS=400   退避基数（第 n 次等待 n*400ms）
 * - HSTREAM_FORCE_NATIVE=1       直接走原生直连，完全绕开宿主连接池/代理层
 * - HSTREAM_NATIVE_FALLBACK=0    关闭原生直连兜底
 * - HSTREAM_MIRRORS=https://a,https://b   备用域名，主域整段失败时按序回退
 * - HSTREAM_PROXY_URL=http://127.0.0.1:7890  出口代理（支持 socks5://，可带用户名密码）
 *   兼容回退 UPSTREAM_HTTP_PROXY_URL / HTTP_PROXY_URL；配置后首个请求即走代理，
 *   因为宿主 SDK 自己并不知道代理配置，继续走它只会重复被 RST。
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

let cheerio;
try {
  cheerio = require("cheerio");
} catch (_) {
  cheerio = null;
}

const crypto = require("crypto");

/* ==========================================================================
 * 基础配置
 * ========================================================================== */

const HOST = String(process.env.HSTREAM_HOST || "https://hstream.moe").replace(/\/+$/, "");
const API_HOST = String(process.env.HSTREAM_API_HOST || HOST).replace(/\/+$/, "");
const UA = String(
  process.env.HSTREAM_USER_AGENT
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
const REQUEST_TIMEOUT = Number(process.env.HSTREAM_TIMEOUT || 25000);
// 可选备用域名（逗号分隔），主域被网络层拦截时按顺序回退
const MIRROR_HOSTS = String(process.env.HSTREAM_MIRRORS || "")
  .split(",")
  .map((item) => item.trim().replace(/\/+$/, ""))
  .filter((item) => /^https?:\/\//i.test(item));

// 页面缓存 TTL（秒）
const HOME_CACHE_TTL = Number(process.env.HSTREAM_HOME_CACHE_TTL || 900);
const LIST_CACHE_TTL = Number(process.env.HSTREAM_LIST_CACHE_TTL || 600);
const DETAIL_CACHE_TTL = Number(process.env.HSTREAM_DETAIL_CACHE_TTL || 3600);
const OPTIONS_CACHE_TTL = Number(process.env.HSTREAM_OPTIONS_CACHE_TTL || 43200);
const PLAY_CACHE_TTL = Number(process.env.HSTREAM_PLAY_CACHE_TTL || 1800);
const SESSION_CACHE_TTL = Number(process.env.HSTREAM_SESSION_CACHE_TTL || 5400);
const EID_CACHE_TTL = Number(process.env.HSTREAM_EID_CACHE_TTL || 86400);

const PAGE_SIZE = 25;

const CACHE_PREFIX = "hstream:";

const ORDER_OPTIONS = [
  { value: "recently-uploaded", label: "最近上传" },
  { value: "recently-released", label: "最近发行" },
  { value: "view-count", label: "观看最多" },
  { value: "az", label: "A-Z" },
  { value: "za", label: "Z-A" },
  { value: "oldest-uploads", label: "最早上传" },
  { value: "oldest-releases", label: "最早发行" },
];

// 首页分类：标签型 / 排序型，与站点前台标签保持一致
const CLASS_LIST = [
  { type_id: "order:recently-uploaded", type_name: "最新上传" },
  { type_id: "order:recently-released", type_name: "最新发行" },
  { type_id: "order:view-count", type_name: "最多观看" },
  { type_id: "tag:4k", type_name: "4K" },
  { type_id: "tag:4k-48fps", type_name: "4K 48FPS" },
  { type_id: "tag:uncensored", type_name: "无修正" },
  { type_id: "tag:3d", type_name: "3D" },
  { type_id: "tag:big-boobs", type_name: "巨乳" },
  { type_id: "tag:school-girl", type_name: "制服" },
  { type_id: "tag:elf", type_name: "精灵" },
  { type_id: "tag:succubus", type_name: "魅魔" },
  { type_id: "tag:ntr", type_name: "NTR" },
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

/* ==========================================================================
 * 通用工具
 * ========================================================================== */

function logInfo(message) {
  try {
    Promise.resolve(OmniBox.log("info", `[hstream] ${message}`)).catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function logError(message, error) {
  const detail = error && error.message ? ` | ${error.message}` : "";
  try {
    Promise.resolve(OmniBox.log("error", `[hstream] ${message}${detail}`)).catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function normalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function shortHash(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex").slice(0, 16);
}

function buildCacheKey(name, ...parts) {
  const raw = parts.filter((p) => p != null && p !== "").join("|");
  const base = `${CACHE_PREFIX}${name}`;
  if (!raw) return base;
  // 宿主缓存 key 有长度限制，统一走 前缀 + 短哈希
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

function absoluteUrl(url, base = `${HOST}/`) {
  const value = String(url == null ? "" : url).trim();
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch (_) {
    if (value.startsWith("/")) return `${HOST}${value}`;
    return value;
  }
}

function getSetCookies(headers = {}) {
  const raw = headers["set-cookie"] || headers["Set-Cookie"] || headers["SET-COOKIE"] || headers["Set-cookie"] || [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    const first = String(item || "").split(";")[0].trim();
    if (!first || first.indexOf("=") <= 0) continue;
    out.push(first);
  }
  return out;
}

function mergeCookiePairs(...groups) {
  const store = {};
  for (const group of groups) {
    const items = Array.isArray(group) ? group : [group];
    for (const item of items) {
      const raw = String(item || "").trim();
      const idx = raw.indexOf("=");
      if (idx <= 0) continue;
      store[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    }
  }
  return Object.entries(store).map(([k, v]) => `${k}=${v}`).join("; ");
}

/* ==========================================================================
 * HTTP 封装
 * ========================================================================== */

// Cloudflare 前置站点在高并发 / 长连接复用场景下会主动 RST，宿主的 axios keep-alive
// 池很容易复用到已被对端关闭的连接，表现就是 read ECONNRESET。
// 这类错误对同一 URL 重试通常立即成功，因此统一做「短退避重试 + Connection: close」。
const RETRYABLE_NET_CODES = [
  "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "EAI_AGAIN",
  "ENOTFOUND", "ECONNREFUSED", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_SOCKET",
];
const NET_RETRY_TIMES = Number(process.env.HSTREAM_RETRY_TIMES || 3);
const NET_RETRY_DELAY = Number(process.env.HSTREAM_RETRY_DELAY_MS || 400);
// 宿主请求池不可用时是否启用原生直连兜底（默认开启；某些受限运行环境可关掉）
const NATIVE_FALLBACK = String(process.env.HSTREAM_NATIVE_FALLBACK || "1") !== "0";
// 1 = 直接走原生直连（宿主连接池/代理层有问题时用），0 = 先宿主再兜底
const FORCE_NATIVE = String(process.env.HSTREAM_FORCE_NATIVE || "0") === "1";

/**
 * 代理：站点被出口链路按域名/SNI 掐断（原生直连也 RST）时，唯一解法是换出口。
 * 优先站点专用变量，其次通用变量，兼容 http(s):// 与 socks5:// 两种协议。
 */
const PROXY_URL = String(
  process.env.HSTREAM_PROXY_URL
  || process.env.UPSTREAM_HTTP_PROXY_URL
  || process.env.HTTP_PROXY_URL
  || "",
).trim();

function isRetryableNetError(error) {
  if (!error) return false;
  const code = String(error.code || "");
  if (RETRYABLE_NET_CODES.indexOf(code) >= 0) return true;
  const message = String(error.message || "");
  return /ECONNRESET|socket hang up|network error|aborted|timeout of|ERR_SOCKET/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOnce(url, options, headers) {
  return OmniBox.request(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    timeout: options.timeout || REQUEST_TIMEOUT,
  });
}

/**
 * 原生 HTTP(S) 直连兜底。
 * 宿主 SDK 底层是 axios + 连接池；遇到 Cloudflare 掐掉的池内死连接时，
 * 只靠 retry 仍可能反复命中同一条坏连接。这里 agent:false 强制每次新建 TCP 连接。
 */
/* --------------------------------------------------------------------------
 * 零依赖代理隧道：HTTP CONNECT + SOCKS5
 * 出口被按域名 RST 时，只能换出口；这两条覆盖 Clash/v2ray 常见本地代理形态。
 * -------------------------------------------------------------------------- */

function parseProxyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (error) {
    logInfo(`代理地址解析失败，忽略代理: ${error.message}`);
    return null;
  }
  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  const defaultPort = protocol === "socks5" || protocol === "socks5h" || protocol === "socks4" ? 1080 : 7890;
  return {
    protocol,
    host: parsed.hostname,
    port: Number(parsed.port || defaultPort),
    auth: parsed.username || parsed.password
      ? {
        username: decodeURIComponent(parsed.username || ""),
        password: decodeURIComponent(parsed.password || ""),
      }
      : null,
    isSocks: protocol.indexOf("socks") === 0,
  };
}

function connectViaHttpProxy(proxy, targetHost, targetPort, timeout) {
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

    socket.on("timeout", () => fail(Object.assign(new Error(`代理连接超时 ${proxy.host}:${proxy.port}`), { code: "ETIMEDOUT" })));
    socket.on("error", (error) => fail(error));
    socket.on("connect", () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
      ];
      if (proxy.auth && proxy.auth.username) {
        const raw = `${proxy.auth.username}:${proxy.auth.password}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(raw).toString("base64")}`);
      }
      lines.push("Proxy-Connection: keep-alive", "", "");
      socket.write(lines.join("\r\n"));
    });

    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
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

function connectViaSocks5(proxy, targetHost, targetPort, timeout) {
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

    socket.on("timeout", () => fail(Object.assign(new Error(`SOCKS5 连接超时 ${proxy.host}:${proxy.port}`), { code: "ETIMEDOUT" })));
    socket.on("error", (error) => fail(error));
    socket.on("connect", () => {
      const withAuth = !!(proxy.auth && proxy.auth.username);
      socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    });

    const onData = (chunk) => {
      if (stage === "greeting") {
        if (chunk[0] !== 0x05) return fail(new Error("SOCKS5 协议版本不匹配"));
        const method = chunk[1];
        if (method === 0x02) {
          const user = Buffer.from(proxy.auth.username, "utf8");
          const pass = Buffer.from(proxy.auth.password, "utf8");
          const authBuf = Buffer.concat([
            Buffer.from([0x01, user.length]), user,
            Buffer.from([pass.length]), pass,
          ]);
          stage = "auth";
          socket.write(authBuf);
          return;
        }
        if (method === 0x00) {
          stage = "connect";
          socket.write(buildSocksConnect(targetHost, targetPort));
          return;
        }
        return fail(new Error(`SOCKS5 不支持认证方式 ${method}`));
      }
      if (stage === "auth") {
        if (chunk[1] !== 0x00) return fail(new Error("SOCKS5 用户名密码认证失败"));
        stage = "connect";
        socket.write(buildSocksConnect(targetHost, targetPort));
        return;
      }
      if (stage === "connect") {
        if (chunk[1] !== 0x00) return fail(new Error(`SOCKS5 连接目标失败 code=${chunk[1]}`));
        socket.removeListener("data", onData);
        settled = true;
        socket.setTimeout(0);
        resolve(socket);
      }
    };

    function buildSocksConnect(host, port) {
      const hostBuf = Buffer.from(host, "utf8");
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      return Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf,
      ]);
    }

    socket.on("data", onData);
  });
}

function connectTunnel(proxy, targetHost, targetPort, timeout) {
  return proxy.isSocks
    ? connectViaSocks5(proxy, targetHost, targetPort, timeout)
    : connectViaHttpProxy(proxy, targetHost, targetPort, timeout);
}

function openRequest(url, options, headers, proxy) {
  const http = require("http");
  const https = require("https");
  const tls = require("tls");
  const requestUrl = new URL(url);
  const isHttps = requestUrl.protocol === "https:";
  const targetHost = requestUrl.hostname;
  const targetPort = Number(requestUrl.port || (isHttps ? 443 : 80));
  const timeout = options.timeout || REQUEST_TIMEOUT;
  const path = `${requestUrl.pathname}${requestUrl.search}`;

  return connectTunnel(proxy, targetHost, targetPort, timeout).then((socket) => {
    const transport = isHttps ? https : http;
    const baseOptions = {
      host: targetHost,
      port: targetPort,
      path,
      method: options.method || "GET",
      headers: Object.assign({}, headers, { Host: requestUrl.host }),
      timeout,
    };
    if (isHttps) {
      // 隧道内再起 TLS，SNI 必须是目标域名
      const secureSocket = tls.connect({ socket, servername: targetHost });
      baseOptions.createConnection = () => secureSocket;
      // https.request 需要 agent:false 才吃 createConnection
      baseOptions.agent = false;
      return transport.request(baseOptions);
    }
    baseOptions.createConnection = () => socket;
    baseOptions.agent = false;
    return transport.request(baseOptions);
  });
}

function requestNative(url, options = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    try {
      requestUrl = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }

    const body = options.body == null ? "" : String(options.body);
    const finalHeaders = Object.assign({}, headers);
    if (body && finalHeaders["Content-Length"] == null && finalHeaders["content-length"] == null) {
      finalHeaders["Content-Length"] = Buffer.byteLength(body);
    }

    const proxy = parseProxyUrl(PROXY_URL);
    const timeout = options.timeout || REQUEST_TIMEOUT;

    const consume = (req) => {
      req.on("timeout", () => {
        const error = new Error(`timeout @ ${url}`);
        error.code = "ETIMEDOUT";
        req.destroy(error);
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    };

    const handleResponse = (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: Number(res.statusCode || 0), headers: res.headers || {}, body: data });
      });
      res.on("error", reject);
    };

    if (proxy) {
      logInfo(`经代理请求 ${requestUrl.host} via ${proxy.protocol}://${proxy.host}:${proxy.port}`);
      openRequest(url, options, finalHeaders, proxy)
        .then((req) => {
          req.on("response", handleResponse);
          consume(req);
        })
        .catch(reject);
      return;
    }

    const transport = requestUrl.protocol === "http:" ? require("http") : require("https");
    const req = transport.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port || (requestUrl.protocol === "http:" ? 80 : 443),
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: options.method || "GET",
      headers: finalHeaders,
      timeout,
      agent: false,
    }, handleResponse);
    consume(req);
  });
}

async function requestWithRetry(url, options, headers) {
  let lastError = null;
  for (let attempt = 1; attempt <= NET_RETRY_TIMES; attempt += 1) {
    // 第 2 次起换原生直连（agent:false），彻底绕开宿主的 keep-alive 连接池
    // 配了代理就直接走原生+代理：宿主 request 并不知道代理配置，走了也是白 RST
    const useNative = NATIVE_FALLBACK && (FORCE_NATIVE || !!PROXY_URL || attempt >= 2);
    try {
      if (useNative) {
        logInfo(`改用原生直连第 ${attempt} 次尝试 ${url}`);
        return await requestNative(url, options, Object.assign({}, headers, { Connection: "close" }));
      }
      return await requestOnce(url, options, headers);
    } catch (error) {
      lastError = error;
      if (!isRetryableNetError(error) || attempt >= NET_RETRY_TIMES) throw error;
      const wait = NET_RETRY_DELAY * attempt;
      logInfo(`网络异常 ${error.code || error.message}，${wait}ms 后第 ${attempt + 1} 次重试 ${url}`);
      await sleep(wait);
    }
  }
  throw lastError || new Error(`请求失败 @ ${url}`);
}

async function httpRequest(url, options = {}, redirectCount = 0) {
  const finalUrl = /^https?:\/\//i.test(url) ? url : absoluteUrl(url);
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    ...(options.headers || {}),
  };

  const res = await requestWithRetry(finalUrl, options, headers);

  const statusCode = Number((res && res.statusCode) || 0);
  const responseHeaders = (res && res.headers) || {};
  const location = responseHeaders.location || responseHeaders.Location || responseHeaders.LOCATION || "";

  if ([301, 302, 303, 307, 308].indexOf(statusCode) >= 0) {
    if (redirectCount >= 4 || !location) {
      throw new Error(`HTTP ${statusCode} 重定向异常 @ ${finalUrl}`);
    }
    const nextUrl = absoluteUrl(location, finalUrl);
    return httpRequest(nextUrl, options, redirectCount + 1);
  }

  return {
    statusCode,
    headers: responseHeaders,
    body: String((res && res.body) || ""),
    url: finalUrl,
    cookies: getSetCookies(responseHeaders),
  };
}

async function fetchHtml(url, { ttl = 0, cacheName = "page", headers } = {}) {
  const cacheKey = ttl > 0 ? buildCacheKey(cacheName, url) : "";
  if (cacheKey) {
    const cached = await getCachedJson(cacheKey);
    if (cached && cached.html) {
      logInfo(`命中页面缓存 ${cacheName} ${url}`);
      return { html: cached.html, url };
    }
  }

  logInfo(`请求页面 ${url}`);
  const attempts = [url];
  for (const mirror of MIRROR_HOSTS) {
    if (url.indexOf(HOST) === 0) attempts.push(url.replace(HOST, mirror));
  }

  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const target = attempts[index];
    try {
      const res = await httpRequest(target, { headers });
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} @ ${target}`);
      if (cacheKey) await setCachedJson(cacheKey, { html: res.body }, ttl);
      if (index > 0) logInfo(`备用域名命中 ${target}`);
      return { html: res.body, url: res.url || target };
    } catch (error) {
      lastError = error;
      if (index < attempts.length - 1) logInfo(`主域失败，尝试备用域名 ${attempts[index + 1]}：${error.message}`);
    }
  }
  throw lastError || new Error(`请求失败 @ ${url}`);
}

/* ==========================================================================
 * 会话（CSRF + Cookie）与 /player/api
 * ========================================================================== */

async function bootstrapSession() {
  logInfo("引导站点会话（cookie + _token）");
  const res = await httpRequest(`${API_HOST}/`, { headers: { Referer: `${HOST}/` } });
  if (res.statusCode !== 200) {
    throw new Error(`会话引导失败 HTTP ${res.statusCode}`);
  }
  const tokenMatch = res.body.match(/name="_token"\s+value="([^"]+)"/i);
  const token = tokenMatch ? tokenMatch[1] : "";
  const cookie = mergeCookiePairs(res.cookies);
  if (!token || !cookie) {
    throw new Error(`会话引导缺少 token(${token ? "ok" : "empty"}) 或 cookie(${cookie ? "ok" : "empty"})`);
  }
  const session = { cookie, token, ts: Date.now() };
  await setCachedJson(buildCacheKey("session"), session, SESSION_CACHE_TTL);
  logInfo(`会话就绪 token=${token.slice(0, 8)}… cookieKeys=${cookie.split(";").map((s) => s.split("=")[0]).join(",")}`);
  return session;
}

async function getSession(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getCachedJson(buildCacheKey("session"));
    if (cached && cached.cookie && cached.token) return cached;
  }
  return bootstrapSession();
}

async function requestPlayerApi(episodeId) {
  const body = JSON.stringify({ episode_id: String(episodeId) });
  let session = await getSession();

  const doPost = async (sess) => httpRequest(`${API_HOST}/player/api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${HOST}/`,
      Origin: HOST,
      Cookie: sess.cookie,
    },
    // 站点要求 CSRF token 放 body：缺 _token 或 cookie 与会话不匹配都会 419
    body: JSON.stringify({ episode_id: String(episodeId), _token: sess.token }),
  });

  let res = await doPost(session);
  if (res.statusCode === 419 || res.statusCode === 401 || res.statusCode === 403) {
    logInfo(`会话失效（HTTP ${res.statusCode}），重建会话后重试 e_id=${episodeId}`);
    session = await bootstrapSession();
    res = await doPost(session);
  }

  if (res.statusCode !== 200) {
    throw new Error(`player/api HTTP ${res.statusCode}: ${res.body.slice(0, 160)}`);
  }

  let data = null;
  try {
    data = JSON.parse(res.body);
  } catch (error) {
    throw new Error(`player/api 返回非 JSON: ${res.body.slice(0, 160)}`);
  }
  if (!data || !data.stream_url) {
    throw new Error(`player/api 缺少 stream_url: ${res.body.slice(0, 160)}`);
  }
  return data;
}

/* ==========================================================================
 * 解析工具
 * ========================================================================== */

function loadCheerio(html) {
  if (!cheerio) throw new Error("缺少 cheerio 依赖");
  return cheerio.load(html);
}

function pickQualityBadge($, node) {
  let text = "";
  node.find("div,span").each((_, el) => {
    if (text) return;
    const cls = String($(el).attr("class") || "");
    if (/bg-black\/70/.test(cls)) {
      const t = normalizeText($(el).text());
      if (t) text = t;
    }
  });
  return text;
}

function pickViews($, node) {
  const icon = node.find("i.fa-eye").first();
  if (!icon.length) return "";
  return normalizeText(icon.parent().text());
}

function pickEidFromNode($, node) {
  let current = node;
  for (let i = 0; i < 5; i += 1) {
    if (!current || !current.length) break;
    const raw = current.attr && current.attr("wire:key");
    if (raw) {
      const match = String(raw).match(/episode-(\d+)/);
      if (match) return match[1];
    }
    const id = current.attr && current.attr("data-episode-id");
    if (id) return String(id);
    current = current.parent();
  }
  return "";
}

function slugFromUrl(url) {
  const match = String(url || "").match(/\/hentai\/([^/?#]+)/i);
  return match ? match[1] : "";
}

function isSeriesSlug(slug) {
  // 站点剧集 slug 不带尾号，单集为 {seriesSlug}-{n}
  return !/-\d+$/.test(String(slug || ""));
}

function prettifySlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((word) => (/^\d+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * 站点存在历史别名 slug（如 sitemap 里的 xxx-r-1），这类页面会被登录门槛整页遮挡。
 * 这里给出「可能等价的正规 slug」候选，供详情/播放链路自动纠正。
 */
function buildAliasCandidates(slug) {
  const value = String(slug || "").trim();
  if (!value) return [];
  const out = [];
  const push = (candidate) => {
    if (candidate && candidate !== value && out.indexOf(candidate) < 0) out.push(candidate);
  };

  // xxx-r-1 -> xxx-1 / xxx
  const rMatch = value.match(/^(.*)-r-(\d+)$/);
  if (rMatch) {
    push(`${rMatch[1]}-${rMatch[2]}`);
    push(rMatch[1]);
  }

  // xxx-1 -> xxx
  const numMatch = value.match(/^(.*)-(\d+)$/);
  if (numMatch) push(numMatch[1]);

  return out;
}

function parseCards(html, { limit = 0 } = {}) {
  const $ = loadCheerio(html);
  const list = [];
  const seen = new Set();

  $('a[href*="/hentai/"]').each((_, el) => {
    const node = $(el);
    const href = node.attr("href") || "";
    const slug = slugFromUrl(href);
    if (!slug) return;

    const img = node.find("img").first();
    const heading = node.find("h3").first();
    const name = normalizeText(heading.text() || img.attr("alt") || "");
    if (!name) return; // 过滤掉「More from」等非卡片链接

    if (seen.has(slug)) return;
    seen.add(slug);

    const pic = img.attr("src") || img.attr("data-src") || img.attr("data-original") || "";
    const eid = pickEidFromNode($, node);
    const badge = pickQualityBadge($, node);
    const views = pickViews($, node);

    list.push({
      vod_id: eid ? `${slug}|${eid}` : slug,
      vod_name: name,
      vod_pic: absoluteUrl(pic),
      vod_remarks: [badge, views].filter(Boolean).join(" · "),
      _slug: slug,
      _eid: eid,
    });

    if (limit && list.length >= limit) return false;
    return undefined;
  });

  return list;
}

function parseLdJson($) {
  let data = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (data) return;
    try {
      const parsed = JSON.parse($(el).text());
      if (parsed && (parsed["@type"] === "VideoObject" || parsed.name)) data = parsed;
    } catch (_) {
      /* ignore */
    }
  });
  return data || {};
}

function extractTagLabels($) {
  const tags = [];
  const seen = new Set();
  $('a[href*="tags%5B0%5D="]').each((_, el) => {
    const href = String($(el).attr("href") || "");
    const match = href.match(/tags%5B0%5D=([^&]+)/i);
    if (!match) return;
    const value = decodeURIComponent(match[1]);
    if (!value || seen.has(value)) return;
    seen.add(value);
    tags.push({ value, label: normalizeText($(el).text()) || value });
  });
  return tags;
}

function extractStudio($) {
  const link = $('a[href*="studios%5B0%5D="]').first();
  if (!link.length) return "";
  const match = String(link.attr("href") || "").match(/studios%5B0%5D=([^&]+)/i);
  const label = normalizeText(link.text());
  if (label) return label;
  return match ? decodeURIComponent(match[1]) : "";
}

function extractDatePills($) {
  const upload = normalizeText($("i.fa-upload").first().parent().text());
  const release = normalizeText($("i.fa-calendar").first().parent().text());
  return { upload, release };
}

function extractEpisodes(html, seriesSlug) {
  const $ = loadCheerio(html);
  const episodes = [];
  const seen = new Set();

  let container = null;
  $("a,div,span,p,h2,h3").each((_, el) => {
    if (container) return;
    const text = normalizeText($(el).text());
    if (/^Episodes\s*\(\d+\)$/i.test(text)) {
      container = $(el).parent();
    }
  });

  const scopes = container && container.length ? [container] : [$("body")];
  for (const scope of scopes) {
    scope.find('a[href*="/hentai/"]').each((_, el) => {
      const node = $(el);
      const href = node.attr("href") || "";
      const slug = slugFromUrl(href);
      if (!slug || seen.has(slug)) return;

      const heading = node.find("h3").first();
      const img = node.find("img").first();
      const rawName = normalizeText(heading.text() || img.attr("alt") || "");
      if (!rawName) return;

      // 只在剧集合集页（slug 无尾号）时按前缀过滤，避免混入推荐卡片
      if (seriesSlug && isSeriesSlug(seriesSlug) && !slug.startsWith(`${seriesSlug}-`)) return;

      seen.add(slug);
      const eid = pickEidFromNode($, node);
      const numMatch = rawName.match(/-\s*(\d+(?:\.\d+)?)\s*$/);
      const number = numMatch ? numMatch[1] : "";
      episodes.push({
        name: number ? `第${number}集` : rawName,
        playId: eid ? `${slug}|${eid}` : slug,
        _slug: slug,
        _eid: eid,
        _rawName: rawName,
        _pic: absoluteUrl(img.attr("src") || img.attr("data-src") || ""),
      });
    });
    if (episodes.length) break;
  }

  return episodes;
}

/* ==========================================================================
 * 详情页解析
 * ========================================================================== */

function parseDetailHtml(slug, html) {
  const $ = loadCheerio(html);
  const ld = parseLdJson($);

  const gated = /Please login to view this hentai/i.test(html);
  const eidMatch = html.match(/id="e_id"[^>]*value="(\d+)"/i);
  const eid = eidMatch ? eidMatch[1] : "";

  const titleLink = $("h1 a").first();
  const seriesHref = titleLink.length ? titleLink.attr("href") || "" : "";
  const seriesSlug = slugFromUrl(seriesHref);

  const title = normalizeText(titleLink.text() || $("h1").first().text() || ld.name || "");
  const jpTitle = normalizeText($("h1").first().parent().find("p").first().text());
  const poster = absoluteUrl(
    $('meta[property="og:image"]').attr("content")
    || $('img[src*="/cover-"]').first().attr("src")
    || ld.thumbnailUrl
    || "",
  );

  const tags = extractTagLabels($);
  const studio = extractStudio($);
  const dates = extractDatePills($);
  const views = normalizeText($("i.fa-eye").first().parent().text());
  const likes = normalizeText($("i.fa-heart").first().parent().text());
  const comments = normalizeText($("i.fa-comment").first().parent().text());

  const description = normalizeText(
    ld.description
    || $('meta[property="og:description"]').attr("content")
    || $('meta[name="description"]').attr("content")
    || "",
  );

  const genre = Array.isArray(ld.genre) ? ld.genre.map((g) => normalizeText(g)).filter(Boolean) : [];

  const isEpisodePage = !!eid || /\sEpisode\s+\d+\s/i.test(html.slice(0, 4000));

  // 站点对「存在但被登录墙整页遮挡 / 已下架」的历史别名，会直接回首页模板：
  // 表现为 og:title 变成站点默认标题、h1 缺失、没有 e_id。
  const ogTitle = normalizeText($('meta[property="og:title"]').attr("content"));
  const isDefaultPage = /English Subbed Hentai Online/i.test(ogTitle)
    || (!eid && !$("h1").length && !seriesSlug && !tags.length);
  const isDefaultTitle = !title || /English Subbed Hentai Online/i.test(title);

  const parsed = {
    slug,
    ogTitle,
    isDefaultPage,
    url: `${HOST}/hentai/${slug}`,
    gated,
    eid,
    isEpisodePage,
    seriesSlug: seriesSlug && seriesSlug !== slug ? seriesSlug : (isEpisodePage ? "" : slug),
    // 登录墙 / 默认模板页面没有 h1，标题退化为 slug，此时用 slug 转可读名兜底
    title: isDefaultTitle ? prettifySlug(slug) : (title || prettifySlug(slug)),
    jpTitle,
    poster,
    description,
    tags,
    genre,
    studio,
    uploadDate: dates.upload,
    releaseDate: dates.release,
    views,
    likes,
    comments,
    year: (String(ld.uploadDate || "").match(/(\d{4})/) || [])[1] || "",
    fetchedAt: Date.now(),
  };

  return parsed;
}

async function getDetailParsed(slug) {
  const cacheKey = buildCacheKey("detail", slug);
  const cached = await getCachedJson(cacheKey);
  if (cached && cached.slug) {
    logInfo(`命中详情缓存 ${slug}`);
    return cached;
  }

  const url = `${HOST}/hentai/${slug}`;
  const { html } = await fetchHtml(url, { ttl: DETAIL_CACHE_TTL, cacheName: "detail" });
  let parsed = parseDetailHtml(slug, html);

  // 宿主的 sitemap 里存在历史别名 slug（如 xxx-r-1），这类页面会被登录门槛整页遮挡：
  // 标题退化成站点默认标题、且没有 e_id。此时自动尝试等价正规 slug。
  const looksLikeDefaultPage = !parsed.eid && (parsed.isDefaultPage || !parsed.tags.length);
  if (looksLikeDefaultPage) {
    for (const candidate of buildAliasCandidates(slug)) {
      try {
        logInfo(`详情疑似历史别名，尝试纠正 slug ${slug} -> ${candidate}`);
        const alt = await fetchHtml(`${HOST}/hentai/${candidate}`, {
          ttl: DETAIL_CACHE_TTL,
          cacheName: "detail",
        });
        const altParsed = parseDetailHtml(candidate, alt.html);
        if (altParsed.eid || (!altParsed.isDefaultPage && altParsed.tags.length)) {
          parsed = Object.assign(altParsed, { aliasFrom: slug });
          break;
        }
      } catch (error) {
        logInfo(`别名纠正失败 ${candidate}: ${error.message}`);
      }
    }
  }

  await setCachedJson(cacheKey, parsed, DETAIL_CACHE_TTL);
  logInfo(
    `详情解析 ${slug} title=${parsed.title} eid=${parsed.eid || "-"} gated=${parsed.gated ? 1 : 0}`
    + ` series=${parsed.seriesSlug || "-"} tags=${parsed.tags.length}`
    + (parsed.aliasFrom ? ` aliasFrom=${parsed.aliasFrom}` : ""),
  );
  return parsed;
}

async function getSeriesEpisodes(seriesSlug) {
  if (!seriesSlug) return [];
  const cacheKey = buildCacheKey("episodes", seriesSlug);
  const cached = await getCachedJson(cacheKey);
  if (cached && Array.isArray(cached.episodes)) {
    logInfo(`命中剧集缓存 ${seriesSlug} -> ${cached.episodes.length}`);
    return cached.episodes;
  }

  const { html } = await fetchHtml(`${HOST}/hentai/${seriesSlug}`, {
    ttl: DETAIL_CACHE_TTL,
    cacheName: "series",
  });
  const episodes = extractEpisodes(html, seriesSlug);
  await setCachedJson(cacheKey, { episodes }, DETAIL_CACHE_TTL);
  logInfo(`剧集解析 ${seriesSlug} -> ${episodes.length}`);
  return episodes;
}

/* ==========================================================================
 * 分类 / 搜索 URL 构建
 * ========================================================================== */

function buildSearchUrl({ keyword = "", order = "recently-uploaded", tags = [], studio = "", page = 1 } = {}) {
  const parts = [];
  const safeOrder = ORDER_OPTIONS.some((o) => o.value === order) ? order : "recently-uploaded";
  parts.push(`order=${encodeURIComponent(safeOrder)}`);
  if (keyword) parts.push(`search=${encodeURIComponent(keyword)}`);
  const tagList = (Array.isArray(tags) ? tags : [tags]).map((t) => String(t || "").trim()).filter(Boolean);
  tagList.forEach((tag, index) => {
    parts.push(`tags%5B${index}%5D=${encodeURIComponent(tag)}`);
  });
  if (studio) parts.push(`studios%5B0%5D=${encodeURIComponent(studio)}`);
  const pageNum = Number(page) || 1;
  if (pageNum > 1) parts.push(`page=${pageNum}`);
  return `${HOST}/search?${parts.join("&")}`;
}

function resolveCategoryQuery(categoryId, filters = {}) {
  const cid = String(categoryId || "order:recently-uploaded");
  let order = "recently-uploaded";
  let tags = [];

  if (cid.startsWith("tag:")) tags = [cid.slice(4)];
  else if (cid.startsWith("order:")) order = cid.slice(6);
  else if (cid.startsWith("studio:")) order = "recently-uploaded";

  let studio = cid.startsWith("studio:") ? cid.slice(7) : "";

  if (filters && typeof filters === "object") {
    if (filters.order) order = String(filters.order);
    if (filters.tags) {
      const value = Array.isArray(filters.tags) ? filters.tags : [filters.tags];
      const cleaned = value.map((v) => String(v || "").trim()).filter(Boolean);
      if (cleaned.length) tags = cleaned;
    }
    if (filters.tag) {
      const cleaned = String(filters.tag || "").trim();
      if (cleaned) tags = [cleaned];
    }
    if (filters.studio) studio = String(filters.studio);
  }

  return { order, tags, studio };
}

async function getSearchOptions() {
  const cacheKey = buildCacheKey("options");
  const cached = await getCachedJson(cacheKey);
  if (cached && cached.tags && cached.tags.length) return cached;

  const fallback = {
    tags: [
      { value: "4k", label: "4K" },
      { value: "4k-48fps", label: "4K 48FPS" },
      { value: "uncensored", label: "Uncensored" },
      { value: "censored", label: "Censored" },
      { value: "3d", label: "3D" },
      { value: "big-boobs", label: "Big Boobs" },
      { value: "school-girl", label: "School Girl" },
      { value: "elf", label: "Elf" },
      { value: "succubus", label: "Succubus" },
      { value: "ntr", label: "NTR" },
    ],
    studios: [],
  };

  try {
    const { html } = await fetchHtml(`${HOST}/search`, { ttl: OPTIONS_CACHE_TTL, cacheName: "options" });
    const $ = loadCheerio(html);
    const tags = [];
    const seenTag = new Set();
    $('input[name="tags[]"]').each((_, el) => {
      const value = String($(el).attr("value") || "").trim();
      if (!value || seenTag.has(value)) return;
      seenTag.add(value);
      const label = normalizeText($(`label[for="tags-${value}"]`).first().text()) || value;
      tags.push({ value, label });
    });

    const studios = [];
    const seenStudio = new Set();
    $('input[name="studios[]"]').each((_, el) => {
      const value = String($(el).attr("value") || "").trim();
      if (!value || seenStudio.has(value)) return;
      seenStudio.add(value);
      const label = normalizeText($(`label[for="studios-${value}"]`).first().text()) || value;
      studios.push({ value, label });
    });

    const result = {
      tags: tags.length ? tags : fallback.tags,
      studios,
    };
    await setCachedJson(cacheKey, result, OPTIONS_CACHE_TTL);
    logInfo(`筛选项解析 tags=${result.tags.length} studios=${result.studios.length}`);
    return result;
  } catch (error) {
    logError("筛选项解析失败，使用内置兜底", error);
    return fallback;
  }
}

function buildFilters(options) {
  const tagValues = [{ name: "全部", value: "" }].concat(
    (options.tags || []).map((t) => ({ name: t.label, value: t.value })),
  );
  const studioValues = [{ name: "全部", value: "" }].concat(
    (options.studios || []).map((s) => ({ name: s.label, value: s.value })),
  );
  const orderValues = ORDER_OPTIONS.map((o) => ({ name: o.label, value: o.value }));

  const filters = {};
  for (const item of CLASS_LIST) {
    filters[item.type_id] = [
      { key: "order", name: "排序", value: orderValues },
      { key: "tags", name: "标签", value: tagValues },
      { key: "studio", name: "制作会社", value: studioValues },
    ];
  }
  return filters;
}

/* ==========================================================================
 * 五个 handler
 * ========================================================================== */

function toVodList(items) {
  return (items || []).map((item) => ({
    vod_id: item.vod_id,
    vod_name: item.vod_name,
    vod_pic: item.vod_pic,
    vod_remarks: item.vod_remarks || "",
  }));
}

async function home(params, context) {
  logInfo(`home 入口 from=${(context && context.from) || "web"}`);
  try {
    const { html } = await fetchHtml(`${HOST}/`, { ttl: HOME_CACHE_TTL, cacheName: "home" });
    const list = parseCards(html, { limit: 80 });
    if (list.length) await setCachedJson(buildCacheKey("home", "last"), { list }, 604800);
    const options = await getSearchOptions();
    logInfo(`home 结果 list=${list.length}`);
    return {
      class: CLASS_LIST,
      filters: buildFilters(options),
      list: toVodList(list),
    };
  } catch (error) {
    // 带 code 便于判断是网络层（ECONNRESET/ETIMEDOUT）还是站点层（401/403/5xx）
    logError(`home 失败 code=${error && error.code ? error.code : "-"}`, error);
    // 站点侧网络抖动时，回退到最近 7 天内成功抓到的首页快照
    const last = await getCachedJson(buildCacheKey("home", "last"));
    if (last && Array.isArray(last.list) && last.list.length) {
      logInfo(`home 回退到历史快照 list=${last.list.length}`);
      return { class: CLASS_LIST, list: toVodList(last.list) };
    }
    return { class: CLASS_LIST, list: [] };
  }
}

async function category(params, context) {
  const categoryId = String((params && params.categoryId) || "order:recently-uploaded");
  const page = Math.max(1, Number((params && params.page) || 1) || 1);
  const filters = (params && (params.filters || params.extend || params.ext || params.filter)) || {};
  logInfo(`category 入口 categoryId=${categoryId} page=${page} filters=${JSON.stringify(filters)} from=${(context && context.from) || "web"}`);

  try {
    const query = resolveCategoryQuery(categoryId, filters);
    const url = buildSearchUrl({ order: query.order, tags: query.tags, studio: query.studio, page });
    logInfo(`category 请求 URL ${url}`);

    const cacheKey = buildCacheKey("list", url);
    let list = null;
    const cached = await getCachedJson(cacheKey);
    if (cached && Array.isArray(cached.list)) {
      list = cached.list;
      logInfo(`category 命中缓存 ${list.length}`);
    } else {
      const { html } = await fetchHtml(url, { ttl: LIST_CACHE_TTL, cacheName: "list" });
      list = parseCards(html);
      await setCachedJson(cacheKey, { list }, LIST_CACHE_TTL);
    }

    const pagecount = list.length >= PAGE_SIZE ? page + 1 : page;
    logInfo(`category 结果 list=${list.length} pagecount=${pagecount}`);
    return {
      page,
      pagecount,
      total: pagecount * PAGE_SIZE,
      list: toVodList(list),
    };
  } catch (error) {
    logError(`category 失败 categoryId=${categoryId} page=${page} code=${error && error.code ? error.code : "-"}`, error);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  const rawId = String((params && params.videoId) || "");
  logInfo(`detail 入口 videoId=${rawId} from=${(context && context.from) || "web"}`);
  if (!rawId) return { list: [] };

  const [slugPart, eidPart] = rawId.split("|");
  const slug = slugFromUrl(slugPart) || slugPart.trim();
  if (!slug) return { list: [] };

  try {
    const info = await getDetailParsed(slug);
    let episodes = [];

    const seriesSlug = info.seriesSlug || (info.isEpisodePage ? "" : slug);
    if (seriesSlug) {
      episodes = await getSeriesEpisodes(seriesSlug);
    }

    if (!episodes.length) {
      episodes = [{
        name: info.isEpisodePage ? "第1集" : "正片",
        playId: info.eid ? `${slug}|${info.eid}` : (eidPart ? `${slug}|${eidPart}` : slug),
      }];
    }

    // 如果当前详情就是其中一集，把播放顺序上调到该集，方便宿主定位
    if (eidPart) {
      const idx = episodes.findIndex((ep) => ep.playId.endsWith(`|${eidPart}`));
      if (idx > 0) logInfo(`当前集在列表第 ${idx + 1} 位 slug=${slug} eid=${eidPart}`);
    }

    const typeName = (info.genre.length ? info.genre : info.tags.map((t) => t.label)).join(" / ");

    // 剧集合集页没有 ld+json，年份从页面的上传/发行日期胶囊兜底
    const yearFromDate = (String(info.uploadDate || info.releaseDate || "").match(/(\d{4})/) || [])[1] || "";
    const remarkParts = [
      episodes.length > 1 ? `全${episodes.length}集` : "",
      info.gated ? "需登录" : "",
      info.views ? `观看${info.views}` : "",
    ].filter(Boolean);

    const vod = {
      vod_id: eidPart ? `${slug}|${eidPart}` : slug,
      vod_name: info.title,
      vod_pic: info.poster,
      vod_content: info.description || [info.jpTitle, info.studio].filter(Boolean).join(" · "),
      vod_year: info.year || yearFromDate,
      vod_area: "日本",
      vod_lang: "英语字幕",
      vod_remarks: remarkParts.join(" · "),
      type_name: typeName || "里番",
      vod_actor: "",
      vod_director: info.studio ? `制作：${info.studio}` : "",
      vod_play_sources: [
        {
          name: "HStream",
          episodes: episodes.map((ep) => ({
            name: ep.name,
            playId: ep.playId,
            episodeName: ep._rawName || ep.name,
            episodeStillPath: ep._pic || undefined,
          })),
        },
      ],
    };

    // 兼容老展示链路：某些端只看 vod_play_from / vod_play_url
    vod.vod_play_from = "HStream";
    vod.vod_play_url = episodes
      .map((ep) => `${ep.name}$${ep.playId}`)
      .join("#");

    logInfo(`detail 结果 name=${vod.vod_name} episodes=${episodes.length} type=${vod.type_name} gated=${info.gated ? 1 : 0}`);
    return { list: [vod] };
  } catch (error) {
    logError(`detail 失败 videoId=${rawId}`, error);
    return { list: [] };
  }
}

async function search(params, context) {
  const keywordRaw = String((params && (params.keyword || params.wd || params.key)) || "").trim();
  const page = Math.max(1, Number((params && params.page) || 1) || 1);
  logInfo(`search 入口 keyword=${keywordRaw} page=${page} from=${(context && context.from) || "web"}`);
  if (!keywordRaw) return { page, pagecount: 0, total: 0, list: [] };

  try {
    const url = buildSearchUrl({ keyword: keywordRaw, page });
    logInfo(`search 请求 URL ${url}`);

    const cacheKey = buildCacheKey("search", url);
    let list = null;
    const cached = await getCachedJson(cacheKey);
    if (cached && Array.isArray(cached.list)) {
      list = cached.list;
      logInfo(`search 命中缓存 ${list.length}`);
    } else {
      const { html } = await fetchHtml(url, { ttl: LIST_CACHE_TTL, cacheName: "search" });
      list = parseCards(html);
      await setCachedJson(cacheKey, { list }, LIST_CACHE_TTL);
    }

    const pagecount = list.length >= PAGE_SIZE ? page + 1 : page;
    logInfo(`search 结果 keyword=${keywordRaw} list=${list.length} pagecount=${pagecount}`);
    return {
      page,
      pagecount,
      total: pagecount * PAGE_SIZE,
      list: toVodList(list),
    };
  } catch (error) {
    logError(`search 失败 keyword=${keywordRaw}`, error);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

/* ==========================================================================
 * 播放
 * ========================================================================== */

async function resolveEid(slug) {
  const cacheKey = buildCacheKey("eid", slug);
  const cached = await getCachedJson(cacheKey);
  if (cached && cached.eid) return cached.eid;

  // 走完整详情解析，这样历史别名 slug（xxx-r-1）也能被自动纠正后拿到 e_id
  const info = await getDetailParsed(slug);
  const eid = (info && info.eid) || "";
  if (!eid) return "";
  await setCachedJson(cacheKey, { eid }, EID_CACHE_TTL);
  logInfo(`解析 e_id 成功 slug=${slug} -> ${info.slug} eid=${eid}`);
  return eid;
}

async function probeMedia(url) {
  const headers = {
    "User-Agent": UA,
    Range: "bytes=0-1",
    Referer: `${HOST}/`,
  };
  try {
    const res = await requestWithRetry(url, { method: "GET", timeout: 12000 }, headers);
    const code = Number((res && res.statusCode) || 0);
    return code === 200 || code === 206;
  } catch (error) {
    logInfo(`媒体探测异常 ${url}: ${error.code || error.message}`);
    return false;
  }
}

function buildMediaCandidates(domain, streamUrl, data) {
  const base = `${String(domain).replace(/\/+$/, "")}/${String(streamUrl).replace(/^\/+/, "")}`;
  const candidates = [
    { name: "720P 直连", url: `${base}/x264.720p.mp4`, kind: "mp4" },
    { name: "720P DASH", url: `${base}/720/manifest.mpd`, kind: "mpd" },
    { name: "1080P DASH", url: `${base}/1080/manifest.mpd`, kind: "mpd" },
    { name: "2160P DASH", url: `${base}/2160/manifest.mpd`, kind: "mpd" },
  ];
  if (Number(data && data.interpolated) === 1) {
    candidates.push({ name: "1080P 48fps DASH", url: `${base}/1080i/manifest.mpd`, kind: "mpd" });
  }
  if (Number(data && data.interpolated_uhd) === 1) {
    candidates.push({ name: "2160P 48fps DASH", url: `${base}/2160i/manifest.mpd`, kind: "mpd" });
  }
  return candidates;
}

async function buildPlayUrls(data, { mp4Only = false } = {}) {
  const domains = []
    .concat(Array.isArray(data.stream_domains) ? data.stream_domains : [])
    .concat(Array.isArray(data.asia_stream_domains) ? data.asia_stream_domains : [])
    .filter(Boolean);

  if (!domains.length) throw new Error("player/api 未返回可用 media 域名");

  for (const domain of domains.slice(0, 3)) {
    const candidates = buildMediaCandidates(domain, data.stream_url, data);
    const checks = await Promise.allSettled(candidates.map((item) => probeMedia(item.url)));
    const alive = [];
    checks.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) alive.push(candidates[index]);
    });

    if (alive.length) {
      // mp4 优先（兼容性最好），DASH 作为补充
      alive.sort((a, b) => (a.kind === "mp4" ? -1 : b.kind === "mp4" ? 1 : 0));
      const picked = mp4Only ? alive.filter((item) => item.kind === "mp4") : alive;
      const finalList = picked.length ? picked : alive.slice(0, 1);
      logInfo(`媒体域名可用 ${domain} 可用线路=${finalList.map((i) => i.name).join("/")}`);
      return finalList.map((item) => ({ name: item.name, url: item.url }));
    }
    logInfo(`媒体域名不可用，尝试下一个 ${domain}`);
  }

  // 全部探测失败时仍然给出主线路，避免播放器完全没有输入
  const fallbackCandidates = buildMediaCandidates(domains[0], data.stream_url, data);
  const fallback = (mp4Only ? fallbackCandidates.filter((i) => i.kind === "mp4") : fallbackCandidates).slice(0, 2);
  logInfo("媒体探测全部失败，回退默认线路");
  return fallback.map((item) => ({ name: item.name, url: item.url }));
}

async function play(params, context) {
  const rawPlayId = String((params && params.playId) || (params && params.id) || "");
  logInfo(`play 入口 playId=${rawPlayId} from=${(context && context.from) || "web"}`);
  if (!rawPlayId) return { urls: [], flag: "HStream", parse: 0, header: {} };

  const [slugPart, eidPart] = rawPlayId.split("|");
  const slug = slugFromUrl(slugPart) || slugPart.trim();

  // web 端走宿主代理播放，header 可能不可靠；TVBox/UZ 端则依赖 Referer 通过 CDN 校验
  const clientFrom = String((context && context.from) || "web");
  const header = {
    "User-Agent": UA,
    Referer: `${HOST}/`,
    Origin: HOST,
  };
  if (clientFrom === "tvbox" || clientFrom === "uz" || clientFrom === "catvod") {
    header.Accept = "*/*";
  }

  try {
    let eid = (eidPart || "").trim();
    if (!eid && slug) {
      eid = await resolveEid(slug);
    }
    if (!eid) {
      throw new Error(`未取到 episode_id（可能是登录可见页面） slug=${slug}`);
    }

    const cacheKey = buildCacheKey("play", eid);
    let data = await getCachedJson(cacheKey);
    if (data && data.stream_url) {
      logInfo(`命中播放缓存 eid=${eid}`);
    } else {
      logInfo(`请求 player/api eid=${eid} slug=${slug}`);
      data = await requestPlayerApi(eid);
      await setCachedJson(cacheKey, data, PLAY_CACHE_TTL);
    }

    // 站点对 DMCA 下架集仍会返回 200 + stream_url="stuff/dmca"，媒体是占位视频
    if (/dmca/i.test(String(data.stream_url || ""))) {
      logInfo(`提示：eid=${eid} 命中站点 DMCA 占位资源（片源已下架），仍返回占位线路`);
    }

    // TVBox / UZ / CatVod 端普遍不支持 DASH(manifest.mpd)，这类端只下发 mp4
    const mp4Only = ["tvbox", "uz", "catvod"].indexOf(clientFrom) >= 0;
    const urls = await buildPlayUrls(data, { mp4Only });
    if (!urls.length) throw new Error("未解析到可播地址");

    const flag = "HStream";
    const firstUrl = urls[0].url;
    const epName = `${data.title || slug || "HStream"}`;

    // 播放记录与媒体信息不阻塞启播
    Promise.resolve()
      .then(() => OmniBox.addPlayHistory && OmniBox.addPlayHistory({
        vodId: slug || String(eid),
        title: data.title || slug || "HStream",
        episode: rawPlayId,
        episodeName: epName,
        pic: absoluteUrl(data.poster || ""),
        playUrl: firstUrl,
        playHeader: header,
      }))
      .then((added) => {
        if (added === false) logInfo(`播放记录已存在或未写入 eid=${eid}`);
        else logInfo(`播放记录写入成功 eid=${eid}`);
      })
      .catch((error) => logInfo(`播放记录写入失败 ${error.message}`));

    Promise.resolve()
      .then(() => OmniBox.getVideoMediaInfo && OmniBox.getVideoMediaInfo(firstUrl, header))
      .then((info) => {
        if (!info) return;
        const duration = Number((info.format && info.format.duration) || 0);
        logInfo(`媒体信息 eid=${eid} duration=${duration || "-"} size=${(info.format && info.format.size) || "-"}`);
      })
      .catch((error) => logInfo(`媒体信息获取失败 ${error.message}`));

    logInfo(`play 结果 eid=${eid} urls=${urls.length} first=${urls[0].name} ${firstUrl}`);
    return {
      urls,
      flag,
      parse: 0,
      header,
    };
  } catch (error) {
    logError(`play 失败 playId=${rawPlayId}`, error);
    const notFound = /HTTP 404/.test(String((error && error.message) || ""));
    const pageUrl = slug && !notFound ? `${HOST}/hentai/${slug}` : "";
    // 兜底：交给客户端嗅探详情页（页面上才有完整播放器初始化逻辑）
    if (pageUrl) {
      return {
        url: pageUrl,
        urls: [{ name: "页面嗅探", url: pageUrl }],
        flag: "HStream",
        parse: 1,
        header,
      };
    }
    return { urls: [], flag: "HStream", parse: 0, header };
  }
}
