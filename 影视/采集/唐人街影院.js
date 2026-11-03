// @name 唐人街影院
// @author 梦
// @description 刮削：支持，弹幕：暂不支持，嗅探：支持，CF：支持 FlareSolverr / cf_clearance 自动缓存
// @dependencies: axios, cheerio
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/%E5%BD%B1%E8%A7%86/%E9%87%87%E9%9B%86/%E5%94%90%E4%BA%BA%E8%A1%97%E5%BD%B1%E9%99%A2.js

const OmniBox = require('omnibox_sdk');
const cheerio = require('cheerio');
const axios = require('axios');
const runner = require('spider_runner');

const BASE_URL = process.env.TRVOD_HOST || 'https://www.trvod.com';
const USER_AGENT = process.env.TRVOD_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;

const TRVOD_CF_COOKIE = process.env.TRVOD_CF_COOKIE || process.env.TRVOD_COOKIE || '';
const TRVOD_CF_AUTO = process.env.TRVOD_CF_AUTO !== '0';
const TRVOD_CF_CACHE_KEY = process.env.TRVOD_CF_CACHE_KEY || 'trvod:cf_clearance';
const TRVOD_CF_MAX_AGE_SECONDS = parseInt(process.env.TRVOD_CF_MAX_AGE_SECONDS || '21600', 10) || 21600;
const TRVOD_CF_TIMEOUT_MS = parseInt(process.env.TRVOD_CF_TIMEOUT_MS || '60000', 10) || 60000;
// FlareSolverr 服务地址，优先读取站点专用变量，其次回退通用 FLARESOLVERR_URL。
// 项目地址：https://github.com/FlareSolverr/FlareSolverr
const TRVOD_FLARESOLVERR_URL = process.env.TRVOD_FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || 'http://192.168.50.50:8191/v1';
// FlareSolverr 会话名，用于复用已过验证的浏览器会话。
const TRVOD_FLARESOLVERR_SESSION = process.env.TRVOD_FLARESOLVERR_SESSION || '';

const axiosInstance = axios.create({
  timeout: 25000,
  validateStatus: () => true,
});

const CATEGORIES = [
  { type_id: 'movie', type_name: '电影' },
  { type_id: 'tv-series', type_name: '剧集' },
  { type_id: 'show', type_name: '综艺' },
  { type_id: 'animation', type_name: '动漫' },
  { type_id: 'ethical', type_name: '限制级' },
];

const FILTERS = {
  'tv-series': [
    {
      key: 'subclass',
      name: '分类',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '大陆剧', value: 'cn' },
        { name: '欧美剧', value: 'useu' },
        { name: '港台剧', value: 'hktw' },
        { name: '日韩剧', value: 'jpkr' },
        { name: '其它海外剧', value: 'other' },
      ],
    },
    {
      key: 'type',
      name: '类型',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '家庭', value: '家庭' },
        { name: '古装', value: '古装' },
        { name: '武侠', value: '武侠' },
        { name: '奇幻', value: '奇幻' },
        { name: '西部', value: '西部' },
        { name: '历史', value: '历史' },
        { name: '传记', value: '传记' },
        { name: '同性', value: '同性' },
        { name: '真人秀', value: '真人秀' },
        { name: '运动', value: '运动' },
        { name: '剧情', value: '剧情' },
        { name: '喜剧', value: '喜剧' },
        { name: '爱情', value: '爱情' },
        { name: '悬疑', value: '悬疑' },
        { name: '犯罪', value: '犯罪' },
        { name: '科幻', value: '科幻' },
        { name: '惊悚', value: '惊悚' },
        { name: '恐怖', value: '恐怖' },
        { name: '战争', value: '战争' },
        { name: '冒险', value: '冒险' },
        { name: '动作', value: '动作' },
        { name: '动画', value: '动画' },
      ],
    },
    {
      key: 'area',
      name: '地区',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '大陆', value: '大陆' },
        { name: '韩国', value: '韩国' },
        { name: '香港', value: '香港' },
        { name: '台湾', value: '台湾' },
        { name: '日本', value: '日本' },
        { name: '欧美', value: '欧美' },
        { name: '新马', value: '新马' },
        { name: '泰国', value: '泰国' },
        { name: '其它', value: '其它' },
      ],
    },
    {
      key: 'year',
      name: '年份',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '2026', value: '2026' }, { name: '2025', value: '2025' }, { name: '2024', value: '2024' },
        { name: '2023', value: '2023' }, { name: '2022', value: '2022' }, { name: '2020', value: '2020' },
        { name: '2019', value: '2019' }, { name: '2018', value: '2018' }, { name: '2017', value: '2017' },
        { name: '2016', value: '2016' }, { name: '2015', value: '2015' }, { name: '2014', value: '2014' },
        { name: '2013', value: '2013' }, { name: '2012', value: '2012' }, { name: '2011', value: '2011' },
        { name: '2010', value: '2010' }, { name: '2009', value: '2009' }, { name: '2008', value: '2008' },
        { name: '2007', value: '2007' }, { name: '2006', value: '2006' }, { name: '2005', value: '2005' },
        { name: '2004', value: '2004' }, { name: '2003', value: '2003' }, { name: '2002', value: '2002' },
        { name: '2001', value: '2001' }, { name: '2000', value: '2000' },
      ],
    },
    {
      key: 'letter',
      name: '字母',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' },
        { name: 'E', value: 'E' }, { name: 'F', value: 'F' }, { name: 'G', value: 'G' }, { name: 'H', value: 'H' },
        { name: 'I', value: 'I' }, { name: 'J', value: 'J' }, { name: 'K', value: 'K' }, { name: 'L', value: 'L' },
        { name: 'M', value: 'M' }, { name: 'N', value: 'N' }, { name: 'O', value: 'O' }, { name: 'P', value: 'P' },
        { name: 'Q', value: 'Q' }, { name: 'R', value: 'R' }, { name: 'S', value: 'S' }, { name: 'T', value: 'T' },
        { name: 'U', value: 'U' }, { name: 'V', value: 'V' }, { name: 'W', value: 'W' }, { name: 'X', value: 'X' },
        { name: 'Y', value: 'Y' }, { name: 'Z', value: 'Z' }, { name: '0-9', value: '0-9' },
      ],
    },
    {
      key: 'by',
      name: '排序',
      init: '',
      value: [
        { name: '默认', value: '' },
        { name: '时间', value: 'time' },
        { name: '人气', value: 'hits' },
        { name: '评分', value: 'score' },
      ],
    },
  ],
  movie: [
    {
      key: 'class',
      name: '类型',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '动作', value: 'action' },
        { name: '喜剧', value: 'comedy' },
        { name: '爱情', value: 'love' },
        { name: '剧情', value: 'drama' },
        { name: '冒险', value: 'adventure' },
        { name: '悬疑', value: 'suspense' },
        { name: '惊悚', value: 'thriller' },
        { name: '犯罪', value: 'crime' },
        { name: '恐怖', value: 'horror' },
        { name: '科幻', value: 'sci-fi' },
        { name: '灾难', value: 'disaster' },
        { name: '奇幻', value: 'fantasy' },
        { name: '战争', value: 'war' },
        { name: '动画', value: 'animated' },
        { name: '歌舞', value: 'musical' },
        { name: '纪录', value: 'documentary' },
      ],
    },
    {
      key: 'by',
      name: '排序',
      init: '',
      value: [
        { name: '默认', value: '' },
        { name: '时间', value: 'time' },
        { name: '人气', value: 'hits' },
        { name: '评分', value: 'score' },
      ],
    },
  ],
  show: [
    {
      key: 'class',
      name: '类型',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '大陆综艺', value: 'show-cn' },
        { name: '港台综艺', value: 'show-hktw' },
        { name: '日韩综艺', value: 'show-jpkr' },
        { name: '欧美综艺', value: 'show-euus' },
        { name: '其它海外综艺', value: 'show-other' },
      ],
    },
    {
      key: 'by',
      name: '排序',
      init: '',
      value: [
        { name: '默认', value: '' },
        { name: '时间', value: 'time' },
        { name: '人气', value: 'hits' },
        { name: '评分', value: 'score' },
      ],
    },
  ],
  animation: [
    {
      key: 'class',
      name: '类型',
      init: '',
      value: [
        { name: '全部', value: '' },
        { name: '大陆动漫', value: 'ani-cn' },
        { name: '日韩动漫', value: 'ani-jpkr' },
        { name: '欧美动漫', value: 'ani-euus' },
        { name: '其它海外动漫', value: 'ani-other' },
      ],
    },
    {
      key: 'by',
      name: '排序',
      init: '',
      value: [
        { name: '默认', value: '' },
        { name: '时间', value: 'time' },
        { name: '人气', value: 'hits' },
        { name: '评分', value: 'score' },
      ],
    },
  ],
  ethical: [
    {
      key: 'by',
      name: '排序',
      init: '',
      value: [
        { name: '默认', value: '' },
        { name: '时间', value: 'time' },
        { name: '人气', value: 'hits' },
        { name: '评分', value: 'score' },
      ],
    },
  ],
};

function text(v) {
  return String(v == null ? '' : v).trim();
}

function absUrl(url = '') {
  const raw = text(url);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${BASE_URL}${raw}`;
  return `${BASE_URL}/${raw}`;
}

function stripTags(html = '') {
  return text(String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '));
}

function pickBackgroundImage(style = '') {
  const raw = text(style);
  if (!raw) return '';
  const m = raw.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return text(m?.[2] || '');
}

function pickCardImage($el) {
  const thumb = $el.find('a.hl-item-thumb, a.hl-br-thumb, .hl-item-thumb, .hl-br-thumb').first();
  const url = thumb.attr('data-original')
    || thumb.attr('data-src')
    || thumb.attr('data-background')
    || pickBackgroundImage(thumb.attr('style') || '')
    || $el.find('img').first().attr('data-original')
    || $el.find('img').first().attr('data-src')
    || $el.find('img').first().attr('src')
    || '';
  return absUrl(url);
}

function buildCookieHeader(cookie = '') {
  const value = text(cookie);
  return value ? { Cookie: value } : {};
}

function cookiesArrayToString(cookies = []) {
  return (Array.isArray(cookies) ? cookies : [])
    .map((item) => ({ name: text(item?.name || ''), value: text(item?.value || '') }))
    .filter((item) => item.name && item.value)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');
}

async function getCachedCfCookie() {
  if (text(TRVOD_CF_COOKIE)) return text(TRVOD_CF_COOKIE);
  try {
    const cached = await OmniBox.getCache(TRVOD_CF_CACHE_KEY);
    return text(cached || '');
  } catch (_) {
    return '';
  }
}

async function setCachedCfCookie(cookie) {
  const value = text(cookie);
  if (!value || text(TRVOD_CF_COOKIE)) return;
  try {
    await OmniBox.setCache(TRVOD_CF_CACHE_KEY, value, TRVOD_CF_MAX_AGE_SECONDS);
  } catch (_) {}
}

async function requestWithFlareSolverr(targetUrl = BASE_URL + '/') {
  await OmniBox.log('info', `[唐人街影院][cf] FlareSolverr 请求开始 url=${targetUrl}`);
  const payload = {
    cmd: 'request.get',
    url: targetUrl,
    maxTimeout: TRVOD_CF_TIMEOUT_MS,
  };
  if (text(TRVOD_FLARESOLVERR_SESSION)) {
    payload.session = text(TRVOD_FLARESOLVERR_SESSION);
  }

  const res = await axios.post(TRVOD_FLARESOLVERR_URL, payload, {
    timeout: TRVOD_CF_TIMEOUT_MS + 5000,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    validateStatus: () => true,
  });

  if (res.status !== 200 || !res.data || res.data.status !== 'ok') {
    await OmniBox.log('warn', `[唐人街影院][cf] FlareSolverr 失败 status=${res.status} bodyStatus=${text(res.data?.status || '')}`);
    throw new Error(`FlareSolverr HTTP ${res.status}`);
  }

  const solution = res.data.solution || {};
  const cookie = cookiesArrayToString(solution.cookies || []);
  const html = String(solution.response || '');
  await OmniBox.log('info', `[唐人街影院][cf] FlareSolverr 返回 cookies=${(solution.cookies || []).length} htmlLen=${html.length}`);
  return { cookie, html, solution };
}

async function fetchCfClearanceWithFlareSolverr(targetUrl = BASE_URL + '/') {
  const { cookie } = await requestWithFlareSolverr(targetUrl);
  if (!/cf_clearance=/.test(cookie)) {
    throw new Error('FlareSolverr 未返回 cf_clearance');
  }
  return cookie;
}

async function ensureCfCookie(forceRefresh = false, targetUrl = BASE_URL + '/') {
  if (text(TRVOD_CF_COOKIE)) return text(TRVOD_CF_COOKIE);
  if (!forceRefresh) {
    const cached = await getCachedCfCookie();
    if (cached) return cached;
  }
  if (!TRVOD_CF_AUTO) return '';
  const cookie = await fetchCfClearanceWithFlareSolverr(targetUrl);
  if (cookie) {
    await setCachedCfCookie(cookie);
  }
  return cookie;
}

async function requestText(url, referer = BASE_URL + '/') {
  await OmniBox.log('info', `[唐人街影院][request] start url=${url} referer=${referer}`);
  let cookie = await getCachedCfCookie();
  await OmniBox.log('info', `[唐人街影院][request] cachedCookie=${cookie ? 'yes' : 'no'}`);
  let res = await axiosInstance.get(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': referer,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...buildCookieHeader(cookie),
    },
  });

  let html = typeof res.data === 'string' ? res.data : String(res.data || '');
  await OmniBox.log('info', `[唐人街影院][request] firstResponse status=${res.status} htmlLen=${html.length}`);
  const challenged = (res.status === 403 || res.status === 503 || /Just a moment|cf_chl_opt|Enable JavaScript and cookies to continue/i.test(html));
  await OmniBox.log('info', `[唐人街影院][request] challenged=${challenged ? 'yes' : 'no'}`);
  if (challenged && TRVOD_CF_AUTO) {
    try {
      const solved = await requestWithFlareSolverr(url);
      if (solved.cookie) {
        await setCachedCfCookie(solved.cookie);
      }
      html = String(solved.html || '');
      await OmniBox.log('info', `[唐人街影院][request] FlareSolverr htmlLen=${html.length} challenged=${/Just a moment|cf_chl_opt|Enable JavaScript and cookies to continue/i.test(html) ? 'yes' : 'no'}`);
      if (html && !/Just a moment|cf_chl_opt|Enable JavaScript and cookies to continue/i.test(html)) {
        return html;
      }
    } catch (e) {
      await OmniBox.log('warn', `[唐人街影院][request] FlareSolverr error: ${e.message}`);
    }

    cookie = await ensureCfCookie(!cookie, url);
    await OmniBox.log('info', `[唐人街影院][request] refreshedCookie=${cookie ? 'yes' : 'no'}`);
    res = await axiosInstance.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...buildCookieHeader(cookie),
      },
    });
    html = typeof res.data === 'string' ? res.data : String(res.data || '');
    await OmniBox.log('info', `[唐人街影院][request] retryResponse status=${res.status} htmlLen=${html.length}`);
  }

  if (res.status !== 200 || !html) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (/Just a moment|cf_chl_opt|Enable JavaScript and cookies to continue/i.test(html)) {
    throw new Error('Cloudflare challenge unresolved');
  }
  return html;
}

function decodePlayerUrl(url = '', encrypt = 0) {
  let value = text(url).replace(/\\\//g, '/');
  if (!value) return '';
  try {
    if (Number(encrypt) === 2) {
      value = decodeURIComponent(Buffer.from(value, 'base64').toString('utf8'));
    } else if (Number(encrypt) === 1) {
      value = decodeURIComponent(value);
    }
  } catch (_) {}
  return value;
}

function deriveIframeUrlFromPlayUrl(playUrl = '') {
  const raw = text(playUrl);
  const m = raw.match(/\/vodplay\/(\d+)-(\d+)-(\d+)\.html/i);
  if (!m) return '';
  const [, id, sid, nid] = m;
  return absUrl(`/vod/player/id/${id}/nid/${nid}/sid/${sid}.html`);
}

async function resolveQlPlayer(qlUrl, referer = '') {
  const pageRes = await axiosInstance.get(qlUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': referer || BASE_URL + '/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  const pageHtml = typeof pageRes.data === 'string' ? pageRes.data : String(pageRes.data || '');
  const token = pageHtml.match(/apiToken\s*:\s*"([^"]+)"/)?.[1] || '';
  if (!token) {
    throw new Error('qlplayer apiToken not found');
  }

  const apiUrl = new URL('/api/resolve.php', qlUrl).toString() + `?token=${encodeURIComponent(token)}`;
  const apiRes = await axiosInstance.get(apiUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': qlUrl,
      'Origin': new URL(qlUrl).origin,
      'Accept': 'application/json, text/plain, */*',
    },
  });
  const payload = typeof apiRes.data === 'string' ? JSON.parse(apiRes.data || '{}') : (apiRes.data || {});
  if (Number(payload.code) !== 200 || !text(payload.url)) {
    throw new Error(text(payload.msg || `qlplayer resolve failed code=${payload.code}`));
  }
  return {
    url: text(payload.url),
    type: text(payload.type || 'auto'),
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': qlUrl,
      'Origin': new URL(qlUrl).origin,
    },
  };
}

function extractCards($, scope) {
  const list = [];
  const seen = new Set();
  $(scope).each((_, el) => {
    const $el = $(el);
    const $a = $el.is('a') ? $el : $el.find('a.hl-item-thumb, a.hl-br-thumb, .hl-item-title a, h2 a, a[href*="/vodhtml/"]').first();
    const href = $a.attr('href') || '';
    const vodId = text(href);
    if (!vodId || seen.has(vodId) || !/\/vodhtml\//.test(vodId)) return;
    seen.add(vodId);

    const vodName = stripTags(
      $el.find('.hl-item-title,.hl-br-title,.hl-item-heading,.hl-vod-title,h2 a').first().text()
      || $a.attr('title')
      || $a.find('img').attr('alt')
      || ''
    );
    const vodPic = pickCardImage($el);
    const vodRemarks = stripTags(
      $el.find('.hl-pic-text .remarks,.hl-br-sub,.hl-item-sub,.hl-item-content,.remarks,.hl-lc-1').first().text()
      || $el.find('.hl-item-remarks').text()
      || ''
    );
    if (!vodName) return;
    list.push({
      vod_id: absUrl(vodId),
      vod_name: vodName,
      vod_pic: vodPic,
      vod_remarks: vodRemarks,
    });
  });
  return list;
}

function fallbackCardsByRegex(html = '') {
  const list = [];
  const seen = new Set();
  const reg = /<a class="hl-item-thumb[^"]*" href="(\/vodhtml\/\d+\/??)" title="([^"]+)"[^>]*data-original="([^"]+)"[\s\S]*?<span class="hl-lc-1 remarks">([^<]*)<\/span>/g;
  let m;
  while ((m = reg.exec(html)) !== null) {
    const vodId = absUrl(m[1]);
    if (seen.has(vodId)) continue;
    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: stripTags(m[2]),
      vod_pic: absUrl(m[3]),
      vod_remarks: stripTags(m[4]),
    });
  }
  return list;
}

function buildCategoryUrl(typeId, page = 1, filters = {}) {
  const by = text(filters.by || '');
  const subclass = text(filters.subclass || '');
  const genre = text(filters.type || '');
  const area = text(filters.area || '');
  const year = text(filters.year || '');
  const letter = text(filters.letter || '');

  const typeIdMap = {
    movie: '1',
    'tv-series': '2',
    show: '3',
    animation: '4',
    ethical: '5',
  };

  if (typeId === 'tv-series' && (subclass || genre || area || year || letter || by || page > 1)) {
    const cls = genre || subclass || '';
    return absUrl(`/vodshow/2-${area}-${by}-${cls}-----${letter}---${page}---${year}.html`);
  }

  const numeric = typeIdMap[typeId] || '';
  if (numeric && (genre || area || year || letter || by || page > 1)) {
    return absUrl(`/vodshow/${numeric}-${area}-${by}-${genre}-----${letter}---${page}---${year}.html`);
  }

  const typePath = subclass || typeId;
  let url = absUrl(`/vodtype/${typePath}/`);
  const query = new URLSearchParams();
  if (by) query.set('by', by);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();
  if (qs) url += `?${qs}`;
  return url;
}

async function home() {
  try {
    const html = await requestText(BASE_URL + '/');
    const $ = cheerio.load(html);
    let list = extractCards($, '.hl-vod-list li, .hl-row-box li, .hl-public-list li, .hl-item-wrap');
    if (!list.length) {
      list = fallbackCardsByRegex(html);
    }
    return {
      class: CATEGORIES,
      filters: FILTERS,
      list: list.slice(0, 36),
    };
  } catch (e) {
    await OmniBox.log('error', `[唐人街影院][home] ${e.message}`);
    return { class: CATEGORIES, filters: FILTERS, list: [] };
  }
}

async function category(params) {
  const typeId = text(params.categoryId || params.type_id || params.tid || 'tv-series');
  const page = Math.max(1, Number(params.page || params.pg || 1) || 1);
  const filters = params.filters || params.extend || {};
  try {
    const url = buildCategoryUrl(typeId, page, filters);
    const html = await requestText(url, BASE_URL + '/');
    const $ = cheerio.load(html);
    let list = extractCards($, '.hl-vod-list li, .hl-row-box li, .hl-item-wrap');
    if (!list.length) {
      list = fallbackCardsByRegex(html);
    }
    const hasNext = /下一页|下页|尾页|page=(\d+)/i.test(html) || list.length >= PAGE_SIZE;
    return {
      page,
      pagecount: hasNext ? page + 1 : page,
      total: page * PAGE_SIZE + list.length,
      filters: FILTERS[typeId] || [],
      list,
    };
  } catch (e) {
    await OmniBox.log('error', `[唐人街影院][category] ${e.message}`);
    return { page, pagecount: 1, total: 0, filters: FILTERS[typeId] || [], list: [] };
  }
}

async function search(params) {
  const keyword = text(params.keyword || params.key || params.wd || '');
  const page = Math.max(1, Number(params.page || params.pg || 1) || 1);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
  try {
    const url = absUrl(`/vodsearch/-------------.html?wd=${encodeURIComponent(keyword)}&submit=` + (page > 1 ? `&page=${page}` : ''));
    const html = await requestText(url, BASE_URL + '/');
    const $ = cheerio.load(html);
    const searchScope = $('div.hl-rb-search').first();
    let list = [];
    if (searchScope.length) {
      list = extractCards($, 'div.hl-rb-search .hl-vod-list li, div.hl-rb-search .hl-list-item, div.hl-rb-search .hl-item-wrap');
      if (!list.length) {
        list = fallbackCardsByRegex(searchScope.html() || '');
      }
    }
    const hasNext = /下一页|下页|尾页|page=(\d+)/i.test(searchScope.html() || html) || list.length >= PAGE_SIZE;
    return {
      page,
      pagecount: hasNext ? page + 1 : page,
      total: page * PAGE_SIZE + list.length,
      list,
    };
  } catch (e) {
    await OmniBox.log('error', `[唐人街影院][search] ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

function parsePlaySources($, html, detailUrl) {
  const playSources = [];
  const tabs = [];
  $('.hl-plays-from a, .hl-tabs-btn a, .hl-plays-list .hl-tabs a').each((_, el) => {
    const $el = $(el);
    const name = stripTags($el.text()) || stripTags($el.attr('title') || '') || `线路${tabs.length + 1}`;
    const target = text($el.attr('href') || $el.attr('data-target') || $el.attr('data-href') || '');
    tabs.push({ name, target });
  });

  const groups = $('.hl-plays-list, .hl-play-list, .hl-plays-wrap .hl-list-wrap, .hl-tabs-box');
  if (groups.length) {
    groups.each((idx, box) => {
      const episodes = [];
      $(box).find('a[href*="/vodplay/"]').each((__, a) => {
        const $a = $(a);
        const href = text($a.attr('href') || '');
        const name = stripTags($a.text()) || stripTags($a.attr('title') || '') || '正片';
        if (!href) return;
        episodes.push({ name, playId: JSON.stringify({ url: absUrl(href), referer: detailUrl }) });
      });
      if (episodes.length) {
        playSources.push({ name: tabs[idx]?.name || `线路${idx + 1}`, episodes });
      }
    });
  }

  if (!playSources.length) {
    const episodes = [];
    $('a[href*="/vodplay/"]').each((_, a) => {
      const $a = $(a);
      const href = text($a.attr('href') || '');
      const name = stripTags($a.text()) || stripTags($a.attr('title') || '') || '正片';
      if (!href || href === detailUrl) return;
      episodes.push({ name, playId: JSON.stringify({ url: absUrl(href), referer: detailUrl }) });
    });
    if (episodes.length) {
      playSources.push({ name: '默认', episodes });
    }
  }

  return playSources;
}

async function detail(params) {
  try {
    const detailUrl = absUrl(params.vod_id || params.videoId || params.id || '');
    if (!detailUrl) return { list: [] };
    const html = await requestText(detailUrl, BASE_URL + '/');
    const $ = cheerio.load(html);

    const vod_name = stripTags($('h1,h2,.hl-dc-title,.hl-item-title').first().text() || $('title').text().split('-')[0]);
    const vod_pic = absUrl($('img[data-original], img[data-src], .hl-item-thumb img, .hl-detail-pic img').first().attr('data-original') || $('img').first().attr('src') || '');
    const vod_content = stripTags($('.hl-content-wrap, .hl-dc-content, .hl-detail-content, .content').first().text() || $('meta[name="description"]').attr('content') || '');
    const vod_remarks = stripTags($('.hl-item-sub,.remarks,.hl-text-conch,.hl-lc-1').first().text() || '');

    const infoText = stripTags($('.hl-full-box, .hl-part-wrap, .hl-content-box, .hl-detail-box').first().text() || html);
    const pick = (label) => {
      const m = infoText.match(new RegExp(`${label}[：:]\\s*([^\\s]+(?:\\s*\/\\s*[^\\s]+)*)`));
      return text(m?.[1] || '');
    };

    const vod_year = pick('年份') || pick('年代');
    const vod_area = pick('地区') || pick('国家');
    const vod_actor = pick('主演') || pick('演员');
    const vod_director = pick('导演');
    const type_name = pick('类型');
    const vod_play_sources = parsePlaySources($, html, detailUrl);

    return {
      list: [{
        vod_id: detailUrl,
        vod_name,
        vod_pic,
        vod_content,
        vod_remarks,
        vod_year,
        vod_area,
        vod_actor,
        vod_director,
        type_name,
        vod_play_sources,
      }],
    };
  } catch (e) {
    await OmniBox.log('error', `[唐人街影院][detail] ${e.message}`);
    return { list: [] };
  }
}

async function play(params) {
  try {
    const rawPlayId = text(params.playId || params.play_id || params.id || '');
    let playMeta = {};
    try { playMeta = JSON.parse(rawPlayId); } catch (_) {}
    const playUrl = absUrl(playMeta.url || rawPlayId);
    const referer = absUrl(playMeta.referer || BASE_URL + '/');
    await OmniBox.log('info', `[唐人街影院][play] rawPlayId=${rawPlayId.slice(0, 200)}`);
    await OmniBox.log('info', `[唐人街影院][play] playUrl=${playUrl} referer=${referer}`);
    if (!playUrl) return { urls: [], parse: 0 };
    const sniffHeaders = {
      'User-Agent': USER_AGENT,
      'Referer': referer || playUrl,
      'Origin': BASE_URL,
    };

    const sniffTargets = [];
    const derivedIframeUrl = deriveIframeUrlFromPlayUrl(playUrl);
    await OmniBox.log('info', `[唐人街影院][play] derivedIframeUrl=${derivedIframeUrl || 'none'}`);

    let html = '';
    let match = null;
    let iframe = '';

    if (derivedIframeUrl) {
      try {
        const iframeHtml = await requestText(derivedIframeUrl, playUrl);
        await OmniBox.log('info', `[唐人街影院][play] iframeHtmlLen=${iframeHtml.length}`);
        const qlIframeSrc = iframeHtml.match(/<iframe[^>]+src="(https:\/\/[^"']*qlplayer\.cyou[^"']*)"/i)?.[1] || '';
        await OmniBox.log('info', `[唐人街影院][play] qlIframeSrc=${qlIframeSrc || 'none'}`);
        if (qlIframeSrc) {
          try {
            await OmniBox.log('info', `[唐人街影院][play] qlplayer resolve start url=${qlIframeSrc}`);
            const resolved = await resolveQlPlayer(qlIframeSrc, derivedIframeUrl);
            await OmniBox.log('info', `[唐人街影院][play] qlplayer resolve ok type=${resolved.type} url=${resolved.url}`);
            return {
              urls: [{ name: 'qlplayer解析', url: resolved.url }],
              parse: /\.(m3u8|mp4|flv|m4a|mp3)(\?|$)/i.test(resolved.url) ? 0 : 1,
              header: resolved.headers,
            };
          } catch (qlError) {
            await OmniBox.log('warn', `[唐人街影院][play] qlplayer resolve failed: ${qlError.message}`);
          }
        }

        const iframePlayerMatch = iframeHtml.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
          || iframeHtml.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
          || iframeHtml.match(/MacPlayerConfig\.player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?/i);
        await OmniBox.log('info', `[唐人街影院][play] iframePlayerMatch=${iframePlayerMatch ? 'yes' : 'no'}`);
        if (iframePlayerMatch) {
          let iframePlayer = {};
          try {
            iframePlayer = JSON.parse(iframePlayerMatch[1]);
          } catch (e) {
            await OmniBox.log('warn', `[唐人街影院][play] iframe player parse error: ${e.message}`);
          }
          let iframeRealUrl = decodePlayerUrl(iframePlayer.url || '', iframePlayer.encrypt || 0);
          if (iframeRealUrl && !/^https?:\/\//i.test(iframeRealUrl)) {
            iframeRealUrl = absUrl(iframeRealUrl);
          }
          await OmniBox.log('info', `[唐人街影院][play] iframe player.from=${text(iframePlayer.from || '')} encrypt=${text(iframePlayer.encrypt || '')} url=${iframeRealUrl}`);
          if (iframeRealUrl) {
            if (/\.(m3u8|mp4|flv|m4a|mp3)(\?|$)/i.test(iframeRealUrl)) {
              return {
                urls: [{ name: 'iframe直链', url: iframeRealUrl }],
                parse: 0,
                header: {
                  'User-Agent': USER_AGENT,
                  'Referer': derivedIframeUrl,
                  'Origin': BASE_URL,
                },
              };
            }
            if (/qlplayer\.cyou/i.test(iframeRealUrl)) {
              try {
                await OmniBox.log('info', `[唐人街影院][play] qlplayer resolve start url=${iframeRealUrl}`);
                const resolved = await resolveQlPlayer(iframeRealUrl, derivedIframeUrl);
                await OmniBox.log('info', `[唐人街影院][play] qlplayer resolve ok type=${resolved.type} url=${resolved.url}`);
                return {
                  urls: [{ name: 'qlplayer解析', url: resolved.url }],
                  parse: /\.(m3u8|mp4|flv|m4a|mp3)(\?|$)/i.test(resolved.url) ? 0 : 1,
                  header: resolved.headers,
                };
              } catch (qlError) {
                await OmniBox.log('warn', `[唐人街影院][play] qlplayer resolve failed: ${qlError.message}`);
              }
            }
            sniffTargets.push({ name: 'iframePlayerUrl', url: iframeRealUrl, headers: { 'User-Agent': USER_AGENT, 'Referer': derivedIframeUrl, 'Origin': BASE_URL } });
          }
        }
        sniffTargets.push({ name: 'iframe', url: derivedIframeUrl, headers: { ...sniffHeaders, Referer: playUrl } });
      } catch (iframeError) {
        await OmniBox.log('warn', `[唐人街影院][play] iframe request failed: ${iframeError.message}`);
      }
    }

    if (!derivedIframeUrl || !sniffTargets.length) {
      html = await requestText(playUrl, referer || BASE_URL + '/');
      await OmniBox.log('info', `[唐人街影院][play] pageHtmlLen=${html.length}`);

      match = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
        || html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
        || html.match(/MacPlayerConfig\.player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?/i);
      await OmniBox.log('info', `[唐人街影院][play] playerMatch=${match ? 'yes' : 'no'}`);

      if (match) {
        let player = {};
        try {
          player = JSON.parse(match[1]);
        } catch (e) {
          await OmniBox.log('warn', `[唐人街影院][play] player parse error: ${e.message}`);
        }
        let realUrl = decodePlayerUrl(player.url || '', player.encrypt || 0);
        await OmniBox.log('info', `[唐人街影院][play] player.from=${text(player.from || '')} encrypt=${text(player.encrypt || '')} rawUrlLen=${text(player.url || '').length}`);
        if (realUrl && !/^https?:\/\//i.test(realUrl)) {
          realUrl = absUrl(realUrl);
        }
        if (realUrl) {
          const parse = /\.(m3u8|mp4|flv|m4a|mp3)(\?|$)/i.test(realUrl) ? 0 : 1;
          return {
            urls: [{ name: '默认线路', url: realUrl }],
            parse,
            header: {
              'User-Agent': USER_AGENT,
              'Referer': referer || playUrl,
              'Origin': BASE_URL,
            },
          };
        }
      }

      iframe = html.match(/<iframe[^>]+src="([^"]+)"/i)?.[1] || '';
      await OmniBox.log('info', `[唐人街影院][play] iframe=${iframe ? 'yes' : 'no'}`);
      if (iframe) {
        sniffTargets.push({ name: 'iframe', url: absUrl(iframe), headers: { ...sniffHeaders, Referer: playUrl } });
      }
      sniffTargets.push({ name: 'playPage', url: playUrl, headers: sniffHeaders });
    }

    for (const target of sniffTargets) {
      try {
        await OmniBox.log('info', `[唐人街影院][play] sniff target=${target.name} url=${target.url}`);
        const sniffed = await OmniBox.sniffVideo(target.url, target.headers);
        await OmniBox.log('info', `[唐人街影院][play] sniff result target=${target.name} url=${text(sniffed?.url || '')}`);
        const sniffUrls = Array.isArray(sniffed?.urls) ? sniffed.urls.filter((item) => item?.url) : [];
        if (!sniffUrls.length && sniffed?.url) {
          sniffUrls.push({ name: target.name, url: sniffed.url });
        }
        if (sniffUrls.length) {
          return {
            parse: 0,
            urls: sniffUrls.map((item) => ({ name: item.name || target.name || '嗅探播放', url: item.url })),
            header: sniffed?.header || sniffed?.headers || target.headers,
            headers: sniffed?.header || sniffed?.headers || target.headers,
          };
        }
      } catch (sniffError) {
        await OmniBox.log('warn', `[唐人街影院][play] sniff failed target=${target.name}: ${sniffError.message}`);
      }
    }

    if (iframe) {
      return {
        urls: [{ name: 'iframe', url: absUrl(iframe) }],
        parse: 1,
        header: sniffHeaders,
      };
    }

    return {
      urls: [{ name: '默认线路', url: playUrl }],
      parse: 1,
      header: sniffHeaders,
    };
  } catch (e) {
    await OmniBox.log('error', `[唐人街影院][play] ${e.message}`);
    await OmniBox.log('error', `[唐人街影院][play] stack=${text(e.stack || '')}`);
    return {
      urls: [{ name: '默认线路', url: absUrl(params.playId || params.play_id || params.id || '') }],
      parse: 1,
      header: {
        'User-Agent': USER_AGENT,
        'Referer': BASE_URL + '/',
        'Origin': BASE_URL,
      },
    };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
