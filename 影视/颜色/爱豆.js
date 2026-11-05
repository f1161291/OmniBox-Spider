// @name 爱豆 (aida5)
// @version 1.0.0
// @downloadURL https://w18.aida5.buzz/
// @indexs 1
// @dependencies crypto

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const crypto = require("crypto");

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

const SITE_API = (process.env.SITE_API || "https://w18.aida5.buzz").replace(/\/$/, "");

const CATEGORIES = [
  { type_id: "1", type_name: "国产" },
  { type_id: "5", type_name: "传媒" },
  { type_id: "2", type_name: "日韩" },
  { type_id: "3", type_name: "欧美" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "6", type_name: "免费" },
];

function randStr(s) {
  return String(s).split("").reverse().join("");
}

function getRsaKey(t) {
  return randStr(String(t * 299) + "1");
}

function aesEncrypt(dataStr, t) {
  const keyStr = getRsaKey(t);
  const key = Buffer.from(keyStr, "latin1");
  const iv = Buffer.from(keyStr, "latin1");
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  let enc = cipher.update(dataStr, "utf8", "base64");
  enc += cipher.final("base64");
  return enc;
}

function aesDecrypt(encStr, t) {
  const keyStr = getRsaKey(t);
  const key = Buffer.from(keyStr, "latin1");
  const iv = Buffer.from(keyStr, "latin1");
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  let dec = decipher.update(encStr, "base64", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

async function awsApi(path, params) {
  const t = Date.now();
  const dataStr = JSON.stringify(params || {});
  const md5Param = parseInt(randStr(String(parseInt(t * 177)) + "1")).toString(16);
  const encData = aesEncrypt(dataStr, t);
  const body = `data=${encodeURIComponent(encData)}`;
  const url = `${SITE_API}/awsapi${path}?md5=${md5Param}`;
  await OmniBox.log("info", `请求: ${url}`);

  const res = await OmniBox.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body)),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": `${SITE_API}/`,
      "Origin": SITE_API,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
    },
    body: body,
  });

  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode}: ${String(res.body || "").slice(0, 200)}`);
  }

  let json;
  try {
    json = JSON.parse(res.body || "{}");
  } catch (e) {
    throw new Error(`JSON解析失败: ${e.message}`);
  }

  if (json.code !== 200) {
    throw new Error(`API code=${json.code}: ${json.message || ""}`);
  }

  if (!json.data) return json;
  const dec = aesDecrypt(json.data, t);
  try {
    json.data = JSON.parse(dec);
  } catch (e) {
    json.data = dec;
  }
  return json;
}

function mapVod(v) {
  const vodId = String(v.vodId || v.id || "");
  const pic = String(v.vodPic || "");
  return {
    vod_id: vodId,
    vod_name: String(v.vodName || v.name || ""),
    vod_pic: pic,
    type_id: String(v.typeId || v.type_id || ""),
    type_name: String(v.typeName || v.type_name || ""),
    vod_remarks: String(v.vodDuration || v.vodRemarks || v.vod_remarks || ""),
    vod_year: String(v.vodYear || v.vod_year || ""),
    vod_douban_score: "",
  };
}

async function home(params, context) {
  try {
    await OmniBox.log("info", "[home] start");
    const data = await awsApi("/vod/search.php", {
      type: "",
      by: "vod_time",
      order: "desc",
      page: 1,
      size: 24,
      tag: "",
      keyword: "",
      count: "",
      extypes: "",
    });
    const rows = (data.data && data.data.rows) || [];
    return {
      class: CATEGORIES.map(c => ({ type_id: c.type_id, type_name: c.type_name })),
      list: rows.map(mapVod),
    };
  } catch (e) {
    await OmniBox.log("error", `[home] 失败: ${e.message}`);
    return { class: CATEGORIES.map(c => ({ type_id: c.type_id, type_name: c.type_name })), list: [] };
  }
}

async function category(params, context) {
  try {
    const categoryId = String((params && params.categoryId) || "1");
    const page = Number((params && params.page) || 1);
    await OmniBox.log("info", `[category] categoryId=${categoryId}, page=${page}`);
    const data = await awsApi("/vod/search.php", {
      type: categoryId,
      by: "vod_time",
      order: "desc",
      page: page,
      size: 24,
      tag: "",
      keyword: "",
      count: "",
      extypes: "",
    });
    const d = (data && data.data) || {};
    const rows = d.rows || [];
    const total = Number(d.total) || 0;
    const size = Number(d.size) || 24;
    const pagecount = size > 0 ? Math.ceil(total / size) : 0;
    return {
      page: Number(d.page) || page,
      pagecount: pagecount,
      total: total,
      list: rows.map(mapVod),
    };
  } catch (e) {
    await OmniBox.log("error", `[category] 失败: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const videoId = String((params && params.videoId) || "");
    await OmniBox.log("info", `[detail] videoId=${videoId}`);
    if (!videoId) return { list: [] };
    const data = await awsApi("/vod/info.php", { id: videoId });
    const v = (data && data.data) || {};
    const playServer = String(v.vodPlayServer || "");
    const playUrl = String(v.vodPlayUrl || "");
    const token = String(v.token || "");
    const fullPlay = playServer + playUrl + (token ? `?token=${token}` : "");
    const playSources = fullPlay
      ? [{ name: String(v.vodPlayFrom || "默认线路"), episodes: [{ name: "播放", playId: fullPlay }] }]
      : [];
    return {
      list: [{
        vod_id: String(v.vodId || videoId),
        vod_name: String(v.vodName || ""),
        vod_pic: String(v.vodPic || ""),
        vod_content: String(v.vodTag || ""),
        vod_director: "",
        vod_actor: "",
        vod_area: "",
        vod_year: String(v.vodTime || "").slice(0, 4),
        vod_remarks: String(v.vodDuration || ""),
        vod_douban_score: "",
        type_name: "",
        vod_play_sources: playSources,
      }],
    };
  } catch (e) {
    await OmniBox.log("error", `[detail] 失败: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = String((params && params.keyword) || "");
    const page = Number((params && params.page) || 1);
    await OmniBox.log("info", `[search] keyword=${keyword}, page=${page}`);
    const data = await awsApi("/vod/search.php", {
      type: "",
      by: "vod_time",
      order: "desc",
      page: page,
      size: 24,
      tag: "",
      keyword: keyword,
      count: "",
      extypes: "",
    });
    const d = (data && data.data) || {};
    const rows = d.rows || [];
    const total = Number(d.total) || 0;
    const size = Number(d.size) || 24;
    const pagecount = size > 0 ? Math.ceil(total / size) : 0;
    return {
      page: Number(d.page) || page,
      pagecount: pagecount,
      total: total,
      list: rows.map(mapVod),
    };
  } catch (e) {
    await OmniBox.log("error", `[search] 失败: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  try {
    const playId = String((params && params.playId) || "");
    await OmniBox.log("info", `[play] playId=${playId}`);
    if (!playId) return { urls: [], parse: 0 };
    return {
      parse: 0,
      url: playId,
      urls: [{ name: "播放", url: playId }],
    };
  } catch (e) {
    await OmniBox.log("error", `[play] 失败: ${e.message}`);
    return { urls: [], parse: 0 };
  }
}
