// @name Chuporno
// @author 宝宝巴士
// @description Chuporno（chuporno.com）：西语视频站；首页/分类/搜索/详情/播放；详情页 embedUrl -> embed 页 slh 直取 m3u8（含 720p）
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/Chuporno.js
// @dependencies []
/**
 * ============================================================================
 * Chuporno（chuporno.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-16 实测）】
 *   西语视频聚合站，服务端渲染 HTML，无框架。
 *   首页：/                          （100 个视频卡片）
 *   分类：/{slug}                   （59 个分类，如 /follando）
 *   分类分页：/{slug}/page/{n}
 *   搜索：/?s={关键词}&page={n}      （表单 name="s"）
 *   详情：/{slug}-{id}
 *   播放：/embed/{code}             （★ 真实 m3u8 在这里）
 *
 * 【列表卡片结构】
 *   <section>
 *     <header><h2><a href="https://chuporno.com/{slug}-{id}" title="标题">标题</a></h2></header>
 *     <figure><a href="..."><img src="/video/thumb/{slug}-{id}.jpg" alt="标题"
 *                    data-vp='/uuid/6/preview.mp4'></a></figure>
 *     <div class="data"><span class="vhd">HD</span><span class="vtime">11:41</span>
 *       <span class="vtube" data-text="Xvideos"></span></div>
 *   </section>
 *   注意：data-vp 是**预览小片**（preview.mp4），不是正片，不能当播放地址。
 *
 * 【详情 / 播放（关键）】
 *   详情页 JSON-LD:
 *     <link itemprop="embedUrl" href="https://chuporno.com/embed/vu232BOE2Dp">
 *     <meta itemprop="contentUrl" content=".../preview.mp4">  ← 只是预览
 *     itemprop: name / description / duration(PT11M41S) / thumbnailUrl /
 *               interactionCount(播放量) / datePublished / uploadDate
 *   embed 页里是一段播放器初始化 JS，真实 m3u8 在变量 slh：
 *     var config = { ... , slh : 'https://hls-cdn77.xvideos-cdn.com/{签名,过期}/{uuid}/0/hls.m3u8',
 *                    typ : 'application/x-mpegURL', pst : '封面', ... }
 *   slh 就是带签名的 HLS 直链，实测 HTTP 200，
 *   master playlist 含 720p / 480p / 360p / 250p 多档。
 *   ⚠️ 签名有时效（URL 里 ,1794842863 是过期时间戳），所以每次播放都现场抓 embed 页，
 *      不要缓存 m3u8 地址。
 *
 * 【环境变量】
 *   CHU_HOST   站点地址，默认 https://chuporno.com
 *   CHU_UA     自定义 User-Agent
 *   CHU_COOKIE 站点 cookie（可选）
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

const PREFIX = '[chuporno]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.CHU_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE = String(process.env.CHU_COOKIE || '').trim();
const HOST = (process.env.CHU_HOST || 'https://chuporno.com').replace(/\/+$/, '');

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
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${u.origin}/`,
    }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {});
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

async function fetchHtml(url, options = {}) {
  try {
    if (OmniBox && typeof OmniBox.request === 'function') {
      const r = await OmniBox.request(url, {
        method: 'GET',
        headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' },
          COOKIE ? { Cookie: COOKIE } : {}, options.headers || {}),
        timeout: options.timeout || 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return body;
    }
  } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  const r = await nodeRequest(url, options);
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
function fixUrl(u, host) {
  let s = String(u || '').replace(/&amp;/gi, '&').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/') && host) return host + s;
  return s;
}
/** ISO 时长 PT11M41S → 11:41 */
function parseDuration(pt) {
  const m = String(pt || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return '';
  const h = Number(m[1] || 0), min = Number(m[2] || 0), sec = Number(m[3] || 0);
  const mm = h * 60 + min;
  return `${String(mm).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: '', type_name: '首页推荐' },
  { type_id: 'porno-gratis', type_name: 'Porno Gratis' },
  { type_id: 'follando', type_name: 'Follando' },
  { type_id: 'sub-espanol', type_name: 'Sub Español' },
  { type_id: 'porno-ia', type_name: 'Porno IA' },
  { type_id: 'tetonas', type_name: 'Tetonas' },
  { type_id: 'madrastra', type_name: 'Madrastra' },
  { type_id: 'sexo-anal', type_name: 'Sexo Anal' },
  { type_id: 'culonas', type_name: 'Culonas' },
  { type_id: 'maduras', type_name: 'Maduras' },
  { type_id: 'hermanastra', type_name: 'Hermanastra' },
  { type_id: 'trios', type_name: 'Trios' },
  { type_id: 'espanolas', type_name: 'Españolas' },
  { type_id: 'milf', type_name: 'MILF' },
  { type_id: 'latinas', type_name: 'Latinas' },
  { type_id: 'jovencitas', type_name: 'Jovencitas' },
  { type_id: 'mas-vistos/semana', type_name: '热门本周' },
];

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  // <section>...<h2><a href=".../{slug}-{id}" title="标题">...</a></h2>...<img ... data-vp=...>
  const secRe = /<section>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = secRe.exec(s)) !== null) {
    const block = m[1];
    const aM = block.match(/<h2>\s*<a\s+href="([^"]+)"\s+title="([^"]*)"/i);
    if (!aM) continue;
    const url = aM[1];
    const title = cleanText(aM[2]);
    if (!title) continue;
    // id：URL 末尾 -数字
    const idM = url.match(/\/([^\/]+?-(\d+))\/?$/);
    const id = idM ? idM[2] : url.replace(/[^a-z0-9]/gi, '');
    if (!id || seen.has(id)) continue;
    // 封面
    let pic = '';
    const imgM = block.match(/<img[^>]*src="([^"]*\/video\/thumb\/[^"]+)"/i);
    if (imgM) pic = fixUrl(imgM[1], HOST);
    // data-vp（预览小片，仅作参考，不当播放地址）
    let preview = '';
    const vpM = block.match(/data-vp=['"]([^'"]+)['"]/i);
    if (vpM) preview = fixUrl(vpM[1], HOST);
    // 时长 / 来源 / HD
    let remarks = '';
    const timeM = block.match(/class="[^"]*vtime[^"]*"[^>]*>([^<]*)</i);
    if (timeM) remarks = cleanText(timeM[1]);
    const hdM = block.match(/class="[^"]*vhd[^"]*"[^>]*>([^<]*)</i);
    if (hdM) remarks = [cleanText(hdM[1]), remarks].filter(Boolean).join(' · ');
    const srcM = block.match(/class="[^"]*vtube[^"]*"[^>]*data-text="([^"]*)"/i);
    let source = '';
    if (srcM) source = cleanText(srcM[1]);

    seen.add(id);
    list.push({
      vod_id: url.replace(/^https?:\/\/[^/]+/, ''),
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      vod_content: [source && `来源：${source}`, preview && `预览：${preview}`].filter(Boolean).join('\n'),
      vod_tag: 'video',
      vod_url: url.startsWith('http') ? url : HOST + url,
      _id: id,
      _preview: preview,
    });
  }
  return list;
}

/** 分页总数：/{slug}/page/N */
function parsePageCount(html) {
  const s = String(html || '');
  let max = 1;
  const re = /\/page\/(\d+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max && n < 10000) max = n;
  }
  return max;
}

/* ---------------- 详情 ---------------- */
/** 从 embed 页提取真实 m3u8（slh 变量） */
async function resolveEmbedM3u8(embedUrl) {
  const html = await fetchHtml(embedUrl, { headers: { Referer: `${HOST}/` } });
  if (!html) return '';
  // slh : 'https://.../hls.m3u8'
  const m = html.match(/\bslh\s*:\s*['"]([^'"]+)['"]/i);
  if (m) return fixUrl(m[1], HOST);
  // 兜底：任意 m3u8
  const m2 = html.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/i);
  return m2 ? fixUrl(m2[0], HOST) : '';
}

async function fetchDetail(vodPath) {
  const cacheKey = `chuporno:detail:${vodPath}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id) return obj;
    }
  } catch (_) {}

  const path = vodPath.startsWith('/') ? vodPath : `/${vodPath}`;
  const html = await fetchHtml(`${HOST}${path}`);
  if (!html) return null;

  // 元数据（JSON-LD itemprop）
  const getMeta = (prop) => {
    const re = new RegExp(`itemprop=["']${prop}["'][^>]*(?:content|href)=["']([^"']+)["']`, 'i');
    const m = html.match(re);
    return m ? m[1] : '';
  };
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title = cleanText(h1 ? h1[1] : getMeta('name'));
  title = title.replace(/\s*[-|]\s*Chuporno\s*$/i, '').trim();
  const desc = cleanText(getMeta('description'));
  const duration = parseDuration(getMeta('duration'));
  const views = getMeta('interactionCount');
  const date = getMeta('datePublished') || getMeta('uploadDate');
  let pic = fixUrl(getMeta('thumbnailUrl'), HOST);
  if (!pic) {
    const im = html.match(/<img[^>]*src="([^"]*\/video\/thumb\/[^"]+)"/i);
    if (im) pic = fixUrl(im[1], HOST);
  }
  const embedUrl = fixUrl(getMeta('embedUrl'), HOST);

  // 现场解析 embed 拿 m3u8（签名有时效，不缓存）
  let playUrl = '';
  if (embedUrl) {
    try { playUrl = await resolveEmbedM3u8(embedUrl); }
    catch (e) { logI(`embed 解析失败: ${e.message}`); }
  }
  if (!playUrl) {
    // 兜底：详情页里直接找 m3u8
    const m8 = html.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/i);
    if (m8) playUrl = fixUrl(m8[0], HOST);
  }

  const tags = [];
  for (const a of html.matchAll(/<a[^>]*href="https:\/\/chuporno\.com\/[^"/]+"[^>]*rel="tag"[^>]*>([^<]*)<\/a>/gi)) {
    const t = cleanText(a[1]);
    if (t) tags.push(t);
  }

  const vod = {
    vod_id: vodPath,
    vod_name: title || `视频 ${vodPath}`,
    vod_pic: pic,
    vod_remarks: [duration, views && `${views} 观看`].filter(Boolean).join(' · '),
    vod_content: [desc, date && `发布：${date}`, tags.length ? `标签：${tags.join('、')}` : '']
      .filter(Boolean).join('\n'),
    vod_play_sources: playUrl ? [{
      name: 'Chuporno',
      episodes: [{ name: '正片', playId: playUrl }],
    }] : [],
    vod_url: `${HOST}${path}`,
    _embed: embedUrl,
  };
  if (playUrl) {
    vod.vod_play_from = 'Chuporno';
    vod.vod_play_url = `正片$${playUrl}`;
  }
  try { await OmniBox.setCache(cacheKey, vod, 600); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 110)} from=${(context && context.from) || 'web'}`);
  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const header = { 'User-Agent': UA, Referer: `${HOST}/` };

  // 已是 m3u8 直链
  if (/\.m3u8(\?|$)/i.test(rawId)) {
    return { parse: 0, jx: 0, flag: 'Chuporno', url: rawId, urls: [{ name: '正片', url: rawId }], header };
  }
  // embed 链接 → 现场解析
  if (/\/embed\//i.test(rawId)) {
    const u = rawId.startsWith('http') ? rawId : HOST + rawId;
    const m3u8 = await resolveEmbedM3u8(u);
    if (m3u8) return { parse: 0, jx: 0, flag: 'Chuporno', url: m3u8, urls: [{ name: '正片', url: m3u8 }], header };
    return { parse: 1, jx: 0, flag: 'Chuporno', url: u, urls: [{ name: '正片', url: u }], header };
  }
  // 视频路径 → 详情拿 embed 再解析
  if (rawId.startsWith('/') || /^[a-z0-9-]+$/i.test(rawId)) {
    const v = await fetchDetail(rawId);
    const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
    if (first) return {
      parse: 0, jx: 0, flag: 'Chuporno',
      url: first.playId,
      urls: [{ name: '正片', url: first.playId }],
      header,
    };
  }
  return { parse: 1, jx: 0, flag: 'Chuporno', url: rawId, urls: [{ name: '正片', url: rawId }], header };
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
    const slug = typeId.replace(/^\/+|\/+$/g, '');
    let path;
    if (!slug) path = page > 1 ? `/page/${page}` : '/';
    else path = page > 1 ? `/${slug}/page/${page}` : `/${slug}`;
    const html = await fetchHtml(`${HOST}${path}`);
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
  // 支持完整 URL / 路径 / embed 链接
  let path = idRaw;
  const um = idRaw.match(/chuporno\.com(\/[^?]+)/i);
  if (um) path = um[1];
  if (/\/embed\//i.test(path)) {
    // 直接给 embed 链接：现场解析 m3u8
    const m3u8 = await resolveEmbedM3u8(path.startsWith('http') ? path : HOST + path);
    if (!m3u8) return { list: [] };
    return { list: [{
      vod_id: path, vod_name: '视频', vod_pic: '',
      vod_play_sources: [{ name: 'Chuporno', episodes: [{ name: '正片', playId: m3u8 }] }],
      vod_play_from: 'Chuporno', vod_play_url: `正片$${m3u8}`,
    }] };
  }
  try {
    const v = await fetchDetail(path);
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
  let list = [];
  try {
    const html = await fetchHtml(`${HOST}/?s=${encodeURIComponent(wd)}&page=${page}`);
    list = parseList(html);
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount: list.length >= 20 ? page + 1 : page, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
