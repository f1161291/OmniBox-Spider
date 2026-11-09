/**
 * @name 吃瓜
 * @version 1.3.1
 * @description 吃瓜 (chigua.com / 51cg)：修复封面（CDN 图片为 AES-128-CBC 加密的密文，脚本内解密还原为 data:image；详情页改取 itemprop="image" 主图）、内置多域名容灾与动态跳转解析、自适应 Node.js http/https 回退机制、Mirages文章列表解析与 DPlayer m3u8 双码率提取
 * @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/51吃瓜.js
 * @dependencies crypto
 *
 * 【环境变量】
 *  SITE_API                  主站点基础地址，默认 https://chigua.com
 *  CHIGUA_MIRRORS            备用镜像域名列表，逗号分隔
 *  CHIGUA_UA                 自定义 User-Agent（可选）
 *  CHIGUA_COVER_TIMEOUT      封面二进制抓取/解密超时毫秒，默认 8000
 *  CHIGUA_COVER_CONCURRENCY  封面并发数，默认 6
 *  CHIGUA_COVER_DISABLE      设为 1 关闭封面解密（回退原始 URL，仅排障用）
 */

let OmniBox;
try {
  OmniBox = require('omnibox_sdk');
} catch (_) {
  OmniBox = {
    log(l, m) {
      console.log(`[${l}] ${m}`);
    },
    getCache() {
      return null;
    },
    setCache() {
      return Promise.resolve();
    },
  };
}

let runner;
try {
  runner = require('spider_runner');
} catch (_) {
  runner = { run() {} };
}

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const SITE_API = (process.env.SITE_API || 'https://chigua.com').replace(/\/+$/, '');
const USER_AGENT =
  process.env.CHIGUA_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 站点 CDN 图片是 AES-128-CBC 加密后的密文（Content-Type: binary/octet-stream），
// 前端 image.20261027.002.min.js 的 decryptjs 用固定 key/iv 解密后再渲染。
// 参数来自前端混淆字符码：key=f5d965df75336270, iv=97b60394abc2fbe1（CBC + Pkcs7）。
const COVER_AES_KEY = Buffer.from('f5d965df75336270', 'latin1');
const COVER_AES_IV = Buffer.from('97b60394abc2fbe1', 'latin1');
const COVER_TIMEOUT = Number(process.env.CHIGUA_COVER_TIMEOUT || 8000);
const COVER_CONCURRENCY = Number(process.env.CHIGUA_COVER_CONCURRENCY || 6);
const COVER_DISABLE = process.env.CHIGUA_COVER_DISABLE === '1';

// 初始种子镜像池（包含直连域名与官方实时反代节点）
const INITIAL_MIRRORS = (() => {
  const custom = (process.env.CHIGUA_MIRRORS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const defaults = [
    SITE_API,
    'https://4je6q.bqoscqfmm.cc',
    'https://39b.eyjqoobi.cc',
    'https://chigua.com',
    'https://cgwz32.com',
  ];
  return Array.from(new Set([...custom, ...defaults]));
})();

let activeMirrors = [...INITIAL_MIRRORS];
let currentActiveBase = INITIAL_MIRRORS[0];

const DEFAULT_CLASSES = [
  { type_id: 'all', type_name: '全部最新' },
  { type_id: '51djc', type_name: '51大瓜' },
  { type_id: 'whhl', type_name: '网红黑料' },
  { type_id: 'mrdg', type_name: '明星大瓜' },
  { type_id: 'rdsj', type_name: '热点事件' },
  { type_id: 'hwcg', type_name: '海外吃瓜' },
  { type_id: 'cgxw', type_name: '吃瓜新闻' },
  { type_id: 'gcjq', type_name: '国产剧场' },
  { type_id: 'snsn', type_name: '少女私密' },
  { type_id: 'jpll', type_name: '极品猎奇' },
];

/**
 * 原生 Node.js 请求，带超时、重定向与自动解压支持
 */
function requestViaNode(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error(`重定向过多: ${urlStr}`));
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }

    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const reqHeaders = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Referer: `${u.origin}/`,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Connection: 'close',
      },
      options.headers || {}
    );

    const req = client.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: reqHeaders,
        timeout: options.timeout || 8000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, u.href).href;
          return requestViaNode(nextUrl, options, redirectCount + 1).then(resolve).catch(reject);
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`请求超时 (${options.timeout || 8000}ms)`));
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * 二进制抓取：保留原始 Buffer，不能 toString('utf-8')，否则 AES 密文会被破坏。
 * 带重定向跟随与 gzip/deflate/br 解压。
 */
function fetchBinary(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error(`封面重定向过多: ${urlStr}`));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: `${u.origin}/`,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: COVER_TIMEOUT,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, u.href).href;
          return resolve(fetchBinary(nextUrl, redirectCount + 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          const finish = (buf) => resolve({ statusCode: res.statusCode || 200, body: buf });
          if (encoding === 'gzip') zlib.gunzip(raw, (e, x) => finish(e ? raw : x));
          else if (encoding === 'deflate') zlib.inflate(raw, (e, x) => finish(e ? raw : x));
          else if (encoding === 'br') zlib.brotliDecompress(raw, (e, x) => finish(e ? raw : x));
          else finish(raw);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('封面请求超时')));
    req.end();
  });
}

/** 与前端 is_cdnimg 一致：只有这些路径下的图被加密，需要解密 */
function isCdnImg(url) {
  if (typeof url !== 'string' || !url) return false;
  return ['/xiao/', '/upload/upload/', '/upload_01/', '/uploads/'].some((seg) => url.includes(seg));
}

/** 探测图片真实类型（解密后），返回 mime；无法识别返回空 */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

/** AES-CBC 解密密文二进制，还原为真实图片 base64 */
function decryptCoverBytes(raw) {
  // 已是普通图片则原样返回
  const plainType = sniffImageType(raw);
  if (plainType) return { mime: plainType, body: raw };
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', COVER_AES_KEY, COVER_AES_IV);
    const out = Buffer.concat([decipher.update(raw), decipher.final()]);
    const mime = sniffImageType(out);
    if (mime) return { mime, body: out };
  } catch (e) {
    // 解密失败（可能是非加密图或算法变更），交给调用方回退
  }
  return null;
}

const coverCache = new Map();

/** 解析单张封面：加密图 -> 解密 -> data URI；非加密图/失败则回退原 URL */
async function resolveCover(url) {
  if (!url || COVER_DISABLE) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  // 非 CDN 图片无需解密，直接返回（前端也是原样直出）
  if (!isCdnImg(url)) {
    coverCache.set(url, url);
    return url;
  }
  try {
    const res = await fetchBinary(url);
    if (res.statusCode !== 200 || !res.body || !res.body.length) {
      coverCache.set(url, url);
      return url;
    }
    const decoded = decryptCoverBytes(res.body);
    if (!decoded) {
      coverCache.set(url, url);
      return url;
    }
    const dataUri = `data:${decoded.mime};base64,${decoded.body.toString('base64')}`;
    coverCache.set(url, dataUri);
    return dataUri;
  } catch (e) {
    await OmniBox.log('info', `[cover] 抓取/解密失败 ${url}: ${e.message}`);
    coverCache.set(url, url);
    return url;
  }
}

/** 限并发批量解析封面，失败不阻塞列表主链路 */
async function resolveCovers(list) {
  if (COVER_DISABLE || !Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      const item = list[idx];
      if (item && item.vod_pic) {
        try { item.vod_pic = await resolveCover(item.vod_pic); } catch (_) {}
      }
    }
  };
  const n = Math.min(COVER_CONCURRENCY, list.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return list;
}

/**
 * 带有 SDK 优先 + 原生 Node 回退的单请求
 */
async function fetchSingle(url) {
  if (typeof OmniBox !== 'undefined' && typeof OmniBox.request === 'function') {
    try {
      const res = await OmniBox.request(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: `${new URL(url).origin}/`,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (res && res.body) return res.body;
    } catch (e) {
      await OmniBox.log('info', `[chigua] OmniBox.request 失败 (${e.message})，转入底层直连`);
    }
  }

  const res = await requestViaNode(url);
  return res && res.body ? res.body : '';
}

/**
 * 校验并自动解开 JS 跳转页 (如 <script>window.location.replace(...)</script>)
 */
async function resolvePageContent(initialBody) {
  if (!initialBody) return '';
  const jumpMatch = initialBody.match(/href=["'](https?:\/\/[^"']+)["']/i);
  if (initialBody.length < 800 && (initialBody.includes('location.replace') || initialBody.includes('加载中')) && jumpMatch) {
    const jumpUrl = jumpMatch[1];
    await OmniBox.log('info', `[chigua] 识别到中转跳转链接: ${jumpUrl}`);
    try {
      const targetBody = await fetchSingle(jumpUrl);
      if (targetBody && (targetBody.includes('post-card') || targetBody.includes('archives') || targetBody.includes('Mirages'))) {
        const targetOrigin = new URL(jumpUrl).origin;
        if (!activeMirrors.includes(targetOrigin)) {
          activeMirrors.push(targetOrigin);
        }
        currentActiveBase = targetOrigin;
        return targetBody;
      }
    } catch (e) {
      await OmniBox.log('error', `[chigua] 跳转解析失败: ${e.message}`);
    }
  }
  return initialBody;
}

/**
 * 带多域名容灾与故障转移的 HTML 抓取
 */
async function fetchHtmlWithFailover(pathOrUrl) {
  let relativePath = pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    try {
      const u = new URL(pathOrUrl);
      relativePath = u.pathname + u.search;
    } catch (_) {}
  }
  if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;

  const candidates = [currentActiveBase, ...activeMirrors.filter((m) => m !== currentActiveBase)];

  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i];
    const fullUrl = base + relativePath;
    try {
      await OmniBox.log('info', `[chigua] 尝试拉取 [${i + 1}/${candidates.length}]: ${fullUrl}`);
      let body = await fetchSingle(fullUrl);
      body = await resolvePageContent(body);

      if (body && (body.includes('post-card') || body.includes('archives') || body.includes('Mirages') || body.length > 500)) {
        currentActiveBase = base;
        return body;
      }
      await OmniBox.log('info', `[chigua] ${base} 返回内容未匹配到文章或结构 (长度: ${body ? body.length : 0})`);
    } catch (err) {
      await OmniBox.log('error', `[chigua] ${base} 连接失败: ${err.message}`);
    }
  }

  await OmniBox.log('error', `[chigua] 所有候选域名均不可达`);
  return '';
}

function parseListFromHtml(html, baseUrl) {
  const list = [];
  const seen = new Set();
  const currentBase = baseUrl || currentActiveBase;

  // 1. 抓取 Mirages 主题标准卡片: <article ...>
  const articleRegex = /<article[\s\S]*?<\/article>/gi;
  let articleMatch;

  while ((articleMatch = articleRegex.exec(html)) !== null) {
    const cardHtml = articleMatch[0];
    if (/class=["'][^"']*ad-item[^"']*["']/i.test(cardHtml)) continue;

    const linkM = cardHtml.match(/href=["'](?:https?:\/\/[^"']*)?\/archives\/(\d+)\/?["']/i);
    if (!linkM) continue;

    const id = linkM[1];
    if (seen.has(id)) continue;

    let title = '';
    const titleM =
      cardHtml.match(/<h2[^>]*class=["'][^"']*post-card-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i) ||
      cardHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (titleM) {
      title = titleM[1].replace(/<[^>]+>/g, '').trim();
    }
    if (!title) continue;

    seen.add(id);

    // 封面提取：覆盖 z-bg-loader-url / x-bg-loader-url / data-original / z-image-loader-url 等自定义属性
    let pic = '';
    const picAttrMatch = cardHtml.match(/(?:[a-z0-9_-]*(?:bg|image|thumb|loader|original|src)[a-z0-9_-]*)=["']\s*([^"'\s>]+\.(?:jpg|jpeg|png|webp|gif)[^"'\s>]*)/i);
    if (picAttrMatch) {
      pic = picAttrMatch[1];
    } else {
      const picUrlMatch = cardHtml.match(/https?:\/\/[^"'\s>]+\.(?:jpg|jpeg|png|webp)[^"'\s>]*/i);
      if (picUrlMatch) pic = picUrlMatch[0];
    }

    if (pic) {
      if (pic.startsWith('//')) pic = 'https:' + pic;
      else if (pic.startsWith('/')) pic = currentBase + pic;
    }

    let remarks = '';
    const timeM = cardHtml.match(/<span[^>]*itemprop=["']datePublished["'][^>]*>([\s\S]*?)<\/span>/i);
    if (timeM) {
      remarks = timeM[1].replace(/<[^>]+>/g, '').replace(/•/g, '').trim();
    }

    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: remarks,
      type_name: '吃瓜',
    });
  }

  // 2. 兜底正则
  if (list.length === 0) {
    const fallbackRegex = /<a[^>]+href=["'](?:https?:\/\/[^"']*)?\/archives\/(\d+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = fallbackRegex.exec(html)) !== null) {
      const id = m[1];
      const rawText = m[2].replace(/<[^>]+>/g, '').trim();
      if (!rawText || rawText.length < 5 || seen.has(id)) continue;
      seen.add(id);
      list.push({
        vod_id: id,
        vod_name: rawText,
        vod_pic: '',
        vod_remarks: '',
        type_name: '吃瓜',
      });
    }
  }

  return list;
}

/**
 * 首页
 */
async function home(params, context) {
  try {
    await OmniBox.log('info', `[home] context.from=${context?.from || 'web'}`);
    const html = await fetchHtmlWithFailover('/');
    const list = await resolveCovers(parseListFromHtml(html, currentActiveBase));
    const coverOk = list.filter((x) => x.vod_pic && x.vod_pic.startsWith('data:')).length;
    await OmniBox.log('info', `[home] got ${list.length} 条，封面已解密 ${coverOk}/${list.length}`);

    const classes = [...DEFAULT_CLASSES];
    const catRegex = /href=["'](?:https?:\/\/[^"']*)?\/category\/([a-zA-Z0-9_\-]+)\/?["'][^>]*>([^<]+)<\/a>/gi;
    let catMatch;
    const catSeen = new Set(classes.map((c) => c.type_id));
    while ((catMatch = catRegex.exec(html)) !== null) {
      const type_id = catMatch[1];
      const type_name = catMatch[2].trim();
      if (type_id && type_name && !catSeen.has(type_id) && type_name.length <= 10 && !/[\r\n]/.test(type_name)) {
        catSeen.add(type_id);
        classes.push({ type_id, type_name });
      }
    }

    return {
      class: classes,
      list,
    };
  } catch (err) {
    await OmniBox.log('error', `[home] err: ${err.message}`);
    return {
      class: DEFAULT_CLASSES,
      list: [],
    };
  }
}

/**
 * 分类列表
 */
async function category(params, context) {
  try {
    const { categoryId = 'all', page = 1 } = params || {};
    await OmniBox.log('info', `[category] categoryId=${categoryId}, page=${page}`);

    let path = '/';
    if (categoryId && categoryId !== 'all') {
      path = `/category/${categoryId}/`;
      if (page > 1) {
        path = `/category/${categoryId}/page/${page}/`;
      }
    } else {
      if (page > 1) {
        path = `/page/${page}/`;
      }
    }

    const html = await fetchHtmlWithFailover(path);
    const list = await resolveCovers(parseListFromHtml(html, currentActiveBase));
    await OmniBox.log('info', `[category] got ${list.length} 条，封面已解密 ${list.filter((x) => x.vod_pic && x.vod_pic.startsWith('data:')).length}/${list.length}`);

    let pagecount = Number(page);
    const pageMatches = html.match(/\/page\/(\d+)\/?/g) || [];
    for (const pm of pageMatches) {
      const num = parseInt(pm.replace(/[^0-9]/g, ''), 10);
      if (num && num > pagecount) pagecount = num;
    }

    return {
      page: Number(page),
      pagecount,
      total: pagecount * 15,
      list,
    };
  } catch (err) {
    await OmniBox.log('error', `[category] err: ${err.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 详情页
 */
async function detail(params, context) {
  try {
    const { videoId } = params || {};
    if (!videoId) return { list: [] };

    await OmniBox.log('info', `[detail] videoId=${videoId}`);
    const html = await fetchHtmlWithFailover(`/archives/${videoId}/`);

    let title = `吃瓜视频 ${videoId}`;
    const titleM =
      html.match(/<h1[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titleM) {
      title = titleM[1].replace(/<[^>]+>/g, '').trim();
    }

    // 详情页封面：真实主图在 <meta itemprop="image" content=".../upload_01/xiao/...">，
    // og:image 是 social-default.jpg 占位图，旧的通用属性正则还会命中 icon-black.png 图标，都不能用。
    let pic = '';
    const itemImage = html.match(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']image["']/i);
    if (itemImage && itemImage[1]) {
      pic = itemImage[1];
    } else {
      // 兜底：详情页里第一条 CDN 加密图（排除广告 /hc237/、图标、占位图）
      const cdn = html.match(/https?:\/\/[^"'\s>]+\/(?:upload_01|xiao|uploads)\/[^"'\s>]+\.(?:jpe?g|png|webp|gif)[^"'\s>]*/i);
      if (cdn) pic = cdn[0];
    }
    if (pic) {
      if (pic.startsWith('//')) pic = 'https:' + pic;
      else if (pic.startsWith('/')) pic = currentActiveBase + pic;
      pic = await resolveCover(pic);
    }
    if (pic) await OmniBox.log('info', `[detail] 封面=${pic.slice(0, 40)}`);

    let content = '';
    const descM =
      html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (descM) {
      content = descM[1].trim();
    }

    const defaultEpisodes = [];
    const h265Episodes = [];

    // 提取 DPlayer 播放器配置
    const dplayerRegex = /class=["'][^"']*dplayer[^"']*["'][^>]*data-config=(['"])([\s\S]*?)\1/gi;
    let dpMatch;
    let epIndex = 1;

    while ((dpMatch = dplayerRegex.exec(html)) !== null) {
      let rawConfig = dpMatch[2];
      try {
        rawConfig = rawConfig
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/&amp;/g, '&');
        const cfg = JSON.parse(rawConfig);

        const videoUrl = cfg.video?.url || '';
        const h265Url = cfg.video_h265?.url || '';

        if (videoUrl) {
          defaultEpisodes.push({
            name: `片段 ${epIndex}`,
            playId: videoUrl,
          });
        }

        if (h265Url) {
          h265Episodes.push({
            name: `片段 ${epIndex} (高清)`,
            playId: h265Url,
          });
        }

        epIndex++;
      } catch (e) {
        await OmniBox.log('error', `[detail] parse dplayer config failed: ${e.message}`);
      }
    }

    // 兜底正则提取 m3u8
    if (defaultEpisodes.length === 0) {
      const m3u8Regex = /https?:\\?\/\\?\/[^"'<>\s]+\.m3u8[^"'<>\s]*/gi;
      let m;
      const seenUrls = new Set();
      while ((m = m3u8Regex.exec(html)) !== null) {
        const cleanUrl = m[0].replace(/\\/g, '');
        if (!seenUrls.has(cleanUrl)) {
          seenUrls.add(cleanUrl);
          defaultEpisodes.push({
            name: `视频 ${defaultEpisodes.length + 1}`,
            playId: cleanUrl,
          });
        }
      }
    }

    const playSources = [];
    if (defaultEpisodes.length > 0) {
      playSources.push({
        name: '默认播放',
        episodes: defaultEpisodes,
      });
    }
    if (h265Episodes.length > 0) {
      playSources.push({
        name: 'H265高清',
        episodes: h265Episodes,
      });
    }

    return {
      list: [
        {
          vod_id: String(videoId),
          vod_name: title,
          vod_pic: pic,
          vod_content: content,
          type_name: '吃瓜',
          vod_play_sources: playSources.length > 0 ? playSources : undefined,
        },
      ],
    };
  } catch (err) {
    await OmniBox.log('error', `[detail] err: ${err.message}`);
    return { list: [] };
  }
}

/**
 * 搜索
 */
async function search(params, context) {
  try {
    const keyword = params?.keyword || params?.wd || '';
    const page = params?.page || 1;
    if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };

    await OmniBox.log('info', `[search] keyword=${keyword}, page=${page}`);
    let searchPath = `/search/${encodeURIComponent(keyword)}/`;
    if (page > 1) {
      searchPath = `/search/${encodeURIComponent(keyword)}/page/${page}/`;
    }

    let html = await fetchHtmlWithFailover(searchPath);

    if (!html || !html.includes('/archives/')) {
      const queryPath = page > 1 ? `/page/${page}/?s=${encodeURIComponent(keyword)}` : `/?s=${encodeURIComponent(keyword)}`;
      html = await fetchHtmlWithFailover(queryPath);
    }

    const list = await resolveCovers(parseListFromHtml(html, currentActiveBase));
    await OmniBox.log('info', `[search] kw=${keyword} got ${list.length} 条，封面已解密 ${list.filter((x) => x.vod_pic && x.vod_pic.startsWith('data:')).length}/${list.length}`);

    return {
      page: Number(page),
      pagecount: list.length > 0 ? page + 1 : page,
      total: list.length,
      list,
    };
  } catch (err) {
    await OmniBox.log('error', `[search] err: ${err.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 播放
 */
async function play(params, context) {
  try {
    const { playId, flag = 'play' } = params || {};
    if (!playId) throw new Error('playId 不能为空');

    await OmniBox.log('info', `[play] playId=${playId}, flag=${flag}`);

    const parse = /\.(m3u8|mp4)($|\?)/i.test(playId) ? 0 : 1;

    return {
      urls: [{ name: '播放', url: playId }],
      flag,
      header: {
        'User-Agent': USER_AGENT,
        Referer: `${currentActiveBase}/`,
        Origin: currentActiveBase,
      },
      parse,
    };
  } catch (err) {
    await OmniBox.log('error', `[play] err: ${err.message}`);
    return { urls: [], flag: params?.flag || 'play', header: {}, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
