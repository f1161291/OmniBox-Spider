// @name 网飞猫
// @version 1.0.0
// @downloadURL https://raw.githubusercontent.com/OmniBox-Spider/OmniBox-Spider/main/影视/采集/网飞猫.js
// @indexs 1

/**
 * 网飞猫（com.cssky.seeplusearn）逆向得到的 OmniBox 源
 *
 * 结构说明（来自 APK 静态逆向 + 接口实测）：
 *   1. 官方内容接口：https://video-short.tiankongshuyu.cn/api  （BuildConfig.API_BASE_URL）
 *      - POST video/home                   首页 tabs / 轮播 / 榜单 / 金刚区
 *      - POST video/pageFilteringResources  分类分页
 *        body: { pageNo, pageSize, dongman, classTitle, address, year }
 *      - POST video/app-source/list         线路列表
 *        body: { videoId } -> [{ id, title, searchUrl }]，searchUrl 里带 #{title} 占位
 *   2. App 自身不存播放地址：每条线路是一个第三方 MacCMS 采集站的「按片名搜索」URL。
 *   3. 播放链路：searchUrl -> 搜索页 -> 详情页 -> /vodplay/xxx-1-1.html -> player_aaaa -> m3u8
 *
 * 环境变量：
 *   SITE_API         官方 API 根地址，默认 https://video-short.tiankongshuyu.cn/api
 *   WFM_MAX_LINES    detail 阶段最多预解析多少条线路，默认 4（控制首屏延迟）
 *   WFM_LINE_WHITE   只使用这些线路名，逗号分隔，例如 "努努,樱花"（默认全部）
 *   WFM_UA_WEB       采集站请求 UA，默认内置移动端 UA
 *
 * 说明：搜索接口 video/searchList 需要登录态，脚本改为直接用采集站搜索，避免依赖账号。
 */

let OmniBox;
try {
  OmniBox = require("omnibox_sdk");
} catch (_) {
  // 本地调试 fallback：保证 node --check / 本地 harness 可运行
  OmniBox = {
    log(level, message) {
      console.log(`[${level}] ${message}`);
    },
    async request(url, options = {}) {
      const res = await fetch(url, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body,
      });
      const body = await res.text();
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { statusCode: res.status, headers, body };
    },
  };
}

let runner;
try {
  runner = require("spider_runner");
} catch (_) {
  runner = { run() {} };
}

const SITE_API = (process.env.SITE_API || "https://video-short.tiankongshuyu.cn/api").replace(/\/+$/, "");
const MAX_LINES = Number(process.env.WFM_MAX_LINES || 4);
const LINE_WHITE = String(process.env.WFM_LINE_WHITE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const UA_APP = "okhttp/3.12.13";
// 实测可达性排序：努努/不卡/BT 较稳，樱花/高速/蜗牛 常 403 或被重置
const LINE_PRIORITY = ["努努", "不卡", "BT", "樱花", "高速", "蜗牛"];

// 官方筛选维度里「连续剧」在后端 page 字段上对应「电视剧」，直接传「连续剧」会返回 0 条
const DONGMAN_ALIAS = { 连续剧: "电视剧" };

function sortLines(lines) {
  const rank = (name) => {
    const i = LINE_PRIORITY.indexOf(String(name || ""));
    return i < 0 ? LINE_PRIORITY.length : i;
  };
  return lines.slice().sort((a, b) => rank(a.title) - rank(b.title));
}
const UA_WEB =
  process.env.WFM_UA_WEB ||
  "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const LOG = "[wfm]";
const TAG = "wfm:";

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 限制并发执行，避免一次性打满 6 个采集站 */
async function mapLimit(items, limit, worker) {
  const ret = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        ret[idx] = await worker(items[idx], idx);
      } catch (e) {
        ret[idx] = null;
        await OmniBox.log("error", `${LOG} 并发任务失败 idx=${idx}: ${e.message}`);
      }
    }
  });
  await Promise.all(runners);
  return ret;
}

function b64encode(obj) {
  try {
    return Buffer.from(JSON.stringify(obj), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch (_) {
    return "";
  }
}

function b64decode(str) {
  try {
    const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch (_) {
    return null;
  }
}

/** 统一构造 vod_id：带上标题等元数据，detail 阶段就不必再查一次详情 */
function makeVodId(meta) {
  return `wfm:${b64encode(meta)}`;
}

function parseVodId(videoId) {
  const raw = String(videoId || "");
  if (raw.startsWith("wfm:")) {
    const meta = b64decode(raw.slice(4));
    if (meta) return meta;
  }
  // 兼容裸 id（历史缓存 / 手动输入）
  return { i: raw, t: "", p: "", y: "", a: "", r: "" };
}

function absUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (_) {
    return href;
  }
}

/* ------------------------------------------------------------------ */
/* 官方 API                                                            */
/* ------------------------------------------------------------------ */

async function postApi(path, body) {
  const url = `${SITE_API}/${path.replace(/^\/+/, "")}`;
  const res = await OmniBox.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA_APP },
    body: JSON.stringify(body || {}),
  });
  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode} @ ${path}`);
  }
  const data = JSON.parse(res.body || "{}");
  if (Number(data.code) !== 200) {
    throw new Error(`code=${data.code} msg=${data.message} @ ${path}`);
  }
  return data.data;
}

/**
 * 首页 tabs 里的各种区块统一抽成列表项。
 * 实测结构：
 *   carousels:      [{ id, title, imageUrl, linkId }]
 *   ranking:        { blockTitle, movies: { records: [...] } }   ← 是对象不是数组
 *   kingkongBlocks: [{ blockTitle, categories: [{ name, movies: { records } }] }]
 */
function collectHomeItems(tab) {
  const out = [];
  const typeId = String(tab.tabCode || "");
  const typeName = String(tab.tabName || "");

  const pushItem = (it) => {
    if (!it) return;
    const title = String(it.title || it.name || "").trim();
    const id = String(it.linkId || it.id || "").trim();
    if (!title || !id) return;
    const pic = String(it.imageUrl || it.image || "").trim();
    out.push({
      vod_id: makeVodId({
        i: id,
        t: title,
        p: pic,
        y: String(it.releaseYear || ""),
        a: String(it.address || ""),
        c: String(it.description || ""),
        r: String(it.cornerLabel || ""),
      }),
      vod_name: title,
      vod_pic: pic,
      vod_remarks: String(it.cornerLabel || ""),
      vod_year: String(it.releaseYear || ""),
      vod_area: String(it.address || ""),
      type_id: typeId,
      type_name: typeName,
    });
  };

  const pushRecords = (holder) => {
    if (!holder) return;
    (holder.records || holder.list || holder.items || []).forEach(pushItem);
  };

  (tab.carousels || []).forEach(pushItem);

  // ranking 可能是对象或数组
  const rankings = Array.isArray(tab.ranking) ? tab.ranking : tab.ranking ? [tab.ranking] : [];
  rankings.forEach((group) => {
    pushRecords(group.movies);
    pushRecords(group);
  });

  (tab.kingkongBlocks || []).forEach((block) => {
    (block.categories || []).forEach((cat) => pushRecords(cat.movies));
    pushRecords(block.movies);
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* 采集站（MacCMS）解析                                                 */
/* ------------------------------------------------------------------ */

async function fetchHtml(url) {
  const res = await OmniBox.request(url, {
    method: "GET",
    headers: {
      "User-Agent": UA_WEB,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} @ ${url}`);
  return res.body || "";
}

/** 采集站搜索页：抽 <a class="v-thumb" href="/voddetail/xxx.html" title="片名" data-original="封面"> */
function parseSearchPage(html, baseUrl) {
  const items = [];
  const re = /<a[^>]+href="(\/voddetail\/\d+\.html)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/v-thumb|stui-vodlist__thumb|play/i.test(tag)) continue;
    const href = m[1];
    const title = (/(?:title|alt)="([^"]+)"/i.exec(tag) || [])[1] || "";
    const pic = (/(?:data-original|data-src|src)="([^"]+)"/i.exec(tag) || [])[1] || "";
    if (!title) continue;
    items.push({ href: absUrl(baseUrl, href), title: title.trim(), pic: absUrl(baseUrl, pic) });
    if (items.length >= 30) break;
  }
  // 去重（同一详情页会出现多次）
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.href)) return false;
    seen.add(it.href);
    return true;
  });
}

/**
 * 详情页：抽取剧集。
 * 只解析播放列表容器（stui-content__playlist / module-play-list），避免把“立即播放”按钮当成剧集。
 */
function parseDetailPage(html, baseUrl) {
  const chunks = [];
  const boxRe = /<ul[^>]+class="[^"]*(?:playlist|play-list)[^"]*"[\s\S]*?<\/ul>/gi;
  let box;
  while ((box = boxRe.exec(html)) !== null) chunks.push(box[0]);
  const scope = chunks.length ? chunks.join("\n") : html;

  const episodes = [];
  const seen = new Set();
  const re = /<a[^>]+href="(\/vodplay\/[^"]+?\.html)"[^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const href = m[1];
    const name = (m[2] || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;
    // 过滤按钮类文案
    if (/^(立即播放|播放|超清|详情|更多)$/.test(name)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    episodes.push({ name, url: absUrl(baseUrl, href) });
  }
  return episodes;
}

/** 播放页：player_aaaa = { url, encrypt, ... } */
function parsePlayer(html) {
  const m = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i.exec(html) || /player_aaaa\s*=\s*(\{[\s\S]*?\});/i.exec(html);
  if (!m) return null;
  let cfg;
  try {
    cfg = JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
  let url = String(cfg.url || "");
  const enc = String(cfg.encrypt || "0");
  if (url && enc === "1") {
    // MacCMS 常见两种：escape 过的明文 / base64 过的 escape 串
    try {
      const decoded = decodeURIComponent(url);
      url = /^https?:\/\//i.test(decoded) ? decoded : url;
    } catch (_) {}
    if (!/^https?:\/\//i.test(url)) {
      try {
        const b = Buffer.from(url, "base64").toString("utf8");
        const u = decodeURIComponent(b);
        if (/^https?:\/\//i.test(u)) url = u;
      } catch (_) {}
    }
  }
  if (url && !/^https?:\/\//i.test(url)) {
    try {
      url = decodeURIComponent(url);
    } catch (_) {}
  }
  return { url, from: cfg.from || "", link: cfg.link || "" };
}

/** 一条线路：搜索片名 -> 取第一条 -> 抓详情页剧集 */
async function resolveLineEpisodes(line, title) {
  const tpl = String(line.searchUrl || "");
  if (!tpl || !title) return null;
  const searchUrl = tpl.replace(/#\{title\}/g, encodeURIComponent(title));
  const base = new URL(searchUrl).origin;

  const searchHtml = await fetchHtml(searchUrl);
  const results = parseSearchPage(searchHtml, base);
  if (!results.length) {
    await OmniBox.log("info", `${LOG} 线路「${line.title}」无搜索结果: ${title}`);
    return null;
  }

  // 优先完全匹配同名，其次取第一条
  const hit = results.find((r) => r.title === title) || results[0];
  const detailHtml = await fetchHtml(hit.href);
  const eps = parseDetailPage(detailHtml, base);
  if (!eps.length) {
    await OmniBox.log("info", `${LOG} 线路「${line.title}」详情页无剧集: ${hit.href}`);
    return null;
  }
  await OmniBox.log("info", `${LOG} 线路「${line.title}」解析到 ${eps.length} 集 (${hit.title})`);
  return { line: line.title, episodes: eps };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                           */
/* ------------------------------------------------------------------ */

async function home(params, context) {
  try {
    await OmniBox.log("info", `${LOG} [home] from=${context?.from || "web"} params=${JSON.stringify(params || {})}`);
    const data = await postApi("video/home", {});
    const tabs = data?.tabs || [];

    const classes = tabs.map((t) => ({
      type_id: String(t.tabCode || t.tabId || ""),
      type_name: String(t.tabName || ""),
    }));

    // 分类入口用官方筛选维度（电影/连续剧/综艺/动漫/短剧）
    try {
      const fc = await postApi("video/filterCriteria", {});
      (fc?.pageList || []).forEach((p) => {
        const t = String(p.title || "");
        classes.push({ type_id: DONGMAN_ALIAS[t] || t, type_name: t });
      });
    } catch (e) {
      await OmniBox.log("error", `${LOG} [home] filterCriteria 失败: ${e.message}`);
    }

    const seen = new Set();
    const list = [];
    tabs.forEach((t) => {
      collectHomeItems(t).forEach((v) => {
        if (seen.has(v.vod_id)) return;
        seen.add(v.vod_id);
        list.push(v);
      });
    });

    await OmniBox.log("info", `${LOG} [home] class=${classes.length} list=${list.length}`);
    return { class: classes, list };
  } catch (e) {
    await OmniBox.log("error", `${LOG} [home] 失败: ${e.message}`);
    return { class: [], list: [] };
  }
}

async function category(params, context) {
  try {
    const page = Number(params?.page || 1);
    const categoryId = String(params?.categoryId || params?.type_id || "电影");
    const filters = params?.filters || params?.extend || params?.ext || {};
    await OmniBox.log("info", `${LOG} [category] id=${categoryId} page=${page} filters=${JSON.stringify(filters)}`);

    const body = {
      pageNo: page,
      pageSize: 20,
      dongman: DONGMAN_ALIAS[categoryId] || categoryId || "全部",
      classTitle: String(filters.classTitle || filters.class || "全部"),
      address: String(filters.address || filters.area || "全部"),
      year: String(filters.year || "全部"),
    };
    let data = await postApi("video/pageFilteringResources", body);
    let records = data?.records || [];
    // 该分类后端无数据时回退到全量，避免分类页空白
    if (!records.length && body.dongman !== "全部") {
      const alt = DONGMAN_ALIAS[body.dongman] || "全部";
      if (alt !== body.dongman) {
        data = await postApi("video/pageFilteringResources", { ...body, dongman: alt });
        records = data?.records || [];
      }
    }

    const list = records.map((r) => ({
      vod_id: makeVodId({
        i: String(r.id || ""),
        t: String(r.title || ""),
        p: String(r.imageUrl || ""),
        y: String(r.releaseYear || ""),
        a: String(r.address || ""),
        r: String(r.cornerLabel || r.episodeLatest || ""),
        c: String(r.description || ""),
      }),
      vod_name: String(r.title || ""),
      vod_pic: String(r.imageUrl || ""),
      vod_remarks: String(r.cornerLabel || (r.episodeLatest ? `更新至${r.episodeLatest}` : "") || ""),
      vod_year: String(r.releaseYear || ""),
      vod_area: String(r.address || ""),
      type_id: categoryId,
      type_name: String(r.page || categoryId),
    }));

    const result = {
      page: Number(data?.current || page),
      pagecount: Number(data?.pages || 0),
      total: Number(data?.total || 0),
      list,
    };
    await OmniBox.log("info", `${LOG} [category] total=${result.total} pages=${result.pagecount} list=${list.length}`);
    return result;
  } catch (e) {
    await OmniBox.log("error", `${LOG} [category] 失败: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const rawId = params?.videoId || params?.vod_id || params?.id || "";
    const meta = parseVodId(rawId);
    await OmniBox.log("info", `${LOG} [detail] id=${meta.i} title=${meta.t}`);

    if (!meta.i) return { list: [] };

    // 采集站直链 id：{ src: 详情页 URL }
    if (meta.src) {
      const base = new URL(meta.src).origin;
      const html = await fetchHtml(meta.src);
      const eps = parseDetailPage(html, base);
      await OmniBox.log("info", `${LOG} [detail] src 分支 episodes=${eps.length}`);
      return {
        list: [
          {
            vod_id: rawId,
            vod_name: meta.t || "",
            vod_pic: meta.p || "",
            vod_play_sources: eps.length
              ? [{ name: "线路1", episodes: eps.map((e) => ({ name: e.name, playId: e.url })) }]
              : undefined,
          },
        ],
      };
    }

    // 官方 id：拿线路 -> 逐线路解析剧集
    let lines = [];
    try {
      lines = (await postApi("video/app-source/list", { videoId: meta.i })) || [];
    } catch (e) {
      await OmniBox.log("error", `${LOG} [detail] app-source/list 失败: ${e.message}`);
    }

    lines = lines.filter((l) => l && l.showBool !== false && l.searchUrl);
    if (LINE_WHITE.length) {
      lines = lines.filter((l) => LINE_WHITE.includes(String(l.title || "")));
    }
    lines = sortLines(lines).slice(0, Math.max(1, MAX_LINES));
    await OmniBox.log("info", `${LOG} [detail] 线路数=${lines.length} -> ${lines.map((l) => l.title).join("/")}`);

    const sources = [];
    if (meta.t) {
      const resolved = await mapLimit(lines, 4, async (line) => {
        try {
          return await resolveLineEpisodes(line, meta.t);
        } catch (e) {
          await OmniBox.log("error", `${LOG} [detail] 线路「${line.title}」失败: ${e.message}`);
          return null;
        }
      });
      resolved.filter(Boolean).forEach((r) => {
        sources.push({
          name: r.line,
          episodes: r.episodes.map((e) => ({ name: e.name, playId: e.url })),
        });
      });
    } else {
      // 没有标题时无法做片名搜索：给出可点击的源站搜索入口
      sources.push({
        name: "源站搜索",
        episodes: lines.map((l) => ({
          name: String(l.title || "线路"),
          playId: String(l.searchUrl || "").replace(/#\{title\}/g, ""),
        })),
      });
      await OmniBox.log("info", `${LOG} [detail] 缺少标题，降级为源站搜索入口`);
    }

    const vod = {
      vod_id: rawId,
      vod_name: meta.t || "",
      vod_pic: meta.p || "",
      vod_year: meta.y || "",
      vod_area: meta.a || "",
      vod_remarks: meta.r || "",
      vod_content: meta.c || "",
      vod_play_sources: sources.length ? sources : undefined,
      vod_play_from: sources.map((s) => s.name).join("$$$"),
      vod_play_url: sources
        .map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join("#"))
        .join("$$$"),
    };
    await OmniBox.log("info", `${LOG} [detail] 输出线路=${sources.length} 集数=${sources.reduce((n, s) => n + s.episodes.length, 0)}`);
    return { list: [vod] };
  } catch (e) {
    await OmniBox.log("error", `${LOG} [detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = String(params?.keyword || params?.wd || params?.word || "").trim();
    const page = Number(params?.page || 1);
    await OmniBox.log("info", `${LOG} [search] keyword=${keyword} page=${page}`);
    if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };

    // 官方 searchList 需要登录态，这里直接用采集站搜索（免费、无账号依赖）
    const line = await pickSearchLine();
    if (!line) return { page: 1, pagecount: 0, total: 0, list: [] };

    const searchUrl = String(line.searchUrl).replace(/#\{title\}/g, encodeURIComponent(keyword));
    const base = new URL(searchUrl).origin;
    const html = await fetchHtml(searchUrl);
    const results = parseSearchPage(html, base);

    const list = results.map((r) => ({
      vod_id: makeVodId({ i: r.href, src: r.href, t: r.title, p: r.pic }),
      vod_name: r.title,
      vod_pic: r.pic,
      vod_remarks: "",
      type_id: "",
      type_name: "",
    }));

    await OmniBox.log("info", `${LOG} [search] 线路=${line.title} 结果=${list.length}`);
    return { page, pagecount: 1, total: list.length, list };
  } catch (e) {
    await OmniBox.log("error", `${LOG} [search] 失败: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/** 选一条能用的线路做搜索（缓存 10 分钟） */
let searchLineCache = null;
async function pickSearchLine() {
  if (searchLineCache) return searchLineCache;
  try {
    const data = await postApi("video/home", {});
    const tab = (data?.tabs || [])[0];
    const first = (tab?.carousels || []).find((c) => c.linkId);
    const videoId = first ? String(first.linkId) : "";
    if (videoId) {
      const lines = (await postApi("video/app-source/list", { videoId })) || [];
      const usable = sortLines(lines.filter((l) => l && l.searchUrl));
      if (LINE_WHITE.length) {
        const filtered = usable.filter((l) => LINE_WHITE.includes(String(l.title || "")));
        if (filtered.length) {
          searchLineCache = filtered[0];
          return searchLineCache;
        }
      }
      if (usable.length) {
        searchLineCache = usable[0];
        return searchLineCache;
      }
    }
  } catch (e) {
    await OmniBox.log("error", `${LOG} [search] 取线路失败: ${e.message}`);
  }
  // 兜底：内置已知线路
  searchLineCache = { title: "努努", searchUrl: "https://whstyysj.com/vodsearch/-------------.html?wd=#{title}&submit=" };
  return searchLineCache;
}

async function play(params, context) {
  try {
    const playId = String(params?.playId || params?.url || "");
    const flag = params?.flag || "play";
    await OmniBox.log("info", `${LOG} [play] playId=${playId.slice(0, 120)} flag=${flag}`);
    if (!playId) throw new Error("playId 为空");

    // 已经是媒体直链
    if (/\.(m3u8|mp4|flv)(\?|$)/i.test(playId)) {
      return {
        urls: [{ name: "播放", url: playId }],
        flag,
        header: { "User-Agent": UA_WEB },
        parse: 0,
      };
    }

    const html = await fetchHtml(playId);
    const player = parsePlayer(html);

    if (player && /^https?:\/\//i.test(player.url) && /\.(m3u8|mp4|flv)(\?|$)/i.test(player.url)) {
      await OmniBox.log("info", `${LOG} [play] 直链: ${player.url.slice(0, 120)}`);
      return {
        urls: [{ name: "播放", url: player.url }],
        flag,
        header: { "User-Agent": UA_WEB, Referer: new URL(playId).origin + "/" },
        parse: 0,
      };
    }

    if (player && player.url) {
      await OmniBox.log("info", `${LOG} [play] 非直链，返回嗅探: ${player.url.slice(0, 120)}`);
      return {
        urls: [{ name: "播放", url: player.url }],
        flag,
        header: { "User-Agent": UA_WEB, Referer: new URL(playId).origin + "/" },
        parse: 1,
      };
    }

    await OmniBox.log("error", `${LOG} [play] 未解析到 player_aaaa，回退页面嗅探`);
    return {
      urls: [{ name: "播放", url: playId }],
      flag,
      header: { "User-Agent": UA_WEB },
      parse: 1,
    };
  } catch (e) {
    await OmniBox.log("error", `${LOG} [play] 失败: ${e.message}`);
    return { url: "", flag: params?.flag || "play", header: {}, urls: [] };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
