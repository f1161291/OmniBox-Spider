// @name FKTV
// @author 梦
// @description 刮削：支持，弹幕：支持，嗅探：支持。v2.0.0 重写：站点已改为 Next.js + 加密 API，改用 POST /ysapi（AES-128-ECB + deviceId）取数据，home/category/search/detail 分别走 movie/home、movie/search、movie/detail，播放走 playback_v2 的签名 m3u8 直链（parse=0，AES-128 HLS 且 CORS 全开）；请求走 Node 原生 https，不依赖宿主 request 的自定义头透传
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/FKTV.js

/**
 * 环境变量：
 * - FKTV_HOST       站点地址，默认 https://fktv.me
 * - FKTV_API_KEY    /ysapi 的 AES-128 密钥，默认 9ed1a661a6ab787a（站点前端硬编码，站点改版时同步改这里）
 * - FKTV_UA         请求 UA
 * - FKTV_PAGE_SIZE  分类/搜索每页条数，默认 30（上限 100）
 * - FKTV_HOME_TTL   首页接口缓存秒数，默认 300
 * - FKTV_LIST_TTL   分类/搜索接口缓存秒数，默认 300
 * - FKTV_DETAIL_TTL 详情接口缓存秒数，默认 120（play 不走缓存，签名有时效）
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");

let OmniBox;
try {
    OmniBox = require("omnibox_sdk");
} catch (_) {
    OmniBox = {
        log(level, message) { console.error(`[${level}] ${message}`); },
        async request() { return { body: "" }; },
        async getCache() { return null; },
        async setCache() { },
        async processScraping() { return {}; },
        async getScrapeMetadata() { return null; },
        async addPlayHistory() { }
    };
}

let runner;
try {
    runner = require("spider_runner");
} catch (_) {
    runner = { run() { } };
}

// ==================== 配置 ====================

const HOST = (process.env.FKTV_HOST || "https://fktv.me").replace(/\/+$/, "");
const HOSTNAME = HOST.replace(/^https?:\/\//, "");
const API_BASE = `${HOST}/ysapi`;
const API_KEY = process.env.FKTV_API_KEY || "9ed1a661a6ab787a";
const UA = process.env.FKTV_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PAGE_SIZE = Math.max(1, Math.min(100, parseInt(process.env.FKTV_PAGE_SIZE || "30", 10) || 30));
const HOME_CACHE_TTL = Math.max(0, parseInt(process.env.FKTV_HOME_TTL || "300", 10) || 300);
const LIST_CACHE_TTL = Math.max(0, parseInt(process.env.FKTV_LIST_TTL || "300", 10) || 300);
const DETAIL_CACHE_TTL = Math.max(0, parseInt(process.env.FKTV_DETAIL_TTL || "120", 10) || 120);

// deviceId 字符集与站点前端保持一致，否则服务端返回 errorCode 2001「设备信息错误」
const DID_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz102345678";
const DID_CACHE_KEY = "fktv:device_id";

const CLASS_LIST = [
    { type_id: "movie", type_name: "电影" },
    { type_id: "tv", type_name: "电视剧" },
    { type_id: "comic", type_name: "动漫" },
    { type_id: "zy", type_name: "综艺" },
    { type_id: "short_tv", type_name: "短剧" },
    { type_id: "jlp", type_name: "纪录片" },
    { type_id: "js", type_name: "电影解说" }
];

// 子类型 tag_id 取自官网 /channel/{position} 各板块「更多」链接
const TAG_OPTIONS = {
    movie: [
        { name: "全部", value: "all" },
        { name: "喜剧片", value: "299" },
        { name: "爱情片", value: "302" },
        { name: "动作片", value: "308" },
        { name: "战争片", value: "337" },
        { name: "犯罪片", value: "318" },
        { name: "奇幻片", value: "330" },
        { name: "科幻片", value: "327" }
    ],
    tv: [
        { name: "全部", value: "all" },
        { name: "国产剧", value: "296" },
        { name: "港剧", value: "324" },
        { name: "台剧", value: "314" },
        { name: "韩剧", value: "325" },
        { name: "欧美剧", value: "295" },
        { name: "泰剧", value: "311" }
    ],
    comic: [
        { name: "全部", value: "all" },
        { name: "国产动漫", value: "326" },
        { name: "日本动漫", value: "307" },
        { name: "欧美动漫", value: "323" }
    ],
    zy: [
        { name: "全部", value: "all" },
        { name: "国产综艺", value: "316" },
        { name: "港台综艺", value: "336" },
        { name: "韩国综艺", value: "328" },
        { name: "日本综艺", value: "356" },
        { name: "其他综艺", value: "365" }
    ],
    short_tv: [
        { name: "全部", value: "all" },
        { name: "穿越", value: "321" },
        { name: "甜宠", value: "301" },
        { name: "逆袭", value: "300" },
        { name: "重生", value: "309" }
    ],
    jlp: [{ name: "全部", value: "all" }],
    js: [{ name: "全部", value: "all" }]
};

// 语言取值：官网筛选链接 language/1..8 对应
const LANGUAGE_OPTIONS = [
    { name: "全部", value: "all" },
    { name: "国语", value: "1" },
    { name: "粤语", value: "2" },
    { name: "英语", value: "3" },
    { name: "韩语", value: "4" },
    { name: "日语", value: "5" },
    { name: "法语", value: "6" },
    { name: "泰语", value: "7" },
    { name: "其他语", value: "8" }
];

const ORDER_OPTIONS = [
    { name: "添加时间", value: "last_update" },
    { name: "人气高低", value: "hot" },
    { name: "收藏最多", value: "ranking" }
];

function buildYearOptions() {
    const current = new Date().getFullYear();
    const out = [{ name: "全部", value: "all" }];
    for (let y = current; y >= current - 12; y -= 1) out.push({ name: String(y), value: String(y) });
    return out;
}

function buildFilters() {
    const yearOptions = buildYearOptions();
    const filters = {};
    CLASS_LIST.forEach((cls) => {
        filters[cls.type_id] = [
            { key: "tag", name: "类型", init: "all", value: TAG_OPTIONS[cls.type_id] || [{ name: "全部", value: "all" }] },
            { key: "year", name: "年份", init: "all", value: yearOptions },
            { key: "lang", name: "语言", init: "all", value: LANGUAGE_OPTIONS },
            { key: "order", name: "排序", init: "last_update", value: ORDER_OPTIONS }
        ];
    });
    return filters;
}

// ==================== 日志 ====================

async function logInfo(message, extra) {
    try {
        await OmniBox.log("info", `[FKTV] ${message}${extra === undefined ? "" : ` | ${safeJson(extra)}`}`);
    } catch (_) { /* 日志失败不影响主链路 */ }
}

async function logWarn(message, extra) {
    try {
        await OmniBox.log("warn", `[FKTV] ${message}${extra === undefined ? "" : ` | ${safeJson(extra)}`}`);
    } catch (_) { /* ignore */ }
}

async function logError(message, error) {
    try {
        const detail = error && error.message ? `${message}: ${error.message}` : message;
        await OmniBox.log("error", `[FKTV] ${detail}`);
    } catch (_) { /* ignore */ }
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

// ==================== 通用工具 ====================

function bodyText(res) {
    const body = res && res.body !== undefined ? res.body : res;
    if (!body) return "";
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    if (typeof body === "object") return safeJson(body);
    return String(body);
}

function shortKey(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex");
}

async function cacheGet(key) {
    try {
        const val = await OmniBox.getCache(key);
        return val === undefined || val === null || val === "" ? null : val;
    } catch (_) {
        return null;
    }
}

async function cacheSet(key, value, ttl) {
    try {
        const payload = typeof value === "string" ? value : safeJson(value);
        await OmniBox.setCache(key, payload, ttl);
    } catch (_) { /* 缓存失败不阻塞主链路 */ }
}

function absUrl(path) {
    const url = String(path || "").trim();
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return `${HOST}${url.startsWith("/") ? "" : "/"}${url}`;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function apiTime() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ==================== 加密 API 层 ====================

function aesEncrypt(text) {
    const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(API_KEY, "utf8"), null);
    return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]).toString("base64");
}

function aesDecrypt(b64) {
    const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(API_KEY, "utf8"), null);
    return Buffer.concat([decipher.update(String(b64), "base64"), decipher.final()]).toString("utf8");
}

function randomDeviceId(len = 32) {
    let out = "";
    for (let i = 0; i < len; i += 1) out += DID_CHARS.charAt(Math.floor(Math.random() * DID_CHARS.length));
    return out;
}

let memoryDeviceId = "";

async function getDeviceId() {
    if (memoryDeviceId) return memoryDeviceId;
    const cached = await cacheGet(DID_CACHE_KEY);
    if (cached && String(cached).length === 32) {
        memoryDeviceId = String(cached);
        return memoryDeviceId;
    }
    memoryDeviceId = randomDeviceId(32);
    await cacheSet(DID_CACHE_KEY, memoryDeviceId, 86400 * 30);
    return memoryDeviceId;
}

/**
 * 原生 https/http 请求：需要精确控制自定义头（version/deviceType/time）与二进制 body，
 * 宿主 OmniBox.request 对这些头不保证透传，因此这里自己发。
 */
function rawRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (e) {
            reject(new Error(`非法 URL: ${url}`));
            return;
        }
        const isHttps = target.protocol === "https:";
        const lib = isHttps ? https : http;
        const body = options.body === undefined || options.body === null ? "" : String(options.body);
        const headers = Object.assign({}, options.headers || {});
        if (body) headers["Content-Length"] = Buffer.byteLength(body);

        const req = lib.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: options.method || "GET",
            headers,
            timeout: options.timeout || 20000
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers || {},
                    text: Buffer.concat(chunks).toString("utf8")
                });
            });
        });
        req.on("error", reject);
        req.setTimeout(options.timeout || 20000, () => req.destroy(new Error("请求超时")));
        if (body) req.write(body);
        req.end();
    });
}

function parseApiResponse(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    if (raw.startsWith("{") || raw.startsWith("[")) {
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }
    try {
        return JSON.parse(aesDecrypt(raw));
    } catch (_) {
        return null;
    }
}

/**
 * 调用站点加密接口。
 * @param {string} endpoint 如 movie/home
 * @param {object} data 业务参数
 * @param {number} ttl 缓存秒数，0 表示不缓存
 */
async function apiPost(endpoint, data, ttl = 0) {
    const payloadData = data || {};
    const cacheKey = ttl > 0 ? `fktv:api:${shortKey(`${endpoint}|${safeJson(payloadData)}`)}` : "";

    if (cacheKey) {
        const cached = await cacheGet(cacheKey);
        if (cached) {
            const parsed = parseApiResponse(cached);
            if (parsed) {
                await logInfo(`接口缓存命中 ${endpoint}`);
                return parsed;
            }
        }
    }

    const payload = {
        deviceId: await getDeviceId(),
        token: "",
        domain: HOSTNAME,
        referer: `${HOST}/`,
        user_agent: UA,
        shareCode: "",
        channel: "",
        ip: "",
        data: payloadData
    };
    const body = aesEncrypt(safeJson(payload));

    const headers = {
        "version": "1.0",
        "deviceType": "pc",
        "time": apiTime(),
        "shareCode": "",
        "channel": "",
        "ip": "",
        "Content-Type": "application/octet-stream",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": UA,
        "Referer": `${HOST}/`,
        "Origin": HOST
    };

    let text = "";
    let transport = "https";
    try {
        const res = await rawRequest(`${API_BASE}/${endpoint}`, {
            method: "POST",
            headers,
            body,
            timeout: 20000
        });
        text = res.text || "";
    } catch (e) {
        await logWarn(`原生请求失败 ${endpoint}，回退宿主 request`, { message: e && e.message });
        transport = "omnibox";
        try {
            const res = await OmniBox.request(`${API_BASE}/${endpoint}`, {
                method: "POST",
                headers,
                body,
                timeout: 20000
            });
            text = bodyText(res);
        } catch (e2) {
            await logError(`接口请求失败 ${endpoint}`, e2);
            return null;
        }
    }

    const json = parseApiResponse(text);
    if (!json) {
        await logWarn(`接口响应无法解析 ${endpoint}`, { preview: String(text).slice(0, 160) });
        return null;
    }
    if (json.status !== "y") {
        await logWarn(`接口返回异常 ${endpoint}`, { transport, status: json.status, error: json.error, errorCode: json.errorCode });
        return null;
    }

    if (cacheKey) await cacheSet(cacheKey, json, ttl);
    return json;
}

// ==================== 数据映射 ====================

function pickCover(item) {
    if (!item) return "";
    const direct = item.img_x_source || item.img_y_source || "";
    if (direct) return absUrl(direct);
    // img_x / img_y 是 .bnc 加密图，浏览器无法直接渲染
    const fallback = item.img_x || item.img_y || "";
    if (fallback && !/\.bnc(\?|$)/i.test(fallback)) return absUrl(fallback);
    return "";
}

function buildRemarks(item) {
    if (!item) return "";
    const parts = [];
    if (item.score && Number(item.score) > 0) parts.push(`评分 ${item.score}`);
    if (item.release_at) parts.push(String(item.release_at));
    if (item.area) parts.push(String(item.area));
    return parts.join(" · ");
}

function mapItem(item, typeId) {
    if (!item || !item.id) return null;
    return {
        vod_id: String(item.id),
        vod_name: item.name || item.name_tw || "",
        vod_pic: pickCover(item),
        vod_remarks: buildRemarks(item),
        vod_year: item.release_at ? String(item.release_at) : "",
        type_id: typeId || item.position || "",
        type_name: item.child_title || item.category || ""
    };
}

function dedupeList(list) {
    const seen = new Set();
    return list.filter((item) => {
        if (!item || !item.vod_id) return false;
        if (seen.has(item.vod_id)) return false;
        seen.add(item.vod_id);
        return true;
    });
}

function pickFilters(params) {
    const candidates = [params && params.filters, params && params.extend, params && params.ext, params && params.filter];
    for (const item of candidates) {
        if (item && typeof item === "object" && !Array.isArray(item)) return item;
    }
    return {};
}

// ==================== playId 编解码 ====================

function encodePlayId(meta) {
    return safeJson({
        m: meta.movieId || "",
        l: meta.linkId || "",
        s: meta.line || "",
        n: meta.episodeName || ""
    });
}

function decodePlayId(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    if (text.startsWith("{")) {
        try {
            const obj = JSON.parse(text);
            if (obj && obj.m) return obj;
        } catch (_) { /* fallthrough */ }
    }
    return null;
}

// ==================== 播放结果构造 ====================

function buildPlayResult(urls, referer, flag) {
    const list = (urls || []).filter((it) => it && it.url);
    if (!list.length) return null;
    const headers = {
        "User-Agent": UA,
        "Referer": referer || `${HOST}/`,
        "Origin": HOST
    };
    return {
        urls: list,
        url: list[0].url,
        flag: flag || list[0].name || "线路",
        header: headers,
        headers,
        parse: 0
    };
}

function buildFallback(pageUrl, name) {
    const headers = {
        "User-Agent": UA,
        "Referer": pageUrl || `${HOST}/`,
        "Origin": HOST
    };
    return {
        urls: [{ name: name || "站点页面", url: pageUrl }],
        url: pageUrl,
        flag: name || "站点页面",
        header: headers,
        headers,
        parse: 1
    };
}

function emptyPlay() {
    return { urls: [], url: "", flag: "线路", header: {}, headers: {}, parse: 0 };
}

// ==================== 核心方法 ====================

async function home(params) {
    await logInfo("home 入参", params || {});
    const result = { class: CLASS_LIST, filters: buildFilters(), list: [] };

    const json = await apiPost("movie/home", {}, HOME_CACHE_TTL);
    const data = (json && json.data) || {};
    const list = [];

    const blocks = Array.isArray(data.main_block) ? data.main_block : [];
    blocks.forEach((block) => {
        const filters = Array.isArray(block && block.filters) ? block.filters : [];
        const usable = filters.find((f) => Array.isArray(f && f.items) && f.items.length) || filters[0];
        const items = (usable && Array.isArray(usable.items)) ? usable.items : [];
        items.forEach((item) => {
            const mapped = mapItem(item, block.cat_code);
            if (mapped) list.push(mapped);
        });
    });

    (Array.isArray(data.new_items) ? data.new_items : []).forEach((item) => {
        const mapped = mapItem(item, item && item.position);
        if (mapped) list.push(mapped);
    });

    result.list = dedupeList(list);
    await logInfo("home 解析结果", { blockCount: blocks.length, listCount: result.list.length, first: result.list[0] || null });
    return result;
}

async function category(params) {
    await logInfo("category 入参", params || {});

    const pg = Math.max(1, parseInt(params && params.page, 10) || 1);
    const typeId = String(
        (params && (params.type_id || params.categoryId || params.typeId || params.type)) || "movie"
    );
    const filters = pickFilters(params);

    const body = {
        position: typeId,
        page: String(pg),
        page_size: String(PAGE_SIZE)
    };
    if (filters.tag && String(filters.tag) !== "all") body.tag_id = String(filters.tag);
    if (filters.year && String(filters.year) !== "all") body.year = String(filters.year);
    if (filters.lang && String(filters.lang) !== "all") body.language = String(filters.lang);
    if (filters.order && String(filters.order) !== "last_update") body.order = String(filters.order);

    const json = await apiPost("movie/search", body, LIST_CACHE_TTL);
    if (!json) {
        await logWarn("category 接口无数据", { typeId, page: pg, filters });
        return { page: pg, pagecount: pg, limit: PAGE_SIZE, total: 0, list: [] };
    }

    const data = json.data || {};
    const items = Array.isArray(data.data) ? data.data : [];
    const total = parseInt(data.total, 10) || 0;
    const list = dedupeList(items.map((item) => mapItem(item, typeId)));
    const pagecount = total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : pg;

    await logInfo("category 解析结果", { typeId, page: pg, total, pagecount, count: list.length, body });
    return { page: pg, pagecount, limit: PAGE_SIZE, total, list };
}

async function detail(params) {
    await logInfo("detail 入参", params || {});

    const rawId = String((params && (params.videoId || params.vod_id || params.id)) || "").trim();
    if (!rawId) return { list: [] };

    const movieId = rawId.split("|")[0];
    const json = await apiPost("movie/detail", { id: movieId }, DETAIL_CACHE_TTL);
    if (!json) {
        await logWarn("detail 接口无数据", { movieId });
        return { list: [] };
    }

    const data = json.data || {};
    const links = Array.isArray(data.links) ? data.links : [];
    const playback = data.playback_v2 || {};
    const videoLines = Array.isArray(playback.video_lines) ? playback.video_lines : [];

    // 线路优先取 playback_v2 声明的真实线路（国内线路 / 海外线路），无则用单条默认线路
    let lines = videoLines
        .filter((line) => line && (line.h264 || line.hevc))
        .map((line) => ({ code: line.line || "", name: line.name || line.line || "线路" }));
    if (!lines.length) lines = [{ code: "", name: "默认线路" }];

    const vodName = data.name || "";
    const scrapeCandidates = links.map((link, index) => {
        const epName = String((link && link.name) || `第${index + 1}集`);
        return {
            fid: `${movieId}#0#${index}`,
            file_id: `${movieId}#0#${index}`,
            file_name: epName,
            name: epName,
            format_type: "video"
        };
    });

    let scrapeData = null;
    let videoMappings = [];
    if (scrapeCandidates.length) {
        try {
            await OmniBox.processScraping(movieId, vodName, vodName, scrapeCandidates);
            const metadata = await OmniBox.getScrapeMetadata(movieId);
            scrapeData = (metadata && metadata.scrapeData) || null;
            videoMappings = (metadata && metadata.videoMappings) || [];
            await logInfo("detail 刮削完成", { hasScrapeData: !!scrapeData, mappingCount: videoMappings.length });
        } catch (e) {
            await logWarn("detail 刮削失败，降级继续", { message: e && e.message });
        }
    }

    const playSources = lines.map((line) => ({
        name: line.name,
        episodes: links.map((link, index) => {
            const epRawName = String((link && link.name) || `第${index + 1}集`);
            const fid = `${movieId}#0#${index}`;
            const mapping = videoMappings.find((m) => m && m.fileId === fid);
            const epName = mapping && mapping.episodeName ? mapping.episodeName : epRawName;
            return {
                name: epName,
                playId: encodePlayId({
                    movieId,
                    linkId: (link && link.id) || "",
                    line: line.code,
                    episodeName: epRawName
                })
            };
        })
    })).filter((source) => source.episodes.length);

    const tags = Array.isArray(data.tags) ? data.tags.map((t) => (t && t.name) || "").filter(Boolean) : [];
    const remarksParts = [];
    if (data.score && Number(data.score) > 0) remarksParts.push(`评分 ${data.score}`);
    if (links.length) remarksParts.push(`共${links.length}集`);
    if (data.pay_type === "vip") remarksParts.push("VIP");

    const vod = {
        vod_id: movieId,
        vod_name: (scrapeData && scrapeData.title) || vodName,
        vod_pic: (scrapeData && scrapeData.posterPath)
            ? `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`
            : pickCover(data),
        vod_content: (scrapeData && scrapeData.overview) || data.description || "",
        vod_year: (scrapeData && scrapeData.releaseDate ? String(scrapeData.releaseDate).substring(0, 4) : "") || (data.release_at ? String(data.release_at) : ""),
        vod_area: data.area || "",
        vod_lang: data.language || "",
        vod_actor: data.actor || "",
        vod_director: data.director || "",
        vod_score: data.score || "",
        vod_douban_score: data.score || "",
        vod_remarks: remarksParts.join(" · "),
        type_name: tags[0] || data.child_title || data.category || "",
        vod_play_sources: playSources
    };

    if (scrapeData) {
        const cast = ((scrapeData.credits && scrapeData.credits.cast) || []).slice(0, 6).map((c) => c && c.name).filter(Boolean).join(",");
        if (cast) vod.vod_actor = cast;
        const crew = ((scrapeData.credits && scrapeData.credits.crew) || [])
            .filter((c) => c && (c.job === "Director" || c.department === "Directing"))
            .slice(0, 3).map((c) => c && c.name).filter(Boolean).join(",");
        if (crew) vod.vod_director = crew;
    }

    await logInfo("detail 解析结果", {
        movieId,
        name: vod.vod_name,
        lineCount: playSources.length,
        episodeCount: links.length,
        cover: vod.vod_pic,
        lineNames: playSources.map((s) => s.name)
    });

    return { list: [vod] };
}

async function search(params) {
    await logInfo("search 入参", params || {});

    const keyword = String((params && (params.keyword || params.wd || params.key)) || "").trim();
    const pg = Math.max(1, parseInt(params && params.page, 10) || 1);
    if (!keyword) return { page: pg, pagecount: pg, limit: PAGE_SIZE, total: 0, list: [] };

    // 关键词搜索不能带 position，否则站点返回 0 条
    const body = {
        keywords: keyword,
        page: String(pg),
        page_size: String(PAGE_SIZE)
    };

    const json = await apiPost("movie/search", body, LIST_CACHE_TTL);
    if (!json) {
        await logWarn("search 接口无数据", { keyword, page: pg });
        return { page: pg, pagecount: pg, limit: PAGE_SIZE, total: 0, list: [] };
    }

    const data = json.data || {};
    const items = Array.isArray(data.data) ? data.data : [];
    const total = parseInt(data.total, 10) || 0;
    const list = dedupeList(items.map((item) => mapItem(item, item && item.position)));
    const pagecount = total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : pg;

    await logInfo("search 解析结果", { keyword, page: pg, total, count: list.length, first: list[0] || null });
    return { page: pg, pagecount, limit: PAGE_SIZE, total, list };
}

async function play(params) {
    try {
        await logInfo("play 入参", params || {});

        const raw = String((params && (params.playId || params.play_id || params.url)) || "").trim();
        if (!raw) return emptyPlay();

        // 已是媒体直链，直接返回
        if (/\.(m3u8|mp4|flv)(\?|$)/i.test(raw)) {
            const direct = buildPlayResult([{ name: "直链", url: raw }], `${HOST}/`);
            await logInfo("play 直链入参", direct);
            return direct || emptyPlay();
        }

        const meta = decodePlayId(raw);
        if (!meta) {
            await logWarn("play 无法解析 playId", { preview: raw.slice(0, 120) });
            return emptyPlay();
        }

        // playback_v2 的签名带时效（约 3 小时），这里不走缓存
        const json = await apiPost("movie/detail", { id: meta.m, link_id: meta.l }, 0);
        const data = (json && json.data) || {};
        const playback = data.playback_v2 || {};
        const videoLines = Array.isArray(playback.video_lines) ? playback.video_lines : [];

        const urls = [];
        videoLines.forEach((line) => {
            const media = line && (line.h264 || line.hevc);
            if (!media || !media.url) return;
            urls.push({
                code: line.line || "",
                name: line.name || line.line || "线路",
                url: absUrl(media.url)
            });
        });

        // 命中指定线路的排到首位
        if (meta.s) {
            urls.sort((a, b) => {
                const aw = a.code === meta.s ? 0 : 1;
                const bw = b.code === meta.s ? 0 : 1;
                return aw - bw;
            });
        }

        if (urls.length) {
            const result = buildPlayResult(urls, `${HOST}/movie/detail/${meta.m}`, urls[0].name);
            await logInfo("play 使用 playback_v2 签名 m3u8", {
                movieId: meta.m,
                linkId: meta.l,
                line: meta.s || "",
                urls: urls.map((it) => ({ name: it.name, url: it.url }))
            });
            return result || emptyPlay();
        }

        // 兜底一：play_links 里的 m3u8（同站点同源，同样可直连）
        const playLinks = Array.isArray(data.play_links) ? data.play_links : [];
        const fallbackUrls = playLinks
            .map((item) => {
                const url = (item && (item.m3u8_url || item.hevc_m3u8_url)) || "";
                return url ? { name: (item && item.name) || "线路", url: absUrl(url) } : null;
            })
            .filter(Boolean);
        if (fallbackUrls.length) {
            const result = buildPlayResult(fallbackUrls, `${HOST}/movie/detail/${meta.m}`, fallbackUrls[0].name);
            await logInfo("play 回退 play_links", { count: fallbackUrls.length, urls: fallbackUrls });
            return result || emptyPlay();
        }

        // 兜底二：尝试 SDK 嗅探详情页
        const pageUrl = `${HOST}/movie/detail/${meta.m}`;
        try {
            const sniff = await OmniBox.sniffVideo(pageUrl, { "User-Agent": UA, "Referer": `${HOST}/` });
            if (sniff && sniff.url) {
                const result = buildPlayResult([{ name: meta.s || "嗅探播放", url: sniff.url }], pageUrl);
                await logInfo("play 使用嗅探结果", result);
                return result || emptyPlay();
            }
        } catch (e) {
            await logWarn("play 嗅探失败", { message: e && e.message });
        }

        const playError = data.play_error_type || data.play_error || "";
        await logWarn("play 未拿到可播地址", { movieId: meta.m, linkId: meta.l, playError });
        return buildFallback(pageUrl, playError === "need_vip" ? "站点 VIP 页" : "站点页面");
    } catch (e) {
        await logError("play 异常", e);
        return emptyPlay();
    }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
