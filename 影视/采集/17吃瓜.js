// @name 17吃瓜
// @author OmniBox
// @description 17吃瓜（17cg.me / 17chigua.tv）：从 App 的 WordPress REST API 采文章+视频，4 域名自动轮换，session_id 签名；首页/分类/搜索/详情；详情 DPlayer config 直取 m3u8（parse=0）。多域名容错 + 封面内联。参考 51吃瓜/黑料网。
// @version 1.0.2
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/17吃瓜.js
// @dependencies axios
/**
 * ============ 17吃瓜（17cg.me / 17chigua.tv）OmniBox 采集源 ============
 * 【站点事实（2026-11-26 实测）】
 *  - 17cg.com 是停放页；17cg.me / 17chigua.tv 是 Loading 跳转页，
 *    JS 解混淆后得到 4 个 .icu 入口域名（PC + 手机各 4）与 cloudfront 兜底。
 *  - 真正内容在 Vue/Vite SPA（入口如 xge1ig.xks1dt.icu），
 *    其 API 为 WordPress REST：/wp-json/wp/v2，4 个 API 域名轮换：
 *      x8ilkj.vxt4pas.com / p9dlsm.mzr3fq.com / oi0kdu.txrw2gf.com / rui6gn.zqt1xa.com
 *  - 所有请求需 session_id 参数：
 *      session_id = base64( XOR( "秒级时间戳|HTTP方法|请求路径", 循环密钥 "TESTLBSA" ) )
 *    （来自 SPA index.js 的 jk()/Nk()，已在本地逐字节复现验证）
 *  - 端点：metaList(分类) / postList(列表,支持 keyword/per_page/page/categories) /
 *    postSingle?id=(详情)；详情 content 里 <dplayer data-config='{"video":{"url":m3u8,...}}'>。
 *  - 数据字段：title.rendered / id / post_thumbnail_image / category_name /
 *    excerpt.rendered / category_list[{cat_id,cat_name}] / date_gmt 等。
 *
 * 环境变量：
 *  SEVENTEEN_HOSTS     API 域名逗号覆盖（默认内置 4 个）
 *  SITE_API            API 基址（单个域名时优先，等价于覆盖）
 *  SEVENTEEN_UA        自定义 UA
 *  SEVENTEEN_TIMEOUT   单请求超时毫秒，默认 15000
 *  SEVENTEEN_CACHE_TTL 首页/分类缓存秒数，默认 300
 *  DANMU_API           弹幕服务（可选）
 */
const axios = require('axios');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[17吃瓜]';
const UA = String(process.env.SEVENTEEN_UA || '').trim()
  || 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const TIMEOUT = Math.max(5000, Number(process.env.SEVENTEEN_TIMEOUT || 15000) || 15000);
const CACHE_TTL = Math.max(0, Number(process.env.SEVENTEEN_CACHE_TTL || 300) || 300);
const SIGN_KEY = 'TESTLBSA';
const API_PATH = '/wp-json/wp/v2';

function splitHosts(s) {
  return String(s || '').split(/[,，]/).map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
}
const DEFAULT_HOSTS = [
  'https://x8ilkj.vxt4pas.com',
  'https://p9dlsm.mzr3fq.com',
  'https://oi0kdu.txrw2gf.com',
  'https://rui6gn.zqt1xa.com',
];
const HOSTS = (() => {
  const fromSite = splitHosts(process.env.SITE_API_06);
  const fromEnv = splitHosts(process.env.SEVENTEEN_HOSTS);
  const list = fromEnv.length ? fromEnv : (fromSite.length ? fromSite : DEFAULT_HOSTS);
  return Array.from(new Set(list));
})();
let preferred = 0;
const deadHosts = new Set();

function log(level, msg) { try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {} }
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.rendered || v.name || v.title || '').trim();
  return String(v).trim();
}
function absUrl(u, base) { try { return new URL(String(u || '').trim(), base).href; } catch (_) { return ''; } }
function decodeEntities(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function clean(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

// session_id 签名：base64( XOR(msg, 循环 key) )，msg = 秒|方法|路径
function makeSessionId(method, path) {
  const sec = Math.floor(Date.now() / 1000);
  const msg = `${sec}|${method}|${path}`;
  const out = Buffer.alloc(msg.length);
  for (let i = 0; i < msg.length; i++) out[i] = msg.charCodeAt(i) ^ SIGN_KEY.charCodeAt(i % SIGN_KEY.length);
  return out.toString('base64');
}

// API 请求：按 preferred 起轮换；失败/死链剔除；自动带 session_id
async function apiGet(endpoint, params = {}) {
  const path = API_PATH + endpoint;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) qs.append(k, String(v));
  qs.append('session_id', makeSessionId('GET', path));
  const urlSuffix = `${path}?${qs.toString()}`;
  const order = [preferred, ...HOSTS.map((_, i) => i).filter(i => i !== preferred && !deadHosts.has(i))];
  let lastErr;
  for (const idx of order) {
    const host = HOSTS[idx];
    if (deadHosts.has(idx)) continue;
    try {
      const res = await axios.get(host + urlSuffix, {
        timeout: TIMEOUT, validateStatus: () => true,
        headers: { 'User-Agent': UA, 'Referer': host + '/', 'Accept': 'application/json,text/plain,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      let data = res.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { throw new Error('非 JSON 响应'); } }
      if (data && (data.code === 404 || data.code === 401)) throw new Error(data.message || '接口拒绝');
      preferred = idx;
      return data;
    } catch (e) {
      lastErr = e;
      if (deadHosts.size < HOSTS.length - 1) deadHosts.add(idx);
      log('info', `[api] ${host} 失败(${e.message})，切换下一个`);
    }
  }
  throw lastErr || new Error('所有 API 域名不可用');
}

// 进程内缓存
const mem = new Map();
function memGet(k, ttl) { const v = mem.get(k); if (v && Date.now() - v.t < ttl) return v.d; return null; }
function memSet(k, d) { mem.set(k, { t: Date.now(), d }); }
async function cacheGet(k) { try { const v = await OmniBox.getCache(`${PREFIX}:${k}`); return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } }
async function cacheSet(k, d, ttl) { try { await OmniBox.setCache(`${PREFIX}:${k}`, JSON.stringify(d), ttl); } catch (_) {} }

function mapVod(post, base) {
  if (!post || typeof post !== 'object') return null;
  const id = String(post.id || post.slug || '');
  if (!id) return null;
  const cats = Array.isArray(post.category_list) ? post.category_list : [];
  return {
    vod_id: id,
    vod_name: text(post.title),
    vod_pic: absUrl(post.post_thumbnail_image || post.post_first_image || post.post_medium_image || post.post_full_image, base),
    vod_remarks: text(post.date) || text(post.date_gmt),
    vod_content: clean(post.excerpt && post.excerpt.rendered),
    vod_year: String(post.date_gmt || '').slice(0, 4),
    type_name: text(post.category_name) || (cats[0] && cats[0].cat_name) || '',
  };
}

async function loadCategories() {
  const hit = memGet('cats', 6 * 3600 * 1000);
  if (hit) return hit;
  const cached = await cacheGet('cats');
  if (cached && cached.length) { memSet('cats', cached); return cached; }
  const raw = await apiGet('/metaList', { taxonomy: 'category', per_page: 100, orderby: 'id', order: 'asc' });
  const list = (Array.isArray(raw) ? raw : []).filter(c => c && c.name && c.id)
    .map(c => ({ type_id: String(c.id), type_name: text(c.name), count: Number(c.count || 0) }));
  if (list.length) { memSet('cats', list); await cacheSet('cats', list, 6 * 3600); }
  log('info', `[cat] 分类数=${list.length}`);
  return list;
}

function buildFilters(categories) {
  const values = [{ name: '全部', value: '' }, ...categories.slice(0, 60).map(c => ({ name: c.type_name, value: c.type_id }))];
  return { cat: [{ key: 'cat', name: '分类', init: '', value: values }] };
}
function pickCat(params) {
  const src = (params && (params.filters || params.extend || params.ext || params.filter)) || {};
  let v = src.cat ?? src['分类'] ?? src.categoryId ?? '';
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v.value ?? v.v ?? '';
  return String(v || '').trim();
}

// ============ 五方法 ============
async function home(params, context) {
  log('info', `home 入口 from=${(context && context.from) || 'web'}`);
  try {
    let categories = await loadCategories().catch(() => []);
    if (!categories.length) categories = [
      { type_id: '471', type_name: '今日大瓜' }, { type_id: '7832', type_name: '自拍偷拍' },
    ];
    let list = memGet('home:list', 5 * 60 * 1000);
    if (!list) { const c = await cacheGet('home'); if (c && c.length) list = c; }
    if (!list) {
      const raw = await apiGet('/postList', { per_page: 30, orderby: 'date', order: 'desc', page: 1 });
      list = (Array.isArray(raw) ? raw : []).map(p => mapVod(p, HOSTS[preferred])).filter(Boolean);
      if (list.length) { memSet('home:list', list); await cacheSet('home', list, CACHE_TTL); }
    }
    log('info', `home 返回 class=${categories.length} list=${list.length}`);
    return { class: categories.map(c => ({ type_id: c.type_id, type_name: c.type_name })), list, filters: buildFilters(categories) };
  } catch (e) { log('error', `home 失败: ${e.message}`); return { class: [], list: [], filters: {} }; }
}

async function category(params, context) {
  const id = pickCat(params) || String((params && (params.categoryId ?? params.cid ?? params.t ?? params.id)) || '');
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `category 入口 id=${id} page=${page}`);
  if (!id) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const raw = await apiGet('/postList', { per_page: 30, page, categories: id, orderby: 'date', order: 'desc' });
    const list = (Array.isArray(raw) ? raw : []).map(p => mapVod(p, HOSTS[preferred])).filter(Boolean);
    log('info', `category 返回 id=${id} list=${list.length}`);
    return { page, pagecount: list.length >= 30 ? page + 1 : page, total: page * 30 + (list.length >= 30 ? 1 : 0), list };
  } catch (e) { log('error', `category 失败: ${e.message}`); return { page, pagecount: 0, total: 0, list: [] }; }
}

async function search(params, context) {
  const kw = String((params && (params.keyword ?? params.kw ?? params.wd ?? params.search)) || '').trim();
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `search 入口 kw=${kw}`);
  if (!kw) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const raw = await apiGet('/postList', { per_page: 30, page, search: kw, orderby: 'date', order: 'desc' });
    const list = (Array.isArray(raw) ? raw : []).map(p => mapVod(p, HOSTS[preferred])).filter(Boolean);
    log('info', `search 返回 kw=${kw} list=${list.length}`);
    return { page, pagecount: list.length >= 30 ? page + 1 : page, total: page * 30 + (list.length >= 30 ? 1 : 0), list };
  } catch (e) { log('error', `search 失败: ${e.message}`); return { page: 1, pagecount: 0, total: 0, list: [] }; }
}

// DPlayer data-config 解析：返回 [{name,url}]
function parseDPlayer(content) {
  const out = [];
  const html = String(content || '');
  // data-config 挂在 <div class="dplayer" data-config='...'> 上（不是 <dplayer> 标签）。
  // 用反引用 \1 保证开闭引号一致；单引号包裹时内部 JSON 是裸双引号，双引号包裹时内部转义。
  const re = /data-config=(['"])([\s\S]*?)\1/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[2];
    if (m[1] === '"') raw = raw.replace(/\\"/g, '"');
    raw = raw.replace(/\\\//g, '/').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    try {
      const cfg = JSON.parse(raw);
      const v = cfg && cfg.video;
      if (!v) continue;
      if (v.url) out.push({ name: '线路1', url: String(v.url) });
      const extra = Array.isArray(v.urls) ? v.urls : [];
      for (const u of extra) { const url = String(u.url || u.link || ''); if (url) out.push({ name: text(u.name) || `线路${out.length + 1}`, url }); }
    } catch (e) { /* 忽略单个坏 config */ }
  }
  return out;
}

async function detail(params, context) {
  const vid = String((params && (params.videoId ?? params.id)) || '').trim();
  log('info', `detail 入口 vid=${vid}`);
  if (!vid) return { list: [] };
  try {
    const cacheKey = `detail:${vid}`;
    let built = memGet(cacheKey, 10 * 60 * 1000);
    if (!built) { const c = await cacheGet(cacheKey); if (c && c.sources) built = c; }
    if (!built) {
      const post = await apiGet('/postSingle', { id: vid });
      if (!post || !post.id) throw new Error('详情为空');
      const content = String((post.content && post.content.rendered) || '');
      let eps = parseDPlayer(content);
      if (!eps.length) {
        // 兜底：正文里直接出现的 m3u8/mp4
        const urls = content.match(/https?:\/\/[^"'<>\s\\]+\.(?:m3u8|mp4)(?:\?[^"'<>\s\\]*)?/gi) || [];
        eps = [...new Set(urls)].map((u, i) => ({ name: `线路${i + 1}`, url: u }));
      }
      // 去重
      const seen = new Set();
      eps = eps.filter(e => { if (!e.url || seen.has(e.url)) return false; seen.add(e.url); return true; });
      built = {
        name: text(post.title),
        pic: absUrl(post.post_thumbnail_image || post.post_first_image || post.post_medium_image, HOSTS[preferred]),
        content: clean(content).slice(0, 3000),
        sources: eps.length ? [{ name: '默认线路', episodes: eps.map(e => ({ name: e.name, playId: e.url })) }] : [],
      };
      if (built.sources.length) { memSet(cacheKey, built); await cacheSet(cacheKey, built, 1800); }
    }
    const playSources = built.sources.map(s => ({ name: s.name, episodes: s.episodes.map(e => ({ name: e.name, playId: e.playId })) }));
    log('info', `detail 返回 vid=${vid} sources=${playSources.length} eps=${playSources.reduce((n, s) => n + s.episodes.length, 0)}`);
    // 图文/吃瓜站按宿主约定返回 list 包裹结构（对齐 51吃瓜/黑料网），扁平结构宿主无法识别详情项
    return {
      list: [{
        vod_id: vid, vod_name: built.name, vod_pic: built.pic, vod_content: built.content,
        type_name: '吃瓜',
        vod_play_sources: playSources.length ? playSources : undefined,
      }],
    };
  } catch (e) { log('error', `detail 失败: ${e.message}`); return { list: [] }; }
}

async function play(params, context) {
  const flag = String((params && params.flag) || '17吃瓜');
  const raw = String((params && (params.playId ?? params.url ?? params.id)) || '').trim();
  log('info', `play 入口 from=${(context && context.from) || 'web'} flag=${flag}`);
  const header = { 'User-Agent': UA, Referer: HOSTS[preferred] + '/', Origin: HOSTS[preferred] };
  if (!raw) return { urls: [], flag, header, parse: 0 };
  try {
    const parse = /^https?:\/\//i.test(raw) && /\.(m3u8|mp4)(?:\?|$)/i.test(raw) ? 0 : 1;
    return { urls: [{ name: '播放', url: raw }], flag, header, parse };
  } catch (e) { log('error', `play 失败: ${e.message}`); return { urls: [], flag, header, parse: 0 }; }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
