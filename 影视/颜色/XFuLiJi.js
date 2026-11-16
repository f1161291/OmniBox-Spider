// @name XFuLiJi
// @author 宝宝巴士
// @description X（推特）图片视频聚合站 xfuliji.org：最新/用户/搜索/详情/播放；媒体取 data-link（video 为 m3u8、image 为原图）
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/XFuLiJi.js
// @dependencies []
/**
 * ============================================================================
 * XFuLiJi（xfuliji.org）OmniBox 采集源
 * ============================================================================
 *
 * 【站点性质（2026-11-16 实测）】
 *   X（Twitter）图片/视频聚合站，Go 后端 + 服务端渲染 HTML。
 *   ⚠️ 根路径 / 直接返回 404「页面不存在」，首页真实入口是 /latest。
 *
 * 【路由（全部实测）】
 *   首页最新：/latest                              → HTML，10 条 tweet-card
 *   加载更多：/list?page={n}&size=10               → JSON {code,message,data,has_more}
 *             data 字段是一段 HTML 字符串（内含 tweet-card），不是结构化数据
 *   用户页：  /x/{username}                        → HTML
 *   推文详情：/x/{username}/{tweetId}              → HTML
 *   搜索：    /search/{keyword}                    → HTML，真实过滤
 *   搜索分页：/search/{keyword}/{n}                → HTML
 *   用户清单：/sitemap/users                       → XML，实测 2464 个用户
 *
 * 【分页坑（实测结论）】
 *   /x/{username}/2         → 404
 *   /x/{username}?page=2    → 返回和第一页完全相同的内容（无效）
 *   用户页没有 load-more 触发器，只能取第一页。
 *   /search/{keyword}?page=2 → 无效（和第一页相同）
 *   /search/{keyword}/2      → 有效（首条 gid 不同）
 *   /list?page=N&size=10     → 有效（不同 page 首条 gid 不同）
 *   /list?keyword=xx         → 无效（三个不同关键词返回同一批）
 *
 * 【搜索坑】
 *   /search/tweets?q=xx   → 返回固定 10 条，完全不按关键词过滤（假搜索）
 *   /search?keyword=xx    → 301 跳到 /search/xx
 *   /search/{keyword}     → ✅ 真实过滤（zzzznotexist12345 返回 0 条）
 *
 * 【媒体结构】
 *   <div class="gallery grid-video" data-id="{tweetId}">
 *     <div class="img-ratio is-video">
 *       <img src="{缩略图}" data-link="{真实地址}" data-type="video|image" data-index="0">
 *     </div>
 *   </div>
 *   data-type=video → data-link 是 https://video.twimg.com/.../xxx.m3u8?tag=16
 *   data-type=image → data-link 是 https://pbs.twimg.com/media/xxx.jpg?format=webp&name=large
 *   详情页另有 JSON-LD 的 VideoObject.contentUrl，可作兜底。
 *   ⚠️ HTML 里 &amp; 必须还原成 &，否则 twimg 会 403。
 *
 * 【环境变量】
 *   XFLJ_HOST        站点地址，默认 https://xfuliji.org
 *   XFLJ_UA          自定义 User-Agent
 *   XFLJ_PROXY       代理（http:// 或 socks5://）
 *   XFLJ_PAGE_SIZE   每次加载条数，默认 10
 *   XFLJ_USERS       自定义首页用户列表（逗号分隔 username），覆盖默认
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

const PREFIX = '[xflj]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.XFLJ_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = (process.env.XFLJ_HOST || 'https://xfuliji.org').replace(/\/+$/, '');
const PAGE_SIZE = (() => {
  const raw = String(process.env.XFLJ_PAGE_SIZE || '').trim();
  const n = raw === '' ? 10 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
})();

/* ---------------- 代理 ---------------- */
const PROXY_URL = String(process.env.XFLJ_PROXY || process.env.UPSTREAM_HTTP_PROXY_URL || '').trim();
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
    'Accept': options.json
      ? 'application/json, text/javascript, */*; q=0.01'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': `${HOST}/latest`,
    'X-Requested-With': 'XMLHttpRequest',
  }, options.headers || {});

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

async function fetchHtml(url, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await httpGet(url);
      if (res.statusCode >= 200 && res.statusCode < 400) return res.body;
      lastErr = new Error(`HTTP ${res.statusCode}`);
      if (res.statusCode === 404) return '';
    } catch (e) { lastErr = e; }
    if (i < retries) await new Promise((r) => setTimeout(r, 700));
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

/** 还原 HTML 实体（URL 用，&amp; 不还原会导致 twimg 403） */
function fixUrl(u) {
  return String(u || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

/* ---------------- 列表解析 ---------------- */
/**
 * 解析 tweet-card 列表。
 * 结构：<article class="tweet-card" id="tweet-{id}" data-tweet-id="{id}">
 *         <div class="tweet-header">...<a class="name" href="/x/{user}">名字</a>
 *           <a class="handle" href="/x/{user}">@user</a>
 *           <a rel="nofollow" href="/x/{user}/{id}">2026.11.14 03:05</a>
 *         <div class="tweet-text">正文</div>
 *         <div class="gallery grid-video" data-id="{id}">
 *           <div class="img-ratio is-video">
 *             <img src="{thumb}" data-link="{真实}" data-type="video" data-index="0">
 */
function parseTweets(html) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  // 用 article.tweet-card 切块
  const cardRe = /<article[^>]*class="[^"]*tweet-card[^"]*"([^>]*)>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = cardRe.exec(s)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const idM = attrs.match(/data-tweet-id="(\d+)"/i) || (m[0].match(/id="tweet-(\d+)"/i));
    const tid = idM ? idM[1] : '';
    if (!tid || seen.has(tid)) continue;

    // 用户名 / 显示名
    let user = '';
    let name = '';
    const userM = body.match(/<a[^>]*class="[^"]*handle[^"]*"[^>]*href="\/x\/([^"]+)"[^>]*>([^<]*)<\/a>/i)
      || body.match(/href="\/x\/([^"\/]+)"[^>]*>@([^<]*)</i);
    if (userM) {
      user = userM[1];
      name = cleanText(userM[2]).replace(/^@/, '');
    }
    if (!user) {
      const anyU = body.match(/href="\/x\/([A-Za-z0-9_]+)"/);
      if (anyU) user = anyU[1];
    }
    if (!name) {
      const n2 = body.match(/<a[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      if (n2) name = cleanText(n2[1]);
    }

    // 正文
    let text = '';
    const tx = body.match(/<div[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (tx) text = cleanText(tx[1]);

    // 时间
    let time = '';
    const tm = body.match(/href="\/x\/[^"]+\/(\d+)"[^>]*>([^<]*)</i);
    if (tm) time = cleanText(tm[2]);

    // 媒体：img[data-link]
    const medias = [];
    const imgRe = /<img[^>]*data-link="([^"]+)"[^>]*data-type="([^"]+)"[^>]*>/gi;
    let im;
    while ((im = imgRe.exec(body)) !== null) {
      const link = fixUrl(im[1]);
      const type = String(im[2]).toLowerCase();
      if (!link) continue;
      if (!medias.some((x) => x.url === link)) medias.push({ url: link, type });
    }
    // 反向属性顺序兜底
    const imgRe2 = /<img[^>]*data-type="([^"]+)"[^>]*data-link="([^"]+)"[^>]*>/gi;
    while ((im = imgRe2.exec(body)) !== null) {
      const link = fixUrl(im[2]);
      const type = String(im[1]).toLowerCase();
      if (!link) continue;
      if (!medias.some((x) => x.url === link)) medias.push({ url: link, type });
    }

    // 缩略图：必须排除头像（class="avatar" / profile_images），
    // 优先取 img-ratio 容器里的媒体缩略图，再退到第一张非头像图。
    let thumb = '';
    const ratio = body.match(/<div[^>]*class="[^"]*img-ratio[^"]*"[^>]*>[\s\S]{0,400}?<img[^>]*src="([^"]+)"/i);
    if (ratio) thumb = fixUrl(ratio[1]);
    if (!thumb) {
      const imgScan = /<img[^>]*>/gi;
      let i3;
      while ((i3 = imgScan.exec(body)) !== null) {
        const tag = i3[0];
        if (/class="[^"]*avatar[^"]*"/i.test(tag)) continue;
        if (/profile_images/i.test(tag)) continue;
        const sm = tag.match(/src="([^"]+)"/i);
        if (sm) { thumb = fixUrl(sm[1]); break; }
      }
    }
    if (!thumb && medias.length) thumb = medias[0].url;

    const hasVideo = medias.some((x) => x.type === 'video');
    const title = text ? text.slice(0, 80) : (name ? `${name} 的推文` : `推文 ${tid}`);

    seen.add(tid);
    list.push({
      vod_id: `${user || 'unknown'}/${tid}`,
      vod_name: title,
      vod_pic: thumb,
      vod_remarks: [
        hasVideo ? '视频' : '图片',
        medias.length ? `${medias.length}P` : '',
        time,
      ].filter(Boolean).join(' · '),
      vod_actor: name || user,
      vod_content: text,
      vod_tag: 'video',
      vod_url: user ? `${HOST}/x/${user}/${tid}` : '',
      _tid: tid,
      _user: user,
      _medias: medias,
    });
  }
  return list;
}

/* ---------------- 分类 ---------------- */
const DEFAULT_USERS = [
  'tongtong0401', 'elonmusk', 'NBA', 'SpaceX', 'MrBeast', 'Tesla', 'arigameplays',
];
const CLASSES = [
  { type_id: 'latest', type_name: '最新' },
  ...DEFAULT_USERS.map((u) => ({ type_id: `u:${u}`, type_name: `@${u}` })),
];

/** 解析分类 type_id → 列表 URL */
function classUrl(typeId, page) {
  const t = String(typeId || 'latest').trim();
  if (t.startsWith('u:')) {
    const user = t.slice(2);
    // 用户页无有效分页，只取第一页
    return `${HOST}/x/${encodeURIComponent(user)}`;
  }
  if (t === 'latest' || t === 'all' || !t) {
    return page > 1
      ? `${HOST}/list?page=${page}&size=${PAGE_SIZE}`
      : `${HOST}/latest`;
  }
  return `${HOST}/latest`;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(user, tid) {
  const cacheKey = `xflj:detail:${tid}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id) return obj;
    }
  } catch (_) {}

  const url = `${HOST}/x/${encodeURIComponent(user)}/${tid}`;
  const html = await fetchHtml(url);
  if (!html) return null;

  // 标题
  const tm = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  let title = cleanText(tm ? tm[1] : '');
  title = title.replace(/\s*[-|]\s*XFuLiJi\s*$/i, '').trim();

  // 正文
  let text = '';
  const tx = html.match(/<div[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (tx) text = cleanText(tx[1]);
  if (!text) {
    const og = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i);
    if (og) text = cleanText(og[1]);
  }

  // 时间
  let time = '';
  const tt = html.match(/<a[^>]*rel="nofollow"[^>]*href="\/x\/[^"]+\/\d+"[^>]*>([^<]*)<\/a>/i);
  if (tt) time = cleanText(tt[1]);

  // 媒体
  const medias = [];
  const imgRe = /<img[^>]*data-link="([^"]+)"[^>]*data-type="([^"]+)"[^>]*>/gi;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    const link = fixUrl(im[1]);
    const type = String(im[2]).toLowerCase();
    if (link && !medias.some((x) => x.url === link)) medias.push({ url: link, type });
  }
  const imgRe2 = /<img[^>]*data-type="([^"]+)"[^>]*data-link="([^"]+)"[^>]*>/gi;
  while ((im = imgRe2.exec(html)) !== null) {
    const link = fixUrl(im[2]);
    const type = String(im[1]).toLowerCase();
    if (link && !medias.some((x) => x.url === link)) medias.push({ url: link, type });
  }
  // JSON-LD 兜底（VideoObject.contentUrl）
  if (!medias.some((x) => x.type === 'video')) {
    const ld = html.match(/"contentUrl"\s*:\s*"([^"]+)"/i);
    if (ld) {
      const u = fixUrl(ld[1].replace(/\\\//g, '/'));
      if (u && !medias.some((x) => x.url === u)) medias.push({ url: u, type: 'video' });
    }
  }

  // 封面：优先媒体缩略图，其次 og:image，最后非头像图。
  // 注意头像（profile_images / class="avatar"）不能当封面。
  let pic = '';
  const ratio2 = html.match(/<div[^>]*class="[^"]*img-ratio[^"]*"[^>]*>[\s\S]{0,400}?<img[^>]*src="([^"]+)"/i);
  if (ratio2) pic = fixUrl(ratio2[1]);
  if (!pic) {
    const og = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
    if (og && !/profile_images/i.test(og[1])) pic = fixUrl(og[1]);
  }
  if (!pic) {
    const imgScan2 = /<img[^>]*>/gi;
    let i4;
    while ((i4 = imgScan2.exec(html)) !== null) {
      const tag = i4[0];
      if (/class="[^"]*avatar[^"]*"/i.test(tag)) continue;
      if (/profile_images/i.test(tag)) continue;
      const sm = tag.match(/src="([^"]+)"/i);
      if (sm) { pic = fixUrl(sm[1]); break; }
    }
  }
  if (!pic && medias.length) pic = medias[0].url;

  // 分集：每个媒体一集
  const episodes = medias.map((x, i) => ({
    name: x.type === 'video' ? `视频${medias.filter((y) => y.type === 'video').length > 1 ? i + 1 : ''}` : `图片${i + 1}`,
    playId: x.url,
  }));

  const vod = {
    vod_id: `${user}/${tid}`,
    vod_name: title || `推文 ${tid}`,
    vod_pic: pic,
    vod_actor: `@${user}`,
    vod_content: [
      text,
      time ? `时间：${time}` : '',
      `原帖：https://x.com/${user}/status/${tid}`,
    ].filter(Boolean).join('\n'),
    vod_remarks: [
      medias.some((x) => x.type === 'video') ? '视频' : '图片',
      medias.length ? `${medias.length}P` : '',
    ].filter(Boolean).join(' · '),
    vod_play_sources: episodes.length ? [{ name: 'XFuLiJi', episodes }] : [],
    _user: user,
    _tid: tid,
    _medias: medias,
  };
  if (episodes.length) {
    vod.vod_play_from = 'XFuLiJi';
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join('#');
  }
  try { await OmniBox.setCache(cacheKey, vod, 3600); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 110)} from=${(context && context.from) || 'web'}`);

  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const url = fixUrl(rawId);
  const header = {
    'User-Agent': UA,
    Referer: `${HOST}/`,
  };

  // m3u8 / mp4 直链
  if (/\.(m3u8|mp4)(\?|$)/i.test(url)) {
    return {
      parse: 0, jx: 0, flag: 'XFuLiJi',
      url,
      urls: [{ name: '视频', url }],
      header: Object.assign({}, header, { Referer: 'https://x.com/' }),
    };
  }

  // 图片直链（twimg）
  if (/\.(webp|jpe?g|png|gif|avif)(\?|$)/i.test(url) || /pbs\.twimg\.com/i.test(url)) {
    return {
      parse: 0, jx: 0, flag: 'XFuLiJi',
      url,
      urls: [{ name: '图片', url }],
      header,
    };
  }

  // 推文 ID（user/tid）：现场解析
  if (/^[A-Za-z0-9_]+\/\d+$/.test(url)) {
    const [u, t] = url.split('/');
    try {
      const v = await fetchDetail(u, t);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) {
        const pu = fixUrl(first.playId);
        return {
          parse: /\.(m3u8|mp4)(\?|$)/i.test(pu) || /twimg\.com/i.test(pu) ? 0 : 1,
          jx: 0, flag: 'XFuLiJi',
          url: pu,
          urls: [{ name: '媒体', url: pu }],
          header,
        };
      }
    } catch (_) {}
  }

  return {
    parse: 1, jx: 0, flag: 'XFuLiJi',
    url,
    urls: [{ name: '媒体', url }],
    header,
  };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const html = await fetchHtml(`${HOST}/latest`);
    list = parseTweets(html);
    logI(`home 返回 ${list.length} 条`);
  } catch (e) {
    logE(`home 异常: ${e.message}`);
  }
  return { class: cls, filters: {}, list, parse: 0, jx: 0 };
}

async function category(params, context) {
  const typeId = (params && (params.categoryId || params.type_id || params.tid)) || 'latest';
  const page = Math.max(1, Number((params && params.page) || 1));
  logI(`category type=${typeId} page=${page}`);
  let list = [];
  let hasMore = false;
  try {
    const url = classUrl(typeId, page);
    if (String(typeId).startsWith('u:') && page > 1) {
      // 用户页无有效分页
      logI(`用户页不支持分页，返回空`);
      return { page, pagecount: 1, total: 0, limit: 0, list: [] };
    }
    if (/\/list\?/.test(url)) {
      // JSON 接口，data 字段是 HTML 片段
      const raw = await fetchHtml(url);
      let payload = null;
      try { payload = JSON.parse(raw); } catch (_) {}
      if (payload && typeof payload.data === 'string') {
        list = parseTweets(payload.data);
        hasMore = !!payload.has_more;
        logI(`category(list) 返回 ${list.length} 条，has_more=${hasMore}`);
      } else {
        logI(`list 接口解析失败，回退 HTML`);
        list = parseTweets(raw);
      }
    } else {
      const html = await fetchHtml(url);
      list = parseTweets(html);
      logI(`category 返回 ${list.length} 条`);
    }
  } catch (e) {
    logE(`category 异常: ${e.message}`);
  }
  const pagecount = hasMore ? page + 1 : page;
  return { page, pagecount, total: page * list.length, limit: list.length, list };
}

async function detail(params, context) {
  const idRaw = String((params && (params.id || params.vod_id || params.videoId)) || '').trim();
  logI(`detail id=${idRaw}`);
  if (!idRaw) return { list: [] };
  let user = '';
  let tid = '';
  const m1 = idRaw.match(/^([A-Za-z0-9_]+)\/(\d+)$/);
  if (m1) { user = m1[1]; tid = m1[2]; }
  else {
    const m2 = idRaw.match(/\/x\/([A-Za-z0-9_]+)\/(\d+)/i);
    if (m2) { user = m2[1]; tid = m2[2]; }
    else if (/^\d+$/.test(idRaw)) { tid = idRaw; }
  }
  if (!tid) {
    logE(`无法解析 user/tid: ${idRaw}`);
    return { list: [] };
  }
  if (!user) {
    // 只有 tid 时无法定位详情页，返回空
    logE(`缺少 username，无法定位详情页: ${idRaw}`);
    return { list: [] };
  }
  try {
    const v = await fetchDetail(user, tid);
    if (!v) return { list: [] };
    logI(`detail 成功: ${v.vod_name.slice(0, 40)}，${(v.vod_play_sources[0] && v.vod_play_sources[0].episodes.length) || 0} 个媒体`);
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
    // 真实搜索路由：/search/{keyword}，分页 /search/{keyword}/{n}
    // 注意：/search/tweets?q=xx 是假搜索（永远返回同一批），不能用
    const url = page > 1
      ? `${HOST}/search/${encodeURIComponent(wd)}/${page}`
      : `${HOST}/search/${encodeURIComponent(wd)}`;
    const html = await fetchHtml(url);
    list = parseTweets(html);
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount: list.length >= 8 ? page + 1 : page, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
