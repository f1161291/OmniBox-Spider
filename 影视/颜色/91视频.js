// @name 91视频
// @author 宝宝巴士
// @description 91视频(2707.zsqwupvt.cc) 采集源：官网同款二级菜单（5 分组 30 子项）；首页/分类/详情/播放；封面 qnlycc AES 解密内联；播放走 POST /videos/{id}/playback 取签名 m3u8 正片（webm 是广告）；多域名轮换
// @version 1.0.9
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91视频.js
// @dependencies axios,cheerio,crypto
/**
 * ============ 91视频（2707.zsqwupvt.cc）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-22 实测）】
 *   传统 SSR 站（非 SPA），CloudFront。title「91视频」。
 *   - 首页 /            video-items grid（video-item 卡片）
 *   - 视频详情 /videos/{id}/    <video src="https://91spx.com/videos/webm/{id}.webm">
 *   - 文章详情 /articles/{id}/
 *   - 分类 /videos/category/{slug}/  与  /articles/category/{slug}/
 *   - 标签 /videos/tag/{tag}/
 *   - 搜索 /videos/search 实测 404（未实现），本源不支持搜索
 *   封面：pic.qnlycc.cn / new2.qnlycc.cn 返回 AES-128-CBC 密文（同爱交网），脚本内解密。
 */
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

// OmniBox 宿主用 stdout 传 JSON 响应；部分版本 omnibox_sdk.log 会把日志字符串
// 写进同一 stdout，Go 侧解析 JSON 失败 → 网页端播放加载不出来。
// 这里在模块加载最早期做 stdout 消毒：日志/非 JSON 字符串转 stderr，JSON 响应放行。
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
function _safeStderr(chunk, encoding, cb) {
  try { return _origStderrWrite(chunk, encoding, cb); } catch (_) { return true; }
}
(function installStdoutGuard() {
  if (process.stdout.__spxGuard || process.stdout.__omniStdoutGuard) return;
  process.stdout.__spxGuard = true;
  const state = { inJson: false, pending: "" };
  const parseOk = (text) => { try { JSON.parse(text); return true; } catch (_) { return false; } };
  const jsonStart = (text) => /^\{/.test(text) || /^\[\s*(?:\{|\[|"|-?\d|true|false|null|\])/.test(text);
  process.stdout.write = function (chunk, encoding, cb) {
    const text = String(chunk == null ? "" : chunk);
    if (state.inJson) {
      state.pending += text;
      if (parseOk(state.pending.trim())) { state.pending = ""; state.inJson = false; }
      return _origStdoutWrite(chunk, encoding, cb);
    }
    const trimmed = text.trim();
    if (!trimmed) return _origStdoutWrite(chunk, encoding, cb);
    let complete = false;
    try { JSON.parse(trimmed); complete = true; } catch (_) {}
    if (complete) return _origStdoutWrite(chunk, encoding, cb);
    if (jsonStart(trimmed)) { state.inJson = true; state.pending = text; return _origStdoutWrite(chunk, encoding, cb); }
    return _safeStderr(chunk, encoding, cb);
  };
})();

const PREFIX = '[91sp]';
const UA = String(process.env.SPX_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOSTS = String(process.env.SPX_HOSTS || 'https://2707.zsqwupvt.cc').split(',')
  .map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
const TIMEOUT = Math.max(5000, Number(process.env.SPX_TIMEOUT || 15000) || 15000);
const COVER_INLINE = process.env.SPX_COVER_INLINE !== '0';
const COVER_KEY = Buffer.from(String(process.env.SPX_COVER_KEY || 'f5d965df75336270'), 'latin1');
const COVER_IV = Buffer.from(String(process.env.SPX_COVER_IV || '97b60394abc2fbe1'), 'latin1');

// 官网二级菜单（2026-11-22 实测）：5 分组 + 内容子项，剔除「热门搜索/回家方法」非内容入口
const CATEGORY_GROUPS = [
  { id: 'group:jingxuan', name: '精选资源', subs: [
    ['国产自拍', 'videos/category/gczp'], ['国产传媒', 'videos/category/gccm'],
    ['经典三级', 'videos/category/gtsj'], ['捆绑调教', 'videos/category/kbtj'],
    ['暗网猎奇', 'videos/category/awlq'], ['醉酒迷玩', 'videos/category/zjmw'],
    ['户外野战', 'videos/category/hwyz'], ['按摩探花', 'videos/category/thjx'],
    ['Cosplay', 'videos/category/cos'],
  ]},
  { id: 'group:toupai', name: '偷拍系列', subs: [
    ['酒店监控', 'videos/category/jdjk'], ['真实厕拍', 'videos/category/zscp'],
    ['街头抄底', 'videos/category/jtcd'],
  ]},
  { id: 'group:heiliao', name: '黑料吃瓜', subs: [
    ['抖音网红', 'articles/category/dywh'], ['学生校园', 'articles/category/xsxy'],
    ['海角社区', 'articles/category/hjsq'], ['人妻少妇', 'articles/category/rqsf'],
    ['明星黑料', 'articles/category/mxhl'], ['吃瓜新闻', 'articles/category/cgxw'],
    ['今日吃瓜', 'articles/category/jrcg'],
  ]},
  { id: 'group:ai', name: 'AI成人', subs: [
    ['AI换脸', 'videos/category/aihl'], ['AI漫剧', 'videos/category/aimj'],
    ['AI成人短剧', 'videos/category/aicrdj'],
  ]},
  { id: 'group:rijhan', name: '日韩欧美', subs: [
    ['日本AV', 'videos/category/rbav'], ['疯狂老外', 'videos/category/fklw'],
    ['91原创', 'videos/category/91yc'], ['海角乱伦', 'videos/category/hjll'],
    ['网红黑料', 'videos/category/whhl'], ['反差婊', 'videos/category/fcb'],
    ['街头搭讪', 'videos/category/gyds'], ['H动漫', 'videos/category/hdm'],
  ]},
];
// 只保留 5 个分组（首页推荐与首页内容重复，不再单列；category 仍兼容 all→home 兜底）
const TOP_CLASSES = CATEGORY_GROUPS.map((g) => ({ type_id: g.id, type_name: g.name }));
function buildClassFilters() {
  const filters = {};
  for (const g of CATEGORY_GROUPS) {
    filters[g.id] = [{
      key: 'sub', name: '子分类', init: '',
      value: [{ name: '全部', value: '' }, ...g.subs.map(([name, path]) => ({ name, value: path }))],
    }];
  }
  return filters;
}
function pickSubCategory(p) {
  p = p || {};
  for (const key of ['filters', 'extend', 'ext', 'filter']) {
    let v = p[key];
    if (!v) continue;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    if (!v || typeof v !== 'object') continue;
    const sub = v.sub ?? v['子分类'];
    const val = String(Array.isArray(sub) ? (sub[0] || '') : (sub || '')).trim();
    if (val) return val;
  }
  return '';
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) { try { _origStderrWrite(`[${level}] ${PREFIX} ${msg}\n`); } catch (_) {} }
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.name || v.title || v.value || '').trim();
  return String(v).trim();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 带域名轮换的页面请求 */
async function fetchHtml(path) {
  const fullPath = path.startsWith('/') ? path : `/${path}`;
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const res = await axios.get(`${host}${fullPath}`, {
        timeout: TIMEOUT, validateStatus: () => true,
        headers: { 'User-Agent': UA, Referer: `${host}/`, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      if (res.status === 200 && res.data) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      throw new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('请求失败');
}

/** 封面 AES 解密内联（qnlycc 图床） */
async function resolveCover(url) {
  const u = String(url || '').trim();
  if (!u || !COVER_INLINE || !/^https?:/i.test(u)) return u;
  try {
    const res = await axios.get(u, {
      timeout: 8000, responseType: 'arraybuffer', validateStatus: () => true,
      headers: { 'User-Agent': UA, Referer: `${HOSTS[0]}/` },
    });
    if (res.status !== 200 || !res.data) return u;
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
    if (buf[0] === 0xff && buf[1] === 0xd8) return u; // 明文
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', COVER_KEY, COVER_IV);
      const out = Buffer.concat([d.update(buf), d.final()]);
      if (out.length > 100 && out[0] === 0xff && out[1] === 0xd8) return `data:image/jpeg;base64,${out.toString('base64')}`;
      if (out.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return `data:image/png;base64,${out.toString('base64')}`;
      if (out.slice(0, 4).toString() === 'RIFF' && out.slice(8, 12).toString() === 'WEBP') return `data:image/webp;base64,${out.toString('base64')}`;
    } catch (_) {}
  } catch (_) {}
  return u;
}
async function fillCovers(list) {
  if (!COVER_INLINE || !Array.isArray(list)) return list;
  let idx = 0;
  const workers = Array.from({ length: Math.min(4, list.length) }, async () => {
    while (idx < list.length) {
      const i = idx++;
      if (list[i].vod_pic) list[i].vod_pic = await resolveCover(list[i].vod_pic);
    }
  });
  await Promise.all(workers);
  return list;
}

/** 解析视频卡片（video-item）与文章卡片（post-item） */
function parseList(html, base) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const out = [];
  const seen = new Set();
  // 视频卡片
  $('.video-item a[href*="/videos/"]').each((_, a) => {
    const href = text($(a).attr('href'));
    const m = href.match(/\/videos\/(\d+)\//);
    if (!m || seen.has(m[1])) return;
    const id = m[1];
    const img = $(a).find('img').first();
    const pic = text(img.attr('data-src') || img.attr('src'));
    const title = text(img.attr('alt')) || text($(a).closest('.video-item').find('a.line-clamp-2').first().text());
    const dur = text($(a).find('.text-sm').last().text()).replace(/\s+/g, '');
    if (!title) return;
    seen.add(id);
    out.push({ vod_id: id, vod_name: title, vod_pic: pic, vod_remarks: dur, _kind: 'video' });
  });
  // 文章卡片（黑料吃瓜）
  $('.post-item').each((_, el) => {
    const $el = $(el);
    const a = $el.closest('a[href*="/articles/"]');
    const href = text(a.attr('href'));
    const m = href.match(/\/articles\/(\d+)\//);
    if (!m || seen.has('a' + m[1])) return;
    const id = m[1];
    const poster = $el.find('.post-item-poster').first();
    const pic = text(poster.attr('data-src') || poster.attr('src'));
    const title = text($el.find('.post-item-title').first().text());
    if (!title) return;
    seen.add('a' + id);
    out.push({ vod_id: 'article:' + id, vod_name: title, vod_pic: pic, vod_remarks: '吃瓜文章', _kind: 'article' });
  });
  return out;
}

/* ---------------- 五方法 ---------------- */
async function home() {
  try {
    const html = await fetchHtml('/');
    const list = await fillCovers(parseList(html, HOSTS[0]).slice(0, 60));
    log('info', `home list=${list.length}`);
    return { class: TOP_CLASSES, filters: buildClassFilters(), list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: TOP_CLASSES, filters: buildClassFilters(), list: [] };
  }
}

async function category(params) {
  const p = params || {};
  let slug = String(p.categoryId || p.type_id || p.tid || 'all').trim();
  const sub = pickSubCategory(p);
  if (sub) slug = sub;
  else if (/^group:/i.test(slug)) {
    const g = CATEGORY_GROUPS.find((x) => x.id === slug);
    slug = (g && g.subs[0]) ? g.subs[0][1] : '';
  }
  if (!slug || slug === 'all') return home();
  const page = Math.max(1, Number(p.page || 1) || 1);
  try {
    let path = `/${slug.replace(/^\/+/, '')}/`;
    if (page > 1) path = `/${slug}/page/${page}/`;
    const html = await fetchHtml(path);
    const list = await fillCovers(parseList(html, HOSTS[0]));
    log('info', `category ${slug} page=${page} list=${list.length}`);
    return { page, pagecount: list.length >= 20 ? page + 1 : page, total: list.length, limit: list.length, list };
  } catch (e) {
    log('error', `category ${slug} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function search(params) {
  // 站点搜索页实测 404，未提供可用搜索接口
  const kw = String((params || {}).keyword || '').trim();
  log('info', `search "${kw}" 站点搜索页不可用，返回空`);
  return { page: 1, pagecount: 0, total: 0, limit: 0, list: [] };
}

async function detail(params, context) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = String(p.videoId || p.vod_id || p.id || '').trim();
  if (!raw) return { list: [] };
  try {
    const isArticle = raw.startsWith('article:');
    const id = isArticle ? raw.slice(8) : raw;
    const path = isArticle ? `/articles/${id}/` : `/videos/${id}/`;
    const html = await fetchHtml(path);
    const $ = cheerio.load(html, { decodeEntities: false });
    const title = text($('h1.vf-title').first().text() || $('h1').first().text() || $('h2.post-item-title').first().text()) || '视频';
    const posterRaw = text($('#mse').attr('data-poster') || $('meta[property="og:image"]').attr('content') || '');
    const pic = await resolveCover(posterRaw);
    const tags = [...html.matchAll(/data-video_tag_name="([^"]+)"/g)].map((m) => m[1]).join(' ') || '';
    // 播放：页面 <video src=webm> 是广告/预告；真实正片走 POST /videos/{id}/playback
    // 这里只透传视频 ID，play() 里实时请求签名 m3u8（有时效，不能缓存到详情）
    const episodes = [];
    if (!isArticle && /^\d+$/.test(id)) {
      episodes.push({ name: '正片', playId: `pb:${id}` });
    }
    const sources = episodes.length ? [{ name: '默认线路', episodes }] : [];
    const playFrom = sources.map((s) => s.name).join('$$$');
    const playUrlField = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');
    log('info', `detail ${raw} title=${title} episodes=${episodes.length}`);
    return {
      list: [{
        vod_id: raw, vod_name: title, vod_pic: pic, vod_content: tags,
        vod_remarks: isArticle ? '吃瓜文章' : '视频',
        vod_play_from: playFrom, vod_play_url: playUrlField, vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${raw} ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  const playId = String(p.playId || p.url || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  try {
    let url = '';
    // 端差异化 header：
    //   · 网页端(web)/OK影视(tvbox/uz)：URL 自带 auth_key(含017) 鉴权，裸请求实测 200+CORS全开；
    //     这两个端不消费脚本返回的自定义 header，带 x-cdn-app 反而可能触发其播放器异常 → 用极简 header
    //   · OmniBox 播放器(其它 from)：消费 header，带 x-cdn-app 秒播（1.0.5 已验证）
    const from = String((context && context.from) || '').toLowerCase();
    const needsCdnHeader = !['web', 'tvbox', 'uz', 'catvod', 'emby'].includes(from);
    const headers = needsCdnHeader
      ? { 'User-Agent': UA, Referer: `${HOSTS[0]}/`, 'x-cdn-app': '017' }
      : { 'User-Agent': UA, Referer: `${HOSTS[0]}/` };
    if (playId.startsWith('embed:')) {
      // 备用线路：把 embed 播放页交给播放器自己嗅探（parse=1）
      const embedUrl = playId.slice(6);
      return {
        urls: [{ name: '网页播放页', url: embedUrl }], flag: 'default', header: {},
        parse: 1, danmaku: '',
      };
    }
    if (playId.startsWith('pb:')) {
      // 真实正片：POST /videos/{id}/playback → streams.main（签名 HLS）
      const vid = playId.slice(3);
      let lastErr = null;
      for (const host of HOSTS) {
        try {
          const res = await axios.post(`${host}/videos/${vid}/playback`, {}, {
            timeout: TIMEOUT, validateStatus: () => true,
            headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json', Origin: HOSTS[0] },
          });
          if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
          const json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          const stream = json && json.data && json.data.streams;
          const m3u8 = stream && (stream.main || stream.hevc || stream.preview);
          if (m3u8) { url = m3u8; break; }
          throw new Error(`playback code=${json && json.code}`);
        } catch (e) { lastErr = e; }
      }
      if (!url) throw lastErr || new Error('playback 未返回流');
    } else if (/^https?:\/\//i.test(playId)) {
      url = playId;
    } else {
      const d = await detail({ videoId: playId });
      const pid = d.list[0] && d.list[0].vod_play_sources[0] && d.list[0].vod_play_sources[0].episodes[0] && d.list[0].vod_play_sources[0].episodes[0].playId;
      if (pid) return play({ playId: pid });
    }
    if (!url) throw new Error('无播放地址');
    log('info', `play url=${url.slice(0, 120)}`);
    return {
      urls: [{ name: '正片', url }], flag: 'default', header: headers,
      parse: 0, danmaku: '',
    };
  } catch (e) {
    log('error', `play ${playId.slice(0, 40)} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
