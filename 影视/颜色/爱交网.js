// @name 爱交网
// @author 宝宝巴士
// @description 爱交网(aijiaox.com，发布页 aafd.shsivadqh.com/contact)：首页/分类/搜索/详情/播放；域名池被动发布页更新+软隔离；播放走 POST /videos/{数字ID}/playback 取签名 m3u8；分类名取链接文本(非父分组)，qnlycc.cn 图床(new2 .webp / pic .jpeg)封面 AES 解密内联(JPEG/PNG/WebP)
// @version 1.0.3
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/爱交网.js
// @dependencies axios,cheerio,crypto
/**
 * ============ 爱交网（aijiaox.com）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-18 实测）】
 *   Vue SPA + 服务端渲染， nginx，域名多且经常更换。
 *   当前入口 aafd.shsivadqh.com（可能 RST），发布页 /contact/
 *   发布页给的真实可用域：e576.kajiljnx.cc、aijiaox.com（永久）、
 *     aijiaowang1.pages.dev / aijiaowang1.github.io（永久入口）
 *   部分 IP 被 RST：aafd/aijiaox 解析到 103.49.212.243 会 RST，
 *     43.230.144.239 可用 —— 靠域名池轮换来兜。
 *
 * 【路由】
 *   首页：/                          卡片 72 个 video-card-item
 *   分类：/category/{slug}/          分页 /category/{slug}/{page}/
 *   标签：/tag/{kw}/
 *   详情：/watch/{slug}/             含 data-video_id（数字，播放要用）
 *   搜索：/search/{关键词}/          分页 /search/{关键词}/{page}/
 *   播放：POST /videos/{数字ID}/playback  body={} → {code:200,data:{streams:{main,hevc}}}
 *         streams.main 就是带 auth_key 的 m3u8 直链（无需签名/cookie）
 *
 * 【卡片】
 *   <article class="video-card-item">
 *     <a href="/watch/{slug}/" class="video-card-link">
 *       <img x-image-loader-url="封面" data-fallback-src="封面" alt="标题">
 *       <div class="video-card-time">1:34</div>
 *       <h3 title="标题" class="video-card-title">标题</h3>
 *
 * 【详情】
 *   <div class="dplayer" data-video_id="19354" data-video_title="..."
 *        data-video_type_name="..." data-poster_url="封面" data-playable="1">
 *   元数据还有 <script type="application/ld+json"> VideoObject（name/description/thumbnailUrl）
 */
const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[aijiao]';
const UA = String(process.env.AJ_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 发布页 API： GitLab/GitHub Pages 不用；直接抓当前域的 /contact/ 提取域名 */
const PUBLISH_PATH = '/contact/';
const HOSTS_CACHE_KEY = 'aijiao:hosts:v1';
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
const PROBE_BATCH = 6;
const PROBE_TIMEOUT = Math.max(3000, Number(process.env.AJ_PROBE_TIMEOUT || 8000) || 8000);
const REQ_TIMEOUT = Math.max(5000, Number(process.env.AJ_TIMEOUT || 15000) || 15000);

/** 内置域名（发布页拉不到时兜底）。第一个是发布页当前给的最新可用域。 */
const BUILTIN_HOSTS = String(process.env.AJ_NO_BUILTIN || '') === '1' ? [] : [
  'https://e576.kajiljnx.cc',
  'https://aijiaox.com',
  'https://aijiaowang1.pages.dev',
  'https://aijiaowang1.github.io',
  'https://aafd.shsivadqh.com',
];
const SEED_HOST = String(process.env.AJ_HOST || '').trim();

let HOST_POOL = (() => {
  const extra = String(process.env.AJ_HOSTS || '').split(',')
    .map((x) => normalizeOriginRaw(x)).filter(Boolean);
  const seeds = SEED_HOST ? [normalizeOriginRaw(SEED_HOST)] : [];
  return uniq([...seeds, ...extra, ...BUILTIN_HOSTS]);
})();
let HOST = HOST_POOL[0];
let HOST_POOL_READY = false;
let refreshInFlight = null;
const health = Object.create(null);

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {}
}
function uniq(a) { return Array.from(new Set(a)); }
function normalizeOriginRaw(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { return new URL(s).origin.replace(/\/+$/, ''); }
  catch (_) { return s.replace(/\/+$/, ''); }
}
function isEnvError(msg) {
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|0\.0\.0\.0|socket hang up|timeout|超时/i.test(String(msg || ''));
}

/* ---------------- HTTP ---------------- */
function makeHttp(timeout) {
  return axios.create({
    timeout,
    validateStatus: () => true,
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    // 站点有两个解析 IP，其中一个常被 RST；axios 走系统 DNS，靠域名池轮换兜底
  });
}

async function fetchText(url, options = {}) {
  const client = makeHttp(options.timeout || REQ_TIMEOUT);
  const headers = { Referer: options.referer || `${HOST}/`, ...(options.headers || {}) };
  const res = await client.get(url, { headers, responseType: 'text' });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} @ ${url}`);
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
}

async function fetchJson(url, options = {}) {
  const client = makeHttp(options.timeout || REQ_TIMEOUT);
  const headers = { Referer: options.referer || `${HOST}/`, 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) };
  const method = (options.method || 'get').toLowerCase();
  const res = method === 'post'
    ? await client.post(url, options.body || {}, { headers })
    : await client.get(url, { headers });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} @ ${url}`);
  return typeof res.data === 'object' ? res.data : JSON.parse(res.data || '{}');
}

function absUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  try { return new URL(value, `${HOST}/`).toString(); }
  catch (_) { return value; }
}

/* ---------------- 封面处理 ----------------
 * pic.qnlycc.cn 返回 AES-128-CBC 密文（binary/octet-stream），需解密内联；
 * new2.qnlycc.cn 等明文图床直接返回 URL。
 */
const COVER_AES_KEY = Buffer.from('f5d965df75336270', 'latin1');
const COVER_AES_IV = Buffer.from('97b60394abc2fbe1', 'latin1');
const COVER_INLINE = process.env.AJ_COVER_INLINE !== '0';
const coverCache = new Map();
function decryptAesImage(buf) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', COVER_AES_KEY, COVER_AES_IV);
    const out = Buffer.concat([d.update(buf), d.final()]);
    if (out.length > 100 && out[0] === 0xff && out[1] === 0xd8) return `data:image/jpeg;base64,${out.toString('base64')}`;
    if (out.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return `data:image/png;base64,${out.toString('base64')}`;
    // WebP：RIFF....WEBP
    if (out.slice(0, 4).toString() === 'RIFF' && out.slice(8, 12).toString() === 'WEBP') return `data:image/webp;base64,${out.toString('base64')}`;
  } catch (_) {}
  return '';
}
function isEncryptedCover(url) {
  // new2.qnlycc.cn 的 .webp 与 pic.qnlycc.cn 的 .jpeg 都是 AES 密文
  return /qnlycc\.cn/i.test(String(url || ''));
}
async function resolveCover(url) {
  const u = absUrl(url);
  if (!u || !COVER_INLINE || !/^https?:/i.test(u)) return u;
  if (!isEncryptedCover(u)) return u; // 明文图床直连
  if (coverCache.has(u)) return coverCache.get(u);
  try {
    const client = makeHttp(8000);
    const res = await client.get(u, {
      headers: { 'User-Agent': UA, Referer: `${HOST}/` },
      responseType: 'arraybuffer',
    });
    if (res.status === 200 && res.data) {
      const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
      // 已是可直接显示的图片则直连
      const plain = (buf[0] === 0xff && buf[1] === 0xd8)
        || (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a')
        || (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
      if (plain) { coverCache.set(u, u); return u; }
      const inline = decryptAesImage(buf);
      if (inline) { coverCache.set(u, inline); return inline; }
    }
  } catch (_) {}
  coverCache.set(u, u);
  return u;
}
async function fillCovers(list) {
  if (!COVER_INLINE || !Array.isArray(list)) return list;
  let idx = 0;
  const workers = Array.from({ length: Math.min(4, list.length) }, async () => {
    while (idx < list.length) {
      const i = idx++;
      list[i].vod_pic = await resolveCover(list[i].vod_pic);
    }
  });
  await Promise.all(workers);
  return list;
}
function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}
function dedupeBy(list, keyFn) {
  const seen = new Set(); const out = [];
  for (const item of list || []) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(item);
  }
  return out;
}

/* ---------------- 域名池 ---------------- */
async function restoreHostCache() {
  if (HOST_POOL_READY) return;
  HOST_POOL_READY = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === 'string') { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (!obj || typeof obj !== 'object') return;
    const dead = new Set((Array.isArray(obj.dead) ? obj.dead : []).map(normalizeOriginRaw));
    const merged = [];
    const push = (h) => { const o = normalizeOriginRaw(h); if (o && !merged.includes(o)) merged.push(o); };
    if (typeof obj.active === 'string') push(obj.active);
    (Array.isArray(obj.hosts) ? obj.hosts : []).forEach(push);
    merged.sort((a, b) => (dead.has(a) ? 1 : 0) - (dead.has(b) ? 1 : 0));
    HOST_POOL = uniq([...HOST_POOL, ...merged.filter((h) => !HOST_POOL.includes(h))]);
    if (typeof obj.active === 'string') {
      const a = normalizeOriginRaw(obj.active);
      const idx = HOST_POOL.indexOf(a);
      if (idx > 0) { HOST_POOL.splice(idx, 1); HOST_POOL.unshift(a); }
      HOST = HOST_POOL[0];
    }
    log('info', `恢复域名池 ${HOST_POOL.length} 个，当前=${HOST}`);
  } catch (_) {}
}

function schedulePersist() {
  Promise.resolve(OmniBox.setCache(HOSTS_CACHE_KEY, {
    at: Date.now(), active: HOST, hosts: HOST_POOL.slice(),
    dead: Object.keys(health).filter((h) => health[h] && health[h].dead),
  }, HOSTS_CACHE_TTL)).catch(() => {});
}

function markAlive(host) {
  if (!host) return;
  health[host] = { fail: 0, dead: false, okAt: Date.now() };
  if (HOST !== host) { log('info', `切换到域名 ${host}`); HOST = host; }
  const idx = HOST_POOL.indexOf(host);
  if (idx > 0) { HOST_POOL.splice(idx, 1); HOST_POOL.unshift(host); }
  schedulePersist();
}
function markDead(host, reason) {
  if (!host) return;
  const msg = String(reason || '');
  const h = health[host] || (health[host] = { fail: 0 });
  if (isEnvError(msg)) { h.envFail = (h.envFail || 0) + 1; return; }
  h.fail = (h.fail || 0) + 1;
  if (h.fail >= 2 && !h.dead) {
    h.dead = true; h.deadAt = Date.now();
    const idx = HOST_POOL.indexOf(host);
    if (idx >= 0 && HOST_POOL.length > 1) { HOST_POOL.splice(idx, 1); HOST_POOL.push(host); }
    if (HOST === host) {
      const next = HOST_POOL.find((x) => !(health[x] && health[x].dead));
      if (next) HOST = next;
    }
    log('info', `${host} 连续失败 ${h.fail} 次，隔离到池尾`);
    schedulePersist();
  }
}

function extractPublishHosts(text) {
  const s = String(text || '');
  const found = new Set();
  // 只取发布页「最新地址/永久入口/永久地址」区里的 a 标签 href
  const re = /href="(https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}))"/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const host = m[2].toLowerCase();
    if (/googletagmanager|google|schema\.org|t\.me|twitter|github\.io/.test(host)) {
      // pages.dev / github.io 是永久入口，保留 github.io；其余第三方跳过
      if (!/aijiaowang/i.test(host)) continue;
    }
    found.add(`https://${host}`);
  }
  return Array.from(found);
}

async function probeHost(origin) {
  try {
    const html = await fetchText(`${origin}${PUBLISH_PATH}`, { timeout: PROBE_TIMEOUT, referer: `${origin}/` });
    if (html.includes('爱交') || html.includes('aijiaox') || html.includes('latest')) return origin;
  } catch (_) {}
  return '';
}

async function discoverHosts() {
  let candidates = [];
  for (const base of HOST_POOL.slice(0, 3)) {
    try {
      const html = await fetchText(`${base}${PUBLISH_PATH}`, { timeout: REQ_TIMEOUT });
      if (html.includes('爱交')) {
        candidates = extractPublishHosts(html);
        log('info', `发布页 ${base} 解析到 ${candidates.length} 个域名`);
        break;
      }
    } catch (e) { log('info', `发布页 ${base} 失败: ${e.message.slice(0, 60)}`); }
  }
  const newOnes = candidates.filter((h) => !HOST_POOL.includes(h));
  if (!newOnes.length) return 0;
  let added = 0;
  for (let i = 0; i < newOnes.length; i += PROBE_BATCH) {
    const batch = newOnes.slice(i, i + PROBE_BATCH);
    const res = await Promise.allSettled(batch.map(probeHost));
    for (let k = 0; k < batch.length; k++) {
      if (res[k].status === 'fulfilled' && res[k].value) {
        HOST_POOL.push(batch[k]);
        health[batch[k]] = { fail: 0, dead: false };
        added++;
        log('info', `发现可用域名 ${batch[k]}`);
      }
    }
  }
  if (added) schedulePersist();
  return added;
}

async function ensureHosts(force) {
  await restoreHostCache();
  if (!force || refreshInFlight) return refreshInFlight || 0;
  refreshInFlight = (async () => {
    try { log('info', '域名池全部失败，拉取发布页'); return await discoverHosts(); }
    catch (e) { log('error', `发布页更新异常 ${e.message}`); return 0; }
    finally { refreshInFlight = null; }
  })();
  return refreshInFlight;
}

/** 统一请求：轮换域名，全部失败才更新发布页后再试一轮 */
async function requestHtml(path, options = {}) {
  await restoreHostCache();
  const tryRound = async (hosts) => {
    let lastErr = null;
    for (const host of hosts) {
      try {
        const html = await fetchText(`${host}${path}`, { ...options, referer: `${host}/` });
        if (html && html.length >= 200) { markAlive(host); return html; }
        lastErr = new Error(`空响应(${html.length}B)`);
        markDead(host, lastErr.message);
      } catch (e) {
        lastErr = e;
        log('info', `${host}${path} 失败: ${e.message.slice(0, 80)}`);
        markDead(host, e.message);
      }
    }
    throw lastErr || new Error('请求失败');
  };
  const order = () => {
    const rest = HOST_POOL.filter((h) => h !== HOST);
    const alive = rest.filter((h) => !(health[h] && health[h].dead));
    const dead = rest.filter((h) => health[h] && health[h].dead);
    return [HOST, ...alive, ...dead];
  };
  try { return await tryRound(order()); }
  catch (first) {
    await ensureHosts(true);
    try { return await tryRound(order()); }
    catch (_) { throw first; }
  }
}

/* ---------------- 列表解析 ---------------- */
function parseCards(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const list = [];
  $('article.video-card-item').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a.video-card-link').first().attr('href') || '';
    const slug = (href.match(/\/watch\/([A-Za-z0-9_-]+)\//) || [])[1] || '';
    if (!slug) return;
    // 优先取真正的封面 img（排除 alt 含「横幅」或 hc237 占位图）
    let img = $el.find('img').first();
    $el.find('img').each((_, im) => {
      const alt = String($(im).attr('alt') || '');
      const src = String($(im).attr('x-image-loader-url') || '');
      if (/横幅|banner|loading/i.test(alt) || /hc237|loading\.gif/i.test(src)) return;
      img = $(im);
      return false;
    });
    const pic = img.attr('x-image-loader-url') || img.attr('data-fallback-src') || img.attr('data-original') || img.attr('src') || '';
    const title = stripHtml($el.find('h3.video-card-title').first().attr('title') || img.attr('alt') || $el.find('h3.video-card-title').first().text());
    const remarks = stripHtml($el.find('.video-card-time').first().text());
    if (!title) return;
    list.push({ vod_id: slug, vod_name: title, vod_pic: absUrl(pic), vod_remarks: remarks });
  });
  return dedupeBy(list, (x) => x.vod_id);
}

function parseCategories(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const seen = new Set();
  const out = [];
  $('a[href*="/category/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const m = href.match(/\/category\/([a-z0-9-]+)\//i);
    if (!m) return;
    const slug = m[1];
    // data-navigation_name 是父分组（全是「热门」），真实分类名在链接文本里
    let name = stripHtml($a.text() || '');
    const navName = stripHtml($a.attr('data-navigation_name') || '');
    if (!name || /^(热门|最新|推荐|精选)$/.test(name) || /^[a-z0-9-]+$/i.test(name)) {
      name = navName && !/^(热门|最新|推荐|精选)$/.test(navName) ? navName : '';
    }
    if (!name || seen.has(slug)) return;
    if (/^\d+$/.test(slug)) return;
    seen.add(slug);
    out.push({ type_id: slug, type_name: name });
  });
  return out.slice(0, 60);
}

/** 末页：向后探一页，无卡片则是末页 */
async function estimatePageCount(slug, page, html, count) {
  const m = [...String(html || '').matchAll(new RegExp(`/category/${slug}/(\\d+)/`, 'gi'))].map((x) => Number(x[1]));
  let maxPage = m.length ? Math.max(...m) : page;
  if (!count) return Math.max(page, maxPage);
  if (maxPage > page) return maxPage;
  try {
    const next = await requestHtml(`/category/${slug}/${page + 1}/`);
    if (parseCards(next).length) return page + 1;
  } catch (_) {}
  return page;
}

/* ---------------- 五方法 ---------------- */
async function home() {
  try {
    const html = await requestHtml('/');
    const classList = parseCategories(html);
    const list = await fillCovers(parseCards(html).slice(0, 60));
    log('info', `home class=${classList.length} list=${list.length}`);
    return { class: classList, list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: [], list: [] };
  }
}

async function category(params) {
  const p = params || {};
  const slug = String(p.categoryId || p.type_id || p.tid || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!slug) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const path = page > 1 ? `/category/${slug}/${page}/` : `/category/${slug}/`;
    const html = await requestHtml(path);
    const list = await fillCovers(parseCards(html));
    const pagecount = await estimatePageCount(slug, page, html, list.length);
    log('info', `category ${slug} page=${page} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    log('error', `category ${slug} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = p.videoId || p.vod_id || p.id || '';
  const slug = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!slug) return { list: [] };
  try {
    // 支持传入完整 URL
    const finalSlug = (slug.match(/\/watch\/([A-Za-z0-9_-]+)\//) || [])[1] || slug;
    const html = await requestHtml(`/watch/${finalSlug}/`);
    const $ = cheerio.load(html, { decodeEntities: false });

    let videoId = $elAttr($, '.dplayer', 'data-video_id');
    if (!videoId) {
      const lm = html.match(/"contentId"\s*:\s*"?(\d+)/) || html.match(/data-video_id="(\d+)"/);
      videoId = lm ? lm[1] : '';
    }
    let vodName = stripHtml($elAttr($, '.dplayer', 'data-video_title'))
      || stripHtml($('.video-card-title').first().text())
      || stripHtml($('h1').first().text());
    vodName = vodName.replace(/[\s'\"`]+$/, '').trim();
    let pic = $elAttr($, '.dplayer', 'data-poster_url') || absUrl($('img').first().attr('x-image-loader-url') || '');
    let content = stripHtml($('.description').first().text()) || stripHtml($('meta[name="description"]').attr('content') || '');
    const typeName = stripHtml($elAttr($, '.dplayer', 'data-video_type_name'));
    const actor = stripHtml($elAttr($, '.dplayer', 'data-video_tag_name'));

    // ld+json 补元信息
    try {
      $('script[type="application/ld+json"]').each((_, el) => {
        const o = JSON.parse($(el).html() || '{}');
        if (o && o['@type'] === 'VideoObject') {
          if (!vodName && o.name) vodName = stripHtml(o.name);
          if (!content && o.description) content = stripHtml(o.description);
          if (o.thumbnailUrl && (!pic || pic.startsWith('http') === false)) pic = absUrl(o.thumbnailUrl);
        }
      });
    } catch (_) {}

    // 本站为单片站：详情页里的 .video-card-item 全是「相关推荐」，不是分集。
    // 真正的分集容器若存在（data-episode / .episode-item）才解析，否则只有正片一条。
    const sources = [];
    const episodes = [];
    $('.episode-item a[href*="/watch/"], .episode-link[href*="/watch/"], a[data-episode][href*="/watch/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/\/watch\/([A-Za-z0-9_-]+)\//);
      if (!m) return;
      const name = stripHtml($(a).attr('title') || $(a).text()) || `第${episodes.length + 1}集`;
      episodes.push({ name, playId: m[1] });
    });
    if (episodes.length) {
      sources.push({ name: '选集', episodes: dedupeBy(episodes, (e) => e.playId) });
    }
    if (videoId) {
      sources.push({ name: '正片', episodes: [{ name: vodName || '正片', playId: `${finalSlug}@${videoId}` }] });
    }
    const playFrom = sources.map((s) => s.name).join('$$$');
    const playUrl = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');

    log('info', `detail ${finalSlug} videoId=${videoId} title=${vodName} sources=${sources.length}`);
    return {
      list: [{
        vod_id: finalSlug, vod_name: vodName, vod_pic: await resolveCover(pic), type_name: typeName,
        vod_actor: actor, vod_content: content, vod_remarks: '',
        vod_play_from: playFrom, vod_play_url: playUrl, vod_play_sources: sources,
        vod_video_id: videoId,
      }],
    };
  } catch (e) {
    log('error', `detail ${slug} ${e.message}`);
    return { list: [] };
  }
}

function $elAttr($, sel, attr) {
  try { return String($(sel).first().attr(attr) || ''); } catch (_) { return ''; }
}

async function search(params) {
  const p = params || {};
  const kw = String(p.keyword || p.wd || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!kw) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const path = page > 1 ? `/search/${encodeURIComponent(kw)}/${page}/` : `/search/${encodeURIComponent(kw)}/`;
    const html = await requestHtml(path);
    const list = await fillCovers(parseCards(html));
    // 搜索页有分页时向后探一页
    let pagecount = page;
    if (list.length) {
      try {
        const np = page > 1 ? `/search/${encodeURIComponent(kw)}/${page + 1}/` : `/search/${encodeURIComponent(kw)}/2/`;
        if (parseCards(await requestHtml(np)).length) pagecount = page + 1;
      } catch (_) {}
    }
    log('info', `search ${kw} page=${page} list=${list.length}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    log('error', `search ${kw} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function play(params) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  let playId = String(p.playId || p.url || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };

  try {
    // playId 形如 slug@数字ID 或纯 slug（去详情取数字ID）
    let videoId = '';
    let slug = '';
    const at = playId.match(/^([A-Za-z0-9_-]+)@(\d+)$/);
    if (at) { slug = at[1]; videoId = at[2]; }
    else if (/^\d+$/.test(playId)) videoId = playId;
    else {
      const wm = playId.match(/\/watch\/([A-Za-z0-9_-]+)\//);
      slug = wm ? wm[1] : playId;
      const html = await requestHtml(`/watch/${slug}/`);
      videoId = (html.match(/data-video_id="(\d+)"/) || [])[1] || '';
    }
    if (!videoId) throw new Error('未取到数字 videoId');

    // 跨域轮换 POST playback
    let data = null;
    for (const host of HOST_POOL.slice(0, 4)) {
      try {
        const json = await fetchJson(`${host}/videos/${videoId}/playback`, {
          method: 'post', body: {}, timeout: REQ_TIMEOUT, referer: `${host}/watch/${slug || videoId}/`,
        });
        if (json && json.code === 200 && json.data && json.data.streams) { data = json.data; markAlive(host); break; }
      } catch (e) { log('info', `playback ${host} 失败: ${e.message.slice(0, 60)}`); }
    }
    if (!data || !data.streams) throw new Error('playback 未返回流');
    const url = data.streams.main || data.streams.hevc || '';
    if (!url) throw new Error('playback 流为空');
    log('info', `play videoId=${videoId} m3u8=${url.slice(0, 140)}`);
    const header = {
      'User-Agent': UA,
      'Referer': `${HOST}/`,
      'x-cdn-auth': '4aae16c3b20ec822f87518504478bb35',
      'x-cdn-app': '109',
    };
    return { urls: [{ name: '默认线路', url }], flag: 'default', header, parse: 0, danmaku: '' };
  } catch (e) {
    log('error', `play ${playId} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
