// @name 511短剧
// @author 宝宝巴士
// @description 511短剧（511dj.com）：分类/搜索/详情/播放；剧集取 /watch/details 的 data-ep-src，播放走 /play/{id}/{n}.m3u8 直链；自动从 /dizhi/ 发布页获取备用域名防失联
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/短剧/511短剧.js
// @dependencies []
/**
 * ============================================================================
 * 511短剧（511dj.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-16 实测）】
 *   自建短剧站，服务端渲染 HTML，非 MacCMS。
 *   首页：/                              （首页只有 empty-recs 推荐位，无完整卡片）
 *   分类：/category/{slug}/              （article.dm-card 完整卡片，36 条/页）
 *   分页：/category/{slug}/page/{n}/
 *   搜索：/search/?keyword={关键词}      （真过滤；无结果时展示推荐位）
 *   详情：/series/details/{id}.html      （只有前 2 集 + 元信息）
 *   观看：/watch/details/{id}.html       （★ 完整剧集列表在这里）
 *   地址：/dizhi/                        （官方备用域名发布页，78 个域名）
 *
 * 【列表卡片结构】
 *   <article class="dm-card" data-article-id="{id}">
 *     <a class="dm-card-cover" href="/series/details/{id}.html" aria-label="标题">
 *       <img class="dm-card-img" src="封面" alt="标题">
 *       <span class="dm-card-heat-text">5827热度</span>
 *     <h3 class="dm-card-title"><a href="..." title="标题">标题</a></h3>
 *     <p class="dm-card-sub" title="简介">简介</p>
 *     <div class="dm-card-tags">
 *       <a class="dm-tag" href="/tag/xx/">标签</a>
 *       <span class="dm-tag dm-ep-badge is-updating">更新至64集</span>
 *
 * 【剧集 / 播放（关键）】
 *   详情页只渲染前 2 集（a.dm-ep），完整剧集在观看页：
 *     <button class="dm-watch-ep" data-ep="1" data-ep-src="/play/{id}/1.m3u8"
 *             data-ep-title="第1集" data-ep-free="1" data-pay-price="0">1</button>
 *   data-ep-free=1 免费；=0 且带 dm-ep-coin 为金币付费集。
 *   播放地址：/play/{id}/{n}.m3u8
 *     免费集实测 HTTP 200 + application/vnd.apple.mpegurl，标准 AES-128 HLS
 *     （EXT-X-KEY + enc.key + seg_*.ts，auth_key 带时效签名）。
 *     付费集实测 HTTP 402（无 cookie 时），脚本保留集数但标注「金币」，
 *     由宿主尝试播放，失败即提示需登录/购买。
 *
 * 【搜索坑】
 *   /search/?q=xx          → 不生效，返回「找短剧」默认页（34 个推荐卡片）
 *   /search/?keyword=xx    → ✅ 生效，title 变「搜索xx」，命中 17 个 dm-card
 *   无结果时标题变成「搜索 - 511短剧」并展示 10 个推荐位，
 *   脚本用 title 是否含关键词来判定，避免把推荐位当搜索结果返回。
 *
 * 【防失联 /dizhi/】
 *   发布页 meta[name=description] 的 content 里列出 78 个官方备用域名
 *   （511dj.com / 511dg.com / 511dj.cc / 511dja.* / 51aiduanju.* / ai511dj.* ...）。
 *   脚本首次请求即解析并做可用性校验，只把能返回同构首页的域名并入轮换池，
 *   时间戳与池写入 SDK 持久缓存，默认每 6 小时刷新一次。
 *
 * 【环境变量】
 *   DJ511_HOST          主站地址，默认 https://511dj.com
 *   DJ511_MIRRORS       追加备用域名（逗号分隔）
 *   DJ511_UA            自定义 User-Agent
 *   DJ511_HOSTS_REFRESH 发布页刷新间隔（小时），默认 6；0=每次都刷
 *   DJ511_COOKIE        站点 cookie（付费集可能需要）
 * ============================================================================
 */

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) {
  OmniBox = {
    log() {},
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

const PREFIX = '[511dj]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.DJ511_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE = String(process.env.DJ511_COOKIE || '').trim();
const PRIMARY = (process.env.DJ511_HOST || 'https://511dj.com').replace(/\/+$/, '');
const ADDR_PAGE = `${PRIMARY}/dizhi/`;

/* ---------------- 域名池 ---------------- */
const HOSTS = (() => {
  const extra = String(process.env.DJ511_MIRRORS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, '');
  return Array.from(new Set([PRIMARY, ...extra.map(norm)]));
})();
let PREFERRED = 0;
const hostHealth = Object.create(null);
const COOLDOWN = (() => {
  const raw = String(process.env.DJ511_ROTATE_COOLDOWN || '').trim();
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
  if (/403|拦截|blocked|地区/i.test(String(reason || ''))) h.blockAt = Date.now();
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
    }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {});
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
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: decompress(raw, res.headers['content-encoding']).toString('utf-8'),
          finalUrl: u.href,
        });
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
        headers: Object.assign({
          'User-Agent': UA,
          'Accept-Language': 'zh-CN,zh;q=0.9',
        }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {}),
        timeout: options.timeout || 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return { statusCode: Number(r.statusCode) || 200, body, headers: r.headers || {} };
    }
  } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  return nodeRequest(url, options);
}

/* ---------------- 官方地址发布页 ---------------- */
const HOSTS_REFRESH_INTERVAL = (() => {
  const raw = String(process.env.DJ511_HOSTS_REFRESH || '').trim();
  const h = raw === '' ? 6 : Number(raw);
  return Math.max(0, Number.isFinite(h) ? h : 6) * 3600 * 1000;
})();
const HOSTS_CACHE_KEY = '511dj:hosts:v1';
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
let lastHostsRefresh = 0;
let hostsRefreshInFlight = null;
let hostsCacheRestored = false;

/** 从 /dizhi/ 的 meta description 解析备用域名 */
function parseAddressPage(html) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  const add = (d) => {
    const h = String(d || '').toLowerCase().trim();
    if (!h || seen.has(h)) return;
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h)) return;
    // 排除 CDN / 统计 / 社交 / 组织站
    if (/cloudfront|gitlab|schema\.org|w3\.org|t\.me|x\.com|google|yandex/i.test(h)) return;
    seen.add(h);
    out.push(`https://${h}`);
  };
  const m = s.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (m) {
    const ds = m[1].match(/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi) || [];
    ds.forEach(add);
  }
  // 兜底：正文里的 a[href]
  const linkRe = /<a[^>]*href="(https?:\/\/([^"\/]+))/gi;
  let lm;
  while ((lm = linkRe.exec(s)) !== null) add(lm[2]);
  return out;
}

/** 可用性校验：能返回含 dm-card / series/details 的同构首页才算主站 */
async function probeHost(host) {
  try {
    const r = await httpGet(`${host}/`, { timeout: 12000 });
    const b = String(r.body || '');
    return r.statusCode >= 200 && r.statusCode < 400 && b.length > 5000 && /series\/details\/|dm-card/.test(b);
  } catch (_) { return false; }
}

async function restoreHostsCache() {
  if (hostsCacheRestored) return;
  hostsCacheRestored = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === 'string') { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (obj && Array.isArray(obj.hosts)) {
      for (const h of obj.hosts) {
        if (typeof h === 'string' && /^https?:\/\//i.test(h) && !HOSTS.includes(h)) HOSTS.push(h);
      }
    }
    if (obj && Number(obj.at) > lastHostsRefresh) lastHostsRefresh = Number(obj.at);
    if (lastHostsRefresh) logI(`[hosts] 已从缓存恢复域名池（${HOSTS.length} 个）`);
  } catch (_) {}
}

async function refreshHostsFromAddressPage() {
  let html = '';
  try {
    const r = await httpGet(ADDR_PAGE, { timeout: 15000 });
    html = String(r.body || '');
  } catch (e) {
    logI(`[hosts] 地址页拉取失败: ${e.message}`);
    return 0;
  }
  const candidates = parseAddressPage(html);
  if (!candidates.length) {
    logI('[hosts] 地址页未解析到备用域名');
    return 0;
  }
  logI(`[hosts] 地址页解析到 ${candidates.length} 个候选域名`);
  let added = 0;
  for (const h of candidates) {
    if (HOSTS.includes(h)) continue;
    const ok = await probeHost(h);
    if (!ok) continue;
    HOSTS.push(h);
    hostHealth[h] = { fail: 0, okAt: 0, blockAt: 0 };
    added++;
    logI(`[hosts] 发现可用主站 -> ${h}`);
  }
  if (added) logI(`[hosts] 本次新增 ${added} 个，池共 ${HOSTS.length} 个`);
  return added;
}

async function ensureHostsFresh(force) {
  await restoreHostsCache();
  if (!force && lastHostsRefresh && Date.now() - lastHostsRefresh < HOSTS_REFRESH_INTERVAL) return 0;
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  hostsRefreshInFlight = (async () => {
    try {
      logI(`[hosts] 定时刷新开始（间隔 ${HOSTS_REFRESH_INTERVAL / 3600000}h）`);
      const added = await refreshHostsFromAddressPage();
      lastHostsRefresh = Date.now();
      await OmniBox.setCache(HOSTS_CACHE_KEY, { at: lastHostsRefresh, hosts: HOSTS.slice() }, HOSTS_CACHE_TTL);
      logI(`[hosts] 定时刷新完成，新增 ${added} 个`);
      return added;
    } catch (e) {
      logI(`[hosts] 定时刷新异常: ${e.message}`);
      return 0;
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

/* ---------------- 带轮换的抓取 ---------------- */
async function fetchHtml(urlOrPath, options = {}) {
  const isFull = /^https?:\/\//i.test(urlOrPath);
  const path = isFull ? new URL(urlOrPath).pathname + new URL(urlOrPath).search : urlOrPath;
  const order = buildHostOrder();
  try { ensureHostsFresh(false); } catch (_) {}

  for (const idx of order) {
    const host = HOSTS[idx];
    const url = isFull ? `${host}${path}` : host + urlOrPath;
    try {
      logI(`拉取 ${url}`);
      const r = await httpGet(url, options);
      const body = String(r.body || '');
      if (r.statusCode === 404) return { body: '', host, statusCode: 404 };
      if (r.statusCode === 402) return { body: '', host, statusCode: 402 };
      if (r.statusCode >= 200 && r.statusCode < 400 && body.length >= 200) {
        markHost(host, true);
        PREFERRED = idx;
        return { body, host, statusCode: r.statusCode };
      }
      markHost(host, false, `HTTP ${r.statusCode}`);
    } catch (e) {
      markHost(host, false, e.message);
      logI(`${host} 请求异常: ${e.message}`);
    }
  }

  // 全挂：强制刷新发布页并重试一轮
  if (!globalThis.__dj511ForceAt || Date.now() - globalThis.__dj511ForceAt >= 60000) {
    globalThis.__dj511ForceAt = Date.now();
    logI('所有候选域名不可达，强制刷新地址发布页');
    const added = await ensureHostsFresh(true);
    if (added > 0) {
      for (const h of HOSTS.slice()) {
        try {
          const r = await httpGet(isFull ? `${h}${path}` : h + urlOrPath, options);
          const b = String(r.body || '');
          if (r.statusCode >= 200 && r.statusCode < 400 && b.length >= 200) {
            markHost(h, true);
            PREFERRED = HOSTS.indexOf(h);
            return { body: b, host: h, statusCode: r.statusCode };
          }
        } catch (_) {}
      }
    }
  }
  logE('所有候选域名均不可达');
  return { body: '', host: HOSTS[PREFERRED] || PRIMARY, statusCode: 0 };
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
function fixUrl(u, host) {
  let s = String(u || '').trim()
    .replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
  if (!s) return '';
  // 站点把封面包了一层 /cdn-img/{base64(原始URL)}.jpg 代理，
  // 还原成原始 CDN 地址，避免图片依赖站点代理、换域名后全挂。
  if (/cdn-img\//i.test(s)) {
    const m = s.match(/cdn-img\/([^/?#"']+)/i);
    if (m) {
      let b = m[1].replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
      try {
        const pad = b + '='.repeat((4 - (b.length % 4)) % 4);
        const dec = Buffer.from(pad, 'base64').toString('utf-8');
        if (/^https?:\/\//i.test(dec)) return dec;
      } catch (_) {}
    }
  }
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/') && host) return host + s;
  return s;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: 'yuanchuangshoufa-3k', type_name: '原创首发' },
  { type_id: 'up-zhubo', type_name: '博主专区' },
  { type_id: 'vip-zone', type_name: '会员专区' },
  { type_id: 'mogaijuchang-3k', type_name: '魔改剧场' },
  { type_id: 'fuliduanju-3k', type_name: '福利短剧' },
  { type_id: 'zhenrenjuchang-3k', type_name: '真人剧场' },
  { type_id: 'chuanyue-chongsheng', type_name: '穿越重生' },
  { type_id: 'fanjuzhuanqu-3k', type_name: '番剧专区' },
  { type_id: 'baoliaosudi-3k', type_name: '爆料速递' },
  { type_id: 'quanmou-fuchou', type_name: '权谋复仇' },
  { type_id: 'studio', type_name: '片商精选' },
  { type_id: 'aidongman-3k', type_name: 'AI动漫' },
  { type_id: 'gufeng-qingyuan', type_name: '古风情缘' },
  { type_id: 'guzhuang-gongdou', type_name: '古装宫斗' },
  { type_id: 'xianxia-xuanhuan', type_name: '仙侠玄幻' },
];

/* ---------------- 列表解析 ---------------- */
function parseList(html, host) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  const cardRe = /<article[^>]*class="[^"]*dm-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = cardRe.exec(s)) !== null) {
    const block = m[0];
    // 详情链接
    const hrefM = block.match(/href="([^"]*\/series\/details\/([^"\/]+)\.html)"/i);
    if (!hrefM) continue;
    const id = hrefM[2];
    if (seen.has(id)) continue;
    // 标题
    let title = '';
    const tm = block.match(/<h3[^>]*class="[^"]*dm-card-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<img[^>]*class="[^"]*dm-card-img[^"]*"[^>]*alt="([^"]*)"/i);
    if (tm) title = cleanText(tm[1]);
    if (!title) {
      const am = block.match(/aria-label="([^"]*)"/i);
      if (am) title = cleanText(am[1]);
    }
    if (!title) continue;
    // 封面
    let pic = '';
    const im = block.match(/<img[^>]*class="[^"]*dm-card-img[^"]*"[^>]*src="([^"]+)"/i);
    if (im) pic = fixUrl(im[1], host);
    // 简介
    let desc = '';
    const sm = block.match(/<p[^>]*class="[^"]*dm-card-sub[^"]*"[^>]*title="([^"]*)"/i)
      || block.match(/<p[^>]*class="[^"]*dm-card-sub[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (sm) desc = cleanText(sm[1]);
    // 标签
    const tags = [];
    const tagRe = /<a[^>]*class="[^"]*dm-tag[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let t;
    while ((t = tagRe.exec(block)) !== null) {
      const v = cleanText(t[1]);
      if (v) tags.push(v);
    }
    // 集数 / 热度
    let remarks = '';
    const em = block.match(/<span[^>]*class="[^"]*dm-ep-badge[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (em) remarks = cleanText(em[1]);
    const hm = block.match(/<span[^>]*class="[^"]*dm-card-heat-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (hm) remarks = [remarks, cleanText(hm[1])].filter(Boolean).join(' · ');

    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      vod_content: desc || tags.join(', '),
      vod_tag: 'video',
      vod_url: `${host}/series/details/${id}.html`,
    });
  }
  return list;
}

/** 解析分页总数：/category/{slug}/page/{n}/ */
function parsePageCount(html) {
  const s = String(html || '');
  let max = 1;
  const re = /\/page\/(\d+)\//g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(id) {
  const cacheKey = `511dj:detail:${id}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id) return obj;
    }
  } catch (_) {}

  const host = HOSTS[PREFERRED] || PRIMARY;
  // 元信息从详情页取
  const { body: dHtml } = await fetchHtml(`/series/details/${id}.html`);
  // 剧集从观看页取（详情页只有前 2 集）
  const { body: wHtml } = await fetchHtml(`/watch/details/${id}.html`);

  const src = dHtml || wHtml || '';
  if (!src) return null;

  // 标题
  const tm = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || src.match(/<title[^>]*>([^<]*)<\/title>/i);
  let title = cleanText(tm ? tm[1] : '');
  title = title.replace(/\s*[-–|]\s*.*$/, '').trim();

  // 封面
  let pic = '';
  const og = src.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (og) pic = fixUrl(og[1], host);
  if (!pic) {
    const pm = src.match(/data-video-cover="([^"]+)"/i);
    if (pm) pic = fixUrl(pm[1], host);
  }
  if (!pic) {
    const im = src.match(/<img[^>]*class="[^"]*dm-card-img[^"]*"[^>]*src="([^"]+)"/i);
    if (im) pic = fixUrl(im[1], host);
  }

  // 简介
  let content = '';
  const dm = src.match(/<p[^>]*class="[^"]*dm-watch-info-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    || src.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (dm) content = cleanText(dm[1]);

  // 标签
  const tags = [];
  const tagRe = /<a[^>]*href="\/tag\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let t;
  while ((t = tagRe.exec(src)) !== null) {
    const v = cleanText(t[1]);
    if (v) tags.push(v);
  }

  // ★ 剧集：观看页的 button.dm-watch-ep[data-ep-src]
  const episodes = [];
  const epSeen = new Set();
  const epRe = /<button[^>]*class="[^"]*dm-watch-ep[^"]*"([^>]*)>/gi;
  let em;
  while ((em = epRe.exec(wHtml)) !== null) {
    const attrs = em[1];
    const n = (attrs.match(/data-ep="(\d+)"/i) || [])[1];
    const epSrc = (attrs.match(/data-ep-src="([^"]+)"/i) || [])[1];
    const epTitle = (attrs.match(/data-ep-title="([^"]+)"/i) || [])[1];
    const free = (attrs.match(/data-ep-free="([^"]+)"/i) || [])[1];
    const payMethod = (attrs.match(/data-pay-method="([^"]+)"/i) || [])[1];
    const price = (attrs.match(/data-pay-price="([^"]+)"/i) || [])[1];
    if (!n || epSeen.has(n)) continue;
    epSeen.add(n);
    // 播放地址：相对路径 /play/{id}/{n}.m3u8，交给 play() 拼成完整直链
    const playId = epSrc || `/play/${id}/${n}.m3u8`;
    const locked = free === '0' || /is-locked|coin|vip/i.test(attrs);
    // 付费类型：vip=会员 / coin=金币（price 可能 0，不能用来判断是否免费）
    let flag = '';
    if (locked) {
      if (/vip/i.test(payMethod || attrs)) flag = 'VIP';
      else if (/coin/i.test(payMethod || attrs)) flag = `金币${price && price !== '0' ? `(${price})` : ''}`;
      else flag = '付费';
    }
    episodes.push({
      name: `${epTitle || `第${n}集`}${flag ? ` · ${flag}` : ''}`,
      playId: fixUrl(playId, host),
      _locked: locked,
    });
  }
  // 观看页没有 button 时，退回详情页的 a.dm-ep
  if (!episodes.length && dHtml) {
    const epRe2 = /<a[^>]*class="[^"]*dm-ep[^"]*"[^>]*href="[^"]*\?ep=(\d+)"([^>]*)>/gi;
    while ((em = epRe2.exec(dHtml)) !== null) {
      const n = em[1];
      if (epSeen.has(n)) continue;
      epSeen.add(n);
      const locked = /is-locked|coin/i.test(em[2] || '');
      episodes.push({
        name: `第${n}集${locked ? ' · 金币' : ''}`,
        playId: `${host}/play/${id}/${n}.m3u8`,
        _locked: locked,
      });
    }
  }
  // 再兜底：详情页 video[data-video-src]
  if (!episodes.length) {
    const vm = src.match(/data-video-src="([^"]+\.m3u8[^"]*)"/i);
    if (vm) episodes.push({ name: '第1集', playId: fixUrl(vm[1], host), _locked: false });
  }

  const totalText = (wHtml.match(/<span[^>]*class="[^"]*dm-watch-eps-total[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
  const remarkEp = cleanText(totalText || '') || (episodes.length ? `${episodes.length}集` : '');

  const vod = {
    vod_id: id,
    vod_name: title || `短剧 ${id}`,
    vod_pic: pic,
    vod_remarks: remarkEp,
    vod_content: [content, tags.length ? `标签：${tags.join('、')}` : ''].filter(Boolean).join('\n'),
    type_name: tags[0] || '',
    vod_play_sources: episodes.length ? [{ name: '511短剧', episodes }] : [],
    _id: id,
    _host: host,
  };
  if (episodes.length) {
    vod.vod_play_from = '511短剧';
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join('#');
  }
  try { await OmniBox.setCache(cacheKey, vod, 1800); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 110)} from=${(context && context.from) || 'web'}`);
  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const host = HOSTS[PREFERRED] || PRIMARY;
  let url = fixUrl(rawId, host);
  // 相对路径 /play/... 拼成完整地址
  if (url.startsWith('/')) url = host + url;

  const header = {
    'User-Agent': UA,
    Referer: `${host}/`,
  };

  if (/\.m3u8(\?|$)/i.test(url)) {
    return {
      parse: 0, jx: 0, flag: '511短剧',
      url,
      urls: [{ name: '正片', url }],
      header,
    };
  }
  if (/\.(mp4|ts)(\?|$)/i.test(url)) {
    return {
      parse: 0, jx: 0, flag: '511短剧',
      url,
      urls: [{ name: '正片', url }],
      header,
    };
  }

  // 纯数字集数 → 拼 /play/{id}/{n}.m3u8（需要 id 上下文）
  if (/^\d+$/.test(url) && params && params.vodId) {
    url = `${host}/play/${params.vodId}/${url}.m3u8`;
    return { parse: 0, jx: 0, flag: '511短剧', url, urls: [{ name: '正片', url }], header };
  }

  // 详情 id → 取第一集
  if (/^[a-z0-9-]+$/i.test(url)) {
    try {
      const v = await fetchDetail(url);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) return {
        parse: 0, jx: 0, flag: '511短剧',
        url: first.playId,
        urls: [{ name: '正片', url: first.playId }],
        header,
      };
    } catch (_) {}
  }

  return {
    parse: 1, jx: 0, flag: '511短剧',
    url,
    urls: [{ name: '正片', url }],
    header,
  };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    // 首页只有 empty-recs 推荐位，没有 dm-card；用「原创首发」分类页作为首页列表
    const { body, host } = await fetchHtml('/category/yuanchuangshoufa-3k/');
    list = parseList(body, host);
    if (!list.length) {
      const { body: hb, host: hh } = await fetchHtml('/');
      list = parseList(hb, hh);
    }
    logI(`home 返回 ${list.length} 条`);
  } catch (e) {
    logE(`home 异常: ${e.message}`);
  }
  return { class: cls, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const typeId = (params && (params.categoryId || params.type_id || params.tid)) || 'yuanchuangshoufa-3k';
  const page = Math.max(1, Number((params && params.page) || 1));
  const slug = String(typeId).replace(/^\/+|\/+$/g, '');
  const path = page > 1
    ? `/category/${slug}/page/${page}/`
    : `/category/${slug}/`;
  logI(`category type=${typeId} page=${page}`);
  let list = [];
  let pagecount = 1;
  try {
    const { body, host } = await fetchHtml(path);
    list = parseList(body, host);
    pagecount = parsePageCount(body);
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
  // 支持完整 URL
  let realId = id;
  const um = id.match(/\/series\/details\/([^"\/]+)\.html/i)
    || id.match(/\/watch\/details\/([^"\/]+)\.html/i);
  if (um) realId = um[1];
  try {
    const v = await fetchDetail(realId);
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
    // 站内真实搜索参数是 keyword；q= 不生效。
    // 分页：/search/page/{n}/?keyword=xx
    const path = page > 1
      ? `/search/page/${page}/?keyword=${encodeURIComponent(wd)}`
      : `/search/?keyword=${encodeURIComponent(wd)}`;
    const { body, host } = await fetchHtml(path);
    const tm = body.match(/<title[^>]*>([^<]*)<\/title>/i);
    const t = cleanText(tm ? tm[1] : '');
    // 无结果时标题是「搜索 - 511短剧」并展示推荐位，必须排除
    if (t.includes(wd)) {
      list = parseList(body, host);
    } else {
      logI(`search 无命中（title=${t}），返回空`);
    }
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount: list.length >= 10 ? page + 1 : page, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
