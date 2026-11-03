// @name PornHub
// @description PornHub FFM Threesome videos
// @version 3.8.3

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

//const PROXY = "http://192.168.1.111:7898";

async function apiGet(url) {
    try {
        const resp = await OmniBox.request(url);
        if (resp && resp.body) {
            return JSON.parse(resp.body);
        }
    } catch(e) {}
    return null;
}

async function home(params) {
    const data = await apiGet(PROXY + "/phfiltered");
    const list = (data && data.list) ? data.list : [];
    return {
        class: [
            { type_id: "ffm", type_name: "PornHub精选" }
        ],
        list: list,
    };
}

async function category(params) {
    const data = await apiGet(PROXY + "/phfiltered");
    if (!data || !data.list || data.list.length === 0) return { list: [] };
    return { list: data.list };
}

// detail: handled as play since Omnibox API rejects ids parameter
async function detail(params) {
    // If ids was passed, Omnibox rejects it before we get here
    // videoId works - handle it
    const id = params.videoId || "";
    if (!id) return { list: [] };
    let viewkey = id;
    if (id.startsWith("ph:")) viewkey = id.substring(3);
    if (!viewkey) return { list: [] };
    
    // Try to get video info from the proxy
    const data = await apiGet(PROXY + "/phfiltered");
    let name = "视频";
    if (data && data.list) {
        const found = data.list.find(v => v.vod_id === ("ph:" + viewkey) || v.vod_id === viewkey);
        if (found) name = found.vod_name;
    }
    
    return {
        list: [{
            vod_id: "ph:" + viewkey,
            vod_name: name,
            vod_pic: params.pic || "",
            vod_play_from: "PornHub",
            vod_play_sources: [{
                name: "PornHub",
                episodes: [{ name: "高清", playId: "ph:" + viewkey }]
            }]
        }]
    };
}

async function search(params) {
    return { list: [] };
}

async function play(params) {
    // Accept both playId and ids (some CatVOD clients use ids for play too)
    const playId = params.play_id || params.playId || params.ids || "";
    let viewkey = "";
    if (playId.startsWith("ph:")) {
        viewkey = playId.substring(3);
    } else if (playId) {
        viewkey = playId;
    }
    if (!viewkey) return {};

    // Try phgeturl first (CDN direct URL, faster startup for player)
    try {
        const resp = await OmniBox.request(PROXY + "/phgeturl?viewkey=" + viewkey);
        if (resp && resp.body) {
            const data = JSON.parse(resp.body);
            if (data && data.url) {
                return {
                    urls: [{ name: "高清", url: data.url }],
                    flag: data.flag || "auto",
                    header: data.header || { Referer: "https://cn.pornhub.com/" },
                    parse: data.parse || 0
                };
            }
        }
    } catch(e) {}

    // Fallback: stream through proxy
    return {
        urls: [{ name: "高清", url: PROXY + "/phplay?viewkey=" + viewkey }],
        flag: "auto",
        header: {},
        parse: 0
    };
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
