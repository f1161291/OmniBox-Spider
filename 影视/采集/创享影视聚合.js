// @name 创享影视聚合
// @author 宝宝巴士
// @description 由 TVBox 订阅 https://ys.cxkjg.cn/api/provide/vod 转换的 OmniBox 源：订阅里的 12 个站点自动成为分站分类，聚合检索漏片时自动补扫分站，多线路播放带失效线路自动回退
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/创享影视聚合.js

const OmniBox = require("omnibox_sdk");

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

// ==================== 配置区域 ====================
// TVBox 订阅地址：脚本启动时拉一次，把订阅里的 sites[] 转成「分站」。订阅不可用时回落到内置清单。
const SUBSCRIPTION_URL = String(
  process.env.SITE_SUBSCRIPTION || process.env.CXKJG_SUBSCRIPTION || "https://ys.cxkjg.cn/api/provide/tvbox"
).trim();

// 采集站 API 基址。默认从订阅第一条站点推导，也可用 SITE_API 直接写死。
const SITE_API = String(process.env.SITE_API || "").trim();

// 聚合检索结果偏少时，是否补扫分站（默认开，宿主侧感知为"搜得更全"，代价是首屏多几个请求）
const SUB_SEARCH_ENABLED = String(process.env.CXKJG_SUB_SEARCH || "1") !== "0";
// 补扫分站时最多扫几个（按订阅顺序），避免 12 站全打
const SUB_SEARCH_LIMIT = Math.max(1, parseInt(process.env.CXKJG_SUB_SEARCH_LIMIT || "8", 10) || 8);
// 子源并发
const SUB_SEARCH_CONCURRENCY = Math.max(1, parseInt(process.env.CXKJG_SUB_SEARCH_CONCURRENCY || "4", 10) || 4);
// 列表 / 详情缓存秒数
const LIST_CACHE_TTL = Math.max(60, parseInt(process.env.CXKJG_LIST_CACHE_TTL || "600", 10) || 600);
const DETAIL_CACHE_TTL = Math.max(60, parseInt(process.env.CXKJG_DETAIL_CACHE_TTL || "1200", 10) || 1200);
// 播放地址探测（用于失效线路回退）；设为 0 则完全跳过探测，直接返回上游给的地址
const PLAY_PROBE_ENABLED = String(process.env.CXKJG_PLAY_PROBE || "1") !== "0";

const PAGE_SIZE = 24;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/xml, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

// 订阅拉取失败时的内置兜底分站清单（与订阅内容一致）
const FALLBACK_SITES = [
  { key: "创享影视", name: "创享影视", api: "https://ys.cxkjg.cn/api/provide/vod" },
  { key: "2680151544", name: "金鹰", api: "https://ys.cxkjg.cn/api/provide/vod?source=2680151544" },
  { key: "3848762792", name: "闪电", api: "https://ys.cxkjg.cn/api/provide/vod?source=3848762792" },
  { key: "1840804598", name: "非凡", api: "https://ys.cxkjg.cn/api/provide/vod?source=1840804598" },
  { key: "1470828922", name: "量子", api: "https://ys.cxkjg.cn/api/provide/vod?source=1470828922" },
  { key: "4118858385", name: "WS", api: "https://ys.cxkjg.cn/api/provide/vod?source=4118858385" },
  { key: "1016684692", name: "速博", api: "https://ys.cxkjg.cn/api/provide/vod?source=1016684692" },
  { key: "1208629981", name: "HD(SN)", api: "https://ys.cxkjg.cn/api/provide/vod?source=1208629981" },
  { key: "2761253814", name: "红牛", api: "https://ys.cxkjg.cn/api/provide/vod?source=2761253814" },
  { key: "4194624554", name: "U酷", api: "https://ys.cxkjg.cn/api/provide/vod?source=4194624554" },
  { key: "4247318859", name: "光速", api: "https://ys.cxkjg.cn/api/provide/vod?source=4247318859" },
  { key: "531717376", name: "樱花", api: "https://ys.cxkjg.cn/api/provide/vod?source=531717376" },
];

// 聚合站的顶级分类兜底（订阅主站 ac=list 会返回同名 class）
const FALLBACK_CLASSES = [
  { type_id: "1", type_name: "电视剧" },
  { type_id: "9", type_name: "电影" },
  { type_id: "19", type_name: "记录片" },
  { type_id: "20", type_name: "动漫" },
  { type_id: "26", type_name: "综艺" },
  { type_id: "31", type_name: "体育赛事" },
  { type_id: "36", type_name: "短剧" },
  { type_id: "43", type_name: "现代都市" },
  { type_id: "44", type_name: "穿越年代" },
];

// ==================== 基础工具 ====================

function log(level, msg) {
  try {
    OmniBox.log(level, `[cxkjg] ${msg}`);
  } catch (_) {
    console.log(`[${level}] [cxkjg] ${msg}`);
  }
}

function asText(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  try {
    if (typeof res.body === "string") return res.body;
    if (typeof res.content === "string") return res.content;
    if (res.body && typeof res.body === "object") return JSON.stringify(res.body);
    return JSON.stringify(res);
  } catch (_) {
    return "";
  }
}

function stripEmoji(name) {
  return String(name || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(v) {
  return String(v == null ? "" : v)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function toInt(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dft;
}

function b64encode(str) {
  try {
    return Buffer.from(String(str), "utf8").toString("base64");
  } catch (_) {
    return "";
  }
}

function b64decode(str) {
  try {
    return Buffer.from(String(str), "base64").toString("utf8");
  } catch (_) {
    return "";
  }
}

// ==================== HTTP ====================

async function rawRequest(url, options) {
  const opts = {
    method: (options && options.method) || "GET",
    headers: Object.assign({}, HEADERS, (options && options.headers) || {}),
    timeout: (options && options.timeout) || 25000,
  };
  if (options && options.body !== undefined && options.body !== null) {
    opts.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  const res = await OmniBox.request(url, opts);
  return {
    statusCode: (res && (res.statusCode || res.status)) || 0,
    headers: (res && res.headers) || {},
    body: asText(res),
  };
}

function buildUrl(api, params) {
  const qs = [];
  Object.keys(params || {}).forEach((k) => {
    const v = params[k];
    if (v === undefined || v === null || v === "") return;
    qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  });
  if (!qs.length) return api;
  return api + (api.indexOf("?") >= 0 ? "&" : "?") + qs.join("&");
}

async function cacheGet(key) {
  try {
    if (OmniBox && typeof OmniBox.getCache === "function") {
      const v = await OmniBox.getCache(key);
      if (!v) return null;
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch (_) {
          return v;
        }
      }
      return v;
    }
  } catch (_) {}
  return null;
}

async function cacheSet(key, value, ttl) {
  try {
    if (OmniBox && typeof OmniBox.setCache === "function") {
      await OmniBox.setCache(key, typeof value === "string" ? value : JSON.stringify(value), ttl);
    }
  } catch (_) {}
}

// ==================== 订阅解析 ====================

function sanitizeKey(raw) {
  const s = String(raw || "");
  const m = s.match(/^source_(\d+)$/);
  if (m) return m[1];
  return s.replace(/[^\w\u4e00-\u9fa5]/g, "");
}

async function loadSources() {
  const cached = await cacheGet("cxkjg:sources");
  if (cached && Array.isArray(cached.sites) && cached.sites.length) {
    return cached;
  }
  let sites = [];
  let baseApi = SITE_API;
  if (SUBSCRIPTION_URL) {
    try {
      const res = await rawRequest(SUBSCRIPTION_URL, { timeout: 20000 });
      const json = JSON.parse(res.body || "{}");
      const arr = Array.isArray(json.sites) ? json.sites : [];
      sites = arr
        .filter((s) => s && s.api)
        .map((s) => ({
          key: sanitizeKey(s.key),
          name: stripEmoji(s.name) || sanitizeKey(s.key),
          api: String(s.api).trim(),
        }));
      if (!sites.length) log("error", `订阅里没有可用站点，回落到内置清单`);
    } catch (e) {
      log("error", `订阅拉取失败：${e && e.message}，回落到内置清单`);
    }
  }
  if (!sites.length) sites = FALLBACK_SITES.slice();
  if (!baseApi) {
    const first = sites.find((s) => !/source=\d+/.test(s.api));
    baseApi = (first && first.api) || "https://ys.cxkjg.cn/api/provide/vod";
  }
  const payload = { sites, baseApi };
  await cacheSet("cxkjg:sources", payload, 21600);
  log("info", `站点清单就绪：${sites.length} 个，基址=${baseApi}`);
  return payload;
}

// ==================== 响应解析（JSON + XML 双栈） ====================

function parseAttributes(seg) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(seg))) out[m[1]] = m[2];
  return out;
}

function xmlTag(block, tag) {
  const re = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`);
  const m = block.match(re);
  if (!m) return "";
  return String(m[1] || "").trim();
}

function xmlLines(block) {
  const lines = [];
  const re = /<dd\s+flag="([^"]*)"\s*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/dd>/g;
  let m;
  while ((m = re.exec(block))) {
    const name = String(m[1] || "").trim() || `线路${lines.length + 1}`;
    lines.push({ name, raw: String(m[2] || "").trim() });
  }
  return lines;
}

// 把 "第1集$url#第2集$url" 拆成分集数组
function splitEpisodes(raw) {
  const out = [];
  String(raw || "")
    .split("#")
    .forEach((seg) => {
      const s = seg.trim();
      if (!s) return;
      const idx = s.indexOf("$");
      let name = "";
      let url = s;
      if (idx > 0) {
        name = s.slice(0, idx).trim();
        url = s.slice(idx + 1).trim();
      }
      if (!url) return;
      out.push({ name: name || `第${out.length + 1}集`, url });
    });
  return out;
}

// 统一成内部结构
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.vod_id != null ? String(raw.vod_id) : "";
  if (!id) return null;
  const lines = [];
  if (Array.isArray(raw.__lines)) {
    raw.__lines.forEach((l) => {
      if (l && l.name) lines.push({ name: l.name, episodes: l.episodes || [] });
    });
  } else {
    const froms = String(raw.vod_play_from || "").split("$$$");
    const urls = String(raw.vod_play_url || "").split("$$$");
    for (let i = 0; i < froms.length; i++) {
      const name = (froms[i] || "").trim() || `线路${i + 1}`;
      const eps = splitEpisodes(urls[i]);
      if (eps.length) lines.push({ name, episodes: eps });
    }
  }
  return {
    vod_id: id,
    vod_name: cleanText(raw.vod_name || raw.name || ""),
    vod_pic: String(raw.vod_pic || raw.pic || "").trim(),
    vod_remarks: cleanText(raw.vod_remarks || raw.note || ""),
    type_name: cleanText(raw.type_name || raw.type || ""),
    vod_year: String(raw.vod_year || raw.year || "").trim(),
    vod_area: String(raw.vod_area || raw.area || "").trim(),
    vod_lang: String(raw.vod_lang || raw.lang || "").trim(),
    vod_actor: cleanText(raw.vod_actor || raw.actor || ""),
    vod_director: cleanText(raw.vod_director || raw.director || ""),
    vod_content: cleanText(raw.vod_content || raw.des || ""),
    vod_score: String(raw.vod_douban_score || raw.vod_score || raw.score || "").trim(),
    lines,
  };
}

function parseXmlPayload(text) {
  const attrSeg = (text.match(/<list\b([^>]*)>/) || [])[1] || "";
  const attrs = parseAttributes(attrSeg);
  const classes = [];
  const clsRe = /<ty\s+id="(\d+)"\s*>([\s\S]*?)<\/ty>/g;
  let cm;
  while ((cm = clsRe.exec(text))) {
    classes.push({ type_id: cm[1], type_name: cleanText(cm[2]) });
  }
  const items = [];
  const vidRe = /<video>([\s\S]*?)<\/video>/g;
  let vm;
  while ((vm = vidRe.exec(text))) {
    const block = vm[1];
    const lines = xmlLines(block).map((l) => ({
      name: l.name,
      episodes: splitEpisodes(l.raw),
    }));
    items.push(
      normalizeItem({
        vod_id: xmlTag(block, "id"),
        vod_name: xmlTag(block, "name"),
        vod_pic: xmlTag(block, "pic"),
        vod_remarks: xmlTag(block, "note"),
        type_name: xmlTag(block, "type"),
        vod_year: xmlTag(block, "year"),
        vod_area: xmlTag(block, "area"),
        vod_lang: xmlTag(block, "lang"),
        vod_actor: xmlTag(block, "actor"),
        vod_director: xmlTag(block, "director"),
        vod_content: xmlTag(block, "des"),
        __lines: lines,
      })
    );
  }
  return {
    format: "xml",
    class: classes,
    filters: {},
    page: toInt(attrs.page, 1),
    pagecount: toInt(attrs.pagecount, 1),
    total: toInt(attrs.recordcount, items.length),
    list: items.filter(Boolean),
  };
}

function parseJsonPayload(text) {
  let json = null;
  try {
    json = JSON.parse(String(text || "").trim());
  } catch (_) {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const arr = Array.isArray(json.list) ? json.list : Array.isArray(json.data) ? json.data : [];
  const classes = (Array.isArray(json.class) ? json.class : []).map((c) => ({
    type_id: String(c.type_id),
    type_name: cleanText(c.type_name),
  }));
  return {
    format: "json",
    class: classes,
    filters: json.filters && typeof json.filters === "object" ? json.filters : {},
    page: toInt(json.page, 1),
    pagecount: toInt(json.pagecount, 1),
    total: toInt(json.total != null ? json.total : json.recordcount, arr.length),
    list: arr.map(normalizeItem).filter(Boolean),
  };
}

function parsePayload(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (t.charAt(0) === "<") return parseXmlPayload(t);
  return parseJsonPayload(t);
}

async function callApi(api, params, extra) {
  const url = buildUrl(api, params);
  try {
    const res = await rawRequest(url, extra);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      log("error", `HTTP ${res.statusCode} ${url}`);
      return null;
    }
    const parsed = parsePayload(res.body);
    if (!parsed) {
      // 上游失败形态有两种：纯文本（如"暂不支持搜索"）、或 {"code":0,"msg":"..."}
      const hint = String(res.body || "").slice(0, 160);
      if (/暂不支持|未授权|无权限|不存在/.test(hint)) {
        log("info", `上游不支持该请求 ${url} -> ${hint}`);
      } else {
        log("error", `解析失败 ${url} body=${hint}`);
      }
      return null;
    }
    return parsed;
  } catch (e) {
    log("error", `请求异常 ${url}：${e && e.message}`);
    return null;
  }
}

// ==================== 分类 / 站点映射 ====================

function buildClassList(baseClasses, sites) {
  const out = [{ type_id: "agg_hot", type_name: "🔥 聚合热榜" }];
  (baseClasses && baseClasses.length ? baseClasses : FALLBACK_CLASSES).forEach((c) => {
    out.push({ type_id: `agg_${c.type_id}`, type_name: `聚合·${c.type_name}` });
  });
  (sites || []).forEach((s) => {
    if (!s.key) return;
    out.push({ type_id: `src_${s.key}`, type_name: s.name });
  });
  return out;
}

function buildFilters(filters, sites) {
  const out = {};
  (sites || []).forEach((s) => {
    if (!s.key) return;
    // 分站筛选普遍被上游忽略，只保留排序，避免"按钮点了没反应"
    out[`src_${s.key}`] = [
      {
        key: "sort",
        name: "排序",
        init: "update_stamp",
        value: [
          { name: "最近更新", value: "update_stamp" },
          { name: "人气", value: "hits" },
        ],
      },
    ];
  });
  Object.keys(filters || {}).forEach((tid) => {
    const groups = Array.isArray(filters[tid]) ? filters[tid] : [];
    const list = [];
    groups.forEach((g) => {
      if (!g || !g.key) return;
      const values = (Array.isArray(g.value) ? g.value : [])
        .map((v) => ({ name: cleanText(v.n != null ? v.n : v.name), value: String(v.v != null ? v.v : v.value || "") }))
        .filter((v, i, a) => v.name && a.findIndex((x) => x.value === v.value) === i);
      if (!values.length) return;
      list.push({ key: String(g.key), name: cleanText(g.name || g.key), init: "", value: values });
    });
    if (list.length) out[`agg_${tid}`] = list;
  });
  return out;
}

function parseFilters(params) {
  const raw =
    (params && (params.filters || params.extend || params.ext || params.filter)) || {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) || {};
    } catch (_) {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function parseCategoryId(categoryId) {
  const raw = String(categoryId || "").trim();
  if (raw.indexOf("src_") === 0) {
    return { mode: "source", key: raw.slice(4) };
  }
  if (raw.indexOf("agg_") === 0) {
    const rest = raw.slice(4);
    if (rest === "hot") return { mode: "agg", tid: "" };
    return { mode: "agg", tid: rest };
  }
  // 兼容宿主可能只传纯数字（当作聚合顶级分类）
  if (/^\d+$/.test(raw)) return { mode: "agg", tid: raw };
  return { mode: "agg", tid: "" };
}

function sourceApi(sites, key) {
  const hit = (sites || []).find((s) => s.key === key);
  return hit ? hit.api : "";
}

function sourceName(sites, key) {
  const hit = (sites || []).find((s) => s.key === key);
  return hit ? hit.name : key;
}

// ==================== 列表 / 详情映射 ====================

function toListVod(item, meta) {
  return {
    vod_id: `${meta.prefix}${item.vod_id}`,
    vod_name: item.vod_name || "未命名",
    vod_pic: item.vod_pic || "",
    vod_remarks: item.vod_remarks || (item.lines.length ? `${item.lines.length} 线路` : ""),
    type_name: item.type_name || "影视",
    vod_year: item.vod_year || undefined,
    vod_area: item.vod_area || undefined,
    vod_tag: "video",
  };
}

function encodePlayId(url, meta) {
  const payload = b64encode(JSON.stringify(meta));
  return `${url}|||${payload}`;
}

function decodePlayId(playId) {
  const raw = String(playId || "").trim();
  const idx = raw.indexOf("|||");
  if (idx < 0) return { url: raw, meta: null };
  const url = raw.slice(0, idx);
  let meta = null;
  try {
    meta = JSON.parse(b64decode(raw.slice(idx + 3)) || "null");
  } catch (_) {
    meta = null;
  }
  return { url, meta };
}

// 让 slug 型播放页也能直接出 m3u8（如 hd.kuktxu.com/play/xxx -> .../index.m3u8）
function guessMediaUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (/\.(m3u8|mp4)(\?|$)/i.test(u)) return u;
  if (/\/play\/[^/?#]+$/.test(u)) return u + "/index.m3u8";
  return u;
}

function isMediaUrl(url) {
  return /\.(m3u8|mp4)(\?|$)/i.test(String(url || ""));
}

function buildDetailVod(item, meta, sites) {
  const sources = [];
  const froms = [];
  const urls = [];
  const lineOrder = [];
  item.lines.forEach((line, li) => {
    const episodes = [];
    line.episodes.forEach((ep, ei) => {
      const mediaUrl = guessMediaUrl(ep.url);
      const playId = encodePlayId(mediaUrl, {
        s: item.vod_id,
        // s：该剧在「聚合」或对应分站里的 id，用于播放失败时回退其它线路
        k: meta.sourceKey || "",
        l: line.name,
        n: ep.name || "",
        i: ei,
      });
      episodes.push({
        name: ep.name || `第${ei + 1}集`,
        playId,
        episodeName: ep.name || `第${ei + 1}集`,
      });
    });
    if (!episodes.length) return;
    sources.push({ name: line.name, episodes });
    froms.push(line.name);
    urls.push(episodes.map((e, i) => `${line.episodes[i].name || `第${i + 1}集`}$${line.episodes[i].url}`).join("#"));
    lineOrder.push(line.name);
  });
  const vod = {
    vod_id: `${meta.prefix}${item.vod_id}`,
    vod_name: item.vod_name || "未命名",
    vod_pic: item.vod_pic || "",
    type_name: item.type_name || "影视",
    vod_remarks: item.vod_remarks || "",
    vod_content: item.vod_content || "",
    vod_tag: "video",
  };
  if (item.vod_year) vod.vod_year = item.vod_year;
  if (item.vod_area) vod.vod_area = item.vod_area;
  if (item.vod_lang) vod.vod_lang = item.vod_lang;
  if (item.vod_actor) vod.vod_actor = item.vod_actor;
  if (item.vod_director) vod.vod_director = item.vod_director;
  if (item.vod_score) vod.vod_douban_score = item.vod_score;
  if (sources.length) {
    vod.vod_play_sources = sources;
    vod.vod_play_from = froms.join("$$$");
    vod.vod_play_url = urls.join("$$$");
  }
  if (meta.sourceKey) vod.vod_remarks = vod.vod_remarks || `来源：${sourceName(sites, meta.sourceKey)}`;
  log("info", `[detail] id=${meta.prefix}${item.vod_id} 线路=${lineOrder.join(" / ") || "无"} 分集=${sources.map((s) => s.episodes.length).join(",")}`);
  return vod;
}

// ==================== handler: home ====================

async function home(params, context) {
  log("info", `[home] params=${JSON.stringify(params || {})} from=${(context && context.from) || "web"}`);
  const { sites, baseApi } = await loadSources();
  let baseClasses = [];
  let list = [];
  try {
    const base = await callApi(baseApi, { ac: "list", pg: 1, limit: PAGE_SIZE });
    if (base) {
      baseClasses = base.class;
      list = base.list.map((it) => toListVod(it, { prefix: "agg_" }));
      if (!list.length) {
        const alt = await callApi(baseApi, { ac: "list", sort: "hits", pg: 1, limit: PAGE_SIZE });
        if (alt) list = alt.list.map((it) => toListVod(it, { prefix: "agg_" }));
      }
    }
  } catch (e) {
    log("error", `[home] 异常：${e && e.message}`);
  }
  if (!baseClasses.length) baseClasses = FALLBACK_CLASSES;
  if (!list.length) {
    // 聚合列表异常时，用第一个分站兜底，保证首页不空
    const first = sites.find((s) => s.api !== baseApi) || sites[0];
    if (first) {
      const sub = await callApi(first.api, { ac: "list", pg: 1 });
      if (sub) list = sub.list.map((it) => toListVod(it, { prefix: `src_${first.key}_` }));
    }
  }
  await cacheSet("cxkjg:classes", baseClasses, LIST_CACHE_TTL);
  // 聚合站自身已在"聚合"分类里，不再重复挂成一个分站
  const subSites = sites.filter((s) => s.api !== baseApi);
  log("info", `[home] 分类=${baseClasses.length} 分站=${subSites.length} 返回=${list.length}`);
  return {
    class: buildClassList(baseClasses, subSites),
    filters: buildFilters({}, subSites),
    list,
    parse: 0,
    jx: 0,
  };
}

// ==================== handler: category ====================

async function category(params, context) {
  const page = Math.max(1, toInt(params && params.page, 1));
  const categoryId = params && (params.categoryId || params.type_id || params.id);
  const target = parseCategoryId(categoryId);
  const filters = parseFilters(params);
  log("info", `[category] categoryId=${categoryId} page=${page} filters=${JSON.stringify(filters)}`);

  const { sites, baseApi } = await loadSources();
  const cacheKey = `cxkjg:list:${categoryId}:${page}:${JSON.stringify(filters)}`;
  const cached = await cacheGet(cacheKey);
  if (cached && Array.isArray(cached.list) && cached.list.length) {
    return cached;
  }

  let list = [];
  let pagecount = 1;
  let total = 0;

  if (target.mode === "source") {
    const api = sourceApi(sites, target.key) || baseApi;
    const sort = filters.sort || "update_stamp";
    const res = await callApi(api, { ac: "list", pg: page, sort });
    if (res) {
      list = res.list.map((it) => toListVod(it, { prefix: `src_${target.key}_` }));
      pagecount = res.pagecount || 1;
      total = res.total || 0;
    }
    log("info", `[category] 分站=${target.key} 返回=${list.length} pagecount=${pagecount}`);
  } else {
    const query = { ac: "list", pg: page, limit: PAGE_SIZE };
    if (target.tid) query.t = target.tid;
    ["cid", "area", "language", "sort", "year"].forEach((k) => {
      if (filters[k]) query[k] = filters[k];
    });
    const res = await callApi(baseApi, query);
    if (res) {
      list = res.list.map((it) => toListVod(it, { prefix: "agg_" }));
      pagecount = res.pagecount || 1;
      total = res.total || 0;
    }
    log("info", `[category] 聚合 tid=${target.tid || "全部"} 返回=${list.length} pagecount=${pagecount}`);
  }

  const payload = { page, pagecount, limit: PAGE_SIZE, total: total || pagecount * PAGE_SIZE, list, parse: 0, jx: 0 };
  if (list.length) await cacheSet(cacheKey, payload, LIST_CACHE_TTL);
  return payload;
}

// ==================== handler: detail ====================

function parseVodId(videoId) {
  const raw = String(videoId || "").trim();
  if (raw.indexOf("src_") === 0) {
    const rest = raw.slice(4);
    const idx = rest.indexOf("_");
    if (idx > 0) return { mode: "source", key: rest.slice(0, idx), vid: rest.slice(idx + 1) };
  }
  if (raw.indexOf("agg_") === 0) {
    return { mode: "agg", key: "", vid: raw.slice(4) };
  }
  if (/^\d+$/.test(raw)) return { mode: "agg", key: "", vid: raw };
  return null;
}

async function fetchDetail(videoId) {
  const parsed = parseVodId(videoId);
  if (!parsed) return null;
  const cacheKey = `cxkjg:detail:${videoId}`;
  const cached = await cacheGet(cacheKey);
  if (cached && cached.vod_name) return cached;

  const { sites, baseApi } = await loadSources();
  let item = null;
  let prefix = "agg_";
  let sourceKey = "";

  if (parsed.mode === "source") {
    const api = sourceApi(sites, parsed.key);
    if (api) {
      const res = await callApi(api, { ac: "detail", ids: parsed.vid });
      if (res && res.list.length) {
        item = res.list[0];
        prefix = `src_${parsed.key}_`;
        sourceKey = parsed.key;
      }
    }
  }
  if (!item) {
    const res = await callApi(baseApi, { ac: "detail", ids: parsed.vid });
    if (res && res.list.length) {
      item = res.list[0];
      prefix = "agg_";
      sourceKey = "";
    }
  }
  if (!item) {
    log("error", `[detail] 未取到详情 videoId=${videoId}`);
    return null;
  }
  const vod = buildDetailVod(item, { prefix, sourceKey }, sites);
  await cacheSet(cacheKey, vod, DETAIL_CACHE_TTL);
  return vod;
}

async function detail(params, context) {
  const raw = (params && (params.videoId || params.vod_id || params.id || params.ids)) || "";
  const ids = Array.isArray(raw) ? raw.map(String) : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  log("info", `[detail] ids=${ids.join(",")}`);
  const list = [];
  for (const id of ids) {
    try {
      const vod = await fetchDetail(id);
      if (vod) list.push(vod);
    } catch (e) {
      log("error", `[detail] ${id} 异常：${e && e.message}`);
    }
  }
  return { list };
}

// ==================== handler: search ====================

function dedupeKey(v) {
  return `${v.vod_name || ""}|${v.type_name || ""}`.replace(/\s+/g, "").toLowerCase();
}

// 分站搜索多是 LIKE 模糊匹配，会带进"止水之询"→"静水城"这类噪声；
// 只保留片名与关键词相关的条目（标题包含关键词，或去括号后完全一致）
function isRelevant(name, keyword) {
  const t = String(name || "").replace(/\s+/g, "").toLowerCase();
  const k = String(keyword || "").replace(/\s+/g, "").toLowerCase();
  if (!t || !k) return false;
  if (t.indexOf(k) >= 0) return true;
  const bare = t.replace(/[（(【\[].*?[）)】\]]/g, "");
  return bare === k || bare.indexOf(k) >= 0;
}

async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (_) {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function search(params, context) {
  const page = Math.max(1, toInt(params && params.page, 1));
  const keyword = String((params && (params.keyword || params.wd || params.key)) || "").trim();
  if (!keyword) return { page, pagecount: 0, limit: 0, total: 0, list: [] };
  log("info", `[search] keyword=${keyword} page=${page} from=${(context && context.from) || "web"}`);

  const { sites, baseApi } = await loadSources();
  const seen = new Set();
  const merged = [];
  let pagecount = 1;
  let total = 0;

  const pushAll = (items) => {
    items.forEach((it) => {
      const k = dedupeKey(it);
      if (!k || seen.has(k)) return;
      seen.add(k);
      merged.push(it);
    });
  };

  // 1) 聚合搜索（上游 videolist 会直接带线路名）
  const agg = await callApi(baseApi, { ac: "videolist", wd: keyword, pg: page, limit: PAGE_SIZE });
  if (agg) {
    pushAll(agg.list.map((it) => toListVod(it, { prefix: "agg_" })));
    pagecount = Math.max(pagecount, agg.pagecount || 1);
    total = Math.max(total, agg.total || 0);
    log("info", `[search] 聚合结果=${agg.list.length} pagecount=${agg.pagecount} total=${agg.total}`);
  } else {
    log("error", `[search] 聚合搜索失败，仅依赖分站`);
  }

  // 2) 聚合会漏片（实测"止水之询"聚合 0 条、分站有），首页第一页补扫分站
  if (SUB_SEARCH_ENABLED && page === 1) {
    const subs = sites.filter((s) => s.api !== baseApi).slice(0, SUB_SEARCH_LIMIT);
    const tasks = subs.map((s) => async () => {
      const res = await callApi(s.api, { ac: "videolist", wd: keyword, pg: 1 });
      if (!res || !res.list.length) return null;
      const hits = res.list.filter((it) => isRelevant(it.vod_name, keyword));
      if (hits.length !== res.list.length) {
        log("info", `[search] 分站=${s.name} 原始=${res.list.length} 相关性过滤后=${hits.length}`);
      }
      if (!hits.length) return null;
      return hits.map((it) => toListVod(it, { prefix: `src_${s.key}_` }));
    });
    const settled = await runLimited(tasks, SUB_SEARCH_CONCURRENCY);
    let added = 0;
    settled.forEach((arr) => {
      if (!arr) return;
      const before = merged.length;
      pushAll(arr);
      added += merged.length - before;
    });
    if (added) log("info", `[search] 分站补扫新增=${added}，合并后=${merged.length}`);
  }

  log("info", `[search] 返回=${merged.length}`);
  return {
    page,
    pagecount,
    limit: PAGE_SIZE,
    total: total || merged.length,
    list: merged,
    parse: 0,
    jx: 0,
  };
}

// ==================== handler: play ====================

async function probeUrl(url, headers) {
  if (!url) return false;
  try {
    const res = await rawRequest(url, { headers, timeout: 12000 });
    if (res.statusCode !== 200) return false;
    const head = String(res.body || "").slice(0, 200);
    if (head.indexOf("#EXTM3U") >= 0) return true;
    if (head.trim().startsWith("<")) return false; // 403/404 页
    return true;
  } catch (_) {
    return false;
  }
}

// 当前线路不可用时，去同一部剧的其它线路找同一集
async function fallbackByLines(meta, currentUrl) {
  if (!meta || !meta.s) return "";
  try {
    const { sites, baseApi } = await loadSources();
    const api = meta.k ? sourceApi(sites, meta.k) : baseApi;
    if (!api) return "";
    const res = await callApi(api, { ac: "detail", ids: meta.s });
    if (!res || !res.list.length) return "";
    const item = res.list[0];
    const wantName = String(meta.n || "").replace(/\s+/g, "");
    const candidates = [];
    const push = (u) => {
      if (!u || u === currentUrl) return;
      if (candidates.indexOf(u) < 0) candidates.push(u);
    };
    // 先按"同集名"跨线路找，再退回按集序号找
    item.lines.forEach((line) => {
      const ep = line.episodes.find((x) => String(x.name || "").replace(/\s+/g, "") === wantName);
      if (ep) push(guessMediaUrl(ep.url));
    });
    item.lines.forEach((line) => {
      const ep = line.episodes[meta.i];
      if (ep) push(guessMediaUrl(ep.url));
    });
    for (let i = 0; i < candidates.length && i < 5; i++) {
      const ok = await probeUrl(candidates[i], { "User-Agent": UA });
      if (ok) {
        log("info", `[play] 原线路不可用，回退到第 ${i + 1} 条备选线路：${candidates[i].slice(0, 80)}`);
        return candidates[i];
      }
    }
    log("error", `[play] ${candidates.length} 条备选线路均探测失败`);
  } catch (e) {
    log("error", `[play] 线路回退异常：${e && e.message}`);
  }
  return "";
}

async function play(params, context) {
  const rawPlayId = (params && (params.playId || params.url || params.id)) || "";
  const { url, meta } = decodePlayId(rawPlayId);
  log("info", `[play] playId=${String(rawPlayId).slice(0, 100)} from=${(context && context.from) || "web"}`);
  if (!url || !/^https?:\/\//i.test(url)) {
    log("error", `[play] 非法播放地址：${url}`);
    return { parse: 0, jx: 0, url: "", urls: [] };
  }

  const header = { "User-Agent": UA, Referer: "https://ys.cxkjg.cn/" };
  let finalUrl = guessMediaUrl(url);

  if (!isMediaUrl(finalUrl)) {
    // 非媒体地址：先 sniffVideo，再退化 parse=1
    try {
      if (OmniBox && typeof OmniBox.sniffVideo === "function") {
        const sniffed = await OmniBox.sniffVideo(finalUrl, header);
        const sniffUrl = (sniffed && (sniffed.url || sniffed.playUrl)) || "";
        if (sniffUrl) {
          log("info", `[play] sniffVideo 命中：${String(sniffUrl).slice(0, 90)}`);
          return {
            parse: 0,
            jx: 0,
            flag: (meta && meta.l) || "",
            header,
            url: sniffUrl,
            playUrl: sniffUrl,
            urls: [{ name: (meta && meta.l) || "播放", url: sniffUrl }],
          };
        }
      }
    } catch (e) {
      log("error", `[play] sniffVideo 失败：${e && e.message}`);
    }
    log("info", `[play] 回退 parse=1：${finalUrl.slice(0, 90)}`);
    return {
      parse: 1,
      jx: 0,
      flag: (meta && meta.l) || "",
      header,
      url: finalUrl,
      playUrl: finalUrl,
      urls: [{ name: (meta && meta.l) || "播放", url: finalUrl }],
    };
  }

  if (PLAY_PROBE_ENABLED) {
    const ok = await probeUrl(finalUrl, { "User-Agent": UA });
    if (!ok) {
      const alt = await fallbackByLines(meta, finalUrl);
      if (alt) finalUrl = alt;
      else log("error", `[play] 当前地址探测失败且无可用备选，仍返回原地址：${finalUrl.slice(0, 90)}`);
    }
  }

  return {
    parse: 0,
    jx: 0,
    flag: (meta && meta.l) || "",
    header,
    url: finalUrl,
    playUrl: finalUrl,
    urls: [{ name: (meta && meta.l) || "播放", url: finalUrl }],
  };
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
