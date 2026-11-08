/**
 * @name 91porn
 * @version 1.5.0
 * @description 91porn.com 采集源（OmniBox Spider，多基址容灾：主站 + 91p618 镜像；列表封面/标题反混淆真值回填）
 * @downloadURL https://raw.githubusercontent.com/omnibox-spider/main/影视/采集/91porn.js
 * @dependencies []
 */

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) { OmniBox = { log(l, m) { console.log(`[${l}] ${m}`); }, getCache() { return null; }, setCache() { return Promise.resolve(); }, deleteCache() { return Promise.resolve(); } }; }
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const https = require('https');
const http = require('http');

const USER_AGENT = process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LANG = process.env.LANG_COOKIE || 'cn_CN';
const COOKIE = process.env.NINETYONE_COOKIE || "";
// 视频代理基址（可选）。91porn 的 mp4 签名绑 IP，OK影视 直接拉永远 403；
// 配置本项后，play() 走代理（代理同机取签名+取流），OK影视 只跟代理通信即可播放。
const NINETYONE_PROXY_BASE = (() => {
  let b = (process.env.NINETYONE_PROXY_BASE || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (b && !/^https?:\/\//i.test(b)) b = 'http://' + b;
  return b;
})();
// 播放策略：默认 auto=真实直链优先、全失败才回退「推荐栏形态播放页」嗅探。
// 站点 player.preroll 广告仅 1 秒(skipTime:1)，首页推荐项常被宿主预热，
// 嗅探落在广告窗口之后能拿到真视频；分类/搜索冷启动首访则容易撞进广告。
// 置 sniff 可强制走旧嗅探模式（复现/兼容特定端），always 则两种线路一起给。
// 推荐栏形态：c=uyklk&viewtype=&category=，与首页真实链接一致。
const NINETYONE_PLAY_MODE = String(process.env.NINETYONE_PLAY_MODE || 'auto').trim().toLowerCase();

// 站点基址容灾：主站 + 91p618.com 最终镜像落点（903.9p234.com）。
// 91p618.com 本身只是 meta-refresh 跳板，不可直接请求，因此填其最终落点。
// SITE_API 仍可单独覆盖主站；SITE_HOSTS 可用逗号自定义多个基址（会追加镜像为兜底）。
const PRIMARY_API = (process.env.SITE_API || 'https://91porn.com').replace(/\/+$/, '');
const MIRROR_API = 'https://903.9p234.com';
const HOSTS = (() => {
  const fromEnv = String(process.env.SITE_HOSTS || PRIMARY_API)
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return Array.from(new Set([...fromEnv, MIRROR_API]));
})();
let PREFERRED = 0; // 上次成功的基址下标，下次优先
const PREFIX = '[91porn]';
function logI(m) { try { OmniBox.log('info', `${PREFIX} ${m}`); } catch (_) {} }
function logE(m) { try { OmniBox.log('error', `${PREFIX} ${m}`); } catch (_) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATEGORIES = [
  { type_id: 'hot', type_name: '今日热门' },
  { type_id: 'watch', type_name: '最新' },
  { type_id: 'rp', type_name: '最近得分' },
  { type_id: 'tf', type_name: '本月收藏' },
  { type_id: 'md', type_name: '本月讨论' },
  { type_id: 'mf', type_name: '本月收藏最多' },
  { type_id: 'rf', type_name: '最近加精' },
  { type_id: 'top', type_name: '本月最热' },
  { type_id: 'top&m=-1', type_name: '上月最热' },
  { type_id: 'hd', type_name: '高清' }
];

function httpRequest(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const baseCookie = `language=${LANG}`;
    const headers = Object.assign(
      { 'User-Agent': USER_AGENT, Accept: '*/*', Cookie: COOKIE ? `${baseCookie}; ${COOKIE}` : baseCookie, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      options.headers || {}
    );
    const req = client.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: options.method || 'GET', headers, timeout: options.timeout || 15000, rejectUnauthorized: false },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return httpRequest(new URL(res.headers.location, u.href).href, options, redirectCount + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8'), _host: u.host }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// 基址容灾：相对路径按 HOSTS 顺序尝试（优选基址优先），网络错误/403/5xx/空体自动切下一个。
async function fetchWithFailover(path, options = {}) {
  const order = [PREFERRED, ...HOSTS.map((_, i) => i).filter(i => i !== PREFERRED)];
  let lastErr;
  for (const idx of order) {
    const host = HOSTS[idx];
    try {
      const res = await httpRequest(`${host}${path}`, options);
      // 视为失败的响应：5xx、403（Cloudflare 拦截/封禁）、空体
      if (res.statusCode >= 500 || res.statusCode === 403 || !res.body) {
        logE(`[failover] ${host}${path} -> HTTP ${res.statusCode}${!res.body ? ' 空体' : ''}, 切下一个`);
        lastErr = new Error(`HTTP ${res.statusCode}`);
        continue;
      }
      if (idx !== PREFERRED) { PREFERRED = idx; logI(`[failover] 切换优选基址 -> ${host}`); }
      return { ...res, host };
    } catch (e) {
      logE(`[failover] ${host}${path} -> ${e.message}, 切下一个`);
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有基址均不可用');
}

// 清洗站点文本：去标签/实体，并剔除 91porn 标题里大量插入的变体选择符(U+FE00-FE0F)、零宽字符、软连字符。
// 列表页标题常带 [原创]/[国产] 之类营销前缀，与详情页真实片名不同，统一剥离。
function cleanText(s, stripPrefix) {
  let t = String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (stripPrefix) t = t.replace(/^\s*\[[^\]]{1,12}\]\s*/g, '').trim();
  return t;
}

// 简介保留 <br> 换行，其余按 cleanText 规则清洗。
function cleanDesc(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF\u00AD]/g, '')
    .split('\n').map(x => x.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}

// 从详情页主区抓取统计信息（时长/热度/留言/收藏/积分），只限 #useraction 区，避免误抓推荐区。
function extractDetailStat(html, label) {
  const uaM = html.match(/<div[^>]*id=["']useraction["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!uaM) return '';
  const m = uaM[1].match(new RegExp(label + '\\s*[:：]\\s*<span[^>]*>([\\s\\S]*?)<\\/span>', 'i'));
  return m ? cleanText(m[1]) : '';
}

// 91porn 2026-11-04 起在详情页尾部挂「title loader」反混淆：
// 静态 <title>/<h4>/作者/时长 每次请求都是随机假值，真实片名/作者/时长藏在隐藏 <i> 的
// data-xxx / data-xxxu / data-xxxd 属性里，由脚本里的 m(编码模式) + k(xor key) 解密。
// 浏览器端靠 2~6 秒延时或首次交互才把真值替换回 DOM；服务端直接读 HTML 必须自己解。
function decode95Payload(e, mode, key) {
  if (!e || !key) return '';
  try {
    let buf;
    if (mode === 1) {
      buf = Buffer.from(String(e).replace(/[^0-9a-f]/gi, ''), 'hex');
    } else {
      let s = String(e);
      if (mode === 2) s = s.split('').reverse().join('');
      while (s.length % 4) s += '=';
      buf = Buffer.from(s, 'base64');
      if (mode === 4) buf = Buffer.from(buf).reverse();
    }
    const k = Buffer.from(String(key), 'utf-8');
    if (!buf.length || !k.length) return '';
    const out = Buffer.alloc(buf.length);
    for (let j = 0; j < buf.length; j++) out[j] = buf[j] ^ k[j % k.length];
    return out.toString('utf-8');
  } catch (_) { return ''; }
}

function extract95RealMeta(html) {
  const meta = { ok: false, title: '', author: '', duration: '', at: '', mode: 0 };
  // 脚本形态：var m=1,id="x8fbfd3",at="data-0a918",k="a4d247ed";
  const cfgM = html.match(/var\s+m\s*=\s*(\d+)\s*,\s*id\s*=\s*["']([^"']+)["']\s*,\s*at\s*=\s*["']([^"']+)["']\s*,\s*k\s*=\s*["']([^"']*)["']/i);
  if (!cfgM) return meta;
  const mode = parseInt(cfgM[1], 10);
  const id = cfgM[2], at = cfgM[3], key = cfgM[4];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const elM = html.match(new RegExp('<i[^>]*\\bid=["\']?' + esc(id) + '["\']?[^>]*>', 'i'));
  if (!elM) return meta;
  const el = elM[0];
  const attr = (name) => {
    const m = el.match(new RegExp('(?:^|\\s)' + esc(name) + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
    return m ? m[1] : '';
  };
  const strip = (s) => cleanText(s).replace(/[\uFE00-\uFE0F]/g, '').trim();
  meta.mode = mode; meta.at = at;
  meta.title = strip(decode95Payload(attr(at), mode, key));
  meta.author = strip(decode95Payload(attr(at + 'u'), mode, key));
  const secs = strip(decode95Payload(attr(at + 'd'), mode, key));
  const n = parseInt(secs, 10);
  if (Number.isFinite(n) && n > 0) {
    const p2 = (x) => (x < 10 ? '0' : '') + x;
    meta.duration = `${p2(Math.floor(n / 3600))}:${p2(Math.floor(n / 60) % 60)}:${p2(n % 60)}`;
  }
  meta.ok = !!(meta.title || meta.author || meta.duration);
  return meta;
}

// 91porn 列表页反爬实测结论（2026-11，3 份列表页 x 24 viewkey 全量核对）：
//   * 同一 viewkey 会在列表页出现多个卡片（主列表区 + 推荐/相关区），且列表页每次请求
//     都把「标题 / 封面 img src / 作者 / 时长 / playvthumb_ID」在卡片间随机打乱。
//     于是同一封面被贴到多张卡（封面重复），列表封面/标题与详情页真实视频对不上。
//   * 判别真值卡的可靠信号（实测 72 组卡片零假阳性零漏判）：
//       卡片内 playvthumb_<ID> 的数字 == img src 的 /thumb/<ID>.jpg 数字
//     —— 这个「真值卡」的 ID == 详情页 <video poster=".../thumb/<同一ID>.jpg">，
//        跨请求稳定、逐 viewkey 唯一；其标题、作者、时长也都是真值。
//     其余「污染卡」的 playvthumb_ID、img_ID、标题彼此不一致，全是被打乱的假值。
//   * 详情页 <title> 与 <video poster> 是权威真值（多次请求完全一致）；
//     title loader 反混淆配置时有时无，有配置时隐藏 <i> data-* 解密值同样为真值。
// 因此：parseList 按 viewkey 分组、只保留「真值卡」，用真值卡 ID 拼 CDN 封面（零额外请求、
//       绝对正确、不重复），标题直接用真值卡标题；enrichListTitles 再以「缓存 + 限并发」
//       抓详情页 <title> 做二次确认/兜底，失败不阻塞、降级保留真值卡标题。
// CDN 封面基址（从列表 img 提取 host），形如 https://xxx/thumb/1257796.jpg
const THUMB_HOST_RE = /https?:\/\/[^"'\/]+\/thumb\//i;
const REAL_TITLE_MEM = new Map();      // viewkey -> { title, exp } 进程内
const REAL_TITLE_TTL = 6 * 3600;       // 真实标题缓存 6h
const ENRICH_CONCURRENCY = 4;          // 列表标题回填限并发
const LIST_TITLE_CACHE = new Map();    // viewkey -> 真值卡标题（enrich 失败时的兜底）

function buildCacheKey(prefix, raw) {
  let s = String(raw || '');
  // SDK 缓存 key 有长度上限，超长一律哈希归一化
  if (s.length > 160) s = require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 24);
  return `${prefix}:${s}`;
}
async function getCachedRealTitle(viewkey) {
  const mem = REAL_TITLE_MEM.get(viewkey);
  if (mem && mem.exp > Date.now()) return mem.title;
  try {
    const v = await OmniBox.getCache(buildCacheKey('91real', viewkey));
    if (v) {
      const t = typeof v === 'string' ? v : String(v);
      REAL_TITLE_MEM.set(viewkey, { title: t, exp: Date.now() + REAL_TITLE_TTL * 1000 });
      return t;
    }
  } catch (_) {}
  return '';
}
async function setCachedRealTitle(viewkey, title) {
  if (!viewkey || !title) return;
  REAL_TITLE_MEM.set(viewkey, { title, exp: Date.now() + REAL_TITLE_TTL * 1000 });
  try { await OmniBox.setCache(buildCacheKey('91real', viewkey), String(title), REAL_TITLE_TTL); } catch (_) {}
}

// 从详情页 HTML 提取「真实标题」：优先级 静态 <title> > h4.login_register_header > title loader 解密。
// 实测 <title> 稳定等于真值；loader 有配置时解密值亦为真值，二者一致。
function extractRealTitle(html) {
  const tagM = html.match(/<title>([\s\S]*?)<\/title>/i);
  let t = tagM ? cleanText(tagM[1]).replace(/\s*-\s*91porn\s*$/i, '').trim() : '';
  if (t && !/^\s*91porn\s*$/i.test(t)) return t;
  const h4M = html.match(/<h4[^>]*class=["'][^"']*login_register_header[^"']*["'][^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i)
    || html.match(/<h4[^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i);
  t = h4M ? cleanText(h4M[1], true) : '';
  if (t) return t;
  const realMeta = extract95RealMeta(html);
  return realMeta.ok && realMeta.title ? realMeta.title : '';
}

// 列表标题回填：限并发抓取详情页 <title>，命中缓存直接跳过；失败不阻塞、降级保留列表标题。
async function enrichListTitles(list, tag) {
  if (!Array.isArray(list) || !list.length) return list;
  const queue = list.slice();
  let ok = 0, cached = 0, failed = 0;
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item || !item.vod_id) continue;
      try {
        const hit = await getCachedRealTitle(item.vod_id);
        if (hit) { item.vod_name = hit; cached++; continue; }
        const res = await fetchWithFailover(`/view_video.php?viewkey=${item.vod_id}`, {
          headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
        });
        const real = extractRealTitle(res.body || '');
        if (real) {
          item.vod_name = real;
          LIST_TITLE_CACHE.set(item.vod_id, real);
          await setCachedRealTitle(item.vod_id, real);
          ok++;
        } else failed++;
      } catch (e) { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, list.length) }, worker));
  logI(`[${tag}][enrich] 标题回填 命中缓存=${cached} 新抓成功=${ok} 失败降级=${failed} 总数=${list.length}`);
  return list;
}

function parseList(html) {
  // 取列表里 CDN 封面基址（host 固定），用于按真值卡 ID 拼稳定封面。
  const hostM = html.match(THUMB_HOST_RE);
  const thumbBase = hostM ? hostM[0] : '';
  // 收集所有候选卡片：按 viewkey 分组（同一 viewkey 有真值卡 + 若干污染卡）。
  // 卡片形态：<a href="...viewkey=..."> ... id="playvthumb_<ID>" ... <img src=".../thumb/<ID2>.jpg"> ... <span class="video-title">TITLE</span> ... </a>
  const byVk = new Map();
  const blockRe = /<a[^>]*href="[^"]*view_video\.php\?viewkey=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const viewkey = m[1];
    const block = m[2];
    const imgM = block.match(/<img[^>]*src="([^"]*thumb[^"]*)"[^>]*>/i) || block.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"[^>]*>/i);
    if (!imgM) continue;
    const ptM = block.match(/playvthumb_(\d+)/i);
    const imgIdM = imgM[1].match(/\/(\d+)\.jpg/i);
    const titleM = block.match(/<span[^>]*class="[^"]*video-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const cand = {
      ptId: ptM ? ptM[1] : '',
      imgId: imgIdM ? imgIdM[1] : '',
      imgUrl: imgM[1],
      title: cleanText(titleM ? titleM[1] : '', true),
      // 判别信号：playvthumb_ID == img_ID 才是未被打乱的真值卡
      isReal: !!(ptM && imgIdM && ptM[1] === imgIdM[1])
    };
    if (!byVk.has(viewkey)) byVk.set(viewkey, []);
    byVk.get(viewkey).push(cand);
  }
  const list = [];
  let realCount = 0, fallbackCount = 0;
  for (const [viewkey, cands] of byVk) {
    // 优先真值卡；若无（极端情况全被打乱）退回第一张卡，保证有结果。
    let c = cands.find(x => x.isReal);
    if (c) realCount++;
    else { c = cands[0]; fallbackCount++; }
    const realId = c.ptId || c.imgId;
    // 封面用真值卡 ID 拼 CDN 地址（稳定、不重复）；无 ID 时退回落列表 img。
    const cover = (realId && thumbBase) ? `${thumbBase}${realId}.jpg` : c.imgUrl;
    let title = c.title || viewkey;
    // 标题真值（真值卡标题）记入缓存，供 detail()/enrich 失败时兜底。
    if (title && title !== viewkey) LIST_TITLE_CACHE.set(viewkey, title);
    list.push({ vod_id: viewkey, vod_name: title, vod_pic: cover, vod_tag: 'video' });
  }
  logI(`[parseList] 卡片分组=${byVk.size} 真值卡命中=${realCount} 无真值卡降级=${fallbackCount}`);
  return list;
}

async function home(params) {
  logI(`[home] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const res = await fetchWithFailover(`/index.php`);
    const list = await enrichListTitles(parseList(res.body), 'home');
    logI(`[home] 命中 ${res.host} 返回 ${list.length} 条`);
    return { class: CATEGORIES, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, list: [] };
  }
}

async function category(params) {
  logI(`[category] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const tid = (params && (params.categoryId || params.type_id || params.tid)) || 'hot';
    const page = parseInt((params && (params.page || params.pg)) || '1', 10) || 1;
    let path;
    if (tid === 'hot' || tid === 'watch') {
      path = `/v.php?next=watch&page=${page}`;
    } else if (tid.includes('&')) {
      path = `/v.php?category=${tid}&page=${page}`;
    } else {
      path = `/v.php?category=${tid}&viewtype=basic&page=${page}`;
    }
    const res = await fetchWithFailover(path);
    const list = await enrichListTitles(parseList(res.body), 'category');
    logI(`[category] 命中 ${res.host} tid=${tid} page=${page} 返回 ${list.length} 条`);
    return { page, pagecount: 99, limit: 20, total: list.length * 99, list };
  } catch (e) {
    logE(`[category] 失败: ${e.message}`);
    return { page: 1, pagecount: 1, limit: 20, total: 0, list: [] };
  }
}

async function detail(params) {
  logI(`[detail] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.vod_id || params.id || params.videoId)) || '';
    const viewkey = String(raw).split('#')[0].trim();
    if (!viewkey) return { list: [] };
    const res = await fetchWithFailover(`/view_video.php?viewkey=${viewkey}`, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    const host = res.host;
    const html = res.body;
    // 标题真值来源（实测修正，推翻旧注释「静态 <title> 是随机假值」的认知）：
    //   * 91porn 被打乱的是【列表页】；详情页 <title> / <video poster> 多次请求完全稳定、逐 viewkey 唯一，是权威真值。
    //   * title loader 反混淆配置时有时无，有配置时隐藏 <i> 的 data-* 解密值同样为真值，与 <title> 一致。
    //   * 列表页缓存的标题已被打乱，优先级最低，仅作兜底。
    // 页面底部「本月热播中」推荐区的 <span class="video-title"> 绝不能当当前视频标题。
    const realMeta = extract95RealMeta(html);
    const detailH4M = html.match(/<h4[^>]*class=["'][^"']*login_register_header[^"']*["'][^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i)
      || html.match(/<h4[^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i);
    let title = extractRealTitle(html);           // 详情 <title> > h4 > loader 解密（均为真值）
    let titleFrom = 'detail_page(静态真<title>/loader)';
    if (!title && realMeta.ok && realMeta.title) { title = realMeta.title; titleFrom = 'title_loader(解密真实片名)'; }
    if (!title && LIST_TITLE_CACHE.has(viewkey)) {
      title = LIST_TITLE_CACHE.get(viewkey);
      titleFrom = 'list_title_cache(已被打乱,仅兜底)';
    }
    if (!title && detailH4M) { title = cleanText(detailH4M[1]); titleFrom = 'h4.login_register_header[align=left](静态回退)'; }
    if (!title) { title = viewkey; titleFrom = 'viewkey(fallback)'; }
    // 详情真值写回双层缓存，供列表 enrichListTitles 直接命中，避免重复抓详情。
    if (title && title !== viewkey) {
      LIST_TITLE_CACHE.set(viewkey, title);
      await setCachedRealTitle(viewkey, title);
    }
    // 封面：优先主播放器 <video id="player_one" poster="...">（= 真实视频ID，跨请求稳定），绝不使用推荐区 img-responsive。
    const posterM = html.match(/<video[^>]*id=["']player_one["'][^>]*poster=["']([^"']+)["']/i)
      || html.match(/poster=["']([^"']+)["']/i);
    const cover = posterM ? posterM[1] : '';
    // 详情页元数据：真实作者/时长优先用 title loader 解密值，其余取 #useraction 统计区 / 视频信息区 / #v_desc 简介区。
    const duration = realMeta.duration || extractDetailStat(html, '时长');
    const views = extractDetailStat(html, '热度');
    const comments = extractDetailStat(html, '留言');
    const favorites = extractDetailStat(html, '收藏');
    const dateM = html.match(/添加时间[\s\S]{0,200}?(\d{4}-\d{2}-\d{2})/i);
    const addDate = dateM ? dateM[1] : '';
    const authorM = html.match(/作者[\s\S]{0,400}?<span[^>]*class=["']title["'][^>]*>\s*([A-Za-z0-9_.\-]+)/i);
    const author = realMeta.author || (authorM ? authorM[1] : '');
    const descM = html.match(/<div[^>]*id=["']?v_desc["']?[^>]*>([\s\S]*?)<\/div>/i);
    const content = descM ? cleanDesc(descM[1]) : '';
    const remarksParts = [duration && `时长 ${duration}`, views && `热度 ${views}`, addDate].filter(Boolean);
    const vod_remarks = remarksParts.join(' · ');
    const vod_content = [
      title,
      author && `作者：${author}`,
      addDate && `添加时间：${addDate}`,
      duration && `时长：${duration}`,
      views && `热度：${views}`,
      comments && `留言：${comments}`,
      favorites && `收藏：${favorites}`,
      content && `\n${content}`
    ].filter(Boolean).join('\n').trim();
    logI(`[detail] 命中 ${host} viewkey=${viewkey} 标题="${title.slice(0, 60)}" 来源=${titleFrom} titleLoader=${realMeta.ok ? `命中(m=${realMeta.mode},${realMeta.at})` : '未命中'} 封面=${cover ? '有' : '无'} 作者=${author || '-'} 时长=${duration || '-'} 简介长度=${content.length}`);
    return {
      list: [{
        vod_id: viewkey,
        vod_name: title,
        vod_pic: cover,
        vod_content,
        vod_actor: author,
        vod_year: addDate ? addDate.slice(0, 4) : '',
        vod_remarks,
        type_name: '91porn',
        vod_play_from: '91porn',
        vod_play_url: `播放$${viewkey}`,
        vod_play_sources: [{ name: '91porn', episodes: [{ name: '播放', playId: viewkey }] }]
      }]
    };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params) {
  logI(`[search] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const kw = String((params && (params.keyword || params.wd || params.key)) || '').trim();
    if (!kw) return { list: [] };
    const page = parseInt((params && (params.page || params.pg)) || '1', 10) || 1;
    const res = await fetchWithFailover(`/search_result.php?search_id=${encodeURIComponent(kw)}&search_type=search_videos`);
    const list = await enrichListTitles(parseList(res.body), 'search');
    logI(`[search] 命中 ${res.host} "${kw}" 返回 ${list.length} 条`);
    return { page, list };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { list: [] };
  }
}

// 91porn 播放页把真实 <source> 藏在 document.write(strencode2("%3c%73%6f...")) 里，
// strencode2 就是 /js/m2.js 里的 unescape，解码后得到带签名的 mp4 直链（cdn77 / btc620 两类 host）。
// 同时页面里混有两类污染源，必须排除：
//   1) HTML 注释里的 <source src="https://ccm.91p52.com/..."> —— 诱饵，TLS 握手直接失败
//   2) player.preroll({ src: "https://g-br-cdn.kwai.net/.../ad-i18n-dsp/...mp4" }) —— 片前广告
// 旧逻辑三条正则恰好只抓到「诱饵 + 广告」，且 sniff 播放页会被 preroll 抢先加载广告。
const AD_URL_RE = /(?:preroll|ad-i18n-dsp|\/ad\/|advert|ads?\.)/i;

function extractRealMp4List(html) {
  if (!html) return [];
  const list = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || seen.has(u)) return;
    let parsed;
    try { parsed = new URL(u); } catch (_) { return; }
    // 黑名单排除污染源；站点 CDN 会轮换（speed.php 的 A=btc620 / H=cdn77 / I=cns.killcovid2021，
    // 以及 la.btc620.com 等），用白名单容易漏掉 VIP 线路，故只剔除已知坏链。
    if (!/^https?:$/i.test(parsed.protocol) || !/\.mp4(\?|$)/i.test(u)) return;
    if (AD_URL_RE.test(u) || /ccm\.91p52\.com/i.test(parsed.hostname)) return;
    seen.add(u);
    list.push(u);
  };
  // 1) 主路径：strencode2 百分号编码里的 <source src='...'>
  const re = /strencode2\(\s*["']([^"']+)["']\s*\)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let decoded;
    try { decoded = decodeURIComponent(m[1]); } catch (_) { decoded = unescape(m[1]); }
    decoded = decoded.replace(/&amp;/g, '&');
    const srcM = decoded.match(/<source[^>]*src=['"]([^'"]+\.mp4[^'"]*)['"]/i);
    if (srcM) push(srcM[1]);
  }
  // 2) 兼容旧版：页面里直接可见的真实 <source>（先剔除注释，避免诱饵混进来）
  const visible = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const visRe = /<source[^>]*src=['"]([^'"]+\.mp4[^'"]*)['"]/gi;
  while ((m = visRe.exec(visible)) !== null) push(m[1]);
  // 3) 兼容部分线路把地址放在 player 初始化对象里（排除 preroll 区块，避免广告混入）
  const playerPart = visible.split(/preroll\s*\(/i)[0];
  const jsRe = /(?:file|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/gi;
  while ((m = jsRe.exec(playerPart)) !== null) push(m[1]);
  // 4) 兼容 player.src("...mp4") 这类直接调用写法（同样只在 preroll 之前）
  const callRe = /\.src\(\s*["']([^"']+\.mp4[^"']*)["']/gi;
  while ((m = callRe.exec(playerPart)) !== null) push(m[1]);
  return list;
}

// 判断直链是否仍可播：优先 HEAD，失败再试 Range GET；只认 200/206 + video/mp4。
// 签名短时效 + 绑 IP，过期或被拒时让调用方及时回退到重新取页。
function probeMediaUrl(url, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(false); }
    const client = u.protocol === 'https:' ? https : http;
    const doReq = (method, extra, done) => {
      const req = client.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method,
          headers: Object.assign({ 'User-Agent': USER_AGENT, Accept: '*/*' }, headers || {}, extra), timeout: 8000, rejectUnauthorized: false },
        (res) => {
          const code = res.statusCode;
          const ctype = String(res.headers['content-type'] || '');
          res.destroy();
          done((code >= 200 && code < 300) && /video|mp4|octet-stream/i.test(ctype));
        }
      );
      req.on('error', () => done(false));
      req.on('timeout', () => { req.destroy(); done(false); });
      req.end();
    };
    doReq('HEAD', {}, (ok) => {
      if (ok) return resolve(true);
      doReq('GET', { Range: 'bytes=0-1023' }, resolve);
    });
  });
}

// 复现「推荐栏能播」的播放页形态：不带 page/viewtype/category 实际值，
// 只带首页链接里的 c=uyklk 与空参；宿主预热后 preroll 1 秒广告窗口已过，sniff 命中真实 <source>。
function buildSniffPageUrl(host, viewkey) {
  return `${host}/view_video.php?viewkey=${encodeURIComponent(viewkey)}&c=uyklk&viewtype=&category=`;
}

// 取播放页并解出 strencode2 里的真实 mp4；签名短时效，失败时带 cache-buster 重取一次。
async function resolveRealMp4(viewkey) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const path = `/view_video.php?viewkey=${viewkey}${attempt > 1 ? `&_r=${Date.now()}` : ''}`;
    try {
      const res = await fetchWithFailover(path, {
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
      });
      const urls = extractRealMp4List(res.body || '');
      logI(`[play][resolve] 第${attempt}次 命中 ${res.host} 解出 ${urls.length} 条真实直链`);
      if (urls.length) return { urls, res };
    } catch (e) {
      logE(`[play][resolve] 第${attempt}次取页失败: ${e.message}`);
    }
  }
  return { urls: [], res: null };
}

async function play(params, context) {
  const from = (context && context.from) || (params && params.from) || 'web';
  logI(`[play] 入口参数=${JSON.stringify(params || {})} from=${from} playMode=${NINETYONE_PLAY_MODE}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id)) || '';
    const viewkey = String(raw).trim().split('#')[0];
    if (!viewkey) return { urls: [], parse: 0 };

    // 代理模式：代理与取流同机（同 IP），自行取签名+取流。
    if (NINETYONE_PROXY_BASE) {
      const proxyUrl = `${NINETYONE_PROXY_BASE}/91.mp4?viewkey=${encodeURIComponent(viewkey)}`;
      logI(`[play] ${viewkey} -> 视频代理 ${proxyUrl}`);
      return { urls: [{ name: '代理', url: proxyUrl }], header: { 'User-Agent': USER_AGENT }, parse: 0 };
    }

    const mode = ['auto', 'direct', 'sniff', 'always'].includes(NINETYONE_PLAY_MODE) ? NINETYONE_PLAY_MODE : 'auto';
    const { urls: realUrls, res } = mode === 'sniff' ? { urls: [], res: null } : await resolveRealMp4(viewkey);
    const host = res ? res.host : (HOSTS[PREFERRED] || PRIMARY_API);
    const pageUrl = `${host}/view_video.php?viewkey=${viewkey}`;
    const sniffUrl = buildSniffPageUrl(host, viewkey);
    const HEADER = { 'User-Agent': USER_AGENT, Referer: pageUrl, Origin: host, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

    // 真实直链探活：cdn77 / btc620 实测裸 HEAD 200 video/mp4、Range 206，不依赖 Referer。
    let healthy = [];
    let ordered = [];
    if (realUrls.length) {
      const probes = await Promise.all(realUrls.map((u) => probeMediaUrl(u, HEADER)));
      healthy = realUrls.filter((_, i) => probes[i]);
      ordered = healthy.length ? [...healthy, ...realUrls.filter((u) => !healthy.includes(u))] : realUrls;
    }
    const directUsable = mode !== 'sniff' && healthy.length > 0;
    const wantSniff = mode === 'sniff' || mode === 'always' || (mode === 'auto' && !directUsable);
    const directUrls = directUsable
      ? ordered.map((u, i) => ({ name: i === 0 ? '真实直链' : `备用直链${i}`, url: u }))
      : [];

    if (wantSniff) {
      const why = mode === 'sniff' ? '强制嗅探模式'
        : mode === 'always' ? '双线路模式'
        : `真实直链不可用(解出${realUrls.length}条/探活${healthy.length}条)`;
      logI(`[play] ${viewkey} from=${from} mode=${mode} ${why} -> 回退推荐栏形态嗅探播放页 ${sniffUrl}`);
      return {
        urls: [
          ...directUrls,
          { name: '嗅探播放页(推荐栏)', url: sniffUrl }
        ],
        header: Object.assign({}, HEADER, { Referer: `${host}/index.php` }),
        flag: '91porn',
        parse: 1
      };
    }

    logI(`[play] ${viewkey} from=${from} mode=${mode} 真实直链 ${realUrls.length} 条 / 探活通过 ${healthy.length} 条 -> parse=0 直连, 首条host=${new URL(ordered[0]).hostname}`);
    ordered.forEach((u, i) => logI(`[play][url${i + 1}] ${new URL(u).hostname}${new URL(u).pathname}`));
    return {
      urls: directUrls,
      header: HEADER,
      flag: '91porn',
      parse: 0
    };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    return { urls: [], header: { 'User-Agent': USER_AGENT }, parse: 0 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
