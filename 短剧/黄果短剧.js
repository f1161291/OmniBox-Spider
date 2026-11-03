const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

const HOST = "https://little-waterfall-ea20.sjzkn886.workers.dev/proxy";
const PIC = "https://little-waterfall-ea20.sjzkn886.workers.dev/img?u=";
const UA = "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const CATEGORIES = [
  { type_id: "newest", type_name: "最近上新" },
  { type_id: "recommend", type_name: "精选推荐" },
  { type_id: "ai-duanju", type_name: "AI成人短剧" },
  { type_id: "ai-manju", type_name: "AI成人漫剧" },
  { type_id: "ai-huanlian", type_name: "AI换脸" },
  { type_id: "ai-mogai", type_name: "AI魔改" },
];

const H = { "User-Agent": UA, "Accept": "application/json,*/*", "Referer": HOST };

function log(level, msg) { OmniBox.log(level, `[short] ${msg}`); }

function getText(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  try {
    if (typeof res.content === "string") return res.content;
    if (typeof res.body === "string") return res.body;
    if (typeof res.data === "string") return res.data;
    if (typeof res.body === "object") return JSON.stringify(res.body);
    return JSON.stringify(res);
  } catch (e) { return ""; }
}

async function httpGet(url) {
  try {
    if (typeof req === "function") return await req(url, { method: "GET", headers: H, timeout: 25000 });
  } catch (e) {}
  try {
    if (typeof fetch === "function") {
      var r = await fetch(url, { method: "GET", headers: H });
      return await r.text();
    }
  } catch (e) {}
  try {
    const res = await OmniBox.request(url, { method: "GET", headers: H, timeout: 25000 });
    return getText(res);
  } catch (e) {}
  return "";
}

function parseJson(text) {
  if (!text) return null;
  let t = text.trim();
  const i = t.indexOf("{");
  if (i > 0) t = t.slice(i);
  try { return JSON.parse(t); } catch (e) { return null; }
}

function proxyPic(url) {
  if (!url) return "";
  url = String(url).trim();
  if (!url) return "";
  if (url.indexOf("/img?u=") >= 0) return url;
  return PIC + encodeURIComponent(url);
}

function mapItem(it) {
  if (!it || it.id == null) return null;
  const ep = parseInt(it.episode_count || it.total_episodes || 1, 10) || 1;
  return {
    vod_id: String(it.id),
    vod_name: String(it.title || "未命名").trim(),
    vod_pic: proxyPic(it.cover || ""),
    vod_remarks: ep > 1 ? ("全" + ep + "集") : "全集",
  };
}

function mapList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const m = mapItem(arr[i]);
    if (m) out.push(m);
  }
  return out;
}

function pickItems(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (json.data) {
    if (Array.isArray(json.data.items)) return json.data.items;
    if (Array.isArray(json.data.list)) return json.data.list;
    if (Array.isArray(json.data)) return json.data;
  }
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.list)) return json.list;
  return [];
}

function buildVodPlaySources(totalEp, id) {
  const eps = [];
  for (let ep = 1; ep <= totalEp; ep++) {
    eps.push({ name: "第" + ep + "集", playId: HOST + "/videos/" + id + "/play?ep=" + ep, url: HOST + "/videos/" + id + "/play?ep=" + ep });
  }
  return [{ name: "short", episodes: eps }];
}

async function home(params, context) {
  const classes = CATEGORIES.map(c => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const text = await httpGet(HOST + "/videos?sort=hot&page=1&size=24");
    const json = parseJson(text);
    list = mapList(pickItems(json));
  } catch (e) {}
  return { class: classes, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const page = Math.max(1, parseInt(params.page || "1", 10));
  const tid = params.categoryId || params.type_id || "recommend";
  let cat = CATEGORIES[0];
  for (let i = 0; i < CATEGORIES.length; i++) {
    if (String(CATEGORIES[i].type_id) === String(tid)) { cat = CATEGORIES[i]; break; }
  }
  let list = [];
  try {
    const url = cat.type_id === "newest" || cat.type_id === "recommend"
      ? `${HOST}/videos?sort=${cat.type_id === "newest" ? "new" : "hot"}&page=${page}&size=24`
      : `${HOST}/videos/category/${cat.type_id}?sort=hot&page=${page}&size=24`;
    const text = await httpGet(url);
    const json = parseJson(text);
    list = mapList(pickItems(json));
  } catch (e) {}
  return { page, pagecount: list.length < 12 ? page : page + 1, limit: 24, total: 999999, list, parse: 0, jx: 0 };
}

async function detail(params, context) {
  const id = params.videoId || params.vod_id || params.id || "";
  if (!id) return { list: [] };
  try {
    const text = await httpGet(HOST + "/videos/" + id);
    const json = parseJson(text);
    const data = json && (json.data || json);
    const totalEp = (Array.isArray(data.episodes) && data.episodes.length)
      ? data.episodes.length
      : (parseInt(data.episode_count || data.total_episodes || 1, 10) || 1);
    const playSource = buildVodPlaySources(totalEp, id);
    const playUrl = HOST + "/videos/" + id + "/play?ep=1";
    log("info", `[detail] name=${data.title || "test"} ep=${totalEp} url=${playUrl}`);
    return { list: [{
      vod_id: String(data.id || "test"),
      vod_name: data.title || ("短剧" + id),
      vod_pic: proxyPic(data.cover || ""),
      type_name: "短剧",
      vod_remarks: totalEp > 1 ? ("全" + totalEp + "集") : "全集",
      vod_content: data.description || data.title || "",
      vod_play_from: "short",
      vod_play_url: playUrl,
      vod_play_list: playSource[0].episodes,
      vod_play_sources: playSource,
    }] };
  } catch (e) { return { list: [] }; }
}

async function play(params, context) {
  const playId = params.playId || params.id || params.url || "";
  if (!playId) return { parse: 0, playUrl: "", url: "", jx: 0, urls: [] };
  try {
    const json = await parseJson(await httpGet(playId));
    const videoUrl = (json && json.data && json.data.video_url) || (json && json.video_url) || "";
    if (videoUrl) {
      const url = String(videoUrl).replace(/\u0026/g, "&").replace(/&amp;/g, "&");
      return { parse: 0, playUrl: "", url, jx: 0, urls: [{ name: "播放", url }], header: { "User-Agent": UA, "Referer": HOST } };
    }
  } catch (e) {}
  return { parse: 0, playUrl: "", url: "", jx: 0, urls: [] };
}

async function search(params, context) {
  const page = Math.max(1, parseInt(params.page || "1", 10));
  const wd = params.keyword || params.wd || params.key || "";
  if (!wd) return { page, pagecount: 0, limit: 0, total: 0, list: [] };
  try {
    const kw = encodeURIComponent(String(wd).trim());
    const text = await httpGet(HOST + "/search?q=" + kw + "&page=" + page);
    const json = parseJson(text);
    const pagination = (json && json.data && json.data.pagination) || {};
    return { page, pagecount: pagination.pages || 1, limit: 24, total: 999999, list: mapList(pickItems(json)), parse: 0, jx: 0 };
  } catch (e) { return { page, pagecount: 0, limit: 0, total: 0, list: [] }; }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
