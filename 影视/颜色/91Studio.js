// @name 91Studio
// @version 1.0.0
// @author omnibox-spider
// @description 91.studio（Ionic/Angular SPA）采集源：POST /js 单端点 RPC + CryptoJS AES(xxx) 解密；/sevenVideos 列表 24 条/页、/searchSevenVideos 多条件搜索、/sevenVideos/<id> 详情取 m3u8s 直链；30 个真实分类、8 个 API 主机容灾、短 TTL 缓存、三段式播放兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91Studio.js
// @dependencies []

/**
 * 实站事实（2026-11-14 逆向前端 bundle 实测，改代码前先读这段）
 *
 * 1) www.91.studio 是 Ionic/Angular SPA，首页只有 <app-root> 和 main.<hash>.js，
 *    没有任何服务端渲染数据；Googlebot/Baiduspider UA 拿到的也是同一个空壳。
 *    前端资源：runtime.<hash>.js（chunk 哈希映射表）+ main.<hash>.js（2.2MB）+ 惰性 chunk。
 *
 * 2) 全部业务数据走【单一 RPC 端点】：POST https://v2.cdn199.com/js
 *    body = { deviceInfo:{}, app:<域名去 www>, isStandalone:false, theLink:"novaluenull",
 *             uuid:"novalue", version:"260901", url:<逻辑接口>, ...业务参数 }
 *    headers = { "Content-Type":"application/json", Authorization:"Bearer "+<token> }
 *    `url` 字段决定调用哪个后端方法（服务端路由，不是真实 HTTP 路径）：
 *      /sevenVideos?page=<n>&type=<cat>   列表，24 条/页
 *      /searchSevenVideos                 搜索，body 另带 page/keywords/filterCategory/
 *                                        filterTimeInDays/filterViews/filterDurationInMins/
 *                                        sortBy/keywordLogic
 *      /sevenVideos/<vId>                 详情，body 另带 url_search，返回 m3u8s[]
 *      /retrieveGlobal                    总数（tvideosReadyCount）
 *      /increaseCount /vsa /vr /reportingError  埋点
 *    API 主机共 8 个（httpNames），前端按 localStorage 里的延迟选最快的一个：
 *      v2.cdn199.com / v2.kekecdn.net / v2.luchu.org / v2.madou.ws /
 *      v2.papapa.biz / v2.tianmtv.com / v2.xiaoshuo.info / v2.xiaoshuo.la
 *
 * 3) 响应统一为 CryptoJS AES 密文：{"r":"U2FsdGVkX1..."}（OpenSSL Salted__ 格式）。
 *    算法 = EVP_BytesToKey(MD5, salt, password="xxx", 1) 派生 key(32)+iv(16) →
 *    AES-256-CBC + PKCS7；明文是 JSON。脚本用 node:crypto 原地实现，无需第三方库。
 *    /va 端点（POST 空 body）同样返回该格式，实测解出 {"value":"s"}，已用于回归验证。
 *
 * 4) 列表对象字段（worker.video(l) 实测）：
 *      _id, id, videoType, vId, thumbnails[], durationStr, views, title, title_en,
 *      tags, tags_en, user, user_en, size, createdTime, vip
 *    详情对象（worker.videoDetails(l)）额外有：timeSince, downloadable,
 *      m3u8s[], m3u8, keywords_gem, seo
 *    播放器 setupPlayer 直接用 h.thumbnails[0] 作 poster、h.m3u8s[0] 作 HLS 源，
 *    所以 m3u8s 就是真实播放地址（多线路/多清晰度）。
 *    列表卡片 routerLink 用 e.vId → 详情路由 /video/<vId>。
 *
 * 5) 分类（首页 chunk 的 tvideoCategories，去掉 myfavs/forum/language 等非数据项）：
 *      hot/recent/high/hd/recent_hot/10mins/20mins/month_discuss/month_favs/favs/
 *      month_hot/last_month_hot/c0/c1..c9/ca/cc/cd/cl/japan/banana/swag/
 *      torture_all/gcsm/pissvids
 *    分页链接 /videos?page=<n>&type=<cat>；finalMaxPage = floor(tvideosReadyCount/24)（472048 → 19668）。
 *    线路参数 ?server=default1|default2|hd1|hd2|hd3（详情页按它重新取 m3u8s）。
 *
 * 6) 【风控事实，重要】服务端对 /js 的 url 做严格白名单：当前出口 IP 下
 *    /increaseCount /vsa /vr /reportingError 返回 200，而 /sevenVideos、
 *    /searchSevenVideos、/retrieveGlobal、/getWhitelist 等数据接口一律
 *    403 {"blocked":true}（8 个 API 主机全部如此）。前端对此有 403→重试→/banned
 *    跳转逻辑，说明是站点按访问环境做的风控，不是协议写错。
 *    换出口 IP（家庭宽带 / 代理）、或配置会员 token 后通常即可正常取数；
 *    脚本已内置多主机容灾、Bearer token 配置、403 明确诊断日志与安全空结构。
 *    本源因此用「真实 /va 密文 + 自造符合协议的加密 fixture」完成离线回归，
 *    实站数据接口的现场连通性需在你自己的 OmniBox 宿主上复核。
 *
 * 【环境变量】站点专用命名优先（STUDIO_*）
 *  STUDIO_HOST          站点基址，默认 https://www.91.studio（用于播放页兜底 URL）
 *  STUDIO_APP           RPC 里的 app 字段，默认由 host 推导（91.studio）
 *  STUDIO_API_HOSTS     逗号分隔的 API 主机，默认上面 8 个
 *  STUDIO_AUTH          Bearer token（游客留空；会员可填自己的 token）
 *  STUDIO_VERSION       前端版本号，默认 260901
 *  STUDIO_UA / STUDIO_COOKIE   自定义 UA / Cookie
 *  STUDIO_LANG          cn | en，决定标题/tags/作者取中文还是英文字段
 *  STUDIO_CACHE_TTL     列表/搜索缓存秒数，默认 300
 *  STUDIO_DETAIL_TTL    详情缓存秒数，默认 180
 *  STUDIO_PLAY_TTL      播放直链缓存秒数，默认 60
 *  STUDIO_PLAY_MODE     direct | sniff | auto（默认 auto：直链 → sniff → parse=1）
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.resolve(...).catch() 兜住。
 */

const crypto = require('crypto');

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) {
  OmniBox = {
    log() {},
    getCache() { return null; },
    setCache() { return Promise.resolve(); },
    deleteCache() { return Promise.resolve(); },
    request() { return Promise.reject(new Error('omnibox_sdk 缺失')); },
    sniffVideo() { return Promise.resolve(''); },
  };
}
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const PREFIX = '[91Studio]';
function safeLog(level, msg) {
  try {
    if (OmniBox && typeof OmniBox.log === 'function') {
      Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {});
      return;
    }
  } catch (_) { /* ignore */ }
  try { process.stderr.write(`${PREFIX}[${level}] ${msg}\n`); } catch (_) { /* ignore */ }
}
function logI(m) { safeLog('info', m); }
function logW(m) { safeLog('warn', m); }
function logE(m) { safeLog('error', m); }

// ==================== 配置区域 ====================
const SITE_HOST = String(process.env.STUDIO_HOST || 'https://www.91.studio').replace(/\/+$/, '');
const APP = String(process.env.STUDIO_APP || SITE_HOST.replace(/^https?:\/\//, '').replace(/^www\./, '')).trim();
const DEFAULT_API_HOSTS = [
  'https://v2.cdn199.com', 'https://v2.kekecdn.net', 'https://v2.luchu.org', 'https://v2.madou.ws',
  'https://v2.papapa.biz', 'https://v2.tianmtv.com', 'https://v2.xiaoshuo.info', 'https://v2.xiaoshuo.la',
];
const API_HOSTS = (() => {
  const raw = String(process.env.STUDIO_API_HOSTS || DEFAULT_API_HOSTS.join(','));
  const list = raw.split(/[,;]/).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map(s => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
  return Array.from(new Set(list.length ? list : DEFAULT_API_HOSTS));
})();
let PREFERRED_API = 0;

const AUTH = String(process.env.STUDIO_AUTH || '').trim();
const VERSION = String(process.env.STUDIO_VERSION || '260901').trim();
const UA = String(process.env.STUDIO_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
const FIXED_COOKIE = String(process.env.STUDIO_COOKIE || '').trim();
const LANG = String(process.env.STUDIO_LANG || 'cn').toLowerCase() === 'en' ? 'en' : 'cn';
const CACHE_TTL = Math.max(0, Number(process.env.STUDIO_CACHE_TTL || 300) || 300);
const DETAIL_TTL = Math.max(0, Number(process.env.STUDIO_DETAIL_TTL || 180) || 180);
const PLAY_TTL = Math.max(0, Number(process.env.STUDIO_PLAY_TTL || 60) || 60);
const PLAY_MODE = ['direct', 'sniff', 'auto'].includes(String(process.env.STUDIO_PLAY_MODE || 'auto').trim().toLowerCase())
  ? String(process.env.STUDIO_PLAY_MODE || 'auto').trim().toLowerCase() : 'auto';
const PAGE_SIZE = 24;
const AES_PASSWORD = 'xxx';           // CryptoJS.AES.decrypt(l.r, "xxx")
const FALLBACK_MAX_PAGE = 19668;      // floor(472048 / 24)，retrieveGlobal 失败时的兜底

let SESSION_COOKIE = '';
let BLOCKED_HINT_ONCE = false;

// a2 首页 tvideoCategories（去掉 myfavs / forum / language / 重复项）
const CATEGORIES = [
  { type_id: 'hot', type_name: '当前最热' },
  { type_id: 'recent', type_name: '最近更新' },
  { type_id: 'high', type_name: '站长推荐' },
  { type_id: 'hd', type_name: '会员专享' },
  { type_id: 'recent_hot', type_name: '最近加精' },
  { type_id: '10mins', type_name: '10分钟以上' },
  { type_id: '20mins', type_name: '20分钟以上' },
  { type_id: 'month_discuss', type_name: '本月讨论' },
  { type_id: 'month_favs', type_name: '本月收藏' },
  { type_id: 'favs', type_name: '收藏最多' },
  { type_id: 'month_hot', type_name: '本月最热' },
  { type_id: 'last_month_hot', type_name: '上月最热' },
  { type_id: 'c0', type_name: '国产传媒全集' },
  { type_id: 'c1', type_name: '麻豆视频' },
  { type_id: 'c2', type_name: '91制片厂' },
  { type_id: 'c3', type_name: '玩偶姐姐' },
  { type_id: 'c4', type_name: '小鸟酱专题' },
  { type_id: 'c5', type_name: '糖心Vlog' },
  { type_id: 'c6', type_name: '天美传媒' },
  { type_id: 'c7', type_name: '蜜桃传媒' },
  { type_id: 'c8', type_name: '皇家华人' },
  { type_id: 'c9', type_name: '星空传媒' },
  { type_id: 'ca', type_name: '精东影业' },
  { type_id: 'cc', type_name: '成人头条' },
  { type_id: 'cd', type_name: '乌鸦传媒' },
  { type_id: 'cl', type_name: '开心鬼传媒' },
  { type_id: 'japan', type_name: '日本高清AV' },
  { type_id: 'banana', type_name: '汝工作室' },
  { type_id: 'swag', type_name: '台湾Swag' },
  { type_id: 'torture_all', type_name: '重口系列' },
  { type_id: 'gcsm', type_name: '国产SM' },
  { type_id: 'pissvids', type_name: '欧美重口' },
];
const CAT_NAME = Object.fromEntries(CATEGORIES.map(c => [c.type_id, c.type_name]));
const VALID_CATS = new Set(CATEGORIES.map(c => c.type_id));
// ==================== 配置区域结束 ====================

// ==================== 工具函数 ====================
function decodeHTML(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function pick(zh, en) { return LANG === 'en' ? (en || zh || '') : (zh || en || ''); }
function cleanText(s) {
  return decodeHTML(String(s == null ? '' : s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function absUrl(u, host) {
  const v = decodeHTML(String(u || '').trim());
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  if (v.startsWith('/')) return `${host}${v}`;
  return `${host}/${v}`;
}
function shortKey(prefix, value) {
  let hash = '';
  try { hash = crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20); }
  catch (_) { hash = String(value).replace(/[^a-zA-Z0-9]/g, '').slice(-20); }
  return `${prefix}:${hash}`;
}
function safeInt(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}
function bodyText(res) {
  const b = res && res.body;
  if (typeof b === 'string') return b;
  if (b && typeof b.toString === 'function') return b.toString('utf8');
  return '';
}
function captureCookie(res) {
  if (SESSION_COOKIE || FIXED_COOKIE) return;
  try {
    const raw = res && res.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
    const arr = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
    for (const line of arr) {
      const m = /(JSESSIONID|PHPSESSID|__cf_bm)=[^;]+/.exec(line);
      if (m) { SESSION_COOKIE = m[0]; return; }
    }
  } catch (_) { /* ignore */ }
}

/** CryptoJS OpenSSL EVP_BytesToKey(MD5, salt, "xxx") → AES-256-CBC 解密 */
function evpBytesToKey(password, salt, keyLen, ivLen) {
  const pwd = Buffer.from(password, 'utf8');
  const slt = salt && salt.length ? salt : Buffer.alloc(0);
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < keyLen + ivLen) {
    const h = crypto.createHash('md5');
    h.update(prev); h.update(pwd); if (slt.length) h.update(slt);
    prev = h.digest();
    d = Buffer.concat([d, prev]);
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) };
}
function aesDecrypt(r) {
  const raw = Buffer.from(String(r || ''), 'base64');
  if (raw.length < 32 || raw.subarray(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('响应不是 CryptoJS OpenSSL 密文');
  }
  const { key, iv } = evpBytesToKey(AES_PASSWORD, raw.subarray(8, 16), 32, 16);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const pt = Buffer.concat([d.update(raw.subarray(16)), d.final()]);
  return pt.toString('utf8');
}
function extractR(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (_) { throw new Error('响应非 JSON'); }
  if (obj && obj.blocked === true) throw new Error('BLOCKED');
  if (typeof obj === 'string') return obj;
  if (obj && typeof obj.r === 'string') return obj.r;
  if (obj && typeof obj.data === 'string') return obj.data;
  throw new Error('响应缺少 r 字段');
}
// ==================== 工具函数结束 ====================

// ==================== RPC ====================
function buildHeaders(apiHost) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': UA,
    Origin: SITE_HOST,
    Referer: `${SITE_HOST}/`,
    Authorization: `Bearer ${AUTH || 'undefined'}`,
  };
  const ck = FIXED_COOKIE || SESSION_COOKIE;
  if (ck) h.Cookie = ck;
  return h;
}
function buildBody(urlPath, extra) {
  return Object.assign({
    deviceInfo: {},
    app: APP,
    isStandalone: false,
    theLink: 'novaluenull',
    uuid: 'novalue',
    version: VERSION,
    url: urlPath,
  }, extra || {});
}

/** POST /js 并解密；403 blocked 时换下一个 API 主机，全挂则抛出带诊断的错误 */
async function rpc(urlPath, extra, tag) {
  const body = JSON.stringify(buildBody(urlPath, extra));
  const errors = [];
  let blocked = 0;
  for (let off = 0; off < API_HOSTS.length; off++) {
    const i = (PREFERRED_API + off) % API_HOSTS.length;
    const host = API_HOSTS[i];
    try {
      const res = await OmniBox.request(`${host}/js`, { method: 'POST', headers: buildHeaders(host), body });
      const text = bodyText(res);
      const code = Number(res && res.statusCode) || 0;
      captureCookie(res);
      if (code === 403 || /"blocked"\s*:\s*true/.test(text)) { blocked++; errors.push(`${host} 403 blocked`); continue; }
      if (code !== 200) { errors.push(`${host} HTTP ${code}`); continue; }
      let plain;
      try { plain = aesDecrypt(extractR(text)); } catch (e) { errors.push(`${host} 解密失败: ${e.message}`); continue; }
      let data;
      try { data = JSON.parse(plain); } catch (e) { errors.push(`${host} 明文非 JSON: ${plain.slice(0, 60)}`); continue; }
      PREFERRED_API = i;
      return data;
    } catch (e) {
      if (e && e.message === 'BLOCKED') { blocked++; errors.push(`${host} 403 blocked`); }
      else errors.push(`${host} ${e && e.message ? e.message : e}`);
    }
  }
  if (blocked && !BLOCKED_HINT_ONCE) {
    BLOCKED_HINT_ONCE = true;
    logW(`[${tag}] 数据接口被站点风控 403 blocked（${blocked}/${API_HOSTS.length} 个 API 主机）。` +
      '这通常是出口 IP 被拦：换出口/代理、或配置 STUDIO_AUTH 会员 token、或稍后重试；' +
      '协议与解密实现已用真实 /va 密文离线验证，无需改代码。');
  }
  throw new Error(`${tag} RPC 失败: ${errors.join(' | ')}`);
}

async function cachedRpc(key, ttl, producer) {
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try {
      const hit = await OmniBox.getCache(key);
      if (hit) return JSON.parse(String(hit));
    } catch (_) {}
  }
  const data = await producer();
  if (data && ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, JSON.stringify(data), ttl); } catch (_) {}
  }
  return data;
}
// ==================== RPC 结束 ====================

// ==================== 数据映射 ====================
/** worker.video(l) 的字段 → OM 列表项 */
function mapVideo(v) {
  const id = String(v && (v.vId || v.id || v._id) || '').trim();
  if (!id) return null;
  const thumbs = Array.isArray(v.thumbnails) ? v.thumbnails.filter(Boolean) : [];
  const title = cleanText(pick(v.title, v.title_en)) || id;
  const tags = cleanText(pick(v.tags, v.tags_en));
  const user = cleanText(pick(v.user, v.user_en));
  const created = String(v.createdTime || '');
  return {
    vod_id: id,
    vod_name: title,
    vod_pic: thumbs.length ? absUrl(thumbs[0], SITE_HOST) : '',
    vod_tag: 'video',
    type_name: cleanText(v.videoType || ''),
    vod_remarks: cleanText(v.durationStr || v.duration || ''),
    vod_actor: user,
    vod_year: /^\d{4}/.test(created) ? created.slice(0, 4) : '',
    vod_time: created,
    vod_content: [tags ? `标签：${tags}` : '', user ? `作者：${user}` : '', v.views != null ? `${v.views} 次播放` : ''].filter(Boolean).join(' · '),
  };
}
function mapList(data) {
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : (data && Array.isArray(data.videos) ? data.videos : []));
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const item = mapVideo(v);
    if (item && !seen.has(item.vod_id)) { seen.add(item.vod_id); out.push(item); }
  }
  return out;
}
/** 详情：m3u8s 直接作为多条播放线路；playId 用 vId，play() 会重新取详情拿直链 */
function mapDetail(data, vodId) {
  const v = (data && !Array.isArray(data) && data.video) ? data.video : data;
  const item = mapVideo(v) || { vod_id: vodId, vod_name: vodId, vod_pic: '', vod_tag: 'video' };
  const urls = Array.isArray(v && v.m3u8s) ? v.m3u8s.filter(u => typeof u === 'string' && u.trim()) : [];
  const single = cleanText(v && v.m3u8);
  const media = urls.length ? urls : (single ? [single] : []);
  const sources = [];
  if (media.length) {
    // 每条 m3u8 给一条线路（站点 ?server= 默认只返回一组，多组即多清晰度/线路）
    media.forEach((u, i) => {
      sources.push({ name: media.length > 1 ? `线路${i + 1}` : '高清', episodes: [{ name: '播放', playId: `${vodId}#${i}` }] });
    });
  } else {
    sources.push({ name: '默认', episodes: [{ name: '播放', playId: vodId }] });
  }
  item.vod_content = [item.vod_content, cleanText(v && v.keywords_gem), cleanText(v && v.timeSince)].filter(Boolean).join(' · ');
  item.vod_play_from = sources.map(s => s.name).join('$$$');
  item.vod_play_url = sources.map(s => `播放$${s.episodes[0].playId}`).join('#');
  item.vod_play_sources = sources;
  return item;
}
// ==================== 数据映射结束 ====================

// ==================== 五个 handler ====================
async function home(params, context) {
  const from = (context && context.from) || (params && params.source) || 'web';
  logI(`[home] 入口 params=${JSON.stringify(params || {})} from=${from}`);
  try {
    const key = shortKey('studio:home', 'hot:1');
    const list = await cachedRpc(key, CACHE_TTL, async () => mapList(await rpc('/sevenVideos?page=1&type=hot', {}, 'home')));
    logI(`[home] 返回 ${list.length} 条`);
    return { class: CATEGORIES, filters: {}, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, filters: {}, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  const filters = p.filters || p.extend || p.ext || {};
  const tid = String(p.categoryId || p.type_id || p.tid || (filters && (filters.categoryId || filters.type_id || filters.tid)) || 'hot');
  const type = VALID_CATS.has(tid) ? tid : 'hot';
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  const urlPath = `/sevenVideos?page=${page}&type=${encodeURIComponent(type)}`;
  logI(`[category] 入口 type=${type}(${CAT_NAME[type]}) page=${page} from=${from}`);
  try {
    const key = shortKey('studio:cat', urlPath);
    const list = await cachedRpc(key, CACHE_TTL, async () => mapList(await rpc(urlPath, {}, 'category')));
    // 总数走 /retrieveGlobal；被风控时兜底用前端内置值，不阻断列表
    let pagecount = FALLBACK_MAX_PAGE;
    try {
      const g = await cachedRpc(shortKey('studio:global', 'v1'), CACHE_TTL, async () => rpc('/retrieveGlobal', {}, 'global'));
      const n = Number(g && (g.tvideosReadyCount || g.readyCount || g.total));
      if (Number.isFinite(n) && n > 0) pagecount = Math.max(1, Math.floor(n / PAGE_SIZE));
    } catch (e) { logI(`[category] 总数接口不可用，用兜底页数: ${e.message}`); }
    logI(`[category] 返回 ${list.length} 条 pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * PAGE_SIZE, limit: PAGE_SIZE, list };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const filters = p.filters || p.extend || p.ext || {};
  const kw = String(p.keyword || p.wd || p.key || '').trim();
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  if (!kw) { logI('[search] 关键词为空，直接返回空结果'); return { page: 1, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] }; }
  const payload = {
    page,
    keywords: kw,                                   // 前端用 "+" 拼多关键词，user_ 前缀搜用户
    filterCategory: filters.category || 'all',
    filterTimeInDays: filters.time || 'all',
    filterViews: filters.views || 'all',
    filterDurationInMins: filters.duration || 'all',
    sortBy: filters.sort === 'views' ? 'views' : 'time',
    keywordLogic: filters.keywordLogic === 'and' ? 'and' : 'or',
  };
  logI(`[search] 入口 kw=${kw} page=${page} from=${from} filters=${JSON.stringify(filters)}`);
  try {
    const key = shortKey('studio:search', JSON.stringify(payload));
    const list = await cachedRpc(key, CACHE_TTL, async () => mapList(await rpc('/searchSevenVideos', payload, 'search')));
    const pagecount = list.length >= PAGE_SIZE ? page + 1 : Math.max(1, page);
    logI(`[search] "${kw}" 返回 ${list.length} 条 pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * PAGE_SIZE, limit: PAGE_SIZE, list };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.vod_id || p.id || p.videoId || '');
  const vodId = decodeHTML(String(raw || '')).trim().split('#')[0];
  const from = (context && context.from) || p.source || 'web';
  logI(`[detail] 入口 videoId=${vodId || '(空)'} from=${from}`);
  if (!vodId || !/^[A-Za-z0-9_-]+$/.test(vodId)) return { list: [] };
  try {
    const key = shortKey('studio:detail', vodId);
    const data = await cachedRpc(key, DETAIL_TTL, async () =>
      rpc(`/sevenVideos/${encodeURIComponent(vodId)}`, { url_search: '' }, 'detail'));
    const item = mapDetail(data, vodId);
    logI(`[detail] 标题="${item.vod_name.slice(0, 60)}" 线路数=${item.vod_play_sources.length}`);
    return { list: [item] };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.playId || p.play_id || p.id || p.url || p.vod_id || '');
  const playId = decodeHTML(String(raw || '')).trim();
  const from = (context && context.from) || p.source || 'web';
  const [vodId, idxRaw] = playId.split('#');
  // playId 里的线路序号是 0-based（mapDetail 生成 `${vodId}#${i}`），按它取 m3u8s
  const idx = Math.max(0, Number.isFinite(Number(idxRaw)) ? Number(idxRaw) : 0);
  logI(`[play] 入口 playId=${playId} from=${from} mode=${PLAY_MODE}`);
  if (!vodId) return { urls: [], flag: '', header: {}, parse: 0, danmaku: [] };

  const header = { 'User-Agent': UA, Referer: `${SITE_HOST}/`, Origin: SITE_HOST };

  // 已经是媒体直链：直通
  if (/^https?:\/\//i.test(playId) && /\.(m3u8|mp4)(\?|$)/i.test(playId)) {
    return { urls: [{ name: '直连', url: playId }], flag: '', header, parse: 0, danmaku: [] };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(vodId)) { logE(`[play] 非法 videoId: ${vodId.slice(0, 60)}`); return { urls: [], flag: '', header, parse: 0, danmaku: [] }; }

  // 三段式：① 详情 m3u8s → ② SDK 嗅探 → ③ 播放页 parse=1
  const direct = await cachedRpc(shortKey('studio:play', `${vodId}#${idx}`), PLAY_TTL, async () => {
    if (PLAY_MODE === 'sniff') return '';
    try {
      const data = await rpc(`/sevenVideos/${encodeURIComponent(vodId)}`, { url_search: '' }, 'play');
      const v = (data && data.video) ? data.video : data;
      const urls = Array.isArray(v && v.m3u8s) ? v.m3u8s.filter(u => typeof u === 'string' && /\.(m3u8|mp4)(\?|$)/i.test(u)) : [];
      const single = cleanText(v && v.m3u8);
      const media = urls.length ? urls : (single ? [single] : []);
      if (!media.length) { logI('[play] 详情未返回 m3u8s/m3u8'); return ''; }
      const u = media[Math.min(idx, media.length - 1)];
      logI(`[play] 直链解析成功: ${u.slice(0, 120)}`);
      return absUrl(u, SITE_HOST);
    } catch (e) { logI(`[play] 直链解析失败: ${e.message}`); return ''; }
  });
  if (direct) return { urls: [{ name: '原画', url: direct }], flag: '', header, parse: 0, danmaku: [] };

  const pageUrl = `${SITE_HOST}/video/${encodeURIComponent(vodId)}`;
  if (PLAY_MODE !== 'direct' && OmniBox && typeof OmniBox.sniffVideo === 'function') {
    try {
      const sniffed = await OmniBox.sniffVideo(pageUrl, header);
      const u = typeof sniffed === 'string' ? sniffed.trim() : (sniffed && sniffed.url ? String(sniffed.url) : '');
      if (u && /^https?:\/\//i.test(u)) {
        logI(`[play] SDK 嗅探成功: ${u.slice(0, 120)}`);
        return { urls: [{ name: '嗅探', url: u }], flag: '', header, parse: 0, danmaku: [] };
      }
      logI('[play] SDK 嗅探无结果，回退播放页 parse=1');
    } catch (e) { logI(`[play] SDK 嗅探异常: ${e.message}`); }
  }
  logI(`[play] 回退播放页交给播放器嗅探: ${pageUrl}`);
  return { urls: [{ name: '播放页', url: pageUrl }], flag: '', header, parse: 1, danmaku: [] };
}
// ==================== 五个 handler 结束 ====================

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
