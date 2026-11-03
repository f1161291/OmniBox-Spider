// @name 飞牛
// @author openclaw
// @description 飞牛私有媒体库源，支持多站点、媒体库分类、目录展开、电影/剧集详情、原画/转码/外挂字幕
// @dependencies: axios
// @version 1.1.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/流媒体/飞牛.js

const axios = require("axios");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const OmniBox = require("omnibox_sdk");

// ==================== 配置区域开始 ====================
// 飞牛开放平台固定参数（按官方 Web 端签名链路写死）
// API_KEY：飞牛 Web 端请求签名用的固定 key，通常无需改动。
const API_KEY = "***";
// API_SECRET：与 API_KEY 配套的固定签名 secret，通常无需改动。
const API_SECRET = "***";
// APP_NAME：登录接口要求的客户端标识，需保持与官方 Web 端一致。
const APP_NAME = "trimemedia-web";

// 单站配置（至少需要 FEINIU_HOST；认证则二选一：FEINIU_TOKEN 或 FEINIU_USERNAME + FEINIU_PASSWORD）
// FEINIU_NAME：站点显示名称，用于多站聚合时区分来源。
const FEINIU_NAME = process.env.FEINIU_NAME || "飞牛";
// FEINIU_HOST：飞牛站点根地址，如 https://example.com 。
const FEINIU_HOST = process.env.FEINIU_HOST || "";
// FEINIU_TOKEN：已登录后的 access token；若填写则优先直连，省去账号密码登录。
const FEINIU_TOKEN = process.env.FEINIU_TOKEN || "";
// FEINIU_USERNAME：登录账号；未填写 FEINIU_TOKEN 时可与 FEINIU_PASSWORD 配套使用。
const FEINIU_USERNAME = process.env.FEINIU_USERNAME || "";
// FEINIU_PASSWORD：登录密码；未填写 FEINIU_TOKEN 时可与 FEINIU_USERNAME 配套使用。
const FEINIU_PASSWORD = process.env.FEINIU_PASSWORD || "";
// FEINIU_USER_AGENT：请求头 UA；部分站点有校验时可改成浏览器 UA。
const FEINIU_USER_AGENT = process.env.FEINIU_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
// FEINIU_PAGE_SIZE：列表接口单次拉取条数，默认 50，按站点承载能力调整。
const FEINIU_PAGE_SIZE = process.env.FEINIU_PAGE_SIZE || "50";
// FEINIU_TIMEOUT：请求超时时间（毫秒），默认 15000。
const FEINIU_TIMEOUT = process.env.FEINIU_TIMEOUT || "15000";
// FEINIU_TOKEN_TTL：token 缓存时长（秒），默认 15 天；账号密码登录场景会按此缓存。
const FEINIU_TOKEN_TTL = process.env.FEINIU_TOKEN_TTL || String(15 * 24 * 60 * 60);

// 多站配置：传 JSON 数组或 base64 JSON；有值时优先级高于单站配置
// FEINIU_SITES：多站点配置，支持 JSON 数组或 base64(JSON)；每项可含 name/host/token/username/password/userAgent/pageSize/timeout/tokenTtl。
const FEINIU_SITES = process.env.FEINIU_SITES || "";

// ==================== 配置区域结束 ====================

const DEFAULT_USER_AGENT = FEINIU_USER_AGENT;
const DEFAULT_PAGE_SIZE = toInt(FEINIU_PAGE_SIZE, 50);
const DEFAULT_TIMEOUT = toInt(FEINIU_TIMEOUT, 15000);

const CACHE_TTL = {
  token: toInt(FEINIU_TOKEN_TTL, 15 * 24 * 60 * 60),
  mediaDb: 10 * 60,
  home: 60,
  search: 60,
  itemList: 90,
  item: 5 * 60,
  season: 5 * 60,
  episode: 5 * 60,
  stream: 90,
};

const SORT_FILTER = {
  key: "sort",
  name: "排序",
  init: "create_time:DESC",
  value: [
    { n: "加入日期⬇️", v: "create_time:DESC" },
    { n: "加入日期⬆️", v: "create_time:ASC" },
    { n: "上映日期⬇️", v: "release_date:DESC" },
    { n: "上映日期⬆️", v: "release_date:ASC" },
    { n: "评分⬇️", v: "vote_average:DESC" },
    { n: "评分⬆️", v: "vote_average:ASC" },
    { n: "名称⬆️", v: "sort_title:ASC" },
    { n: "名称⬇️", v: "sort_title:DESC" },
  ],
};

const runtimeTokenCache = new Map();

const httpClient = axios.create({
  timeout: DEFAULT_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  validateStatus: () => true,
  maxRedirects: 5,
});

function log(level, message, data) {
  const suffix = data === undefined ? "" : `: ${safeStringify(data)}`;
  OmniBox.log(level, `[飞牛] ${message}${suffix}`);
}

function logInfo(message, data) {
  log("info", message, data);
}

function logWarn(message, data) {
  log("warn", message, data);
}

function logError(message, error) {
  const data = error && typeof error === "object"
    ? { message: error.message || String(error), stack: error.stack || "" }
    : error;
  log("error", message, data);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function toInt(value, defaultValue = 0) {
  const num = parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(num) ? num : defaultValue;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function md5(textValue) {
  return crypto.createHash("md5").update(String(textValue || ""), "utf8").digest("hex");
}

function sha1Buffer(textValue) {
  return crypto.createHash("sha1").update(String(textValue || ""), "utf8").digest();
}

function toUuidFromString(value) {
  if (!text(value)) return "00000000-0000-0000-0000-000000000000";
  const hex = sha1Buffer(value).subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildCacheKey(prefix, raw) {
  return `feiniu:${prefix}:${md5(raw).slice(0, 24)}`;
}

function validateConfiguredSites(rawSites = []) {
  if (!Array.isArray(rawSites) || rawSites.length === 0) {
    throw new Error("飞牛配置缺失：请先填写 FEINIU_HOST，或提供 FEINIU_SITES 多站配置");
  }
  rawSites.forEach((site, index) => {
    const siteName = text(site?.name || site?.title || site?.label) || `飞牛站点${index + 1}`;
    const host = normalizeHost(site?.host || site?.url || site?.baseUrl || site?.server);
    if (!host) {
      throw new Error(`${siteName} 缺少必填配置：URL 地址（host）`);
    }
    const token = text(site?.token);
    const username = text(site?.username || site?.user);
    const password = text(site?.password || site?.pass);
    if (!token && (!username || !password)) {
      throw new Error(`${siteName} 缺少必填配置：Token，或 用户名 + 密码`);
    }
  });
}

function encodeBase64Url(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  return Buffer.from(raw + padding, "base64").toString("utf8");
}

function encodeId(payload) {
  return `fni:${encodeBase64Url(JSON.stringify(payload || {}))}`;
}

function decodeId(value) {
  const raw = text(value);
  if (!raw.startsWith("fni:")) return null;
  try {
    return JSON.parse(decodeBase64Url(raw.slice(4)) || "{}");
  } catch (error) {
    logWarn("解码 ID 失败", { value: raw, error: error.message });
    return null;
  }
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (Array.isArray(value) || isObject(value)) return value;
  const raw = text(value);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch (error) {
      logWarn("解析 JSON 配置失败", { raw: raw.slice(0, 120), error: error.message });
      return null;
    }
  }
}

function normalizeHost(host) {
  const raw = text(host);
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function firstNonBlank(...values) {
  for (const value of values) {
    const current = text(value);
    if (current) return current;
  }
  return "";
}

function firstText(node, ...keys) {
  for (const key of keys) {
    const value = node && typeof node === "object" ? node[key] : undefined;
    if (typeof value === "string" && text(value)) return text(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (typeof first === "string" && text(first)) return text(first);
      if (isObject(first)) {
        const nested = firstNonBlank(first.name, first.title, first.label, first.value, first.text);
        if (nested) return nested;
      }
    }
  }
  return "";
}

function collectTextList(node, ...keys) {
  const result = [];
  for (const key of keys) {
    const value = node && typeof node === "object" ? node[key] : undefined;
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && text(item)) {
          result.push(text(item));
        } else if (isObject(item)) {
          const hit = firstNonBlank(item.name, item.title, item.label, item.value, item.text);
          if (hit) result.push(hit);
        }
      }
    } else if (typeof value === "string" && text(value)) {
      result.push(text(value));
    }
  }
  return Array.from(new Set(result));
}

function extractYear(node) {
  const date = firstText(node, "release_date", "air_date", "publish_date", "year");
  const match = date.match(/(19|20)\d{2}/);
  return match ? match[0] : "";
}

function formatScore(value) {
  const raw = text(value);
  if (!raw) return "";
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return raw;
  return num.toFixed(1);
}

function formatDuration(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  let seconds = num;
  if (seconds > 24 * 60 * 60 * 10) {
    seconds = Math.round(seconds / 1000);
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainSeconds = seconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${remainSeconds}秒`;
}

function pickPosterPath(item) {
  return firstText(item, "poster", "poster_list", "posters", "cover", "cover_mobile", "thumb", "background");
}

function normalizeSite(site, index) {
  const host = normalizeHost(site.host || site.url);
  if (!host) return null;
  const name = text(site.name || site.title || site.label || `飞牛${index + 1}`) || `飞牛${index + 1}`;
  const username = text(site.username);
  const keySeed = `${host}|${name}|${username}|${index}`;
  return {
    key: md5(keySeed).slice(0, 12),
    name,
    host,
    token: text(site.token),
    username,
    password: text(site.password),
    userAgent: text(site.userAgent || site.ua || FEINIU_USER_AGENT || DEFAULT_USER_AGENT),
    pageSize: Math.max(1, toInt(site.pageSize || site.limit || DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE)),
  };
}

function getSitesFromEnv() {
  const multi = parseMaybeJson(FEINIU_SITES);
  if (Array.isArray(multi) && multi.length > 0) return multi;
  const singleHost = normalizeHost(FEINIU_HOST);
  if (!singleHost) return [];
  return [
    {
      name: FEINIU_NAME,
      host: singleHost,
      token: FEINIU_TOKEN,
      username: FEINIU_USERNAME,
      password: FEINIU_PASSWORD,
      userAgent: FEINIU_USER_AGENT,
      pageSize: FEINIU_PAGE_SIZE || DEFAULT_PAGE_SIZE,
    },
  ];
}

function resolveSites(params = {}) {
  const ext = parseMaybeJson(params.extend || params.config || params.ext);
  let rawSites = [];
  if (Array.isArray(ext)) {
    rawSites = ext;
  } else if (Array.isArray(ext && ext.sites)) {
    rawSites = ext.sites;
  } else if (isObject(ext) && ext.host) {
    rawSites = [ext];
  } else {
    rawSites = getSitesFromEnv();
  }
  validateConfiguredSites(rawSites);
  const sites = rawSites.map((site, index) => normalizeSite(site, index)).filter(Boolean);
  if (!sites.length) {
    throw new Error("未配置飞牛站点，请设置 FEINIU_HOST / FEINIU_SITES 或通过 params.extend 传入");
  }
  return sites;
}

function getSiteByKey(sites = [], siteKey = "") {
  const key = text(siteKey);
  if (!key || !Array.isArray(sites) || sites.length === 0) return null;
  return sites.find((site) => text(site && site.key) === key) || null;
}

async function getCachedJson(key) {
  try {
    const cached = await OmniBox.getCache(key);
    if (!cached) return null;
    if (typeof cached === "string") return JSON.parse(cached);
    return cached;
  } catch (error) {
    logWarn("读取缓存失败", { key, error: error.message });
    return null;
  }
}

async function setCachedJson(key, value, ttl) {
  try {
    await OmniBox.setCache(key, JSON.stringify(value), ttl);
  } catch (error) {
    logWarn("写入缓存失败", { key, error: error.message });
  }
}

async function deleteCache(key) {
  try {
    await OmniBox.deleteCache(key);
  } catch (error) {
    logWarn("删除缓存失败", { key, error: error.message });
  }
}

async function withCachedJson(key, ttl, producer) {
  const cached = await getCachedJson(key);
  if (cached !== null && cached !== undefined) return cached;
  const value = await producer();
  if (value !== undefined) await setCachedJson(key, value, ttl);
  return value;
}

function randomNonce() {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

function buildAuthx(path, bodyJson, nonce, timestamp) {
  const payloadMd5 = md5(bodyJson || "");
  const raw = [API_KEY, path, nonce, String(timestamp), payloadMd5, API_SECRET].join("_");
  return `nonce=${nonce}&timestamp=${timestamp}&sign=${md5(raw)}`;
}

function buildCommonHeaders(site, token, path, bodyJson, extra = {}) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Authorization: token || "",
    Cookie: `mode=relay; Trim-MC-token=${token || ""}`,
    authx: buildAuthx(path, bodyJson, nonce, timestamp),
    "User-Agent": site.userAgent || DEFAULT_USER_AGENT,
    ...extra,
  };
}

function shouldRefreshToken(status, responseJson) {
  if (status === 401 || status === 403) return true;
  const code = Number(responseJson && responseJson.code);
  const msg = text(responseJson && (responseJson.msg || responseJson.message)).toLowerCase();
  if ([401, 403, 10001, 10002].includes(code)) return true;
  return /(token|登录|登入|auth|unauthorized|expired|过期)/.test(msg);
}

async function loginSite(site) {
  const path = "/v/api/v1/login";
  const body = {
    app_name: APP_NAME,
    username: site.username,
    password: site.password,
  };
  const bodyJson = JSON.stringify(body);
  const url = `${site.host}${path}`;
  const headers = buildCommonHeaders(site, "", path, bodyJson);
  logInfo("登录飞牛", { site: site.name, host: site.host });
  const response = await httpClient.post(url, bodyJson, { headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`登录 HTTP ${response.status}`);
  }
  const json = typeof response.data === "string" ? JSON.parse(response.data || "{}") : response.data;
  if (Number(json && json.code) !== 0) {
    throw new Error(text(json && (json.msg || json.message)) || "飞牛登录失败");
  }
  const token = text(json && json.data && json.data.token);
  if (!token) throw new Error("飞牛登录未返回 token");
  runtimeTokenCache.set(site.key, token);
  await setCachedJson(buildCacheKey("token", `${site.key}|${site.host}`), { token }, CACHE_TTL.token);
  return token;
}

async function getSiteToken(site, options = {}) {
  if (!options.forceRefresh && site.token) return site.token;
  if (!options.forceRefresh && runtimeTokenCache.has(site.key)) {
    return runtimeTokenCache.get(site.key);
  }
  const tokenCacheKey = buildCacheKey("token", `${site.key}|${site.host}`);
  if (!options.forceRefresh) {
    const cached = await getCachedJson(tokenCacheKey);
    if (cached && text(cached.token)) {
      runtimeTokenCache.set(site.key, text(cached.token));
      return text(cached.token);
    }
  }
  if (!site.username || !site.password) {
    throw new Error(`${site.name} 缺少 FEINIU_TOKEN，且未配置 FEINIU_USERNAME / FEINIU_PASSWORD`);
  }
  return loginSite(site);
}

async function apiRequest(site, method, path, bodyObj, options = {}) {
  const token = options.skipToken ? "" : await getSiteToken(site, { forceRefresh: options.forceRefreshToken });
  const bodyJson = bodyObj == null ? "" : JSON.stringify(bodyObj);
  const url = `${site.host}${path}`;
  const headers = buildCommonHeaders(site, token, path, bodyJson, options.headers || {});
  const requestConfig = {
    url,
    method,
    headers,
    data: bodyJson || undefined,
  };

  const response = await httpClient.request(requestConfig);
  const status = response.status;
  let responseJson = response.data;
  if (typeof responseJson === "string") {
    try {
      responseJson = JSON.parse(responseJson || "{}");
    } catch (_) {
      throw new Error(`飞牛响应不是 JSON: ${String(response.data).slice(0, 120)}`);
    }
  }

  if (!options.skipToken && !options.retried && shouldRefreshToken(status, responseJson) && site.username && site.password) {
    logWarn("检测到 token 可能失效，尝试重新登录", { site: site.name, path, status });
    runtimeTokenCache.delete(site.key);
    await deleteCache(buildCacheKey("token", `${site.key}|${site.host}`));
    return apiRequest(site, method, path, bodyObj, { ...options, retried: true, forceRefreshToken: true });
  }

  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
  if (!responseJson || Number(responseJson.code) !== 0) {
    throw new Error(text(responseJson && (responseJson.msg || responseJson.message)) || "飞牛请求失败");
  }
  return responseJson.data;
}

async function getMediaDbList(site) {
  const cacheKey = buildCacheKey("mediadb", `${site.key}|${site.host}`);
  return withCachedJson(cacheKey, CACHE_TTL.mediaDb, () => apiRequest(site, "GET", "/v/api/v1/mediadb/list", null));
}

async function getPlayList(site) {
  const cacheKey = buildCacheKey("home", `${site.key}|${site.host}`);
  return withCachedJson(cacheKey, CACHE_TTL.home, () => apiRequest(site, "GET", "/v/api/v1/play/list", null));
}

async function getItemList(site, body, page = 1) {
  const payload = {
    ...body,
    page,
    page_size: Math.max(1, toInt(body.page_size || site.pageSize, site.pageSize)),
  };
  const cacheKey = buildCacheKey("itemlist", `${site.key}|${safeStringify(payload)}`);
  return withCachedJson(cacheKey, CACHE_TTL.itemList, () => apiRequest(site, "POST", "/v/api/v1/item/list", payload));
}

async function searchItems(site, keyword) {
  const path = `/v/api/v1/search/list?q=${encodeURIComponent(keyword)}`;
  const cacheKey = buildCacheKey("search", `${site.key}|${keyword}`);
  return withCachedJson(cacheKey, CACHE_TTL.search, () => apiRequest(site, "GET", path, null));
}

async function getItem(site, guid) {
  const cacheKey = buildCacheKey("item", `${site.key}|${guid}`);
  return withCachedJson(cacheKey, CACHE_TTL.item, () => apiRequest(site, "GET", `/v/api/v1/item/${guid}`, null));
}

async function getSeasonList(site, guid) {
  const cacheKey = buildCacheKey("season", `${site.key}|${guid}`);
  return withCachedJson(cacheKey, CACHE_TTL.season, () => apiRequest(site, "GET", `/v/api/v1/season/list/${guid}`, null));
}

async function getEpisodeList(site, guid) {
  const cacheKey = buildCacheKey("episode", `${site.key}|${guid}`);
  return withCachedJson(cacheKey, CACHE_TTL.episode, () => apiRequest(site, "GET", `/v/api/v1/episode/list/${guid}`, null));
}

async function getPlayInfo(site, guid) {
  return apiRequest(site, "POST", "/v/api/v1/play/info", { item_guid: guid });
}

async function getStreamList(site, guid) {
  return apiRequest(site, "GET", `/v/api/v1/stream/list/${guid}`, null);
}

async function getStream(site, mediaGuid) {
  const payload = {
    header: { "User-Agent": ["trim_player"] },
    level: 1,
    media_guid: mediaGuid,
    ip: toUuidFromString(firstNonBlank(site.username, site.name)),
  };
  const cacheKey = buildCacheKey("stream", `${site.key}|${mediaGuid}`);
  return withCachedJson(cacheKey, CACHE_TTL.stream, () => apiRequest(site, "POST", "/v/api/v1/stream", payload));
}

async function startPlay(site, payload) {
  return apiRequest(site, "POST", "/v/api/v1/play/play", payload);
}

function absoluteUrl(site, path) {
  const raw = text(path);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${site.host}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function getMediaRangeUrl(site, mediaGuid) {
  return `${site.host}/v/api/v1/media/range/${mediaGuid}`;
}

function getSubtitleUrl(site, guid) {
  return `${site.host}/v/api/v1/subtitle/dl/${guid}`;
}

function getImageUrl(site, path) {
  const raw = text(path);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${site.host}/v/api/v1/sys/img${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function buildMediaHeaders(site, token) {
  return {
    Authorization: token || "",
    Cookie: `mode=relay; Trim-MC-token=${token || ""}`,
    Referer: `${site.host}/v`,
    Origin: site.host,
    "User-Agent": site.userAgent || DEFAULT_USER_AGENT,
  };
}

async function getImageHeaders(site) {
  const token = await getSiteToken(site);
  return buildMediaHeaders(site, token);
}

function buildLibraryClass(site, lib, multipleSites) {
  const guid = firstText(lib, "guid", "id");
  const title = firstText(lib, "title", "name") || "媒体库";
  return {
    type_id: encodeId({ kind: "library", site: site.key, guid, title }),
    type_name: multipleSites ? `${site.name} · ${title}` : title,
  };
}

function buildRemarks(item, multipleSites, siteName) {
  const parts = [];
  if (multipleSites) parts.push(siteName);
  const score = formatScore(firstText(item, "vote_average", "score", "rating"));
  if (score) parts.push(`评分${score}`);
  const year = extractYear(item);
  if (year) parts.push(year);
  const quality = firstText(item, "quality", "resolution", "resolution_type");
  if (quality) parts.push(quality);
  const type = firstText(item, "type");
  if (type === "Directory") parts.push("目录");
  if (type === "TV") {
    const seasonCount = toInt(firstText(item, "seasons_count"), 0);
    if (seasonCount > 0) parts.push(`${seasonCount}季`);
  }
  return parts.join(" · ");
}

async function toVod(site, item, options = {}) {
  const itemType = firstText(item, "type");
  const vodId = encodeId({
    kind: "item",
    site: site.key,
    guid: firstText(item, "guid", "id"),
    itemType,
    title: firstText(item, "title", "name", "tv_title"),
  });
  const tokenHeaders = options.includePicHeaders ? await getImageHeaders(site) : undefined;
  return {
    vod_id: vodId,
    vod_name: firstText(item, "tv_title", "title", "name", "original_name") || "未命名",
    vod_pic: getImageUrl(site, pickPosterPath(item)),
    ...(tokenHeaders ? { vod_pic_headers: tokenHeaders } : {}),
    vod_remarks: buildRemarks(item, !!options.multipleSites, site.name),
    vod_year: extractYear(item),
    vod_tag: ["Directory"].includes(itemType) ? "folder" : "video",
  };
}

function buildHomeFilters(classList) {
  const filters = {};
  for (const item of classList) {
    filters[item.type_id] = [SORT_FILTER];
  }
  return filters;
}

function parseSortValue(params = {}) {
  const filters = isObject(params.filters) ? params.filters : {};
  const ext = isObject(params.extend) ? params.extend : {};
  const sort = firstNonBlank(filters.sort, params.sort, ext.sort, SORT_FILTER.init);
  const [sortColumn, sortTypeRaw] = sort.split(":");
  const sortType = text(sortTypeRaw).toUpperCase() === "ASC" ? "ASC" : "DESC";
  return { sort, sortColumn: text(sortColumn) || "create_time", sortType };
}

async function fetchAllDirectoryChildren(site, guid, maxPages = 10) {
  const payload = {
    tags: {},
    sort_type: "ASC",
    sort_column: "sort_title",
    parent_guid: guid,
    page_size: site.pageSize,
  };
  const result = [];
  let page = 1;
  while (page <= maxPages) {
    const data = await getItemList(site, payload, page);
    const list = Array.isArray(data && data.list) ? data.list : [];
    result.push(...list);
    const total = toInt(data && data.total, result.length);
    if (!list.length || result.length >= total) break;
    page += 1;
  }
  return result;
}

function buildTypeName(item) {
  return collectTextList(item, "genres", "genre", "category", "categories", "tags").join(" / ");
}

function buildPersonName(item, keys) {
  return collectTextList(item, ...keys).join(" / ");
}

async function buildDetailVod(site, item, multipleSites) {
  const headers = await getImageHeaders(site);
  const score = formatScore(firstText(item, "vote_average", "score", "rating"));
  return {
    vod_id: encodeId({
      kind: "item",
      site: site.key,
      guid: firstText(item, "guid", "id"),
      itemType: firstText(item, "type"),
      title: firstText(item, "title", "name", "tv_title"),
    }),
    vod_name: firstText(item, "title", "name", "tv_title") || "未命名",
    vod_pic: getImageUrl(site, pickPosterPath(item)),
    vod_pic_headers: headers,
    vod_remarks: buildRemarks(item, multipleSites, site.name),
    vod_content: firstText(item, "overview", "description", "plot", "summary"),
    vod_year: extractYear(item),
    vod_score: score,
    vod_director: buildPersonName(item, ["directors", "director"]).replace(/,/g, " / "),
    vod_actor: buildPersonName(item, ["actors", "casts", "cast", "artist", "artists"]).replace(/,/g, " / "),
    vod_area: buildPersonName(item, ["countries", "country", "regions", "region"]).replace(/,/g, " / "),
    vod_lang: buildPersonName(item, ["languages", "language", "audio_languages"]).replace(/,/g, " / "),
    vod_time: formatDuration(firstText(item, "duration", "runtime", "run_time")),
    type_name: buildTypeName(item),
  };
}

function buildEpisodePlayId(site, item, extra = {}) {
  return encodeId({
    kind: "play",
    site: site.key,
    guid: firstText(item, "guid", "id"),
    itemType: firstText(item, "type") || extra.itemType,
    title: firstText(item, "tv_title", "title", "name") || extra.title,
    season: extra.season || 0,
    episode: extra.episode || 0,
  });
}

function episodeLabel(item) {
  const title = firstText(item, "title", "name");
  const episodeNumber = toInt(firstText(item, "episode_number", "episode", "number"), 0);
  if (episodeNumber <= 0) return title || "播放";
  if (title && !/^第\s*\d+\s*集$/.test(title)) {
    return `${episodeNumber}. ${title}`;
  }
  return `第${episodeNumber}集`;
}

async function buildTvPlaySources(site, item) {
  const showGuid = firstText(item, "guid", "id");
  const seasonsData = await getSeasonList(site, showGuid);
  const seasons = Array.isArray(seasonsData) ? seasonsData : [];
  const sources = [];
  for (const season of seasons) {
    const seasonGuid = firstText(season, "guid", "id");
    const seasonNumber = toInt(firstText(season, "season_number", "number"), 0);
    const seasonTitle = firstText(season, "title", "name") || (seasonNumber > 0 ? `第${seasonNumber}季` : "剧集");
    const episodeData = await getEpisodeList(site, seasonGuid);
    const episodeList = Array.isArray(episodeData) ? episodeData : [];
    const episodes = episodeList.map((episode) => ({
      name: episodeLabel(episode),
      playId: buildEpisodePlayId(site, episode, {
        season: seasonNumber,
        episode: toInt(firstText(episode, "episode_number", "episode", "number"), 0),
      }),
    }));
    if (episodes.length > 0) {
      sources.push({ name: seasonTitle, episodes });
    }
  }
  if (!sources.length) {
    const fallbackPlayId = buildEpisodePlayId(site, item, { itemType: "TV" });
    sources.push({ name: site.name, episodes: [{ name: firstText(item, "title", "name") || "播放", playId: fallbackPlayId }] });
  }
  return sources;
}

async function buildDirectoryPlaySources(site, item) {
  const children = await fetchAllDirectoryChildren(site, firstText(item, "guid", "id"));
  const episodes = children.map((child) => {
    const type = firstText(child, "type");
    const rawName = firstText(child, "tv_title", "title", "name") || "未命名";
    const name = type === "Directory" ? `📁 ${rawName}` : rawName;
    return {
      name,
      playId: buildEpisodePlayId(site, child, { itemType: type, title: rawName }),
    };
  });
  return episodes.length ? [{ name: "资源列表", episodes }] : [];
}

async function resolvePlayableTarget(site, payload, depth = 0) {
  if (!payload || !payload.guid) throw new Error("缺少播放资源 guid");
  if (depth > 6) throw new Error("目录展开层级过深，已停止递归");

  let itemType = firstText(payload, "itemType");
  let guid = firstText(payload, "guid");
  let title = firstText(payload, "title") || "播放";

  if (!itemType) {
    const item = await getItem(site, guid);
    itemType = firstText(item, "type");
    title = firstText(item, "title", "name") || title;
  }

  if (itemType === "TV") {
    const seasonsData = await getSeasonList(site, guid);
    const seasons = Array.isArray(seasonsData) ? seasonsData : [];
    for (const season of seasons) {
      const episodeData = await getEpisodeList(site, firstText(season, "guid", "id"));
      const episodes = Array.isArray(episodeData) ? episodeData : [];
      const firstEpisode = episodes.find((ep) => ["Episode", "Video", "Movie"].includes(firstText(ep, "type")));
      if (firstEpisode) {
        return {
          guid: firstText(firstEpisode, "guid", "id"),
          itemType: firstText(firstEpisode, "type") || "Episode",
          title: firstText(firstEpisode, "title", "name") || title,
        };
      }
    }
  }

  if (itemType === "Directory") {
    const children = await fetchAllDirectoryChildren(site, guid, 6);
    const preferred = ["Movie", "Episode", "Video", "TV", "Directory"];
    children.sort((a, b) => preferred.indexOf(firstText(a, "type")) - preferred.indexOf(firstText(b, "type")));
    for (const child of children) {
      const type = firstText(child, "type");
      if (!["Movie", "Episode", "Video", "TV", "Directory"].includes(type)) continue;
      return resolvePlayableTarget(
        site,
        {
          guid: firstText(child, "guid", "id"),
          itemType: type,
          title: firstText(child, "title", "name") || title,
        },
        depth + 1
      );
    }
  }

  return { guid, itemType, title };
}

function pickAudioStream(streamInfo) {
  const audioStreams = Array.isArray(streamInfo && streamInfo.audio_streams) ? streamInfo.audio_streams : [];
  if (audioStreams.length > 0) return audioStreams[0];
  return isObject(streamInfo && streamInfo.audio_stream) ? streamInfo.audio_stream : {};
}

function collectQualityOptions(streamInfo) {
  const qualities = Array.isArray(streamInfo && streamInfo.qualities) ? streamInfo.qualities : [];
  const map = new Map();
  for (const quality of qualities) {
    const resolution = firstText(quality, "resolution");
    const bitrate = Number(firstText(quality, "bitrate"));
    if (!resolution || !Number.isFinite(bitrate) || bitrate <= 0 || map.has(resolution)) continue;
    map.set(resolution, bitrate);
  }
  return Array.from(map.entries()).map(([resolution, bitrate]) => ({ resolution, bitrate }));
}

function resolutionLabel(resolution) {
  const raw = text(resolution);
  if (!raw) return "转码";
  return /p$/i.test(raw) ? raw : `${raw}p`;
}

function addUniqueUrl(container, seen, name, url) {
  const hitName = text(name);
  const hitUrl = text(url);
  if (!hitName || !hitUrl) return;
  const key = `${hitName}|${hitUrl}`;
  if (seen.has(key)) return;
  seen.add(key);
  container.push({ name: hitName, url: hitUrl });
}

function collectDirectUrls(site, playInfo, streamList) {
  const result = [];
  const seen = new Set();
  const videoStreams = Array.isArray(streamList && streamList.video_streams) ? streamList.video_streams : [];
  for (const stream of videoStreams) {
    const mediaGuid = firstText(stream, "media_guid");
    const label = firstNonBlank(firstText(stream, "resolution_type"), firstText(stream, "title"), "原画");
    if (mediaGuid) {
      addUniqueUrl(result, seen, label, getMediaRangeUrl(site, mediaGuid));
    }
  }
  const mediaGuid = firstText(playInfo, "media_guid");
  if (mediaGuid) {
    addUniqueUrl(result, seen, "原画", getMediaRangeUrl(site, mediaGuid));
  }
  const playLink = absoluteUrl(site, firstText(playInfo, "play_link"));
  if (playLink) {
    addUniqueUrl(result, seen, "默认", playLink);
  }
  return result;
}

async function collectTranscodeUrls(site, playInfo, streamInfo) {
  if (!isObject(streamInfo)) return [];
  const qualities = collectQualityOptions(streamInfo).slice(0, 6);
  if (!qualities.length) return [];
  const videoStream = isObject(streamInfo.video_stream) ? streamInfo.video_stream : {};
  const audioStream = pickAudioStream(streamInfo);
  const mediaGuid = firstNonBlank(firstText(playInfo, "media_guid"), firstText(videoStream, "media_guid"));
  const videoGuid = firstNonBlank(firstText(playInfo, "video_guid"), firstText(videoStream, "guid"));
  if (!mediaGuid || !videoGuid) return [];

  const baseBody = {
    media_guid: mediaGuid,
    video_guid: videoGuid,
    video_encoder: "h264",
    startTimestamp: 0,
    audio_encoder: "aac",
    audio_guid: firstNonBlank(firstText(playInfo, "audio_guid"), firstText(audioStream, "guid")),
    subtitle_guid: firstText(playInfo, "subtitle_guid"),
    channels: toInt(firstText(audioStream, "channels"), 0),
  };

  const results = [];
  const seen = new Set();
  const settled = await Promise.allSettled(
    qualities.map(async (quality) => {
      const body = {
        ...baseBody,
        resolution: quality.resolution,
        bitrate: quality.bitrate,
      };
      const playResult = await startPlay(site, body);
      return {
        name: `${resolutionLabel(quality.resolution)} 转码`,
        url: absoluteUrl(site, firstText(playResult, "play_link")),
      };
    })
  );

  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    addUniqueUrl(results, seen, item.value.name, item.value.url);
  }
  return results;
}

function collectSubtitles(site, streamList) {
  const subtitles = [];
  const subtitleStreams = Array.isArray(streamList && streamList.subtitle_streams) ? streamList.subtitle_streams : [];
  for (const sub of subtitleStreams) {
    if (sub && sub.is_external === false) continue;
    const guid = firstText(sub, "guid");
    if (!guid) continue;
    subtitles.push({
      name: firstNonBlank(firstText(sub, "title"), guid),
      lang: firstText(sub, "language"),
      format: firstNonBlank(firstText(sub, "format"), firstText(sub, "codec_name"), "srt"),
      url: getSubtitleUrl(site, guid),
    });
  }
  return subtitles;
}

async function home(params = {}, context = {}) {
  const sites = resolveSites(params);
  logInfo("进入首页", { siteCount: sites.length, from: context && context.from });
  if (!sites.length) {
    logWarn("缺少 FEINIU 配置，首页返回空结果");
    return { class: [], filters: {}, list: [] };
  }

  try {
    const multipleSites = sites.length > 1;
    const classResults = await Promise.allSettled(sites.map((site) => getMediaDbList(site)));
    const classes = [];
    for (let i = 0; i < classResults.length; i += 1) {
      const result = classResults[i];
      if (result.status !== "fulfilled") {
        logWarn("读取媒体库失败", { site: sites[i].name, error: result.reason && result.reason.message });
        continue;
      }
      const libs = Array.isArray(result.value) ? result.value : [];
      for (const lib of libs) {
        const guid = firstText(lib, "guid", "id");
        if (!guid) continue;
        classes.push(buildLibraryClass(sites[i], lib, multipleSites));
      }
    }

    const homeResults = await Promise.allSettled(sites.map((site) => getPlayList(site)));
    const list = [];
    const seen = new Set();
    for (let i = 0; i < homeResults.length; i += 1) {
      const result = homeResults[i];
      if (result.status !== "fulfilled") {
        logWarn("读取首页推荐失败", { site: sites[i].name, error: result.reason && result.reason.message });
        continue;
      }
      const items = Array.isArray(result.value) ? result.value : [];
      for (const item of items) {
        const guid = firstText(item, "guid", "id");
        if (!guid) continue;
        const dedupeKey = `${sites[i].key}|${guid}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        list.push(await toVod(sites[i], item, { multipleSites, includePicHeaders: true }));
      }
    }

    return {
      class: classes,
      filters: buildHomeFilters(classes),
      list,
    };
  } catch (error) {
    logError("首页构建失败", error);
    return { class: [], filters: {}, list: [] };
  }
}

async function category(params = {}, context = {}) {
  const sites = resolveSites(params);
  const page = Math.max(1, toInt(params.page, 1));
  const categoryId = firstNonBlank(params.categoryId, params.type_id);
  logInfo("进入分类", { categoryId, page, from: context && context.from });

  if (!sites.length || !categoryId) {
    return { list: [], page, pagecount: 0, limit: 0, total: 0 };
  }

  const payload = decodeId(categoryId);
  if (!payload || payload.kind !== "library") {
    logWarn("无效的分类 ID", { categoryId });
    return { list: [], page, pagecount: 0, limit: 0, total: 0 };
  }

  const site = getSiteByKey(sites, payload.site);
  if (!site) {
    logWarn("分类对应站点不存在", payload);
    return { list: [], page, pagecount: 0, limit: 0, total: 0 };
  }

  try {
    const sortInfo = parseSortValue(params);
    const body = {
      tags: { type: ["Movie", "TV", "Directory", "Video"] },
      exclude_grouped_video: 1,
      sort_type: sortInfo.sortType,
      sort_column: sortInfo.sortColumn,
      ancestor_guid: payload.guid,
      page_size: site.pageSize,
    };
    const data = await getItemList(site, body, page);
    const items = Array.isArray(data && data.list) ? data.list : [];
    const multipleSites = sites.length > 1;
    const list = [];
    for (const item of items) {
      list.push(await toVod(site, item, { multipleSites, includePicHeaders: true }));
    }
    const total = toInt(data && data.total, list.length);
    const limit = Math.max(1, site.pageSize);
    const pagecount = Math.max(1, Math.ceil(total / limit));
    return { list, page, pagecount, limit, total };
  } catch (error) {
    logError("分类请求失败", error);
    return { list: [], page, pagecount: 0, limit: 0, total: 0 };
  }
}

async function search(params = {}, context = {}) {
  const sites = resolveSites(params);
  const keyword = firstNonBlank(params.keyword, params.wd);
  const page = Math.max(1, toInt(params.page, 1));
  logInfo("进入搜索", { keyword, page, from: context && context.from });
  if (!sites.length || !keyword) {
    return { list: [], page, pagecount: 0, limit: 0, total: 0 };
  }

  try {
    const multipleSites = sites.length > 1;
    const settled = await Promise.allSettled(sites.map((site) => searchItems(site, keyword)));
    const allItems = [];
    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      if (result.status !== "fulfilled") {
        logWarn("搜索子站失败", { site: sites[i].name, error: result.reason && result.reason.message });
        continue;
      }
      const items = Array.isArray(result.value) ? result.value : [];
      for (const item of items) {
        allItems.push({ site: sites[i], item });
      }
    }
    const total = allItems.length;
    const limit = DEFAULT_PAGE_SIZE;
    const start = (page - 1) * limit;
    const slice = allItems.slice(start, start + limit);
    const list = [];
    for (const entry of slice) {
      list.push(await toVod(entry.site, entry.item, { multipleSites, includePicHeaders: true }));
    }
    return {
      list,
      page,
      pagecount: Math.max(1, Math.ceil(total / limit)),
      limit,
      total,
    };
  } catch (error) {
    logError("搜索失败", error);
    return { list: [], page, pagecount: 0, limit: 0, total: 0 };
  }
}

async function detail(params = {}, context = {}) {
  const sites = resolveSites(params);
  const videoId = firstNonBlank(params.videoId, params.vod_id);
  logInfo("进入详情", { videoId, from: context && context.from });
  if (!sites.length || !videoId) return { list: [] };

  const payload = decodeId(videoId);
  if (!payload || payload.kind !== "item") {
    logWarn("无效的详情 ID", { videoId });
    return { list: [] };
  }

  const site = getSiteByKey(sites, payload.site);
  if (!site) return { list: [] };

  try {
    const item = await getItem(site, payload.guid);
    const itemType = firstText(item, "type");
    const vod = await buildDetailVod(site, item, sites.length > 1);
    let playSources = [];

    if (itemType === "TV") {
      playSources = await buildTvPlaySources(site, item);
    } else if (itemType === "Directory") {
      playSources = await buildDirectoryPlaySources(site, item);
    } else {
      playSources = [{
        name: site.name,
        episodes: [{
          name: firstText(item, "title", "name") || "播放",
          playId: buildEpisodePlayId(site, item, { itemType, title: firstText(item, "title", "name") || "播放" }),
        }],
      }];
    }

    vod.vod_play_sources = playSources;
    return { list: [vod] };
  } catch (error) {
    logError("详情获取失败", error);
    return { list: [] };
  }
}

async function play(params = {}, context = {}) {
  const sites = resolveSites(params);
  const playId = firstNonBlank(params.playId, params.id);
  logInfo("进入播放", { playId, from: context && context.from });
  if (!sites.length || !playId) return { urls: [], parse: 1 };

  const payload = decodeId(playId);
  if (!payload || payload.kind !== "play") {
    logWarn("无效的播放 ID", { playId });
    return { urls: [], parse: 1 };
  }

  const site = getSiteByKey(sites, payload.site);
  if (!site) return { urls: [], parse: 1 };

  try {
    const token = await getSiteToken(site);
    const target = await resolvePlayableTarget(site, payload);
    const playInfo = await getPlayInfo(site, target.guid);
    const streamList = await getStreamList(site, target.guid);
    const mediaGuid = firstText(playInfo, "media_guid");
    const streamInfo = mediaGuid ? await getStream(site, mediaGuid) : null;

    const directUrls = collectDirectUrls(site, playInfo, streamList);
    const transcodeUrls = await collectTranscodeUrls(site, playInfo, streamInfo);
    const urls = [];
    const seen = new Set();
    for (const item of [...directUrls, ...transcodeUrls]) {
      addUniqueUrl(urls, seen, item.name, item.url);
    }

    if (!urls.length) {
      const fallback = absoluteUrl(site, firstText(playInfo, "play_link"));
      if (fallback) {
        urls.push({ name: target.title || "默认", url: fallback });
      }
    }

    if (!urls.length) {
      throw new Error("未获取到可播放地址");
    }

    const subs = collectSubtitles(site, streamList);
    const header = buildMediaHeaders(site, token);
    logInfo("播放地址构建完成", { site: site.name, urlCount: urls.length, subCount: subs.length });
    return {
      urls,
      parse: 0,
      header,
      subs,
      subtitles: subs,
    };
  } catch (error) {
    logError("播放解析失败", error);
    return { urls: [], parse: 1, msg: error.message || "播放失败" };
  }
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
