// @name 91全集
// @version 1.1.0
// @author omnibox-spider
// @description 91quanji.com（木瓜视频/KVS Paysite）采集源：新增地址发布页 mgbbr.com/91bbr.com（XOR129 解混淆 + 同构校验 + 被动触发 + 死域淘汰）；修复封面（图床 pics.uoepp.com 有 Referer 防盗链，脚本内带 Referer 抓取并转 data:image 内联）+ 补 Node 直连兜底（宿主缺 OmniBox.request 时不再整体失败）；10 个真实分类 + 首页推荐 + 搜索分页；卡片解析封面/标题；详情页反混淆 eval(I(...)) 直取签名 m3u8；tag 分类 token 分页链（进程内+SDK 缓存）、搜索 p=N、三段式播放兜底
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91全集.js
// @dependencies []

/**
 * 实站事实（2026-11-14 实测，改代码前先读这段）
 * 1) 站点是 KVS Paysite 模板（nginx + UTF-8），无 Cloudflare；两个外链用 I() 混淆：
 *      I(r) = 逐字符 chr(128 ^ charCodeAt(i))，document.write(I('¼á...')) 输出 <a href=...>。
 * 2) 路由：
 *      首页        /                              3 个分区（国产自拍/国产精品/厂商）共 60+ 卡片
 *      分类        /tag.jsp?t=<token>            12 卡片/页，10 个真实分类（含 8 个厂商）
 *      厂商导航    /makers.jsp                   分类按钮 + 96 卡片
 *      搜索        /search.jsp?keyword=<kw>&p=<n>   36 卡片/页，实测 p=1..20 有效、p=50 空
 *      详情        /watch.jsp?v=<12位id>
 * 3) 卡片 DOM：<div class="item thumb thumb--videos"><a href="watch.jsp?v=...">
 *      <div class="thumb__img"><img src="https://pics.uoepp.com/..."></div>
 *      <div class="thumb-spot__title"><h5>标题</h5>
 *    详情页标题：<h1 class="title">；相关视频也是同一卡片结构，解析时要用 id 去重。
 * 4) 播放地址在 <script>eval(I("..."))</script> 里，解码后是 DPlayer 初始化：
 *      if(-1!=='muguad.cfd,...,91quanji.com,...'.indexOf(window.location.hostname)){
 *        const dp = new DPlayer({ ..., video:{ url:'https://8017.o9hx3f-s8jamrmtps5.sbs/.../chunklist_w.m3u8?v=<ts>-<sig>' ... } })
 *    直接取 url: '...' 即可，GET 实测 200 application/vnd.apple.mpegurl（带签名 query，勿二次编码）。
 *    这是正版片源，不是诱饵；页面里没有其它 m3u8。签名带时间戳，播放缓存 TTL 必须短（默认 45s）。
 * 5) tag 分类分页**不是** ?page=N：<ul class="pagination"> 每页给的是不可推算的 token
 *      （如 ?t=649e2zxgw10p&p=51d0rqoxqvp8 才是第 2 页，末页 3483）。
 *    隐藏的「跳转至」表单 location.href='?t=<t>&p=<baseToken>='+页号 实测服务端不认（回第 1 页），
 *    只能靠**逐页跟随分页链接**建立 token 链：本源把「页码 -> token」缓存起来，
 *    category(page=N) 从已缓存链里取 token，缺页时从第 1 页逐页走到 N（有步数上限）。
 *    pagecount 取分页区最大数字（国产自拍 3483、国产精品 45）。
 * 6) 搜索用 p=<n>，不用 token；搜索页无分页区，靠「有卡片/无卡片」判断还有没有下一页。
 *
 * 【环境变量】（沿用仓库既有命名优先）
 *  QUANJI_HOST / SITE_HOSTS   站点基址，默认 https://91quanji.com；SITE_HOSTS 逗号分隔可容灾
 *  NINETYONE_UA               自定义 UA
 *  NINETYONE_COOKIE           可选手动 Cookie
 *  QUANJI_CACHE_TTL           页面缓存秒数，默认 300
 *  QUANJI_DETAIL_TTL          详情页缓存秒数，默认 90
 *  QUANJI_PLAY_TTL            播放直链缓存秒数，默认 45
 *  QUANJI_TOKEN_TTL           tag 分页 token 链缓存秒数，默认 3600
 *  QUANJI_MAX_WALK            单次 category 最多跟随多少页，默认 12
 *  QUANJI_PLAY_MODE           direct | sniff | auto（默认 auto：直链 -> sniff -> parse=1）
 *
 * 【stdout 纪律】宿主通过 stdout 读 handler 返回的 JSON，脚本绝不向 stdout 写日志；
 *  SDK 缺失时日志走 stderr，OmniBox.log 一律 Promise.resolve(...).catch() 兜住。
 */

const crypto = require('crypto');
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
    request() { return Promise.reject(new Error('omnibox_sdk 缺失')); },
    sniffVideo() { return Promise.resolve(''); },
  };
}
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const PREFIX = '[91quanji]';
function safeLog(level, msg) {
  try {
    if (OmniBox && typeof OmniBox.log === 'function') {
      Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {});
      return;
    }
  } catch (_) { /* ignore */ }
  try { process.stderr.write(`${PREFIX}[${level}] ${msg}\n`); } catch (_) { /* ignore */ }
}
function logI(m) { safeLog('info', m); }
function logE(m) { safeLog('error', m); }

/* ==================== 封面防盗链处理 ====================
 * 站点图床 pics.uoepp.com 有 Referer 白名单：
 *   带 Referer: https://91quanji.com/  →  200 image/jpeg
 *   不带 Referer / 其它 Referer        →  403 text/html
 * 宿主播放器直连图片时不会带该 Referer，表现为「封面全是空白」。
 * 因此列表态把封面抓取后转成 data:image/*;base64 内联返回。
 * 可用 QUANJI_COVER_INLINE=0 关闭（回退原始 URL），QUANJI_COVER_CONCURRENCY 调并发。
 * ========================================================= */
const COVER_INLINE = process.env.QUANJI_COVER_INLINE !== '0';
const COVER_CONCURRENCY = (() => {
  const n = Number(String(process.env.QUANJI_COVER_CONCURRENCY || '').trim() || 6);
  return Number.isFinite(n) && n > 0 ? Math.min(12, Math.floor(n)) : 6;
})();
const COVER_TIMEOUT = 8000;
const coverCache = new Map();
const COVER_CACHE_LIMIT = 300;

function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
/** 二进制抓图（保留原始 Buffer），带 Referer 绕过防盗链 */
function fetchImageBinary(urlStr, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('图片重定向过多'));
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
        Referer: referer,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: COVER_TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchImageBinary(new URL(res.headers.location, u.href).href, referer, redirects + 1)
          .then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: decompressBody(Buffer.concat(chunks), res.headers['content-encoding']),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('封面超时')); });
    req.end();
  });
}
/** 单张封面：抓取 + 转 data URI；失败回退原 URL */
async function resolveCover(url, host) {
  if (!url || !COVER_INLINE) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await fetchImageBinary(url, `${host}/`);
    const mime = sniffImageMime(res.body);
    if (res.statusCode === 200 && mime) {
      const dataUri = `data:${mime};base64,${res.body.toString('base64')}`;
      if (coverCache.size >= COVER_CACHE_LIMIT) coverCache.delete(coverCache.keys().next().value);
      coverCache.set(url, dataUri);
      return dataUri;
    }
    logI(`[cover] ${res.statusCode} 非图片 ${String(url).slice(0, 70)}`);
  } catch (e) {
    logI(`[cover] 抓取失败 ${String(url).slice(0, 70)}: ${e.message}`);
  }
  coverCache.set(url, url);
  return url;
}
/** 限并发批量内联封面，失败不阻塞列表主链路 */
async function resolveCovers(list, host) {
  if (!COVER_INLINE || !Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      const item = list[idx];
      if (item && item.vod_pic) {
        try { item.vod_pic = await resolveCover(item.vod_pic, host); } catch (_) {}
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, list.length) }, () => worker()));
  return list;
}

// ==================== 配置区域 ====================
const DEFAULT_HOST = 'https://91quanji.com';
const HOSTS = (() => {
  const raw = String(process.env.SITE_HOSTS || process.env.QUANJI_HOST || DEFAULT_HOST);
  const list = raw.split(/[,;]/).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map(s => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
  return Array.from(new Set(list.length ? list : [DEFAULT_HOST]));
})();
let PREFERRED = 0;

/* ==================== 地址发布页（被动触发） ====================
 * 发布页：https://mgbbr.com/  （标题「木瓜视频 | 永久网址 | 最新地址发布页」）
 * 另有同款镜像：https://91bbr.com/（内容完全一致，可作发布页兜底）
 *
 * ⚠️ 发布页里的域名是 XOR 129 混淆的，页面内联函数：
 *      function l(r){var n="";for(i=0;i<r.length;++i)n+=String.fromCharCode(129^r.charCodeAt(i));return n}
 *      <script>document.write(l('½à¡éóäç¼£éõõñò»®®...'))</script>
 *    解码后得到真实地址（实测）：
 *      sp123.cc/mugua   → 跳转型入口
 *      91quanji.com     → 真实内容站（即本源默认站点）✅
 *      91bbr.com        → 发布页镜像（非内容站）
 *    注意：用户给的 muguad.cfd 当前**不可用**（HTTP→HTTPS 301 死循环 +
 *    HTTPS PROTOCOL_ERROR），但站点 JS 里 muguad.cfd 与 91quanji.com 同属
 *    这条线，所以它只是镜像域名之一，不是独立站点。
 *
 * 策略与其它源一致：不做定时刷新；全部已知域名失败才拉发布页；
 * 候选域名分批探测（每批 10 个）并做同构校验，通过才入池；
 * 成功域置顶持久化、连续失败 2 次判死移出池。
 * ============================================================== */
const PUBLISH_PAGES = String(process.env.QUANJI_PUBLISH_PAGES || 'https://mgbbr.com/,https://91bbr.com/')
  .split(',').map((x) => x.trim()).filter(Boolean);
const HOSTS_CACHE_KEY = 'quanji:hosts:v1';
const HOSTS_CACHE_TTL = 30 * 24 * 3600;
const PROBE_BATCH_SIZE = (() => {
  const n = Number(String(process.env.QUANJI_PROBE_BATCH || '').trim() || 10);
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 10;
})();
const PROBE_BATCH_DELAY = 200;
const PROBE_TIMEOUT = Math.max(3000, Number(process.env.QUANJI_PROBE_TIMEOUT || 8000) || 8000);
let HOST_POOL_READY = false;
let hostsRefreshInFlight = null;
const hostHealth = Object.create(null);

/** 发布页域名解码：XOR 129 */
function decodePublishText(raw) {
  return String(raw || '').split('').map((c) => String.fromCharCode(129 ^ c.charCodeAt(0))).join('');
}

/** 从发布页 HTML 里解出真实域名候选（排除发布页自身/邮箱/社交） */
function extractPublishHosts(html) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  // 1) 解出所有 l('...') 里的内容
  let text = s;
  const lRe = /l\('([^']+)'\)/g;
  let m;
  const decoded = [];
  while ((m = lRe.exec(s)) !== null) decoded.push(decodePublishText(m[1]));
  if (decoded.length) text = decoded.join('\n');

  const re = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(\/[a-z0-9_-]*)?/gi;
  while ((m = re.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    if (/gmail|qq\.com|163\.com|telegram|t\.me|x\.com|twitter|google|yandex|cloudflare/i.test(host)) continue;
    const origin = `https://${host}`;
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/** 同构校验：首页必须能抓到 item thumb / watch.jsp 卡片 */
async function probeHost(origin) {
  try {
    const r = await nodeRequest(`${origin}/`, {
      timeout: PROBE_TIMEOUT,
      headers: { 'User-Agent': UA, Referer: `${origin}/` },
    });
    const body = String(r.body || '');
    if (r.statusCode < 200 || r.statusCode >= 400) return false;
    if (body.length < 5000) return false;
    const cards = (body.match(/item thumb/g) || []).length;
    const watches = (body.match(/watch\.jsp\?v=/g) || []).length;
    return cards >= 3 || watches >= 5;
  } catch (_) { return false; }
}

async function restoreHostCache() {
  if (HOST_POOL_READY) return;
  HOST_POOL_READY = true;
  try {
    const saved = await OmniBox.getCache(HOSTS_CACHE_KEY);
    let obj = saved;
    if (typeof saved === 'string') { try { obj = JSON.parse(saved); } catch (_) { obj = null; } }
    if (!obj || typeof obj !== 'object') return;
    const dead = new Set((Array.isArray(obj.dead) ? obj.dead : []).map((h) => String(h).replace(/\/+$/, '')));
    const merged = [];
    const push = (h) => {
      if (typeof h !== 'string' || !/^https?:\/\//i.test(h)) return;
      const host = h.replace(/\/+$/, '');
      if (dead.has(host) || merged.includes(host)) return;
      merged.push(host);
    };
    if (typeof obj.active === 'string') push(obj.active);
    (Array.isArray(obj.hosts) ? obj.hosts : []).forEach(push);
    if (merged.length) {
      const seen = new Set(HOSTS);
      HOSTS.push(...merged.filter((h) => !seen.has(h)));
      if (typeof obj.active === 'string') {
        const active = obj.active.replace(/\/+$/, '');
        const idx = HOSTS.indexOf(active);
        if (idx > 0) { HOSTS.splice(idx, 1); HOSTS.unshift(active); PREFERRED = 0; }
      }
      logI(`[hosts] 恢复缓存池: ${HOSTS.length} 个，当前=${HOSTS[PREFERRED]}`);
    }
  } catch (_) {}
}

let persistTimer = null;
function schedulePersistHosts() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    Promise.resolve(OmniBox.setCache(
      HOSTS_CACHE_KEY,
      {
        at: Date.now(),
        active: HOSTS[PREFERRED],
        hosts: HOSTS.slice(),
        dead: Object.keys(hostHealth).filter((h) => hostHealth[h] && hostHealth[h].dead),
      },
      HOSTS_CACHE_TTL
    )).catch(() => {});
  }, 500);
  if (persistTimer.unref) persistTimer.unref();
}

function markHostAlive(host) {
  if (!host) return;
  hostHealth[host] = { fail: 0, okAt: Date.now(), dead: false };
  const idx = HOSTS.indexOf(host);
  if (idx > 0) { HOSTS.splice(idx, 1); HOSTS.unshift(host); PREFERRED = 0; }
  schedulePersistHosts();
}

function markHostDead(host, reason) {
  if (!host) return;
  const h = hostHealth[host] || (hostHealth[host] = { fail: 0 });
  h.fail = Number(h.fail || 0) + 1;
  h.lastReason = String(reason || '').slice(0, 120);
  if (h.fail >= 2 && !h.dead) {
    h.dead = true;
    h.deadAt = Date.now();
    const idx = HOSTS.indexOf(host);
    if (idx >= 0 && HOSTS.length > 1) {
      HOSTS.splice(idx, 1);
      // 删除元素后索引会错位：当前项之前被删则前移一位，越界则归零
      if (PREFERRED > idx) PREFERRED -= 1;
      if (PREFERRED >= HOSTS.length) PREFERRED = 0;
    }
    logI(`[hosts] ${host} 连续失败 ${h.fail} 次，移出轮换池（${h.lastReason}）`);
    schedulePersistHosts();
  }
}

async function discoverHosts() {
  const candidates = new Set();
  let publishOk = false;
  for (const page of PUBLISH_PAGES) {
    try {
      logI(`[hosts] 拉取发布页 ${page}`);
      const r = await nodeRequest(page, { timeout: 15000, headers: { 'User-Agent': UA } });
      const body = String(r.body || '');
      if (r.statusCode !== 200 || body.length < 100) continue;
      publishOk = true;
      const found = extractPublishHosts(body);
      found.forEach((h) => candidates.add(h));
      logI(`[hosts] ${page} 解析到 ${found.length} 个候选`);
      if (found.length) break;
    } catch (e) {
      logI(`[hosts] 发布页 ${page} 拉取失败: ${e.message}`);
    }
  }

  if (!publishOk) {
    logI('[hosts] 发布页不可用，保留现有域名池不变');
    return 0;
  }

  const newOnes = Array.from(candidates).filter((h) => !HOSTS.includes(h));
  if (!newOnes.length) {
    logI('[hosts] 发布页无新域名，无需探测');
    return 0;
  }
  logI(`[hosts] 待探测 ${newOnes.length} 个新域名（含同构校验），每批 ${PROBE_BATCH_SIZE} 个`);

  let added = 0;
  for (let i = 0; i < newOnes.length; i += PROBE_BATCH_SIZE) {
    const batch = newOnes.slice(i, i + PROBE_BATCH_SIZE);
    const batchNo = Math.floor(i / PROBE_BATCH_SIZE) + 1;
    logI(`[hosts] 探测批次 ${batchNo}: ${batch.length} 个`);
    const results = await Promise.allSettled(batch.map((h) => probeHost(h)));
    for (let k = 0; k < batch.length; k++) {
      if (results[k].status !== 'fulfilled' || !results[k].value) {
        logI(`[hosts] 跳过非同构域名 ${batch[k]}`);
        continue;
      }
      HOSTS.push(batch[k]);
      hostHealth[batch[k]] = { fail: 0, okAt: Date.now(), dead: false };
      added++;
      logI(`[hosts] 发现可用站点 -> ${batch[k]}`);
    }
    if (i + PROBE_BATCH_SIZE < newOnes.length) {
      await new Promise((r) => setTimeout(r, PROBE_BATCH_DELAY));
    }
  }
  if (added) logI(`[hosts] 本次新增 ${added} 个，池共 ${HOSTS.length} 个`);
  try {
    await OmniBox.setCache(
      HOSTS_CACHE_KEY,
      { at: Date.now(), active: HOSTS[PREFERRED], hosts: HOSTS.slice(), dead: Object.keys(hostHealth).filter((h) => hostHealth[h] && hostHealth[h].dead) },
      HOSTS_CACHE_TTL
    );
  } catch (_) {}
  return added;
}

async function ensureHostsFresh(force) {
  await restoreHostCache();
  if (!force) return 0;
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  hostsRefreshInFlight = (async () => {
    try {
      logI('[hosts] 全部域名不可达，从发布页拉取新域名');
      return await discoverHosts();
    } catch (e) {
      logI(`[hosts] 拉取新域名异常: ${e.message}`);
      return 0;
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

const UA = String(process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
const FIXED_COOKIE = String(process.env.NINETYONE_COOKIE || '').trim();
const CACHE_TTL = Math.max(0, Number(process.env.QUANJI_CACHE_TTL || 300) || 300);
const DETAIL_TTL = Math.max(0, Number(process.env.QUANJI_DETAIL_TTL || 90) || 90);
const PLAY_TTL = Math.max(0, Number(process.env.QUANJI_PLAY_TTL || 45) || 45);
const TOKEN_TTL = Math.max(0, Number(process.env.QUANJI_TOKEN_TTL || 3600) || 3600);
const MAX_WALK = Math.max(1, Number(process.env.QUANJI_MAX_WALK || 12) || 12);
const PLAY_MODE = ['direct', 'sniff', 'auto'].includes(String(process.env.QUANJI_PLAY_MODE || 'auto').trim().toLowerCase())
  ? String(process.env.QUANJI_PLAY_MODE || 'auto').trim().toLowerCase() : 'auto';
const PAGE_SIZE = 12;
const SEARCH_PAGE_SIZE = 36;
const MEDIA_RE = /\.(m3u8|mp4)(\?|$)/i;

let SESSION_COOKIE = '';

// 10 个真实分类（首页导航 2 个 + makers.jsp 厂商 8 个）
const CATEGORIES = [
  { type_id: '649e2zxgw10p', type_name: '国产自拍' },
  { type_id: '5y9kg97rdzxe', type_name: '国产精品' },
  { type_id: 'z8y32yqgdemj', type_name: '天美传媒' },
  { type_id: '0598gp923vod', type_name: '其他传媒' },
  { type_id: '7wxkgwqgm60p', type_name: '蜜桃影像传媒' },
  { type_id: 'onmvrndgxzw3', type_name: '精东影业' },
  { type_id: 'poy4gx4rqwxv', type_name: '91制片厂' },
  { type_id: 'e1mqglprj3v8', type_name: '麻豆传媒映画' },
  { type_id: 'k1o721d2zp8l', type_name: '台湾swag' },
  { type_id: 'qyl9gmx236dp', type_name: '星空无限传媒' },
];
const CAT_NAME = Object.fromEntries(CATEGORIES.map(c => [c.type_id, c.type_name]));
// 首页「更多」按钮给的第 3 页 token：作为预置加速，避免每次从第 1 页走起
const SEED_TOKENS = { '649e2zxgw10p': { 3: 'myz530grq4je' }, '5y9kg97rdzxe': { 2: 'g6r2m3qyq70x' } };
// ==================== 配置区域结束 ====================

// ==================== 工具函数 ====================
function decodeHTML(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function cleanText(s) {
  return decodeHTML(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function absUrl(u, host) {
  const v = decodeHTML(String(u || '').trim());
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  if (v.startsWith('/')) return `${host}${v}`;
  return `${host}/${v}`;
}
function shortKey(prefix, value) {
  let hash = '';
  try { hash = crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20); }
  catch (_) { hash = String(value).replace(/[^a-zA-Z0-9]/g, '').slice(-20); }
  return `${prefix}:${hash}`;
}
function safeInt(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}
function buildHeaders(host) {
  const h = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: `${host}/`,
  };
  const cookie = FIXED_COOKIE || SESSION_COOKIE;
  if (cookie) h.Cookie = cookie;
  return h;
}
function captureCookie(res) {
  if (SESSION_COOKIE || FIXED_COOKIE) return;
  try {
    const raw = res && res.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
    const arr = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
    for (const line of arr) {
      const m = /(JSESSIONID|PHPSESSID)=[^;]+/.exec(line);
      if (m) { SESSION_COOKIE = m[0]; logI(`已接收会话 cookie=${SESSION_COOKIE.slice(0, 22)}...`); return; }
    }
  } catch (_) { /* ignore */ }
}
function bodyText(res) {
  const b = res && res.body;
  if (typeof b === 'string') return b;
  if (b && typeof b.toString === 'function') return b.toString('utf8');
  return '';
}
/** 站点 I() 反混淆：逐字符 128 ^ charCode */
function decodeI(raw) {
  let out = '';
  const s = String(raw || '');
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(128 ^ s.charCodeAt(i));
  return out;
}
// ==================== 工具函数结束 ====================

// ==================== 请求与缓存 ====================
/**
 * Node 直连兜底：部分宿主没有 OmniBox.request（或版本不提供），
 * 只依赖 SDK 会让 home/detail 整体失败（表现为「列表 0 条 + 封面全空」）。
 * 这里直接用 http/https 发请求，保留原始 header 与 cookie 捕获能力。
 */
function decompressBody(buf, encoding) {
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
    const headers = Object.assign({}, options.headers || {}, { 'Accept-Encoding': 'gzip, deflate, br' });
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
          body: decompressBody(raw, res.headers['content-encoding']).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.end();
  });
}
/** 统一请求：SDK 优先，不可用/失败时回落 Node 直连 */
async function requestPage(url, host) {
  const headers = buildHeaders(host);
  if (OmniBox && typeof OmniBox.request === 'function') {
    try {
      return await OmniBox.request(url, { method: 'GET', headers });
    } catch (_) { /* 回落直连 */ }
  }
  return nodeRequest(url, { method: 'GET', headers });
}
async function fetchPage(path) {
  await restoreHostCache();
  const errors = [];

  const tryAll = async () => {
    for (let off = 0; off < HOSTS.length; off++) {
      const i = (PREFERRED + off) % HOSTS.length;
      const host = HOSTS[i];
      const url = absUrl(path, host);
      try {
        const res = await requestPage(url, host);
        const text = bodyText(res);
        const code = Number(res && res.statusCode) || 0;
        if (code !== 200 || text.length < 300) {
          errors.push(`${host} HTTP ${code} len=${text.length}`);
          markHostDead(host, `HTTP ${code}`);
          continue;
        }
        PREFERRED = i;
        markHostAlive(host);
        captureCookie(res);
        return { body: text, host, url };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        errors.push(`${host} ${msg}`);
        logI(`[hosts] ${host} 失败: ${msg}`);
        markHostDead(host, msg);
      }
    }
    return null;
  };

  const hit = await tryAll();
  if (hit) return hit;

  // 全部已知域名失败 → 去发布页拉新域名（被动触发），再重试一轮
  await ensureHostsFresh(true);

  // 重试前重排：把「已判死」和「失败过」的域名排到池尾，让新增的干净域名优先。
  // （markHostDead 在池里只剩一个域时不会删除，避免清空池；
  //   而第一次失败只累加 fail=1，此时 dead 还是 false，所以这里按 fail 排序。）
  HOSTS.sort((a, b) => {
    const ha = hostHealth[a] || {}, hb = hostHealth[b] || {};
    const da = ha.dead ? 2 : (Number(ha.fail || 0) > 0 ? 1 : 0);
    const db = hb.dead ? 2 : (Number(hb.fail || 0) > 0 ? 1 : 0);
    return da - db;
  });
  // 彻底剔除已判死的（保留至少一个）
  for (let i = HOSTS.length - 1; i >= 0 && HOSTS.length > 1; i--) {
    if (hostHealth[HOSTS[i]] && hostHealth[HOSTS[i]].dead) {
      logI(`[hosts] 清理已判死域名 ${HOSTS[i]}`);
      HOSTS.splice(i, 1);
    }
  }
  PREFERRED = 0;
  logI(`[hosts] 重试域名顺序: ${HOSTS.join(', ')}`);
  const retry = await tryAll();
  if (retry) return retry;

  throw new Error(`全部基址失败: ${errors.join(' | ')}`);
}
async function cachedPage(path, ttl, tag) {
  const key = shortKey('quanji:page', path);
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try {
      const hit = await OmniBox.getCache(key);
      if (hit && String(hit).length > 300) {
        logI(`[${tag}] 命中页面缓存 path=${path}`);
        return { body: String(hit), host: HOSTS[PREFERRED], cached: true };
      }
    } catch (e) { logI(`[${tag}] 读缓存失败: ${e.message}`); }
  }
  const res = await fetchPage(path);
  if (ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, res.body, ttl); } catch (e) { logI(`[${tag}] 写缓存失败: ${e.message}`); }
  }
  return Object.assign({ cached: false }, res);
}
async function cachedText(key, ttl, producer) {
  if (ttl > 0 && OmniBox && typeof OmniBox.getCache === 'function') {
    try { const v = await OmniBox.getCache(key); if (v) return String(v); } catch (_) {}
  }
  const value = await producer();
  if (value && ttl > 0 && OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(key, value, ttl); } catch (_) {}
  }
  return value;
}
// ==================== 请求与缓存结束 ====================

// ==================== 列表 / 分页解析 ====================
function parseCards(html, host) {
  const list = [];
  const seen = new Set();
  const re = /<div class="item thumb thumb--videos"[^>]*>\s*<a href="(watch\.jsp\?v=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const vodId = decodeHTML(m[1]).trim();
    if (!vodId || seen.has(vodId)) continue;
    const b = m[2];
    const imgM = /<img[^>]*\bsrc="([^"]+)"/i.exec(b);
    const tM = /<h5[^>]*class="[^"]*thumb-spot__title[^"]*"[^>]*>([\s\S]*?)<\/h5>/i.exec(b);
    const title = cleanText(tM ? tM[1] : '');
    if (!title) continue;
    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: title,
      vod_pic: imgM ? absUrl(imgM[1], host) : '',
      vod_tag: 'video',
      vod_remarks: '',
      vod_content: '',
    });
  }
  return list;
}
/** 解析 <ul class="pagination">：页码 -> token，以及末页号 */
function parsePagination(html) {
  const out = { tokens: {}, pagecount: 0 };
  const b = /<ul class="pagination"[\s\S]*?<\/ul>/i.exec(String(html || ''));
  if (!b) return out;
  const re = /<li[^>]*>\s*<a[^>]*href="\?t=([^&"]+)&p=([^"]+)"[^>]*>(\d+)<\/a>/gi;
  let m;
  while ((m = re.exec(b[0])) !== null) {
    const t = decodeHTML(m[1]);
    const token = decodeHTML(m[2]);
    const page = Number(m[3]);
    if (t && token && page > 0) {
      out.tokens[page] = token;
      if (page > out.pagecount) out.pagecount = page;
    }
  }
  return out;
}
/** 从隐藏 goto 表单读 baseToken（站点自带的分页基串，实测不能直接跳页，仅作诊断） */
function parseGotoBase(html) {
  const m = /location\.href='\?t=([^&']+)&p=([^=]+)=/i.exec(String(html || ''));
  return m ? { t: decodeHTML(m[1]), base: decodeHTML(m[2]) } : null;
}
// ==================== 列表 / 分页解析结束 ====================

// ==================== tag 分页 token 链 ====================
// 进程内 Map + SDK 双层缓存；key 用短哈希控制长度
const TOKEN_MEM = new Map();
function tokenKey(t) { return shortKey('quanji:tokens', t); }
async function loadTokens(t) {
  const hit = TOKEN_MEM.get(t);
  if (hit && hit.exp > Date.now()) return hit.map;
  let map = { 1: '' };
  if (OmniBox && typeof OmniBox.getCache === 'function') {
    try {
      const raw = await OmniBox.getCache(tokenKey(t));
      if (raw) {
        const obj = JSON.parse(String(raw));
        if (obj && typeof obj === 'object') map = Object.assign(map, obj);
      }
    } catch (_) {}
  }
  Object.assign(map, SEED_TOKENS[t] || {});
  TOKEN_MEM.set(t, { map, exp: Date.now() + TOKEN_TTL * 1000 });
  return map;
}
async function saveTokens(t, map) {
  TOKEN_MEM.set(t, { map, exp: Date.now() + TOKEN_TTL * 1000 });
  if (OmniBox && typeof OmniBox.setCache === 'function') {
    try { await OmniBox.setCache(tokenKey(t), JSON.stringify(map), TOKEN_TTL); } catch (_) {}
  }
}
/** 逐页跟随分页链接，把「页码 -> token」补齐到 want 页为止 */
async function ensureToken(t, want, tag) {
  const map = await loadTokens(t);
  if (map[want] !== undefined) return map;
  // 游标只沿「1 起连续已知」的链往前走；预置的高页 token（如第 3 页）不能把游标
  // 直接跳过去，否则第 2 页 token 永远不会被补上。
  let page = 1;
  while (map[page] !== undefined) page++;
  page -= 1;
  let html = '';
  let pagecount = 0;
  for (let step = 0; step < MAX_WALK && page < want; step++) {
    const token = map[page] || '';
    const path = token ? `tag.jsp?t=${t}&p=${encodeURIComponent(token)}` : `tag.jsp?t=${t}`;
    const res = await cachedPage(path, CACHE_TTL, tag);
    html = res.body;
    const pg = parsePagination(html);
    if (pg.pagecount) pagecount = pg.pagecount;
    const next = page + 1;
    if (!pg.tokens[next]) {
      logI(`[${tag}] 分页链在 ${page} 页断了（无 ${next} 页 token），停止跟随`);
      break;
    }
    map[next] = pg.tokens[next];
    // 顺手把本页可见的其它页码 token 一起记下来
    for (const [k, v] of Object.entries(pg.tokens)) map[k] = v;
    page = next;
    await saveTokens(t, map);
    logI(`[${tag}] 分页链推进到 ${page}/${want} token=${map[page]}`);
  }
  return map;
}
// ==================== tag 分页 token 链结束 ====================

// ==================== 详情 / 播放解析 ====================
function normalizeWatchPath(vodId) {
  let v = decodeHTML(String(vodId || '')).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    try { const u = new URL(v); v = `${u.pathname}${u.search}`; } catch (_) { return ''; }
  }
  v = v.replace(/^\/+/, '');
  // 只接受本模板的 watch.jsp?v=<id>
  const m = /^watch\.jsp\?v=([A-Za-z0-9]+)$/i.exec(v);
  return m ? `watch.jsp?v=${m[1]}` : '';
}
/** 解码 eval(I("...")) 里的 DPlayer url */
function extractPlayUrl(html) {
  const s = String(html || '');
  const m = /eval\(I\(["']([\s\S]*?)["']\)\)/i.exec(s);
  if (!m) return '';
  let js = '';
  try { js = decodeI(m[1]); } catch (_) { return ''; }
  const u = /video\s*:\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/i.exec(js)
    || /url\s*:\s*['"](https?:[^'"]+)['"]/i.exec(js);
  if (!u) return '';
  return decodeHTML(u[1]).trim();
}
function parseDetail(html, host, vodId) {
  const s = String(html || '');
  const titleM = /<h1 class="title">([\s\S]*?)<\/h1>/i.exec(s) || /<title>([\s\S]*?)<\/title>/i.exec(s);
  const title = cleanText(titleM ? titleM[1] : '') || vodId;
  // 封面：详情页无 poster，用相关视频首图之外不猜；列表态的封面由宿主自带
  const durM = /(\d{1,2}:\d{2}(?::\d{2})?)/.exec(s);
  return {
    vod_id: vodId,
    vod_name: title,
    vod_pic: '',
    vod_tag: 'video',
    type_name: '',
    vod_remarks: durM ? durM[1] : '',
    vod_content: '',
    vod_play_from: '木瓜视频',
    vod_play_url: `播放$${vodId}`,
    vod_play_sources: [{ name: '木瓜视频', episodes: [{ name: '播放', playId: vodId }] }],
  };
}
// ==================== 详情 / 播放解析结束 ====================

// ==================== 五个 handler ====================
async function home(params, context) {
  const from = (context && context.from) || (params && params.source) || 'web';
  logI(`[home] 入口 params=${JSON.stringify(params || {})} from=${from}`);
  try {
    const res = await cachedPage('/', CACHE_TTL, 'home');
    const list = await resolveCovers(parseCards(res.body, res.host), res.host);
    logI(`[home] 返回 ${list.length} 条 cached=${res.cached}`);
    return { class: CATEGORIES, filters: {}, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, filters: {}, list: [] };
  }
}

async function category(params, context) {
  const p = params || {};
  const filters = p.filters || p.extend || p.ext || {};
  const tid = p.categoryId || p.type_id || p.tid
    || (filters && (filters.categoryId || filters.type_id || filters.tid))
    || CATEGORIES[0].type_id;
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  const tag = `category:${tid}`;
  logI(`[category] 入口 tid=${tid}(${CAT_NAME[tid] || '?'}) page=${page} from=${from}`);
  try {
    let path = `tag.jsp?t=${encodeURIComponent(tid)}`;
    let pagecount = 0;
    if (page > 1) {
      const map = await ensureToken(tid, page, tag);
      const token = map[page];
      if (token) path += `&p=${encodeURIComponent(token)}`;
      else logI(`[category] 未拿到第 ${page} 页 token，回退使用最近可用页`);
      for (const k of Object.keys(map)) { const n = Number(k); if (n > pagecount) pagecount = n; }
    }
    let res = await cachedPage(path, CACHE_TTL, tag);
    let list = parseCards(res.body, res.host);
    if (!list.length) { res = await fetchPage(path); list = parseCards(res.body, res.host); }
    list = await resolveCovers(list, res.host);
    const pg = parsePagination(res.body);
    if (pg.pagecount) {
      pagecount = Math.max(pagecount, pg.pagecount);
      // 把当前页可见的 token 也存进链，后续翻页少走几步
      const map = await loadTokens(tid);
      let changed = false;
      for (const [k, v] of Object.entries(pg.tokens)) { if (map[k] !== v) { map[k] = v; changed = true; } }
      if (changed) await saveTokens(tid, map);
    }
    logI(`[category] 返回 ${list.length} 条 path=${path} pagecount=${pagecount}`);
    return {
      page,
      pagecount: pagecount || page,
      total: (pagecount || page) * PAGE_SIZE,
      limit: PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function search(params, context) {
  const p = params || {};
  const kw = String(p.keyword || p.wd || p.key || '').trim();
  const page = safeInt(p.page || p.pg, 1);
  const from = (context && context.from) || p.source || 'web';
  if (!kw) { logI('[search] 关键词为空，直接返回空结果'); return { page: 1, pagecount: 0, total: 0, limit: SEARCH_PAGE_SIZE, list: [] }; }
  const path = `/search.jsp?keyword=${encodeURIComponent(kw)}&p=${page}`;
  logI(`[search] 入口 kw=${kw} page=${page} from=${from}`);
  try {
    let res = await cachedPage(path, CACHE_TTL, 'search');
    let list = parseCards(res.body, res.host);
    if (!list.length) { res = await fetchPage(path); list = parseCards(res.body, res.host); }
    list = await resolveCovers(list, res.host);
    // 搜索页无分页区：本页有数据就认为还有下一页（空页时回退到当前页）
    const pagecount = list.length ? page + 1 : Math.max(1, page - 1);
    logI(`[search] "${kw}" 返回 ${list.length} 条 pagecount=${pagecount}`);
    return {
      page,
      pagecount,
      total: pagecount * SEARCH_PAGE_SIZE,
      limit: SEARCH_PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: SEARCH_PAGE_SIZE, list: [] };
  }
}

async function detail(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.vod_id || p.id || p.videoId || '');
  const vodId = normalizeWatchPath(raw);
  const from = (context && context.from) || p.source || 'web';
  logI(`[detail] 入口 videoId=${vodId || '(空)'} from=${from}`);
  if (!vodId) return { list: [] };
  try {
    const res = await cachedPage(vodId, DETAIL_TTL, 'detail');
    const item = parseDetail(res.body, res.host, vodId);
    if (item && item.vod_pic) {
      try { item.vod_pic = await resolveCover(item.vod_pic, res.host); } catch (_) {}
    }
    const direct = extractPlayUrl(res.body);
    logI(`[detail] 标题="${item.vod_name.slice(0, 60)}" 直链=${direct ? direct.slice(0, 100) : '无'}`);
    // 列表态已带封面，这里把已知直链透传进 playId 之外不做额外请求
    return { list: [item] };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = params || {};
  const raw = typeof params === 'string' ? params : (p.playId || p.play_id || p.id || p.url || p.vod_id || '');
  const playId = decodeHTML(String(raw || '')).trim();
  const from = (context && context.from) || p.source || 'web';
  logI(`[play] 入口 playId=${playId.slice(0, 120)} from=${from} mode=${PLAY_MODE}`);
  if (!playId) return { urls: [], flag: '', header: {}, parse: 0, danmaku: [] };

  const header = { 'User-Agent': UA, Referer: `${HOSTS[PREFERRED]}/` };

  // 已经是媒体直链：直通
  if (/^https?:\/\//i.test(playId) && MEDIA_RE.test(playId)) {
    logI('[play] playId 即媒体直链，直通 parse=0');
    return { urls: [{ name: '直连', url: playId }], flag: '', header, parse: 0, danmaku: [] };
  }

  const watchPath = normalizeWatchPath(playId);
  if (!watchPath) { logE(`[play] playId 非站内 watch 路径: ${playId.slice(0, 80)}`); return { urls: [], flag: '', header, parse: 0, danmaku: [] }; }

  // 三段式：① 反混淆直链 → ② SDK 嗅探 → ③ 播放页 parse=1
  const direct = await cachedText(shortKey('quanji:play', watchPath), PLAY_TTL, async () => {
    if (PLAY_MODE === 'sniff') return '';
    try {
      const res = await fetchPage(watchPath);        // 播放不走页面缓存，避免签名过期
      const url = extractPlayUrl(res.body);
      if (!url) { logI('[play] 详情页未解出 eval(I(...)) 直链'); return ''; }
      if (!/^https?:\/\//i.test(url) || !MEDIA_RE.test(url)) { logI(`[play] 解出的地址非媒体: ${url.slice(0, 100)}`); return ''; }
      logI(`[play] 直链解析成功: ${url.slice(0, 120)}`);
      return url;
    } catch (e) { logI(`[play] 直链解析失败: ${e.message}`); return ''; }
  });
  if (direct) return { urls: [{ name: '原画', url: direct }], flag: '', header, parse: 0, danmaku: [] };

  const pageUrl = absUrl(watchPath, HOSTS[PREFERRED]);
  if (PLAY_MODE !== 'direct' && OmniBox && typeof OmniBox.sniffVideo === 'function') {
    try {
      const sniffed = await OmniBox.sniffVideo(pageUrl, header);
      const url = typeof sniffed === 'string' ? sniffed.trim() : (sniffed && sniffed.url ? String(sniffed.url) : '');
      if (url && /^https?:\/\//i.test(url)) {
        logI(`[play] SDK 嗅探成功: ${url.slice(0, 120)}`);
        return { urls: [{ name: '嗅探', url }], flag: '', header, parse: 0, danmaku: [] };
      }
      logI('[play] SDK 嗅探无结果，回退播放页 parse=1');
    } catch (e) { logI(`[play] SDK 嗅探异常: ${e.message}`); }
  }
  logI(`[play] 回退播放页交给播放器嗅探: ${pageUrl}`);
  return { urls: [{ name: '播放页', url: pageUrl }], flag: '', header, parse: 1, danmaku: [] };
}
// ==================== 五个 handler 结束 ====================

const exported = { home, category, detail, search, play };
module.exports = exported;
runner.run(exported);
