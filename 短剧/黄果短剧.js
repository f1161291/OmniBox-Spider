// @name 黄果短剧
// @author 宝宝巴士
// @description 黄果短剧：从 https://huangguoai.com/go-home/ 官方地址发布页动态获取域名并健康度轮转（主域 + 3 条线路）；分类/搜索/详情/播放；播放走 POST /api/videos/{id}/episodes/{ep}/playback 直取 m3u8 直链
// @version 1.2.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/短剧/黄果短剧.js

const OmniBox = require("omnibox_sdk");

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

const UA = "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// ---------------------------------------------------------------------------
// 域名池：从官方地址发布页 https://huangguoai.com/go-home/ 动态获取并轮转
// ---------------------------------------------------------------------------
// 实站事实（2026-11-15 实测）：
//   /go-home/ 是「黄果短剧 · 官方最新地址发布页」，里面
//     - <article class="hg-homeway-line"> 的 p.hg-homeway-line__domain 是线路域名
//       （d1716d.bmikbxhi.cc / 40dca.vlkotdgb.cc / up0e.bmikbxhi.cc）
//     - <article class="hg-homeway-permanent__item"> 的 span.hg-homeway-permanent__domain
//       是官方域名（huangguoai.com / .ai / .me / hgai15.com / huangguoai.pages.dev）
//   实测只有 huangguoai.com / d1716d.bmikbxhi.cc / up0e.bmikbxhi.cc 三个是
//   同构主站（220KB 首页 + POST playback 返回 status:1 + streams.main），
//   其余是地址发布页/跳转页/介绍页，不能当采集源，因此会自动按「可用性探测」筛掉。
// 默认种子：主域 + go-home 发布页域名；运行时调用 refreshHosts() 拉取最新清单。
const GO_HOME = "https://huangguoai.com/go-home/";
const DEFAULT_HOSTS = [
  "https://huangguoai.com",
  "https://d1716d.bmikbxhi.cc",
  "https://up0e.bmikbxhi.cc",
];

function normalizeHost(v) {
  const raw = String(v || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProtocol); return `${u.protocol}//${u.host}`; }
  catch (_) { return ""; }
}

let HOSTS = (() => {
  const raw = String(process.env.HUANGGUO_HOSTS || process.env.HUANGGUO_HOST || "").trim();
  const list = raw
    ? raw.split(/[,;]/).map(normalizeHost).filter(Boolean)
    : DEFAULT_HOSTS.map(normalizeHost).filter(Boolean);
  return Array.from(new Set(list.length ? list : DEFAULT_HOSTS));
})();

// 健康度：成功过的域名优先；失败/被拦截的在 HUANGGUO_ROTATE_COOLDOWN 内降权
const hostHealth = Object.create(null);
let PREFERRED = 0;
const ROTATE_COOLDOWN = (() => {
  const raw = String(process.env.HUANGGUO_ROTATE_COOLDOWN || "").trim();
  const n = raw === "" ? 600 : Number(raw);
  return Math.max(60, Number.isFinite(n) ? n : 600) * 1000;
})();

function currentOrigin() { return HOSTS[PREFERRED] || HOSTS[0] || "https://huangguoai.com"; }

function markHost(host, ok, reason) {
  if (!host) return;
  const h = hostHealth[host] || (hostHealth[host] = { fail: 0, okAt: 0, blockedAt: 0 });
  if (ok) { h.fail = 0; h.okAt = Date.now(); h.blockedAt = 0; return; }
  h.fail = Number(h.fail || 0) + 1;
  if (/403|401|429|blocked|challenge|拦截/i.test(String(reason || ""))) h.blockedAt = Date.now();
}

/** 排序：未拦截 > 优选 > 失败少 > 配置顺序 */
function hostOrder() {
  const now = Date.now();
  return HOSTS.map((host, idx) => {
    const h = hostHealth[host] || {};
    return {
      idx, host,
      blocked: (h.blockedAt && now - h.blockedAt < ROTATE_COOLDOWN) ? 1 : 0,
      preferred: idx === PREFERRED ? 0 : 1,
      fails: Number(h.fail || 0),
    };
  }).sort((a, b) =>
    a.blocked - b.blocked || a.preferred - b.preferred || a.fails - b.fails || a.idx - b.idx
  ).map((x) => x.idx);
}

/**
 * 从官方地址发布页拉取最新域名清单并并入 HOSTS。
 * 只解析 hg-homeway-line / hg-homeway-permanent 两个区块里的域名文本，
 * 避免把 t.me / x.com / pic 图床等无关域名混进来。
 * 结果按可用性验证（能返回同构首页才加入轮换池），验证失败不加入。
 */
async function refreshHosts() {
  const pages = [GO_HOME];
  // 备用发布页（实测同结构）
  for (const d of ["https://huangguoai.ai", "https://hgai15.com"]) {
    pages.push(`${d}/go-home/`);
  }
  const found = new Set();
  for (const page of pages) {
    try {
      const res = await OmniBox.request(page, {
        method: "GET",
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", Referer: "https://huangguoai.com/" },
        timeout: 15000,
      });
      const html = asText(res);
      if (!html) continue;
      const re = /(?:hg-homeway-line__domain|hg-homeway-permanent__domain)[^>]*>\s*([a-z0-9.-]+\.[a-z]{2,})\s*</gi;
      let m;
      while ((m = re.exec(html)) !== null) found.add(m[1].toLowerCase());
      // 「立即进入」按钮的 href 也是有效入口
      const re2 = /class="[^"]*hg-homeway-line__enter[^"]*"[^>]*href="(https?:\/\/[a-z0-9.-]+)/gi;
      while ((m = re2.exec(html)) !== null) found.add(new URL(m[1]).hostname.toLowerCase());
    } catch (e) {
      log("info", `[hosts] 拉取发布页失败 ${page}: ${(e && e.message) || e}`);
    }
  }
  let added = 0;
  for (const host of found) {
    const u = normalizeHost(host);
    if (!u || HOSTS.includes(u)) continue;
    // 只收看起来像主站/线路域名的，排除图床/社交/统计
    if (/pic\.|drleao|google|yandex|t\.me|x\.com|tiktok|youtube|pages\.dev|huangguojob/i.test(u)) continue;
    // 【可用性验证】go-home 里混有 301 跳转页、地址发布页、介绍页，
    // 直接塞进池会导致大量无效请求。用一个轻量 API 探测：能返回 JSON 才算同构主站。
    let ok = false;
    try {
      const res = await rawRequest(`${u}/api/videos?sort=hot&page=1&size=1`, { method: "GET" });
      ok = res.statusCode >= 200 && res.statusCode < 300 && !!parseJson(res.body);
    } catch (_) {}
    if (!ok) {
      log("info", `[hosts] 跳过非主站域名 -> ${u}（API 无 JSON 响应）`);
      continue;
    }
    HOSTS.push(u);
    hostHealth[u] = { fail: 0, okAt: 0, blockedAt: 0 };
    added++;
    log("info", `[hosts] 发现可用主站 -> ${u}`);
  }
  if (added) log("info", `[hosts] 本次新增 ${added} 个，当前池共 ${HOSTS.length} 个`);
  return added;
}

// Cloudflare Worker 反代（只作为列表/详情/搜索的兜底，POST 播放接口不支持）
const PROXY = String(process.env.HUANGGUO_PROXY_HOST || "https://little-waterfall-ea20.sjzkn886.workers.dev/proxy").replace(/\/+$/, "");
const PIC = "https://little-waterfall-ea20.sjzkn886.workers.dev/img?u=";

// 注意：所有需要当前域名的地方统一调用 currentOrigin()，不用静态常量，
// 这样轮换后 Referer / Origin / 播放页 URL 会跟着切换。

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
  // Referer / Origin 按本次请求的目标域名动态生成，轮换后才不会串域
  let origin = currentOrigin();
  try { origin = new URL(url).origin; } catch (_) {}
  const opts = {
    method: options.method || "GET",
    headers: Object.assign({}, HEADERS, {
      Referer: `${origin}/`,
      ...(options.method === "POST" ? { Origin: origin } : {}),
    }, options.headers || {}),
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

/**
 * /api/xxx 的候选 URL：按健康度轮转所有域名（成功的优先、被拦截的降权），
 * 最后再挂 Worker 反代兜底（去掉 /api 前缀）。
 * onlyOrigin（播放 POST）只走域名池，不用反代（反代不支持 POST playback）。
 */
function candidateUrls(apiPath, onlyOrigin) {
  const order = hostOrder();
  if (HOSTS.length > 1) {
    log("info", `[rotate] 尝试顺序: ${order.map((i) => HOSTS[i]).join(" -> ")}`);
  }
  const urls = order.map((i) => HOSTS[i] + apiPath);
  if (!onlyOrigin && PROXY) {
    const proxied = apiPath.replace(/^\/api/, "");
    urls.push(PROXY + proxied);
  }
  return urls;
}

async function requestJson(apiPath, options = {}) {
  const urls = candidateUrls(apiPath, !!options.onlyOrigin);
  let lastErr = "";
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    // 从 URL 反推本次尝试的域名，用于健康度记录
    let host = "";
    try { host = new URL(url).origin; } catch (_) {}
    const isHost = HOSTS.indexOf(host) >= 0;
    try {
      const res = await rawRequest(url, options);
      const json = parseJson(res.body);
      if (res.statusCode >= 200 && res.statusCode < 300 && json) {
        if (isHost) {
          markHost(host, true);
          const idx = HOSTS.indexOf(host);
          if (idx !== PREFERRED) { PREFERRED = idx; log("info", `[rotate] 切换优选域名 -> ${host}`); }
        }
        return json;
      }
      lastErr = `status=${res.statusCode} body=${String(res.body || "").slice(0, 120)}`;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    if (isHost) { markHost(host, false, lastErr); log("info", `[rotate] ${host} 失败，切下一个`); }
    log("error", `${options.method || "GET"} ${url} 失败：${lastErr}`);
  }
  // 全部失败：尝试从官方发布页刷新域名清单，只刷新一轮
  if (!globalThis.__huangguoRefreshed) {
    globalThis.__huangguoRefreshed = true;
    log("info", "[rotate] 全部域名失败，尝试从 go-home 刷新域名池");
    const added = await refreshHosts();
    if (added > 0) {
      for (const h of hostOrder().map((i) => HOSTS[i])) {
        try {
          const res = await rawRequest(h + apiPath, options);
          const json = parseJson(res.body);
          if (res.statusCode >= 200 && res.statusCode < 300 && json) {
            markHost(h, true);
            PREFERRED = HOSTS.indexOf(h);
            log("info", `[rotate] 用新域名重试成功 -> ${h}`);
            return json;
          }
        } catch (_) {}
      }
    }
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
      playUrls.push(`${name}$${currentOrigin()}/video/${id}/${ep > 1 ? `ep-${ep}/` : ""}`);
    }
  } else {
    for (let ep = 1; ep <= total; ep++) {
      const name = `第${ep}集`;
      episodes.push({ name, playId: encodePlayId(id, ep), episodeName: name });
      playUrls.push(`${name}$${currentOrigin()}/video/${id}/${ep > 1 ? `ep-${ep}/` : ""}`);
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
      const playUrl = `${currentOrigin()}/video/${id}/`;
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
  // 上游 JSON 里的 URL 用 \u0026 转义 &（如 ?auth_key=...\u0026v=3），必须还原，
  // 否则播放器拿到带字面 \u0026 的地址会丢参数、取流 403。
  const fixUrl = (u) => String(u || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
  const streams = data.streams || {};
  if (streams.main) streams.main = fixUrl(streams.main);
  if (streams.hevc) streams.hevc = fixUrl(streams.hevc);
  if (streams.preview) streams.preview = fixUrl(streams.preview);
  if (data.video_url) data.video_url = fixUrl(data.video_url);
  if (data.video_url_hevc) data.video_url_hevc = fixUrl(data.video_url_hevc);
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
    "Referer": currentOrigin() + "/",
    "Origin": currentOrigin(),
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
