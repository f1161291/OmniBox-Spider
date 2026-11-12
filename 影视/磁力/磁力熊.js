// @name 磁力熊
// @author 梦
// @description 磁力资源站：多域名容灾 + 实站筛选路由 + 302 搜索结果页 + 磁力/电驴/种子线路 + legacy 播放字段兼容
// @dependencies cheerio
// @version 1.1.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/磁力/磁力熊.js

// 本地直接 require 调试时，SDK / runner 缺失不应导致脚本在入口阶段崩溃
let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  OmniBox = {
    log(level, message) {
      console.log(`[${level}] ${message}`);
    },
  };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}
const cheerio = require("cheerio");

// .com 主域已切换为域名停放页，站点自身在首页标注 .cc / .org / .xyz 为可用镜像
const BASE_URL = String(process.env.CILIXIONG_HOST || "https://cilixiong.org").trim().replace(/\/+$/, "");
const SITE_HOSTS = Array.from(new Set([
  BASE_URL,
  "https://www.cilixiong.cc",
  "https://www.cilixiong.org",
  "https://cilixiong.xyz",
].map((h) => String(h).trim().replace(/\/+$/, "")).filter(Boolean)));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DETAIL_CACHE_TTL = Number(process.env.CILIXIONG_DETAIL_CACHE_TTL || 1800);
const LIST_CACHE_TTL = Number(process.env.CILIXIONG_LIST_CACHE_TTL || 900);
const SEARCH_CACHE_TTL = Number(process.env.CILIXIONG_SEARCH_CACHE_TTL || 900);
const SOURCE_NAMES_CONFIG = (process.env.SOURCE_NAMES_CONFIG || "本地代理;服务端代理;直连")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const MAGNET_LOCAL_SCHEME = String(process.env.MAGNET_LOCAL_SCHEME || "").trim();
const MAGNET_PROXY_API = String(process.env.MAGNET_PROXY_API || "").trim();

const CATEGORY_CONFIG = [
  { id: "movie", name: "电影", path: "/movie/" },
  { id: "tv", name: "剧集", path: "/drama/" },
  { id: "top250", name: "豆瓣电影Top250", path: "/top250/" },
  { id: "imdbtop250", name: "IMDB Top250", path: "/s/imdbtop250/" },
  { id: "suspense", name: "高分悬疑片", path: "/s/suspense/" },
  { id: "comedy", name: "高分喜剧片", path: "/s/comedy/" },
  { id: "biopic", name: "高分传记片", path: "/s/biopic/" },
  { id: "romance", name: "高分爱情片", path: "/s/romance/" },
  { id: "crime", name: "高分犯罪片", path: "/s/crime/" },
  { id: "horror", name: "高分恐怖片", path: "/s/horror/" },
  { id: "adventure", name: "高分冒险片", path: "/s/adventure/" },
  { id: "martial", name: "高分武侠片", path: "/s/martial/" },
  { id: "fantasy", name: "高分奇幻片", path: "/s/fantasy/" },
  { id: "history", name: "高分历史片", path: "/s/history/" },
  { id: "war", name: "高分战争片", path: "/s/war/" },
  { id: "musical", name: "高分歌舞片", path: "/s/musical/" },
  { id: "disaster", name: "高分灾难片", path: "/s/disaster/" },
  { id: "west", name: "高分西部片", path: "/s/west/" },
  { id: "music", name: "高分音乐片", path: "/s/music/" },
  { id: "sci-fi", name: "高分科幻片", path: "/s/sci-fi/" },
  { id: "action", name: "高分动作片", path: "/s/action/" },
  { id: "animation", name: "高分动画片", path: "/s/animation/" },
  { id: "documentary", name: "高分纪录片", path: "/s/documentary/" },
  { id: "unpopular", name: "冷门佳片", path: "/s/unpopular/" },
];

const CATEGORY_MAP = new Map(CATEGORY_CONFIG.map((item) => [item.id, item]));

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

async function requestText(url, options = {}, redirectCount = 0) {
  await OmniBox.log("info", `[磁力熊][request] ${options.method || "GET"} ${url}, redirect=${redirectCount}`);
  const res = await OmniBox.request(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(options.headers || {}),
    },
    body: options.body,
    timeout: options.timeout || 20000,
  });
  const statusCode = Number(res?.statusCode || 0);
  const headers = res?.headers || {};
  if ([301, 302, 303, 307, 308].includes(statusCode)) {
    const location = headers.location || headers.Location || headers.LOCATION;
    if (!location) throw new Error(`HTTP ${statusCode} 缺少 location @ ${url}`);
    // 站点搜索返回 location: result/?searchid=xxx（相对路径），
    // 必须相对“当前请求 URL”解析，否则会落到 /result/ 而拿不到结果页。
    const nextUrl = new URL(location, url).toString();
    if (redirectCount >= 5) throw new Error(`重定向次数超限 @ ${url} -> ${nextUrl}`);
    await OmniBox.log("info", `[磁力熊][redirect] ${url} -> ${nextUrl}`);
    if (options.method && String(options.method).toUpperCase() === "POST") {
      // 302 后的结果页必须改用 GET，避免把 POST body 再带到结果页
      return await requestText(nextUrl, { ...options, method: "GET", body: undefined }, redirectCount + 1);
    }
    return await requestText(nextUrl, options, redirectCount + 1);
  }
  if (!res || statusCode !== 200) {
    throw new Error(`HTTP ${res?.statusCode || "unknown"} @ ${url}`);
  }
  return String(res.body || "");
}

// 域名停放页 / CDN 错误页不应被写入缓存，也不应被当作正常列表解析
function isUsableSiteHtml(htmlText) {
  const text = String(htmlText || "");
  if (!text || /<title>\s*Redirecting\.\.\./i.test(text)) return false;
  if (/router\.parklogic\.com|This page has been created by ParkLogic/i.test(text)) return false;
  if (/<title>\s*信息提示\s*<\/title>/i.test(text)) return false;
  return true;
}

async function requestSiteText(pathOrUrl, options = {}) {
  const raw = String(pathOrUrl || "/");
  let path = raw;
  let hosts = SITE_HOSTS.slice();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      path = `${parsed.pathname}${parsed.search}` || "/";
      // 传入外站/镜像绝对 URL 时，优先按该 origin 请求，并在失败后回落到已知镜像
      hosts = Array.from(new Set([parsed.origin, ...SITE_HOSTS]));
    } catch (_) {
      path = raw;
    }
  }
  let lastError;
  for (const host of hosts) {
    const url = `${host}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const body = await requestText(url, {
        ...options,
        headers: { ...(options.headers || {}), Referer: `${host}/` },
      });
      if (!isUsableSiteHtml(body)) {
        throw new Error(`命中域名停放/跳转页 @ ${url}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      await OmniBox.log("warn", `[磁力熊][request] 域名尝试失败 host=${host}, url=${url}, message=${error.message}`);
    }
  }
  throw lastError || new Error(`全部域名不可用 @ ${path}`);
}

async function getCachedText(cacheKey, ttl, producer) {
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached && isUsableSiteHtml(cached)) return String(cached);
    if (cached) await OmniBox.log("warn", `[磁力熊][cache] 丢弃旧域名停放/跳转页缓存 key=${cacheKey}`);
  } catch (_) {}
  const value = await producer();
  try {
    if (isUsableSiteHtml(value)) await OmniBox.setCache(cacheKey, String(value), ttl);
  } catch (_) {}
  return value;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripHtml(value) {
  return normalizeText(String(value || "").replace(/<[^>]+>/g, " "));
}

function absoluteUrl(url) {
  try {
    return new URL(url, `${BASE_URL}/`).toString();
  } catch (_) {
    return String(url || "");
  }
}

function decodeMaybeGarbled(text) {
  const raw = String(text || "");
  if (!/[ÃÂÐÑ]/.test(raw) && !/ç|è|ä|å|æ|é|ê|ë|ï|î|ô|û|ù/.test(raw)) return raw;
  try {
    return Buffer.from(raw, "latin1").toString("utf8");
  } catch (_) {
    return raw;
  }
}

function extractBgImage(style) {
  const match = String(style || "").match(/url\(['"]?([^'")]+)['"]?\)/i);
  return match ? absoluteUrl(match[1]) : "";
}

function mapCard($, el, fallbackTypeName = "") {
  const node = $(el);
  const href = node.find("a[href]").first().attr("href") || "";
  const title = decodeMaybeGarbled(normalizeText(node.find("h2").first().text()));
  const score = normalizeText(node.find(".rank").first().text());
  const year = normalizeText(node.find(".small").first().text());
  // 封面挂在 <a> 内的 .card-img style，部分卡片也会把 data-original / data-src 放在 <a> 上
  const imgNode = node.find(".card-img").first();
  const anchor = node.find("a[href]").first();
  const picRaw = imgNode.attr("style")
    ? extractBgImage(imgNode.attr("style"))
    : (imgNode.attr("data-original") || imgNode.attr("data-src") || imgNode.attr("src")
      || anchor.attr("data-original") || anchor.attr("data-src") || "");
  const id = String(href || "").match(/\/(movie|tv)\/(\d+)\.html/i)?.[2] || href;
  return {
    vod_id: absoluteUrl(href),
    vod_name: title,
    vod_pic: /^https?:\/\//i.test(String(picRaw || "")) ? picRaw : absoluteUrl(picRaw),
    vod_year: year,
    vod_remarks: [score, year].filter(Boolean).join(" / "),
    type_name: fallbackTypeName,
    _id: id,
  };
}

// 筛选 URL 实站为 /{classid}-{class}-{area}-{pageIndex}.html（pageIndex 从 0 起）；
function normalizeFilterValue(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : "0";
}

function getFilterObject(params = {}) {
  const raw = params.filters || params.filter || params.extend || params.ext || {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}

function buildCategoryUrl(categoryId, page, filter = {}) {
  const category = CATEGORY_MAP.get(String(categoryId || "movie")) || CATEGORY_CONFIG[0];
  const currentPage = Math.max(1, Number(page) || 1);
  const categoryPath = category.path;
  const klass = normalizeFilterValue(filter.class);
  const area = normalizeFilterValue(filter.area);
  if ((categoryId === "movie" || categoryId === "tv") && (klass !== "0" || area !== "0")) {
    const classId = categoryId === "movie" ? "1" : "2";
    return absoluteUrl(`/${classId}-${klass}-${area}-${currentPage - 1}.html`);
  }
  if (currentPage === 1) return absoluteUrl(categoryPath);
  return absoluteUrl(`${categoryPath}index_${currentPage}.html`);
}

// 只认真实分页 <a> 中的下一页/尾页 href，避免末页继续递增 pagecount
function parsePageCount(htmlText, currentPage) {
  const $ = cheerio.load(String(htmlText || ""));
  const page = Math.max(1, Number(currentPage) || 1);
  let maxPage = page;
  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "");
    const indexMatch = href.match(/index_(\d+)\.html/i);
    if (indexMatch) {
      maxPage = Math.max(maxPage, Number(indexMatch[1]) || page);
      return;
    }
    // 筛选页分页是 0-based 尾段，如 /1-1-0-1.html 表示第 2 页
    const filterMatch = href.match(/^\/\d+-\d+-\d+-(\d+)\.html$/i);
    if (filterMatch) maxPage = Math.max(maxPage, (Number(filterMatch[1]) || 0) + 1);
  });
  return maxPage;
}

function parseDetailMeta(htmlText) {
  const $ = cheerio.load(htmlText);
  const detailBlock = $(".mv_detail").first();
  const title = decodeMaybeGarbled(normalizeText(detailBlock.find("h1").first().text()));
  const pic = absoluteUrl($("meta[property='og:image']").attr("content") || "");
  const content = decodeMaybeGarbled(normalizeText($("meta[property='og:description']").attr("content") || $("meta[name='description']").attr("content") || ""));
  const metaMap = {};
  detailBlock.find("p").each((_, p) => {
    const text = decodeMaybeGarbled(stripHtml($(p).html() || $(p).text()));
    if (!text) return;
    const idx = text.indexOf("：") > 0 ? text.indexOf("：") : text.indexOf(":");
    if (idx > 0) {
      let key = text.slice(0, idx).trim();
      // 页面里“豆瓣评分: 7.6”用半角冒号，统一成 parseDetailMeta 读取的全角 key
      if (/豆瓣评分/i.test(key)) key = "豆瓣评分";
      metaMap[key] = text.slice(idx + 1).trim();
    }
  });
  // 优先读页面上带 .mv_card_box 的剧情简介，meta description 往往是截断版
  const fullContent = decodeMaybeGarbled(normalizeText($(".mv_card_box").first().text()));
  return {
    title,
    pic,
    content: fullContent || content,
    score: metaMap["豆瓣评分"] || "",
    alias: metaMap["又名"] || "",
    date: metaMap["上映日期"] || "",
    type: metaMap["类型"] || "",
    duration: metaMap["片长"] || "",
    area: metaMap["上映地区"] || "",
    actors: metaMap["主演"] || "",
    update: metaMap["最后更新于"] || "",
  };
}

function parseResourceEpisodes(htmlText) {
  const $ = cheerio.load(htmlText);
  const episodes = [];
  const seen = new Set();
  $("a[href]").each((_, a) => {
    const href = ($(a).attr("href") || "").trim();
    if (!href) return;
    let seedType = "";
    if (href.startsWith("magnet:")) seedType = "magnet";
    else if (href.startsWith("ed2k://")) seedType = "ed2k";
    else if (/\.torrent($|\?)/i.test(href)) seedType = "torrent";
    else return;
    const rawName = decodeMaybeGarbled(normalizeText($(a).text())) || `${seedType}资源`;
    const quality = normalizeText((rawName.match(/(4K|2160P|1080P|720P|WEB-DL|BluRay|BD|HDR|REMUX)/i) || [])[1] || "");
    const size = normalizeText((rawName.match(/\[(\d+(?:\.\d+)?\s*[GMTK]B?)\]/i) || [])[1] || "");
    const episodeName = size ? rawName.replace(/\s*\[[^\]]+\]\s*$/, "").trim() || rawName : rawName;
    const key = `${seedType}@@${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    const prefix = seedType === "magnet" ? "🧲磁力" : seedType === "ed2k" ? "⚡电驴" : "🧩种子";
    episodes.push({
      name: episodeName,
      playId: href,
      _sortKey: rawName,
      _prefix: quality ? `${prefix}·${quality}` : prefix,
    });
  });
  episodes.sort((a, b) => String(a._sortKey).localeCompare(String(b._sortKey), "zh-Hans-CN"));
  const groups = new Map();
  for (const ep of episodes) {
    const key = ep._prefix;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: ep.name, playId: ep.playId });
  }
  return Array.from(groups.entries()).map(([name, episodes]) => ({ name, episodes }));
}

// 兼容仍只消费传统 MacCMS 播放字段的端，避免 detail 有数据但前端不显示线路
function buildLegacyPlayFields(playSources = []) {
  const valid = (Array.isArray(playSources) ? playSources : []).filter(
    (source) => source && Array.isArray(source.episodes) && source.episodes.length,
  );
  if (!valid.length) return { vod_play_from: "", vod_play_url: "", vod_play_list: [] };
  return {
    vod_play_from: valid.map((source) => String(source.name || "资源")).join("$$$"),
    vod_play_url: valid
      .map((source) =>
        source.episodes
          .map((ep) => `${String(ep?.name || "资源").replace(/[$#]/g, " ")}$${String(ep?.playId || "")}`)
          .join("#"),
      )
      .join("$$$"),
    vod_play_list: valid.map((source) => ({
      name: String(source.name || "资源"),
      episodes: source.episodes.map((ep) => ({ name: ep.name, playId: ep.playId })),
    })),
  };
}

function buildPlayUrls(meta) {
  const link = String(meta?.link || meta?.url || "").trim();
  const urls = [];
  if (MAGNET_LOCAL_SCHEME) {
    const localName = SOURCE_NAMES_CONFIG[0] || "本地代理";
    const localUrl = MAGNET_LOCAL_SCHEME.includes("{")
      ? MAGNET_LOCAL_SCHEME.replaceAll("{url}", encodeURIComponent(link))
      : `${MAGNET_LOCAL_SCHEME}${encodeURIComponent(link)}`;
    urls.push({ name: localName, url: localUrl });
  }
  if (MAGNET_PROXY_API) {
    const proxyName = SOURCE_NAMES_CONFIG[1] || "服务端代理";
    const joiner = MAGNET_PROXY_API.includes("?") ? "&" : "?";
    urls.push({ name: proxyName, url: `${MAGNET_PROXY_API}${joiner}url=${encodeURIComponent(link)}` });
  }
  const directName = SOURCE_NAMES_CONFIG[SOURCE_NAMES_CONFIG.length - 1] || "直连";
  urls.push({ name: directName, url: link });
  return urls;
}

async function home(params = {}, context = {}) {
  try {
    await OmniBox.log("info", `[磁力熊][home] params=${JSON.stringify(params || {})}, from=${context?.from || "web"}`);
    const html = await getCachedText("cilixiong:home", LIST_CACHE_TTL, () => requestSiteText("/"));
    const $ = cheerio.load(html);
    // 首页第一个 .col 是说明文字，后面才是影片卡片；旧逻辑 slice(1,13) 会漏掉第一张卡片
    const list = $(".col > .card").toArray().slice(0, 12).map((el) => mapCard($, el.parent, "电影")).filter((item) => item.vod_id && item.vod_name);
    await OmniBox.log("info", `[磁力熊][home] list=${list.length}`);
    return {
      class: CATEGORY_CONFIG.map(({ id, name }) => ({ type_id: id, type_name: name })),
      list,
      filters: {
        movie: [
          {
            key: "class",
            name: "类型",
            value: [
              { name: "全部", value: "0" }, { name: "剧情", value: "1" }, { name: "喜剧", value: "2" }, { name: "惊悚", value: "3" },
              { name: "动作", value: "4" }, { name: "爱情", value: "5" }, { name: "犯罪", value: "6" }, { name: "恐怖", value: "7" },
              { name: "冒险", value: "8" }, { name: "悬疑", value: "9" }, { name: "科幻", value: "10" }, { name: "家庭", value: "11" },
              { name: "奇幻", value: "12" }, { name: "动画", value: "13" }, { name: "战争", value: "14" }, { name: "历史", value: "15" },
              { name: "传记", value: "16" }, { name: "音乐", value: "17" }, { name: "歌舞", value: "18" }, { name: "运动", value: "19" },
              { name: "西部", value: "20" }, { name: "灾难", value: "21" }, { name: "古装", value: "22" },
              { name: "同性", value: "24" }, { name: "儿童", value: "25" }, { name: "纪录片", value: "26" },
            ],
          },
          {
            key: "area",
            name: "地区",
            value: [
              { name: "全部", value: "0" }, { name: "大陆", value: "1" }, { name: "香港", value: "2" }, { name: "台湾", value: "3" },
              { name: "美国", value: "4" }, { name: "日本", value: "5" }, { name: "韩国", value: "6" }, { name: "英国", value: "7" },
              { name: "法国", value: "8" }, { name: "德国", value: "9" }, { name: "印度", value: "10" }, { name: "泰国", value: "11" },
              { name: "丹麦", value: "12" }, { name: "瑞典", value: "13" }, { name: "巴西", value: "14" }, { name: "加拿大", value: "15" },
              { name: "俄罗斯", value: "16" }, { name: "意大利", value: "17" }, { name: "比利时", value: "18" }, { name: "爱尔兰", value: "19" },
              { name: "西班牙", value: "20" }, { name: "澳大利亚", value: "21" }, { name: "波兰", value: "22" }, { name: "土耳其", value: "23" },
              { name: "越南", value: "24" },
            ],
          },
        ],
        tv: [
          {
            key: "class",
            name: "类型",
            value: [
              { name: "全部", value: "0" }, { name: "剧情", value: "1" }, { name: "喜剧", value: "2" }, { name: "惊悚", value: "3" },
              { name: "动作", value: "4" }, { name: "爱情", value: "5" }, { name: "犯罪", value: "6" }, { name: "恐怖", value: "7" },
              { name: "冒险", value: "8" }, { name: "悬疑", value: "9" }, { name: "科幻", value: "10" }, { name: "家庭", value: "11" },
              { name: "奇幻", value: "12" }, { name: "动画", value: "13" }, { name: "战争", value: "14" }, { name: "历史", value: "15" },
              { name: "传记", value: "16" }, { name: "音乐", value: "17" }, { name: "歌舞", value: "18" }, { name: "运动", value: "19" },
              { name: "西部", value: "20" }, { name: "灾难", value: "21" }, { name: "古装", value: "22" },
              { name: "同性", value: "24" }, { name: "儿童", value: "25" }, { name: "纪录片", value: "26" },
            ],
          },
          {
            key: "area",
            name: "地区",
            value: [
              { name: "全部", value: "0" }, { name: "大陆", value: "1" }, { name: "香港", value: "2" }, { name: "台湾", value: "3" },
              { name: "美国", value: "4" }, { name: "日本", value: "5" }, { name: "韩国", value: "6" }, { name: "英国", value: "7" },
              { name: "法国", value: "8" }, { name: "德国", value: "9" }, { name: "印度", value: "10" }, { name: "泰国", value: "11" },
              { name: "丹麦", value: "12" }, { name: "瑞典", value: "13" }, { name: "巴西", value: "14" }, { name: "加拿大", value: "15" },
              { name: "俄罗斯", value: "16" }, { name: "意大利", value: "17" }, { name: "比利时", value: "18" }, { name: "爱尔兰", value: "19" },
              { name: "西班牙", value: "20" }, { name: "澳大利亚", value: "21" }, { name: "波兰", value: "22" }, { name: "土耳其", value: "23" },
              { name: "越南", value: "24" },
            ],
          },
        ],
      },
    };
  } catch (error) {
    await OmniBox.log("error", `[磁力熊][home] ${error.message}`);
    return { class: CATEGORY_CONFIG.map(({ id, name }) => ({ type_id: id, type_name: name })), list: [] };
  }
}

async function category(params = {}, context = {}) {
  try {
    const categoryId = String(params.type_id || params.categoryId || params.id || "movie");
    const page = Math.max(1, Number(params.page) || 1);
    const filter = getFilterObject(params);
    const path = buildCategoryUrl(categoryId, page, filter);
    const cacheKey = `cilixiong:category:${categoryId}:${page}:${JSON.stringify(filter)}`;
    await OmniBox.log("info", `[磁力熊][category] params=${JSON.stringify(params || {})}, from=${context?.from || "web"}, type=${categoryId}, page=${page}, filters=${JSON.stringify(filter)}, path=${path}`);
    const html = await getCachedText(cacheKey, LIST_CACHE_TTL, () => requestSiteText(path));
    const $ = cheerio.load(html);
    const typeName = CATEGORY_MAP.get(categoryId)?.name || "磁力";
    const list = $(".col > .card").toArray().map((el) => mapCard($, el.parent, typeName)).filter((item) => item.vod_id && item.vod_name);
    const pagecount = list.length ? parsePageCount(html, page) : page;
    await OmniBox.log("info", `[磁力熊][category] type=${categoryId} page=${page} list=${list.length} pagecount=${pagecount} url=${path}`);
    return {
      list,
      page,
      pagecount,
      limit: list.length,
      total: pagecount * Math.max(list.length, 1),
    };
  } catch (error) {
    await OmniBox.log("error", `[磁力熊][category] ${error.message}`);
    return { list: [], page: Number(params.page) || 1, pagecount: Number(params.page) || 1, limit: 0, total: 0 };
  }
}

async function detail(params = {}, context = {}) {
  try {
    const rawId = String(params.id || params.videoId || params.vod_id || "").trim();
    const vodId = /^https?:\/\//i.test(rawId) ? rawId : absoluteUrl(rawId);
    await OmniBox.log("info", `[磁力熊][detail] params=${JSON.stringify(params || {})}, from=${context?.from || "web"}, vodId=${vodId}`);
    const cacheKey = `cilixiong:detail:${rawId || "empty"}`;
    if (!rawId) throw new Error("videoId 为空");
    const html = await getCachedText(cacheKey, DETAIL_CACHE_TTL, () => requestSiteText(vodId));
    const meta = parseDetailMeta(html);
    const playSources = parseResourceEpisodes(html);
    await OmniBox.log("info", `[磁力熊][detail] id=${vodId} title=${meta.title} sources=${playSources.length} episodes=${playSources.reduce((sum, s) => sum + s.episodes.length, 0)}`);
    return {
      list: [{
        vod_id: vodId,
        vod_name: meta.title,
        vod_pic: meta.pic,
        type_name: meta.type,
        vod_year: meta.date,
        vod_area: meta.area,
        vod_actor: meta.actors,
        vod_remarks: [meta.score ? `豆瓣${meta.score}` : "", meta.duration].filter(Boolean).join(" / "),
        vod_content: meta.content,
        vod_play_sources: playSources,
        ...buildLegacyPlayFields(playSources),
      }],
    };
  } catch (error) {
    await OmniBox.log("error", `[磁力熊][detail] ${error.message}`);
    return { list: [] };
  }
}

async function search(params = {}, context = {}) {
  try {
    const wd = normalizeText(params.wd || params.keyword || params.q || params.key || "");
    const page = Math.max(1, Number(params.page) || 1);
    await OmniBox.log("info", `[磁力熊][search] params=${JSON.stringify(params || {})}, from=${context?.from || "web"}, wd=${wd}, page=${page}`);
    if (!wd) return { page, pagecount: 0, total: 0, list: [] };
    const cacheKey = `cilixiong:search:${wd}:${page}`;
    const html = await getCachedText(cacheKey, SEARCH_CACHE_TTL, async () => {
      // 必须用 x-www-form-urlencoded 百分号编码；中文直接塞进 body 会拿到空结果
      const body = new URLSearchParams({
        classid: "1,2",
        show: "title",
        tempid: "1",
        keyboard: wd,
        ...(page > 1 ? { page: String(page) } : {}),
      }).toString();
      return await requestSiteText("/e/search/index.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    });
    const $ = cheerio.load(html);
    let list = $(".col > .card").toArray().map((el) => mapCard($, el.parent)).filter((item) => item.vod_id && item.vod_name);
    if (!list.length) {
      list = $("a[href*='/movie/'], a[href*='/tv/']").toArray().map((el) => {
        const node = $(el);
        const href = node.attr("href") || "";
        const title = decodeMaybeGarbled(normalizeText(node.text()));
        return {
          vod_id: absoluteUrl(href),
          vod_name: title,
          vod_pic: "",
          vod_remarks: "",
        };
      }).filter((item, idx, arr) => item.vod_id && item.vod_name && arr.findIndex((x) => x.vod_id === item.vod_id) === idx);
    }
    await OmniBox.log("info", `[磁力熊][search] wd=${wd} page=${page} list=${list.length}`);
    return { page, pagecount: list.length ? page + 1 : page, total: page * Math.max(list.length, 1), list };
  } catch (error) {
    await OmniBox.log("error", `[磁力熊][search] ${error.message}`);
    return { page: Math.max(1, Number(params.page) || 1), pagecount: 0, total: 0, list: [] };
  }
}

async function play(params = {}, context = {}) {
  try {
    const raw = String(params.id || params.playId || params.play_id || "").trim();
    const seedType = raw.startsWith("magnet:") ? "magnet" : raw.startsWith("ed2k://") ? "ed2k" : /\.torrent($|\?)/i.test(raw) ? "torrent" : "magnet";
    const urls = buildPlayUrls({ link: raw, url: raw, seedType });
    await OmniBox.log("info", `[磁力熊][play] params=${JSON.stringify(params || {})}, from=${context?.from || "web"}, type=${seedType} urls=${urls.length}`);
    return {
      parse: 0,
      header: {},
      urls,
    };
  } catch (error) {
    await OmniBox.log("error", `[磁力熊][play] ${error.message}`);
    return { parse: 0, header: {}, urls: [] };
  }
}
