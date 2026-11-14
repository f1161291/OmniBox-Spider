/**
 * @name 91porn
 * @version 2.2.1
 * @description 91porn.com 采集源（OmniBox Spider，单主站优先+SITE_HOSTS 可选容灾；列表封面/标题反混淆真值回填；返回形状守卫；列表耗时预算；SDK/Node 双通道传输 + 网络自检 + HTTP/SOCKS5 代理隧道；会话 cookie jar + 403 预热重试（应对出口 IP 拦截）；修复高清分类/搜索分页/作者解析/无效视频/直链规范）
 * @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/91Porn.js
 * @dependencies []
 */

let OmniBox;
try { OmniBox = require('omnibox_sdk'); }
catch (_) { OmniBox = { log() { /* 无 SDK 时静默，绝不写 stdout */ }, getCache() { return null; }, setCache() { return Promise.resolve(); }, deleteCache() { return Promise.resolve(); } }; }
let runner;
try { runner = require('spider_runner'); }
catch (_) { runner = { run() {} }; }

const https = require('https');
const http = require('http');

const USER_AGENT = process.env.NINETYONE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LANG = process.env.LANG_COOKIE || 'cn_CN';
const COOKIE = process.env.NINETYONE_COOKIE || "";
// 视频代理基址（可选）。91porn 的 mp4 签名绑 IP，OK影视 直接拉永远 403；
// 配置本项后，play() 走代理（代理同机取签名+取流），OK影视 只跟代理通信即可播放。
const NINETYONE_PROXY_BASE = (() => {
  let b = (process.env.NINETYONE_PROXY_BASE || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (b && !/^https?:\/\//i.test(b)) b = 'http://' + b;
  return b;
})();
// 播放策略：默认 auto=真实直链优先、全失败才回退「推荐栏形态播放页」嗅探。
// 站点 player.preroll 广告仅 1 秒(skipTime:1)，首页推荐项常被宿主预热，
// 嗅探落在广告窗口之后能拿到真视频；分类/搜索冷启动首访则容易撞进广告。
// 置 sniff 可强制走旧嗅探模式（复现/兼容特定端），always 则两种线路一起给。
// 推荐栏形态：c=uyklk&viewtype=&category=，与首页真实链接一致。
const NINETYONE_PLAY_MODE = String(process.env.NINETYONE_PLAY_MODE || 'auto').trim().toLowerCase();

// 站点基址：默认只用主站 91porn.com。
// （v1.7.0 起移除第三方镜像站：镜像签发的播放直链与主站线路不一致，
//   混用会让 play() 拿到镜像地址后播放器取流失败，反而制造问题。
//   需要多基址容灾时可自行用 SITE_HOSTS 逗号配置。）
const PRIMARY_API = (process.env.SITE_API || 'https://91porn.com').replace(/\/+$/, '');
const HOSTS = (() => {
  const fromEnv = String(process.env.SITE_HOSTS || PRIMARY_API)
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return Array.from(new Set(fromEnv.length ? fromEnv : [PRIMARY_API]));
})();
let PREFERRED = 0; // 上次成功的基址下标，下次优先
const PREFIX = '[91porn]';
// 日志统一走「吞掉异常 + 不写 stdout」的实现：
//   * 宿主通过 stdout 读脚本返回值，任何直接 console.log 都可能污染结果流，
//     导致宿主报 json: cannot unmarshal string into Go value of type ...；
//   * OmniBox.log 返回 Promise，未 await 时若 reject 会产生未处理拒绝，
//     因此统一 Promise.resolve(...).catch() 兜住；
//   * SDK 缺失时降级为 no-op（坚决不用 console.log）。
function safeLog(level, m) {
  try {
    if (OmniBox && typeof OmniBox.log === 'function') {
      Promise.resolve(OmniBox.log(level, `${PREFIX} ${m}`)).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}
function logI(m) { safeLog('info', m); }
function logE(m) { safeLog('error', m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATEGORIES = [
  { type_id: 'hot', type_name: '今日热门' },
  { type_id: 'watch', type_name: '最新' },
  { type_id: 'rp', type_name: '最近得分' },
  { type_id: 'tf', type_name: '本月收藏' },
  { type_id: 'md', type_name: '本月讨论' },
  { type_id: 'mf', type_name: '本月收藏最多' },
  { type_id: 'rf', type_name: '最近加精' },
  { type_id: 'top', type_name: '本月最热' },
  { type_id: 'top&m=-1', type_name: '上月最热' },
  { type_id: 'hd', type_name: '高清' }
];

/**
 * 传输通道选择：
 *   宿主运行在受限出网环境时，脚本自建的 node https 可能被网络策略拦掉
 *   （典型现象：请求 ~400ms 内被中断，宿主界面却显示「方法执行成功」但没数据）。
 *   宿主的 OmniBox.request 走它自己的请求栈（可能带代理/白名单），成功率高得多。
 *   NINETYONE_TRANSPORT:
 *     auto（默认）= 先 SDK 再 node
 *     sdk         = 只用宿主请求
 *     node        = 只用 node https（旧行为）
 */
const TRANSPORT = String(process.env.NINETYONE_TRANSPORT || 'auto').trim().toLowerCase();
const SDK_TIMEOUT = Number(process.env.NINETYONE_SDK_TIMEOUT || 20000);

/**
 * 出口代理（可选但强烈建议在「403 + 极短响应体」场景下配置）。
 *
 * 症状判据：请求 8ms 就返回 HTTP 403、响应体只有十几字节 → 这是 Cloudflare/防火墙
 * 针对服务器出口 IP 的拦截，请求没进到应用层。换 UA / Cookie / Referer 都无效，
 * 唯一解法是换出口 IP。支持 http(s) CONNECT 与 socks5（可带用户名密码）。
 *
 *   NINETYONE_PROXY_URL=http://127.0.0.1:7890
 *   NINETYONE_PROXY_URL=socks5://user:pass@127.0.0.1:1080
 * 也兼容通用变量 UPSTREAM_HTTP_PROXY_URL / HTTP_PROXY_URL。
 */
const PROXY_URL = String(
  process.env.NINETYONE_PROXY_URL
  || process.env.UPSTREAM_HTTP_PROXY_URL
  || process.env.HTTP_PROXY_URL
  || '',
).trim();

function sdkAvailable() {
  return !!(OmniBox && typeof OmniBox.request === 'function');
}

async function sdkRequest(urlStr, options = {}, headers = {}) {
  const res = await OmniBox.request(urlStr, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    timeout: options.timeout || SDK_TIMEOUT,
  });
  const statusCode = Number((res && res.statusCode) || 0);
  const rawHeaders = (res && res.headers) || {};
  parseSetCookie(rawHeaders);
  const body = String((res && res.body) || '');
  // SDK 在不同实现下可能返回已解析对象，这里统一成字符串
  return {
    statusCode,
    headers: rawHeaders,
    body: typeof res?.body === 'string' ? body : (body || ''),
    _host: (() => { try { return new URL(urlStr).host; } catch (_) { return ''; } })(),
    finalUrl: String((res && (res.finalUrl || res.url)) || urlStr),
  };
}

/* ---------------- 零依赖代理隧道：HTTP CONNECT / SOCKS5 ---------------- */

function parseProxyUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(text) ? text : `http://${text}`;
  let u;
  try { u = new URL(withScheme); } catch (_) { return null; }
  const protocol = u.protocol.replace(':', '').toLowerCase();
  const isSocks = protocol.indexOf('socks') === 0;
  return {
    protocol,
    host: u.hostname,
    port: Number(u.port || (isSocks ? 1080 : 7890)),
    auth: (u.username || u.password)
      ? { username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }
      : null,
    isSocks,
  };
}

function connectViaHttpProxy(proxy, host, port, timeout) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; socket.destroy(); reject(e); };
    socket.on('timeout', () => fail(Object.assign(new Error('代理连接超时'), { code: 'ETIMEDOUT' })));
    socket.on('error', fail);
    socket.on('connect', () => {
      const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (proxy.auth && proxy.auth.username) {
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')}`);
      }
      lines.push('Proxy-Connection: keep-alive', '', '');
      socket.write(lines.join('\r\n'));
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.indexOf('\r\n\r\n') < 0) return;
      socket.removeListener('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      const code = Number((statusLine.match(/\s(\d{3})\s?/) || [])[1] || 0);
      if (code !== 200) return fail(new Error(`代理 CONNECT 失败: ${statusLine}`));
      settled = true; socket.setTimeout(0); resolve(socket);
    };
    socket.on('data', onData);
  });
}

function connectViaSocks5(proxy, host, port, timeout) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout });
    let stage = 'greeting';
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; socket.destroy(); reject(e); };
    const buildConnect = () => {
      const h = Buffer.from(host, 'utf8');
      const p = Buffer.alloc(2); p.writeUInt16BE(port, 0);
      return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, p]);
    };
    socket.on('timeout', () => fail(Object.assign(new Error('SOCKS5 超时'), { code: 'ETIMEDOUT' })));
    socket.on('error', fail);
    socket.on('connect', () => {
      const withAuth = !!(proxy.auth && proxy.auth.username);
      socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    });
    const onData = (chunk) => {
      if (stage === 'greeting') {
        if (chunk[0] !== 0x05) return fail(new Error('SOCKS5 版本不匹配'));
        if (chunk[1] === 0x02) {
          const u = Buffer.from(proxy.auth.username, 'utf8');
          const p = Buffer.from(proxy.auth.password, 'utf8');
          stage = 'auth';
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        if (chunk[1] === 0x00) { stage = 'connect'; socket.write(buildConnect()); return; }
        return fail(new Error(`SOCKS5 不支持认证 ${chunk[1]}`));
      }
      if (stage === 'auth') {
        if (chunk[1] !== 0x00) return fail(new Error('SOCKS5 认证失败'));
        stage = 'connect'; socket.write(buildConnect()); return;
      }
      if (stage === 'connect') {
        if (chunk[1] !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${chunk[1]}`));
        socket.removeListener('data', onData);
        settled = true; socket.setTimeout(0); resolve(socket);
      }
    };
    socket.on('data', onData);
  });
}

/**
 * 经代理发起请求（隧道内再起 TLS，SNI 必须是目标域名）。
 */
function proxyRequest(urlStr, options = {}, headers = {}, proxy = null) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const targetHost = u.hostname;
    const targetPort = Number(u.port || (isHttps ? 443 : 80));
    const timeout = options.timeout || 15000;
    const connect = proxy.isSocks ? connectViaSocks5 : connectViaHttpProxy;

    connect(proxy, targetHost, targetPort, timeout).then((socket) => {
      const http_ = require('http');
      const https_ = require('https');
      const tls_ = require('tls');
      const reqOptions = {
        host: targetHost,
        port: targetPort,
        path: `${u.pathname}${u.search}`,
        method: options.method || 'GET',
        headers: Object.assign({}, headers, { Host: u.host }),
        timeout,
        agent: false,
      };
      if (isHttps) {
        const secure = tls_.connect({ socket, servername: targetHost });
        reqOptions.createConnection = () => secure;
      } else {
        reqOptions.createConnection = () => socket;
      }
      const transport = isHttps ? https_ : http_;
      const req = transport.request(reqOptions, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return proxyRequest(new URL(res.headers.location, u.href).href, options, headers, proxy).then(resolve).catch(reject);
        }
        parseSetCookie(res.headers);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
          _host: u.host,
          finalUrl: u.href,
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      if (options.body) req.write(options.body);
      req.end();
    }).catch(reject);
  });
}

function nodeRequest(urlStr, options = {}, headers = {}, redirectCount = 0) {
  // 配了代理就走隧道（403 极短响应体这类 IP 级拦截只能靠换出口解决）
  const proxy = parseProxyUrl(PROXY_URL);
  if (proxy) {
    logI(`[proxy] ${proxy.protocol}://${proxy.host}:${proxy.port} -> ${urlStr.slice(0, 60)}`);
    return proxyRequest(urlStr, options, headers, proxy);
  }
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向过多'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: options.method || 'GET', headers, timeout: options.timeout || 15000, rejectUnauthorized: false },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return nodeRequest(new URL(res.headers.location, u.href).href, options, headers, redirectCount + 1).then(resolve).catch(reject);
        }
        parseSetCookie(res.headers);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8'), _host: u.host, finalUrl: u.href }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 统一请求入口：按 TRANSPORT 决定用宿主请求还是 node 直连。
 * auto 模式下先试 SDK（宿主网络策略通常更宽松），失败再回落 node，并记住哪条通道更可靠。
 */
let PREFERRED_TRANSPORT = '';

/**
 * 站点下发 CLIPSHARE / ga 等会话 cookie，首次访问才会给。
 * 部分机房 IP 段（如部分美国 VPS）不带 cookie 连续裸请求会被 WAF 直接 403，
 * 症状就是「403 + 十几字节响应体」。因此这里自己做 cookie jar：
 *   1) 从响应 set-cookie 里自动累积；
 *   2) 通过 SDK cache 持久化，跨请求复用；
 *   3) 可在 NINETYONE_COOKIE 里手工追加/覆盖。
 */
const SESSION_COOKIE = new Map();   // name -> value
let sessionCookieLoaded = false;

function parseSetCookie(headers) {
  const raw = (headers && (headers['set-cookie'] || headers['Set-Cookie'])) || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const picked = [];
  for (const line of arr) {
    const first = String(line || '').split(';')[0].trim();
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name || !value) continue;
    SESSION_COOKIE.set(name, value);
    picked.push(name);
  }
  if (picked.length) logI(`[cookie] 收到 ${picked.join(',')}`);
  return picked;
}

const COOKIE_CACHE_KEY = '91porn:session-cookie';
async function loadSessionCookie() {
  if (sessionCookieLoaded) return;
  sessionCookieLoaded = true;
  try {
    const raw = await OmniBox.getCache(COOKIE_CACHE_KEY);
    if (!raw) return;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k && v) SESSION_COOKIE.set(k, String(v));
      }
      logI(`[cookie] 载入缓存 session cookie ${SESSION_COOKIE.size} 个`);
    }
  } catch (_) { /* ignore */ }
}
async function saveSessionCookie() {
  try {
    const obj = {};
    for (const [k, v] of SESSION_COOKIE.entries()) obj[k] = v;
    await OmniBox.setCache(COOKIE_CACHE_KEY, JSON.stringify(obj), 6 * 3600);
  } catch (_) { /* ignore */ }
}

function buildCookieHeader() {
  const parts = [`language=${LANG}`];
  for (const [k, v] of SESSION_COOKIE.entries()) {
    if (k === 'language') continue;
    parts.push(`${k}=${v}`);
  }
  if (COOKIE) parts.push(COOKIE);
  return parts.join('; ');
}

function buildHeaders(extra) {
  return Object.assign(
    {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Cookie: buildCookieHeader(),
    },
    extra || {},
  );
}

async function httpRequest(urlStr, options = {}) {
  await loadSessionCookie();
  const headers = buildHeaders(options.headers);
  const order = (() => {
    if (TRANSPORT === 'sdk') return ['sdk'];
    if (TRANSPORT === 'node') return ['node'];
    // auto：优先上次成功的通道
    const all = [];
    if (sdkAvailable()) all.push('sdk');
    all.push('node');
    if (PREFERRED_TRANSPORT) {
      return all.slice().sort((a, b) => (a === PREFERRED_TRANSPORT ? -1 : b === PREFERRED_TRANSPORT ? 1 : 0));
    }
    return all;
  })();

  let lastErr = null;
  for (const ch of order) {
    try {
      const res = ch === 'sdk'
        ? await sdkRequest(urlStr, options, headers)
        : await nodeRequest(urlStr, options, headers);
      if (PREFERRED_TRANSPORT !== ch) {
        PREFERRED_TRANSPORT = ch;
        logI(`[transport] 采用 ${ch} 通道`);
      }
      if (SESSION_COOKIE.size) saveSessionCookie();
      return res;
    } catch (e) {
      lastErr = e;
      logE(`[transport] ${ch} 通道失败: ${(e && e.message) || e}`);
    }
  }
  throw lastErr || new Error('无可用传输通道');
}

// 基址容灾：相对路径按 HOSTS 顺序尝试（优选基址优先），网络错误/403/5xx/空体自动切下一个。
// 连通性自检：当所有基址都失败时，用一次最短请求判断是「DNS 失败 / TCP 被拒 /
// 连接超时 / 被 RST」，把结论打成一条明确的错误日志，避免宿主只看到「方法执行成功但没数据」。
async function diagnoseNetwork(host) {
  const startedAt = Date.now();
  try {
    const res = await httpRequest(`${host}/index.php`, { timeout: 6000 });
    const len = String(res.body || '').length;
    const cost = Date.now() - startedAt;
    if (res.statusCode === 403 && len < 200) {
      return `HTTP 403 + 仅 ${len}B（${cost}ms）→ Cloudflare 出口 IP 级拦截；换 UA/Cookie 无效，需 NINETYONE_PROXY_URL 换出口`;
    }
    if (res.statusCode >= 400) {
      return `HTTP ${res.statusCode} + ${len}B（${cost}ms）→ 站点/边缘拒绝，非解析问题`;
    }
    return `可达 (HTTP ${res.statusCode}, ${cost}ms, ${len}B)`;
  } catch (e) {
    const msg = String((e && e.message) || e);
    const code = String((e && e.code) || '');
    let hint = msg;
    if (/ENOTFOUND|EAI_AGAIN/i.test(code + msg)) hint = `DNS 解析失败 (${code || msg})`;
    else if (/ECONNREFUSED/i.test(code + msg)) hint = `TCP 连接被拒 (ECONNREFUSED)`;
    else if (/ETIMEDOUT|timeout|超时/i.test(code + msg)) hint = `连接/响应超时 (${Date.now() - startedAt}ms) —— 出口网络被阻断或过慢`;
    else if (/ECONNRESET|socket hang up/i.test(code + msg)) hint = `连接被重置 (ECONNRESET) —— 出口被中间设备掐断`;
    else if (/CERT|SSL|TLS/i.test(code + msg)) hint = `TLS 握手失败 (${code || msg})`;
    return `不可达: ${hint}`;
  }
}

/**
 * WAF 补救：部分机房 IP 在「无 cookie 首次访问」时会直接 403（响应体极短）。
 * 此时先请求站点根路径拿到 CLIPSHARE 等 cookie，再重试原路径，通常就能通过。
 */
async function warmupCookie(host) {
  try {
    const res = await httpRequest(`${host}/index.php`, { timeout: 12000 });
    const got = SESSION_COOKIE.size;
    logI(`[warmup] ${host} 预热结果 HTTP ${res.statusCode}，session cookie ${got} 个`);
    return got > 0 && res.statusCode === 200;
  } catch (e) {
    logI(`[warmup] ${host} 预热失败: ${e.message}`);
    return false;
  }
}

async function fetchWithFailover(path, options = {}) {
  const order = [PREFERRED, ...HOSTS.map((_, i) => i).filter(i => i !== PREFERRED)];
  let lastErr;
  for (const idx of order) {
    const host = HOSTS[idx];
    try {
      const res = await httpRequest(`${host}${path}`, options);
      // 视为失败的响应：5xx、403（Cloudflare 拦截/封禁）、空体
      // 失败判定：5xx / 403（Cloudflare 拦截或封禁）/ 200 但响应体过小（被截断或空壳）。
      // 注意：不能把「!res.body」直接判死——站点个别分类页会返回极短但合法的页面，
      // 一律重试会把正常空列表误当成故障，导致无谓切基址。
      const bodyLen = String(res.body || '').length;
      const tooSmall = res.statusCode === 200 && bodyLen < 512;
      // 403 + 极短响应体 + 极快返回 = 出口 IP 被 Cloudflare/防火墙拦截（请求没进应用层）。
      // 这类情况换 UA/Cookie 都无效，只能换出口，因此单独打出可执行的处置建议。
      const ipBlocked = res.statusCode === 403 && bodyLen < 200;
      if (ipBlocked) {
        logE(`[failover] ${host}${path} -> 403 且响应体仅 ${bodyLen}B（Cloudflare 出口 IP 拦截）`);
        if (!PROXY_URL && !globalThis.__ninetyoneIpBlockHinted) {
          globalThis.__ninetyoneIpBlockHinted = true;
          logE('[failover] 未配置 NINETYONE_PROXY_URL：换 UA/Cookie/Referer 均无效，必须换出口 IP');
          logE('[failover] 处置：NINETYONE_PROXY_URL=http://127.0.0.1:7890 或 socks5://user:pass@127.0.0.1:1080');
        }
        // 第一层补救：先用根路径建立会话 cookie，再重试原路径。
        // 实测站点对「无 cookie 的陌生机房 IP」会直接短 403，建 cookie 后多数可恢复。
        if (!options._cookieRetried) {
          const warmed = await warmupCookie(host);
          if (warmed) {
            logI(`[failover] ${host} 已建立 session cookie，重试原路径 ${path}`);
            try {
              const retryRes = await httpRequest(`${host}${path}`, Object.assign({}, options, { _cookieRetried: true }));
              const retryLen = String(retryRes.body || '').length;
              if (retryRes.statusCode < 400 && retryLen >= 512) {
                logI(`[failover] ${host}${path} 重试成功 HTTP ${retryRes.statusCode} ${retryLen}B`);
                return { ...retryRes, host, finalUrl: retryRes.finalUrl || `${host}${path}` };
              }
              logE(`[failover] ${host}${path} 带 cookie 重试仍失败 HTTP ${retryRes.statusCode} ${retryLen}B`);
            } catch (e2) {
              logE(`[failover] ${host}${path} 带 cookie 重试异常: ${e2.message}`);
            }
          } else {
            logE('[failover] 预热未取得 cookie，判定为出口 IP 被拦截');
            logE('[failover] 换 UA/Cookie 无效，需换出口：设置 NINETYONE_PROXY_URL=http://127.0.0.1:7890（或 socks5://...）');
          }
        }
      }
      if (res.statusCode >= 500 || res.statusCode === 403 || res.statusCode < 200 || tooSmall) {
        logE(`[failover] ${host}${path} -> HTTP ${res.statusCode}${tooSmall ? ` 响应体过小(${bodyLen}B)` : ''}, 切下一个`);
        lastErr = new Error(`HTTP ${res.statusCode}${tooSmall ? ' body too small' : ''}`);
        continue;
      }
      if (idx !== PREFERRED) { PREFERRED = idx; logI(`[failover] 切换优选基址 -> ${host}`); }
      return { ...res, host, finalUrl: res.finalUrl || `${host}${path}` };
    } catch (e) {
      logE(`[failover] ${host}${path} -> ${e.message}, 切下一个`);
      lastErr = e;
    }
  }
  // 全部基址失败：跑一次自检，把根因写进日志（宿主界面只看得到「执行成功/失败」）
  const diag = await diagnoseNetwork(HOSTS[0]);
  logE(`[failover] 所有基址失败（已试 ${order.length} 个）。网络自检 → ${diag}`);
  throw lastErr || new Error('所有基址均不可用');
}

// 清洗站点文本：去标签/实体，并剔除 91porn 标题里大量插入的变体选择符(U+FE00-FE0F)、零宽字符、软连字符。
// 列表页标题常带 [原创]/[国产] 之类营销前缀，与详情页真实片名不同，统一剥离。
function cleanText(s, stripPrefix) {
  let t = String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (stripPrefix) t = t.replace(/^\s*\[[^\]]{1,12}\]\s*/g, '').trim();
  return t;
}

// 简介保留 <br> 换行，其余按 cleanText 规则清洗。
function cleanDesc(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF\u00AD]/g, '')
    .split('\n').map(x => x.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}

// 从详情页主区抓取统计信息（时长/热度/留言/收藏/积分），只限 #useraction 区，避免误抓推荐区。
function extractDetailStat(html, label) {
  const uaM = html.match(/<div[^>]*id=["']useraction["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!uaM) return '';
  const m = uaM[1].match(new RegExp(label + '\\s*[:：]\\s*<span[^>]*>([\\s\\S]*?)<\\/span>', 'i'));
  return m ? cleanText(m[1]) : '';
}

// 从详情页提取「作者」（只认主信息区那一次出现）。
// 站点在相关推荐区里也重复输出「作者:」，因此先截断到主信息区窗口再匹配。
function extractAuthor(html) {
  const text = String(html || '');
  const firstIdx = text.search(/作者\s*[:：]/);
  if (firstIdx < 0) return '';
  // 主信息区作者紧跟在标题/添加时间附近；向后取 1200 字符足够覆盖 A/B/C 三种形态，
  // 且远小于到第一个推荐卡的距离（实测 >4KB）。
  const window = text.slice(firstIdx, firstIdx + 1200);

  // A) <span class="title-yakov"> ... <span class="title">名字< ...
  const a = window.match(/<span[^>]*class=["']title["'][^>]*>\s*([^<]{1,40})</i);
  if (a) {
    const name = cleanText(a[1]);
    if (name && !/^\d+(\s*小时|\s*分钟|\s*天|\s*秒)?\s*前?$/.test(name)) return name;
  }

  // B) 作者:</span> 名字 <br>
  const b = window.match(/作者\s*[:：]?\s*<\/span>\s*([^<\n\r]{1,40})/i);
  if (b) {
    const name = cleanText(b[1]);
    // 过滤掉「添加时间/热度/收藏」等相邻字段被误吞的情况
    if (name && !/^(添加时间|热度|收藏|留言|积分)/.test(name) && !/^\d+\s*(小时|分钟|天|秒)/.test(name)) {
      return name.replace(/\s*(小时|分钟)?\s*前$/, '').trim();
    }
  }

  // C) 旧 ASCII 名
  const c = window.match(/作者[\s\S]{0,400}?<span[^>]*class=["']title["'][^>]*>\s*([A-Za-z0-9_.\-]{2,40})/i);
  return c ? c[1] : '';
}

// 91porn 2026-11-04 起在详情页尾部挂「title loader」反混淆：
// 静态 <title>/<h4>/作者/时长 每次请求都是随机假值，真实片名/作者/时长藏在隐藏 <i> 的
// data-xxx / data-xxxu / data-xxxd 属性里，由脚本里的 m(编码模式) + k(xor key) 解密。
// 浏览器端靠 2~6 秒延时或首次交互才把真值替换回 DOM；服务端直接读 HTML 必须自己解。
function decode95Payload(e, mode, key) {
  if (!e || !key) return '';
  try {
    let buf;
    if (mode === 1) {
      buf = Buffer.from(String(e).replace(/[^0-9a-f]/gi, ''), 'hex');
    } else {
      let s = String(e);
      if (mode === 2) s = s.split('').reverse().join('');
      while (s.length % 4) s += '=';
      buf = Buffer.from(s, 'base64');
      if (mode === 4) buf = Buffer.from(buf).reverse();
    }
    const k = Buffer.from(String(key), 'utf-8');
    if (!buf.length || !k.length) return '';
    const out = Buffer.alloc(buf.length);
    for (let j = 0; j < buf.length; j++) out[j] = buf[j] ^ k[j % k.length];
    return out.toString('utf-8');
  } catch (_) { return ''; }
}

function extract95RealMeta(html) {
  const meta = { ok: false, title: '', author: '', duration: '', at: '', mode: 0 };
  // 脚本形态：var m=1,id="x8fbfd3",at="data-0a918",k="a4d247ed";
  const cfgM = html.match(/var\s+m\s*=\s*(\d+)\s*,\s*id\s*=\s*["']([^"']+)["']\s*,\s*at\s*=\s*["']([^"']+)["']\s*,\s*k\s*=\s*["']([^"']*)["']/i);
  if (!cfgM) return meta;
  const mode = parseInt(cfgM[1], 10);
  const id = cfgM[2], at = cfgM[3], key = cfgM[4];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const elM = html.match(new RegExp('<i[^>]*\\bid=["\']?' + esc(id) + '["\']?[^>]*>', 'i'));
  if (!elM) return meta;
  const el = elM[0];
  const attr = (name) => {
    const m = el.match(new RegExp('(?:^|\\s)' + esc(name) + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
    return m ? m[1] : '';
  };
  const strip = (s) => cleanText(s).replace(/[\uFE00-\uFE0F]/g, '').trim();
  meta.mode = mode; meta.at = at;
  meta.title = strip(decode95Payload(attr(at), mode, key));
  meta.author = strip(decode95Payload(attr(at + 'u'), mode, key));
  const secs = strip(decode95Payload(attr(at + 'd'), mode, key));
  const n = parseInt(secs, 10);
  if (Number.isFinite(n) && n > 0) {
    const p2 = (x) => (x < 10 ? '0' : '') + x;
    meta.duration = `${p2(Math.floor(n / 3600))}:${p2(Math.floor(n / 60) % 60)}:${p2(n % 60)}`;
  }
  meta.ok = !!(meta.title || meta.author || meta.duration);
  return meta;
}

// 91porn 列表页反爬实测结论（2026-11，3 份列表页 x 24 viewkey 全量核对）：
//   * 同一 viewkey 会在列表页出现多个卡片（主列表区 + 推荐/相关区），且列表页每次请求
//     都把「标题 / 封面 img src / 作者 / 时长 / playvthumb_ID」在卡片间随机打乱。
//     于是同一封面被贴到多张卡（封面重复），列表封面/标题与详情页真实视频对不上。
//   * 判别真值卡的可靠信号（实测 72 组卡片零假阳性零漏判）：
//       卡片内 playvthumb_<ID> 的数字 == img src 的 /thumb/<ID>.jpg 数字
//     —— 这个「真值卡」的 ID == 详情页 <video poster=".../thumb/<同一ID>.jpg">，
//        跨请求稳定、逐 viewkey 唯一；其标题、作者、时长也都是真值。
//     其余「污染卡」的 playvthumb_ID、img_ID、标题彼此不一致，全是被打乱的假值。
//   * 详情页 <title> 与 <video poster> 是权威真值（多次请求完全一致）；
//     title loader 反混淆配置时有时无，有配置时隐藏 <i> data-* 解密值同样为真值。
// 因此：parseList 按 viewkey 分组、只保留「真值卡」，用真值卡 ID 拼 CDN 封面（零额外请求、
//       绝对正确、不重复），标题直接用真值卡标题；enrichListTitles 再以「缓存 + 限并发」
//       抓详情页 <title> 做二次确认/兜底，失败不阻塞、降级保留真值卡标题。
// CDN 封面基址（从列表 img 提取 host），形如 https://xxx/thumb/1257796.jpg
const THUMB_HOST_RE = /https?:\/\/[^"'\/]+\/thumb\//i;
const REAL_TITLE_MEM = new Map();      // viewkey -> { title, exp } 进程内
const REAL_TITLE_TTL = 6 * 3600;       // 真实标题缓存 6h
const ENRICH_CONCURRENCY = 4;          // 列表标题回填限并发
const LIST_TITLE_CACHE = new Map();    // viewkey -> 真值卡标题（enrich 失败时的兜底）

function buildCacheKey(prefix, raw) {
  let s = String(raw || '');
  // SDK 缓存 key 有长度上限，超长一律哈希归一化
  if (s.length > 160) s = require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 24);
  return `${prefix}:${s}`;
}
async function getCachedRealTitle(viewkey) {
  const mem = REAL_TITLE_MEM.get(viewkey);
  if (mem && mem.exp > Date.now()) return mem.title;
  try {
    const v = await OmniBox.getCache(buildCacheKey('91real', viewkey));
    if (v) {
      const t = typeof v === 'string' ? v : String(v);
      REAL_TITLE_MEM.set(viewkey, { title: t, exp: Date.now() + REAL_TITLE_TTL * 1000 });
      return t;
    }
  } catch (_) {}
  return '';
}
async function setCachedRealTitle(viewkey, title) {
  if (!viewkey || !title) return;
  REAL_TITLE_MEM.set(viewkey, { title, exp: Date.now() + REAL_TITLE_TTL * 1000 });
  try { await OmniBox.setCache(buildCacheKey('91real', viewkey), String(title), REAL_TITLE_TTL); } catch (_) {}
}

// 从详情页 HTML 提取「真实标题」：优先级 静态 <title> > h4.login_register_header > title loader 解密。
// 实测 <title> 稳定等于真值；loader 有配置时解密值亦为真值，二者一致。
function extractRealTitle(html) {
  const tagM = html.match(/<title>([\s\S]*?)<\/title>/i);
  let t = tagM ? cleanText(tagM[1]).replace(/\s*-\s*91porn\s*$/i, '').trim() : '';
  if (t && !/^\s*91porn\s*$/i.test(t)) return t;
  const h4M = html.match(/<h4[^>]*class=["'][^"']*login_register_header[^"']*["'][^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i)
    || html.match(/<h4[^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i);
  t = h4M ? cleanText(h4M[1], true) : '';
  if (t) return t;
  const realMeta = extract95RealMeta(html);
  return realMeta.ok && realMeta.title ? realMeta.title : '';
}

// 列表标题回填：限并发抓取详情页 <title>，命中缓存直接跳过；失败不阻塞、降级保留列表标题。
// 列表标题回填：限并发抓详情页做「二次确认」。
// 性能约束（实测）：24 条 × 抓详情 ≈ 5.9s，网络抖动时可拖到 41s。
// 宿主对 home/category 有响应时间预期，超时会导致拿不到结果/解析异常。
// 因此这里做三件事：
//   1) 只补「缓存未命中」的条目，命中缓存零请求；
//   2) 设置整体截止时间（默认 4s），到点立即返回已完成的回填结果，剩余走后台；
//   3) 真值卡标题本身已正确，回填只是增强，绝不阻塞主流程。
async function enrichListTitles(list, tag, opts) {
  if (!Array.isArray(list) || !list.length) return list;
  const options = opts || {};
  const budgetMs = Number.isFinite(options.budgetMs)
    ? options.budgetMs
    : Number(process.env.NINETYONE_ENRICH_BUDGET_MS || 4000);
  const queue = list.slice();
  let ok = 0, cached = 0, failed = 0, skipped = 0;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, budgetMs);
  // race 返回后 worker 仍会跑完当前请求；用 aborted 让它们尽快退出，避免后台继续压站点
  let aborted = false;

  const worker = async () => {
    while (queue.length) {
      // 到点或被中止就停，剩余条目保留真值卡标题（本来就是对的）
      if (aborted || Date.now() > deadline) {
        skipped += queue.length;
        queue.length = 0;
        return;
      }
      const item = queue.shift();
      if (!item || !item.vod_id) continue;
      try {
        const hit = await getCachedRealTitle(item.vod_id);
        if (hit) { item.vod_name = hit; cached++; continue; }
        const res = await fetchWithFailover(`/view_video.php?viewkey=${item.vod_id}`, {
          headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          timeout: Math.min(8000, Math.max(1500, deadline - Date.now())),
        });
        const real = extractRealTitle(res.body || '');
        if (real) {
          item.vod_name = real;
          LIST_TITLE_CACHE.set(item.vod_id, real);
          await setCachedRealTitle(item.vod_id, real);
          ok++;
        } else failed++;
      } catch (e) { failed++; }
    }
  };

  const workers = Array.from(
    { length: Math.min(ENRICH_CONCURRENCY, list.length) },
    () => worker(),
  );
  const all = Promise.all(workers);
  // 双保险：即使某个 worker 卡在网络超时上，也按预算硬切，不让渲染被拖死
  await Promise.race([
    all,
    sleep(Math.max(0, deadline - Date.now())).then(() => { aborted = true; }),
  ]);

  logI(`[${tag}][enrich] 标题回填 用时=${Date.now() - startedAt}ms 命中缓存=${cached} 新抓成功=${ok} 失败降级=${failed} 超预算跳过=${skipped} 总数=${list.length}`);
  return list;
}

// 解析站点分页元信息：页面上有「视频 457 - 480 的 149753」。
// 实测硬上限 20 页：page>=21 一律回落成 457-480（站点把深页重置为末页），
// 因此必须用这里的 total 自己算 pagecount，不能写死 99。
const PAGE_SIZE = 24;
function parsePageMeta(html, isSearch) {
  const text = String(html || '');
  // 视频列表：「视频 457 - 480 的 149753」
  // 搜索页  ：「搜索结果 1 - 24 的 6332」
  const m = text.match(/(?:搜索结果|视频)\s*(\d+)\s*-\s*(\d+)\s*的\s*(\d+)/);
  if (!m) return { from: 0, to: 0, total: 0, pageSize: PAGE_SIZE, maxPage: 0 };
  const from = parseInt(m[1], 10) || 0;
  const to = parseInt(m[2], 10) || 0;
  const total = parseInt(m[3], 10) || 0;
  const pageSize = to > from ? (to - from + 1) : PAGE_SIZE;
  const naturalMax = Math.max(1, Math.ceil(total / pageSize) || 1);
  // 实测：视频列表 page>=21 会被站点重置为末页(457-480)，只能翻 20 页；
  // 搜索页没有这个限制（page=100 正常返回 2377-2400），故不钳制。
  const maxPage = isSearch ? naturalMax : Math.max(1, Math.min(naturalMax, 20));
  return { from, to, total, pageSize, maxPage };
}

function parseList(html) {
  // 取列表里 CDN 封面基址（host 固定），用于按真值卡 ID 拼稳定封面。
  const hostM = html.match(THUMB_HOST_RE);
  const thumbBase = hostM ? hostM[0] : '';
  // 收集所有候选卡片：按 viewkey 分组（同一 viewkey 有真值卡 + 若干污染卡）。
  // 卡片形态：<a href="...viewkey=..."> ... id="playvthumb_<ID>" ... <img src=".../thumb/<ID2>.jpg"> ... <span class="video-title">TITLE</span> ... </a>
  const byVk = new Map();
  // 链接有两种形态：普通区 view_video.php，高清分类区 view_video_hd.php（实测 hd 分类全是后者，
  // 旧正则只认 view_video.php，导致「高清」分类永远 0 条）。统一用 view_video[_hd].php 匹配。
  const blockRe = /<a[^>]*href="[^"]*view_video(?:_hd)?\.php\?viewkey=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const viewkey = m[1];
    const block = m[2];
    const imgM = block.match(/<img[^>]*src="([^"]*thumb[^"]*)"[^>]*>/i) || block.match(/<img[^>]*class="img-responsive"[^>]*src="([^"]+)"[^>]*>/i);
    if (!imgM) continue;
    const ptM = block.match(/playvthumb_(\d+)/i);
    const imgIdM = imgM[1].match(/\/(\d+)\.jpg/i);
    const titleM = block.match(/<span[^>]*class="[^"]*video-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const cand = {
      ptId: ptM ? ptM[1] : '',
      imgId: imgIdM ? imgIdM[1] : '',
      imgUrl: imgM[1],
      title: cleanText(titleM ? titleM[1] : '', true),
      // 判别信号：playvthumb_ID == img_ID 才是未被打乱的真值卡
      isReal: !!(ptM && imgIdM && ptM[1] === imgIdM[1])
    };
    if (!byVk.has(viewkey)) byVk.set(viewkey, []);
    byVk.get(viewkey).push(cand);
  }
  const list = [];
  let realCount = 0, fallbackCount = 0;
  for (const [viewkey, cands] of byVk) {
    // 优先真值卡；若无（极端情况全被打乱）退回第一张卡，保证有结果。
    let c = cands.find(x => x.isReal);
    if (c) realCount++;
    else { c = cands[0]; fallbackCount++; }
    const realId = c.ptId || c.imgId;
    // 封面用真值卡 ID 拼 CDN 地址（稳定、不重复）；无 ID 时退回落列表 img。
    const cover = (realId && thumbBase) ? `${thumbBase}${realId}.jpg` : c.imgUrl;
    let title = c.title || viewkey;
    // 标题真值（真值卡标题）记入缓存，供 detail()/enrich 失败时兜底。
    if (title && title !== viewkey) LIST_TITLE_CACHE.set(viewkey, title);
    list.push({ vod_id: viewkey, vod_name: title, vod_pic: cover, vod_tag: 'video' });
  }
  logI(`[parseList] 卡片分组=${byVk.size} 真值卡命中=${realCount} 无真值卡降级=${fallbackCount}`);
  return list;
}

async function home(params) {
  const T0 = Date.now();
  logI(`[home] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const res = await fetchWithFailover(`/index.php`);
    logI(`[home] 取页完成 ${Date.now() - T0}ms 来源=${res.host}`);
    // 首页首屏对延迟最敏感：真值卡标题本身已正确（实测与详情页 8/8 一致），
    // 标题回填只是「二次确认」，默认关闭以免拖慢首屏。需要时用 NINETYONE_HOME_ENRICH_MS 开启。
    const homeEnrichMs = Number(process.env.NINETYONE_HOME_ENRICH_MS || 0);
    let list = parseList(res.body);
    if (homeEnrichMs > 0) {
      list = await enrichListTitles(list, 'home', { budgetMs: homeEnrichMs });
    } else {
      logI('[home] 标题回填已跳过（默认关闭，真值卡标题已正确）');
    }
    logI(`[home] 命中 ${res.host} 返回 ${list.length} 条 总耗时=${Date.now() - T0}ms`);
    return { class: CATEGORIES, list };
  } catch (e) {
    logE(`[home] 失败(${Date.now() - T0}ms): ${e.message}`);
    logE('[home] 返回空列表；若宿主界面显示「方法执行成功」但无数据，请看上面 failover 的自检结论');
    return { class: CATEGORIES, list: [] };
  }
}

async function category(params) {
  const T0 = Date.now();
  logI(`[category] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const tid = (params && (params.categoryId || params.type_id || params.tid)) || 'hot';
    const page = parseInt((params && (params.page || params.pg)) || '1', 10) || 1;
    let path;
    if (tid === 'hot' || tid === 'watch') {
      path = `/v.php?next=watch&page=${page}`;
    } else if (tid.includes('&')) {
      path = `/v.php?category=${tid}&page=${page}`;
    } else {
      path = `/v.php?category=${tid}&viewtype=basic&page=${page}`;
    }
    const res = await fetchWithFailover(path);
    logI(`[category] 取页完成 ${Date.now() - T0}ms 来源=${res.host}`);
    let body = res.body;
    let list = parseList(body);
    // 站点偶发抖动会返回「页面正常但 0 条卡片」，同基址补抓一次再放弃
    if (!list.length) {
      logI(`[category] ${tid} page=${page} 首次 0 条，重试一次`);
      await sleep(350);
      const retry = await fetchWithFailover(path, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } });
      body = retry.body;
      list = parseList(body);
    }
    const meta = parsePageMeta(body);
    // 站点 page>=21 会被重置为末页（457-480），钳制到有效区间，避免宿主无限翻页
    const effPage = Math.min(page, meta.maxPage || page);
    const categoryEnrichMs = Number(process.env.NINETYONE_CATEGORY_ENRICH_MS || 1200);
    const enriched = categoryEnrichMs > 0
      ? await enrichListTitles(list, 'category', { budgetMs: categoryEnrichMs })
      : list;
    if (effPage !== page) {
      logI(`[category] 请求页 ${page} 超过站点上限，已钳制为第 ${effPage} 页（总 ${meta.total} 条）`);
    }
    logI(`[category] 命中 ${res.host} tid=${tid} page=${effPage} 返回 ${enriched.length} 条 total=${meta.total || '-'} 总耗时=${Date.now() - T0}ms`);
    return {
      page: effPage,
      pagecount: meta.maxPage || effPage,
      limit: meta.pageSize || PAGE_SIZE,
      total: meta.total || 0,
      list: enriched,
    };
  } catch (e) {
    logE(`[category] 失败(${Date.now() - T0}ms): ${e.message}`);
    return { page: 1, pagecount: 1, limit: 20, total: 0, list: [] };
  }
}

async function detail(params) {
  logI(`[detail] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.vod_id || params.id || params.videoId)) || '';
    const viewkey = String(raw).split('#')[0].trim();
    if (!viewkey) return { list: [] };
    const res = await fetchWithFailover(`/view_video.php?viewkey=${viewkey}`, {
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    const host = res.host;
    const html = res.body;
    // 不存在的 viewkey 会被站点 302 到 error.php?type=video_missing（HTTP 200 + 空壳页）。
    // 这类页面没有 player_one / #useraction，原实现会返回一条「标题=viewkey、无封面无简介」的
    // 空壳条目，宿主点进去才发现没内容。这里直接判定为无效视频返回空列表。
    const isMissingVideo = /type=video_missing/i.test(String(res.finalUrl || ''))
      || (!/id=["']player_one["']/i.test(html) && !/id=["']?useraction["']?/i.test(html));
    if (isMissingVideo) {
      logI(`[detail] 视频不存在或已删除 viewkey=${viewkey}（命中 error.php / 空壳页），返回空列表`);
      return { list: [] };
    }
    // 标题真值来源（实测修正，推翻旧注释「静态 <title> 是随机假值」的认知）：
    //   * 91porn 被打乱的是【列表页】；详情页 <title> / <video poster> 多次请求完全稳定、逐 viewkey 唯一，是权威真值。
    //   * title loader 反混淆配置时有时无，有配置时隐藏 <i> 的 data-* 解密值同样为真值，与 <title> 一致。
    //   * 列表页缓存的标题已被打乱，优先级最低，仅作兜底。
    // 页面底部「本月热播中」推荐区的 <span class="video-title"> 绝不能当当前视频标题。
    const realMeta = extract95RealMeta(html);
    const detailH4M = html.match(/<h4[^>]*class=["'][^"']*login_register_header[^"']*["'][^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i)
      || html.match(/<h4[^>]*align\s*=\s*["']?left["']?[^>]*>([\s\S]*?)<\/h4>/i);
    let title = extractRealTitle(html);           // 详情 <title> > h4 > loader 解密（均为真值）
    let titleFrom = 'detail_page(静态真<title>/loader)';
    if (!title && realMeta.ok && realMeta.title) { title = realMeta.title; titleFrom = 'title_loader(解密真实片名)'; }
    if (!title && LIST_TITLE_CACHE.has(viewkey)) {
      title = LIST_TITLE_CACHE.get(viewkey);
      titleFrom = 'list_title_cache(已被打乱,仅兜底)';
    }
    if (!title && detailH4M) { title = cleanText(detailH4M[1]); titleFrom = 'h4.login_register_header[align=left](静态回退)'; }
    if (!title) { title = viewkey; titleFrom = 'viewkey(fallback)'; }
    // 详情真值写回双层缓存，供列表 enrichListTitles 直接命中，避免重复抓详情。
    if (title && title !== viewkey) {
      LIST_TITLE_CACHE.set(viewkey, title);
      await setCachedRealTitle(viewkey, title);
    }
    // 封面：优先主播放器 <video id="player_one" poster="...">（= 真实视频ID，跨请求稳定），绝不使用推荐区 img-responsive。
    const posterM = html.match(/<video[^>]*id=["']player_one["'][^>]*poster=["']([^"']+)["']/i)
      || html.match(/poster=["']([^"']+)["']/i);
    const cover = posterM ? posterM[1] : '';
    // 详情页元数据：真实作者/时长优先用 title loader 解密值，其余取 #useraction 统计区 / 视频信息区 / #v_desc 简介区。
    const duration = realMeta.duration || extractDetailStat(html, '时长');
    const views = extractDetailStat(html, '热度');
    const comments = extractDetailStat(html, '留言');
    const favorites = extractDetailStat(html, '收藏');
    const dateM = html.match(/添加时间[\s\S]{0,200}?(\d{4}-\d{2}-\d{2})/i);
    const addDate = dateM ? dateM[1] : '';
    // 作者解析（实测修正）：详情页有 3 类形态，且只有主信息区那处是真值，
    // 后面的「相关推荐 / 本月热播」每张卡也带「作者:」字样，绝不能顺扫到它们。
    //   A) 实心卡：作者: </span> <span class="title-yakov"> <a ...><span class="title">名字<a ...i></a>...
    //   B) 纯文本：作者:</span> 名字 <br>
    //   C) 旧 ASCII 名：作者: ... <span class="title">name
    // 策略：先限定在主信息区（取第一次出现的「作者」前的窗口），并按 A→B→C 依次尝试。
    const author = realMeta.author || extractAuthor(html);
    const descM = html.match(/<div[^>]*id=["']?v_desc["']?[^>]*>([\s\S]*?)<\/div>/i);
    const content = descM ? cleanDesc(descM[1]) : '';
    const remarksParts = [duration && `时长 ${duration}`, views && `热度 ${views}`, addDate].filter(Boolean);
    const vod_remarks = remarksParts.join(' · ');
    const vod_content = [
      title,
      author && `作者：${author}`,
      addDate && `添加时间：${addDate}`,
      duration && `时长：${duration}`,
      views && `热度：${views}`,
      comments && `留言：${comments}`,
      favorites && `收藏：${favorites}`,
      content && `\n${content}`
    ].filter(Boolean).join('\n').trim();
    logI(`[detail] 命中 ${host} viewkey=${viewkey} 标题="${title.slice(0, 60)}" 来源=${titleFrom} titleLoader=${realMeta.ok ? `命中(m=${realMeta.mode},${realMeta.at})` : '未命中'} 封面=${cover ? '有' : '无'} 作者=${author || '-'} 时长=${duration || '-'} 简介长度=${content.length}`);
    return {
      list: [{
        vod_id: viewkey,
        vod_name: title,
        vod_pic: cover,
        vod_content,
        vod_actor: author,
        vod_year: addDate ? addDate.slice(0, 4) : '',
        vod_remarks,
        type_name: '91porn',
        vod_play_from: '91porn',
        vod_play_url: `播放$${viewkey}`,
        vod_play_sources: [{ name: '91porn', episodes: [{ name: '播放', playId: viewkey }] }]
      }]
    };
  } catch (e) {
    logE(`[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params) {
  logI(`[search] 入口参数=${JSON.stringify(params || {})}`);
  try {
    const kw = String((params && (params.keyword || params.wd || params.key)) || '').trim();
    if (!kw) return { page: 1, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
    const page = parseInt((params && (params.page || params.pg)) || '1', 10) || 1;
    // 实测修正：站点搜索支持 page 参数（page=100 能取到 2377-2400），
    // 但原实现没带 page，导致宿主翻页时永远拿到第一页。
    const path = `/search_result.php?search_id=${encodeURIComponent(kw)}&search_type=search_videos&page=${page}`;
    const res = await fetchWithFailover(path);
    const meta = parsePageMeta(res.body, true);
    const searchEnrichMs = Number(process.env.NINETYONE_SEARCH_ENRICH_MS || 1500);
    let list = parseList(res.body);
    if (searchEnrichMs > 0) list = await enrichListTitles(list, 'search', { budgetMs: searchEnrichMs });
    // 搜索结果总数标记形如「搜索结果 1 - 24 的 6332」，与视频列表的「视频 1 - 24 的 N」不同
    logI(`[search] 命中 ${res.host} "${kw}" page=${page} 返回 ${list.length} 条 total=${meta.total || '-'} pagecount=${meta.maxPage || '-'}`);
    return {
      page,
      pagecount: meta.maxPage || page,
      total: meta.total || 0,
      limit: meta.pageSize || PAGE_SIZE,
      list,
    };
  } catch (e) {
    logE(`[search] 失败: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, limit: PAGE_SIZE, list: [] };
  }
}

// 91porn 播放页把真实 <source> 藏在 document.write(strencode2("%3c%73%6f...")) 里，
// strencode2 就是 /js/m2.js 里的 unescape，解码后得到带签名的 mp4 直链（cdn77 / btc620 两类 host）。
// 同时页面里混有两类污染源，必须排除：
//   1) HTML 注释里的 <source src="https://ccm.91p52.com/..."> —— 诱饵，TLS 握手直接失败
//   2) player.preroll({ src: "https://g-br-cdn.kwai.net/.../ad-i18n-dsp/...mp4" }) —— 片前广告
// 旧逻辑三条正则恰好只抓到「诱饵 + 广告」，且 sniff 播放页会被 preroll 抢先加载广告。
const AD_URL_RE = /(?:preroll|ad-i18n-dsp|\/ad\/|advert|ads?\.)/i;

function extractRealMp4List(html) {
  if (!html) return [];
  const list = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || seen.has(u)) return;
    let parsed;
    try { parsed = new URL(u); } catch (_) { return; }
    // 黑名单排除污染源；站点 CDN 会轮换（speed.php 的 A=btc620 / H=cdn77 / I=cns.killcovid2021，
    // 以及 la.btc620.com 等），用白名单容易漏掉 VIP 线路，故只剔除已知坏链。
    if (!/^https?:$/i.test(parsed.protocol) || !/\.mp4(\?|$)/i.test(u)) return;
    if (AD_URL_RE.test(u) || /ccm\.91p52\.com/i.test(parsed.hostname)) return;
    // 站点 btc620 线路会给出 host 后带双斜杠的地址（https://la.btc620.com//mp43/x.mp4）。
    // Node/http 能容忍，但部分播放器/Kodi 解析会失败，统一规范成单斜杠。
    const normalized = u.replace(/^(https?:\/\/[^/]+)\/{2,}/i, '$1/');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    list.push(normalized);
  };
  // 1) 主路径：strencode2 百分号编码里的 <source src='...'>
  const re = /strencode2\(\s*["']([^"']+)["']\s*\)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let decoded;
    try { decoded = decodeURIComponent(m[1]); } catch (_) { decoded = unescape(m[1]); }
    decoded = decoded.replace(/&amp;/g, '&');
    const srcM = decoded.match(/<source[^>]*src=['"]([^'"]+\.mp4[^'"]*)['"]/i);
    if (srcM) push(srcM[1]);
  }
  // 2) 兼容旧版：页面里直接可见的真实 <source>（先剔除注释，避免诱饵混进来）
  const visible = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const visRe = /<source[^>]*src=['"]([^'"]+\.mp4[^'"]*)['"]/gi;
  while ((m = visRe.exec(visible)) !== null) push(m[1]);
  // 3) 兼容部分线路把地址放在 player 初始化对象里（排除 preroll 区块，避免广告混入）
  const playerPart = visible.split(/preroll\s*\(/i)[0];
  const jsRe = /(?:file|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/gi;
  while ((m = jsRe.exec(playerPart)) !== null) push(m[1]);
  // 4) 兼容 player.src("...mp4") 这类直接调用写法（同样只在 preroll 之前）
  const callRe = /\.src\(\s*["']([^"']+\.mp4[^"']*)["']/gi;
  while ((m = callRe.exec(playerPart)) !== null) push(m[1]);
  return list;
}

// 判断直链是否仍可播：优先 HEAD，失败再试 Range GET；只认 200/206 + video/mp4。
// 签名短时效 + 绑 IP，过期或被拒时让调用方及时回退到重新取页。
function probeMediaUrl(url, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(false); }
    const client = u.protocol === 'https:' ? https : http;
    const doReq = (method, extra, done) => {
      const req = client.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method,
          headers: Object.assign({ 'User-Agent': USER_AGENT, Accept: '*/*' }, headers || {}, extra), timeout: 8000, rejectUnauthorized: false },
        (res) => {
          const code = res.statusCode;
          const ctype = String(res.headers['content-type'] || '');
          res.destroy();
          // 站点 CDN 偶尔回 application/octet-stream 甚至空 content-type，
          // 只要 2xx 且不是 text/html 就算可用（text/html 通常是 403/404 的伪装页）。
          const okStatus = code >= 200 && code < 300;
          const notHtml = !/text\/html/i.test(ctype);
          done(okStatus && notHtml);
        }
      );
      req.on('error', () => done(false));
      req.on('timeout', () => { req.destroy(); done(false); });
      req.end();
    };
    doReq('HEAD', {}, (ok) => {
      if (ok) return resolve(true);
      doReq('GET', { Range: 'bytes=0-1023' }, resolve);
    });
  });
}

// 复现「推荐栏能播」的播放页形态：不带 page/viewtype/category 实际值，
// 只带首页链接里的 c=uyklk 与空参；宿主预热后 preroll 1 秒广告窗口已过，sniff 命中真实 <source>。
function buildSniffPageUrl(host, viewkey) {
  return `${host}/view_video.php?viewkey=${encodeURIComponent(viewkey)}&c=uyklk&viewtype=&category=`;
}

// 取播放页并解出 strencode2 里的真实 mp4；签名短时效，失败时带 cache-buster 重取一次。
async function resolveRealMp4(viewkey) {
  // 站点每次请求会随机二选一 CDN（btc620 / cdn77）。单条直链一旦在客户端侧不可达
  // 就没有备用线路，因此这里最多取两轮页面，把两轮解出的不同 CDN 地址都攒起来，
  // 让宿主/播放器有可切换的备用线路。
  const picked = [];
  const seenHost = new Set();
  let lastRes = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1 && picked.length >= 2) break;
    const path = `/view_video.php?viewkey=${viewkey}${attempt > 1 ? `&_r=${Date.now()}` : ''}`;
    try {
      const res = await fetchWithFailover(path, {
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
      });
      if (!lastRes) lastRes = res;
      const urls = extractRealMp4List(res.body || '');
      logI(`[play][resolve] 第${attempt}次 命中 ${res.host} 解出 ${urls.length} 条真实直链`);
      for (const u of urls) {
        let h = '';
        try { h = new URL(u).hostname; } catch (_) { h = ''; }
        // 同一 CDN 只收第一条，保证备用线路来自不同 CDN
        if (h && seenHost.has(h)) continue;
        if (h) seenHost.add(h);
        picked.push(u);
      }
    } catch (e) {
      logE(`[play][resolve] 第${attempt}次取页失败: ${e.message}`);
    }
  }

  if (picked.length) logI(`[play][resolve] 合计可用直链 ${picked.length} 条（含 ${seenHost.size} 个 CDN）`);
  return { urls: picked, res: lastRes };
}

async function play(params, context) {
  const from = (context && context.from) || (params && params.from) || 'web';
  logI(`[play] 入口参数=${JSON.stringify(params || {})} from=${from} playMode=${NINETYONE_PLAY_MODE}`);
  try {
    const raw = typeof params === 'string' ? params : (params && (params.playId || params.play_id || params.id || params.url || params.vod_id)) || '';
    const viewkey = String(raw).trim().split('#')[0];
    if (!viewkey) return { urls: [], parse: 0 };

    // 代理模式：代理与取流同机（同 IP），自行取签名+取流。
    if (NINETYONE_PROXY_BASE) {
      const proxyUrl = `${NINETYONE_PROXY_BASE}/91.mp4?viewkey=${encodeURIComponent(viewkey)}`;
      logI(`[play] ${viewkey} -> 视频代理 ${proxyUrl}`);
      return { urls: [{ name: '代理', url: proxyUrl }], header: { 'User-Agent': USER_AGENT }, parse: 0 };
    }

    const mode = ['auto', 'direct', 'sniff', 'always'].includes(NINETYONE_PLAY_MODE) ? NINETYONE_PLAY_MODE : 'auto';
    const { urls: realUrls, res } = mode === 'sniff' ? { urls: [], res: null } : await resolveRealMp4(viewkey);
    const host = res ? res.host : (HOSTS[PREFERRED] || PRIMARY_API);
    const pageUrl = `${host}/view_video.php?viewkey=${viewkey}`;
    const sniffUrl = buildSniffPageUrl(host, viewkey);
    // 播放器拉流只需要 UA + Referer；带上 Origin 会被部分播放器当作跨域请求拒绝，
    // 而 CDN 侧实测并不校验 Origin，因此这里不再下发 Origin。
    const PLAY_HEADER = { 'User-Agent': USER_AGENT, Referer: pageUrl };
    const HEADER = PLAY_HEADER;

    // 真实直链探活：cdn77 / btc620 实测裸 HEAD 200 video/mp4、Range 206，不依赖 Referer。
    let healthy = [];
    let ordered = [];
    if (realUrls.length) {
      const probes = await Promise.all(realUrls.map((u) => probeMediaUrl(u, HEADER)));
      healthy = realUrls.filter((_, i) => probes[i]);
      ordered = healthy.length ? [...healthy, ...realUrls.filter((u) => !healthy.includes(u))] : realUrls;
    }
    const directUsable = mode !== 'sniff' && healthy.length > 0;
    const wantSniff = mode === 'sniff' || mode === 'always' || (mode === 'auto' && !directUsable);
    const directUrls = directUsable
      ? ordered.map((u, i) => ({ name: i === 0 ? '真实直链' : `备用直链${i}`, url: u }))
      : [];

    if (wantSniff) {
      const why = mode === 'sniff' ? '强制嗅探模式'
        : mode === 'always' ? '双线路模式'
        : `真实直链不可用(解出${realUrls.length}条/探活${healthy.length}条)`;
      logI(`[play] ${viewkey} from=${from} mode=${mode} ${why} -> 回退推荐栏形态嗅探播放页 ${sniffUrl}`);
      return {
        urls: [
          ...directUrls,
          { name: '嗅探播放页(推荐栏)', url: sniffUrl }
        ],
        header: Object.assign({}, HEADER, { Referer: `${host}/index.php` }),
        flag: '91porn',
        parse: 1
      };
    }

    logI(`[play] ${viewkey} from=${from} mode=${mode} 真实直链 ${realUrls.length} 条 / 探活通过 ${healthy.length} 条 -> parse=0 直连, 首条host=${new URL(ordered[0]).hostname}`);
    ordered.forEach((u, i) => logI(`[play][url${i + 1}] ${new URL(u).hostname}${new URL(u).pathname}`));
    // 全部是直链 → parse=0 由宿主直接播放。
    // 注意：不能把「播放页」混进 parse=0 的 urls 里，宿主会把它当直链直接播必然失败；
    // 多 CDN 容灾交给 ordered（多条直链依次给出，播放器/宿主可自行切换）。
    if (!directUrls.length) {
      // 没有任何可用直链时，退回嗅探模式（parse=1 只给播放页，由客户端嗅探）
      logI(`[play] ${viewkey} 无可用直链，返回播放页交由客户端嗅探 parse=1`);
      return {
        urls: [{ name: '嗅探播放页', url: sniffUrl }],
        header: Object.assign({}, PLAY_HEADER, { Referer: `${host}/index.php` }),
        flag: '91porn',
        parse: 1
      };
    }
    return {
      urls: directUrls,
      header: PLAY_HEADER,
      flag: '91porn',
      parse: 0
    };
  } catch (e) {
    logE(`[play] 失败: ${e.message}`);
    return { urls: [], header: { 'User-Agent': USER_AGENT }, parse: 0 };
  }
}

/**
 * 返回形状守卫：宿主用 Go 反序列化，若 handler 意外返回字符串 / null / undefined，
 * 会直接报 `json: cannot unmarshal string into Go value of type models.XxxResponse`。
 * 这里统一包一层：任何异常或非法返回都转成对应 handler 的「空骨架」。
 */
const EMPTY_SHAPES = {
  home: () => ({ class: CATEGORIES, list: [] }),
  category: () => ({ page: 1, pagecount: 0, limit: 20, total: 0, list: [] }),
  detail: () => ({ list: [] }),
  search: () => ({ page: 1, pagecount: 0, limit: 20, total: 0, list: [] }),
  play: () => ({ urls: [], header: { 'User-Agent': USER_AGENT }, flag: '91porn', parse: 0 }),
};

function guard(method, fn) {
  return async function guarded(params, context) {
    let out;
    try {
      out = await fn(params, context);
    } catch (e) {
      logE(`[${method}] 未捕获异常: ${e && e.message}`);
      return EMPTY_SHAPES[method]();
    }
    // 必须是普通对象；数组/字符串/null 全部回退到空骨架
    if (!out || typeof out !== 'object' || Array.isArray(out)) {
      logE(`[${method}] 返回值非法(type=${typeof out})，回退空骨架`);
      return EMPTY_SHAPES[method]();
    }
    // 关键字段兜底，避免 Go 侧因字段类型不符报错
    if (method === 'home' || method === 'category' || method === 'detail' || method === 'search') {
      if (!Array.isArray(out.list)) out.list = [];
    }
    if (method === 'play') {
      if (!Array.isArray(out.urls)) out.urls = [];
      if (!out.header || typeof out.header !== 'object') out.header = { 'User-Agent': USER_AGENT };
      if (typeof out.parse !== 'number') out.parse = 0;
      if (typeof out.flag !== 'string') out.flag = '91porn';
    }
    return out;
  };
}

const exported = {
  home: guard('home', home),
  category: guard('category', category),
  detail: guard('detail', detail),
  search: guard('search', search),
  play: guard('play', play),
};

module.exports = exported;
runner.run(exported);
