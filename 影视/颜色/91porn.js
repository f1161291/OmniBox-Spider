/**
 * @name 91porn
 * @version 1.2.0
 * @description 91porn.com 采集源（OmniBox Spider）
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

const SITE_API = (process.env.SITE_API || 'https://91porn.com').replace(/\/+$/, '');
const USER_AGENT = process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LANG = process.env.LANG_COOKIE || 'cn_CN';
const COOKIE = process.env.NINETYONE_COOKIE || "";
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
    try { u = new URL(urlStr, SITE_API); } catch (e) { return reject(e); }
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
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

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
    let title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() : viewkey;
    if (!title) title = viewkey;
    list.push({ vod_id: viewkey, vod_name: title, vod_pic: imgM[1], vod_tag: 'video' });
  }
  return list;
}

async function home(params) {
  logI(`[home] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const res = await httpRequest(`${SITE_API}/index.php`);
    const list = parseList(res.body);
    logI(`[home] 返回 ${list.length} 条`);
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
    let url;
    if (tid === 'hot' || tid === 'watch') {
      url = `${SITE_API}/v.php?next=watch&page=${page}`;
    } else if (tid.includes('&')) {
      url = `${SITE_API}/v.php?category=${tid}&page=${page}`;
    } else {
      url = `${SITE_API}/v.php?category=${tid}&viewtype=basic&page=${page}`;
    }
    const res = await httpRequest(url);
    const list = parseList(res.body);
    logI(`[category] tid=${tid} page=${page} 返回 ${list.length} 条`);
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
    const res = await httpRequest(`${SITE_API}/view_video.php?viewkey=${viewkey}`, {
      headers: { Referer: `${SITE_API}/`, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    const html = res.body;
    // title: try video-title span (CN page) then h4 then title tag
    const vtM = html.match(/<span[^>]*class="[^"]*video-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const h4M = html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const titleTagM = html.match(/<title>([^<]+)<\/title>/i);
    let title = vtM ? vtM[1] : (h4M ? h4M[1] : (titleTagM ? titleTagM[1] : viewkey));
    title = title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    if (!title) title = viewkey;
    // cover
    const coverM = html.match(/poster="([^"]+)"/) || html.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"/);
    const cover = coverM ? coverM[1] : '';
    logI(`[detail] ${title.slice(0, 60)}`);
    return {
      list: [{
        vod_id: viewkey,
        vod_name: title,
        vod_pic: cover,
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
    const res = await httpRequest(`${SITE_API}/search_result.php?search_id=${encodeURIComponent(kw)}&search_type=search_videos`);
    const list = parseList(res.body);
    logI(`[search] "${kw}" 返回 ${list.length} 条`);
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
    const pageUrl = `${SITE_API}/view_video.php?viewkey=${viewkey}`;
    const HEADER = { 'User-Agent': USER_AGENT, Referer: pageUrl, Origin: SITE_API, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

    // 91porn 视频 mp4 的 st 签名绑定请求 IP 且短时效：
    // 脚本在 OmniBox 机器解析出的直链，交给 OK影视（不同出口 IP）直接拉会被 CDN 拒(403)。
    // 因此主线路改为 parse=1：由 OK影视 从自身 IP 嗅探播放页、取得自身的新鲜签名后再播放，
    // 广告能播正是因为它在第三方域、无此 IP/Referer 校验。脚本侧 fetch 仅用于诊断日志。
    const res = await httpRequest(pageUrl, { headers: { Referer: `${SITE_API}/`, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
    const urls = extractMp4List(res.body || '');
    logI(`[play] ${viewkey} -> 提取到 ${urls.length} 条直链(仅供诊断), 主线路走 sniff 播放页`);
    return {
      urls: [
        { name: '嗅探播放页', url: pageUrl },
        ...urls.map((u, i) => ({ name: `直链${i + 1}`, url: u }))
      ],
      header: HEADER,
      parse: 1
    };
  } catch (e) {
    const raw = typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id)) || '';
    const viewkey = String(raw).trim().split('#')[0];
    const pageUrl = viewkey ? `${SITE_API}/view_video.php?viewkey=${viewkey}` : '';
    logE(`[play] 失败: ${e.message}, fallback sniff ${pageUrl}`);
    return { urls: pageUrl ? [{ name: '嗅探播放页', url: pageUrl }] : [], header: { 'User-Agent': USER_AGENT, Referer: pageUrl }, parse: 1 };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
