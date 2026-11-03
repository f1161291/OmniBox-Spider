// @name 播放记录拦截器
// @author OpenCode
// @description 在 afterPlay 阶段自动记录观看历史（参考木偶.js / 嗷呜动漫.js play() 中的 addPlayHistory 调用）
// @version 1.2.0
// @filter-stages play_after
// @filter-config-schema {"description":"在播放阶段为当前播放条目添加观看历史记录","fields":[{"key":"recordEnabled","label":"启用播放记录","type":"boolean","required":false},{"key":"updateFavoriteEpisode","label":"更新收藏集数","type":"boolean","required":false,"placeholder":"播放后更新追剧进度"}]}

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

function extractEpisodeNumber(name = "") {
  const text = String(name || "").trim();
  if (!text) return undefined;

  const patterns = [
    /第\s*(\d{1,3})\s*[集话]/,
    /[sS](\d{1,2})\s*[eE](\d{1,3})/,
    /(?:EP|E)(\d{1,3})/i,
    /\b(\d{1,3})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = match.length >= 3 ? match[2] : match[1];
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

async function resolveEpisodeInfo(playId = "") {
  const info = parsePlayId(playId);
  const result = {
    episodeNumber: extractEpisodeNumber(info.episodeName || ""),
    episodeName: String(info.episodeName || ""),
    title: String(info.vodName || ""),
  };

  if (!info.videoId) return result;

  const formattedFileId = info.shareURL + "|" + info.fileId + "|" + info.videoId;

  try {
    const metadata = await OmniBox.getScrapeMetadata(info.videoId);
    if (metadata?.scrapeData?.title) {
      result.title = String(metadata.scrapeData.title);
    }
    if (metadata?.videoMappings) {
      let mapping = metadata.videoMappings.find(
        (m) => m && m.fileId === formattedFileId
      );
      if (!mapping && result.episodeNumber !== undefined) {
        mapping = metadata.videoMappings.find(
          (m) => m && m.episodeNumber === result.episodeNumber
        );
      }
      if (mapping) {
        if (mapping.episodeNumber !== undefined) {
          result.episodeNumber = mapping.episodeNumber;
        }
        if (mapping.episodeName) result.episodeName = String(mapping.episodeName);
      }
    }
  } catch (_) { /* 刮削数据获取失败不影响播放 */ }

  return result;
}

async function tryUpdateFavorite(videoId = "", episodeNumber = undefined) {
  if (!videoId || episodeNumber === undefined) return;
  try {
    const updated = await OmniBox.updateFavoriteEpisode(videoId, episodeNumber);
    await OmniBox.log(
      "info",
      "播放记录拦截器: 更新追剧集数 vodId=" +
        videoId +
        " episode=" +
        episodeNumber +
        (updated ? " 成功" : " 跳过")
    );
  } catch (error) {
    await OmniBox.log("warn", "播放记录拦截器: 更新追剧失败 " + error.message);
  }
}

async function recordPlayHistory(videoId, playId, extra = {}) {
  if (!videoId) return;

  try {
    const title = String(extra.title || videoId);
    const pic = String(extra.pic || "");
    const sourceId = String(extra.sourceId || "");

    const added = await OmniBox.addPlayHistory({
      vodId: videoId,
      title,
      pic,
      episode: playId,
      sourceId,
      episodeNumber: extra.episodeNumber,
      episodeName: String(extra.episodeName || ""),
    });

    await OmniBox.log(
      "info",
      "播放记录拦截器: " + (added ? "已添加" : "已存在跳过") + " title=" + title
    );
  } catch (error) {
    await OmniBox.log("warn", "播放记录拦截器: 记录失败 " + error.message);
  }
}

async function afterPlay(params) {
  const data = params?.data || {};
  const extend = params?.extend || {};
  const recordEnabled = Boolean(extend.recordEnabled ?? true);
  const updateFavoriteEpisode = Boolean(extend.updateFavoriteEpisode);

  if (!recordEnabled) return data;

  const playId = String(params?.params?.playId || data?.playId || "");
  const info = parsePlayId(playId);

  if (!info.videoId) {
    await OmniBox.log("info", "播放记录拦截器: 当前 playId 不是网盘聚合格式，跳过 playId=" + playId);
    return data;
  }

  const epInfo = await resolveEpisodeInfo(playId);
  const sourceId = String(params?.context?.sourceId || "");

  await recordPlayHistory(info.videoId, playId, {
    title: String(data.vod_name || data.title || epInfo.title || info.vodName || info.videoId || ""),
    pic: String(data.vod_pic || data.pic || ""),
    sourceId,
    episodeNumber: epInfo.episodeNumber,
    episodeName: epInfo.episodeName || info.episodeName,
  });

  if (updateFavoriteEpisode) {
    await tryUpdateFavorite(info.videoId, epInfo.episodeNumber);
  }

  return data;
}
