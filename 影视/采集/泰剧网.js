// @name 泰剧网
// @author 梦
// @description 页面解析：分类/详情/播放已接入；播放页直接解析 playUrls 多线路 m3u8
// @dependencies cheerio
// @version 1.2.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/泰剧网.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");

const BASE_URL = "https://zh.taijuwang.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const CLASS_LIST = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "chinese-mainland", type_name: "国产剧" },
  { type_id: "united-states", type_name: "美剧" },
  { type_id: "japan", type_name: "日剧" },
  { type_id: "south-korea", type_name: "韩剧" },
  { type_id: "thailand", type_name: "泰剧" },
  { type_id: "hong-kong", type_name: "港剧" },
  { type_id: "taiwan", type_name: "台剧" },
  { type_id: "other-overseas", type_name: "海外剧" }
];

const CATEGORY_LIBRARY_PATH = {
  movie: '/all/3---hits/',
  'chinese-mainland': '/all/1---hits/',
  'united-states': '/all/9---hits/',
  japan: '/all/6---hits/',
  'south-korea': '/all/4---hits/',
  thailand: '/all/2---hits/',
  'hong-kong': '/all/8---hits/',
  taiwan: '/all/5---hits/',
  'other-overseas': '/all/7---hits/'
};

const CATEGORY_CODE_MAP = {
  movie: '3',
  'chinese-mainland': '1',
  'united-states': '9',
  japan: '6',
  'south-korea': '4',
  thailand: '2',
  'hong-kong': '8',
  taiwan: '5',
  'other-overseas': '7'
};

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function buildFilters() {
  const typeValues = [
    { name: '全部', value: '' },
    { name: '剧情', value: '43' },
    { name: '喜剧', value: '84' },
    { name: '爱情', value: '54' },
    { name: '动作', value: '174' },
    { name: '惊悚', value: '737' },
    { name: '悬疑', value: '158' },
    { name: '犯罪', value: '63' },
    { name: '恐怖', value: '2755' },
    { name: '科幻', value: '1160' },
    { name: '奇幻', value: '109' },
    { name: '家庭', value: '204' },
    { name: '动画', value: '339' },
    { name: '冒险', value: '273' },
    { name: '古装', value: '90' },
    { name: '历史', value: '779' },
    { name: '战争', value: '44' },
    { name: '同性', value: '2148' },
    { name: '传记', value: '2258' },
    { name: '短片', value: '76' },
    { name: '纪录片', value: '61' },
    { name: '武侠', value: '547' },
    { name: '音乐', value: '3726' },
    { name: '运动', value: '1401' },
    { name: '儿童', value: '1941' },
    { name: '歌舞', value: '3725' },
    { name: '西部', value: '19204' },
    { name: '真人秀', value: '471' },
    { name: '灾难', value: '2340' },
    { name: '戏曲', value: '12132' },
    { name: '黑色电影', value: '28860' },
    { name: '脱口秀', value: '14163' }
  ];

  const yearValues = [{ name: '全部', value: '' }];
  for (let y = 2026; y >= 2000; y -= 1) {
    yearValues.push({ name: String(y), value: String(y) });
  }

  const sortValues = [
    { name: '人气', value: 'hits' },
    { name: '高分', value: 'score' },
    { name: '点赞', value: 'like' },
    { name: '时间', value: 'time' }
  ];

  const common = [
    { key: 'genre', name: '类型', init: '', value: typeValues },
    { key: 'year', name: '年代', init: '', value: yearValues },
    { key: 'sort', name: '排序', init: 'hits', value: sortValues }
  ];

  const filters = {};
  for (const item of CLASS_LIST) {
    filters[item.type_id] = common;
  }
  return filters;
}

function getBodyText(res) {
  const body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.toString();
  return String(body || "");
}

function absUrl(url, base = BASE_URL) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  try {
    return new URL(value, /^https?:\/\//i.test(base) ? base : `${BASE_URL}/`).toString();
  } catch {
    if (value.startsWith("/")) return `${BASE_URL}${value}`;
    return `${BASE_URL}/${value.replace(/^\/+/, "")}`;
  }
}

function stripHtml(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeSlash(url) {
  return String(url || "").replace(/\\\//g, "/");
}

async function fetchText(url, options = {}) {
  const res = await OmniBox.request(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": UA,
      Referer: options.referer || `${BASE_URL}/`,
      ...(options.headers || {})
    },
    timeout: options.timeout || 20000,
    body: options.body
  });

  if (!res || Number(res.statusCode) < 200 || Number(res.statusCode) >= 400) {
    throw new Error(`HTTP ${res?.statusCode || "unknown"} @ ${url}`);
  }

  return getBodyText(res);
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseVodCardsFromRoot($root) {
  const list = [];

  $root.find("a[href*='/v/']").each((_, el) => {
    const $a = $root.find(el).first();
    const href = $a.attr("href") || "";
    if (!/\/v\/\d+\.html$/i.test(href)) return;

    const title =
      $a.attr("title") ||
      stripHtml($a.find(".module-poster-item-title, .module-item-title, h3, h4").first().text()) ||
      stripHtml($a.text());
    if (!title) return;

    const pic =
      $a.find("img").attr("data-src") ||
      $a.find("img").attr("src") ||
      $a.find("img").attr("data-original") ||
      "";

    const remarks =
      stripHtml($a.find(".module-item-note, .module-item-text, .public-list-prb, .module-item-caption").first().text()) ||
      stripHtml($a.closest(".module-item, .module-poster-item").find(".module-item-note, .public-list-prb").first().text());

    const vodId = (href.match(/\/v\/(\d+)\.html/i) || [])[1] || "";
    list.push({
      vod_id: vodId,
      vod_name: title,
      vod_pic: absUrl(pic),
      vod_remarks: remarks
    });
  });

  return dedupeBy(list, (item) => item.vod_id);
}

function parseVodCards(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  return parseVodCardsFromRoot($.root());
}

function parseCategoryCards(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const blocks = $(".module .module-main");

  // 分类页优先跳过顶部“近期热门”等推荐区，尽量取后面的主列表。
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks.eq(i);
    const list = parseVodCardsFromRoot(block);
    if (list.length > 0) return list;
  }

  // 回退：如果页面结构变化，再退回全页通用解析。
  return parseVodCards(html);
}

function parseMenuClasses(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const list = [];
  $("#menu-netflix-header a[href]").each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") || "").trim();
    const name = stripHtml($a.text());
    if (!href || !name) return;
    const match = href.match(/^\/([^/]+)\/?$/);
    if (!match) return;
    const typeId = match[1];
    if (typeId === "") return;
    list.push({ type_id: typeId, type_name: name });
  });
  return dedupeBy(list.filter((item) => item.type_id !== ""), (item) => item.type_id);
}

function extractPageCount(html, currentPage = 1) {
  const matches = [...String(html || "").matchAll(/\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  const maxPage = matches.length ? Math.max(...matches) : currentPage;
  return maxPage || currentPage;
}

async function home(params, context) {
  try {
    const html = await fetchText(`${BASE_URL}/`);
    const classList = parseMenuClasses(html);
    const list = parseVodCards(html).slice(0, 40);
    await OmniBox.log("info", `[泰剧网][home] class=${classList.length} list=${list.length}`);
    return {
      class: classList.length ? classList : CLASS_LIST,
      filters: buildFilters(),
      list
    };
  } catch (e) {
    await OmniBox.log("error", `[泰剧网][home] ${e.message}`);
    return { class: CLASS_LIST, list: [] };
  }
}

async function category(params, context) {
  try {
    const categoryId = String(params?.categoryId || "thailand").trim();
    const page = Math.max(1, Number(params?.page || 1) || 1);
    const filters = params?.filters || params?.extend || {};
    const catCode = CATEGORY_CODE_MAP[categoryId] || '2';
    const genre = String(filters.genre || '').trim();
    const year = String(filters.year || '').trim();
    const sortRaw = String(filters.sort || 'hits').trim() || 'hits';
    const sort = sortRaw === 'time' ? '' : sortRaw;

    const path = page > 1
      ? `/all/${catCode}-${genre}-${year}-${sort}/page/${page}/`
      : `/all/${catCode}-${genre}-${year}-${sort}/`;
    const url = absUrl(path);
    const html = await fetchText(url);
    const list = parseCategoryCards(html);
    const pagecount = Math.max(page, extractPageCount(html, page));

    await OmniBox.log("info", `[泰剧网][category] category=${categoryId} page=${page} genre=${genre} year=${year} sortRaw=${sortRaw} sort=${sort} list=${list.length} pagecount=${pagecount}`);
    return {
      page,
      pagecount,
      total: list.length,
      list
    };
  } catch (e) {
    await OmniBox.log("error", `[泰剧网][category] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

function parsePlayUrlsFromPlayerPage(html) {
  const raw = String(html || "");
  const match = raw.match(/const\s+playUrls\s*=\s*(\{[\s\S]*?\});/i);
  if (!match) return [];

  try {
    const json = decodeSlash(match[1]);
    const playMap = JSON.parse(json);
    return Object.entries(playMap || {})
      .map(([name, url]) => ({ name, url: String(url || "").trim() }))
      .filter((item) => /^https?:\/\//i.test(item.url));
  } catch {
    return [];
  }
}

async function detail(params, context) {
  try {
    const videoId = String(params?.videoId || "").trim();
    if (!videoId) return { list: [] };

    const detailUrl = /^https?:\/\//i.test(videoId) ? videoId : `${BASE_URL}/v/${videoId}.html`;
    const html = await fetchText(detailUrl);
    const $ = cheerio.load(html, { decodeEntities: false });

    const title = stripHtml($("title").first().text())
      .replace(/》.*$/, "")
      .replace(/^《/, "")
      .trim();
    const poster = $(".detail-poster img, .module-item-pic img, img[data-src]").first();
    const vodPic = absUrl(poster.attr("data-src") || poster.attr("src") || "");
    const content = stripHtml($(".detail-info .detail-content, .detail-desc, .module-info-introduction-content, .video-info-content").first().text()) ||
      stripHtml($("meta[name='description']").attr("content") || "");

    const typeName = stripHtml($(".info-tag a[rel*='category']").first().text());
    const year = stripHtml($(".info-tag a[href*='/year/']").first().text());
    const remarks = stripHtml($(".module-info-item-content, .detail-sketch").first().text());

    const episodes = [];
    $(".ep-all a.list-ep[href*='/p/']").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href") || "";
      const name = stripHtml($a.text()) || stripHtml($a.attr("title") || "");
      if (!href || !name) return;
      episodes.push({
        name,
        playId: absUrl(href, detailUrl)
      });
    });

    const playSources = episodes.length ? [{ name: "在线播放", episodes }] : [];
    await OmniBox.log("info", `[泰剧网][detail] videoId=${videoId} episodes=${episodes.length}`);

    return {
      list: [
        {
          vod_id: videoId,
          vod_name: title || `视频${videoId}`,
          vod_pic: vodPic,
          vod_content: content,
          vod_year: year,
          type_name: typeName,
          vod_remarks: remarks,
          vod_play_sources: playSources
        }
      ]
    };
  } catch (e) {
    await OmniBox.log("error", `[泰剧网][detail] ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = String(params?.keyword || params?.wd || "").trim();
    const page = Math.max(1, Number(params?.page || 1) || 1);
    if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

    const key = keyword.toLowerCase();
    const searchPages = [
      `${BASE_URL}/`,
      ...Object.values(CATEGORY_LIBRARY_PATH).map((path) => absUrl(path))
    ];

    const collected = [];
    for (const url of searchPages) {
      try {
        const html = await fetchText(url);
        const list = url === `${BASE_URL}/` ? parseVodCards(html) : parseCategoryCards(html);
        collected.push(...list);
      } catch (err) {
        await OmniBox.log("warn", `[泰剧网][search] page.skip url=${url} message=${err.message}`);
      }
    }

    const merged = dedupeBy(collected, (item) => item.vod_id);
    const matched = merged.filter((item) => String(item.vod_name || "").toLowerCase().includes(key));

    await OmniBox.log("info", `[泰剧网][search] keyword=${keyword} totalScanned=${merged.length} list=${matched.length}`);
    return { page, pagecount: 1, total: matched.length, list: matched };
  } catch (e) {
    await OmniBox.log("error", `[泰剧网][search] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  try {
    const playId = String(params?.playId || "").trim();
    if (!playId) return { urls: [], parse: 0, header: {} };

    const html = await fetchText(playId, { referer: `${BASE_URL}/` });
    const urls = parsePlayUrlsFromPlayerPage(html);
    await OmniBox.log("info", `[泰剧网][play] playId=${playId} lines=${urls.length}`);

    if (!urls.length) {
      return {
        urls: [{ name: "播放页", url: playId }],
        parse: 1,
        header: {
          "User-Agent": UA,
          Referer: `${BASE_URL}/`
        }
      };
    }

    return {
      urls: urls.map((item) => ({ name: item.name, url: item.url })),
      parse: 0,
      header: {
        "User-Agent": UA,
        Referer: playId
      }
    };
  } catch (e) {
    await OmniBox.log("error", `[泰剧网][play] ${e.message}`);
    return { urls: [], parse: 0, header: {} };
  }
}
