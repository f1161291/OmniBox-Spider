// @name 爱盼
// @author 
// @description 网盘资源导航站：https://aipan.win ，站点仅索引资源不提供播放；支持首页、分类、详情、搜索、网盘播放、刮削、弹幕、播放记录
// v1.0.3 对齐人人电影.py：playId 改 JSON（drive-file + routeType 逐线路编码）；修复 addPlayHistory 在宿主不存在导致 TypeError 冒泡、已拿到直链却返回空 urls 的致命 bug；fallback 统一 parse:0
// v1.0.4 夸克线路强制展开「本地代理 / 服务端代理 / 直连」三条，不受调用方过滤与 EXTERNAL_SERVER_PROXY_ENABLED 影响（FORCE_ALL_ROUTE_TYPES_CONFIG 可配）
// v1.0.5 百度网盘只保留「直连」一条线路，不再展开代理（DIRECT_ONLY_ROUTE_TYPES_CONFIG 可配）
// v1.0.6 去掉「本地代理」线路，只保留「服务端代理 / 直连」
// @version 1.0.6
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/网盘/爱盼.js
// @dependencies cheerio

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");

const HOST = (process.env.AIPAN_HOST || "https://aipan.win").replace(/\/$/, "");
const UA = process.env.AIPAN_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: `${HOST}/`,
};
const PAGE_SIZE = Math.max(1, Math.min(100, parseInt(process.env.AIPAN_PAGE_SIZE || "30", 10) || 30));

const DRIVE_TYPE_CONFIG = splitConfigList(process.env.DRIVE_TYPE_CONFIG || "quark;uc;guangya;baidu;xunlei");
const SOURCE_NAMES_CONFIG = splitConfigList(process.env.SOURCE_NAMES_CONFIG || "服务端代理;直连");
const DRIVE_ORDER = splitConfigList(process.env.DRIVE_ORDER || "baidu;tianyi;quark;uc;115;xunlei;ali;123pan;guangya").map((s) => s.toLowerCase());
const EXTERNAL_SERVER_PROXY_ENABLED = String(process.env.EXTERNAL_SERVER_PROXY_ENABLED || "false").toLowerCase() === "true";
// 需要「强制展开全部代理线路」的网盘类型：夸克默认同时给出 本地代理 / 服务端代理 / 直连，
// 不受调用方过滤与 allowServerProxy 影响（夸克直连在国内网络下经常不稳，多留两条线路给用户切换）
const FORCE_ALL_ROUTE_TYPES_CONFIG = splitConfigList(process.env.FORCE_ALL_ROUTE_TYPES_CONFIG || "quark").map((s) => s.toLowerCase());
// 只给「直连」一条线路的网盘类型：百度网盘自身直连足够，多余的代理线路只是噪音
const DIRECT_ONLY_ROUTE_TYPES_CONFIG = splitConfigList(process.env.DIRECT_ONLY_ROUTE_TYPES_CONFIG || "baidu").map((s) => s.toLowerCase());

const VIDEO_EXTENSIONS = [
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".mpg", ".mpeg", ".rmvb", ".ts", ".m2ts", ".webm", ".iso",
];

// 官网真实导航分类；type_id 直接编码 /api/movies/list 的查询参数
const CLASS_LIST = [
  { type_id: "sort=latest", type_name: "最新发布" },
  { type_id: "imdbMin=8", type_name: "高分精选" },
  { type_id: "sort=rating", type_name: "评分排行" },
  { type_id: "region=华语", type_name: "华语热门" },
  { type_id: "region=欧美", type_name: "欧美影片" },
  { type_id: "region=日韩", type_name: "日韩影片" },
  { type_id: "genre=动画", type_name: "动画电影" },
  { type_id: "res=quark", type_name: "夸克资源" },
  { type_id: "res=guangya", type_name: "光鸭资源" },
  { type_id: "res=magnet", type_name: "磁力资源" },
];

const FILTER_GROUPS = [
  { key: "res", name: "网盘", init: "", value: [
    { name: "全部", value: "" }, { name: "夸克", value: "quark" }, { name: "光鸭", value: "guangya" },
    { name: "磁力", value: "magnet" }, { name: "无资源", value: "none" },
  ] },
  { key: "genre", name: "类型", init: "", value: [
    { name: "全部", value: "" }, ...["剧情", "动作", "喜剧", "惊悚", "犯罪", "冒险", "科幻", "悬疑", "爱情", "奇幻",
      "恐怖", "动画", "历史", "古装", "传记", "战争", "家庭", "武侠", "运动", "歌舞", "音乐", "纪录片", "灾难",
      "同性", "西部", "儿童", "情色", "真人秀", "Sci-Fi & Fantasy", "动作冒险", "短片", "纪录", "动漫", "热血",
      "脱口秀", "War & Politics", "人性", "黑色电影"].map((v) => ({ name: v, value: v })),
  ] },
  { key: "year", name: "年份", init: "", value: [
    { name: "全部", value: "" }, ...["2020年代", "2010年代", "2000年代", "90年代", "80年代", "更早"].map((v) => ({ name: v, value: v })),
  ] },
  { key: "region", name: "地区", init: "", value: [
    { name: "全部", value: "" }, { name: "华语", value: "华语" }, { name: "欧美", value: "欧美" }, { name: "日韩", value: "日韩" },
  ] },
  { key: "sort", name: "排序", init: "latest", value: [
    { name: "最新上映", value: "latest" }, { name: "评分", value: "rating" }, { name: "最早上映", value: "oldest" },
  ] },
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function splitConfigList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getBodyText(res) {
  const body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.toString();
  return String(body || "");
}

function absUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${HOST}${value}`;
  return `${HOST}/${value.replace(/^\/+/, "")}`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatFileSize(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(2)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)}MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  return `${(n / 1024 ** 4).toFixed(2)}TB`;
}

function encodePlayMeta(meta) {
  try {
    return Buffer.from(JSON.stringify(meta || {}), "utf8").toString("base64");
  } catch (_) {
    return "";
  }
}

function decodePlayMeta(meta) {
  try {
    return JSON.parse(Buffer.from(String(meta || ""), "base64").toString("utf8") || "{}");
  } catch (_) {
    return {};
  }
}

// 统一解析 episode.playId：优先 JSON（对齐人人电影.py 的 drive-file 格式，
// 线路 routeType 在 detail 阶段就编码进 playId），兼容旧 pipe+base64 / share||| / page||| 格式
function parsePlayId(rawPlayId) {
  const raw = typeof rawPlayId === "string" ? rawPlayId.trim() : rawPlayId;
  if (raw && typeof raw === "object") return { ...raw };
  const text = String(raw || "");
  if (text.startsWith("share|||")) {
    return { kind: "link", url: decodeURIComponent(text.slice("share|||".length)), name: "打开网盘" };
  }
  if (text.startsWith("page|||")) {
    return { kind: "page", url: decodeURIComponent(text.slice("page|||".length)), name: "详情页" };
  }
  try {
    const meta = JSON.parse(text);
    if (meta && typeof meta === "object") return meta;
  } catch (_) { /* 非 JSON，走旧格式兼容 */ }
  const parts = text.split("|");
  if (parts.length >= 2 && /^https?:\/\//i.test(parts[0])) {
    const legacy = parts.length >= 3 ? decodePlayMeta(parts[2]) : {};
    return {
      kind: "drive-file",
      shareURL: parts[0],
      fid: parts[1],
      name: legacy.e || "播放",
      routeType: "直连",
      sid: legacy.sid || "", t: legacy.t || "", p: legacy.p || "", e: legacy.e || "",
      formattedId: `${parts[0]}|${parts[1]}`,
    };
  }
  return {};
}

function buildScrapedFileName(scrapeData, mapping, originalFileName) {
  if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < 0.5)) {
    return originalFileName;
  }
  if (!scrapeData || !scrapeData.title) return originalFileName;
  if (scrapeData.type === "tv" || mapping.seasonNumber) {
    const seasonNum = mapping.seasonNumber || 1;
    const epNum = mapping.episodeNumber || 1;
    const seasonAirYear = scrapeData.seasonAirYear || "";
    let name = `${scrapeData.title}`;
    if (seasonAirYear) name += `.${seasonAirYear}`;
    name += `.S${String(seasonNum).padStart(2, "0")}E${String(epNum).padStart(2, "0")}`;
    return name;
  }
  return scrapeData.title || originalFileName;
}

function normalizeEpisodeName(episodeName) {
  if (!episodeName) return "";
  return String(episodeName)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/（[^）]*）/g, " ")
    .replace(/第\s*([0-9一二三四五六七八九十百千零〇两]+)\s*[集话期]/g, "E$1")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFileNameForDanmu(vodName, episodeTitle) {
  const title = cleanText(vodName || "");
  const episode = normalizeEpisodeName(episodeTitle || "");
  if (!title) return episode;
  if (!episode || title.includes(episode)) return title;
  return `${title} ${episode}`;
}

function buildPlayHistoryPayload({ sourceId, vodId, title, pic, episode, episodeName, episodeNumber }) {
  if (!sourceId || !vodId) return null;
  return {
    vodId,
    title: title || "",
    pic: pic || "",
    episode,
    sourceId,
    episodeNumber: typeof episodeNumber === "number" ? episodeNumber : undefined,
    episodeName: episodeName || "",
  };
}

function getBaseURLHost(context = {}) {
  const baseURL = String(context?.baseURL || "").trim();
  if (!baseURL) return "";
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch (_) {
    return baseURL.toLowerCase();
  }
}

function isPrivateHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".intra")) return true;
  if (host.includes(":")) return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  return false;
}

function canUseServerProxy(context = {}) {
  if (EXTERNAL_SERVER_PROXY_ENABLED) return true;
  return isPrivateHost(getBaseURLHost(context));
}

function resolveCallerSource(params = {}, context = {}) {
  return String(context?.from || params?.source || "").toLowerCase();
}

function filterSourceNamesForCaller(sourceNames = [], callerSource = "", context = {}) {
  let filtered = Array.isArray(sourceNames) ? [...sourceNames] : [];
  const allowServerProxy = canUseServerProxy(context);
  if (callerSource === "web") {
    filtered = filtered.filter((name) => name !== "本地代理");
  } else if (callerSource === "emby") {
    filtered = allowServerProxy ? filtered.filter((name) => name === "服务端代理") : filtered.filter((name) => name !== "服务端代理");
  } else if (callerSource === "uz") {
    filtered = filtered.filter((name) => name !== "本地代理");
  }
  if (!allowServerProxy) filtered = filtered.filter((name) => name !== "服务端代理");
  return filtered.length > 0 ? filtered : ["直连"];
}

// 对齐人人电影.py get_route_types：仅已知网盘类型展开多线路（本地代理/服务端代理/直连），
// 未知类型统一「直连」。DRIVE_TYPE_CONFIG / SOURCE_NAMES_CONFIG 均为 splitConfigList 返回的数组。
// DIRECT_ONLY_ROUTE_TYPES_CONFIG（默认 baidu）只给「直连」，FORCE_ALL_ROUTE_TYPES_CONFIG（默认 quark）给全部线路。
function getRouteTypes(context = {}, driveType = "") {
  const normalized = String(driveType || "").toLowerCase();
  const known = Array.isArray(DRIVE_TYPE_CONFIG) && DRIVE_TYPE_CONFIG.includes(normalized);
  if (!known) return ["直连"];
  const directOnly = Array.isArray(DIRECT_ONLY_ROUTE_TYPES_CONFIG) && DIRECT_ONLY_ROUTE_TYPES_CONFIG.includes(normalized);
  if (directOnly) return ["直连"];
  const forceAll = Array.isArray(FORCE_ALL_ROUTE_TYPES_CONFIG) && FORCE_ALL_ROUTE_TYPES_CONFIG.includes(normalized);
  if (forceAll) {
    const all = Array.isArray(SOURCE_NAMES_CONFIG) ? SOURCE_NAMES_CONFIG.filter(Boolean) : [];
    return all.length ? [...all] : ["服务端代理", "直连"];
  }
  return filterSourceNamesForCaller(SOURCE_NAMES_CONFIG, resolveCallerSource({}, context), context);
}

function resolveRouteType(flag = "", callerSource = "", context = {}) {
  const allowServerProxy = canUseServerProxy(context);
  const validRouteTypes = new Set(["本地代理", "服务端代理", "直连"]);
  let routeType = "直连";
  if (callerSource === "web" || callerSource === "emby") {
    routeType = allowServerProxy ? "服务端代理" : "直连";
  }
  if (flag) {
    if (flag.includes("-")) {
      const parts = flag.split("-");
      routeType = parts[parts.length - 1];
    } else {
      routeType = flag;
    }
  }
  if (!validRouteTypes.has(routeType)) routeType = "直连";
  if (!allowServerProxy && routeType === "服务端代理") routeType = "直连";
  if (callerSource === "uz" && routeType === "本地代理") routeType = "直连";
  return routeType;
}

function inferDriveTypeFromSourceName(name = "") {
  const raw = String(name || "").toLowerCase();
  if (raw.includes("百度")) return "baidu";
  if (raw.includes("天翼")) return "tianyi";
  if (raw.includes("夸克")) return "quark";
  if (raw === "uc" || raw.includes("uc")) return "uc";
  if (raw.includes("光鸭")) return "guangya";
  if (raw.includes("115")) return "115";
  if (raw.includes("迅雷")) return "xunlei";
  if (raw.includes("阿里")) return "ali";
  if (raw.includes("123")) return "123pan";
  return raw;
}

function sortPlaySourcesByDriveOrder(playSources = []) {
  if (!Array.isArray(playSources) || playSources.length <= 1 || DRIVE_ORDER.length === 0) return playSources;
  const orderMap = new Map(DRIVE_ORDER.map((name, index) => [name, index]));
  return [...playSources].sort((a, b) => {
    const aType = inferDriveTypeFromSourceName(a?.name || "");
    const bType = inferDriveTypeFromSourceName(b?.name || "");
    const aOrder = orderMap.has(aType) ? orderMap.get(aType) : Number.MAX_SAFE_INTEGER;
    const bOrder = orderMap.has(bType) ? orderMap.get(bType) : Number.MAX_SAFE_INTEGER;
    return aOrder !== bOrder ? aOrder - bOrder : 0;
  });
}

function isVideoFile(file = {}) {
  const name = String(file.file_name || file.name || "").toLowerCase();
  const hasVideoExt = VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
  const sdkFileFlag = file.file === 1 || file.file === true || file.is_file === 1 || file.isFile === 1;
  return hasVideoExt || (sdkFileFlag && hasVideoExt);
}

function isFolderLike(file = {}) {
  if (
    file.is_dir === 1 || file.isDir === 1 || file.dir === 1 || file.dir === true ||
    file.folder === 1 || file.folder === true || file.is_folder === 1
  ) return true;
  const type = String(file.type || file.obj_type || file.category || file.file_type || "").toLowerCase();
  return type.includes("dir") || type.includes("folder");
}

async function getAllVideoFiles(shareURL, files, depth = 0, seen = new Set()) {
  if (!Array.isArray(files) || !files.length || depth > 8) return [];
  const videos = [];
  for (const file of files) {
    const fid = String(file.fid || file.file_id || file.id || "").trim();
    if (!fid) continue;
    if (isVideoFile(file)) {
      videos.push({ fid, file_name: String(file.file_name || file.name || fid), size: Number(file.size || file.file_size || 0) });
      continue;
    }
    if (isFolderLike(file)) {
      const key = `${shareURL}|${fid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const subFileList = await OmniBox.getDriveFileList(shareURL, fid);
        const subFiles = Array.isArray(subFileList?.files) ? subFileList.files : Array.isArray(subFileList) ? subFileList : [];
        if (subFiles.length) {
          const nested = await getAllVideoFiles(shareURL, subFiles, depth + 1, seen);
          if (nested.length) videos.push(...nested);
        }
      } catch (e) {
        await OmniBox.log("warn", `[爱盼][detail] 读取子目录失败 share=${shareURL} fid=${fid}: ${e.message}`);
      }
    }
  }
  return videos;
}

function dedupeEpisodes(episodes = []) {
  const seen = new Set();
  const result = [];
  for (const ep of episodes) {
    const key = `${ep.playId}@@${ep.name}`;
    if (!ep.playId || seen.has(key)) continue;
    seen.add(key);
    result.push(ep);
  }
  return result;
}

async function requestText(url, options = {}) {
  url = absUrl(url);
  const res = await OmniBox.request(url, {
    method: options.method || "GET",
    headers: { ...HEADERS, ...(options.headers || {}), Referer: options.referer || `${HOST}/` },
    timeout: options.timeout || 20000,
    body: options.body,
  });
  const statusCode = Number(res?.statusCode || 0);
  const text = getBodyText(res);
  if (statusCode < 200 || statusCode >= 400) throw new Error(`HTTP ${statusCode} @ ${url}`);
  return text;
}

async function requestJson(url, options = {}) {
  const text = await requestText(url, { ...options, headers: { ...(options.headers || {}), Accept: "application/json" } });
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`JSON 解析失败 @ ${url}`);
  }
}

function mapMovies(movies) {
  if (!Array.isArray(movies)) return [];
  const seen = new Set();
  const list = [];
  for (const m of movies) {
    const id = String(m?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const year = m.year ? String(m.year) : "";
    const rate = m.rate ? String(m.rate) : "";
    const parts = [year, rate].filter(Boolean);
    const genres = Array.isArray(m.genres) ? m.genres.slice(0, 2).join("/") : "";
    if (genres) parts.push(genres);
    list.push({
      vod_id: `${HOST}/movie/${id}`,
      vod_name: String(m.title || m.subtitle || id),
      vod_pic: String(m.cover || ""),
      vod_remarks: parts.join(" · "),
      vod_content: "",
    });
  }
  return list;
}

function buildFilters() {
  const filters = {};
  for (const c of CLASS_LIST) filters[c.type_id] = FILTER_GROUPS;
  return filters;
}

function pickFilters(params = {}) {
  const raw = params?.filters ?? params?.extend ?? params?.ext ?? params?.filter;
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const key = String(item.key || item.k || "").trim();
      if (key) {
        let value = item.value ?? item.v;
        if (Array.isArray(value)) value = value.length ? (value[0]?.value ?? value[0]?.v ?? "") : "";
        out[key] = value;
      } else {
        Object.assign(out, item);
      }
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      out[k] = Array.isArray(v) ? (v.length ? (v[0]?.value ?? v[0]?.v ?? "") : "") : v;
    }
  }
  return out;
}

function parseTypeId(typeId) {
  const out = {};
  String(typeId || "").split("&").forEach((kv) => {
    const at = kv.indexOf("=");
    if (at <= 0) return;
    try {
      out[decodeURIComponent(kv.slice(0, at))] = decodeURIComponent(kv.slice(at + 1));
    } catch (_) {
      out[kv.slice(0, at)] = kv.slice(at + 1);
    }
  });
  return out;
}

async function home(params, context) {
  try {
    const data = await requestJson(`/api/movies/list?sort=latest&page=1&pageSize=${PAGE_SIZE}`);
    const list = mapMovies(data?.movies);
    return { class: CLASS_LIST, filters: buildFilters(), list };
  } catch (e) {
    await OmniBox.log("error", `[爱盼][home] ${e.message}`);
    return { class: CLASS_LIST, filters: buildFilters(), list: [] };
  }
}

async function category(params, context) {
  try {
    const typeId = String(params.categoryId || params.type_id || "sort=latest");
    const page = Math.max(1, parseInt(params.page || 1, 10) || 1);
    const query = parseTypeId(typeId);
    const chosen = pickFilters(params);
    for (const key of ["res", "genre", "year", "region", "sort", "imdbMin"]) {
      if (chosen[key] !== undefined && chosen[key] !== "") query[key] = chosen[key];
    }
    if (!query.sort && !query.imdbMin) query.sort = "latest";
    const qs = new URLSearchParams({ ...query, page: String(page), pageSize: String(PAGE_SIZE) }).toString();
    const data = await requestJson(`/api/movies/list?${qs}`);
    const list = mapMovies(data?.movies);
    const total = Number(data?.total || 0) || list.length;
    const pagecount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return { page, pagecount, total, list };
  } catch (e) {
    await OmniBox.log("error", `[爱盼][category] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = String(params.keyword || params.wd || params.key || params.search || "").trim();
    const page = Math.max(1, parseInt(params.page || 1, 10) || 1);
    if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
    const data = await requestJson(`/api/movies/search?q=${encodeURIComponent(keyword)}`);
    const list = mapMovies(data?.movies);
    const total = Number(data?.total || 0) || list.length;
    return { page: 1, pagecount: 1, total, list };
  } catch (e) {
    await OmniBox.log("error", `[爱盼][search] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const id = String(params.videoId || params.id || params.url || "").trim();
    if (!id) return { list: [] };

    const source = resolveCallerSource(params, context);
    const detailUrl = /^https?:\/\//i.test(id) ? id : absUrl(`/movie/${id.replace(/^\/+/, "")}`);
    const html = await requestText(detailUrl);
    const $ = cheerio.load(html);

    const ogTitle = cleanText($("meta[property='og:title']").attr("content") || "");
    const title = cleanText($(".v2d-top h1, .v2d-top .title").first().text()) ||
      (ogTitle ? ogTitle.replace(/\s*-\s*爱盼\s*$/, "").trim() : "");
    const pic = String($("meta[property='og:image']").attr("content") || "") ||
      absUrl($(".v2d-poster img").first().attr("src") || "");
    const desc = cleanText($("meta[name='description']").attr("content") || $(".v2d-desc, .v2d-overview").first().text());

    const shareLinks = [];
    const seenLinks = new Set();
    $(".v2d-rrow a[data-pan-kind], .v2d-rrow a.v2-mini.pri, .v2d-quick a[href]").each((_, el) => {
      const href = String($(el).attr("href") || "").trim();
      if (!href || !/^https?:\/\//i.test(href) || seenLinks.has(href)) return;
      seenLinks.add(href);
      shareLinks.push(href);
    });
    if (!shareLinks.length) {
      $("a[href*='pan.quark.cn'], a[href*='baidu.com/s/'], a[href*='guangyapan.com'], a[href*='pan.xunlei.com'], a[href*='magnet:']").each((_, el) => {
        const href = String($(el).attr("href") || "").trim();
        if (!href || seenLinks.has(href)) return;
        seenLinks.add(href);
        shareLinks.push(href);
      });
    }

    const driveTypeCountMap = {};
    const rawDriveInfos = [];
    for (const shareURL of shareLinks) {
      let driveInfo = null;
      try {
        driveInfo = await OmniBox.getDriveInfoByShareURL(shareURL);
      } catch (_) {
        driveInfo = null;
      }
      const displayName = driveInfo?.displayName || "网盘";
      driveTypeCountMap[displayName] = (driveTypeCountMap[displayName] || 0) + 1;
      rawDriveInfos.push({ shareURL, driveInfo, displayName });
    }

    const driveTypeCurrentIndexMap = {};
    const filesForScraping = [];
    let playSources = [];

    for (const item of rawDriveInfos) {
      const { shareURL, driveInfo } = item;
      let displayName = item.displayName;
      if ((driveTypeCountMap[displayName] || 0) > 1) {
        driveTypeCurrentIndexMap[displayName] = (driveTypeCurrentIndexMap[displayName] || 0) + 1;
        displayName = `${displayName}${driveTypeCurrentIndexMap[displayName]}`;
      }

      let allVideoFiles = [];
      try {
        const rootFileList = await OmniBox.getDriveFileList(shareURL, "0");
        const rootFiles = Array.isArray(rootFileList?.files) ? rootFileList.files : Array.isArray(rootFileList) ? rootFileList : [];
        allVideoFiles = await getAllVideoFiles(shareURL, rootFiles, 0, new Set());
        await OmniBox.log("info", `[爱盼][detail] share=${shareURL} rootFiles=${rootFiles.length} videoFiles=${allVideoFiles.length}`);
      } catch (e) {
        await OmniBox.log("warn", `[爱盼][detail] 扫描网盘文件失败: ${e.message}`);
      }

      // 对齐人人电影.py：文件只收集一次（刮削用），每条线路单独生成 JSON playId
      // （kind/shareURL/fid/routeType 在 detail 阶段就编码进去，播放时不再靠 flag 重算）
      const fileEntries = allVideoFiles.map((file) => {
        const sizeText = formatFileSize(file.size);
        const episodeName = cleanText(String(file.file_name || "资源").replace(/\.[^.]+$/, "")) || "资源";
        const displayFileName = sizeText ? `[${sizeText}] ${file.file_name}` : file.file_name;
        const formattedFileId = `${shareURL}|${file.fid}`;
        if (file.fid && !filesForScraping.some((item) => item.fid === formattedFileId)) {
          filesForScraping.push({ file_name: episodeName, fid: formattedFileId, file_id: formattedFileId });
        }
        return { file, episodeName, displayFileName, formattedFileId };
      });

      const driveType = String(driveInfo?.driveType || "").toLowerCase();
      const routeTypes = getRouteTypes(context, driveType);
      for (const routeType of routeTypes) {
        const episodes = dedupeEpisodes(fileEntries.map(({ file, episodeName, displayFileName, formattedFileId }) => ({
          name: displayFileName,
          playId: JSON.stringify({
            kind: "drive-file",
            shareURL,
            fid: file.fid,
            name: episodeName,
            routeType,
            sid: detailUrl, t: title, p: pic, e: episodeName,
            formattedId: formattedFileId,
          }),
        })));
        if (!episodes.length) {
          episodes.push({ name: "打开网盘链接", playId: `share|||${encodeURIComponent(shareURL)}` });
        }
        const lineName = routeTypes.length > 1 ? `${displayName}-${routeType}` : displayName;
        playSources.push({ name: lineName, episodes });
      }
    }

    if (playSources.length > 1) playSources = sortPlaySourcesByDriveOrder(playSources);

    const vodItem = {
      vod_id: detailUrl,
      vod_name: title,
      vod_pic: pic,
      vod_content: desc,
      vod_play_sources: playSources.length
        ? playSources
        : [{ name: "详情页", episodes: [{ name: "打开详情页", playId: `page|||${encodeURIComponent(detailUrl)}` }] }],
    };

    if (filesForScraping.length > 0) {
      try {
        await OmniBox.log("info", `[爱盼][detail] 开始统一刮削: vodId=${detailUrl}, files=${filesForScraping.length}`);
        await OmniBox.processScraping(detailUrl, title || "", title || "", filesForScraping);
        const metadata = await OmniBox.getScrapeMetadata(detailUrl);
        const scrapeData = metadata?.scrapeData || null;
        const videoMappings = Array.isArray(metadata?.videoMappings) ? metadata.videoMappings : [];
        if (scrapeData || videoMappings.length > 0) {
          for (const s of vodItem.vod_play_sources || []) {
            for (const episode of s.episodes || []) {
              const meta = parsePlayId(episode.playId);
              const formattedId = meta.formattedId || (meta.shareURL && meta.fid ? `${meta.shareURL}|${meta.fid}` : "");
              const matched = videoMappings.find((m) => m && m.fileId === formattedId);
              if (matched && scrapeData) {
                const newName = buildScrapedFileName(scrapeData, matched, String(episode.name || ""));
                if (newName && newName !== episode.name) episode.name = newName;
              }
            }
          }
          if (scrapeData) {
            if (scrapeData.title) vodItem.vod_name = scrapeData.title;
            if (scrapeData.posterPath) vodItem.vod_pic = `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`;
            if (scrapeData.overview) vodItem.vod_content = scrapeData.overview;
            if (scrapeData.releaseDate) vodItem.vod_year = String(scrapeData.releaseDate).slice(0, 4);
            if (scrapeData.voteAverage) vodItem.vod_douban_score = Number(scrapeData.voteAverage).toFixed(1);
          }
          await OmniBox.log("info", `[爱盼][detail] 统一刮削完成: vodId=${detailUrl}, mappings=${videoMappings.length}`);
        } else {
          await OmniBox.log("info", `[爱盼][detail] 统一刮削无结果: vodId=${detailUrl}`);
        }
      } catch (error) {
        await OmniBox.log("warn", `[爱盼][detail] 统一刮削失败: ${error.message}`);
      }
    } else {
      await OmniBox.log("info", `[爱盼][detail] 跳过统一刮削: 未收集到可刮削文件`);
    }

    await OmniBox.log("info", `[爱盼][detail] url=${detailUrl} title=${vodItem.vod_name || title} shareLinks=${shareLinks.length} lines=${playSources.length}`);
    return { list: [vodItem] };
  } catch (e) {
    await OmniBox.log("error", `[爱盼][detail] ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  try {
    const rawPlayId = params.playId || params.url || params.input;
    const flag = String(params.flag || "").trim();
    const source = resolveCallerSource(params, context);

    const meta = parsePlayId(rawPlayId);
    const kind = meta.kind || "";

    // link/page：直接给宿主分享页/详情页（走 parse:1 页面兜底，宿主可嗅探）
    if (kind === "link" || kind === "page") {
      const pageUrl = String(meta.url || "");
      const header = { ...HEADERS, Referer: pageUrl || `${HOST}/` };
      const name = kind === "link" ? "打开网盘" : "详情页";
      return { parse: 1, jx: 0, url: pageUrl, urls: [{ name, url: pageUrl }], header, headers: header };
    }

    const shareURL = String(meta.shareURL || "");
    let fileId = String(meta.fid || "");
    const playMeta = meta && typeof meta === "object" ? meta : {};
    if (!shareURL) throw new Error("播放参数缺少分享链接");

    // routeType 优先取 detail 阶段编码进 playId 的值，其次按 flag 重算（兼容旧 playId）
    const routeType = meta.routeType || resolveRouteType(flag, source, context);

    if (!fileId) {
      const rootFileList = await OmniBox.getDriveFileList(shareURL, "0");
      const rootFiles = Array.isArray(rootFileList?.files) ? rootFileList.files : Array.isArray(rootFileList) ? rootFileList : [];
      const files = await getAllVideoFiles(shareURL, rootFiles, 0, new Set());
      if (files.length) fileId = files[0].fid;
    }
    if (!fileId) {
      const header = { ...HEADERS, Referer: `${HOST}/` };
      return { parse: 1, jx: 0, url: shareURL, urls: [{ name: "打开网盘", url: shareURL }], header, headers: header };
    }

    const metadataPromise = (async () => {
      const result = {
        danmakuList: [],
        scrapeTitle: "",
        scrapePic: "",
        episodeNumber: null,
        episodeName: playMeta.e || params.episodeName || "",
      };
      const vodId = String(playMeta.sid || params.vodId || params.videoId || "").trim();
      if (!vodId) return result;
      try {
        const metadata = await OmniBox.getScrapeMetadata(vodId);
        if (!metadata || !metadata.scrapeData || !Array.isArray(metadata.videoMappings)) return result;
        const formattedFileId = `${shareURL}|${fileId}`;
        const matched = metadata.videoMappings.find((m) => m && m.fileId === formattedFileId);
        const scrapeData = metadata.scrapeData || {};
        result.scrapeTitle = scrapeData.title || "";
        if (scrapeData.posterPath) result.scrapePic = `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`;
        if (!matched) return result;
        if (matched.episodeNumber) result.episodeNumber = matched.episodeNumber;
        if (matched.episodeName && !result.episodeName) result.episodeName = matched.episodeName;
        const fileName = buildScrapedFileName(scrapeData, matched, result.episodeName || "") ||
          buildFileNameForDanmu(scrapeData.title || playMeta.t || "", result.episodeName || "");
        if (fileName) {
          const matchedDanmaku = await OmniBox.getDanmakuByFileName(fileName);
          if (Array.isArray(matchedDanmaku) && matchedDanmaku.length > 0) result.danmakuList = matchedDanmaku;
        }
      } catch (error) {
        await OmniBox.log("warn", `[爱盼][play] 弹幕匹配失败: ${error.message}`);
      }
      return result;
    })();

    const [playInfoResult, metadataResult] = await Promise.allSettled([
      OmniBox.getDriveVideoPlayInfo(shareURL, fileId, routeType),
      metadataPromise,
    ]);

    if (playInfoResult.status !== "fulfilled") {
      const reason = playInfoResult.reason && playInfoResult.reason.message ? playInfoResult.reason.message : String(playInfoResult.reason || "网盘直链解析失败");
      await OmniBox.log("warn", `[爱盼][play] getDriveVideoPlayInfo 失败: ${reason}，fallback 分享页 share=${shareURL}`);
      const fbHeader = { ...HEADERS, Referer: `${HOST}/` };
      return { urls: [{ name: "打开网盘", url: shareURL }], header: fbHeader, headers: fbHeader, parse: 0, jx: 0, url: shareURL };
    }
    const playInfo = playInfoResult.value || {};
    await OmniBox.log("info", `[爱盼][play] SDK返回 url类型=${typeof playInfo.url} 数组=${Array.isArray(playInfo.url)} urls数组=${Array.isArray(playInfo.urls)} keys=${Object.keys(playInfo).join(",")}`);

    // SDK 的 url 字段可能是 string（见 javascript-sdk.md）或 [{name,url}] 数组，也可能是 urls；三种都要兼容
    const urls = [];
    const rawUrls = playInfo.urls || playInfo.url || [];
    if (typeof rawUrls === "string" && rawUrls) {
      urls.push({ name: "播放", url: rawUrls });
    } else if (Array.isArray(rawUrls)) {
      for (const item of rawUrls) {
        if (typeof item === "string" && item) {
          urls.push({ name: "播放", url: item });
        } else if (item && item.url) {
          urls.push({ name: item.name || "播放", url: item.url });
        }
      }
    }

    if (!urls.length) {
      await OmniBox.log("warn", `[爱盼][play] SDK未返回可用直链，fallback 分享页 share=${shareURL}`);
      const fbHeader = { ...HEADERS, Referer: `${HOST}/` };
      return { urls: [{ name: "打开网盘", url: shareURL }], header: fbHeader, headers: fbHeader, parse: 0, jx: 0, url: shareURL };
    }

    let danmakuList = Array.isArray(playInfo.danmaku) ? playInfo.danmaku : [];
    let scrapeTitle = "";
    let scrapePic = "";
    let episodeNumber = null;
    let episodeName = playMeta.e || params.episodeName || "";
    if (metadataResult.status === "fulfilled" && metadataResult.value) {
      const v = metadataResult.value;
      danmakuList = v.danmakuList?.length ? v.danmakuList : danmakuList;
      scrapeTitle = v.scrapeTitle || "";
      scrapePic = v.scrapePic || "";
      episodeNumber = v.episodeNumber ?? null;
      episodeName = v.episodeName || episodeName;
    }

    // 观看记录是可选增强：宿主未必提供 addPlayHistory，必须做能力检测，
    // 否则 TypeError 会冒泡到外层 catch，把已拿到的直链变成空 urls（宿主报「未获取到播放地址」）
    try {
      if (typeof OmniBox.addPlayHistory === "function") {
        const historyPayload = buildPlayHistoryPayload({
          sourceId: context?.sourceId,
          vodId: String(playMeta.sid || params.vodId || params.videoId || shareURL),
          title: params.title || scrapeTitle || playMeta.t || shareURL,
          pic: params.pic || scrapePic || playMeta.p || "",
          episode: rawPlayId,
          episodeName,
          episodeNumber,
        });
        if (historyPayload) {
          Promise.resolve(OmniBox.addPlayHistory(historyPayload))
            .then((added) => OmniBox.log("info", `[爱盼][play] ${added ? "已添加" : "已存在,跳过"}观看记录: ${historyPayload.title}`))
            .catch((error) => OmniBox.log("warn", `[爱盼][play] 添加观看记录失败: ${error.message}`));
        }
      }
    } catch (_) { /* 观看记录失败不影响播放 */ }

    const header = playInfo.header || playInfo.headers || {};
    await OmniBox.log("info", `[爱盼][play] route=${routeType} share=${shareURL} fileId=${fileId} urls=${urls.length}`);
    return { urls, header, parse: 0, jx: 0, danmaku: danmakuList };
  } catch (e) {
    await OmniBox.log("error", `[爱盼][play] ${e.message}`);
    return { parse: 0, jx: 0, url: "", urls: [], header: {}, headers: {} };
  }
}
