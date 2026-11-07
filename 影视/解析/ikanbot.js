// @name 爱看机器人
// @version 1.0.2
// @description 爱看机器人 ikanbot.com 采集源（OmniBox Spider）：首页/分类/榜单/搜索 + /api/getResN 线路接口 + get_tks 令牌还原 + 电影/剧集分集 + 页面级缓存 + 多基址容灾
// @downloadURL https://raw.githubusercontent.com/omnibox-spider/main/影视/采集/ikanbot.js
// @indexs 1
// @dependencies []
//
// 【环境变量】
//  SITE_API        主站基址，默认 https://www1.ikanbot.com（复用通用采集站变量）
//  SITE_HOSTS      逗号分隔备用基址（沿用仓库既有容灾变量）
//  SITE_UA         自定义 User-Agent（沿用仓库既有变量）
//  SITE_COOKIE     站点 Cookie（沿用仓库既有变量）
//  SITE_TIMEOUT    单请求超时毫秒，默认 15000（沿用仓库既有变量）
//  SITE_CACHE_TTL  页面缓存默认 TTL 秒，默认 300（沿用仓库既有变量）
//  SITE_IMG_MODE   封面模式 inline | url | proxy | raw，默认 inline
//                  inline：只对 doubanio 海报做服务端抓取（带豆瓣 Referer）并内联 data URI；
//                          非豆瓣图床原样返回。并发 12 / 超时 3s，实测首页 24 张约 0.3s。
//                  url   ：doubanio 统一改到 img9 子域 + s_ratio 小图（纯字符串改写）
//                  proxy ：doubanio 改成官网同款 imgp.ikanbot.eu.org/i/{id}?u= 代理
//                  raw   ：完全不改，返回站点原始 URL（等同 1.0.0 行为）
//  SITE_IMG_CONCURRENCY  inline 模式图片并发数，默认 12
//  SITE_IMG_TIMEOUT      inline 模式单图超时毫秒，默认 3000
//  SITE_IMG_PROXY        可选：封面代理前缀，最终 URL = 前缀 + 原始图片 URL
//                        （同仓库 网飞猫.js 约定；宿主自带图片代理时用，覆盖 inline 输出）
//  说明：除 SITE_IMG_* 外全部复用仓库既有 SITE_* 命名；inline 只抓豆瓣图，不会碰
//        pic.youkupic.com 这类会整批 ECONNRESET 的采集图床。

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) {
  OmniBox = {
    log(l, m) { console.log(`[${l}] ${m}`); },
    getCache() { return null; }, setCache() { return Promise.resolve(); }, deleteCache() { return Promise.resolve(); }
  };
}
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const PREFIX = '[ikanbot]';
function logI(m) { try { OmniBox.log('info', `${PREFIX} ${m}`); } catch (_) {} }
function logE(m) { try { OmniBox.log('error', `${PREFIX} ${m}`); } catch (_) {} }

const USER_AGENT = process.env.SITE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SITE_COOKIE = process.env.SITE_COOKIE || '';
const REQ_TIMEOUT = parseInt(process.env.SITE_TIMEOUT || '15000', 10) || 15000;
const DEFAULT_TTL = parseInt(process.env.SITE_CACHE_TTL || '300', 10) || 300;
const IMG_MODE = ['inline', 'url', 'proxy', 'raw'].includes(String(process.env.SITE_IMG_MODE || 'inline').trim().toLowerCase())
  ? String(process.env.SITE_IMG_MODE || 'inline').trim().toLowerCase() : 'inline';
const IMG_CONCURRENCY = Math.max(1, Math.min(24, parseInt(process.env.SITE_IMG_CONCURRENCY || '12', 10) || 12));
const IMG_TIMEOUT = Math.max(500, parseInt(process.env.SITE_IMG_TIMEOUT || '3000', 10) || 3000);
// 同仓库 网飞猫.js 的既有约定：宿主自带图片代理时，封面 URL = 前缀 + 原始图片 URL。
const IMG_PROXY = String(process.env.SITE_IMG_PROXY || '').trim().replace(/\/+$/, '');

const PRIMARY_API = (process.env.SITE_API || 'https://www1.ikanbot.com').replace(/\/+$/, '');
const HOSTS = (() => {
  const fromEnv = String(process.env.SITE_HOSTS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return Array.from(new Set([PRIMARY_API, ...fromEnv, 'https://ikanbot.com', 'https://www.ikanbot.com']));
})();
let PREFERRED = 0;

// 分类定义：categoryId 用短 code，buildCategoryPath() 统一映射到站点真实前台路由。
// /category/{id}?p=N 为分类库；/hot/index-{movie|tv}-{名称}[-p-N].html 为热门筛选页。
const CATEGORIES = [
  { type_id: 'all', type_name: '最新' },
  { type_id: 'movie', type_name: '电影' },
  { type_id: 'tv', type_name: '剧集' },
  { type_id: 'anime', type_name: '动漫' },
  { type_id: 'variety', type_name: '综艺' },
  { type_id: 'doc', type_name: '纪录片' },
  { type_id: 'hot:movie', type_name: '热门电影' },
  { type_id: 'hot:tv', type_name: '热门剧集' },
  { type_id: 'hot:tv:美剧', type_name: '美剧' },
  { type_id: 'hot:tv:英剧', type_name: '英剧' },
  { type_id: 'hot:tv:韩剧', type_name: '韩剧' },
  { type_id: 'hot:tv:日剧', type_name: '日剧' },
  { type_id: 'hot:tv:国产剧', type_name: '国产剧' },
  { type_id: 'hot:tv:港剧', type_name: '港剧' },
  { type_id: 'hot:tv:日本动画', type_name: '日本动画' },
  { type_id: 'hot:tv:综艺', type_name: '热门综艺' },
  { type_id: 'hot:tv:纪录片', type_name: '热门纪录片' }
];
const CATEGORY_ID_MAP = { all: '', movie: '1', tv: '2', anime: '18', variety: '19', doc: '20' };

// 文本清洗：去标签、还原常见实体、压缩空白。
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}
function decodeAttr(s) { return cleanText(String(s || '').replace(/\s+/g, ' ')); }

// 图片链路说明：
// doubanio.com 海报对 OmniBox 宿主(不带或带本地 Referer)一律 403/418；官网自己靠
// common.js 把它改写成 imgp.ikanbot.eu.org 代理，但该代理也只认 ikanbot Referer，
// 宿主 <img> 请求同样带不上 —— 所以「原样 URL」和「换 img9 域」都只是碰运气。
// 仓库已验证 吃瓜.js 的宿主链路支持 data:image，故默认 inline：
// 只对豆瓣图在脚本侧带 movie.douban.com Referer 抓取并内联，非豆瓣图床原样返回，
// 绝不碰 pic.youkupic.com 这类会整批 ECONNRESET 的采集图床。
function isDoubanImg(u) { return /doubanio\.com/i.test(String(u || '')); }
function toSmallDouban(u) {
  return String(u || '').trim()
    .replace(/https?:\/\/img\d+\.doubanio\.com/i, 'https://img9.doubanio.com')
    .replace(/\/(?:m|l)_ratio_poster\//i, '/s_ratio_poster/');
}
function normalizeDoubanPic(u, id) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  if (s.startsWith('/')) s = HOSTS[PREFERRED] + s;
  if (!/^https?:\/\//i.test(s)) return '';
  if (!isDoubanImg(s)) return s; // 非豆瓣图床宿主可直连，原样返回
  if (IMG_MODE === 'raw') return s;
  if (IMG_MODE === 'proxy') return `https://imgp.ikanbot.eu.org/i/${encodeURIComponent(String(id || '0'))}?u=${Buffer.from(toSmallDouban(s), 'utf-8').toString('base64url')}`;
  return toSmallDouban(s);
}

// 1x1 透明 PNG：豆瓣上游 418/404 等死链时兜底，避免宿主显示裂图图标。
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// 豆瓣图二进制抓取（二进制 Buffer，不走 fetchHtml 的 utf-8 解码）。
function fetchDoubanBinary(url) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = https.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://movie.douban.com/' },
        timeout: IMG_TIMEOUT, rejectUnauthorized: false },
      (res) => {
        const ctype = String(res.headers['content-type'] || '');
        if (res.statusCode < 200 || res.statusCode >= 300 || !/^image\//i.test(ctype)) {
          res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${ctype || '非图片'}`));
        }
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= 400000) chunks.push(c); });
        res.on('end', () => {
          if (size > 400000) return reject(new Error('图片过大'));
          resolve({ mime: ctype.split(';')[0].trim(), buf: Buffer.concat(chunks) });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('图片请求超时')); });
    req.end();
  });
}

// 图片 data URI 缓存：进程内 Map + SDK 持久缓存；key 为短哈希，避免宿主 key 长度限制。
const IMG_MEM = new Map();
const IMG_PENDING = new Map();
async function getInlineImage(key, ttl) {
  const mem = IMG_MEM.get(key);
  if (mem && mem.exp > Date.now()) return mem.val;
  try { const v = await OmniBox.getCache(key); if (typeof v === 'string' && v.startsWith('data:image/')) { IMG_MEM.set(key, { val: v, exp: Date.now() + ttl * 1000 }); return v; } } catch (_) {}
  return null;
}
async function setInlineImage(key, val, ttl) {
  IMG_MEM.set(key, { val, exp: Date.now() + ttl * 1000 });
  try { await OmniBox.setCache(key, val, ttl); } catch (_) {}
}

// inline 模式：只处理豆瓣图；失败返回透明 PNG，绝不抛错阻塞列表。
async function inlineDoubanImage(pic, ttl) {
  const url = String(pic || '').trim();
  if (!url || !isDoubanImg(url) || IMG_MODE !== 'inline') return url;
  const key = buildCacheKey('ikan:img', url);
  const cached = await getInlineImage(key, ttl);
  if (cached) return cached;
  if (IMG_PENDING.has(key)) return IMG_PENDING.get(key);
  const task = (async () => {
    try {
      const { mime, buf } = await fetchDoubanBinary(url);
      const val = `data:${mime};base64,${buf.toString('base64')}`;
      await setInlineImage(key, val, ttl);
      return val;
    } catch (e) {
      logE(`[img] 豆瓣图失败 ${new URL(url).hostname}${new URL(url).pathname.slice(0, 46)} -> ${e.message}`);
      return BLANK_PNG;
    } finally { IMG_PENDING.delete(key); }
  })();
  IMG_PENDING.set(key, task);
  return task;
}

// 批量内联：限并发 IMG_CONCURRENCY（默认 12），实测首页 24 张约 0.3s。
// 若配置了 SITE_IMG_PROXY（宿主自带图片代理），统一改为「前缀 + 原始 URL」，
// 与仓库 网飞猫.js 保持一致，且零额外网络请求。
async function attachImages(list, ttl) {
  if (!Array.isArray(list) || !list.length) return list;
  if (IMG_PROXY) {
    list.forEach((item) => {
      const raw = String(item.vod_pic || '');
      item.vod_pic = raw ? IMG_PROXY + (raw.startsWith('/') ? HOSTS[PREFERRED] + raw : raw) : '';
    });
    return list;
  }
  if (IMG_MODE !== 'inline') return list;
  const keys = list.map(x => String(x.vod_pic || ''));
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(IMG_CONCURRENCY, list.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) break;
      out[i] = await inlineDoubanImage(keys[i], ttl);
    }
  });
  await Promise.all(workers);
  list.forEach((item, i) => { item.vod_pic = out[i] || ''; });
  return list;
}
function pickImage(block) {
  const cand = [];
  const push = (v) => { if (v && !/^data:image\//i.test(v) && !/svg\+xml/i.test(v)) cand.push(v); };
  const dataSrc = block.match(/data-src\s*=\s*["']([^"']+)["']/i);
  const dataOrig = block.match(/data-original\s*=\s*["']([^"']+)["']/i);
  if (dataSrc) push(decodeAttr(dataSrc[1]));
  if (dataOrig) push(decodeAttr(dataOrig[1]));
  const src = block.match(/<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if (src) push(decodeAttr(src[1]));
  const imgIdM = block.match(/<img[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  return normalizeDoubanPic(cand[0] || '', imgIdM ? imgIdM[1] : '');
}

// 缓存：进程内 Map + SDK 持久缓存双层；key 统一「可读前缀 + sha1 短哈希」，避免宿主 key 长度限制。
const MEM_CACHE = new Map();
function buildCacheKey(prefix, raw) {
  let key = `${prefix}:${crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 20)}`;
  if (key.length > 200) key = `${prefix}:${crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 20)}`;
  return key;
}
async function getCachedText(raw, prefix) {
  const key = buildCacheKey(prefix, raw);
  const mem = MEM_CACHE.get(key);
  if (mem && mem.exp > Date.now()) return mem.val;
  try {
    const v = await OmniBox.getCache(key);
    if (v) { MEM_CACHE.set(key, { val: String(v), exp: Date.now() + DEFAULT_TTL * 1000 }); return String(v); }
  } catch (_) {}
  return null;
}
async function setCachedText(raw, prefix, val, ttl) {
  const key = buildCacheKey(prefix, raw);
  MEM_CACHE.set(key, { val: String(val), exp: Date.now() + (ttl || DEFAULT_TTL) * 1000 });
  try { await OmniBox.setCache(key, String(val), ttl || DEFAULT_TTL); } catch (_) {}
}

// 基础 HTTP 请求：自动跟随重定向、超时、非 ASCII 路径安全编码。
function httpRequest(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      Accept: options.json ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }, SITE_COOKIE ? { Cookie: SITE_COOKIE } : {}, options.headers || {});
    const req = client.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search, method: options.method || 'GET', headers,
        timeout: options.timeout || REQ_TIMEOUT, rejectUnauthorized: false },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return httpRequest(new URL(res.headers.location, u.href).href, options, redirectCount + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8'), _host: u.host }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// 多基址容灾：网络错误 / 5xx / 403 / 空体自动切下一个基址。
async function fetchWithFailover(path, options = {}) {
  const order = [PREFERRED, ...HOSTS.map((_, i) => i).filter(i => i !== PREFERRED)];
  let lastErr;
  for (const idx of order) {
    const host = HOSTS[idx];
    try {
      const res = await httpRequest(`${host}${path}`, options);
      if (res.statusCode >= 500 || res.statusCode === 403 || !res.body) {
        logE(`[failover] ${host}${path} -> HTTP ${res.statusCode}${!res.body ? ' 空体' : ''}, 切下一个`);
        lastErr = new Error(`HTTP ${res.statusCode}`);
        continue;
      }
      if (idx !== PREFERRED) { PREFERRED = idx; logI(`[failover] 切换优选基址 -> ${host}`); }
      return { ...res, host };
    } catch (e) {
      logE(`[failover] ${host}${path} -> ${e.message}, 切下一个`);
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有基址均不可用');
}

// 页面级缓存入口：home/category/search/detail 分别给 TTL；play 链路不缓存（签名短时效）。
async function fetchHtml(path, options = {}, ttl) {
  const cacheKey = `page:${path}`;
  const cached = await getCachedText(cacheKey, 'ikan');
  if (cached) { logI(`[cache] 命中 ${path} 长度=${cached.length}`); return { body: cached, host: HOSTS[PREFERRED], _cached: true }; }
  const res = await fetchWithFailover(path, options);
  await setCachedText(cacheKey, 'ikan', res.body, ttl);
  return { ...res, _cached: false };
}

// 站点路由拼装：中文分类名按 segment 编码，避免「按钮有值但中文筛选回空」。
function encodeSegment(s) { return encodeURIComponent(String(s)); }
function buildCategoryPath(tid, page) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const t = String(tid || 'all');
  if (t.startsWith('hot:')) {
    const parts = t.split(':');
    const mtype = parts[1] === 'movie' ? 'movie' : 'tv';
    const name = parts[2] || '热门';
    // 热门电影的固定标签是「热门」，剧集子类用自身名称
    const label = mtype === 'movie' ? '热门' : name;
    const suffix = p > 1 ? `-p-${p}` : '';
    return `/hot/index-${mtype}-${encodeSegment(label)}${suffix}.html`;
  }
  const id = CATEGORY_ID_MAP[t];
  if (id === undefined) return null;
  const base = id ? `/category/${id}` : '/category/';
  return p > 1 ? `${base}?p=${p}` : base;
}

// 只认分页 <a> 里的「下一页」href，不用全页字符串泛匹配。
// 注意两类坑：
//  1) 末页自指：/category/1?p=2 的「下一页」仍指向 p=2，不能只判断文字存在；
//  2) 游标偏移：/category/ 的 p 不是连续页码（p=1 的下一页可能是 p=22），
//     所以这里只返回「是否有有效下一页 + 真实 href」，pagecount 由 handler 保守取 page+1。
function parseNextPage(html, currentPage, currentPath) {
  const links = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const norm = (u) => String(u || '').replace(/&amp;/g, '&').replace(/\/+$/, '').toLowerCase();
  for (const m of links) {
    if (!/下一页|next/i.test(cleanText(m[2]))) continue;
    const href = m[1].replace(/&amp;/g, '&');
    // 末页自指：下一页 href 与本次请求 path 完全一致（可能是游标式 p=41 也可能是连续 p=2）
    if (currentPath && norm(href) === norm(currentPath)) continue;
    const pFromQuery = href.match(/[?&]p=(\d+)/);
    const pFromPath = href.match(/-p-(\d+)\.html/i);
    const n = parseInt((pFromQuery || pFromPath || [])[1], 10);
    if (Number.isFinite(n) && n <= currentPage) continue;
    return { hasNext: true, href, rawPage: Number.isFinite(n) ? n : 0 };
  }
  return { hasNext: false, href: '', rawPage: 0 };
}

// /category/ 的 p 为游标偏移，下一页 href 里的 p 不等于「当前页+1」。
// 按 tid+当前页记住真实下一页 href，category() 收到下一页请求时优先用该 href。
const CATEGORY_NEXT_HREF = new Map();
// 记录上一页首条 id：站点游标越界时会把 p 回落到与上一页相同的内容，
// 若检测到重复则直接判为末页，避免宿主多出一个重复页。
const CATEGORY_FIRST_ID = new Map();

// 列表卡片解析：首页/分类/热门页通用 <a class="item" href="/play/N"> ... data-src ... <p>标题</p>。
function parseCardList(html, defaultTypeName) {
  const list = [];
  const seen = new Set();
  const re = /<a\s+class="item"\s+href="\/play\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    const block = m[2];
    const imgAlt = block.match(/<img[^>]*\balt\s*=\s*["']([^"']*)["']/i);
    const pM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const name = cleanText(pM ? pM[1] : (imgAlt ? imgAlt[1] : '')) || id;
    seen.add(id);
    list.push({
      vod_id: id, vod_name: name, vod_pic: pickImage(block),
      type_name: defaultTypeName || '', vod_tag: 'video'
    });
  }
  return list;
}

// 搜索结果解析：以 <a href="/play/N" class="cover-link"> 为锚点，
// 取该锚点之后到下一个 media 之前的区块，避免嵌套 </div> 数量变化导致正则提前截断。
function parseSearchList(html) {
  const list = [];
  const seen = new Set();
  const anchors = [...html.matchAll(/<a href="\/play\/(\d+)" class="cover-link">([\s\S]*?)<\/a>/gi)];
  anchors.forEach((a, idx) => {
    const id = a[1];
    if (seen.has(id)) return;
    const start = a.index;
    const end = idx + 1 < anchors.length ? anchors[idx + 1].index : Math.min(html.length, start + 2200);
    const block = html.slice(start, end);
    const titleM = block.match(/class="title-text"[^>]*>([\s\S]*?)<\/a>/i);
    const labelM = block.match(/\[(\d+)条线路可播放\]/);
    // 保留原始空白：站点用「双空格」分隔地区与别名、用「单空格」分隔导演与主演，
    // 若先 cleanText 压平空白就切不开了。
    const smallsRaw = [...block.matchAll(/<span class="small"[^>]*>([\s\S]*?)<\/span>/gi)].map(x => x[1]);
    let name = cleanText(titleM ? titleM[1] : '');
    const yearM = name.match(/\s+((?:19|20)\d{2})\s*$/);
    const year = yearM ? yearM[1] : '';
    if (yearM) name = name.replace(/\s+(?:19|20)\d{2}\s*$/, '').trim();
    const alt = a[2].match(/alt="([^"]*)"/i);
    if (!name) name = cleanText(alt ? alt[1] : id) || id;
    seen.add(id);
    const firstSmall = cleanText(smallsRaw[0] || '').replace(/&nbsp;/g, ' ');
    const firstSmallRaw = (smallsRaw[0] || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\r/g, '');
    // 形如「中国大陆  庆余年,Joy of Life」：地区与别名之间是双空格
    const areaParts = firstSmallRaw.split(/\s{2,}| {2,}/);
    const secondSmall = cleanText(smallsRaw[1] || '');
    // 形如「孙皓 张若昀,李沁,...」：第一个空格前是导演，后面是主演
    const peopleParts = secondSmall.split(/\s+/);
    list.push({
      vod_id: id, vod_name: name, vod_pic: pickImage(a[2]), vod_tag: 'video',
      vod_year: year,
      vod_remarks: labelM ? `${labelM[1]}条线路` : '',
      vod_area: cleanText(areaParts[0] || ''),
      vod_director: peopleParts[0] || '',
      vod_actor: peopleParts.slice(1).join(' ').trim()
    });
  });
  return list;
}

// 详情页：title / meta / current_id / e_token / mtype / 封面。
function parseDetailPage(html) {
  const titleM = html.match(/<h1[^>]*id="video_title"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<title>([\s\S]*?)<\/title>/i);
  let title = cleanText(titleM ? titleM[1] : '');
  title = title.replace(/\s*-免费在线观看-.*$/i, '').trim();
  const id = (html.match(/id="current_id"\s+value="([^"]+)"/i) || [])[1] || '';
  const eToken = (html.match(/id="e_token"\s+value="([^"]+)"/i) || [])[1] || '';
  const mtype = (html.match(/id="mtype"\s+value="([^"]+)"/i) || [])[1] || '1';
  const infoBlock = (html.match(/<div class="item result-info active">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i) || [])[1] || '';
  // <h2 class="meta title"> 是片名本身，不能混入 metas；只取 <h3 class="meta"> 四行：
  // 又名 / 年份 / 地区 / 「导演/主演」。
  const metas = [...infoBlock.matchAll(/<h3[^>]*class="meta[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi)].map(x => cleanText(x[1]));
  const metaTitle = (infoBlock.match(/<h2[^>]*class="meta title"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1];
  if (!title && metaTitle) title = cleanText(metaTitle);
  const alias = metas[0] || '';
  const year = (metas[1] || '').match(/(?:19|20)\d{2}/)?.[0] || '';
  const area = metas[2] || '';
  const people = metas[3] || '';
  const director = people.split('/')[0].trim();
  const actor = people.includes('/') ? people.split('/').slice(1).join('/').trim() : '';
  const pic = pickImage(infoBlock);
  const desc = (html.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || '';
  return { id, title, eToken, mtype, pic, alias, year, area, director, actor, desc: cleanText(desc) };
}

// 还原站点内联 get_tks()：取 current_id 末 4 位，逐位 d => k=d%3+1，
// 从 e_token 的 substring(k,k+8) 取一段，再把 e_token 砍掉前 k+8 个字符，最后拼接。
function buildToken(id, eToken) {
  if (!id || !eToken) return '';
  const last4 = String(id).substring(String(id).length - 4);
  const parts = [];
  let cur = eToken;
  for (let i = 0; i < last4.length; i++) {
    const d = parseInt(last4[i], 10);
    if (!Number.isFinite(d)) return '';
    const k = d % 3 + 1;
    parts.push(cur.substring(k, k + 8));
    cur = cur.substring(k + 8);
  }
  return parts.join('');
}

// 解析 /api/getResN 的线路：resData 是 JSON 字符串数组，url 为「集名$直链#集名$直链」。
// 与官网 play_new.js 保持一致：只保留 m3u8 结尾的地址，保持上游线路顺序。
function parseLineSources(apiBody) {
  let json;
  try { json = typeof apiBody === 'string' ? JSON.parse(apiBody) : apiBody; } catch (_) { return { sources: [], state: -1 }; }
  const state = Number(json.state);
  if (state !== 1 || !json.data || !Array.isArray(json.data.list)) return { sources: [], state };
  const sources = [];
  json.data.list.forEach((item, index) => {
    let resArr;
    try { resArr = typeof item.resData === 'string' ? JSON.parse(item.resData) : item.resData; } catch (_) { return; }
    if (!Array.isArray(resArr)) return;
    const episodes = [];
    const epSeen = new Set();
    resArr.forEach((r) => {
      const rawUrl = String(r && r.url || '');
      const flag = String(r && r.flag || '').trim();
      rawUrl.split('#').forEach((seg) => {
        const parts = seg.trim().split('$');
        if (parts.length < 2) return;
        const epName = cleanText(parts[0]) || `第${episodes.length + 1}集`;
        const url = parts.slice(1).join('$').trim();
        if (!/m3u8(\?|$)/i.test(url) || epSeen.has(url)) return;
        epSeen.add(url);
        episodes.push({ name: epName, playId: url, _flag: flag, _lineId: String(item.id || '') });
      });
    });
    if (!episodes.length) return;
    // 官网 UI 显示「线路N」；flag 仅写入日志，不拼进展示名，避免站外 code 干扰排序展示。
    sources.push({ name: `线路${index + 1}`, episodes });
  });
  return { sources, state };
}

// 取线路：详情 HTML（含 e_token）-> token -> /api/getResN。API 不缓存，保证签名新鲜。
async function fetchLineSources(videoId) {
  const pagePath = `/play/${encodeURIComponent(videoId)}`;
  // e_token 实测同一 videoId 连续 3 次请求保持不变（站点按资源固定下发），
  // 可给详情页 HTML 60s 页面缓存；但 /api/getResN 线路接口一律不缓存，保证签名新鲜。
  const page = await fetchHtml(pagePath, {}, 60);
  const meta = parseDetailPage(page.body);
  if (!meta.eToken) { logE(`[detail] ${videoId} 未取到 e_token`); return { meta, sources: [], apiState: -1 }; }
  const token = buildToken(meta.id || videoId, meta.eToken);
  const apiPath = `/api/getResN?videoId=${encodeURIComponent(meta.id || videoId)}&mtype=${encodeURIComponent(meta.mtype)}&token=${encodeURIComponent(token)}`;
  logI(`[detail] ${videoId} mtype=${meta.mtype} token长度=${token.length} 请求 ${apiPath.split('&token=')[0]}&token=***`);
  const res = await fetchWithFailover(apiPath, {
    json: true,
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${HOSTS[PREFERRED]}${pagePath}` }
  });
  const parsed = parseLineSources(res.body);
  logI(`[detail] ${videoId} getResN state=${parsed.state} 线路=${parsed.sources.length} 总分集=${parsed.sources.reduce((n, s) => n + s.episodes.length, 0)}`);
  return { meta, sources: parsed.sources, apiState: parsed.state };
}

async function home(params, context) {
  const from = (context && context.from) || 'web';
  logI(`[home] 入口参数=${JSON.stringify(params || {})} from=${from}`);
  try {
    const res = await fetchHtml('/', {}, 300);
    const list = await attachImages(parseCardList(res.body, '推荐'), 300);
    logI(`[home] 命中 ${res.host} 返回 ${list.length} 条 图片模式=${IMG_MODE} cached=${res._cached}`);
    return { class: CATEGORIES, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, list: [] };
  }
}

async function category(params, context) {
  const from = (context && context.from) || 'web';
  const p = params || {};
  // 同时兼容 params.filters / params.extend / params.ext（宿主筛选字段不统一）
  const filters = p.filters || p.extend || p.ext || {};
  const tid = String(p.categoryId || p.type_id || p.tid || 'all');
  const page = Math.max(1, parseInt(p.page || p.pg || '1', 10) || 1);
  logI(`[category] 入口参数=${JSON.stringify(p)} from=${from} filters=${JSON.stringify(filters)}`);
  try {
    // 站点 /category/ 的 p 是游标偏移，翻页必须复用上一页「下一页」href；
    // 其余分类（/category/{id}、/hot/...）的 p 是连续页码，可本地拼装。
    const cursorKey = `${tid}:${page}`;
    let path = (page > 1 && CATEGORY_NEXT_HREF.has(cursorKey)) ? CATEGORY_NEXT_HREF.get(cursorKey) : buildCategoryPath(tid, page);
    if (!path) { logE(`[category] 未知分类 ${tid}`); return { page, pagecount: page, total: 0, list: [] }; }
    const res = await fetchHtml(path, {}, 300);
    const cat = CATEGORIES.find(c => c.type_id === tid);
    const list = await attachImages(parseCardList(res.body, cat ? cat.type_name : ''), 300);
    const firstId = list.length ? list[0].vod_id : '';
    const prevFirst = CATEGORY_FIRST_ID.get(`${tid}:${page - 1}`);
    const duplicate = page > 1 && firstId && prevFirst && firstId === prevFirst;
    let next = parseNextPage(res.body, page, path);
    if (duplicate) {
      logI(`[category] tid=${tid} page=${page} 与上一页首条相同(${firstId})，按末页处理`);
      next = { hasNext: false, href: '', rawPage: 0 };
    }
    CATEGORY_FIRST_ID.set(`${tid}:${page}`, firstId);
    if (next.hasNext && next.href) CATEGORY_NEXT_HREF.set(`${tid}:${page + 1}`, next.href);
    const pagecount = next.hasNext ? page + 1 : page;
    logI(`[category] 命中 ${res.host} tid=${tid} page=${page} path=${path} 返回 ${list.length} 条 下一页=${next.hasNext ? next.href : '无'} duplicate=${duplicate} pagecount=${pagecount} cached=${res._cached}`);
    return { page, pagecount, limit: 48, total: list.length, list };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: page, total: 0, list: [] };
  }
}

// 搜索下一页游标：站点 /search?q=..&p=N&n=游标，游标由上一页「下一页」href 下发。
const SEARCH_CURSOR = new Map();
function extractNextCursor(html) {
  const links = [...html.matchAll(/<a[^>]*href=["']([^"']*\/search\?[^"']*p=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const next = links.find(m => /下一页/.test(cleanText(m[2])));
  if (!next) return '';
  const href = next[1].replace(/&amp;/g, '&');
  const n = href.match(/[?&]n=([^&]+)/);
  return n ? decodeURIComponent(n[1]) : '';
}

async function search(params, context) {
  const from = (context && context.from) || 'web';
  const p = params || {};
  const kw = String(p.keyword || p.wd || p.key || p.q || '').trim();
  const page = Math.max(1, parseInt(p.page || p.pg || '1', 10) || 1);
  logI(`[search] 入口参数=${JSON.stringify(p)} from=${from}`);
  if (!kw) return { page: 1, pagecount: 1, total: 0, list: [] };
  try {
    let path = `/search?q=${encodeURIComponent(kw)}${page > 1 ? `&p=${page}` : ''}`;
    const cursors = SEARCH_CURSOR.get(kw) || {};
    if (page > 1 && cursors[page]) path += `&n=${encodeURIComponent(cursors[page])}`;
    const res = await fetchHtml(path, {}, 60);
    const list = await attachImages(parseSearchList(res.body), 60);
    const cursor = extractNextCursor(res.body);
    if (cursor) { cursors[page + 1] = cursor; SEARCH_CURSOR.set(kw, cursors); }
    const next = parseNextPage(res.body, page, path);
    const pagecount = next.hasNext ? page + 1 : page;
    logI(`[search] 命中 ${res.host} "${kw}" page=${page} 返回 ${list.length} 条 游标=${cursor ? '有' : '无'} 下一页=${next.hasNext ? next.href.slice(0, 80) : '无'} pagecount=${pagecount}`);
    return { page, pagecount, limit: 10, total: list.length, list };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: page, total: 0, list: [] };
  }
}

async function detail(params, context) {
  const from = (context && context.from) || 'web';
  logI(`[detail] 入口参数=${JSON.stringify(params || {})} from=${from}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.videoId || params.vod_id || params.id)) || '';
    const videoId = String(raw).trim().replace(/^\/play\//, '').split(/[?#]/)[0];
    if (!videoId) return { list: [] };
    const { meta, sources, apiState } = await fetchLineSources(videoId);
    const vod_content = [
      meta.alias && `又名：${meta.alias}`,
      meta.year && `年份：${meta.year}`,
      meta.area && `地区：${meta.area}`,
      meta.director && `导演：${meta.director}`,
      meta.actor && `主演：${meta.actor}`,
      meta.desc && `\n${meta.desc}`
    ].filter(Boolean).join('\n').trim();
    const vod = {
      vod_id: videoId,
      vod_name: meta.title || videoId,
      vod_pic: IMG_PROXY
        ? (meta.pic ? IMG_PROXY + (meta.pic.startsWith('/') ? HOSTS[PREFERRED] + meta.pic : normalizeDoubanPic(meta.pic, videoId)) : '')
        : await inlineDoubanImage(normalizeDoubanPic(meta.pic, videoId), 300),
      vod_content,
      vod_year: meta.year,
      vod_area: meta.area,
      vod_director: meta.director,
      vod_actor: meta.actor,
      vod_remarks: sources.length ? `${sources.length}条线路` : '',
      type_name: Number(meta.mtype) === 2 ? '剧集' : '电影',
      vod_play_sources: sources
    };
    // 兼容部分宿主仍读旧字段
    if (sources.length) {
      vod.vod_play_from = sources.map(s => s.name).join('$$$');
      vod.vod_play_url = sources.map(s => s.episodes.map(e => `${e.name}$${e.playId}`).join('#')).join('$$$');
    }
    logI(`[detail] ${videoId} "${vod.vod_name}" 线路=${sources.length} 分集=${sources.reduce((n, s) => n + s.episodes.length, 0)} apiState=${apiState}`);
    return { list: [vod] };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const from = (context && context.from) || 'web';
  logI(`[play] 入口参数=${JSON.stringify(params || {})} from=${from}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id)) || '';
    let playId = String(raw).trim();
    if (!playId) return { urls: [], parse: 0 };
    const HEADER = {
      'User-Agent': USER_AGENT,
      Referer: `${HOSTS[PREFERRED]}/`,
      Origin: HOSTS[PREFERRED],
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    // 主链路：detail 传出的 playId 本身就是 m3u8 直链，直接 parse=0 返回。
    if (/^https?:\/\//i.test(playId)) {
      const isMedia = /\.(m3u8|mp4)(\?|$)/i.test(playId);
      logI(`[play] ${new URL(playId).hostname}${new URL(playId).pathname.slice(0, 60)} -> isMedia=${isMedia} parse=0`);
      return { urls: [{ name: '播放', url: playId }], flag: 'ikanbot', header: HEADER, parse: isMedia ? 0 : 1 };
    }
    // 兼容：宿主若把 videoId 当 playId 传进来，回查详情取第一集。
    const videoId = playId.replace(/^\/play\//, '').split(/[?#]/)[0];
    const { sources } = await fetchLineSources(videoId);
    const first = sources.length && sources[0].episodes.length ? sources[0].episodes[0] : null;
    if (!first) { logE(`[play] ${videoId} 无可用线路`); return { urls: [], flag: 'ikanbot', header: HEADER, parse: 0 }; }
    logI(`[play] ${videoId} 回查详情取首集 "${first.name}" -> ${new URL(first.playId).hostname} parse=0`);
    return { urls: [{ name: first.name, url: first.playId }], flag: 'ikanbot', header: HEADER, parse: 0 };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    return { urls: [], flag: 'ikanbot', header: { 'User-Agent': USER_AGENT }, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
