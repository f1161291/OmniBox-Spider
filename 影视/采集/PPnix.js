// @name PPnix
// @author 梦
// @description 刮削：暂不支持，弹幕：暂不支持，分类筛选：支持，播放链：兼容 TVBox；v2.0.0 彻底修复视频加载失败：实测原始直链分段经 ipfs.ppnix.com 随机 302 到不稳定网关（仅 2/5 分段正常），而 data: URL 播放器不支持。方案：内置轻量 HTTP 代理服务（独立进程 --pp-server，默认端口 10009，可用 PPNIX_PROXY_PORT/PPNIX_PROXY_BASE/HOST_IP 配置），play 返回 http://IP:10009/playlist.m3u8?infoId=&param=（普通 http URL），代理内部把 AES key 内联为 data URI + 分段固定到实测 206+Content-Range+CORS* 的 ipfs.aleph.cloud。端到端实测 12/12 分段 206 且 TS 解密 100% 正确。PPNIX_REWRITE_M3U8=0 可回退原始直链。
// @dependencies: axios, cheerio
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/PPnix.js

const OmniBox = require("omnibox_sdk");
const cheerio = require("cheerio");
const axios = require("axios");
const runner = require("spider_runner");
const http = require("http");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

// ---- 轻量 m3u8 代理服务：把 key 内联、分段固定到稳定网关，对外仍提供 http URL ----
const PP_PROXY_PORT = Number(process.env.PPNIX_PROXY_PORT || 10009);
const PP_PROXY_BASE = String(process.env.PPNIX_PROXY_BASE || "").trim();
const PP_PROXY_HOST_IP = String(process.env.HOST_IP || "").trim();
const IS_PP_SERVER = process.argv.includes("--pp-server");

const BASE_URL = process.env.PPNIX_HOST || "https://www.ppnix.com";
const BASE_PATH = process.env.PPNIX_LANG_PATH || "/cn";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const CATEGORIES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv", type_name: "电视剧" },
];

function normalizeBasePath(path = "") {
  const p = String(path || "").trim();
  if (!p) return "/cn";
  return p.startsWith("/") ? p.replace(/\/+$/, "") : `/${p.replace(/\/+$/, "")}`;
}

const LANG_PATH = normalizeBasePath(BASE_PATH);

// 分段网关：ipfs.ppnix.com 每次随机 302 到不稳定第三方网关（部分忽略 Range / 失效），
// 直接固定到实测支持 Range(206) 的 ipfs.aleph.cloud，避免播放器加载分段失败。
const PPNIX_SEGMENT_HOST = process.env.PPNIX_SEGMENT_HOST || "https://ipfs.aleph.cloud";
// 默认走本地代理服务（http m3u8，key 内联 + 分段固定稳定网关 ipfs.aleph.cloud）。
// 原始直链的分段随机 302 到不稳定网关（实测仅 2/5 分段正常），data: URL 播放器不支持，
// 故用轻量 HTTP 代理提供重写后的 m3u8。设 PPNIX_REWRITE_M3U8=0 可回退原始直链。
const PPNIX_REWRITE_M3U8 = process.env.PPNIX_REWRITE_M3U8 !== "0";
const PPNIX_CF_COOKIE = process.env.PPNIX_CF_COOKIE || process.env.PPNIX_COOKIE || "";
// 站点当前直连 200，无需 CF；仅显式 PPNIX_CF_AUTO=1 且真正遇到 403/503 时才启用绕过，
// 避免每次播放都空跑 FlareSolverr/Chromium 拖垮启播。
const PPNIX_CF_AUTO = process.env.PPNIX_CF_AUTO === "1";
const PPNIX_CF_CACHE_KEY = process.env.PPNIX_CF_CACHE_KEY || "ppnix:cf_clearance";
const PPNIX_CF_MAX_AGE_SECONDS = parseInt(process.env.PPNIX_CF_MAX_AGE_SECONDS || "21600", 10) || 21600;
const PPNIX_CF_TIMEOUT_MS = parseInt(process.env.PPNIX_CF_TIMEOUT_MS || "45000", 10) || 45000;
// FlareSolverr 服务地址，优先读取站点专用变量，其次回退通用 FLARESOLVERR_URL。
// 项目地址：https://github.com/FlareSolverr/FlareSolverr
const PPNIX_FLARESOLVERR_URL = process.env.PPNIX_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || "";
// FlareSolverr 会话名，用于复用已过验证的浏览器会话。
const PPNIX_FLARESOLVERR_SESSION = process.env.PPNIX_FLARESOLVERR_SESSION || "";
// FlareSolverr 单次请求最大等待时间（毫秒），默认沿用 CF 自动处理超时配置。
const PPNIX_FLARESOLVERR_TIMEOUT_MS = parseInt(process.env.PPNIX_FLARESOLVERR_TIMEOUT_MS || String(PPNIX_CF_TIMEOUT_MS), 10) || PPNIX_CF_TIMEOUT_MS;
const PPNIX_ENABLE_SUBTITLES = process.env.PPNIX_ENABLE_SUBTITLES === "1";
const execFileAsync = promisify(execFile);

const SORT_MAP = {
  time: "newstime",
  hits: "onclick",
  score: "rating",
  newstime: "newstime",
  onclick: "onclick",
  rating: "rating",
};

function joinUrl(path = "") {
  const raw = String(path || "").trim();
  if (!raw) return `${BASE_URL}${LANG_PATH}/`;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
  return `${BASE_URL}/${raw}`;
}

function buildCookieHeader(cookie = "") {
  const value = text(cookie);
  return value ? { Cookie: value } : {};
}

function toCookieString(cookieMap = {}) {
  return Object.entries(cookieMap || {})
    .map(([k, v]) => [text(k), text(v)])
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function cookiesArrayToString(cookies = []) {
  return (Array.isArray(cookies) ? cookies : [])
    .map((item) => ({ name: text(item?.name || ""), value: text(item?.value || "") }))
    .filter((item) => item.name && item.value)
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
}

async function getCachedCfCookie() {
  if (text(PPNIX_CF_COOKIE)) return text(PPNIX_CF_COOKIE);
  try {
    const cached = await OmniBox.getCache(PPNIX_CF_CACHE_KEY);
    return text(cached || "");
  } catch (error) {
    await OmniBox.log("warn", `[cf] 读取缓存失败: ${error.message}`);
    return "";
  }
}

async function setCachedCfCookie(cookie) {
  const value = text(cookie);
  if (!value || text(PPNIX_CF_COOKIE)) return;
  try {
    await OmniBox.setCache(PPNIX_CF_CACHE_KEY, value, PPNIX_CF_MAX_AGE_SECONDS);
  } catch (error) {
    await OmniBox.log("warn", `[cf] 写入缓存失败: ${error.message}`);
  }
}

async function fetchCfClearanceWithFlareSolverr(targetUrl = `${BASE_URL}${LANG_PATH}/`) {
  const endpoint = text(PPNIX_FLARESOLVERR_URL);
  if (!endpoint) {
    throw new Error("未配置 FlareSolverr 地址");
  }

  const payload = {
    cmd: "request.get",
    url: targetUrl,
    maxTimeout: PPNIX_FLARESOLVERR_TIMEOUT_MS,
  };
  if (text(PPNIX_FLARESOLVERR_SESSION)) {
    payload.session = text(PPNIX_FLARESOLVERR_SESSION);
  }

  const res = await axios.post(endpoint, payload, {
    timeout: PPNIX_FLARESOLVERR_TIMEOUT_MS + 5000,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    validateStatus: () => true,
  });

  if (res.status !== 200 || !res.data || res.data.status !== "ok") {
    throw new Error(`FlareSolverr HTTP ${res.status}`);
  }

  const solution = res.data.solution || {};
  const cookies = Array.isArray(solution.cookies) ? solution.cookies : [];
  const cookie = cookiesArrayToString(cookies);
  const cf = cookies.find((item) => text(item?.name) === "cf_clearance" && /ppnix\.com$/i.test(text(item?.domain || "ppnix.com")));

  if (!cf?.value) {
    throw new Error(`FlareSolverr 未返回 cf_clearance，message=${text(res.data.message || "") || "unknown"}`);
  }

  await OmniBox.log("info", `[cf] FlareSolverr 已返回 cookies=${cookies.length}, ua=${text(solution.userAgent || "")}`);
  return cookie;
}

async function fetchCfClearanceWithBrowser() {
  const script = String.raw`
const { execFile } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const execFileAsync = promisify(execFile);
const BASE_URL = process.env.PPNIX_BASE_URL;
const USER_AGENT = process.env.PPNIX_USER_AGENT;
const timeoutMs = Number(process.env.PPNIX_CF_TIMEOUT_MS || 45000);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function waitForDebugger(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const info = await getJson("http://127.0.0.1:" + port + "/json/version");
      if (info && info.webSocketDebuggerUrl) return info;
    } catch (_) {}
    await delay(500);
  }
  throw new Error("等待 Chromium 调试端口超时");
}

async function readCookies(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const res = await send("Storage.getCookies", {});
  ws.close();
  return (res.result && res.result.cookies) || [];
}

(async () => {
  const port = 9223 + Math.floor(Math.random() * 200);
  const userDataDir = await execFileAsync("mktemp", ["-d", "/tmp/ppnix-cf-XXXXXX"]);
  const profileDir = String(userDataDir.stdout || "").trim();
  const chrome = ["/snap/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  const bin = chrome.find(Boolean);
  if (!bin) throw new Error("未找到 Chromium");

  const child = execFile(bin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--user-data-dir=" + profileDir,
    "--remote-debugging-port=" + port,
    "--user-agent=" + USER_AGENT,
    BASE_URL + "/cn/"
  ], { stdio: "ignore" });

  try {
    const deadline = Date.now() + timeoutMs;
    const version = await waitForDebugger(port, deadline);
    while (Date.now() < deadline) {
      const cookies = await readCookies(version.webSocketDebuggerUrl);
      const hit = cookies.find((c) => c && c.name === "cf_clearance" && String(c.domain || "").includes("ppnix.com"));
      if (hit && hit.value) {
        process.stdout.write("cf_clearance=" + hit.value);
        return;
      }
      await delay(1200);
    }
    throw new Error("未在时限内获取到 cf_clearance");
  } finally {
    try { child.kill("SIGKILL"); } catch (_) {}
  }
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});`;

  const { stdout, stderr } = await execFileAsync("node", ["-e", script], {
    timeout: PPNIX_CF_TIMEOUT_MS,
    env: {
      ...process.env,
      PPNIX_BASE_URL: BASE_URL,
      PPNIX_USER_AGENT: USER_AGENT,
      PPNIX_CF_TIMEOUT_MS: String(PPNIX_CF_TIMEOUT_MS),
    },
    maxBuffer: 1024 * 1024,
  });

  const cookie = text(stdout || "");
  if (!/^cf_clearance=/.test(cookie)) {
    throw new Error(text(stderr || "未获取到 cf_clearance"));
  }
  return cookie;
}

async function ensureCfCookie(forceRefresh = false, targetUrl = `${BASE_URL}${LANG_PATH}/`) {
  if (text(PPNIX_CF_COOKIE)) return text(PPNIX_CF_COOKIE);
  if (!forceRefresh) {
    const cached = await getCachedCfCookie();
    if (cached) return cached;
  }
  if (!PPNIX_CF_AUTO) return "";
  // 未配置 FlareSolverr 时零成本返回，不回退 headless Chromium（会在短生命周期 runner 里空等数十秒）。
  if (!text(PPNIX_FLARESOLVERR_URL)) {
    await OmniBox.log("warn", `[cf] 未配置 FlareSolverr 地址，跳过自动绕过（可配 PPNIX_FLARESOLVERR_URL / FLARESOLVERR_URL）`);
    return "";
  }

  let cookie = "";
  try {
    await OmniBox.log("info", `[cf] 开始通过 FlareSolverr 自动获取 cf_clearance`);
    cookie = await fetchCfClearanceWithFlareSolverr(targetUrl);
  } catch (error) {
    await OmniBox.log("warn", `[cf] FlareSolverr 获取失败: ${error.message}（不再回退 headless Chromium，避免空等超时）`);
    return "";
  }

  if (cookie) {
    await setCachedCfCookie(cookie);
    await OmniBox.log("info", `[cf] 已自动获取 cf_clearance，长度=${cookie.length}`);
  }
  return cookie;
}

async function requestPage(path) {
  const url = joinUrl(path);
  await OmniBox.log("info", `[request] ${url}`);
  let cookie = await getCachedCfCookie();
  let res = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": `${BASE_URL}${LANG_PATH}/`,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...buildCookieHeader(cookie),
    },
    validateStatus: () => true,
  });

  if ((res.status === 403 || res.status === 503) && PPNIX_CF_AUTO) {
    cookie = await ensureCfCookie(!cookie, url);
    res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": USER_AGENT,
        "Referer": `${BASE_URL}${LANG_PATH}/`,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...buildCookieHeader(cookie),
      },
      validateStatus: () => true,
    });
  }

  if (res.status !== 200 || !res.data) {
    throw new Error(`HTTP ${res.status}`);
  }

  return {
    url,
    html: typeof res.data === "string" ? res.data : String(res.data || ""),
  };
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function fixImage(url) {
  const u = text(url);
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `${BASE_URL}${u}`;
  return `${BASE_URL}/${u}`;
}

function stripTags(s = "") {
  return text(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function decodeHtmlEntity(str = "") {
  return text(str)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function mapListItems($, scope, typeId = "") {
  const list = [];
  const seen = new Set();
  $(scope).each((_, el) => {
    const $el = $(el);
    const $a = $el.find("a.thumbnail, h2 a, a").first();
    const href = $a.attr("href") || $el.find("h2 a").attr("href") || "";
    const vodId = text(href);
    if (!vodId || seen.has(vodId)) return;
    seen.add(vodId);

    const vodName = text($el.find("img.thumb").attr("alt") || $el.find("h2 a").text() || $a.text());
    const vodPic = fixImage($el.find("img.thumb").attr("src") || $el.find("img.thumb").attr("data-src") || "");
    const vodRemarks = text($el.find("footer .rate").text() || $el.find("footer").text());

    if (!vodName) return;

    list.push({
      vod_id: vodId,
      vod_name: vodName,
      vod_pic: vodPic,
      type_id: typeId,
      type_name: typeId === "movie" ? "电影" : typeId === "tv" ? "电视剧" : "",
      vod_remarks: vodRemarks,
    });
  });
  return list;
}

function parseM3u8List(html = "") {
  const infoId = (html.match(/infoid\s*=\s*(\d+)/) || [])[1] || "";
  const m = html.match(/m3u8\s*=\s*\[(.*?)\]/s);
  if (!m) return { infoId, items: [] };
  const items = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) {
    const value = text(mm[1] || mm[2] || "");
    if (value) items.push(value);
  }
  return { infoId, items };
}

function buildPlayId(meta) {
  const infoId = text(meta.infoId || "");
  const param = encodeURIComponent(text(meta.param || ""));
  const referer = encodeURIComponent(text(meta.referer || ""));
  const name = encodeURIComponent(text(meta.name || ""));
  const episodeName = encodeURIComponent(text(meta.episodeName || ""));
  return `${infoId}|${param}|${referer}|${name}|${episodeName}`;
}

function parsePlayId(playId) {
  const parts = String(playId || "").split("|");
  return {
    infoId: text(parts[0] || ""),
    param: decodeURIComponent(parts[1] || ""),
    referer: decodeURIComponent(parts[2] || ""),
    name: decodeURIComponent(parts[3] || ""),
    episodeName: decodeURIComponent(parts[4] || ""),
  };
}

async function fetchText(url, headers = {}) {
  let cookie = await getCachedCfCookie();
  let res = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": USER_AGENT,
      ...headers,
      ...buildCookieHeader(cookie),
    },
    validateStatus: () => true,
  });
  if ((res.status === 403 || res.status === 503) && PPNIX_CF_AUTO) {
    cookie = await ensureCfCookie(!cookie, url);
    res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": USER_AGENT,
        ...headers,
        ...buildCookieHeader(cookie),
      },
      validateStatus: () => true,
    });
  }
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }
  return typeof res.data === "string" ? res.data : String(res.data || "");
}

function rewritePpnixM3u8(m3u8Text, referer) {
  const keyUrl = `${BASE_URL}/info/m3u8/key`;
  return String(m3u8Text || "")
    .replace(/URI="\.\.\/key"/g, `URI="${keyUrl}"`)
    .replace(/https:\/\/ipfs\.ppnix\.com\/ipfs\//g, `${PPNIX_SEGMENT_HOST}/ipfs/`);
}

function buildSubtitleSelector(infoId, param, langs = ["cn", "tw", "en"]) {
  const items = [];
  for (const lang of langs) {
    const code = text(lang);
    if (!code) continue;
    items.push({
      name: code,
      url: `${BASE_URL}/info/subtitle/${infoId}/${encodeURIComponent(param)}/${code}.srt`,
    });
  }
  return items;
}

function uniqValues(values = []) {
  return [...new Set(values.map((v) => text(v)).filter(Boolean))];
}

function normalizeCategoryFilters(raw = {}) {
  const filters = raw && typeof raw === "object" ? raw : {};
  return {
    class: text(filters.class || filters.type || filters.cate || ""),
    area: text(filters.area || ""),
    year: text(filters.year || ""),
    by: text(filters.by || filters.sort || "newstime") || "newstime",
  };
}

function buildFilterPath(categoryId, page = 1, rawFilters = {}) {
  const filters = normalizeCategoryFilters(rawFilters);
  const genre = filters.class;
  const area = filters.area;
  const year = filters.year;
  const sort = SORT_MAP[filters.by] || "newstime";
  const pagePart = page <= 1 ? "" : `${page - 1}`;
  return `${LANG_PATH}/${categoryId}/${genre}-${area}-${year}-${pagePart}-${sort}.html`;
}

function extractFilterValues($, root, currentText = "") {
  const values = [];
  $(root).find("a").each((_, el) => {
    const name = text($(el).text());
    if (!name || name === currentText) return;
    values.push(name);
  });
  return uniqValues(values);
}

function buildCategoryFilters($) {
  const groups = [];
  const dls = $(".lists-content.filter dl");
  if (!dls.length) return groups;

  const typeValues = extractFilterValues($, dls.eq(0), "全部");
  if (typeValues.length) {
    groups.push({
      key: "class",
      name: "类型",
      init: "",
      value: [{ name: "全部", value: "" }, ...typeValues.map((v) => ({ name: v, value: v }))],
    });
  }

  const areaValues = extractFilterValues($, dls.eq(1), "全部");
  if (areaValues.length) {
    groups.push({
      key: "area",
      name: "地区",
      init: "",
      value: [{ name: "全部", value: "" }, ...areaValues.map((v) => ({ name: v, value: v }))],
    });
  }

  const yearValues = extractFilterValues($, dls.eq(2), "全部");
  if (yearValues.length) {
    groups.push({
      key: "year",
      name: "年份",
      init: "",
      value: [{ name: "全部", value: "" }, ...yearValues.map((v) => ({ name: v, value: v }))],
    });
  }

  groups.push({
    key: "by",
    name: "排序",
    init: "newstime",
    value: [
      { name: "按时间", value: "newstime" },
      { name: "按人气", value: "onclick" },
      { name: "按评分", value: "rating" },
    ],
  });

  return groups;
}

function buildM3u8DataUrl(m3u8Text) {
  return `data:application/vnd.apple.mpegurl;base64,${Buffer.from(String(m3u8Text || ""), "utf8").toString("base64")}`;
}

// 抓取 AES key 并内联为 data URI：key 接口无 CORS，data-url 播放时跨域取 key 会失败，
// 必须把 32 字节 key 内嵌进 m3u8，让播放列表完全自包含。
async function fetchKeyDataUri(headers = {}) {
  const keyUrl = `${BASE_URL}/info/m3u8/key`;
  let cookie = await getCachedCfCookie();
  const doGet = () => axios.get(keyUrl, {
    timeout: 20000,
    responseType: "arraybuffer",
    headers: { "User-Agent": USER_AGENT, Referer: `${BASE_URL}${LANG_PATH}/`, ...headers, ...buildCookieHeader(cookie) },
    validateStatus: () => true,
  });
  let res = await doGet();
  if ((res.status === 403 || res.status === 503) && PPNIX_CF_AUTO) {
    cookie = await ensureCfCookie(!cookie, keyUrl);
    res = await doGet();
  }
  if (res.status !== 200 || !res.data || Buffer.byteLength(res.data) < 16) {
    throw new Error(`key 获取失败 HTTP ${res.status}`);
  }
  const buf = Buffer.from(res.data);
  return `data:application/octet-stream;base64,${buf.toString("base64")}`;
}

// 重写 m3u8：key 内联为 data URI（解决无 CORS），分段固定到支持 Range 的稳定网关
// （解决 ipfs.ppnix.com 随机 302 到忽略 Range 的网关导致加载失败）。
async function rewritePpnixM3u8(m3u8Text, headers = {}) {
  const keyUri = await fetchKeyDataUri(headers);
  return String(m3u8Text || "")
    .replace(/URI="[^"]*key[^"]*"/gi, `URI="${keyUri}"`)
    .replace(/https:\/\/ipfs\.ppnix\.com\/ipfs\//g, `${PPNIX_SEGMENT_HOST}/ipfs/`);
}

// ---- 代理服务（独立长驻进程）：对外提供 http m3u8，内部重写 key + 分段网关 ----
function ppDetectLanIp() {
  if (PP_PROXY_HOST_IP) return PP_PROXY_HOST_IP;
  try {
    const dgram = require("dgram");
    const s = dgram.createSocket("udp4");
    let ip = "";
    try { s.connect(223, "5.5.5.5"); ip = s.address().address; } catch (_) {}
    try { s.close(); } catch (_) {}
    if (ip && !/^(127\.|198\.18\.|169\.254\.)/.test(ip)) return ip;
  } catch (_) {}
  return "127.0.0.1";
}
function ppProxyBase() { return PP_PROXY_BASE || `http://${ppDetectLanIp()}:${PP_PROXY_PORT}`; }
async function ppPingProxy() {
  try {
    const res = await axios.get(`${PP_PROXY_BASE || `http://127.0.0.1:${PP_PROXY_PORT}`}/__pp_health`, { timeout: 1500, validateStatus: () => true });
    return res.status === 200 && String(res.data || "").includes("pp-ok");
  } catch (_) { return false; }
}
async function ppEnsureProxy() {
  if (PP_PROXY_BASE) return true;
  if (await ppPingProxy()) return true;
  try {
    const child = spawn(process.execPath, [__filename, "--pp-server", String(PP_PROXY_PORT)], {
      detached: true, stdio: "ignore", env: process.env,
    });
    child.unref();
  } catch (e) {
    await OmniBox.log("warn", `[pp][proxy] 拉起代理服务失败: ${e.message}`);
    return false;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await ppPingProxy()) return true;
  }
  return false;
}
function ppPlaylistUrl(infoId, param) {
  const u = new URL("/playlist.m3u8", ppProxyBase());
  u.searchParams.set("infoId", String(infoId));
  u.searchParams.set("param", String(param));
  return u.toString();
}
async function ppStartServer(port) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname === "/__pp_health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pp-ok");
        return;
      }
      if (u.pathname !== "/playlist.m3u8") {
        res.writeHead(404); res.end("not found"); return;
      }
      const infoId = u.searchParams.get("infoId") || "";
      const param = u.searchParams.get("param") || "";
      if (!infoId || !param) { res.writeHead(400); res.end("missing infoId/param"); return; }
      const sourceUrl = `${BASE_URL}/info/m3u8/${infoId}/${encodeURIComponent(param)}.m3u8`;
      const raw = await fetchText(sourceUrl, { Referer: `${BASE_URL}${LANG_PATH}/` });
      const rewritten = await rewritePpnixM3u8(raw, {});
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(rewritten);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`proxy failed: ${e && e.message ? e.message : e}`);
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.error(`[pp-server] listening on 0.0.0.0:${port} health=/__pp_health`);
  });
}

// 兼容旧调用名
function rewritePpnixM3u8LikeWeb(m3u8Text) { return rewritePpnixM3u8(m3u8Text); }
function rewritePpnixM3u8ForTvbox(m3u8Text) { return rewritePpnixM3u8(m3u8Text); }

async function home(params, context) {
  try {
    const [homePage, moviePage, tvPage] = await Promise.all([
      requestPage(`${LANG_PATH}/`),
      requestPage(buildFilterPath("movie", 1, {})),
      requestPage(buildFilterPath("tv", 1, {})),
    ]);

    const $home = cheerio.load(homePage.html);
    const $movie = cheerio.load(moviePage.html);
    const $tv = cheerio.load(tvPage.html);

    const blocks = $home(".lists-content ul");
    const movieList = blocks.eq(0).length ? mapListItems($home, blocks.eq(0).find("li"), "movie") : [];
    const tvList = blocks.eq(1).length ? mapListItems($home, blocks.eq(1).find("li"), "tv") : [];
    const list = [...movieList, ...tvList].slice(0, 30);

    const filters = {
      movie: buildCategoryFilters($movie),
      tv: buildCategoryFilters($tv),
    };

    await OmniBox.log("info", `[home] 分类=${CATEGORIES.length}, 推荐=${list.length}, movieFilters=${filters.movie?.length || 0}, tvFilters=${filters.tv?.length || 0}`);
    return {
      class: CATEGORIES,
      filters,
      list,
    };
  } catch (error) {
    await OmniBox.log("error", `[home] 失败: ${error.message}`);
    return { class: CATEGORIES, filters: {}, list: [] };
  }
}

async function category(params, context) {
  try {
    const categoryId = text(params.categoryId || params.type_id || "movie");
    const page = parseInt(params.page || "1", 10) || 1;
    const rawFilters = params.filters || params.extend || {};
    const path = buildFilterPath(categoryId, page, rawFilters);
    const { html } = await requestPage(path);
    const $ = cheerio.load(html);

    const list = mapListItems($, ".lists-content > ul > li, .lists .lists-content ul li", categoryId)
      .filter((item) => item.vod_id.includes(`/${categoryId}/`));

    let pagecount = page;
    const pagerHtml = $(".pagination, .pages, .pagenavi").html() || "";
    const matches = [...pagerHtml.matchAll(/---(\d+)-\.html/g)].map((m) => Number(m[1]) + 1);
    if (matches.length > 0) {
      pagecount = Math.max(page, ...matches);
    }

    const categoryFilters = buildCategoryFilters($);
    await OmniBox.log("info", `[category] categoryId=${categoryId}, page=${page}, path=${path}, list=${list.length}, pagecount=${pagecount}`);
    return {
      list,
      page,
      pagecount,
      total: list.length,
      filters: categoryFilters.length ? { [categoryId]: categoryFilters } : {},
    };
  } catch (error) {
    await OmniBox.log("error", `[category] 失败: ${error.message}`);
    return { list: [], page: 1, pagecount: 0, total: 0, filters: {} };
  }
}

async function detail(params, context) {
  try {
    const videoId = text(params.videoId || "");
    if (!videoId) return { list: [] };

    const { html, url } = await requestPage(videoId);
    const $ = cheerio.load(html);

    const titleRaw = text($("h1.product-title").text());
    const vodName = titleRaw.replace(/\s*\([^)]*\)\s*$/, "").trim() || text($("title").text()).replace(/\s*\([^)]*\).*/, "");
    const vodPic = fixImage($("header.product-header img.thumb").attr("src") || "");
    const vodContent = text($(".product-excerpt").filter((_, el) => $(el).text().includes("简介：")).text()).replace(/^简介：/, "").trim();
    const vodDirector = text($(".product-excerpt").filter((_, el) => $(el).text().includes("导演：")).find("span").text());
    const vodActor = text($(".product-excerpt").filter((_, el) => $(el).text().includes("主演：")).find("span").text()).replace(/\s*\/\s*/g, ",");
    const vodYear = ((titleRaw.match(/\((\d{4})\)/) || [])[1]) || "";

    const { infoId, items } = parseM3u8List(html);
    const episodes = items.map((item, idx) => ({
      name: item,
      playId: buildPlayId({
        infoId: infoId || ((videoId.match(/(\d+)\.html/) || [])[1] || ""),
        param: item,
        referer: url,
        name: vodName,
        episodeName: item,
        subtitleBase: `${BASE_URL}/info/subtitle/${infoId || ((videoId.match(/(\d+)\.html/) || [])[1] || "")}/${item}`,
      }),
    }));

    const vod = {
      vod_id: videoId,
      vod_name: vodName,
      vod_pic: vodPic,
      vod_year: vodYear,
      vod_director: vodDirector,
      vod_actor: vodActor,
      vod_content: vodContent,
      vod_play_sources: episodes.length ? [{ name: "PPnix", episodes }] : undefined,
    };

    await OmniBox.log("info", `[detail] infoId=${infoId}, episodes=${episodes.length}`);
    return { list: [vod] };
  } catch (error) {
    await OmniBox.log("error", `[detail] 失败: ${error.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = text(params.keyword || params.wd || "");
    const page = parseInt(params.page || "1", 10) || 1;
    if (!keyword) return { list: [], page: 1, pagecount: 0, total: 0 };

    const encoded = encodeURIComponent(keyword);
    const sortSuffix = page <= 1 ? "" : `-page-${page}`;
    const path = `${LANG_PATH}/search/${encoded}--.html${sortSuffix}`;
    const { html } = await requestPage(path);
    const $ = cheerio.load(html);

    const list = mapListItems($, ".lists-content > ul > li, .lists .lists-content ul li")
      .filter((item) => /\/(movie|tv)\/\d+\.html/.test(item.vod_id));

    await OmniBox.log("info", `[search] keyword=${keyword}, page=${page}, list=${list.length}`);
    return {
      list,
      page,
      pagecount: page,
      total: list.length,
    };
  } catch (error) {
    await OmniBox.log("error", `[search] 失败: ${error.message}`);
    return { list: [], page: 1, pagecount: 0, total: 0 };
  }
}

async function play(params, context) {
  try {
    const meta = parsePlayId(params.playId || "");
    const infoId = text(meta.infoId || "");
    const param = text(meta.param || "");
    if (!infoId || !param) {
      throw new Error("playId 参数不完整");
    }

    const referer = text(meta.referer || `${BASE_URL}${LANG_PATH}/`);
    const from = text(context?.from || "") || "unknown";
    const shouldUseLeanHeader = from === "tvbox";
    // 只复用已有 CF cookie，不在播放前主动触发绕过；真正需要时 fetchText 会在 403/503 后自行处理。
    const cfCookie = shouldUseLeanHeader ? "" : await getCachedCfCookie();
    // 干净 header：仅 UA + Referer（与其它可正常播放的 m3u8 源一致）。
    // 实测带 Origin/Cookie 会让播放器/CDN 拒绝 m3u8 或分段，去掉后 5/5 分段 206 且 TS 解密正确。
    const header = shouldUseLeanHeader ? {} : {
      Referer: referer,
      "User-Agent": USER_AGENT,
    };

    const sourceUrl = `${BASE_URL}/info/m3u8/${infoId}/${encodeURIComponent(param)}.m3u8`;
    const episodeName = text(meta.episodeName || param || "播放");
    const subtitles = PPNIX_ENABLE_SUBTITLES ? buildSubtitleSelector(infoId, param) : [];

    // 默认走本地代理服务：对外是 http m3u8（播放器支持），内部 key 内联 + 分段固定稳定网关。
    if (PPNIX_REWRITE_M3U8 !== false) {
      const ready = await ppEnsureProxy();
      if (ready) {
        const proxyUrl = ppPlaylistUrl(infoId, param);
        await OmniBox.log("info", `[play] 返回代理 m3u8: ${proxyUrl} from=${from}`);
        return {
          urls: [{ name: episodeName, url: proxyUrl }],
          header: {},
          parse: 0,
          danmaku: [],
          subtitles};
      }
      await OmniBox.log("warn", `[play] 代理服务不可用，回退原始 m3u8 直链`);
    }

    await OmniBox.log("info", `[play] 返回原始 m3u8 直链: infoId=${infoId}, param=${param}, from=${from}, subtitles=${subtitles.length}`);
    return {
      urls: [{ name: episodeName, url: sourceUrl }],
      header,
      parse: 0,
      danmaku: [],
      subtitles};
  } catch (error) {
    await OmniBox.log("error", `[play] 失败: ${error.message}`);
    return { urls: [], header: {}, parse: 1, danmaku: [] };
  }
}

module.exports = { home, category, detail, search, play };

if (IS_PP_SERVER) {
  // 独立长驻代理进程：不进入 spider_runner
  const port = Number(process.argv[process.argv.indexOf("--pp-server") + 1]) || PP_PROXY_PORT;
  ppStartServer(port).catch((e) => {
    console.error(`[pp-server] 启动失败: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
} else {
  runner.run(module.exports);
}
