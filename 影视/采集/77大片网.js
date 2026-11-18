// @name 77大片网
// @author 宝宝巴士
// @description 66大片网(www.77dpw.vip) mxpro 模板：首页/分类(电影动漫剧集短剧综艺)/详情/播放；player_aaaa(encrypt=2) base64+urldecode 解码，解出网页链接走 SDK 嗅探；搜索走分类本地匹配+ymck 聚合兜底(站内搜索需图片验证码)
// @version 1.0.3
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/采集/77大片网.js
// @dependencies axios,cheerio
/**
 * ============ 77大片网 / 66大片网（www.77dpw.vip）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-18 实测）】
 *   MacCMS mxpro 模板，服务端渲染，nginx。
 *   首页：/
 *   分类：/vodtype/{id}.html    1电影 2动漫 3剧集 4短剧 5综艺
 *   翻页：/vodtype/{id}-{page}.html（无限下拉，但直连 -N.html 可取到第 N 页）
 *   详情：/voddetail/{id}.html
 *   播放：/vodplay/{id}-{sid}-{nid}.html
 *   搜索：/vodsearch/{关键词}-------------.html （触发图片验证码，本源不用）
 *
 * 【列表卡片】
 *   <a href="/voddetail/{id}.html" title="标题" class="module-poster-item module-item">
 *     <img data-original="封面" ...>
 *     <div class="module-item-note">更新至XX集</div>
 *     <div class="module-poster-item-title">标题</div>
 *
 * 【详情线路】（mxpro 新版 DOM）
 *   线路名：<div class="module-tab-item tab-item" data-dropdown-value="腾讯视频">
 *   分集：  <a class="module-play-list-link" href="/vodplay/{id}-{sid}-{nid}.html" title="分集名">
 *   同时返回 vod_play_from / vod_play_url 兼容宿主旧链路。
 *
 * 【播放解密】
 *   播放页 <script>var player_aaaa={...}</script>
 *   encrypt=2 时：url = unescape(base64decode(player_aaaa.url))
 *   即 url 先 base64 解码，再对它做 urldecode（%XX）→ 得到真实地址。
 *   若为 m3u8/mp4 直链直接返回；若是网页链接（腾讯/爱奇艺等）走 SDK 嗅探。
 */
const axios = require('axios');
const cheerio = require('cheerio');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const HOST = String(process.env.DPW_HOST || 'https://www.77dpw.vip').replace(/\/+$/, '');
const UA = String(process.env.DPW_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PREFIX = '[77dpw]';

const CLASS_LIST = [
  { type_id: '1', type_name: '电影' },
  { type_id: '2', type_name: '动漫' },
  { type_id: '3', type_name: '剧集' },
  { type_id: '4', type_name: '短剧' },
  { type_id: '5', type_name: '综艺' },
];

const http = axios.create({
  timeout: 20000,
  validateStatus: () => true,
  headers: { 'User-Agent': UA, Referer: `${HOST}/` },
});

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {}
}

function absUrl(url, base = HOST) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  try { return new URL(value, /^https?:\/\//i.test(base) ? base : `${HOST}/`).toString(); }
  catch (_) {
    if (value.startsWith('/')) return `${HOST}${value}`;
    return `${HOST}/${value.replace(/^\/+/, '')}`;
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

async function fetchText(url, options = {}) {
  const res = await http.get(url, {
    headers: {
      'User-Agent': UA,
      Referer: options.referer || `${HOST}/`,
      ...(options.headers || {}),
    },
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} @ ${url}`);
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
}

/* ---------------- 列表解析 ---------------- */
function parseVodCards(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const list = [];
  $('a.module-poster-item[href*="/voddetail/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const id = (href.match(/\/voddetail\/(\d+)\.html/i) || [])[1] || '';
    if (!id) return;
    const title = stripHtml($a.attr('title') || '') || stripHtml($a.find('.module-poster-item-title').first().text());
    const pic = $a.find('img').first().attr('data-original') || $a.find('img').first().attr('data-src') || $a.find('img').first().attr('src') || '';
    const remarks = stripHtml($a.find('.module-item-note').first().text())
      || stripHtml($a.find('.module-item-pic .module-item-note').first().text());
    if (!title) return;
    list.push({ vod_id: id, vod_name: title, vod_pic: absUrl(pic), vod_remarks: remarks });
  });
  return dedupeBy(list, (x) => x.vod_id);
}

/* ---------------- 首页 ---------------- */
async function home() {
  try {
    const html = await fetchText(`${HOST}/`);
    let list = parseVodCards(html).slice(0, 60);
    if (!list.length) {
      const fb = await fetchText(`${HOST}/vodtype/1.html`);
      list = parseVodCards(fb).slice(0, 60);
    }
    log('info', `home list=${list.length}`);
    return { class: CLASS_LIST, list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: CLASS_LIST, list: [] };
  }
}

/* ---------------- 分类（含翻页） ---------------- */
async function fetchCategoryPage(typeId, page) {
  const url = page > 1 ? `${HOST}/vodtype/${typeId}-${page}.html` : `${HOST}/vodtype/${typeId}.html`;
  const html = await fetchText(url);
  return { html, list: parseVodCards(html) };
}

async function category(params) {
  try {
    const p = params || {};
    const typeId = String(p.categoryId || p.type_id || p.tid || '1').trim();
    const page = Math.max(1, Number(p.page || 1) || 1);
    const { html, list } = await fetchCategoryPage(typeId, page);
    const pagecount = await estimatePageCount(typeId, page, html, list.length);
    log('info', `category type=${typeId} page=${page} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    log('error', `category ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

/** 分类页是无限下拉、无页码控件：向后多探一页，有数据说明还有下一页 */
async function estimatePageCount(typeId, page, html, currentCount) {
  let maxPage = page;
  const m = [...String(html || '').matchAll(/vodtype\/\d+-(\d+)\.html/gi)].map((x) => Number(x[1]));
  if (m.length) maxPage = Math.max(maxPage, ...m);
  if (!currentCount) return maxPage;
  if (maxPage > page) return maxPage;
  try {
    const next = await fetchCategoryPage(typeId, page + 1);
    if (next.list.length) return page + 1;
  } catch (_) {}
  return page;
}

/* ---------------- 详情 ---------------- */
function parseDetailMeta($) {
  let vodName = stripHtml($('.module-info-heading h1').first().text());
  if (!vodName) vodName = stripHtml($('h1').first().text());
  if (!vodName) vodName = stripHtml($('title').first().text()).replace(/详情.*$/, '').trim();

  const pic = $('.module-info-poster img').first().attr('data-original')
    || $('.module-info-poster img').first().attr('src')
    || $('.module-info-heading img').first().attr('data-original')
    || $('.stui-content__thumb img').first().attr('data-original')
    || '';

  let director = '', actor = '', content = '', year = '', area = '';
  $('.module-info-item').each((_, el) => {
    const $el = $(el);
    const title = stripHtml($el.find('.module-info-item-title').first().text());
    const val = stripHtml($el.find('.module-info-item-content').first().text()).replace(/\s*\/\s*$/, '').trim();
    if (title.includes('导演')) director = val;
    else if (title.includes('主演') || title.includes('演员')) actor = val;
  });
  content = stripHtml($('.module-info-introduction-content').first().text())
    || stripHtml($('meta[name="description"]').attr('content') || '');
  const yearLink = $('a[href*="/vodshow/"][title]').filter((_, a) => /^(19|20)\d{2}$/.test($(a).attr('title') || '')).first();
  year = stripHtml(yearLink.attr('title') || '');
  const areaLink = $('a[href*="/vodshow/"]').filter((_, a) => /地区|国家/.test($(a).closest('.module-info-item').text())).first();
  area = stripHtml(areaLink.text() || '');
  const typeLinks = $('a[href*="/vodshow/"]').filter((_, a) => {
    const s = $(a).attr('href') || '';
    return /---/.test(s);
  }).map((_, a) => stripHtml($(a).text())).get().filter(Boolean);
  const typeName = typeLinks[0] || '';

  return { vodName, pic, director, actor, content, year, area, typeName };
}

function cleanEpisodeName(name, vodName) {
  let n = stripHtml(name);
  if (!n) return '';
  // mxpro 的分集 title 常是「播放哈姆雷特原声版」，片名是冗余前缀 → 去掉
  if (vodName) {
    const prefixes = [`播放${vodName}`, `播放${vodName}第`, `播放${vodName}：`];
    for (const pre of prefixes) {
      if (n.startsWith(pre)) {
        const rest = n.slice(pre.length).replace(/^[：:\-\s]+/, '');
        if (rest) return rest;
      }
    }
  }
  return n;
}

function parsePlaySources($, vodName) {
  const sources = [];
  const tabNames = [];
  $('.module-tab-item[data-dropdown-value]').each((_, el) => {
    tabNames.push(stripHtml($(el).attr('data-dropdown-value') || '') || stripHtml($(el).text()));
  });
  $('.module-play-list').each((idx, panel) => {
    const $panel = $(panel);
    const episodes = [];
    $panel.find('a.module-play-list-link[href*="/vodplay/"]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const name = cleanEpisodeName($a.attr('title') || $a.text(), vodName);
      if (!href) return;
      episodes.push({ name: name || `第${episodes.length + 1}集`, playId: absUrl(href) });
    });
    if (!episodes.length) return;
    const name = tabNames[idx] || tabNames[0] || `线路${sources.length + 1}`;
    sources.push({ name, episodes });
  });
  return dedupeBy(sources, (s) => s.name + '|' + s.episodes[0].playId);
}

async function detail(params) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = p.videoId || p.vod_id || p.id || p.ids || '';
  const videoId = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!videoId) return { list: [] };
  try {
    const html = await fetchText(`${HOST}/voddetail/${videoId}.html`);
    const $ = cheerio.load(html, { decodeEntities: false });
    const meta = parseDetailMeta($);
    const sources = parsePlaySources($, meta.vodName);

    const vodPlayFrom = sources.map((s) => s.name).join('$$$');
    const vodPlayUrl = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');

    log('info', `detail id=${videoId} sources=${sources.length} title=${meta.vodName} playFrom=${vodPlayFrom}`);
    return {
      list: [{
        vod_id: videoId,
        vod_name: meta.vodName,
        vod_pic: meta.pic,
        type_name: meta.typeName,
        vod_area: meta.area,
        vod_year: meta.year,
        vod_actor: meta.actor,
        vod_director: meta.director,
        vod_content: meta.content,
        vod_remarks: '',
        vod_play_from: vodPlayFrom,
        vod_play_url: vodPlayUrl,
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${videoId} ${e.message}`);
    return { list: [] };
  }
}

/* ---------------- 搜索 ---------------- */
/** 站内搜索需图片验证码；改为遍历若干分类页本地匹配标题 */
async function searchByCategory(keyword, page) {
  const kw = String(keyword || '').toLowerCase();
  const perScan = Number(process.env.DPW_SEARCH_PAGES || 6);
  // 并发抓取：首页 + 5 个分类的前 N 页，显著缩短搜索耗时。
  const tasks = [];
  const pushTask = (url) => tasks.push(
    fetchText(url).then((html) => parseVodCards(html)).catch(() => [])
  );
  pushTask(`${HOST}/`);
  for (const cls of CLASS_LIST) {
    for (let pg = 1; pg <= perScan; pg++) {
      pushTask(pg > 1 ? `${HOST}/vodtype/${cls.type_id}-${pg}.html` : `${HOST}/vodtype/${cls.type_id}.html`);
    }
  }
  const batches = [];
  for (let i = 0; i < tasks.length; i += 6) batches.push(tasks.slice(i, i + 6));
  const out = [];
  for (const batch of batches) {
    const results = await Promise.all(batch);
    for (const list of results) {
      for (const item of list || []) {
        if (String(item.vod_name || '').toLowerCase().includes(kw)) out.push(item);
      }
    }
  }
  const start = (page - 1) * 20;
  return dedupeBy(out, (x) => x.vod_id).slice(start, start + 20);
}

/** ymck 聚合搜索兜底（只保留指向本站的链接） */
async function searchByYmck(keyword, page) {
  const url = `https://www.ymck.pro/API/v2.php?q=${encodeURIComponent(keyword)}&size=50`;
  const raw = await fetchText(url, { referer: `${HOST}/` });
  const decoded = Buffer.from(String(raw).trim(), 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  // 结构：['data', {website,icon,text,url,tags}, ...] —— 从第 1 项起每个是一条结果对象
  const arr = Array.isArray(parsed) ? parsed.slice(1).filter((x) => x && typeof x === 'object') : [];
  const out = [];
  for (const item of arr) {
    const link = String(item.url || '');
    const id = (link.match(/\/voddetail\/(\d+)\.html/i) || [])[1] || '';
    if (!id || !/77dpw|66dpw/i.test(link)) continue;
    out.push({
      vod_id: id,
      vod_name: String(item.text || keyword),
      vod_pic: absUrl(item.icon || ''),
      vod_remarks: '',
    });
  }
  const start = (page - 1) * 20;
  return dedupeBy(out, (x) => x.vod_id).slice(start, start + 20);
}

async function search(params) {
  const p = params || {};
  const keyword = String(p.keyword || p.wd || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!keyword) return { page, pagecount: 0, total: 0, limit: 0, list: [] };

  let list = [];
  try { list = await searchByCategory(keyword, page); }
  catch (e) { log('error', `search category ${e.message}`); }
  if (!list.length) {
    try { list = await searchByYmck(keyword, page); }
    catch (e) { log('error', `search ymck ${e.message}`); }
  }
  log('info', `search keyword=${keyword} page=${page} list=${list.length}`);
  return { page, pagecount: list.length ? page + 1 : page, total: list.length, limit: list.length, list };
}

/* ---------------- 播放 ---------------- */
/** 解 player_aaaa.url：encrypt=2 → unescape(base64decode(url)) = urldecode(base64decode(url)) */
function decodePlayerUrl(enc, encrypt) {
  let s = String(enc || '').trim();
  if (!s) return '';
  try {
    if (Number(encrypt) === 2) {
      s = Buffer.from(s, 'base64').toString('utf8');
      s = decodeURIComponent(s);
    } else {
      s = decodeURIComponent(s);
    }
  } catch (e) {
    log('error', `decodePlayerUrl ${e.message}`);
  }
  return s.trim();
}

async function resolvePlay(playId) {
  const html = await fetchText(playId, { referer: `${HOST}/` });
  const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
    || html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?/i);
  if (!m) throw new Error('未找到 player_aaaa');
  let data;
  try { data = JSON.parse(m[1]); }
  catch (e) { throw new Error(`player_aaaa JSON 解析失败: ${e.message}`); }
  const url = decodePlayerUrl(data.url, data.encrypt);
  log('info', `resolvePlay encrypt=${data.encrypt} url=${url.slice(0, 200)}`);
  return url;
}

async function play(params) {
  const p = typeof params === 'string' ? { playId: params } : (params || {});
  const playId = String(p.playId || p.url || p.vod_id || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  const header = { 'User-Agent': UA, Referer: `${HOST}/` };

  try {
    const resolved = await resolvePlay(playId);
    if (isHttpUrl(resolved)) {
      if (/\.m3u8(\?|$)/i.test(resolved) || /\.mp4(\?|$)/i.test(resolved)) {
        log('info', `play direct ${resolved.slice(0, 160)}`);
        return { urls: [{ name: '默认线路', url: resolved }], flag: 'default', header, parse: 0, danmaku: '' };
      }
      // 网页链接（腾讯/爱奇艺等）走 SDK 嗅探
      try {
        const sniffed = await OmniBox.sniffVideo(resolved, header);
        if (typeof sniffed === 'string' && isHttpUrl(sniffed)) {
          return { urls: [{ name: '默认线路', url: sniffed }], flag: 'default', header, parse: 0, danmaku: '' };
        }
        if (sniffed && sniffed.url && isHttpUrl(sniffed.url)) {
          return { urls: sniffed.urls || [{ name: '默认线路', url: sniffed.url }], flag: 'default', header: sniffed.headers || header, parse: sniffed.parse ?? 0, danmaku: '' };
        }
        if (sniffed && Array.isArray(sniffed.urls) && sniffed.urls.length) {
          return { urls: sniffed.urls, flag: 'default', header: sniffed.headers || header, parse: sniffed.parse ?? 0, danmaku: '' };
        }
      } catch (e) {
        log('error', `play sniff ${e.message}`);
      }
      // 嗅探失败：保留原始网页链接交给播放器嗅探（parse=1 仅 ok影视 app 有效）
      return { urls: [{ name: '默认线路', url: resolved }], flag: 'default', header, parse: 1, danmaku: '' };
    }
  } catch (e) {
    log('error', `play resolve ${e.message}`);
  }
  return { urls: [{ name: '默认线路', url: playId }], flag: 'default', header, parse: 1, danmaku: '' };
}
