// @name 谷哥搜
// @author 宝宝巴士
// @description 谷哥搜(gugeso.com) 网盘搜索源：SSE 搜索 → decrypt_urls 解密 → 网盘目录展开播放+刮削回填；参考网盘目录聚盘搜索成品结构；支持夸克/百度/阿里/UC 等线路
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/网盘/谷哥搜.js
// @dependencies axios
/**
 * ============ 谷哥搜（gugeso.com）OmniBox 网盘搜索源 ============
 *
 * 【站点事实（2026-11-19 实测）】
 *   谷哥搜 - 免费无广告网盘资源搜索引擎，Vue SPA + SSE 流式搜索。
 *
 * 【关键链路】
 *   1) 必须先 GET / 拿 PHPSESSID cookie，否则 API 返回 403
 *   2) 搜索：GET /api/other/web_search?title={kw}&is_type={线路}
 *      → text/event-stream，逐行 "data: {json}"，最后 "data: [DONE]"
 *      json = {title, url(加密), datetime, is_type}
 *      首行是 "线路：夸克网盘" 文字
 *   3) 解密：POST /api/other/decrypt_urls  {urls:[加密URL...]}
 *      → {code:200,data:{urls:[真实网盘链接...]}}
 *   4) 播放：SDK getDriveInfoByShareURL / getDriveFileList / getDriveVideoPlayInfo
 *
 * 【网盘线路 is_type】
 *   0=夸克(默认) 其它码对应不同网盘；可用 GUGESO_IS_TYPE 环境变量覆盖。
 *
 * 【返回结构】遵循网盘目录成品（聚盘搜索.js）：
 *   vod_id 用 base64 封 {mode,title,url,enc}
 *   detail 展开网盘目录成 vod_play_sources，play 调 SDK 取直链
 */
const axios = require('axios');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[gugeso]';
const BASE = String(process.env.GUGESO_HOST || 'https://gugeso.com').replace(/\/+$/, '');
const UA = String(process.env.GUGESO_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IS_TYPE = String(process.env.GUGESO_IS_TYPE ?? '').trim();  // 空=默认线路(夸克)
const SEARCH_LIMIT = Math.max(5, Math.min(50, Number(process.env.GUGESO_LIMIT || 20) || 20));
const TIMEOUT = Math.max(5000, Number(process.env.GUGESO_TIMEOUT || 15000) || 15000);
const PAGE_SIZE = 20;

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

/* ---- cookie（PHPSESSID）管理 ---- */
let COOKIE = '';
let COOKIE_AT = 0;
async function ensureCookie(force) {
  if (!force && COOKIE && Date.now() - COOKIE_AT < 20 * 60 * 1000) return COOKIE;
  try {
    const res = await axios.get(`${BASE}/`, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      validateStatus: () => true,
    });
    const setCookie = res.headers['set-cookie'];
    if (Array.isArray(setCookie)) {
      COOKIE = setCookie.map((c) => String(c).split(';')[0]).join('; ');
      COOKIE_AT = Date.now();
    }
  } catch (e) { log('warn', `获取 cookie 失败: ${e.message}`); }
  return COOKIE;
}

function baseHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${BASE}/`,
    ...(COOKIE ? { Cookie: COOKIE } : {}),
  };
}

/** SSE 搜索，返回 [{title, enc, datetime, is_type}] */
async function sseSearch(keyword, isType) {
  let url = `${BASE}/api/other/web_search?title=${encodeURIComponent(keyword)}`;
  if (isType !== '' && isType != null) url += `&is_type=${encodeURIComponent(isType)}`;
  await ensureCookie(false);
  let res = await axios.get(url, { timeout: TIMEOUT, headers: baseHeaders(), responseType: 'text', validateStatus: () => true });
  // 403 → 强制刷新 cookie 重试一次
  if (res.status === 403) {
    await ensureCookie(true);
    res = await axios.get(url, { timeout: TIMEOUT, headers: baseHeaders(), responseType: 'text', validateStatus: () => true });
  }
  if (res.status !== 200) throw new Error(`搜索 HTTP ${res.status}`);
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
  const items = [];
  let lineName = '';
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('线路')) { lineName = s; continue; }
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (payload === '[DONE]') break;
    try {
      const o = JSON.parse(payload);
      if (o && o.title && o.url) {
        items.push({ title: text(o.title), enc: text(o.url), datetime: text(o.datetime), is_type: o.is_type, line: lineName });
      }
    } catch (_) {}
  }
  log('info', `sse 搜索 "${keyword}" 命中 ${items.length} 条 ${lineName}`);
  return items;
}

/** 批量解密加密链接 */
async function decryptUrls(encUrls) {
  const list = (encUrls || []).filter(Boolean);
  if (!list.length) return [];
  const out = [];
  const chunkSize = 20;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    try {
      const res = await axios.post(`${BASE}/api/other/decrypt_urls`, { urls: chunk }, {
        timeout: TIMEOUT, headers: { ...baseHeaders(), 'Content-Type': 'application/json' }, validateStatus: () => true,
      });
      if (res.status === 403) { await ensureCookie(true); continue; }
      const urls = res.data && res.data.data && res.data.data.urls;
      if (res.data && res.data.code === 200 && Array.isArray(urls)) {
        for (const u of urls) out.push(text(u));
        continue;
      }
    } catch (e) { log('warn', `解密失败: ${e.message}`); }
    for (const _ of chunk) out.push('');
  }
  return out;
}

function driveFromLink(link) {
  const u = text(link).toLowerCase();
  if (!u) return '';
  if (u.includes('pan.quark.cn') || u.includes('drive.quark.cn')) return '夸克网盘';
  if (u.includes('pan.baidu.com')) return '百度网盘';
  if (u.includes('drive.uc.cn') || u.includes('fast.uc.cn')) return 'UC网盘';
  if (u.includes('aliyundrive.com') || u.includes('alipan.com')) return '阿里云盘';
  if (u.includes('pan.xunlei.com')) return '迅雷网盘';
  if (u.includes('cloud.189.cn')) return '天翼云盘';
  if (u.includes('yun.139.com')) return '移动云盘';
  if (u.includes('123pan.com') || u.includes('123684.com') || u.includes('123865.com')) return '123网盘';
  if (u.includes('115.com') || u.includes('115cdn')) return '115网盘';
  return '网盘';
}

function isVideoFile(name) {
  return /\.(mp4|mkv|avi|mov|rmvb|wmv|flv|ts|m3u8|webm|mpg|mpeg|rm|3gp|m4v)(?:\?|$)/i.test(text(name));
}

/* ---- 递归展开网盘目录 ---- */
async function collectVideos(shareURL, files, depth) {
  const out = [];
  const stack = [...(files || [])].map((f) => ({ f, d: 0 }));
  const maxDepth = 6;
  const seen = new Set();
  while (stack.length) {
    const { f, d } = stack.shift();
    if (!f) continue;
    const fid = text(f.fid || f.file_id || '');
    const name = text(f.file_name || f.name || f.fileName || '');
    const isDir = Number(f.is_dir ?? f.isDir ?? 0) === 1 || /folder|dir/i.test(text(f.type || ''));
    if (isDir && d < maxDepth && fid) {
      const key = `${fid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const sub = await OmniBox.getDriveFileList(shareURL, fid);
        const children = (sub && Array.isArray(sub.files)) ? sub.files : [];
        for (const c of children) stack.push({ f: c, d: d + 1 });
      } catch (_) {}
    } else if (isVideoFile(name)) {
      out.push({ fid, name, size: f.size || 0 });
    }
  }
  return out;
}

/* ---------------- 五方法 ---------------- */
const PAN_LINES = [
  { id: 'quark', name: '夸克网盘', isType: '0' },
  { id: 'baidu', name: '百度网盘', isType: '4' },
  { id: 'aliyun', name: '阿里云盘', isType: '2' },
  { id: 'uc', name: 'UC网盘', isType: '10' },
];

async function home() {
  const classes = PAN_LINES.map((p) => ({ type_id: p.id, type_name: p.name }));
  // 首页给一个默认线路的热门词占位（真实热搜需另接口，留空列表避免空白）
  return { class: classes, list: [] };
}

async function category(params) {
  const p = params || {};
  const cid = String(p.categoryId || p.type_id || 'quark').trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  const line = PAN_LINES.find((x) => x.id === cid);
  if (!line) return { page, pagecount: 0, total: 0, limit: 0, list: [] };
  // 网盘搜索无分类浏览：用通用词按该线路拉一页
  const kw = String(p.keyword || '电影').trim();
  try {
    let items = await sseSearch(kw, IS_TYPE || line.isType);
    const encs = items.map((x) => x.enc);
    const links = await decryptUrls(encs);
    const list = items.map((x, i) => {
      const share = links[i] || '';
      return {
        vod_id: b64Encode({ mode: 'share', title: x.title, url: share, enc: x.enc }),
        vod_name: x.title,
        vod_pic: '',
        vod_remarks: `${driveFromLink(share)} | ${x.line || ''}`,
        type_id: cid,
        type_name: line.name,
      };
    }).filter((x) => x.vod_name);
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
    let items = await sseSearch(keyword, IS_TYPE);
    if (!items.length) {
      // 刷新 cookie 再试一次
      await ensureCookie(true);
      items = await sseSearch(keyword, IS_TYPE);
    }
    items = items.slice(0, SEARCH_LIMIT);
    const links = await decryptUrls(items.map((x) => x.enc));
    const list = items.map((x, i) => {
      const share = links[i] || '';
      return {
        vod_id: b64Encode({ mode: 'share', title: x.title, url: share, enc: x.enc }),
        vod_name: x.title,
        vod_pic: '',
        vod_remarks: `${driveFromLink(share)} | ${(x.datetime || '').slice(0, 10)}`,
      };
    }).filter((x) => x.vod_name);
    log('info', `search "${keyword}" list=${list.length}`);
    return { page, pagecount: 1, total: list.length, limit: list.length, list };
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
    let meta = b64Decode(vodId);
    let title = text(meta.title) || '网盘资源';
    let shareURL = text(meta.url);

    // 兜底：只有加密串时解密
    if (!shareURL && text(meta.enc)) {
      const arr = await decryptUrls([text(meta.enc)]);
      shareURL = text(arr[0]);
    }
    if (!shareURL) { log('warn', `detail 无分享链接 ${vodId}`); return { list: [] }; }

    let driveName = driveFromLink(shareURL);
    try {
      const info = await OmniBox.getDriveInfoByShareURL(shareURL);
      if (info && (info.name || info.driveName || info.type)) {
        driveName = text(info.name || info.driveName || info.type) || driveName;
      }
    } catch (_) {}

    // 展开根目录
    let videoFiles = [];
    try {
      const root = await OmniBox.getDriveFileList(shareURL, '0');
      const rootFiles = (root && Array.isArray(root.files)) ? root.files : [];
      videoFiles = await collectVideos(shareURL, rootFiles, 0);
    } catch (e) { log('warn', `目录展开失败: ${e.message}`); }

    // 刮削：一次性提交候选，回填元数据 + 分集改名（失败不影响主链路）
    let scrapeData = null;
    let mappingMap = new Map();
    if (videoFiles.length) {
      try {
        const resourceId = `${shareURL}|${title}`;
        const candidates = videoFiles.map((f) => ({
          fid: `${shareURL}|${f.fid}`,
          file_id: `${shareURL}|${f.fid}`,
          file_name: f.name,
          name: f.name,
          format_type: 'video',
        }));
        await OmniBox.processScraping(resourceId, title, title, candidates);
        const metadata = await OmniBox.getScrapeMetadata(resourceId);
        scrapeData = metadata && metadata.scrapeData ? metadata.scrapeData : null;
        const mappings = (metadata && Array.isArray(metadata.videoMappings)) ? metadata.videoMappings : [];
        for (const m of mappings) if (m && m.fileId) mappingMap.set(String(m.fileId), m);
        if (mappings.length) log('info', `刮削 mappings=${mappings.length}`);
      } catch (e) { log('warn', `刮削跳过: ${e.message}`); }
    }

    const pickScrape = (k) => {
      const v = scrapeData && (scrapeData[k] || scrapeData[k.replace(/^vod_/, '')]);
      return v ? text(v) : '';
    };

    const playSources = [];
    if (videoFiles.length) {
      const episodes = videoFiles.map((f) => {
        const mapKey = `${shareURL}|${f.fid}`;
        const mp = mappingMap.get(mapKey);
        return {
          name: (mp && (mp.episodeName || mp.name)) ? text(mp.episodeName || mp.name) : f.name,
          playId: b64Encode({ mode: 'play', shareURL, fid: f.fid, name: f.name, title, fidKey: mapKey }),
        };
      });
      playSources.push({ name: driveName, episodes });
    } else {
      // 展开失败也要给一条可点线路
      playSources.push({
        name: driveName,
        episodes: [{ name: title, playId: b64Encode({ mode: 'play', shareURL, fid: '0', name: title, title }) }],
      });
    }
    const playFrom = playSources.map((s) => s.name).join('$$$');
    const playUrl = playSources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');

    log('info', `detail ${title} drive=${driveName} files=${videoFiles.length}`);
    return {
      list: [{
        vod_id: vodId,
        vod_name: pickScrape('vod_name') || title,
        vod_pic: pickScrape('vod_pic') || '',
        vod_content: pickScrape('vod_content') || '',
        vod_actor: pickScrape('vod_actor') || '',
        vod_director: pickScrape('vod_director') || '',
        vod_year: pickScrape('vod_year') || '',
        vod_remarks: `${driveName} | ${videoFiles.length || 1}个文件`,
        vod_play_from: playFrom,
        vod_play_url: playUrl,
        vod_play_sources: playSources,
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
    return { urls, flag: 'default', header: { 'User-Agent': UA, Referer: `${BASE}/` }, parse: 0, danmaku: '' };
  } catch (e) {
    log('error', `play ${playId.slice(0, 40)} ${e.message}`);
    return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  }
}
