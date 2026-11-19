// @name 全盘搜索
// @author 宝宝巴士
// @description 全盘搜索(quanpan.xyz) 网盘搜索源：token 鉴权 + POST /api/search，按网盘类型分组；支持百度/夸克/阿里/UC/迅雷/115/123/天翼/磁力等；参考网盘目录聚盘搜索成品结构；统一 DRIVE_TYPE_CONFIG/SOURCE_NAMES_CONFIG/DRIVE_ORDER 分号分割环境变量
// @version 1.0.2
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/网盘/全盘搜索.js
// @dependencies axios
/**
 * ============ 全盘搜索（quanpan.xyz）OmniBox 网盘搜索源 ============
 *
 * 【站点事实（2026-11-19 实测）】
 *   全盘搜索 - 聚合网盘资源搜索，传统 SSR + 原生 fetch，nginx。
 *   站点会间歇性 TLS 中断，脚本内置重试。
 *
 * 【链路】
 *  1) GET /api/auth/token → {code:0, data:{token, ttl_ms}}
 *  2) POST /api/search  header X-QP-K=token
 *     body {kw:关键词, res:"merge", src:"all"}
 *     → {code:0, data:{total, merged_by_type:{
 *         "quark":[{url, password, note, datetime}], "baidu":[...], ...
 *       }}}
 *  3) 每条直接是网盘分享链接（无加密/无二次解密），password 是提取码
 *
 * 【网盘类型】baidu/quark/uc/xunlei/aliyun/tianyi/115/123/guangya/mobile/magnet/ed2k/others
 *
 * 【返回结构】遵循网盘目录成品（聚盘搜索.js）：
 *   home=网盘线路，search=资源列表，detail=展开网盘目录，play=SDK 取直链
 */
const axios = require('axios');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[quanpan]';
const BASE = String(process.env.QP_HOST || 'https://quanpan.xyz').replace(/\/+$/, '');
const UA = String(process.env.QP_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = Math.max(5000, Number(process.env.QP_TIMEOUT || 15000) || 15000);
const RETRY = 4;
const SEARCH_LIMIT = Math.max(10, Math.min(200, Number(process.env.QP_LIMIT || 60) || 60));

// 网盘类型 → 名称
const PAN_NAMES = {
  baidu: '百度网盘', quark: '夸克网盘', uc: 'UC网盘', xunlei: '迅雷网盘',
  aliyun: '阿里云盘', tianyi: '天翼云盘', '115': '115网盘', '123': '123网盘',
  guangya: '光鸭云盘', mobile: '移动云盘', pikpak: 'PikPak', magnet: '磁力链接',
  ed2k: '电驴链接', others: '其它', other: '其它',
};

/* ---------------- 与其它网盘脚本统一的环境变量（分号分割） ---------------- */
function splitConfigList(value) {
  return String(value || '').replace(/,/g, ';').split(';').map((s) => s.trim()).filter(Boolean);
}
// 读取环境变量:支持多个网盘类型,用分号分割；命中的网盘会展开为多条代理线路
const DRIVE_TYPE_CONFIG = splitConfigList(process.env.DRIVE_TYPE_CONFIG || 'quark;uc');
// 读取环境变量:线路名称和顺序,用分号分割
const SOURCE_NAMES_CONFIG = splitConfigList(process.env.SOURCE_NAMES_CONFIG || '本地代理;服务端代理;直连');
// 详情页播放线路的网盘排序顺序（仅作用于 detail 的线路，不作用于搜索结果）
const DRIVE_ORDER = splitConfigList(process.env.DRIVE_ORDER || 'baidu;tianyi;quark;uc;115;xunlei;ali;123pan').map((s) => s.toLowerCase());

/** 从线路名推断网盘类型（用于 DRIVE_ORDER 排序） */
function inferDriveTypeFromSourceName(name) {
  const raw = String(name || '').toLowerCase();
  if (raw.includes('百度')) return 'baidu';
  if (raw.includes('夸克')) return 'quark';
  if (raw.includes('阿里')) return 'ali';
  if (raw.includes('天翼')) return 'tianyi';
  if (raw.includes('迅雷')) return 'xunlei';
  if (raw.includes('115')) return '115';
  if (raw.includes('123')) return '123pan';
  if (raw.includes('uc')) return 'uc';
  return raw;
}
function sortPlaySourcesByDriveOrder(playSources = []) {
  if (!Array.isArray(playSources) || playSources.length <= 1 || DRIVE_ORDER.length === 0) return playSources;
  const orderMap = new Map(DRIVE_ORDER.map((name, index) => [name, index]));
  return [...playSources].sort((a, b) => {
    const aOrder = orderMap.has(inferDriveTypeFromSourceName(a?.name)) ? orderMap.get(inferDriveTypeFromSourceName(a?.name)) : Number.MAX_SAFE_INTEGER;
    const bOrder = orderMap.has(inferDriveTypeFromSourceName(b?.name)) ? orderMap.get(inferDriveTypeFromSourceName(b?.name)) : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}
/** 线路名 → 代理方式 flag（play 时传给 getDriveVideoPlayInfo） */
function routeTypeFromSourceName(name) {
  const n = String(name || '');
  if (n.includes('本地')) return '本地代理';
  if (n.includes('服务端')) return '服务端代理';
  if (n.includes('直连')) return '直连';
  return '';
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) {
  try { Promise.resolve(OmniBox.log(level, `${PREFIX} ${msg}`)).catch(() => {}); } catch (_) {}
}
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return text(v.value || v.name || v.url || '');
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 站点 TLS 间歇中断，带重试的 GET/POST */
async function req(method, url, options = {}) {
  let lastErr = null;
  for (let i = 0; i < RETRY; i++) {
    try {
      const cfg = {
        method,
        url,
        timeout: TIMEOUT,
        headers: { 'User-Agent': UA, Referer: `${BASE}/`, ...(options.headers || {}) },
        validateStatus: () => true,
      };
      if (method.toUpperCase() === 'POST') cfg.data = options.body || {};
      const res = await axios(cfg);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr || new Error('请求失败');
}

/* ---- token ---- */
let TOKEN = '';
let TOKEN_EXP = 0;
async function ensureToken(force) {
  if (!force && TOKEN && Date.now() < TOKEN_EXP - 60000) return TOKEN;
  try {
    const r = await req('GET', `${BASE}/api/auth/token`);
    const t = r && r.data && r.data.token;
    if (!t) throw new Error('token 为空');
    TOKEN = t;
    TOKEN_EXP = Date.now() + (Number(r.data.ttl_ms) || 900000);
    return TOKEN;
  } catch (e) { log('error', `token ${e.message}`); throw e; }
}

/** 搜索：返回全部分组结果 [{type, url, password, note, datetime}] */
async function apiSearch(keyword) {
  let token = await ensureToken(false);
  const doSearch = async (tk) => req('POST', `${BASE}/api/search`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-QP-K': tk },
    body: { kw: keyword, res: 'merge', src: 'all' },
  });
  let r;
  try {
    r = await doSearch(token);
  } catch (e) {
    token = await ensureToken(true);
    r = await doSearch(token);
  }
  const out = [];
  const groups = (r && r.data && r.data.merged_by_type) || {};
  for (const [type, items] of Object.entries(groups)) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const url = text(it.url);
      if (!url) continue;
      out.push({ type, url, password: text(it.password), note: text(it.note), datetime: text(it.datetime) });
    }
  }
  log('info', `搜索 "${keyword}" total=${(r && r.data && r.data.total) || 0} 抓取=${out.length}`);
  return out;
}

function panName(type) { return PAN_NAMES[type] || type || '网盘'; }

function toVodItem(it) {
  return {
    vod_id: b64Encode({ mode: 'share', url: it.url, password: it.password, type: it.type, title: it.note }),
    vod_name: it.note || '网盘资源',
    vod_pic: '',
    vod_remarks: `${panName(it.type)}${it.password ? ' | 提取码:' + it.password : ''}`,
  };
}

function isVideoFile(name) {
  return /\.(mp4|mkv|avi|mov|rmvb|wmv|flv|ts|m3u8|webm|mpg|mpeg|rm|3gp|m4v|iso)(?:\?|$)/i.test(text(name));
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
  { id: 'quark', name: '夸克网盘' }, { id: 'baidu', name: '百度网盘' },
  { id: 'aliyun', name: '阿里云盘' }, { id: 'uc', name: 'UC网盘' },
  { id: 'xunlei', name: '迅雷网盘' }, { id: '115', name: '115网盘' },
  { id: '123', name: '123网盘' }, { id: 'tianyi', name: '天翼云盘' },
  { id: 'magnet', name: '磁力链接' },
];

async function home() {
  let classList = PAN_LINES.map((p) => ({ type_id: p.id, type_name: p.name }));
  // 尝试从 cloud-types 拿站点实际支持的线路
  try {
    const r = await req('GET', `${BASE}/api/cloud-types`, { headers: { 'X-QP-K': await ensureToken(false) } });
    const list = (r && r.data && r.data.list) || [];
    const enabled = list.filter((x) => x.enabled).map((x) => ({ type_id: x.id, type_name: x.name || panName(x.id) }));
    if (enabled.length) classList = enabled;
  } catch (_) {}
  return { class: classList, list: [] };
}

async function category(params) {
  const p = params || {};
  const cid = String(p.categoryId || p.type_id || '').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  const kw = String(p.keyword || '电影').trim() || '电影';
  if (!cid) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  try {
    let all = await apiSearch(kw);
    if (cid !== 'all') all = all.filter((x) => x.type === cid);
    const list = all.slice(0, SEARCH_LIMIT).map(toVodItem);
    log('info', `category ${cid} list=${list.length}`);
    return { page, pagecount: 1, total: list.length, limit: list.length, list };
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
    const all = await apiSearch(keyword);
    const start = (page - 1) * SEARCH_LIMIT;
    const list = all.slice(start, start + SEARCH_LIMIT).map(toVodItem);
    log('info', `search "${keyword}" list=${list.length}`);
    return { page, pagecount: Math.ceil(all.length / SEARCH_LIMIT), total: all.length, limit: list.length, list };
  } catch (e) {
    log('error', `search "${keyword}" ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  }
}

async function detail(params, context) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const vodId = String(p.videoId || p.vod_id || p.id || '').trim();
  if (!vodId) return { list: [] };
  try {
    const meta = b64Decode(vodId);
    const shareURL = text(meta.url);
    const title = text(meta.title) || '网盘资源';
    if (!shareURL) { log('warn', `detail 无链接 ${vodId}`); return { list: [] }; }
    const drive = panName(meta.type);

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
        playId: b64Encode({ mode: 'play', shareURL, fid: f.fid, name: f.name, title, password: meta.password }),
      };
    });
    // 与其它网盘脚本统一：命中的网盘类型展开为多条代理线路（SOURCE_NAMES_CONFIG）
    const driveType = String(meta.type || '').toLowerCase();
    let sourceNames = [drive];
    if (DRIVE_TYPE_CONFIG.includes(driveType) || DRIVE_TYPE_CONFIG.includes(meta.type)) {
      sourceNames = [...SOURCE_NAMES_CONFIG];
      // web 端过滤「本地代理」
      if (context && context.from === 'web') sourceNames = sourceNames.filter((n) => !n.includes('本地'));
      if (!sourceNames.length) sourceNames = [drive];
      log('info', `detail ${drive} 命中 DRIVE_TYPE_CONFIG，线路: ${sourceNames.join(' | ')}`);
    }
    const sources = sortPlaySourcesByDriveOrder(
      sourceNames.map((name) => ({
        name,
        // 每条线路克隆 episodes，playId 里带上线路名，供 play() 识别代理方式
        episodes: episodes.map((ep) => {
          const m = b64Decode(ep.playId);
          m.sourceName = name;
          return { name: ep.name, playId: b64Encode(m) };
        }),
      }))
    );
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
        vod_remarks: `${drive}${meta.password ? ' | 码:' + meta.password : ''} | ${videoFiles.length || 1}文件`,
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
    const flag = routeTypeFromSourceName(meta.name) || routeTypeFromSourceName(meta.sourceName || '');
    const info = await OmniBox.getDriveVideoPlayInfo(shareURL, fid, flag);
    const urls = [];
    if (Array.isArray(info?.url)) {
      for (const u of info.url) if (u && u.url) urls.push({ name: text(u.name || text(meta.name) || '播放'), url: text(u.url) });
    } else if (typeof info?.url === 'string' && info.url) {
      urls.push({ name: text(meta.name) || '播放', url: info.url });
    }
    if (!urls.length) throw new Error('未获取到播放地址');
    log('info', `play ${text(meta.name)} urls=${urls.length}`);
    return { urls, flag: 'default', header: { 'User-Agent': UA, Referer: `${BASE}/` }, parse: 0, danmaku: '' };
  } catch (e) {
    log('error', `play ${playId.slice(0, 40)} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
