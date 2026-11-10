// @name 黄果短剧
// @author 宝宝巴士
// @description 黄果短剧（huangguoai.com）：分类/搜索/详情/播放；播放走 POST /api/videos/{id}/episodes/{ep}/playback 直取 m3u8 直链
// @version 1.1.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/短剧/黄果短剧.js

const OmniBox = require("omnibox_sdk");

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

// 站点主域名（GET /api/* 与播放 POST 都直连这里）
const ORIGIN = String(process.env.HUANGGUO_HOST || "https://huangguoai.com").replace(/\/+$/, "");
// Cloudflare Worker 反代（只作为列表/详情/搜索的兜底，POST 播放接口不支持）
const PROXY = String(process.env.HUANGGUO_PROXY_HOST || "https://little-waterfall-ea20.sjzkn886.workers.dev/proxy").replace(/\/+$/, "");
const PIC = "https://little-waterfall-ea20.sjzkn886.workers.dev/img?u=";
const UA = "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const CATEGORIES = [
  { type_id: "newest", type_name: "最近上新", mode: "list", sort: "new" },
  { type_id: "recommend", type_name: "精选推荐", mode: "list", sort: "hot" },
  { type_id: "ai-duanju", type_name: "AI成人短剧", mode: "category", slug: "ai-duanju" },
  { type_id: "ai-manju", type_name: "AI成人漫剧", mode: "category", slug: "ai-manju" },
  { type_id: "ai-huanlian", type_name: "AI换脸", mode: "category", slug: "ai-huanlian" },
  { type_id: "ai-mogai", type_name: "AI魔改", mode: "category", slug: "ai-mogai" },
];

const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Referer": ORIGIN + "/",
};

function log(level, msg) {
  try {
    OmniBox.log(level, `[huangguo] ${msg}`);
  } catch (_) {
    console.log(`[${level}] [huangguo] ${msg}`);
  }
}

function asText(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  try {
    if (typeof res.body === "string") return res.body;
    if (typeof res.content === "string") return res.content;
    if (typeof res.data === "string") return res.data;
    if (res.body && typeof res.body === "object") return JSON.stringify(res.body);
    return JSON.stringify(res);
  } catch (_) {
    return "";
  }
}

async function rawRequest(url, options) {
  const opts = {
    method: options.method || "GET",
    headers: Object.assign({}, HEADERS, options.headers || {}),
  };
  if (options.body !== undefined && options.body !== null) {
    opts.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  const res = await OmniBox.request(url, opts);
  return {
    statusCode: (res && (res.statusCode || res.status)) || 0,
    body: asText(res),
  };
}

function parseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  if (!t) return null;
  if (t.charAt(0) !== "{") {
    const i = t.indexOf("{");
    if (i < 0) return null;
    t = t.slice(i);
  }
  try {
    return JSON.parse(t);
  } catch (_) {
    return null;
  }
}

// /api/xxx -> 依次尝试：直连站点、Worker 反代（去掉 /api 前缀）
function candidateUrls(apiPath) {
  const urls = [ORIGIN + apiPath];
  const proxied = apiPath.replace(/^\/api/, "");
  if (PROXY) urls.push(PROXY + proxied);
  return urls;
}

async function requestJson(apiPath, options = {}) {
  const urls = options.onlyOrigin ? [ORIGIN + apiPath] : candidateUrls(apiPath);
  let lastErr = "";
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const res = await rawRequest(url, options);
      const json = parseJson(res.body);
      if (res.statusCode >= 200 && res.statusCode < 300 && json) {
        return json;
      }
      lastErr = `status=${res.statusCode} body=${String(res.body || "").slice(0, 120)}`;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    log("error", `${options.method || "GET"} ${url} 失败：${lastErr}`);
  }
  return null;
}

function proxyPic(url) {
  if (!url) return "";
  let u = String(url).trim();
  if (!u) return "";
  if (u.indexOf("//") === 0) u = "https:" + u;
  if (u.indexOf("/img?u=") >= 0) return u;
  return PIC + encodeURIComponent(u);
}

function pickItems(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  const data = json.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data.videos)) return data.videos;
  }
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.list)) return json.list;
  return [];
}

function pickPages(json, fallbackLength, size) {
  const data = json && json.data;
  const pagination = (data && data.pagination) || (json && json.pagination) || null;
  if (pagination && Number(pagination.pages) > 0) return Number(pagination.pages);
  if (pagination && Number(pagination.total) > 0) {
    return Math.max(1, Math.ceil(Number(pagination.total) / (Number(pagination.size) || size || 24)));
  }
  return fallbackLength >= (size || 24) ? 2 : 1;
}

function mapItem(it) {
  if (!it || it.id == null) return null;
  const ep = parseInt(it.episode_count || it.total_episodes || 1, 10) || 1;
  const year = String(it.created_at || "").slice(0, 4);
  const out = {
    vod_id: String(it.id),
    vod_name: String(it.title || "未命名").trim(),
    vod_pic: proxyPic(it.cover || ""),
    vod_remarks: ep > 1 ? `全${ep}集` : "全集",
    type_name: "短剧",
  };
  if (year) out.vod_year = year;
  if (it.score) out.vod_douban_score = String(it.score);
  if (Array.isArray(it.tags) && it.tags.length) out.vod_class = it.tags.join(",");
  return out;
}

function mapList(json) {
  const arr = pickItems(json);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const m = mapItem(arr[i]);
    if (m) out.push(m);
  }
  return out;
}

// playId: "视频ID@集数"；同时兼容旧格式 ".../videos/12/play?ep=3"
function encodePlayId(videoId, ep) {
  return `${videoId}@${ep}`;
}

function parsePlayId(playId) {
  const raw = String(playId == null ? "" : playId).trim();
  if (!raw) return null;
  let m = raw.match(/^(\d+)@(\d+)$/);
  if (m) return { videoId: m[1], ep: parseInt(m[2], 10) || 1 };
  m = raw.match(/\/videos\/(\d+)\/play\?ep=(\d+)/);
  if (m) return { videoId: m[1], ep: parseInt(m[2], 10) || 1 };
  m = raw.match(/\/video\/(\d+)(?:\/ep-(\d+))?/);
  if (m) return { videoId: m[1], ep: parseInt(m[2] || "1", 10) || 1 };
  m = raw.match(/^(\d+)[:：|_*](\d+)$/);
  if (m) return { videoId: m[1], ep: parseInt(m[2], 10) || 1 };
  if (/^\d+$/.test(raw)) return { videoId: raw, ep: 1 };
  return null;
}

function buildEpisodes(id, data) {
  const src = Array.isArray(data && data.episodes) ? data.episodes : [];
  const total = src.length
    ? src.length
    : (parseInt((data && (data.episode_count || data.total_episodes)) || 1, 10) || 1);
  const episodes = [];
  const playUrls = [];
  if (src.length) {
    const sorted = src.slice().sort((a, b) => (Number(a.ep_num) || 0) - (Number(b.ep_num) || 0));
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      const ep = parseInt(it.ep_num, 10) || (i + 1);
      const name = `第${ep}集`;
      const sec = parseInt(it.duration, 10) || 0;
      episodes.push({
        name,
        playId: encodePlayId(id, ep),
        episodeName: name,
        // 站点 duration 单位是秒，宿主 episodeRuntime 期望分钟
        episodeRuntime: sec > 0 ? Math.max(1, Math.round(sec / 60)) : undefined,
      });
      playUrls.push(`${name}$${ORIGIN}/video/${id}/${ep > 1 ? `ep-${ep}/` : ""}`);
    }
  } else {
    for (let ep = 1; ep <= total; ep++) {
      const name = `第${ep}集`;
      episodes.push({ name, playId: encodePlayId(id, ep), episodeName: name });
      playUrls.push(`${name}$${ORIGIN}/video/${id}/${ep > 1 ? `ep-${ep}/` : ""}`);
    }
  }
  return { total, episodes, playUrls };
}

async function cacheGet(key) {
  try {
    if (OmniBox && typeof OmniBox.getCache === "function") {
      const v = await OmniBox.getCache(key);
      if (v) return typeof v === "string" ? parseJson(v) : v;
    }
  } catch (_) {}
  return null;
}

async function cacheSet(key, value, ttl) {
  try {
    if (OmniBox && typeof OmniBox.setCache === "function") {
      await OmniBox.setCache(key, value, ttl);
    }
  } catch (_) {}
}

async function fetchDetail(id) {
  const key = `huangguo:detail:${id}`;
  const cached = await cacheGet(key);
  if (cached && cached.id != null) return cached;
  const json = await requestJson(`/api/videos/${encodeURIComponent(id)}`);
  const data = json && (json.data || json);
  if (!data || data.id == null) return null;
  await cacheSet(key, data, 600);
  return data;
}

async function home(params, context) {
  log("info", `[home] params=${JSON.stringify(params || {})}`);
  const classes = CATEGORIES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const json = await requestJson("/api/videos?sort=hot&page=1&size=24");
    list = mapList(json);
    log("info", `[home] 返回 ${list.length} 条`);
  } catch (e) {
    log("error", `[home] 异常：${e && e.message}`);
  }
  return { class: classes, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const page = Math.max(1, parseInt((params && params.page) || "1", 10) || 1);
  const tid = String((params && (params.categoryId || params.type_id || params.id)) || "recommend");
  let cat = CATEGORIES[1];
  for (let i = 0; i < CATEGORIES.length; i++) {
    if (String(CATEGORIES[i].type_id) === tid) {
      cat = CATEGORIES[i];
      break;
    }
  }
  log("info", `[category] tid=${tid} page=${page}`);
  let list = [];
  let pages = 1;
  try {
    const path = cat.mode === "list"
      ? `/api/videos?sort=${cat.sort}&page=${page}&size=24`
      : `/api/videos/category/${cat.slug}?sort=hot&page=${page}&size=24`;
    const json = await requestJson(path);
    list = mapList(json);
    pages = pickPages(json, list.length, 24);
    log("info", `[category] url=${path} 返回 ${list.length} 条 pages=${pages}`);
  } catch (e) {
    log("error", `[category] 异常：${e && e.message}`);
  }
  return { page, pagecount: pages, limit: 24, total: pages * 24, list, parse: 0, jx: 0 };
}

async function detail(params, context) {
  const ids = [];
  const raw = (params && (params.videoId || params.vod_id || params.id || params.ids)) || "";
  if (Array.isArray(raw)) {
    raw.forEach((v) => ids.push(String(v)));
  } else if (raw) {
    String(raw).split(",").forEach((v) => {
      const t = v.trim();
      if (t) ids.push(t);
    });
  }
  if (!ids.length) return { list: [] };
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const data = await fetchDetail(id);
      if (!data) {
        log("error", `[detail] id=${id} 详情为空`);
        continue;
      }
      const { total, episodes, playUrls } = buildEpisodes(id, data);
      const playUrl = `${ORIGIN}/video/${id}/`;
      log("info", `[detail] id=${id} name=${data.title || ""} ep=${total} episodes=${episodes.length}`);
      out.push({
        vod_id: String(data.id || id),
        vod_name: String(data.title || `短剧${id}`).trim(),
        vod_pic: proxyPic(data.cover || ""),
        type_name: (data.breadcrumb && data.breadcrumb[0] && data.breadcrumb[0].name) || "短剧",
        vod_remarks: total > 1 ? `全${total}集` : "全集",
        vod_year: String(data.created_at || "").slice(0, 4) || undefined,
        vod_area: "中国",
        vod_lang: "国语",
        vod_class: Array.isArray(data.tags) ? data.tags.join(",") : undefined,
        vod_douban_score: data.score ? String(data.score) : undefined,
        vod_content: String(data.description || data.title || "").trim(),
        vod_play_from: "黄果",
        vod_play_url: playUrls.join("#"),
        vod_play_list: episodes,
        vod_play_sources: [{ name: "黄果", episodes }],
        vod_play_page: playUrl,
      });
    } catch (e) {
      log("error", `[detail] id=${id} 异常：${e && e.message}`);
    }
  }
  return { list: out };
}

// 真实播放地址：POST /api/videos/{id}/episodes/{ep}/playback
async function fetchPlayback(videoId, ep) {
  const path = `/api/videos/${encodeURIComponent(videoId)}/episodes/${encodeURIComponent(ep)}/playback`;
  const json = await requestJson(path, {
    method: "POST",
    onlyOrigin: true,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!json) return null;
  const data = json.data && typeof json.data === "object" ? json.data : null;
  if (!data) {
    log("error", `[play] id=${videoId} ep=${ep} 上游返回 status=${json.status} msg=${json.msg || ""}`);
    return null;
  }
  return data;
}

async function play(params, context) {
  const playId = (params && (params.playId || params.id || params.url)) || "";
  const parsed = parsePlayId(playId);
  if (!parsed) {
    log("error", `[play] 无法解析 playId=${playId}`);
    return { parse: 0, jx: 0, url: "", urls: [] };
  }
  const { videoId, ep } = parsed;
  log("info", `[play] playId=${playId} -> id=${videoId} ep=${ep} from=${(context && context.from) || "web"}`);
  let data = null;
  try {
    data = await fetchPlayback(videoId, ep);
  } catch (e) {
    log("error", `[play] 请求异常：${e && e.message}`);
  }
  const streams = (data && data.streams) || {};
  const urls = [];
  const seen = {};
  const push = (name, url) => {
    const u = String(url || "").trim();
    if (!u || seen[u]) return;
    seen[u] = 1;
    urls.push({ name, url: u });
  };
  push("1080P", streams.main || (data && data.video_url));
  push("HEVC", streams.hevc || (data && data.video_url_hevc));
  // main 缺失时用 preview 兜底，避免整集无地址
  if (!urls.length) push("预览", streams.preview);
  if (!urls.length) {
    log("error", `[play] id=${videoId} ep=${ep} 未获取到播放地址`);
    return { parse: 0, jx: 0, url: "", urls: [] };
  }
  const cdn = (data && data.cdn) || {};
  const header = {
    "User-Agent": UA,
    "Referer": ORIGIN + "/",
    "Origin": ORIGIN,
  };
  if (cdn.authKey && cdn.authValue) header[String(cdn.authKey)] = String(cdn.authValue);
  log("info", `[play] id=${videoId} ep=${ep} urls=${urls.length} first=${urls[0].url.slice(0, 90)}`);
  return {
    parse: 0,
    jx: 0,
    flag: "黄果",
    header,
    url: urls[0].url,
    playUrl: urls[0].url,
    urls,
  };
}

async function search(params, context) {
  const page = Math.max(1, parseInt((params && params.page) || "1", 10) || 1);
  const wd = String((params && (params.keyword || params.wd || params.key)) || "").trim();
  if (!wd) return { page, pagecount: 0, limit: 0, total: 0, list: [] };
  log("info", `[search] keyword=${wd} page=${page}`);
  try {
    const json = await requestJson(`/api/search?q=${encodeURIComponent(wd)}&page=${page}`);
    const list = mapList(json);
    const pages = pickPages(json, list.length, 20);
    log("info", `[search] 返回 ${list.length} 条 pages=${pages}`);
    return { page, pagecount: pages, limit: 20, total: pages * 20, list, parse: 0, jx: 0 };
  } catch (e) {
    log("error", `[search] 异常：${e && e.message}`);
    return { page, pagecount: 0, limit: 0, total: 0, list: [] };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
