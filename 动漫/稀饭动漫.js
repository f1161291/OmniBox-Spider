// @name 稀饭动漫
// @author 梦
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/%E5%8A%A8%E6%BC%AB/%E7%A8%80%E9%A5%AD%E5%8A%A8%E6%BC%AB.js

/**
 * ============================================================================
 * 稀饭动漫
 * 站点：https://dm.xifanacg.com/
 * 分类：连载新番 / 完结旧番 / 剧场版 / 美漫
 * 说明：
 * - 分类走 /index.php/ds_api/vod POST 接口
 * - 搜索走 /index.php/ajax/suggest
 * - 详情页资源列表为 /watch/{id}/{sid}/{nid}.html
 * - 播放页 player_aaaa.url 可能为直链，也兼容 encrypt=1/2 情况
 * ============================================================================
 */
const axios = require('axios');
const https = require('https');
const OmniBox = require('omnibox_sdk');

const HOST = 'https://dm.xifanacg.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const PAGE_LIMIT = 40;
const DANMU_API = process.env.DANMU_API || '';

const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false, family: 4 }),
  headers: {
    'User-Agent': UA,
    'Referer': HOST + '/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

const FILTERS = {
  '1': [
    {
      key: 'class',
      name: '类型',
      value: [
        { n: '全部', v: '' },
        { n: '搞笑', v: '搞笑' },
        { n: '原创', v: '原创' },
        { n: '轻小说改', v: '轻小说改' },
        { n: '恋爱', v: '恋爱' },
        { n: '百合', v: '百合' },
        { n: '漫改', v: '漫改' },
        { n: '校园', v: '校园' },
        { n: '战斗', v: '战斗' },
        { n: '治愈', v: '治愈' },
        { n: '奇幻', v: '奇幻' },
        { n: '日常', v: '日常' },
        { n: '青春', v: '青春' },
        { n: '乙女向', v: '乙女向' },
        { n: '悬疑', v: '悬疑' },
        { n: '后宫', v: '后宫' },
        { n: '科幻', v: '科幻' },
        { n: '冒险', v: '冒险' },
        { n: '热血', v: '热血' },
        { n: '异世界', v: '异世界' },
        { n: '游戏改', v: '游戏改' },
        { n: '音乐', v: '音乐' },
        { n: '偶像', v: '偶像' },
        { n: '美食', v: '美食' },
        { n: '耽美', v: '耽美' },
      ],
    },
    { key: 'area', name: '地区', value: [{ n: '全部', v: '' }, { n: '日本', v: '日本' }] },
    {
      key: 'year',
      name: '年份',
      value: [
        { n: '全部', v: '' },
        { n: '2026', v: '2026' }, { n: '2025', v: '2025' }, { n: '2024', v: '2024' },
        { n: '2023', v: '2023' }, { n: '2022', v: '2022' }, { n: '2021', v: '2021' },
        { n: '2020', v: '2020' }, { n: '2019', v: '2019' }, { n: '2018', v: '2018' },
        { n: '2017', v: '2017' }, { n: '2016', v: '2016' }, { n: '2015', v: '2015' },
        { n: '2014', v: '2014' }, { n: '2013', v: '2013' }, { n: '2012', v: '2012' },
        { n: '2011', v: '2011' }, { n: '2010', v: '2010' }, { n: '2009', v: '2009' },
        { n: '2008', v: '2008' }, { n: '2007', v: '2007' }, { n: '2006', v: '2006' },
        { n: '2005', v: '2005' },
      ],
    },
    { key: 'by', name: '排序', value: [{ n: '最新', v: 'time' }, { n: '最热', v: 'hits' }, { n: '评分', v: 'score' }] },
  ],
  '2': [
    {
      key: 'class',
      name: '类型',
      value: [
        { n: '全部', v: '' },
        { n: '搞笑', v: '搞笑' },
        { n: '原创', v: '原创' },
        { n: '轻小说改', v: '轻小说改' },
        { n: '恋爱', v: '恋爱' },
        { n: '百合', v: '百合' },
        { n: '漫改', v: '漫改' },
        { n: '校园', v: '校园' },
        { n: '战斗', v: '战斗' },
        { n: '治愈', v: '治愈' },
        { n: '奇幻', v: '奇幻' },
        { n: '日常', v: '日常' },
        { n: '青春', v: '青春' },
        { n: '乙女向', v: '乙女向' },
        { n: '悬疑', v: '悬疑' },
        { n: '后宫', v: '后宫' },
        { n: '科幻', v: '科幻' },
        { n: '冒险', v: '冒险' },
        { n: '热血', v: '热血' },
        { n: '异世界', v: '异世界' },
        { n: '游戏改', v: '游戏改' },
        { n: '音乐', v: '音乐' },
        { n: '偶像', v: '偶像' },
        { n: '美食', v: '美食' },
        { n: '耽美', v: '耽美' },
      ],
    },
    { key: 'area', name: '地区', value: [{ n: '全部', v: '' }, { n: '日本', v: '日本' }, { n: '中国', v: '中国' }, { n: '欧美', v: '欧美' }] },
    {
      key: 'year',
      name: '年份',
      value: [
        { n: '全部', v: '' },
        { n: '2026', v: '2026' }, { n: '2025', v: '2025' }, { n: '2024', v: '2024' },
        { n: '2023', v: '2023' }, { n: '2022', v: '2022' }, { n: '2021', v: '2021' },
        { n: '2020', v: '2020' }, { n: '2019', v: '2019' }, { n: '2018', v: '2018' },
        { n: '2017', v: '2017' }, { n: '2016', v: '2016' }, { n: '2015', v: '2015' },
        { n: '2014', v: '2014' }, { n: '2013', v: '2013' }, { n: '2012', v: '2012' },
        { n: '2011', v: '2011' }, { n: '2010', v: '2010' }, { n: '2009', v: '2009' },
        { n: '2008', v: '2008' }, { n: '2007', v: '2007' }, { n: '2006', v: '2006' },
        { n: '2005', v: '2005' },
      ],
    },
    { key: 'by', name: '排序', value: [{ n: '最新', v: 'time' }, { n: '最热', v: 'hits' }, { n: '评分', v: 'score' }] },
  ],
  '3': [
    {
      key: 'class',
      name: '类型',
      value: [
        { n: '全部', v: '' },
        { n: '剧场版', v: '剧场版' },
        { n: '动画电影', v: '动画电影' },
        { n: '奇幻', v: '奇幻' },
        { n: '战斗', v: '战斗' },
        { n: '恋爱', v: '恋爱' },
        { n: '冒险', v: '冒险' },
      ],
    },
    { key: 'area', name: '地区', value: [{ n: '全部', v: '' }, { n: '日本', v: '日本' }, { n: '中国', v: '中国' }, { n: '欧美', v: '欧美' }] },
    {
      key: 'year',
      name: '年份',
      value: [
        { n: '全部', v: '' },
        { n: '2026', v: '2026' }, { n: '2025', v: '2025' }, { n: '2024', v: '2024' },
        { n: '2023', v: '2023' }, { n: '2022', v: '2022' }, { n: '2021', v: '2021' },
        { n: '2020', v: '2020' }, { n: '2019', v: '2019' }, { n: '2018', v: '2018' },
        { n: '2017', v: '2017' }, { n: '2016', v: '2016' }, { n: '2015', v: '2015' },
        { n: '2014', v: '2014' }, { n: '2013', v: '2013' }, { n: '2012', v: '2012' },
        { n: '2011', v: '2011' }, { n: '2010', v: '2010' },
      ],
    },
    { key: 'by', name: '排序', value: [{ n: '最新', v: 'time' }, { n: '最热', v: 'hits' }, { n: '评分', v: 'score' }] },
  ],
  '21': [
    {
      key: 'class',
      name: '类型',
      value: [
        { n: '全部', v: '' },
        { n: '美漫', v: '美漫' },
        { n: '搞笑', v: '搞笑' },
        { n: '科幻', v: '科幻' },
        { n: '奇幻', v: '奇幻' },
        { n: '冒险', v: '冒险' },
      ],
    },
    { key: 'area', name: '地区', value: [{ n: '全部', v: '' }, { n: '欧美', v: '欧美' }, { n: '美国', v: '美国' }] },
    {
      key: 'year',
      name: '年份',
      value: [
        { n: '全部', v: '' },
        { n: '2026', v: '2026' }, { n: '2025', v: '2025' }, { n: '2024', v: '2024' },
        { n: '2023', v: '2023' }, { n: '2022', v: '2022' }, { n: '2021', v: '2021' },
        { n: '2020', v: '2020' }, { n: '2019', v: '2019' }, { n: '2018', v: '2018' },
        { n: '2017', v: '2017' }, { n: '2016', v: '2016' }, { n: '2015', v: '2015' },
      ],
    },
    { key: 'by', name: '排序', value: [{ n: '最新', v: 'time' }, { n: '最热', v: 'hits' }, { n: '评分', v: 'score' }] },
  ],
};

function normalizeFilters(filters) {
  if (!filters || typeof filters !== 'object') {
    return filters;
  }

  const normalized = {};
  for (const key of Object.keys(filters)) {
    const group = Array.isArray(filters[key]) ? filters[key] : [];
    normalized[key] = group.map((item) => ({
      ...item,
      init: typeof item?.init === 'undefined' ? '' : item.init,
      value: Array.isArray(item?.value)
        ? item.value.map((entry) => {
            if (!entry || typeof entry !== 'object') return entry;
            if ('name' in entry || 'value' in entry) {
              return {
                name: entry.name ?? entry.n ?? '',
                value: entry.value ?? entry.v ?? '',
              };
            }
            return {
              name: entry.n ?? '',
              value: entry.v ?? '',
            };
          })
        : [],
    }));
  }
  return normalized;
}

const NORMALIZED_FILTERS = normalizeFilters(FILTERS);

const CLASSES = [
  { type_id: '1', type_name: '连载新番' },
  { type_id: '2', type_name: '完结旧番' },
  { type_id: '3', type_name: '剧场版' },
  { type_id: '21', type_name: '美漫' },
];

const logInfo = (message, data = null) => {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log('info', `[稀饭动漫-DEBUG] ${output}`);
};

const logError = (message, error) => {
  OmniBox.log('error', `[稀饭动漫-DEBUG] ${message}: ${error.message || error}`);
};

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function pickParamValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      const s = String(value).trim();
      if (s) return s;
      continue;
    }
    if (typeof value === 'object') {
      const nested = pickParamValue(
        value.vod_id,
        value.videoId,
        value.play_id,
        value.playId,
        value.categoryId,
        value.type_id,
        value.tid,
        value.id,
        value.url,
        value.href,
        value.path
      );
      if (nested) return nested;
    }
  }
  return '';
}

function absolutize(url) {
  const value = pickParamValue(url);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  try {
    return new URL(value.startsWith('/') ? value : `/${value}`, HOST).toString();
  } catch (_) {
    return '';
  }
}

function decodePlayerUrl(encoded) {
  try {
    const first = Buffer.from(String(encoded || ''), 'base64').toString('utf8');
    return decodeURIComponent(first);
  } catch (_) {
    return String(encoded || '');
  }
}

function preprocessTitle(title) {
  if (!title) return '';
  return title
    .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, ' ')
    .replace(/[hH]\.?26[45]/g, ' ')
    .replace(/BluRay|WEB-DL|HDR|REMUX/gi, ' ')
    .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, ' ');
}

function chineseToArabic(cn) {
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (!isNaN(cn)) return parseInt(cn, 10);
  if (cn.length === 1) return map[cn] || cn;
  if (cn.length === 2) {
    if (cn[0] === '十') return 10 + map[cn[1]];
    if (cn[1] === '十') return map[cn[0]] * 10;
  }
  if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
  return cn;
}

function extractEpisode(title) {
  if (!title) return '';
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
    if (!['720', '1080', '480'].includes(num)) return num;
  }
  return '';
}

function buildFileNameForDanmu(vodName, episodeTitle) {
  if (!vodName) return '';
  if (!episodeTitle || episodeTitle === '正片' || episodeTitle === '播放') return vodName;
  const digits = extractEpisode(episodeTitle);
  if (digits) {
    const epNum = parseInt(digits, 10);
    if (epNum > 0) return epNum < 10 ? `${vodName} S01E0${epNum}` : `${vodName} S01E${epNum}`;
  }
  return vodName;
}

async function matchDanmu(fileName) {
  if (!DANMU_API || !fileName) return [];
  try {
    const response = await OmniBox.request(`${DANMU_API}/api/v2/match`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ fileName }),
    });
    if (response.statusCode !== 200) return [];
    const matchData = safeJsonParse(response.body || '{}', {});
    if (!matchData.isMatched) return [];
    const firstMatch = (matchData.matches || [])[0];
    if (!firstMatch?.episodeId) return [];
    const danmakuURL = `${DANMU_API}/api/v2/comment/${firstMatch.episodeId}?format=xml`;
    const danmakuName = [firstMatch.animeTitle, firstMatch.episodeTitle].filter(Boolean).join(' - ') || '弹幕';
    return [{ name: danmakuName, url: danmakuURL }];
  } catch (_) {
    return [];
  }
}

function extractCards(html) {
  const results = [];
  const blocks = String(html || '').match(/<div class="public-list-box[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) || [];
  for (const block of blocks) {
    const href = (block.match(/class="(?:public-list-exp|time-title)[^"]*"[^>]*href="([^"]+)"/) || [])[1] || '';
    const title = (block.match(/class="public-list-exp"[^>]*title="([^"]+)"/) || [])[1]
      || (block.match(/class="time-title[^"]*"[^>]*title="([^"]+)"/) || [])[1]
      || stripTags((block.match(/class="time-title[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const pic = (block.match(/data-src="([^"]+)"/) || [])[1]
      || (block.match(/src="([^"]+)"/) || [])[1]
      || '';
    const remarks = (block.match(/<span class="public-list-prb[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
    if (!href || !title) continue;
    results.push({
      vod_id: absolutize(href),
      vod_name: stripTags(title),
      vod_pic: absolutize(pic),
      vod_remarks: stripTags(remarks),
    });
  }
  return results;
}

function parseHomeSlides(html) {
  const list = [];
  const reg = /<div class="swiper-slide">[\s\S]*?<div class="swiper-lazy[^"]*" data-background="([^"]+)"[\s\S]*?<a class="lank" href="([^"]+)"[\s\S]*?<h3 class="slide-info-title hide">([\s\S]*?)<\/h3>[\s\S]*?<li>([^<]*)<\/li>/g;
  let m;
  while ((m = reg.exec(String(html || ''))) !== null) {
    list.push({
      vod_id: absolutize(m[2]),
      vod_name: stripTags(m[3]),
      vod_pic: absolutize(m[1]),
      vod_remarks: stripTags(m[4]),
    });
  }
  return list;
}

function dedupeByVodId(list) {
  const seen = new Set();
  const result = [];
  for (const item of list || []) {
    const key = item?.vod_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function home() {
  try {
    const { data: html } = await axiosInstance.get(HOST + '/');
    const list = dedupeByVodId([
      ...parseHomeSlides(html),
      ...extractCards(html),
    ]).slice(0, 40);
    logInfo('home ok', { list: list.length });
    return {
      class: CLASSES,
      filters: NORMALIZED_FILTERS,
      list,
    };
  } catch (e) {
    logError('home failed', e);
    return { class: CLASSES, filters: NORMALIZED_FILTERS, list: [] };
  }
}

async function category(params) {
  const tid = pickParamValue(params.tid, params.type_id, params.categoryId, params.id) || '1';
  const page = Number(params.page || params.pg || 1);
  const extend = { ...(params.extend || {}), ...(params.filters || {}) };
  const body = new URLSearchParams();
  body.set('type', tid);
  body.set('page', String(page));
  body.set('by', String(extend.by || 'time'));
  if (extend.class) body.set('class', String(extend.class));
  if (extend.area) body.set('area', String(extend.area));
  if (extend.year) body.set('year', String(extend.year));

  try {
    const { data } = await axiosInstance.post(`${HOST}/index.php/ds_api/vod`, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${HOST}/type/${tid}.html`,
      },
    });
    const payload = typeof data === 'string' ? safeJsonParse(data, {}) : (data || {});
    const list = (payload.list || []).map((item) => ({
      vod_id: absolutize(item.url || `/bangumi/${item.vod_id}.html`),
      vod_name: item.vod_name || '',
      vod_pic: absolutize(String(item.vod_pic || '').replace(/\\\//g, '/')),
      vod_remarks: item.vod_remarks || '',
    })).filter((item) => item.vod_id && item.vod_name);

    return {
      list,
      page: Number(payload.page || page),
      pagecount: Number(payload.pagecount || page),
      limit: Number(payload.limit || PAGE_LIMIT),
      total: Number(payload.total || list.length),
      filters: NORMALIZED_FILTERS[tid] || [],
    };
  } catch (e) {
    logError('category failed', e);
    return { list: [], page, pagecount: page, limit: PAGE_LIMIT, total: 0, filters: NORMALIZED_FILTERS[tid] || [] };
  }
}

async function search(params) {
  const keyword = String(params.keyword || params.key || params.wd || '').trim();
  const page = Math.max(Number(params.page || params.pg || 1) || 1, 1);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
  try {
    const { data } = await axiosInstance.get(`${HOST}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(keyword)}`, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${HOST}/search/wd/${encodeURIComponent(keyword)}.html`,
      },
    });
    const payload = typeof data === 'string' ? safeJsonParse(data, {}) : (data || {});
    const list = (payload.list || []).map((item) => ({
      vod_id: absolutize(`/bangumi/${item.id}.html`),
      vod_name: item.name || '',
      vod_pic: absolutize(item.pic || ''),
      vod_remarks: '',
    })).filter((item) => item.vod_id && item.vod_name);
    return {
      page: Number(payload.page || page),
      pagecount: Number(payload.pagecount || (list.length ? page : 0)),
      limit: Number(payload.limit || list.length),
      total: Number(payload.total || list.length),
      list,
      keyword,
    };
  } catch (e) {
    logError('search failed', e);
    return { page, pagecount: 0, limit: 0, total: 0, list: [], keyword };
  }
}

async function detail(params) {
  const vodId = pickParamValue(params.vod_id, params.videoId, params.id, params);
  const url = absolutize(vodId);
  if (!url) return { list: [] };

  try {
    const { data: html } = await axiosInstance.get(url);
    const title = stripTags((html.match(/<h3>([\s\S]*?)<\/h3>/i) || [])[1] || (html.match(/<title>(.*?)<\/title>/i) || [])[1] || '').replace(/\s*-\s*免费高清动漫分享.*$/i, '');
    const pic = absolutize((html.match(/<div class="detail-pic">[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"/i) || [])[1] || '');
    const remarks = stripTags((html.match(/<span class="slide-info-remarks cor5">([\s\S]*?)<\/span>/i) || [])[1] || '');
    const year = stripTags((html.match(/<span class="slide-info-remarks"><a href="\/search\/year\/[^"]+">([\s\S]*?)<\/a>/i) || [])[1] || '');
    const area = stripTags((html.match(/<span class="slide-info-remarks"><a href="\/search\/area\/[^"]+">([\s\S]*?)<\/a>/i) || [])[1] || '');
    const director = stripTags((html.match(/导演\s*:<\/strong>([\s\S]*?)<\/div>/i) || [])[1] || '');
    const actor = stripTags((html.match(/演员\s*:<\/strong>([\s\S]*?)<\/div>/i) || [])[1] || '');
    const typeName = stripTags((html.match(/类型\s*:<\/strong>([\s\S]*?)<\/div>/i) || [])[1] || '');
    const content = stripTags((html.match(/<div id="height_limit" class="text cor3">([\s\S]*?)<\/div>/i) || [])[1] || '');

    const tabNames = [];
    const tabReg = /<a class="swiper-slide">[\s\S]*?&nbsp;([^<]+)<span class="badge">(\d+)<\/span><\/a>/g;
    let tabMatch;
    while ((tabMatch = tabReg.exec(html)) !== null) {
      tabNames.push(stripTags(tabMatch[1]));
    }

    const vodPlaySources = [];
    const anthBlockMatch = html.match(/<div class="anthology-list[\s\S]*?<script>\$\("\.anthology-tab a"\)\.eq\(0\)/);
    const anthBlock = anthBlockMatch ? anthBlockMatch[0] : html;
    const boxReg = /<div class="anthology-list-box[^>]*>[\s\S]*?<ul class="anthology-list-play size">([\s\S]*?)<\/ul>[\s\S]*?<\/div>\s*<\/div>/g;
    let boxMatch;
    let lineIndex = 0;
    while ((boxMatch = boxReg.exec(anthBlock)) !== null) {
      const episodes = [];
      const epReg = /<a class="[^"]*" href="([^"]*\/watch[^"]+)"[^>]*>\s*(?:<span>)?([^<]+)(?:<\/span>)?\s*<\/a>/g;
      let epMatch;
      while ((epMatch = epReg.exec(boxMatch[1])) !== null) {
        const playUrl = epMatch[1];
        const epName = stripTags(epMatch[2]);
        if (!playUrl.includes('/watch/')) continue;
        episodes.push({
          name: epName,
          playId: absolutize(playUrl),
        });
      }
      if (episodes.length) {
        vodPlaySources.push({
          name: tabNames[lineIndex] || `线路${lineIndex + 1}`,
          episodes,
        });
      }
      lineIndex += 1;
    }

    if (!vodPlaySources.length) {
      const fallbackEpisodes = [];
      const epReg = /href="([^"]*\/watch[^"]+)"[^>]*>\s*(?:<span>)?([^<]+)(?:<\/span>)?\s*<\/a>/g;
      let epMatch;
      while ((epMatch = epReg.exec(html)) !== null) {
        const playUrl = epMatch[1];
        if (!playUrl.includes('/watch/')) continue;
        fallbackEpisodes.push({
          name: stripTags(epMatch[2]),
          playId: absolutize(playUrl),
        });
      }
      if (fallbackEpisodes.length) {
        vodPlaySources.push({ name: '默认', episodes: fallbackEpisodes });
      }
    }

    return {
      list: [{
        vod_id: url,
        vod_name: title,
        vod_pic: pic,
        vod_remarks: remarks,
        vod_year: year,
        vod_area: area,
        vod_director: director,
        vod_actor: actor,
        type_name: typeName,
        vod_content: content,
        vod_play_sources: vodPlaySources,
      }],
    };
  } catch (e) {
    logError('detail failed', e);
    return { list: [] };
  }
}

async function play(params) {
  const playPath = pickParamValue(params.play_id, params.playId, params.id, params);
  const url = absolutize(playPath);
  if (!url) return { urls: [], parse: 0 };

  try {
    const { data: html } = await axiosInstance.get(url, {
      headers: {
        'User-Agent': UA,
        'Referer': url,
        'Origin': HOST,
      },
    });
    const playerMatch = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})<\/script>/i);
    if (!playerMatch) throw new Error('player_aaaa not found');
    const player = safeJsonParse(playerMatch[1], {});

    let playUrl = String(player.url || '').replace(/\\\//g, '/');
    if (Number(player.encrypt) === 2) playUrl = decodePlayerUrl(playUrl);
    else if (Number(player.encrypt) === 1) playUrl = decodeURIComponent(playUrl);
    if (!/^https?:\/\//i.test(playUrl)) playUrl = absolutize(playUrl);

    const response = {
      urls: [{ name: '默认线路', url: playUrl }],
      parse: /\.(m3u8|mp4|m4a|mp3)(\?|$)/i.test(playUrl) ? 0 : 1,
      header: {
        'User-Agent': UA,
        'Referer': url,
        'Origin': HOST,
      },
    };

    const vodName = player?.vod_data?.vod_name || '';
    const episodeName = stripTags((html.match(/<li class="bj3 border on[\s\S]*?<span>([^<]+)<\/span>/i) || [])[1] || '');
    if (DANMU_API && vodName) {
      const fileName = buildFileNameForDanmu(vodName, episodeName);
      if (fileName) {
        const danmakuList = await matchDanmu(fileName);
        if (danmakuList.length) response.danmaku = danmakuList;
      }
    }

    return response;
  } catch (e) {
    logError('play failed', e);
    return {
      urls: [{ name: '默认线路', url }],
      parse: 0,
      header: {
        'User-Agent': UA,
        'Referer': url,
        'Origin': HOST,
      },
    };
  }
}

module.exports = { home, category, search, detail, play };

const runner = require('spider_runner');
runner.run(module.exports);
