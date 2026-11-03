// @name StreamingCommunity
// @author 梦
// @description 意大利 StreamingCommunity 站点，支持电影/剧集、季集详情、VixCloud 播放下钻与 SDK 嗅探兜底
// @dependencies: axios
// @version 1.1.2
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/StreamingCommunity.js

const axios = require("axios");
const OmniBox = require("omnibox_sdk");

const HOST = "https://streamingcommunityz.pink";
const CDN = "https://cdn.streamingcommunityz.pink";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const http = axios.create({
    timeout: 15000,
    headers: {
        "User-Agent": UA,
        "Referer": `${HOST}/`,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    validateStatus: () => true
});

const logInfo = (msg, data = null) => {
    OmniBox.log("info", `[StreamingCommunity] ${data ? `${msg}: ${JSON.stringify(data)}` : msg}`);
};
const logError = (msg, err) => {
    OmniBox.log("error", `[StreamingCommunity] ${msg}: ${err?.message || err}`);
};

function fixUrl(url) {
    if (!url) return "";
    if (url.startsWith("http")) return url;
    return url.startsWith("/") ? `${HOST}${url}` : `${HOST}/${url}`;
}

function decodeHtmlEntities(str = "") {
    return String(str)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function extractDataPage(html) {
    const match = html.match(/<div id="app" data-page="([^"]+)">/);
    if (!match) return null;
    try {
        const raw = decodeHtmlEntities(match[1]);
        return JSON.parse(raw);
    } catch (error) {
        logError("解析 data-page 失败", error);
        return null;
    }
}

function getImageUrl(item, preferred = ["poster", "cover", "cover_mobile", "background"]) {
    const images = item?.images || [];
    for (const type of preferred) {
        const hit = images.find((img) => img?.type === type && img?.filename);
        if (hit?.filename) return `${CDN}/images/${hit.filename}`;
    }
    const first = images.find((img) => img?.filename);
    return first?.filename ? `${CDN}/images/${first.filename}` : "";
}

function mapTitleToVod(item) {
    return {
        vod_id: `/it/titles/${item.id}-${item.slug}`,
        vod_name: item.name || item.original_name || "",
        vod_pic: getImageUrl(item),
        vod_remarks: item.type === "tv" ? `${item.seasons_count || 0}季 · ${item.score || ""}` : `${item.quality || ""}${item.score ? ` · ${item.score}` : ""}`.trim(),
        vod_year: item.release_date ? String(item.release_date).slice(0, 4) : "",
        vod_score: item.score || "",
    };
}

function pickArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    return [];
}

async function fetchPageJson(url) {
    const res = await http.get(url);
    if (res.status !== 200 || !res.data) {
        throw new Error(`请求失败: ${res.status}`);
    }
    const data = extractDataPage(typeof res.data === "string" ? res.data : "");
    if (!data) throw new Error("未找到 data-page JSON");
    return data;
}

async function home(params, context) {
    try {
        const showData = await fetchPageJson(`${HOST}/it/tv-shows`);
        const movieData = await fetchPageJson(`${HOST}/it/movies`);

        const showTitles = (showData.props?.sliders || []).flatMap((s) => s.titles || []).slice(0, 20);
        const movieTitles = (movieData.props?.sliders || []).flatMap((s) => s.titles || []).slice(0, 20);
        const merged = [...showTitles, ...movieTitles];
        const seen = new Set();
        const list = [];
        for (const item of merged) {
            if (!item?.id || seen.has(item.id)) continue;
            seen.add(item.id);
            list.push(mapTitleToVod(item));
        }

        return {
            class: [
                { type_id: "tv-shows", type_name: "剧集" },
                { type_id: "movies", type_name: "电影" },
                { type_id: "browse/trending", type_name: "热门" }
            ],
            filters: {},
            list: list.slice(0, 40)
        };
    } catch (error) {
        logError("首页获取失败", error);
        return { class: [], filters: {}, list: [] };
    }
}

async function category(params, context) {
    const categoryId = params.categoryId || "tv-shows";
    const page = parseInt(params.page, 10) || 1;
    try {
        let url = `${HOST}/it/${categoryId}`;
        if (categoryId.startsWith("browse/")) {
            url = `${HOST}/it/${categoryId}`;
        }
        const data = await fetchPageJson(url);
        const props = data.props || {};
        let titles = [];
        if (Array.isArray(props.titles)) {
            titles = props.titles;
        } else if (Array.isArray(props.sliders)) {
            titles = props.sliders.flatMap((s) => s.titles || []);
        }
        const list = titles.map(mapTitleToVod);
        const limit = 40;
        const start = (page - 1) * limit;
        const paged = list.slice(start, start + limit);
        const pagecount = Math.max(1, Math.ceil(list.length / limit));
        return {
            list: paged,
            page,
            pagecount,
            limit,
            total: list.length
        };
    } catch (error) {
        logError("分类获取失败", error);
        return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
    }
}

async function search(params, context) {
    const keyword = String(params.keyword || "").trim();
    const page = parseInt(params.page, 10) || 1;
    if (!keyword) return { list: [], page, pagecount: 0, limit: 0, total: 0 };

    try {
        const data = await fetchPageJson(`${HOST}/it/search?q=${encodeURIComponent(keyword)}`);
        const props = data.props || {};
        const titles = Array.isArray(props.titles) ? props.titles : [];
        const list = titles.map(mapTitleToVod);
        const limit = 40;
        const start = (page - 1) * limit;
        return {
            list: list.slice(start, start + limit),
            page,
            pagecount: Math.max(1, Math.ceil(list.length / limit)),
            limit,
            total: list.length
        };
    } catch (error) {
        logError("搜索失败", error);
        return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
    }
}

async function detail(params, context) {
    const videoId = params.videoId;
    if (!videoId) return { list: [] };
    try {
        const data = await fetchPageJson(fixUrl(videoId));
        const props = data.props || {};
        const title = props.title || {};
        const seasons = Array.isArray(title.seasons) ? title.seasons : [];
        const currentLoadedSeason = props.loadedSeason || null;

        const allSources = [];
        for (const season of seasons) {
            let seasonData = currentLoadedSeason && currentLoadedSeason.number === season.number
                ? currentLoadedSeason
                : null;
            if (!seasonData) {
                try {
                    const seasonUrl = `${HOST}/it/titles/${title.id}-${title.slug}/season-${season.number}`;
                    const seasonPage = await fetchPageJson(seasonUrl);
                    seasonData = seasonPage.props?.loadedSeason || null;
                } catch (error) {
                    logError(`加载第${season.number}季失败`, error);
                }
            }
            const episodes = (seasonData?.episodes || []).map((ep) => ({
                name: `S${String(season.number).padStart(2, "0")}E${String(ep.number).padStart(2, "0")} ${ep.name || ""}`.trim(),
                playId: `/it/watch/${title.id}?episode_id=${ep.id}&season=${season.number}`
            }));
            if (episodes.length) {
                allSources.push({
                    name: `第${season.number}季`,
                    episodes
                });
            }
        }

        if (!allSources.length) {
            allSources.push({
                name: "播放",
                episodes: [{ name: "正片", playId: `/it/watch/${title.id}` }]
            });
        }

        const directors = pickArray(title.directors || title.created_by).map((d) => d?.name || d?.original_name || d).filter(Boolean).join(",");
        const actors = pickArray(title.cast || title.actors).map((a) => a?.name || a?.original_name || a).filter(Boolean).join(",");
        const genres = (props.genres || []).map((g) => g?.name || g).filter(Boolean).join(",");

        return {
            list: [{
                vod_id: String(title.id || videoId),
                vod_name: title.name || title.original_name || "",
                vod_pic: getImageUrl(title, ["cover", "poster", "cover_mobile", "background"]),
                vod_content: title.plot || "",
                vod_year: title.release_date ? String(title.release_date).slice(0, 4) : "",
                vod_area: "意大利站点",
                vod_actor: actors,
                vod_director: directors,
                vod_remarks: `${title.quality || ""}${title.score ? ` · ${title.score}` : ""}`.trim(),
                vod_class: genres,
                vod_play_sources: allSources
            }]
        };
    } catch (error) {
        logError("详情获取失败", error);
        return { list: [] };
    }
}

async function play(params) {
    const playId = params.playId || "";
    try {
        const url = fixUrl(playId.startsWith('/it/watch/') ? playId : `/it/watch/${playId}`);
        const data = await fetchPageJson(url);
        const props = data.props || {};
        let embedUrl = props.embedUrl || "";
        const episodeId = params.playId && /episode_id=(\d+)/.test(params.playId) ? RegExp.$1 : "";
        if (!embedUrl) {
            embedUrl = `${HOST}/it/iframe/${props.title?.id || ""}${episodeId ? `?episode_id=${episodeId}&next_episode=1` : ""}`;
        }

        let sniffTarget = embedUrl || url;

        try {
            OmniBox.log("info", `嗅探地址：${embedUrl}`)
            const sniffed = await OmniBox.sniffVideo(embedUrl);
            OmniBox.log("info", `嗅探结果：${JSON.stringify(sniffed)}`)
            if (sniffed?.url) {
                logInfo("嗅探成功", sniffed.url);

                return {
                    urls: [{ name: "嗅探线路", url: sniffed.url }],
                    parse: 0,
                    header: sniffed.header || {
                        "User-Agent": UA,
                        "Referer": sniffTarget
                    }
                };
            }
        } catch (error) {
            logInfo("SDK 嗅探未命中", error?.message || error);
        }

        return {
            urls: [{ name: "播放", url: embedUrl || url }],
            parse: 1,
            header: {
                "User-Agent": UA,
                "Referer": `${HOST}/`
            }
        };
    } catch (error) {
        logError("播放解析失败", error);
        try {
            const fallbackTarget = fixUrl(playId);
            const sniffed = await OmniBox.sniffVideo(fallbackTarget);
            if (sniffed?.url) {
                return {
                    urls: [{ name: "嗅探回退", url: sniffed.url }],
                    parse: 0,
                    header: sniffed.header || {
                        "User-Agent": UA,
                        "Referer": fallbackTarget
                    }
                };
            }
        } catch (sniffError) {
            logInfo("回退嗅探失败", sniffError?.message || sniffError);
        }
        return {
            urls: [{ name: "回退", url: fixUrl(playId) }],
            parse: 1,
            header: {
                "User-Agent": UA,
                "Referer": `${HOST}/`
            }
        };
    }
}

module.exports = { home, category, search, detail, play };
const runner = require("spider_runner");
runner.run(module.exports);
