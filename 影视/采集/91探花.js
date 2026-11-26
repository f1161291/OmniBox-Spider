// @name 91探花
// @author OmniBox
// @description 91探花（911tanhua.com）：JSON-LD 结构化数据取列表（分类/最新/热门/搜索），详情页 data-video_id + POST /videos/{id}/playback 取 m3u8 直链（parse=0）。多分类、分页、异步播放解析。
// @version 1.0.3
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/91探花.js
// @dependencies axios, crypto
// TANHUA_COVER_INLINE 封面内联开关，默认 1（抓图转 data URI 兼容 OK影视；设 0 关闭回退原 URL）
/**
 * ============ 91探花（911tanhua.com）OmniBox 采集源 ============
 * 【站点事实（2026-11-26 实测）】
 *  - 分类 /category/{slug}/，分页 /category/{slug}/{page}/，最新 /sort/renew/，热门 /sort/hot/，
 *    搜索 /search/{关键词}/，详情 /watch/{hash}/。
 *  - 列表页内嵌 JSON-LD（<script type="application/ld+json">），结构：
 *    { mainEntity: { itemListElement: [ { item: { @id, name, description,
 *      thumbnailUrl, uploadDate, duration, keywords, ... } } ], numberOfItems } }
 *    每页 24 条，字段干净，优先于 HTML 正则。
 *  - 详情页 <video> 周边 data-video_* 属性：data-video_id（数字ID）、data-video_title、
 *    data-video_type_name、data-video_content_type、data-video_allowed_origins。
 *  - 播放：POST https://911tanhua.com/videos/{data-video_id}/playback，空 body {}，
 *    header Content-Type: application/json、X-Requested-With: XMLHttpRequest、Referer 详情页；
 *    返回 { code:200, data:{ streams:{ main:m3u8, hevc, preview } } }，
 *    main 是带 auth_key 的 m3u8 直链，裸请求可播（AES-128 由播放器处理）。
 *
 * 环境变量：
 *  TANHUA_HOST     站点基址，默认 https://911tanhua.com
 *  TANHUA_UA       自定义 UA
 *  TANHUA_TIMEOUT  单请求超时毫秒，默认 15000
 *  TANHUA_CACHE_TTL 缓存秒数，默认 300
 */
const axios = require('axios');
const crypto = require('crypto');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[91探花]';
// 封面链路（与 51吃瓜/黑料网 同源图床）：
//   JSON-LD 的 thumbnailUrl 是 expose.eisees.com + 短期 auth 签名（OK影视 对带查询串的图显示标题首字）。
//   同图在 new2.qnlycc.cn 有 <原路径>.webp 版本，无签名但 AES-128-CBC 加密。
//   处理：expose URL -> new2 URL -> 抓图 -> AES 解密 -> data:image base64 内联（OK影视/UZN 都能显示）。
// 抓图/解密失败回退原 URL（不阻塞主链路）。可用 TANHUA_COVER_INLINE=0 关闭。
const COVER_INLINE = process.env.TANHUA_COVER_INLINE !== '0';
const COVER_CONCURRENCY = 4;
const COVER_AES_KEY = Buffer.from(String(process.env.TANHUA_COVER_KEY || 'f5d965df75336270'), 'latin1');
const COVER_AES_IV = Buffer.from(String(process.env.TANHUA_COVER_IV || '97b60394abc2fbe1'), 'latin1');
const NEW2_HOST = String(process.env.TANHUA_COVER_HOST || 'https://new2.qnlycc.cn').replace(/\/+$/, '');
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
// expose 图片 -> new2 稳定图（路径一致，去掉 auth 查询串）。
// 路径可能是 /upload_01/...（列表）或 /upload/xiao/...（详情），统一取 expose 域名后的 path。
// 注意：不要加 .webp —— new2 的 .webp 是压缩版（约 19.9KB），原图 JPEG 约 29.6KB，画质明显更好，
// 两者同为 320x180；用原图可避免封面发糊/发虚。若原图 404 再回退 .webp。
function exposeToNew2(url) {
  const m = String(url || '').match(/expose\.eisees\.com(\/[^?]+)/i);
  if (!m) return '';
  const p = m[1].replace(/\/+$/, '');
  return NEW2_HOST + p;
}
// 备选：原图不可用时尝试的压缩版（体积更小、画质略差）
function exposeToNew2Webp(url) {
  const base = exposeToNew2(url);
  if (!base || /\.webp$/i.test(base)) return '';
  return base + '.webp';
}
// AES 解密加密图，返回 {mime, body} 或 null
function decryptCoverBytes(buf) {
  const plain = sniffImageType(buf);
  if (plain) return { mime: plain, body: buf };
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', COVER_AES_KEY, COVER_AES_IV);
    const out = Buffer.concat([d.update(buf), d.final()]);
    const mime = sniffImageType(out);
    if (mime) return { mime, body: out };
  } catch (_) {}
  return null;
}
const UA = String(process.env.TANHUA_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = String(process.env.TANHUA_HOST || 'https://911tanhua.com').replace(/\/+$/, '');
const TIMEOUT = Math.max(5000, Number(process.env.TANHUA_TIMEOUT || 15000) || 15000);
const CACHE_TTL = Math.max(0, Number(process.env.TANHUA_CACHE_TTL || 300) || 300);

function log(level, msg) { try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {} }
function text(v) { return v == null ? '' : String(v).trim(); }
function absUrl(u) { try { return new URL(String(u || '').trim(), BASE).href; } catch (_) { return ''; } }
function decodeEntities(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function clean(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

function requestHeaders(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': referer || BASE + '/',
  };
}
async function fetchHtml(path) {
  const res = await axios.get(BASE + path, { timeout: TIMEOUT, validateStatus: () => true, headers: requestHeaders() });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

// 官网二级分类（slug 与官网一致）
const CATEGORIES = [
  ['探花视频', 'tanhua-shipin'], ['星吧探花', 'xingba-tanhua'], ['顶媒探花', 'dingmei-tanhua'],
  ['会所按摩', 'huisuo-anmo'], ['磨特丝派', 'mote-sipai'], ['直播录屏', 'zhibo-luping'],
  ['重口激情', 'zhongkou-jiqing'], ['SM调教', 'sm-tiaojiao'], ['街头大善', 'jietou-dashan'],
  ['街头抄底', 'jietou-chaodi'], ['酒店摄像头', 'jiudian-shexiangtou'], ['制服诱惑', 'zhifu-youhuo'],
];
const SORTS = [['最新', 'renew'], ['热门', 'hot']];
const TOP_CLASSES = [
  { type_id: 'sort:renew', type_name: '最新' },
  { type_id: 'sort:hot', type_name: '热门' },
  ...CATEGORIES.map(([name, slug]) => ({ type_id: `cat:${slug}`, type_name: name })),
];

// 进程内缓存
const mem = new Map();
function memGet(k, ttl) { const v = mem.get(k); if (v && Date.now() - v.t < ttl) return v.d; return null; }
function memSet(k, d) { mem.set(k, { t: Date.now(), d }); }
async function cacheGet(k) { try { const v = await OmniBox.getCache(`${PREFIX}:${k}`); return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } }
async function cacheSet(k, d, ttl) { try { await OmniBox.setCache(`${PREFIX}:${k}`, JSON.stringify(d), ttl); } catch (_) {} }

// 封面内联：expose(auth签名) -> new2(稳定AES加密) -> 抓图 -> 解密 -> data URI
const coverCache = new Map();
async function resolveCover(url) {
  if (!url || !COVER_INLINE || !/^https?:/i.test(url)) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  // 优先原图（画质最好），失败再退压缩 webp，最后才回退原 URL
  const candidates = [];
  const primary = exposeToNew2(url);
  if (primary) {
    candidates.push(primary);
    const webp = exposeToNew2Webp(url);
    if (webp && webp !== primary) candidates.push(webp);
  }
  candidates.push(url);
  for (const fetchUrl of candidates) {
    try {
      const res = await axios.get(fetchUrl, {
        timeout: 8000, responseType: 'arraybuffer', validateStatus: () => true,
        headers: { 'User-Agent': UA, Referer: BASE + '/' },
      });
      let buf = res.data;
      if (res.status !== 200 || !buf) continue;
      if (!Buffer.isBuffer(buf)) {
        if (buf.buffer && typeof buf.byteLength === 'number') buf = Buffer.from(buf.buffer, buf.byteOffset || 0, buf.byteLength);
        else if (Array.isArray(buf)) buf = Buffer.from(buf);
        else buf = Buffer.from(String(buf));
      }
      const decoded = decryptCoverBytes(buf);
      if (decoded && decoded.body.length > 100) {
        const dataUri = `data:${decoded.mime};base64,${decoded.body.toString('base64')}`;
        coverCache.set(url, dataUri);
        log('info', `[cover] 命中 ${decoded.mime} ${decoded.body.length}B <- ${fetchUrl.slice(0, 80)}`);
        return dataUri;
      }
    } catch (_) { /* 试下一个候选 */ }
  }
  coverCache.set(url, url);
  return url;
}
async function resolveCovers(list) {
  if (!COVER_INLINE || !Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      const item = list[i];
      if (item && item.vod_pic) { try { item.vod_pic = await resolveCover(item.vod_pic); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, list.length) }, () => worker()));
  return list;
}

// 从页面 JSON-LD 提取 VideoObject 列表
function parseJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1]); } catch (_) { continue; }
    const candidates = [];
    if (data && data.mainEntity && Array.isArray(data.mainEntity.itemListElement)) candidates.push(...data.mainEntity.itemListElement);
    if (data && Array.isArray(data.itemListElement)) candidates.push(...data.itemListElement);
    for (const entry of candidates) {
      const it = entry && entry.item ? entry.item : entry;
      if (!it || !it.url || !it.name) continue;
      const id = (String(it.url).match(/\/watch\/([^/]+)\//) || [])[1];
      if (!id) continue;
      out.push({
        vod_id: id,
        vod_name: text(it.name),
        vod_pic: text(it.thumbnailUrl),
        vod_remarks: text(it.duration || it.uploadDate || ''),
        vod_content: clean(it.description || ''),
        vod_year: String(it.uploadDate || '').slice(0, 4),
        type_name: '',
      });
    }
    if (out.length) break;
  }
  return out;
}
// HTML 兜底解析（JSON-LD 缺失时）
function parseHtmlFallback(html) {
  const out = [];
  const seen = new Set();
  const re = /href=["']\/watch\/([a-z0-9]+)\/["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const name = clean((m[2].match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1] || m[2]);
    if (!name || name.length < 2) continue;
    const pic = (m[2].match(/(?:data-original|data-src|src)=["']([^"']+)["']/i) || [])[1] || '';
    seen.add(id);
    out.push({ vod_id: id, vod_name: name, vod_pic: absUrl(pic), vod_remarks: '', vod_content: '' });
  }
  return out;
}
async function loadList(path) {
  const html = await fetchHtml(path);
  let list = parseJsonLd(html);
  if (!list.length) list = parseHtmlFallback(html);
  // 去重
  const seen = new Set();
  list = list.filter(x => { if (seen.has(x.vod_id)) return false; seen.add(x.vod_id); return true; });
  return list;
}

// ============ 五方法 ============
async function home(params, context) {
  log('info', `home 入口 from=${(context && context.from) || 'web'}`);
  try {
    let list = memGet('home:list', 5 * 60 * 1000);
    if (!list) { const c = await cacheGet('home'); if (c && c.length) list = c; }
    if (!list) {
      list = await loadList('/sort/renew/');
      if (list.length) { memSet('home:list', list); await cacheSet('home', list, CACHE_TTL); }
    }
    await resolveCovers(list);
    log('info', `home 返回 class=${TOP_CLASSES.length} list=${list.length}`);
    return { class: TOP_CLASSES, list, filters: {} };
  } catch (e) { log('error', `home 失败: ${e.message}`); return { class: [], list: [] }; }
}

async function category(params, context) {
  const id = String((params && (params.categoryId ?? params.t ?? params.id ?? params.type_id)) || '');
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `category 入口 id=${id} page=${page}`);
  if (!id) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    let path;
    if (id.startsWith('sort:')) path = `/sort/${id.slice(5)}/`;
    else if (id.startsWith('cat:')) { const slug = id.slice(4); path = page <= 1 ? `/category/${slug}/` : `/category/${slug}/${page}/`; }
    else path = page <= 1 ? `/category/${id}/` : `/category/${id}/${page}/`;
    const list = await loadList(path);
    await resolveCovers(list);
    log('info', `category 返回 id=${id} page=${page} list=${list.length}`);
    return { page, pagecount: list.length >= 24 ? page + 1 : page, total: page * 24 + (list.length >= 24 ? 1 : 0), list };
  } catch (e) { log('error', `category 失败: ${e.message}`); return { page, pagecount: 0, total: 0, list: [] }; }
}

async function search(params, context) {
  const kw = String((params && (params.keyword ?? params.kw ?? params.wd ?? params.search)) || '').trim();
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `search 入口 kw=${kw}`);
  if (!kw) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const path = page <= 1 ? `/search/${encodeURIComponent(kw)}/` : `/search/${encodeURIComponent(kw)}/${page}/`;
    const list = await loadList(path);
    await resolveCovers(list);
    log('info', `search 返回 kw=${kw} list=${list.length}`);
    return { page, pagecount: list.length >= 24 ? page + 1 : page, total: page * 24 + (list.length >= 24 ? 1 : 0), list };
  } catch (e) { log('error', `search 失败: ${e.message}`); return { page: 1, pagecount: 0, total: 0, list: [] }; }
}

// 从详情页 JSON-LD 取 VideoObject 详情（含 embedUrl/uploadDate/duration）
function parseDetailJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let d;
    try { d = JSON.parse(m[1]); } catch (_) { continue; }
    const stack = [d];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (o['@type'] === 'VideoObject' && o.url) return o;
      for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}
async function detail(params, context) {
  const vid = String((params && (params.videoId ?? params.id)) || '').trim();
  log('info', `detail 入口 vid=${vid}`);
  if (!vid) return { list: [] };
  try {
    const html = await fetchHtml(`/watch/${vid}/`);
    const ld = parseDetailJsonLd(html);
    const attr = (name) => (html.match(new RegExp(`data-video_${name}="([^"]*)"`, 'i')) || [])[1] || '';
    const videoId = text(attr('id')) || vid;
    const title = text(ld && ld.name) || text(attr('title')) || '';
    const pic = text(ld && ld.thumbnailUrl)
      || (html.match(/<video[^>]*poster="([^"]+)"/i) || [])[1] || '';
    const desc = clean((ld && ld.description) || '');
    const typeName = text(attr('type_name'));
    // playId 透传：videoId（数字）|标题（用于播放记录/日志）
    const playId = `${videoId}|${title}`;
    let finalPic = pic;
    if (pic) { try { finalPic = await resolveCover(pic); } catch (_) {} }
    const item = {
      vod_id: vid,
      vod_name: title,
      vod_pic: finalPic,
      vod_content: desc,
      type_name: typeName,
      vod_play_sources: videoId ? [{ name: '默认线路', episodes: [{ name: '正片', playId }] }] : undefined,
    };
    log('info', `detail 返回 vid=${vid} videoId=${videoId} title=${title.slice(0, 20)}`);
    return { list: [item] };
  } catch (e) { log('error', `detail 失败: ${e.message}`); return { list: [] }; }
}

async function play(params, context) {
  const flag = String((params && params.flag) || '91探花');
  const raw = String((params && (params.playId ?? params.url ?? params.id)) || '').trim();
  log('info', `play 入口 flag=${flag} raw=${raw.slice(0, 60)}`);
  if (!raw) return { urls: [], flag, parse: 0 };
  try {
    let url = '';
    if (/^https?:\/\//i.test(raw) && /\.(m3u8|mp4)(?:\?|$)/i.test(raw)) {
      url = raw;
    } else {
      const videoId = raw.split('|')[0].trim();
      if (!videoId) throw new Error('无视频 ID');
      const res = await axios.post(`${BASE}/videos/${encodeURIComponent(videoId)}/playback`, {}, {
        timeout: TIMEOUT, validateStatus: () => true,
        headers: {
          ...requestHeaders(BASE + '/'),
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (res.status !== 200) throw new Error(`playback HTTP ${res.status}`);
      let data = res.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { throw new Error('playback 非 JSON'); } }
      if (Number(data.code) !== 200) throw new Error(data.msg || 'playback 失败');
      const streams = (data.data && data.data.streams) || {};
      url = text(streams.main) || text(streams.preview) || text(streams.hevc);
      if (!url) throw new Error('无播放地址');
    }
    log('info', `play 命中 ${url.slice(0, 90)}`);
    return {
      urls: [{ name: '正片', url }], flag, parse: 0,
      header: { 'User-Agent': UA, Referer: BASE + '/', Origin: BASE },
    };
  } catch (e) {
    log('error', `play 失败: ${e.message}`);
    return { urls: [], flag, header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
