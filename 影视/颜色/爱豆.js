/**
 * @name 爱豆 (aida5)
 * @version 1.6.1
 * @description 爱豆 (w18.aida5.buzz)：AES-CBC+md5 签名接口逆向；修复封面（vodPic 为整段字节反转的 JPEG，脚本内反转并转 data:image/jpeg）与播放（失效的 vodPlayServer 改回主站 /api/m3u8/ 真实 m3u8）；/awsapi 的 POST 走原生 node https；跟随重定向、自动解压 gzip/br、镜像容灾；修复分类/搜索返回 page、limit 为字符串导致宿主 Go 结构体解析失败（改为数值）
 * @downloadURL https://w18.aida5.buzz/
 * @dependencies crypto
 *
 * 【环境变量】
 *  SITE_API                 主站地址，默认 https://w18.aida5.buzz
 *  AIDOU_MIRRORS            备用镜像域名（逗号分隔），主站不可达时自动切换
 *  AIDOU_TIMEOUT            API 请求超时毫秒，默认 15000
 *  AIDOU_PLAY_HOST          播放域名覆盖，默认沿用 SITE_API（站点下发的 vodPlayServer 已失效）
 *  AIDOU_COVER_TIMEOUT      封面二进制抓取超时，默认 8000
 *  AIDOU_COVER_CONCURRENCY  封面并发数，默认 6
 *  AIDOU_COVER_DISABLE      设为 1 关闭封面反转（回退原始 URL，仅排障用）
 */

let OmniBox;
try {
  OmniBox = require('omnibox_sdk');
} catch (_) {
  OmniBox = {
    log(l, m) { console.log(`[${l}] ${m}`); },
    request: null,
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
const crypto = require('crypto');
const zlib = require('zlib');

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

const SITE_API = (process.env.SITE_API || 'https://w18.aida5.buzz').replace(/\/+$/, '');
const DEFAULT_TIMEOUT = Number(process.env.AIDOU_TIMEOUT || 15000);
// 封面链路专属参数：站点封面是「字节反转的 JPEG」，需单独走二进制抓取 + 反转，
// 与 API 请求（AIDOU_TIMEOUT）不是同一条链路，故独立配置，且默认并发受限避免拖慢首屏。
const COVER_TIMEOUT = Number(process.env.AIDOU_COVER_TIMEOUT || 8000);
const COVER_CONCURRENCY = Number(process.env.AIDOU_COVER_CONCURRENCY || 6);
const COVER_DISABLE = process.env.AIDOU_COVER_DISABLE === '1';

const CATEGORIES = [
  { type_id: '1', type_name: '国产' },
  { type_id: '5', type_name: '传媒' },
  { type_id: '2', type_name: '日韩' },
  { type_id: '3', type_name: '欧美' },
  { type_id: '4', type_name: '动漫' },
  { type_id: '6', type_name: '免费' },
];

const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.type_id, c.type_name]));

function randStr(s) {
  return String(s).split('').reverse().join('');
}

function getRsaKey(t) {
  return randStr(String(t * 299) + '1');
}

function aesEncrypt(dataStr, t) {
  const keyStr = getRsaKey(t);
  const key = Buffer.from(keyStr, 'latin1');
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, key);
  let enc = cipher.update(dataStr, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

function aesDecrypt(encStr, t) {
  const keyStr = getRsaKey(t);
  const key = Buffer.from(keyStr, 'latin1');
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, key);
  let dec = decipher.update(encStr, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

function requestViaNode(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error(`redirect loop: ${urlStr}`));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const bodyBuf = options.body ? Buffer.from(options.body) : null;
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': `${u.origin}/`,
      'Origin': u.origin,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Encoding': 'gzip, deflate, br',
    }, options.headers || {});
    if (bodyBuf) headers['Content-Length'] = String(bodyBuf.length);

    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || DEFAULT_TIMEOUT,
    }, (res) => {
      const status = res.statusCode || 200;
      // 跟随重定向（301/302/303/307/308），修复站点跳转到可达镜像导致 body 为空、首页加载失败
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, u.href).href;
        return resolve(requestViaNode(nextUrl, options, redirectCount + 1));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        const finish = (body) => resolve({ statusCode: status, headers: res.headers, body });
        if (encoding === 'gzip') {
          zlib.gunzip(raw, (e, buf) => e ? finish(raw.toString('utf8')) : finish(buf.toString('utf8')));
        } else if (encoding === 'deflate') {
          zlib.inflate(raw, (e, buf) => e ? finish(raw.toString('utf8')) : finish(buf.toString('utf8')));
        } else if (encoding === 'br') {
          zlib.brotliDecompress(raw, (e, buf) => e ? finish(raw.toString('utf8')) : finish(buf.toString('utf8')));
        } else {
          finish(raw.toString('utf8'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 二进制抓取：与 requestViaNode 不同，这里必须保留原始 Buffer，不能 toString('utf8')，
// 否则反转封面字节会被破坏。用于站点把 JPEG 整段反转后伪装成 .ttf 的封面。
function fetchBinary(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error(`cover redirect loop: ${urlStr}`));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': `${SITE_API}/`,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: COVER_TIMEOUT,
    }, (res) => {
      const status = res.statusCode || 200;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, u.href).href;
        return resolve(fetchBinary(nextUrl, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        const finish = (buf) => resolve({ statusCode: status, body: buf });
        if (encoding === 'gzip') zlib.gunzip(raw, (e, x) => finish(e ? raw : x));
        else if (encoding === 'deflate') zlib.inflate(raw, (e, x) => finish(e ? raw : x));
        else if (encoding === 'br') zlib.brotliDecompress(raw, (e, x) => finish(e ? raw : x));
        else finish(raw);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('cover timeout')));
    req.end();
  });
}

// 站点封面 = 整段字节反转的 JPEG（前端 Boot.getCover: Uint8Array(e).reverse()）。
// 反转后校验 FFD8FF...FFD9，再产出 data URI 让宿主直接渲染，避免 .ttf 被当字体忽略。
function reverseCoverToDataUri(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  const reversed = Buffer.from(buf).reverse();
  const isJpeg = reversed[0] === 0xff && reversed[1] === 0xd8 && reversed[2] === 0xff;
  if (isJpeg) return `data:image/jpeg;base64,${reversed.toString('base64')}`;
  // 未被反转（本来就是正常图片）则原样返回，兼容站点后续改回直链
  const alreadyJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (alreadyJpeg) return `data:image/jpeg;base64,${buf.toString('base64')}`;
  if (isPng) return `data:image/png;base64,${buf.toString('base64')}`;
  return '';
}

// 进程内缓存：同一封面 URL 在 home/category/search/detail 反复出现时只抓一次
const coverCache = new Map();

async function resolveCover(url) {
  if (!url || COVER_DISABLE) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await fetchBinary(url);
    if (res.statusCode !== 200 || !res.body || !res.body.length) {
      coverCache.set(url, url);
      return url;
    }
    const dataUri = reverseCoverToDataUri(res.body);
    const out = dataUri || url;
    coverCache.set(url, out);
    return out;
  } catch (e) {
    await OmniBox.log('info', `[cover] 抓取失败 ${url}: ${e.message}`);
    coverCache.set(url, url);
    return url;
  }
}

// 限并发批量解析封面，失败不阻塞列表主链路
async function resolveCovers(list) {
  if (COVER_DISABLE || !Array.isArray(list) || !list.length) return list;
  const tasks = [];
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
  for (let i = 0; i < n; i++) tasks.push(worker());
  await Promise.all(tasks);
  return list;
}

// 镜像容灾：主站 w18 子域可能轮换，主站不可达时自动切换到备用镜像
const INITIAL_MIRRORS = (() => {
  const custom = (process.env.AIDOU_MIRRORS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return Array.from(new Set([SITE_API, ...custom]));
})();
let activeMirrors = [...INITIAL_MIRRORS];

async function unifiedRequest(url, options = {}) {
  if (typeof OmniBox?.request === 'function') {
    try {
      const res = await OmniBox.request(url, options);
      if (res && res.statusCode) return res;
    } catch (_) {}
  }
  return requestViaNode(url, options);
}

async function unifiedRequestWithFailover(url, options = {}) {
  const seen = new Set();
  for (const base of activeMirrors) {
    if (seen.has(base)) continue;
    seen.add(base);
    let target;
    try {
      const u = new URL(url);
      target = url.replace(/^https?:\/\/[^/]+/, base);
    } catch (_) {
      target = url;
    }
    try {
      // 优先走原生 node 请求：实测 OmniBox.request 在 POST /awsapi 时会改写 body/Content-Type，
      // 导致 Spring 后端返回 code:500「查询异常」；原生 https 直发已验证 200。
      const res = await requestViaNode(target, options);
      if (res && (res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 301)) {
        // 把成功主机置顶，后续复用
        activeMirrors = [base, ...activeMirrors.filter((m) => m !== base)];
        return res;
      }
      await OmniBox.log('info', `[net] ${base} 返回 status=${res?.statusCode}，尝试下一个镜像`);
    } catch (e) {
      await OmniBox.log('error', `[net] ${base} 原生请求失败: ${e.message}，尝试 SDK 兜底`);
      // 兜底：原生直连被沙箱限制时，退回 SDK 请求
      try {
        if (typeof OmniBox?.request === 'function') {
          const sdkRes = await OmniBox.request(target, options);
          if (sdkRes && (sdkRes.statusCode === 200 || sdkRes.statusCode === 302 || sdkRes.statusCode === 301)) {
            activeMirrors = [base, ...activeMirrors.filter((m) => m !== base)];
            return sdkRes;
          }
        }
      } catch (_) {}
    }
  }
  // 所有镜像都失败，最后再直连一次原始 url，让错误正常抛出
  return requestViaNode(url, options);
}

function cleanParams(params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = v;
  }
  return clean;
}

async function awsApi(path, params) {
  const t = Date.now();
  const dataStr = JSON.stringify(cleanParams(params));
  const md5Param = parseInt(randStr(String(parseInt(t * 177)) + '1')).toString(16);
  const encData = aesEncrypt(dataStr, t);
  const body = `data=${encodeURIComponent(encData)}`;
  const url = `${SITE_API}/awsapi${path}?md5=${md5Param}`;

  const res = await unifiedRequestWithFailover(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  let json;
  try { json = JSON.parse(res.body || '{}'); } catch (e) { throw new Error('JSON parse error'); }
  if (json.code !== 200) throw new Error(`API ${json.code}: ${json.message || ''}`);
  if (!json.data) return json;
  const dec = aesDecrypt(json.data, t);
  try { json.data = JSON.parse(dec); } catch (_) { json.data = dec; }
  return json;
}

function mapVod(v) {
  const typeId = String(v.typeId || v.type_id || '');
  const typeName = CATEGORY_MAP[typeId] || String(v.typeName || v.type_name || '');
  return {
    vod_id: String(v.vodId || v.id || ''),
    vod_name: String(v.vodName || v.name || ''),
    vod_pic: String(v.vodPic || ''),
    type_id: typeId,
    type_name: typeName,
    vod_remarks: String(v.vodDuration || v.vodRemarks || v.vod_remarks || ''),
    vod_year: String(v.vodYear || v.vod_year || ''),
    vod_douban_score: '',
  };
}

function wrapList(page, pagecount, total, limit, list, extra = {}) {
  const p = Number(page) || 1;
  const pc = Number(pagecount) || 0;
  const t = Number(total) || 0;
  const l = Number(limit) || list.length || 20;
  return {
    code: 1,
    msg: '数据列表',
    // 宿主 Go 结构体 SpiderCategoryResponse 的 page / limit 均为 int，
    // 这里必须是数值，输出字符串会导致 json: cannot unmarshal string into ... of type int。
    page: p,
    pagecount: pc,
    limit: l,
    total: t,
    list,
    ...extra,
  };
}

async function home(params, context) {
  try {
    await OmniBox.log('info', '[home] start');
    const data = await awsApi('/vod/search.php', {
      by: 'vod_hits',
      order: 'desc',
      page: 1,
      size: 24,
      extypes: '6',
    });
    const rows = (data.data && data.data.rows) || [];
    const classes = CATEGORIES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
    const list = await resolveCovers(rows.map(mapVod));
    await OmniBox.log('info', `[home] got ${list.length} 条，封面已解析`);
    return {
      class: classes,
      class_list: classes,
      list,
    };
  } catch (e) {
    await OmniBox.log('error', `[home] ${e.message}`);
    const classes = CATEGORIES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
    return { class: classes, class_list: classes, list: [] };
  }
}

async function category(params, context) {
  try {
    const p = params || {};
    const categoryId = String(p.categoryId || p.id || p.type_id || p.tid || p.t || '1');
    const page = Number(p.page || p.pg || 1);
    await OmniBox.log('info', `[category] id=${categoryId} page=${page} params=${JSON.stringify(p)}`);

    const queryParams = {
      type: categoryId,
      by: 'vod_time',
      order: 'desc',
      page: page,
      size: 24,
    };
    if (categoryId !== '6') queryParams.extypes = '6';

    const data = await awsApi('/vod/search.php', queryParams);
    const d = (data && data.data) || {};
    const rows = d.rows || [];
    const total = Number(d.total) || 0;
    const size = Number(d.size) || 24;
    const pagecount = size > 0 ? Math.ceil(total / size) : 0;
    const list = await resolveCovers(rows.map(mapVod));

    await OmniBox.log('info', `[category] id=${categoryId} got ${list.length} total=${total} pagecount=${pagecount}`);
    if (list[0]) await OmniBox.log('info', `[category] sample: ${list[0].vod_name} 封面=${list[0].vod_pic.slice(0, 40)}`);

    return wrapList(page, pagecount, total, size, list);
  } catch (e) {
    await OmniBox.log('error', `[category] ${e.message}`);
    return wrapList(1, 0, 0, 24, []);
  }
}

async function detail(params, context) {
  try {
    const p = params || {};
    const videoId = String(p.videoId || p.id || p.vod_id || p.ids || '');
    await OmniBox.log('info', `[detail] id=${videoId}`);
    if (!videoId) return { list: [] };

    const data = await awsApi('/vod/info.php', { id: videoId });
    const v = (data && data.data) || {};

    const playUrl = String(v.vodPlayUrl || '');
    const token = String(v.token || '');
    // 实测：vodPlayServer(ws1.lczzyr.top) 已失效 404；真实 m3u8 在主站 SITE_API + /api/m3u8/{code}.m3u8。
    // 优先主站绝对路径，token 作为兼容参数附在后；若将来站点恢复独立播放域，可用 AIDOU_PLAY_HOST 覆盖。
    const playHost = (process.env.AIDOU_PLAY_HOST || SITE_API).replace(/\/+$/, '');
    const buildPlay = (host) => {
      if (!playUrl) return '';
      let full;
      if (/^https?:\/\//i.test(playUrl)) full = playUrl;
      else full = `${host}/${playUrl.replace(/^\/+/, '')}`;
      if (token) full += (full.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
      return full;
    };
    const fullPlay = buildPlay(playHost);
    const typeId = String(v.typeId || v.type_id || '');
    const fromName = String(v.vodPlayFrom || '默认');

    const picUrl = String(v.vodPic || '');
    const vodPic = await resolveCover(picUrl);
    await OmniBox.log('info', `[detail] playHost=${playHost} fullPlay=${fullPlay} 封面=${vodPic ? vodPic.slice(0, 30) : '空'}`);

    const vod = {
      vod_id: String(v.vodId || videoId),
      vod_name: String(v.vodName || ''),
      vod_pic: vodPic,
      vod_content: String(v.vodTag || ''),
      vod_director: '',
      vod_actor: '',
      vod_area: '',
      vod_year: String(v.vodTime || '').slice(0, 4),
      vod_remarks: String(v.vodDuration || ''),
      vod_douban_score: '',
      type_name: CATEGORY_MAP[typeId] || '',
      vod_play_from: fullPlay ? fromName : '',
      vod_play_url: fullPlay ? `播放$${fullPlay}` : '',
      vod_play_sources: fullPlay ? [{
        name: fromName,
        episodes: [{ name: '播放', playId: fullPlay }],
      }] : [],
    };

    return { list: [vod] };
  } catch (e) {
    await OmniBox.log('error', `[detail] ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const p = params || {};
    const keyword = String(p.keyword || p.wd || p.key || '');
    const page = Number(p.page || p.pg || 1);
    await OmniBox.log('info', `[search] kw=${keyword} page=${page}`);

    const data = await awsApi('/vod/search.php', {
      keyword: keyword,
      by: 'vod_time',
      order: 'desc',
      page: page,
      size: 24,
    });
    const d = (data && data.data) || {};
    const rows = d.rows || [];
    const total = Number(d.total) || 0;
    const size = Number(d.size) || 24;
    const pagecount = size > 0 ? Math.ceil(total / size) : 0;

    const list = await resolveCovers(rows.map(mapVod));
    await OmniBox.log('info', `[search] kw=${keyword} got ${list.length}`);
    return wrapList(page, pagecount, total, size, list);
  } catch (e) {
    await OmniBox.log('error', `[search] ${e.message}`);
    return wrapList(1, 0, 0, 24, []);
  }
}

async function play(params, context) {
  try {
    const p = params || {};
    let playId = String(p.playId || p.url || p.id || '');
    await OmniBox.log('info', `[play] ${playId}`);
    if (!playId) return { parse: 0, url: '', urls: [] };

    // 归一化历史遗留 playId：老版本 detail 曾把失效的 vodPlayServer 域写进 playId，
    // 这里把非主站的 /api/m3u8/ 前缀强制切回 SITE_API，保证旧收藏/缓存也能播。
    const playHost = (process.env.AIDOU_PLAY_HOST || SITE_API).replace(/\/+$/, '');
    try {
      const u = new URL(playId);
      if (u.pathname.startsWith('/api/m3u8/') && u.origin !== playHost) {
        playId = `${playHost}${u.pathname}${u.search}`;
        await OmniBox.log('info', `[play] 归一化失效播放域 -> ${playId}`);
      }
    } catch (_) {}

    return {
      parse: 0,
      jx: 0,
      flag: 'play',
      url: playId,
      urls: [{ name: '播放', url: playId }],
      header: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': `${SITE_API}/`,
        'Origin': SITE_API,
      },
    };
  } catch (e) {
    await OmniBox.log('error', `[play] ${e.message}`);
    return { parse: 0, url: '', urls: [] };
  }
}
