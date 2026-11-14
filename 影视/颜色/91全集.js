// @name 91全集
// @version 1.0.0
// @author omnibox-spider
// @description 91quanji.com（木瓜视频/KVS Paysite）采集源：10 个真实分类 + 首页推荐 + 搜索分页；卡片解析封面/标题；详情页反混淆 eval(I(...)) 直取签名 m3u8；tag 分类 token 分页链（进程内+SDK 缓存）、搜索 p=N、三段式播放兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91全集.js
// @dependencies []

/**
 * 实站事实（2026-11-14 实测，改代码前先读这段）
 * 1) 站点是 KVS Paysite 模板（nginx + UTF-8），无 Cloudflare；两个外链用 I() 混淆：
 *      I(r) = 逐字符 chr(128 ^ charCodeAt(i))，document.write(I('¼á...')) 输出 <a href=...>。
 * 2) 路由：
 *      首页        /                              3 个分区（国产自拍/国产精品/厂商）共 60+ 卡片
 *      分类        /tag.jsp?t=<token>            12 卡片/页，10 个真实分类（含 8 个厂商）
 *      厂商导航    /makers.jsp                   分类按钮 + 96 卡片
 *      搜索        /search.jsp?keyword=<kw>&p=<n>   36 卡片/页，实测 p=1..20 有效、p=50 空
 *      详情        /watch.jsp?v=<12位id>
 * 3) 卡片 DOM：<div class="item thumb thumb--videos"><a href="watch.jsp?v=...">
 *      <div class="thumb__img"><img src="https://pics.uoepp.com/..."></div>
 *      <div class="thumb-spot__title"><h5>标题</h5>
 *    详情页标题：<h1 class="title">；相关视频也是同一卡片结构，解析时要用 id 去重。
 * 4) 播放地址在 <script>eval(I("..."))</script> 里，解码后是 DPlayer 初始化：
 *      if(-1!=='muguad.cfd,...,91quanji.com,...'.indexOf(window.location.hostname)){
 *        const dp = new DPlayer({ ..., video:{ url:'https://8017.o9hx3f-s8jamrmtps5.sbs/.../chunklist_w.m3u8?v=<ts>-<sig>' ... } })
 *    直接取 url: '...' 即可，GET 实测 200 application/vnd.apple.mpegurl（带签名 query，勿二次编码）。
 *    这是正版片源，不是诱饵；页面里没有其它 m3u8。签名带时间戳，播放缓存 TTL 必须短（默认 45s）。
 * 5) tag 分类分页**不是** ?page=N：<ul class="pagination"> 每页给的是不可推算的 token
 *      （如 ?t=649e2zxgw10p&p=51d0rqoxqvp8 才是第 2 页，末页 3483）。
 *    隐藏的「跳转至」表单 location.href='?t=<t>&p=<baseToken>='+页号 实测服务端不认（回第 1 页），
 *    只能靠**逐页跟随分页链接**建立 token 链：本源把「页码 -> token」缓存起来，
 *    category(page=N) 从已缓存链里取 token，缺页时从第 1 页逐页走到 N（有步数上限）。
 *    pagecount 取分页区最大数字（国产自拍 3483、国产精品 45）。
 * 6) 搜索用 p=<n>，不用 token；搜索页无分页区，靠「有卡片/无卡片」判断还有没有下一页。
 *
 * 【环境变量】（沿用仓库既有命名优先）
 *  QUANJI_HOST / SITE_HOSTS   站点基址，默认 https://91quanji.com；SITE_HOSTS 逗号分隔可容灾
 *  NINETYONE_UA               自定义 UA
 *  NINETYONE_COOKIE           可选手动 Cookie
 *  QUANJI_CACHE_TTL           页面缓存秒数，默认 300
 *  QUANJI_DETAIL_TTL          详情页缓存秒数，默认 90
 *  QUANJI_PLAY_TTL            播放直链缓存秒数，默认 45
 *  QUANJI_TOKEN_TTL           tag 分页 token 链缓存秒数，默认 3600
 *  QUANJI_MAX_WALK            单次 category 最多跟随多少页，默认 12
 *  QUANJI_PLAY_MODE           direct | sniff | auto（默认 auto：直链 -> sniff -> parse=1）
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

const PREFIX = '[91quanji]';
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
function logE(m) { safeLog('error', m); }

// ==================== 配置区域 ====================
const DEFAULT_HOST = 'https://91quanji.com';
const HOSTS = (() => {
  const raw = String(process.env.SITE_HOSTS || process.env.QUANJI_HOST || DEFAULT_HOST);
  const list = raw.split(/[,;]/).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map(s => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
  return Array.from(new Set(list.length ? list : [DEFAULT_HOST]));
})();
let PREFERRED = 0;

const UA = String(process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
const FIXED_COOKIE = String(process.env.NINETYONE_COOKIE || '').trim();
const CACHE_TTL = Math.max(0, Number(process.env.QUANJI_CACHE_TTL || 300) || 300);
const DETAIL_TTL = Math.max(0, Number(process.env.QUANJI_DETAIL_TTL || 90) || 90);
const PLAY_TTL = Math.max(0, Number(process.env.QUANJI_PLAY_TTL || 45) || 45);
const TOKEN_TTL = Math.max(0, Number(process.env.QUANJI_TOKEN_TTL || 3600) || 3600);
const MAX_WALK = Math.max(1, Number(process.env.QUANJI_MAX_WALK || 12) || 12);
const PLAY_MODE = ['direct', 'sniff', 'auto'].includes(String(process.env.QUANJI_PLAY_MODE || 'auto').trim().toLowerCase())
  ? String(process.env.QUANJI_PLAY_MODE || 'auto').trim().toLowerCase() : 'auto';
const PAGE_SIZE = 12;
const SEARCH_PAGE_SIZE = 36;
const MEDIA_RE = /\.(m3u8|mp4)(\?|$)/i;

let SESSION_COOKIE = '';

// 10 个真实分类（首页导航 2 个 + makers.jsp 厂商 8 个）
const CATEGORIES = [
  { type_id: '649e2zxgw10p', type_name: '国产自拍' },
  { type_id: '5y9kg97rdzxe', type_name: '国产精品' },
  { type_id: 'z8y32yqgdemj', type_name: '天美传媒' },
  { type_id: '0598gp923vod', type_name: '其他传媒' },
  { type_id: '7wxkgwqgm60p', type_name: '蜜桃影像传媒' },
  { type_id: 'onmvrndgxzw3', type_name: '精东影业' },
  { type_id: 'poy4gx4rqwxv', type_name: '91制片厂' },
  { type_id: 'e1mqglprj3v8', type_name: '麻豆传媒映画' },
  { type_id: 'k1o721d2zp8l', type_name: '台湾swag' },
  { type_id: 'qyl9gmx236dp', type_name: '星空无限传媒' },
];
const CAT_NAME = Object.fromEntries(CATEGORIES.map(c => [c.type_id, c.type_name]));
// 首页「更多」按钮给的第 3 页 token：作为预置加速，避免每次从第 1 页走起
const SEED_TOKENS = { '649e2zxgw10p': { 3: 'myz530grq4je' }, '5y9kg97rdzxe': { 2: 'g6r2m3qyq70x' } };
// ==================== 配置区域结束 ====================

// ==================== 工具函数 ====================
function decodeHTML(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function cleanText(s) {
  return decodeHTML(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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
function buildHeaders(host) {
  const h = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: `${host}/`,
  };
  const cookie = FIXED_COOKIE || SESSION_COOKIE;
  if (cookie) h.Cookie = cookie;
  return h;
}
function captureCookie(res) {
  if (SESSION_COOKIE || FIXED_COOKIE) return;
  try {
    const raw = res && res.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
    const arr = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
    for (const line of arr) {
      const m = /(JSESSIONID|PHPSESSID)=[^;]+/.exec(line);
      if (m) { SESSION_COOKIE = m[0]; logI(`已接收会话 cookie=${SESSION_COOKIE.slice(0, 22)}...`); return; }
    }
  } catch (_) { /* ignore */ }
}
function bodyText(res) {
  const b = res && res.body;
  if (typeof b === 'string') return b;
  if (b && typeof b.toString === 'function') return b.toString('utf8');
  return '';
}
/** 站点 I() 反混淆：逐字符 128 ^ charCode */
function decodeI(raw) {
  let out = '';
  const s = String(raw || '');
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(128 ^ s.charCodeAt(i));
  return out;
}
// ==================== 工具函数结束 ====================

// ==================== 请求与缓存 ====================
async function fetchPage(path) {
  const errors = [];
  for (let off = 0; off < HOSTS.length; off++) {
    const i = (PREFERRED + off) % HOSTS.length;
    const host = HOSTS[i];
    const url = absUrl(path, host);
    try {
      const res = await OmniBox.request(url, { method: 'GET', headers: buildHeaders(host) });
      const text = bodyText(res);
      const code = Number(res && res.statusCode) || 0;
      if (code !== 200 || text.length < 300) { errors.push(`${host} HTTP ${code} len=${text.length}`); continue; }
      PREFERRED = i;
      captureCookie(res);
      return { body: text, host, url };
    } catch (e) { errors.push(`${host} ${e && e.message ? e.message : e}`); }
  }
  throw new Error(`全部基址失败: ${errors.join(' | ')}`);
}
async function cachedPage(path, ttl, tag) {
  const key = shortKey('quanji:page', path);
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try {
      const hit = await OmniBox.getCache(key);
      if (hit && String(hit).length > 300) {
        logI(`[${tag}] 命中页面缓存 path=${path}`);
        return { body: String(hit), host: HOSTS[PREFERRED], cached: true };
      }
    } catch (e) { logI(`[${tag}] 读缓存失败: ${e.message}`); }
  }
  const res = await fetchPage(path);
  if (ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, res.body, ttl); } catch (e) { logI(`[${tag}] 写缓存失败: ${e.message}`); }
  }
  return Object.assign({ cached: false }, res);
}
async function cachedText(key, ttl, producer) {
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try { const v = await OmniBox.getCache(key); if (v) return String(v); } catch (_) {}
  }
  const value = await producer();
  if (value && ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, value, ttl); } catch (_) {}
  }
  return value;
}
// ==================== 请求与缓存结束 ====================

// ==================== 列表 / 分页解析 ====================
function parseCards(html, host) {
  const list = [];
  const seen = new Set();
  const re = /<div class="item thumb thumb--videos"[^>]*>\s*<a href="(watch\.jsp\?v=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const vodId = decodeHTML(m[1]).trim();
    if (!vodId || seen.has(vodId)) continue;
    const b = m[2];
    const imgM = /<img[^>]*\bsrc="([^"]+)"/i.exec(b);
    const tM = /<h5[^>]*class="[^"]*thumb-spot__title[^"]*"[^>]*>([\s\S]*?)<\/h5>/i.exec(b);
    const title = cleanText(tM ? tM[1] : '');
    if (!title) continue;
    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: title,
      vod_pic: imgM ? absUrl(imgM[1], host) : '',
      vod_tag: 'video',
      vod_remarks: '',
      vod_content: '',
    });
  }
  return list;
}
/** 解析 <ul class="pagination">：页码 -> token，以及末页号 */
function parsePagination(html) {
  const out = { tokens: {}, pagecount: 0 };
  const b = /<ul class="pagination"[\s\S]*?<\/ul>/i.exec(String(html || ''));
  if (!b) return out;
  const re = /<li[^>]*>\s*<a[^>]*href="\?t=([^&"]+)&p=([^"]+)"[^>]*>(\d+)<\/a>/gi;
  let m;
  while ((m = re.exec(b[0])) !== null) {
    const t = decodeHTML(m[1]);
    const token = decodeHTML(m[2]);
    const page = Number(m[3]);
    if (t && token && page > 0) {
      out.tokens[page] = token;
      if (page > out.pagecount) out.pagecount = page;
    }
  }
  return out;
}
/** 从隐藏 goto 表单读 baseToken（站点自带的分页基串，实测不能直接跳页，仅作诊断） */
function parseGotoBase(html) {
  const m = /location\.href='\?t=([^&']+)&p=([^=]+)=/i.exec(String(html || ''));
  return m ? { t: decodeHTML(m[1]), base: decodeHTML(m[2]) } : null;
}
// ==================== 列表 / 分页解析结束 ====================

// ==================== tag 分页 token 链 ====================
// 进程内 Map + SDK 双层缓存；key 用短哈希控制长度
const TOKEN_MEM = new Map();
function tokenKey(t) { return shortKey('quanji:tokens', t); }
async function loadTokens(t) {
  const hit = TOKEN_MEM.get(t);
  if (hit && hit.exp > Date.now()) return hit.map;
  let map = { 1: '' };
  if (OmniBox && typeof OmniBox.getCache === 'function') {
    try {
      const raw = await OmniBox.getCache(tokenKey(t));
      if (raw) {
        const obj = JSON.parse(String(raw));
        if (obj && typeof obj === 'object') map = Object.assign(map, obj);
      }
    } catch (_) {}
  }
  Object.assign(map, SEED_TOKENS[t] || {});
  TOKEN_MEM.set(t, { map, exp: Date.now() + TOKEN_TTL * 1000 });
  return map;
}
async function saveTokens(t, map) {
  TOKEN_MEM.set(t, { map, exp: Date.now() + TOKEN_TTL * 1000 });
  if (OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(tokenKey(t), JSON.stringify(map), TOKEN_TTL); } catch (_) {}
  }
}
/** 逐页跟随分页链接，把「页码 -> token」补齐到 want 页为止 */
async function ensureToken(t, want, tag) {
  const map = await loadTokens(t);
  if (map[want] !== undefined) return map;
  // 游标只沿「1 起连续已知」的链往前走；预置的高页 token（如第 3 页）不能把游标
  // 直接跳过去，否则第 2 页 token 永远不会被补上。
  let page = 1;
  while (map[page] !== undefined) page++;
  page -= 1;
  let html = '';
  let pagecount = 0;
  for (let step = 0; step < MAX_WALK && page < want; step++) {
    const token = map[page] || '';
    const path = token ? `tag.jsp?t=${t}&p=${encodeURIComponent(token)}` : `tag.jsp?t=${t}`;
    const res = await cachedPage(path, CACHE_TTL, tag);
    html = res.body;
    const pg = parsePagination(html);
    if (pg.pagecount) pagecount = pg.pagecount;
    const next = page + 1;
    if (!pg.tokens[next]) {
      logI(`[${tag}] 分页链在 ${page} 页断了（无 ${next} 页 token），停止跟随`);
      break;
    }
    map[next] = pg.tokens[next];
    // 顺手把本页可见的其它页码 token 一起记下来
    for (const [k, v] of Object.entries(pg.tokens)) map[k] = v;
    page = next;
    await saveTokens(t, map);
    logI(`[${tag}] 分页链推进到 ${page}/${want} token=${map[page]}`);
  }
  return map;
}
// ==================== tag 分页 token 链结束 ====================

// ==================== 详情 / 播放解析 ====================
function normalizeWatchPath(vodId) {
  let v = decodeHTML(String(vodId || '')).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    try { const u = new URL(v); v = `${u.pathname}${u.search}`; } catch (_) { return ''; }
  }
  v = v.replace(/^\/+/, '');
  // 只接受本模板的 watch.jsp?v=<id>
  const m = /^watch\.jsp\?v=([A-Za-z0-9]+)$/i.exec(v);
  return m ? `watch.jsp?v=${m[1]}` : '';
}
/** 解码 eval(I("...")) 里的 DPlayer url */
function extractPlayUrl(html) {
  const s = String(html || '');
  const m = /eval\(I\(["']([\s\S]*?)["']\)\)/i.exec(s);
  if (!m) return '';
  let js = '';
  try { js = decodeI(m[1]); } catch (_) { return ''; }
  const u = /video\s*:\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/i.exec(js)
    || /url\s*:\s*['"](https?:[^'"]+)['"]/i.exec(js);
  if (!u) return '';
  return decodeHTML(u[1]).trim();
}
function parseDetail(html, host, vodId) {
  const s = String(html || '');
  const titleM = /<h1 class="title">([\s\S]*?)<\/h1>/i.exec(s) || /<title>([\s\S]*?)<\/title>/i.exec(s);
  const title = cleanText(titleM ? titleM[1] : '') || vodId;
  // 封面：详情页无 poster，用相关视频首图之外不猜；列表态的封面由宿主自带
  const durM = /(\d{1,2}:\d{2}(?::\d{2})?)/.exec(s);
  return {
    vod_id: vodId,
    vod_name: title,
    vod_pic: '',
    vod_tag: 'video',
    type_name: '',
    vod_remarks: durM ? durM[1] : '',
    vod_content: '',
    vod_play_from: '木瓜视频',
    vod_play_url: `播放$${vodId}`,
    vod_play_sources: [{ name: '木瓜视频', episodes: [{ name: '播放', playId: vodId }] }],
  };
}
// ==================== 详情 / 播放解析结束 ====================

// ==================== 五个 handler ====================
async function home(params, context) {
  const from = (context && context.from) || (params && params.source) || 'web';
  logI(`[home] 入口 params=${JSON.stringify(params || {})} from=${from}`);
  try {
    const res = await cachedPage('/', CACHE_TTL, 'home');
    const list = parseCards(res.body, res.host);
    logI(`[home] 返回 ${list.length} 条 cached=${res.cached}`);
    return { class: CATEGORIES, filters: {}, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, filters: {}, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  const filters = p.filters || p.extend || p.ext || {};
  const tid = p.categoryId || p.type_id || p.tid
    || (filters && (filters.categoryId || filters.type_id || filters.tid))
    || CATEGORIES[0].type_id;
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  const tag = `category:${tid}`;
  logI(`[category] 入口 tid=${tid}(${CAT_NAME[tid] || '?'}) page=${page} from=${from}`);
  try {
    let path = `tag.jsp?t=${encodeURIComponent(tid)}`;
    let pagecount = 0;
    if (page > 1) {
      const map = await ensureToken(tid, page, tag);
      const token = map[page];
      if (token) path += `&p=${encodeURIComponent(token)}`;
      else logI(`[category] 未拿到第 ${page} 页 token，回退使用最近可用页`);
      for (const k of Object.keys(map)) { const n = Number(k); if (n > pagecount) pagecount = n; }
    }
    let res = await cachedPage(path, CACHE_TTL, tag);
    let list = parseCards(res.body, res.host);
    if (!list.length) { res = await fetchPage(path); list = parseCards(res.body, res.host); }
    const pg = parsePagination(res.body);
    if (pg.pagecount) {
      pagecount = Math.max(pagecount, pg.pagecount);
      // 把当前页可见的 token 也存进链，后续翻页少走几步
      const map = await loadTokens(tid);
      let changed = false;
      for (const [k, v] of Object.entries(pg.tokens)) { if (map[k] !== v) { map[k] = v; changed = true; } }
      if (changed) await saveTokens(tid, map);
    }
    logI(`[category] 返回 ${list.length} 条 path=${path} pagecount=${pagecount}`);
    return {
      page,
      pagecount: pagecount || page,
      total: (pagecount || page) * PAGE_SIZE,
      limit: PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const kw = String(p.keyword || p.wd || p.key || '').trim();
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  if (!kw) { logI('[search] 关键词为空，直接返回空结果'); return { page: 1, pagecount: 0, total: 0, limit: SEARCH_PAGE_SIZE, list: [] }; }
  const path = `/search.jsp?keyword=${encodeURIComponent(kw)}&p=${page}`;
  logI(`[search] 入口 kw=${kw} page=${page} from=${from}`);
  try {
    let res = await cachedPage(path, CACHE_TTL, 'search');
    let list = parseCards(res.body, res.host);
    if (!list.length) { res = await fetchPage(path); list = parseCards(res.body, res.host); }
    // 搜索页无分页区：本页有数据就认为还有下一页（空页时回退到当前页）
    const pagecount = list.length ? page + 1 : Math.max(1, page - 1);
    logI(`[search] "${kw}" 返回 ${list.length} 条 pagecount=${pagecount}`);
    return {
      page,
      pagecount,
      total: pagecount * SEARCH_PAGE_SIZE,
      limit: SEARCH_PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: SEARCH_PAGE_SIZE, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.vod_id || p.id || p.videoId || '');
  const vodId = normalizeWatchPath(raw);
  const from = (context && context.from) || p.source || 'web';
  logI(`[detail] 入口 videoId=${vodId || '(空)'} from=${from}`);
  if (!vodId) return { list: [] };
  try {
    const res = await cachedPage(vodId, DETAIL_TTL, 'detail');
    const item = parseDetail(res.body, res.host, vodId);
    const direct = extractPlayUrl(res.body);
    logI(`[detail] 标题="${item.vod_name.slice(0, 60)}" 直链=${direct ? direct.slice(0, 100) : '无'}`);
    // 列表态已带封面，这里把已知直链透传进 playId 之外不做额外请求
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
  logI(`[play] 入口 playId=${playId.slice(0, 120)} from=${from} mode=${PLAY_MODE}`);
  if (!playId) return { urls: [], flag: '', header: {}, parse: 0, danmaku: [] };

  const header = { 'User-Agent': UA, Referer: `${HOSTS[PREFERRED]}/` };

  // 已经是媒体直链：直通
  if (/^https?:\/\//i.test(playId) && MEDIA_RE.test(playId)) {
    logI('[play] playId 即媒体直链，直通 parse=0');
    return { urls: [{ name: '直连', url: playId }], flag: '', header, parse: 0, danmaku: [] };
  }

  const watchPath = normalizeWatchPath(playId);
  if (!watchPath) { logE(`[play] playId 非站内 watch 路径: ${playId.slice(0, 80)}`); return { urls: [], flag: '', header, parse: 0, danmaku: [] }; }

  // 三段式：① 反混淆直链 → ② SDK 嗅探 → ③ 播放页 parse=1
  const direct = await cachedText(shortKey('quanji:play', watchPath), PLAY_TTL, async () => {
    if (PLAY_MODE === 'sniff') return '';
    try {
      const res = await fetchPage(watchPath);        // 播放不走页面缓存，避免签名过期
      const url = extractPlayUrl(res.body);
      if (!url) { logI('[play] 详情页未解出 eval(I(...)) 直链'); return ''; }
      if (!/^https?:\/\//i.test(url) || !MEDIA_RE.test(url)) { logI(`[play] 解出的地址非媒体: ${url.slice(0, 100)}`); return ''; }
      logI(`[play] 直链解析成功: ${url.slice(0, 120)}`);
      return url;
    } catch (e) { logI(`[play] 直链解析失败: ${e.message}`); return ''; }
  });
  if (direct) return { urls: [{ name: '原画', url: direct }], flag: '', header, parse: 0, danmaku: [] };

  const pageUrl = absUrl(watchPath, HOSTS[PREFERRED]);
  if (PLAY_MODE !== 'direct' && OmniBox && typeof OmniBox.sniffVideo === 'function') {
    try {
      const sniffed = await OmniBox.sniffVideo(pageUrl, header);
      const url = typeof sniffed === 'string' ? sniffed.trim() : (sniffed && sniffed.url ? String(sniffed.url) : '');
      if (url && /^https?:\/\//i.test(url)) {
        logI(`[play] SDK 嗅探成功: ${url.slice(0, 120)}`);
        return { urls: [{ name: '嗅探', url }], flag: '', header, parse: 0, danmaku: [] };
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
