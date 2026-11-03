// @name 四万影视
// @author 梦
// @description 站点接口源：直接走 40000.me 的 /api/maccms，支持分类、详情、搜索、播放
// @version 1.2.1
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/四万影视.js
// @dependencies axios

const axios = require("axios");
const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

const BASE_URL = "https://40000.me";
const API = `${BASE_URL}/api/maccms`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0";
const FALLBACK_PIC = `${BASE_URL}/public/favicon.png`;

const CLASS_LIST = [
  { type_id: "20", type_name: "电影" },
  { type_id: "30", type_name: "电视剧" },
  { type_id: "39", type_name: "动漫" },
  { type_id: "45", type_name: "综艺" },
  { type_id: "32", type_name: "欧美" }
];

const FILTER_TYPE_OPTIONS = {
  '20': [
    { name: '全部', value: '20' },
    { name: '动作片', value: '21' },
    { name: '喜剧片', value: '22' },
    { name: '恐怖片', value: '23' },
    { name: '科幻片', value: '24' },
    { name: '爱情片', value: '25' },
    { name: '剧情片', value: '26' },
    { name: '战争片', value: '27' },
    { name: '纪录片', value: '28' },
    { name: '理论片', value: '29' },
    { name: '预告片', value: '52' },
    { name: '电影解说', value: '51' }
  ],
  '30': [
    { name: '全部', value: '30' },
    { name: '国产剧', value: '31' },
    { name: '欧美剧', value: '32' },
    { name: '香港剧', value: '33' },
    { name: '韩国剧', value: '34' },
    { name: '台湾剧', value: '35' },
    { name: '日本剧', value: '36' },
    { name: '海外剧', value: '37' },
    { name: '泰国剧', value: '38' },
    { name: '短剧大全', value: '58' }
  ],
  '39': [
    { name: '全部', value: '39' },
    { name: '国产动漫', value: '40' },
    { name: '日韩动漫', value: '41' },
    { name: '欧美动漫', value: '42' },
    { name: '港台动漫', value: '43' },
    { name: '海外动漫', value: '44' },
    { name: '动画片', value: '50' }
  ],
  '45': [
    { name: '全部', value: '45' },
    { name: '大陆综艺', value: '46' },
    { name: '港台综艺', value: '47' },
    { name: '日韩综艺', value: '48' },
    { name: '欧美综艺', value: '49' }
  ],
  '32': [
    { name: '全部', value: '32' },
    { name: '欧美剧', value: '32' },
    { name: '欧美动漫', value: '42' },
    { name: '欧美综艺', value: '49' },
    { name: '海外剧', value: '37' }
  ]
};

function buildFilters() {
  const years = [{ name: '全部', value: '' }];
  for (let y = 2026; y >= 2000; y -= 1) years.push({ name: String(y), value: String(y) });
  const sortValues = [
    { name: '时间', value: 'time' },
    { name: '人气', value: 'hits' },
    { name: '评分', value: 'score' },
    { name: '点赞', value: 'up' }
  ];
  const filters = {};
  for (const item of CLASS_LIST) {
    filters[item.type_id] = [
      { key: 'subType', name: '分类', init: item.type_id, value: FILTER_TYPE_OPTIONS[item.type_id] || [{ name: '全部', value: item.type_id }] },
      { key: 'year', name: '年代', init: '', value: years },
      { key: 'sort', name: '排序', init: 'time', value: sortValues }
    ];
  }
  return filters;
}

const http = axios.create({
  timeout: 20000,
  validateStatus: () => true,
  headers: {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Content-Type": "application/json",
    DNT: "1",
    Priority: "u=1, i",
    Referer: `${BASE_URL}/`,
    "Sec-CH-UA": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-GPC": "1"
  }
});

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { OmniBox.log(level, `[四万影视] ${msg}`); } catch {}
}

function typeNameById(typeId) {
  const hit = CLASS_LIST.find((item) => String(item.type_id) === String(typeId));
  return hit?.type_name || "";
}

function normalizeVod(v) {
  return {
    vod_id: String(v.vod_id || ""),
    vod_name: String(v.vod_name || ""),
    vod_pic: String(v.vod_pic || FALLBACK_PIC),
    type_id: String(v.type_id || ""),
    type_name: String(v.type_name || typeNameById(v.type_id) || ""),
    vod_remarks: String(v.vod_remarks || ""),
    vod_year: String(v.vod_year || ""),
    vod_douban_score: String(v.vod_score || v.vod_douban_score || ""),
    vod_subtitle: String(v.vod_sub || ""),
    vod_content: String(v.vod_blurb || v.vod_content || ""),
    vod_actor: String(v.vod_actor || "").replace(/&amp;#039;/g, "'").replace(/\s+,\s+/g, ", "),
    vod_director: String(v.vod_director || ""),
    vod_area: String(v.vod_area || ""),
    vod_lang: String(v.vod_lang || "")
  };
}

async function apiGet(params = {}) {
  const resp = await http.get(API, { params });
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status}: ${String(resp.data).slice(0, 300)}`);
  }
  const data = resp.data;
  if (!data || typeof data !== "object") throw new Error("接口返回不是 JSON 对象");
  return data;
}

function parsePlaySources(v) {
  const fromArr = String(v.vod_play_from || "").split("$$$");
  const urlArr = String(v.vod_play_url || "").split("$$$");
  const sources = [];

  for (let i = 0; i < fromArr.length; i += 1) {
    const sourceName = String(fromArr[i] || `线路${i + 1}`).trim();
    const sourceRaw = String(urlArr[i] || "").trim();
    if (!sourceRaw) continue;

    const episodes = sourceRaw
      .split("#")
      .map((seg, idx) => {
        const [name, playId] = String(seg || "").split("$");
        return {
          name: String(name || `第${idx + 1}集`).trim(),
          playId: String(playId || "").trim()
        };
      })
      .filter((ep) => ep.playId);

    if (episodes.length) {
      sources.push({ name: sourceName, episodes });
    }
  }

  return sources;
}

async function home() {
  try {
    const data = await apiGet({ ac: "detail", pg: 1 });
    const list = Array.isArray(data.list) ? data.list.map(normalizeVod) : [];
    log("info", `home list=${list.length}`);
    return { class: CLASS_LIST, filters: buildFilters(), list };
  } catch (e) {
    log("error", `home ${e.message}`);
    return { class: CLASS_LIST, list: [] };
  }
}

async function category(params) {
  try {
    const categoryId = String(params?.categoryId || "30");
    const page = Math.max(1, Number(params?.page || 1) || 1);
    const filters = params?.filters || params?.extend || {};
    const subType = String(filters.subType || categoryId).trim() || categoryId;
    const year = String(filters.year || '').trim();
    const sortRaw = String(filters.sort || 'time').trim() || 'time';
    const sort = sortRaw;
    const data = await apiGet({ ac: "detail", t: subType, pg: page, ...(year ? { h: year } : {}), by: sort });
    const list = Array.isArray(data.list) ? data.list.map(normalizeVod) : [];
    return {
      page: Number(data.page || page),
      pagecount: Number(data.pagecount || 0),
      total: Number(data.total || list.length),
      list
    };
  } catch (e) {
    log("error", `category ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params) {
  try {
    const videoId = String(params?.videoId || "").trim();
    if (!videoId) return { list: [] };
    const data = await apiGet({ ac: "detail", ids: videoId });
    const item = Array.isArray(data.list) ? data.list[0] : null;
    if (!item) return { list: [] };

    const vod = normalizeVod(item);
    const out = {
      vod_id: vod.vod_id,
      vod_name: vod.vod_name,
      vod_pic: vod.vod_pic,
      type_name: vod.type_name,
      vod_year: String(item.vod_year || ""),
      vod_area: String(item.vod_area || ""),
      vod_subtitle: String(item.vod_sub || item.vod_lang || ""),
      vod_douban_score: String(item.vod_score || item.vod_douban_score || ""),
      vod_actor: String(item.vod_actor || "").replace(/&amp;#039;/g, "'").replace(/\s+,\s+/g, ", "),
      vod_director: String(item.vod_director || ""),
      vod_content: String(item.vod_blurb || item.vod_content || ""),
      vod_remarks: [String(item.vod_remarks || ""), String(item.vod_area || ""), String(item.vod_year || "")].filter(Boolean).join(' · '),
      vod_play_sources: parsePlaySources(item)
    };
    log("info", `detail id=${videoId} sources=${out.vod_play_sources.length}`);
    return { list: [out] };
  } catch (e) {
    log("error", `detail ${e.message}`);
    return { list: [] };
  }
}

async function search(params) {
  try {
    const keyword = String(params?.keyword || params?.wd || "").trim();
    const page = Math.max(1, Number(params?.page || 1) || 1);
    if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
    const data = await apiGet({ ac: "detail", wd: keyword, pg: page });
    const list = Array.isArray(data.list) ? data.list.map(normalizeVod) : [];
    return {
      page: Number(data.page || page),
      pagecount: Number(data.pagecount || 0),
      total: Number(data.total || list.length),
      list
    };
  } catch (e) {
    log("error", `search ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params) {
  try {
    const playId = String(params?.playId || "").trim();
    if (!playId) return { urls: [], parse: 0, header: {} };

    if (/^https?:\/\//i.test(playId)) {
      return {
        urls: [{ name: "默认线路", url: playId }],
        parse: 0,
        header: { "User-Agent": UA, Referer: `${BASE_URL}/` }
      };
    }

    return {
      urls: [{ name: "默认线路", url: playId }],
      parse: 1,
      header: { "User-Agent": UA, Referer: `${BASE_URL}/` }
    };
  } catch (e) {
    log("error", `play ${e.message}`);
    return { urls: [], parse: 0, header: {} };
  }
}
