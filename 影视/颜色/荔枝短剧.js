// @name 荔枝短剧
// @author 宝宝巴士
// @description 荔枝短剧(liz04.com，发布页 /road/)：Nuxt SSR + /api/v1 JSON API；首页/分类/搜索/详情/播放；播放接口直接返回签名 m3u8；封面 AES-128-CBC 解密内联；多域名轮换兜底
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/荔枝短剧.js
// @dependencies axios,cheerio,crypto
/**
 * ============ 荔枝短剧（liz04.com）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-19 实测）】
 *   Nuxt SSR 站，配置在 window.__NUXT__.config.public 里：
 *     apiBase  = https://liz01.com   （真实 API 域名）
 *     imageAesKeyHex / imageAesIvHex = 封面 AES 密钥
 *     hlsKeyOrigins = 播放 key 域名
 *   发布页 https://liz04.com/road/ 给多个入口域名（liz01/002/003/004.com）。
 *
 * 【API（均 GET，返回 {success,code,data}）】
 *   /api/v1/homepage                    首页 banners/topics/categories
 *   /api/v1/drama/list?keyword=&categoryId=&page=&size=   列表/分类/搜索
 *   /api/v1/category/tree               分类树（3 级）
 *   /api/v1/drama/{id}                  详情（分集列表）
 *   /api/v1/drama/{id}/ep/{n}           单集：playbackUrl(签名 m3u8 相对路径)
 *
 * 【封面】images.xnimageservice.com 返回 AES-128-CBC 密文，用 config 的 key/iv 解密。
 * 【播放】playbackUrl 拼 apiBase 即 m3u8 直链（实测 200 标准 HLS）。
 */
const axios = require('axios');
const crypto = require('crypto');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[lizhi]';
const UA = String(process.env.LIZ_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_BASES = String(process.env.LIZ_API_BASES || 'https://liz01.com,https://liz02.com,https://liz03.com,https://liz04.com')
  .split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
const PAGE_SIZE = Math.max(10, Math.min(60, Number(process.env.LIZ_PAGE_SIZE || 30) || 30));
const TIMEOUT = Math.max(5000, Number(process.env.LIZ_TIMEOUT || 15000) || 15000);
const COVER_INLINE = process.env.LIZ_COVER_INLINE !== '0';
// 封面 AES（config: imageAesKeyHex / imageAesIvHex）
const COVER_KEY = Buffer.from(String(process.env.LIZ_COVER_KEY || 'ea19c21e85d768da4165f5964ab886b2'), 'hex');
const COVER_IV = Buffer.from(String(process.env.LIZ_COVER_IV || 'f4d53ecbc273901e0d9cd7848233c702'), 'hex');

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {}
}
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.name || v.title || v.value || '').trim();
  return String(v).trim();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 带域名轮换的 GET（API_BASES 逐个尝试） */
async function apiGet(path, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const full = path + (qs ? (path.includes('?') ? '&' : '?') + qs : '');
  let lastErr = null;
  for (const base of API_BASES) {
    try {
      const url = /^https?:\/\//i.test(full) ? full : `${base}${full}`;
      const res = await axios.get(url, {
        timeout: TIMEOUT, validateStatus: () => true,
        headers: { 'User-Agent': UA, Referer: `${API_BASES[0]}/`, Accept: 'application/json' },
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      if (json && json.success && json.code === '000000') return json.data;
      throw new Error(`API code=${json && json.code}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('API 请求失败');
}

function absUrl(u, base) {
  const v = String(u || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  return `${base || API_BASES[0]}${v.startsWith('/') ? '' : '/'}${v}`;
}

/** 封面：AES 密文解密成 data:image/jpeg;base64；明文直连 */
async function resolveCover(url) {
  const u = String(url || '').trim();
  if (!u || !COVER_INLINE || !/^https?:\/\//i.test(u)) return u;
  try {
    const base = API_BASES[0];
    const res = await axios.get(u, {
      timeout: 8000, responseType: 'arraybuffer', validateStatus: () => true,
      headers: { 'User-Agent': UA, Referer: `${base}/` },
    });
    if (res.status !== 200 || !res.data) return u;
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
    if (buf[0] === 0xff && buf[1] === 0xd8) return u; // 已是明文 JPEG
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

function toVod(item, base) {
  return {
    vod_id: String(item.id || ''),
    vod_name: text(item.title),
    vod_pic: text(item.coverUrl),
    vod_remarks: [
      item.totalEpisodes ? `${item.totalEpisodes}集` : '',
      item.displayViewText ? item.displayViewText : '',
      Array.isArray(item.tags) ? item.tags.slice(0, 2).map((x) => text(x.name)).join('/') : '',
    ].filter(Boolean).join(' | '),
    vod_content: text(item.description),
  };
}

/* ---------------- 五方法 ---------------- */
async function home() {
  try {
    const data = await apiGet('/api/v1/homepage');
    const hp = data.homepage || data;
    const classes = [];
    // 分类取 category tree 的三级叶子，扁平展示
    try {
      const tree = await apiGet('/api/v1/category/tree');
      const walk = (nodes, parentName) => {
        for (const n of nodes || []) {
          const kids = n.children || [];
          if (!kids.length) classes.push({ type_id: String(n.id), type_name: text(n.categoryName) });
          else walk(kids, text(n.categoryName));
        }
      };
      walk(tree);
    } catch (_) {}
    const dramas = [];
    const seen = new Set();
    for (const topic of (hp.topics || [])) {
      for (const d of (topic.dramas || [])) {
        if (!d || seen.has(String(d.id))) continue;
        seen.add(String(d.id));
        dramas.push(toVod(d, API_BASES[0]));
        if (dramas.length >= 60) break;
      }
      if (dramas.length >= 60) break;
    }
    // 封面内联（限前 12 张，避免首页太慢）
    const inlineCount = Math.min(12, dramas.length);
    for (let i = 0; i < inlineCount; i++) dramas[i].vod_pic = await resolveCover(dramas[i].vod_pic);
    log('info', `home classes=${classes.length} list=${dramas.length}`);
    return { class: classes, list: dramas };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: [], list: [] };
  }
}

async function category(params) {
  const p = params || {};
  const cid = String(p.categoryId || p.type_id || p.tid || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!cid) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const data = await apiGet('/api/v1/drama/list', { categoryId: cid, page, size: PAGE_SIZE });
    const pg = (data && data.page) || {};
    const list = (pg.items || []).map((x) => toVod(x, API_BASES[0]));
    const total = Number(pg.total) || 0;
    log('info', `category ${cid} page=${page} list=${list.length} total=${total}`);
    return { page, pagecount: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, limit: list.length, list };
  } catch (e) {
    log('error', `category ${cid} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const kw = String(p.keyword || p.wd || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!kw) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const data = await apiGet('/api/v1/drama/list', { keyword: kw, page, size: PAGE_SIZE });
    const pg = (data && data.page) || {};
    const list = (pg.items || []).map((x) => toVod(x, API_BASES[0]));
    const total = Number(pg.total) || 0;
    log('info', `search "${kw}" list=${list.length} total=${total}`);
    return { page, pagecount: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, limit: list.length, list };
  } catch (e) {
    log('error', `search "${kw}" ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = p.videoId || p.vod_id || p.id || '';
  const id = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!id) return { list: [] };
  try {
    const data = await apiGet(`/api/v1/drama/${id}`);
    const d = data || {};
    const episodes = [];
    const total = Number(d.totalEpisodes) || 0;
    for (let n = 1; n <= total; n++) {
      episodes.push({ name: `第${n}集`, playId: `${id}|${n}` });
    }
    if (!episodes.length) episodes.push({ name: '正片', playId: `${id}|1` });
    const sources = [{ name: '默认线路', episodes }];
    const playFrom = sources.map((s) => s.name).join('$$$');
    const playUrl = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');
    const pic = await resolveCover(text(d.coverUrl));
    const tags = Array.isArray(d.tags) ? d.tags.map((x) => text(x.name)).join(' ') : '';
    log('info', `detail ${id} title=${text(d.title)} episodes=${episodes.length}`);
    return {
      list: [{
        vod_id: id,
        vod_name: text(d.title),
        vod_pic: pic,
        vod_content: text(d.description),
        vod_remarks: `${total}集 ${tags}`,
        vod_play_from: playFrom,
        vod_play_url: playUrl,
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${id} ${e.message}`);
    return { list: [] };
  }
}

async function play(params) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  const playId = String(p.playId || p.url || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  try {
    let id, ep;
    const m = playId.match(/^(\d+)\|(\d+)$/);
    if (m) { id = m[1]; ep = m[2]; }
    else {
      const wm = playId.match(/\/drama\/(\d+)\/ep-(\d+)/);
      if (wm) { id = wm[1]; ep = wm[2]; }
      else if (/^\d+$/.test(playId)) { id = playId; ep = '1'; }
      else throw new Error('无效 playId');
    }
    const data = await apiGet(`/api/v1/drama/${id}/ep/${ep}`);
    const playbackUrl = text(data.playbackUrl);
    if (!playbackUrl) throw new Error('无 playbackUrl');
    const url = absUrl(playbackUrl, API_BASES[0]);
    log('info', `play ${id}-${ep} m3u8=${url.slice(0, 120)}`);
    return {
      urls: [{ name: `${ep}集`, url }],
      flag: 'default',
      header: { 'User-Agent': UA, Referer: `${API_BASES[0]}/` },
      parse: 0,
      danmaku: '',
    };
  } catch (e) {
    log('error', `play ${playId} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
