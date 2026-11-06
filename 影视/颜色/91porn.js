/**
 * @name 91porn
 * @version 1.4.1
 * @description 91porn.com 采集源（OmniBox Spider，多基址容灾：主站 + 91p618 镜像）
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

// 列表页标题是真实值（未做反混淆）：按 viewkey 记住，供 detail() 在站点更换/去掉
// title loader 时作为稳定兜底，避免详情页退回被污染的随机假标题。
const LIST_TITLE_CACHE = new Map();

function parseList(html) {
  const list = [];
  const seen = new Set();
  // Match blocks: <a href="...view_video.php?viewkey=..."> ... <img src="...thumb..."> ... <span class="video-title...">TITLE</span> ... </a>
  const blockRe = /<a[^>]*href="[^"]*view_video\.php\?viewkey=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const viewkey = m[1];
    if (seen.has(viewkey)) continue;
    const block = m[2];
    const imgM = block.match(/<img[^>]*src="([^"]*thumb[^"]*)"[^>]*>/i) || block.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"[^>]*>/i);
    if (!imgM) continue;
    seen.add(viewkey);
    const titleM = block.match(/<span[^>]*class="[^"]*video-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    let title = cleanText(titleM ? titleM[1] : '', true);
    if (!title) title = viewkey;
    if (title && title !== viewkey) LIST_TITLE_CACHE.set(viewkey, title);
    list.push({ vod_id: viewkey, vod_name: title, vod_pic: imgM[1], vod_tag: 'video' });
  }
  return list;
}

async function home(params) {
  logI(`[home] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const res = await fetchWithFailover(`/index.php`);
    const list = parseList(res.body);
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
    const list = parseList(res.body);
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
    // 标题：站点对详情页 <title>/<h4>/作者/时长 做了随机假值反混淆（title loader），
    // 真值在隐藏 <i> 的 data-* 属性里，按 m+k 解密后才与主页列表标题一致。
    // 页面底部「本月热播中」推荐区的 <span class="video-title"> 绝不能当当前视频标题。
    const realMeta = extract95RealMeta(html);
    const detailH4M = html.match(/<h4[^>]*class=["'][^"']*login_register_header[^"']*["'][^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i)
      || html.match(/<h4[^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i);
    const tagM = html.match(/<title>([\s\S]*?)<\/title>/i);
    let title = realMeta.title;
    let titleFrom = 'title_loader(解密真实片名)';
    // 列表页缓存的真实标题优先级高于详情页静态字段（静态字段已被随机污染）。
    if (!title && LIST_TITLE_CACHE.has(viewkey)) {
      title = LIST_TITLE_CACHE.get(viewkey);
      titleFrom = 'list_title_cache(列表页真实标题)';
    }
    if (!title && detailH4M) { title = cleanText(detailH4M[1]); titleFrom = 'h4.login_register_header[align=left](静态回退)'; }
    if (!title && tagM) {
      title = cleanText(tagM[1]).replace(/\s*-\s*91porn\s*$/i, '').trim();
      titleFrom = 'title(静态回退)';
    }
    if (!title) { title = viewkey; titleFrom = 'viewkey(fallback)'; }
    // 解密/列表标题是权威值，写回缓存供后续无 loader 时复用。
    if (title && title !== viewkey) LIST_TITLE_CACHE.set(viewkey, title);
    // 封面：优先主播放器 <video id="player_one" poster="...">，绝不使用推荐区 img-responsive。
    const posterM = html.match(/<video[^>]*id=["']player_one["'][^>]*poster=["']([^"']+)["']/i)
      || html.match(/poster=["']([^"']+)["']/i);
    const cover = posterM ? posterM[1] : '';
    // 详情页元数据：真实作者/时长优先用 title loader 解密值（静态值同样被随机污染），
    // 其余取 #useraction 统计区 / 视频信息区 / #v_desc 简介区。
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
    const list = parseList(res.body);
    logI(`[search] 命中 ${res.host} "${kw}" 返回 ${list.length} 条`);
    return { page, list };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { list: [] };
  }
}

function extractMp4List(html) {
  if (!html) return [];
  const list = [];
  const seen = new Set();
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); list.push(u); } };
  let m;
  const re1 = /<source[^>]*src="([^"]+\.mp4[^"]*)"/gi;
  while ((m = re1.exec(html)) !== null) push(m[1]);
  const re2 = /file\s*:\s*"([^"]+\.mp4[^"]*)"/gi;
  while ((m = re2.exec(html)) !== null) push(m[1]);
  const re3 = /src\s*:\s*"([^"]+\.mp4[^"]*)"/gi;
  while ((m = re3.exec(html)) !== null) push(m[1]);
  return list;
}

async function play(params) {
  logI(`[play] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id)) || '';
    const viewkey = String(raw).trim().split('#')[0];
    if (!viewkey) return { urls: [], parse: 0 };

    // 代理模式：OK影视 直接拉代理地址即可。代理与取流同机（同 IP），
    // 自行取签名+取流，绕过 91porn 的 IP 绑定签名校验。
    if (NINETYONE_PROXY_BASE) {
      const proxyUrl = `${NINETYONE_PROXY_BASE}/91.mp4?viewkey=${encodeURIComponent(viewkey)}`;
      logI(`[play] ${viewkey} -> 视频代理 ${proxyUrl}`);
      return { urls: [{ name: '代理', url: proxyUrl }], header: { 'User-Agent': USER_AGENT }, parse: 0 };
    }

    // 取播放页（容灾到可用基址），命中谁就用谁的 base 拼 pageUrl/Referer，
    // OK影视 从该 base 嗅探即可拿到本机 IP 签名的新鲜视频地址。
    const res = await fetchWithFailover(`/view_video.php?viewkey=${viewkey}`, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    const host = res.host;
    const pageUrl = `${host}/view_video.php?viewkey=${viewkey}`;
    const HEADER = { 'User-Agent': USER_AGENT, Referer: pageUrl, Origin: host, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

    // 91porn 视频 mp4 的 st 签名绑定请求 IP 且短时效：
    // 脚本在 OmniBox 机器解析出的直链，交给 OK影视（不同出口 IP）直接拉会被 CDN 拒(403)。
    // 因此主线路改为 parse=1：由 OK影视 从自身 IP 嗅探播放页、取得自身的新鲜签名后再播放，
    // 广告能播正是因为它在第三方域、无此 IP/Referer 校验。脚本侧 fetch 仅用于诊断日志。
    const urls = extractMp4List(res.body || '');
    logI(`[play] 命中 ${host} ${viewkey} -> 提取到 ${urls.length} 条直链(仅供诊断), 主线路走 sniff 播放页`);
    return {
      urls: [
        { name: '嗅探播放页', url: pageUrl },
        ...urls.map((u, i) => ({ name: `直链${i + 1}`, url: u }))
      ],
      header: HEADER,
      parse: 1
    };
  } catch (e) {
    // 兜底：用优选基址拼 URL，保证至少有一个 sniff 线路可点
    const host = HOSTS[PREFERRED] || PRIMARY_API;
    const viewkey = String((typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id))) || '').trim().split('#')[0];
    const pageUrl = viewkey ? `${host}/view_video.php?viewkey=${viewkey}` : '';
    logE(`[play] 失败: ${e.message}, fallback sniff ${pageUrl}`);
    return { urls: pageUrl ? [{ name: '嗅探播放页', url: pageUrl }] : [], header: { 'User-Agent': USER_AGENT, Referer: pageUrl }, parse: 1 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
