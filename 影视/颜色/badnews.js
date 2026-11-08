/**
 * @name BadNews
 * @version 1.1.0
 * @description BadNews (bad.news) 采集源（OmniBox Spider，X/Twitter 成人短视频聚合）。
 *   站点为服务端直出（Lvv2 架构）：列表/详情页已内联真实播放地址 video.twimg.com 的
 *   mp4 / m3u8（data-source 直接挂在 <video> 标签上，twimg 开启 access-control-allow-origin:*
 *   可直连播放，parse=0）。脚本负责把站点路由（首页 / 热门 / 最新 / 得分 / 精选 / 短视频 /
 *   长视频）与搜索结果整理为标准 OmniBox 影视源；详情页仅取主视频（首个 <video>，位于
 *   “您可能感兴趣的”模块之前），避免把相关推荐误当成正片。
 *   网络层带三层容灾：HTTP 代理隧道（DNS 交代理侧）→ 宿主 SDK request → 抗 DNS 污染固定
 *   Cloudflare IP + SNI 直连；可识别并绕开 GFW 投毒 IP（如 31.13.84.2），并对 CF 451 区域
 *   封锁给出明确诊断日志。
 * @downloadURL https://raw.githubusercontent.com/omnibox-spider/main/影视/采集/badnews.js
 * @dependencies []
 *
 * 【环境变量】
 *   SITE_API         主站点基础地址，默认 https://bad.news（可选）
 *   BADNEWS_UA       自定义 User-Agent（可选）
 *   BADNEWS_PROXY    HTTP/HTTPS 代理地址，形如 http://127.0.0.1:7890 或
 *                     http://user:pass@host:port（可选，网络受限时必配）
 *                     兼容通用别名：HTTP_PROXY_URL / HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   BADNEWS_IP       手动指定 Cloudflare IP（逗号分隔多个，可选，覆盖内置列表）
 *   BADNEWS_PIN      设为 1 强制跳过系统 DNS、直接用内置 IP + SNI 直连（可选）
 *
 * 【说明】
 *   - 站点 /av、/dm 路由会跳转外部或为空，已剔除；可用分类见 ROUTES。
 *   - 列表页与详情页均内联 data-source，play 优先使用 detail 透传的地址，失败再回源详情页。
 *   - 若宿主 DNS 被污染（解析到 31.13.x 等投毒 IP）或出口被 CF 451 封锁，
 *     配置 BADNEWS_PROXY 后由代理侧完成 DNS 与出口，即可恢复访问。
 */

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) { OmniBox = { log(l, m) { console.log(`[${l}] ${m}`); }, getCache() { return null; }, setCache() { return Promise.resolve(); }, deleteCache() { return Promise.resolve(); } }; }
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const https = require('https');
const http = require('http');
const tls = require('tls');
const dns = require('dns');

const SITE_API = (process.env.SITE_API || 'https://bad.news').replace(/\/+$/, '');
const USER_AGENT = process.env.BADNEWS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PREFIX = '[BadNews]';
const PAGE_SIZE = 20; // 仅用于分页估算，站点无官方 page size

// ===== 网络容灾配置 =====
// 代理：站点专用变量优先，其次复用仓库常见通用命名（HTTP_PROXY_URL / HTTPS_PROXY ...）
const PROXY_URL = String(
  process.env.BADNEWS_PROXY || process.env.HTTP_PROXY_URL ||
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || ''
).trim();
// bad.news 位于 Cloudflare；内置真实边缘 IP，供宿主 DNS 被污染时 SNI 直连使用
const PINNED_IPS = (process.env.BADNEWS_IP
  ? process.env.BADNEWS_IP.split(/[,;\s]+/).filter(Boolean)
  : ['104.26.13.211', '104.26.12.211', '172.67.73.102']);
const FORCE_PIN = String(process.env.BADNEWS_PIN || '') === '1';
// 常见 GFW DNS 投毒 / 黑洞网段（命中即判定为污染，弃用系统解析结果）
const POISON_PREFIXES = ['31.13.', '243.185.187.', '59.24.', '78.16.', '159.106.', '37.61.', '8.7.198.', '46.82.', '61.54.'];
function isPoisoned(ip) {
  if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return true;
  return ip === '0.0.0.0' || ip === '127.0.0.1' || POISON_PREFIXES.some((p) => ip.startsWith(p));
}
// 自定义 lookup：系统 DNS 干净则沿用，被污染则回退内置 Cloudflare IP（SNI 仍用原域名）
const safeLookup = (hostname, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (FORCE_PIN) return opts && opts.all ? cb(null, [{ address: PINNED_IPS[0], family: 4 }]) : cb(null, PINNED_IPS[0], 4);
  dns.lookup(hostname, { all: true }, (err, arr) => {
    const v4 = (arr || []).filter((a) => a && a.family === 4).map((a) => a.address);
    const clean = v4.filter((ip) => !isPoisoned(ip));
    const chosen = (!err && clean.length) ? clean[0] : PINNED_IPS[0];
    if (chosen !== (v4[0] || '')) logI(`[net] DNS ${hostname} 系统解析=${v4.join(',') || '空'} 判定污染/失效 -> 改用 ${chosen}`);
    return opts && opts.all ? cb(null, [{ address: chosen, family: 4 }]) : cb(null, chosen, 4);
  });
};

// 日志包装
function logI(m) { try { OmniBox.log('info', `${PREFIX} ${m}`); } catch (_) {} }
function logE(m) { try { OmniBox.log('error', `${PREFIX} ${m}`); } catch (_) {} }

// SDK 缓存包装（失败安全降级，绝不阻断主链路）
async function cacheGet(key) {
  try { const v = await OmniBox.getCache(key); return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v); } catch (_) { return null; }
}
async function cacheSet(key, val, ttl) {
  try { await OmniBox.setCache(key, JSON.stringify(val), ttl || 1800); } catch (_) {}
}

// 站点分类路由（剔除了 /av、/dm 这类死链）
const CLASS_CONFIG = [
  { type_id: 'home', type_name: '首页热门' },
  { type_id: 'hot', type_name: '热门' },
  { type_id: 'new', type_name: '最新' },
  { type_id: 'score', type_name: '得分' },
  { type_id: 'better', type_name: '精选' },
  { type_id: 'porn', type_name: '短视频' },
  { type_id: 'long-porn', type_name: '长视频' },
];
const ROUTES = {
  home: '/',
  hot: '/sort-hot',
  new: '/sort-new',
  score: '/sort-score',
  better: '/sort-better',
  porn: '/tag/porn',
  'long-porn': '/tag/long-porn',
};

// 限并发执行器
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; }
    }
  }
  const n = Math.max(1, Math.min(limit || 4, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// 统一请求头
function buildHeaders(u, extra) {
  return Object.assign(
    { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'identity', Host: u.host, Connection: 'close' },
    extra || {}
  );
}
function collect(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
  });
}

// 路径 A：HTTP 代理（CONNECT 隧道）。DNS 解析发生在代理侧，天然绕开宿主污染 + CF 区域封锁。
function requestViaProxy(u, headers, timeout) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(PROXY_URL); } catch (e) { return reject(new Error(`BADNEWS_PROXY 非法: ${PROXY_URL}`)); }
    const pIsHttps = p.protocol === 'https:';
    const pClient = pIsHttps ? https : http;
    const pPort = p.port || (pIsHttps ? 443 : 80);
    const proxyAuth = p.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`).toString('base64') : '';
    const connectHeaders = { Host: `${u.hostname}:${u.port || 443}`, 'Proxy-Connection': 'keep-alive' };
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;
    const cReq = pClient.request({
      protocol: p.protocol, hostname: p.hostname, port: pPort, method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`, headers: connectHeaders, timeout, rejectUnauthorized: false,
    });
    cReq.on('connect', (cRes, socket) => {
      if (cRes.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理 CONNECT 失败 HTTP ${cRes.statusCode}`)); }
      const tlsSocket = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: false }, () => {
        let raw = `GET ${u.pathname + u.search} HTTP/1.1\r\n`;
        Object.keys(headers).forEach((k) => { raw += `${k}: ${headers[k]}\r\n`; });
        raw += '\r\n';
        tlsSocket.write(raw);
      });
      const chunks = [];
      let settled = false;
      const finish = (err, out) => { if (settled) return; settled = true; try { tlsSocket.destroy(); } catch (_) {} err ? reject(err) : resolve(out); };
      tlsSocket.setTimeout(timeout, () => finish(new Error('代理请求超时')));
      tlsSocket.on('error', (e) => finish(e));
      tlsSocket.on('data', (chunk) => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const head = buf.slice(0, sep).toString('utf-8');
        const sm = head.match(/^HTTP\/1\.[01] (\d{3})/);
        if (!sm) return;
        const status = parseInt(sm[1], 10);
        const hdr = {};
        head.split('\r\n').slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) hdr[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
        const enc = (hdr['transfer-encoding'] || '').toLowerCase();
        let bodyBuf = buf.slice(sep + 4);
        // 处理 chunked：等最后一个 0\r\n\r\n 结束块
        if (enc.includes('chunked')) {
          const end = bodyBuf.indexOf('\r\n0\r\n\r\n');
          if (end < 0) return; // 数据未收完，继续等
          bodyBuf = dechunk(bodyBuf.slice(0, end));
        } else {
          const cl = parseInt(hdr['content-length'] || '0', 10);
          if (cl > 0 && bodyBuf.length < cl) return;
          bodyBuf = bodyBuf.slice(0, cl || bodyBuf.length);
        }
        finish(null, { statusCode: status, headers: hdr, body: bodyBuf.toString('utf-8') });
      });
    });
    cReq.on('error', reject);
    cReq.on('timeout', () => { cReq.destroy(); reject(new Error('代理连接超时')); });
    cReq.end();
  });
}
function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.slice(i, nl).toString('utf-8').split(';')[0], 16);
    if (!size || isNaN(size)) break;
    i = nl + 2;
    if (i + size > buf.length) break;
    out.push(buf.slice(i, i + size));
    i += size + 2;
  }
  return Buffer.concat(out);
}

// 路径 B：宿主 SDK request（走宿主网络栈，部分宿主有独立 DNS / 内置代理）
async function requestViaSdk(urlStr, headers) {
  if (!OmniBox || typeof OmniBox.request !== 'function') throw new Error('宿主未提供 OmniBox.request');
  const r = await OmniBox.request(urlStr, { method: 'GET', headers });
  if (!r || typeof r.statusCode !== 'number') throw new Error('SDK request 返回结构异常');
  return { statusCode: r.statusCode, headers: r.headers || {}, body: String(r.body || '') };
}

// 路径 C：原生直连（safeLookup 自动识别污染 IP 并回退内置 Cloudflare IP + SNI）
function requestDirect(u, headers, timeout) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers, timeout, rejectUnauthorized: false, servername: u.hostname, lookup: safeLookup },
      (res) => resolve({ statusCode: res.statusCode, headers: res.headers, body: null, _res: res })
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}
async function requestDirectFull(u, headers, timeout) {
  const r = await requestDirect(u, headers, timeout);
  if (r._res) { const c = await collect(r._res); return c; }
  return r;
}

// 给任意 Promise 套超时，防止宿主 SDK 请求挂死
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);
}

// 统一入口：跟随重定向；三层容灾；451 明确诊断
async function httpRequest(urlStr, options = {}, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('重定向过多');
  let u;
  try { u = new URL(urlStr); } catch (e) { throw e; }
  const headers = buildHeaders(u, options.headers);
  const timeout = options.timeout || 20000;
  const chain = [];
  if (PROXY_URL) chain.push(['proxy', () => withTimeout(requestViaProxy(u, headers, timeout), timeout + 2000, 'proxy')]);
  chain.push(['sdk', () => withTimeout(requestViaSdk(urlStr, headers), timeout, 'sdk')]);
  chain.push(['direct', () => withTimeout(requestDirectFull(u, headers, timeout), timeout + 2000, 'direct')]);

  let lastErr = null, result = null, via = '', fallbackResult = null, fallbackVia = '';
  for (const [name, fn] of chain) {
    try {
      const r = await fn();
      if (r.statusCode === 451) {
        logE(`[net] ${name} 返回 451（Cloudflare 区域封锁 error code:1026），出口 IP 被拦，需配置 BADNEWS_PROXY`);
      }
      // 2xx / 3xx 视为成功；451 / 5xx 记为兜底后继续尝试下一条路径
      if (r.statusCode >= 200 && r.statusCode < 400 && r.statusCode !== 451) {
        result = r; via = name; break;
      }
      fallbackResult = r; fallbackVia = name;
    } catch (e) {
      lastErr = e;
      logI(`[net] ${name} 失败: ${e.code || ''} ${e.message}`);
    }
  }
  if (!result && fallbackResult) { result = fallbackResult; via = fallbackVia; }
  if (!result) throw new Error(`全部网络路径失败: ${lastErr ? (lastErr.code || '') + ' ' + lastErr.message : 'unknown'}`);
  logI(`[net] ${urlStr} -> HTTP ${result.statusCode} via ${via}, body=${(result.body || '').length}B`);

  // 重定向（仅对 3xx 且非外部 whos.tv，避免死循环）
  if ([301, 302, 303, 307, 308].includes(result.statusCode) && result.headers && result.headers.location) {
    let next;
    try { next = new URL(result.headers.location, u.href).href; } catch (_) { next = ''; }
    if (next && !/whos\.tv/i.test(next)) return httpRequest(next, options, redirectCount + 1);
  }
  return result;
}

// 清理标题里的空白/换行
function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
// 去掉 HTML 标签，保留文本
function stripTags(s) {
  return cleanText(String(s || '').replace(/<[^>]+>/g, ' '));
}
// HTML 实体解码
function htmlDecode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// 从一段 HTML 里取第一个 <video> 的 data-source / data-type / poster
function extractFirstVideo(html, beforeMarker) {
  let seg = html;
  if (beforeMarker) {
    const idx = html.indexOf(beforeMarker);
    if (idx > -1) seg = html.slice(0, idx); // 只取主视频区，排除“您可能感兴趣的”推荐
  }
  const re = /<video\b[^>]*\bdata-source="([^"]+)"[^>]*\bdata-type="([^"]+)"[^>]*>/g;
  let m, best = null;
  while ((m = re.exec(seg)) !== null) {
    const posterM = m[0].match(/poster="([^"]+)"/);
    best = { source: m[1], type: m[2], poster: posterM ? posterM[1] : '' };
    break; // 取第一个即主视频
  }
  return best;
}

// 解析列表页：按 <div class="link show ..."> 切分条目
function parseList(html) {
  const items = [];
  const blocks = html.split(/<div class="link show[ "]/).slice(1);
  for (const blk of blocks) {
    const tidM = blk.match(/data-tid="(\d+)"/);
    if (!tidM) continue;
    const tid = tidM[1];
    // 标题：<a class="title" ...>文本</a>（嵌套在 h3 里）
    const titleM = blk.match(/<a class="title"[^>]*>([\s\S]*?)<\/a>/);
    let title = titleM ? stripTags(titleM[1]) : '';
    if (!title) {
      const h3M = blk.match(/<h3 class="title">([\s\S]*?)<\/h3>/);
      if (h3M) title = stripTags(h3M[1]);
    }
    // 标签（分类）：<h4 class="label label-info">...</h4>
    const tagM = blk.match(/<h4 class="label label-info"[^>]*>([\s\S]*?)<\/h4>/);
    const tag = tagM ? stripTags(tagM[1]).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '') : '';
    // 时间
    const timeM = blk.match(/<time[^>]*>([\s\S]*?)<\/time>/);
    const timeText = timeM ? stripTags(timeM[1]) : '';
    // 列表内已内联的视频（供 play 兜底）
    const vid = extractFirstVideo(blk);
    items.push({
      tid,
      title: title || `BadNews ${tid}`,
      tag,
      timeText,
      poster: vid ? vid.poster : '',
      media: vid ? vid.source : '',
    });
  }
  return items;
}

function itemToVod(it) {
  return {
    vod_id: it.tid,
    vod_name: it.title.slice(0, 100),
    vod_pic: it.poster || '',
    type_name: it.tag || '成人短视频',
    vod_remarks: it.timeText || '',
    vod_tag: 'video',
    _media: it.media,
  };
}

// 是否有下一页（分页区出现 next-page 链接；站点“下一页”文本包在子 span 里，故优先按 class 判断）
function hasNextPage(html) {
  if (/class="[^"]*next-page[^"]*"/.test(html)) return true;
  if (/下一页<\/a>/.test(html)) return true;
  if (/href="[^"]*page-\d+"[^>]*>\s*下一页/.test(html)) return true;
  return false;
}

async function fetchRoute(route, page) {
  let url;
  if (route === '/') {
    url = page > 1 ? `${SITE_API}/page-${page}` : `${SITE_API}/`;
  } else {
    const base = route.replace(/\/$/, '');
    url = page > 1 ? `${SITE_API}${base}/page-${page}` : `${SITE_API}${base}`;
  }
  logI(`[fetchRoute] ${url}`);
  const res = await httpRequest(url, { headers: { Referer: `${SITE_API}/` } });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return res.body;
}

// 抓详情页（带轻量缓存，避免宿主重复请求同一 tid 时反复打站点）
async function fetchDetail(tid) {
  const key = `badnews:detail:${tid}`;
  let cached = await cacheGet(key);
  if (cached && cached.html) {
    logI(`[detail] ${tid} 命中缓存`);
    return cached;
  }
  const url = `${SITE_API}/t/${tid}`;
  logI(`[detail] ${url}`);
  const res = await httpRequest(url, { headers: { Referer: `${SITE_API}/` } });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  const html = res.body;
  const meta = (name) => {
    const m = html.match(new RegExp('<meta (?:property|name)="' + name + '"[^>]*content="([^"]*)"'));
    return m ? htmlDecode(m[1].replace(/&amp;/g, '&')) : '';
  };
  const video = extractFirstVideo(html, '您可能感兴趣的');
  const item = {
    tid,
    ogTitle: meta('og:title'),
    ogImage: meta('og:image'),
    ogDesc: meta('og:description'),
    poster: video ? video.poster : '',
    media: video ? video.source : '',
    mediaType: video ? video.type : '',
    html,
  };
  await cacheSet(key, item, 1800);
  return item;
}

// 解析任意参数里的 tid（支持裸 ID、/t/ 链接、twimg URL）
function resolveTid(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(?:bad\.news\/t\/|twimg\.com\/[a-z_]+\/|status\/)(\d{6,})/) || s.match(/^(\d{6,})$/);
  return m ? m[1] : '';
}

function emptyList(page) {
  return { page: page || 1, pagecount: 1, limit: PAGE_SIZE, total: 0, list: [] };
}

async function home(params) {
  logI(`[home] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const html = await fetchRoute('/', 1);
    const list = parseList(html).map(itemToVod);
    logI(`[home] 返回 ${list.length} 条`);
    return { class: CLASS_CONFIG, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CLASS_CONFIG, list: [] };
  }
}

async function category(params) {
  logI(`[category] 入口参数=${JSON.stringify(params || {})}`);
  const cid = String((params && (params.categoryId || params.type_id || params.tid)) || 'home').trim();
  const route = ROUTES[cid] || ROUTES.home;
  const page = Math.max(1, parseInt((params && (params.page || params.pg)) || 1, 10) || 1);
  try {
    const html = await fetchRoute(route, page);
    const list = parseList(html).map(itemToVod);
    const pagecount = hasNextPage(html) ? page + 1 : Math.max(1, page);
    logI(`[category] ${cid} page=${page} 返回 ${list.length} 条, pagecount=${pagecount}`);
    return { page, pagecount, limit: PAGE_SIZE, total: (page - 1) * PAGE_SIZE + list.length, list };
  } catch (e) {
    logE(`[category] ${cid} 失败: ${e.message}`);
    return emptyList(page);
  }
}

async function search(params) {
  logI(`[search] 入口参数=${JSON.stringify(params || {})}`);
  const kw = String((params && (params.keyword || params.wd || params.key || params.q)) || '').trim();
  if (!kw) return emptyList(1);
  const page = Math.max(1, parseInt((params && (params.page || params.pg)) || 1, 10) || 1);
  try {
    const path = `/search/q-${encodeURIComponent(kw)}/via-log${page > 1 ? '/page-' + page : ''}`;
    const url = `${SITE_API}${path}`;
    logI(`[search] ${url}`);
    const res = await httpRequest(url, { headers: { Referer: `${SITE_API}/` } });
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
    const list = parseList(res.body).map(itemToVod);
    const pagecount = hasNextPage(res.body) ? page + 1 : Math.max(1, page);
    logI(`[search] "${kw}" page=${page} 返回 ${list.length} 条`);
    return { page, pagecount, limit: PAGE_SIZE, total: (page - 1) * PAGE_SIZE + list.length, list };
  } catch (e) {
    logE(`[search] "${kw}" 失败: ${e.message}`);
    return emptyList(page);
  }
}

async function detail(params) {
  logI(`[detail] 入口参数=${JSON.stringify(params || {})}`);
  const raw = typeof params === 'string' ? params : (params && (params.videoId || params.vod_id || params.id || params.playId)) || '';
  const tid = resolveTid(raw);
  if (!tid) { logE(`[detail] 无法解析 tid: ${String(raw).slice(0, 80)}`); return { list: [] }; }
  try {
    const d = await fetchDetail(tid);
    // 标题：优先详情页主视频区标题，其次 og:title
    const titleM = d.html.match(/<a class="title"[^>]*>([\s\S]*?)<\/a>/);
    let title = titleM ? stripTags(titleM[1]) : '';
    if (!title) title = cleanText(d.ogTitle);
    if (!title) title = `BadNews ${tid}`;
    const pic = d.poster || d.ogImage || '';
    const desc = d.ogDesc || '';
    // playId 透传 tid + 主视频地址（twimg 直链），play 直接 parse:0
    const playId = `${tid}|||${d.media || ''}`;
    logI(`[detail] ${title.slice(0, 40)} 封面=${pic ? '有' : '无'} 地址=${d.media ? '有' : '无'}`);
    return {
      list: [{
        vod_id: tid,
        vod_name: title.slice(0, 100),
        vod_pic: pic,
        type_name: '成人短视频',
        vod_remarks: '',
        vod_content: desc,
        vod_play_from: 'BadNews',
        vod_play_url: `播放$${playId}`,
        vod_play_sources: [{ name: 'BadNews', episodes: [{ name: '播放', playId }] }],
      }]
    };
  } catch (e) {
    logE(`[detail] ${tid} 失败: ${e.message}`);
    return { list: [] };
  }
}

async function play(params) {
  logI(`[play] 入口参数=${JSON.stringify(params || {})}`);
  const raw = typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id)) || '';
  const s = String(raw).trim();
  const header = { 'User-Agent': USER_AGENT, Referer: `${SITE_API}/`, Origin: SITE_API, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  try {
    // playId 形如 tid|||mediaUrl（detail 透传）；也兼容裸 tid / URL
    let tid = '', carried = '';
    const bar = s.indexOf('|||');
    if (bar > -1) { tid = resolveTid(s.slice(0, bar)); carried = s.slice(bar + 3); }
    else tid = resolveTid(s);

    let media = (carried && /^https?:\/\//.test(carried)) ? carried : '';
    if (!media && tid) {
      // 回源详情页拿主视频地址
      try {
        const d = await fetchDetail(tid);
        media = d.media || '';
      } catch (e) { logE(`[play] 回源 ${tid} 失败: ${e.message}`); }
    }
    if (!media) {
      logE(`[play] ${tid || s.slice(0, 40)} 未提取到直链`);
      return { urls: tid ? [{ name: '嗅探播放頁', url: `${SITE_API}/t/${tid}` }] : [], header, parse: 1 };
    }
    logI(`[play] ${tid} -> ${media.slice(0, 70)}`);
    // twimg 开启 CORS(*)，直连即可播放
    return {
      urls: [{ name: 'BadNews', url: media }],
      flag: 'BadNews',
      header,
      parse: 0,
    };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    const tid = resolveTid(s);
    return { urls: tid ? [{ name: '嗅探播放頁', url: `${SITE_API}/t/${tid}` }] : [], header, parse: 1 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
