// @name 奈飞工厂
// @author @lucky_TJQ
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios,cheerio
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/奈飞工厂.js
// @indexs 1

/**
 * ============================================================================
 * 奈飞工厂 (NetflixGC / dsn2 主题)
 * 站点：https://www.netflixgc.com
 *
 * 站点协议：
 * - 首页：伪静态 /，卡片 class=public-list-box，首屏 hero class=slid-e-list-box
 * - 分类：前台 /vodshow/{type}-----------.html 为空壳，真实数据由 AJAX 拉取：
 *         POST /index.php/ds_api/vod  { type, page, by, class, area, year, lang, letter }
 *         排序 by ∈ time / hits / score
 * - 搜索：SSR 页 /vodsearch/{keyword}----------{page}---.html，条目 class=search-list
 *         备用 /index.php/ajax/suggest?mid=1&wd=xxx
 * - 详情：/voddetail/{id}.html
 *         线路名：.anthology-tab a.swiper-slide（末尾 .badge 是集数，要剔除）
 *         分集：  .anthology-list .anthology-list-box → a[href=/vodplay/{id}-{sid}-{nid}.html]
 * - 播放：/vodplay/{id}-{sid}-{nid}.html 内 player_aaaa
 *         encrypt=2 → base64 后再 URL 解码；偶发 %uXXXX 转义需二次还原
 * ============================================================================
 */
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const crypto = require('crypto');

let OmniBox;
try {
  OmniBox = require('omnibox_sdk');
} catch (_) {
  OmniBox = {
    log(level, message) {
      console.log(`[${level}] ${message}`);
    },
  };
}

const runner = (() => {
  try {
    return require('spider_runner');
  } catch (_) {
    return { run() {} };
  }
})();

// ========================= 基础配置 =========================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HOSTS = ['https://www.netflixgc.com', 'https://www.netflixgc.net', 'https://www.netflixgc.org'];

function normalizeHost(host) {
  const value = String(host || '').trim();
  if (!value) return '';
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, '');
}

const HOST_CANDIDATES = (() => {
  const list = [];
  const fromEnv = normalizeHost(process.env.NETFLIXGC_HOST || '');
  if (fromEnv) list.push(fromEnv);
  for (const host of DEFAULT_HOSTS) {
    if (!list.includes(host)) list.push(host);
  }
  return list;
})();

let ACTIVE_HOST = HOST_CANDIDATES[0];

// 弹幕（复用统一变量名）
const DANMU_API = process.env.DANMU_API || '';

// CF 盾绕过（仅在显式配置时才启用，未配置时零成本）
const FLARESOLVERR_URL = String(
  process.env.NETFLIXGC_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || ''
).trim();
const CF_PAGE_CACHE_PREFIX = process.env.NETFLIXGC_CF_PAGE_CACHE_KEY_PREFIX || 'netflixgc:page:';
const CF_PAGE_CACHE_TTL = Number(process.env.NETFLIXGC_CF_PAGE_CACHE_TTL || 3600);
const CF_AUTO = String(process.env.NETFLIXGC_CF_AUTO || '1') !== '0';

// 缓存 TTL（秒）
const TTL_HOME = Number(process.env.NETFLIXGC_TTL_HOME || 600);
const TTL_CATEGORY = Number(process.env.NETFLIXGC_TTL_CATEGORY || 600);
const TTL_SEARCH = Number(process.env.NETFLIXGC_TTL_SEARCH || 300);
const TTL_DETAIL = Number(process.env.NETFLIXGC_TTL_DETAIL || 1800);

const LOG_PREFIX = '[netflixgc]';

const logInfo = (message, data) => {
  const output = data === undefined ? message : `${message}: ${JSON.stringify(data)}`;
  try {
    OmniBox.log('info', `${LOG_PREFIX} ${output}`);
  } catch (_) {
    console.log(`${LOG_PREFIX} ${output}`);
  }
};

const logError = (message, error) => {
  const text = error && error.message ? error.message : String(error || '');
  try {
    OmniBox.log('error', `${LOG_PREFIX} ${message}: ${text}`);
  } catch (_) {
    console.log(`${LOG_PREFIX} ${message}: ${text}`);
  }
};

// ========================= 通用工具 =========================

const axiosInstance = axios.create({
  timeout: 20000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false, family: 4 }),
  maxRedirects: 5,
  validateStatus: () => true,
});

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function unescapeBackslashes(text) {
  return String(text || '').replace(/\\\//g, '/');
}

function encodeMeta(obj) {
  try {
    return Buffer.from(JSON.stringify(obj || {}), 'utf8').toString('base64');
  } catch (_) {
    return '';
  }
}

function decodeMeta(text) {
  try {
    return JSON.parse(Buffer.from(String(text || ''), 'base64').toString('utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/gi, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlaceholderImage(url) {
  const value = String(url || '').trim();
  if (!value) return true;
  if (/^data:/i.test(value)) return true;
  if (/base64/i.test(value)) return true;
  if (/loading|placeholder|none\.png|null\.png/i.test(value)) return true;
  return false;
}

function absolutize(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${ACTIVE_HOST}${value}`;
  return `${ACTIVE_HOST}/${value}`;
}

/** 从任意形态（URL / 路径 / 纯 id）里取站点内路径 */
function toSitePath(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return `${parsed.pathname}${parsed.search}`;
    } catch (_) {
      return value;
    }
  }
  if (value.startsWith('//')) {
    try {
      const parsed = new URL(`https:${value}`);
      return `${parsed.pathname}${parsed.search}`;
    } catch (_) {
      return value;
    }
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function extractVodId(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const detailMatch = value.match(/\/voddetail\/(\d+)\.html/i);
  if (detailMatch) return detailMatch[1];
  const playMatch = value.match(/\/vodplay\/(\d+)-(\d+)-(\d+)\.html/i);
  if (playMatch) return playMatch[1];
  const pureMatch = value.match(/^(\d{1,10})$/);
  if (pureMatch) return pureMatch[1];
  const anyMatch = value.match(/(\d{2,10})/);
  return anyMatch ? anyMatch[1] : '';
}

function pickParamValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
      continue;
    }
    if (typeof value === 'object') {
      const nested = pickParamValue(
        value.vod_id,
        value.videoId,
        value.video_id,
        value.id,
        value.ids,
        value.playId,
        value.play_id,
        value.categoryId,
        value.type_id,
        value.tid,
        value.url,
        value.href
      );
      if (nested) return nested;
    }
  }
  return '';
}

/** 缓存 key 归一化：保留可读前缀 + 短哈希，避免超过宿主 key 长度上限 */
function buildCacheKey(prefix, raw) {
  const text = String(raw || '');
  if (text.length <= 120) return `${prefix}:${text}`;
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 32);
  return `${prefix}:h${hash}`;
}

async function getCachedText(key) {
  try {
    if (!OmniBox || typeof OmniBox.getCache !== 'function') return null;
    const value = await OmniBox.getCache(key);
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && typeof value.body === 'string') return value.body;
    return null;
  } catch (error) {
    logInfo('读取缓存失败', { key, error: error.message });
    return null;
  }
}

async function setCachedText(key, text, ttl) {
  try {
    if (!OmniBox || typeof OmniBox.setCache !== 'function') return;
    if (!text || text.length < 200) return;
    await OmniBox.setCache(key, text, Number(ttl) || 600);
  } catch (error) {
    logInfo('写入缓存失败', { key, error: error.message });
  }
}

// ========================= CF 盾（可选） =========================

function cookiesArrayToString(cookies) {
  if (!Array.isArray(cookies)) return '';
  return cookies
    .filter((item) => item && item.name)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');
}

function isBlockedHtml(statusCode, body) {
  const text = String(body || '');
  if (statusCode === 403 || statusCode === 503) {
    if (/cdn-cgi|challenge-platform|Just a moment|Attention Required/i.test(text)) return true;
  }
  if (/cf-browser-verification|cf_chl_opt|_cf_chl_opt/i.test(text)) return true;
  return false;
}

async function fetchPageWithFlareSolverr(targetUrl) {
  if (!FLARESOLVERR_URL) return null;
  try {
    const startedAt = Date.now();
    const res = await axiosInstance.post(
      FLARESOLVERR_URL,
      { cmd: 'request.get', url: targetUrl, maxTimeout: 60000 },
      { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
    );
    const data = res.data || {};
    if (data.status !== 'ok' || !data.solution) {
      logInfo('FlareSolverr 返回异常', { message: data.message || '', status: data.status });
      return null;
    }
    const solution = data.solution || {};
    const cookie = cookiesArrayToString(solution.cookies);
    const body = String(solution.response || '');
    if ((!cookie && !body) || !body) {
      logInfo('FlareSolverr 未拿到页面', { cookieLen: cookie.length });
      return null;
    }
    logInfo('FlareSolverr 已返回页面', {
      url: targetUrl,
      status: solution.status,
      cookies: Array.isArray(solution.cookies) ? solution.cookies.length : 0,
      bodyLen: body.length,
      cost: `${Date.now() - startedAt}ms`,
    });
    await setCachedText(buildCacheKey(CF_PAGE_CACHE_PREFIX, targetUrl), body, CF_PAGE_CACHE_TTL);
    return { body, statusCode: Number(solution.status) || 200, cookie };
  } catch (error) {
    logInfo('FlareSolverr 绕过失败', { error: error.message });
    return null;
  }
}

// ========================= 请求层 =========================

function defaultHeaders(refererPath) {
  const referer = refererPath ? `${ACTIVE_HOST}${toSitePath(refererPath)}` : `${ACTIVE_HOST}/`;
  return {
    'User-Agent': UA,
    Referer: referer,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}

/** 站点内请求，带缓存 + 多域名容灾 + 可选 CF 绕过 */
async function requestSite(pathOrUrl, options = {}) {
  const { method = 'GET', body = null, ttl = 0, headers = {}, contentType = '' } = options;
  const sitePath = toSitePath(pathOrUrl);
  const cacheKey = ttl > 0 && method === 'GET' ? buildCacheKey(`netflixgc:html`, sitePath) : '';

  if (cacheKey) {
    const cached = await getCachedText(cacheKey);
    if (cached) {
      logInfo('命中页面缓存', { path: sitePath, len: cached.length });
      return { statusCode: 200, body: cached, host: ACTIVE_HOST, cached: true };
    }
  }

  const hostOrder = [ACTIVE_HOST, ...HOST_CANDIDATES.filter((host) => host !== ACTIVE_HOST)];
  let lastError = null;

  for (const host of hostOrder) {
    const target = `${host}${sitePath}`;
    try {
      const reqHeaders = { ...defaultHeaders(), ...headers };
      if (contentType) reqHeaders['Content-Type'] = contentType;
      if (method === 'POST') {
        reqHeaders['X-Requested-With'] = reqHeaders['X-Requested-With'] || 'XMLHttpRequest';
        reqHeaders.Referer = reqHeaders.Referer || `${host}/`;
      }

      const res = await axiosInstance.request({
        url: target,
        method,
        headers: reqHeaders,
        data: body || undefined,
        responseType: 'text',
        transformResponse: [(data) => data],
      });

      const text = typeof res.data === 'string' ? res.data : String(res.data || '');

      if (isBlockedHtml(res.status, text) && CF_AUTO && FLARESOLVERR_URL) {
        const cachedPage = await getCachedText(buildCacheKey(CF_PAGE_CACHE_PREFIX, target));
        if (cachedPage) {
          logInfo('命中 CF 页面缓存', { path: sitePath, len: cachedPage.length });
          ACTIVE_HOST = host;
          return { statusCode: 200, body: cachedPage, host, cached: true };
        }
        const solved = await fetchPageWithFlareSolverr(target);
        if (solved && solved.body) {
          ACTIVE_HOST = host;
          return { statusCode: solved.statusCode, body: solved.body, host, cached: false };
        }
      }

      if (res.status >= 200 && res.status < 400 && text) {
        if (host !== ACTIVE_HOST) logInfo('切换可用域名', { from: ACTIVE_HOST, to: host });
        ACTIVE_HOST = host;
        if (cacheKey) await setCachedText(cacheKey, text, ttl);
        return { statusCode: res.status, body: text, host, cached: false };
      }

      lastError = new Error(`HTTP ${res.status} ${sitePath}`);
      logInfo('请求未拿到有效内容', { host, path: sitePath, status: res.status, len: text.length });
      if (res.status === 404) break;
    } catch (error) {
      lastError = error;
      logInfo('请求异常，尝试下一个域名', { host, path: sitePath, error: error.message });
    }
  }

  throw lastError || new Error(`请求失败: ${sitePath}`);
}

// ========================= 首页 / 分类配置 =========================

const CLASS_LIST = [
  { type_id: '1', type_name: '电影' },
  { type_id: '2', type_name: '连续剧' },
  { type_id: '3', type_name: '漫剧' },
  { type_id: '23', type_name: '综艺' },
  { type_id: '24', type_name: '纪录片' },
  { type_id: '57', type_name: '直播' },
];

const SORT_OPTIONS = [
  { n: '最新', v: 'time' },
  { n: '最热', v: 'hits' },
  { n: '评分', v: 'score' },
];

const FILTER_SOURCE = {
  '1': {
    class:
      '喜剧,爱情,恐怖,动作,科幻,剧情,犯罪,奇幻,悬疑,惊悚,家庭,冒险,同性,运动,战争,灾难,NETFLIX,HBO,BBC ONE,HULU,APPLE TV,FOX',
    area:
      '中国,大陆,香港,台湾,美国,韩国,日本,泰国,新加坡,马来西亚,印度,英国,法国,瑞典,瑞士,乌克兰,加拿大,西班牙,俄罗斯,其它',
    year:
      '2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012,2011,2010,2009,2008,2007,2006,2005,2004,2003,2002,2001,2000,1999,1998,1997,1996,1995,1994,1993,1992,1991,1990,其他',
    lang: '中文,粤语,闽南语,英语,日语,韩语,法语,俄语,德语,泰语,瑞典语,印度语',
  },
  '2': {
    class:
      '古装,战争,青春偶像,喜剧,爱情,家庭,犯罪,动作,奇幻,剧情,历史,经典,乡村,情景,商战,恐怖,悬疑,惊悚,冒险,同性,运动,灾难,NETFLIX,HBO,BBC ONE,HULU,APPLE TV,FOX,NBC,其他',
    area:
      '中国,大陆,香港,台湾,美国,韩国,日本,泰国,新加坡,马来西亚,印度,英国,法国,瑞典,瑞士,乌克兰,加拿大,西班牙,俄罗斯,其它',
    year:
      '2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012,2011,2010,2009,2008,2007,2006,2005,2004,2003,2002,2001,2000',
    lang: '中文,国语,粤语,闽南语,英语,日语,韩语,法语,俄语,德语,泰语,瑞典语,印度语,其它',
  },
  '3': {
    class:
      '搞笑,热血,催泪,后宫,机战,致郁,百合,推理,校园,音乐,社团,装通,战斗,日常,恋爱,冒险,魔幻,喜剧,动作,奇幻,剧情,动画,科幻,NETFLIX',
    area: '日本,美国,其他',
    year:
      '2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012,2011,2010,2009,2008,2007,2006,2005,2004,2003,2002,2001,2000,1999,1998,1997,1996,1995,1994,1993,1992,1991,1990,其他',
    lang: '日语,英语',
  },
  '23': {
    class: '真人秀,搞笑,音乐,冒险,爱情,喜剧,脱口秀,NETFLIX',
    area: '美国,日本,韩国',
    year: '2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012,2011,其他',
    lang: '英语,日语,韩语',
  },
  '24': {
    class: '人物,军事,历史,文化,探索,科技,自然,剧情,纪录片,NETFLIX',
    area: '美国,日本,韩国,英国',
    year: '2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012,2011,其他',
    lang: '英语,日语,韩语',
  },
};

const LETTER_VALUES = 'A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,0-9';

function buildValueList(raw, withAll = true) {
  const items = String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const list = withAll ? [{ n: '全部', v: '' }] : [];
  for (const item of items) {
    list.push({ n: item, v: item });
  }
  return list;
}

function buildFiltersOf(typeId) {
  const config = FILTER_SOURCE[typeId];
  const groups = [];
  if (config) {
    groups.push({ key: 'class', name: '类型', init: '', value: buildValueList(config.class) });
    groups.push({ key: 'area', name: '地区', init: '', value: buildValueList(config.area) });
    groups.push({ key: 'year', name: '年份', init: '', value: buildValueList(config.year) });
    groups.push({ key: 'lang', name: '语言', init: '', value: buildValueList(config.lang) });
    groups.push({ key: 'letter', name: '字母', init: '', value: buildValueList(LETTER_VALUES) });
  }
  groups.push({ key: 'by', name: '排序', init: 'time', value: SORT_OPTIONS.map((item) => ({ ...item })) });
  return groups;
}

const FILTERS = (() => {
  const result = {};
  for (const item of CLASS_LIST) {
    result[item.type_id] = buildFiltersOf(item.type_id);
  }
  return result;
})();

const FILTER_KEYS = ['class', 'area', 'year', 'lang', 'letter', 'by'];
const FILTER_VALUE_POOL = (() => {
  const pool = {};
  for (const key of FILTER_KEYS) {
    const values = new Set(['']);
    for (const typeId of Object.keys(FILTERS)) {
      for (const group of FILTERS[typeId]) {
        if (group.key !== key) continue;
        for (const option of group.value || []) values.add(String(option.v));
      }
    }
    pool[key] = values;
  }
  return pool;
})();

function readFilters(params) {
  const source = params?.filters || params?.extend || params?.ext || params?.filter || {};
  if (!source || typeof source !== 'object') return {};
  const result = {};
  for (const key of FILTER_KEYS) {
    const raw = source[key];
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!value) continue;
    // 白名单校验：只接受站点前台真实存在的筛选值，避免脏参数把列表打空
    if (FILTER_VALUE_POOL[key] && FILTER_VALUE_POOL[key].size > 1 && !FILTER_VALUE_POOL[key].has(value)) {
      logInfo('忽略非法筛选值', { key, value });
      continue;
    }
    result[key] = value;
  }
  return result;
}

// ========================= 列表解析 =========================

function pickCardImage($, element) {
  const $card = $(element);
  const candidates = [
    $card.find('a.public-list-exp').attr('data-original'),
    $card.find('a.public-list-exp').attr('data-src'),
    $card.find('img').attr('data-src'),
    $card.find('img').attr('data-original'),
    $card.find('img').attr('src'),
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (isPlaceholderImage(value)) continue;
    return absolutize(value);
  }
  return '';
}

function parseVodCards(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const list = [];
  const seen = new Set();

  $('div.public-list-box').each((_, element) => {
    const $card = $(element);
    const $link = $card.find('a.public-list-exp').first();
    const $titleLink = $card.find('a.time-title').first();
    const href = $link.attr('href') || $titleLink.attr('href') || '';
    const vodId = extractVodId(href);
    if (!vodId || seen.has(vodId)) return;
    const title =
      stripTags($titleLink.attr('title') || '') ||
      stripTags($titleLink.text() || '') ||
      stripTags($link.attr('title') || '') ||
      stripTags($link.find('img').attr('alt') || '');
    if (!title) return;
    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: title,
      vod_pic: pickCardImage($, element),
      vod_remarks: stripTags($card.find('.public-list-prb').first().text() || ''),
      type_name: stripTags($card.find('.public-prt').first().text() || ''),
    });
  });

  return list;
}

function parseBanner(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const banner = [];
  $('div.slid-e-list-box').each((_, element) => {
    const $item = $(element);
    const title = stripTags($item.find('h3.slide-info-title').first().text() || '');
    const href = $item.find('a.tim-bj[href*="/voddetail/"]').first().attr('href') || '';
    const vodId = extractVodId(href);
    if (!title || !vodId) return;
    const background = $item.find('.slid-e-bj').attr('data-background') || '';
    banner.push({
      title,
      subtitle: stripTags($item.find('.slid-e-type').first().text() || ''),
      backgroundImage: absolutize(background),
      genre: stripTags($item.find('.slid-e-type').first().text() || ''),
      description: stripTags($item.find('.slide-info').first().text() || ''),
      vod_id: vodId,
    });
  });
  return banner;
}

function parseSearchCards(html) {
  if (!html) return { list: [], total: 0, pagecount: 0 };
  const $ = cheerio.load(html);
  const list = [];
  const seen = new Set();

  $('div.search-list').each((_, element) => {
    const $item = $(element);
    const href = $item.find('a[href*="/voddetail/"]').first().attr('href') || '';
    const vodId = extractVodId(href);
    if (!vodId || seen.has(vodId)) return;
    const title =
      stripTags($item.find('h3.slide-info-title').first().text() || '') ||
      stripTags($item.find('a[href*="/voddetail/"]').first().attr('title') || '');
    if (!title) return;

    const candidates = [$item.find('img').attr('data-src'), $item.find('img').attr('src')];
    let pic = '';
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (isPlaceholderImage(value)) continue;
      pic = absolutize(value);
      break;
    }

    const remarks = stripTags($item.find('.slide-info-remarks.cor5').first().text() || '');

    // 搜索卡片只有“年份 / 地区”两个短标签，直接按关键词归类，避免拼出“已完结2011 未知”这类脏值
    let year = '';
    let area = '';
    $item.find('.slide-info-remarks a[href*="/vodsearch/"]').each((__, link) => {
      const text = stripTags($(link).text() || '');
      if (!text) return;
      const classified = classifySearchLink($(link).attr('href') || '');
      if (/^\d{4}$/.test(text) && !year) {
        year = text;
        return;
      }
      if (!area && (AREA_NAMES.has(text) || (classified && classified.pos === 2))) {
        area = text;
      }
    });

    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      vod_year: year,
      vod_area: area,
    });
  });

  let total = 0;
  let pagecount = 0;
  const tip = stripTags($('.page-tip').first().text() || '');
  const totalMatch = tip.match(/共\s*(\d+)\s*条/);
  if (totalMatch) total = Number(totalMatch[1]) || 0;
  const pageMatch = tip.match(/当前\s*(\d+)\s*\/\s*(\d+)\s*页/);
  if (pageMatch) pagecount = Number(pageMatch[2]) || 0;
  if (!pagecount && list.length) pagecount = 1;
  if (!total && list.length) total = list.length;

  return { list, total, pagecount };
}

// ========================= 详情解析 =========================

function pickDetailImage($) {
  const candidates = [
    $('.detail-pic img').attr('data-src'),
    $('.detail-pic img').attr('data-original'),
    $('.detail-pic img').attr('src'),
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (isPlaceholderImage(value)) continue;
    return absolutize(value);
  }
  return '';
}

const AREA_NAMES = new Set([
  '中国', '大陆', '香港', '台湾', '美国', '韩国', '日本', '泰国', '新加坡', '马来西亚', '印度', '英国',
  '法国', '瑞典', '瑞士', '乌克兰', '加拿大', '西班牙', '俄罗斯', '其它', '其他', '欧美', '墨西哥',
  '澳大利亚', '德国', '意大利', '巴西', '越南', '菲律宾', '印尼', '土耳其', '波兰', '丹麦', '挪威',
  '荷兰', '比利时', '爱尔兰', '新西兰', '阿根廷', '南非', '以色列', '伊朗', '捷克', '奥地利', '芬兰',
]);

const LANG_HINTS = /(语|中文|国语|粤语|闽南语|英语|日语|韩语|法语|德语|俄语|泰语|印度语)/;

/**
 * 解析站点伪静态搜索链接，反推该值属于哪个字段
 * 形如 /vodsearch/--美国-----------.html → 前缀 2 个短横线 → 地区槽位
 * 形如 /vodsearch/-------------2022.html → 前缀 13 个短横线 → 年份槽位
 */
function classifySearchLink(href) {
  const match = String(href || '').match(/\/vodsearch\/([^/]*)\.html/i);
  if (!match) return null;
  const segment = match[1];
  const lead = (segment.match(/^-*/) || [''])[0].length;
  const remainder = segment.slice(lead);
  const rawValue = (remainder.match(/^[^-]*/) || [''])[0];
  let value = rawValue;
  try {
    value = decodeURIComponent(rawValue);
  } catch (_) {
    value = rawValue;
  }
  value = stripTags(value);
  if (!value) return null;
  return { pos: lead, value };
}

function parseMetaSpans($) {
  const info = { year: '', area: '', lang: '', type_name: '' };

  // 1) 优先用详情头部搜索链接的槽位判定年份 / 地区（最贴近站点真实字段）
  $('.slide-info a[href*="/vodsearch/"]').each((_, element) => {
    const classified = classifySearchLink($(element).attr('href') || '');
    if (!classified) return;
    const { pos, value } = classified;
    if (pos === 13 && /^\d{4}$/.test(value) && !info.year) {
      info.year = value;
      return;
    }
    if (pos === 2 && AREA_NAMES.has(value) && !info.area) {
      info.area = value;
    }
  });

  // 2) 兜底：从 deployment 文本里补齐年份 / 语言 / 类型
  const texts = [];
  $('.deployment span')
    .filter((_, el) => !$(el).hasClass('division'))
    .each((_, el) => {
      const text = stripTags($(el).text() || '');
      if (text) texts.push(text);
    });
  const typeSpanText = stripTags($('.deployment .hl-ma0').first().text() || '');

  if (!info.year) {
    const yearSpan = texts.find((text) => /^\d{4}$/.test(text));
    if (yearSpan) info.year = yearSpan;
  }
  if (!info.lang) {
    const langSpan = texts.find((text) => LANG_HINTS.test(text) && text.length <= 8 && !/^\d+$/.test(text));
    if (langSpan) info.lang = langSpan;
  }
  if (!info.area) {
    const areaSpan = texts.find((text) => AREA_NAMES.has(text) || /^[^\d·]+ \/ [^\d·]+$/.test(text));
    if (areaSpan) info.area = areaSpan;
  }
  // 类型：优先 hl-ma0 单值场景（如“韩国”），多值时拆出类型与地区
  if (typeSpanText) {
    const tokens = typeSpanText.split(/[\s/]+/).map((item) => item.trim()).filter(Boolean);
    const areaTokens = tokens.filter((item) => AREA_NAMES.has(item));
    const typeTokens = tokens.filter((item) => !AREA_NAMES.has(item));
    if (tokens.length === 1) {
      if (AREA_NAMES.has(tokens[0])) {
        if (!info.area) info.area = tokens[0];
      } else {
        info.type_name = tokens[0];
      }
    } else {
      if (!info.area && areaTokens.length) info.area = areaTokens[0];
      if (typeTokens.length) info.type_tokens = typeTokens;
    }
  }
  if (info.area === '未知') info.area = '';
  return info;
}

function parsePartitionInfo($, label) {
  let result = '';
  $('.slide-info.partition').each((_, element) => {
    if (result) return;
    const $block = $(element);
    const text = stripTags($block.find('strong').first().text() || '');
    if (!text.includes(label)) return;
    const names = [];
    $block.find('a').each((__, link) => {
      const name = stripTags($(link).text() || '');
      if (name && name !== ',') names.push(name);
    });
    result = names.join(',').replace(/,+$/, '');
  });
  return result;
}

function parseDetailPage(html, vodId) {
  const $ = cheerio.load(html);

  const vod = {
    vod_id: String(vodId),
    vod_name: stripTags($('h3.slide-info-title').first().text() || '') || stripTags($('title').first().text() || ''),
    vod_pic: pickDetailImage($),
    vod_remarks: stripTags($('.slide-info-remarks.cor5').first().text() || ''),
    vod_content: stripTags($('#height_limit').first().text() || ''),
    vod_director: parsePartitionInfo($, '导演'),
    vod_actor: parsePartitionInfo($, '演员'),
    vod_douban_score: stripTags($('.fraction').first().text() || ''),
  };

  const meta = parseMetaSpans($);
  vod.vod_year = meta.year;
  vod.vod_area = meta.area;
  vod.vod_lang = meta.lang;
  if (meta.type_name) vod.type_name = meta.type_name;
  if (!vod.type_name && Array.isArray(meta.type_tokens) && meta.type_tokens.length) {
    vod.type_name = meta.type_tokens.join(',');
  }
  if (!vod.type_name) {
    const partitionType = parsePartitionInfo($, '类型');
    if (partitionType) vod.type_name = partitionType;
  }
  // 简介兜底文案（形如“《X》是一部YYYY年上映的…作品”）保留原值，刮削成功时会被 TMDB 简介覆盖
  vod.vod_actor = String(vod.vod_actor || '').replace(/,+$/, '');
  vod.vod_director = String(vod.vod_director || '').replace(/,+$/, '');

  const lineNames = [];
  $('.anthology .anthology-tab a.swiper-slide').each((_, element) => {
    const $tab = $(element).clone();
    $tab.find('.badge').remove();
    lineNames.push(stripTags($tab.text() || ''));
  });

  const playSources = [];
  $('.anthology .anthology-list .anthology-list-box').each((index, element) => {
    const episodes = [];
    $(element)
      .find('a[href*="/vodplay/"]')
      .each((_, link) => {
        const href = $(link).attr('href') || '';
        const playMatch = href.match(/\/vodplay\/(\d+)-(\d+)-(\d+)\.html/i);
        if (!playMatch) return;
        const epName = stripTags($(link).text() || '') || `第${episodes.length + 1}集`;
        const [, sid, lineSid, nid] = playMatch;
        const fid = `${sid}#${lineSid}#${nid}`;
        const lineName = lineNames[index] || `线路${index + 1}`;
        episodes.push({
          name: epName,
          playId: `${toSitePath(href)}|||${encodeMeta({
            sid,
            fid,
            v: vod.vod_name,
            e: epName,
            l: lineName,
            n: Number(nid) || episodes.length + 1,
            p: vod.vod_pic,
          })}`,
          _fid: fid,
          _rawName: epName,
          _line: lineName,
        });
      });
    if (!episodes.length) return;
    playSources.push({ name: lineNames[index] || `线路${index + 1}`, episodes });
  });

  return { vod, playSources };
}

function buildLegacyPlayFields(playSources) {
  const fromList = [];
  const urlList = [];
  for (const source of playSources || []) {
    const episodes = source?.episodes || [];
    if (!episodes.length) continue;
    fromList.push(source.name || `线路${fromList.length + 1}`);
    urlList.push(
      episodes
        .map((ep) => `${ep.name}$${String(ep.playId || '').split('|||')[0]}`)
        .join('#')
    );
  }
  return {
    vod_play_from: fromList.join('$$$'),
    vod_play_url: urlList.join('$$$'),
  };
}

// ========================= 刮削 =========================

function buildDanmakuFileName(vodName, episodeName) {
  const title = String(vodName || '').trim();
  if (!title) return '';
  const raw = String(episodeName || '').replace(/第\s*0*(\d+)\s*[集话期]/, '$1').trim();
  const cnMap = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const cnMatch = raw.match(/第\s*([零一二三四五六七八九十]{1,3})\s*[集话期]/);
  let num = 0;
  if (cnMatch) {
    const text = cnMatch[1];
    if (text.length === 1) num = cnMap[text] || 0;
    else if (text.length === 2) num = text[0] === '十' ? 10 + (cnMap[text[1]] || 0) : (cnMap[text[0]] || 0) * 10;
    else if (text.length === 3) num = (cnMap[text[0]] || 0) * 10 + (cnMap[text[2]] || 0);
  }
  if (!num) {
    const seMatch = raw.match(/[Ss](\d{1,2})?[-._\s]*[Ee](\d{1,3})/);
    if (seMatch) num = Number(seMatch[2]) || 0;
  }
  if (!num) {
    const epMatch = raw.match(/^\s*(?:EP|E)?\s*(\d{1,3})\s*$/i);
    if (epMatch) num = Number(epMatch[1]) || 0;
  }
  if (!num) {
    const digits = raw.match(/(\d{1,3})/);
    if (digits && Number(digits[1]) <= 2000) num = Number(digits[1]) || 0;
  }
  if (!num) return title;
  return num < 10 ? `${title} S01E0${num}` : `${title} S01E${num}`;
}

async function matchDanmaku(fileName) {
  if (!fileName) return [];
  try {
    if (typeof OmniBox.getDanmakuByFileName === 'function') {
      const matched = await OmniBox.getDanmakuByFileName(fileName);
      if (Array.isArray(matched) && matched.length) return matched;
    }
  } catch (error) {
    logInfo('SDK 弹幕匹配失败', { fileName, error: error.message });
  }
  if (!DANMU_API) return [];
  try {
    const res = await OmniBox.request(`${DANMU_API.replace(/\/+$/, '')}/api/v2/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ fileName }),
    });
    if (Number(res.statusCode) !== 200) return [];
    const data = safeJsonParse(res.body || '{}', {});
    if (!data.isMatched) return [];
    const first = (data.matches || [])[0];
    if (!first || !first.episodeId) return [];
    const name = [first.animeTitle, first.episodeTitle].filter(Boolean).join(' - ') || '弹幕';
    return [
      {
        name,
        url: `${DANMU_API.replace(/\/+$/, '')}/api/v2/comment/${first.episodeId}?format=xml`,
      },
    ];
  } catch (error) {
    logInfo('弹幕接口匹配失败', { error: error.message });
    return [];
  }
}

function buildScrapeCandidates(playSources) {
  const candidates = [];
  for (const source of playSources || []) {
    for (const episode of source?.episodes || []) {
      if (!episode || !episode._fid) continue;
      const name = episode._rawName || episode.name || '正片';
      candidates.push({
        fid: episode._fid,
        file_id: episode._fid,
        file_name: name,
        name,
        format_type: 'video',
      });
    }
  }
  return candidates;
}

function buildScrapedEpisodeName(scrapeData, mapping, fallback) {
  const season = Number(mapping?.seasonNumber);
  const episode = Number(mapping?.episodeNumber);
  if (!Number.isFinite(episode) || episode <= 0) return fallback;
  if (Number.isFinite(season) && season > 1) return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return `第${episode}集`;
}

function buildPosterUrl(path) {
  if (!path) return '';
  const value = String(path);
  if (/^https?:\/\//i.test(value)) return value;
  return `https://image.tmdb.org/t/p/w500${value.startsWith('/') ? value : `/${value}`}`;
}

async function applyScraping(vod, playSources, vodId) {
  const candidates = buildScrapeCandidates(playSources);
  logInfo('刮削候选', {
    vodId,
    sourceCount: (playSources || []).length,
    candidateCount: candidates.length,
    preview: candidates.slice(0, 3).map((item) => `${item.file_id}=>${item.file_name}`),
  });
  if (!candidates.length) {
    logInfo('刮削跳过: 无可用候选', { vodId });
    return;
  }
  if (!OmniBox || typeof OmniBox.processScraping !== 'function') {
    logInfo('刮削跳过: 宿主未提供 processScraping', { vodId });
    return;
  }
  try {
    await OmniBox.processScraping(vodId, vod.vod_name || '', vod.vod_name || '', candidates);
    if (typeof OmniBox.getScrapeMetadata !== 'function') return;
    const metadata = await OmniBox.getScrapeMetadata(vodId);
    const scrapeData = metadata?.scrapeData || null;
    const mappings = Array.isArray(metadata?.videoMappings) ? metadata.videoMappings : [];
    logInfo('刮削结果', {
      vodId,
      hasScrapeData: !!scrapeData,
      mappingCount: mappings.length,
      mappingPreview: mappings.slice(0, 3).map((item) => `${item.fileId || '<empty>'}=>${item.episodeName || ''}`),
    });
    if (!scrapeData) return;

    if (scrapeData.title || scrapeData.name) vod.vod_name = scrapeData.title || scrapeData.name;
    const poster = scrapeData.posterPath || scrapeData.poster_path || '';
    if (poster) vod.vod_pic = buildPosterUrl(poster);
    const releaseDate = scrapeData.releaseDate || scrapeData.release_date || '';
    if (releaseDate) vod.vod_year = String(releaseDate).slice(0, 4);
    if (scrapeData.overview) vod.vod_content = scrapeData.overview;
    if (scrapeData.voteAverage || scrapeData.vote_average) {
      vod.vod_douban_score = String(scrapeData.voteAverage || scrapeData.vote_average);
    }

    let actors = scrapeData.actors || '';
    let directors = scrapeData.director || '';
    if (Array.isArray(scrapeData.credits?.cast) && scrapeData.credits.cast.length) {
      actors = scrapeData.credits.cast
        .slice(0, 8)
        .map((item) => item?.name)
        .filter(Boolean)
        .join(',');
    }
    if (Array.isArray(scrapeData.credits?.crew) && scrapeData.credits.crew.length) {
      directors = scrapeData.credits.crew
        .filter((item) => item?.job === 'Director' || item?.department === 'Directing')
        .slice(0, 3)
        .map((item) => item?.name)
        .filter(Boolean)
        .join(',');
    }
    if (actors) vod.vod_actor = actors;
    if (directors) vod.vod_director = directors;

    for (const source of playSources || []) {
      source.episodes = (source.episodes || []).map((episode) => {
        const mapping = mappings.find((item) => item?.fileId === episode._fid);
        if (!mapping) return { ...episode, playId: episode.playId };
        const newName = buildScrapedEpisodeName(scrapeData, mapping, episode.name);
        return {
          ...episode,
          name: newName,
          playId: rebuildPlayIdName(episode.playId, newName),
        };
      });
    }
    logInfo('刮削回填完成', {
      vodId,
      title: vod.vod_name,
      actor: String(vod.vod_actor || '').slice(0, 60),
      director: String(vod.vod_director || '').slice(0, 40),
      area: vod.vod_area || '',
      type: vod.type_name || '',
    });
  } catch (error) {
    logInfo('刮削失败，忽略', { vodId, error: error.message });
  }
}

/** 分集名变化后同步更新 playId 里透传的 meta.e，保证 play() 命名一致 */
function rebuildPlayIdName(playId, name) {
  const raw = String(playId || '');
  if (!raw.includes('|||')) return raw;
  const [base, encoded] = raw.split('|||');
  const meta = decodeMeta(encoded);
  if (!meta || typeof meta !== 'object') return raw;
  meta.e = name;
  return `${base}|||${encodeMeta(meta)}`;
}

// ========================= 请求：ds_api 分类 =========================

async function requestCategoryList(typeId, page, filters) {
  const body = new URLSearchParams();
  body.set('type', String(typeId || '1'));
  body.set('class', String(filters.class || ''));
  body.set('area', String(filters.area || ''));
  body.set('year', String(filters.year || ''));
  body.set('lang', String(filters.lang || ''));
  body.set('version', '');
  body.set('state', '');
  body.set('letter', String(filters.letter || ''));
  body.set('time', '');
  body.set('level', '0');
  body.set('weekday', '');
  body.set('by', String(filters.by || 'time'));
  body.set('page', String(page));

  const res = await requestSite('/index.php/ds_api/vod', {
    method: 'POST',
    body: body.toString(),
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: { Referer: `${ACTIVE_HOST}/vodshow/${typeId}-----------.html` },
  });

  const payload = safeJsonParse(res.body, null);
  if (!payload || Number(payload.code) !== 1) {
    logInfo('分类接口返回异常', { typeId, page, code: payload?.code, msg: payload?.msg });
    return { list: [], page, pagecount: 0, total: 0 };
  }

  const list = (payload.list || [])
    .map((item) => {
      const vodId = String(item.vod_id || extractVodId(item.url || ''));
      const pic = unescapeBackslashes(String(item.vod_pic || ''));
      return {
        vod_id: vodId,
        vod_name: stripTags(item.vod_name || ''),
        vod_pic: pic ? absolutize(pic) : '',
        vod_remarks: stripTags(item.vod_remarks || ''),
        type_name: stripTags(item.vod_tag || '').slice(0, 20),
        vod_year: stripTags(String(item.vod_year || '')),
      };
    })
    .filter((item) => item.vod_id && item.vod_name);

  return {
    list,
    page: Number(payload.page) || Number(page) || 1,
    pagecount: Number(payload.pagecount) || 0,
    total: Number(payload.total) || list.length,
  };
}

// ========================= 五个 handler =========================

async function home(params, context) {
  try {
    logInfo('home 入口', { from: context?.from || 'web' });
    const res = await requestSite('/', { ttl: TTL_HOME });
    const list = parseVodCards(res.body).slice(0, 60);
    const banner = parseBanner(res.body).slice(0, 10);
    logInfo('home 完成', { host: res.host, cached: !!res.cached, list: list.length, banner: banner.length });
    return {
      class: CLASS_LIST.map((item) => ({ ...item })),
      filters: FILTERS,
      list,
      banner,
    };
  } catch (error) {
    logError('home 失败', error);
    return { class: CLASS_LIST.map((item) => ({ ...item })), filters: FILTERS, list: [] };
  }
}

async function category(params, context) {
  const typeId = pickParamValue(params?.categoryId, params?.type_id, params?.tid, params?.id) || '1';
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  const filters = readFilters(params);
  try {
    logInfo('category 入口', { typeId, page, filters, from: context?.from || 'web' });
    const result = await requestCategoryList(typeId, page, filters);
    logInfo('category 完成', {
      typeId,
      page: result.page,
      pagecount: result.pagecount,
      total: result.total,
      list: result.list.length,
      filters,
    });
    return {
      page: result.page,
      pagecount: result.pagecount || result.page,
      total: result.total,
      list: result.list,
      filters: FILTERS[typeId] || FILTERS['1'],
    };
  } catch (error) {
    logError('category 失败', error);
    return { page, pagecount: page, total: 0, list: [], filters: FILTERS[typeId] || FILTERS['1'] };
  }
}

async function search(params, context) {
  const keyword = String(params?.keyword || params?.key || params?.wd || '').trim();
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };

  try {
    logInfo('search 入口', { keyword, page, quick: params?.quick, from: context?.from || 'web' });
    const encoded = encodeURIComponent(keyword);
    const path = `/vodsearch/${encoded}----------${page}---.html`;
    let result = { list: [], total: 0, pagecount: 0 };
    try {
      const res = await requestSite(path, {
        ttl: TTL_SEARCH,
        headers: { Referer: `${ACTIVE_HOST}/vodsearch/-------------.html?wd=${encoded}` },
      });
      result = parseSearchCards(res.body);
    } catch (error) {
      logInfo('搜索页请求失败，回退 suggest', { error: error.message });
    }

    if (!result.list.length) {
      try {
        const res = await requestSite(
          `/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(keyword)}`,
          { ttl: TTL_SEARCH, headers: { 'X-Requested-With': 'XMLHttpRequest' } }
        );
        const payload = safeJsonParse(res.body, {});
        const suggestList = (payload.list || [])
          .map((item) => ({
            vod_id: String(item.id || ''),
            vod_name: stripTags(item.name || ''),
            vod_pic: item.pic ? absolutize(unescapeBackslashes(String(item.pic))) : '',
            vod_remarks: '',
          }))
          .filter((item) => item.vod_id && item.vod_name);
        if (suggestList.length) {
          result = { list: suggestList, total: suggestList.length, pagecount: page + 1 };
        }
      } catch (error) {
        logInfo('suggest 回退失败', { error: error.message });
      }
    }

    logInfo('search 完成', { keyword, page, list: result.list.length, total: result.total, pagecount: result.pagecount });
    return {
      page,
      pagecount: result.pagecount || page,
      limit: result.list.length,
      total: result.total || result.list.length,
      list: result.list,
      keyword,
    };
  } catch (error) {
    logError('search 失败', error);
    return { page, pagecount: 0, total: 0, list: [], keyword };
  }
}

async function detail(params, context) {
  const rawId = pickParamValue(params?.videoId, params?.video_id, params?.vod_id, params?.id, params?.ids, params);
  const vodId = extractVodId(rawId);
  if (!vodId) {
    logInfo('detail 缺少有效 videoId', { params });
    return { list: [] };
  }

  try {
    logInfo('detail 入口', { vodId, params, from: context?.from || 'web' });
    const res = await requestSite(`/voddetail/${vodId}.html`, { ttl: TTL_DETAIL });
    const { vod, playSources } = parseDetailPage(res.body, vodId);

    logInfo('detail 解析完成', {
      vodId,
      title: vod.vod_name,
      tabs: playSources.length,
      episodes: playSources.reduce((sum, item) => sum + (item.episodes || []).length, 0),
      lineOrder: playSources.map((item) => item.name),
      pic: vod.vod_pic,
      cached: !!res.cached,
    });

    await applyScraping(vod, playSources, vodId);

    const finalSources = (playSources || []).map((source) => ({
      name: source.name,
      episodes: (source.episodes || []).map((episode) => ({ name: episode.name, playId: episode.playId })),
    }));

    const item = {
      ...vod,
      vod_play_sources: finalSources,
      ...buildLegacyPlayFields(finalSources),
    };

    if (!finalSources.length) logInfo('detail 无线路，检查站点 DOM 或风控', { vodId, host: res.host });
    logInfo('detail 完成', { vodId, sourceCount: finalSources.length, items: 1 });

    return { list: [item] };
  } catch (error) {
    logError('detail 失败', error);
    return { list: [] };
  }
}

/** encrypt=2 → base64；之后统一处理 %uXXXX 与百分号编码 */
function decodePlayerUrl(raw, encrypt) {
  let text = String(raw || '').replace(/\\\//g, '/');
  if (Number(encrypt) === 2) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8');
    } catch (_) {
      /* 保持原值 */
    }
  }
  text = text.replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  try {
    return decodeURIComponent(text);
  } catch (_) {
    const bytes = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        const code = text.charCodeAt(i);
        if (code < 128) bytes.push(code);
        else {
          const encoded = Buffer.from(text[i], 'utf8');
          for (const byte of encoded) bytes.push(byte);
        }
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
}

function extractPlayerConfig(html) {
  const match = String(html || '').match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
  if (!match) return null;
  return safeJsonParse(match[1], null);
}

function isMediaUrl(url) {
  return /\.(m3u8|mp4|flv|mkv|m4a|mp3)(\?|#|$)/i.test(String(url || ''));
}

/**
 * 解析器配置：playerconfig.js 里 player_list[from].ps === "1" 的线路
 * 都不返回直链，而是把 player_aaaa.url 交给站点自有解析器。
 * 其中 NBY 一类是 NBY-XMYAES<hex>|<key> 自有 token，必须由解析器还原。
 */
const DEFAULT_PARSER = 'https://mplayer.nfgc.net/?url=';
let PARSER_MAP = null;
let PARSER_MAP_AT = 0;

async function getParserMap() {
  const now = Date.now();
  if (PARSER_MAP && now - PARSER_MAP_AT < 6 * 3600 * 1000) return PARSER_MAP;
  try {
    const res = await requestSite('/static/js/playerconfig.js', { ttl: 3600 });
    const match = String(res.body || '').match(/MacPlayerConfig\.player_list\s*=\s*(\{[\s\S]*?\})\s*,\s*MacPlayerConfig/);
    const raw = match ? match[1] : '';
    const parsed = safeJsonParse(raw, null);
    if (parsed && typeof parsed === 'object') {
      const map = {};
      for (const [code, config] of Object.entries(parsed)) {
        map[code] = {
          show: String(config?.show || code),
          ps: String(config?.ps ?? ''),
          parse: String(config?.parse || ''),
        };
      }
      PARSER_MAP = map;
      PARSER_MAP_AT = now;
      logInfo('解析器列表加载完成', { count: Object.keys(map).length });
      return map;
    }
  } catch (error) {
    logInfo('解析器列表加载失败', { error: error.message });
  }
  PARSER_MAP = PARSER_MAP || {};
  PARSER_MAP_AT = now;
  return PARSER_MAP;
}

/** 从 player_aaaa.url 里拆出自有 token（NBY-XMYAES...|key 形态） */
function pickCustomToken(resolved) {
  const text = String(resolved || '').trim();
  if (!text) return '';
  if (/^[A-Za-z0-9]+-[A-Za-z0-9]+-[0-9a-fA-F]+\|[0-9a-fA-F]+$/.test(text)) return text;
  if (/XMYAES/i.test(text)) return text;
  return '';
}

/**
 * 按 playerconfig.js 里的真实配置拼解析器地址：
 * - ps=1 的线路不返回直链，站点前端把 player_aaaa.url 原样丢给 entry.parse + encodeURIComponent(url)
 * - 典型前缀：mplayer.nfgc.net/?url=（NBY / 蓝光系列）、cjbfq.netflixgc.tv/player/ec.php?...&url=（APP 独享）
 */
function buildParserUrl(from, resolved) {
  const value = String(resolved || '').trim();
  if (!value) return '';
  if (isMediaUrl(value)) return '';
  const code = String(from || '').trim();
  const entry = PARSER_MAP && code ? PARSER_MAP[code] : null;
  if (entry && entry.parse && entry.ps === '1') {
    return `${entry.parse}${encodeURIComponent(value)}`;
  }
  const token = pickCustomToken(value);
  if (token && DEFAULT_PARSER) return `${DEFAULT_PARSER}${encodeURIComponent(token)}`;
  return '';
}


async function play(params, context) {
  const rawPlayId = pickParamValue(params?.playId, params?.play_id, params?.id, params?.url, params);
  if (!rawPlayId) {
    logInfo('play 缺少 playId', { params });
    return { urls: [], flag: params?.flag || 'play', header: {}, parse: 0 };
  }

  let playRef = String(rawPlayId);
  let meta = {};
  if (playRef.includes('|||')) {
    const parts = playRef.split('|||');
    playRef = parts[0];
    meta = decodeMeta(parts[1]);
  }

  const vodId = String(meta.sid || extractVodId(playRef) || '');
  let playPath = '';
  if (/^https?:\/\//i.test(playRef)) playPath = toSitePath(playRef);
  else if (playRef.startsWith('/')) playPath = playRef;
  else if (/\/vodplay\//i.test(playRef)) {
    playPath = toSitePath(playRef);
  } else if (/^\d+-\d+-\d+$/.test(playRef)) {
    playPath = `/vodplay/${playRef}.html`;
  }
  if (!playPath) {
    logInfo('play 无法识别 playId', { rawPlayId: String(rawPlayId).slice(0, 80) });
    return { urls: [], flag: params?.flag || 'play', header: {}, parse: 0 };
  }

  const header = {
    'User-Agent': UA,
    Referer: `${ACTIVE_HOST}${playPath}`,
    Origin: ACTIVE_HOST,
  };

  try {
    logInfo('play 入口', {
      playPath,
      vodId,
      fid: meta.fid || '',
      line: meta.l || '',
      episode: meta.e || '',
      from: context?.from || 'web',
    });

    const res = await requestSite(playPath, { headers: { Referer: `${ACTIVE_HOST}${playPath}` } });
    const player = extractPlayerConfig(res.body);
    if (!player) {
      logInfo('play 未找到 player_aaaa，回退嗅探', { playPath });
      return await fallbackSniff(`${ACTIVE_HOST}${playPath}`, header, params?.flag || 'play');
    }

    const resolved = decodePlayerUrl(player.url, player.encrypt);
    logInfo('play 解码结果', {
      playPath,
      encrypt: player.encrypt,
      from: player.from,
      resolved: String(resolved || '').slice(0, 140),
    });

    const vodName = meta.v || player?.vod_data?.vod_name || '';
    const episodeName = meta.e || '';
    const episodeNumber = Number(meta.n) || 0;

    const metadataPromise = (async () => {
      const result = { danmaku: [], episodeNumber, episodeName, title: vodName };
      try {
        if (vodId && meta.fid && typeof OmniBox.getScrapeMetadata === 'function') {
          const metadata = await OmniBox.getScrapeMetadata(vodId);
          const mappings = Array.isArray(metadata?.videoMappings) ? metadata.videoMappings : [];
          const mapping = mappings.find((item) => item?.fileId === meta.fid);
          if (metadata?.scrapeData?.title) result.title = metadata.scrapeData.title;
          if (mapping) {
            if (mapping.episodeNumber) result.episodeNumber = Number(mapping.episodeNumber) || result.episodeNumber;
            if (mapping.episodeName) result.episodeName = mapping.episodeName;
          }
        }
      } catch (error) {
        logInfo('play 读取刮削元数据失败', { error: error.message });
      }
      const fileName = buildDanmakuFileName(result.title || vodName, result.episodeName || episodeName);
      if (fileName) {
        const danmaku = await matchDanmaku(fileName);
        if (danmaku.length) result.danmaku = danmaku;
        logInfo('play 弹幕匹配', { fileName, count: danmaku.length });
      }
      return result;
    })();

    const result = await metadataPromise;
    if (vodId && meta.fid && typeof OmniBox.addPlayHistory === 'function' && context?.sourceId) {
      const payload = {
        vodId,
        title: result.title || vodName || '奈飞工厂视频',
        pic: meta.p || '',
        episode: String(result.episodeNumber || episodeNumber || 1),
        sourceId: context.sourceId,
        episodeNumber: result.episodeNumber || episodeNumber || undefined,
        episodeName: result.episodeName || episodeName || undefined,
      };
      OmniBox.addPlayHistory(payload)
        .then((added) => logInfo(`播放记录${added ? '已添加' : '已存在'}`, { vodId, episode: payload.episode }))
        .catch((error) => logInfo('播放记录写入失败', { error: error.message }));
    }

    if (resolved && isMediaUrl(resolved)) {
      return {
        urls: [{ name: meta.l || '默认线路', url: resolved }],
        flag: params?.flag || 'play',
        header,
        parse: 0,
        danmaku: result.danmaku,
      };
    }

    if (resolved && /^https?:\/\//i.test(resolved)) {
      const sniffed = await trySniff(resolved, { ...header, Referer: resolved });
      if (sniffed) {
        return {
          urls: [{ name: meta.l || '嗅探线路', url: sniffed }],
          flag: params?.flag || 'play',
          header: { ...header, Referer: resolved },
          parse: 0,
          danmaku: result.danmaku,
        };
      }
      return {
        urls: [{ name: meta.l || '默认线路', url: resolved }],
        flag: params?.flag || 'play',
        header: { ...header, Referer: resolved },
        parse: 1,
        danmaku: result.danmaku,
      };
    }

    // 站点自有 token（如 NBY-XMYAES<hex>|<key>）→ 交给站点解析器
    const parserUrl = await buildParserUrlAsync(player.from, resolved);
    if (parserUrl) {
      const sniffed = await trySniff(parserUrl, { ...header, Referer: `${ACTIVE_HOST}${playPath}` });
      if (sniffed) {
        return {
          urls: [{ name: meta.l || '默认线路', url: sniffed }],
          flag: params?.flag || 'play',
          header: { ...header, Referer: `${ACTIVE_HOST}${playPath}` },
          parse: 0,
          danmaku: result.danmaku,
        };
      }
      logInfo('解析器地址嗅探失败，交由客户端解析', {
        from: player.from,
        parserUrl: parserUrl.slice(0, 120),
      });
      return {
        urls: [{ name: meta.l || '默认线路', url: parserUrl }],
        flag: params?.flag || 'play',
        header: { ...header, Referer: `${ACTIVE_HOST}${playPath}` },
        parse: 1,
        danmaku: result.danmaku,
      };
    }

    logInfo('play 未解出可用地址', {
      playPath,
      from: player.from,
      resolved: String(resolved || '').slice(0, 80),
    });
    return await fallbackSniff(`${ACTIVE_HOST}${playPath}`, header, params?.flag || 'play');
  } catch (error) {
    logError('play 失败', error);
    return {
      urls: [{ name: '默认线路', url: `${ACTIVE_HOST}${playPath}` }],
      flag: params?.flag || 'play',
      header,
      parse: 1,
    };
  }
}

async function buildParserUrlAsync(from, resolved) {
  const value = String(resolved || '').trim();
  if (!value || isMediaUrl(value)) return '';
  await getParserMap();
  return buildParserUrl(from, value);
}

async function trySniff(targetUrl, headers) {
  try {
    if (!OmniBox || typeof OmniBox.sniffVideo !== 'function') return '';
    logInfo('尝试 SDK 嗅探', { targetUrl: String(targetUrl).slice(0, 120) });
    const sniffed = await OmniBox.sniffVideo(targetUrl, headers);
    const url = typeof sniffed === 'string' ? sniffed : sniffed?.url || '';
    if (url) {
      logInfo('SDK 嗅探成功', { url: String(url).slice(0, 120) });
      return url;
    }
    logInfo('SDK 嗅探无结果', { targetUrl: String(targetUrl).slice(0, 120) });
  } catch (error) {
    logInfo('SDK 嗅探异常', { error: error.message });
  }
  return '';
}

async function fallbackSniff(targetUrl, header, flag) {
  const sniffed = await trySniff(targetUrl, header);
  if (sniffed) {
    return { urls: [{ name: '嗅探线路', url: sniffed }], flag, header, parse: 0 };
  }
  logInfo('嗅探失败，交由客户端处理', { targetUrl: String(targetUrl).slice(0, 120) });
  return {
    urls: [{ name: '默认线路', url: targetUrl }],
    flag,
    header,
    parse: 1,
  };
}

module.exports = { home, category, detail, search, play };

runner.run(module.exports);
