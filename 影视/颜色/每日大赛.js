// @name 每日大赛
// @author 宝宝巴士
// @description 每日大赛（mrds66.com）：WordPress Mirages 主题；分类/搜索/详情/播放；DPlayer data-config 直取 m3u8；图床图片 AES-128-CBC 加密，脚本内解密还原为 data:image；从发布页 ukcyeyqpp.cc + GitLab README 自动获取最新域名防失联
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/每日大赛.js
// @dependencies crypto
/**
 * ============================================================================
 * 每日大赛（mrds66.com）OmniBox 采集源
 * ============================================================================
 *
 * 【站点事实（2026-11-16 实测）】
 *   程序：WordPress + Mirages 主题（和 51吃瓜.js 同款）
 *   主站：https://www.mrds66.com/             （46KB 首页，60 个 archives 链接）
 *   同构备用主站：https://mrds.com/           （同样 46KB、60 个 archives）
 *   首页列表：/                              （article > a[href=/archives/{id}/] > div.post-card）
 *   分类：/category/{slug}/                  （实测 /category/mrds/ 返回 60 条）
 *   分页：/page/{n}/                        （首页分页，首页可达 2030 页）
 *   归档：/archives.html、/archives/page/{n}/
 *   搜索：/search/{关键词}/                  （★ ?s= 和 /?s= 都会 302，不能用）
 *   详情：/archives/{id}/
 *
 * 【列表卡片结构】
 *   <article itemscope itemtype="...BlogPosting">
 *     <meta itemprop="url mainEntityOfPage" content="/archives/201159/" />
 *     <a href="/archives/201159/">
 *       <div class="post-card" id="post-card-201159">
 *         <script>loadBannerDirect('https://pic.gyezbp.cn/.../xxx.jpeg', ...)</script>
 *         <h2 class="post-card-title" itemprop="headline">标题 <div class="wrap">热搜 HOT</div></h2>
 *         <div class="post-card-info"><span itemprop="author">赛里木 • </span>
 *           <span itemprop="datePublished" content="2026-11-10T08:30:00+08:00">2026 年 11 月 10 日 • </span>
 *           <span>每日大赛, 必撸大赛</span></div>
 *   ⚠️ 封面不在 <img>，而在 loadBannerDirect('URL', ...) 的 JS 参数里。
 *
 * 【详情 / 播放】
 *   <div class="dplayer" data-video_id="201869001" data-config='{"...","video":{"url":"https:\/\/hls.ohjzmm.cn\/...\/x.m3u8?auth_key=...&v=3&time=0","type":"hls"}}'>
 *   真实 m3u8 在 data-config 的 JSON 里，含 \u002f / \/ 转义必须还原。
 *   实测 HTTP 200，标准 AES-128 HLS（EXT-X-KEY + crypt.key + seg_*.ts）。
 *   封面：<meta itemprop="image" content="https://pic.gyezbp.cn/.../xxx.jpeg">
 *   ⚠️ 图床图片（pic.gyezbp.cn）是 AES-128-CBC 加密密文（Content-Type:
 *     binary/octet-stream，非标准图片格式），前端用 tbxw/zzz.js 的 decryptImage
 *     解密后再渲染。脚本需用相同密钥解密，输出 data:image/jpeg;base64,...
 *     密钥/IV 来自前端混淆字符码：key=f5d965df75336270, iv=97b60394abc2fbe1
 *     （CBC + Pkcs7）。与 51吃瓜.js 共用同一图床，密钥相同。
 *   标题：<h1>标题</h1>
 *
 * 【自动获取最新域名（本需求核心）】
 *   用户给的 https://www.ukcyeyqpp.cc/ 是**中转发布页**（title「每日大赛官网」），
 *   正文里用 <a href="https://www.mrds66.com/">每日大赛</a> 指向当前主站。
 *
 *   完整链路实测：
 *     GitLab README (gitlab.com/mrds/mrds/-/raw/main/README.md)
 *       → 列出「最新官网 mrdsv8.com」「备用线路 mrdst2.com / mrdsv7.com」
 *       → 这些是 310B 的 JS 中转页（<a href="https://www.ukcyeyqpp.cc/"> + click()）
 *       → 跳回发布页 ukcyeyqpp.cc
 *       → 发布页给出当前主站 www.mrds66.com
 *     README 里另有永久地址 mrds.com（实测同构主站）。
 *
 *   脚本三层域名发现（合并去重）：
 *     1) 用户发布页 PUBLISH_PAGE → 解析 a[href] 里的主站链接
 *     2) GitLab README → 解析所有 https 域名（含中转与永久地址）
 *     3) 中转页跟随 → 解析 JS 里的 <a href> 跳回发布页，再取主站
 *   所有候选都做**同构校验**（首页能抓到 /archives/{数字} 且 >5KB），
 *   中转页 / 广告页 / 统计域一律排除，只把真主站并入轮换池。
 *   时间戳 + 域名池写入 SDK 持久缓存，默认每 6 小时刷新，
 *   全部域名不可达时立即强制刷新并重试本次请求。
 *
 * 【环境变量】
 *   MRDS_PUBLISH_PAGE    发布页地址，默认 https://www.ukcyeyqpp.cc/
 *   MRDS_HOST            主站地址，默认 https://www.mrds66.com
 *   MRDS_MIRRORS         追加备用域名（逗号分隔）
 *   MRDS_HOSTS_REFRESH   发布页刷新间隔（小时），默认 6；0=每次都刷
 *   MRDS_COOKIE          站点 cookie
 *   MRDS_UA              自定义 User-Agent
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
const crypto = require('crypto');

// 【封面解密】图床 pic.gyezbp.cn 图片是 AES-128-CBC 加密密文（Content-Type:
// binary/octet-stream），前端 tbxw/zzz.js 的 decryptImage 用固定 key/iv 解密。
// key/iv 来自前端混淆字符码：key=f5d965df75336270, iv=97b60394abc2fbe1（CBC+Pkcs7）。
// 与 51吃瓜.js 共用同一图床，密钥相同。
const COVER_AES_KEY = Buffer.from('f5d965df75336270', 'latin1');
const COVER_AES_IV = Buffer.from('97b60394abc2fbe1', 'latin1');
const COVER_TIMEOUT = (() => {
  const raw = String(process.env.MRDS_COVER_TIMEOUT || '').trim();
  return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 8000;
})();
const COVER_CONCURRENCY = (() => {
  const raw = String(process.env.MRDS_COVER_CONCURRENCY || '').trim();
  return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 6;
})();
const COVER_DISABLE = process.env.MRDS_COVER_DISABLE === '1';

const PREFIX = '[mrds]';
function logI(m) { try { Promise.resolve(OmniBox.log('info', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }
function logE(m) { try { Promise.resolve(OmniBox.log('error', `${PREFIX} ${m}`)).catch(() => {}); } catch (_) {} }

const UA = process.env.MRDS_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE = String(process.env.MRDS_COOKIE || '').trim();
const PRIMARY = (process.env.MRDS_HOST || 'https://www.mrds66.com').replace(/\/+$/, '');
const PUBLISH_PAGE = (process.env.MRDS_PUBLISH_PAGE || 'https://www.ukcyeyqpp.cc/').trim();
const GITLAB_README = 'https://gitlab.com/mrds/mrds/-/raw/main/README.md';

/* ---------------- 域名池 ---------------- */
const HOSTS = (() => {
  const extra = String(process.env.MRDS_MIRRORS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, '');
  return Array.from(new Set([PRIMARY, ...extra.map(norm)]));
})();
let PREFERRED = 0;
const hostHealth = Object.create(null);
const COOLDOWN = (() => {
  const raw = String(process.env.MRDS_ROTATE_COOLDOWN || '').trim();
  const n = raw === '' ? 600 : Number(raw);
  return Math.max(60, Number.isFinite(n) ? n : 600) * 1000;
})();

function buildHostOrder() {
  const now = Date.now();
  return HOSTS.map((host, idx) => {
    const h = hostHealth[host] || {};
    return {
      idx,
      blocked: h.blockAt && (now - h.blockAt) < COOLDOWN ? 1 : 0,
      preferred: idx === PREFERRED ? 0 : 1,
      fails: Number(h.fail || 0),
    };
  }).sort((a, b) => a.blocked - b.blocked || a.preferred - b.preferred || a.fails - b.fails || a.idx - b.idx)
    .map((s) => s.idx);
}
function markHost(host, ok, reason) {
  if (!host) return;
  const h = hostHealth[host] || (hostHealth[host] = { fail: 0, okAt: 0, blockAt: 0 });
  if (ok) { h.fail = 0; h.okAt = Date.now(); h.blockAt = 0; return; }
  h.fail = Number(h.fail || 0) + 1;
  if (/403|拦截|blocked|地区/i.test(String(reason || ''))) h.blockAt = Date.now();
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
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${u.origin}/`,
    }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {});
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
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
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function httpGet(url, options = {}) {
  try {
    if (OmniBox && typeof OmniBox.request === 'function') {
      const r = await OmniBox.request(url, {
        method: 'GET',
        headers: Object.assign({
          'User-Agent': UA,
          'Accept-Language': 'zh-CN,zh;q=0.9',
        }, COOKIE ? { Cookie: COOKIE } : {}, options.headers || {}),
        timeout: options.timeout || 20000,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (body) return { statusCode: Number(r.statusCode) || 200, body, headers: r.headers || {} };
    }
  } catch (e) { logI(`SDK 请求失败，转直连: ${e.message}`); }
  return nodeRequest(url, options);
}

/* ---------------- 自动获取最新域名 ---------------- */
const HOSTS_REFRESH_INTERVAL = (() => {
  const raw = String(process.env.MRDS_HOSTS_REFRESH || '').trim();
  const h = raw === '' ? 6 : Number(raw);
  return Math.max(0, Number.isFinite(h) ? h : 6) * 3600 * 1000;
})();
const HOSTS_CACHE_KEY = 'mrds:hosts:v1';
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
let lastHostsRefresh = 0;
let hostsRefreshInFlight = null;
let hostsCacheRestored = false;

/** 从任意 HTML/文本里抽取可用域名（排除第三方） */
function extractDomains(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    let h = String(raw || '').toLowerCase().trim();
    if (!h) return;
    // 去掉路径
    h = h.replace(/^https?:\/\//i, '').split(/[/\s"'`#?]/)[0];
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h)) return;
    // 排除第三方：广告 / 统计 / 社交 / 图床 / CDN / 代码托管 / 邮箱 / 浏览器提示站
    if (/gitlab|github|google|yandex|addtoany|cloudfront|pic\.|ads\.|t\.me|telegram|x\.com|twitter|browsehappy|schema\.org|w3\.org|googletagmanager|gmail|cloudflare|jsdelivr|npm\./i.test(h)) return;
    if (seen.has(h)) return;
    seen.add(h);
    out.push(`https://${h}`);
  };
  // 1) a[href] 链接
  const re1 = /<a[^>]*href=["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = re1.exec(s)) !== null) add(m[1]);
  // 2) JS 中转页里的 <a id=... href=...>（可能无引号）
  const re2 = /href=["']?(https?:\/\/[^"'\s>]+)/gi;
  while ((m = re2.exec(s)) !== null) add(m[1]);
  // 3) 纯文本 URL（README 用）
  const re3 = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
  while ((m = re3.exec(s)) !== null) add(m[1]);
  return out;
}

/** 同构校验：能返回含 /archives/{数字} 的 Mirages 首页才算真主站 */
async function probeMainSite(host) {
  try {
    const r = await httpGet(`${host}/`, { timeout: 12000 });
    const b = String(r.body || '');
    return r.statusCode >= 200 && r.statusCode < 400
      && b.length > 5000
      && /\/archives\/\d+/.test(b)
      && /Mirages|每日大赛/.test(b);
  } catch (_) { return false; }
}

/**
 * 从发布页 / GitLab README / 中转页发现最新主站。
 * 中转页（310B 的 JS click）会跳回发布页，发布页再给当前主站。
 */
async function discoverHosts() {
  const candidates = new Set();
  const pages = [];

  // 1) 用户给的发布页
  pages.push({ url: PUBLISH_PAGE, tag: '发布页' });
  // 2) GitLab README（官方失联恢复通道）
  pages.push({ url: GITLAB_README, tag: 'GitLab README' });

  for (const p of pages) {
    try {
      const r = await httpGet(p.url, { timeout: 15000 });
      const body = String(r.body || '');
      if (!body) continue;
      const found = extractDomains(body);
      found.forEach((d) => candidates.add(d));
      logI(`[hosts] ${p.tag} 解析到 ${found.length} 个候选域名`);

      // 若该页本身是中转页（很小且含 location.replace / .click()），
      // 跟随它里面的 <a href> 再抓一层，把发布页的主站链接也拿到
      if (body.length < 2000 && /location\.replace|\.click\(\)|加载中/.test(body)) {
        for (const d of found.slice(0, 4)) {
          try {
            const r2 = await httpGet(`${d}/`, { timeout: 12000 });
            const found2 = extractDomains(String(r2.body || ''));
            found2.forEach((x) => candidates.add(x));
          } catch (_) {}
        }
      }
    } catch (e) {
      logI(`[hosts] ${p.tag} 拉取失败: ${e.message}`);
    }
  }

  // 3) 已知同构备用主站（README 里的永久地址）
  ['https://mrds.com'].forEach((d) => candidates.add(d));

  logI(`[hosts] 合计 ${candidates.size} 个候选，开始同构校验`);
  let added = 0;
  for (const h of candidates) {
    if (HOSTS.includes(h)) continue;
    const ok = await probeMainSite(h);
    if (!ok) continue;
    HOSTS.push(h);
    hostHealth[h] = { fail: 0, okAt: 0, blockAt: 0 };
    added++;
    logI(`[hosts] 发现可用主站 -> ${h}`);
  }
  if (added) logI(`[hosts] 本次新增 ${added} 个，池共 ${HOSTS.length} 个`);
  return added;
}

async function restoreHostsCache() {
  if (hostsCacheRestored) return;
  hostsCacheRestored = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === 'string') { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (obj && Array.isArray(obj.hosts)) {
      for (const h of obj.hosts) {
        if (typeof h === 'string' && /^https?:\/\//i.test(h) && !HOSTS.includes(h)) HOSTS.push(h);
      }
    }
    if (obj && Number(obj.at) > lastHostsRefresh) lastHostsRefresh = Number(obj.at);
    if (lastHostsRefresh) logI(`[hosts] 已从缓存恢复域名池（${HOSTS.length} 个）`);
  } catch (_) {}
}

async function ensureHostsFresh(force) {
  await restoreHostsCache();
  if (!force && lastHostsRefresh && Date.now() - lastHostsRefresh < HOSTS_REFRESH_INTERVAL) return 0;
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  hostsRefreshInFlight = (async () => {
    try {
      logI(`[hosts] 定时刷新开始（间隔 ${HOSTS_REFRESH_INTERVAL / 3600000}h）`);
      const added = await discoverHosts();
      lastHostsRefresh = Date.now();
      await OmniBox.setCache(HOSTS_CACHE_KEY, { at: lastHostsRefresh, hosts: HOSTS.slice() }, HOSTS_CACHE_TTL);
      logI(`[hosts] 定时刷新完成，新增 ${added} 个`);
      return added;
    } catch (e) {
      logI(`[hosts] 定时刷新异常: ${e.message}`);
      return 0;
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

/* ---------------- 带轮换的抓取 ---------------- */
async function fetchHtml(urlOrPath, options = {}) {
  const isFull = /^https?:\/\//i.test(urlOrPath);
  const path = isFull ? new URL(urlOrPath).pathname + new URL(urlOrPath).search : urlOrPath;
  try { ensureHostsFresh(false); } catch (_) {}

  const tryAll = async () => {
    for (const idx of buildHostOrder()) {
      const host = HOSTS[idx];
      const url = isFull ? `${host}${path}` : host + urlOrPath;
      try {
        logI(`拉取 ${url}`);
        const r = await httpGet(url, options);
        const body = String(r.body || '');
        if (r.statusCode === 404) return { body: '', host, statusCode: 404 };
        if (r.statusCode >= 200 && r.statusCode < 400 && body.length >= 200) {
          markHost(host, true);
          PREFERRED = idx;
          return { body, host, statusCode: r.statusCode };
        }
        markHost(host, false, `HTTP ${r.statusCode}`);
      } catch (e) {
        markHost(host, false, e.message);
        logI(`${host} 请求异常: ${e.message}`);
      }
    }
    return null;
  };

  const hit = await tryAll();
  if (hit) return hit;

  // 全挂：强制刷新域名池并重试一轮（60s 内只一次）
  if (!globalThis.__mrdsForceAt || Date.now() - globalThis.__mrdsForceAt >= 60000) {
    globalThis.__mrdsForceAt = Date.now();
    logI('所有候选域名不可达，强制刷新发布页/GitLab 域名池');
    await ensureHostsFresh(true);
    const retry = await tryAll();
    if (retry) return retry;
  }
  logE('所有候选域名均不可达');
  return { body: '', host: HOSTS[PREFERRED] || PRIMARY, statusCode: 0 };
}

/* ---------------- 封面解密（图床 AES-128-CBC 密文） ---------------- */
/** 二进制抓取：保留原始 Buffer（不能 toString utf8），带重定向与解压 */
function fetchBinary(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) return reject(new Error(`封面重定向过多: ${urlStr}`));
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
        'User-Agent': UA,
        Referer: `${u.origin}/`,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: COVER_TIMEOUT,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchBinary(new URL(res.headers.location, u.href).href, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const finish = (buf) => resolve({ statusCode: res.statusCode || 200, body: buf });
        if (enc === 'gzip') zlib.gunzip(raw, (e, x) => finish(e ? raw : x));
        else if (enc === 'deflate') zlib.inflate(raw, (e, x) => finish(e ? raw : x));
        else if (enc === 'br') zlib.brotliDecompress(raw, (e, x) => finish(e ? raw : x));
        else finish(raw);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('封面请求超时')));
    req.end();
  });
}

/** 与前端 is_cdnimg 一致：这些路径下的图被加密 */
function isCdnImg(url) {
  if (typeof url !== 'string' || !url) return false;
  return ['/xiao/', '/upload/upload/', '/upload_01/', '/uploads/'].some((seg) => url.includes(seg));
}
/** 探测图片真实类型 */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
/** AES-CBC 解密密文，已是明文则原样返回 */
function decryptCoverBytes(raw) {
  const plain = sniffImageType(raw);
  if (plain) return { mime: plain, body: raw };
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', COVER_AES_KEY, COVER_AES_IV);
    const out = Buffer.concat([decipher.update(raw), decipher.final()]);
    const mime = sniffImageType(out);
    if (mime) return { mime, body: out };
  } catch (_) {}
  return null;
}
const coverCache = new Map();
/** 单张封面：加密图 -> 解密 -> data URI；失败回退原 URL */
async function resolveCover(url) {
  if (!url || COVER_DISABLE) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  // 普通图片或 data URI 无需解密
  if (url.startsWith('data:') || !isCdnImg(url)) {
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
    logI(`[cover] 解密失败 ${String(url).slice(0, 80)}: ${e.message}`);
    coverCache.set(url, url);
    return url;
  }
}
/** 限并发批量解析封面，失败不阻塞主链路 */
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
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, list.length) }, () => worker()));
  return list;
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
  let s = String(u || '').trim()
    .replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/') && host) return host + s;
  return s;
}
/** 还原 DPlayer data-config 里的 \/ 和 \u002f */
function decodeConfigUrl(u) {
  return String(u || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
}

/* ---------------- 分类 ---------------- */
const CLASSES = [
  { type_id: '', type_name: '首页推荐' },
  { type_id: 'category/mrds', type_name: '每日大赛' },
  { type_id: 'category/rstt', type_name: '热搜吃瓜' },
  { type_id: 'category/ztds', type_name: '主题大赛' },
  { type_id: 'category/hjds', type_name: '混剪PMV' },
  { type_id: 'category/dypd', type_name: '影视国漫' },
  { type_id: 'category/omjp', type_name: '欧美精品' },
  { type_id: 'archives.html', type_name: '往期内容' },
];

/* ---------------- 列表解析 ---------------- */
function parseList(html, host) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  // 卡片：article 里 meta[itemprop="url mainEntityOfPage"] 或 a[href=/archives/{id}/]
  const artRe = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = artRe.exec(s)) !== null) {
    // 卡片里的 <script>loadBannerDirect(...)</script> 会污染后续正则，
    // 但封面又藏在它里面 —— 先单独抽出封面，再把 script 整段剥掉再解析字段。
    const rawBlock = m[0];
    let cover = '';
    const bm0 = rawBlock.match(/loadBannerDirect\(\s*['"]([^'"]+)['"]/i)
      || rawBlock.match(/<img[^>]*src="(https?:\/\/[^"]*\.(?:jpe?g|png|webp|gif)[^"]*)"/i);
    if (bm0) cover = fixUrl(bm0[1], host);

    const block = rawBlock
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<div[^>]*class="[^"]*display-none[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi, ' ');
    const idM = block.match(/content="\/?archives\/(\d+)\/?"/i)
      || block.match(/href="\/?archives\/(\d+)\/?"/i);
    if (!idM) continue;
    const id = idM[1];
    if (seen.has(id)) continue;
    // 标题：去掉 <div class="wrap">热搜 HOT</div> 这类角标
    let title = '';
    const tm = block.match(/<h2[^>]*class="[^"]*post-card-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
    if (tm) title = cleanText(tm[1].replace(/<div[^>]*class="[^"]*wrap[^"]*"[\s\S]*?<\/div>/gi, ''));
    if (!title) {
      const tm2 = block.match(/<a[^>]*href="\/?archives\/\d+\/?"[^>]*title="([^"]*)"/i);
      if (tm2) title = cleanText(tm2[1]);
    }
    if (!title) continue;
    const pic = cover;
    // 作者 / 时间 / 分类：只从 post-card-info 里取，避免命中 head 区的 meta
    let author = '';
    let date = '';
    let cat = '';
    const infoM = block.match(/<div[^>]*class="[^"]*post-card-info[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (infoM) {
      const spans = infoM[1].match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || [];
      if (spans[0]) author = cleanText(spans[0]).replace(/[•·\s]+$/, '');
      if (spans[1]) date = cleanText(spans[1]).replace(/[•·\s]+$/, '');
      if (spans.length >= 3) cat = cleanText(spans[spans.length - 1]);
    }
    // 热搜标记
    let hot = '';
    const hm = block.match(/class="[^"]*wraps[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (hm) hot = cleanText(hm[1]);

    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: title,
      vod_pic: pic,
      vod_remarks: [hot, cat].filter(Boolean).join(' · '),
      vod_actor: author,
      vod_content: [date, cat].filter(Boolean).join(' · '),
      vod_tag: 'video',
      vod_url: `${host}/archives/${id}/`,
    });
  }
  return list;
}

/** 归档页（/archives.html）无封面，走纯文本兜底 */
function parseArchiveList(html, host) {
  const s = String(html || '');
  const list = [];
  const seen = new Set();
  const re = /<div class="brick">\s*<a href="\/?archives\/(\d+)\/?"[^>]*>\s*<span class="time">([^<]*)<\/span>\s*([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({
      vod_id: id,
      vod_name: cleanText(m[3]),
      vod_pic: '',
      vod_remarks: cleanText(m[2]),
      vod_tag: 'video',
      vod_url: `${host}/archives/${id}/`,
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
    if (Number.isFinite(n) && n > max && n < 100000) max = n;
  }
  return max;
}

/* ---------------- 详情 ---------------- */
async function fetchDetail(id) {
  const cacheKey = `mrds:detail:${id}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) {
      const obj = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (obj && obj.vod_id) return obj;
    }
  } catch (_) {}

  const host = HOSTS[PREFERRED] || PRIMARY;
  const { body } = await fetchHtml(`/archives/${id}/`);
  if (!body) return null;

  // 标题
  const h1 = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title = cleanText(h1 ? h1[1] : '');
  title = title.replace(/\s*[-–|]\s*每日大赛\s*$/i, '').trim();

  // 封面：itemprop="image"（og:image 是站点 social.jpg，不能用）
  let pic = '';
  const im = body.match(/itemprop="image"[^>]*content="([^"]+)"/i)
    || body.match(/<meta[^>]*itemprop="image"[^>]*content="([^"]+)"/i);
  if (im) pic = fixUrl(im[1], host);

  // 简介
  let content = '';
  const desc = body.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (desc) content = cleanText(desc[1]);

  // 视频：div.dplayer[data-config] 里的 video.url
  const media = [];
  const dpRe = /<div[^>]*class="[^"]*dplayer[^"]*"[^>]*data-config='([^']+)'/gi;
  let dm;
  while ((dm = dpRe.exec(body)) !== null) {
    try {
      const cfg = JSON.parse(decodeConfigUrl(dm[1]));
      const v = cfg && cfg.video && cfg.video.url;
      if (v) {
        const u = decodeConfigUrl(v);
        if (!media.some((x) => x.url === u)) media.push({ url: u, type: cfg.video.type || 'hls' });
      }
      const h265 = cfg && cfg.video_h265;
      if (Array.isArray(h265)) {
        for (const h of h265) {
          const u = decodeConfigUrl(h.url || h);
          if (u && !media.some((x) => x.url === u)) media.push({ url: u, type: 'h265' });
        }
      }
    } catch (_) {}
  }
  // 兜底：全页找 m3u8（含转义）
  if (!media.length) {
    const m8 = body.match(/https?:\\?\/\\?\/[^"'<>\s]+\.m3u8[^"'<>\s]*/gi);
    if (m8) {
      for (const u of m8.slice(0, 4)) {
        const real = decodeConfigUrl(u);
        if (!media.some((x) => x.url === real)) media.push({ url: real, type: 'hls' });
      }
    }
  }

  // 关键词
  const tags = [];
  const kw = body.match(/关键词：([^<]+)/i);
  if (kw) {
    (kw[1].match(/#([^\s#]+)/g) || []).forEach((t) => {
      const v = t.replace(/^#/, '');
      if (v && !tags.includes(v)) tags.push(v);
    });
  }

  const episodes = media.map((x, i) => ({
    name: media.length > 1 ? `线路${i + 1}${x.type === 'h265' ? ' (H265)' : ''}` : '正片',
    playId: x.url,
  }));

  const vod = {
    vod_id: id,
    vod_name: title || `每日大赛 ${id}`,
    vod_pic: pic,
    vod_content: [content, tags.length ? `标签：${tags.join('、')}` : ''].filter(Boolean).join('\n'),
    vod_remarks: episodes.length ? `${episodes.length} 条线路` : '',
    vod_play_sources: episodes.length ? [{ name: '每日大赛', episodes }] : [],
    _id: id,
    _host: host,
  };
  if (episodes.length) {
    vod.vod_play_from = '每日大赛';
    vod.vod_play_url = episodes.map((e) => `${e.name}$${e.playId}`).join('#');
  }
  try { await OmniBox.setCache(cacheKey, vod, 1800); } catch (_) {}
  return vod;
}

/* ---------------- 播放 ---------------- */
async function play(params, context) {
  const rawId = String((params && (params.playId || params.id || params.url)) || '').trim();
  logI(`play playId=${rawId.slice(0, 110)} from=${(context && context.from) || 'web'}`);
  if (!rawId) return { parse: 0, jx: 0, url: '', urls: [] };

  const host = HOSTS[PREFERRED] || PRIMARY;
  let url = decodeConfigUrl(rawId);
  url = fixUrl(url, host);

  const header = {
    'User-Agent': UA,
    Referer: `${host}/`,
  };

  if (/\.(m3u8|mp4)(\?|$)/i.test(url)) {
    return { parse: 0, jx: 0, flag: '每日大赛', url, urls: [{ name: '正片', url }], header };
  }
  // 数字 id → 现场解析详情拿第一路
  if (/^\d+$/.test(url)) {
    try {
      const v = await fetchDetail(url);
      const first = v && v.vod_play_sources[0] && v.vod_play_sources[0].episodes[0];
      if (first) return {
        parse: 0, jx: 0, flag: '每日大赛',
        url: first.playId,
        urls: [{ name: '正片', url: first.playId }],
        header,
      };
    } catch (_) {}
  }
  return { parse: 1, jx: 0, flag: '每日大赛', url, urls: [{ name: '正片', url }], header };
}

/* ---------------- 五个方法 ---------------- */
async function home(params, context) {
  logI(`home from=${(context && context.from) || 'web'}`);
  const cls = CLASSES.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
  let list = [];
  try {
    const { body, host } = await fetchHtml('/');
    list = parseList(body, host);
    list = await resolveCovers(list);
    logI(`home 返回 ${list.length} 条，封面解密 ${list.filter((v) => /^data:image/.test(v.vod_pic || '')).length} 张`);
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
    let path;
    if (!typeId) path = page > 1 ? `/page/${page}/` : '/';
    else if (typeId === 'archives.html') path = page > 1 ? `/archives/page/${page}/` : '/archives.html';
    else {
      const slug = typeId.replace(/^\/+|\/+$/g, '');
      path = page > 1 ? `/${slug}/page/${page}/` : `/${slug}/`;
    }
    const { body, host } = await fetchHtml(path);
    list = parseList(body, host);
    if (!list.length && /archives\.html|brick/.test(path)) list = parseArchiveList(body, host);
    list = await resolveCovers(list);
    pagecount = parsePageCount(body);
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
  const um = idRaw.match(/\/archives\/(\d+)/i);
  if (um) id = um[1];
  if (!/^\d+$/.test(id)) return { list: [] };
  try {
    const v = await fetchDetail(id);
    if (!v) return { list: [] };
    await resolveCovers([v]);
    logI(`detail 成功: ${v.vod_name.slice(0, 40)}，${(v.vod_play_sources[0] && v.vod_play_sources[0].episodes.length) || 0} 条线路`);
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
    // 搜索路由 /search/{关键词}/；?s= 会 302，不能用
    const path = page > 1
      ? `/search/${encodeURIComponent(wd)}/page/${page}/`
      : `/search/${encodeURIComponent(wd)}/`;
    const { body, host } = await fetchHtml(path);
    list = parseList(body, host);
    list = await resolveCovers(list);
    logI(`search 返回 ${list.length} 条`);
  } catch (e) {
    logE(`search 异常: ${e.message}`);
  }
  return { page, pagecount: list.length >= 10 ? page + 1 : page, total: list.length, limit: list.length, list };
}

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
