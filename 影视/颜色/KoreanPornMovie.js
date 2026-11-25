// @name Korean Porn Movie
// @author 宝宝巴士
// @description koreanpornmovie.com：WordPress 视频站；首页/分类/标签/搜索/分页；卡片 article 取标题/封面/时长；详情页 itemprop="contentUrl" 直取 mp4 直链（HTTP 200 + Range 206 实测可播）
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/KoreanPornMovie.js
/**
 * ============================================================================
 * Korean Porn Movie（koreanpornmovie.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-18 实测）】
 *   WordPress 视频站，服务端渲染 HTML。
 *   首页：/                       （75 个 article 卡片）
 *   分类：/category/{slug}/       实测 /category/korean/ 44 条
 *   标签：/tag/{slug}/
 *   搜索：/?s={关键词}             （GET，form#searchform）
 *   分页：/{路径}/page/{n}/        实测 /page/2/ 75 条
 *   详情：/{slug}/
 *
 * 【列表卡片】
 *   <article data-video-id="video_1" data-post-id="10389"
 *            data-main-thumb="https://.../xxx.jpg"
 *            class="loop-video thumb-block video-preview-item ...">
 *     <a href="https://koreanpornmovie.com/{slug}/" title="标题">
 *       <img class="video-main-thumb" src="封面">
 *       <span class="duration"><i class="fa fa-clock-o"></i>01:02:54</span>
 *       <header class="entry-header"><span>标题</span></header>
 *     </a>
 *   </article>
 *   注意：部分 article 带 data-trailer（xvideos-cdn 预览片），不是正片，忽略。
 *
 * 【详情 / 播放】
 *   详情页 <meta itemprop="contentUrl" content="https://koreanporn.stream/xxx.mp4">
 *   就是真实 mp4 直链（实测 HTTP 200，97MB，支持 Range 206）。
 *   另有 itemprop="duration"（ISO8601，如 P0DT1H2M54S）、
 *        itemprop="thumbnailUrl"、itemprop="uploadDate"、og:image。
 *   play() 直接 parse=0 返回 mp4 直链，带 Referer。
 *
 * 【环境变量】
 *   KPM_HOST   站点地址，默认 https://koreanpornmovie.com
 *   KPM_UA     自定义 User-Agent
 * ============================================================================
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');

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

const PREFIX = '[kpm]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const HOST = String(process.env.KPM_HOST || 'https://koreanpornmovie.com').replace(/\/+$/, '');
const UA = String(process.env.KPM_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${u.origin}/`,
    }, options.headers || {});
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
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
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: decompress(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.end();
  });
}
async function fetchHtml(url) {
  if (OmniBox && typeof OmniBox.request === 'function') {
    try {
      const r = await OmniBox.request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        timeout: 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return body;
    } catch (_) {}
  }
  const r = await nodeRequest(url);
  return String(r.body || '');
}

/* ---------------- 工具 ---------------- */
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function absUrl(u) {
  let s = String(u || '').replace(/&amp;/gi, '&').trim();
  if (!s) return '';
  s = s.replace(/\\\//g, '/');
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return HOST + s;
  if (!/^https?:\/\//i.test(s)) return HOST + '/' + s;
  return s;
}
/** ISO8601 时长 → mm:ss / hh:mm:ss */
function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i.exec(String(iso || ''));
  if (!m) return '';
  const d = Number(m[1] || 0), h = Number(m[2] || 0), mi = Number(m[3] || 0), s = Number(m[4] || 0);
  const total = d * 86400 + h * 3600 + mi * 60 + s;
  if (!total) return '';
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: 'home', type_name: '首页推荐' },
  { type_id: 'korean', type_name: '韩国' },
  { type_id: 'korean-adult-movies', type_name: '韩国成人' },
  { type_id: 'asian-erotic', type_name: '亚洲情色' },
  { type_id: 'celebrity-porn-movies', type_name: '名人' },
  { type_id: 'korean-erotic', type_name: '韩国情色' },
];

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  const re = /<article\b([^>]*)>([\s\S]{0,2000}?)<\/article>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const attrs = m[1];
    const block = m[2];

    const hrefM = /\bhref="([^"]+)"/i.exec(block);
    const titleM = /\btitle="([^"]+)"/i.exec(block);
    if (!hrefM) continue;
    const url = absUrl(hrefM[1]);
    const title = cleanText((titleM && titleM[1]) || '');
    if (!title) continue;

    const idM = /data-post-id="(\d+)"/i.exec(attrs);
    const id = idM ? idM[1] : (url.match(/\/(\d+)(\/|$)/) || [])[1] || url;

    // 封面：优先 data-main-thumb，再 img.video-main-thumb / img[src]
    let pic = '';
    const dt = /data-main-thumb="([^"]+)"/i.exec(attrs);
    const im = /<img[^>]*\b(?:data-src|src)="([^"]+)"/i.exec(block);
    pic = absUrl((dt && dt[1]) || (im && im[1]) || '');
    // 跳过占位小图（如 1x1）
    if (/placeholder|1x1|blank/i.test(pic)) pic = '';

    const durM = /<span[^>]*class="[^"]*duration[^"]*"[^>]*>([\s\S]{0,80}?)<\/span>/i.exec(block);
    const duration = cleanText(durM ? durM[1] : '');

    if (seen.has(String(id))) continue;
    seen.add(String(id));
    list.push({
      vod_id: String(id),
      vod_name: title,
      vod_pic: pic,
      vod_remarks: duration,
      vod_tag: 'video',
      vod_url: url,
    });
  }
  return list;
}
function parsePageCount(html) {
  const s = String(html || '');
  let max = 1;
  const re = /\/page\/(\d+)\//g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (n > max && n < 100000) max = n;
  }
  return max;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(idOrUrl) {
  const raw = String(idOrUrl || '').trim();
  if (!raw) return null;
  // 数字 id → 从首页/搜索找 URL 不可行；直接用 /?p={id} 兜底
  let pageUrl = /^https?:\/\//i.test(raw) ? raw : (/^\d+$/.test(raw) ? `${HOST}/?p=${raw}` : `${HOST}/${raw}`);
  const html = await fetchHtml(pageUrl);
  if (!html) return null;

  const tm = /<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i.exec(html)
    || /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  let title = cleanText(tm ? tm[1] : '');
  title = title.replace(/\s*\|\s*Korean Porn.*$/i, '').trim();

  const picM = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i.exec(html)
    || /itemprop="thumbnailUrl"[^>]*content="([^"]+)"/i.exec(html);
  const pic = absUrl(picM ? picM[1] : '');

  const durM = /itemprop="duration"[^>]*content="([^"]+)"/i.exec(html);
  const duration = parseDuration(durM ? durM[1] : '');

  const dateM = /itemprop="uploadDate"[^>]*content="([^"]+)"/i.exec(html);
  const date = dateM ? String(dateM[1]).slice(0, 10) : '';

  // 播放直链：itemprop="contentUrl"
  let media = '';
  const cu = /itemprop="contentUrl"[^>]*content="([^"]+)"/i.exec(html);
  if (cu) media = absUrl(cu[1]);
  if (!media) {
    const rawMp4 = /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/i.exec(html);
    if (rawMp4) media = absUrl(rawMp4[1]);
  }

  const vod = {
    vod_id: raw,
    vod_name: title || `视频 ${raw}`,
    vod_pic: pic,
    vod_remarks: [duration, date].filter(Boolean).join(' / '),
    vod_content: cleanText((/<meta[^>]*name="description"[^>]*content="([^"]*)"/i.exec(html) || [])[1] || ''),
    vod_play_sources: media ? [{ name: 'KoreanPorn', episodes: [{ name: '正片', playId: media }] }] : [],
    vod_url: pageUrl,
  };
  if (media) {
    vod.vod_play_from = 'KoreanPorn';
    vod.vod_play_url = `正片$${media}`;
  }
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const p = params || {};
  const raw = String(p.playId || p.id || p.url || '').trim();
  logI(`play playId=${raw.slice(0, 110)} from=${(context && context.from) || 'web'}`);
  if (!raw) return { parse: 0, jx: 0, urls: [] };

  const header = { 'User-Agent': UA, Referer: `${HOST}/` };
  if (/\.(mp4|m3u8|ts)(\?|$)/i.test(raw)) {
    return { parse: 0, jx: 0, flag: 'KoreanPorn', url: raw, urls: [{ name: '正片', url: raw }], header };
  }
  // 详情页 URL / slug → 现场解析
  if (/\.html\//i.test(raw) || /\/\d+\/?$/.test(raw) || (!/^https?:\/\//i.test(raw))) {
    try {
      const v = await fetchDetail(raw);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) return {
        parse: 0, jx: 0, flag: 'KoreanPorn',
        url: first.playId,
        urls: [{ name: '正片', url: first.playId }],
        header,
      };
    } catch (e) {
      logI(`[play] 解析失败: ${e.message}`);
    }
  }
  return { parse: 1, jx: 0, flag: 'KoreanPorn', url: raw, urls: [{ name: '正片', url: raw }], header };
}

/* ---------------- 五方法 ---------------- */
async function home(params, context) {
  try {
    logI(`home from=${(context && context.from) || 'web'}`);
    const html = await fetchHtml(`${HOST}/`);
    const list = parseList(html);
    logI(`home 返回 ${list.length} 条`);
    return { class: CLASSES, filters: {}, list, parse: 0, jx: 0 };
  } catch (e) {
    logE(`home 失败: ${e.message}`);
    return { class: CLASSES, filters: {}, list: [], parse: 0, jx: 0 };
  }
}

async function category(params, context) {
  const p = params || {};
  const typeId = String(p.categoryId || p.type_id || p.tid || 'home').trim();
  const page = Math.max(1, Number(p.page || 1));
  try {
    logI(`category type=${typeId} page=${page}`);
    let path = '/';
    if (typeId === 'korean') path = '/category/korean/';
    else if (typeId !== 'home') path = `/tag/${encodeURIComponent(typeId)}/`;
    if (page > 1) path = `${path.replace(/\/+$/, '')}/page/${page}/`;
    const html = await fetchHtml(`${HOST}${path}`);
    const list = parseList(html);
    const pagecount = parsePageCount(html);
    logI(`category 返回 ${list.length} 条，pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    logE(`category 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.vod_id || p.id || p.videoId || '');
  logI(`detail id=${String(raw).slice(0, 80)}`);
  if (!raw) return { list: [] };
  try {
    const v = await fetchDetail(raw);
    if (!v) return { list: [] };
    logI(`detail 成功: ${String(v.vod_name).slice(0, 40)}，线路 ${v.vod_play_sources.length}`);
    return { list: [v] };
  } catch (e) {
    logE(`detail 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const wd = String(p.wd || p.keyword || p.k || '').trim();
  const page = Math.max(1, Number(p.page || 1));
  logI(`search wd=${wd} page=${page}`);
  if (!wd) return { page: 1, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    let url = `${HOST}/?s=${encodeURIComponent(wd)}`;
    if (page > 1) url += `&paged=${page}`;
    const html = await fetchHtml(url);
    const list = parseList(html);
    const pagecount = parsePageCount(html);
    logI(`search 返回 ${list.length} 条`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    logE(`search 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
