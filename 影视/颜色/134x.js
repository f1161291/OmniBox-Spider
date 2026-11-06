/**
 * @name 134X
 * @version 1.2.0
 * @description 134x.com 采集源（OmniBox Spider，X/Twitter 长视频聚合）
 * @downloadURL https://raw.githubusercontent.com/omnibox-spider/main/影视/采集/134x.js
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

const SITE_API = (process.env.SITE_API || 'https://134x.com').replace(/\/+$/, '');
const USER_AGENT = process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PREFIX = '[134X]';
const PAGE_SIZE = 20;

function logI(m) { try { OmniBox.log('info', `${PREFIX} ${m}`); } catch (_) {} }
function logE(m) { try { OmniBox.log('error', `${PREFIX} ${m}`); } catch (_) {} }

// SDK 缓存包装（key 短、失败安全降级，绝不阻断主链路）
async function cacheGet(key) {
  try {
    const v = await OmniBox.getCache(key);
    if (v == null) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) { return null; }
}
async function cacheSet(key, val, ttl) {
  try { await OmniBox.setCache(key, JSON.stringify(val), ttl || CACHE_TTL_LIST); } catch (_) {}
}
// 限并发执行器
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = null; logE(`[mapLimit] 第${i + 1}项失败: ${e.message}`); }
    }
  });
  await Promise.all(workers);
  return out;
}

// 134X 是 TanStack Start(SSR) 站。列表在 /popular /featured /search?q= 页面里 SSR 内联
// （TanStack Router 的 $R[n]= 流式对象），详情页 /video/{tweetId} 内联完整 tweet 数据。
// 播放地址：video.twimg.com 的 mp4/m3u8。OK影视 等客户端直连 twimg 常加载失败，
// 故主线路改走 134X 自带代理 /api/video?url=<mp4> 与 /api/hls?url=<m3u8>（实测 206/200，
// 且 HLS 内部分片 URI 会被代理自动改写为同域，避免跨域/签名问题）；twimg 直链留作备用线路。
// 列表页 SSR 不含封面，封面与官方标题需限量并发抓详情页 og:image / og:title 补齐。
const CATEGORIES = [
  { type_id: 'index',  type_name: '首頁' },
  { type_id: 'popular', type_name: '熱門' },
  { type_id: 'featured', type_name: '精選' },
];
const DETAIL_CONCURRENCY = 4;   // 补详情并发上限，避免打满站点
const CACHE_TTL_LIST = 1800;    // 列表补详情缓存（秒）
const CACHE_KEY_PREFIX = '134x:detail';

function httpRequest(urlStr, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = Object.assign(
      { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'identity' },
      options.headers || {}
    );
    const req = client.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: options.method || 'GET', headers, timeout: options.timeout || 20000, rejectUnauthorized: false },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return httpRequest(new URL(res.headers.location, u.href).href, options, redirectCount + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// 反转义 TSR 字符串里的 \n \\ \" 等
function unesc(s) {
  if (!s) return '';
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// 从一段 TSR 记录里读字段（TSR 内联值形如 key:"..." / key:123 / key:!0）
// 用逐字段简单正则，避免动态拼接的嵌套分组出错。
function rs(seg, key) {
  const m = seg.match(new RegExp('\\b' + key + ':"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? unesc(m[1]) : '';
}
function rn(seg, key) {
  const m = seg.match(new RegExp('\\b' + key + ':(\\d+)'));
  return m ? parseInt(m[1], 10) : 0;
}

// 解析列表页 SSR 内联的 tweets 数组（TSR $R[n]= 格式，按 {id:"<24hex>",name: 切记录）
function parseTweets(html) {
  const starts = [];
  const re = /\{id:"[0-9a-f]{24}",name:/g;
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  const list = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = (i + 1 < starts.length) ? starts[i + 1] : Math.min(html.length, s + 4000);
    const seg = html.slice(s, e);
    const tid = rs(seg, 'tweetId');
    if (!/^\d{10,}$/.test(tid)) continue;
    const media = rs(seg, 'media');
    if (!media) continue;
    list.push({
      tid,
      name: rs(seg, 'name'),
      screenName: rs(seg, 'screenName'),
      text: unesc(rs(seg, 'text')),
      media,
      posterUrl: rs(seg, 'posterUrl'),
      durationMillis: rn(seg, 'durationMillis'),
      playTimes: rn(seg, 'playTimes'),
      postAt: rs(seg, 'postAt'),
      videoVariants: seg, // 保留原始片段供 play 兜底提取多清晰度
    });
  }
  return list;
}

// HTML 实体解码（详情页 og:title / og:description 里有 &#x27; 等）
function htmlDecode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// 清洗英文数据标题：Code: SONE-771 Title: I couldn't... -> SONE-771（保留番号）
function cleanTitleText(t) {
  let s = String(t || '');
  // 去掉 Code:/Title:/Actress: 这类英文标签前缀，保留番号
  s = s.replace(/\bCode:\s*([A-Za-z]{2,6}-\d{2,6})\b/gi, '$1')
       .replace(/\bTitle:\s*/gi, '').replace(/\bActress:\s*[^\n]*/gi, '');
  // 若清洗后主体是长英文描述（缺中文），截到番号 + 首个中文/标点前
  const code = s.match(/^([A-Z]{2,6}-\d{2,6})\b/);
  if (code && !/[\u4e00-\u9fff]/.test(s.slice(0, 60))) s = code[1] + ' ' + s.slice(code[1].length).replace(/[A-Za-z][A-Za-z .,'\-!?]{25,}/g, '').trim();
  return s.replace(/\s+/g, ' ').trim();
}

// 从列表/详情记录构造标题（清洗艾特刷屏、t.co、emoji、英文标签）
function buildTitle(rec) {
  let t = String(rec.text || '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
  t = t.replace(/https?:\/\/t\.co\/\S+/g, '').replace(/@[A-Za-z0-9_]+/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}💕💖]/gu, '');
  t = cleanTitleText(t).replace(/\s+/g, ' ').trim();
  if (!t || t.length < 2) t = rec.name || rec.screenName || '';
  if (!t) t = `134X ${rec.tid}`;
  return t.slice(0, 90);
}

// 详情页 og:title 清洗（去站点后缀、去省略号、去英文标签）
function cleanOgTitle(ogTitle) {
  let s = htmlDecode(String(ogTitle || ''))
    .replace(/｜X 長視頻 - 134X\s*$/, '').replace(/\s*\.\.\.\s*$/, '').replace(/…\s*$/, '').trim();
  s = cleanTitleText(s);
  return s;
}

// 判断标题是否为"退化标题"（纯艾特/emoji/作者名兜底/纯英文长句），需要详情页覆盖
function isWeakTitle(t) {
  const s = String(t || '');
  if (!s || s.length < 4) return true;
  if (/^(中文字幕 AV|134X|@)/.test(s)) return true;                 // 作者名兜底
  if (!/[\u4e00-\u9fff]/.test(s) && s.length > 24) return true;      // 纯英文长句
  return false;
}

// 列表记录 -> OmniBox vod 项；playId 透传直链，避免 play 再打一次详情
function recToVod(rec, idx) {
  const title = buildTitle(rec);
  const dur = rec.durationMillis ? Math.round(rec.durationMillis / 60000) + '分钟' : '長視頻';
  return {
    vod_id: rec.tid,
    vod_name: `${title}｜@${rec.screenName || rec.name || '134X'}`.slice(0, 100),
    vod_pic: rec.posterUrl || '',
    vod_remarks: `${dur} · ${rec.playTimes || 0}次播放`,
    vod_tag: 'video',
    // 透传直链：media 已是 video.twimg.com 的完整 mp4，play 直接可用
    _play: rec.media,
    _tid: rec.tid,
    _idx: idx,
  };
}

// 抓列表页（分页）。返回 {list, nextCursor}
async function fetchList(path, page) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const url = `${SITE_API}${path}${path.includes('?') ? '&' : '?'}page=${pageNum}`;
  logI(`[fetchList] ${url}`);
  const res = await httpRequest(url, { headers: { Referer: `${SITE_API}/` } });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  const recs = parseTweets(res.body);
  const nc = res.body.match(/nextCursor:"([^"]+)"/);
  logI(`[fetchList] 解析到 ${recs.length} 条, nextCursor=${nc ? nc[1].slice(0, 16) + '…' : '无'}`);
  return { recs, nextCursor: nc ? nc[1] : '' };
}

// 抓详情页 SSR（真实 tweetId 才有完整内联数据）
async function fetchDetail(tid) {
  const url = `${SITE_API}/video/${tid}`;
  logI(`[fetchDetail] ${url}`);
  const res = await httpRequest(url, { headers: { Referer: `${SITE_API}/` } });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  const html = res.body;
  const meta = (name) => {
    const m = html.match(new RegExp('<meta (?:property|name)="' + name + '"[^>]*content="([^"]*)"'));
    return m ? m[1].replace(/&amp;/g, '&') : '';
  };
  const idx = html.indexOf('tweetId:"');
  const seg = idx > -1 ? html.slice(Math.max(0, idx - 600), idx + 2600) : html.slice(0, 3200);
  const field = (k) => { const m = seg.match(new RegExp('\\b' + k + ':"((?:[^"\\\\]|\\\\.)*)"')); return m ? unesc(m[1]) : ''; };
  const num = (k) => { const m = seg.match(new RegExp('\\b' + k + ':(\\d+)')); return m ? parseInt(m[1], 10) : 0; };
  return {
    tid,
    ogTitle: meta('og:title').replace(/\s*｜X 長視頻 - 134X\s*$/, '').trim(),
    ogImage: meta('og:image'),
    ogVideo: meta('og:video') || meta('og:video:secure_url'),
    ogDesc: meta('og:description'),
    name: field('name'),
    screenName: field('screenName'),
    text: unesc(field('text')),
    media: field('media'),
    posterUrl: field('posterUrl'),
    durationMillis: num('durationMillis'),
    playTimes: num('playTimes'),
    // 多清晰度 videoVariants / hlsUrls 原始片段
    html,
  };
}

// 批量补详情：列表页无封面/官方标题，限量并发抓详情页 og:image / og:title。
// 结果按 tweetId 写入 SDK 缓存，失败安全降级（不阻断主列表）。
async function enrichVodList(vodList) {
  const cores = vodList.map((v) => ({ v, tid: v.vod_id }));
  const results = await mapLimit(cores, DETAIL_CONCURRENCY, async ({ v, tid }) => {
    const key = `${CACHE_KEY_PREFIX}:${tid}`;
    let meta = await cacheGet(key);
    if (!meta) {
      try {
        const d = await fetchDetail(tid);
        meta = { pic: d.ogImage || d.posterUrl || '', title: cleanOgTitle(d.ogTitle), ogVideo: d.ogVideo || d.media || '' };
        await cacheSet(key, meta, CACHE_TTL_LIST);
      } catch (e) {
        logE(`[enrich] ${tid} 抓详情失败: ${e.message}`);
        return null;
      }
    }
    // 封面：详情页 og:image 是唯一可靠来源
    if (meta.pic && !v.vod_pic) v.vod_pic = meta.pic;
    // 官方标题：仅当列表标题退化、且详情标题更实时才覆盖
    const cur = String(v.vod_name || '').split('｜@')[0];
    if (meta.title && isWeakTitle(cur) && !isWeakTitle(meta.title)) {
      const screen = String(v.vod_name || '').match(/｜@([^｜]+)$/);
      v.vod_name = `${meta.title}${screen ? '｜@' + screen[1] : ''}`.slice(0, 100);
    }
    return meta;
  });
  const ok = results.filter(Boolean).length;
  logI(`[enrich] 补齐 ${ok}/${vodList.length} 条（封面/标题），并发=${DETAIL_CONCURRENCY}`);
  return vodList;
}

// 从详情页/列表片段提取所有可播放地址（mp4 多分辨率 + m3u8），按分辨率降序
function extractPlayUrls(html, primary) {
  const urls = [];
  const seen = new Set();
  const add = (u) => { if (u && /^https?:\/\//.test(u) && !seen.has(u)) { seen.add(u); urls.push(u); } };
  if (primary) add(primary);
  // 详情页 og:video
  const og = html.match(/<meta property="og:video(?:|:secure_url)"[^>]*content="([^"]*)"/g) || [];
  og.forEach((tag) => { const m = tag.match(/content="([^"]*)"/); if (m) add(m[1]); });
  // TSR 内联：所有 video.twimg.com 的 mp4（含 ?tag=）与 m3u8
  const re = /https:\/\/video\.twimg\.com\/[A-Za-z0-9_./-]+\.(?:mp4|m3u8)(?:\?tag=\d+)?/g;
  let m;
  while ((m = re.exec(html)) !== null) add(m[0]);
  // 排序：mp4 优先，按路径里 宽x高 总面积降序；m3u8 放最后
  const score = (u) => {
    const isM3u8 = /\.m3u8/.test(u);
    const d = u.match(/\/(\d{3,4})x(\d{3,4})\//);
    const px = d ? parseInt(d[1], 10) * parseInt(d[2], 10) : 0;
    return (isM3u8 ? 0 : 1) * 1e9 + px;
  };
  return urls.sort((a, b) => score(b) - score(a));
}

// 播放线路命名（按分辨率）
function lineName(u, i) {
  if (/\.m3u8/.test(u)) return 'HLS';
  const d = u.match(/\/(\d{3,4})x(\d{3,4})\//);
  if (d) return `${d[1]}×${d[2]}`;
  return `線路${i + 1}`;
}

// 把 twimg 原始地址包装成 134X 同域代理地址（mp4 -> /api/video, m3u8 -> /api/hls）
function proxied(u) {
  if (!u) return '';
  const isHls = /\.m3u8/.test(u);
  const api = isHls ? '/api/hls' : '/api/video';
  return `${SITE_API}${api}?url=${encodeURIComponent(u)}`;
}

// 生成最终播放线路：代理主线路优先，twimg 直链作备用（全部 parse:0）
function buildPlayLines(urls) {
  const lines = [];
  const seen = new Set();
  const push = (name, url) => {
    if (url && !seen.has(url)) { seen.add(url); lines.push({ name, url }); }
  };
  // 1) 代理线路（同域，OK影视/网页端均稳）
  urls.forEach((u) => push(`代理·${lineName(u, 0)}`, proxied(u)));
  // 2) 原始 twimg 直链备用（部分客户端可直连）
  urls.forEach((u, i) => push(`直連·${lineName(u, i)}`, u));
  return lines;
}

function emptyList(page, pagecount) {
  return { page: page || 1, pagecount: pagecount || 1, limit: PAGE_SIZE, total: 0, list: [] };
}

async function home(params) {
  logI(`[home] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const { recs } = await fetchList('/popular', 1);
    const list = await enrichVodList(recs.map(recToVod));
    logI(`[home] 返回 ${list.length} 条推荐`);
    return { class: CATEGORIES, list };
  } catch (e) {
    logE(`[home] 失败: ${e.message}`);
    return { class: CATEGORIES, list: [] };
  }
}

async function category(params) {
  logI(`[category] 入口参数=${JSON.stringify(params || {})}`);
  const tid = String((params && (params.categoryId || params.type_id || params.tid)) || 'index').trim();
  const page = Math.max(1, parseInt((params && (params.page || params.pg)) || 1, 10) || 1);
  // index 用 /popular 作首页推荐；popular / featured 各走对应路由；其余回退 popular
  const path = (tid === 'featured') ? '/featured' : '/popular';
  try {
    const { recs } = await fetchList(path, page);
    const list = await enrichVodList(recs.map(recToVod));
    // 站点无总页数；有数据就允许继续翻页，无数据即末页
    const pagecount = list.length >= PAGE_SIZE ? page + 1 : Math.max(1, page);
    logI(`[category] ${tid} page=${page} 返回 ${list.length} 条, pagecount=${pagecount}`);
    return { page, pagecount, limit: PAGE_SIZE, total: (page - 1) * PAGE_SIZE + list.length, list };
  } catch (e) {
    logE(`[category] ${tid} 失败: ${e.message}`);
    return emptyList(page);
  }
}

async function search(params) {
  logI(`[search] 入口参数=${JSON.stringify(params || {})}`);
  const kw = String((params && (params.keyword || params.wd || params.key || params.q)) || '').trim();
  if (!kw) return emptyList(1);
  const page = Math.max(1, parseInt((params && (params.page || params.pg)) || 1, 10) || 1);
  try {
    // 中文必须 URL 编码，否则站点返回 0 字节
    const path = `/search?q=${encodeURIComponent(kw)}`;
    const { recs } = await fetchList(path, page);
    const list = await enrichVodList(recs.map(recToVod));
    const pagecount = list.length >= PAGE_SIZE ? page + 1 : Math.max(1, page);
    logI(`[search] "${kw}" page=${page} 返回 ${list.length} 条`);
    return { page, pagecount, limit: PAGE_SIZE, total: (page - 1) * PAGE_SIZE + list.length, list };
  } catch (e) {
    logE(`[search] "${kw}" 失败: ${e.message}`);
    return emptyList(page);
  }
}

// 从任意参数里解析 tweetId（支持裸 ID、视频页 URL、twimg URL、透传直链）
function resolveTid(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(?:134x\.com\/video\/|status\/|twimg\.com\/[a-z_]+\/)(\d{10,})/) || s.match(/^(\d{10,})$/);
  return m ? m[1] : '';
}

async function detail(params) {
  logI(`[detail] 入口参数=${JSON.stringify(params || {})}`);
  const raw = typeof params === 'string' ? params : (params && (params.vod_id || params.id || params.videoId || params.playId)) || '';
  const tid = resolveTid(raw);
  if (!tid) { logE(`[detail] 无法解析 tweetId: ${String(raw).slice(0, 80)}`); return { list: [] }; }
  try {
    const d = await fetchDetail(tid);
    // 标题优先取正文清洗版（中文片名/番号完整），og:title 常被站点截断成 ".../…" 作次选
    const bodyTitle = buildTitle({ text: d.text, name: d.name, screenName: d.screenName, tid });
    const ogTitle = cleanOgTitle(d.ogTitle);
    let title = isWeakTitle(bodyTitle) ? (ogTitle || bodyTitle) : bodyTitle;
    if (isWeakTitle(title)) title = `${d.name || '134X'} 長視頻`;
    const pic = d.ogImage || d.posterUrl || '';
    const dur = d.durationMillis ? Math.round(d.durationMillis / 60000) + ' 分鐘' : '長視頻';
    const desc = d.ogDesc || `${d.name} (@${d.screenName}) 發佈的 X 長視頻，時長 ${dur}。${(d.text || '').replace(/\s+/g, ' ').slice(0, 160)}`;
    // 透传全部原始地址（多分辨率 mp4 + m3u8），play 一次生成 代理/直连 全套线路，免二次请求
    const allUrls = extractPlayUrls(d.html, d.ogVideo || d.media || '');
    const playId = `${tid}|||${allUrls.join('@@')}`;
    logI(`[detail] ${title.slice(0, 40)} 封面=${pic ? '有' : '无'} 地址=${allUrls.length} 条`);
    return {
      list: [{
        vod_id: tid,
        vod_name: title.slice(0, 100),
        vod_pic: pic,
        vod_remarks: `${dur} · ${d.playTimes || 0}次播放`,
        vod_content: desc,
        vod_actor: '',
        type_name: 'X 長視頻',
        vod_play_from: '134X',
        vod_play_url: `播放$${playId}`,
        vod_play_sources: [{ name: '134X', episodes: [{ name: '播放', playId }] }],
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
  const header = { 'User-Agent': USER_AGENT, Referer: `${SITE_API}/`, Origin: SITE_API, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' };
  try {
    // playId 形如 tid|||url1@@url2@@...（detail 透传全部地址）或 tid|||单直链、裸 tid / URL
    let tid = '', carried = [];
    const bar = s.indexOf('|||');
    if (bar > -1) {
      tid = resolveTid(s.slice(0, bar));
      carried = s.slice(bar + 3).split('@@').filter((u) => /^https?:\/\//.test(u));
    } else tid = resolveTid(s);

    // 透传多地址（detail 已按分辨率降序排好）：直接去重使用，免二次请求
    let urls = [];
    if (carried.length) {
      const seen = new Set();
      urls = carried.filter((u) => { if (seen.has(u)) return false; seen.add(u); return true; });
    }
    if (!urls.length) {
      if (!tid) { logE(`[play] 无法解析 tweetId: ${s.slice(0, 80)}`); return { urls: [], parse: 0 }; }
      // 回源详情页拿 og:video / videoVariants / hlsUrls
      const res = await httpRequest(`${SITE_API}/video/${tid}`, { headers: { Referer: `${SITE_API}/` } });
      urls = extractPlayUrls(res.body || '', '');
    }
    if (!urls.length) {
      logE(`[play] ${tid} 未提取到直链`);
      return { urls: tid ? [{ name: '嗅探播放頁', url: `${SITE_API}/video/${tid}` }] : [], header, parse: 1 };
    }
    const lines = buildPlayLines(urls);
    logI(`[play] ${tid} -> ${urls.length} 条原始地址, 生成 ${lines.length} 条线路, 首选 ${lines[0].name} ${lines[0].url.slice(0, 70)}`);
    return {
      urls: lines,
      header, // 代理线路与 134X 同域，带 Referer/UA/Origin 更稳
      parse: 0, // 代理返回标准 mp4/HLS，直接播
    };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    const tid = resolveTid(s);
    return { urls: tid ? [{ name: '嗅探播放頁', url: `${SITE_API}/video/${tid}` }] : [], header, parse: 1 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
