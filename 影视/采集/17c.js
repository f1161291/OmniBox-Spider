// @name 17c
// @author OmniBox
// @description 17c（17c.com 最新落地站）：多域名池 + AES-128-CBC 加密接口。首页/分类/搜索/详情/播放全通；分类树与所有接口响应均 AES 解密，播放取 m3u8 直链（parse=0，需站点 Referer）。
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/17c.js
// @dependencies axios, crypto
/**
 * ============ 17c（17c.com）OmniBox 采集源 ============
 * 【站点事实（2026-11-26 实测）】
 *  17c.com 本身连接被 RST；发布页 www.ogkmlcx.com:2087/1047.html 为反爬分发页，
 *  经多层解混淆（obfuscator.io 字符串阵列 + 移动UA门禁 + JSONP 配置）得到：
 *   - 站点域名池 20 个（getSetting.landingdomains，形如 https://1tym.xxx.cc）
 *   - 静态资源 CDN：https://cmsta.uitxn.cn/static/caomei/
 *   - API：GET {站点}/app/movie/getList|getDetail|getPlayUrl、/app/common/getSetting、getHotKeywordListV2
 *   - 所有接口响应为 AES-128-CBC/Pkcs7 的 base64 密文：
 *       KEY = NHboMHZerxFQ401E   IV = i7JeCEIMVrj2W9xN
 *   - 分类树：{staticCDN}static/common/category_tree.js（同样 AES 加密，13 顶层分类）
 *   - 列表：getList?cid=&page=&keyword= → { page,pageCount,pageSize,records[{viewKey,title,poster,duration,cid}] }
 *   - 详情：getDetail?viewKey= → data{ title,description,duration,poster,playUrl,downloadUrl,hits }
 *   - 播放：getPlayUrl?viewKey= → data{ playUrl, sourceInfoListVO[{playDomain,imgDomain,name}] }
 *           完整地址 = playDomain + playUrl；m3u8 需 Referer: {站点}/ 否则 403
 *
 * 环境变量：
 *  C17_HOSTS      站点域名逗号覆盖（默认自动从 getSetting 拉 landingdomains）
 *  C17_HOST       单域名覆盖
 *  C17_UA         自定义 UA
 *  C17_TIMEOUT    单请求超时毫秒，默认 15000
 *  C17_CACHE_TTL  缓存秒数，默认 300
 */
const axios = require('axios');
const crypto = require('crypto');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[17c]';
const UA = String(process.env.C17_UA || '').trim()
  || 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const TIMEOUT = Math.max(5000, Number(process.env.C17_TIMEOUT || 15000) || 15000);
const CACHE_TTL = Math.max(0, Number(process.env.C17_CACHE_TTL || 300) || 300);
const AES_KEY = String(process.env.C17_AES_KEY || 'NHboMHZerxFQ401E');
const AES_IV = String(process.env.C17_AES_IV || 'i7JeCEIMVrj2W9xN');
const STATIC_CDN = String(process.env.C17_STATIC_CDN || 'https://cmsta.uitxn.cn/static/caomei/').replace(/\/+$/, '/');

// 默认域名池（getSetting 拉取失败时的兜底）
const DEFAULT_HOSTS = [
  'https://1tym.scvnp2yrmg.cc', 'https://1tym.snu7ziyemg.cc', 'https://1tym.strx06fcmg.cc',
  'https://1tym.s2qtk6zjmg.cc', 'https://1tym.spxistqwmg.cc', 'https://1tym.sv8t5yvcmg.cc',
];
function splitHosts(s) { return String(s || '').split(/[,，]/).map(x => x.trim().replace(/\/+$/, '')).filter(Boolean); }
let HOSTS = (() => {
  const env = splitHosts(process.env.C17_HOSTS);
  const single = splitHosts(process.env.C17_HOST);
  const list = env.length ? env : (single.length ? single : DEFAULT_HOSTS);
  return Array.from(new Set(list));
})();
let preferred = 0;
const deadHosts = new Set();

function log(level, msg) { try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {} }
function text(v) { return v == null ? '' : String(v).trim(); }
function absUrl(u, base) { try { return new URL(String(u || '').trim(), base || HOSTS[preferred]).href; } catch (_) { return ''; } }
function decodeHtml(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function clean(s) { return decodeHtml(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

// AES-128-CBC/Pkcs7 解密（接口响应与静态配置共用）
function aesDecrypt(b64) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'));
    const out = Buffer.concat([d.update(Buffer.from(String(b64).trim(), 'base64')), d.final()]).toString('utf8');
    return out;
  } catch (_) { return ''; }
}
function decodePayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 已是 JSON 直接返回
  if (/^[\[{]/.test(s)) { try { return JSON.parse(s); } catch (_) {} }
  const plain = aesDecrypt(s);
  if (!plain) return null;
  try { return JSON.parse(plain); } catch (_) { return null; }
}

// 带域名轮换的 API 请求（自动解密）
async function apiGet(endpoint, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) qs.append(k, String(v));
  const suffix = endpoint + (qs.toString() ? `?${qs}` : '');
  const order = [preferred, ...HOSTS.map((_, i) => i).filter(i => i !== preferred && !deadHosts.has(i))];
  let lastErr;
  for (const idx of order) {
    const host = HOSTS[idx];
    if (deadHosts.has(idx)) continue;
    try {
      const res = await axios.get(host + suffix, {
        timeout: TIMEOUT, validateStatus: () => true,
        headers: { 'User-Agent': UA, 'Referer': host + '/', 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = decodePayload(res.data);
      if (!data) throw new Error('解密失败');
      if (data.errCode && Number(data.errCode) !== 0) throw new Error(data.msg || `errCode=${data.errCode}`);
      preferred = idx;
      return data;
    } catch (e) {
      lastErr = e;
      if (deadHosts.size < HOSTS.length - 1) deadHosts.add(idx);
      log('info', `[api] ${host} 失败(${e.message})，切下一个`);
    }
  }
  throw lastErr || new Error('所有域名不可用');
}

// 进程内缓存
const mem = new Map();
function memGet(k, ttl) { const v = mem.get(k); if (v && Date.now() - v.t < ttl) return v.d; return null; }
function memSet(k, d) { mem.set(k, { t: Date.now(), d }); }
async function cacheGet(k) { try { const v = await OmniBox.getCache(`${PREFIX}:${k}`); return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } }
async function cacheSet(k, d, ttl) { try { await OmniBox.setCache(`${PREFIX}:${k}`, JSON.stringify(d), ttl); } catch (_) {} }

// 站点设置（拿 landingdomains / imgdomain / playdomain）
let settingsCache = null;
async function loadSettings() {
  if (settingsCache) return settingsCache;
  const cached = await cacheGet('settings');
  if (cached && cached.imgdomain) { settingsCache = cached; return cached; }
  const data = await apiGet('/app/common/getSetting');
  const s = (data && data.data) || {};
  settingsCache = s;
  if (s.landingdomains && Array.isArray(s.landingdomains) && s.landingdomains.length) {
    // 用官方域名池刷新（保留用户显式配置优先）
    if (!process.env.C17_HOSTS && !process.env.C17_HOST) {
      HOSTS = Array.from(new Set(s.landingdomains.map(x => String(x).replace(/\/+$/, '')).filter(Boolean)));
      preferred = 0;
      deadHosts.clear();
      log('info', `[settings] 域名池刷新 ${HOSTS.length} 个`);
    }
  }
  await cacheSet('settings', s, 3600);
  return s;
}
function imgBase() { return (settingsCache && settingsCache.imgdomain) || ''; }
function playBase() { return (settingsCache && settingsCache.playdomain) || ''; }

// 分类树（静态加密 JS）
let categoryTree = null;
async function loadCategories() {
  if (categoryTree) return categoryTree;
  const cached = await cacheGet('cats');
  if (cached && cached.length) { categoryTree = cached; return cached; }
  try {
    const url = `${STATIC_CDN}/static/common/category_tree.js`.replace(/\/+/g, '/').replace('https:/', 'https://');
    const res = await axios.get(url, { timeout: TIMEOUT, validateStatus: () => true, headers: { 'User-Agent': UA, 'Referer': HOSTS[preferred] + '/' } });
    let body = res.data;
    if (typeof body !== 'string') body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    body = body.trim().replace(/^[^A-Za-z0-9+/=]+/, '').replace(/[^A-Za-z0-9+/=]+$/, '');
    const plain = aesDecrypt(body);
    const tree = JSON.parse(plain);
    if (Array.isArray(tree) && tree.length) {
      categoryTree = tree;
      memSet('cats', tree);
      await cacheSet('cats', tree, 6 * 3600);
      log('info', `[cat] 分类树 ${tree.length} 个顶层`);
      return tree;
    }
  } catch (e) { log('info', `[cat] 分类树加载失败: ${e.message}，用兜底`); }
  // 兜底
  categoryTree = [
    { id: 51, name: '国产' }, { id: 76, name: '日韩' }, { id: 127, name: '欧美' },
    { id: 93, name: '吃瓜' }, { id: 60, name: '传媒' }, { id: 137, name: 'AI视频' },
    { id: 83, name: '动漫' }, { id: 71, name: '综艺' }, { id: 198, name: '解说' },
    { id: 197, name: 'VR' }, { id: 199, name: '伦理' }, { id: 200, name: '猎奇' }, { id: 201, name: '福利姬' },
  ];
  return categoryTree;
}

function posterUrl(poster) {
  const p = text(poster);
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  const base = imgBase() || playBase() || HOSTS[preferred];
  return base.replace(/\/+$/, '') + (p.startsWith('/') ? p : '/' + p);
}

// ===== 封面内联：post.js 是 AES 加密图（与 API 同 KEY/IV），解密转 data URI（兼容 OK影视）=====
function sniffImage(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
const coverCache = new Map();
async function resolveCover(url) {
  if (!url || !/^https?:/i.test(url)) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await axios.get(url, {
      timeout: 8000, responseType: 'arraybuffer', validateStatus: () => true,
      headers: { 'User-Agent': UA, Referer: HOSTS[preferred] + '/' },
    });
    let buf = res.data;
    if (res.status === 200 && buf) {
      if (!Buffer.isBuffer(buf)) {
        if (buf.buffer && typeof buf.byteLength === 'number') buf = Buffer.from(buf.buffer, buf.byteOffset || 0, buf.byteLength);
        else if (Array.isArray(buf)) buf = Buffer.from(buf);
        else buf = Buffer.from(String(buf));
      }
      // 明文图直接内联；密文用 API 同 KEY/IV 解密
      let out = buf, mime = sniffImage(buf);
      if (!mime) {
        try {
          const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'));
          out = Buffer.concat([d.update(buf), d.final()]);
          mime = sniffImage(out);
        } catch (_) {}
      }
      if (mime && out.length > 100) {
        const uri = `data:${mime};base64,${out.toString('base64')}`;
        coverCache.set(url, uri);
        return uri;
      }
    }
  } catch (_) {}
  coverCache.set(url, url);
  return url;
}
async function resolveCovers(list) {
  if (!Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      const it = list[i];
      if (it && it.vod_pic) { try { it.vod_pic = await resolveCover(it.vod_pic); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, () => worker()));
  return list;
}

function mapRecord(r) {
  if (!r || !r.viewKey) return null;
  return {
    vod_id: text(r.viewKey),
    vod_name: clean(r.title),
    vod_pic: posterUrl(r.poster),
    vod_remarks: r.duration ? `${Math.floor(Number(r.duration) / 60)}分钟` : '',
    type_name: '',
    vod_year: '',
  };
}

// ============ 五方法 ============
async function home(params, context) {
  log('info', `home 入口 from=${(context && context.from) || 'web'}`);
  try {
    await loadSettings().catch(() => {});
    const tree = await loadCategories();
    const classes = tree.map(t => ({ type_id: String(t.id), type_name: text(t.name) }));
    let list = memGet('home:list', 5 * 60 * 1000);
    if (!list) { const c = await cacheGet('home'); if (c && c.length) list = c; }
    if (!list) {
      const data = await apiGet('/app/movie/getList', { page: 1 });
      const records = (data && (data.records || (data.data && data.data.records))) || [];
      list = records.map(mapRecord).filter(Boolean);
      if (list.length) { memSet('home:list', list); await cacheSet('home', list, CACHE_TTL); }
    }
    log('info', `home 返回 class=${classes.length} list=${list.length}`);
    await resolveCovers(list);
    return { class: classes, list, filters: {} };
  } catch (e) { log('error', `home 失败: ${e.message}`); return { class: [], list: [] }; }
}

async function category(params, context) {
  const cid = String((params && (params.categoryId ?? params.t ?? params.id ?? params.type_id)) || '');
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `category 入口 cid=${cid} page=${page}`);
  if (!cid) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    await loadSettings().catch(() => {});
    const data = await apiGet('/app/movie/getList', { cid, page });
    const records = (data && (data.records || (data.data && data.data.records))) || [];
    const list = records.map(mapRecord).filter(Boolean);
    const pageCount = Number((data && (data.pageCount ?? (data.data && data.data.pageCount))) || 0);
    await resolveCovers(list);
    log('info', `category 返回 cid=${cid} page=${page} list=${list.length} pageCount=${pageCount}`);
    return { page, pagecount: pageCount || (list.length ? page + 1 : page), total: pageCount ? pageCount * (Number(data.pageSize) || 18) : list.length, list };
  } catch (e) { log('error', `category 失败: ${e.message}`); return { page, pagecount: 0, total: 0, list: [] }; }
}

async function search(params, context) {
  const kw = String((params && (params.keyword ?? params.kw ?? params.wd ?? params.search)) || '').trim();
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `search 入口 kw=${kw} page=${page}`);
  if (!kw) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    await loadSettings().catch(() => {});
    const data = await apiGet('/app/movie/getList', { keyword: kw, page });
    const records = (data && (data.records || (data.data && data.data.records))) || [];
    const list = records.map(mapRecord).filter(Boolean);
    const pageCount = Number((data && (data.pageCount ?? (data.data && data.data.pageCount))) || 0);
    await resolveCovers(list);
    log('info', `search 返回 kw=${kw} list=${list.length}`);
    return { page, pagecount: pageCount || (list.length ? page + 1 : page), total: list.length, list };
  } catch (e) { log('error', `search 失败: ${e.message}`); return { page: 1, pagecount: 0, total: 0, list: [] }; }
}

async function detail(params, context) {
  const vid = String((params && (params.videoId ?? params.id)) || '').trim();
  log('info', `detail 入口 vid=${vid}`);
  if (!vid) return { list: [] };
  try {
    await loadSettings().catch(() => {});
    const data = await apiGet('/app/movie/getDetail', { viewKey: vid });
    const d = (data && (data.data || data)) || {};
    if (!d || (!d.title && !d.playUrl)) throw new Error('详情为空');
    // 播放地址：优先 getPlayUrl 拿 playDomain，失败则用详情里的相对 playUrl
    let playUrl = '';
    let playDomain = playBase();
    try {
      const pdata = await apiGet('/app/movie/getPlayUrl', { viewKey: vid });
      const pd = (pdata && (pdata.data || pdata)) || {};
      if (pd.playUrl) playUrl = text(pd.playUrl);
      const src = Array.isArray(pd.sourceInfoListVO) ? pd.sourceInfoListVO : [];
      if (src.length && src[0].playDomain) playDomain = text(src[0].playDomain);
    } catch (e) { log('info', `getPlayUrl 失败: ${e.message}，回退详情地址`); }
    if (!playUrl) playUrl = text(d.playUrl || d.downloadUrl);
    let full = playUrl;
    if (playUrl && !/^https?:\/\//i.test(playUrl)) {
      full = (playDomain || HOSTS[preferred]).replace(/\/+$/, '') + (playUrl.startsWith('/') ? playUrl : '/' + playUrl);
    }
    const sources = full ? [{ name: '默认线路', episodes: [{ name: '正片', playId: full }] }] : [];
    const item = {
      vod_id: vid,
      vod_name: clean(d.title),
      vod_pic: posterUrl(d.poster),
      vod_content: clean(d.description === 'unkown' ? '' : d.description),
      vod_remarks: d.duration ? `${Math.floor(Number(d.duration) / 60)}分钟` : '',
      type_name: '',
      vod_play_sources: sources.length ? sources : undefined,
    };
    if (item.vod_pic) { try { item.vod_pic = await resolveCover(item.vod_pic); } catch (_) {} }
    log('info', `detail 返回 vid=${vid} title=${clean(d.title).slice(0, 20)} sources=${sources.length}`);
    return { list: [item] };
  } catch (e) { log('error', `detail 失败: ${e.message}`); return { list: [] }; }
}

async function play(params, context) {
  const flag = String((params && params.flag) || '17c');
  const raw = String((params && (params.playId ?? params.url ?? params.id)) || '').trim();
  log('info', `play 入口 flag=${flag} url=${raw.slice(0, 80)}`);
  const header = { 'User-Agent': UA, Referer: HOSTS[preferred] + '/', Origin: HOSTS[preferred] };
  if (!raw) return { urls: [], flag, header, parse: 0 };
  try {
    // playId 可能带 "相对路径|||viewKey"，需要现取最新签名地址
    const parts = raw.split('|||');
    let url = parts[0];
    if (!/^https?:\/\//i.test(url) && parts[1]) {
      const data = await apiGet('/app/movie/getPlayUrl', { viewKey: parts[1] });
      const pd = (data && (data.data || data)) || {};
      const pdUrl = text(pd.playUrl);
      const src = Array.isArray(pd.sourceInfoListVO) ? pd.sourceInfoListVO : [];
      const dom = src.length && src[0].playDomain ? text(src[0].playDomain) : playBase();
      if (pdUrl) url = (dom || HOSTS[preferred]).replace(/\/+$/, '') + (pdUrl.startsWith('/') ? pdUrl : '/' + pdUrl);
    }
    const parse = /\.(m3u8|mp4)(\?|$)/i.test(url) ? 0 : 1;
    log('info', `play 输出 parse=${parse} url=${url.slice(0, 100)}`);
    return { urls: [{ name: '正片', url }], flag, header, parse };
  } catch (e) { log('error', `play 失败: ${e.message}`); return { urls: [], flag, header, parse: 0 }; }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
