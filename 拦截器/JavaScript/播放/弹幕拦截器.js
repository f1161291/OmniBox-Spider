// @name 弹幕拦截器
// @author OpenCode
// @description 在 afterPlay 阶段根据 TMDB 刮削结果或标题关键词自动匹配弹幕数据（参考木偶.js / 嗷呜动漫.js 弹幕匹配流程）
// @version 1.2.0
// @filter-stages play_after
// @filter-config-schema {"description":"在播放阶段读取已有刮削元数据或根据标题/集名匹配弹幕","fields":[{"key":"danmakuEnabled","label":"启用弹幕","type":"boolean","required":false}]}

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

module.exports = { afterPlay };
runner.run(module.exports);

function parsePlayId(playId = "") {
  const raw = String(playId || "").trim();
  if (!raw) return {};

  const gimyMatch = raw.match(/^(https?:\/\/[^/]+)\/play\/(\d+)-\d+-(\d+)\.html(?:\?.*)?$/i);
  if (gimyMatch) {
    return {
      playURL: raw,
      shareURL: "",
      fileId: "",
      videoId: `${gimyMatch[1]}/detail/${gimyMatch[2]}.html`,
      vodName: "",
      episodeName: `第${gimyMatch[3]}集`,
    };
  }

  if (raw.includes("|||")) {
    const [mainPlayId, metaB64] = raw.split("|||");
    try {
      const meta = JSON.parse(Buffer.from(metaB64 || "", "base64").toString("utf8"));
      return {
        playURL: mainPlayId || "",
        shareURL: "",
        fileId: String(meta?.fid || ""),
        videoId: String(meta?.sid || meta?.videoId || ""),
        vodName: String(meta?.v || meta?.vodName || ""),
        episodeName: String(meta?.e || meta?.episodeName || ""),
      };
    } catch (_) {
      return { playURL: mainPlayId || "" };
    }
  }

  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (decoded && typeof decoded === "object" && (decoded.id || decoded.sid)) {
      return {
        playURL: String(decoded.id || ""),
        shareURL: "",
        fileId: String(decoded.fid || ""),
        videoId: String(decoded.sid || decoded.videoId || ""),
        vodName: String(decoded.v || decoded.vodName || ""),
        episodeName: String(decoded.e || decoded.episodeName || ""),
      };
    }
  } catch (_) { /* 非纯base64 JSON格式 */ }

  const parts = raw.split("|");
  if (parts.length < 2) return {};
  let videoId = parts[2] || "";
  let cleanParts = [...parts];
  let meta = null;
  if (cleanParts.length >= 3) {
    const lastPart = cleanParts[cleanParts.length - 1] || "";
    try {
      meta = JSON.parse(
        Buffer.from(lastPart, "base64").toString("utf8")
      );
      if (meta && typeof meta === "object" && meta.e) {
        cleanParts = cleanParts.slice(0, -1);
        videoId = meta.sid || videoId;
      }
    } catch (_) { /* 非base64元数据字段 */ }
  }
  return {
    playURL: cleanParts[0] || "",
    shareURL: cleanParts[0] || "",
    fileId: String(meta?.fid || cleanParts[1] || ""),
    videoId,
    vodName: String(meta?.v || meta?.vodName || ""),
    episodeName: String(meta?.e || meta?.episodeName || ""),
  };
}

function preprocessTitle(title) {
  if (!title) return "";
  return String(title)
    .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
    .replace(/[hH]\.?26[45]/g, " ")
    .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
    .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEpisode(name = "") {
  const text = preprocessTitle(name);
  if (!text) return "";

  const patterns = [
    /第\s*([0-9零一二三四五六七八九十]+)\s*[集话章节回期]/,
    /[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i,
    /\b(?:EP|E)[-._\s]*(\d{1,3})\b/i,
    /[\[\(【](\d{1,3})[\]\)】]/,
  ];

  const chineseMap = { "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
  const chineseToArabic = (raw) => {
    if (!Number.isNaN(Number(raw))) return String(Number.parseInt(raw, 10));
    const str = String(raw || "");
    if (str.length === 1) return String(chineseMap[str] ?? "");
    if (str.length === 2) {
      if (str[0] === "十") return String(10 + (chineseMap[str[1]] || 0));
      if (str[1] === "十") return String((chineseMap[str[0]] || 0) * 10);
    }
    if (str.length === 3 && str[1] === "十") {
      return String((chineseMap[str[0]] || 0) * 10 + (chineseMap[str[2]] || 0));
    }
    return str;
  };

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    return chineseToArabic(match[1] || "");
  }

  return "";
}

function buildFileNameForDanmu(vodName, episodeTitle) {
  const title = String(vodName || "").trim();
  if (!title) return "";
  const epName = String(episodeTitle || "").trim();
  if (!epName || epName === "正片" || epName === "播放") {
    return title;
  }
  const digits = extractEpisode(epName);
  if (!digits) return title;
  const episodeNumber = Number.parseInt(digits, 10);
  if (!Number.isFinite(episodeNumber) || episodeNumber <= 0) return title;
  return `${title} S01E${String(episodeNumber).padStart(2, "0")}`;
}

function buildDanmakuCandidates(vodName, episodeTitle) {
  const candidate = buildFileNameForDanmu(vodName, episodeTitle);
  return candidate ? [candidate] : [];
}

async function matchDanmakuByCandidates(candidates = []) {
  for (const candidate of candidates) {
    await OmniBox.log("info", "弹幕拦截器: 尝试候选 fileName=" + candidate);
    const matched = await OmniBox.getDanmakuByFileName(candidate);
    const list = Array.isArray(matched) ? matched : [];
    await OmniBox.log("info", "弹幕拦截器: 候选结果 fileName=" + candidate + " count=" + list.length);
    if (list.length > 0) {
      return list;
    }
  }
  return [];
}

async function matchDanmaku(playId = "", data = {}) {
  const result = { danmakuList: [] };

  const info = parsePlayId(playId);
  const siteVodName = String(info.vodName || data.vod_name || data.title || "").trim();
  const fallbackEpisodeName = String(info.episodeName || data.episodeName || "").trim();
  const fallbackCandidates = buildDanmakuCandidates(siteVodName, fallbackEpisodeName);

  if (!info.videoId) {
    if (fallbackCandidates.length === 0) return result;
    await OmniBox.log("info", "弹幕拦截器: 使用非网盘兜底候选匹配 candidates=" + JSON.stringify(fallbackCandidates));
    result.danmakuList = await matchDanmakuByCandidates(fallbackCandidates);
    return result;
  }

  try {
    const metadata = await OmniBox.getScrapeMetadata(info.videoId);
    if (!metadata?.scrapeData || !Array.isArray(metadata.videoMappings)) {
      await OmniBox.log("info", "弹幕拦截器: 无刮削数据跳过 videoId=" + info.videoId);
      if (fallbackCandidates.length > 0) {
        await OmniBox.log("info", "弹幕拦截器: 使用非网盘兜底候选匹配 candidates=" + JSON.stringify(fallbackCandidates));
        result.danmakuList = await matchDanmakuByCandidates(fallbackCandidates);
      }
      return result;
    }

    const scrapeData = metadata.scrapeData;
    const scrapedVodName = String(scrapeData.title || siteVodName || "").trim();
    const formattedFileId = info.shareURL + "|" + info.fileId + "|" + info.videoId;
    const mapping = metadata.videoMappings.find((m) => m && m.fileId === formattedFileId);
    if (!mapping) {
      await OmniBox.log("info", "弹幕拦截器: 未命中映射 formattedFileId=" + formattedFileId);
      const scrapedCandidates = buildDanmakuCandidates(scrapedVodName, fallbackEpisodeName);
      if (scrapedCandidates.length > 0) {
        await OmniBox.log("info", "弹幕拦截器: 使用刮削标题兜底候选匹配 candidates=" + JSON.stringify(scrapedCandidates));
        result.danmakuList = await matchDanmakuByCandidates(scrapedCandidates);
        if (result.danmakuList.length > 0) {
          return result;
        }
      }
      if (fallbackCandidates.length > 0) {
        await OmniBox.log("info", "弹幕拦截器: 使用站点标题兜底候选匹配 candidates=" + JSON.stringify(fallbackCandidates));
        result.danmakuList = await matchDanmakuByCandidates(fallbackCandidates);
      }
      return result;
    }

    let fileName = "";
    const scrapeType = metadata.scrapeType || "";
    if (scrapeType === "movie") {
      fileName = String(scrapeData.title || "");
    } else {
      const title = String(scrapeData.title || "");
      const seasonAirYear = String(scrapeData.seasonAirYear || data.vod_year || "");
      const seasonNumber = mapping.seasonNumber || 1;
      const episodeNum = mapping.episodeNumber || 1;
      fileName = [
        title,
        seasonAirYear,
        "S" + String(seasonNumber).padStart(2, "0"),
        "E" + String(episodeNum).padStart(2, "0"),
      ].join(".");
    }

    if (!fileName) return result;

    await OmniBox.log("info", "弹幕拦截器: 尝试匹配弹幕 fileName=" + fileName);
    const matched = await OmniBox.getDanmakuByFileName(fileName);
    const count = Array.isArray(matched) ? matched.length : 0;
    await OmniBox.log("info", "弹幕拦截器: 弹幕匹配结果 fileName=" + fileName + " count=" + count);
    result.danmakuList = Array.isArray(matched) ? matched : [];
  } catch (error) {
    await OmniBox.log("warn", "弹幕拦截器: 弹幕匹配失败 " + error.message);
  }

  return result;
}

async function afterPlay(params) {
  const data = params?.data || {};
  const extend = params?.extend || {};
  const danmakuEnabled = Boolean(extend.danmakuEnabled ?? true);
  const playId = String(params?.params?.playId || data?.playId || "");
  if (!danmakuEnabled) return data;

  try {
    const danmakuResult = await matchDanmaku(playId, data);
    if (danmakuResult.danmakuList.length > 0) {
      if (!data.danmaku || !Array.isArray(data.danmaku)) {
        data.danmaku = [];
      }
      for (const item of danmakuResult.danmakuList) {
        data.danmaku.push(item);
      }
      await OmniBox.log("info", "弹幕拦截器: 已注入" + danmakuResult.danmakuList.length + "条弹幕");
    }
  } catch (_) { /* 弹幕匹配失败不影响播放 */ }

  return data;
}
