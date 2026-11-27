// @name 修罗影视
// @author 
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios, cheerio
// @version 1.1.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/修罗影视.js

/**
 * ============================================================================
 * 修罗影视 - OmniBox 爬虫脚本
 * 站点地址: https://www.xlysw.ggff.net （v1.1.0 迁移：旧域 xlys02.com SSL 已失效）
 * ============================================================================
 * 核心功能:
 *   - 首页/分类: MacCMS myui 模板，/list/?{typeId}-{page}.html，.myui-vodlist__box 卡片
 *   - 详情: /detail/?{id}.html，#playlist1 .myui-content__list li 剧集列表
 *   - 播放: /video/?{id}-{from}-{part}.html 内 var now="...m3u8" 明文直链（master 展开子流，parse=0）
 *   - 搜索: search.php 算术验证码（外部 OCR + 会话缓存）+ ymck 聚合搜索兜底
 * 修改时间: 2026-11-28
 */

const axios = require("axios");
const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");
const https = require("https");

// ==================== 配置区域开始 ====================
// 弹幕接口地址。未配置时不启用弹幕补充。
const DANMU_API = process.env.DANMU_API || "";
// 修罗专用 ddddocr 基础地址。若配置该项，优先按 ddddocr 风格处理。
const RAW_XIULUO_DDDDOCR_API = String(process.env.XIULUO_DDDDOCR_API || "").trim();
// 修罗专用普通 OCR 基础地址。仅在未配置 ddddocr 地址时参与兜底。
const RAW_XIULUO_OCR_API = String(process.env.XIULUO_OCR_API || "").trim();
// 通用 ddddocr 基础地址。作为修罗专用 ddddocr 地址的后备。
const RAW_DDDDOCR_API = String(process.env.DDDDOCR_API || "").trim();
// 通用 OCR 基础地址。作为修罗专用普通 OCR 地址的后备。
const RAW_OCR_API = String(process.env.OCR_API || "").trim();
// OCR 识别接口自定义路径。留空时自动按接口类型推断。
const EXTERNAL_OCR_PATH = String(process.env.XIULUO_DDDDOCR_PATH || process.env.XIULUO_OCR_PATH || "").trim();

// 最终生效的外部 OCR 基础地址。优先级：修罗专用 ddddocr > 修罗专用 OCR > 通用 ddddocr > 通用 OCR。
const EXTERNAL_OCR_API = String(RAW_XIULUO_DDDDOCR_API || RAW_XIULUO_OCR_API || RAW_DDDDOCR_API || RAW_OCR_API || "").trim();
// OCR 接口类型标记：ddddocr 或普通 ocr，用于自动推断接口路径。
const OCR_API_KIND = (RAW_XIULUO_DDDDOCR_API || RAW_DDDDOCR_API) ? "ddddocr" : ((RAW_XIULUO_OCR_API || RAW_OCR_API) ? "ocr" : "");
// 默认公共 OCR 兜底接口。当自定义 OCR 失败时回退到该接口。
const DEFAULT_OCR_API = "https://api.nn.ci/ocr/b64/json";
// 搜索会话的 SDK 标准缓存键。
const SESSION_CACHE_KEY = "xiuluo:search-cookie";
// 搜索会话缓存时长：30 分钟。
const SESSION_TTL = 30 * 60 * 1000;

// 站点主域名。
const HOST = (process.env.XIULUO_HOST || "https://www.xlysw.ggff.net").replace(/\/$/, "");
// 桌面端请求 User-Agent。
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
// 移动端请求 User-Agent。搜索与验证码链路优先使用该 UA。
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";

// 进程内搜索会话镜像缓存。优先配合 SDK 缓存一起使用，减少重复读取。
let SESSION_CACHE = {
    cookie: null,
    expire: 0
};
// ==================== 配置区域结束 ====================

/**
 * 创建 HTTPS Agent (忽略 SSL 证书验证)
 */
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 50,
    maxFreeSockets: 10,
    scheduling: 'lifo',
    rejectUnauthorized: false  // 忽略 SSL 证书验证
});

/**
 * 创建 Axios 实例
 */
const axiosInstance = axios.create({
    httpsAgent
});

// ========== 日志工具 ==========
const logInfo = (message, data = null) => {
    const output = data ? `${message}: ${JSON.stringify(data)}` : message;
    OmniBox.log("info", `[修罗影视] ${output}`);
};

const logError = (message, error) => {
    OmniBox.log("error", `[修罗影视] ${message}: ${error.message || error}`);
};

// ========== 元数据编解码 ==========
const encodeMeta = (obj) => {
    try {
        return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64");
    } catch {
        return "";
    }
};

const decodeMeta = (str) => {
    try {
        const raw = Buffer.from(str || "", "base64").toString("utf8");
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
};

// ========== 工具函数 ==========
const fixImg = (img) => {
    if (!img) return "";
    if (img.startsWith("http")) return img;
    if (img.startsWith("//")) return "https:" + img;
    return HOST + img;
};

const getId = (href) => {
    if (!href) return "";
    let id = href.split(".htm")[0];
    if (id.startsWith("/")) id = id.substring(1);
    return id;
};

// ===== v1.1.0：myui 模板解析辅助（新域 xlysw.ggff.net）=====
// /detail/?9443.html -> 9443；/video/?9443-0-0.html -> 9443-0-0
const parseMyuiId = (href) => {
    if (!href) return "";
    const m = String(href).match(/\?([\w-]+)\.html/);
    if (m) return m[1];
    const n = String(href).match(/(\d+)(?:-\d+-\d+)?\.html/);
    return n ? n[1] : "";
};

// 从 style="background: url(...)" 或 data-original / src 中提取封面
const extractCover = ($, el) => {
    const a = $(el).find('a[href*="/detail/"]').first();
    const style = a.attr("style") || $(el).find('[style*="background"]').first().attr("style") || "";
    let url = "";
    const sm = style.match(/url\(['"]?([^'")]+)['"]?\)/i);
    if (sm) url = sm[1];
    if (!url) url = $(el).find("img").attr("data-original") || $(el).find("img").attr("src") || "";
    return fixImg(url);
};

// 解析 .myui-vodlist__box 卡片列表为 OmniBox list
const parseMyuiCards = ($) => {
    const list = [];
    $(".myui-vodlist__box").each((_, el) => {
        const a = $(el).find('a[href*="/detail/"]').first();
        const href = a.attr("href");
        if (!href) return;
        const id = parseMyuiId(href);
        if (!id) return;
        const name = $(el).find(".myui-vodlist__detail h4 a, .myui-vodlist__detail .title a").first().text().trim()
            || a.attr("title") || "";
        const remark = $(el).find(".myui-vodlist__detail .text, .myui-vodlist__detail .text-muted").first().text().trim();
        list.push({ vod_id: id, vod_name: name, vod_pic: extractCover($, el), vod_remarks: remark });
    });
    return list;
};

// 首页/详情页分类导航（真实 typeId）
const buildMyuiCategories = () => ([
    { type_id: "1", type_name: "电影" },
    { type_id: "2", type_name: "电视剧" },
    { type_id: "3", type_name: "综艺" },
    { type_id: "4", type_name: "动漫" },
    { type_id: "42", type_name: "短剧" },
    { type_id: "40", type_name: "会员动漫" },
    { type_id: "41", type_name: "会员片" },
    { type_id: "43", type_name: "体育" }
]);

// 从 .myui-page 的「1/835」中提取总页数
const extractPageCount = ($, currentPage) => {
    const pageText = $(".myui-page").text().replace(/\s+/g, " ");
    const m = pageText.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return parseInt(m[2], 10) || currentPage;
    return currentPage;
};

// 相对 URL 转绝对
const absoluteUrl = (base, rel) => {
    if (!rel) return base;
    if (/^https?:\/\//i.test(rel)) return rel;
    if (rel.startsWith("//")) return "https:" + rel;
    if (rel.startsWith("/")) {
        const m = String(base).match(/^(https?:\/\/[^/]+)/);
        return (m ? m[1] : "") + rel;
    }
    const m = String(base).match(/^(.*\/)[^/]*$/);
    return (m ? m[1] : base) + rel;
};

// master m3u8 → 展开为第一个子流绝对 URL（子流为 VOD 无 AES，可 parse=0 直返）
const resolveXlyM3u8 = async (url, referer) => {
    try {
        const res = await axiosInstance.get(url, {
            headers: { "User-Agent": UA, "Referer": referer || HOST },
            timeout: 15000
        });
        const body = String(res.data || "");
        if (body.includes("#EXT-X-STREAM-INF")) {
            const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j] && !lines[j].startsWith("#")) {
                            return absoluteUrl(url, lines[j]);
                        }
                    }
                }
            }
        }
    } catch (e) {
        logInfo(`⚠ master 展开失败，保留原 URL: ${e.message}`);
    }
    return url;
};

const extractDetailVodName = ($, videoId = "") => {
    const invalidTitles = new Set(["观看历史", "简介", "剧集列表", "相关推荐", "热门推荐"]);
    const pickMainTitle = (text) => {
        if (!text) return "";
        const raw = text.replace(/\s+/g, " ").trim();
        // 优先提取《片名》
        const quoted = raw.match(/《\s*([^》]+?)\s*》/);
        if (quoted && quoted[1]) return quoted[1].trim();
        return raw;
    };
    const selectors = [
        "h1",
        ".video-title",
        ".detail-title",
        ".vod-title",
        ".card-title"
    ];

    for (const sel of selectors) {
        const txt = pickMainTitle($(sel).first().text());
        if (txt && !invalidTitles.has(txt)) {
            return txt;
        }
    }

    // 回退到页面 title
    const pageTitle = $("title").first().text().trim();
    if (pageTitle) {
        const cleanTitle = pickMainTitle(pageTitle
            .replace(/\s*[-|_｜]\s*修罗影视.*$/i, "")
            .replace(/\s*[-|_｜].*$/, "")
            .trim());
        if (cleanTitle && !invalidTitles.has(cleanTitle)) {
            return cleanTitle;
        }
    }

    return videoId || "未知视频";
};

const request = async (url, options = {}) => {
    try {
        logInfo("🌐 请求", url);
        const res = await axiosInstance.get(url, {
            headers: {
                "User-Agent": UA,
                "Referer": HOST,
                ...options.headers
            },
            timeout: 15000,
            ...options
        });
        return res.data;
    } catch (e) {
        logError("❌ 请求失败", e);
        return "";
    }
};

const requestPost = async (url, data, options = {}) => {
    try {
        logInfo("🌐 POST请求", url);
        const res = await axiosInstance.post(url, data, {
            headers: {
                "User-Agent": UA,
                "Referer": HOST,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                ...options.headers
            },
            timeout: 15000,
            ...options
        });
        return res.data;
    } catch (e) {
        logError("❌ POST请求失败", e);
        return null;
    }
};

const resolveExternalOcrCandidates = () => {
    const normalizedBase = EXTERNAL_OCR_API.replace(/\/$/, "");
    if (!normalizedBase) return [DEFAULT_OCR_API];
    const lower = normalizedBase.toLowerCase();
    const looksLikeFullEndpoint = /\/(ocr|slide|det)(\/|$)|\/json(\/|$)/.test(lower);
    if (looksLikeFullEndpoint) {
        return [...new Set([normalizedBase, DEFAULT_OCR_API].filter(Boolean))];
    }

    const hasExplicitPath = !!EXTERNAL_OCR_PATH;
    const inferredPaths = hasExplicitPath
        ? [EXTERNAL_OCR_PATH]
        : (OCR_API_KIND === "ddddocr" ? ["/ocr"] : ["/ocr/b64/json"]);
    const candidates = [];
    for (const path of inferredPaths) {
        const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
        candidates.push(`${normalizedBase}${normalizedPath}`);
    }
    candidates.push(normalizedBase, DEFAULT_OCR_API);
    return [...new Set(candidates.filter(Boolean))];
};

const hasVerifyOperator = (raw) => /[+\-xX×*/]/.test(String(raw || ""));

const normalizeVerifyText = (text) => String(text || "")
    .replace(/\s/g, "")
    .replace(/[=？?]+$/g, "")
    .replace(/[xX×]/g, "*")
    .replace(/[÷／]/g, "/")
    .replace(/[－﹣—–]/g, "-")
    .replace(/[十]/g, "+")
    .replace(/[oO。]/g, "0");

const shrinkNegativeSubtraction = (left, right) => {
    let currentRight = String(right || "");
    const leftNum = parseInt(left, 10);
    if (Number.isNaN(leftNum) || !currentRight) return null;

    while (currentRight.length > 0) {
        const rightNum = parseInt(currentRight, 10);
        if (!Number.isNaN(rightNum) && leftNum - rightNum >= 0) {
            return `${left}-${currentRight}`;
        }
        currentRight = currentRight.slice(0, -1);
    }

    return null;
};

const normalizeVerifyExpression = (text) => {
    let exp = normalizeVerifyText(text);
    if (!exp) return "";

    exp = exp.replace(/-7$/g, "");

    const firstExprMatch = exp.match(/^(\d+)([\+\-\*\/])(\d+)/);
    if (!firstExprMatch) return exp;

    const left = firstExprMatch[1];
    const op = firstExprMatch[2];
    let right = firstExprMatch[3];

    if (right.endsWith("7") && right.length > 1) {
        right = right.slice(0, -1);
    }
    if (right.length > 2) {
        right = right.slice(0, 2);
    }
    if (op === "-") {
        const nonNegativeExpr = shrinkNegativeSubtraction(left, right);
        if (nonNegativeExpr) return nonNegativeExpr;
    }

    return `${left}${op}${right}`;
};

const normalizePureDigitsVerifyExpr = (raw) => {
    let digits = normalizeVerifyText(raw).replace(/\D/g, "");
    if (!digits) return "";

    if (digits.length >= 3 && digits.endsWith("7")) {
        digits = digits.slice(0, -1);
    }

    if (digits.length === 4) {
        return shrinkNegativeSubtraction(digits.slice(0, 2), digits.slice(2)) || `${digits.slice(0, 2)}-${digits.slice(2)}`;
    }
    if (digits.length === 5) {
        return shrinkNegativeSubtraction(digits.slice(0, 2), digits.slice(-2)) || `${digits.slice(0, 2)}-${digits.slice(-2)}`;
    }
    return "";
};

const requestVerifyCodeByDefaultApi = async (b64) => {
    try {
        logInfo("🧾 OCR请求", { url: DEFAULT_OCR_API });
        const ocrRes = await axiosInstance.post(DEFAULT_OCR_API, b64, {
            headers: { "User-Agent": MOBILE_UA },
            timeout: 8000,
        });
        const data = ocrRes.data || {};
        const raw = String(
            data?.result
            || data?.data?.code
            || data?.data?.result
            || data?.data?.text
            || data?.data?.ocr_text
            || data?.code
            || data?.text
            || data?.ocr_text
            || ""
        ).trim();
        const normalizedRaw = normalizeVerifyExpression(raw);
        logInfo("🧾 OCR识别", { url: DEFAULT_OCR_API, raw });
        return normalizedRaw || raw;
    } catch (e) {
        logError(`⚠ OCR异常 @ ${DEFAULT_OCR_API}`, e);
        return "";
    }
};

const requestVerifyCodeByOcr = async (b64) => {
    const candidates = resolveExternalOcrCandidates();
    let lastError = null;
    let fallbackRaw = "";
    for (const url of candidates) {
        try {
            logInfo("🧾 OCR请求", { url });
            const lower = String(url || "").toLowerCase();
            const isDefaultApi = url === DEFAULT_OCR_API;
            const isDdddocrTextApi = /\/ocr(\/|$)/.test(lower) && !/\/b64\/json(\/|$)/.test(lower);
            const payload = isDefaultApi
                ? b64
                : (isDdddocrTextApi
                    ? { data: `data:image/png;base64,${b64}`, mode: 1, range: 7 }
                    : { image: b64, img: b64, base64: b64, data: `data:image/png;base64,${b64}` });
            const headers = { "User-Agent": MOBILE_UA };
            if (!isDefaultApi) headers["Content-Type"] = "application/json";
            const ocrRes = await axiosInstance.post(url, payload, { headers, timeout: 8000 });
            const data = ocrRes.data || {};
            const raw = String(
                data?.result
                || data?.data?.code
                || data?.data?.result
                || data?.data?.text
                || data?.data?.ocr_text
                || data?.code
                || data?.text
                || data?.ocr_text
                || ""
            ).trim().split("=")[0].trim();
            const normalizedRaw = normalizeVerifyExpression(raw);
            logInfo("🧾 OCR识别", { url, raw });
            if (!raw) continue;
            if (hasVerifyOperator(normalizedRaw)) return normalizedRaw;
            const normalizedExpr = normalizePureDigitsVerifyExpr(raw);
            if (normalizedExpr) {
                logInfo("🧮 纯数字验证码改写", { raw, normalizedExpr });
                return normalizedExpr;
            }
            if (isDefaultApi) {
                logInfo("⚠ 默认OCR结果不含运算符且无法改写，视为失败", { raw });
                fallbackRaw = raw;
                continue;
            }
            logInfo("⚠ OCR结果不含运算符且无法改写，尝试默认OCR兜底", { url, raw });
            const defaultRaw = await requestVerifyCodeByDefaultApi(b64);
            if (defaultRaw && hasVerifyOperator(defaultRaw)) return defaultRaw;
            const normalizedDefaultExpr = normalizePureDigitsVerifyExpr(defaultRaw);
            if (normalizedDefaultExpr) {
                logInfo("🧮 默认OCR纯数字改写", { raw: defaultRaw, normalizedExpr: normalizedDefaultExpr });
                return normalizedDefaultExpr;
            }
            fallbackRaw = defaultRaw || raw;
            break;
        } catch (e) {
            lastError = e;
            logError(`⚠ OCR异常 @ ${url}`, e);
        }
    }
    if (fallbackRaw && !hasVerifyOperator(fallbackRaw)) {
        return "";
    }
    if (lastError) throw lastError;
    return "";
};

const loadSessionCache = async () => {
    const now = Date.now();
    if (SESSION_CACHE.cookie && now < SESSION_CACHE.expire) {
        return SESSION_CACHE.cookie;
    }
    try {
        const cached = await OmniBox.getCache(SESSION_CACHE_KEY);
        if (!cached) return "";
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        const cookie = String(parsed?.cookie || "").trim();
        const expire = Number(parsed?.expire || 0);
        if (cookie && expire > now) {
            SESSION_CACHE.cookie = cookie;
            SESSION_CACHE.expire = expire;
            return cookie;
        }
    } catch (e) {
        logError("读取SDK会话缓存失败", e);
    }
    return "";
};

const saveSessionCache = async (cookie) => {
    const value = String(cookie || "").trim();
    if (!value) return;
    const expire = Date.now() + SESSION_TTL;
    SESSION_CACHE.cookie = value;
    SESSION_CACHE.expire = expire;
    try {
        await OmniBox.setCache(SESSION_CACHE_KEY, JSON.stringify({ cookie: value, expire }), Math.ceil(SESSION_TTL / 1000));
    } catch (e) {
        logError("写入SDK会话缓存失败", e);
    }
};

const clearSessionCache = async () => {
    SESSION_CACHE.cookie = null;
    SESSION_CACHE.expire = 0;
    try {
        await OmniBox.setCache(SESSION_CACHE_KEY, JSON.stringify({ cookie: "", expire: 0 }), 1);
    } catch (e) {
        logError("清理SDK会话缓存失败", e);
    }
};

/**
 * 通过API进行聚合搜索(验证码失败兜底)
 */
const aggregateApiSearch = async (keyword, pg) => {
    if (!keyword) return { list: [], page: pg, pagecount: pg };
    try {
        const searchUrl = `https://www.ymck.pro/API/v2.php?q=${encodeURIComponent(keyword)}&size=50`;
        const base64Data = await request(searchUrl);
        if (!base64Data) return { list: [], page: pg, pagecount: pg };

        let decodedStr = "";
        try {
            decodedStr = Buffer.from(String(base64Data).trim(), "base64").toString("utf8");
        } catch (e) {
            logError("聚合搜索Base64解码失败", e);
            return { list: [], page: pg, pagecount: pg };
        }

        let searchResults = [];
        try {
            searchResults = JSON.parse(decodedStr) || [];
        } catch (e) {
            logError("聚合搜索JSON解析失败", e);
            return { list: [], page: pg, pagecount: pg };
        }

        if (!Array.isArray(searchResults)) {
            logInfo("聚合搜索返回非数组");
            return { list: [], page: pg, pagecount: pg };
        }

        const targetSites = ["哔滴影视", "修罗", "修罗影视"];
        const list = [];

        for (const item of searchResults) {
            if (!item || typeof item !== "object") continue;
            const website = item.website || "";
            if (!targetSites.some((name) => website.includes(name))) continue;

            const url = item.url || "";
            if (!url) continue;

            let vodId = "";
            try {
                const u = new URL(url);
                vodId = parseMyuiId(u.pathname) || getId(u.pathname);
            } catch {
                vodId = parseMyuiId(url) || getId(url);
            }

            if (!vodId) continue;

            const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean).join(" ") : "";
            list.push({
                vod_id: vodId,
                vod_name: item.text || keyword,
                vod_pic: fixImg(item.icon || ""),
                vod_remarks: tags
            });
        }

        logInfo(`🧩 聚合搜索命中: ${list.length}条`);
        return { list, page: 1, pagecount: list.length, total: list.length};
    } catch (e) {
        logError("聚合搜索异常", e);
        return { list: [], page: pg, pagecount: pg };
    }
};

// ========== 筛选配置 ==========
// v1.1.0：key 对齐新站 typeId（1=电影 / 2=电视剧）
const filters = {
    "1": [
        { key: "genre", name: "类型", init: "all", value: [{ name: "不限", value: "all" }, { name: "动作", value: "dongzuo" }, { name: "爱情", value: "aiqing" }, { name: "喜剧", value: "xiju" }, { name: "科幻", value: "kehuan" }, { name: "恐怖", value: "kongbu" }, { name: "战争", value: "zhanzheng" }, { name: "武侠", value: "wuxia" }, { name: "魔幻", value: "mohuan" }, { name: "剧情", value: "juqing" }, { name: "动画", value: "donghua" }, { name: "惊悚", value: "jingsong" }, { name: "3D", value: "3D" }, { name: "灾难", value: "zainan" }, { name: "悬疑", value: "xuanyi" }, { name: "警匪", value: "jingfei" }, { name: "文艺", value: "wenyi" }, { name: "青春", value: "qingchun" }, { name: "冒险", value: "maoxian" }, { name: "犯罪", value: "fanzui" }, { name: "记录", value: "jilu" }, { name: "古装", value: "guzhuang" }, { name: "奇幻", value: "奇幻" }] },
        { key: "area", name: "地区", init: "", value: [{ name: "不限", value: "" }, { name: "中国大陆", value: "中国大陆" }, { name: "中国香港", value: "中国香港" }, { name: "美国", value: "美国" }, { name: "日本", value: "日本" }, { name: "韩国", value: "韩国" }, { name: "法国", value: "法国" }, { name: "印度", value: "印度" }, { name: "德国", value: "德国" }] },
        { key: "year", name: "年份", init: "", value: [{ name: "不限", value: "" }, { name: "2026", value: "2026" }, { name: "2025", value: "2025" }, { name: "2024", value: "2024" }, { name: "2023", value: "2023" }, { name: "2022", value: "2022" }] },
        { key: "order", name: "排序", init: "0", value: [{ name: "更新时间", value: "0" }, { name: "豆瓣评分", value: "1" }] }
    ],
    "2": [
        { key: "genre", name: "类型", init: "all", value: [{ name: "不限", value: "all" }, { name: "动作", value: "dongzuo" }, { name: "爱情", value: "aiqing" }, { name: "喜剧", value: "xiju" }, { name: "剧情", value: "juqing" }] },
        { key: "area", name: "地区", init: "", value: [{ name: "不限", value: "" }, { name: "中国大陆", value: "中国大陆" }, { name: "美国", value: "美国" }, { name: "韩国", value: "韩国" }] },
        { key: "year", name: "年份", init: "", value: [{ name: "不限", value: "" }, { name: "2026", value: "2026" }, { name: "2025", value: "2025" }] },
        { key: "order", name: "排序", init: "0", value: [{ name: "更新时间", value: "0" }, { name: "豆瓣评分", value: "1" }] }
    ]
};

// ========== 验证码计算 ==========
const calcVerifyCode = (text) => {
    if (!text) return null;

    const exp = normalizeVerifyExpression(text);
    const match = exp.match(/^(\d+)([\+\-\*\/])(\d+)$/);
    if (!match) return null;

    const a = parseInt(match[1], 10);
    const op = match[2];
    const b = parseInt(match[3], 10);

    switch (op) {
        case "+":
            return a + b;
        case "-":
            return a - b;
        case "*": {
            const result = a * b;
            return (a >= 10 && b >= 10) ? (a + b) : result;
        }
        case "/":
            if (!b) return null;
            return Math.floor(a / b);
        default:
            return null;
    }
};

// ========== 弹幕工具函数 ==========
const preprocessTitle = (title) => {
    if (!title) return "";
    return title
        .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
        .replace(/[hH]\\.?26[45]/g, " ")
        .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
        .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
};

const chineseToArabic = (cn) => {
    const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (!isNaN(cn)) return parseInt(cn, 10);
    if (cn.length === 1) return map[cn] || cn;
    if (cn.length === 2) {
        if (cn[0] === '十') return 10 + map[cn[1]];
        if (cn[1] === '十') return map[cn[0]] * 10;
    }
    if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
    return cn;
};

const extractEpisode = (title) => {
    if (!title) return "";
    const processedTitle = preprocessTitle(title).trim();

    const cnMatch = processedTitle.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
    if (cnMatch) return String(chineseToArabic(cnMatch[1]));

    const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
    if (seMatch) return seMatch[1];

    const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
    if (epMatch) return epMatch[1];

    const bracketMatch = processedTitle.match(/[\[\(【(](\d{1,3})[\]\)】)]/);
    if (bracketMatch) {
        const num = bracketMatch[1];
        if (!["720", "1080", "480"].includes(num)) return num;
    }

    return "";
};

const buildFileNameForDanmu = (vodName, episodeTitle) => {
    if (!vodName) return "";
    if (!episodeTitle || episodeTitle === "正片" || episodeTitle === "播放") {
        return vodName;
    }

    const digits = extractEpisode(episodeTitle);
    if (digits) {
        const epNum = parseInt(digits, 10);
        if (epNum > 0) {
            if (epNum < 10) return `${vodName} S01E0${epNum}`;
            return `${vodName} S01E${epNum}`;
        }
    }
    return vodName;
};

const buildScrapedEpisodeName = (scrapeData, mapping, originalName) => {
    if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < 0.5)) {
        return originalName;
    }
    if (mapping.episodeName) {
        const epName = mapping.episodeNumber + "." + mapping.episodeName;
        return epName;
    }
    if (scrapeData && Array.isArray(scrapeData.episodes)) {
        const hit = scrapeData.episodes.find(
            (ep) => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber
        );
        if (hit?.name) {
            return `${hit.episodeNumber}.${hit.name}`;
        }
    }
    return originalName;
};

const buildScrapedDanmuFileName = (scrapeData, scrapeType, mapping, fallbackVodName, fallbackEpisodeName) => {
    if (!scrapeData) {
        return buildFileNameForDanmu(fallbackVodName, fallbackEpisodeName);
    }
    if (scrapeType === "movie") {
        return scrapeData.title || fallbackVodName;
    }
    const title = scrapeData.title || fallbackVodName;
    const seasonAirYear = scrapeData.seasonAirYear || "";
    const seasonNumber = mapping?.seasonNumber || 1;
    const episodeNumber = mapping?.episodeNumber || 1;
    return `${title}.${seasonAirYear}.S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
};

/**
 * 嗅探播放页，兜底提取真实视频地址
 */
const sniffXluysPlay = async (playUrl) => {
    if (!playUrl) return null;
    try {
        logInfo("尝试嗅探播放页", playUrl);
        const sniffed = await OmniBox.sniffVideo(playUrl);
        if (sniffed && sniffed.url) {
            logInfo("嗅探成功", sniffed.url);
            return {
                urls: [{ name: "嗅探线路", url: sniffed.url }],
                parse: 0,
                header: sniffed.header || { "User-Agent": UA, "Referer": HOST }
            };
        }
    } catch (error) {
        logInfo(`嗅探失败: ${error.message}`);
    }
    return null;
};

const matchDanmu = async (fileName) => {
    if (!DANMU_API || !fileName) return [];

    try {
        logInfo(`💬 匹配弹幕: ${fileName}`);
        const matchUrl = `${DANMU_API}/api/v2/match`;
        const response = await OmniBox.request(matchUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            body: JSON.stringify({ fileName })
        });

        if (response.statusCode !== 200) {
            logInfo(`⚠ 弹幕匹配失败: HTTP ${response.statusCode}`);
            return [];
        }

        const matchData = JSON.parse(response.body);
        if (!matchData.isMatched) {
            logInfo("⚠ 弹幕未匹配到");
            return [];
        }

        const matches = matchData.matches || [];
        if (matches.length === 0) return [];

        const firstMatch = matches[0];
        const episodeId = firstMatch.episodeId;
        const animeTitle = firstMatch.animeTitle || "";
        const episodeTitle = firstMatch.episodeTitle || "";
        if (!episodeId) return [];

        let danmakuName = "弹幕";
        if (animeTitle && episodeTitle) {
            danmakuName = `${animeTitle} - ${episodeTitle}`;
        } else if (animeTitle) {
            danmakuName = animeTitle;
        } else if (episodeTitle) {
            danmakuName = episodeTitle;
        }

        const danmakuURL = `${DANMU_API}/api/v2/comment/${episodeId}?format=xml`;
        logInfo(`✅ 弹幕匹配成功: ${danmakuName}`);

        return [{
            name: danmakuName,
            url: danmakuURL
        }];
    } catch (e) {
        logError("⚠ 弹幕匹配异常", e);
        return [];
    }
};

// ========== 核心接口实现 ==========

async function home(params) {
    logInfo("🏠 进入首页");
    let list = [];

    try {
        const html = await request(HOST);
        if (!html) {
            logInfo("⚠ 首页HTML为空");
        } else {
            const $ = cheerio.load(html);
            list = parseMyuiCards($);
            // 去重：同一影片可能在多个板块重复出现
            const seen = new Set();
            list = list.filter(item => {
                if (seen.has(item.vod_id)) return false;
                seen.add(item.vod_id);
                return true;
            });
            logInfo(`✅ 首页解析到 ${list.length} 条数据`);
        }
    } catch (e) {
        logError("首页解析异常", e);
        list = [];
    }

    return {
        class: buildMyuiCategories(),
        filters: filters,
        list
    };
}

async function category(params) {
    logInfo(`📂 请求参数: ${JSON.stringify(params)}`);

    const pg = parseInt(params.page) || 1;
    const typeId = String(params.categoryId || "1");
    // v1.1.0：兼容传入「movie/tv」旧分类名 → 映射到新 typeId
    const typeMap = { movie: "1", tv: "2", zongyi: "3", duanju: "42" };
    const tid = typeMap[typeId] || typeId;

    // 新站分页：/list/?1.html 第一页，/list/?1-N.html 第 N 页
    const url = pg <= 1 ? `${HOST}/list/?${tid}.html` : `${HOST}/list/?${tid}-${pg}.html`;
    logInfo(`📂 请求分类: ${tid}, 页码: ${pg}, URL: ${url}`);

    try {
        const html = await request(url);
        if (!html) {
            logInfo("⚠ 返回HTML为空");
            return { list: [], page: pg, pagecount: pg };
        }
        const $ = cheerio.load(html);
        const list = parseMyuiCards($);
        const pagecount = extractPageCount($, pg);
        logInfo(`✅ 解析到 ${list.length} 条数据，共 ${pagecount} 页`);
        return { list, page: pg, pagecount };
    } catch (e) {
        logError("分类解析异常", e);
        return { list: [], page: pg, pagecount: pg };
    }
}

async function detail(params) {
    const videoId = params.videoId;
    logInfo(`📄 请求详情 ID: ${videoId}`);

    // v1.1.0：新站详情路径 /detail/?{id}.html，旧 /{id}.htm 已失效
    const plainId = String(videoId || "").split("|")[0];
    const detailUrl = `${HOST}/detail/?${plainId}.html`;
    const html = await request(detailUrl);
    if (!html) return { list: [] };

    const $ = cheerio.load(html);
    const playUrls = [];
    const vodName = extractDetailVodName($, videoId);

    // v1.1.0：新站剧集选择器 #playlist1 .myui-content__list li a，href=/video/?9443-0-0.html
    $("#playlist1 .myui-content__list li a, #playlist1 li a").each((_, item) => {
        const name = $(item).text().trim() || $(item).attr("title") || "";
        const href = $(item).attr("href");
        if (name && href) {
            const fullPlayId = parseMyuiId(href);
            if (!fullPlayId) return;
            logInfo(`🔗 找到剧集: ${name} -> ID: ${fullPlayId}`);
            playUrls.push(`${name}$${fullPlayId}`);
        }
    });

    // 转换为 OmniBox 播放源格式
    const videoIdForScrape = String(videoId || "");
    const scrapeCandidates = [];
    
    playUrls.forEach((item, index) => {
        const parts = item.split('$');
        const episodeName = parts[0] || '正片';
        scrapeCandidates.push({
            fid: `${videoIdForScrape}#0#${index}`,
            file_id: `${videoIdForScrape}#0#${index}`,
            file_name: episodeName,
            name: episodeName,
            format_type: "video"
        });
    });

    let scrapeData = null;
    let videoMappings = [];
    let scrapeType = "";

    if (scrapeCandidates.length > 0) {
        try {
            const scrapingResult = await OmniBox.processScraping(videoIdForScrape, vodName || "", vodName || "", scrapeCandidates);
            logInfo(`✅ 刮削处理完成`);

            const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
            scrapeData = metadata?.scrapeData || null;
            videoMappings = metadata?.videoMappings || [];
            scrapeType = metadata?.scrapeType || "";
            logInfo("刮削元数据读取完成", { hasScrapeData: !!scrapeData, mappingCount: videoMappings.length, scrapeType });
        } catch (error) {
            logError("刮削处理失败", error);
        }
    }

    const playSources = [{
        name: "修罗直连",
        episodes: playUrls.map((item, index) => {
            const parts = item.split('$');
            const episodeName = parts[0] || '正片';
            const playIdValue = parts[1] || parts[0];
            const fid = `${videoIdForScrape}#0#${index}`;
            
            // 应用刮削后的集数名称
            let finalEpisodeName = episodeName;
            const mapping = videoMappings.find((m) => m?.fileId === fid);
            if (mapping) {
                finalEpisodeName = buildScrapedEpisodeName(scrapeData, mapping, episodeName);
            }

            const combinedId = `${playIdValue}|||${encodeMeta({ sid: videoIdForScrape, fid, v: vodName || "", e: episodeName })}`;
            return {
                name: finalEpisodeName,
                playId: combinedId,
                _fid: fid,
                _rawName: episodeName,
                _seasonNumber: mapping?.seasonNumber,
                _episodeNumber: mapping?.episodeNumber
            };
        })
    }];

    // 按季度和集数排序
    const hasEpisodeNumber = playSources[0].episodes.some(
        (ep) => ep._episodeNumber !== undefined && ep._episodeNumber !== null
    );
    if (hasEpisodeNumber) {
        playSources[0].episodes.sort((a, b) => {
            const seasonA = a._seasonNumber || 0;
            const seasonB = b._seasonNumber || 0;
            if (seasonA !== seasonB) return seasonA - seasonB;
            const episodeA = a._episodeNumber || 0;
            const episodeB = b._episodeNumber || 0;
            return episodeA - episodeB;
        });
    }

    // v1.1.0：新站封面 .myui-content__thumb img[data-original]，简介为「剧情介绍」panel 内的 p
    const siteCover = fixImg($(".myui-content__thumb img").attr("data-original") || $(".myui-content__thumb img").attr("src") || "");
    let siteIntro = "";
    $(".myui-panel").each((_, panel) => {
        if ($(panel).find("h3.title").text().includes("剧情介绍")) {
            siteIntro = $(panel).find("p").first().text().replace(/\s+/g, " ").trim();
            return false;
        }
    });
    // 从 .data 里提取主演/年份/分类（刮削优先，站点兜底）
    const dataLines = $(".myui-content__detail p.data").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get();
    const dataBlob = dataLines.join(" ");
    const siteYear = (dataBlob.match(/年份[：:]\s*(\d{4})/) || [])[1] || "";
    const siteActor = (dataBlob.match(/主演[：:]\s*([^年更新导演]+?)(?:\.\.|$)/) || [])[1]?.trim() || "";

    const vod = {
        vod_id: videoId,
        vod_name: scrapeData?.title || vodName,
        vod_pic: scrapeData?.posterPath ? `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}` : siteCover,
        vod_content: scrapeData?.overview || siteIntro,
        vod_year: scrapeData?.releaseDate ? String(scrapeData.releaseDate).substring(0, 4) : siteYear,
        vod_actor: siteActor,
        vod_play_sources: playSources.map((source) => ({
            name: source.name,
            episodes: source.episodes.map((ep) => ({
                name: ep.name,
                playId: ep.playId
            }))
        }))
    };

    if (scrapeData) {
        if (scrapeData.releaseDate) {
            vod.vod_year = String(scrapeData.releaseDate).substring(0, 4);
        }
        const actors = (scrapeData.credits?.cast || []).slice(0, 5).map((c) => c?.name).filter(Boolean).join(",");
        if (actors) {
            vod.vod_actor = actors;
        }
        const directors = (scrapeData.credits?.crew || [])
            .filter((c) => c?.job === "Director" || c?.department === "Directing")
            .slice(0, 3)
            .map((c) => c?.name)
            .filter(Boolean)
            .join(",");
        if (directors) {
            vod.vod_director = directors;
        }
    }

    return { list: [vod] };
}

async function search(params) {
    const keyword = (params.keyword || params.wd || "").trim();
    const pg = parseInt(params.page) || 1;

    if (!keyword) {
        logInfo("⚠ 搜索关键词为空");
        return { list: [] };
    }

    // v1.1.0：新站搜索走 search.php + scheckAC POST 验证码流程
    const kw = encodeURIComponent(keyword);
    const searchPageUrl = `${HOST}/search.php?searchword=${kw}`;
    const browserHeaders = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1"
    };
    const isVerifyPage = (html) => /系统安全验证|scheckAC|vdimgck|validate/i.test(String(html || ""));

    const cachedCookie = await loadSessionCache();
    // 优先使用缓存会话
    if (cachedCookie) {
        logInfo("♻ 使用SDK缓存会话");
        try {
            const fastRes = await axiosInstance.get(searchPageUrl, {
                headers: { ...browserHeaders, "Cookie": cachedCookie, "Referer": searchPageUrl }
            });
            const fastHtml = fastRes.data || "";
            if (!isVerifyPage(fastHtml)) {
                const result = await parseSearch(fastHtml, pg, keyword);
                if (result.list.length > 0) {
                    logInfo("✅ SDK缓存会话有效");
                    return result;
                }
            }
            logInfo("⚠ SDK缓存失效，重新验证");
            await clearSessionCache();
        } catch (e) {
            logError("⚠ SDK缓存请求异常", e);
            await clearSessionCache();
        }
    }

    logInfo(`🔍 开始搜索: ${keyword}`);
    const MAX_FLOW_RETRY = 3;

    try {
        for (let flow = 1; flow <= MAX_FLOW_RETRY; flow++) {
            logInfo(`🔁 第 ${flow} 轮验证码流程`);

            // 初始化会话，拿 PHPSESSID
            const initRes = await axiosInstance.get(searchPageUrl, { headers: browserHeaders });
            const rawCookies = initRes.headers["set-cookie"] || [];
            const cookieStr = rawCookies.map(c => c.split(";")[0]).join("; ");
            const finalCookie = cookieStr;
            logInfo("🍪 新会话Cookie", { hasCookie: !!cookieStr });

            // 获取验证码图 /include/vdimgck.php + OCR
            let verifyCode = null;
            for (let i = 1; i <= 3; i++) {
                try {
                    logInfo(`🖼 获取验证码 第${i}次`);
                    const imgRes = await axiosInstance.get(
                        `${HOST}/include/vdimgck.php?t=${Date.now()}`,
                        {
                            headers: {
                                "User-Agent": UA,
                                "Cookie": finalCookie,
                                "Referer": searchPageUrl
                            },
                            responseType: "arraybuffer"
                        }
                    );
                    const b64 = Buffer.from(imgRes.data).toString("base64");
                    logInfo("🖼 验证码Base64", { preview: b64.slice(0, 120), length: b64.length });
                    const raw = await requestVerifyCodeByOcr(b64);
                    verifyCode = calcVerifyCode(raw);
                    if (verifyCode !== null) {
                        logInfo(`✅ 验证码计算结果: ${verifyCode}`);
                        break;
                    }
                } catch (e) {
                    logError("⚠ OCR异常", e);
                }
            }

            if (!verifyCode) {
                logInfo("❌ OCR失败，重新整轮流程");
                continue;
            }

            // 提交验证码：POST search.php?scheckAC=check...
            const submitUrl = `${HOST}/search.php?scheckAC=check&page=${pg}&searchtype=&order=&tid=&area=&year=&letter=&yuyan=&state=&money=&ver=&jq=`;
            logInfo("📡 提交搜索");
            const formBody = new URLSearchParams({ validate: String(verifyCode), searchword: keyword }).toString();
            const htmlRes = await axiosInstance.post(submitUrl, formBody, {
                headers: {
                    ...browserHeaders,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": finalCookie,
                    "Referer": searchPageUrl
                }
            });

            const html = htmlRes.data || "";
            if (isVerifyPage(html)) {
                logInfo("⚠ 仍是验证码页，重试");
                continue;
            }

            const result = await parseSearch(html, pg, keyword);
            if (result.list.length > 0) {
                await saveSessionCache(finalCookie);
                logInfo("💾 会话缓存成功(30分钟)");
                logInfo(`🎯 搜索成功: ${result.list.length}条`);
                return result;
            }
            logInfo("⚠ 无结果，重新整轮流程");
        }

        // 聚合搜索兜底
        try {
            const aggregateResult = await aggregateApiSearch(keyword, pg);
            if (aggregateResult.list.length > 0) {
                logInfo("✅ 聚合搜索命中");
                return aggregateResult;
            }
        } catch (e) {
            logError("聚合搜索异常", e);
        }

        logInfo("❌ 所有流程失败");
        return { list: [] };
    } catch (e) {
        logError("❌ 搜索异常", e);
        return { list: [] };
    }
}

async function parseSearch(html, pg, keyword = "") {
    if (!html) {
        logInfo("❌ 解析HTML为空");
        return { list: [] };
    }

    const $ = cheerio.load(html);
    const list = [];
    keyword = (keyword || "").trim();

    // v1.1.0：搜索结果也是 myui 卡片 .myui-vodlist__box
    list.push(...parseMyuiCards($));
    logInfo(`✅ 搜索解析到 ${list.length} 条`);

    const pagecount = extractPageCount($, pg);
    logInfo(`📄 分页识别: 当前=${pg} 最大=${pagecount}`);
    return { list, page: pg, pagecount, total: list.length };
}

async function play(params) {
    let playId = params.playId;
    logInfo(`🎬 准备解析: ${playId}`);

    let vodName = "";
    let episodeName = "";
    let playMeta = {};

    // 解析透传参数
    if (playId && playId.includes('|||')) {
        const [mainPlayId, metaB64] = playId.split('|||');
        playId = mainPlayId;
        playMeta = decodeMeta(metaB64 || "");
        vodName = playMeta.v || "";
        episodeName = playMeta.e || "";
        logInfo(`📌 透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    } else if (playId && playId.includes('|')) {
        // 兼容旧格式
        const parts = playId.split('|');
        playId = parts.shift() || "";
        vodName = parts.shift() || "";
        episodeName = parts.join('|') || "";
        logInfo(`📌 透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    }

    let scrapedDanmuFileName = "";
    try {
        const videoIdFromParam = params.vodId ? String(params.vodId) : "";
        const videoIdFromMeta = playMeta?.sid ? String(playMeta.sid) : "";
        const videoIdForScrape = videoIdFromParam || videoIdFromMeta;
        if (videoIdForScrape) {
            const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
            if (metadata && metadata.scrapeData) {
                const mapping = (metadata.videoMappings || []).find((m) => m?.fileId === playMeta?.fid);
                scrapedDanmuFileName = buildScrapedDanmuFileName(
                    metadata.scrapeData,
                    metadata.scrapeType || "",
                    mapping,
                    vodName,
                    episodeName
                );
                if (metadata.scrapeData.title) {
                    vodName = metadata.scrapeData.title;
                }
                if (mapping?.episodeName) {
                    episodeName = mapping.episodeName;
                }
            }
        }
    } catch (error) {
        logInfo(`读取刮削元数据失败: ${error.message}`);
    }

    try {
        // v1.1.0：新站播放页 /video/?{id}-{from}-{part}.html，明文 var now="...m3u8"
        const cleanId = String(playId || "").split("|")[0].split("|||")[0];
        const playPageUrl = `${HOST}/video/?${cleanId}.html`;
        const playPageHtml = await request(playPageUrl) || "";
        let playResponse;

        // 提取 var now="..."（可能带单引号）
        const nowMatch = playPageHtml.match(/var\s+now\s*=\s*["']([^"']+)["']/);
        let mediaUrl = nowMatch ? nowMatch[1] : "";
        if (mediaUrl) {
            mediaUrl = absoluteUrl(playPageUrl, mediaUrl);
            logInfo(`✅ 提取播放地址: ${mediaUrl}`);
            // master m3u8 展开第一个子流（无 AES，parse=0 直返）
            if (/\.m3u8([&#?]|$)/i.test(mediaUrl)) {
                mediaUrl = await resolveXlyM3u8(mediaUrl, playPageUrl);
            }
            playResponse = {
                urls: [{ name: "修罗线路", url: mediaUrl }],
                parse: 0,
                header: { "User-Agent": UA, "Referer": HOST }
            };
        } else {
            logInfo("❌ 未提取到 var now，尝试嗅探");
            const sniffResult = await sniffXluysPlay(playPageUrl);
            playResponse = sniffResult || { urls: [{ name: "嗅探", url: playPageUrl }], parse: 1 };
        }

        // 弹幕匹配
        if (DANMU_API && vodName) {
            const fileName = scrapedDanmuFileName || buildFileNameForDanmu(vodName, episodeName);
            logInfo(`💬 尝试匹配弹幕文件名: ${fileName}`);
            if (fileName) {
                const danmakuList = await matchDanmu(fileName);
                if (danmakuList.length > 0) {
                    playResponse.danmaku = danmakuList;
                    logInfo("✅ 已注入弹幕数据");
                }
            }
        } else if (!DANMU_API) {
            logInfo("ℹ DANMU_API 未配置，跳过弹幕匹配");
        }

        return playResponse;
    } catch (e) {
        logError("🔥 播放异常", e);
        const fallbackId = String(playId || "").split("|")[0].split("|||")[0];
        const fallbackUrl = `${HOST}/video/?${fallbackId}.html`;
        const fallbackSniff = await sniffXluysPlay(fallbackUrl);
        if (fallbackSniff) {
            return fallbackSniff;
        }
        return {
            urls: [{ name: "嗅探", url: fallbackUrl }],
            parse: 1
        };
    }
}

// ========== 导出模块 ==========
module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
