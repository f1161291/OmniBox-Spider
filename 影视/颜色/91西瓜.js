// @name 91西瓜
// @author 宝宝巴士
// @description 91西瓜(91xg.tv / www.xigua662.com) 采集源：纯前端 SPA，数据走 POST xmjk.kphm88.com/forward 私有 JSON 接口（WEB_GET_ALL / WEB_GET_INFO / WEB_GET_INFO_DETAIL）；首页/分类/搜索/详情/播放全支持；播放地址 = getDataInit 的 macVodLinkMap[vod_server_id].LINK_N + vod_url（AES-128 HLS，key 与分片均 CORS 全开）
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91西瓜.js
// @dependencies axios
/**
 * ============ 91西瓜（91xg.tv → www.xigua662.com）OmniBox 采集源 ============
 *
 * 【站点事实（2026-11-27 实测）】
 *   纯前端 SPA（jQuery），首页只有骨架 + getHomeV()，真实数据全走私有 JSON 接口：
 *     POST https://xmjk.kphm88.com/forward      Content-Type: application/json
 *     POST https://xmjk.kphm88.com/getDataInit  （配置/菜单/播放线路服务器表）
 *
 *   1) 首页    {command:"WEB_GET_ALL", languageType:"CN", content:""}
 *      → data.resultList[] = 每个栏目 {t_Name, type_id, type_Mid, t_type, href, t_list[]}
 *        t_type = M_VOIDE（视频/电影）| M_ART（图片/小说）
 *        t_list[] 条目字段（只收视频）：
 *          {id, vod_name, vod_pic(绝对URL), vod_class, type_Mid, vod_server_id, href:"moviePlayer.html"}
 *        图文条目（art_name/art_pic/imageShow.html）不收，本源只做视频
 *
 *   2) 分类/搜索  {command:"WEB_GET_INFO", pageNumber, RecordsPage, typeId, typeMid,
 *                  languageType:"CN", content:"" , type:1}
 *      → data.{count, pageNumber, pageAllNumber, t_Name, resultList[]}
 *        搜索：content=关键词 + type=1（实测「巨乳」命中 7862 条）
 *        分类：typeId=叶子分类 id，typeMid=1（视频类，本源固定 1）
 *        实测 typeId=6（91传媒）count=2959、pageAllNumber=148（每页 20）
 *
 *   3) 详情    {command:"WEB_GET_INFO_DETAIL", type_Mid, id, languageType:"CN"}
 *      → data.result = {id, vod_name, vod_pic(相对路径), vod_url(相对 m3u8 路径),
 *                       vod_server_id, vod_type_id, typeName, vod_class, vod_time_add}
 *        实测 vod_url = "/video/m3u8/202602/10/7453f0a8b46e/playlist.m3u8"
 *
 *   4) 播放线路  POST getDataInit → data.macVodLinkMap[server_id] = {
 *          LINK_1, LINK_2, LINK_3, PIC_LINK_1, PIC_LINK_2, PIC_LINK_3 }
 *      真实播放地址 = macVodLinkMap[vod_server_id].LINK_N + vod_url
 *      封面         = macVodLinkMap[vod_server_id].PIC_LINK_1 + vod_pic
 *
 *   5) 播放链实测：playlist.m3u8 → HTTP 206 / application/vnd.apple.mpegurl，
 *      内含 #EXT-X-KEY:METHOD=AES-128,URI="https://hweu2.hulichuang.mobi/encrypt.key"
 *      key 16 字节、ts 分片 video/mp2t，三者 Access-Control-Allow-Origin: * → 浏览器端可直解。
 *
 * 【分类菜单】getDataInit.menu0ListMap 里前 5 组是真实内容分类，其余为博彩/成人外链广告位
 *   （href 指向 123adpda.com 等），本脚本已剔除；
 *   其中 图片(id=4) 与 小说(id=5) 属于 typeMid=2 图文，本源不收录，
 *   最终只保留 传媒/视频/电影 三组视频分类。
 */
const axios = require('axios');
const OmniBox = require('omnibox_sdk');
const runner = require('spider_runner');

const PREFIX = '[xg]';
const UA = String(process.env.XIGUA_UA || '').trim()
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 数据接口（SPA 实际请求的私有网关）
const API = String(process.env.XIGUA_API || 'https://xmjk.kphm88.com').trim().replace(/\/+$/, '');
// 站点域名（仅用于 Referer/Origin，接口本身不校验来源）
const SITE = String(process.env.XIGUA_HOST || 'https://www.xigua662.com').trim().replace(/\/+$/, '');
const TIMEOUT = Math.max(5000, Number(process.env.XIGUA_TIMEOUT || 15000) || 15000);
const PAGE_SIZE = Math.max(1, Number(process.env.XIGUA_PAGE_SIZE || 20) || 20);

// 官网真实视频分类（2026-11-27 从 getDataInit.menu0ListMap 提取）
// 只保留 传媒/视频/电影 三组视频分类；图片(id=4, typeMid=2) 与 小说(id=5, typeMid=2) 不收录
// 其余 20 组为博彩/外链广告位（href 指向 123adpda.com 等），同样剔除
const CATEGORY_GROUPS = [
  { id: '1', name: '传媒', mid: 1, subs: [
    ['6', '91传媒', 1], ['7', '精东传媒', 1], ['8', '麻豆传媒', 1], ['9', '麻豆映画', 1],
    ['10', '麻豆猫爪', 1], ['11', '蜜桃传媒', 1], ['12', '天美传媒', 1], ['13', '星空传媒', 1],
  ] },
  { id: '2', name: '视频', mid: 1, subs: [
    ['14', '偷拍自拍', 1], ['15', '日韩视频', 1], ['16', '欧美性爱', 1], ['17', '智能换脸', 1],
    ['18', '经典三级', 1], ['19', '网红主播', 1], ['20', '台湾辣妹', 1], ['21', 'onlyfans', 1],
  ] },
  { id: '3', name: '电影', mid: 1, subs: [
    ['22', '中文字幕', 1], ['23', '经典素人', 1], ['24', '高清无码', 1], ['25', '美颜巨乳', 1],
    ['26', '丝袜制服', 1], ['27', 'SM系列', 1], ['28', '欧美系列', 1], ['29', 'H動畫', 1],
  ] },
];

const TOP_CLASSES = [
  { type_id: '0', type_name: '全部' },
  ...CATEGORY_GROUPS.map((g) => ({ type_id: g.id, type_name: g.name })),
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function log(level, msg) { try { OmniBox.log(level, `${PREFIX} ${msg}`); } catch (_) {} }
function text(v) {
  if (v == null) return '';
  return String(v).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}
function absUrl(u) {
  const s = text(u);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return `https:${s}`;
  return `${SITE}/${s.replace(/^\/+/, '')}`;
}

/** 统一 POST /forward 请求，返回解析后的 data 字段。 */
async function forward(payload) {
  const body = Object.assign({ languageType: 'CN', content: '' }, payload);
  const res = await axios.post(`${API}/forward`, body, {
    timeout: TIMEOUT,
    validateStatus: () => true,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Origin: SITE,
      Referer: `${SITE}/`,
    },
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  if (res.status !== 200) throw new Error(`forward HTTP ${res.status}`);
  let json;
  try { json = JSON.parse(String(res.data || '')); }
  catch (_) { throw new Error(`forward 非 JSON: ${String(res.data || '').slice(0, 80)}`); }
  const code = String(json && json.errorCode != null ? json.errorCode : '');
  if (code && code !== '0') throw new Error(`forward errorCode=${code} ${json.message || ''}`);
  return (json && json.data) || {};
}

/** getDataInit：分类菜单 + 播放线路服务器表。进程内缓存，避免每次 play 都打。 */
let INIT_CACHE = null;
let INIT_AT = 0;
const INIT_TTL = Math.max(60000, Number(process.env.XIGUA_INIT_TTL || 1800000) || 1800000);
async function getInit(force) {
  const now = Date.now();
  if (!force && INIT_CACHE && now - INIT_AT < INIT_TTL) return INIT_CACHE;
  const res = await axios.post(`${API}/getDataInit`, {}, {
    timeout: TIMEOUT,
    validateStatus: () => true,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Origin: SITE,
      Referer: `${SITE}/`,
    },
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  if (res.status !== 200) throw new Error(`getDataInit HTTP ${res.status}`);
  const json = JSON.parse(String(res.data || ''));
  INIT_CACHE = (json && json.data) || {};
  INIT_AT = now;
  log('info', `getDataInit 完成 服务器线路=${Object.keys(INIT_CACHE.macVodLinkMap || {}).length} 菜单=${(INIT_CACHE.menu0ListMap || []).length}`);
  return INIT_CACHE;
}

/** 数据库占位图（如 "[db:图片]"）不是真实 URL，统一视为空。 */
function realPic(u) {
  const s = text(u);
  if (!s || /^\[db:/.test(s)) return '';
  return absUrl(s);
}

/** 列表条目 → OmniBox vod 结构。只收视频条目（图文 art_* 直接跳过）。 */
function mapItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.art_name != null || it.href === 'imageShow.html') return null; // 图文/小说不收
  const name = text(it.vod_name);
  if (!name) return null;
  const id = text(it.id);
  if (!id) return null;
  const mid = Number(it.type_Mid || 1) || 1;
  return {
    vod_id: `${mid}:${id}`,
    vod_name: name,
    vod_pic: realPic(it.vod_pic),
    vod_remarks: '视频',
    vod_tag: 'video',
    vod_content: '',
    type_id: String(mid),
    type_name: '视频',
  };
}

function mapList(arr) {
  const out = [];
  for (const it of (arr || [])) {
    const v = mapItem(it);
    if (v) out.push(v);
  }
  return out;
}

function buildClassFilters() {
  const filters = {};
  for (const g of CATEGORY_GROUPS) {
    filters[g.id] = [{
      key: 'sub', name: '子分类', init: '',
      value: [{ name: '全部', value: '' }, ...g.subs.map(([sid, name]) => ({ name, value: `${sid}|${name}` }))],
    }];
  }
  return filters;
}

/** 从 filters/extend/ext 里取用户选中的子分类（值为 "typeId|名称"）。 */
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

/** 解析 "typeId|名称" 或纯 typeId，返回 {typeId, mid, name}。 */
function resolveCategory(rawId, subVal) {
  let typeId = String(rawId || '').trim();
  let mid = 0;
  let name = '';
  if (subVal) {
    const [sid, sname] = String(subVal).split('|');
    typeId = String(sid || '').trim();
    name = String(sname || '').trim();
  }
  // 定位所属分组拿 typeMid
  for (const g of CATEGORY_GROUPS) {
    if (String(g.id) === typeId) { mid = g.mid; name = name || g.name; break; }
    const hit = g.subs.find(([sid]) => String(sid) === typeId);
    if (hit) { mid = hit[2]; name = name || hit[1]; break; }
  }
  if (!mid) mid = 1;
  return { typeId, mid, name };
}

async function home() {
  try {
    const data = await forward({ command: 'WEB_GET_ALL' });
    const groups = data.resultList || [];
    const list = [];
    const seen = new Set();
    for (const g of groups) {
      for (const it of (g.t_list || [])) {
        const v = mapItem(it);
        if (!v || seen.has(v.vod_id)) continue;
        seen.add(v.vod_id);
        list.push(v);
      }
    }
    log('info', `home 栏目=${groups.length} 条目=${list.length}`);
    return { class: TOP_CLASSES, filters: buildClassFilters(), list };
  } catch (e) {
    log('error', `home ${e.message}`);
    return { class: TOP_CLASSES, filters: buildClassFilters(), list: [] };
  }
}

async function category(params) {
  const p = params || {};
  const rawId = p.categoryId || p.type_id || p.tid || '0';
  const sub = pickSubCategory(p);
  let { typeId, mid, name } = resolveCategory(rawId, sub);
  // 未指定分类 → 走首页
  if (!typeId || typeId === '0' || typeId === 'all') return home();
  const page = Math.max(1, Number(p.page || 1) || 1);
  try {
    const data = await forward({
      command: 'WEB_GET_INFO',
      pageNumber: page,
      RecordsPage: PAGE_SIZE,
      typeId: Number(typeId) || typeId,
      typeMid: mid,
    });
    const list = mapList(data.resultList);
    const total = Number(data.count || 0) || 0;
    const pageAll = Number(data.pageAllNumber || 0) || 0;
    // pagecount 语义：宿主用于判断是否还有下一页，给「总页数」最稳
    const pagecount = pageAll > 0 ? pageAll : (list.length >= PAGE_SIZE ? page + 1 : page);
    log('info', `category id=${typeId}(${name || '-'}) mid=${mid} page=${page}/${pagecount} total=${total} list=${list.length}`);
    return { page, pagecount, total, limit: PAGE_SIZE, list };
  } catch (e) {
    log('error', `category id=${typeId} page=${page} ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const kw = text(p.keyword || p.wd || p.key || '');
  const page = Math.max(1, Number(p.page || 1) || 1);
  if (!kw) return { page: 1, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  try {
    const data = await forward({
      command: 'WEB_GET_INFO',
      pageNumber: page,
      RecordsPage: PAGE_SIZE,
      typeId: 0,
      typeMid: 1,
      content: kw,
      type: 1,
    });
    const list = mapList(data.resultList);
    const total = Number(data.count || 0) || 0;
    const pageAll = Number(data.pageAllNumber || 0) || 0;
    const pagecount = pageAll > 0 ? pageAll : (list.length >= PAGE_SIZE ? page + 1 : page);
    log('info', `search "${kw}" page=${page}/${pagecount} total=${total} list=${list.length}`);
    return { page, pagecount, total, limit: PAGE_SIZE, list };
  } catch (e) {
    log('error', `search "${kw}" ${e.message}`);
    return { page, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

async function detail(params, context) {
  const p = (typeof params === 'string') ? { videoId: params } : (params || {});
  const raw = text(p.videoId || p.vod_id || p.id || '');
  if (!raw) return { list: [] };
  // vod_id 形如 "1:52005"（type_Mid:id）；兼容纯 id（默认 mid=1）
  let mid = 1;
  let id = raw;
  const m = raw.match(/^(\d+):(\d+)$/);
  if (m) { mid = Number(m[1]) || 1; id = m[2]; }
  try {
    const data = await forward({ command: 'WEB_GET_INFO_DETAIL', type_Mid: mid, id: Number(id) || id });
    const r = data.result || {};
    const name = text(r.vod_name) || '未命名';

    // ---------- 视频（typeMid=1）----------
    // 封面/播放地址都需要 getDataInit 的服务器前缀
    let init = null;
    try { init = await getInit(false); } catch (e) { log('warn', `detail getInit 失败: ${e.message}`); }
    const links = (init && init.macVodLinkMap) || {};
    const sid = String(r.vod_server_id != null ? r.vod_server_id : '');
    const srv = links[sid] || {};
    const picPath = text(r.vod_pic);
    let pic = '';
    if (picPath) {
      pic = /^https?:\/\//i.test(picPath) ? picPath : `${text(srv.PIC_LINK_1 || srv.PIC_LINK_2 || '')}${picPath}`;
    }
    const vodUrl = text(r.vod_url);
    const content = text(r.vod_class || '') || text(r.typeName || '');

    const sources = [];
    if (vodUrl) {
      // 同一条 vod_url 挂多个服务器前缀，任一线路可用即可
      const episodes = [];
      const candidates = [];
      for (const key of ['LINK_1', 'LINK_2', 'LINK_3']) {
        const base = text(srv[key]);
        if (base && !candidates.includes(base)) candidates.push(base);
      }
      if (!candidates.length) log('warn', `detail id=${id} 服务器 ${sid || '?'} 无可用 LINK 前缀`);
      candidates.forEach((base, i) => {
        episodes.push({ name: `线路${i + 1}`, playId: `xg:${base}${vodUrl}` });
      });
      if (episodes.length) sources.push({ name: '默认线路', episodes });
    }
    const playFrom = sources.map((s) => s.name).join('$$$');
    const playUrlField = sources.map((s) => s.episodes.map((e) => `${e.name}$${e.playId}`).join('#')).join('$$$');
    log('info', `detail ${raw} name=${name.slice(0, 24)} sid=${sid} 线路=${sources[0] ? sources[0].episodes.length : 0} vod_url=${vodUrl.slice(0, 60)}`);
    return {
      list: [{
        vod_id: raw,
        vod_name: name,
        vod_pic: pic,
        vod_content: content,
        vod_remarks: text(r.typeName || '') || '视频',
        vod_year: text(r.vod_time_add || '').slice(0, 4),
        vod_play_from: playFrom,
        vod_play_url: playUrlField,
        vod_play_sources: sources,
      }],
    };
  } catch (e) {
    log('error', `detail ${raw} ${e.message}`);
    return { list: [] };
  }
}

async function play(params, context) {
  const p = (typeof params === 'string') ? { playId: params } : (params || {});
  const playId = text(p.playId || p.url || '');
  if (!playId) return { urls: [], flag: 'default', header: {}, parse: 1, danmaku: '' };
  const header = { 'User-Agent': UA, Referer: `${SITE}/`, Origin: SITE };
  try {
    let url = playId;
    if (playId.startsWith('xg:')) url = playId.slice(3);
    // 视频 m3u8/mp4 已是完整直链 → parse=0 直返
    if (/^https?:\/\/.+/i.test(url) && /\.(m3u8|mp4)(\?|$)/i.test(url)) {
      log('info', `play 直链 ${url.slice(0, 110)}`);
      return { urls: [{ name: '默认线路', url }], flag: 'default', header, parse: 0, danmaku: '' };
    }
    // 兜底：非媒体地址交给播放器嗅探
    log('warn', `play 非媒体直链，回退嗅探: ${url.slice(0, 110)}`);
    return { urls: [{ name: '默认线路', url }], flag: 'default', header, parse: 1, danmaku: '' };
  } catch (e) {
    log('error', `play ${playId.slice(0, 80)} ${e.message}`);
    return { urls: [], flag: 'default', header, parse: 1, danmaku: '' };
  }
}
