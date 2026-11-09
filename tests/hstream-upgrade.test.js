const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "颜色", "HStream.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "hstream");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

function loadSpider(request, env = {}) {
  const spiderModule = { exports: {} };
  const cache = new Map();
  const logs = [];

  const sdk = {
    log: async (level, message) => {
      logs.push(`[${level}] ${message}`);
    },
    getCache: async (key) => (cache.has(key) ? cache.get(key) : null),
    setCache: async (key, value) => {
      cache.set(key, value);
    },
    deleteCache: async (key) => {
      cache.delete(key);
    },
    request,
    sniffVideo: async () => ({ url: "", header: {} }),
    addPlayHistory: async () => true,
    getVideoMediaInfo: async () => null,
  };

  const localRequire = (id) => {
    if (id === "omnibox_sdk") return sdk;
    if (id === "spider_runner") return { run: () => {} };
    return require(id);
  };

  vm.runInNewContext(source, {
    module: spiderModule,
    exports: spiderModule.exports,
    require: localRequire,
    process: { env },
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    Promise,
    console,
  }, { filename: "HStream.js" });

  return { spider: spiderModule.exports, cache, logs };
}

function makeRequest() {
  const requests = [];
  const request = async (url, options = {}) => {
    const currentUrl = String(url);
    requests.push({ url: currentUrl, method: options.method || "GET", headers: options.headers || {}, body: options.body });

    if (currentUrl === "https://hstream.moe/" && (options.method || "GET") === "GET") {
      return {
        statusCode: 200,
        headers: { "set-cookie": ["XSRF-TOKEN=abc%3D; Path=/", "hstream_session=xyz%3D; Path=/; HttpOnly"] },
        body: `${fixture("home.html")}<input type="hidden" name="_token" value="TOKENVALUE" />`,
      };
    }
    if (currentUrl === "https://hstream.moe/search" ) return { statusCode: 200, headers: {}, body: fixture("options.html") };
    if (currentUrl.startsWith("https://hstream.moe/search?")) {
      if (currentUrl.includes("search=kuroinu")) return { statusCode: 200, headers: {}, body: fixture("search.html") };
      return { statusCode: 200, headers: {}, body: fixture("list.html") };
    }
    if (currentUrl === "https://hstream.moe/hentai/deco-x-deco-the-animation-1") {
      return { statusCode: 200, headers: {}, body: fixture("detail.html") };
    }
    if (currentUrl === "https://hstream.moe/hentai/deco-x-deco-the-animation") {
      return { statusCode: 200, headers: {}, body: fixture("series.html") };
    }
    if (currentUrl === "https://hstream.moe/hentai/unknown-slug-xyz") {
      // 200 但没有 e_id（登录墙页面），应走页面嗅探兜底
      return { statusCode: 200, headers: {}, body: fixture("gated.html") };
    }
    if (currentUrl === "https://hstream.moe/hentai/legacy-alias-r-1") {
      return { statusCode: 200, headers: {}, body: fixture("gated.html") };
    }
    if (currentUrl === "https://hstream.moe/hentai/legacy-alias-1") {
      return { statusCode: 200, headers: {}, body: fixture("detail.html") };
    }
    if (currentUrl === "https://hstream.moe/hentai/legacy-alias") {
      return { statusCode: 200, headers: {}, body: fixture("series.html") };
    }
    if (currentUrl === "https://hstream.moe/player/api" && (options.method || "GET") === "POST") {
      const payload = JSON.parse(options.body || "{}");
      if (payload._token !== "TOKENVALUE") {
        return { statusCode: 419, headers: {}, body: JSON.stringify({ message: "CSRF token mismatch." }) };
      }
      if (String(payload.episode_id) === "2032") {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            title: "Deco x Deco The Animation - 1",
            poster: "/images/hentai/deco-x-deco-the-animation/gallery-ep-1-0.webp",
            interpolated: 1,
            interpolated_uhd: 0,
            stream_url: "2026/Deco.x.Deco.The.Animation/E01",
            stream_domains: ["https://cdn-a.example.com", "https://cdn-b.example.com"],
            asia_stream_domains: ["https://cdn-asia.example.com"],
            extra_subtitles: [],
          }),
        };
      }
      return { statusCode: 404, headers: {}, body: JSON.stringify({ message: "not found" }) };
    }
    if (currentUrl.startsWith("https://cdn-a.example.com/")) {
      // 让 720p mp4 与 1080p DASH 可用，2160p 不可用
      if (currentUrl.endsWith("/2160/manifest.mpd")) return { statusCode: 404, headers: {}, body: "" };
      return { statusCode: 206, headers: { "content-type": "video/mp4" }, body: "" };
    }
    return { statusCode: 404, headers: {}, body: "" };
  };
  return { request, requests };
}

test("HStream source declares header annotations and om format", () => {
  assert.match(source, /\/\/ @name 🔞HStream/);
  assert.match(source, /\/\/ @version 1\.2\.0/);
  assert.match(source, /@downloadURL .*影视\/颜色\/HStream\.js/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
  assert.doesNotMatch(source, /app\.get\(meta\.api/);
});

test("HStream home returns classes, filters and cards", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);
  const result = await spider.home({}, { from: "web" });

  assert.ok(result.class.length >= 8);
  assert.ok(result.list.length >= 3);
  assert.ok(result.filters);
  const first = result.list[0];
  assert.equal(first.vod_id, "ntr-kishi-1");
  assert.equal(first.vod_name, "NTR Kishi - 1");
  assert.ok(first.vod_pic.startsWith("https://hstream.moe/images/hentai/"));
  const filters = result.filters["order:recently-uploaded"];
  assert.ok(Array.isArray(filters));
  const tagFilter = filters.find((item) => item.key === "tags");
  assert.ok(tagFilter.value.length >= 2);
});

test("HStream category builds browse url with order/tags/filters", async () => {
  const { request, requests } = makeRequest();
  const { spider } = loadSpider(request);

  const result = await spider.category({ categoryId: "tag:4k", page: 2 }, {});
  assert.equal(result.page, 2);
  assert.ok(result.list.length >= 2);
  const listRequest = requests.find((item) => item.url.includes("/search?"));
  assert.ok(listRequest.url.includes("tags%5B0%5D=4k"));
  assert.ok(listRequest.url.includes("page=2"));

  const filtered = await spider.category({
    categoryId: "order:recently-uploaded",
    page: 1,
    filters: { order: "view-count", tags: ["4k"], studio: "seven" },
  }, {});
  assert.ok(filtered.list.length >= 2);
  const filteredRequest = requests.filter((item) => item.url.includes("/search?")).pop();
  assert.ok(filteredRequest.url.includes("order=view-count"));
  assert.ok(filteredRequest.url.includes("tags%5B0%5D=4k"));
  assert.ok(filteredRequest.url.includes("studios%5B0%5D=seven"));
});

test("HStream search maps keyword results with episode ids", async () => {
  const { request, requests } = makeRequest();
  const { spider } = loadSpider(request);

  const result = await spider.search({ keyword: "kuroinu", page: 1 }, {});
  assert.ok(result.list.length >= 2);
  assert.ok(result.list[0].vod_id.includes("|"));
  const searchRequest = requests.find((item) => item.url.includes("search=kuroinu"));
  assert.ok(searchRequest, "应请求站点搜索页");
});

test("HStream detail builds play sources from series episodes", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);

  const result = await spider.detail({ videoId: "deco-x-deco-the-animation-1|2032" }, {});
  assert.equal(result.list.length, 1);
  const vod = result.list[0];
  assert.ok(vod.vod_name.startsWith("Deco x Deco The Animation"));
  assert.ok(vod.vod_content);
  assert.ok(vod.type_name);
  assert.equal(vod.vod_play_from, "HStream");
  const episodes = vod.vod_play_sources[0].episodes;
  assert.equal(episodes.length, 2);
  // 剧集合集页的分集卡片本身不带 wire:key，playId 先只带 slug，play() 阶段再补 e_id
  assert.equal(episodes[0].playId.split("|")[0], "deco-x-deco-the-animation-1");
  assert.equal(episodes[1].playId.split("|")[0], "deco-x-deco-the-animation-2");
  assert.equal(episodes.map((ep) => ep.name).join(","), "第1集,第2集");
  assert.ok(vod.vod_play_url.includes("$"));
});

test("HStream detail self-heals legacy alias slug", async () => {
  const { request, requests } = makeRequest();
  const { spider } = loadSpider(request);

  const result = await spider.detail({ videoId: "legacy-alias-r-1" }, {});
  assert.equal(result.list.length, 1);
  const vod = result.list[0];
  assert.ok(vod.vod_name.startsWith("Deco x Deco The Animation"));
  assert.ok(requests.some((item) => item.url.endsWith("/hentai/legacy-alias-1")), "应尝试纠正别名 slug");
});

test("HStream play bootstraps session then calls player/api", async () => {
  const { request, requests } = makeRequest();
  const { spider, cache } = loadSpider(request);

  const result = await spider.play({ playId: "deco-x-deco-the-animation-1|2032" }, {});
  assert.equal(result.parse, 0);
  assert.ok(result.urls.length >= 2);
  assert.ok(result.urls[0].url.startsWith("https://cdn-a.example.com/"));
  assert.ok(result.urls[0].url.endsWith("/x264.720p.mp4"), "720p 直连应排第一");
  assert.ok(result.urls.some((item) => item.url.endsWith("/1080/manifest.mpd")));
  assert.equal(result.urls.some((item) => item.url.endsWith("/2160/manifest.mpd")), false, "探测失败的线路应被剔除");

  const post = requests.find((item) => item.method === "POST");
  assert.equal(post.url, "https://hstream.moe/player/api");
  assert.equal(post.headers["X-Requested-With"], "XMLHttpRequest");
  assert.match(String(post.headers.Cookie || ""), /hstream_session=/);
  const payload = JSON.parse(post.body);
  assert.equal(payload.episode_id, "2032");
  assert.equal(payload._token, "TOKENVALUE");

  assert.ok([...cache.keys()].some((key) => key.startsWith("hstream:session")));
  assert.ok([...cache.keys()].some((key) => key.startsWith("hstream:play")));
});

test("HStream play falls back to page sniff when episode id missing", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);

  const result = await spider.play({ playId: "unknown-slug-xyz" }, {});
  assert.equal(result.parse, 1);
  assert.equal(result.urls.length, 1);
  assert.ok(result.urls[0].url.endsWith("/hentai/unknown-slug-xyz"));

  // 404 页面不做无意义嗅探兜底
  const notFound = await spider.play({ playId: "missing-slug-404" }, {});
  assert.equal(notFound.urls.length, 0);
  assert.equal(notFound.parse, 0);
});

test("HStream play refreshes session on csrf failure", async () => {
  let homeHits = 0;
  const { request } = makeRequest();
  const wrapped = async (url, options = {}) => {
    if (String(url) === "https://hstream.moe/" && (options.method || "GET") === "GET") {
      homeHits += 1;
      return {
        statusCode: 200,
        headers: { "set-cookie": [`hstream_session=s${homeHits}; Path=/`] },
        body: `<input type="hidden" name="_token" value="TOKENVALUE" />`,
      };
    }
    if (String(url) === "https://hstream.moe/player/api") {
      const payload = JSON.parse(options.body || "{}");
      assert.equal(payload.episode_id, "2032");
      if (homeHits === 1) {
        return { statusCode: 419, headers: {}, body: JSON.stringify({ message: "CSRF token mismatch." }) };
      }
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          title: "x",
          stream_url: "2026/Deco.x.Deco.The.Animation/E01",
          stream_domains: ["https://cdn-a.example.com"],
          interpolated: 0,
          interpolated_uhd: 0,
        }),
      };
    }
    return request(url, options);
  };

  const { spider } = loadSpider(wrapped);
  const result = await spider.play({ playId: "slug-1|2032" }, {});
  assert.equal(homeHits, 2, "419 后应重建一次会话");
  assert.equal(result.parse, 0);
  assert.ok(result.urls.length >= 1);
});

test("HStream play restricts DASH for tvbox-like clients", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);

  const web = await spider.play({ playId: "deco-x-deco-the-animation-1|2032" }, { from: "web" });
  assert.ok(web.urls.some((item) => item.url.endsWith("/1080/manifest.mpd")));

  const tv = await spider.play({ playId: "deco-x-deco-the-animation-1|2032" }, { from: "tvbox" });
  assert.equal(tv.parse, 0);
  assert.equal(tv.urls.length, 1);
  assert.ok(tv.urls[0].url.endsWith("/x264.720p.mp4"));
  assert.ok(tv.header.Accept === "*/*");
});

test("HStream retries ECONNRESET and falls back to stored home snapshot", async () => {
  // 首次请求全部抛 ECONNRESET，home 应回退历史快照而不是直接空列表
  let calls = 0;
  const request = async () => {
    calls += 1;
    const error = new Error("read ECONNRESET");
    error.code = "ECONNRESET";
    throw error;
  };
  // 关掉原生直连兜底，确保测试只验证「重试 + 快照回退」这一条链路
  const { spider, cache } = loadSpider(request, { HSTREAM_NATIVE_FALLBACK: "0" });

  // 预置一份历史快照
  cache.set("hstream:home:last", JSON.stringify({
    list: [{ vod_id: "snapshot-1", vod_name: "快照条目", vod_pic: "https://hstream.moe/x.webp", vod_remarks: "" }],
  }));

  const result = await spider.home({}, {});
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].vod_id, "snapshot-1");
  assert.ok(calls >= 3, "应至少重试 NET_RETRY_TIMES 次");
});

test("HStream retry layer reissues request after transient reset", async () => {
  let calls = 0;
  const { request } = makeRequest();
  const wrapped = async (url, options = {}) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("read ECONNRESET");
      error.code = "ECONNRESET";
      throw error;
    }
    return request(url, options);
  };
  // 关闭原生直连兜底，避免单测打到真实网络
  const { spider } = loadSpider(wrapped, { HSTREAM_NATIVE_FALLBACK: "0" });
  const result = await spider.home({}, {});
  assert.ok(result.list.length >= 3, "重试后应正常返回");
  assert.ok(calls >= 2, "应发生过重试");
});

test("HStream force-native switch bypasses host request layer", async () => {
  // FORCE_NATIVE=1 时首个请求就应走原生直连，宿主 request 不应被调用
  let hostCalls = 0;
  const { request } = makeRequest();
  const wrapped = async (url, options = {}) => {
    hostCalls += 1;
    return request(url, options);
  };
  const { spider } = loadSpider(wrapped, { HSTREAM_FORCE_NATIVE: "1" });
  const result = await spider.category({ categoryId: "order:recently-uploaded", page: 1 }, {});
  assert.equal(hostCalls, 0, "强制原生直连时不应调用宿主 request");
  assert.ok(result.list.length >= 2);
});

test("HStream ships proxy tunnel helpers (http connect + socks5)", () => {
  assert.match(source, /function parseProxyUrl/);
  assert.match(source, /function connectViaHttpProxy/);
  assert.match(source, /function connectViaSocks5/);
  assert.match(source, /HSTREAM_PROXY_URL/);
  assert.match(source, /UPSTREAM_HTTP_PROXY_URL/);
  assert.match(source, /Proxy-Authorization: Basic/);
  assert.match(source, /servername: targetHost/);
});

test("HStream routes through proxy first when proxy configured", async () => {
  let hostCalls = 0;
  const { request } = makeRequest();
  const wrapped = async (url, options = {}) => {
    hostCalls += 1;
    return request(url, options);
  };
  // 指向一个不存在的本地代理端口：证明首个请求不走宿主层
  const { spider } = loadSpider(wrapped, {
    HSTREAM_PROXY_URL: "http://127.0.0.1:1",
    HSTREAM_RETRY_TIMES: "1",
  });
  const result = await spider.category({ categoryId: "order:recently-uploaded", page: 1 }, {});
  assert.equal(hostCalls, 0, "配置代理后不应再调用宿主 request");
  assert.equal(result.list.length, 0, "代理不可用时应安全返回空");
});
