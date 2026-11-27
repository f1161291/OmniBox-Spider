// @name 洛雪TV
// @author OmniBox
// @description 站点：tv.lxyy.club（洛雪TV）。v2.1.0 对齐官网真实菜单分类：主分类改为官网侧边栏影视浏览项「电影/剧集/动漫」（官网叫剧集不叫电视剧）；电影/剧集/动漫的二级 tab 接入官网 catalog-categories.js 的 37 个真实目录分类（TMDB discover 参数完全对齐，多国家用 | 分隔）；榜单改为官网 category-tabs 的夸克/TMDB趋势/B站/奈飞四类（去「榜」字，夸克补「短剧」频道）；采集源补齐 md 魔都 / fy 官方源共 8 个；适配 trend/netflix 接口自带 TMDB id 直走 tm| 详情。v2.0.5 修复直链 m3u8 点了转圈：jimaoys 系 .m3u8 是「假 master」（单个 BANDWIDTH 变体指向带动态 session 的相对路径子列表），部分播放器卡在解析变体阶段转圈。服务端新增 expandMasterM3u8()：GET master 展开一层，直接返回绝对 session 子 m3u8 URL（内容为绝对 ts），播放器一步到位。实测 play 返回 ?session= 绝对直链。v2.0.4 修复 MPV 等外部播放器 "unrecognized file format"：平台播放页（如 svip.qlplayer.cyou/?url=…）是 HTML，MPV 当媒体打开必然失败。新增跨源直链兜底 findDirectFallback()：嗅探失败后按剧名搜 jl/mj/360zy 等源，取其 jlm3u8 线路的 .m3u8 直链 parse:0 返回，实测凡人修仙传 mgtv 播放页成功返回 jimaoys92.com 的 m3u8。v2.0.3 修复集数列表出现 "jlm3u8"：站点 jl 源有 jlm3u8/jlplayer 两个线路分组，旧版把它们合并成一条线路并把 group 名拼进每集名（"jlm3u8 第N集"）。改为按 group 拆成多条 vod_play_source，线路名体现在线路名/vod_play_from，分集名统一「第N集」不再带线路前缀。实测 jl 源拆成 jlm3u8(25集直链)/jlplayer(25集) 两条线路，jlm3u8 首集 parse:0 直链可播。v2.0.2：分集名纯数字补「第N集」、playId 精简、嗅探 Referer 按域名生成。v2.0.1 修复视频加载失败：平台播放页/解析页原先只返回 parse=1，改为先用 OmniBox.sniffVideo 嗅探真实媒体地址，命中即 parse:0 直链返回。主链路走站点自带采集站代理 /api/proxy.php，支持多源搜索、详情分集与在线播放解析；TMDB 元数据（榜单/发现）作为补充。盘搜与 PanCheck 环境变量与 影视/网盘/盘搜.js 完全统一（PANSOU_*/PANCHECK_*）。
// @version 2.1.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/影视库/洛雪TV.js

/**
 * ============================================================================
 * tv.lxyy.club OmniBox 源 v2.0.0
 *
 * ⚠️ v1.x 方向不全：当时只看到 TMDB 代理和「盘搜」，漏掉了站点真正的播放主链路
 *    —— /api/proxy.php（采集站聚合代理）。v2.0.0 以此为骨架重写。
 *
 * 站点实测要点（2026-11）：
 *
 * 1.【主链路】采集站代理 /api/proxy.php（GET，无需鉴权、无需人机验证）
 *      ?action=config                                站点配置 + sources 源清单
 *      ?action=search&wd=<关键词>&page=<n>           多源聚合搜索（实测一次 40+ 条）
 *      ?action=detail&id=<id>&source=<source>        详情 + 分集 episodes
 *    search  → { success, results:[{id,name,source,source_name,type,pic,remarks,year}],
 *                sources:{key:name} }
 *    detail  → { success, details:[{ name,pic,type,year,area,lang,actor,director,
 *                content,remarks,player_api,episodes:[{group,episodes:[{name,url}]}],
 *                play_url }] }
 *    episodes[].url 是**平台播放页**（B站/爱奇艺/腾讯…），
 *    player_api 是站点解析入口（如 https://svip.qlplayer.cyou/?url=）。
 *    → 这才是能真正播的链路。
 *
 * 2. TMDB 代理 /api/tmdb.php?path=<tmdb path>（白名单）
 *      ✅ movie/{id} tv/{id} tv/{id}/season/{n} person/{id}
 *      ✅ discover/movie discover/tv search/multi trending/movie/day
 *      ❌ movie/popular credits videos genre/* search/movie
 *
 * 3. 榜单接口（免验证）：/api/quark-ranking.php?channel=电视剧|电影|综艺|动漫
 *
 * 4. 盘搜（可选增强，与仓库 影视/网盘/盘搜.js 同协议）
 *    站点自带盘搜受 Cloudflare Turnstile 保护，服务端无法自动过；
 *    配置 PANSOU_API 后可额外补网盘线路。
 *
 * 5. 环境变量
 *    站点： LXYY_HOST / LXYY_TIMEOUT / LXYY_HOME_KEYWORD / LXYY_PROXY_URL
 *    盘搜： PANSOU_* / PANCHECK_* / DRIVE_ORDER / DRIVE_TYPE_CONFIG /
 *           SOURCE_NAMES_CONFIG / EXTERNAL_SERVER_PROXY_ENABLED
 *    代理： UPSTREAM_HTTP_PROXY_URL / HTTP_PROXY_URL
 * ============================================================================
 */

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  OmniBox = {
    log() { /* 无 SDK 时静默，绝不写 stdout */ },
    async request() { throw new Error("omnibox_sdk 不可用"); },
    async getCache() { return null; },
    async setCache() {},
    async deleteCache() {},
    async sniffVideo() { return null; },
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

const HOST = String(process.env.LXYY_HOST || "https://tv.lxyy.club").replace(/\/+$/, "");
const TMDB_PATH = String(process.env.LXYY_TMDB_PATH || "/api/tmdb.php?path=");
const IMG_BASE = String(process.env.LXYY_IMG_BASE || "https://image.tmdb.org/t/p").replace(/\/+$/, "");
const DEFAULT_LANG = String(process.env.LXYY_LANG || "zh-CN");
const UA = String(
  process.env.LXYY_UA
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
const REQUEST_TIMEOUT = Number(process.env.LXYY_TIMEOUT || 20000);
// 首页/源分类使用的主搜索词（采集站没有"热门列表"接口，用关键词聚合代替）
const HOME_KEYWORD = String(process.env.LXYY_HOME_KEYWORD || "热门").trim();

function splitConfigList(value) {
  return String(value || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function normalizeFilterConfig(raw) {
  const fallback = { include: [], exclude: [] };
  if (!raw) return fallback;
  const obj = typeof raw === "object" ? raw : (() => {
    try { return JSON.parse(String(raw)); } catch (_) { return null; }
  })();
  if (!obj) return fallback;
  return {
    include: Array.isArray(obj.include) ? obj.include.filter(Boolean) : [],
    exclude: Array.isArray(obj.exclude) ? obj.exclude.filter(Boolean) : [],
  };
}

/* --- 盘搜（与 影视/网盘/盘搜.js 同名同义） --- */
const PANSOU_API = String(process.env.PANSOU_API || "").trim().replace(/\/+$/, "");
const PANSOU_CHANNELS = String(process.env.PANSOU_CHANNELS || "").trim();
const PANSOU_PLUGINS = String(process.env.PANSOU_PLUGINS || "").trim();
const PANSOU_CLOUD_TYPES = splitConfigList(process.env.PANSOU_CLOUD_TYPES || "");
const PANSOU_FILTER = normalizeFilterConfig(process.env.PANSOU_FILTER);
const PANSOU_CACHE_EX_SECONDS = Number(process.env.PANSOU_CACHE_EX_SECONDS || 43200);
const PANSOU_TOKEN = String(process.env.PANSOU_TOKEN || "").trim();

const PANCHECK_API = String(process.env.PANCHECK_API || "").trim().replace(/\/+$/, "");
const PANCHECK_PLATFORMS = splitConfigList(process.env.PANCHECK_PLATFORMS || "quark,baidu,uc,pan123,tianyi,cmcc");
const PANCHECK_ENABLED = String(process.env.PANCHECK_ENABLED || "true").toLowerCase() !== "false";

const DRIVE_TYPE_CONFIG = splitConfigList(process.env.DRIVE_TYPE_CONFIG || "quark;uc");
const SOURCE_NAMES_CONFIG = splitConfigList(process.env.SOURCE_NAMES_CONFIG || "本地代理;服务端代理;直连");
const DRIVE_ORDER = splitConfigList(process.env.DRIVE_ORDER || "baidu;tianyi;quark;uc;115;xunlei;ali;123pan")
  .map((s) => s.toLowerCase());
const EXTERNAL_SERVER_PROXY_ENABLED =
  String(process.env.EXTERNAL_SERVER_PROXY_ENABLED || "false").toLowerCase() === "true";

const PROXY_URL = String(
  process.env.UPSTREAM_HTTP_PROXY_URL
  || process.env.HTTP_PROXY_URL
  || process.env.LXYY_PROXY_URL
  || "",
).trim();

const LIST_CACHE_TTL = Number(process.env.LXYY_LIST_CACHE_TTL || 900);
const DETAIL_CACHE_TTL = Number(process.env.LXYY_DETAIL_CACHE_TTL || 3600);
const RANK_CACHE_TTL = Number(process.env.LXYY_RANK_CACHE_TTL || 1800);
const CONFIG_CACHE_TTL = Number(process.env.LXYY_CONFIG_CACHE_TTL || 21600);
const PAN_CACHE_TTL = PANSOU_CACHE_EX_SECONDS || Number(process.env.LXYY_PAN_CACHE_TTL || 1800);

const CACHE_SCHEMA = "v2";
const CACHE_PREFIX = `lxyy:${CACHE_SCHEMA}:`;

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

/* ==========================================================================
 * 日志与缓存
 * ========================================================================== */

function logInfo(message) {
  try {
    Promise.resolve(OmniBox.log("info", `[lxyy] ${message}`)).catch(() => {});
  } catch (_) { /* ignore */ }
}

function logError(message, error) {
  const detail = error && error.message ? ` | ${error.message}` : "";
  try {
    Promise.resolve(OmniBox.log("error", `[lxyy] ${message}${detail}`)).catch(() => {});
  } catch (_) { /* ignore */ }
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

function normalizeText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/* ==========================================================================
 * 出口代理（HTTP CONNECT / SOCKS5），零依赖
 * ========================================================================== */

function parseProxyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try { parsed = new URL(withScheme); } catch (_) { return null; }
  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  const isSocks = protocol.indexOf("socks") === 0;
  return {
    protocol,
    host: parsed.hostname,
    port: Number(parsed.port || (isSocks ? 1080 : 7890)),
    auth: parsed.username || parsed.password
      ? { username: decodeURIComponent(parsed.username || ""), password: decodeURIComponent(parsed.password || "") }
      : null,
    isSocks,
  };
}

function connectViaHttpProxy(proxy, host, port, timeout) {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; socket.destroy(); reject(e); };
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
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      if (buf.indexOf("\r\n\r\n") < 0) return;
      socket.removeListener("data", onData);
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const code = Number((statusLine.match(/\s(\d{3})\s?/) || [])[1] || 0);
      if (code !== 200) return fail(new Error(`代理 CONNECT 失败: ${statusLine}`));
      settled = true; socket.setTimeout(0); resolve(socket);
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
    const fail = (e) => { if (settled) return; settled = true; socket.destroy(); reject(e); };
    const buildConnect = () => {
      const h = Buffer.from(host, "utf8");
      const p = Buffer.alloc(2); p.writeUInt16BE(port, 0);
      return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, p]);
    };
    socket.on("timeout", () => fail(Object.assign(new Error("SOCKS5 超时"), { code: "ETIMEDOUT" })));
    socket.on("error", fail);
    socket.on("connect", () => {
      const withAuth = !!(proxy.auth && proxy.auth.username);
      socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    });
    const onData = (chunk) => {
      if (stage === "greeting") {
        if (chunk[0] !== 0x05) return fail(new Error("SOCKS5 版本不匹配"));
        if (chunk[1] === 0x02) {
          const u = Buffer.from(proxy.auth.username, "utf8");
          const pw = Buffer.from(proxy.auth.password, "utf8");
          stage = "auth";
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
          return;
        }
        if (chunk[1] === 0x00) { stage = "connect"; socket.write(buildConnect()); return; }
        return fail(new Error(`SOCKS5 不支持认证 ${chunk[1]}`));
      }
      if (stage === "auth") {
        if (chunk[1] !== 0x00) return fail(new Error("SOCKS5 认证失败"));
        stage = "connect"; socket.write(buildConnect()); return;
      }
      if (stage === "connect") {
        if (chunk[1] !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${chunk[1]}`));
        socket.removeListener("data", onData);
        settled = true; socket.setTimeout(0); resolve(socket);
      }
    };
    socket.on("data", onData);
  });
}

/* ==========================================================================
 * HTTP
 * ========================================================================== */

function nodeRequest(urlStr, options = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const proxy = parseProxyUrl(PROXY_URL);
    const timeout = options.timeout || REQUEST_TIMEOUT;

    const handle = (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
        finalUrl: u.href,
      }));
      res.on("error", reject);
    };

    if (proxy) {
      const connect = proxy.isSocks ? connectViaSocks5 : connectViaHttpProxy;
      connect(proxy, u.hostname, Number(u.port || (isHttps ? 443 : 80)), timeout).then((socket) => {
        const httpsMod = require("https");
        const httpMod = require("http");
        const tlsMod = require("tls");
        const targetPort = Number(u.port || (isHttps ? 443 : 80));
        const reqOptions = {
          host: u.hostname,
          port: targetPort,
          path: `${u.pathname}${u.search}`,
          method: options.method || "GET",
          headers: Object.assign({}, headers, { Host: u.host }),
          timeout,
          agent: false,
        };
        if (isHttps) {
          const secure = tlsMod.connect({ socket, servername: u.hostname });
          reqOptions.createConnection = () => secure;
        } else {
          reqOptions.createConnection = () => socket;
        }
        const req = (isHttps ? httpsMod : httpMod).request(reqOptions, handle);
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
        if (options.body) req.write(options.body);
        req.end();
      }).catch(reject);
      return;
    }

    const client = isHttps ? require("https") : require("http");
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: options.method || "GET",
      headers,
      timeout,
      rejectUnauthorized: false,
    }, handle);
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchJson(urlStr, options = {}) {
  const headers = Object.assign({
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: `${HOST}/`,
  }, options.headers || {});

  logInfo(`请求 ${options.method || "GET"} ${urlStr.slice(0, 130)}`);
  const res = await nodeRequest(urlStr, options, headers);
  const code = Number(res.statusCode || 0);
  if (code < 200 || code >= 300) {
    throw new Error(`HTTP ${code} @ ${urlStr.slice(0, 100)}`);
  }
  try {
    return JSON.parse(res.body || "{}");
  } catch (error) {
    throw new Error(`返回非 JSON: ${String(res.body || "").slice(0, 100)}`);
  }
}

/* ==========================================================================
 * 采集站代理 /api/proxy.php —— 站点真正的播放主链路
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 采集站代理限流保护
 * 实测：短时间高频请求 /api/proxy.php 后，站点会返回
 *   {"message":"未知操作","success":false}
 * 且此后一段时间内连 action=config 都失败（其它接口如 tmdb/ranking 仍正常）。
 * 因此这里做三件事：
 *   1) 请求间隔节流（默认 700ms，可用 LXYY_PROXY_MIN_INTERVAL 调整）
 *   2) 识别限流响应 → 进入冷却期（默认 300s），冷却期内直接返回缓存/空，不再打站点
 *   3) 命中限流时打明确日志，提示用户这是站点限流而非脚本 bug
 * ------------------------------------------------------------------------- */

const PROXY_MIN_INTERVAL = Number(process.env.LXYY_PROXY_MIN_INTERVAL || 700);
const PROXY_COOLDOWN = Number(process.env.LXYY_PROXY_COOLDOWN || 300);

let proxyLastAt = 0;
let proxyCooldownUntil = 0;
let proxyBlockedLogged = false;

function proxyCoolingDown() {
  return Date.now() < proxyCooldownUntil;
}

function proxyCoolingHint() {
  const left = Math.max(0, Math.ceil((proxyCooldownUntil - Date.now()) / 1000));
  return `${left}s`;
}

function enterProxyCooldown(reason) {
  proxyCooldownUntil = Date.now() + PROXY_COOLDOWN * 1000;
  if (!proxyBlockedLogged) {
    proxyBlockedLogged = true;
    logError(
      `采集站代理被限流（${reason}），进入 ${PROXY_COOLDOWN}s 冷却。`
      + "该接口是站点反爬重点，请降低调用频率或用 LXYY_PROXY_MIN_INTERVAL 调大间隔；"
      + "冷却期内本源会优先用缓存/TMDB 兜底，不会反复打站点",
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isProxyBlocked(data) {
  if (!data) return false;
  const msg = String(data.message || "");
  // 站点限流/参数失效统一表现为「未知操作」+ success:false，且没有 results/details
  if (data.success === false && /未知操作|unknown action/i.test(msg)) return true;
  return false;
}

async function proxyThrottle() {
  const now = Date.now();
  const wait = proxyLastAt + PROXY_MIN_INTERVAL - now;
  if (wait > 0) await sleep(wait);
  proxyLastAt = Date.now();
}

async function proxyFetch(action, params = {}) {
  if (proxyCoolingDown()) {
    throw new Error(`采集站代理冷却中（剩余 ${proxyCoolingHint()}），跳过请求`);
  }
  await proxyThrottle();
  const data = await fetchJson(proxyUrl(action, params));
  if (isProxyBlocked(data)) {
    enterProxyCooldown(`action=${action}`);
    throw new Error(`采集站代理返回限流响应（action=${action}）`);
  }
  return data;
}

function proxyUrl(action, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${HOST}/api/proxy.php?action=${encodeURIComponent(action)}${qs ? `&${qs}` : ""}`;
}

async function fetchSiteConfig() {
  const key = buildCacheKey("config");
  const cached = await getCachedJson(key);
  if (cached && cached.sources) {
    logInfo(`命中站点配置缓存 sources=${Object.keys(cached.sources).length}`);
    return cached;
  }
  const data = await proxyFetch("config");
  const sources = (data && data.sources) || {};
  await setCachedJson(key, { sources }, CONFIG_CACHE_TTL);
  logInfo(`站点配置 源=${Object.keys(sources).length} [${Object.keys(sources).join(",")}]`);
  return { sources };
}

async function proxySearch(keyword, page = 1) {
  const key = buildCacheKey("search", `${keyword}|${page}`);
  const cached = await getCachedJson(key);
  if (cached && Array.isArray(cached.results)) {
    logInfo(`命中搜索缓存 ${keyword} p${page} -> ${cached.results.length}`);
    return cached.results;
  }
  const data = await proxyFetch("search", { wd: keyword, page: String(page) });
  if (data && data.need_captcha) {
    logError("采集站要求人机校验（need_captcha），本轮返回空，稍后重试或降低频率");
    return [];
  }
  if (data && data.success === false) {
    throw new Error(`采集站搜索失败: ${data.message || "unknown"}`);
  }
  const results = (Array.isArray(data.results) ? data.results : [])
    .filter((item) => item && item.id != null && item.source);
  await setCachedJson(key, { results }, LIST_CACHE_TTL);
  logInfo(`采集站搜索 "${keyword}" p${page} -> ${results.length} 条`);
  return results;
}

async function proxyDetail(id, source) {
  const key = buildCacheKey("detail", `${id}|${source}`);
  const cached = await getCachedJson(key);
  if (cached && cached.name) {
    logInfo(`命中详情缓存 ${source}/${id}`);
    return cached;
  }
  const data = await proxyFetch("detail", { id: String(id), source: String(source) });
  const detail = (Array.isArray(data.details) ? data.details[0] : null) || null;
  if (!detail) {
    logInfo(`详情为空 ${source}/${id}`);
    return null;
  }
  await setCachedJson(key, detail, DETAIL_CACHE_TTL);
  const epCount = (detail.episodes || []).reduce((s, g) => s + ((g.episodes || []).length), 0);
  logInfo(`详情 ${source}/${id}「${normalizeText(detail.name)}」分集=${epCount} player_api=${detail.player_api ? "有" : "无"}`);
  return detail;
}

/**
 * 把站点 detail.episodes 摊平成 OmniBox episode 列表。
 * episodes[].url 是平台播放页（B站/爱奇艺…），player_api 是解析入口。
 * playId 直接透传所需信息，play() 不必再回源：
 *   playId = "px|" + base64(JSON{u:播放页url, p:player_api, s:source, i:id, t:片名, g:线路})
 */
function normalizeEpisodeName(raw, index) {
  // 站点分集名常是纯数字（"1"/"2"…）或"第 1 集"，统一成「第N集」避免列表显示异常。
  const name = normalizeText(raw) || `第${index + 1}集`;
  const m = name.match(/(\d+)/);
  if (/^\d+$/.test(name) || /^第\s*\d+\s*集$/.test(name)) return `第${m ? m[1] : index + 1}集`;
  return name;
}

function buildEpisodeMeta(detail, url) {
  // playId 精简：t(片名)/g(线路) 全剧每集都相同属冗余，去掉可显著缩短
  // vod_play_url（长剧 200+ 集时从 42KB 降到 ~20KB，避免宿主解析/显示异常）。
  // play() 里 meta.g 有 fallback，不影响播放。
  const meta = {
    u: String(url || "").trim(),
    p: String((detail && detail.player_api) || "").trim(),
    s: String((detail && detail.source) || ""),
    i: String((detail && detail.id) || ""),
    t: normalizeText(detail && detail.name), // 剧名：嗅探失败时用于跨源搜索 m3u8 直链兜底
  };
  return `px|${Buffer.from(JSON.stringify(meta), "utf8").toString("base64")}`;
}

// 按站点线路分组拆成多条 vod_play_source：线路名（如 jlm3u8/jlplayer）体现在线路名上，
// 不再拼进每个分集名——否则列表里每集都带 "jlm3u8 第N集"，看起来像乱码/异常。
function buildProxySources(detail, fallbackName) {
  const groups = Array.isArray(detail && detail.episodes) ? detail.episodes : [];
  const sources = [];
  groups.forEach((group, gi) => {
    const groupName = normalizeText(group && group.group) || `线路${gi + 1}`;
    const eps = Array.isArray(group && group.episodes) ? group.episodes : [];
    const episodes = [];
    eps.forEach((ep, ei) => {
      const url = String((ep && ep.url) || "").trim();
      if (!url) return;
      episodes.push({ name: normalizeEpisodeName(ep && ep.name, ei), playId: buildEpisodeMeta(detail, url) });
    });
    if (episodes.length) sources.push({ name: normalizeText(fallbackName) || groupName, episodes });
  });
  return sources;
}

function buildProxyEpisodes(detail) {
  return buildProxySources(detail).reduce((all, source) => all.concat(source.episodes), []);
}

function decodePlayId(playId) {
  const raw = String(playId || "");
  if (raw.indexOf("px|") !== 0) return null;
  try {
    const json = Buffer.from(raw.slice(3), "base64").toString("utf-8");
    const meta = JSON.parse(json);
    if (meta && meta.u) return meta;
  } catch (error) {
    logInfo(`playId 解析失败: ${error.message}`);
  }
  return null;
}

/* ==========================================================================
 * TMDB（榜单/发现分类 + 元数据补充）
 * ========================================================================== */

function buildTmdbUrl(path, params = {}) {
  const base = `${HOST}${TMDB_PATH}${encodeURI(path)}`;
  const qs = Object.entries(Object.assign({ language: DEFAULT_LANG }, params))
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `${base}&${qs}` : base;
}

async function tmdbGet(path, params = {}, ttl = LIST_CACHE_TTL, cacheName = "tmdb") {
  const url = buildTmdbUrl(path, params);
  const key = buildCacheKey(cacheName, url);
  const cached = await getCachedJson(key);
  if (cached) return cached;
  const data = await fetchJson(url);
  if (data && data.success === false) {
    throw new Error(`TMDB 代理失败: ${data.message || "unknown"} @ ${path}`);
  }
  await setCachedJson(key, data, ttl);
  return data;
}

function tmdbImage(path, size) {
  if (!path) return "";
  const p = String(path);
  if (/^https?:\/\//i.test(p)) return p;
  return `${IMG_BASE}/${size || "w500"}${p.startsWith("/") ? "" : "/"}${p}`;
}

/* ==========================================================================
 * 榜单 / 分类
 * ========================================================================== */

/* 官网权威分类：tv.lxyy.club/js/catalog-categories.js 的 CESHI_CATALOG_LISTS（37 个） */
const MOVIE_BASE = {
  sort_by: "popularity.desc",
  "primary_release_date.lte": "today",
  include_adult: "false",
  include_video: "false",
};
const SERIES_BASE = {
  sort_by: "popularity.desc",
  "first_air_date.lte": "today",
  include_null_first_air_dates: "false",
  include_adult: "false",
};
const GROUP_NAMES = { movie: "电影", series: "剧集", anime: "动漫" };

function mkCat(id, group, label, extra) {
  const e = Object.assign({}, extra || {});
  const countries = e.countries;
  delete e.countries;
  const isMovie = group === "movie";
  const params = Object.assign({}, isMovie ? MOVIE_BASE : SERIES_BASE, e);
  // 官网多国家用 | 分隔（HK|TW|MO→16267 条；逗号分隔只有 3 条）
  if (Array.isArray(countries) && countries.length) params.with_origin_country = countries.join("|");
  return {
    type_id: id,
    group,
    tabTitle: label,
    type_name: `${GROUP_NAMES[group]} · ${label}`,
    mediaType: isMovie ? "movie" : "tv",
    endpoint: isMovie ? "discover/movie" : "discover/tv",
    params,
  };
}

// 电影 16
const CATALOG_MOVIES = [
  mkCat("movie-all", "movie", "全部"),
  mkCat("movie-popular", "movie", "热门"),
  mkCat("movie-latest", "movie", "最新", { sort_by: "primary_release_date.desc" }),
  mkCat("movie-rated", "movie", "高分", { sort_by: "vote_average.desc", vote_count_gte: "200" }),
  mkCat("cn-movie", "movie", "国产", { with_original_language: "zh", with_origin_country: "CN" }),
  mkCat("movie-hktw", "movie", "港澳台", { countries: ["HK", "TW", "MO"] }),
  mkCat("movie-western", "movie", "欧美", { with_original_language: "en" }),
  mkCat("movie-jpkr", "movie", "日韩", { countries: ["JP", "KR"] }),
  mkCat("movie-action", "movie", "动作", { with_genres: "28" }),
  mkCat("movie-comedy", "movie", "喜剧", { with_genres: "35" }),
  mkCat("movie-romance", "movie", "爱情", { with_genres: "10749" }),
  mkCat("movie-mystery", "movie", "悬疑", { with_genres: "9648" }),
  mkCat("movie-scifi", "movie", "科幻", { with_genres: "878" }),
  mkCat("movie-horror", "movie", "恐怖", { with_genres: "27" }),
  mkCat("movie-animation", "movie", "动画", { with_genres: "16" }),
  mkCat("movie-documentary", "movie", "纪录片", { with_genres: "99" }),
];

// 剧集 16（官网叫「剧集」；genre 分类按官网排除动画 without_genres=16）
const NO_ANIME = { without_genres: "16" };
const CATALOG_SERIES = [
  mkCat("series-all", "series", "全部", NO_ANIME),
  mkCat("series-hot", "series", "热播", NO_ANIME),
  mkCat("series-latest", "series", "最新", Object.assign({ sort_by: "first_air_date.desc" }, NO_ANIME)),
  mkCat("series-rated", "series", "高分", Object.assign({ sort_by: "vote_average.desc", vote_count_gte: "200" }, NO_ANIME)),
  mkCat("cn-tv", "series", "国产", Object.assign({ with_original_language: "zh", with_origin_country: "CN" }, NO_ANIME)),
  mkCat("series-korea", "series", "韩剧", Object.assign({ with_origin_country: "KR" }, NO_ANIME)),
  mkCat("series-japan", "series", "日剧", Object.assign({ with_origin_country: "JP" }, NO_ANIME)),
  mkCat("series-western", "series", "欧美", Object.assign({ with_original_language: "en" }, NO_ANIME)),
  mkCat("series-action", "series", "动作冒险", Object.assign({ with_genres: "10759" }, NO_ANIME)),
  mkCat("series-comedy", "series", "喜剧", Object.assign({ with_genres: "35" }, NO_ANIME)),
  mkCat("series-mystery", "series", "悬疑", Object.assign({ with_genres: "9648" }, NO_ANIME)),
  mkCat("series-crime", "series", "犯罪", Object.assign({ with_genres: "80" }, NO_ANIME)),
  mkCat("series-scifi", "series", "科幻奇幻", Object.assign({ with_genres: "10765" }, NO_ANIME)),
  mkCat("series-animation", "series", "动画", { with_genres: "16" }),
  mkCat("series-documentary", "series", "纪录片", Object.assign({ with_genres: "99" }, NO_ANIME)),
  mkCat("western-animation", "series", "英文动画", { with_genres: "16", with_original_language: "en" }),
];

// 动漫 6
const ANIME_BASE = { with_genres: "16" };
const CATALOG_ANIME = [
  mkCat("anime-all", "anime", "全部", ANIME_BASE),
  mkCat("anime-cn", "anime", "国漫", Object.assign({}, ANIME_BASE, { with_original_language: "zh", with_origin_country: "CN" })),
  mkCat("anime-japan", "anime", "日漫", Object.assign({}, ANIME_BASE, { with_origin_country: "JP" })),
  mkCat("anime-western", "anime", "欧美", Object.assign({}, ANIME_BASE, { with_original_language: "en" })),
  mkCat("anime-latest", "anime", "最新", Object.assign({}, ANIME_BASE, { sort_by: "first_air_date.desc" })),
  mkCat("anime-rated", "anime", "高分", Object.assign({}, ANIME_BASE, { sort_by: "vote_average.desc", vote_count_gte: "100" })),
];

const DISCOVER_LISTS = [].concat(CATALOG_MOVIES, CATALOG_SERIES, CATALOG_ANIME);

// 官网侧边栏影视浏览项：电影 / 剧集 / 动漫（官网叫「剧集」，不是「电视剧」）
const CATALOG_GROUPS = [
  { type_id: "cat:movie", type_name: "电影", group: "movie" },
  { type_id: "cat:series", type_name: "剧集", group: "series" },
  { type_id: "cat:anime", type_name: "动漫", group: "anime" },
];

// 官网 category-tabs 榜单：去「榜」字，quark 补「短剧」
const RANK_CHANNELS = [
  { type_id: "rank:quark", type_name: "夸克榜单", channels: ["电视剧", "电影", "综艺", "动漫", "短剧"] },
  { type_id: "rank:trend", type_name: "TMDB趋势" },
  { type_id: "rank:bilibili", type_name: "B站榜单" },
  { type_id: "rank:netflix", type_name: "奈飞榜单" },
];

// 官网 config.sources 全部 8 个源（补 md 魔都 / fy 官方源）
const SOURCE_CATEGORIES = [
  { type_id: "src:qilin", type_name: "官采蓝光" },
  { type_id: "src:mj", type_name: "4k60帧" },
  { type_id: "src:jl", type_name: "自营" },
  { type_id: "src:360zy", type_name: "360资源" },
  { type_id: "src:dytt", type_name: "电影天堂" },
  { type_id: "src:ik", type_name: "ikun" },
  { type_id: "src:md", type_name: "魔都" },
  { type_id: "src:fy", type_name: "官方源" },
];

const CLASS_LIST = [
  ...CATALOG_GROUPS.map((c) => ({ type_id: c.type_id, type_name: c.type_name })),
  ...RANK_CHANNELS.map((c) => ({ type_id: c.type_id, type_name: c.type_name })),
  ...SOURCE_CATEGORIES.map((c) => ({ type_id: c.type_id, type_name: c.type_name })),
];

/* spec: "quark:电视剧" | "trend" | "bilibili" | "netflix" | 旧「电视剧」（兼容） */
async function fetchRankChannel(spec) {
  const key = buildCacheKey("rank", spec);
  const cached = await getCachedJson(key);
  if (cached && Array.isArray(cached.items)) return cached.items;
  let url;
  let field = "items";
  const s = String(spec || "");
  if (s.indexOf("quark:") === 0) {
    url = `${HOST}/api/quark-ranking.php?channel=${encodeURIComponent(s.slice(6))}&limit=60`;
  } else if (s === "trend" || s === "ranking") {
    url = `${HOST}/api/ranking.php`;
  } else if (s === "bilibili") {
    url = `${HOST}/api/bilibili-ranking.php`;
  } else if (s === "netflix") {
    url = `${HOST}/api/netflix-ranking.php`;
    field = "results";
  } else {
    url = `${HOST}/api/quark-ranking.php?channel=${encodeURIComponent(s)}`;
  }
  const data = await fetchJson(url);
  const items = Array.isArray(data && data[field]) ? data[field] : [];
  await setCachedJson(key, { items }, RANK_CACHE_TTL);
  logInfo(`榜单 ${spec} -> ${items.length}`);
  return items;
}

function pickFilters(p) {
  for (const key of ["filters", "extend", "ext", "filter"]) {
    const v = p && p[key];
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  }
  return {};
}

/* ==========================================================================
 * 映射
 * ========================================================================== */

function collectToVod(item) {
  const remarkParts = [];
  if (item.remarks) remarkParts.push(normalizeText(item.remarks));
  if (item.year) remarkParts.push(String(item.year));
  return {
    vod_id: `cs|${item.source}|${item.id}`,
    vod_name: normalizeText(item.name) || `资源 ${item.id}`,
    vod_pic: String(item.pic || ""),
    vod_remarks: remarkParts.join(" · "),
    vod_year: String(item.year || ""),
    type_name: normalizeText(item.type) || normalizeText(item.source_name) || "影视",
  };
}

function rankToVod(item, channel) {
  const title = normalizeText(item.title || item.name);
  // trend / netflix 条目自带 TMDB id：直接用 tm| 前缀走 TMDB 详情（能拿完整播放列表）
  const tmdbId = item.tmdbId || (item.id && (item.media_type || item.mediaType) ? item.id : null);
  const mediaType = item.mediaType || item.media_type || (item.first_air_date ? "tv" : "movie");
  if (tmdbId) {
    const v = tmdbToVod({ id: tmdbId, media_type: mediaType,
      title: item.title || item.name, name: item.name,
      poster_path: item.posterPath || item.poster_path,
      vote_average: item.score, first_air_date: item.first_air_date,
      release_date: item.release_date }, mediaType);
    return v;
  }
  const parts = [];
  if (item.episodes) parts.push(String(item.episodes));
  if (item.hot_score) parts.push(String(item.hot_score));
  if (item.score && Number(item.score) > 0 && !String(item.score).includes("分")) parts.push(`★${item.score}`);
  if (item.people) parts.push(`${item.people}人关注`);
  return {
    vod_id: `rk|${channel}|${encodeURIComponent(title)}`,
    vod_name: title || "未知",
    vod_pic: String(item.src || (item.poster_path ? tmdbImage(item.poster_path, "w500") : "")),
    vod_remarks: parts.join(" · "),
    vod_year: String(item.year || item.pub_date || "").slice(0, 4),
    vod_content: normalizeText(item.desc || item.overview),
    vod_actor: normalizeText(item.actors),
    type_name: normalizeText(item.category || item.channel) || channel || "影视",
  };
}

function tmdbToVod(item, fallbackType) {
  const mediaType = item.media_type || fallbackType || (item.first_air_date ? "tv" : "movie");
  const title = normalizeText(item.title || item.name);
  const date = String(item.release_date || item.first_air_date || "");
  const parts = [];
  if (Number(item.vote_average) > 0) parts.push(`★${Number(item.vote_average).toFixed(1)}`);
  if (date) parts.push(date.slice(0, 4));
  return {
    vod_id: `tm|${mediaType}|${item.id}`,
    vod_name: title || `TMDB ${item.id}`,
    vod_pic: tmdbImage(item.poster_path, "w500"),
    vod_remarks: parts.join(" · "),
    vod_year: date.slice(0, 4),
    vod_content: normalizeText(item.overview),
    type_name: mediaType === "tv" ? "剧集" : "电影",
  };
}

function toVodList(items) {
  return (items || []).map((item) => ({
    vod_id: item.vod_id,
    vod_name: item.vod_name,
    vod_pic: item.vod_pic,
    vod_remarks: item.vod_remarks || "",
  }));
}

/* ==========================================================================
 * 五个 handler
 * ========================================================================== */

async function home(params, context) {
  logInfo(`home 入口 from=${(context && context.from) || "web"}`);
  try {
    const list = [];

    // 首屏：采集站聚合搜索（这是"能播的内容"，比榜单更有用）
    try {
      const hot = await proxySearch(HOME_KEYWORD, 1);
      hot.slice(0, 12).forEach((item) => list.push(collectToVod(item)));
      logInfo(`home 采集站("${HOME_KEYWORD}") -> ${Math.min(hot.length, 12)}`);
    } catch (error) {
      logInfo(`home 采集站搜索失败: ${error.message}`);
    }

    // 补充榜单（官网推荐模式：夸克榜单，取电影 + 电视剧频道）
    const channels = ["quark:电影", "quark:电视剧"];
    const settled = await Promise.allSettled(channels.map((c) => fetchRankChannel(c)));
    settled.forEach((res, i) => {
      if (res.status !== "fulfilled") return;
      res.value.slice(0, 6).forEach((item) => list.push(rankToVod(item, channels[i])));
    });

    logInfo(`home 结果 list=${list.length}`);
    return { class: CLASS_LIST, filters: buildFilters(), list: toVodList(list) };
  } catch (error) {
    logError("home 失败", error);
    return { class: CLASS_LIST, list: [] };
  }
}

function buildFilters() {
  const filters = {};
  // 电影/剧集/动漫主分类：把官网 37 个目录分类做成二级 tab（值=catalogId）
  for (const g of CATALOG_GROUPS) {
    const items = DISCOVER_LISTS.filter((c) => c.group === g.group);
    filters[g.type_id] = [
      { key: "catalog", name: g.type_name, value: [
        { name: "全部", value: "" },
        ...items.map((c) => ({ name: c.tabTitle, value: c.type_id })),
      ] },
    ];
  }
  // 夸克榜单：5 个频道做成二级 tab
  const quark = RANK_CHANNELS.find((c) => c.type_id === "rank:quark");
  if (quark) {
    filters["rank:quark"] = [
      { key: "channel", name: "频道", value: [
        { name: "电视剧", value: "电视剧" },
        { name: "电影", value: "电影" },
        { name: "综艺", value: "综艺" },
        { name: "动漫", value: "动漫" },
        { name: "短剧", value: "短剧" },
      ] },
    ];
  }
  // 其余分类保留排序占位
  for (const item of CLASS_LIST) {
    if (filters[item.type_id]) continue;
    filters[item.type_id] = [
      { key: "sort", name: "排序", value: [
        { name: "默认", value: "" },
        { name: "最新", value: "newest" },
      ] },
    ];
  }
  return filters;
}

async function categoryFromCatalog(conf, page) {
  const data = await tmdbGet(conf.endpoint, Object.assign({}, conf.params, { page: String(page) }), LIST_CACHE_TTL, "list");
  const results = Array.isArray(data.results) ? data.results : [];
  const mediaType = conf.endpoint.indexOf("tv") >= 0 ? "tv" : "movie";
  const realPages = Number(data.total_pages) || 0;
  logInfo(`category(catalog) ${conf.type_id} p${page} list=${results.length} total_pages=${realPages}`);
  return {
    page,
    pagecount: Math.max(page, Math.min(realPages > 0 ? realPages : page, 500)),
    total: Number(data.total_results) || 0,
    list: toVodList(results.map((x) => tmdbToVod(x, mediaType))),
  };
}

async function category(params, context) {
  const categoryId = String((params && params.categoryId) || "cat:movie");
  const page = Math.max(1, Number((params && params.page) || 1) || 1);
  const f = pickFilters(params);
  logInfo(`category 入口 categoryId=${categoryId} page=${page} filters=${JSON.stringify(f)}`);

  try {
    if (categoryId.indexOf("src:") === 0) {
      const source = categoryId.slice(4);
      const all = await proxySearch(HOME_KEYWORD, page);
      const filtered = all.filter((item) => String(item.source) === source);
      logInfo(`category(src) ${source} p${page} all=${all.length} matched=${filtered.length}`);
      return {
        page,
        pagecount: all.length >= 20 ? page + 1 : page,
        total: filtered.length,
        list: toVodList(filtered.map(collectToVod)),
      };
    }

    if (categoryId.indexOf("rank:") === 0) {
      let spec = categoryId.slice(5);
      if (spec === "quark") {
        const ch = normalizeText(f.channel || f.catalog || "电视剧") || "电视剧";
        spec = `quark:${ch}`;
      }
      const items = await fetchRankChannel(spec);
      const start = (page - 1) * 20;
      const slice = items.slice(start, start + 20);
      logInfo(`category(rank) ${spec} total=${items.length} list=${slice.length}`);
      return {
        page,
        pagecount: Math.max(1, Math.ceil(items.length / 20)),
        total: items.length,
        list: toVodList(slice.map((x) => rankToVod(x, spec))),
      };
    }

    // 官网主分组：电影 / 剧集 / 动漫，二级 tab 选具体目录分类
    if (categoryId.indexOf("cat:") === 0) {
      const group = categoryId.slice(4);
      const chosen = normalizeText(f.catalog || f.sub || f.type || "");
      let conf = chosen ? DISCOVER_LISTS.find((c) => c.type_id === chosen && c.group === group) : null;
      if (!conf) conf = DISCOVER_LISTS.find((c) => c.group === group); // 默认该组第一个（全部）
      if (conf) return await categoryFromCatalog(conf, page);
    }

    // 直接用目录分类 id（movie-action / series-korea / anime-japan ...）
    const conf = DISCOVER_LISTS.find((c) => c.type_id === categoryId);
    if (conf) return await categoryFromCatalog(conf, page);

    // 兼容旧分类名
    const alias = { "movie:now": "movie-latest", "movie:popular": "movie-popular",
      "tv:now": "series-latest", "tv:popular": "series-hot", anime: "anime-all" };
    if (alias[categoryId]) return await categoryFromCatalog(DISCOVER_LISTS.find((c) => c.type_id === alias[categoryId]), page);

    logInfo(`category 未知分类 ${categoryId}`);
    return { page, pagecount: 0, total: 0, list: [] };
  } catch (error) {
    logError(`category 失败 ${categoryId} p${page}`, error);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

/* ==========================================================================
 * 详情
 * ========================================================================== */

async function matchTmdbByTitle(title, year) {
  const t = normalizeText(title);
  if (!t) return null;
  try {
    const data = await tmdbGet("search/multi", { query: t, include_adult: "false", page: "1" }, LIST_CACHE_TTL, "match");
    const results = (Array.isArray(data.results) ? data.results : [])
      .filter((x) => x && (x.media_type === "movie" || x.media_type === "tv"));
    if (!results.length) return null;
    const norm = (v) => normalizeText(v).toLowerCase();
    const same = results.filter((x) => norm(x.title || x.name) === norm(t));
    const pool = same.length ? same : results;
    let picked = pool[0];
    if (year) {
      picked = pool.find((x) => String(x.release_date || x.first_air_date || "").slice(0, 4) === String(year)) || picked;
    }
    return { mediaType: picked.media_type, id: picked.id };
  } catch (error) {
    logInfo(`TMDB 回查失败 ${t}: ${error.message}`);
    return null;
  }
}

async function detailFromCollect(source, id, vodId) {
  const d = await proxyDetail(id, source);
  if (!d) return null;
  let sources = buildProxySources(d);
  const totalEps = sources.reduce((n, s) => n + s.episodes.length, 0);
  // 单线路用站点源名（官采蓝光）更友好；多线路保留各自分组名（jlm3u8/jlplayer）便于选择。
  if (sources.length === 1) sources = [{ ...sources[0], name: normalizeText(d.source_name) || sources[0].name }];

  const parts = [];
  if (d.remarks) parts.push(normalizeText(d.remarks));
  if (d.year) parts.push(String(d.year));
  if (totalEps > 1) parts.push(`全${totalEps}集`);
  else if (totalEps === 1) parts.push("正片");

  const vod = {
    vod_id: vodId || `cs|${source}|${id}`,
    vod_name: normalizeText(d.name),
    vod_pic: String(d.pic || ""),
    vod_content: normalizeText(d.content),
    vod_year: String(d.year || ""),
    vod_area: normalizeText(d.area),
    vod_lang: normalizeText(d.lang),
    vod_remarks: parts.join(" · "),
    type_name: normalizeText(d.type) || normalizeText(d.source_name) || "影视",
    vod_actor: normalizeText(d.actor),
    vod_director: normalizeText(d.director),
    vod_play_sources: sources,
  };
  if (sources.length) {
    vod.vod_play_from = sources.map((s) => s.name).join("$$$");
    // 兼容旧端：只取第一条线路的集数生成 vod_play_url（避免多线路混在一起）。
    vod.vod_play_url = sources[0].episodes.map((ep) => `${ep.name}$${ep.playId}`).join("#");
  }
  return vod;
}

async function detailFromRank(channel, titleOrIndex, vodId) {
  const items = await fetchRankChannel(channel);
  let item = null;
  const asIndex = Number(titleOrIndex);
  if (Number.isFinite(asIndex) && String(asIndex) === String(titleOrIndex)) item = items[asIndex] || null;
  if (!item) {
    const title = decodeURIComponent(String(titleOrIndex));
    item = items.find((x) => normalizeText(x.title) === title) || null;
  }
  if (!item) return null;

  const rankVod = rankToVod(item, channel);

  // 关键：榜单条目本身没有播放列表，先去采集站找同名资源
  try {
    const results = await proxySearch(normalizeText(item.title), 1);
    const exact = results.find((r) => normalizeText(r.name) === normalizeText(item.title));
    const picked = exact || results[0];
    if (picked) {
      const cs = await detailFromCollect(picked.source, picked.id, vodId);
      if (cs && cs.vod_play_sources.length) {
        const n = cs.vod_play_sources[0].episodes.length;
        logInfo(`[detail] 榜单「${item.title}」→ 采集站 ${picked.source}/${picked.id} 分集=${n}`);
        return Object.assign({}, cs, {
          vod_id: vodId || rankVod.vod_id,
          vod_name: cs.vod_name || rankVod.vod_name,
          vod_content: cs.vod_content || rankVod.vod_content,
          vod_actor: rankVod.vod_actor || cs.vod_actor,
          vod_year: rankVod.vod_year || cs.vod_year,
        });
      }
    }
  } catch (error) {
    logInfo(`[detail] 榜单「${item.title}」采集站搜索失败: ${error.message}`);
  }

  // 兜底：TMDB 元数据（无播放列表）
  const matched = await matchTmdbByTitle(item.title, item.year);
  if (matched) {
    try {
      const data = await tmdbGet(`${matched.mediaType}/${matched.id}`, {}, DETAIL_CACHE_TTL, "detail");
      return {
        vod_id: vodId || rankVod.vod_id,
        vod_name: normalizeText(data.title || data.name) || rankVod.vod_name,
        vod_pic: tmdbImage(data.poster_path, "w500") || rankVod.vod_pic,
        vod_content: normalizeText(data.overview) || rankVod.vod_content,
        vod_year: String(data.release_date || data.first_air_date || "").slice(0, 4) || rankVod.vod_year,
        type_name: rankVod.type_name,
        vod_actor: rankVod.vod_actor,
        vod_play_sources: [],
        vod_remarks: rankVod.vod_remarks,
      };
    } catch (error) {
      logInfo(`TMDB 详情失败: ${error.message}`);
    }
  }
  return Object.assign({}, rankVod, { vod_play_sources: [] });
}

async function detailFromTmdb(mediaType, id, vodId) {
  const data = await tmdbGet(`${mediaType}/${id}`, {}, DETAIL_CACHE_TTL, "detail");
  const title = normalizeText(data.title || data.name);

  // TMDB 条目也尝试走采集站拿真实播放列表
  let sources = [];
  try {
    const results = await proxySearch(title, 1);
    const exact = results.find((r) => normalizeText(r.name) === title) || results[0];
    if (exact) {
      const d = await proxyDetail(exact.id, exact.source);
      if (d) {
        sources = buildProxySources(d);
        if (sources.length === 1) sources = [{ ...sources[0], name: normalizeText(d.source_name) || sources[0].name }];
        logInfo(`[detail] TMDB「${title}」→ 采集站 ${exact.source}/${exact.id} 线路=${sources.length}`);
      }
    }
  } catch (error) {
    logInfo(`[detail] TMDB「${title}」采集站搜索失败: ${error.message}`);
  }

  const date = String(data.release_date || data.first_air_date || "");
  const genres = (Array.isArray(data.genres) ? data.genres : []).map((g) => normalizeText(g.name)).filter(Boolean);
  const parts = [];
  if (data.runtime) parts.push(`${data.runtime}分钟`);
  if (mediaType === "tv" && data.number_of_seasons) parts.push(`共${data.number_of_seasons}季`);
  if (Number(data.vote_average) > 0) parts.push(`★${Number(data.vote_average).toFixed(1)}`);

  const vod = {
    vod_id: vodId || `tm|${mediaType}|${id}`,
    vod_name: title || `TMDB ${id}`,
    vod_pic: tmdbImage(data.poster_path, "w500") || tmdbImage(data.backdrop_path, "w780"),
    vod_content: normalizeText(data.overview) || normalizeText(data.tagline),
    vod_year: date.slice(0, 4),
    vod_area: (Array.isArray(data.production_countries) ? data.production_countries : []).map((c) => normalizeText(c.name)).filter(Boolean).join(","),
    vod_lang: (Array.isArray(data.spoken_languages) ? data.spoken_languages : []).map((l) => normalizeText(l.name || l.english_name)).filter(Boolean).join(","),
    vod_remarks: parts.join(" · "),
    type_name: genres.join("/") || (mediaType === "tv" ? "剧集" : "电影"),
    vod_actor: "",
    vod_director: "",
    vod_play_sources: sources,
  };
  if (sources.length) {
    vod.vod_play_from = sources.map((s) => s.name).join("$$$");
    vod.vod_play_url = sources[0].episodes.map((ep) => `${ep.name}$${ep.playId}`).join("#");
  }
  return vod;
}

async function detail(params, context) {
  const rawId = String((params && params.videoId) || "").trim();
  logInfo(`detail 入口 videoId=${rawId} from=${(context && context.from) || "web"}`);
  if (!rawId) return { list: [] };

  try {
    let vod = null;

    if (rawId.indexOf("cs|") === 0) {
      const p = rawId.split("|");
      vod = await detailFromCollect(p[1], p[2], rawId);
    } else if (rawId.indexOf("rk|") === 0 || rawId.indexOf("rank|") === 0) {
      const p = rawId.split("|");
      vod = await detailFromRank(p[1], p[2], rawId);
    } else if (rawId.indexOf("tm|") === 0) {
      const p = rawId.split("|");
      vod = await detailFromTmdb(p[1], p[2], rawId);
    } else {
      // 兼容旧格式：movie|123 / tv|123
      const p = rawId.split("|");
      if (p.length === 2 && /^(movie|tv)$/.test(p[0])) {
        vod = await detailFromTmdb(p[0], p[1], rawId);
      }
    }

    if (!vod) {
      logInfo(`detail 未取到数据 ${rawId}`);
      return { list: [] };
    }
    const n = vod.vod_play_sources.length ? vod.vod_play_sources[0].episodes.length : 0;
    logInfo(`detail 结果 ${rawId} name=${String(vod.vod_name).slice(0, 26)} 线路=${vod.vod_play_sources.length} 分集=${n}`);
    return { list: [vod] };
  } catch (error) {
    logError(`detail 失败 ${rawId}`, error);
    return { list: [] };
  }
}

/* ==========================================================================
 * 搜索
 * ========================================================================== */

async function search(params, context) {
  const keyword = String((params && (params.keyword || params.wd || params.key)) || "").trim();
  const page = Math.max(1, Number((params && params.page) || 1) || 1);
  logInfo(`search 入口 keyword=${keyword} page=${page}`);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

  try {
    const results = await proxySearch(keyword, page);
    if (results.length) {
      logInfo(`search 结果(采集站) "${keyword}" p${page} list=${results.length}`);
      return {
        page,
        pagecount: results.length >= 20 ? page + 1 : page,
        total: (page - 1) * 20 + results.length,
        list: toVodList(results.map(collectToVod)),
      };
    }

    const data = await tmdbGet("search/multi", { query: keyword, page: String(page), include_adult: "false" }, LIST_CACHE_TTL, "search");
    const tmdbResults = (Array.isArray(data.results) ? data.results : [])
      .filter((x) => x && (x.media_type === "movie" || x.media_type === "tv"));
    const realPages = Number(data.total_pages) || 0;
    logInfo(`search 结果(TMDB 兜底) "${keyword}" list=${tmdbResults.length}`);
    return {
      page,
      pagecount: Math.max(page, Math.min(realPages > 0 ? realPages : page, 500)),
      total: Number(data.total_results) || tmdbResults.length,
      list: toVodList(tmdbResults.map((x) => tmdbToVod(x))),
    };
  } catch (error) {
    logError(`search 失败 "${keyword}"`, error);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

/* ==========================================================================
 * 盘搜（可选增强）
 * ========================================================================== */

async function panSearch(keyword) {
  if (!PANSOU_API) return null;
  const key = buildCacheKey("pan", keyword);
  const cached = await getCachedJson(key);
  if (cached && Array.isArray(cached.items)) return cached.items;

  const body = { kw: String(keyword || ""), refresh: false, res: "merge", src: "all" };
  if (PANSOU_CHANNELS) body.channels = splitConfigList(PANSOU_CHANNELS);
  if (PANSOU_PLUGINS) body.plugins = splitConfigList(PANSOU_PLUGINS);
  if (PANSOU_CLOUD_TYPES.length) body.cloud_types = PANSOU_CLOUD_TYPES;
  if (PANSOU_FILTER && (PANSOU_FILTER.include.length || PANSOU_FILTER.exclude.length)) body.filter = PANSOU_FILTER;

  const headers = { "Content-Type": "application/json" };
  if (PANSOU_TOKEN) headers.Authorization = `Bearer ${PANSOU_TOKEN}`;

  const data = await fetchJson(`${PANSOU_API}/api/search`, { method: "POST", body: JSON.stringify(body), headers });
  const payload = data && data.data ? data.data : data;
  const merged = (payload && payload.merged_by_type) || {};

  const items = [];
  for (const [drive, list] of Object.entries(merged)) {
    for (const entry of (Array.isArray(list) ? list : [])) {
      const url = String((entry && (entry.url || entry.URL)) || "").trim();
      if (!url) continue;
      items.push({
        drive: String(drive || "").toLowerCase(),
        url,
        note: normalizeText(entry && (entry.note || entry.Note || entry.name)),
        size: String((entry && (entry.size || entry.Size)) || ""),
        password: String((entry && (entry.password || entry.Password)) || ""),
      });
    }
  }
  const orderIndex = (d) => {
    const i = DRIVE_ORDER.indexOf(String(d || "").toLowerCase());
    return i < 0 ? DRIVE_ORDER.length : i;
  };
  items.sort((a, b) => orderIndex(a.drive) - orderIndex(b.drive));

  await setCachedJson(key, { items }, PAN_CACHE_TTL);
  logInfo(`盘搜 ${keyword} -> ${items.length}`);
  return items;
}

async function panCheckFilter(items) {
  if (!PANCHECK_API || !PANCHECK_ENABLED || !items.length) return items;
  try {
    const targets = items.filter((it) => PANCHECK_PLATFORMS.indexOf(it.drive) >= 0);
    if (!targets.length) return items;
    const res = await fetchJson(`${PANCHECK_API}/api/check`, {
      method: "POST",
      body: JSON.stringify({ items: targets.map((it) => ({ url: it.url, type: it.drive })) }),
      headers: { "Content-Type": "application/json" },
    });
    const results = (res && (res.results || res.data)) || [];
    if (!Array.isArray(results) || !results.length) return items;
    const bad = new Set(
      results.filter((r) => r && (r.valid === false || r.status === "bad" || r.ok === false))
        .map((r) => String(r.url || "")),
    );
    if (!bad.size) return items;
    const kept = items.filter((it) => !bad.has(it.url));
    logInfo(`PanCheck 过滤 ${items.length - kept.length} 条`);
    return kept;
  } catch (error) {
    logInfo(`PanCheck 失败(忽略): ${error.message}`);
    return items;
  }
}

function driveLabel(drive) {
  const raw = String(drive || "").toLowerCase();
  const map = {
    quark: "夸克", aliyun: "阿里", alipan: "阿里", ali: "阿里",
    baidu: "百度", bdy: "百度", uc: "UC",
    tianyi: "天翼", tianyiyun: "天翼", xunlei: "迅雷",
    123: "123", "123pan": "123", pan123: "123", 115: "115",
    mobile: "移动", cmcc: "移动", "139": "移动",
    pikpak: "PikPak", guangya: "光鸭",
    magnet: "磁力", ed2k: "电驴", others: "其他",
  };
  return map[raw] || (drive || "链接");
}

/* ==========================================================================
 * 播放
 * ========================================================================== */

function isDirectMedia(url) {
  return /\.(m3u8|mp4|flv|mkv|ts)(\?|$)/i.test(String(url || ""));
}

// 部分站点的 .m3u8 是「假 master」：只有一个 BANDWIDTH 变体，指向带动态 session
// 的相对路径子列表。不少播放器（含 MPV/内置内核）卡在解析这种单层 master 而转圈。
// 服务端先展开一层，直接返回绝对的子 m3u8 URL（内容是绝对 ts），让播放器一步到位。
async function expandMasterM3u8(masterUrl, headers = {}) {
  try {
    const res = await nodeRequest(masterUrl, { timeout: 12000 }, { "User-Agent": UA, ...headers });
    if (res.statusCode !== 200 || !res.body) return masterUrl;
    const text = res.body.trim();
    if (!/#EXT-X-STREAM-INF/i.test(text)) return masterUrl; // 已是子列表，无需展开
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const child = lines.find((line) => !line.startsWith("#") && /^https?:\/\//i.test(line));
    const childRel = child || lines.find((line) => !line.startsWith("#"));
    if (!childRel) return masterUrl;
    const expanded = new URL(childRel, masterUrl).toString();
    logInfo(`play 展开假 master → ${expanded.slice(0, 90)}`);
    return expanded;
  } catch (error) {
    logInfo(`play master 展开失败，用原地址: ${error && error.message ? error.message : error}`);
    return masterUrl;
  }
}

function buildPlayerPageUrl(playerApi, playPageUrl) {
  const api = String(playerApi || "").trim();
  const target = String(playPageUrl || "").trim();
  if (!api || !target) return "";
  if (api.indexOf("{url}") >= 0) return api.replace(/\{url\}/g, encodeURIComponent(target));
  return `${api}${encodeURIComponent(target)}`;
}

// 嗅探失败兜底：平台播放页（B站/芒果/爱奇艺…）交给 MPV 等外部播放器会报
// "unrecognized file format"，因为那是 HTML 页不是媒体。改用站点 jl/mj 等源的
// m3u8 直链：按剧名搜同名资源，优先取 t=json 且分集含 .m3u8 的线路。
async function findDirectFallback(meta) {
  const title = normalizeText(meta && meta.t);
  if (!title) return null;
  try {
    const results = await proxySearch(title, 1);
    // 优先 jl/mj 这类给直链的源；其次任意源里 detail 含 m3u8 的
    const preferred = ["jl", "mj", "360zy", "ik"];
    const candidates = (results || []).slice().sort((a, b) => {
      const ai = preferred.indexOf(String(a.source || ""));
      const bi = preferred.indexOf(String(b.source || ""));
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    }).slice(0, 4);
    for (const c of candidates) {
      try {
        const d = await proxyDetail(c.id, c.source);
        if (!d) continue;
        const sources = buildProxySources(d);
        for (const src of sources) {
          for (const ep of src.episodes) {
            const u = decodePlayId(ep.playId);
            if (u && isDirectMedia(u.u)) {
              logInfo(`play 跨源直链兜底命中 ${c.source}/${c.id} 线路=${src.name} 集=${ep.name}`);
              return { url: u.u, header: { "User-Agent": UA, Referer: `${HOST}/` }, flag: src.name || c.source };
            }
          }
        }
      } catch (_) { /* 单源失败继续下一个 */ }
    }
  } catch (error) {
    logInfo(`play 跨源直链兜底失败: ${error && error.message ? error.message : error}`);
  }
  return null;
}

async function play(params, context) {
  const rawId = String((params && (params.playId || params.id)) || "").trim();
  const from = (context && context.from) || "web";
  logInfo(`play 入口 playId=${rawId.slice(0, 70)} from=${from}`);
  if (!rawId) return { urls: [], flag: "洛雪TV", parse: 0, header: {} };

  const header = { "User-Agent": UA, Referer: `${HOST}/` };

  try {
    // A) 采集站分集（主链路）
    const meta = decodePlayId(rawId);
    if (meta) {
      if (isDirectMedia(meta.u)) {
        let directUrl = meta.u;
        if (/\.m3u8(\?|$)/i.test(meta.u)) directUrl = await expandMasterM3u8(meta.u, header);
        logInfo(`play 直链 ${meta.t || ""} ${directUrl.slice(0, 70)}`);
        return { urls: [{ name: "直链", url: directUrl }], flag: meta.g || "洛雪TV", parse: 0, header };
      }

      const urls = [];
      const playerPage = buildPlayerPageUrl(meta.p, meta.u);
      if (playerPage) urls.push({ name: meta.g || "解析播放", url: playerPage });
      urls.push({ name: "原始播放页", url: meta.u });

      logInfo(`play 解析入口=${playerPage ? "有" : "无"} src=${meta.s}/${meta.i} 线路=${meta.g || "-"} page=${meta.u.slice(0, 60)}`);

      // 平台播放页/解析页不是媒体直链；parse=1 仅 ok影视 有效，其它客户端会忽略导致加载失败。
      // 先用 SDK 嗅探真实媒体地址，命中直链即 parse=0 返回（兼容所有端）。
      if (typeof OmniBox.sniffVideo === "function") {
        for (const candidate of urls.slice(0, 2)) {
          try {
            // 嗅探 Referer 必须匹配被嗅探页面本身：qlplayer 解析页用洛雪站，
            // B站/爱奇艺等原始播放页用其自身源站，否则页面会因 Referer 校验失败而嗅探不到。
            let sniffReferer = `${HOST}/`;
            try { sniffReferer = `${new URL(candidate.url).origin}/`; } catch (_) { /* 保留默认 */ }
            logInfo(`play 开始嗅探 ${candidate.name} ${candidate.url.slice(0, 70)} ref=${sniffReferer}`);
            const sniffed = await OmniBox.sniffVideo(candidate.url, { ...header, Referer: sniffReferer });
            const sniffUrl = sniffed && (sniffed.url || sniffed.mediaUrl);
            if (sniffUrl && /^https?:\/\//i.test(String(sniffUrl))) {
              logInfo(`play 嗅探成功 ${String(sniffUrl).slice(0, 90)}`);
              return {
                urls: [{ name: meta.g || "解析播放", url: sniffUrl }],
                flag: meta.g || "洛雪TV",
                parse: 0,
                header: Object.assign({}, header, sniffed.header || {}),
              };
            }
            logInfo(`play 嗅探无结果 ${candidate.name}`);
          } catch (error) {
            logInfo(`play 嗅探失败 ${candidate.name}: ${error && error.message ? error.message : error}`);
          }
        }
      }
      // 嗅探全部失败：MPV 等外部播放器无法打开 HTML 解析页，先用同名 jl/mj 源的
      // m3u8 直链兜底（parse:0），彻底避免 "unrecognized file format"。
      const direct = await findDirectFallback(meta);
      if (direct) {
        logInfo(`play 返回跨源直链 ${direct.url.slice(0, 80)}`);
        return { urls: [{ name: direct.flag || "直链", url: direct.url }], flag: direct.flag || "洛雪TV", parse: 0, header: direct.header };
      }
      // 直链兜底也失败：回退 parse=1（ok影视 可继续嗅探），解析入口排在原始页前面
      return { urls, flag: meta.g || "洛雪TV", parse: 1, header };
    }

    // B) 兼容旧 playId：走盘搜
    const parts = rawId.split("|");
    let keyword = "";
    try {
      if (parts[0] === "tm" || parts[0] === "movie" || parts[0] === "tv") {
        const mediaType = parts[0] === "tm" ? parts[1] : parts[0];
        const id = parts[0] === "tm" ? parts[2] : parts[1];
        const data = await tmdbGet(`${mediaType}/${id}`, {}, DETAIL_CACHE_TTL, "detail");
        keyword = normalizeText(data.title || data.name);
      }
    } catch (error) {
      logInfo(`play 取标题失败: ${error.message}`);
    }

    if (!PANSOU_API) {
      logError(
        "play 未取到播放地址：该条目缺少采集站分集信息，且未配置 PANSOU_API。"
        + "请从本源的详情页进入播放（分集自带解析入口），或配置 PANSOU_API 走盘搜",
      );
      return { urls: [], flag: "洛雪TV", parse: 0, header };
    }
    if (!keyword) {
      logError(`play 缺少搜索关键词 ${rawId.slice(0, 40)}`);
      return { urls: [], flag: "洛雪TV", parse: 0, header };
    }

    let items = await panSearch(keyword);
    if (!items || !items.length) {
      logInfo(`play 盘搜无结果 ${keyword}`);
      return { urls: [], flag: "洛雪TV", parse: 0, header };
    }
    items = await panCheckFilter(items);

    const urls = items.slice(0, 20).map((item, i) => {
      const seg = [driveLabel(item.drive)];
      if (item.note) seg.push(item.note.slice(0, 20));
      if (item.size) seg.push(item.size);
      if (item.password) seg.push(`提取码 ${item.password}`);
      const name = seg.filter(Boolean).join(" · ");
      return { name: i > 0 ? `${name} (${i + 1})` : name, url: item.url };
    });
    logInfo(`play 盘搜 ${keyword} urls=${urls.length}`);
    return { urls, flag: "洛雪TV", parse: 0, header };
  } catch (error) {
    logError(`play 失败 ${rawId.slice(0, 50)}`, error);
    return { urls: [], flag: "洛雪TV", parse: 0, header };
  }
}
