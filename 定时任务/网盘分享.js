// @name 网盘分享
// @author lampon
// @description 
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/定时任务/网盘分享.js
// @dependencies: crypto

/**
 * 定时任务：将网盘分享链接入库到 media_library_items（全量 batch 入库）
 *
 * 入库规则（batch）：
 * - 分类文件夹 / 影片文件夹 / 多集视频文件... → 1条媒体记录（episodes 多集）
 *
 * playId 约定（本脚本写入）：
 * - cloud_share：episodes[].playId = 文件ID|分享链接
 *   说明：play 时通过 `|` 分割可取到 fileId 与 shareURL
 *
 * 环境变量：
 *   OMNIBOX_API_URL=http://127.0.0.1:端口/api/spider/omnibox
 *   SHARE_URLS=...            # 必填：逗号或换行分隔
 *   DRIVE_IMPORT_MODE=batch   # batch / flat（默认 batch）
 *
 * 限流（优先级：DRIVE_* > DRIVE_{BATCH|FLAT}_* > 默认值）
 *   DRIVE_LIST_CONCURRENCY=1
 *   DRIVE_LIST_MIN_INTERVAL_MS=500
 *   DRIVE_SHARE_GAP_MS=5000
 *
 * 可选
 *   DRIVE_DEFAULT_CATEGORY=未分类
 *
 * 成功时 stdout 最后一行输出 JSON 摘要。
 */

const crypto = require("crypto");
const OmniBox = require("omnibox_sdk");

function sleep(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

function canonicalizeShareURL(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";
  try {
    const u = new URL(input);
    u.hash = "";
    u.protocol = (u.protocol || "").toLowerCase();
    u.hostname = (u.hostname || "").toLowerCase();
    // 去掉默认端口
    if (
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80")
    ) {
      u.port = "";
    }
    // 过滤常见追踪参数
    const drops = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "spm",
      "from",
      "scene",
    ];
    for (const k of drops) u.searchParams.delete(k);
    // 对剩余参数排序，确保稳定
    const pairs = Array.from(u.searchParams.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    u.search = "";
    for (const [k, v] of pairs) u.searchParams.append(k, v);
    // pathname 尾部斜杠统一（保留根路径 /）
    if (u.pathname.length > 1) {
      u.pathname = u.pathname.replace(/\/+$/g, "");
    }
    return u.toString();
  } catch (e) {
    // 非标准 URL（如某些网盘会给短链/自定义格式），只做基础 trim
    return input;
  }
}

function isVideoFile(file) {
  if (!file || !file.file_name) return false;
  const fileName = String(file.file_name).toLowerCase();
  const videoExtensions = [
    ".mp4",
    ".mkv",
    ".avi",
    ".flv",
    ".mov",
    ".wmv",
    ".m3u8",
    ".ts",
    ".webm",
    ".m4v",
    ".iso",
  ];
  return videoExtensions.some((ext) => fileName.endsWith(ext));
}

function normalizeFolderName(s) {
  const t = String(s || "").trim();
  return t || "未命名";
}

function categoryAndMovieFromPath(pathFromRoot, defaultCategory, shareTitle) {
  const p = (pathFromRoot || []).map(normalizeFolderName).filter(Boolean);
  const dc = normalizeFolderName(defaultCategory || "未分类");
  const st = normalizeFolderName(shareTitle || "分享");

  if (p.length >= 2) {
    return {
      category: p[p.length - 2],
      movieName: p[p.length - 1],
    };
  }
  if (p.length === 1) {
    return { category: dc, movieName: p[0] };
  }
  return { category: dc, movieName: st };
}

function groupKey(category, movieName) {
  return `${category}\n${movieName}`;
}

function sortEpisodesNatural(episodes) {
  const arr = (episodes || []).slice();
  arr.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return arr;
}

/**
 * 有界并发 + 无限排队：永不因「队列满」丢弃目录分支
 */
async function acquireListSlot(state) {
  if (state.listSlotsAvailable > 0) {
    state.listSlotsAvailable--;
    return;
  }
  await new Promise((resolve) => state.listWaiters.push(resolve));
}

function releaseListSlot(state) {
  if (state.listWaiters.length > 0) {
    const next = state.listWaiters.shift();
    next();
  } else {
    state.listSlotsAvailable++;
  }
}

async function getDriveFileListGuarded(shareURL, pdirFid, state) {
  await acquireListSlot(state);
  try {
    const sub = await OmniBox.getDriveFileList(shareURL, pdirFid);
    state.listRequests++;
    return sub;
  } finally {
    await sleep(state.listMinIntervalMs);
    releaseListSlot(state);
  }
}

// 全量扫描仍需一个硬上限，避免异常目录结构导致无限递归
const MAX_WALK_DEPTH = 64;
const DEFAULT_CATEGORY = "未分类";

/** 去掉文件名最后一个扩展名，如 "速度与激情.mkv" → "速度与激情" */
function stripExtension(fileName) {
  const s = String(fileName || "").trim();
  const dot = s.lastIndexOf(".");
  return dot > 0 ? s.slice(0, dot) : s;
}

async function collectIntoGroups(
  shareURL,
  files,
  pathFromRoot,
  depth,
  shareTitle,
  defaultCategory,
  state,
) {
  if (!files || !Array.isArray(files)) return;

  const subTasks = [];
  for (const file of files) {
    if (file.file && isVideoFile(file)) {
      const { category, movieName } = categoryAndMovieFromPath(
        pathFromRoot,
        defaultCategory,
        shareTitle,
      );
      const gk = groupKey(category, movieName);
      if (!state.groups.has(gk)) {
        state.groups.set(gk, { category, movieName, episodes: [] });
      }
      const fid = file.fid || file.file_id || "";
      const name = file.file_name || fid || "video";
      const playId = fid;
      if (!playId) continue;

      const grp = state.groups.get(gk);
      grp.episodes.push({
        name,
        playId,
        size: file.size || file.file_size || 0,
        path: [...pathFromRoot, name].join("/"),
      });
      state.videoCount++;
    } else if (file.dir && depth < MAX_WALK_DEPTH) {
      const dirName = file.file_name || file.name || "";
      const task = (async () => {
        const sub = await getDriveFileListGuarded(shareURL, file.fid, state);
        if (!sub || !sub.files || !Array.isArray(sub.files)) return;
        await collectIntoGroups(
          shareURL,
          sub.files,
          [...pathFromRoot, dirName],
          depth + 1,
          shareTitle,
          defaultCategory,
          state,
        );
      })().catch(async (e) => {
        console.warn(`[drive-batch] 子目录失败 fid=${file.fid}: ${e.message}`);
      });
      subTasks.push(task);
    }
  }
  if (subTasks.length) {
    await Promise.all(subTasks);
  }
}

/**
 * flat 模式：递归收集，每个视频文件独立成一条待入库记录
 */
async function collectFlatVideos(
  shareURL,
  files,
  pathFromRoot,
  depth,
  defaultCategory,
  state,
) {
  if (!files || !Array.isArray(files)) return;

  const subTasks = [];
  for (const file of files) {
    if (file.file && isVideoFile(file)) {
      const fid = file.fid || file.file_id || "";
      if (!fid) continue;

      const category =
        pathFromRoot.length > 0
          ? normalizeFolderName(pathFromRoot[pathFromRoot.length - 1])
          : normalizeFolderName(defaultCategory);
      const fileName = file.file_name || `${fid}.mp4`;
      const title = stripExtension(fileName);
      const playId = fid;
      if (!playId) continue;

      state.flatItems.push({
        category,
        title,
        originalTitle: title,
        fileName,
        fid,
        playId,
        size: file.size || file.file_size || 0,
        path: [...pathFromRoot, fileName].join("/"),
      });
      state.videoCount++;
    } else if (file.dir && depth < MAX_WALK_DEPTH) {
      const dirName = file.file_name || file.name || "";
      const task = (async () => {
        const sub = await getDriveFileListGuarded(shareURL, file.fid, state);
        if (!sub || !Array.isArray(sub.files)) return;
        await collectFlatVideos(
          shareURL,
          sub.files,
          [...pathFromRoot, dirName],
          depth + 1,
          defaultCategory,
          state,
        );
      })().catch(async (e) => {
        console.warn(`[drive-flat] 子目录失败 fid=${file.fid}: ${e.message}`);
      });
      subTasks.push(task);
    }
  }
  if (subTasks.length) await Promise.all(subTasks);
}

function parseShareURLs(raw) {
  if (!raw || !String(raw).trim()) return [];
  const t = String(raw).trim();
  if (t.includes("\n")) {
    return t
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function upsertOneShare(shareURL, opts) {
  const shareURLRaw = String(shareURL || "").trim();
  const shareURLCanonical = canonicalizeShareURL(shareURLRaw);
  const { importMode, defaultCategory, listConcurrency, listMinIntervalMs } =
    opts;
  console.log(`[drive] 开始处理: ${shareURLRaw} mode=${importMode}`);

  const info = await OmniBox.getDriveShareInfo(shareURLRaw).catch(() => ({}));
  const driveInfo = await OmniBox.getDriveInfoByShareURL(shareURLRaw).catch(
    () => ({}),
  );

  const state = {
    videoCount: 0,
    groups: new Map(),
    flatItems: [],
    listRequests: 0,
    listConcurrency,
    listSlotsAvailable: listConcurrency,
    listWaiters: [],
    listMinIntervalMs,
  };

  const root = await getDriveFileListGuarded(shareURLRaw, "0", state);
  const files = (root && root.files) || [];

  const shareTitle =
    root.displayName ||
    root.display_name ||
    info.displayName ||
    info.title ||
    driveInfo.displayName ||
    shareURLRaw;

  if (importMode === "flat") {
    await collectFlatVideos(shareURLRaw, files, [], 0, defaultCategory, state);
  } else {
    await collectIntoGroups(
      shareURLRaw,
      files,
      [],
      0,
      shareTitle,
      defaultCategory,
      state,
    );
  }

  const driveType = driveInfo.driveType || "";
  const coverUrl = driveInfo.iconUrl || "";

  const payloads = [];
  const upserted = [];
  if (importMode === "flat") {
    const seen = new Set();
    const dedupItems = [];
    for (const it of state.flatItems) {
      if (!it.playId || seen.has(it.playId)) continue;
      seen.add(it.playId);
      dedupItems.push(it);
    }
    for (const it of dedupItems) {
      const {
        category,
        title,
        originalTitle,
        fileName,
        fid,
        playId,
        size,
        path,
      } = it;
      const sourceKey = sha256Hex(
        `${shareURLCanonical || shareURLRaw}\n${fid}`,
      );
      const finalTitle =
        String(title || "")
          .slice(0, 250)
          .trim() || title;
      payloads.push({
        sourceType: "cloud_share",
        sourceKey,
        from: shareURLRaw,
        title: finalTitle,
        originalTitle,
        year: "",
        genres: [category],
        description: `网盘分享 · 分类「${category}」`,
        coverUrl,
        playbackPayload: {
          kind: "cloud_share",
          shareURL: shareURLRaw,
          driveType,
          category,
          movieName: title,
          episodes: [{ name: fileName, playId, size, path }],
        },
        extra: {
          shareURL: shareURLRaw,
          shareURLCanonical: shareURLCanonical || shareURLRaw,
          category,
          fid,
          fileName,
          importedAt: new Date().toISOString(),
          listRequests: state.listRequests,
        },
      });
      upserted.push({ category, title: finalTitle, sourceKey, libraryId: "" });
    }
  } else {
    const groupEntries = Array.from(state.groups.entries());
    for (const [, grp] of groupEntries) {
      const { category, movieName, episodes } = grp;
      const dedup = [];
      const seen = new Set();
      for (const ep of episodes || []) {
        if (!ep.playId || seen.has(ep.playId)) continue;
        seen.add(ep.playId);
        dedup.push(ep);
      }
      const dedupSorted = sortEpisodesNatural(dedup);
      if (!dedupSorted.length) continue;

      const sourceKey = sha256Hex(
        `${shareURLCanonical || shareURLRaw}\n${category}\n${movieName}`,
      );
      const title =
        String(movieName || "")
          .slice(0, 250)
          .trim() || movieName;

      payloads.push({
        sourceType: "cloud_share",
        sourceKey,
        from: shareURLRaw,
        title,
        originalTitle: movieName,
        year: "",
        genres: [category],
        description: `网盘分享 · 分类「${category}」· 共 ${dedupSorted.length} 个视频`,
        coverUrl,
        playbackPayload: {
          kind: "cloud_share",
          shareURL: shareURLRaw,
          driveType,
          category,
          movieName,
          episodes: dedupSorted,
        },
        extra: {
          shareURL: shareURLRaw,
          shareURLCanonical: shareURLCanonical || shareURLRaw,
          category,
          movieName,
          importedAt: new Date().toISOString(),
          episodeCount: dedupSorted.length,
          videoCountInShare: state.videoCount,
          listRequests: state.listRequests,
        },
      });

      upserted.push({
        category,
        movieName,
        sourceKey,
        episodeCount: dedupSorted.length,
        libraryId: "",
      });
    }
  }

  const BATCH_SIZE = 100;
  let writtenCount = 0;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    writtenCount += await OmniBox.upsertMediaItems(
      payloads.slice(i, i + BATCH_SIZE),
    );
  }

  return {
    shareURL: shareURLRaw,
    shareTitle,
    videoFilesScanned: state.videoCount,
    writtenCount,
    listRequests: state.listRequests,
    items: upserted,
  };
}

async function main() {
  const raw =
    process.env.SHARE_URLS || "https://115cdn.com/s/sw6pw793wfp?password=w816";
  const urls = parseShareURLs(raw);
  const envInt = (key, def) => {
    const raw = process.env[key];
    if (raw == null || String(raw).trim() === "") return Number(def) || 0;
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) ? n : Number(def) || 0;
  };

  const importMode = "flat";
  const listConcurrency = envInt("DRIVE_LIST_CONCURRENCY", 2);
  const listMinIntervalMs = envInt("DRIVE_LIST_MIN_INTERVAL_MS", 800);
  const shareGapMs = envInt("DRIVE_SHARE_GAP_MS", 1000);

  const defaultCategory =
    String(process.env.DRIVE_DEFAULT_CATEGORY || DEFAULT_CATEGORY).trim() ||
    DEFAULT_CATEGORY;

  if (!urls.length) {
    throw new Error(
      "请配置环境变量 SHARE_URLS（逗号分隔或换行分隔的网盘分享链接）",
    );
  }

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    try {
      const r = await upsertOneShare(u, {
        importMode,
        defaultCategory,
        listConcurrency,
        listMinIntervalMs,
      });
      results.push({ ok: true, ...r });
    } catch (e) {
      console.error(`[drive] 失败 ${u}: ${e.message}`);
      results.push({ ok: false, shareURL: u, error: e.message });
    }
    if (shareGapMs > 0 && i < urls.length - 1) {
      await sleep(shareGapMs);
    }
  }
  console.log("执行完毕");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
