// @name 厂长资源
// @author 宝宝巴士
// @description 厂长资源（4kcz.com / czzy）：WordPress mibt 主题；分类/搜索/详情/播放；播放页 /v_play/{base64} 经 SDK 嗅探 + parse=1 兜底
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/4kcz.js
/**
 * ============================================================================
 * 厂长资源（4kcz.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-15 实测）】
 *   程序：WordPress + mibt 主题（不是 MacCMS，没有 /api.php/provide/vod/ 采集接口）
 *   详情：/movie/{id}.html
 *   分类：/movie_bt_series/{slug}、/movie_bt_tags/{tag}、/movie_bt_cat/{area}、/year/{year}
 *         /movie_bt/ 是「分类筛选」总入口
 *   分页：{分类URL}/page/{n}
 *   搜索：/?s={关键词}（WordPress 原生搜索）
 *   播放：详情页 <div class="paly_list_btn"> 里是 /v_play/{base64}.html，
 *         base64 解码后形如 mv_24191-nm_1（影片ID-线路_集数）。
 *         播放页内嵌 <iframe class="viframe" src="https://plaa.py1080p.com:8181/player/py.php?...">
 *         —— 真实 m3u8 由该第三方解析站在浏览器端解密下发，服务端拿不到明文。
 *         因此 play() 采用「嗅探优先 + parse=1 兜底」，把播放页交给播放器处理。
 *
 * 【封面】列表卡片真实封面在 img[data-original]（src 是 blank.gif 占位），
 *        且经过 gimg1.baidu.com 图片代理包装，原图在 src= 参数里，需还原。
 *
 * 【地区限制】本站对境外 IP 有封锁（返回 403 或地区异常页）。
 *        脚本已内置多域名池与失败降权，配置 SITE_MIRRORS 可加备用域名。
 *
 * 【环境变量】
 *   SITE_API        主站地址，默认 https://www.4kcz.com
 *   CZ_MIRRORS      备用域名（逗号分隔），追加进轮换池
 *   CZ_UA           自定义 User-Agent
 *   CZ_COVER_PROXY  封面是否走百度图床代理还原，默认 1（0 关闭）
 * ============================================================================
 */

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) {
  OmniBox = {
    log() { /* 无 SDK 时静默，绝不写 stdout */ },
    getCache() { return null; },
    setCache() { return Promise.resolve(); },
    deleteCache() { return Promise.resolve(); },
  };
}
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const https = require('https');
const http = require('http');
const zlib = require('zlib');

const PREFIX = '[czzy]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.CZ_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- 域名池 ---------------- */
const PRIMARY = (process.env.SITE_API || 'https://www.4kcz.com').replace(/\/+$/, '');

/**
 * 备用入口：这些域名实测是**导航公告页**（不是同构站），
 * 页面正文形如「新地址 www.4kcz.com，本页面是默认跳转页面」，
 * 并列出当前所有可用主域（www.4kcz.com / czzy.top / www.cz4k.com）。
 * 所以它们不能直接当采集基址，而是作为「域名发现源」：
 * 全部基址失败时去抓公告页，解析出真实主域再并入轮换池。
 */
const NAV_PAGES = [
  'https://www.cz01.vip/',
  'https://www.czzy.site/',
  'https://czzy.top/',
];
const BUILTIN_MIRRORS = [
  'https://www.cz4k.com',
];

const HOSTS = (() => {
  const fromMirrors = String(process.env.CZ_MIRRORS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, '');
  const list = [PRIMARY, ...fromMirrors.map(norm), ...BUILTIN_MIRRORS];
  return Array.from(new Set(list));
})();
let PREFERRED = 0;
const hostHealth = Object.create(null);
const COOLDOWN = (() => {
  const raw = String(process.env.CZ_ROTATE_COOLDOWN || '').trim();
  const n = raw === '' ? 600 : Number(raw);
  return Math.max(60, Number.isFinite(n) ? n : 600) * 1000;
})();

function buildHostOrder() {
  const now = Date.now();
  return HOSTS.map((host, idx) => {
    const h = hostHealth[host] || {};
    return {
      idx,
      blocked: h.blockAt && (now - h.blockAt) < COOLDOWN ? 1 : 0,
      preferred: idx === PREFERRED ? 0 : 1,
      fails: Number(h.fail || 0),
    };
  }).sort((a, b) => a.blocked - b.blocked || a.preferred - b.preferred || a.fails - b.fails || a.idx - b.idx)
    .map((s) => s.idx);
}
function markHost(host, ok, reason) {
  if (!host) return;
  const h = hostHealth[host] || (hostHealth[host] = { fail: 0, okAt: 0, blockAt: 0 });
  if (ok) { h.fail = 0; h.okAt = Date.now(); h.blockAt = 0; return; }
  h.fail = Number(h.fail || 0) + 1;
  if (/403|地区|拦截|blocked/i.test(String(reason || ''))) h.blockAt = Date.now();
}

/* ---------------- HTTP ---------------- */
function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) {}
  return buf;
}

function nodeRequest(urlStr, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${u.origin}/`,
    }, options.headers || {});
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || 20000,
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return nodeRequest(new URL(res.headers.location, u.href).href, options, redirects + 1)
          .then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const body = decompress(raw, res.headers['content-encoding']).toString('utf-8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body, finalUrl: u.href });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function httpGet(url, options = {}) {
  try {
    if (OmniBox && typeof OmniBox.request === 'function') {
      const r = await OmniBox.request(url, {
        method: 'GET',
        headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, options.headers || {}),
        timeout: options.timeout || 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return { statusCode: Number(r.statusCode) || 200, body, headers: r.headers || {} };
    }
  } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  return nodeRequest(url, options);
}

/** 带域名轮换的抓取：path 以 / 开头 */
async function fetchPath(path, options = {}) {
  const order = buildHostOrder();
  for (const idx of order) {
    const host = HOSTS[idx];
    const url = host + path;
    try {
      logI(`拉取 ${url}`);
      const res = await httpGet(url, options);
      const body = String(res.body || '');
      // 403 / 地区异常页 / 空体 → 判为不可用，换下一个域名
      if (res.statusCode === 403 || /地区网络连接异常|Access denied/i.test(body) || body.length < 200) {
        markHost(host, false, `HTTP ${res.statusCode}`);
        logI(`${host} 不可用（HTTP ${res.statusCode}，${body.length}B），换下一个`);
        continue;
      }
      if (res.statusCode >= 200 && res.statusCode < 400) {
        markHost(host, true);
        PREFERRED = idx;
        return { body, host, statusCode: res.statusCode };
      }
      markHost(host, false, `HTTP ${res.statusCode}`);
    } catch (e) {
      markHost(host, false, e.message);
      logI(`${host} 请求异常: ${e.message}`);
    }
  }
  // 全部失败：去导航公告页发现最新主域，再重试一轮（只发现一次）
  if (!globalThis.__czzyDiscovered) {
    globalThis.__czzyDiscovered = true;
    const added = await discoverFromNavPages();
    if (added.length) {
      for (const host of added) {
        try {
          const res = await httpGet(host + path, options);
          const body = String(res.body || '');
          if (res.statusCode >= 200 && res.statusCode < 400 && body.length >= 200
              && !/地区网络连接异常/i.test(body)) {
            markHost(host, true);
            PREFERRED = HOSTS.indexOf(host);
            logI(`用新发现的域名重试成功 -> ${host}`);
            return { body, host, statusCode: res.statusCode };
          }
        } catch (_) {}
      }
    }
  }
  logE('所有候选域名均不可达');
  return { body: '', host: HOSTS[PREFERRED] || PRIMARY, statusCode: 0 };
}

/**
 * 从导航公告页发现最新主域。
 * 公告页正文形如：「新地址 www.4kcz.com，本页面是默认跳转页面 ...
 *   推荐访问 https://www.4kcz.com / https://czzy.top / https://www.cz4k.com」
 * 只接受能通过同构校验（首页能解析出 movie 卡片）的域名。
 */
async function discoverFromNavPages() {
  const found = new Set();
  for (const page of NAV_PAGES) {
    try {
      const res = await httpGet(page, { timeout: 15000 });
      const body = String(res.body || '');
      if (!body || body.length < 100) continue;
      // 抓页面里所有形如 4kcz.com / czzy.top / cz4k.com 的域名
      const re = /\b((?:www\.)?(?:[a-z0-9-]+\.)*(?:4kcz|czzy|cz4k|cz01)\.[a-z]{2,})\b/gi;
      let m;
      while ((m = re.exec(body)) !== null) {
        const d = m[1].toLowerCase();
        // 排除导航页自身与统计/外链
        if (/baidu|bytedance|elemecdn|google|jquery/i.test(d)) continue;
        found.add(`https://${d}`);
      }
      logI(`导航页 ${page} 发现候选: ${[...found].join(', ')}`);
    } catch (e) {
      logI(`导航页 ${page} 不可达: ${e.message}`);
    }
  }
  const added = [];
  for (const host of found) {
    if (HOSTS.includes(host)) continue;
    // 同构校验：首页必须能解析出 movie 卡片
    try {
      const res = await httpGet(host + '/', { timeout: 15000 });
      const body = String(res.body || '');
      if (res.statusCode === 200 && /\/movie\/\d+\.html/i.test(body) && body.length > 5000) {
        HOSTS.push(host);
        hostHealth[host] = { fail: 0, okAt: 0, blockAt: 0 };
        added.push(host);
        logI(`发现可用主域 -> ${host}`);
      } else {
        logI(`跳过非同构域名 -> ${host}（HTTP ${res.statusCode}，${body.length}B）`);
      }
    } catch (_) {}
  }
  return added;
}

/* ---------------- 工具 ---------------- */
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 还原百度图床代理：gimg1.baidu.com/gimg?...&src=img.czzy66.com/2026/11/x.jpg */
function fixCover(src) {
  let u = String(src || '').trim();
  if (!u) return '';
  // HTML 实体必须先还原，否则 &amp; 会让百度代理的 src= 参数断掉
  u = u.replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/gi, '"');
  if (u.startsWith('//')) u = 'https:' + u;
  if (process.env.CZ_COVER_PROXY === '0') return u;
  // 百度代理包装：取 src= 参数还原成原始图床
  if (/gimg\d*\.baidu\.com\/gimg/i.test(u)) {
    const m = u.match(/[?&]src=([^&]+)/i);
    if (m) {
      let inner = m[1];
      try { inner = decodeURIComponent(inner); } catch (_) {}
      if (inner && !/^https?:\/\//i.test(inner)) inner = 'https://' + inner;
      if (/^https?:\/\//i.test(inner)) return inner;
    }
  }
  return u;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: 'zuixindianying', type_name: '最新电影' },
  { type_id: 'movie_bt_series/dyy', type_name: '近日更新(电影)' },
  { type_id: 'gcj', type_name: '国产剧' },
  { type_id: 'meijutt', type_name: '美剧' },
  { type_id: 'hanjutv', type_name: '韩剧' },
  { type_id: 'riju', type_name: '日剧' },
  { type_id: 'fanju', type_name: '番剧' },
  { type_id: 'haiwaijuqita', type_name: '海外剧' },
  { type_id: 'dongmanjuchangban', type_name: '剧场版' },
  { type_id: 'huayudianying', type_name: '华语电影' },
  { type_id: 'oumeidianying', type_name: '欧美电影' },
  { type_id: 'hanguodianying', type_name: '韩国电影' },
  { type_id: 'ribendianying', type_name: '日本电影' },
  { type_id: 'gaofenyingshi', type_name: '高分影视' },
  { type_id: 'dbtop250', type_name: '豆瓣Top250' },
];

/** 分类 slug → 真实 URL 前缀 */
function classPath(typeId) {
  const t = String(typeId || '').trim();
  if (!t || t === 'all') return '/zuixindianying';
  // 已是完整路径（含 movie_bt_series/ 等）
  if (t.includes('/')) return '/' + t.replace(/^\/+/, '');
  return '/' + t;
}

/* ---------------- 列表解析 ---------------- */
function parseList(html, host) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  // 卡片：<li><a href=".../movie/{id}.html"> <img ... data-original="封面"> ... <div class="jidi"><span>备注</span></div>
  //       <h3 class="dytit"><a href="...">标题</a></h3> <p class="inzhuy">主演：...</p>
  const liRe = /<li>\s*<a\s+href="([^"]*\/movie\/(\d+)\.html)"[\s\S]*?(?=<li>|<\/ul>|$)/gi;
  let m;
  while ((m = liRe.exec(s)) !== null) {
    const block = m[0];
    const id = m[2];
    if (seen.has(id)) continue;
    // 标题：优先 h3.dytit > a 文本
    let title = '';
    const h3 = block.match(/<h3[^>]*class="[^"]*dytit[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3) title = cleanText(h3[1]);
    if (!title) {
      const alt = block.match(/<img[^>]*alt="([^"]*)"/i);
      if (alt) title = cleanText(alt[1]);
    }
    if (!title) continue;
    // 封面：data-original 优先（src 是 blank.gif 占位）
    let pic = '';
    const orig = block.match(/data-original="([^"]+)"/i);
    if (orig) pic = fixCover(orig[1]);
    if (!pic) {
      const src = block.match(/<img[^>]*src="([^"]+)"/i);
      if (src && !/blank\.gif/i.test(src[1])) pic = fixCover(src[1]);
    }
    // 备注：div.jidi > span
    let remarks = '';
    const jidi = block.match(/<div[^>]*class="[^"]*jidi[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    if (jidi) remarks = cleanText(jidi[1]);
    // 主演
    let actor = '';
    const zhuy = block.match(/<p[^>]*class="[^"]*inzhuy[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (zhuy) actor = cleanText(zhuy[1]).replace(/^主演[:：]\s*/, '');
    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      vod_actor: actor,
      vod_tag: 'video',
      vod_url: `${host}/movie/${id}.html`,
    });
  }
  return list;
}

/** 解析分页总数 */
function parsePageCount(html, currentPath) {
  const s = String(html || '');
  let max = 1;
  const re = /\/page\/(\d+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(id) {
  const cacheKey = `czzy:detail:${id}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.id) return obj;
    }
  } catch (_) {}

  const { body, host } = await fetchPath(`/movie/${id}.html`);
  if (!body) return null;

  const titleM = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || body.match(/<title[^>]*>([^<]*)<\/title>/i);
  let title = cleanText(titleM ? titleM[1] : '').replace(/\s*[-–|].*$/, '').trim();

  // 封面
  let pic = '';
  const imgM = body.match(/<img[^>]*class="[^"]*(?:attachment|poster|wp-post-image)[^"]*"[^>]*src="([^"]+)"/i)
    || body.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (imgM) pic = fixCover(imgM[1]);

  // 元数据：类型 / 地区 / 年份 / 又名 / 上映 / 导演 / 编剧 / 主演 / 语言
  // 结构：<li>导演：<span>成红</span>&nbsp;&nbsp;<span>赵大牛</span></li>
  //       <li>类型：<a href=".../movie_bt_tags/juqing">剧情</a><a ...>喜剧</a></li>
  // 多值字段必须把该行内所有 span/a 的文本都取出来，只取第一个会漏。
  const pick = (label) => {
    const re = new RegExp(`${label}[:：]([\\s\\S]{0,600}?)<\\/li>`, 'i');
    const m = body.match(re);
    if (!m) return '';
    const seg = m[1];
    const parts = [];
    const tagRe = /<(?:span|a)\b[^>]*>([\s\S]*?)<\/(?:span|a)>/gi;
    let t;
    while ((t = tagRe.exec(seg)) !== null) {
      const v = cleanText(t[1]);
      if (v) parts.push(v);
    }
    const raw = parts.length ? Array.from(new Set(parts)).join(' ') : cleanText(seg).replace(/^[\s:：]+/, '');
    // 站方部分影片字段没录入，会直接输出 "false"/"undefined"/"null"，过滤掉
    if (/^(false|undefined|null|0|无)$/i.test(raw)) return '';
    return raw;
  };
  const year = (body.match(/\/year\/(\d{4})/i) || [])[1] || pick('年份');
  const area = pick('地区');
  const typeName = pick('类型');
  const lang = pick('语言');
  const alias = pick('又名');
  const actor = pick('主演');
  const director = pick('导演');
  const releaseDate = pick('上映');

  // 简介
  let content = '';
  const descM = body.match(/电影介绍[^<]*<\/[^>]+>([\s\S]{0,1200}?)(?:<div|<footer|<\/article)/i);
  if (descM) content = cleanText(descM[1]);
  if (!content) {
    const og = body.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i);
    if (og) content = cleanText(og[1]);
  }

  // 剧集：/v_play/{base64}.html
  const episodes = [];
  const epRe = /<a[^>]*href="([^"]*\/v_play\/([^".]+)\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let em;
  const seenEp = new Set();
  while ((em = epRe.exec(body)) !== null) {
    const b64 = em[2];
    if (seenEp.has(b64)) continue;
    seenEp.add(b64);
    const name = cleanText(em[3]) || `第${episodes.length + 1}集`;
    // 解码出 mv_{id}-{line}_{ep}，便于排查
    let decoded = '';
    try { decoded = Buffer.from(b64, 'base64').toString('utf-8'); } catch (_) {}
    episodes.push({ name, playId: b64, _decoded: decoded });
  }

  const vod = {
    id,
    vod_id: id,
    vod_name: title,
    vod_pic: pic,
    vod_year: year,
    vod_area: area,
    vod_lang: lang,
    vod_actor: actor,
    vod_director: director,
    vod_content: content,
    type_name: typeName,
    vod_pubdate: releaseDate,
    vod_remarks: alias ? `又名：${alias}` : '',
    vod_play_sources: episodes.length ? [{
      name: '厂长资源',
      episodes: episodes.map((e) => ({ name: e.name, playId: e.playId })),
    }] : [],
    _host: host,
  };
  // 兼容旧展示链路
  if (episodes.length) {
    vod.vod_play_from = '厂长资源';
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join('#');
  }
  try { await OmniBox.setCache(cacheKey, vod, 1800); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId} from=${(context && context.from) || 'web'}`);
  const host = HOSTS[PREFERRED] || PRIMARY;

  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  // 已是直链：直接返回
  if (/\.(m3u8|mp4|flv|ts)(\?|$)/i.test(rawId)) {
    return {
      parse: 0,
      jx: 0,
      flag: '厂长资源',
      url: rawId,
      urls: [{ name: '默认线路', url: rawId }],
      header: { 'User-Agent': UA, Referer: `${host}/`, Origin: host },
    };
  }

  // 完整 URL 直接用；否则拼 /v_play/{b64}.html
  let pageUrl = rawId;
  if (/^https?:\/\//i.test(rawId)) pageUrl = rawId;
  else if (rawId.startsWith('/')) pageUrl = host + rawId;
  else pageUrl = `${host}/v_play/${rawId}.html`;

  // 先尝试 SDK 嗅探（能把播放页里的真实 m3u8 挖出来）
  try {
    if (OmniBox && typeof OmniBox.sniffVideo === 'function') {
      const r = await OmniBox.sniffVideo(pageUrl, { 'User-Agent': UA, Referer: `${host}/` });
      const u = r && (r.url || (r.urls && r.urls[0] && r.urls[0].url));
      if (u && /\.(m3u8|mp4)(\?|$)/i.test(u)) {
        logI(`嗅探成功: ${String(u).slice(0, 100)}`);
        return {
          parse: 0,
          jx: 0,
          flag: '厂长资源',
          url: u,
          urls: [{ name: '默认线路', url: u }],
          header: Object.assign({ 'User-Agent': UA, Referer: `${host}/`, Origin: host }, (r && r.header) || {}),
        };
      }
      logI('嗅探未取到直链，回退 parse=1 交给播放器');
    }
  } catch (e) {
    logI(`嗅探异常: ${e.message}`);
  }

  // 兜底：把播放页交给播放器嗅探
  return {
    parse: 1,
    jx: 0,
    flag: '厂长资源',
    url: pageUrl,
    urls: [{ name: '默认线路', url: pageUrl }],
    header: {
      'User-Agent': UA,
      Referer: `${host}/`,
      Origin: host,
    },
  };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const { body, host } = await fetchPath('/');
    list = parseList(body, host);
    logI(`home 返回 ${list.length} 条`);
  } catch (e) {
    logE(`home 异常: ${e.message}`);
  }
  return { class: cls, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const typeId = (params && (params.categoryId || params.type_id || params.tid)) || 'zuixindianying';
  const page = Math.max(1, Number((params && params.page) || 1));
  const base = classPath(typeId);
  const path = page > 1 ? `${base}/page/${page}` : base;
  logI(`category type=${typeId} page=${page} path=${path}`);
  let list = [];
  let pagecount = 1;
  try {
    const { body, host } = await fetchPath(path);
    list = parseList(body, host);
    pagecount = parsePageCount(body, path);
    logI(`category 返回 ${list.length} 条，共 ${pagecount} 页`);
  } catch (e) {
    logE(`category 异常: ${e.message}`);
  }
  return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
}

async function detail(params, context) {
  const id = String((params && (params.id || params.vod_id || params.videoId)) || '').trim();
  logI(`detail id=${id}`);
  if (!id) return { list: [] };
  try {
    const v = await fetchDetail(id);
    if (!v) return { list: [] };
    logI(`detail 成功: ${v.vod_name}，${(v.vod_play_sources[0] && v.vod_play_sources[0].episodes.length) || 0} 集`);
    return { list: [v] };
  } catch (e) {
    logE(`detail 异常: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const wd = String((params && (params.wd || params.keyword || params.k)) || '').trim();
  const page = Math.max(1, Number((params && params.page) || 1));
  logI(`search wd=${wd} page=${page}`);
  if (!wd) return { page, pagecount: 1, total: 0, limit: 0, list: [] };
  let list = [];
  try {
    // 搜索接口实测（2026-11-15）：
    //   站点搜索表单 action="/nimasile"、参数 name="q"
    //   → /nimasile?q=关键词 精确返回结果卡片（干净、无首页噪音）
    //   对比：WordPress 原生 /?s= 返回「未找到页面」；
    //         /?keyword= 虽能出结果但混着整个首页（48 条噪音），不能用。
    //   分页：/nimasile/page/{n}?q=关键词
    const path = page > 1
      ? `/nimasile/page/${page}?q=${encodeURIComponent(wd)}`
      : `/nimasile?q=${encodeURIComponent(wd)}`;
    const { body, host } = await fetchPath(path);
    list = parseList(body, host);
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount: list.length >= 10 ? page + 1 : page, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
