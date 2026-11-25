// @name 热播之家
// @author OmniBox
// @description 热播之家（rebozj.cc）：仅采集站内网盘资源（百度/夸克/UC/阿里/迅雷/天翼/115/123）。MacCMS 前台解析：详情页网盘 tab -> 播放页 player_aaaa.url 取分享链接 -> SDK 展开文件列表 -> 真实直链播放。统一变量：SITE_API / DRIVE_ORDER / DRIVE_TYPE_CONFIG / SOURCE_NAMES_CONFIG / PANCHECK_* / DANMU_API。刮削+弹幕+播放记录。
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/网盘/热播之家.js

/**
 * 热播之家 (rebozj.cc) —— 只取网盘资源
 *
 * 站点事实（实站实测 2026-11-26）：
 * - MacCMS/stui 前台：分类 /type/N.html、详情 /detail/N.html、搜索 /search/-------------.html?wd=K。
 * - 详情页含多个"网盘"tab（如 playlist9=UC网盘 / playlist10=夸克网盘 / playlist11=百度网盘），
 *   每个 tab 下是若干分集，链接 /play/{vid}-{sid}-{nid}.html。
 * - 播放页 <script> var player_aaaa={...,"url":"https://pan.baidu.com/s/xxx?pwd=yyy","from":"baidu",...}；
 *   url 即网盘分享链接，from 为网盘类型。
 * - 只处理网盘 tab，忽略站点在线播放线路。
 *
 * 环境变量（与仓库网盘脚本统一）：
 * - SITE_API            站点基址，默认 https://www.rebozj.cc
 * - SITE_TIMEOUT        单请求超时毫秒，默认 15000
 * - SITE_UA             自定义 UA
 * - DRIVE_ORDER         网盘线路优先级，如 "quark;uc;baidu;ali;tianyi;115;xunlei;123"
 * - DRIVE_TYPE_CONFIG   参与采集的网盘类型（分号分隔），默认 "baidu;quark;uc;ali;tianyi;115;xunlei;123"
 * - SOURCE_NAMES_CONFIG 源名称映射（可选，形如 "baidu=百度网盘;quark=夸克网盘"）
 * - PANCHECK_ENABLED    是否启用 PanCheck 校验（1/true 开启）
 * - PANCHECK_API        PanCheck 服务地址
 * - PANCHECK_PLATFORMS  参与校验的平台
 * - DANMU_API           弹幕服务（可选）
 */

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PREFIX = "[热播之家]";
const DEFAULT_SITE = "https://www.rebozj.cc";
const SITE = normalizeBase(process.env.SITE_API || DEFAULT_SITE);
const UA = process.env.SITE_UA
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT = Number(process.env.SITE_TIMEOUT || 15000);

const splitCfg = (s) => String(s || "").split(/[;,，]/).map(x => x.trim()).filter(Boolean);
const DRIVE_ORDER = splitCfg(process.env.DRIVE_ORDER || "quark;uc;baidu;ali;tianyi;115;xunlei;123").map(x => x.toLowerCase());
const DRIVE_TYPE_CONFIG = splitCfg(process.env.DRIVE_TYPE_CONFIG || "baidu;quark;uc;ali;tianyi;115;xunlei;123").map(x => x.toLowerCase());
const SOURCE_NAMES_CONFIG = (() => {
  const m = {};
  for (const pair of splitCfg(process.env.SOURCE_NAMES_CONFIG || "")) {
    const i = pair.indexOf("=");
    if (i > 0) m[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
  }
  return m;
})();
const PANCHECK_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.PANCHECK_ENABLED || ""));
const PANCHECK_API = String(process.env.PANCHECK_API || "").trim().replace(/\/+$/, "");
const PANCHECK_PLATFORMS = new Set(splitCfg(process.env.PANCHECK_PLATFORMS || "").map(x => x.toLowerCase()));
const DANMU_API = String(process.env.DANMU_API || "").trim().replace(/\/+$/, "");

// 已知网盘类型 -> 标准 key（用于统一排序/命名）
const DRIVE_KEY_MAP = {
  baidu: "baidu", "百度": "baidu", "百度网盘": "baidu",
  quark: "quark", "夸克": "quark", "夸克网盘": "quark",
  uc: "uc", "UC": "uc", "UC网盘": "uc",
  ali: "ali", aliyun: "ali", alipan: "ali", "阿里": "ali", "阿里云盘": "ali",
  tianyi: "tianyi", "天翼": "tianyi", "天翼云盘": "tianyi",
  "115": "115", xunlei: "xunlei", "迅雷": "xunlei", "123": "123", "123pan": "123",
};
const DRIVE_DEFAULT_NAMES = {
  baidu: "百度网盘", quark: "夸克网盘", uc: "UC网盘", ali: "阿里云盘",
  tianyi: "天翼云盘", "115": "115网盘", xunlei: "迅雷云盘", "123": "123云盘",
};
const VIDEO_EXT = [".mp4", ".mkv", ".avi", ".flv", ".mov", ".wmv", ".m3u8", ".ts", ".webm", ".m4v", ".rmvb", ".rm"];

function normalizeBase(s) {
  let v = String(s || "").trim();
  if (!v) return DEFAULT_SITE;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  return v.replace(/\/+$/, "");
}
function log(level, message) { try { OmniBox.log(level, `${PREFIX} ${message}`); } catch (_) {} }
function str(v) { return v == null ? "" : String(v); }
function absUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return SITE + (path.startsWith("/") ? path : "/" + path);
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function cleanText(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// ============ HTTP ============
// 宿主沙箱可能禁用原生 http/https，优先用 SDK 的 OmniBox.request（返回 {statusCode, body}），
// 本地无该能力时回退原生 http/https。两条链路都做 gzip 容错解压。
function decodeBody(buf, encoding) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ""));
  try {
    const enc = String(encoding || "").toLowerCase();
    if (enc === "gzip") b = zlib.gunzipSync(b);
    else if (enc === "deflate") b = zlib.inflateSync(b);
  } catch (_) {}
  return b.toString("utf-8");
}
function sdkGet(urlStr, headers) {
  return Promise.resolve().then(async () => {
    if (typeof OmniBox.request !== "function") return null;
    const res = await OmniBox.request(urlStr, { method: "GET", headers, timeout: TIMEOUT });
    if (!res) return null;
    // 兼容三种返回：{statusCode,body} / {status,body} / 直接字符串 body
    if (typeof res === "string" || Buffer.isBuffer(res)) return { status: 200, body: decodeBody(res), headers: {} };
    const status = Number(res.statusCode || res.status || 200);
    const bodyRaw = "body" in res ? res.body : (res.data ?? res.text ?? "");
    const body = decodeBody(bodyRaw, res.headers && (res.headers["content-encoding"] || res.headers["Content-Encoding"]));
    return { status, body, headers: res.headers || {} };
  });
}
function httpGet(urlStr, headers = {}, redirect = 0) {
  return sdkGet(urlStr, headers).then((sdkRes) => { if (sdkRes) return sdkRes; return httpGetNative(urlStr, headers, redirect); });
}
function httpGetNative(urlStr, headers = {}, redirect = 0) {
  return new Promise((resolve, reject) => {
    if (redirect > 5) return reject(new Error("重定向过多"));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const client = u.protocol === "https:" ? https : http;
    const req = client.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "GET", timeout: TIMEOUT, rejectUnauthorized: false,
      headers: Object.assign({
        "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9", "Accept-Encoding": "gzip, deflate", "Referer": SITE + "/",
      }, headers),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, u.href).href, headers, redirect + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        try {
          if (res.headers["content-encoding"] === "gzip") buf = zlib.gunzipSync(buf);
          else if (res.headers["content-encoding"] === "deflate") buf = zlib.inflateSync(buf);
        } catch (_) {}
        resolve({ status: res.statusCode, body: buf.toString("utf-8"), headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    req.end();
  });
}
async function fetchHtml(url, headers = {}) {
  const res = await httpGet(url, headers);
  if (res.status < 200 || res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.body;
}

// ============ 列表解析（home/category/search 共用）============
function parseList(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href="([^"]*(?:\/detail\/|\/vod\/)[^\"]*?\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const id = (href.match(/\/(\d+)\.html/) || [])[1];
    if (!id || seen.has(id)) continue;
    const attrs = m[0].slice(0, m[0].indexOf(">"));
    const block = m[2];
    // 标题优先取 <a title>（最干净），其次卡片下方 <h>，最后才退回锚文本
    const titleAttr = (attrs.match(/title="([^"]+)"/i) || [])[1];
    const name = cleanText(titleAttr || (block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1] || block)
      .replace(/^\s*\[[^\]]*\]\s*/, "");
    if (!name || /^[\d.]+$/.test(name)) continue;
    const picRaw = (attrs.match(/data-original="([^"]+)"/i) || attrs.match(/data-src="([^"]+)"/i)
      || block.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || "";
    const pic = absUrl(decodeEntities(picRaw));
    const remarks = cleanText((block.match(/class="[^"]*pic-text[^"]*"[^>]*>([\s\S]*?)</i)
      || block.match(/class="[^"]*vod_remarks[^"]*"[^>]*>([\s\S]*?)</i) || [])[1] || "");
    seen.add(id);
    out.push({ vod_id: id, vod_name: name, vod_pic: absUrl(pic), vod_remarks: remarks });
  }
  return out;
}

function parseCategories(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*href="\/type\/(\d+)\.html"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1], name = cleanText(m[2]);
    if (!name || seen.has(id)) continue;
    seen.add(id);
    out.push({ type_id: id, type_name: name });
  }
  return out;
}

// ============ 详情网盘 tab 解析 ============
// 返回 [{ name, sid, episodes:[{nid,label}] }]
function parsePanTabs(html) {
  const tabs = [];
  // tab 标签：<a href="#playlistN">UC网盘</a>
  const tabRe = /<a[^>]*href="#(playlist\d+)"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
  let m;
  const map = new Map();
  while ((m = tabRe.exec(html))) {
    const pid = m[1], pname = cleanText(m[2]);
    if (!isPanLineName(pname)) continue;
    map.set(pid, pname);
  }
  for (const [pid, pname] of map) {
    // 对应内容块：<div id="playlistN" ...> ... <a href="/play/vid-sid-nid.html">标签</a>
    const start = html.indexOf(`id="${pid}"`);
    if (start < 0) continue;
    // 只截到本 tab 的 </ul>，避免把后续 tab 的分集串进来
    const ulEnd = html.indexOf("</ul>", start);
    const seg = html.slice(start, ulEnd > start ? ulEnd + 5 : start + 4000);
    const eps = [];
    const epRe = /<a[^>]*href="([^"]*\/play\/(\d+)-(\d+)-(\d+)\.html)"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
    let e;
    while ((e = epRe.exec(seg))) {
      eps.push({ vid: e[2], sid: Number(e[3]), nid: Number(e[4]), label: cleanText(e[5]) || "合集" });
    }
    if (eps.length) tabs.push({ name: pname, pid, episodes: eps });
  }
  return tabs;
}
function isPanLineName(name) {
  const n = String(name || "");
  return /网盘|百度|夸克|UC|阿里|迅雷|天翼|115|123/i.test(n);
}
function driveKeyOf(name) {
  const n = String(name || "");
  for (const [k, v] of Object.entries(DRIVE_KEY_MAP)) if (n.toLowerCase() === k.toLowerCase()) return v;
  for (const [k, v] of Object.entries(DRIVE_KEY_MAP)) if (n.toLowerCase().includes(k.toLowerCase())) return v;
  return "";
}

// 从播放页 player_aaaa 提取分享链接与类型
async function extractShareInfo(playUrl) {
  const html = await fetchHtml(playUrl, { Referer: SITE + "/" });
  const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
  if (!m) return null;
  let data;
  try {
    const clean = m[1]
      .replace(/\\"/g, "\u0001").replace(/"/g, '"').replace(/\u0001/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, "/");
    data = JSON.parse(clean);
  } catch (e) { log("error", `player_aaaa 解析失败 ${playUrl}: ${e.message}`); return null; }
  const url = str(data.url).replace(/^push:\/*/, "");
  const from = str(data.from);
  const key = driveKeyOf(from) || driveKeyOf(url);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { url, from, key, note: str(data.note) };
}

function isVideoFile(file) {
  if (!file || typeof file !== "object") return false;
  const name = str(file.file_name || file.name).toLowerCase();
  if (VIDEO_EXT.some(ext => name.endsWith(ext))) return true;
  const ft = str(file.format_type).toLowerCase();
  return ft.includes("video") || ft.includes("mpeg") || ft.includes("h264");
}
function fileId(file) { return str(file?.fid || file?.file_id); }
function fileName(file) { return str(file?.file_name || file?.name || "未命名"); }

async function getAllVideoFiles(shareURL, files, depth = 0) {
  const out = [];
  if (depth > 6 || !Array.isArray(files)) return out;
  for (const f of files) {
    if (isVideoFile(f)) out.push(f);
    else if (f.dir || f.is_dir) {
      const id = fileId(f);
      if (!id) continue;
      try {
        const sub = await OmniBox.getDriveFileList(shareURL, id);
        const subFiles = Array.isArray(sub?.files) ? sub.files : [];
        out.push(...await getAllVideoFiles(shareURL, subFiles, depth + 1));
      } catch (e) { log("info", `子目录展开失败 ${fileName(f)}: ${e.message}`); }
    }
  }
  return out;
}

async function loadPanFiles(shareURL) {
  if (!shareURL) return null;
  try {
    const driveInfo = await OmniBox.getDriveInfoByShareURL(shareURL);
    const list = await OmniBox.getDriveFileList(shareURL, "0");
    const files = Array.isArray(list?.files) ? list.files : [];
    const videos = await getAllVideoFiles(shareURL, files);
    return { driveInfo, videos };
  } catch (e) { log("info", `网盘文件读取失败: ${e.message}`); return null; }
}

// ============ 缓存 ============
const mem = new Map();
function memGet(key, ttl) { const v = mem.get(key); if (v && Date.now() - v.t < ttl) return v.d; return null; }
function memSet(key, d) { mem.set(key, { t: Date.now(), d }); }
async function cacheGet(k, sub) { try { const v = await OmniBox.getCache(`${PREFIX}:${k}:${sub}`); return typeof v === "string" ? JSON.parse(v) : v; } catch (_) { return null; } }
async function cacheSet(k, sub, d, ttl) { try { await OmniBox.setCache(`${PREFIX}:${k}:${sub}`, JSON.stringify(d), ttl); } catch (_) {} }

// ============ PanCheck（可选，按统一变量）============
function shouldPanCheck(key) {
  if (!PANCHECK_ENABLED || !PANCHECK_API) return false; // 未配置：直接放行
  if (PANCHECK_PLATFORMS.size && !PANCHECK_PLATFORMS.has(key)) return false; // 不在校验名单：放行
  return true;
}
async function runPanCheck(url) {
  try {
    const body = JSON.stringify({ url });
    const ctrl = new URL(PANCHECK_API);
    const client = ctrl.protocol === "https:" ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = client.request({
        protocol: ctrl.protocol, hostname: ctrl.hostname, port: ctrl.port || (ctrl.protocol === "https:" ? 443 : 80),
        path: ctrl.pathname + ctrl.search, method: "POST", timeout: TIMEOUT, rejectUnauthorized: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": UA },
      }, (r) => { const c = []; r.on("data", x => c.push(x)); r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString("utf-8") })); });
      req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("PanCheck 超时")); });
      req.write(body); req.end();
    });
    const j = JSON.parse(res.body);
    return j && (j.ok === true || j.valid === true || j.status === 200);
  } catch (e) { log("info", `PanCheck 异常: ${e.message}`); return false; }
}

// ============ 线路排序（DRIVE_ORDER）============
function sortSources(sources) {
  if (DRIVE_ORDER.length <= 1) return sources;
  const idx = new Map(DRIVE_ORDER.map((k, i) => [k, i]));
  return sources.slice().sort((a, b) => {
    const ia = idx.has(a.key) ? idx.get(a.key) : 999;
    const ib = idx.has(b.key) ? idx.get(b.key) : 999;
    return ia - ib;
  });
}
function driveName(key, fallback) {
  return SOURCE_NAMES_CONFIG[key] || DRIVE_DEFAULT_NAMES[key] || fallback || key || "网盘";
}

// ============ 五方法 ============
async function home(params, context) {
  log("info", `home 入口 from=${(context && context.from) || "web"}`);
  try {
    const html = await fetchHtml(SITE + "/");
    const classes = parseCategories(html).slice(0, 20);
    let list = memGet("home:list", 5 * 60 * 1000);
    if (!list) {
      const cached = await cacheGet("home", "p1");
      if (cached && cached.length) list = cached;
    }
    if (!list) {
      list = parseList(html).slice(0, 40);
      if (list.length) { memSet("home:list", list); await cacheSet("home", "p1", list, 300); }
    }
    log("info", `home 返回 class=${classes.length} list=${list.length}`);
    return { class: classes, list };
  } catch (e) { log("error", `home 失败: ${e.message}`); return { class: [], list: [] }; }
}

async function category(params, context) {
  const id = str((params && (params.categoryId ?? params.t ?? params.id)) || "");
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log("info", `category 入口 id=${id} page=${page}`);
  if (!id) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const url = page <= 1 ? `${SITE}/type/${id}.html` : `${SITE}/type/${id}-${page}.html`;
    const html = await fetchHtml(url);
    const list = parseList(html);
    log("info", `category 返回 id=${id} page=${page} list=${list.length}`);
    return { page, pagecount: list.length >= 20 ? page + 1 : page, total: list.length, list };
  } catch (e) { log("error", `category 失败: ${e.message}`); return { page, pagecount: 0, total: 0, list: [] }; }
}

async function search(params, context) {
  const kw = str((params && (params.keyword ?? params.kw ?? params.wd)) || "").trim();
  log("info", `search 入口 kw=${kw}`);
  if (!kw) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const url = `${SITE}/search/-------------.html?wd=${encodeURIComponent(kw)}`;
    const html = await fetchHtml(url);
    const list = parseList(html);
    log("info", `search 返回 kw=${kw} list=${list.length}`);
    return { page: 1, pagecount: 1, total: list.length, list };
  } catch (e) { log("error", `search 失败: ${e.message}`); return { page: 1, pagecount: 0, total: 0, list: [] }; }
}

async function detail(params, context) {
  const vid = str((params && (params.videoId ?? params.id)) || "").trim();
  log("info", `detail 入口 vid=${vid}`);
  if (!vid) return { vod_id: vid, vod_name: "", vod_play_sources: [] };
  try {
    const cacheKey = `detail:${vid}`;
    let built = memGet(cacheKey, 10 * 60 * 1000);
    if (!built) {
      const cached = await cacheGet("detail", vid);
      if (cached && Array.isArray(cached.sources)) built = cached;
    }
    if (!built) {
      const html = await fetchHtml(`${SITE}/detail/${vid}.html`);
      const title = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
        || (html.match(/<title>([^<]*)/i) || [])[1] || "").split(/[-_]/)[0].trim();
      const picRaw = (html.match(/class="[^"]*vod_pic[^"]*"[^>]*>\s*<img[^>]+src="([^"]+)"/i)
        || html.match(/<img[^>]+class="[^"]*thumb[^"]*"[^>]+src="([^"]+)"/i) || [])[1] || "";
      const pic = absUrl(decodeEntities(picRaw));
      const desc = cleanText((html.match(/class="[^"]*vod_content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
      const tabs = parsePanTabs(html);
      log("info", `detail vid=${vid} 网盘tab=${tabs.length} 名称=${title}`);
      const buckets = new Map();
      for (const tab of tabs) {
        for (const ep of tab.episodes) {
          const playUrl = absUrl(`/play/${ep.vid}-${ep.sid}-${ep.nid}.html`);
          let info;
          try { info = await extractShareInfo(playUrl); } catch (e) { log("info", `播放页读取失败 ${playUrl}: ${e.message}`); continue; }
          if (!info || !info.key || !DRIVE_TYPE_CONFIG.includes(info.key)) continue;
          if (shouldPanCheck(info.key) && !await runPanCheck(info.url)) { log("info", `PanCheck 未通过，跳过 ${info.key}`); continue; }
          const loaded = await loadPanFiles(info.url);
          if (!loaded || !loaded.videos.length) { log("info", `无视频文件，跳过 ${info.key}: ${info.url}`); continue; }
          if (!buckets.has(info.key)) buckets.set(info.key, { key: info.key, name: driveName(info.key, tab.name), videos: [] });
          for (const v of loaded.videos) {
            const fid = fileId(v);
            if (!fid) continue;
            buckets.get(info.key).videos.push({ name: fileName(v), fid, shareURL: info.url });
          }
        }
      }
      const sources = sortSources([...buckets.values()].filter(b => b.videos.length).map(b => ({
        key: b.key, name: b.name,
        episodes: b.videos.map(v => ({ name: v.name, playId: `${v.shareURL}|||${v.fid}` })),
      })));
      built = { title, pic, desc, sources };
      if (sources.length) { memSet(cacheKey, built); await cacheSet("detail", vid, built, 1800); }
    }
    log("info", `detail 返回 vid=${vid} 线路=${built.sources.length} 集数=${built.sources.reduce((n, s) => n + s.episodes.length, 0)}`);
    return {
      vod_id: vid, vod_name: built.title, vod_pic: built.pic, vod_content: built.desc,
      vod_play_sources: built.sources.map(s => ({ name: s.name, episodes: s.episodes.map(e => ({ name: e.name, playId: e.playId })) })),
    };
  } catch (e) { log("error", `detail 失败: ${e.message}`); return { vod_id: vid, vod_name: "", vod_play_sources: [] }; }
}

async function play(params, context) {
  const raw = str((params && (params.playId ?? params.url ?? params.id)) || "");
  log("info", `play 入口 from=${(context && context.from) || "web"} playId=${raw.slice(0, 120)}`);
  try {
    const [shareURL, fid] = raw.split("|||");
    if (!shareURL || !fid) return { urls: [], parse: 0 };
    // 主链路：SDK 取网盘文件真实播放地址
    let playInfo = null;
    try { playInfo = await OmniBox.getDriveVideoPlayInfo(shareURL, fid); } catch (e) { log("info", `getDriveVideoPlayInfo 失败: ${e.message}`); }
    const url = str(playInfo?.url || playInfo?.play_url || playInfo?.download_url || "");
    if (url) {
      log("info", `play 命中直链 ${url.slice(0, 120)}`);
      // 播放记录（异步，不阻塞）
      try { OmniBox.addPlayHistory && OmniBox.addPlayHistory({ vod_id: str(params?.vodId || ""), playId: raw }).catch(() => {}); } catch (_) {}
      return { urls: [{ name: "网盘资源", url }], parse: 0, header: { Referer: new URL(shareURL).origin + "/" } };
    }
    // 兜底：分享页 URL 交播放器嗅探
    log("info", "play 直链不可用，回退分享页 parse=1");
    return { urls: [{ name: "网盘资源", url: shareURL }], parse: 1, header: { Referer: new URL(shareURL).origin + "/" } };
  } catch (e) { log("error", `play 失败: ${e.message}`); return { urls: [], parse: 0 }; }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
