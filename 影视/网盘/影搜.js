// @name 影搜
// @author 宝宝巴士
// @description 影搜(yingso.fun) 网盘搜索源：逆向 uni-app API（XOR 配置解密 + 动态 body 加密），搜索→getKey→按 root 拼网盘链接；参考网盘目录聚盘搜索成品结构；支持阿里/夸克/迅雷/百度/UC
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/网盘/影搜.js
// @dependencies axios
/**
 * ============ 影搜（yingso.fun）OmniBox 网盘搜索源 ============
 *
 * 【站点事实（2026-11-19 实测逆向）】
 *   uni-app SPA，API 在 ysapi.yingso.fun，全部 POST 有 XOR 加密包装。
 *
 * 【完整链路】
 *  1) GET /test1 → 返回加密串 data
 *     XOR 解密(key="672134612") → {url_version, user_id, start, end, ...}
 *  2) POST /{url_version}/search  body={no,test,info}
 *     · no  = 24 位随机串
 *     · test = {...data, userId}
 *     · info = XOR(JSON.stringify({...data,userId}), no.substring(start,end))
 *     data = {pageSize:30, pageNum:N, title:关键词, root:0, cat:'all', id:''}
 *     ⚠️ cat 必须是 'all'（空串会返回空数据）
 *     → [{id, title, root}]
 *  3) POST /{url_version}/getKey670I23762183
 *     data={id, id2:"132hjshdfuy73y7123ggetKey6703762183dywqgq3t26eg", x1:88位随机串}
 *     → {code:200, data:"短key"}
 *  4) 按 root 拼链接：
 *     1→aliyundrive.com/s/  2→pan.quark.cn/s/  3→pan.xunlei.com/s/
 *     4→pan.baidu.com/s/    5→drive.uc.cn/s/
 *
 * 【返回结构】遵循网盘目录成品（聚盘搜索.js）：
 *   vod_id base64 封 {mode,title,url,id,root,key}
 *   detail 展开网盘目录，play 调 SDK 取直链
 */
const axios = require('axios');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[yingso]';
const BASE = String(process.env.YINGSO_API || 'https://ysapi.yingso.fun').replace(/\/+$/, '');
const UA = String(process.env.YINGSO_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://yingso.fun/';
const XOR_MAIN_KEY = '672134612';
const KEY_ID2 = '132hjshdfuy73y7123ggetKey6703762183dywqgq3t26eg';
const PAGE_SIZE = 30;
const TIMEOUT = Math.max(5000, Number(process.env.YINGSO_TIMEOUT || 15000) || 15000);
const GETKEY_CONCURRENCY = Number(process.env.YINGSO_KEY_CONCURRENCY || 2);

const ROOT_HOSTS = {
  '1': 'https://www.aliyundrive.com/s/',
  '2': 'https://pan.quark.cn/s/',
  '3': 'https://pan.xunlei.com/s/',
  '4': 'https://pan.baidu.com/s/',
  '5': 'https://drive.uc.cn/s/',
};
const ROOT_NAMES = { '1': '阿里云盘', '2': '夸克网盘', '3': '迅雷网盘', '4': '百度网盘', '5': 'UC网盘' };

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {}
}
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return text(v.value || v.name || v.title || v.url || '');
  return String(v).trim();
}
function b64Encode(obj) {
  try { return Buffer.from(JSON.stringify(obj || {}), 'utf8').toString('base64'); }
  catch (_) { return ''; }
}
function b64Decode(str) {
  try { return JSON.parse(Buffer.from(String(str || ''), 'base64').toString('utf8')); }
  catch (_) { return {}; }
}
/** JS String.fromCharCode(charCodeAt ^ ...) 的等价实现（按 UTF-16 码元） */
function xorStr(str, key) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}
function randStr(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ---- 配置（/test1 + XOR 解密），带缓存 ---- */
let CFG = null;
let CFG_AT = 0;
async function getConfig(force) {
  if (!force && CFG && Date.now() - CFG_AT < 30 * 60 * 1000) return CFG;
  try {
    const res = await axios.get(`${BASE}/test1`, {
      timeout: TIMEOUT, headers: { 'User-Agent': UA, Referer: REFERER }, validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data || !res.data.data) throw new Error(`test1 HTTP ${res.status}`);
    const dec = xorStr(String(res.data.data), XOR_MAIN_KEY);
    const cfg = JSON.parse(dec);
    if (!cfg.url_version || !cfg.user_id) throw new Error('配置字段缺失');
    CFG = cfg; CFG_AT = Date.now();
    log('info', `配置就绪 ver=${cfg.url_version} start=${cfg.start} end=${cfg.end}`);
    return cfg;
  } catch (e) { log('error', `getConfig ${e.message}`); throw e; }
}

/** 构造 uni-app POST 加密 body（与站点 request.js 完全一致） */
function buildBody(cfg, data) {
  const no = randStr(24);
  const d = Object.assign({}, data, { userId: cfg.user_id });
  const subKey = no.substring(Number(cfg.start), Number(cfg.end));
  return { no, test: d, info: xorStr(JSON.stringify(d), subKey) };
}

async function postApi(path, cfg, data) {
  const body = buildBody(cfg, data);
  const res = await axios.post(`${BASE}/${cfg.url_version}/${path}`, body, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, Referer: REFERER, Origin: 'https://yingso.fun', 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} @ ${path}`);
  let out = res.data;
  if (typeof out === 'string') { try { out = JSON.parse(out); } catch (_) {} }
  return out;
}

/** 搜索接口：返回 [{id,title,root}] */
async function apiSearch(keyword, page) {
  let cfg = await getConfig(false);
  let res = await postApi('search', cfg, {
    pageSize: PAGE_SIZE, pageNum: page, title: keyword, root: 0, cat: 'all', id: '',
  });
  if (!res || !Array.isArray(res.data)) {
    cfg = await getConfig(true);
    res = await postApi('search', cfg, {
      pageSize: PAGE_SIZE, pageNum: page, title: keyword, root: 0, cat: 'all', id: '',
    });
  }
  if (!res || res.code !== 200 || !Array.isArray(res.data)) return [];
  return res.data;
}

/** getKey：id → 短 key */
async function apiGetKey(cfg, id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await postApi('getKey670I23762183', cfg, {
        id, id2: KEY_ID2, x1: randStr(88),
      });
      if (res && res.code === 200 && res.data) return text(res.data);
    } catch (_) {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
  }
  return '';
}

function buildShareUrl(root, key) {
  const host = ROOT_HOSTS[String(root)] || ROOT_HOSTS['2'];
  return key ? `${host}${key}` : '';
}
function driveName(root) { return ROOT_NAMES[String(root)] || '网盘'; }

function isVideoFile(name) {
  return /\.(mp4|mkv|avi|mov|rmvb|wmv|flv|ts|m3u8|webm|mpg|mpeg|rm|3gp|m4v)(?:\?|$)/i.test(text(name));
}

async function collectVideos(shareURL, files) {
  const out = [];
  const stack = [...(files || [])].map((f) => ({ f, d: 0 }));
  const seen = new Set();
  while (stack.length) {
    const { f, d } = stack.shift();
    if (!f) continue;
    const fid = text(f.fid || f.file_id || '');
    const name = text(f.file_name || f.name || f.fileName || '');
    const isDir = Number(f.is_dir ?? f.isDir ?? 0) === 1 || /folder|dir/i.test(text(f.type || ''));
    if (isDir && d < 6 && fid) {
      if (seen.has(fid)) continue;
      seen.add(fid);
      try {
        const sub = await OmniBox.getDriveFileList(shareURL, fid);
        for (const c of ((sub && sub.files) || [])) stack.push({ f: c, d: d + 1 });
      } catch (_) {}
    } else if (isVideoFile(name)) {
      out.push({ fid, name, size: f.size || 0 });
    }
  }
  return out;
}

/* ---------------- 五方法 ---------------- */
const PAN_LINES = [
  { id: 'all', name: '全部网盘' },
  { id: '2', name: '夸克网盘' },
  { id: '4', name: '百度网盘' },
  { id: '1', name: '阿里云盘' },
  { id: '3', name: '迅雷网盘' },
  { id: '5', name: 'UC网盘' },
];

/** 结果项 → 带真实链接（批量 getKey，限并发） */
async function hydrateItems(rawItems) {
  const cfg = await getConfig(false);
  const results = new Array(rawItems.length).fill(null);
  let idx = 0;
  const workers = Array.from({ length: Math.min(GETKEY_CONCURRENCY, rawItems.length) }, async () => {
    while (idx < rawItems.length) {
      const i = idx++;
      const it = rawItems[i];
      await new Promise((r) => setTimeout(r, 120));
      try {
        const key = await apiGetKey(cfg, it.id);
        results[i] = { ...it, key, url: buildShareUrl(it.root, key) };
      } catch (e) {
        results[i] = { ...it, key: '', url: '' };
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

function toVodItem(it) {
  return {
    vod_id: b64Encode({ mode: 'share', title: it.title, url: it.url, id: it.id, root: it.root, key: it.key }),
    vod_name: it.title,
    vod_pic: '',
    vod_remarks: `${driveName(it.root)} | ${it.key ? '有效链接' : '待获取'}`,
  };
}

async function home() {
  return { class: PAN_LINES.map((p) => ({ type_id: p.id, type_name: p.name })), list: [] };
}

async function category(params) {
  const p = params || {};
  const cid = String(p.categoryId || p.type_id || 'all').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  try {
    let raw = await apiSearch(String(p.keyword || '电影').trim() || '电影', page);
    if (cid !== 'all') raw = raw.filter((x) => String(x.root) === cid);
    const items = await hydrateItems(raw);
    const list = items.map(toVodItem).filter((x) => x.vod_name);
    log('info', `category ${cid} list=${list.length}`);
    return { page, pagecount: raw.length >= PAGE_SIZE ? page + 1 : page, total: list.length, limit: list.length, list };
  } catch (e) {
    log('error', `category ${cid} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const keyword = String(p.keyword || p.wd || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!keyword) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    const raw = await apiSearch(keyword, page);
    const items = await hydrateItems(raw);
    const list = items.map(toVodItem).filter((x) => x.vod_name && x.vod_id);
    log('info', `search "${keyword}" raw=${raw.length} list=${list.length}`);
    return { page, pagecount: raw.length >= PAGE_SIZE ? page + 1 : page, total: list.length, limit: list.length, list };
  } catch (e) {
    log('error', `search "${keyword}" ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const vodId = String(p.videoId || p.vod_id || p.id || '').trim();
  if (!vodId) return { list: [] };
  try {
    const meta = b64Decode(vodId);
    const title = text(meta.title) || '网盘资源';
    let shareURL = text(meta.url);
    if (!shareURL && meta.id && meta.root) {
      const cfg = await getConfig(false);
      const key = await apiGetKey(cfg, meta.id);
      shareURL = buildShareUrl(meta.root, key);
    }
    if (!shareURL) { log('warn', `detail 无链接 ${vodId}`); return { list: [] }; }
    const drive = driveName(meta.root);

    let videoFiles = [];
    try {
      const root = await OmniBox.getDriveFileList(shareURL, '0');
      videoFiles = await collectVideos(shareURL, (root && root.files) || []);
    } catch (e) { log('warn', `目录展开失败: ${e.message}`); }

    // 刮削（失败不影响主链路）
    let scrapeData = null;
    const mappingMap = new Map();
    if (videoFiles.length) {
      try {
        const rid = `${shareURL}|${title}`;
        const candidates = videoFiles.map((f) => ({
          fid: `${shareURL}|${f.fid}`, file_id: `${shareURL}|${f.fid}`, file_name: f.name, name: f.name, format_type: 'video',
        }));
        await OmniBox.processScraping(rid, title, title, candidates);
        const md = await OmniBox.getScrapeMetadata(rid);
        scrapeData = (md && md.scrapeData) || null;
        for (const m of ((md && md.videoMappings) || [])) if (m && m.fileId) mappingMap.set(String(m.fileId), m);
      } catch (_) {}
    }
    const pick = (k) => { const v = scrapeData && (scrapeData[k] || scrapeData[k.replace(/^vod_/, '')]); return v ? text(v) : ''; };

    const episodes = (videoFiles.length ? videoFiles : [{ fid: '0', name: title }]).map((f) => {
      const mk = `${shareURL}|${f.fid}`;
      const mp = mappingMap.get(mk);
      return {
        name: (mp && (mp.episodeName || mp.name)) ? text(mp.episodeName || mp.name) : f.name,
        playId: b64Encode({ mode: 'play', shareURL, fid: f.fid, name: f.name, title }),
      };
    });
    const sources = [{ name: drive, episodes }];
    const playFrom = sources.map((s) => s.name).join('$$$');
    const playUrl = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');

    log('info', `detail ${title} drive=${drive} files=${videoFiles.length}`);
    return {
      list: [{
        vod_id: vodId,
        vod_name: pick('vod_name') || title,
        vod_pic: pick('vod_pic') || '',
        vod_content: pick('vod_content') || '',
        vod_actor: pick('vod_actor') || '',
        vod_director: pick('vod_director') || '',
        vod_year: pick('vod_year') || '',
        vod_remarks: `${drive} | ${videoFiles.length || 1}个文件`,
        vod_play_from: playFrom,
        vod_play_url: playUrl,
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${vodId} ${e.message}`);
    return { list: [] };
  }
}

async function play(params) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  const playId = String(p.playId || p.url || '').trim();
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  try {
    const meta = b64Decode(playId);
    const shareURL = text(meta.shareURL || meta.url);
    const fid = text(meta.fid || '0');
    if (!shareURL) throw new Error('缺少分享链接');
    const info = await OmniBox.getDriveVideoPlayInfo(shareURL, fid, '');
    const urls = [];
    if (Array.isArray(info?.url)) {
      for (const u of info.url) if (u && u.url) urls.push({ name: text(u.name || text(meta.name) || '播放'), url: text(u.url) });
    } else if (typeof info?.url === 'string' && info.url) {
      urls.push({ name: text(meta.name) || '播放', url: info.url });
    }
    if (!urls.length) throw new Error('未获取到播放地址');
    log('info', `play ${text(meta.name)} urls=${urls.length}`);
    return { urls, flag: 'default', header: { 'User-Agent': UA, Referer: REFERER }, parse: 0, danmaku: '' };
  } catch (e) {
    log('error', `play ${playId.slice(0, 40)} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
