// @name 影视大全
// @author 梦
// @description 影视站：https://www.iysdq.tv ，支持首页、分类、搜索、详情与播放解析
// @version 1.0.2
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/影视大全.js
// @dependencies cheerio

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");

const HOST = "https://www.iysdq.tv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Referer: `${HOST}/` };

const CLASS_LIST = [
  { type_id: "1", type_name: "电影" },
  { type_id: "2", type_name: "电视剧" },
  { type_id: "3", type_name: "综艺" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "5", type_name: "短剧" },
];

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function getBodyText(res) {
  const body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.toString();
  return String(body || "");
}

function absUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${HOST}${value}`;
  return `${HOST}/${value.replace(/^\/+/, "")}`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fetchText(url, options = {}) {
  return OmniBox.request(url, {
    method: options.method || "GET",
    headers: {
      ...HEADERS,
      ...(options.headers || {}),
      Referer: options.referer || `${HOST}/`,
    },
    timeout: options.timeout || 20000,
    body: options.body,
  }).then((res) => {
    if (!res || Number(res.statusCode) < 200 || Number(res.statusCode) >= 400) {
      throw new Error(`HTTP ${res?.statusCode || "unknown"} @ ${url}`);
    }
    return getBodyText(res);
  });
}

function extractVideos(html) {
  const $ = cheerio.load(html);
  const videos = [];
  const seen = new Set();

  $("a.public-list-exp[href*='/voddetail/']").each((_, el) => {
    const a = $(el);
    const href = String(a.attr("href") || "").trim();
    const m = href.match(/\/voddetail\/(\d+)\.html/);
    const vodId = m ? m[1] : "";
    const vodName = cleanText(a.attr("title") || a.text());
    if (!vodId || !vodName || seen.has(vodId)) return;
    seen.add(vodId);

    const block = a.parent().html() || a.closest(".public-list-box").html() || a.html() || "";
    let vodPic = absUrl(a.find("img").attr("data-src") || a.find("img").attr("src") || "");
    if (!vodPic) {
      const img = block.match(/<img[^>]*(?:data-src|src)="([^"]*)"/i);
      vodPic = absUrl(img ? img[1] : "");
    }
    let vodRemarks = cleanText(a.find(".public-list-prb").text());
    if (!vodRemarks) vodRemarks = cleanText(a.find(".public-list-subtitle").text());

    videos.push({
      vod_id: vodId,
      vod_name: vodName,
      vod_pic: vodPic,
      vod_remarks: vodRemarks,
      vod_content: "",
    });
  });

  return videos;
}

function extractHomeVideos(html) {
  const sections = [
    "最新热播",
    "最新Netflix",
    "最新电影",
    "最新连续剧",
    "最新资讯",
    "最新动漫",
    "最新综艺",
    "最新纪录片",
  ];
  for (const sectionName of sections) {
    const idx = html.indexOf(sectionName);
    if (idx < 0) continue;
    const slice = html.slice(idx, idx + 50000);
    const videos = extractVideos(slice);
    if (videos.length) return videos;
  }
  return extractVideos(html);
}

function buildDetailFromHtml(html, vodId) {
  const $ = cheerio.load(html);
  let vodName = cleanText($(".this-desc-title").first().text());
  if (!vodName) vodName = cleanText($("h1").first().text());

  let vodPic = absUrl($("img").first().attr("data-src") || $("img").first().attr("src") || "");
  if (!vodPic) {
    const pm = html.match(/<img[^>]*(?:data-src|src)="([^"]*(?:upload|cover|vod)[^"]*)"/i);
    vodPic = absUrl(pm ? pm[1] : "");
  }

  let vodContent = cleanText($("meta[name='description']").attr("content") || "");
  if (vodContent) {
    vodContent = vodContent.replace(/^.*?(?:剧情|简介)[：:]\s*/g, "").replace(/^.*?(?:在线|免费观看)[，,]?\s*/g, "");
    vodContent = `【by：轻狂书生】\n${vodContent}`;
  } else {
    vodContent = "【by：轻狂书生】";
  }

  const sourceNames = [];
  $(".anthology-tab a.swiper-slide").each((_, el) => {
    let text = cleanText($(el).text()).replace(/\d+\s*$/, "").trim();
    if (text && !text.includes("下载")) sourceNames.push(text);
  });

  const vodPlaySources = [];

  const boxes = $(".anthology-list-box");
  if (boxes.length) {
    boxes.each((idx, el) => {
      if (sourceNames.length && idx >= sourceNames.length) return;
      const srcName = sourceNames[idx] || `线路${idx + 1}`;
      const episodes = [];
      $(el)
        .find('a[href*="/vodplay/"]')
        .each((_, ael) => {
          const a = $(ael);
          const epName = cleanText(a.text());
          const epUrl = absUrl(a.attr("href") || "");
          if (epName && epUrl) episodes.push({ name: epName, playId: epUrl });
        });
      if (episodes.length) {
        vodPlaySources.push({ name: srcName, episodes });
      }
    });
  }

  if (!vodPlaySources.length) {
    const listBox = $(".anthology-list-play").first();
    if (listBox.length) {
      const episodes = [];
      listBox.find('a[href*="/vodplay/"]').each((_, ael) => {
        const a = $(ael);
        const epName = cleanText(a.text());
        const epUrl = absUrl(a.attr("href") || "");
        if (epName && epUrl) episodes.push({ name: epName, playId: epUrl });
      });
      if (episodes.length) {
        vodPlaySources.push({ name: sourceNames[0] || "默认", episodes });
      }
    }
  }

  return {
    vod_id: String(vodId || ""),
    vod_name: vodName,
    vod_pic: vodPic,
    vod_content: vodContent,
    vod_play_sources: vodPlaySources,
  };
}

async function home(params, context) {
  try {
    const html = await fetchText(`${HOST}/`);
    const list = extractHomeVideos(html);
    return { class: CLASS_LIST, filters: {}, list };
  } catch (e) {
    await OmniBox.log("error", `[影视大全][home] ${e.message}`);
    return { class: CLASS_LIST, filters: {}, list: [] };
  }
}

async function category(params, context) {
  try {
    const tid = String(params.categoryId || params.type_id || "1");
    const page = Math.max(1, parseInt(params.page || 1, 10));
    const url = `${HOST}/vodshow/${tid}--time------${page}---.html`;
    const html = await fetchText(url);
    const list = extractVideos(html);
    let total = 0;
    const totalMatch = html.match(/\$\('\.hl-total'\)\.html\('(\d+)'\)/);
    if (totalMatch) total = parseInt(totalMatch[1], 10) || 0;
    const pagecount = total > 0 ? Math.max(1, Math.ceil(total / 40)) : page + (list.length >= 40 ? 1 : 0);
    return { page, pagecount, total, list };
  } catch (e) {
    await OmniBox.log("error", `[影视大全][category] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const id = String(params.videoId || params.id || params.categoryId || "").trim();
    if (!id) return { list: [] };
    const vodId = id.includes("/") ? (id.match(/(\d+)/) || ["", id])[1] : id;
    const html = await fetchText(`${HOST}/voddetail/${vodId}.html`);
    const vod = buildDetailFromHtml(html, vodId);
    return { list: [vod] };
  } catch (e) {
    await OmniBox.log("error", `[影视大全][detail] ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = String(params.keyword || params.wd || params.key || "").trim();
    const page = Math.max(1, parseInt(params.page || 1, 10));
    if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

    const url = `${HOST}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(keyword)}&page=${page}`;
    const text = await fetchText(url);
    let data = {};
    try {
      data = JSON.parse(text || "{}");
    } catch (_) {
      data = {};
    }

    const list = [];
    for (const item of data.list || []) {
      const pic = absUrl(item.pic || "");
      list.push({
        vod_id: String(item.id || ""),
        vod_name: String(item.name || ""),
        vod_pic: pic,
        vod_remarks: "",
        vod_content: "",
      });
    }
    return {
      page,
      pagecount: Number(data.pagecount || 1),
      total: Number(data.total || list.length),
      list,
    };
  } catch (e) {
    await OmniBox.log("error", `[影视大全][search] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  try {
    const input = String(params.playId || params.url || params.input || "").trim();
    await OmniBox.log("info", `[影视大全][play] input=${input}`);
    if (!input) return { parse: 0, jx: 0, url: "", header: {} };

    const playUrl = input.startsWith("http") ? input : absUrl(input);
    await OmniBox.log("info", `[影视大全][play] playUrl=${playUrl}`);
    const html = await fetchText(playUrl, { referer: `${HOST}/` });
    await OmniBox.log("info", `[影视大全][play] htmlLen=${html.length}`);

    // 1) 直接解析 player_aaaa JSON
    let videoUrl = "";
    let playerRaw = "";
    const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
      || html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;/i)
      || html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
      || html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;/i);

    if (m) {
      playerRaw = m[1] || "";
      await OmniBox.log("info", `[影视大全][play] player_aaaa matched len=${playerRaw.length}`);
      try {
        const data = JSON.parse(playerRaw);
        videoUrl = String(data.url || "").trim();
        await OmniBox.log("info", `[影视大全][play] player_url=${videoUrl}`);
      } catch (err) {
        await OmniBox.log("error", `[影视大全][play] player json parse fail: ${err.message}`);
        videoUrl = "";
      }
    } else {
      await OmniBox.log("info", `[影视大全][play] player_aaaa not matched`);
    }

    // 2) 兜底：页面里直接找 m3u8/mp4
    if (!videoUrl) {
      const m2 = html.match(/https?:\/\/[^\"'\s>]+\.(?:m3u8|mp4)(?:\?[^\"'\s>]*)?/i);
      if (m2) {
        videoUrl = m2[0];
        await OmniBox.log("info", `[影视大全][play] fallback_url=${videoUrl}`);
      } else {
        await OmniBox.log("info", `[影视大全][play] fallback_url=none`);
      }
    }

    if (!videoUrl) {
      return { parse: 0, jx: 0, url: "", header: {} };
    }

    return {
      parse: 0,
      jx: 0,
      url: videoUrl,
      header: {
        "User-Agent": UA,
        Referer: `${HOST}/`,
      },
    };
  } catch (e) {
    await OmniBox.log("error", `[影视大全][play] ${e.message}`);
    return { parse: 0, jx: 0, url: "", header: {} };
  }
}
