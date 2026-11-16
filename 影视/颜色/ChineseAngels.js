// @name Chinese Angels
// @author 宝宝巴士
// @description Chinese Angels（chinese-angels.com）：WordPress 视频站；首页/分类/详情/播放；详情页 <video><source> 直取带签名 mp4 直链
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/ChineseAngels.js
// @dependencies []
/**
 * ============================================================================
 * Chinese Angels（chinese-angels.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-16 实测）】
 *   WordPress 视频站，服务端渲染 HTML，中文标题。
 *   首页：/                          （72 个 video 卡片）
 *   分类：/category/{slug}/          （37 个分类）
 *   分类分页：/category/{slug}/?page={n}   （★ 是 query 参数，不是 /page/N）
 *   详情：/video/{id}/{slug}/
 *   搜索：站点无有效搜索（?s= / ?q= 都返回首页，也没有搜索表单），
 *         search() 退化为「按分类筛选 + 本地标题匹配」，见下方说明。
 *
 * 【列表卡片结构】
 *   <article class="video infinite post-{id} ...">
 *     <a href="/video/{id}/{slug}/" title="标题">
 *       <figure class="video-thumb">
 *         <span class="duration">03:31</span>
 *         <img src="封面" data-original="封面" class="lazy ...">
 *       </figure>
 *       <header class="video-header"><span class="views"></span><h2>标题</h2></header>
 *     </a>
 *   </article>
 *
 * 【详情 / 播放（关键）】
 *   详情页：
 *     <video preload="none" controls poster="封面">
 *       <source src="https://vs1.videosrc.net/s/.../xxx.mp4?md5=...&expires=..." type="video/mp4">
 *     </video>
 *   <source src> 就是带签名的 mp4 直链，直接 parse=0 返回。
 *   视频源用多个子域（vs1/vs9/vs12.videosrc.net），签名有时效（expires 时间戳），
 *   所以每次 detail 都现场抓页面取最新直链，不缓存 m3u8/mp4。
 *   ⚠️ 站点给的媒体域 *.videosrc.net 在某些出口（如本机遇到的韩国 IP）DNS 无法解析，
 *      这是站点/地区问题，脚本只负责正确提取站点返回的直链。
 *
 * 【环境变量】
 *   CA_HOST   站点地址，默认 https://chinese-angels.com
 *   CA_UA     自定义 User-Agent
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

const PREFIX = '[chineseangels]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.CA_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = (process.env.CA_HOST || 'https://chinese-angels.com').replace(/\/+$/, '');

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
    req.end();
  });
}

async function fetchHtml(url) {
  try {
    if (OmniBox && typeof OmniBox.request === 'function') {
      const r = await OmniBox.request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        timeout: 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return body;
    }
  } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  const r = await nodeRequest(url);
  return String(r.body || '');
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
function fixUrl(u) {
  let s = String(u || '').replace(/&amp;/gi, '&').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: '', type_name: '首页推荐' },
  { type_id: 'hd', type_name: '高清' },
  { type_id: 'asian', type_name: '亚洲' },
  { type_id: 'amateur', type_name: '业余' },
  { type_id: 'teens', type_name: '少女' },
  { type_id: 'matures', type_name: '熟女' },
  { type_id: 'big_boobs', type_name: '巨乳' },
  { type_id: 'anal', type_name: '肛交' },
  { type_id: 'blowjobs', type_name: '口交' },
  { type_id: 'hardcore', type_name: '重口' },
  { type_id: 'cumshots', type_name: '射精' },
  { type_id: 'lesbians', type_name: '女同' },
  { type_id: 'bdsm', type_name: 'BDSM' },
  { type_id: 'pornstars', type_name: '艳星' },
  { type_id: 'compilation', type_name: '合集' },
  { type_id: 'orgy', type_name: '群交' },
  { type_id: 'voyeur', type_name: '偷窥' },
];

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  const artRe = /<article\b[^>]*\bpost-(\d+)\b[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = artRe.exec(s)) !== null) {
    const id = m[1];
    const block = m[2];
    if (seen.has(id)) continue;
    const aM = block.match(/<a[^>]*href="([^"]*\/video\/\d+\/[^"]*)"[^>]*title="([^"]*)"/i);
    if (!aM) continue;
    const url = fixUrl(aM[1]);
    const title = cleanText(aM[2]);
    if (!title) continue;
    // 封面：data-original 优先
    let pic = '';
    const im = block.match(/<img[^>]*data-original="([^"]+)"/i)
      || block.match(/<img[^>]*src="(https?:\/\/[^"]*\.(?:jpe?g|png|webp)[^"]*)"/i);
    if (im) pic = fixUrl(im[1]);
    // 时长
    let duration = '';
    const dm = block.match(/class="[^"]*duration[^"]*"[^>]*>([^<]*)</i);
    if (dm) duration = cleanText(dm[1]);

    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: duration,
      vod_tag: 'video',
      vod_url: url.startsWith('http') ? url : HOST + url,
    });
  }
  return list;
}

/** 分页总数：?page=N */
function parsePageCount(html) {
  const s = String(html || '');
  let max = 1;
  const re = /[?&]page=(\d+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max && n < 100000) max = n;
  }
  return max;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(id) {
  const cacheKey = `chineseangels:detail:${id}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id && obj.vod_play_sources[0]?.episodes[0]?.playId) {
        // 检查签名是否还有效：expires 时间戳
        const u = obj.vod_play_sources[0].episodes[0].playId;
        const ex = (u.match(/expires=(\d+)/) || [])[1];
        if (ex && Number(ex) * 1000 > Date.now() + 60000) return obj;
      }
    }
  } catch (_) {}

  // 用详情页 URL 拿真实内容（id 路径即可，slug 不重要）
  const html = await fetchHtml(`${HOST}/video/${id}/`);
  if (!html) return null;

  // 标题
  const tm = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  let title = cleanText(tm ? tm[1] : '');
  title = title.replace(/\s*[-–|]\s*.*$/, '').trim();

  // 封面 poster
  let pic = '';
  const pm = html.match(/<video[^>]*poster="([^"]+)"/i);
  if (pm) pic = fixUrl(pm[1]);
  if (!pic) {
    const im = html.match(/<img[^>]*data-original="([^"]+)"/i)
      || html.match(/<img[^>]*src="(https?:\/\/[^"]*\/media\/thumbs\/[^"]+)"/i);
    if (im) pic = fixUrl(im[1]);
  }
  // 时长
  let duration = '';
  const dm = html.match(/<span class="duration">[\s\S]{0,80}?([\d:]+)/i);
  if (dm) duration = cleanText(dm[1]);

  // 播放直链：<source src="...mp4?md5=...&expires=...">
  let playUrl = '';
  const sm = html.match(/<source\s+src="([^"]+\.mp4[^"]*)"/i);
  if (sm) playUrl = fixUrl(sm[1]);
  if (!playUrl) {
    const m8 = html.match(/https?:\/\/[^"'\s]+\.mp4\?[^"'\s]+/i);
    if (m8) playUrl = fixUrl(m8[0]);
  }

  const vod = {
    vod_id: id,
    vod_name: title || `视频 ${id}`,
    vod_pic: pic,
    vod_remarks: duration,
    vod_play_sources: playUrl ? [{
      name: 'Chinese Angels',
      episodes: [{ name: '正片', playId: playUrl }],
    }] : [],
    vod_url: `${HOST}/video/${id}/`,
    _id: id,
  };
  if (playUrl) {
    vod.vod_play_from = 'Chinese Angels';
    vod.vod_play_url = `正片$${playUrl}`;
  }
  // 只缓存短时（签名有时效）
  try { await OmniBox.setCache(cacheKey, vod, 300); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 110)} from=${(context && context.from) || 'web'}`);
  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const header = { 'User-Agent': UA, Referer: `${HOST}/` };

  // 已是 mp4 / m3u8 直链
  if (/\.(mp4|m3u8)(\?|$)/i.test(rawId)) {
    return { parse: 0, jx: 0, flag: 'Chinese Angels', url: rawId, urls: [{ name: '正片', url: rawId }], header };
  }
  // 数字 id → 详情现场解析（签名有时效）
  if (/^\d+$/.test(rawId)) {
    try {
      const v = await fetchDetail(rawId);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) return {
        parse: 0, jx: 0, flag: 'Chinese Angels',
        url: first.playId,
        urls: [{ name: '正片', url: first.playId }],
        header,
      };
    } catch (_) {}
  }
  return { parse: 1, jx: 0, flag: 'Chinese Angels', url: rawId, urls: [{ name: '正片', url: rawId }], header };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const html = await fetchHtml(`${HOST}/`);
    list = parseList(html);
    logI(`home 返回 ${list.length} 条`);
  } catch (e) {
    logE(`home 异常: ${e.message}`);
  }
  return { class: cls, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const typeId = String((params && (params.categoryId || params.type_id || params.tid)) || '').trim();
  const page = Math.max(1, Number((params && params.page) || 1));
  logI(`category type=${typeId || '(首页)'} page=${page}`);
  let list = [];
  let pagecount = 1;
  try {
    const slug = typeId.replace(/[^a-zA-Z0-9_+&-]/g, '');
    let url;
    if (!slug) url = `${HOST}/${page > 1 ? `?page=${page}` : ''}`;
    else url = `${HOST}/category/${slug}/${page > 1 ? `?page=${page}` : ''}`;
    const html = await fetchHtml(url);
    list = parseList(html);
    pagecount = parsePageCount(html);
    logI(`category 返回 ${list.length} 条，共 ${pagecount} 页`);
  } catch (e) {
    logE(`category 异常: ${e.message}`);
  }
  return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
}

async function detail(params, context) {
  const idRaw = String((params && (params.id || params.vod_id || params.videoId)) || '').trim();
  logI(`detail id=${idRaw}`);
  if (!idRaw) return { list: [] };
  let id = idRaw;
  const um = idRaw.match(/\/video\/(\d+)/i);
  if (um) id = um[1];
  if (!/^\d+$/.test(id)) return { list: [] };
  try {
    const v = await fetchDetail(id);
    if (!v) return { list: [] };
    logI(`detail 成功: ${v.vod_name.slice(0, 40)}`);
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
  // 站点无有效搜索（?s=/?q= 都回首页）。
  // 退而求其次：抓首页+前几页分类，本地按标题筛选。
  let all = [];
  try {
    const idx = await fetchHtml(`${HOST}/`);
    all = all.concat(parseList(idx));
    for (const slug of ['hd', 'asian', 'amateur', 'teens', 'matures']) {
      try {
        const h = await fetchHtml(`${HOST}/category/${slug}/`);
        all = all.concat(parseList(h));
      } catch (_) {}
    }
    // 去重 + 本地标题匹配
    const seen = new Set();
    const kw = wd.toLowerCase();
    const list = all.filter((v) => {
      if (seen.has(v.vod_id)) return false;
      seen.add(v.vod_id);
      return String(v.vod_name).toLowerCase().includes(kw);
    });
    logI(`search 返回 ${list.length} 条（本地筛选，站点无搜索接口）`);
    return { page, pagecount: 1, total: list.length, limit: list.length, list };
  } catch (e) {
    logE(`search 异常: ${e.message}`);
    return { page, pagecount: 1, total: 0, limit: 0, list: [] };
  }
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
