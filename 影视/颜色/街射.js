// @name 街射
// @author 宝宝巴士
// @description 街射(jieshee.cc，入口 account.jieshee.cc)：首页/分类/搜索/详情/播放；播放直接从详情 window.__ARCHIVE_PLAYER__(cdnLine+rawPath) 取 m3u8；封面图床 content-type 异常，脚本内联 data:image；多 CDN 线路兜底
// @version 1.0.2
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/街射.js
// @dependencies axios,cheerio
/**
 * ============ 街射（account.jieshee.cc / jieshee.cc）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-18 实测）】
 *   Cloudflare 后，独立 tp4 模板，服务端渲染，首页 ~997KB。
 *   首页：/
 *   分类：/category/cate{数字}/   （cate1..cate99）
 *   详情：/video/{数字ID}/
 *   搜索：/search/{关键词}/
 *
 * 【卡片】
 *   <div class="tp4-section-content__item">
 *     <a href="/video/{id}/" aria-label="标题">
 *       <img data-src="封面">
 *       <div class="tp4-item-preview" data-plink="/video/.../xxx_preview.m3u8">
 *       <div class="tp4-duration">07:42</div>
 *       <h3 class="text-truncate">标题</h3>
 *
 * 【播放（关键）】
 *   详情页内联：
 *     window.__ARCHIVE_PLAYER__ = {rawPath:"/video/.../xxx.m3u8", cdnLine:"https://xxx.sxtmo.com", posterImg, ...}
 *   m3u8 = cdnLine + rawPath（无需签名，实测 200）。
 *   另有多线路 cdn_lines 数组，主线路挂时可切换备用。
 *
 * 【封面】
 *   图床 sxtmo.com 返回真实 JPEG 但 content-type=text/base64.jpg，
 *   前端 blob 显示。脚本内联成 data:image/jpeg;base64 确保渲染。
 */
const axios = require('axios');
const cheerio = require('cheerio');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[jieshee]';
const UA = String(process.env.JS_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOSTS = String(process.env.JS_HOSTS || 'https://account.jieshee.cc').split(',')
  .map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
const COVER_INLINE = process.env.JS_COVER_INLINE !== '0';
const COVER_CONCURRENCY = 4;
const COVER_TIMEOUT = 8000;

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {}
}
function absUrl(url, base) {
  const v = String(url || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  try { return new URL(v, base || `${HOSTS[0]}/`).toString(); }
  catch (_) { return v; }
}
function stripHtml(t) {
  return String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}
function uniq(a) { return Array.from(new Set(a)); }
function dedupeBy(list, keyFn) {
  const seen = new Set(); const out = [];
  for (const item of list || []) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(item);
  }
  return out;
}

const http = axios.create({
  timeout: 15000,
  validateStatus: () => true,
  headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});

async function fetchText(url, options = {}) {
  let lastErr = null;
  for (const host of HOSTS) {
    const full = /^https?:\/\//i.test(url) ? url : `${host}${url}`;
    try {
      const res = await http.get(full, {
        headers: { Referer: `${host}/`, ...(options.headers || {}) },
        responseType: 'text',
      });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('请求失败');
}

/* ---------------- 列表解析 ---------------- */
function parseCards(html, base) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const list = [];
  $('.tp4-section-content__item').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a[href*="/video/"]').first().attr('href') || '';
    const id = (href.match(/\/video\/(\d+)\//) || [])[1] || '';
    if (!id) return;
    const img = $el.find('img').first();
    const pic = img.attr('data-src') || img.attr('data-cover') || img.attr('src') || '';
    let title = stripHtml($el.find('a[href*="/video/"]').first().attr('aria-label') || $el.find('h3').first().text() || img.attr('alt'));
    // aria-label 常带 "-{数字ID}" 后缀，去掉
    title = title.replace(/[-–—\s]*\d{8,}[\s]*$/, '').trim();
    const remarks = stripHtml($el.find('.tp4-duration').first().text());
    if (!title || !id) return;
    list.push({ vod_id: id, vod_name: title, vod_pic: absUrl(pic, base), vod_remarks: remarks });
  });
  return dedupeBy(list, (x) => x.vod_id);
}

function parseCategories(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const seen = new Set(); const out = [];
  $('a[href*="/category/cate"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const m = href.match(/\/category\/(cate\d+)\//i);
    if (!m) return;
    const slug = m[1];
    const name = stripHtml($a.text() || $a.attr('aria-label') || '');
    if (!name || seen.has(slug)) return;
    seen.add(slug);
    out.push({ type_id: slug, type_name: name });
  });
  return out.slice(0, 100);
}

/* ---------------- 封面内联 ---------------- */
async function inlineCover(url) {
  if (!url || !COVER_INLINE || !/^https?:\/\//i.test(url)) return url;
  try {
    const res = await http.get(url, { headers: { 'User-Agent': UA, Referer: `${HOSTS[0]}/` }, responseType: 'arraybuffer', timeout: COVER_TIMEOUT });
    if (res.status !== 200 || !res.data) return url;
    const buf = Buffer.from(res.data);
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return url;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (_) { return url; }
}
async function fillCovers(list) {
  if (!COVER_INLINE || !list || !list.length) return list;
  const copy = list.slice();
  let idx = 0;
  const workers = Array.from({ length: Math.min(COVER_CONCURRENCY, copy.length) }, async () => {
    while (idx < copy.length) {
      const i = idx++;
      copy[i].vod_pic = await inlineCover(copy[i].vod_pic);
    }
  });
  await Promise.all(workers);
  return copy;
}

/* ---------------- 五方法 ---------------- */
async function home() {
  try {
    const html = await fetchText('/');
    const classList = parseCategories(html);
    let list = parseCards(html, HOSTS[0]).slice(0, 60);
    list = await fillCovers(list);
    log('info', `home class=${classList.length} list=${list.length}`);
    return { class: classList, list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: [], list: [] };
  }
}

async function category(params) {
  const p = params || {};
  const slug = String(p.categoryId || p.type_id || p.tid || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!slug) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    // 该站分类多为单页无限列表；page>1 尝试 /category/{slug}/{page}/
    const path = page > 1 ? `/category/${slug}/${page}/` : `/category/${slug}/`;
    const html = await fetchText(path);
    let list = parseCards(html, HOSTS[0]);
    let pagecount = 1;
    if (list.length) {
      try {
        const np = `/category/${slug}/${page + 1}/`;
        if (parseCards(await fetchText(np), HOSTS[0]).length) pagecount = page + 1;
      } catch (_) {}
    }
    list = await fillCovers(list);
    log('info', `category ${slug} page=${page} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    log('error', `category ${slug} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

function parsePlayerConfig(html) {
  const m = html.match(/window\.__ARCHIVE_PLAYER__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
    || html.match(/window\.__ARCHIVE_PLAYER__\s*=\s*(\{[\s\S]*?\})\s*;?/i);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    return o && o.rawPath ? o : null;
  } catch (_) { return null; }
}

async function detail(params) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = p.videoId || p.vod_id || p.id || '';
  let id = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!id) return { list: [] };
  try {
    const wm = id.match(/\/video\/(\d+)\//);
    if (wm) id = wm[1];
    const html = await fetchText(`/video/${id}/`);
    const $ = cheerio.load(html, { decodeEntities: false });

    const ld = (() => {
      try {
        const s = $('script[type="application/ld+json"]').first().html() || '{}';
        const o = JSON.parse(s);
        return o && o.video ? o.video : (o || {});
      } catch (_) { return {}; }
    })();
    let vodName = stripHtml(ld.name || $('h1').first().text() || $('title').first().text().replace(/[-_].*街射.*$/, '').trim());
    const content = stripHtml(ld.description || $('meta[name="description"]').attr('content') || '');
    const poster = (() => {
      const pc = parsePlayerConfig(html);
      return (pc && pc.posterImg) || (ld.thumbnailUrl && ld.thumbnailUrl[0]) || $('img[data-src]').first().attr('data-src') || '';
    })();
    const year = String(ld.uploadDate || '').slice(0, 4);
    const keywords = stripHtml(ld.keywords || '');

    const pc = parsePlayerConfig(html);
    let sources = [];
    if (pc) {
      const m3u8 = `${String(pc.cdnLine || '').replace(/\/+$/, '')}${pc.rawPath}`;
      sources.push({ name: '默认线路', episodes: [{ name: vodName || '正片', playId: m3u8 }] });
      // 多线路：cdn_lines 数组里其余线路
      try {
        const cm = html.match(/var\s+cdn_lines\s*=\s*'([^']+)'/);
        if (cm) {
          const lines = JSON.parse(cm[1]);
          for (const line of lines || []) {
            const cl = String(line.cdnLine || '').replace(/\/+$/, '');
            if (!cl || cl === String(pc.cdnLine || '').replace(/\/+$/, '')) continue;
            sources.push({ name: line.lineName || line.cdnName || '备用线路', episodes: [{ name: vodName || '正片', playId: `${cl}${pc.rawPath}` }] });
          }
        }
      } catch (_) {}
    }
    const playFrom = sources.map((s) => s.name).join('$$$');
    const playUrl = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');
    const finalPic = await inlineCover(absUrl(poster, HOSTS[0]));

    log('info', `detail ${id} title=${vodName} sources=${sources.length}`);
    return {
      list: [{
        vod_id: id, vod_name: vodName, vod_pic: finalPic,
        vod_content: content, vod_year: year, vod_remarks: '',
        vod_play_from: playFrom, vod_play_url: playUrl, vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${id} ${e.message}`);
    return { list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const kw = String(p.keyword || p.wd || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!kw) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const path = page > 1 ? `/search/${encodeURIComponent(kw)}/${page}/` : `/search/${encodeURIComponent(kw)}/`;
    const html = await fetchText(path);
    let list = parseCards(html, HOSTS[0]);
    let pagecount = page;
    if (list.length) {
      try {
        const np = `/search/${encodeURIComponent(kw)}/${page + 1}/`;
        if (parseCards(await fetchText(np), HOSTS[0]).length) pagecount = page + 1;
      } catch (_) {}
    }
    list = await fillCovers(list);
    log('info', `search ${kw} page=${page} list=${list.length}`);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    log('error', `search ${kw} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function play(params) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  let playId = String(p.playId || p.url || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  const header = { 'User-Agent': UA, Referer: `${HOSTS[0]}/` };

  // playId 直接是 m3u8
  if (/\.m3u8(\?|$)/i.test(playId)) {
    log('info', `play direct ${playId.slice(0, 120)}`);
    return { urls: [{ name: '默认线路', url: playId }], flag: 'default', header, parse: 0, danmaku: '' };
  }
  // playId 是数字 ID 或详情链接
  try {
    let id = playId;
    const wm = playId.match(/\/video\/(\d+)\//);
    if (wm) id = wm[1];
    const html = await fetchText(`/video/${id}/`);
    const pc = parsePlayerConfig(html);
    if (!pc || !pc.rawPath) throw new Error('未找到播放配置');
    const url = `${String(pc.cdnLine || '').replace(/\/+$/, '')}${pc.rawPath}`;
    if (!/^https?:\/\//i.test(url)) throw new Error('播放地址无效');
    log('info', `play id=${id} m3u8=${url.slice(0, 120)}`);
    return { urls: [{ name: '默认线路', url }], flag: 'default', header, parse: 0, danmaku: '' };
  } catch (e) {
    log('error', `play ${playId} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
