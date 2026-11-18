// @name AVJiali镜像
// @author 宝宝巴士
// @description AVJiali(avjiali3.wiki)：tp4 模板，首页/13 大类二级分类/搜索/详情/播放；播放从 window.__ARCHIVE_PLAYER__(cdnLine+rawPath) 取 m3u8；237 个原始分类归并为 13 大类；封面内联 data:image；双 IP 轮换兜底
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/AVJiali镜像.js
// @dependencies axios,cheerio
/**
 * ============ AVJiali（avjiali3.wiki）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-18 实测）】
 *   与「街射」同款 tp4 模板，独立品牌 AVJiali（女神反差片源合集）。
 *   nginx，无 Cloudflare；DNS 轮询两个 IP，其中一个常返回 500，
 *   需靠轮换 + 重试兜底（脚本已内置）。
 *
 * 【路由】
 *   首页：/                      419 个 /video/{id}/ 卡片
 *   分类：/category/cate{N}/     237 个原始分类
 *   详情：/video/{数字ID}/
 *   搜索：/search/{关键词}/
 *
 * 【卡片】
 *   <li class="tp4-section-content__item">
 *     <a href="/video/{id}/" aria-label="标题">
 *       <img data-src="封面">
 *       <div class="tp4-duration">07:42</div>
 *       <h3 class="text-truncate">标题</h3>
 *
 * 【播放（关键）】
 *   详情页内联：
 *     window.__ARCHIVE_PLAYER__ = {rawPath:"/video/.../xxx.m3u8",
 *       cdnLine:"https://fgds54gg.sxtmo.com", posterImg, ...}
 *   m3u8 = cdnLine + rawPath（无需签名，实测 200）
 *   另有多线路 cdn_lines 数组可切换。
 *
 * 【封面】
 *   图床 sxtmo.com 返回真实 JPEG/WebP 但 content-type 异常，
 *   脚本内联成 data:image/* 确保渲染。
 *
 * 【二级分类】
 *   237 个扁平分类（人物名/传媒名/探花/制服…）归并为 13 大类，
 *   子分类通过 filters 暴露。
 * ==================================================================== */
const axios = require('axios');
const cheerio = require('cheerio');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[avjiali]';
const UA = String(process.env.AVJ_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOSTS = String(process.env.AVJ_HOSTS || 'https://avjiali3.wiki').split(',')
  .map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
const COVER_INLINE = process.env.AVJ_COVER_INLINE !== '0';
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

/* ---- 全局限速：站点对并发很敏感，>4 并发就开始 429 ---- */
let RATE_CHAIN = Promise.resolve();
function rateLimit(ms = 220) {
  RATE_CHAIN = RATE_CHAIN.then(() => new Promise((r) => setTimeout(r, ms))).catch(() => {});
  return RATE_CHAIN;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, options = {}) {
  const maxRetry = Number(options.retry ?? 3);
  let lastErr = null;
  for (const host of HOSTS) {
    const full = /^https?:\/\//i.test(url) ? url : `${host}${url}`;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        await rateLimit(options.rateGap ?? 220);
        const res = await http.get(full, {
          headers: { Referer: `${host}/`, ...(options.headers || {}) },
          responseType: 'text',
        });
        // 429 限流：指数退避重试
        if (res.status === 429) {
          lastErr = new Error('HTTP 429');
          if (attempt >= maxRetry) break;
          const wait = 800 * Math.pow(2, attempt);
          log('info', `429 限流，等待 ${wait}ms 重试(${attempt + 1}/${maxRetry}) ${full.slice(0, 70)}`);
          await sleep(wait);
          continue;
        }
        if (res.status >= 500 && attempt < maxRetry) {
          await sleep(500 * (attempt + 1));
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetry && !/HTTP 4\d\d/.test(String(e.message))) { await sleep(400 * (attempt + 1)); continue; }
        break;
      }
    }
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

/**
 * 二级分类：站点有 90+ 个扁平分类（动漫*、*传媒、乱伦*…），
 * 直接铺在 class 里会让分类栏又长又乱。
 * 这里归并成 10 个大类，子分类通过 filters 暴露：
 *   class   = 大类（type_id = group:xxx）
 *   filters = { "group:xxx": [{ key:"sub", name:"子分类", value:[{name,value:cateN}] }] }
 *   category() 读到 filters.sub 就请求对应 cateN。
 */
const CATEGORY_GROUPS = [
  // 数组顺序 = 展示顺序；catchAll 组只收未被其它组命中的分类
  { id: 'group:girl',     name: '网红福利', catchAll: true },
  { id: 'group:media',    name: '传媒',     pattern: /传媒|傳媒|影业|制片厂|OnlyFans|乌托邦|性视界|Vlog|萝莉社|杏吧|兔子先生|香蕉视频|葫芦/i },
  { id: 'group:tanhua',   name: '探花',     pattern: /探花|寻花|先生|大神|千人斩|按摩会所|嫖妓|保健室/i },
  { id: 'group:amateur',  name: '素人自拍', pattern: /大瓜|猛料|泄密|吃瓜|潜规则|反差泄露|裸贷|独家|自拍|投稿/i },
  { id: 'group:incest',   name: '乱伦',     pattern: /兄妹|岳母|儿媳|父女|侄女|师生|母子|姐弟|嫂子|小姨子|乱伦/i },
  { id: 'group:hardcore', name: '重口',     pattern: /迷奸|强暴|轮奸|群交|淫交|多P|药物|滥交/i },
  { id: 'group:live',     name: '直播主播', pattern: /主播|直播|抖音|快手|车震/i },
  { id: 'group:costume',  name: '制服',     pattern: /制服|空姐诱惑|丝袜诱惑|职场OL|清涩校服|三点泳装|JK短裙|女仆装|护士打针|国风旗袍|体操运动|古装诱惑|萝莉塔/i },
  { id: 'group:asia',     name: '亚洲三级', pattern: /韩国三级|香港三级|台湾三级|日本三级|韩国|台湾|香港/i },
  { id: 'group:jpav',     name: '日本AV',   pattern: /日本|FC2|骑兵|高清优质|VR视觉|人妻巨乳|筱田|森澤|三上|神宮寺|藤森|松本一香|乙爱丽丝|沙月|姬咲|佐山|Akiho|AliceOtsu|少女制服/i },
  { id: 'group:western',  name: '欧美',     pattern: /欧美|欧洲|俄乌|美国|洋马|AngelX|Sweetie|Morgpie|DianRider|BadCute|Ailish|Samantha|黑人大屌|捷克|越南|印度|东南亚|情色/i },
  { id: 'group:variety',  name: '综艺教学', pattern: /综艺|教学|两性|训练营|奇啪|自修室|体育祭|屁孩日记|性趣|蜜桃说|大秀|k歌/i },
  { id: 'group:movie',    name: '影视片',   pattern: /喜剧片|古装片|武侠片|枪战片|灾难片|冒险片|犯罪片|科幻片|动作片|恐怖片/i },
];

/** 抓站点真实分类（cateN -> 名称） */
function parseRawCategories(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const seen = new Set(); const out = [];
  $('a[href*="/category/cate"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const m = href.match(/\/category\/(cate\d+)\//i);
    if (!m) return;
    const slug = m[1];
    const name = stripHtml($a.text() || $a.attr('aria-label') || '');
    // 过滤导航噪音：全部/更多/展开 等不是真实分类
    if (!name || /^(全部|更多|展开|收起|查看更多|首页)$/.test(name) || seen.has(slug)) return;
    seen.add(slug);
    out.push({ type_id: slug, type_name: name });
  });
  return out;
}

/** 把真实分类归并进大类，产出 class + filters */
function buildGroupedCategories(rawList) {
  const buckets = new Map(CATEGORY_GROUPS.map((g) => [g.id, []]));
  const catchAll = CATEGORY_GROUPS.find((g) => g.catchAll) || null;
  const matchers = CATEGORY_GROUPS.filter((g) => !g.catchAll);
  for (const item of rawList || []) {
    const nm = String(item.type_name || '');
    let g = matchers.find((x) => x.pattern && x.pattern.test(nm)) || catchAll;
    if (!g) continue;
    buckets.get(g.id).push(item);
  }
  const classList = [];
  const filters = {};
  for (const g of CATEGORY_GROUPS) {
    const items = buckets.get(g.id) || [];
    if (!items.length) continue;
    classList.push({ type_id: g.id, type_name: g.name });
    filters[g.id] = [{
      key: 'sub',
      name: '子分类',
      init: '',
      value: [{ name: '全部', value: '' }, ...items.map((x) => ({ name: x.type_name, value: x.type_id }))],
    }];
  }
  return { classList, filters };
}

/** 兼容旧调用名 */
function parseCategories(html) {
  return buildGroupedCategories(parseRawCategories(html)).classList;
}

/** 站点原始分类缓存（合并大类时避免反复抓首页） */
let RAW_CATS_CACHE = null;
let RAW_CATS_AT = 0;
async function getRawCategoriesCached() {
  if (RAW_CATS_CACHE && Date.now() - RAW_CATS_AT < 10 * 60 * 1000) return RAW_CATS_CACHE;
  try {
    const cats = parseRawCategories(await fetchText('/'));
    if (cats.length) { RAW_CATS_CACHE = cats; RAW_CATS_AT = Date.now(); }
    return cats;
  } catch (_) { return RAW_CATS_CACHE || []; }
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
    const rawCats = parseRawCategories(html);
    const { classList, filters } = buildGroupedCategories(rawCats);
    let list = parseCards(html, HOSTS[0]).slice(0, 60);
    list = await fillCovers(list);
    log('info', `home 大类=${classList.length} 原始分类=${rawCats.length} list=${list.length}`);
    return { class: classList, filters, list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: [], filters: {}, list: [] };
  }
}

/** 从 params 各兼容字段里取出子分类 slug */
function pickSubCategory(params) {
  const p = params || {};
  const cands = [p.filters, p.extend, p.ext, p.filter];
  for (const c of cands) {
    if (!c) continue;
    let v = null;
    if (typeof c === 'string') { try { v = JSON.parse(c); } catch (_) { v = null; } }
    else if (typeof c === 'object') v = c;
    if (!v) continue;
    const sub = v.sub ?? v['子分类'] ?? v.subclass ?? v.class ?? v.cate;
    const s = String(Array.isArray(sub) ? (sub[0] || '') : (sub || '')).trim();
    if (/^cate\d+$/i.test(s)) return s;
  }
  return '';
}

/** 大类合并结果缓存：同一大类 10 分钟内直接复用，避免重复扫 15 个子分类 */
const GROUP_MERGE_CACHE = new Map();
const GROUP_MERGE_TTL = 10 * 60 * 1000;

async function category(params) {
  const p = params || {};
  const cid = String(p.categoryId || p.type_id || p.tid || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!cid) return { page, pagecount: 0, total: 0, limit: 0, list: [] };

  // 大类 + 选了子分类 → 直接打子分类；没选则合并该大类下所有子分类
  const isGroup = /^group:/i.test(cid);
  const sub = pickSubCategory(p);

  try {
    let list = [];
    let pagecount = 1;

    if (sub) {
      const path = page > 1 ? `/category/${sub}/${page}/` : `/category/${sub}/`;
      let html = '';
      try { html = await fetchText(path); }
      catch (e) {
        log('info', `子分类 ${sub} 失败(${e.message})，回退大类合并`);
        html = '';
      }
      list = html ? parseCards(html, HOSTS[0]) : [];
      if (list.length) {
        try {
          const np = `/category/${sub}/${page + 1}/`;
          if (parseCards(await fetchText(np), HOSTS[0]).length) pagecount = page + 1;
        } catch (_) {}
      }
      log('info', `category ${cid} sub=${sub} page=${page} list=${list.length}`);
    } else if (isGroup) {
      // 合并大类下所有子分类（并发抓第一页）
      const cachedMerge = GROUP_MERGE_CACHE.get(cid);
      if (cachedMerge && Date.now() - cachedMerge.at < GROUP_MERGE_TTL) {
        log('info', `category ${cid} 命中合并缓存 list=${cachedMerge.list.length}`);
        return { page, pagecount: 1, total: cachedMerge.list.length, limit: cachedMerge.list.length, list: cachedMerge.list };
      }
      const grp = CATEGORY_GROUPS.find((g) => g.id === cid);
      const allCats = await getRawCategoriesCached();
      const members = (allCats || []).filter((x) => (grp ? grp.pattern.test(x.type_name) : false));
      const targets = (members.length ? members : allCats).map((x) => x.type_id);
      const seen = new Set();
      let ok = 0;
      // 顺序抓取 + 全局限速，避免 429；命中缓存则很快
      for (const c of targets) {
        try {
          const html = await fetchText(`/category/${c}/`);
          ok++;
          for (const it of parseCards(html, HOSTS[0])) {
            if (seen.has(it.vod_id)) continue;
            seen.add(it.vod_id);
            list.push(it);
          }
        } catch (e) {
          log('info', `子分类 ${c} 跳过: ${e.message}`);
        }
      }
      log('info', `category ${cid} 合并 ${ok}/${targets.length} 个子分类 list=${list.length}`);
      if (list.length) GROUP_MERGE_CACHE.set(cid, { at: Date.now(), list: list.slice() });
    } else {
      const path = page > 1 ? `/category/${cid}/${page}/` : `/category/${cid}/`;
      const html = await fetchText(path);
      list = parseCards(html, HOSTS[0]);
      if (list.length) {
        try {
          const np = `/category/${cid}/${page + 1}/`;
          if (parseCards(await fetchText(np), HOSTS[0]).length) pagecount = page + 1;
        } catch (_) {}
      }
      log('info', `category ${cid} page=${page} list=${list.length}`);
    }

    list = await fillCovers(list);
    return { page, pagecount, total: pagecount * list.length, limit: list.length, list };
  } catch (e) {
    log('error', `category ${cid} ${e.message}`);
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
    let vodName = stripHtml(ld.name || $('h1').first().text() || $('title').first().text().replace(/[-_].*AVJiali.*$/, '').trim());
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
