// @name E-Hentai
// @author 宝宝巴士
// @description E-Hentai 图库（e-hentai.org）：分类/搜索/详情/播放；详情页逐页解析 /s/ 图片页取 hath.network 原图；游标式翻页
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/EHentai.js
// @dependencies []
/**
 * ============================================================================
 * E-Hentai（e-hentai.org）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-16 实测）】
 *   列表：https://e-hentai.org/            → <tr> 表格行，25 条/页
 *   搜索：/?f_search={关键词}
 *   标签：/tag/{namespace:tag}            例：/tag/female:big+breasts
 *   上传者：/uploader/{name}
 *   分类：/?f_cats={掩码}                 ⚠️ 是「排除」掩码，不是包含！
 *
 * 【分页是游标式，不是页码】
 *   /?page=N  实测无效：page=0/1/2/5 返回的都是同一批 gid。
 *   必须用 /?next={最后一行的 gid}，gid 递减翻页。
 *   搜索：/?f_search=xx&next={gid}
 *   标签：/tag/xx?next={gid}
 *   判断是否最后一页：页面里没有 id="unext" 的 <a>。
 *
 * 【分类位掩码（排除语义）】
 *   Misc=1  Doujinshi=2  Manga=4  Artist CG=8  Game CG=16
 *   Image Set=32  Cosplay=64  Asian Porn=128  Non-H=256  Western=512
 *   全部 = 1023。f_cats 表示「排除哪些」：
 *     只看 Doujinshi → f_cats = 1023-2 = 1021   （实测 25 条全是 Doujinshi）
 *     只看 Manga     → f_cats = 1023-4 = 1019   （实测 25 条全是 Manga）
 *     f_cats=0       → 不排除，混合（实测 Misc/Doujinshi/Western/Manga 混杂）
 *
 * 【列表行结构】
 *   <tr>
 *     <td class="gl1c glcat"><div class="cn ct4" onclick="...artistcg">Artist CG</div></td>
 *     <td class="gl2c">
 *       <img src="data:image/gif;base64,..." data-src="https://ehgt.org/w/02/802/xxx.webp" />
 *       <div>8 pages</div>
 *     </td>
 *     <td class="gl3c glname"><a href="https://e-hentai.org/g/{gid}/{token}/">
 *       <div class="glink">标题</div>
 *       <div><div class="gt" title="language:japanese">japanese</div>...</div>
 *     </a></td>
 *     <td class="gl4c glhide"><div><a href="/uploader/xx">上传者</a></div><div>8 pages</div></td>
 *   </tr>
 *   注意封面 src 是 base64 占位 gif，真实封面在 data-src。
 *
 * 【详情页】
 *   <h1 id="gn">标题</h1>
 *   <div id="gdc">分类</div>
 *   <table class="gdd"> 里有 Posted / Parent / Visible / Language / File Size / Length
 *   缩略图：<div id="gdt"><a href="https://e-hentai.org/s/{hash}/{gid}-{n}">
 *             <div title="Page 1: 0002.png" style="background:url(sprite)"></div></a>
 *           ⚠️ 缩略图是 CSS sprite 拼图，不能当封面用。
 *   真实大图必须逐页进 /s/ 页：
 *     <img id="img" src="https://xxx.hath.network/h/{hash}/keystamp=.../0002.webp" />
 *
 * 【播放策略】
 *   每页图片是直链 webp/jpg，play() 直接把第 n 页的图片 URL 交给宿主。
 *   detail() 会解析全部 /s/ 页拿真实图片直链（并发受限），
 *   若页数过多只解析前 MAX_PAGES 页并标注剩余。
 *
 * 【环境变量】
 *   EH_COOKIE        登录 cookie（看某些受限画廊需要）
 *   EH_UA            自定义 User-Agent
 *   EH_PROXY         代理（http:// 或 socks5://），境外访问可加速
 *   EH_MAX_PAGES     详情最多解析多少页图片，默认 120（0=不限制）
 *   EH_CONCURRENCY   图片页并发数，默认 4
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

const PREFIX = '[ehentai]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.EH_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE = String(process.env.EH_COOKIE || '').trim();
const BASE = 'https://e-hentai.org';

const MAX_PAGES = (() => {
  const raw = String(process.env.EH_MAX_PAGES || '').trim();
  if (raw === '') return 120;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 120;
})();
const CONCURRENCY = (() => {
  const raw = String(process.env.EH_CONCURRENCY || '').trim();
  const n = raw === '' ? 4 : Number(raw);
  return Math.max(1, Math.min(8, Number.isFinite(n) ? Math.floor(n) : 4));
})();

/* ---------------- 代理 ---------------- */
const PROXY_URL = String(process.env.EH_PROXY || process.env.UPSTREAM_HTTP_PROXY_URL || '').trim();
function parseProxy(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(t) ? t : `http://${t}`;
  let u;
  try { u = new URL(withScheme); } catch (_) { return null; }
  const protocol = u.protocol.replace(':', '').toLowerCase();
  return {
    protocol,
    host: u.hostname,
    port: Number(u.port || (protocol.startsWith('socks') ? 1080 : 7890)),
    isSocks: protocol.startsWith('socks'),
    auth: (u.username || u.password)
      ? { username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }
      : null,
  };
}

function connectHttpProxy(proxy, host, port, timeout) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let done = false;
    const fail = (e) => { if (!done) { done = true; sock.destroy(); reject(e); } };
    sock.on('error', fail);
    sock.on('timeout', () => fail(new Error('代理超时')));
    sock.on('connect', () => {
      let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (proxy.auth) {
        const b = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64');
        req += `Proxy-Authorization: Basic ${b}\r\n`;
      }
      req += 'Connection: keep-alive\r\n\r\n';
      sock.write(req);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        if (/^HTTP\/1\.[01] 200/i.test(buf)) { done = true; resolve(sock); }
        else fail(new Error(`代理拒绝: ${buf.split('\r\n')[0]}`));
      }
    };
    sock.on('data', onData);
  });
}

function connectSocks5(proxy, host, port, timeout) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let done = false;
    const fail = (e) => { if (!done) { done = true; sock.destroy(); reject(e); } };
    sock.on('error', fail);
    sock.on('timeout', () => fail(new Error('代理超时')));
    sock.on('connect', () => {
      const methods = proxy.auth ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    let stage = 0;
    sock.on('data', (d) => {
      if (stage === 0) {
        if (d[0] !== 0x05) return fail(new Error('SOCKS 版本错'));
        const method = d[1];
        if (method === 0x02 && proxy.auth) {
          const u = Buffer.from(proxy.auth.username);
          const p = Buffer.from(proxy.auth.password);
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
          return;
        }
        if (method !== 0x00) return fail(new Error('SOCKS 认证不支持'));
        sendConnect();
      } else if (stage === 1) {
        if (d[1] !== 0x00) return fail(new Error('SOCKS 认证失败'));
        sendConnect();
      } else {
        if (d[1] !== 0x00) return fail(new Error(`SOCKS 连接失败 code=${d[1]}`));
        done = true;
        resolve(sock);
      }
    });
    function sendConnect() {
      stage = 2;
      const h = Buffer.from(host);
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]));
    }
  });
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

async function httpGet(urlStr, options = {}) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const headers = Object.assign({
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': `${BASE}/`,
  }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {});

  const proxy = parseProxy(PROXY_URL);
  const timeout = options.timeout || 25000;

  return new Promise((resolve, reject) => {
    const doReq = (sock) => {
      const client = isHttps ? https : http;
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout,
        rejectUnauthorized: false,
      };
      if (sock) {
        reqOpts.createConnection = () => sock;
        reqOpts.agent = false;
      }
      const req = client.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: decompress(raw, res.headers['content-encoding']).toString('utf-8'),
          });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      req.end();
    };

    if (!proxy) return doReq(null);
    const port = u.port || (isHttps ? 443 : 80);
    const p = proxy.isSocks
      ? connectSocks5(proxy, u.hostname, port, timeout)
      : connectHttpProxy(proxy, u.hostname, port, timeout);
    p.then(doReq).catch((e) => {
      logI(`代理失败(${e.message})，改直连`);
      doReq(null);
    });
  });
}

/** 带重试的抓取（E-Hentai 偶发 509 带宽超限） */
async function fetchHtml(url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await httpGet(url);
      if (res.statusCode === 509) {
        lastErr = new Error('HTTP 509 带宽超限');
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      if (res.statusCode >= 200 && res.statusCode < 400) return res.body;
      lastErr = new Error(`HTTP ${res.statusCode}`);
      if (res.statusCode === 404) return '';
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw lastErr || new Error('请求失败');
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

/** 限并发映射 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (_) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- 分类 ---------------- */
// f_cats 是「排除掩码」，全部=1023。只看某类 = 1023 - 该类值
const CAT_MASK = {
  misc: 1, doujinshi: 2, manga: 4, artistcg: 8, gamecg: 16,
  imageset: 32, cosplay: 64, asianporn: 128, nonh: 256, western: 512,
};
const ALL_MASK = 1023;
const CLASSES = [
  { type_id: 'all', type_name: '全部' },
  { type_id: 'doujinshi', type_name: '同人志' },
  { type_id: 'manga', type_name: '漫画' },
  { type_id: 'artistcg', type_name: '画师CG' },
  { type_id: 'gamecg', type_name: '游戏CG' },
  { type_id: 'imageset', type_name: '图集' },
  { type_id: 'cosplay', type_name: 'Cosplay' },
  { type_id: 'asianporn', type_name: '亚洲' },
  { type_id: 'nonh', type_name: '非H' },
  { type_id: 'western', type_name: '欧美' },
  { type_id: 'misc', type_name: '其他' },
];

/** type_id → 列表 URL（不含游标） */
function classBaseUrl(typeId) {
  const t = String(typeId || '').trim().toLowerCase();
  if (!t || t === 'all') return `${BASE}/`;
  const mask = CAT_MASK[t];
  if (!mask) return `${BASE}/`;
  return `${BASE}/?f_cats=${ALL_MASK - mask}`;
}

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  // 每个画廊是一个 <tr>，用 /g/{gid}/{token}/ 定位再回扩到整行
  const linkRe = /<a href="(https:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]+)\/)"[^>]*>([\s\S]{0,800}?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(s)) !== null) {
    const url = m[1];
    const gid = m[2];
    const token = m[3];
    const inner = m[4];
    if (seen.has(gid)) continue;
    // 标题在 div.glink 里
    let title = '';
    const gl = inner.match(/<div[^>]*class="[^"]*glink[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (gl) title = cleanText(gl[1]);
    if (!title) title = cleanText(inner);
    if (!title) continue;
    // 标签
    const tags = [];
    const tagRe = /<div[^>]*class="[^"]*gt[^"]*"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/div>/gi;
    let t;
    while ((t = tagRe.exec(inner)) !== null) {
      const v = cleanText(t[2]) || cleanText(t[1]);
      if (v) tags.push(v);
    }
    // 从整行里补封面 / 分类 / 页数 / 上传者
    const rowStart = Math.max(0, s.lastIndexOf('<tr', m.index));
    let rowEnd = s.indexOf('</tr>', m.index);
    if (rowEnd < 0) rowEnd = Math.min(s.length, m.index + 3000);
    const row = s.slice(rowStart, rowEnd);
    // 封面：data-src（src 是 base64 占位）
    let pic = '';
    const ds = row.match(/<img[^>]*data-src="([^"]+)"/i);
    if (ds) pic = ds[1];
    if (!pic) {
      const src = row.match(/<img[^>]*src="(https?:\/\/[^"]+)"/i);
      if (src && !/^data:/i.test(src[1])) pic = src[1];
    }
    if (pic && pic.startsWith('//')) pic = 'https:' + pic;
    // 分类
    let cat = '';
    const cn = row.match(/<td[^>]*class="[^"]*gl1c[^"]*"[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>/i);
    if (cn) cat = cleanText(cn[1]);
    // 页数
    let pages = '';
    const pg = row.match(/(\d+)\s*pages?/i);
    if (pg) pages = `${pg[1]} 页`;
    // 上传者
    let uploader = '';
    const up = row.match(/<a href="https:\/\/e-hentai\.org\/uploader\/[^"]+"[^>]*>([^<]*)<\/a>/i);
    if (up) uploader = cleanText(up[1]);

    seen.add(gid);
    list.push({
      vod_id: `${gid}/${token}`,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: [cat, pages].filter(Boolean).join(' · '),
      vod_actor: uploader,
      vod_content: tags.join(', '),
      vod_tag: 'video',
      vod_url: url,
      _gid: gid,
      _token: token,
    });
  }
  return list;
}

/** 解析下一页游标：页面里 id="unext" 的链接 */
function parseNextUrl(html, baseUrl) {
  const s = String(html || '');
  const m = s.match(/id="unext"[^>]*href="([^"]+)"/i);
  if (!m) return '';
  let next = m[1].replace(/&amp;/g, '&');
  if (next.startsWith('/')) next = BASE + next;
  return next;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(gid, token) {
  const cacheKey = `ehentai:detail:${gid}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id) return obj;
    }
  } catch (_) {}

  const url = `${BASE}/g/${gid}/${token}/`;
  const html = await fetchHtml(url);
  if (!html) return null;

  // 标题
  const gnM = html.match(/<h1[^>]*id="gn"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = cleanText(gnM ? gnM[1] : '') || `Gallery ${gid}`;

  // 分类
  let cat = '';
  const gdc = html.match(/<div[^>]*id="gdc"[^>]*>([\s\S]*?)<\/div>/i);
  if (gdc) cat = cleanText(gdc[1]);

  // 元数据表 gdd
  const pick = (label) => {
    const re = new RegExp(`<td[^>]*class="gdt1"[^>]*>\\s*${label}[:：]?\\s*</td>\\s*<td[^>]*class="gdt2"[^>]*>([\\s\\S]*?)</td>`, 'i');
    const m = html.match(re);
    return m ? cleanText(m[1]) : '';
  };
  const posted = pick('Posted');
  const language = pick('Language');
  const fileSize = pick('File Size');
  const length = pick('Length');
  const favorited = pick('Favorited');

  // 标签
  const tags = [];
  const tagRe = /<div[^>]*id="taglist"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i;
  const tagBlock = html.match(tagRe);
  const tagSrc = tagBlock ? tagBlock[1] : html;
  const tRe = /<a[^>]*href="https:\/\/e-hentai\.org\/tag\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let tm;
  while ((tm = tRe.exec(tagSrc)) !== null) {
    const v = cleanText(tm[2]);
    if (v) tags.push(v);
  }

  // 封面：详情页 og:image 或第一张缩略图的 sprite（sprite 不可直接用，退而求其次）
  let pic = '';
  const og = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (og) pic = og[1];
  if (!pic) {
    const bg = html.match(/background:[^;]*url\((https?:\/\/[^)]+)\)/i);
    if (bg) pic = bg[1];
  }

  // 图片页列表：/s/{hash}/{gid}-{n}
  const pageUrls = [];
  const sRe = /<a href="(https:\/\/e-hentai\.org\/s\/[0-9a-f]+\/\d+-\d+)"/gi;
  let sm;
  while ((sm = sRe.exec(html)) !== null) {
    if (!pageUrls.includes(sm[1])) pageUrls.push(sm[1]);
  }

  // 逐页解析真实图片直链（限并发）
  let images = [];
  const total = pageUrls.length;
  if (total) {
    const targets = MAX_PAGES > 0 ? pageUrls.slice(0, MAX_PAGES) : pageUrls;
    logI(`详情 ${gid}：共 ${total} 页，解析 ${targets.length} 页图片直链`);
    const got = await mapLimit(targets, CONCURRENCY, async (pu) => {
      try {
        const ph = await fetchHtml(pu, 1);
        const im = ph.match(/<img[^>]*id="img"[^>]*src="([^"]+)"/i);
        if (!im) return null;
        let src = im[1].replace(/&amp;/g, '&');
        if (src.startsWith('//')) src = 'https:' + src;
        return src;
      } catch (_) { return null; }
    });
    images = got.filter(Boolean);
    logI(`详情 ${gid}：成功取到 ${images.length}/${targets.length} 张图片直链`);
  }

  const episodes = images.map((u, i) => ({
    name: `第${i + 1}页`,
    playId: u,
  }));
  // 没解析出直链时，退化为「图片页 URL」，play 时再解析
  if (!episodes.length && pageUrls.length) {
    pageUrls.forEach((u, i) => episodes.push({ name: `第${i + 1}页`, playId: u }));
  }

  const vod = {
    vod_id: `${gid}/${token}`,
    vod_name: title,
    vod_pic: pic,
    vod_year: (posted.match(/(\d{4})/) || [])[1] || '',
    vod_area: language,
    vod_lang: language,
    vod_content: [
      cat && `分类：${cat}`,
      length && `页数：${length}`,
      fileSize && `大小：${fileSize}`,
      favorited && `收藏：${favorited}`,
      posted && `发布：${posted}`,
      tags.length ? `标签：${tags.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    vod_remarks: [cat, length].filter(Boolean).join(' · '),
    type_name: cat,
    vod_play_sources: episodes.length ? [{ name: 'E-Hentai', episodes }] : [],
    _gid: gid,
    _token: token,
    _pageUrls: pageUrls,
    _totalPages: total,
  };
  if (episodes.length) {
    vod.vod_play_from = 'E-Hentai';
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join('#');
  }
  try { await OmniBox.setCache(cacheKey, vod, 3600); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 100)} from=${(context && context.from) || 'web'}`);

  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const header = {
    'User-Agent': UA,
    Referer: `${BASE}/`,
  };

  // 已是图片直链（webp/jpg/png/gif）
  if (/\.(webp|jpe?g|png|gif|avif)(\?|$)/i.test(rawId)) {
    return {
      parse: 0, jx: 0, flag: 'E-Hentai',
      url: rawId,
      urls: [{ name: '原图', url: rawId }],
      header,
    };
  }

  // 是 /s/ 图片页：现场解析真实直链
  if (/e-hentai\.org\/s\//i.test(rawId)) {
    try {
      const html = await fetchHtml(rawId, 1);
      const im = html.match(/<img[^>]*id="img"[^>]*src="([^"]+)"/i);
      if (im) {
        let src = im[1].replace(/&amp;/g, '&');
        if (src.startsWith('//')) src = 'https:' + src;
        logI(`现场解析成功: ${src.slice(0, 90)}`);
        return {
          parse: 0, jx: 0, flag: 'E-Hentai',
          url: src,
          urls: [{ name: '原图', url: src }],
          header: Object.assign({}, header, { Referer: rawId }),
        };
      }
    } catch (e) {
      logI(`现场解析失败: ${e.message}`);
    }
    // 兜底：把图片页交给宿主
    return {
      parse: 1, jx: 0, flag: 'E-Hentai',
      url: rawId,
      urls: [{ name: '原图', url: rawId }],
      header: Object.assign({}, header, { Referer: rawId }),
    };
  }

  // 画廊 ID：gid/token → 取第一页
  if (/^\d+\/[0-9a-f]+$/i.test(rawId)) {
    const [gid, token] = rawId.split('/');
    try {
      const v = await fetchDetail(gid, token);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) {
        return {
          parse: /\.(webp|jpe?g|png|gif)(\?|$)/i.test(first.playId) ? 0 : 1,
          jx: 0, flag: 'E-Hentai',
          url: first.playId,
          urls: [{ name: '原图', url: first.playId }],
          header,
        };
      }
    } catch (_) {}
  }

  // 其它：当成 URL 交给宿主嗅探
  return {
    parse: 1, jx: 0, flag: 'E-Hentai',
    url: rawId,
    urls: [{ name: '原图', url: rawId }],
    header,
  };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const html = await fetchHtml(`${BASE}/`);
    list = parseList(html);
    logI(`home 返回 ${list.length} 条`);
  } catch (e) {
    logE(`home 异常: ${e.message}`);
  }
  return { class: cls, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const typeId = (params && (params.categoryId || params.type_id || params.tid)) || 'all';
  const page = Math.max(1, Number((params && params.page) || 1));
  // 游标式分页：page>1 时用 extend 里的 next，否则只能取第 1 页
  const nextUrl = params && (params.next || params.cursor);
  logI(`category type=${typeId} page=${page} next=${nextUrl || '-'}`);
  let list = [];
  let pagecount = page;
  try {
    const url = nextUrl || classBaseUrl(typeId);
    const html = await fetchHtml(url);
    list = parseList(html);
    const next = parseNextUrl(html, url);
    pagecount = next ? page + 1 : page;
    logI(`category 返回 ${list.length} 条，next=${next ? '有' : '无'}`);
  } catch (e) {
    logE(`category 异常: ${e.message}`);
  }
  return { page, pagecount, total: page * list.length, limit: list.length, list };
}

async function detail(params, context) {
  const idRaw = String((params && (params.id || params.vod_id || params.videoId)) || '').trim();
  logI(`detail id=${idRaw}`);
  if (!idRaw) return { list: [] };
  // 支持 gid/token 或完整 URL
  let gid = '';
  let token = '';
  const m1 = idRaw.match(/^(\d+)\/([0-9a-f]+)$/i);
  if (m1) { gid = m1[1]; token = m1[2]; }
  else {
    const m2 = idRaw.match(/\/g\/(\d+)\/([0-9a-f]+)/i);
    if (m2) { gid = m2[1]; token = m2[2]; }
  }
  if (!gid) {
    logE(`无法解析 gid/token: ${idRaw}`);
    return { list: [] };
  }
  try {
    const v = await fetchDetail(gid, token);
    if (!v) return { list: [] };
    logI(`detail 成功: ${v.vod_name}，${(v.vod_play_sources[0] && v.vod_play_sources[0].episodes.length) || 0} 页`);
    return { list: [v] };
  } catch (e) {
    logE(`detail 异常: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const wd = String((params && (params.wd || params.keyword || params.k)) || '').trim();
  const page = Math.max(1, Number((params && params.page) || 1));
  const nextUrl = params && (params.next || params.cursor);
  logI(`search wd=${wd} page=${page}`);
  if (!wd && !nextUrl) return { page, pagecount: 1, total: 0, limit: 0, list: [] };
  let list = [];
  let pagecount = page;
  try {
    const url = nextUrl || `${BASE}/?f_search=${encodeURIComponent(wd)}`;
    const html = await fetchHtml(url);
    list = parseList(html);
    const next = parseNextUrl(html, url);
    pagecount = next ? page + 1 : page;
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
