// 红果短剧：红果官网页面数据与视频模型适配。
// 页面接口使用官网 SSR 的 _ROUTER_DATA；播放 token 保留视频 ID 与清晰度，
// 以便宿主在 play 阶段重新请求最新的媒体地址。
// @name 红果短剧
// @author OmniBox
// @description 红果短剧（hongguoduanju.com）：官网 SSR 分类/搜索/详情 + App 私有播放模型（完整 Argus 551/Ladon 签名 + gzip + player/v1）+ 内置 CENC Range 解密流服务；直接替代旧《红果短剧.py》+《红果短剧-代理.py》，默认 0.0.0.0:10008。跨机播放可配 HG_PROXY_BASE。
// @version 1.3.2
// @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/短剧/红果短剧.js
// @dependencies
// 说明：只依赖 Node 内置模块（crypto/zlib/http/https/fs/os/path/dgram/child_process），无需 axios/cheerio；无需同目录《红果短剧-代理.py》。详情页/play() 预热、模型短缓存、CDN 保活、首 Range 复用 moov 探测缓存以降低加载延迟；每 6 小时定时清扫内存缓存、日志与历史视频临时文件。
// 签名算法移植自 zfdang/hongguo-open-player (PR #92, AGPL/GPL-3.0)，用于修复 2026-11-10 起 App 播放接口 200 空体。
const crypto = require('crypto');
const { createDecipheriv, createHash, randomBytes } = crypto;
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

let OmniBox;
try {
  OmniBox = require('omnibox_sdk');
} catch (_) {
  OmniBox = {
    async log(level, message) { console.log(`[${level}] ${message}`); },
  };
}
let runner;
try {
  runner = require('spider_runner');
} catch (_) {
  runner = { run() {} };
}

async function log(level, message) {
  try { await OmniBox.log(level, message); } catch (_) { console.log(`[${level}] ${message}`); }
}

// ---------------------------------------------------------------------------
// 环境变量（沿用旧《红果短剧.py》/《红果短剧-代理.py》的命名，便于直接替换）
//   HG_PROXY_BASE  外部流服务基址，如 http://10.0.0.10:10008；配置后本源不再自行拉起服务
//   HG_PROXY_HOST  内置流服务监听地址，默认 0.0.0.0（沿用旧代理脚本语义）
//   HG_PROXY_PORT  内置流服务端口，默认 10008
//   HG_PROXY_LOG   独立流服务日志，默认 <tmpdir>/hg-proxy.log
//   HG_PROXY_PREFETCH  详情页异步预热，默认 1；设 0 关闭（减少上游请求）
//   HG_PROXY_PREFETCH_N  详情页预热的集数，默认 3（首集 + 后 2 集，便于连播）
//   HG_PROXY_SWEEP_MS   定时清扫间隔，默认 21600000ms（6 小时）；最小 1000ms
//   HG_PROXY_LOG_MAX_MB 日志超过该大小时截断，默认 8MB；设 0 关闭日志轮转
//   HG_PROXY_CACHE_DIR  历史视频临时文件目录，默认 <tmpdir>/hongguo_video
//   HG_PROXY_SWEEP_DISK 是否清扫该目录下的过期视频临时文件，默认 1；设 0 关闭
//   HOST_IP        播放端与脚本不同机时的服务机局域网 IP（兼容旧配置）
//   DUANJU_DEVICE_ID / DUANJU_INSTALL_ID / DUANJU_CDID / DUANJU_COOKIE  覆盖内置匿名设备
// ---------------------------------------------------------------------------
const HG_PROXY_PORT = Number(process.env.HG_PROXY_PORT || 10008);
const HG_PROXY_BASE = normalizeProxyBase(process.env.HG_PROXY_BASE);
const HG_PROXY_HOST = String(process.env.HG_PROXY_HOST || '').trim() || '0.0.0.0';
const HG_PROXY_LOG = String(process.env.HG_PROXY_LOG || '').trim() || `${os.tmpdir()}/hg-proxy.log`;
const HG_PROXY_PREFETCH = !['0', 'false', 'no', 'off'].includes(String(process.env.HG_PROXY_PREFETCH || '1').trim().toLowerCase());
const HG_PROXY_PREFETCH_N = Math.max(1, Math.min(8, Number(process.env.HG_PROXY_PREFETCH_N || 3) || 3));
const HG_PROXY_SWEEP_MS = Math.max(1000, Number(process.env.HG_PROXY_SWEEP_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000);
const HG_PROXY_LOG_MAX_MB = Math.max(0, Number(process.env.HG_PROXY_LOG_MAX_MB || 8) || 0);
const HG_PROXY_CACHE_DIR = String(process.env.HG_PROXY_CACHE_DIR || '').trim() || path.join(os.tmpdir(), 'hongguo_video');
const HG_PROXY_SWEEP_DISK = !['0', 'false', 'no', 'off'].includes(String(process.env.HG_PROXY_SWEEP_DISK || '1').trim().toLowerCase());
const IS_STREAM_PROCESS = process.argv.includes('--hg-stream');
function normalizeProxyBase(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}
const VIDEO_API = 'https://reading.snssdk.com/novel/player/multi_video_model/player/v1';
const VIDEO_API_FALLBACK = 'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1';
const SHORTPLAY_API = 'https://api3-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/';
const PLAYBACK_UA = 'com.phoenix.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const SHORTPLAY_UA = 'com.dragon.read';
const PLAYBACK_DEVICE_74332 = {
  ac: 'wifi', channel: 'update_64', aid: '8662', app_name: 'novelread',
  version_code: '74332', version_name: '7.4.3.32', device_platform: 'android', os: 'android',
  ssmix: 'a', device_type: '25053RT47C', device_brand: 'Redmi', language: 'zh', os_api: '36',
  os_version: '16', manifest_version_code: '74332', resolution: '1280*2772', dpi: '520',
  update_version_code: '74332', host_abi: 'arm64-v8a', dragon_device_type: 'phone', pv_player: '74332',
  compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0',
};
const DEFAULT_DEVICE = Object.freeze({
  device_id: '1624456208323876',
  iid: '1624456208327972',
  cdid: '91d56f7e-c027-4ce9-9a3c-229d59a13c3b',
  cookie: 'install_id=1624456208327972; store-region=cn-bj; store-region-src=did',
});

function sanitizeCookie(value, iid) {
  const clean = String(value || '').split(';').map(x => x.trim())
    .filter(x => x && !x.toLowerCase().startsWith('ttreq=')).join('; ');
  return clean || `store-region=cn-bj; store-region-src=did; install_id=${iid}`;
}
function getDevice() {
  return {
    device_id: String(process.env.DUANJU_DEVICE_ID || DEFAULT_DEVICE.device_id),
    iid: String(process.env.DUANJU_INSTALL_ID || DEFAULT_DEVICE.iid),
    cdid: String(process.env.DUANJU_CDID || DEFAULT_DEVICE.cdid),
    cookie: sanitizeCookie(process.env.DUANJU_COOKIE || DEFAULT_DEVICE.cookie, process.env.DUANJU_INSTALL_ID || DEFAULT_DEVICE.iid),
  };
}

// SM3 (GB/T 32905), pure JavaScript: Electron's bundled crypto may omit SM3.
function sm3(input) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const data = Buffer.alloc(Math.ceil((source.length + 9) / 64) * 64);
  source.copy(data);
  data[source.length] = 0x80;
  data.writeBigUInt64BE(BigInt(source.length) * 8n, data.length - 8);
  const state = new Uint32Array([0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e]);
  const words = new Uint32Array(68);
  const rotate = (x, n) => ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0;
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = data.readUInt32BE(offset + i * 4);
    for (let i = 16; i < 68; i++) {
      const x = words[i - 16] ^ words[i - 9] ^ rotate(words[i - 3], 15);
      words[i] = x ^ rotate(x, 15) ^ rotate(x, 23) ^ rotate(words[i - 13], 7) ^ words[i - 6];
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const a12 = rotate(a, 12);
      const s1 = rotate((a12 + e + rotate(i < 16 ? 0x79cc4519 : 0x7a879d8a, i)) >>> 0, 7);
      const s2 = s1 ^ a12;
      const ff = i < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c);
      const gg = i < 16 ? e ^ f ^ g : (e & f) | (~e & g);
      const t1 = (ff + d + s2 + (words[i] ^ words[i + 4])) >>> 0;
      const t2 = (gg + h + s1 + words[i]) >>> 0;
      d = c; c = rotate(b, 9); b = a; a = t1;
      h = g; g = rotate(f, 19); f = e;
      e = (t2 ^ rotate(t2, 9) ^ rotate(t2, 17)) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] ^= next[i];
  }
  const digest = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) digest.writeUInt32BE(state[i], i * 4);
  return digest;
}

// --- 1. Minimal ProtoBuf Writer ---
class ProtoBuf {
  constructor() {
    this.fields = [];
    this.blobs = [];
  }
  putVarint(idx, v) {
    this.fields.push({ tag: idx, type: 0, value: BigInt(v), blobIndex: -1 });
    return this;
  }
  putBlob(idx, data) {
    this.blobs.push(data);
    this.fields.push({ tag: idx, type: 2, value: 0n, blobIndex: this.blobs.length - 1 });
    return this;
  }
  putUtf8(idx, s) {
    return this.putBlob(idx, Buffer.from(String(s == null ? '' : s), 'utf8'));
  }
  putBytes(idx, data) {
    return this.putBlob(idx, Buffer.isBuffer(data) ? data : Buffer.from(data || ''));
  }
  putProtobuf(idx, nested) {
    return this.putBlob(idx, nested.toBuf());
  }
  toBuf() {
    const parts = [];
    for (const f of this.fields) {
      this.writeVarint(parts, (BigInt(f.tag) << 3n) | BigInt(f.type));
      if (f.type === 0) {
        this.writeVarint(parts, f.value);
      } else if (f.type === 2) {
        const b = this.blobs[f.blobIndex];
        this.writeVarint(parts, BigInt(b.length));
        parts.push(b);
      }
    }
    return Buffer.concat(parts);
  }
  writeVarint(parts, v) {
    let n = BigInt.asUintN(32, BigInt(v));
    const out = [];
    while (n >= 128n) {
      out.push(Number((n & 127n) | 128n));
      n >>= 7n;
    }
    out.push(Number(n));
    parts.push(Buffer.from(out));
  }
}

// --- 2. Simon 64/128 Block Cipher ---
const Z = 0x3DC94C3A046D678Bn;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

function rotl64(x, n) {
  const s = BigInt(n) & 63n;
  return ((x << s) | (x >> (64n - s))) & MASK64;
}
function rotr64(x, n) {
  const s = BigInt(n) & 63n;
  return ((x >> s) | (x << (64n - s))) & MASK64;
}

const Simon = {
  keyExpansion(k) {
    const key = new Array(72);
    for (let i = 0; i < 4; i++) key[i] = BigInt.asUintN(64, k[i]);
    for (let i = 4; i < 72; i++) {
      let tmp = rotr64(key[i - 1], 3) ^ key[i - 3];
      tmp ^= rotr64(tmp, 1);
      const bit = (Z >> BigInt((i - 4) % 62)) & 1n;
      key[i] = (~key[i - 4] ^ tmp ^ bit ^ 3n) & MASK64;
    }
    return key;
  },
  encrypt(xInput, x1Input, k) {
    const key = this.keyExpansion(k);
    let xi = BigInt.asUintN(64, xInput);
    let xi1 = BigInt.asUintN(64, x1Input);
    for (const roundKey of key) {
      const tmp = xi1;
      const f = rotl64(xi1, 1) & rotl64(xi1, 8);
      xi1 = (xi ^ f ^ rotl64(xi1, 2) ^ roundKey) & MASK64;
      xi = tmp;
    }
    return [xi, xi1];
  },
  decrypt(xLeftInput, xRightInput, k) {
    const key = this.keyExpansion(k);
    let xLeft = BigInt.asUintN(64, xLeftInput);
    let xRight = BigInt.asUintN(64, xRightInput);
    for (let i = 71; i >= 0; i--) {
      const tmp = xLeft;
      const f = rotl64(xLeft, 1) & rotl64(xLeft, 8);
      xLeft = (xRight ^ f ^ rotl64(xLeft, 2) ^ key[i]) & MASK64;
      xRight = tmp;
    }
    return [xLeft, xRight];
  }
};

// --- 3. Ladon Cipher (34-round ARX) ---
const Ladon = {
  encrypt(khronos, lcId, aid, randomBytes) {
    const data = `${khronos}-${lcId}-${aid}`;
    const md5Hex = crypto.createHash('md5').update(Buffer.concat([randomBytes, Buffer.from(String(aid))])).digest('hex');
    const ht = this.expandTable(md5Hex);
    const size = data.length;
    const newSize = size + (16 - (size % 16));
    const padVal = newSize - size;
    const input = Buffer.alloc(newSize, padVal);
    Buffer.from(data, 'utf8').copy(input, 0);
    const out = Buffer.alloc(newSize);
    for (let i = 0; i < newSize / 16; i++) {
      this.encryptBlock(ht, input, i * 16).copy(out, i * 16);
    }
    return Buffer.concat([randomBytes, out]).toString('base64');
  },
  expandTable(md5Hex) {
    const ht = Buffer.alloc(288);
    const src = Buffer.from(md5Hex, 'utf8');
    src.copy(ht, 0, 0, Math.min(32, src.length));
    let b0 = ht.readBigUInt64LE(0);
    let b8 = ht.readBigUInt64LE(8);
    const temp = [ht.readBigUInt64LE(16), ht.readBigUInt64LE(24)];
    for (let i = 0; i < 34; i++) {
      let x8 = (rotr64(b8, 8) + b0) & MASK64;
      x8 ^= BigInt(i);
      temp.push(x8);
      x8 ^= rotl64(b0, 3);
      ht.writeBigUInt64LE(x8, (i + 1) * 8);
      b0 = x8;
      b8 = temp.shift();
    }
    const table = [];
    for (let i = 0; i < 36; i++) {
      table.push(ht.readBigUInt64LE(i * 8));
    }
    return table;
  },
  encryptBlock(ht, data, at) {
    let data0 = data.readBigUInt64LE(at);
    let data1 = data.readBigUInt64LE(at + 8);
    for (let i = 0; i < 34; i++) {
      data1 = (ht[i] ^ ((data0 + rotr64(data1, 8)) & MASK64)) & MASK64;
      data0 = (data1 ^ rotl64(data0, 3)) & MASK64;
    }
    const res = Buffer.alloc(16);
    res.writeBigUInt64LE(data0, 0);
    res.writeBigUInt64LE(data1, 8);
    return res;
  }
};

// --- 4. Argus Signer (551 layout) ---
const SIGN_KEY = Buffer.from('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304', 'hex');
const AES_KEY = Buffer.from('d31e3718288a1027baab59f146a09a9c', 'hex');
const AES_IV = Buffer.from('ea180a0336ed352fcd24e4d50018ae54', 'hex');
const MAGIC8 = Buffer.from([0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff]);
const TAIL9 = Buffer.from([0xea, 0xfb, 0x2c, 0xfe, 0x85, 0x68, 0x51, 0x91, 0x54]);

function pkcs7Pad(buf) {
  const pad = 16 - (buf.length % 16);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function simonEncryptPadded(protobuf) {
  const key = [
    SIGN_KEY.readBigUInt64LE(0),
    SIGN_KEY.readBigUInt64LE(8),
    SIGN_KEY.readBigUInt64LE(16),
    SIGN_KEY.readBigUInt64LE(24)
  ];
  const out = Buffer.alloc(protobuf.length);
  for (let i = 0; i < protobuf.length; i += 16) {
    const xInput = protobuf.readBigUInt64LE(i);
    const x1Input = protobuf.readBigUInt64LE(i + 8);
    const [ct0, ct1] = Simon.encrypt(xInput, x1Input, key);
    out.writeBigUInt64LE(ct0, i);
    out.writeBigUInt64LE(ct1, i + 8);
  }
  return out;
}

function aesEncrypt(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function queryParam(query, name) {
  if (!query) return null;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.substring(0, eq);
    let decodedK = k;
    try {
      decodedK = decodeURIComponent(k);
    } catch {
      decodedK = k;
    }
    if (decodedK === name) {
      const v = eq < 0 ? '' : part.substring(eq + 1);
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

const Argus = {
  bodyHash(stubHex) {
    if (!stubHex) return sm3(Buffer.alloc(16)).subarray(0, 6);
    try {
      return sm3(Buffer.from(stubHex, 'hex')).subarray(0, 6);
    } catch {
      return sm3(Buffer.alloc(0)).subarray(0, 6);
    }
  },
  queryHash(query) {
    if (!query) return sm3(Buffer.alloc(16)).subarray(0, 6);
    return sm3(Buffer.from(query, 'utf8')).subarray(0, 6);
  },
  sign(query, stubHex, ts, aid, licenseId, deviceId, installId, randField) {
    const bean = new ProtoBuf();
    bean.putVarint(1, 1077940818);
    bean.putVarint(2, 2);
    bean.putVarint(3, BigInt.asUintN(32, BigInt(randField)));
    bean.putUtf8(4, String(aid === 0 ? 1967 : aid));
    bean.putUtf8(5, deviceId || '');
    bean.putUtf8(6, String(licenseId === 0 ? 1611921764 : licenseId));
    bean.putUtf8(7, queryParam(query, 'version_name') || '');
    bean.putUtf8(8, 'v04.04.05-ov-android');
    bean.putVarint(9, 134744640);
    bean.putBytes(10, Buffer.alloc(8));
    bean.putVarint(11, 0);
    bean.putVarint(12, (BigInt(ts) << 1n) & 0xffffffffn);
    bean.putBytes(13, this.bodyHash(stubHex));
    bean.putBytes(14, this.queryHash(query));
    const sub15 = new ProtoBuf();
    sub15.putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xC792ECCC);
    bean.putProtobuf(15, sub15);
    bean.putUtf8(16, installId || '');
    bean.putUtf8(20, 'none');
    bean.putVarint(21, 738);
    const sub23 = new ProtoBuf();
    sub23.putUtf8(1, 'NX551J').putVarint(2, 8196).putVarint(4, 0x80E0D800);
    bean.putProtobuf(23, sub23);
    bean.putVarint(25, 2);

    const protobuf = pkcs7Pad(bean.toBuf());
    const encPb = simonEncryptPadded(protobuf);

    const un = Buffer.concat([MAGIC8, encPb, TAIL9]);
    const buf = Buffer.alloc(un.length);
    MAGIC8.copy(buf, 0);
    for (let i = 8; i < un.length; i++) {
      buf[i] = un[i] ^ MAGIC8[i % 8];
    }
    buf.reverse();
    const padded = pkcs7Pad(Buffer.concat([buf, Buffer.from([0x61, 0x6f])])); // 'ao'
    const encrypted = aesEncrypt(padded, AES_KEY, AES_IV);
    return Buffer.concat([Buffer.from([0xf2, 0x81]), encrypted]).toString('base64');
  }
};

const PlayerSigner = {
  LICENSE_ID: 1611921764,
  headers(query, body, ts = Math.floor(Date.now() / 1000)) {
    const aid = Number(queryParam(query, 'aid') || 1967);
    const stub = body && body.length > 0 ? crypto.createHash('md5').update(body).digest('hex') : '';
    const ladonRandom = crypto.randomBytes(4);
    const randField = crypto.randomBytes(4).readInt32LE(0);
    const deviceId = queryParam(query, 'device_id') || '';
    const installId = queryParam(query, 'iid') || '';
    const headers = {
      'x-ss-req-ticket': String(ts * 1000),
      'x-khronos': String(ts),
      'x-ladon': Ladon.encrypt(ts, this.LICENSE_ID, aid, ladonRandom),
      'x-argus': Argus.sign(query, stub, ts, aid, this.LICENSE_ID, deviceId, installId, randField)
    };
    if (stub) headers['x-ss-stub'] = stub.toUpperCase();
    return headers;
  }
};



// ---------------------------------------------------------------------------
// 统一 HTTP 请求层（Node 内置；支持 gzip 请求体、二进制 Range 响应、重定向）
// ---------------------------------------------------------------------------
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = Number(options.timeout || 30000);
    const binary = options.binary === true;
    const redirects = Number(options.maxRedirects == null ? 5 : options.maxRedirects);
    const doRequest = (current, hopsLeft) => {
      let u;
      try { u = new URL(current); } catch (err) { reject(err); return; }
      const mod = u.protocol === 'https:' ? https : http;
      const headers = Object.assign({}, options.headers || {});
      const body = options.body;
      if (body != null && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body)));
      }
      const reqOptions = { method: options.method || 'GET', headers, timeout };
      if (options.agent) reqOptions.agent = options.agent;
      const req = mod.request(u, reqOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hopsLeft > 0) {
          res.resume();
          doRequest(new URL(res.headers.location, u).toString(), hopsLeft - 1);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          try {
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch (_) { /* 保留原始 body */ }
          const data = binary ? buf : buf.toString('utf8');
          resolve({ status: res.statusCode, statusCode: res.statusCode, headers: res.headers, data, body: binary ? '' : data });
        });
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      if (body != null) req.write(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      req.end();
    };
    doRequest(url, redirects);
  });
}

// ---------------------------------------------------------------------------
// 进程内首页缓存（替代原 ../../util/home-cache.js）
// ---------------------------------------------------------------------------
const HOME_CACHE_TTL = { semiStatic: 30 * 60 * 1000 };
const _homeCache = new Map();
function buildHomeCacheKey(key) { return String(key); }
function getHomeCache(key) {
  const item = _homeCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { _homeCache.delete(key); return null; }
  return item.value;
}
function setHomeCache(key, value, ttl) {
  _homeCache.set(key, { value, expires: Date.now() + (Number(ttl) || HOME_CACHE_TTL.semiStatic) });
  while (_homeCache.size > 64) _homeCache.delete(_homeCache.keys().next().value);
}

// ---------------------------------------------------------------------------
// App 播放模型请求：完整 Argus 551 / Ladon + gzip body + 74332 设备基线
// ---------------------------------------------------------------------------
function pythonUrlEncode(values) {
  return Object.entries(values).map(([k, v]) => {
    const enc = x => encodeURIComponent(String(x == null ? '' : x))
      .replace(/%2A/gi, '*')
      .replace(/[!'()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${enc(k)}=${enc(v)}`;
  }).join('&');
}
function playbackRequest(payload, device, apiBase = VIDEO_API) {
  const body = zlib.gzipSync(Buffer.from(payload));
  const khronos = Math.floor(Date.now() / 1000);
  const query = pythonUrlEncode(Object.assign({}, PLAYBACK_DEVICE_74332, {
    device_id: device.device_id, iid: device.iid, cdid: device.cdid,
    _rticket: String(Date.now()),
  }));
  const url = `${apiBase}?${query}`;
  const signerHeaders = PlayerSigner.headers(query, body, khronos);
  const headers = {
    'User-Agent': PLAYBACK_UA,
    Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Encoding': 'gzip',
    'sdk-version': '2',
    'passport-sdk-version': '5051452',
    'x-xs-from-web': '0',
    'x-ss-dp': '8662',
    ...signerHeaders,
  };
  if (device.cookie) headers.Cookie = device.cookie;
  return { url, body, headers };
}
function shortplayRequest(vid, device) {
  const khronos = Math.floor(Date.now() / 1000);
  const query = pythonUrlEncode({
    iid: device.iid, device_id: device.device_id, aid: '1967', app_name: 'novelapp',
    version_code: '72132', version_name: '7.2.1.32', device_platform: 'android',
    device_brand: 'Xiaomi', os_version: '13', cdid: device.cdid,
  });
  const payload = JSON.stringify({
    video_id: String(vid), content_type: 1004,
    biz_param: {
      detail_page_version: 0, device_level: 3, disable_digg_stat: false,
      disable_video_relate_book: false, from_video_id: '', need_all_video_definition: true,
      need_mp4_align: false, source: 4, use_os_player: false, use_server_dns: false,
      video_platform: 3,
    },
  });
  const body = Buffer.from(payload);
  return {
    url: `${SHORTPLAY_API}?${query}`,
    body,
    headers: {
      'User-Agent': SHORTPLAY_UA,
      'Content-Type': 'application/json; charset=utf-8',
      ...PlayerSigner.headers(query, body, khronos),
      Cookie: device.cookie,
    },
  };
}

// ---------------------------------------------------------------------------
// 内置 CENC Range 流服务（独立进程长驻，避免宿主短命进程导致服务消失）
// ---------------------------------------------------------------------------
const HEALTH_PATH = '/__hg_health';
const HG1080_HEALTH_PATH = '/__hg1080_health';
const HG1080_HEALTH_BODY = 'hg1080-ok';
let _streamServer = null;

function detectLanIp() {
  const explicit = String(process.env.HOST_IP || '').trim();
  if (explicit) return explicit;
  try {
    const dgram = require('dgram');
    const s = dgram.createSocket('udp4');
    let ip = '';
    try { s.connect(223, '5.5.5.5'); ip = s.address().address; } catch (_) { /* ignore */ }
    try { s.close(); } catch (_) { /* ignore */ }
    if (ip && !/^(127\.|198\.18\.|169\.254\.)/.test(ip)) return ip;
  } catch (_) { /* ignore */ }
  return '127.0.0.1';
}
function streamProbeBase() { return HG_PROXY_BASE || `http://127.0.0.1:${HG_PROXY_PORT}`; }
function streamPublicBase() {
  if (HG_PROXY_BASE) return HG_PROXY_BASE;
  return `http://${detectLanIp()}:${HG_PROXY_PORT}`;
}
async function pingStream() {
  try {
    const r = await httpRequest(streamProbeBase() + HG1080_HEALTH_PATH, { timeout: 1500 });
    return Number(r.status) === 200 && String(r.body || '').includes(HG1080_HEALTH_BODY);
  } catch (_) { return false; }
}
let _streamSpawnPromise = null;
async function ensureStreamService() {
  if (await pingStream()) return true;
  // 详情页预热与 play() 可能同时进入，共用一个 spawn 结果避免重复拉起。
  if (_streamSpawnPromise) return await _streamSpawnPromise;
  if (!HG_PROXY_BASE) {
    _streamSpawnPromise = (async () => {
    try {
      const { spawn } = require('child_process');
      let logFd = null;
      try {
        logFd = fs.openSync(HG_PROXY_LOG, 'a');
      } catch (_) { logFd = null; }
      const child = spawn(process.execPath, [__filename, '--hg-stream', String(HG_PROXY_PORT)], {
        detached: true,
        stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
        env: process.env,
      });
      child.unref();
      if (logFd != null) { try { fs.closeSync(logFd); } catch (_) { /* 子进程已 dup fd */ } }
      await log('info', `[hg][stream] 已拉起独立流服务 pid=${child.pid} port=${HG_PROXY_PORT}`);
    } catch (err) {
      await log('warn', `[hg][stream] 独立流服务拉起失败: ${err.message}`);
    }
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (await pingStream()) return true;
    }
    // 兜底：同进程内直接监听（至少同机、当前进程存活期间可用）
    try {
      await startStreamServer(HG_PROXY_PORT);
      return true;
    } catch (err) {
      if (!/EADDRINUSE/.test(String(err && err.code))) {
        await log('warn', `[hg][stream] 内置流服务监听失败: ${err.message}`);
      }
      const alive = await pingStream();
      if (!alive) {
        try {
          const legacy = await httpRequest(streamProbeBase() + HEALTH_PATH, { timeout: 1200 });
          if (Number(legacy.status) === 200) {
            await log('warn', `[hg][stream] 端口 ${HG_PROXY_PORT} 上的 /__hg_health 来自旧《红果短剧-代理.py》，请先停止该进程；新流服务无法监听同一端口`);
          }
        } catch (_) { /* 端口无响应，忽略 */ }
      }
      return alive;
    }
  })().finally(() => { _streamSpawnPromise = null; });
    return await (_streamSpawnPromise || Promise.resolve(false));
  }
  return false;
}
function startStreamServer(port) {
  return new Promise((resolve, reject) => {
    if (_streamServer) { resolve(_streamServer); return; }
    const server = http.createServer((req, res) => {
      const healthPath = String(req.url || '').split('?')[0];
      if (healthPath === HEALTH_PATH || healthPath === HG1080_HEALTH_PATH) {
        const body = healthPath === HG1080_HEALTH_PATH ? HG1080_HEALTH_BODY : 'ok';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(body);
        return;
      }
      serveMediaHttp(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`media session failed: ${err && err.message ? err.message : err}`);
        } else res.destroy();
      });
    });
    server.on('error', reject);
    server.listen(Number(port) || HG_PROXY_PORT, HG_PROXY_HOST, () => {
      _streamServer = server;
      resolve(server);
    });
  });
}


// Medusa/Sixgod signer is bundled here so this plugin stays single-file and loads like 影探4k.js.

// Generated from the official Red Fruit Android signer tables.
const MEDUSA_SBOX_B64 = '+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==';
const MEDUSA_BRANCH1_B64 = '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';

// Native JavaScript port of the Red Fruit Android sixgod signer.
// The signer is bundled above so this plugin has no local runtime imports.

const U32 = 0xffffffff;
const sbox = Buffer.from(MEDUSA_SBOX_B64, 'base64');
const branch1Bytes = Buffer.from(MEDUSA_BRANCH1_B64, 'base64');
const SV2 = [0xa7aefe20,0x7149f1d6,0x47e4ca07,0xe9b58f67,0x93b924de,0xc614d0f5,0x38afe0ef,0xb2bbad73,0xe24444c3,0x9d3aec9b,0xdf7b37e4,0xd8b16d40,0xf8ac31b8,0x76b9a90b,0x31d833ee,0x953fce64,0x353595a4,0x4609c13b,0x36925008,0x8c6d0925,0x5df5c177,0x1cfbf52b,0x8a4fa7f0,0x114ca35e,0x8193f984,0x7a7a8733,0x316ab4d5,0x3c20cfc9,0xa6d84453,0x3a18500c,0x798ec47a,0x97a76b28,0x66c4ff96,0x51716443,0xdd2fc3b,0xb5696da7,0xbbeb3ac5,0x5c53d204,0xd32608ce,0x7279b9ec,0xf4188ecf,0xf7d793db,0x332cc491,0xab76ae15,0x9bebe727,0x18a01384,0x5be9f8a7,0x5f90a754,0x39b663c0,0x36673c83,0x7c92f514,0x9d7d94d7,0xe2e8d9aa,0x5f7e9ea9,0x7abd4551,0x569e05da,0x40a25632,0x3df5a9a5,0xbab37d80,0x454286dc,0x3f5d4e78,0x3d7b75d,0xb1fe4af7,0xa5ab26a3];
const BRANCH2_ORDERS = Buffer.from('0f0704000908030a060b050d0e010c020f05080c0009020103070e060b0a0d04060500070c000a04080f010b0d09020e060b02050403080101070a000d0c090e0d070e0f0b0208030c0509010004060a0d0902060f0b0a040807000c0503010e0c090f07060f030e020d0405010b0a000c050a090e0802040407030f01060b000b0f0408020a0700090d06010e03050c0b060a0508020c03070f0e090d0001040906080f050800040a0b030d01020c0e090d0c0604070a03030f00080105020e01000d0f090a0b0e0402080703060c0501080a0c0f0905060b000304020e070d04080f000c0f0e0d0a01060207090503040205080d0b0a0606000e0f070c09030a08040f000b01060d0c0709030e05020a070b050f00020e0108030d0c0609040d070f08050f06040b0a0e0c090002030d0c020704010b0e0e08060f09050003','hex');

const u8 = n => Number(n) & 255;
const u32 = n => Number(n) >>> 0;
const rol32 = (n, k) => { k &= 31; return u32((n << k) | (n >>> (32 - k))); };
const ror32 = (n, k) => { k &= 31; return u32((n >>> k) | (n << (32 - k))); };
const rol8 = (n, k) => { k &= 7; return u8((n << k) | (n >>> (8 - k))); };
const ror64 = (n, k) => { const b = BigInt(k) & 63n; const mask = (1n << 64n) - 1n; return b ? ((n >> b) | ((n << (64n - b)) & mask)) & mask : n & mask; };
const xorBytes = (a, b) => Buffer.from(a.map((v, i) => v ^ (b[i] || 0)));
const md5 = value => createHash('md5').update(value).digest();
// sm3 使用顶部内联的纯 JS 实现（Node 部分版本不提供 crypto sm3）
const sumMd5 = data => { let check = 0x20220420; for (let i = 0; i < 12; i++) { let temp; if ((i & 1) === 0) { temp = (check >>> 3) ^ check; check = data[i] ^ (check << 7); } else { temp = (check >>> 5) ^ check; check = data[i] | (check << 11); check ^= U32; } check = u32(check ^ temp); } return u32((check | 4) ^ 0x1000000); };
const blockDivide = (block, chunks) => Array.from({ length: chunks }, (_, i) => block.readUInt32LE(i * 4));

function md5sumV3(msg, countV2, orders, countV1) {
  const sv = SV2.map(x => ror32(x, countV1));
  let count = countV2 & 255;
  const start = [ror32(0x79e0f2fb, count), ror32(0xc8b52570, count), ror32(0xebc2f8cd, count), ror32(0x7c104d93, count)];
  let [a, b, c, d] = start;
  count = (countV2 + 6) & 255;
  const end = [ror32(0x19be4866, count), ror32(0xe85986b4, count), ror32(0xe19b326e, count), ror32(0x71d1d7d4, count)];
  const M = blockDivide(msg.subarray(0, 64), 16), o = [orders.subarray(0,16),orders.subarray(16,32),orders.subarray(32,48),orders.subarray(48,64)];
  const F=(x,y,z)=>(x&y)|((~x)&z), G=(x,y,z)=>(x&z)|(y&(~z)), H=(x,y,z)=>x^y^z, I=(x,y,z)=>y^(x|(~z));
  const FF=(x,y,z,w,m,s,t)=>u32(rol32(u32(x+F(y,z,w)+m+t),s)+y), GG=(x,y,z,w,m,s,t)=>u32(rol32(u32(x+G(y,z,w)+m+t),s)+y), HH=(x,y,z,w,m,s,t)=>u32(rol32(u32(x+H(y,z,w)+m+t),s)+y), II=(x,y,z,w,m,s,t)=>u32(rol32(u32(x+I(y,z,w)+m+t),s)+y);
  const T = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
  const idx = [[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[1,6,11,0,5,10,15,4,9,14,3,8,13,2,7,12],[5,8,11,14,1,4,7,10,13,0,3,6,9,12,15,2],[0,7,14,5,12,3,10,1,8,15,6,13,4,11,2,9]];
  const sh = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
  const fs = [FF,GG,HH,II];
  const state = [a, b, c, d];
  const targetOrder = [0, 3, 2, 1];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 16; i++) {
      const target = targetOrder[i & 3];
      const x = state[target];
      const y = state[(target + 1) & 3];
      const z = state[(target + 2) & 3];
      const w = state[(target + 3) & 3];
      state[target] = fs[round](x, y, z, w, M[o[round][i]], sh[round][i & 3], sv[round * 16 + i]);
    }
  }
  const out = Buffer.alloc(20);
  [u32(start[0] + state[0]) ^ end[0], u32(start[1] + state[1]) ^ end[1], u32(start[2] + state[2]) ^ end[2], u32(start[3] + state[3]) ^ end[3]].forEach((v, i) => out.writeUInt32LE(u32(v), i * 4));
  out.writeUInt32LE(sumMd5(out.subarray(0, 16)), 16);
  return out;
}

function getIv(iv, data) { for(let i=0;i<data.length;i++){ if((i&1)===0) iv=(iv>>>4)^iv^(iv<<6)^data[i]; else iv=~((iv>>>7)^iv^(data[i]|(iv<<12))); iv=u32(iv); } return iv; }
function branch0Xor(data, base, di, tt03, rounds, x1,x2,x3,x4,x5,x6,x7,x8,x9,x10){ const d=data.slice(); for(let i=0;i<rounds;i++){const n0=di[(base+i)&127],n1=((d[x3]^d[x4])&d[x1])^d[x3],n2=rol32(d[x1],26)^rol32(d[x1],21)^rol32(d[x1],7),n3=tt03[(base+i)&63],n4=u32(n0+n1+n2+n3+d[x5]),n5=rol32(d[x2],30)^rol32(d[x2],19)^rol32(d[x2],10),n6=(d[x2]&d[x6])|((d[x2]|d[x6])&d[x7]),n7=n5+n6,o=d[x9]; if(globalThis.DEBUG_MEDUSA&&i===0)console.log('STEP0',n0,n1,n2,n3,n4,n5,n6,n7,o,d.slice()); d.unshift(d.pop()); d[x10]=u32(n7+n4); d[x8]=u32(o+n4); } return d; }
function hashF13(querySm3, bodyMd5, ts, khronos){ const iv=getIv(getIv(getIv(0x20230928,querySm3),bodyMd5),ts), v0=((iv&15)*171)>>9, branch=(iv&15)-((v0*3)&255); if(branch===0)return branch0(v0,khronos,querySm3,bodyMd5,ts); if(branch===1)return branch1(v0,khronos,querySm3,bodyMd5,ts); if(branch===2)return branch2(iv,khronos,querySm3,bodyMd5,ts); throw new Error(`medusa branch ${branch}`); }

function branch0(v0,khronos,q,b,t){
  const tt01=[0xc4a78580,0xb3c0fd39,0xc58c5686,0xc9aa3ba7,0xf5a7adf2,0x963c2ed1], iv1=tt01[v0], cv1=(iv1+khronos+1)&255, cv2=(iv1+khronos)>>>0;
  const tt02=[0xebb64faf,0x7aadcc2,0xcf3187bf,0xe01138ff,0x6d0bfcff,0x5a30a3be,0xb41ad638,0x34180eb8,0xf233eb6f,0xb1a584cc,0xccc30dc7,0x47d1db51,0xd55653de,0x70a84fa1,0x57473c12,0xf76f0288,0x2c077f0a,0xda0dcad0,0xfbb86f6c,0xfdc4cf00,0x688a020d,0xe676c6a6,0x8cd6338b,0x1a3c8d0e,0xcce8b06b,0x6ad0ed0b,0xa0522717,0xdc71ac83,0x2285db71,0xd5b4dda6,0x736f8650,0x6560306c,0x617ce2a6,0xe423417e,0xa40e143,0x544e4032,0x88dffb2a,0x716c1ae0,0x4c467a88,0x5b23bb3,0xe1d0b866,0xbaa3dcb8,0xae3374d3,0xc3381a50,0x1702f75b,0xfe6da368,0xf0b4cf48,0x4e0ffbb8,0x72aad10d,0x26c53a3d,0xf2bce0f6,0xb4557581,0x4a257fdd,0x8c3182a2,0xab0b3b86,0x3d5dfb14,0x4f103634,0xd37b52d7,0x444eff16,0xeb0a33d1,0x6ca86f6e,0x284ba7,0x8387cfa,0x5fb37586];
  const tt03=tt02.map(x=>ror32(x,(iv1+khronos+1)&255)); const n0=(cv2+2)&7, seed=[0xfa,0x45,0x61,0xd7], pad=Buffer.from(seed.map(x=>(x|x<<8)>>n0&255)); const count=cv2&255, init=[0x7aba4fc8,0x67166507,0x6403fa00,0x340f512f,984304912,3005047866,2874125293,2152413264].map(x=>ror32(x,count)); const data=Buffer.concat([q,b,t,pad,Buffer.from('00000000000001a0','hex')]); const di=[]; for(let i=0;i<data.length;i+=4)di.push(data.readUInt32BE(i)); let di0=di[0]; for(let i=0;i<112;i++){const d1=di[i+1],d14=di[i+14],r1=rol32(d1,14)^rol32(d1,25)^(d1>>>3),r2=rol32(d14,13)^rol32(d14,15)^(d14>>>10);di0=u32(di0+di[i+9]+r1+r2);di.push(di0);di0=d1;}
  if (globalThis.DEBUG_MEDUSA) console.log('JSINIT', init.map(x=>x.toString(16)), 'JSDI', di.slice(0,20).map(x=>x.toString(16)), di[20].toString(16), di[50].toString(16), di[100].toString(16));
  const args=[[101,5,7,6,3,2,1,0,5,4,3],[96,0,6,7,5,3,2,1,5,4,4],[96,7,6,2,1,4,0,5,4,3,5],[99,3,6,2,4,5,1,0,0,7,6],[96,0,5,6,7,3,1,2,5,4,4],[100,2,0,3,5,4,6,7,2,1,5]][v0]; const vj=branch0Xor(init,iv1,di,tt03,...args); if (globalThis.DEBUG_MEDUSA) console.log('JSVJ', vj.map(x=>x.toString(16))); const full=Buffer.alloc(32); for(let i=0;i<8;i++)full.writeUInt32BE(u32(vj[i]+init[i]),i*4); const ret=Buffer.alloc(20); for(let i=0;i<16;i++)ret[i]=full[i]^full[i+16]; if(globalThis.DEBUG_MEDUSA)console.log('JSFULL',full.toString('hex'),'JSRET',ret.subarray(0,16).toString('hex')); ret.writeUInt32LE(sumMd5(ret.subarray(0,16)),16); return ret;
}

function r00(a,b,c,d,e,f,g,h,tt,table){let x=table(Number((a>>56n)*8n));if(tt>0n)x^=tt;x^=table(Number(((b>>45n)&2040n)+2048n));x^=table(Number(((c>>37n)&2040n)+4096n));x^=table(Number(((d>>29n)&2040n)+6144n));x^=table(Number(((e>>21n)&2040n)+8192n));x^=table(Number(((f>>13n)&2040n)+10240n));x^=table(Number((((g>>8n)&255n)*8n)+12288n));x^=table(Number(((h&255n)*8n)+14336n));return x;}
function swapV0(src,srcXor,tt2,table,order,typ){let da=order.map((x,i)=>src[x]^srcXor[i]),ha=srcXor.slice();for(let round=0;round<10;round++){const rr=[];for(let i=0;i<8;i++){const z=ha.slice(i).concat(ha.slice(0,i));rr[i]=r00(...z,i===7?tt2[round+1]:0n,table);}const old=da.slice();for(let i=0;i<8;i++){const z=old.slice(i).concat(old.slice(0,i));da[i]=r00(...z,rr[i],table);}ha=rr;}if(!typ){src[0]=da[0]^srcXor[0]^src[0];src[1]=da[7]^srcXor[1]^src[1];src[2]=da[6]^srcXor[2]^src[2];src[3]=da[5]^srcXor[3]^src[3];src[4]=da[4]^srcXor[4]^src[4];src[5]=da[3]^srcXor[5]^src[5];src[6]=da[2]^srcXor[6]^src[6];src[7]=da[1]^srcXor[7]^src[7];}else{src[0]=da[7]^typ[1];src[1]=da[6]^typ[2];src[2]=da[5]^typ[3];src[3]=da[4]^typ[4];src[4]=da[3]^typ[5];src[5]=da[2]^typ[6];src[6]=da[1]^typ[7]^src[7];src[7]=da[0]^typ[0];}return src;}
function branch1(v0,khronos,q,b,t){ const t1=[0x808a9c79n,0xf079807en,0xbadf79c5n,0xa785d3ffn,0x82d8438cn],iv1=t1[v0], cv=ror64(BigInt(khronos),((iv1+BigInt(khronos))&255n)); const orders=Buffer.from('050701020400060300050204010307060507020401060300030002040607010504050003060201070000000000000000','hex').subarray(v0*8,v0*8+8); const rot=Number((iv1+BigInt(khronos)+1n)&63n), constants=[0x87aeea5dab37cd6bn,0x7ff48becb4f54087n,0xb0724c06706bbd5dn,0x1fe5dfb1143e328dn,0x1a2331d00af4f1f2n,0xcaff7131bb1e71ban,0x33385e1042752218n,0xff01ed65d4a441fbn,0xadb1ec8828c80e8n,0x62475d12f4e06fe7n,0xbd0b238da4fe72n].map(x=>ror64(x,rot)); const to=Buffer.concat([q,b,t,Buffer.from('800000000000000000000000','hex')]); const src=Array.from({length:8},(_,i)=>to.readBigUInt64BE(i*8)); let sx=Array(8).fill(cv); const table=x=>branch1Bytes.readBigUInt64LE((v0<<14)+x); let swap=swapV0(src,sx,constants,table,[...orders]); const dat=Array(8).fill(0n);dat[7]=416n; sx=[swap[4],swap[3],swap[2],swap[1],swap[0],swap[7],swap[6],swap[5]]; swap=swapV0(dat,sx,constants,table,[...orders],swap); const raw=Buffer.alloc(32);let n=0;for(let i=7;i>=0;i--){const pp=Buffer.alloc(8);pp.writeBigUInt64LE(swap[i]);raw[n++]=pp[1];raw[n++]=pp[3];raw[n++]=pp[5];raw[n++]=pp[6];}for(let i=0;i<16;i++)raw[i]^=raw[i+16];const ret=Buffer.alloc(20);raw.copy(ret,0,0,16);ret.writeUInt32LE(sumMd5(ret.subarray(0,16)),16);return ret; }
function branch2(iv,khronos,q,b,t){ const n=(iv&(15-2))*86, iv0=(((n>>15)&255)+((n>>8)&255))&255, n1=[0x8980f29b,0xeb549c7f,0xb08726db,0xd40cb5e6,0xe8f559e4][iv0], cv1=(n1+khronos+1)&255, cv2=(n1+khronos)>>>0,n0=(cv2+5)&7,seed=[0x84,0x96,0x77,0x9d,0xd4,0x15,0x0b,0xf8],pad=Buffer.from(seed.map(x=>(x|x<<8)>>n0&255)),data=Buffer.concat([q,b,t,pad,Buffer.from('a0010000','hex')]);return md5sumV3(data,cv2,BRANCH2_ORDERS.subarray(iv0<<6,(iv0+1)<<6),cv1); }

class AESV3 {
  constructor(key,khronos){ this.word=khronos&3; this.sb=sbox.subarray(this.word<<8,(this.word+1)<<8); this.isb=Buffer.alloc(256);for(let i=0;i<256;i++)this.isb[this.sb[i]]=i; this.con=[[1,0,2,3],[1,3,0,2],[0,1,3,2],[1,0,2,3]][this.word];this.con2=[[1,0,2,3],[2,0,3,1],[0,1,3,2],[1,0,2,3]][this.word];this.order=[[0,9,14,11,4,13,2,7,8,1,6,15,12,5,10,3],[0,9,14,15,4,13,2,7,8,1,6,3,12,5,10,11],[0,9,14,7,4,13,2,11,8,1,6,3,12,5,10,15],[0,9,14,11,4,13,2,7,8,1,6,15,12,5,10,3]][this.word]; this.rk=this.expand(key); }
  expand(key){const init=[0xca025ddc,0x823dc546,0xc9420583,0xc298225f][this.word];const mk=Buffer.alloc(48);for(let i=0;i<16;i++)mk[i]=(init>>((i&3)*8))&255 ^ key[i];let rounds=8;for(let i=4;i<12;i++){const idx=4*(i-1);let [k0,k1,k2,k3]=mk.subarray(idx,idx+4);if((i&3)===0){const k00=((init>> (rounds&24))^this.sb[k1])&255;k1=this.sb[k2];k2=this.sb[k3];k3=this.sb[k0];k0=k00;}rounds+=2;for(let j=0;j<4;j++)mk[idx+4+j]=[k0,k1,k2,k3][j]^mk[idx-12+j];}return mk;}
  sum(data){const out=Buffer.alloc(32);for(let i=0;i<31;i++){const j=i*8;let n0=(data[j]>>4)&2,n1=n0|(data[j+1]&64),n2=n1|((data[j+2]>>2)&1),n3=n2|((data[j+3]<<3)&128),n4=n3|((data[j+4]>>1)&4),n5=n4|((data[j+5]<<3)&16),n6=n5|((data[j+6]<<5)&32),n7=n6|((data[j+7]>>4)&8);out[i]=n7;}out[31]=1;return out;}
  shift(s){const b=Buffer.from(s);for(let i=0;i<4;i++)for(let j=0;j<4;j++)s[i*4+j]=b[this.order[i*4+j]];}
  shiftCon(s,c){for(let i=0;i<4;i++){const b=s.slice(i*4,i*4+4);for(let j=0;j<4;j++)s[i*4+j]=b[c[j]];}}
  sub(s){for(let i=0;i<16;i++)s[i]=this.sb[s[i]];const b=Buffer.from(s);for(let i=0;i<4;i++)s[i]=b[this.con2[i]];}
  invSub(s){for(let i=0;i<16;i++)s[i]=this.isb[s[i]];const b=Buffer.from(s);for(let i=0;i<4;i++)s[i]=b[this.con[i]];}
  mix(s){for(let i=0;i<4;i++){const a=[s[i],s[4+i],s[8+i],s[12+i]],t=a[0]^a[1]^a[2]^a[3],x=(v)=>((v<<1)^((v&128)?0x1b:0))&255;a[0]^=t^x(a[0]^a[1]);a[1]^=t^x(a[1]^a[2]);a[2]^=t^x(a[2]^a[3]);a[3]^=t^x(a[3]^a[0]);for(let j=0;j<4;j++)s[j*4+i]=a[j];}}
  block(p){let s=Buffer.from(p);for(let i=0;i<16;i++)s[i]^=this.rk[i];for(let r=1;r<3;r++){this.sub(s);this.shift(s);if(r===1){this.shiftCon(s,this.con2);this.mix(s);}for(let i=0;i<16;i++)s[i]^=this.rk[r*16+i];}for(let i=0;i<16;i++)s[i]^=this.rk[16+i];return s;}
  encrypt(data,iv){const plain=this.sum(data), blocks=[];let prev=Buffer.from(iv);for(let i=0;i<plain.length;i+=16){const b=this.block(xorBytes([...plain.subarray(i,i+16)], [...prev]));blocks.push(b);prev=b;}const key=Buffer.concat(blocks),out=Buffer.from(data);for(let i=0;i<31;i++){const k=key[i],j=i*8;out[j]=(out[j]&~32)|((k<<4)&32);out[j+1]=(out[j+1]&~64)|(k&64);out[j+2]=(out[j+2]&~4)|((k<<2)&4);out[j+3]=(out[j+3]&~16)|((k>>3)&16);out[j+4]=(out[j+4]&~8)|((k<<1)&8);out[j+5]=(out[j+5]&~2)|((k>>3)&2);out[j+6]=(out[j+6]&~1)|((k>>5)&1);out[j+7]=(out[j+7]&127)|((k<<4)&128);}return Buffer.concat([key.subarray(-1),out]);}
}

const varint = value => { let n=BigInt(value);if(n<0)n&=(1n<<64n)-1n;const a=[];while(n>127n){a.push(Number((n&127n)|128n));n>>=7n;}a.push(Number(n));return Buffer.from(a);};
const sint = value => {const n=BigInt(value);return n>=0n?n<<1n:(n<<1n)^-1n;};
function field(no,value,kind){if(value==null||value===''||value===false||value===0||((Buffer.isBuffer(value))&&!value.length))return Buffer.alloc(0);if(kind==='sint32'||kind==='sint64')return Buffer.concat([varint(BigInt(no<<3)),varint(sint(value))]);if(kind==='float'){const wire=Buffer.alloc(4);wire.writeFloatLE(Number(value));return Buffer.concat([varint(BigInt((no<<3)|5)),wire]);}let wire;if(kind==='bytes')wire=Buffer.from(value);else if(kind==='string')wire=Buffer.from(String(value));else wire=Buffer.from(value);return Buffer.concat([varint(BigInt((no<<3)|2)),varint(wire.length),wire]);}
const proto = fields => Buffer.concat(fields.map(([n,v,k])=>field(n,v,k)));
function encodeMedusa(values){const req=proto([[1,111,'sint32'],[2,10,'sint32'],[3,694367,'sint32'],[5,586952199,'sint32']]);const d=values.env.device,r=values.env.report;const dev=proto([[1,d.d1,'sint32'],[2,d.collect_stat,'sint32'],[3,d.aid,'string'],[4,d.device_id,'string'],[5,d.sec_device_token,'string'],[6,d.app_version,'string'],[7,d.battery,'sint32'],[8,d.battery2,'sint32'],[9,d.battery_health,'sint32'],[10,d.battery_changed,'sint32'],[11,d.network,'string'],[12,d.tz,'string'],[13,d.lan,'string'],[14,d.cpu,'sint32'],[15,d.resolution,'string'],[16,d.sdcard,'float'],[17,d.sdcard_used,'float'],[18,d.memory,'float'],[19,d.memory2,'float'],[20,d.data,'float'],[21,d.data_used,'float'],[22,d.os_version,'string'],[23,d.brightness,'sint32'],[24,d.volume,'sint32'],[25,d.ts,'sint64'],[26,d.ts2,'sint64'],[27,d.ts3,'sint64'],[28,d.ts4,'sint64'],[29,d.usb,'sint32'],[30,d.hw_version,'string'],[31,d.brand,'string'],[32,d.board,'string'],[33,d.product_name,'string'],[34,d.product_device,'string'],[35,d.product_manufacturer,'string'],[36,d.hardware,'string'],[38,d.unknown38,'sint32'],[40,d.unknown40,'sint32']]);const env=proto([[1,values.env.launch_time,'sint32'],[2,values.env.unknown2,'sint32'],[3,values.env.unknown3,'sint32'],[5,values.env.unknown5,'sint32'],[6,values.env.version,'string'],[7,values.env.pid,'sint32'],[12,dev,'message'],[13,proto([[1,r.time,'sint64'],[2,r.state,'sint32'],[4,r.code,'sint32'],[5,r.times,'sint32'],[6,r.unknown6,'sint32']]),'message'],[14,values.env.app_version,'string']]);return proto([[1,values.magic,'bytes'],[2,values.version,'sint32'],[3,values.rand,'sint32'],[4,values.ms_app_id,'string'],[5,values.device_id,'string'],[6,values.license_id,'string'],[7,values.app_version,'string'],[8,values.sdk_version_str,'string'],[9,values.sdk_version,'sint32'],[10,values.xg_seed_bytes,'bytes'],[12,values.time,'sint32'],[13,values.query_body_ts_hash,'bytes'],[14,values.query_sm3,'bytes'],[15,req,'message'],[16,values.sec_device_token,'string'],[17,values.time2,'sint32'],[18,values.lanusk_hash,'bytes'],[19,values.query_body_hash_sm3,'bytes'],[20,values.psk_version,'string'],[21,values.call_type,'sint32'],[23,env,'message'],[24,values.unknown24,'string']]);}

function jsonBodyMd5(data,type){if(!data)return '';const raw=typeof data==='string'?Buffer.from(data):Buffer.from(JSON.stringify(data));return md5(raw).toString('hex').toUpperCase();}
function urlEncode(params){return Object.entries(params).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%20/g,'%20').replace(/%2A/g,'*')}`).join('&');}
function getKeyHash(key,rand){const buf=Buffer.alloc(68);key.copy(buf,0);buf.writeUInt32LE(rand>>>0,32);key.copy(buf,36);const d1=(rand>>>16)&255;let d2=((d1<<11)|(rand>>>24))>>>0;d2=(~(d2^(d1>>>5)^d1))>>>0;return [sm3(buf),Buffer.from([d2&255,(d2>>>8)&255,(d2>>>16)&255,(d2>>>24)&255])];}
function xmxorTwo(data,key){const out=Buffer.alloc(data.length);for(let i=0;i<data.length;i++){const p=(i*4)&28,d0=key[p],d1=key[p+1];let d2=(rol8(data[i],4)+d0)^d1;d2=rol8((~d2)&255,3);d2=((d2+d1)&255)^d0;out[data.length-i-1]=(~d2)&255;}return out;}
function xmxor(data,key){const v=xmxorTwo(data,key),last=v[v.length-1]^v[v.length-2],d0=v[0];v[0]=((~last)+v[0])&255;v[1]=((v[0]^v[v.length-1]^254)+v[1])&255;v[2]=(v[2]+((last-d0)^rol8(v[1],3)^2))&255;for(let i=0;i<v.length-4;i++)v[i+3]=((~(rol8(v[i+2],3)^v[i+1]^(i+3)))+v[i+3])&255;v[v.length-1]^=v[v.length-2];v[0]=((v[0]^v[1])+v.subarray(1).reduce((a,b)=>a+b,0))&255;return v;}

function genMedusa(url,params,devices,data,khronos,dataType='application/json; charset=UTF-8'){
  const bodyMd5=Buffer.from(jsonBodyMd5(data,dataType)||'00000000000000000000000000000000','hex'), query=url.split('?')[1]||'', qsm3=sm3(query), qhash=sm3(Buffer.concat([Buffer.from(query),bodyMd5,Buffer.from('none')])), ts=Buffer.alloc(4);ts.writeUInt32LE(khronos>>>0);const bodyHash=hashF13(qsm3,bodyMd5,ts,khronos);
  const deviceId=String(devices.device_id||params.device_id||''), model=String(devices.device_model||params.device_type||''), brand=String(devices.device_brand||params.device_brand||''), version=String(devices.version_name||params.version_name||'7.1.3.32'), now=Math.floor(Date.now()/1000);
  const device={d1:1,collect_stat:2,aid:'8662',device_id:deviceId,sec_device_token:String(devices.device_sec_device_token||''),app_version:'!noperm!',battery:-888888,battery2:-888888,battery_health:3,battery_changed:-888888,network:'!notset!',tz:'Asia/Shanghai,8',lan:'zh_CN',cpu:4,resolution:'1280*2772',sdcard:255.24993896484375,sdcard_used:35.58599090576172,memory:3.467449188232422,memory2:3.467449188232422,data:255.1754913330078,data_used:42.17544174194336,os_version:String(devices.os_version||params.os_version||''),brightness:41,volume:36,ts:1728388016635,ts2:1728388016635,ts3:1728388016635,ts4:1728388016637,usb:-1,hw_version:model,brand,board:model,product_name:model,product_device:String(devices.device_manufacturer||brand),product_manufacturer:brand,hardware:brand,unknown38:31};
  const env={launch_time:100+randomBytes(1)[0]%21,unknown2:146331399,unknown3:146331396,unknown5:7,version:'v04.06.04.03-bugfix',pid:10001+randomBytes(2).readUInt16LE()%2000,device,report:{time:now,state:-2,code:200,times:0,unknown6:0},app_version:version};
  const rand=randomBytes(4).readUInt32LE(), vals={magic:Buffer.from('f7e85ffad7d7dc3bd62ac87057cf6118','hex'),version:3,rand,ms_app_id:'8662',device_id:deviceId,license_id:'1588093228',app_version:version,sdk_version_str:'v04.06.04-ml-android',sdk_version:67503104,xg_seed_bytes:Buffer.from('4001000000000000','hex'),time:khronos,query_body_ts_hash:bodyHash,query_sm3:qsm3.subarray(0,6),sec_device_token:String(devices.sec_device_token||''),time2:khronos,lanusk_hash:Buffer.alloc(0),query_body_hash_sm3:qhash,psk_version:'none',call_type:312,env,unknown24:'{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}'};
  const proto=encodeMedusa(vals), hashRand=randomBytes(4).readUInt32LE(), xmRand=randomBytes(4).readUInt32LE(), [key,seed]=getKeyHash(Buffer.from('8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eae f71cb691f7aaa8a2f5'.replace(/ /g,''),'hex'),hashRand); let mixed=Buffer.concat([Buffer.alloc(8),xmxor(proto,key)]);mixed.writeBigUInt64LE(320n);mixed=Buffer.from(mixed.reverse());for(let i=0;i<mixed.length;i++)mixed[i]^=seed[~i&3];const hb=Buffer.alloc(4);hb.writeUInt32LE(hashRand);const check=(((qsm3[0]&63)<<14)|0x18000001|((bodyHash[0]&63)<<8))>>>0;const pre=Buffer.concat([Buffer.from([0x35]),(()=>{const x=Buffer.alloc(4);x.writeUInt32LE(xmRand);return x;})(),(()=>{const x=Buffer.alloc(4);x.writeUInt32LE(check);return x;})(),mixed,hb.subarray(2)]);const enc=new AESV3(Buffer.from('f15933766e6ea98d34f31b057a9d5be4','hex'),khronos).encrypt(pre,Buffer.from('1fe109a4125283f418de9e051a969e12','hex'));const ver=Buffer.from('03000000f7e85ffad7d7dc3bd62ac87057cf6118','hex'), vo=Buffer.alloc(20);for(let i=0;i<20;i+=4)vo.writeUInt32LE((ver.readUInt32LE(i)^khronos)>>>0,i);return Buffer.concat([vo,hb.subarray(0,2),Buffer.from([0,1]),enc]).toString('base64');
}

const KEY = 'hongguo';
const SITE = 'https://hongguoduanju.com';
const VIDEO_URL = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/';
const EPISODE_PREFIX = 'hg-episode-v1:';
const SERIES_EPISODE_PREFIX = 'hg-series-episode-v1:';
const SERIES_PREFIX = 'hg-series-v1:';
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const APP_UA = 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const MEDIA_UA = 'com.phoenix.read/71332';
const PAGE_ATTEMPTS = 3;
const QUALITY_ORDER = ['2160', '1440', '1080', '720', '576', '540', '480', '360'];
// 与红果.py 的 vod_play_from/vod_play_url 保持一致，只输出灵风线路。
// 播放模型请求仍声明全部清晰度，缺档时由服务端按实际结果降级。
const QUALITY_LINES = [{ q: '1080', name: '1080P' }];
const QUALITY_NAMES = {
  灵风: '1080', 高清: '720', 标准: '540', 流畅: '480', 极速: '360',
  '1080': '1080', '720': '720', '576': '576', '540': '540', '480': '480', '360': '360',
};
const MANJU_KEYWORDS = ['漫剧', '动漫短剧', '二次元', '漫画短剧', '国漫短剧', '日漫', '动态漫', '动画剧'];
const AI_MANJU_KEYWORDS = ['AI漫剧', 'AI动画', 'AI短剧', 'AI动漫', '漫剧AI', '二次元AI', 'AI漫画', '动画短剧'];
const SERIES_DETAIL_CACHE_TTL = 30 * 60 * 1000;
const SERIES_DETAIL_CACHE_LIMIT = 2000;
const seriesDetailCache = new Map();

function randomDeviceId() {
  const raw = BigInt(`0x${randomBytes(8).toString('hex')}`) % 900000000000000000n + 100000000000000000n;
  return raw.toString();
}

let deviceId = randomDeviceId();
let installId = randomDeviceId();

const text = (value, fallback = '') => value == null ? fallback : String(value).trim() || fallback;
const safeArray = (value) => Array.isArray(value) ? value : [];
function bodyOf(request) {
  if (request && typeof request === 'object' && !Array.isArray(request)) {
    if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) return request.body;
    return request;
  }
  return objectOf(request);
}
const pageOf = (value) => Math.max(1, Number.parseInt(value, 10) || 1);
const toInt = (value) => Number.parseInt(String(value ?? '').match(/\d+/)?.[0] || '0', 10) || 0;

function parseJSON(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function parseJSONPrefix(value) {
  const source = String(value || '').trimStart();
  if (!source) return null;
  const start = source[0] === '{' || source[0] === '[' ? 0 : -1;
  if (start < 0) return null;
  const stack = [];
  let quote = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') { quote = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) return null;
      if (!stack.length) return parseJSON(source.slice(start, index + 1), null);
    }
  }
  return null;
}

function objectOf(value) {
  const parsed = parseJSON(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function pageObject(value) {
  const parsed = objectOf(value);
  if (parsed.loaderData || parsed.searchList || parsed.detail_page || parsed.homeSections) return parsed;
  const nested = parsed.data;
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? objectOf(nested) : parsed;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function responsePayload(response) {
  // req.js 通常返回 { data, status }，测试壳也可能直接返回已解析页面对象。
  // 页面对象本身带 loaderData/searchList 时不能误取它的 data 字段。
  if (response && typeof response === 'object' && !Buffer.isBuffer(response)) {
    if (response.loaderData || response.searchList || response.detail_page) return response;
    return response.data ?? response.body ?? response;
  }
  return response;
}

async function getPageRaw(url, attempts = PAGE_ATTEMPTS) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      const response = await httpRequest(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Cache-Control': 'no-cache' },
        timeout: 30000,
      });
      const status = Number(response?.status ?? response?.statusCode ?? 0);
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const raw = responsePayload(response);
      if (Buffer.isBuffer(raw)) {
        if (!raw.length) throw new Error('页面为空');
        return raw.toString('utf8');
      }
      if (raw && typeof raw === 'object') return raw;
      const html = text(raw);
      if (!html) throw new Error('页面为空');
      return html;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(600 * (attempt + 1));
    }
  }
  throw new Error(`红果页面请求失败: ${lastError?.message || lastError || url}`);
}

async function getHtml(url, attempts = PAGE_ATTEMPTS) {
  const raw = await getPageRaw(url, attempts);
  if (typeof raw === 'string') return raw;
  const html = text(raw?.html || raw?.body || raw?.content);
  if (html) return html;
  return JSON.stringify(raw);
}

function routerData(html) {
  const sourceHtml = String(html || '');
  const assignment = sourceHtml.match(/(?:window\.)?_ROUTER_DATA\s*=\s*/);
  const script = sourceHtml.match(/<script\b[^>]*\bid=["']__ROUTER_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!assignment && !script) throw new Error('红果页面没有路由数据');
  const source = assignment ? sourceHtml.slice(assignment.index + assignment[0].length) : script[1];
  const parsed = parseJSONPrefix(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('红果路由数据格式错误');
  return parsed;
}

async function pageData(url) {
  const raw = await getPageRaw(url);
  const direct = pageObject(raw);
  if (direct.loaderData || direct.data || direct.searchList || direct.detail_page) return direct;
  return routerData(typeof raw === 'string' ? raw : JSON.stringify(raw));
}

async function searchLoader(keyword) {
  let last = {};
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    try {
      const raw = await getPageRaw(`${SITE}/search/${encodeURIComponent(keyword)}`);
      const html = typeof raw === 'string' ? raw : JSON.stringify(raw);
      let data = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? pageObject(raw) : {};
      if (!Object.keys(data).length) {
        try { data = routerData(html); } catch { data = objectOf(html); }
      }
      const page = data.loaderData?.['search_(keyword)/page'] || data.searchPage || data;
      if (safeArray(page.searchList).length) return page;
      const fallback = [];
      extractHtmlItems(html, fallback);
      if (fallback.length) return { searchList: fallback, totalCount: fallback.length };
      last = page || last;
    } catch { /* Retry transient page failures. */ }
    if (attempt + 1 < PAGE_ATTEMPTS) await sleep(500 * (attempt + 1));
  }
  return last;
}

function first(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = first(...value);
      if (found) return found;
    } else if (value && typeof value === 'object') {
      const found = first(value.url, value.uri, value.src, value.download_url, value.main_url, value.backup_url, value.backup_url_1, value.play_addr, value.url_list);
      if (found) return found;
    } else if (text(value)) return text(value);
  }
  return '';
}

function itemOf(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const data = item.video_data && typeof item.video_data === 'object' ? item.video_data : item;
  const pick = (...keys) => {
    for (const source of [data, item]) {
      for (const key of keys) if (source?.[key] != null && source[key] !== '' && source[key] !== 0) return source[key];
    }
    return '';
  };
  const href = pick('href', 'detail_url', 'detailUrl');
  let linkedId = '';
  try { linkedId = new URL(text(href), SITE).searchParams.get('series_id') || ''; } catch { /* 非 URL href 不作为详情 ID */ }
  const id = linkedId || pick('series_id', 'seriesId', 'seriesID', 'book_id', 'bookId', 'id', 'keyword');
  const name = pick('series_title', 'series_name', 'seriesName', 'name', 'title', 'book_name', 'bookName');
  const count = pick('episode_cnt', 'episodeCount', 'accessible_episode_cnt', 'episode_count', 'total_episodes');
  const pic = pick('series_cover', 'cover', 'cover_url', 'coverUrl', 'thumb_url', 'thumbUrl', 'poster', 'pic', 'image');
  const intro = pick('series_intro', 'intro', 'description', 'desc', 'summary');
  const heat = pick('heat', 'hot', 'hot_value', 'hotValue', 'score');
  if (id) cacheSeriesDetail(text(id), data);
  return {
    vod_id: text(id),
    vod_name: text(name, '未命名'),
    vod_pic: text(pic),
    vod_remarks: count ? `全${text(count)}集` : text(heat),
    vod_content: text(intro),
  };
}

function filterGroup(key, name, values) {
  // OmniBox 筛选结构要求 { key, name, init, value: [{ name, value }] }；
  // 旧的 { n, v } 会让「榜单 / 题材」二级菜单渲染成异常图标或空白。
  const options = values.map(([label, value]) => ({ name: label, value }));
  return { key, name, init: options[0] ? options[0].value : '', value: options };
}

function paginated(data = {}, requestedPage = 1, fallbackLimit = 20) {
  const list = safeArray(data.list);
  const page = pageOf(data.page ?? requestedPage);
  const limit = Number(data.limit || data.pageSize) > 0 ? Number(data.limit || data.pageSize) : fallbackLimit;
  const pagecount = Number(data.pagecount) > 0 ? Number(data.pagecount) : page + (list.length >= limit ? 1 : 0);
  const total = Number(data.total) >= 0 && Number(data.total) > 0
    ? Number(data.total)
    : (page - 1) * limit + list.length + (pagecount > page ? 1 : 0);
  return { ...data, page, pagecount, limit, total, list };
}

function homeClasses() {
  return [
    { type_id: 'rank', type_name: '热播榜单' },
    { type_id: 'real-drama', type_name: '真人短剧' },
    { type_id: 'comic-drama', type_name: '热血漫剧' },
    { type_id: 'ai-drama', type_name: 'AI短剧' },
  ];
}

function homeFilters() {
  const genre = [
    ['全部', ''], ['爱情', 'romance'], ['年代', 'period'], ['传奇', 'legend'], ['成长', 'growth'],
    ['家庭', 'family'], ['家族', 'clan'], ['萌宝', 'cute-kids'], ['惊悚', 'thriller'], ['恐怖', 'horror'],
    ['志怪', 'supernatural'], ['玄幻', 'fantasy'], ['奇幻', 'wonder'], ['都市', 'urban'], ['古装', 'costume'],
    ['逆袭', 'counterattack'], ['喜剧', 'comedy'], ['科幻', 'sci-fi'], ['灾难', 'disaster'], ['战争', 'war'],
    ['悬疑', 'suspense'], ['动作冒险', 'action-adventure'], ['剧情', 'drama'], ['青春', 'youth'],
  ];
  const comic = [['全部', ''], ['脑洞', 'creative'], ['玄幻', 'fantasy'], ['剧情', 'drama'], ['末世', 'apocalypse'], ['豪门', 'wealthy-family'], ['奇幻', 'wonder'], ['科幻', 'sci-fi'], ['冒险', 'adventure']];
  return {
    rank: [filterGroup('rank_type', '榜单', [['全部', ''], ['短剧热播榜', 'hot-drama'], ['漫剧热播榜', 'hot-comic-drama'], ['AI剧热播榜', 'hot-ai-drama']])],
    'real-drama': [filterGroup('genre', '题材', genre)],
    'comic-drama': [filterGroup('genre', '题材', comic)],
    'ai-drama': [filterGroup('genre', '题材', comic)],
  };
}

function collectItems(node, out = [], seen = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) collectItems(child, out, seen);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const keys = new Set(['seriesList', 'series_list', 'rankList', 'rank_list', 'rankingList', 'hotList', 'hot_list', 'dramaList', 'searchList', 'recommendList', 'video_list', 'list', 'results', 'data', 'items', 'records']);
  for (const [key, value] of Object.entries(node)) {
    if (keys.has(key) && Array.isArray(value)) {
      for (const raw of value) {
        const mapped = itemOf(raw);
        if (mapped.vod_id && mapped.vod_name !== '未命名' && !seen.has(mapped.vod_id)) {
          seen.add(mapped.vod_id); out.push(mapped); cacheSeriesDetail(mapped.vod_id, raw);
        }
      }
    }
    if (value && typeof value === 'object') collectItems(value, out, seen);
  }
  if (node.series_id || node.seriesId || node.series_title || node.series_name) {
    const mapped = itemOf(node);
    if (mapped.vod_id && mapped.vod_name !== '未命名' && !seen.has(mapped.vod_id)) {
      seen.add(mapped.vod_id); out.push(mapped); cacheSeriesDetail(mapped.vod_id, node);
    }
  }
  return out;
}

function extractHtmlItems(html, out = [], seen = new Set()) {
  const pattern = /<a\b[^>]*href=["'](?:https?:\/\/[^/]+)?\/(?:detail(?:\?series_id=|\/)|player\/)([^"'&#/?]+)[^"']*["'][^>]*>(.*?)<\/a>/gis;
  for (const match of String(html || '').matchAll(pattern)) {
    const id = text(match[1]);
    const inner = match[2] || '';
    const title = inner.match(/(?:title|alt)=["']([^"']+)["']/i)?.[1] || inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const pic = inner.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i)?.[1] || '';
    if (id && title && !seen.has(id)) {
      seen.add(id); out.push({ vod_id: id, vod_name: title, vod_pic: pic, vod_remarks: '', vod_content: '' });
    }
  }
  return out;
}

function decodeHtmlAttribute(value) {
  return String(value || '').replace(/&(?:quot|apos|#39|#34|amp|lt|gt|#x([\da-f]+)|#(\d+));/gi, (entity, hex, decimal) => {
    const name = entity.slice(1, -1).toLowerCase();
    if (name === 'quot' || name === '#34') return '"';
    if (name === 'apos' || name === '#39') return "'";
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function parseStructured(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    const parsed = parseJSON(value, null);
    return parsed == null ? value : parseStructured(parsed, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => parseStructured(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = parseStructured(child, depth + 1);
    return out;
  }
  return value;
}

function asyncPagePayloads(html) {
  const payloads = [];
  const pattern = /<script\b[^>]*\bdata-fn-args\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const raw = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? '');
    const parsed = parseJSONPrefix(raw) ?? parseJSON(raw, null);
    if (parsed != null) payloads.push(parseStructured(parsed));
  }
  return payloads;
}

function collectNamedArrays(node, names, out = [], seen = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) collectNamedArrays(child, names, out, seen);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (names.has(key) && Array.isArray(value)) {
      for (const raw of value) {
        const item = itemOf(raw);
        if (item.vod_id && item.vod_name !== '未命名' && !seen.has(item.vod_id)) {
          seen.add(item.vod_id);
          out.push(item);
          cacheSeriesDetail(item.vod_id, raw);
        }
      }
    }
    if (value && typeof value === 'object') collectNamedArrays(value, names, out, seen);
  }
  return out;
}

function cacheSeriesDetail(id, raw) {
  if (!id || !raw || typeof raw !== 'object') return;
  const data = raw.video_data && typeof raw.video_data === 'object' ? raw.video_data : raw;
  const videos = safeArray(data.episodeVids || data.episode_vids || data.vid_list || data.video_ids);
  const episodeCount = toInt(data.episode_cnt || data.episodeCount || data.total_episodes || data.episode_count || videos.length);
  const series = {
    series_id: id,
    series_name: text(data.series_title || data.series_name || data.title || data.name),
    series_cover: text(data.series_cover || data.cover || data.cover_url || data.poster || data.pic),
    series_intro: text(data.series_intro || data.description || data.intro || data.summary),
    episode_right_text: text(data.episode_right_text || data.statusText || data.status_text || data.heatText || data.episode_cnt && `全${data.episode_cnt}集`),
    celebrities: safeArray(data.celebrities),
    vid_list: videos.map((video) => typeof video === 'object' ? text(video.vid || video.video_id || video.id) : text(video)).filter(Boolean),
    episode_count: episodeCount || videos.length,
  };
  if (!series.series_name && !series.series_cover && !series.vid_list.length && !series.episode_count) return;
  seriesDetailCache.delete(id);
  seriesDetailCache.set(id, { series, expiresAt: Date.now() + SERIES_DETAIL_CACHE_TTL });
  while (seriesDetailCache.size > SERIES_DETAIL_CACHE_LIMIT) seriesDetailCache.delete(seriesDetailCache.keys().next().value);
}

function cachedSeriesDetail(id) {
  const cached = seriesDetailCache.get(id);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    seriesDetailCache.delete(id);
    return null;
  }
  seriesDetailCache.delete(id);
  seriesDetailCache.set(id, cached);
  return cached.series;
}

function detailPageFrom(data) {
  const loader = data?.loaderData || {};
  if (loader.detail_page) return loader.detail_page;
  return Object.entries(loader).find(([key, value]) => /detail.*\/(page|layout)/i.test(key) && value && typeof value === 'object')?.[1] || {};
}

function seriesFromDetailPage(detailPage) {
  const direct = detailPage?.seriesDetail || detailPage?.series_detail || detailPage?.detail || {};
  if (direct && typeof direct === 'object' && (direct.series_name || direct.series_id || direct.vid_list)) return direct;
  for (const value of Object.values(detailPage || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value.series_name || value.series_id || value.vid_list)) return value;
  }
  return {};
}

function rankPageData(node, rankType) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = rankPageData(child, rankType);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase().includes(`rank_${rankType}/page`) && value && typeof value === 'object') return value;
  }
  for (const value of Object.values(node)) {
    const found = rankPageData(value, rankType);
    if (found) return found;
  }
  return null;
}

function routeOf(id, page, extend = {}) {
  const raw = text(id, 'real-drama').replace(/^\/+|\/+$/g, '');
  const aliases = { all: 'real-drama', short: 'real-drama', real: 'real-drama', comic: 'comic-drama', manju: 'comic-drama', ai_comic: 'ai-drama', ai_manju: 'ai-drama' };
  if (raw === 'rank' || raw.startsWith('rank/')) {
    const routeRank = raw.startsWith('rank/') ? raw.slice(5) : '';
    const rank = routeRank || text(extend.rank_type, 'hot-drama');
    const allowed = ['hot-drama', 'hot-comic-drama', 'hot-ai-drama'];
    return `${SITE}/rank/${encodeURIComponent(allowed.includes(rank) ? rank : 'hot-drama')}`;
  }
  let category = raw.startsWith('category/') ? raw.slice(9).split('/')[0] : raw.split('/')[0];
  category = aliases[category] || category;
  if (!['real-drama', 'comic-drama', 'ai-drama'].includes(category)) category = 'real-drama';
  let genre = text(extend.genre);
  const parts = raw.split('/');
  if (!genre && parts.length > 1) genre = text(parts[parts.length - 1]);
  const path = `${SITE}/category/${encodeURIComponent(category)}${genre ? `/${encodeURIComponent(genre)}` : ''}`;
  return `${path}?page=${page}`;
}

async function loadCategory(page, id, extend) {
  const url = routeOf(id, page, extend);
  const raw = await getPageRaw(url);
  const html = typeof raw === 'string' ? raw : JSON.stringify(raw);
  let data = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? pageObject(raw) : {};
  if (!Object.keys(data).length) {
    try { data = routerData(html); } catch { data = {}; }
  }
  const rawId = text(id, 'real-drama').replace(/^\/+|\/+$/g, '');
  if (rawId === 'rank' || rawId.startsWith('rank/')) {
    const rankType = rawId.startsWith('rank/') ? rawId.slice(5) : text(extend.rank_type, 'hot-drama');
    const loaderRank = rankPageData(data, rankType);
    const asyncPayloads = asyncPagePayloads(html);
    const rankNames = new Set(['rankList', 'rank_list', 'rankingList', 'ranking_list']);
    let list = collectNamedArrays(loaderRank || {}, rankNames);
    if (!list.length) {
      for (const payload of asyncPayloads) collectNamedArrays(payload, rankNames, list, new Set(list.map((item) => item.vod_id)));
    }
    if (!list.length && loaderRank) list = collectItems(loaderRank);
    // 路由键会随官网版本变化；Python 版本会遍历整个状态树，这里保持同样的兜底。
    if (!list.length) list = collectItems(data);
    if (!list.length) extractHtmlItems(html, list, new Set(list.map((item) => item.vod_id)));
    return { page, pagecount: list.length >= 12 ? page + 1 : page, limit: 20, total: list.length >= 12 ? 999 : list.length, list };
  }
  // 与红果.py 的 categoryContent 一样遍历 loaderData 全树，兼容
  // recommendList 改名或嵌套层级变化的页面版本。
  const list = collectItems(data);
  if (!list.length) extractHtmlItems(html, list, new Set(list.map((item) => item.vod_id)));
  return { page, pagecount: list.length >= 12 ? page + 1 : page, limit: 20, total: list.length >= 12 ? 999 : list.length, list };
}

async function init(params, context) {
  const body = bodyOf(params);
  const requestedDevice = text(body.device_id || body.deviceId);
  const requestedInstall = text(body.install_id || body.installId || body.iid);
  if (/^\d{10,}$/.test(requestedDevice)) deviceId = requestedDevice;
  if (/^\d{10,}$/.test(requestedInstall)) installId = requestedInstall;
  return {};
}

async function home(params, context) {
  const cacheKey = buildHomeCacheKey(KEY, params);
  const cached = getHomeCache(cacheKey);
  if (cached) return cached;
  const result = { class: homeClasses(), filters: homeFilters(), list: [] };
  try {
    const vod = await homeVod();
    result.list = safeArray(vod.list).slice(0, 60);
  } catch (err) {
    await log('info', `[hg][home] 推荐列表拉取失败: ${err.message || err}`);
  }
  await log('info', `[hg][home] from=${context?.from || 'web'} class=${result.class.length} list=${result.list.length}`);
  setHomeCache(cacheKey, result, HOME_CACHE_TTL.semiStatic);
  return result;
}

async function homeVod() {
  try {
    const ranked = await loadCategory(1, 'rank/hot-drama', { rank_type: 'hot-drama' });
    if (safeArray(ranked.list).length) return { list: ranked.list.slice(0, 60) };
  } catch { /* 首页榜单失败时回退官网推荐。 */ }
  try {
    const data = await pageData(SITE);
    const page = data.loaderData?.page || {};
    const list = [];
    for (const section of safeArray(page.homeSections)) {
      for (const raw of safeArray(section?.video_list)) {
        const mapped = itemOf(raw);
        if (mapped.vod_id && !list.some((item) => item.vod_id === mapped.vod_id)) list.push(mapped);
      }
    }
    return { list: list.slice(0, 60) };
  } catch { return { list: [] }; }
}

async function category(params, context) {
  const body = bodyOf(params);
  const page = pageOf(body.page ?? body.pg);
  const id = text(body.categoryId ?? body.type_id ?? body.id ?? body.tid, 'real-drama');
  const extend = objectOf(body.filters ?? body.extend ?? body.ext);
  await log('info', `[hg][category] categoryId=${id} page=${page} filters=${JSON.stringify(extend).slice(0, 120)}`);
  try { return paginated(await loadCategory(page, id, extend), page); }
  catch (err) {
    await log('error', `[hg][category] 失败: ${err.message || err}`);
    return paginated({ list: [] }, page, 20);
  }
}

function splitEpisodeToken(value) {
  let body = text(value);
  if (body.startsWith(EPISODE_PREFIX)) body = body.slice(EPISODE_PREFIX.length);
  const index = body.indexOf(':');
  if (index > 0 && /^\d+$/.test(body.slice(0, index))) return { quality: body.slice(0, index), videoId: body.slice(index + 1) };
  return { quality: '1080', videoId: body };
}

function encodeEpisode(quality, videoId) { return `${EPISODE_PREFIX}${quality}:${videoId}`; }
function encodeSeriesEpisode(quality, seriesId, episode) { return `${SERIES_EPISODE_PREFIX}${quality}:${seriesId}:${episode}`; }

function parseEpisodeToken(value) {
  const raw = text(value);
  if (raw.startsWith(SERIES_EPISODE_PREFIX)) {
    const [quality, seriesId, episode, ...rest] = raw.slice(SERIES_EPISODE_PREFIX.length).split(':');
    if (QUALITY_ORDER.includes(quality) && /^\d+$/.test(seriesId) && /^\d+$/.test(episode) && !rest.length) {
      return { kind: 'series-episode', quality, seriesId, episode: Number(episode) };
    }
  }
  const token = splitEpisodeToken(raw);
  return { kind: 'video', quality: QUALITY_ORDER.includes(token.quality) ? token.quality : '1080', videoId: token.videoId };
}

function detailLines(seriesId, series) {
  const videos = safeArray(series?.vid_list || series?.episodeVids || series?.episode_vids);
  const count = videos.length;
  if (!count) return [];
  return QUALITY_LINES.map(({ q, name }) => ({
    name,
    urls: Array.from({ length: count }, (_, index) => {
      const directVideoId = text(videos[index]?.vid || videos[index]?.video_id || videos[index]?.id || videos[index]);
      return `第${index + 1}集$${encodeEpisode(q, directVideoId)}`;
    }).join('#'),
  }));
}

async function resolveSeriesEpisode(seriesId, episode) {
  let series = cachedSeriesDetail(seriesId);
  let videos = safeArray(series?.vid_list || series?.episodeVids || series?.episode_vids);
  if (episode > 0 && videos[episode - 1]) {
    const cachedId = text(videos[episode - 1]?.vid || videos[episode - 1]?.video_id || videos[episode - 1]?.id || videos[episode - 1]);
    if (/^\d+$/.test(cachedId)) return cachedId;
  }
  const data = await pageData(`${SITE}/detail?series_id=${encodeURIComponent(seriesId)}`);
  series = seriesFromDetailPage(detailPageFrom(data));
  videos = safeArray(series.vid_list || series.episodeVids || series.episode_vids);
  cacheSeriesDetail(seriesId, series);
  const video = videos[episode - 1];
  const videoId = text(video?.vid || video?.video_id || video?.id || video);
  if (!/^\d+$/.test(videoId)) throw new Error(`红果第 ${episode} 集没有可播放视频 ID`);
  return videoId;
}

function qualityFromFlag(flag, fallback = '1080') {
  const value = text(flag).toLowerCase();
  const direct = value.match(/(2160|1440|1080|720|576|540|480|360)\s*p?/i)?.[1];
  if (direct && QUALITY_ORDER.includes(direct)) return direct;
  for (const [name, quality] of Object.entries(QUALITY_NAMES)) {
    if (name && value.includes(name.toLowerCase()) && QUALITY_ORDER.includes(quality)) return quality;
  }
  if (value.includes('4k') || value.includes('超清')) return '2160';
  if (value.includes('高清') || value.includes('高码')) return '720';
  if (value.includes('标准')) return '540';
  if (value.includes('流畅')) return '480';
  if (value.includes('极速')) return '360';
  return QUALITY_ORDER.includes(String(fallback)) ? String(fallback) : '1080';
}

function qualityLinesFor(videos) {
  const list = safeArray(videos).filter((video) => /^\d+$/.test(text(video)));
  return QUALITY_LINES.map(({ q, name }) => ({
    name,
    urls: list.map((video, index) => `第${index + 1}集$${encodeEpisode(q, video)}`).join('#'),
  })).filter((line) => line.urls);
}

function normalizeSeriesId(value) {
  const input = text(value).replace(SERIES_PREFIX, '');
  if (!input) return '';
  try {
    const parsed = new URL(input, SITE);
    const queryId = parsed.searchParams.get('series_id');
    if (queryId) return queryId;
    const pathId = parsed.pathname.match(/\/(?:detail|player)\/([0-9]+)/)?.[1];
    if (pathId) return pathId;
  } catch { /* Plain IDs continue below. */ }
  return input;
}

async function detail(params, context) {
  const body = bodyOf(params);
  const input = body.videoId ?? body.id ?? body.ids;
  const ids = (Array.isArray(input) ? input : [input]).map(normalizeSeriesId).filter(Boolean);
  if (!ids.length) { await log('error', '[hg][detail] videoId 为空'); return { list: [] }; }
  await log('info', `[hg][detail] videoId=${ids.join(',')}`);
  const list = [];
  for (const id of ids) {
    try {
      const data = await pageData(`${SITE}/detail?series_id=${encodeURIComponent(id)}`);
      const fetched = seriesFromDetailPage(detailPageFrom(data));
      if (!fetched || typeof fetched !== 'object') throw new Error('红果剧集详情为空');
      cacheSeriesDetail(id, fetched);
      const series = { ...fetched, series_id: id };
      const lines = detailLines(id, series);
      if (!lines.length) throw new Error('红果详情没有返回完整剧集列表');
      const actors = safeArray(series.celebrities).map((actor) => text(actor?.nickname)).filter(Boolean);
      const sources = lines.map((line) => ({
        name: line.name,
        episodes: String(line.urls || '').split('#').filter(Boolean).map((seg, idx) => {
          const pos = seg.indexOf('$');
          return pos >= 0
            ? { name: seg.slice(0, pos).trim() || `第${idx + 1}集`, playId: seg.slice(pos + 1).trim() }
            : { name: `第${idx + 1}集`, playId: seg.trim() };
        }),
      }));
      list.push({
        vod_id: id,
        vod_name: text(series.series_name || series.series_title || series.title),
        vod_pic: text(series.series_cover || series.cover || series.cover_url),
        vod_year: '', vod_area: '', vod_director: '', vod_actor: actors.join(','),
        vod_content: text(series.series_intro || series.description || series.intro), vod_remarks: text(series.episode_right_text || series.heatText),
        vod_play_from: lines.map((line) => line.name).join('$$$'),
        vod_play_url: lines.map((line) => line.urls).join('$$$'),
        vod_play_sources: sources,
      });
      await log('info', `[hg][detail] sid=${id} name=${list[list.length - 1].vod_name} lines=${sources.length} eps=${sources[0] ? sources[0].episodes.length : 0}`);
      if (HG_PROXY_PREFETCH && sources[0] && sources[0].episodes.length) {
        const warmVids = [];
        for (const ep of sources[0].episodes.slice(0, HG_PROXY_PREFETCH_N)) {
          const t = parseEpisodeToken(text(ep.playId));
          if (t.kind === 'video' && /^\d+$/.test(t.videoId)) warmVids.push(t.videoId);
        }
        if (warmVids.length) {
          (async () => {
            try {
              await ensureStreamService();
              for (const v of warmVids) {
                const warmUrl = mediaEndpointUrl({ vid: v, q: '1080', hg: 'cenc', warm: '1' }, context);
                await httpRequest(warmUrl, { method: 'HEAD', timeout: 15000 });
              }
              await log('info', `[hg][prefetch] 详情预热完成 count=${warmVids.length} vids=${warmVids.slice(0, 3).join(',')}`);
            } catch (err) {
              await log('info', `[hg][prefetch] 详情预热跳过: ${err.message || err}`);
            }
          })();
        }
      }
    } catch (error) {
      list.push({ vod_id: id, vod_name: `❌ ${error.message || error}`, vod_remarks: '红果详情请求失败' });
    }
  }
  return { list };
}

function mediaUrl(item) { return first(item?.main_url, item?.backup_url, item?.backup_url_1, item?.play_addr, item?.url); }
function spadeValue(item) { return first(item?.spade_a, item?.encrypt_info?.spade_a); }

function decodeBase64(value) {
  const clean = text(value).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!clean) return Buffer.alloc(0);
  try { return Buffer.from(clean + '='.repeat((4 - clean.length % 4) % 4), 'base64'); } catch { return Buffer.alloc(0); }
}

function deriveContentKey(spade) {
  const raw = decodeBase64(spade);
  if (raw.length < 3) throw new Error('spade_a 太短');
  let length = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
  if (length <= 0 || 1 + length > raw.length) length = raw.length - 1;
  if (length < 33) throw new Error('spade_a 长度异常');
  const value = Buffer.from(raw.subarray(1, 1 + length));
  let va = 85; let vb = 246;
  for (let index = 0; index < length; index++) {
    const previous = index & 1 ? va : vb;
    if (index & 1) va = value[index]; else vb = value[index];
    const ones = index.toString(2).split('').filter((bit) => bit === '1').length;
    value[index] = (-21 - ones + (previous ^ value[index])) & 0xff;
  }
  const material = value.subarray(1, 33).toString('ascii');
  if (!/^[0-9a-f]{32}$/i.test(material)) throw new Error('spade_a 密钥材料无效');
  return Buffer.from(material, 'hex');
}

function decryptSpadeUrl(value, keySeed) {
  const raw = decodeBase64(value);
  if (raw.length < 20 || raw[0] !== 0xa8 || raw[2] !== 1 || raw[3] !== 0) throw new Error('spade URL 头无效');
  const encrypted = raw.subarray(4, raw.length - ((raw.length - 4) % 16));
  const constants = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const first = createHash('sha512').update(keySeed).digest();
  const second = createHash('sha512').update(Buffer.concat([first, constants])).digest();
  const cipher = createDecipheriv('aes-128-cbc', second.subarray(0, 16), second.subarray(16, 32));
  let plain = Buffer.concat([cipher.update(encrypted), cipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad > 0 && pad <= 16) plain = plain.subarray(0, -pad);
  return plain.toString('utf8').replace(/\0+$/, '');
}

function videoList(model) {
  for (const key of ['video_list', 'dynamic_video_list']) if (model?.[key] != null) return model[key];
  for (const key of ['dynamic_video', 'video_info', 'data']) {
    const nested = model?.[key];
    if (nested && typeof nested === 'object') {
      const value = videoList(nested.data && typeof nested.data === 'object' ? nested.data : nested);
      if (value != null) return value;
    }
  }
  return null;
}

function qualityOf(value) { return text(value).match(/(2160|1440|1080|720|576|540|480|360)/)?.[1] || '1080'; }
function flattenVideoRows(value, hinted = '') {
  if (Array.isArray(value)) return value.flatMap((item) => flattenVideoRows(item, hinted));
  if (!value || typeof value !== 'object') return [];
  if (['main_url', 'backup_url', 'backup_url_1', 'play_addr', 'spade_a', 'encrypt_info'].some((key) => key in value)) return [[hinted, value]];
  return Object.entries(value).flatMap(([key, child]) => {
    if (child && typeof child === 'object') return flattenVideoRows(child, ['video_list', 'dynamic_video_list', 'list'].includes(key) ? qualityOf(key) : hinted);
    return [];
  });
}

function selectQuality(rows, wanted = '1080') {
  const map = new Map();
  for (const [hinted, item] of flattenVideoRows(rows)) {
    const definition = qualityOf(item.definition || item.vheight || item.video_meta?.definition || hinted);
    map.set(definition, item);
  }
  if (!map.size) throw new Error('播放模型没有清晰度');
  const order = [qualityOf(wanted), ...QUALITY_ORDER.filter((q) => q !== qualityOf(wanted))];
  for (const quality of order) if (map.has(quality)) return [quality, map.get(quality)];
  const quality = [...map.keys()].sort((a, b) => toInt(b) - toInt(a))[0];
  return [quality, map.get(quality)];
}

function deviceConfig() {
  return { device_id: deviceId, iid: installId, install_id: installId, device_brand: 'Redmi', device_model: '25053RT47C', device_type: '25053RT47C', device_manufacturer: 'Xiaomi', os_version: '16', version_name: '7.1.3.32', ua: APP_UA };
}

function keySeedOf(model) {
  const direct = decodeBase64(text(model?.key_seed));
  if (direct.length) return direct;
  for (const key of ['dynamic_video', 'video_info', 'data']) {
    if (model?.[key] && typeof model[key] === 'object') {
      const nested = keySeedOf(model[key]);
      if (nested.length) return nested;
    }
  }
  return Buffer.alloc(0);
}

// 与红果.py 的 _core_sixgod 保持同一参数顺序和签名输入。
function pythonQueryEncode(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/%2A/gi, '*')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function md5Hex(value) {
  return createHash('md5').update(value).digest('hex').toUpperCase();
}

function xgRc4(data, key) {
  const table = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index++) {
    j = (j + table[index] + key[index % key.length]) & 255;
    table[index] = table[j];
  }
  const result = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index++) {
    i = (i + 1) & 255;
    const x = table[i];
    j = (j + x) & 255;
    const y = table[j];
    table[i] = y;
    result[index] = data[index] ^ table[(y + y) & 255];
  }
  return result;
}

function reverseBits(value) {
  let result = 0;
  for (let index = 0; index < 8; index++) result = (result << 1) | ((value >> index) & 1);
  return result;
}

function encryptGorgon(body, query, khronos, randomValue) {
  const bodyMd5 = body ? Buffer.from(md5Hex(body), 'hex') : Buffer.alloc(0);
  const data = Buffer.alloc(20);
  createHash('md5').update(query).digest().copy(data, 0, 0, 4);
  if (bodyMd5.length) bodyMd5.copy(data, 4, 0, 4);
  data.writeUInt32LE(67503104, 8);
  data.writeUInt32BE(khronos >>> 0, 16);
  const key = Buffer.from([0x4a, 320 & 0xff, 0x16, (randomValue >> 8) & 0xff, 0x47, 0x6c, 1, randomValue & 0xff]);
  const result = xgRc4(data, key);
  for (let index = 0; index < result.length; index++) {
    const value = ((result[index] >> 4) | (result[index] << 4)) & 0xff;
    const next = result[(index + 1) % result.length];
    result[index] = (~(reverseBits(next ^ value) ^ 20)) & 0xff;
  }
  const header = Buffer.alloc(4);
  header.writeUInt16LE(randomValue, 0);
  header.writeUInt16LE(320, 2);
  return Buffer.concat([Buffer.from([0x84, 0x04]), header, result]).toString('hex');
}

function rotateRight64(value, count) {
  const bits = BigInt(count % 64);
  const mask = (1n << 64n) - 1n;
  return bits ? ((value >> bits) | ((value << (64n - bits)) & mask)) & mask : value & mask;
}

function encryptHelios(khronos, randomValue = 0) {
  const value = randomValue || randomBytes(4).readUInt32LE(0);
  const seed = Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]);
  const digest = createHash('md5').update(Buffer.concat([seed, Buffer.from('8662')])).digest();
  // Python 版本使用 digest 的 ASCII 十六进制文本（32 字节），不能把
  // 16 个 Buffer 直接交给 Buffer.from(array)，后者只会保留每项的首字节。
  const keyBytes = Buffer.from(digest.toString('hex'), 'ascii');
  const words = Array.from({ length: 4 }, (_, index) => keyBytes.readBigUInt64LE(index * 8));
  let first = words[0];
  let second = words[1];
  const expanded = words.slice(2);
  const table = [words[0]];
  for (let index = 0; index < 0x22; index++) {
    let value2 = (rotateRight64(second, 8) + first) & ((1n << 64n) - 1n);
    value2 = (value2 ^ BigInt(index)) & ((1n << 64n) - 1n);
    expanded.push(value2);
    value2 = (value2 ^ rotateRight64(first, 61)) & ((1n << 64n) - 1n);
    table.push(value2);
    first = value2;
    second = expanded.shift();
  }
  const raw = Buffer.from(`${khronos}-1588093228-8662`);
  const padding = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padding, padding)]);
  const output = Buffer.alloc(padded.length);
  for (let offset = 0; offset < padded.length; offset += 16) {
    let left = padded.readBigUInt64LE(offset);
    let right = padded.readBigUInt64LE(offset + 8);
    for (let index = 0; index < 0x22; index++) {
      right = (table[index] ^ (left + rotateRight64(right, 8))) & ((1n << 64n) - 1n);
      left = (right ^ rotateRight64(left, 61)) & ((1n << 64n) - 1n);
    }
    output.writeBigUInt64LE(left, offset);
    output.writeBigUInt64LE(right, offset + 8);
  }
  return Buffer.concat([seed, output]).toString('base64');
}

async function genMedusaSafe(url, params, device, body, khronos, dataType) {
  return genMedusa(url, params, device, body, khronos, dataType);
}

async function coreSixgod(url, params, device, body, headers) {
  const values = { ...params };
  for (const [key, value] of Object.entries(device || {})) {
    if (Object.prototype.hasOwnProperty.call(values, key)) values[key] = value;
    else if (key === 'device_id' && Object.prototype.hasOwnProperty.call(values, 'did')) values.did = value;
  }
  const khronos = Math.floor(Date.now() / 1000);
  values.ts = khronos;
  values._rticket = Date.now();
  const query = Object.entries(values).map(([key, value]) => `${pythonQueryEncode(key)}=${pythonQueryEncode(value)}`).join('&');
  const signedUrl = `${String(url).split('?')[0]}?${query}`;
  const randomValue = randomBytes(2).readUInt16BE(0);
  const resultHeaders = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  resultHeaders['x-ladon'] = Buffer.from([(khronos >>> 24) & 255, (khronos >>> 16) & 255, (khronos >>> 8) & 255, khronos & 255]).toString('base64');
  resultHeaders['x-khronos'] = String(khronos);
  resultHeaders['x-argus'] = Buffer.from([khronos & 255, (khronos >>> 8) & 255, (khronos >>> 16) & 255, (khronos >>> 24) & 255]).toString('base64');
  resultHeaders['x-gorgon'] = encryptGorgon(bodyText, query, khronos, randomValue);
  resultHeaders['x-helios'] = encryptHelios(khronos);
  const medusa = await genMedusaSafe(signedUrl, values, device || {}, bodyText, khronos, resultHeaders['content-type']);
  if (medusa) resultHeaders['x-medusa'] = medusa;
  if (bodyText) resultHeaders['x-ss-stub'] = md5Hex(bodyText);
  resultHeaders['x-tt-dt'] = String(device?.x_tt_dt || '');
  if (device?.ua) resultHeaders['user-agent'] = String(device.ua);
  return { url: signedUrl, headers: resultHeaders };
}

const MODEL_CACHE_TTL = 3 * 60 * 1000;
const MODEL_CACHE_LIMIT = 64;
const modelCache = new Map();
async function videoModel(videoId, config = {}) {
  const cacheKey = String(videoId);
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() < hit.expires) {
    await log('info', `[hg][model] vid=${videoId} 命中模型缓存（剩余 ${Math.round((hit.expires - Date.now()) / 1000)}s）`);
    return hit.model;
  }
  if (hit) modelCache.delete(cacheKey);
  const device = getDevice();
  const payload = JSON.stringify({
    dr_scene: 'player',
    biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
    mixed_video_id_map: { '1004': [String(videoId)] },
  });
  const attempts = [
    () => playbackRequest(payload, device, VIDEO_API),
    () => playbackRequest(payload, device, VIDEO_API_FALLBACK),
  ];
  let lastReason = '';
  for (const build of attempts) {
    try {
      const signed = build();
      await log('info', `[hg][model] vid=${videoId} POST ${new URL(signed.url).host}${new URL(signed.url).pathname} gzip=${signed.body.length}`);
      const response = await httpRequest(signed.url, {
        method: 'POST', headers: signed.headers, body: signed.body, timeout: 30000,
        agent: new URL(signed.url).protocol === 'https:' ? APP_HTTPS_AGENT : undefined,
      });
      const root = objectOf(responsePayload(response));
      const data = root.data && typeof root.data === 'object' ? root.data : root;
      let entry = data[videoId];
      if (!entry) entry = Object.values(data).find(v => v && typeof v === 'object' && !Array.isArray(v)) || data;
      let model = entry?.video_model ?? data.video_model ?? entry;
      if (typeof model === 'string') model = parseJSON(model, {});
      if (model && typeof model === 'object' && Object.keys(model).length) {
        await log('info', `[hg][model] vid=${videoId} 命中播放模型 keys=${Object.keys(model).length}`);
        modelCache.set(cacheKey, { model, expires: Date.now() + MODEL_CACHE_TTL });
        while (modelCache.size > MODEL_CACHE_LIMIT) modelCache.delete(modelCache.keys().next().value);
        return model;
      }
      lastReason = `HTTP ${response.status} 空体`;
    } catch (err) {
      lastReason = err.message || String(err);
    }
  }
  // 终极兜底：番茄小说客户端短剧接口 (aid:1967)
  try {
    const signed = shortplayRequest(videoId, device);
    const response = await httpRequest(signed.url, {
      method: 'POST', headers: signed.headers, body: signed.body, timeout: 30000,
      agent: new URL(signed.url).protocol === 'https:' ? APP_HTTPS_AGENT : undefined,
    });
    const root = objectOf(responsePayload(response));
    const data = root.data && typeof root.data === 'object' ? root.data : root;
    const entry = data[videoId] || data.video_model || data;
    let model = entry?.video_model ?? entry;
    if (typeof model === 'string') model = parseJSON(model, {});
    if (model && typeof model === 'object' && Object.keys(model).length) {
      await log('info', `[hg][model] vid=${videoId} 命中 SHORTPLAY 兜底模型`);
      modelCache.set(cacheKey, { model, expires: Date.now() + MODEL_CACHE_TTL });
      while (modelCache.size > MODEL_CACHE_LIMIT) modelCache.delete(modelCache.keys().next().value);
      return model;
    }
  } catch (err) {
    lastReason = err.message || String(err);
  }
  await log('error', `[hg][model] vid=${videoId} 播放模型为空: ${lastReason}`);
  throw new Error(`红果 video_model 为空（${lastReason}）`);
}

const MEDIA_SESSION_TTL = 15 * 60 * 1000;
const MEDIA_SESSION_LIMIT = 4;
const MEDIA_RANGE_CHUNK = 1 << 20;
const MEDIA_HEAD_PROBE = 1 << 16;
const mediaSessions = new Map();
// 跨 Range 复用 TLS 连接，避免每个 1MB 分片重新握手。
const MEDIA_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 60000 });
const APP_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, timeout: 30000 });
// fetchMoov() 探测到的 0..MEDIA_HEAD_PROBE-1 字节缓存进 session，播放器首个 Range 直接命中。
const MEDIA_PREFIX_CACHE_TTL = 10 * 60 * 1000;


// ---------------------------------------------------------------------------
// 定时清扫（默认 6 小时）：内存缓存 / 过期媒体会话 / 空闲 TLS 连接 / 日志 / 历史视频临时文件
// 活跃播放会话受 MEDIA_ACTIVE_GRACE_MS 保护，不会被清扫中断。
// ---------------------------------------------------------------------------
const MEDIA_ACTIVE_GRACE_MS = 2 * 60 * 1000;
const CACHE_FILE_RE = /\.(mp4|m4s|ts|mkv|avi|flv|mov|webm|wmv|bin|part|downloading|m3u8)$/i;

function sweepMemoryCaches(now) {
  let home = 0;
  for (const [k, v] of _homeCache) if (now > v.expires) { _homeCache.delete(k); home++; }
  let series = 0;
  for (const [k, v] of seriesDetailCache) if (v.expiresAt <= now) { seriesDetailCache.delete(k); series++; }
  let models = 0;
  for (const [k, v] of modelCache) if (v.expires <= now) { modelCache.delete(k); models++; }
  return { home, series, models };
}

async function sweepMediaSessions(now) {
  let removed = 0;
  let kept = 0;
  let active = 0;
  let prefixes = 0;
  for (const [key, entry] of Array.from(mediaSessions)) {
    let session = null;
    try {
      session = await Promise.race([
        Promise.resolve(entry.promise).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 1000)),
      ]);
    } catch (_) { session = null; }
    const lastUsed = Number(session && session.lastUsed) || 0;
    const activeRecently = lastUsed > 0 && now - lastUsed < MEDIA_ACTIVE_GRACE_MS;
    const expired = now - (Number(entry.createdAt) || 0) > MEDIA_SESSION_TTL;
    if (expired && !activeRecently) {
      mediaSessions.delete(key);
      if (session) {
        try { session.prefix = null; session.prefixPlain = null; } catch (_) { /* ignore */ }
        prefixes++;
      }
      removed++;
    } else {
      kept++;
      if (activeRecently) active++;
      if (session && session.prefixUntil && now > session.prefixUntil) {
        try { session.prefix = null; session.prefixPlain = null; prefixes++; } catch (_) { /* ignore */ }
      }
    }
  }
  return { removed, kept, active, prefixes };
}

function sweepIdleSockets() {
  let closed = 0;
  for (const agent of [MEDIA_HTTPS_AGENT, APP_HTTPS_AGENT]) {
    try {
      for (const list of Object.values(agent.freeSockets || {})) {
        for (const socket of (Array.isArray(list) ? list : [list])) {
          if (!socket) continue;
          try { socket.destroy(); closed++; } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* freeSockets 属 Node 内部字段，版本差异时跳过 */ }
  }
  return closed;
}

function sweepLogFile() {
  if (!IS_STREAM_PROCESS || HG_PROXY_LOG_MAX_MB <= 0) return { truncated: false, before: 0 };
  const max = HG_PROXY_LOG_MAX_MB * 1024 * 1024;
  try {
    const stat = fs.statSync(HG_PROXY_LOG);
    if (stat.size <= max) return { truncated: false, before: stat.size };
    // 子进程持有 O_APPEND fd，truncate 后新日志从 0 继续写；不能用 rename，否则 fd 仍写旧文件。
    fs.truncateSync(HG_PROXY_LOG, 0);
    return { truncated: true, before: stat.size };
  } catch (_) { return { truncated: false, before: 0 }; }
}

function sweepDiskFiles(now) {
  if (!HG_PROXY_SWEEP_DISK) return { skipped: true, removed: 0, freed: 0 };
  let removed = 0;
  let freed = 0;
  try {
    if (!fs.existsSync(HG_PROXY_CACHE_DIR) || !fs.statSync(HG_PROXY_CACHE_DIR).isDirectory()) {
      return { skipped: false, removed: 0, freed: 0 };
    }
    // 只处理该目录一层，不递归；只删白名单扩展名且超过一个清扫周期未修改的文件。
    for (const name of fs.readdirSync(HG_PROXY_CACHE_DIR)) {
      if (!CACHE_FILE_RE.test(name)) continue;
      const file = path.join(HG_PROXY_CACHE_DIR, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || now - stat.mtimeMs < HG_PROXY_SWEEP_MS) continue;
        fs.unlinkSync(file);
        removed++;
        freed += stat.size;
      } catch (_) { /* 单个文件失败不影响其余 */ }
    }
  } catch (_) { /* 目录不可读时跳过 */ }
  return { skipped: false, removed, freed };
}

async function runSweep(reason) {
  const now = Date.now();
  const mem = sweepMemoryCaches(now);
  const sessions = await sweepMediaSessions(now);
  const sockets = sweepIdleSockets();
  const disk = sweepDiskFiles(now);
  const logInfo = sweepLogFile();
  const freedMB = (disk.freed / 1048576).toFixed(1);
  await log('info',
    `[hg][sweep] ${reason} 清扫完成(间隔=${Math.round(HG_PROXY_SWEEP_MS / 3600000 * 10) / 10}h): ` +
    `home=${mem.home} series=${mem.series} model=${mem.models} ` +
    `sessions=${sessions.removed}删/${sessions.kept}留(活跃=${sessions.active}) prefix=${sessions.prefixes} ` +
    `空闲连接=${sockets} 磁盘=${disk.removed}个/${freedMB}MB ` +
    `日志=${logInfo.before}B${logInfo.truncated ? '→已截断' : '未超限'}`);
}

let _sweepTimer = null;
function startSweepTimer() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    runSweep('定时').catch(err => log('warn', `[hg][sweep] 清扫异常: ${err && err.message ? err.message : err}`));
  }, HG_PROXY_SWEEP_MS);
  if (_sweepTimer && typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
  log('info', `[hg][sweep] 已启动定时清扫: 每 ${Math.round(HG_PROXY_SWEEP_MS / 3600000 * 10) / 10} 小时一次, 日志上限=${HG_PROXY_LOG_MAX_MB}MB, 磁盘目录=${HG_PROXY_CACHE_DIR}`)
    .catch(() => {});
}

function findBox(data, fourcc, start = 0) {
  const tag = Buffer.from(fourcc, 'ascii');
  for (let index = Math.max(4, start); index <= data.length - 4; index++) {
    if (!data.subarray(index, index + 4).equals(tag)) continue;
    let size = data.readUInt32BE(index - 4);
    let headerSize = 8;
    if (size === 1) {
      if (index + 12 > data.length) continue;
      const extended = data.readBigUInt64BE(index + 4);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      size = Number(extended);
      headerSize = 16;
    }
    if (size >= headerSize && index - 4 + size <= data.length) return [index - 4, size];
  }
  return [-1, 0];
}

function boxBody(data, fourcc, start) {
  const [offset, size] = findBox(data, fourcc, start);
  return offset >= 0 ? data.subarray(offset + 8, offset + size) : null;
}

function parseTrack(moov, trackOffset) {
  if (trackOffset < 0) return null;
  const [stblOffset] = findBox(moov, 'stbl', trackOffset + 8);
  if (stblOffset < 0) return null;
  const stsz = boxBody(moov, 'stsz', stblOffset);
  const stco = boxBody(moov, 'stco', stblOffset);
  const co64 = boxBody(moov, 'co64', stblOffset);
  const stsc = boxBody(moov, 'stsc', stblOffset);
  const saiz = boxBody(moov, 'saiz', stblOffset);
  const saio = boxBody(moov, 'saio', stblOffset);
  if (!stsz || !stsc || !saiz || !saio || (!stco && !co64)) return null;
  if (stsz.length < 12 || stsc.length < 8) return null;

  const defaultSize = stsz.readUInt32BE(4);
  const sampleCount = stsz.readUInt32BE(8);
  if (!sampleCount || sampleCount > 2_000_000) return null;
  if (!defaultSize && stsz.length < 12 + sampleCount * 4) return null;
  const sizes = defaultSize ? Array(sampleCount).fill(defaultSize) : Array.from({ length: sampleCount }, (_, i) => stsz.readUInt32BE(12 + i * 4));

  const chunkTable = stco || co64;
  const chunkWidth = stco ? 4 : 8;
  if (chunkTable.length < 8) return null;
  const chunkCount = chunkTable.readUInt32BE(4);
  if (chunkCount > 2_000_000 || chunkTable.length < 8 + chunkCount * chunkWidth) return null;
  const offsets = Array.from({ length: chunkCount }, (_, i) => {
    const value = chunkWidth === 4 ? BigInt(chunkTable.readUInt32BE(8 + i * chunkWidth)) : chunkTable.readBigUInt64BE(8 + i * chunkWidth);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 chunk offset 超出安全范围');
    return Number(value);
  });

  const entryCount = stsc.readUInt32BE(4);
  if (entryCount > 2_000_000 || stsc.length < 8 + entryCount * 12) return null;
  const entries = Array.from({ length: entryCount }, (_, i) => ({
    first: stsc.readUInt32BE(8 + i * 12), samples: stsc.readUInt32BE(12 + i * 12),
  }));
  const chunkSamples = Array(chunkCount).fill(0);
  for (let i = 0; i < entries.length; i++) {
    const begin = Math.max(0, entries[i].first - 1);
    const stop = Math.min(i + 1 < entries.length ? entries[i + 1].first - 1 : chunkCount, chunkCount);
    for (let chunk = begin; chunk < stop; chunk++) chunkSamples[chunk] = entries[i].samples;
  }

  const saizFlags = saiz.readUIntBE(1, 3);
  const saizCursor = saizFlags & 1 ? 12 : 4;
  if (saiz.length < saizCursor + 5) return null;
  const defaultAuxSize = saiz[saizCursor];
  const auxCount = saiz.readUInt32BE(saizCursor + 1);
  if (auxCount > 2_000_000) return null;
  if (!defaultAuxSize && saiz.length < saizCursor + 5 + auxCount) return null;
  const auxSizes = defaultAuxSize ? Array(auxCount).fill(defaultAuxSize) : Array.from({ length: auxCount }, (_, i) => saiz[saizCursor + 5 + i]);

  const saioFlags = saio.readUIntBE(1, 3);
  const saioCursor = saioFlags & 1 ? 12 : 4;
  const offsetWidth = saio[0] === 1 ? 8 : 4;
  if (saio.length < saioCursor + 4 + offsetWidth) return null;
  const saioCount = saio.readUInt32BE(saioCursor);
  if (!saioCount) return null;
  const rawOffset = offsetWidth === 8 ? saio.readBigUInt64BE(saioCursor + 4) : BigInt(saio.readUInt32BE(saioCursor + 4));
  if (rawOffset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { sizes, offsets, chunkSamples, auxSizes, auxOffset: Number(rawOffset), sampleCount };
}

function topLevelBoxes(data) {
  const boxes = [];
  let cursor = 0;
  while (cursor + 8 <= data.length) {
    let size = data.readUInt32BE(cursor);
    const type = data.toString('ascii', cursor + 4, cursor + 8);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > data.length) break;
      const extended = data.readBigUInt64BE(cursor + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) size = data.length - cursor;
    if (size < headerSize) break;
    boxes.push({ offset: cursor, size, type });
    if (cursor + size > data.length) break;
    cursor += size;
  }
  return boxes;
}

function originalFormatNear(data, entryPos, fallback) {
  const end = Math.min(data.length, entryPos + 800);
  let index = entryPos;
  while ((index = data.indexOf('frma', index, 'ascii')) >= 0 && index + 8 <= end) {
    const format = data.subarray(index + 4, index + 8);
    if (!format.equals(Buffer.alloc(4)) && format.toString('ascii') !== 'encv' && format.toString('ascii') !== 'enca' && [...format].every((byte) => byte >= 32 && byte < 127)) return Buffer.from(format);
    index += 4;
  }
  return Buffer.from(fallback);
}

function restoreCencCodecs(data) {
  for (const [encrypted, fallback] of [['encv', 'avc1'], ['enca', 'mp4a']]) {
    let position = 0;
    while ((position = data.indexOf(encrypted, position, 'ascii')) >= 0) {
      const format = originalFormatNear(data, position, fallback);
      format.copy(data, position, 0, 4);
      position += 4;
    }
  }
}

function replaceSinf(data) {
  let position = 0;
  while ((position = data.indexOf('sinf', position, 'ascii')) >= 0) {
    if (position >= 4) {
      const size = data.readUInt32BE(position - 4);
      const end = position - 4 + size;
      if (size >= 8 && size < 50_000 && end <= data.length) {
        data.write('free', position, 4, 'ascii');
        data.fill(0, position + 4, end);
        position = end;
        continue;
      }
    }
    position += 4;
  }
}

function rewriteMoov(moov) {
  const plain = Buffer.from(moov);
  restoreCencCodecs(plain);
  replaceSinf(plain);
  return plain;
}

function sampleTable(moov, moovStart) {
  const samples = [];
  let trackSearch = 0;
  while (true) {
    const [track, trackSize] = findBox(moov, 'trak', trackSearch);
    if (track < 0) break;
    trackSearch = track + Math.max(trackSize, 8);
    const parsed = parseTrack(moov, track);
    if (!parsed) continue;
    const { sizes, offsets, chunkSamples, auxSizes, auxOffset, sampleCount } = parsed;
    const auxLength = auxSizes.reduce((sum, size) => sum + Math.max(size, 8), 0);
    const localAux = auxOffset - moovStart;
    if (!sampleCount || localAux < 0 || localAux + auxLength > moov.length) throw new Error('CENC 辅助信息不在 moov 内，无法流式解密');
    let sampleIndex = 0;
    let auxIndex = 0;
    for (let chunkIndex = 0; chunkIndex < offsets.length; chunkIndex++) {
      let current = offsets[chunkIndex];
      for (let j = 0; j < chunkSamples[chunkIndex]; j++) {
        if (sampleIndex >= sampleCount || sampleIndex >= sizes.length) break;
        if (sampleIndex >= auxSizes.length) throw new Error('CENC 辅助信息数量不足');
        const entrySize = Math.max(auxSizes[sampleIndex], 8);
        const iv = Buffer.alloc(16);
        moov.copy(iv, 0, localAux + auxIndex, localAux + auxIndex + Math.min(entrySize, 8));
        samples.push({ offset: current, size: sizes[sampleIndex], iv });
        current += sizes[sampleIndex];
        auxIndex += entrySize;
        sampleIndex++;
      }
    }
  }
  if (!samples.length) throw new Error('moov 中没有可解密的 CENC 样本');
  samples.sort((a, b) => a.offset - b.offset);
  return samples;
}

function parseRange(value, total) {
  const source = text(value).toLowerCase();
  if (!source.startsWith('bytes=')) return null;
  const spec = source.slice(6).split(',')[0].trim();
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);
  if (!left) {
    if (!/^\d+$/.test(right)) return null;
    const length = Math.min(Number(right), total);
    return length ? [total - length, total - 1] : false;
  }
  if (!/^\d+$/.test(left)) return null;
  const start = Number(left);
  const end = Math.min(/^\d+$/.test(right) ? Number(right) : total - 1, total - 1);
  return start >= total || start > end ? false : [start, end];
}

function responseBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'binary');
  return Buffer.alloc(0);
}

async function rangeGet(url, start, end) {
  const expected = end - start + 1;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await httpRequest(url, {
        method: 'GET',
        headers: { 'User-Agent': MEDIA_UA, Referer: 'https://novel.snssdk.com/', Accept: '*/*', Range: `bytes=${start}-${end}` },
        binary: true, timeout: 60000,
        agent: new URL(url).protocol === 'https:' ? MEDIA_HTTPS_AGENT : undefined,
      });
      const status = Number(response?.status ?? response?.statusCode ?? 0);
      if (status && status !== 200 && status !== 206) throw new Error(`媒体分片 HTTP ${status}`);
      const body = responseBuffer(response?.data ?? response);
      if (!body.length || (status === 206 && body.length < expected)) throw new Error(`媒体分片长度不足 ${body.length}/${expected}`);
      const headers = response?.headers || {};
      const contentRange = text(headers['content-range'] || headers['Content-Range']);
      const totalMatch = contentRange.match(/\/(\d+)$/);
      const lengthHeader = Number(headers['content-length'] || headers['Content-Length'] || 0);
      const total = totalMatch ? Number(totalMatch[1]) : (lengthHeader || body.length);
      if (status === 200 && body.length > expected) {
        // 部分 CDN 忽略 Range；按 Python 版本取所需区间，避免代理直接返回 502。
        if (start + expected > body.length) throw new Error(`媒体完整响应长度不足 ${body.length}/${start + expected}`);
        return { body: body.subarray(start, start + expected), total };
      }
      return { body, total };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
  }
  throw lastError || new Error('媒体分片请求失败');
}

async function fetchMoov(url) {
  const t0 = Date.now();
  const probe = await rangeGet(url, 0, MEDIA_HEAD_PROBE - 1);
  if (!probe.total) throw new Error('媒体总长度未知');
  const box = topLevelBoxes(probe.body).find((item) => item.type === 'moov');
  if (!box) throw new Error('未找到 MP4 moov 盒');
  if (box.offset + box.size > probe.total) throw new Error('MP4 moov 越界');
  let result;
  let prefix = probe.body;
  if (box.offset + box.size <= probe.body.length) {
    result = { total: probe.total, moovStart: box.offset, moov: Buffer.from(probe.body.subarray(box.offset, box.offset + box.size)) };
  } else {
    // 首个 64KB 已下载；只续拉剩余部分，拼成 0..moovEnd-1 的连续字节，
    // 既省一次重叠下载，也让首个播放器 Range 能命中更大的解密前缀缓存。
    const from = Math.max(probe.body.length, box.offset);
    const to = box.offset + box.size - 1;
    const rest = await rangeGet(url, from, to);
    if (rest.body.length !== to - from + 1) throw new Error('MP4 moov 续传长度不符');
    const full = Buffer.concat([probe.body, rest.body]);
    if (full.length !== to + 1) throw new Error('MP4 moov 拼接不连续');
    result = { total: probe.total, moovStart: box.offset, moov: Buffer.from(full.subarray(box.offset, box.offset + box.size)) };
    prefix = full;
  }
  // 前缀缓存限 1MB，避免 moov 异常大时占内存；首个 Range 一般远小于此。
  result.prefix = prefix.length > (1 << 20) ? prefix.subarray(0, 1 << 20) : prefix;
  await log('info', `[hg][moov] 探测完成 total=${result.total} moov=${result.moov.length} prefix=${result.prefix.length} 耗时=${Date.now() - t0}ms`);
  return result;
}

class CencMediaSession {
  constructor(url, key, total, moovStart, moov, prefix) {
    if (key.length !== 16) throw new Error('CENC 密钥长度错误');
    this.url = url;
    this.key = key;
    this.total = total;
    this.moovStart = moovStart;
    this.moovEnd = moovStart + moov.length;
    this.moovPlain = rewriteMoov(moov);
    this.samples = sampleTable(moov, moovStart);
    if (this.samples.some((sample) => sample.offset < 0 || sample.size <= 0 || sample.offset + sample.size > total)) throw new Error('MP4 样本偏移超出媒体长度');
    this.offsets = this.samples.map((sample) => sample.offset);
    // 前 64KB 已在 fetchMoov 阶段下载，保留解密后的副本供首个 Range 命中。
    this.prefix = prefix && prefix.length ? Buffer.from(prefix) : null;
    this.prefixPlain = this.prefix ? this.patch(Buffer.from(this.prefix), 0) : null;
    this.prefixUntil = this.prefix ? Date.now() + MEDIA_PREFIX_CACHE_TTL : 0;
    this.lastUsed = Date.now();
  }

  patch(buffer, base) {
    const end = base + buffer.length - 1;
    let low = 0;
    let high = this.offsets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.offsets[mid] <= base) low = mid + 1;
      else high = mid;
    }
    let index = Math.max(low - 1, 0);
    while (index < this.samples.length) {
      const sample = this.samples[index++];
      if (sample.offset > end) break;
      if (sample.offset + sample.size <= base) continue;
      const first = Math.max(sample.offset, base);
      const last = Math.min(sample.offset + sample.size - 1, end);
      const skip = first - sample.offset;
      const counter = Buffer.from(sample.iv);
      const initial = (counter.readBigUInt64BE(0) << 64n) | counter.readBigUInt64BE(8);
      const adjusted = (initial + BigInt(Math.floor(skip / 16))) & ((1n << 128n) - 1n);
      const ctr = Buffer.alloc(16);
      ctr.writeBigUInt64BE(adjusted >> 64n, 0);
      ctr.writeBigUInt64BE(adjusted & ((1n << 64n) - 1n), 8);
      const padding = skip % 16;
      const encrypted = Buffer.from(buffer.subarray(first - base, last - base + 1));
      const decipher = createDecipheriv('aes-128-ctr', this.key, ctr);
      const plain = Buffer.concat([decipher.update(Buffer.concat([Buffer.alloc(padding), encrypted])), decipher.final()]);
      plain.copy(buffer, first - base, padding);
    }
    if (base < this.moovEnd && end >= this.moovStart) {
      const first = Math.max(base, this.moovStart);
      const last = Math.min(end, this.moovEnd - 1);
      this.moovPlain.copy(buffer, first - base, first - this.moovStart, last - this.moovStart + 1);
    }
    this.lastUsed = Date.now();
    return buffer;
  }

  async readRange(start, end) {
    if (this.prefixPlain && Date.now() < this.prefixUntil && end < this.prefixPlain.length) {
      return Buffer.from(this.prefixPlain.subarray(start, end + 1));
    }
    if (Date.now() >= this.prefixUntil) { this.prefix = null; this.prefixPlain = null; }
    const { body } = await rangeGet(this.url, start, end);
    return this.patch(Buffer.from(body.subarray(0, end - start + 1)), start);
  }

  async *iterRange(start, end) {
    let cursor = start;
    while (cursor <= end) {
      const stop = Math.min(cursor + MEDIA_RANGE_CHUNK - 1, end);
      const block = await this.readRange(cursor, stop);
      if (!block.length) throw new Error('媒体分片为空');
      yield block;
      cursor += block.length;
    }
  }
}

async function mediaSession(videoId, quality, did, iid) {
  const key = `${videoId}|${quality}|${did}|${iid}`;
  const now = Date.now();
  for (const [entryKey, entry] of mediaSessions) if (now - entry.createdAt > MEDIA_SESSION_TTL) mediaSessions.delete(entryKey);
  const cached = mediaSessions.get(key);
  if (cached) {
    cached.createdAt = now;
    return await cached.promise;
  }
  const promise = (async () => {
    const model = await videoModel(videoId, { device_id: did, iid, install_id: iid });
    const [actualQuality, selected] = selectQuality(videoList(model), quality);
    let url = mediaUrl(selected);
    const spade = spadeValue(selected);
    if (!url || !spade) throw new Error('红果播放模型缺少媒体地址或 CENC 密钥');
    const keySeed = keySeedOf(model);
    if (keySeed.length) {
      try { url = decryptSpadeUrl(url, keySeed); } catch { /* 部分版本直接返回明文媒体地址 */ }
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('红果视频地址格式无效');
    const contentKey = deriveContentKey(spade);
    const { total, moovStart, moov, prefix } = await fetchMoov(url);
    const session = new CencMediaSession(url, contentKey, total, moovStart, moov, prefix);
    session.quality = actualQuality;
    return session;
  })();
  mediaSessions.set(key, { createdAt: now, promise });
  try {
    const session = await promise;
    mediaSessions.set(key, { createdAt: Date.now(), promise: Promise.resolve(session) });
    while (mediaSessions.size > MEDIA_SESSION_LIMIT) mediaSessions.delete(mediaSessions.keys().next().value);
    return session;
  } catch (error) {
    mediaSessions.delete(key);
    throw error;
  }
}

function mediaEndpointUrl(params, context) {
  let base = HG_PROXY_BASE;
  if (!base) {
    // context.headers.host 是宿主 OmniBox 的 web 端口，不能直接用；只取主机名，
    // 端口强制替换为独立流服务端口。
    const explicit = String(process.env.HOST_IP || '').trim();
    const raw = text(context?.headers?.host || context?.headers?.Host || context?.baseURL || '');
    let hostname = explicit;
    if (!hostname && raw) {
      try { hostname = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname; } catch (_) { hostname = ''; }
    }
    if (!hostname) hostname = detectLanIp();
    base = `http://${hostname}:${HG_PROXY_PORT}`;
  }
  const u = new URL('/media.mp4', base);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

async function serveMediaHttp(req, res) {
  const u = new URL(req.url || '/', 'http://localhost');
  const query = Object.fromEntries(u.searchParams);
  const directVideoId = text(query.vid || query.id);
  const seriesId = text(query.sid);
  const episode = toInt(query.ep);
  const quality = qualityOf(query.q || '1080');
  if (!/^\d+$/.test(directVideoId) && (!/^\d+$/.test(seriesId) || episode < 1)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('missing video id or episode');
    return;
  }
  let session;
  try {
    const videoId = /^\d+$/.test(directVideoId) ? directVideoId : await resolveSeriesEpisode(seriesId, episode);
    session = await mediaSession(videoId, quality, text(query.did, ''), text(query.iid, ''));
    if (text(query.warm) === '1') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '2' });
      res.end('ok');
      return;
    }
  } catch (error) {
    await log('error', `[hg][media] 会话构建失败: ${error && error.stack ? error.stack.split('\n')[0] : error}`);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`media session failed: ${error && error.message ? error.message : error}`);
    return;
  }
  const requested = parseRange(req.headers.range, session.total);
  if (requested === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${session.total}`, 'Content-Length': '0' });
    res.end();
    return;
  }
  const [start, end] = requested || [0, session.total - 1];
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'no-store',
  };
  if (requested) headers['Content-Range'] = `bytes ${start}-${end}/${session.total}`;
  res.writeHead(requested ? 206 : 200, headers);
  if (String(req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return; }
  try {
    for await (const block of session.iterRange(start, end)) {
      if (res.destroyed) return;
      if (!res.write(block)) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`media range failed: ${error && error.message ? error.message : error}`);
    } else res.destroy(error);
  }
}

async function play(params, context) {
  const flag = text(bodyOf(params)?.flag, '1080P') || '1080P';
  try {
    const body = bodyOf(params);
    const rawId = text(body.playId || body.id || body.url);
    if (!rawId) throw new Error('playId 不能为空');
    await log('info', `[hg][play] 入口 playId=${rawId} flag=${flag} from=${context?.from || 'web'}`);
    if (/^https?:\/\//i.test(rawId)) {
      return { urls: [{ name: flag, url: rawId }], flag, header: { 'User-Agent': MEDIA_UA }, parse: 0 };
    }
    const token = parseEpisodeToken(rawId);
    if (token.kind === 'video' && !/^\d+$/.test(token.videoId)) throw new Error('无效的红果播放参数');
    if (token.kind === 'series-episode' && (!/^\d+$/.test(token.seriesId) || token.episode < 1)) throw new Error('无效的红果剧集参数');
    const tokenQuality = QUALITY_ORDER.includes(token.quality) ? token.quality : '1080';
    const requestedQuality = tokenQuality === '1080' && text(body.flag) ? qualityFromFlag(body.flag, tokenQuality) : tokenQuality;
    const mediaParams = token.kind === 'series-episode'
      ? { sid: token.seriesId, ep: String(token.episode), q: requestedQuality, hg: 'cenc' }
      : { vid: token.videoId, q: requestedQuality, hg: 'cenc' };
    const ready = await ensureStreamService();
    const url = mediaEndpointUrl(mediaParams, context);
    if (!ready) await log('warn', `[hg][play] 流服务未通过健康探测，仍返回地址: ${url}`);
    // 预热：同进程内先把签名模型 + moov + 首个前缀准备好；播放器连到独立流服务时
    // 两者不共享内存，因此同时向 /media.mp4 发一个 HEAD 让流服务提前建 session。
    if (ready) {
      const warmUrl = new URL(url);
      warmUrl.searchParams.set('warm', '1');
      httpRequest(warmUrl.toString(), { method: 'HEAD', timeout: 15000 })
        .then(() => log('info', `[hg][warm] vid=${mediaParams.vid || mediaParams.sid} 预热完成`))
        .catch((err) => log('info', `[hg][warm] 预热跳过: ${err.message || err}`));
    }
    await log('info', `[hg][play] vid=${token.kind === 'video' ? token.videoId : token.seriesId} 1080P 流地址 → ${url}`);
    return {
      urls: [{ name: `${requestedQuality}P`, url }],
      flag,
      header: { 'User-Agent': MEDIA_UA, Referer: 'https://novel.snssdk.com/' },
      parse: 0,
    };
  } catch (err) {
    await log('error', `[hg][play] 失败: ${err.message || err}`);
    return { urls: [], flag, header: {}, parse: 0 };
  }
}

async function searchLoaderApi(keyword, page) {
  const query = text(keyword);
  if (!query) return { searchList: [], totalCount: 0, totalPages: 1 };
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: `${SITE}/` };
  // 官网同款前置请求：先取 ttwid（首访）与 suggestion keyword
  try { await httpRequest(SITE + '/', { headers, timeout: 10000 }); } catch (_) { /* 忽略 */ }
  let sug = '';
  try {
    const r = await httpRequest(`${SITE}/api/search/suggestion/?aid=8662&query=${encodeURIComponent(query)}`, { headers, timeout: 10000 });
    if (Number(r.status) === 200) {
      const rows = (objectOf(r.data).suggestionList) || [];
      if (rows.length && rows[0] && rows[0].keyword) sug = text(rows[0].keyword);
    }
  } catch (_) { /* 忽略 */ }
  const qs = new URLSearchParams({ aid: '8662', query, page: String(Math.max(1, Number(page) || 1)) });
  if (sug) qs.set('keyword', sug);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await httpRequest(`${SITE}/api/search/result?${qs.toString()}`, { headers, timeout: 20000 });
      if (Number(r.status) === 200) {
        const data = objectOf(r.data);
        const rows = Array.isArray(data.searchList) ? data.searchList : [];
        if (rows.length) {
          return {
            searchList: rows,
            totalCount: Number(data.totalCount) || rows.length,
            totalPages: Math.max(1, Number(data.totalPages) || 1),
          };
        }
      }
    } catch (_) { /* 退避重试 */ }
    await sleep(600 * (attempt + 1));
  }
  await log('warn', `[hg][search] 官网搜索接口无结果 query=${query} page=${page}，回退 SSR`);
  return searchLoader(keyword);
}

async function search(params, context) {
  const body = bodyOf(params);
  const keyword = text(body.keyword ?? body.wd ?? body.key, '').trim();
  const page = pageOf(body.page ?? body.pg);
  if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };
  await log('info', `[hg][search] keyword=${keyword} page=${page}`);
  try {
    const data = await searchLoaderApi(keyword, page);
    const parsed = objectOf(data);
    const list = safeArray(parsed.searchList).map(itemOf).filter(item => item.vod_id);
    const total = Number(parsed.totalCount) || list.length;
    const pagecount = Math.max(1, Number(parsed.totalPages) || (total ? Math.ceil(total / Math.max(1, list.length)) : 1));
    await log('info', `[hg][search] keyword=${keyword} 返回 list=${list.length} total=${total}`);
    return { page, pagecount, limit: list.length, total: total || list.length, list };
  } catch (err) {
    await log('error', `[hg][search] 失败: ${err.message || err}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

module.exports = { home, category, detail, search, play };

startSweepTimer();

if (IS_STREAM_PROCESS) {
  // 独立流服务进程：不进入 spider_runner，长驻提供 /media.mp4 与 /__hg_health
  const port = Number(process.argv[process.argv.indexOf('--hg-stream') + 1]) || HG_PROXY_PORT;
  startStreamServer(port).then(() => {
    console.log(`[hg-stream] 监听 ${HG_PROXY_HOST}:${port}  健康检查=${HG1080_HEALTH_PATH}  播放=/media.mp4?vid=&q=`);
  }).catch((err) => {
    console.error(`[hg-stream] 启动失败: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
} else {
  runner.run(module.exports);
}
