// @name 洛雪
// @author OmniBox
// @description 站点：tv.lxyy.club（洛雪）。v2.2.7 修复爱奇艺(qiyi)线路只能靠 svip.qlplayer.cyou 嗅探、嗅探失败就播不了：实测爱奇艺经官网解析接口蓝光(muh2fkp2)/789(mwieue15)都能拿到可播 hls 直链(200)，只是 qiyi 不在 OFFICIAL_GROUPS 导致 detail 不生成官方线路、play 点原始线路时跳过官方解析。把 qiyi 加入官方线路并用平台→路线白名单只放行实测可播的蓝光/789（洛雪4K noauth、臻享付费墙、麒麟502、蝉窨403 全部排除）。v2.2.6 修复 jimaoys94.com smart.m3u8 再次 403：宿主沙箱里原生 https（nodeRequest）访问 jimaoys94 失败时 expandMasterM3u8 会 return 原始裸 master（不带 session）→ 播放器请求必 403。改为双通道（nodeRequest → OmniBox.request）取 m3u8 文本；且假 master 只要展开失败就返回 null，绝不把不带 session 的裸 master 交给播放器——直链分支转嗅探兜底、嗅探/跨源分支跳过该候选或回退 parse=1。v2.2.5 修复芒果 TV 直链 403 Forbidden：titan.mgtv.com 等 *.mgtv.com 的 m3u8/ts 签名(pm=)已含设备指纹(mac_id/uid/version)，播放器额外带 Referer/Origin 会被判盗链→403（裸请求/只带 UA 均 200）。新增 mediaHeader() 按直链域名剔除 Referer/Origin，所有返回媒体直链的路径（直链/官方解析/嗅探/跨源兜底/sniffCompatible）统一套用。v2.2.4 修复 jimaoys94.com smart.m3u8 在 MPV 上 403 Forbidden：该 m3u8 是「假 master」，请求的 session 由脚本服务器现场签发、有时效，把不带 session 的 master 原样交给播放器 → 403。expandMasterM3u8() 改为深度展开（最多 4 层、seen 防环），一路跟到含 #EXTINF 的媒体列表；并且嗅探成功/跨源兜底/sniffCompatible 三条返回路径统一在返回 .m3u8 前先展开，杜绝任何未展开的 master 落到播放器。v2.2.3 修复 B站 4K DASH(.mpd) 在不支持 DASH 的宿主上「视频加载失败」：命中 format=dash 时保留 4K DASH 在第一位（支持 DASH 的端照常播 4K），同时嗅探一条 hls/mp4 兼容直链作为第二备选（宿主首个失败可降级）；嗅探不到就只返回 4K 单条，不做跨源重操作。v2.2.2 修复官方解析在宿主上「无授权：请从本站影片播放页打开」：playback_grant 是绑会话的，而宿主 detail 与 play 是两次独立进程、不共享内存，play 新建会话后拿旧会话的 grant 必然被拒（本地单进程 vm 测试反而是通的，容易误判）。改为会话落宿主缓存让两次调用共享（20 分钟续期），并在授权缺失时自动换新会话重新换 grant 重试一次。v2.2.0 新增官方解析线路（洛雪4K/蓝光/臻享/789/麒麟）：官网的 4K/HDR 画质不在采集站里，而是把平台播放页交给站点解析接口换直链。接入完整四段链路 POST /api/playback-session.php 取 csrf+cookie → 带 X-CSRF-Token+Cookie 请求 detail 拿 episodes[].playback_grant → GET /json-player.php?route=&url=&source=&grant= 取 data-authorization → POST /api/json-parse.php 拿 {format,url}；官方线路在详情页排最前，play 时优先走解析、命中即 parse=0 直链（hls 与 dash/.mpd 都支持），失败再回落嗅探与跨源兜底。只对 qq/bilibili/rrmj/hmdj/mgtv 生成官方线路（优酷/爱奇艺实测洛雪4K 返回 noauth），native 格式实测是付费墙直接跳过。可用 LXYY_OFFICIAL_ENABLED/LXYY_OFFICIAL_ROUTES/LXYY_OFFICIAL_GROUPS 调整。v2.1.0 对齐官网真实菜单分类：主分类改为官网侧边栏影视浏览项「电影/剧集/动漫」（官网叫剧集不叫电视剧）；电影/剧集/动漫的二级 tab 接入官网 catalog-categories.js 的 37 个真实目录分类（TMDB discover 参数完全对齐，多国家用 | 分隔）；榜单改为官网 category-tabs 的夸克/TMDB趋势/B站/奈飞四类（去「榜」字，夸克补「短剧」频道）；采集源补齐 md 魔都 / fy 官方源共 8 个；适配 trend/netflix 接口自带 TMDB id 直走 tm| 详情。v2.0.5 修复直链 m3u8 点了转圈：jimaoys 系 .m3u8 是「假 master」（单个 BANDWIDTH 变体指向带动态 session 的相对路径子列表），部分播放器卡在解析变体阶段转圈。服务端新增 expandMasterM3u8()：GET master 展开一层，直接返回绝对 session 子 m3u8 URL（内容为绝对 ts），播放器一步到位。实测 play 返回 ?session= 绝对直链。v2.0.4 修复 MPV 等外部播放器 "unrecognized file format"：平台播放页（如 svip.qlplayer.cyou/?url=…）是 HTML，MPV 当媒体打开必然失败。新增跨源直链兜底 findDirectFallback()：嗅探失败后按剧名搜 jl/mj/360zy 等源，取其 jlm3u8 线路的 .m3u8 直链 parse:0 返回，实测凡人修仙传 mgtv 播放页成功返回 jimaoys92.com 的 m3u8。v2.0.3 修复集数列表出现 "jlm3u8"：站点 jl 源有 jlm3u8/jlplayer 两个线路分组，旧版把它们合并成一条线路并把 group 名拼进每集名（"jlm3u8 第N集"）。改为按 group 拆成多条 vod_play_source，线路名体现在线路名/vod_play_from，分集名统一「第N集」不再带线路前缀。实测 jl 源拆成 jlm3u8(25集直链)/jlplayer(25集) 两条线路，jlm3u8 首集 parse:0 直链可播。v2.0.2：分集名纯数字补「第N集」、playId 精简、嗅探 Referer 按域名生成。v2.0.1 修复视频加载失败：平台播放页/解析页原先只返回 parse=1，改为先用 OmniBox.sniffVideo 嗅探真实媒体地址，命中即 parse:0 直链返回。主链路走站点自带采集站代理 /api/proxy.php，支持多源搜索、详情分集与在线播放解析；TMDB 元数据（榜单/发现）作为补充。盘搜与 PanCheck 环境变量与 影视/网盘/盘搜.js 完全统一（PANSOU_*/PANCHECK_*）。
// @version 2.2.7
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/影视库/洛雪.js

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

/* -------------------------------------------------------------------------
 * 官方解析接口（4K / HDR 画质的唯一来源）
 *
 * 站点采集站给的 episodes[].url 是**平台播放页**（腾讯/爱奇艺/B站/优酷…），
 * 清晰度由平台自己决定；官网右侧「解析线路」面板（洛雪4K / 臻享 / 蓝光 / 789 /
 * 麒麟 / 蝉窨）才是把平台页解析成 4K/HDR 直链的入口。旧版脚本没接这条链路，
 * 所以只有 mj（4K60帧）这类自带 m3u8 的采集源能出高清，官方 4K 线路始终缺失。
 *
 * 完整链路（三段，缺一不可）：
 *   1) POST /api/playback-session.php        → csrf + Cookie: sg_playback_access
 *   2) GET  /api/proxy.php?action=detail&…   → episodes[].playback_grant（带 csrf+cookie 才下发）
 *   3) GET  /json-player.php?route=<id>&url=&source=&grant=  → HTML 里的 data-authorization
 *   4) POST /api/json-parse.php {route,url,source,authorization} → { success, format, url }
 * 其中 grant 单次可复用（同一 csrf 会话内重复解析同一集结果稳定），
 * authorization 绑定单次 grant，二次使用返回「播放授权已使用，请重新解析」。
 * ------------------------------------------------------------------------- */
const OFFICIAL_ROUTES = splitConfigList(
  process.env.LXYY_OFFICIAL_ROUTES || "official_musbpyqz;official_muh2fkp2;official_muh2g0rz;official_mwieue15;official_mv83mv2y",
);
// 官网 player_codes 声明洛雪4K 只覆盖 qq/bilibili/rrmj/hmdj；其余平台不派给它，省一轮无效请求
const OFFICIAL_ROUTE_CODES = {
  official_musbpyqz: ["qq", "bilibili", "rrmj", "hmdj"],
};
// 只有这些平台线路才生成官方解析线路：其它平台（优酷/爱奇艺等）洛雪4K 实测返回 noauth，
// 生成出来就是死线路。可用 LXYY_OFFICIAL_GROUPS 覆盖。
const OFFICIAL_GROUPS = splitConfigList(
  process.env.LXYY_OFFICIAL_GROUPS || "qq;bilibili;rrmj;hmdj;mgtv;qiyi",
).map((s) => s.toLowerCase());
// 部分平台只有特定解析线路能出可播直链（实测），其余线路是 noauth/付费墙/502/403。
// 用「平台→路线白名单」收敛，避免生成一堆点了没反应的死线路。
// 爱奇艺(qiyi)：蓝光(muh2fkp2) / 789(mwieue15) 实测 200 application/vnd.apple.mpegurl；
//                洛雪4K noauth、臻享 302 付费墙、麒麟 502、蝉窨 json-manifest 403。
const OFFICIAL_GROUP_ROUTES = {
  qiyi: ["official_muh2fkp2", "official_mwieue15"],
};
function officialRouteAllowed(routeId, groupCode) {
  const allow = OFFICIAL_ROUTE_CODES[routeId];
  if (allow && allow.length && allow.indexOf(groupCode) < 0) return false;
  const groupRoutes = OFFICIAL_GROUP_ROUTES[groupCode];
  if (groupRoutes && groupRoutes.length && groupRoutes.indexOf(routeId) < 0) return false;
  return true;
}
const OFFICIAL_ENABLED = String(process.env.LXYY_OFFICIAL_ENABLED || "true").toLowerCase() !== "false";
const OFFICIAL_TIMEOUT = Number(process.env.LXYY_OFFICIAL_TIMEOUT || 25000);
const OFFICIAL_CACHE_TTL = Number(process.env.LXYY_OFFICIAL_CACHE_TTL || 900);

// 解析线路显示名，与官网「解析线路」面板一致
const OFFICIAL_ROUTE_NAMES = {
  official_musbpyqz: "洛雪4K",
  official_muh2fkp2: "蓝光",
  official_muh2g0rz: "臻享",
  official_mwieue15: "789",
  official_mv83mv2y: "麒麟",
  official_mv49v5qz: "蝉窨",
};

let playbackSession = null; // { csrf, cookie, at }

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

/* ==========================================================================
 * 官方解析接口（4K / HDR 直链）
 * ========================================================================== */

function collectSetCookie(headers) {
  const raw = headers && (headers["set-cookie"] || headers["Set-Cookie"]);
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map((c) => String(c).split(";")[0].trim()).filter(Boolean).join("; ");
}

/** 取播放会话（csrf + sg_playback_access cookie），进程内复用，过期自动重建。 */
const PLAYBACK_SESSION_CACHE_KEY = "lxyy:playback_session";
const PLAYBACK_SESSION_TTL = 20 * 60; // 秒；站点 cookie 约 24h，20 分钟续一次足够稳

/**
 * 取播放会话（csrf + sg_playback_access cookie）。
 *
 * 关键：宿主是「detail 一次进程、play 一次进程」，两次不共享内存。
 * 而 playback_grant 是**绑会话**的——A 会话拿到的 grant 在 B 会话里用，
 * 站点返回「请从本站影片播放页打开」。所以会话必须落宿主缓存让两次调用共享，
 * 否则 play 永远拿不到 4K 授权（本地单进程 vm 测试反而是通的，容易误判）。
 */
async function ensurePlaybackSession(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && playbackSession && now - playbackSession.at < PLAYBACK_SESSION_TTL * 1000) {
    return playbackSession;
  }
  if (!forceRefresh) {
    const cached = await getCachedJson(PLAYBACK_SESSION_CACHE_KEY);
    if (cached && cached.csrf && cached.at && now - Number(cached.at) < PLAYBACK_SESSION_TTL * 1000) {
      playbackSession = { csrf: String(cached.csrf), cookie: String(cached.cookie || ""), at: Number(cached.at) };
      logInfo(`官方解析 复用缓存会话 csrf=${playbackSession.csrf.slice(0, 10)}`);
      return playbackSession;
    }
  }
  const res = await nodeRequest(`${HOST}/api/playback-session.php`, { method: "POST" }, {
    "User-Agent": UA,
    Referer: `${HOST}/`,
    Origin: HOST,
    Accept: "application/json, text/plain, */*",
  });
  let csrf = "";
  try {
    csrf = String(JSON.parse(res.body || "{}").csrf || "");
  } catch (_) { /* 下面统一判空 */ }
  if (!csrf) throw new Error(`播放会话获取失败 HTTP ${res.statusCode}`);
  const cookie = collectSetCookie(res.headers);
  playbackSession = { csrf, cookie, at: now };
  await setCachedJson(PLAYBACK_SESSION_CACHE_KEY, playbackSession, PLAYBACK_SESSION_TTL);
  logInfo(`官方解析 新建会话 csrf=${csrf.slice(0, 10)} cookie=${cookie ? "有" : "无"}`);
  return playbackSession;
}

/** 带 csrf + cookie 取详情：只有这种请求才会下发 episodes[].playback_grant。 */
async function proxyDetailWithGrant(id, source) {
  const session = await ensurePlaybackSession();
  const headers = {
    "User-Agent": UA,
    Referer: `${HOST}/`,
    Accept: "application/json, text/plain, */*",
    "X-CSRF-Token": session.csrf,
  };
  if (session.cookie) headers.Cookie = session.cookie;
  const res = await nodeRequest(proxyUrl("detail", { id: String(id), source: String(source) }), {}, headers);
  if (Number(res.statusCode) < 200 || Number(res.statusCode) >= 300) {
    throw new Error(`详情 HTTP ${res.statusCode}`);
  }
  let data;
  try {
    data = JSON.parse(res.body || "{}");
  } catch (_) {
    throw new Error("详情返回非 JSON");
  }
  const detail = (Array.isArray(data.details) ? data.details[0] : null) || null;
  return detail;
}

/**
 * 用官方解析接口把平台播放页解析成直链。
 * @param {string} playPageUrl 平台播放页（采集站 episodes[].url）
 * @param {string} source      采集站源名（qilin/mj/…）
 * @param {object} opts        { grant, routeId, collectId, group }
 * @returns {Promise<{url:string, format:string, routeId:string, routeName:string}|null>}
 */
async function parseOfficial(playPageUrl, source, opts = {}) {
  if (!OFFICIAL_ENABLED) return null;
  const target = String(playPageUrl || "").trim();
  if (!target) return null;

  let grant = String(opts.grant || "");
  // playId 里没带 grant（旧 playId 或 detail 未取到）时，用采集站 id 重新换一次
  if (!grant && opts.collectId) {
    try {
      const detail = await proxyDetailWithGrant(opts.collectId, source);
      grant = findGrantByUrl(detail, target);
    } catch (error) {
      logInfo(`官方解析 取 grant 失败: ${error && error.message ? error.message : error}`);
    }
  }
  // grant 绑会话：宿主 detail 与 play 是两次进程，playId 里的 grant 可能属于上一个会话。
  // 这种情况下站点会返回「请从本站影片播放页打开」，用当前会话重新换一次即可。
  let session = null;
  let refreshed = false;
  const refreshGrant = async () => {
    if (refreshed || !opts.collectId) return false;
    refreshed = true;
    try {
      // 必须换新会话再取 grant：旧会话下的 grant 在新会话里无效
      session = await ensurePlaybackSession(true);
      const detail = await proxyDetailWithGrant(opts.collectId, source);
      const next = findGrantByUrl(detail, target);
      if (!next) return false;
      grant = next;
      logInfo("官方解析 会话变更，已重新换取 grant");
      return true;
    } catch (error) {
      logInfo(`官方解析 换 grant 失败: ${error && error.message ? error.message : error}`);
      return false;
    }
  };

  const group = String(opts.group || "").toLowerCase();
  const routeIds = opts.routeId
    ? [String(opts.routeId)]
    : OFFICIAL_ROUTES.filter((id) => officialRouteAllowed(id, group));
  if (!routeIds.length) return null;

  session = await ensurePlaybackSession();
  for (const routeId of routeIds) {
    const routeName = OFFICIAL_ROUTE_NAMES[routeId] || routeId;
    try {
      const playerUrl = `${HOST}/json-player.php?route=${encodeURIComponent(routeId)}`
        + `&url=${encodeURIComponent(target)}`
        + `&source=${encodeURIComponent(source || "")}`
        + (grant ? `&grant=${encodeURIComponent(grant)}` : "");
      const pageRes = await nodeRequest(playerUrl, {}, {
        "User-Agent": UA,
        Referer: `${HOST}/`,
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      });
      const html = String(pageRes.body || "");
      let authMatch = html.match(/data-authorization="([^"]*)"/);
      if (!authMatch || !authMatch[1]) {
        const errMatch = html.match(/data-authorization-error="([^"]*)"/);
        const reason = errMatch ? errMatch[1] : "unknown";
        // 授权缺失多因会话不匹配：换 grant 后用同一线路重试一次
        if (await refreshGrant()) {
          const retryUrl = `${HOST}/json-player.php?route=${encodeURIComponent(routeId)}`
            + `&url=${encodeURIComponent(target)}`
            + `&source=${encodeURIComponent(source || "")}`
            + (grant ? `&grant=${encodeURIComponent(grant)}` : "");
          const retryRes = await nodeRequest(retryUrl, {}, {
            "User-Agent": UA,
            Referer: `${HOST}/`,
            ...(session.cookie ? { Cookie: session.cookie } : {}),
          });
          authMatch = String(retryRes.body || "").match(/data-authorization="([^"]*)"/);
          if (authMatch && authMatch[1]) {
            logInfo(`官方解析 ${routeName} 换 grant 后重试成功`);
          } else {
            logInfo(`官方解析 ${routeName} 无授权: ${reason}`);
            continue;
          }
        } else {
          logInfo(`官方解析 ${routeName} 无授权: ${reason}`);
          continue;
        }
      }

      const payload = JSON.stringify({
        route: routeId,
        url: target,
        source: String(source || ""),
        authorization: authMatch[1],
      });
      const parseRes = await nodeRequest(`${HOST}/api/json-parse.php`, { method: "POST", body: payload }, {
        "User-Agent": UA,
        Referer: `${HOST}/`,
        Origin: HOST,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      });
      let parsed;
      try {
        parsed = JSON.parse(parseRes.body || "{}");
      } catch (_) {
        logInfo(`官方解析 ${routeName} 返回非 JSON (HTTP ${parseRes.statusCode})`);
        continue;
      }
      if (!parsed.success || !parsed.url) {
        logInfo(`官方解析 ${routeName} 失败: ${parsed.message || parsed.error || "unknown"}`);
        continue;
      }
      const mediaUrl = String(parsed.url);
      const format = String(parsed.format || "").toLowerCase();
      // native 实测 302 后是 402 付费墙（DEPLOYMENT_DISABLED），当直链返回只会让播放器报错
      if (format === "native") {
        logInfo(`官方解析 ${routeName} 返回 native（付费墙），跳过`);
        continue;
      }
      logInfo(`官方解析 ${routeName} 成功 format=${format || "-"} url=${mediaUrl.slice(0, 90)}`);
      return { url: mediaUrl, format, routeId, routeName };
    } catch (error) {
      logInfo(`官方解析 ${routeName} 异常: ${error && error.message ? error.message : error}`);
    }
  }
  return null;
}

/** play() 用的官方解析入口：指定线路优先，未指定则按 OFFICIAL_ROUTES 顺序试。 */
async function tryOfficial(meta) {
  if (!OFFICIAL_ENABLED || !meta) return null;
  // 未指定解析线路（即用户点的是采集站原始线路）时，只有平台在 OFFICIAL_GROUPS 里才顺带升级画质：
  // 优酷/爱奇艺这类平台洛雪4K 返回 noauth，硬试只会给每次播放多加 4~5 次无效请求。
  if (!meta.r) {
    const group = String(meta.g || "").toLowerCase();
    if (OFFICIAL_GROUPS.indexOf(group) < 0) return null;
  }
  try {
    return await parseOfficial(meta.u, meta.s, {
      grant: meta.n,
      routeId: meta.r,
      collectId: meta.i,
      group: meta.g,
    });
  } catch (error) {
    logInfo(`官方解析整体失败: ${error && error.message ? error.message : error}`);
    return null;
  }
}

/** 在 detail.episodes 里按 url 精确匹配，取该集的 playback_grant。 */
function findGrantByUrl(detail, target) {
  const groups = Array.isArray(detail && detail.episodes) ? detail.episodes : [];
  for (const group of groups) {
    const eps = Array.isArray(group && group.episodes) ? group.episodes : [];
    for (const ep of eps) {
      if (String((ep && ep.url) || "").trim() === String(target).trim()) {
        return String((ep && ep.playback_grant) || "");
      }
    }
  }
  return "";
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

function buildEpisodeMeta(detail, url, extra) {
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
  if (extra && extra.g) meta.g = String(extra.g);       // 平台线路代码（qq/bilibili/…）
  if (extra && extra.n) meta.n = String(extra.n);       // playback_grant，解析接口必带
  if (extra && extra.r) meta.r = String(extra.r);       // 指定解析线路 id
  return `px|${Buffer.from(JSON.stringify(meta), "utf8").toString("base64")}`;
}

// 按站点线路分组拆成多条 vod_play_source：线路名（如 jlm3u8/jlplayer）体现在线路名上，
// 不再拼进每个分集名——否则列表里每集都带 "jlm3u8 第N集"，看起来像乱码/异常。
//
// withOfficial=true 时额外为「官方解析线路」生成独立线路（洛雪4K/蓝光/臻享…）：
// 官网这些线路是把平台播放页交给解析接口拿 4K/HDR 直链的，采集站本身不提供，
// 所以必须单独列出来，否则用户看不到 4K 选项。
function buildProxySources(detail, fallbackName) {
  const groups = Array.isArray(detail && detail.episodes) ? detail.episodes : [];
  const sources = [];
  groups.forEach((group, gi) => {
    const groupName = normalizeText(group && group.group) || `线路${gi + 1}`;
    const groupCode = String((group && group.group) || "").toLowerCase();
    const eps = Array.isArray(group && group.episodes) ? group.episodes : [];
    const episodes = [];
    eps.forEach((ep, ei) => {
      const url = String((ep && ep.url) || "").trim();
      if (!url) return;
      episodes.push({
        name: normalizeEpisodeName(ep && ep.name, ei),
        playId: buildEpisodeMeta(detail, url, { g: groupCode, n: ep && ep.playback_grant }),
      });
    });
    if (episodes.length) sources.push({ name: normalizeText(fallbackName) || groupName, episodes });
  });
  return sources;
}

// 官方解析线路（洛雪4K/蓝光/臻享/789/麒麟）。
// 官网这些线路是把平台播放页交给 /json-player.php + /api/json-parse.php 换 4K/HDR 直链，
// 采集站本身不提供这些画质——不单独列出来，用户在播放器里就永远看不到 4K 选项。
// 只对 OFFICIAL_GROUPS 里的平台生成：优酷/爱奇艺实测洛雪4K 返回 noauth，生成出来是死线路。
function buildOfficialSources(detail) {
  if (!OFFICIAL_ENABLED) return [];
  const groups = Array.isArray(detail && detail.episodes) ? detail.episodes : [];
  const sources = [];
  groups.forEach((group) => {
    const groupCode = String((group && group.group) || "").toLowerCase();
    if (OFFICIAL_GROUPS.indexOf(groupCode) < 0) return;
    const eps = Array.isArray(group && group.episodes) ? group.episodes : [];
    if (!eps.length) return;
    OFFICIAL_ROUTES.forEach((routeId) => {
      if (!officialRouteAllowed(routeId, groupCode)) return;
      const routeName = OFFICIAL_ROUTE_NAMES[routeId] || routeId;
      const routeEpisodes = [];
      eps.forEach((ep, ei) => {
        const url = String((ep && ep.url) || "").trim();
        if (!url) return;
        routeEpisodes.push({
          name: normalizeEpisodeName(ep && ep.name, ei),
          playId: buildEpisodeMeta(detail, url, { g: groupCode, n: ep && ep.playback_grant, r: routeId }),
        });
      });
      if (routeEpisodes.length) sources.push({ name: `${routeName}·${groupCode}`, episodes: routeEpisodes });
    });
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
  // 必须带 csrf + cookie 请求详情，否则 episodes[].playback_grant 不下发，
  // 官方解析线路（4K/HDR）就无从换授权。拿不到会话时降级为普通详情，功能不受影响。
  let d = null;
  try {
    d = await proxyDetailWithGrant(id, source);
  } catch (error) {
    logInfo(`[detail] 带授权取详情失败，降级普通详情: ${error && error.message ? error.message : error}`);
  }
  if (!d) d = await proxyDetail(id, source);
  if (!d) return null;
  let sources = buildProxySources(d);
  // 集数只按采集站原始线路统计，不能把官方解析线路（同一批集的复制品）算进去
  const totalEps = sources.reduce((n, s) => n + s.episodes.length, 0);
  const officialSources = buildOfficialSources(d);
  if (officialSources.length) {
    // 官方解析线路排最前：官网优先度也是「洛雪4K > 4K60帧 > 其它官采 > 普通线路」
    sources = officialSources.concat(sources);
    logInfo(`[detail] ${normalizeText(d.name)} 官方解析线路 ${officialSources.map((s) => s.name).join(",")}`);
  }
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
  // mpd = MPEG-DASH 清单：B站/部分官采线路的 4K 只给 .mpd（format=dash），
  // 缺这个后缀会被当成 HTML 页去做嗅探，白白丢掉 4K 直链。
  return /\.(m3u8|mpd|mp4|flv|mkv|ts)(\?|$)/i.test(String(url || ""));
}

// 按直链域名修正交给播放器的 header。
// 芒果 Titan 直链（titan.mgtv.com 等 *.mgtv.com）的 pm= 签名里已含设备指纹
// （mac_id/uid/version），播放器额外带 Referer 或 Origin 会被判盗链 → 403 Forbidden。
// 实测：裸请求或只带 User-Agent 返回 200（m3u8 与 ts 分片均是），带任意 Referer
// （tv.lxyy.club / www.mgtv.com）全部 403。故返回这类直链时必须剔除 Referer/Origin。
function mediaHeader(url, baseHeader = {}) {
  const h = Object.assign({}, baseHeader);
  let host = "";
  try { host = String(new URL(url).hostname || "").toLowerCase(); } catch (_) {}
  if (/(^|\.)mgtv\.com$/.test(host)) {
    for (const k of Object.keys(h)) {
      if (/^referer$/i.test(k) || /^origin$/i.test(k)) delete h[k];
    }
  }
  return h;
}

// 部分站点的 .m3u8 是「假 master」：只有一个 BANDWIDTH 变体，指向带动态 session
// 的相对路径子列表（如 jimaoys94.com 的 smart.m3u8 → smart.m3u8?session=<64hex>）。
// 这种 session 由脚本服务器请求时签发、有时效且和签发环境绑定；把 master 原样交给
// 播放器（MPV/内置内核）时，播放器侧拿不到有效 session → 403 Forbidden。
// 所以服务端一路展开到「含 #EXTINF 的媒体列表」再返回，播放器直接用最终地址。
// 双通道取 m3u8 文本：宿主沙箱里 require("https") 未必可用（nodeRequest 会失败），
// 此时回退到宿主原生 OmniBox.request。两条通道都不通时返回 null。
async function fetchMasterText(url, headers = {}) {
  const reqHeaders = { "User-Agent": UA, ...headers };
  try {
    const res = await nodeRequest(url, { timeout: 15000 }, reqHeaders);
    if (res && res.statusCode === 200 && res.body) return res.body;
  } catch (_) { /* 回退宿主通道 */ }
  if (typeof OmniBox.request === "function") {
    try {
      const res = await OmniBox.request(url, { method: "GET", headers: reqHeaders });
      if (res && res.statusCode === 200 && res.body) return res.body;
    } catch (_) { /* 两通道都失败 */ }
  }
  return null;
}

// 已知「假 master」域名特征：jimaoys 系采集站的 smart.m3u8，
// 不带 session 参数时播放器请求必 403，请求失败时绝不把裸 master 漏出去。
function looksLikeFakeMaster(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();
    if (!/jimaoys\d*\.com$/.test(host)) return false;
    // 带 session= 的已经是展开后的子列表，不是裸 master
    return !/[?&]session=/.test(u.search);
  } catch (_) { return false; }
}

// 返回：展开成功→最终媒体列表 URL；本来就是媒体列表→原 URL；
// 假 master 展开失败→null（绝不返回不带 session 的裸 master，交给播放器必然 403）。
async function expandMasterM3u8(masterUrl, headers = {}) {
  let current = masterUrl;
  const seen = new Set();
  let isFakeMaster = false;
  try {
    for (let depth = 0; depth < 4; depth++) {
      if (seen.has(current)) break;
      seen.add(current);
      const text = await fetchMasterText(current, headers);
      if (text == null) {
        // 请求失败：jimaoys 系裸 master（不带 session）交给播放器必 403，必须返回 null 转兜底；
        // 其它直链（akamaized/腾讯 CDN 等）只是我们这边读不到，播放器自身可能能播，返回原 URL 保留机会。
        if (looksLikeFakeMaster(current) || isFakeMaster) {
          logInfo(`play 假 master 请求失败，放弃该地址转兜底 ${current.slice(0, 90)}`);
          return null;
        }
        logInfo(`play m3u8 请求失败，仍返回原地址交播放器 ${current.slice(0, 90)}`);
        return current;
      }
      const trimmed = text.trim();
      if (!/#EXT-X-STREAM-INF/i.test(trimmed)) return current; // 已是媒体列表，展开到位
      isFakeMaster = true;
      const lines = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const child = lines.find((line) => !line.startsWith("#") && /^https?:\/\//i.test(line));
      const childRel = child || lines.find((line) => !line.startsWith("#"));
      if (!childRel) {
        logInfo(`play 假 master 无子列表，放弃 ${masterUrl.slice(0, 90)}`);
        return null;
      }
      const next = new URL(childRel, current).toString();
      if (next === current || seen.has(next)) {
        logInfo(`play 假 master 展开成环/超限，放弃 ${masterUrl.slice(0, 90)}`);
        return null;
      }
      logInfo(`play 展开假 master 第${depth + 1}层 → ${next.slice(0, 90)}`);
      current = next;
    }
    if (isFakeMaster) {
      logInfo(`play 假 master 超过 4 层，放弃 ${masterUrl.slice(0, 90)}`);
      return null;
    }
  } catch (error) {
    logInfo(`play master 展开失败: ${error && error.message ? error.message : error}`);
    if (isFakeMaster) return null;
  }
  return current;
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
              return { url: u.u, header: mediaHeader(u.u, { "User-Agent": UA, Referer: `${HOST}/` }), flag: src.name || c.source };
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

/**
 * 嗅探一条 hls/mp4 兼容直链，用作 DASH(.mpd) 的降级备选。
 * 只取 m3u8/mp4，跳过 .mpd（否则和官方 4K 线路重复，失去降级意义）。
 */
async function sniffCompatible(meta, header) {
  if (typeof OmniBox.sniffVideo !== "function") return null;
  const candidates = [];
  const playerPage = buildPlayerPageUrl(meta.p, meta.u);
  if (playerPage) candidates.push(playerPage);
  candidates.push(meta.u);
  for (const page of candidates.slice(0, 2)) {
    try {
      let referer = `${HOST}/`;
      try { referer = `${new URL(page).origin}/`; } catch (_) { /* 保留默认 */ }
      const sniffed = await OmniBox.sniffVideo(page, { ...header, Referer: referer });
      const url = sniffed && (sniffed.url || sniffed.mediaUrl);
      if (url && /^https?:\/\//i.test(String(url)) && !/\.mpd(\?|$)/i.test(String(url))) {
        // 兼容备选同样可能是「假 master」（jimaoys94 之类），展开到媒体列表再交给播放器
        let finalUrl = String(url);
        if (/\.m3u8(\?|$)/i.test(finalUrl)) {
          finalUrl = await expandMasterM3u8(finalUrl, sniffed.header || {});
          if (!finalUrl) continue; // 假 master 展开失败，跳过该候选，绝不把裸 master 交给播放器
        }
        return { url: finalUrl, header: mediaHeader(finalUrl, sniffed.header || {}) };
      }
    } catch (_) { /* 单条失败继续下一条 */ }
  }
  // 不做跨源兜底：那是重操作（多轮 proxy 请求 + 可能触发站点限流），
  // 且按剧名搜来的资源可能和当前剧集不是同一部，不宜当兼容备选。
  return null;
}

async function play(params, context) {
  const rawId = String((params && (params.playId || params.id)) || "").trim();
  const from = (context && context.from) || "web";
  logInfo(`play 入口 playId=${rawId.slice(0, 70)} from=${from}`);
  if (!rawId) return { urls: [], flag: "洛雪", parse: 0, header: {} };

  const header = { "User-Agent": UA, Referer: `${HOST}/` };

  try {
    // A) 采集站分集（主链路）
    const meta = decodePlayId(rawId);
    if (meta) {
      let directUrl = "";
      if (isDirectMedia(meta.u)) {
        directUrl = meta.u;
        if (/\.m3u8(\?|$)/i.test(meta.u)) {
          const expanded = await expandMasterM3u8(meta.u, header);
          if (expanded) directUrl = expanded;
          else {
            // 假 master 且展开失败：directUrl 留空，绝把裸 master 交给播放器（必 403），
            // 落到下面的解析页嗅探 / 跨源兜底。
            directUrl = "";
            logInfo(`play 直链是假 master 且展开失败，转嗅探兜底 ${meta.u.slice(0, 70)}`);
          }
        }
        if (directUrl) {
          logInfo(`play 直链 ${meta.t || ""} ${directUrl.slice(0, 70)}`);
          return { urls: [{ name: "直链", url: directUrl }], flag: meta.g || "洛雪", parse: 0, header: mediaHeader(directUrl, header) };
        }
      }

      const urls = [];
      const playerPage = buildPlayerPageUrl(meta.p, meta.u);
      if (playerPage) urls.push({ name: meta.g || "解析播放", url: playerPage });
      urls.push({ name: "原始播放页", url: meta.u });

      logInfo(`play 解析入口=${playerPage ? "有" : "无"} src=${meta.s}/${meta.i} 线路=${meta.g || "-"} page=${meta.u.slice(0, 60)}`);

      // 官方解析线路（洛雪4K/蓝光/臻享…）：站点把平台播放页交给解析接口换 4K/HDR 直链，
      // 这是全站唯一能拿到 4K 的通道，且优先级最高——有就直接用，不必再嗅探。
      // 命中 format=hls 直接返回；命中的是 format=dash(.mpd) 时，B站 4K 只有 DASH 一种格式，
      // 而 TVBox/UZ/CatVod 及部分 web 内核不支持 DASH 清单（见 HStream.js 同类处理），
      // 所以额外嗅探一条 hls/mp4 兼容备选，宿主首个失败时可降级，不牺牲支持 DASH 的端的 4K。
      const official = await tryOfficial(meta);
      if (official) {
        logInfo(`play 官方解析命中 线路=${official.routeName} format=${official.format || "-"} ${official.url.slice(0, 90)}`);
        const resultUrls = [{ name: official.routeName, url: official.url }];
        if (official.format === "dash") {
          const compat = await sniffCompatible(meta, header);
          if (compat && compat.url && compat.url !== official.url) {
            resultUrls.push({ name: `${meta.g || "平台"}·兼容`, url: compat.url });
            logInfo(`play 追加 DASH 兼容备选 ${compat.url.slice(0, 80)}`);
          }
        }
        return {
          urls: resultUrls,
          flag: official.routeName,
          parse: 0,
          header: mediaHeader(official.url, header),
        };
      }

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
              // 嗅探命中的也可能是「假 master」（jimaoys94 之类），展开后再交给播放器，
              // 否则播放器请求不带 session 的 master → 403 Forbidden。
              let finalUrl = String(sniffUrl);
              if (/\.m3u8(\?|$)/i.test(finalUrl)) {
                finalUrl = await expandMasterM3u8(finalUrl, sniffed.header || {});
                if (!finalUrl) {
                  logInfo(`play 嗅探结果是假 master 且展开失败，跳过该候选`);
                  continue; // 绝不把裸 master 交给播放器
                }
              }
              return {
                urls: [{ name: meta.g || "解析播放", url: finalUrl }],
                flag: meta.g || "洛雪",
                parse: 0,
                // 芒果等站点直链禁止 Referer/Origin，按域名剔除后再交给播放器
                header: mediaHeader(finalUrl, Object.assign({}, header, sniffed.header || {})),
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
        // 跨源兜底拿到的同样可能是「假 master」（jimaoys94 之类），展开后再返回。
        let directUrl = direct.url;
        if (/\.m3u8(\?|$)/i.test(directUrl)) {
          const expanded = await expandMasterM3u8(directUrl, direct.header || {});
          if (expanded) directUrl = expanded;
          else {
            logInfo(`play 跨源直链是假 master 且展开失败，放弃该兜底 ${directUrl.slice(0, 70)}`);
            directUrl = "";
          }
        }
        if (!directUrl) {
          // 跨源兜底也是假 master 且展开失败：回退 parse=1（ok影视 可自行嗅探）
          return { urls, flag: meta.g || "洛雪", parse: 1, header };
        }
        logInfo(`play 返回跨源直链 ${directUrl.slice(0, 80)}`);
        return { urls: [{ name: direct.flag || "直链", url: directUrl }], flag: direct.flag || "洛雪", parse: 0, header: mediaHeader(directUrl, direct.header || {}) };
      }
      // 直链兜底也失败：回退 parse=1（ok影视 可继续嗅探），解析入口排在原始页前面
      return { urls, flag: meta.g || "洛雪", parse: 1, header };
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
      return { urls: [], flag: "洛雪", parse: 0, header };
    }
    if (!keyword) {
      logError(`play 缺少搜索关键词 ${rawId.slice(0, 40)}`);
      return { urls: [], flag: "洛雪", parse: 0, header };
    }

    let items = await panSearch(keyword);
    if (!items || !items.length) {
      logInfo(`play 盘搜无结果 ${keyword}`);
      return { urls: [], flag: "洛雪", parse: 0, header };
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
    return { urls, flag: "洛雪", parse: 0, header };
  } catch (error) {
    logError(`play 失败 ${rawId.slice(0, 50)}`, error);
    return { urls: [], flag: "洛雪", parse: 0, header };
  }
}
