// @name 色花堂
// @author OmniBox
// @description 色花堂（18sht.com）：MacCMS 风格前台，HTML 卡片取列表，详情 div#mse[data-url] 取 m3u8 直链（parse=0）。封面 new2.qnlycc.cn AES 加密图内联 data URI（兼容 OK影视）。分类/搜索/分页/详情全通。
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/色花堂.js
// @dependencies axios, crypto
/**
 * ============ 色花堂（18sht.com）OmniBox 采集源 ============
 * 【站点事实（2026-11-26 实测）】
 *  - 首页 /；视频列表 /video/，分页 /video/page/N/，搜索 /video/search/{关键词}/。
 *  - 子分类 /video/hd/ /video/original/ /video/now-hot/ 等；标签 /tag/{词}/；黑料图文 /heiliao-chigua/。
 *  - 详情 /video/{id}/，播放器 <div id="mse" data-video="{id}" data-url="{m3u8}"
 *    data-url-hevc="{m3u8}" data-poster="{jpg}">。m3u8 带 auth_key，裸请求可播（AES-128）。
 *    注意 HTML 属性里是 &amp;，需解码为 &。
 *  - 列表卡片：<a href="/video/{id}/"> ... <img data-src="{new2.qnlycc...webp}"
 *    data-fallback-src="{pic.qnlycc...jpg?auth_key=...}" alt="{标题}"> ... <div>{时长}</div>。
 *  - 封面 new2.qnlycc.cn/*.webp 是 AES-128-CBC 加密图（同 51吃瓜/黑料网/91探花 图床），
 *    KEY=f5d965df75336270 IV=97b60394abc2fbe1，抓图解密后转 data URI（OK影视/UZN 都能显示）。
 *
 * 环境变量：
 *  SHT_HOST      站点基址，默认 https://18sht.com
 *  SHT_UA        自定义 UA
 *  SHT_TIMEOUT   单请求超时毫秒，默认 15000
 *  SHT_CACHE_TTL 缓存秒数，默认 300
 *  SHT_COVER_INLINE 封面内联开关，默认 1（设 0 关闭回退原 URL）
 */
const axios = require('axios');
const crypto = require('crypto');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[色花堂]';
const UA = String(process.env.SHT_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = String(process.env.SHT_HOST || 'https://18sht.com').replace(/\/+$/, '');
const TIMEOUT = Math.max(5000, Number(process.env.SHT_TIMEOUT || 15000) || 15000);
const CACHE_TTL = Math.max(0, Number(process.env.SHT_CACHE_TTL || 300) || 300);
const COVER_INLINE = process.env.SHT_COVER_INLINE !== '0';
const COVER_CONCURRENCY = 4;
const COVER_KEY = Buffer.from(String(process.env.SHT_COVER_KEY || 'f5d965df75336270'), 'latin1');
const COVER_IV = Buffer.from(String(process.env.SHT_COVER_IV || '97b60394abc2fbe1'), 'latin1');

function log(level, msg) { try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {} }
function text(v) { return v == null ? '' : String(v).trim(); }
function decodeHtml(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function clean(s) { return decodeHtml(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function absUrl(u) { try { return new URL(String(u || '').trim(), BASE).href; } catch (_) { return ''; } }

async function fetchHtml(path) {
  const res = await axios.get(BASE + path, {
    timeout: TIMEOUT, validateStatus: () => true,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: BASE + '/' },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (Buffer.isBuffer(res.data)) return res.data.toString('utf-8');
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

// ===== 封面内联（new2.qnlycc AES 图 -> data URI）=====
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
function decryptCover(buf) {
  const plain = sniffImageType(buf);
  if (plain) return { mime: plain, body: buf };
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', COVER_KEY, COVER_IV);
    const out = Buffer.concat([d.update(buf), d.final()]);
    const mime = sniffImageType(out);
    if (mime) return { mime, body: out };
  } catch (_) {}
  return null;
}
const coverCache = new Map();
async function resolveCover(url) {
  if (!url || !COVER_INLINE || !/^https?:/i.test(url)) return url || '';
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const res = await axios.get(url, {
      timeout: 8000, responseType: 'arraybuffer', validateStatus: () => true,
      headers: { 'User-Agent': UA, Referer: BASE + '/' },
    });
    let buf = res.data;
    if (res.status === 200 && buf) {
      if (!Buffer.isBuffer(buf)) {
        if (buf.buffer && typeof buf.byteLength === 'number') buf = Buffer.from(buf.buffer, buf.byteOffset || 0, buf.byteLength);
        else if (Array.isArray(buf)) buf = Buffer.from(buf);
        else buf = Buffer.from(String(buf));
      }
      const dec = decryptCover(buf);
      if (dec && dec.body.length > 100) {
        const uri = `data:${dec.mime};base64,${dec.body.toString('base64')}`;
        coverCache.set(url, uri);
        return uri;
      }
    }
  } catch (_) {}
  coverCache.set(url, url);
  return url;
}
async function resolveCovers(list) {
  if (!COVER_INLINE || !Array.isArray(list) || !list.length) return list;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      const it = list[i];
      if (it && it.vod_pic) { try { it.vod_pic = await resolveCover(it.vod_pic); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, list.length) }, () => worker()));
  return list;
}

// ===== 列表解析（视频卡片）=====
function parseList(html) {
  const out = [];
  const seen = new Set();
  // 每个 <a href="/video/{id}/"> 卡片块
  const re = /<a[^>]*href="\/video\/(\d+)\/"[^>]*>([\s\S]{0,1200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const block = m[2];
    const img = block.match(/<img[^>]*>/i) || [''];
    const attrs = img[0];
    const alt = (attrs.match(/alt="([^"]*)"/i) || [])[1] || '';
    const name = clean(alt);
    if (!name || name.length < 2) continue;
    // 优先 new2 稳定图（webp），其次 data-src，再次 fallback
    const pic = decodeHtml((attrs.match(/data-src="([^"]+)"/i) || [])[1]
      || (attrs.match(/data-fallback-src="([^"]+)"/i) || [])[1] || '');
    const dur = clean((block.match(/<div[^>]*>(\d{1,2}:\d{2}(?::\d{2})?)<\/div>/i) || [])[1] || '');
    seen.add(id);
    out.push({ vod_id: id, vod_name: name, vod_pic: absUrl(pic), vod_remarks: dur });
  }
  return out;
}

// 官网导航分类（顶层大类，与首页一致）
const CLASSES = [
  { type_id: 'video', type_name: '全部视频' },
  { type_id: 'heiliao-chigua', type_name: '黑料吃瓜' },
  { type_id: 'av', type_name: '日本AV' },
  { type_id: 'duanju', type_name: 'AI短剧' },
  { type_id: 'moviesets', type_name: '精选合集' },
  { type_id: 'tag', type_name: '热门标签' },
  { type_id: 'novels', type_name: '成人小说' },
];

// 二级子分类（官网可见项完整补齐，value 为相对站点根的路径）
const SUBCATEGORIES = {
  video: [
    ['全部', ''], ['热门排行榜', 'video/now-month-hot'], ['最近更新', 'video/new-update'],
    ['当前热门', 'video/now-hot'], ['高清精选', 'video/hd'], ['原创自拍', 'video/original'],
    ['本月收藏', 'video/now-month-collect'], ['本月评论', 'video/now-month-comment'],
    ['本月热门', 'video/month-hot'], ['十分钟', 'video/ten_minutes'], ['二十分钟', 'video/twenty_minutes'],
    ['最大合集', 'video/max-collect'],
  ],
  'heiliao-chigua': [
    ['全部', ''], ['今日吃瓜', 'heiliao-chigua/jinrichigua'], ['学生校园', 'heiliao-chigua/xueshengxiaoyuan'],
    ['明星黑料', 'heiliao-chigua/mingxingheiliao'], ['网红黑料', 'heiliao-chigua/wanghongheiliao'],
    ['吃瓜新闻', 'heiliao-chigua/chiguaxinwen'], ['伦理道德', 'heiliao-chigua/伦理道德'],
    ['每日大赛', 'heiliao-chigua/meiridasai'],
  ],
  av: [
    ['全部', 'av'], ['角色扮演', 'av/theme/2'], ['中文字幕', 'av/theme/5'], ['制服诱惑', 'av/theme/6'],
    ['主奴调教', 'av/theme/7'], ['凌辱强暴', 'av/theme/8'], ['无码高清', 'av/theme/12'],
  ],
  duanju: [
    ['全部', 'duanju'], ['成人短剧', 'duanju/chengren-duanju'],
  ],
  moviesets: [['全部', 'moviesets']],
  tag: [
    ['全部', ''], ['自拍', 'tag/自拍'], ['约炮', 'tag/约炮'], ['内射中出', 'tag/内射'],
    ['童颜巨乳', 'tag/巨乳'], ['人妻熟女', 'tag/人妻'], ['家庭乱伦', 'tag/家庭乱伦'],
    ['萝莉少女', 'tag/萝莉'], ['SM调教', 'tag/调教'], ['丝袜美腿', 'tag/丝袜'],
    ['黑料', 'tag/黑料'], ['学生妹', 'tag/学生妹'], ['直播', 'tag/直播'], ['清纯', 'tag/清纯'],
    ['KiKi', 'tag/JK'], ['原创', 'tag/原创'],
  ],
  novels: [
    ['都市激情', 'novels/dushi-jiqing/new'], ['校园之恋', 'novels/xiaoyuan-zhilian/new'],
    ['人妻熟女', 'novels/renqi-shunv/new'], ['家庭乱伦', 'novels/jiating-luanlun/new'],
    ['经验故事', 'novels/jingyan-gushi/new'], ['真实体验', 'novels/zhenshi-tiyan/new'],
  ],
};
function buildCategoryFilters() {
  const f = {};
  for (const [id, subs] of Object.entries(SUBCATEGORIES)) {
    f[id] = [{ key: 'sub', name: '子分类', init: '', value: subs.map(([name, value]) => ({ name, value })) }];
  }
  return f;
}
function pickSub(params, categoryId) {
  const src = (params && (params.filters || params.extend || params.ext || params.filter)) || {};
  let v = src.sub ?? src['子分类'] ?? '';
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v.value ?? v.v ?? '';
  return String(v || '').trim();
}

// 进程内缓存
const mem = new Map();
function memGet(k, ttl) { const v = mem.get(k); if (v && Date.now() - v.t < ttl) return v.d; return null; }
function memSet(k, d) { mem.set(k, { t: Date.now(), d }); }
async function cacheGet(k) { try { const v = await OmniBox.getCache(`${PREFIX}:${k}`); return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } }
async function cacheSet(k, d, ttl) { try { await OmniBox.setCache(`${PREFIX}:${k}`, JSON.stringify(d), ttl); } catch (_) {} }

// ============ 五方法 ============
async function home(params, context) {
  log('info', `home 入口 from=${(context && context.from) || 'web'}`);
  try {
    let list = memGet('home:list', 5 * 60 * 1000);
    if (!list) { const c = await cacheGet('home'); if (c && c.length) list = c; }
    if (!list) {
      list = parseList(await fetchHtml('/video/'));
      if (list.length) { memSet('home:list', list); await cacheSet('home', list, CACHE_TTL); }
    }
    await resolveCovers(list);
    const filters = buildCategoryFilters();
    log('info', `home 返回 class=${CLASSES.length} list=${list.length} filters=${Object.keys(filters).length}`);
    return { class: CLASSES, list, filters };
  } catch (e) { log('error', `home 失败: ${e.message}`); return { class: [], list: [] }; }
}

// 通用文章卡片解析（黑料/短剧/小说等图文分类：a[href=/{slug}/{数字}/] + 文本/图片）
function parseArticleList(html, slug) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(`<a[^>]*href="/${slug}/(\\d+)/"[^>]*>([\\s\\S]{0,600}?)</a>`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const block = m[2];
    const name = clean(block);
    if (!name || name.length < 3) continue;
    const pic = decodeHtml((block.match(/(?:data-src|data-original|src)="([^"]+)"/i) || [])[1] || '');
    seen.add(id);
    out.push({ vod_id: `${slug}:${id}`, vod_name: name.slice(0, 80), vod_pic: pic ? absUrl(pic) : '', vod_remarks: '' });
  }
  return out;
}

async function category(params, context) {
  const rawId = String((params && (params.categoryId ?? params.t ?? params.id ?? params.type_id)) || '').replace(/^\/+|\/+$/g, '');
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  const sub = pickSub(params, rawId);
  log('info', `category 入口 id=${rawId} sub=${sub} page=${page}`);
  if (!rawId) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    // 解析目标路径：优先用 filters.sub（子分类路径），否则用 id 本身
    let route = sub || rawId;
    // id 是顶层大类且 sub 为空时，取该大类的第一个有内容的默认路径
    if (!sub && SUBCATEGORIES[rawId]) {
      const first = SUBCATEGORIES[rawId].find(([, v]) => v);
      route = first ? first[1] : rawId;
    }
    if (route === 'video') route = 'video';
    const path = page <= 1 ? `/${route}/` : `/${route}/page/${page}/`;
    const html = await fetchHtml(path);
    let list = parseList(html);
    // 视频卡片为空时，尝试图文文章卡片（黑料/短剧/小说）
    if (!list.length) {
      const seg = route.split('/')[0];
      list = parseArticleList(html, seg);
    }
    // AV 等纯导航页无任何内容卡片：回退视频推荐列表，避免空页
    if (!list.length && (route.startsWith('av/') || route === 'av')) {
      list = parseList(await fetchHtml('/video/'));
      log('info', `[category] ${route} 无内容卡片，回退视频推荐 ${list.length} 条`);
    }
    await resolveCovers(list);
    const hasNext = /href="\/[^"]*\/page\/\d+\/"/i.test(html);
    log('info', `category 返回 id=${rawId} route=${route} page=${page} list=${list.length} hasNext=${hasNext}`);
    return { page, pagecount: hasNext ? page + 1 : page, total: list.length, list, filters: { [rawId]: buildCategoryFilters()[rawId] || [] } };
  } catch (e) { log('error', `category 失败: ${e.message}`); return { page, pagecount: 0, total: 0, list: [] }; }
}

async function search(params, context) {
  const kw = String((params && (params.keyword ?? params.kw ?? params.wd ?? params.search)) || '').trim();
  const page = Math.max(1, Number((params && (params.page ?? params.pg)) || 1) || 1);
  log('info', `search 入口 kw=${kw} page=${page}`);
  if (!kw) return { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const path = page <= 1 ? `/video/search/${encodeURIComponent(kw)}/` : `/video/search/${encodeURIComponent(kw)}/page/${page}/`;
    const html = await fetchHtml(path);
    const list = parseList(html);
    await resolveCovers(list);
    const hasNext = /href="\/video\/search\/[^"]*\/page\/\d+\/"/i.test(html);
    log('info', `search 返回 kw=${kw} list=${list.length}`);
    return { page, pagecount: hasNext ? page + 1 : page, total: list.length, list };
  } catch (e) { log('error', `search 失败: ${e.message}`); return { page: 1, pagecount: 0, total: 0, list: [] }; }
}

async function detail(params, context) {
  const vid = String((params && (params.videoId ?? params.id)) || '').trim();
  log('info', `detail 入口 vid=${vid}`);
  if (!vid) return { list: [] };
  try {
    const html = await fetchHtml(`/video/${vid}/`);
    // 播放器 div#mse 属性
    const mse = html.match(/<div[^>]*id="mse"[^>]*>/i) || [];
    const tag = mse[0] || '';
    const attr = (name) => decodeHtml((tag.match(new RegExp(`data-${name}="([^"]*)"`, 'i')) || [])[1] || '');
    const urlMain = attr('url');
    const urlHevc = attr('url-hevc');
    const poster = attr('poster');
    // 标题
    const title = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
      || (html.match(/<title>([^<]*)/i) || [])[1] || '').split(/[-|]/)[0];
    // 简介
    const desc = clean((html.match(/class="[^"]*(?:vod_content|video-desc|description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
    const sources = [];
    if (urlMain) sources.push({ name: '主线路', episodes: [{ name: '正片', playId: urlMain }] });
    if (urlHevc && urlHevc !== urlMain) sources.push({ name: 'H265', episodes: [{ name: '正片', playId: urlHevc }] });
    let finalPic = poster;
    if (poster) { try { finalPic = await resolveCover(poster); } catch (_) {} }
    const item = {
      vod_id: vid, vod_name: title, vod_pic: finalPic, vod_content: desc,
      type_name: '', vod_play_sources: sources.length ? sources : undefined,
    };
    log('info', `detail 返回 vid=${vid} title=${title.slice(0, 20)} sources=${sources.length}`);
    return { list: [item] };
  } catch (e) { log('error', `detail 失败: ${e.message}`); return { list: [] }; }
}

async function play(params, context) {
  const flag = String((params && params.flag) || '色花堂');
  const raw = String((params && (params.playId ?? params.url ?? params.id)) || '').trim();
  log('info', `play 入口 flag=${flag} url=${raw.slice(0, 80)}`);
  const header = { 'User-Agent': UA, Referer: BASE + '/', Origin: BASE };
  if (!raw) return { urls: [], flag, header, parse: 0 };
  try {
    const url = decodeHtml(raw);
    const parse = /\.(m3u8|mp4)(\?|$)/i.test(url) ? 0 : 1;
    log('info', `play 输出 parse=${parse}`);
    return { urls: [{ name: '正片', url }], flag, header, parse };
  } catch (e) { log('error', `play 失败: ${e.message}`); return { urls: [], flag, header, parse: 0 }; }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
