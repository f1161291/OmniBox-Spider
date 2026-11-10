const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "影视库", "洛雪TV.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "lxyy");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

function loadSpider(routes, env = {}) {
  const spiderModule = { exports: {} };
  const cache = new Map();
  const logs = [];
  const requested = [];

  const sdk = {
    log: async (level, message) => { logs.push(`[${level}] ${message}`); },
    getCache: async (key) => (cache.has(key) ? cache.get(key) : null),
    setCache: async (key, value) => { cache.set(key, value); },
    deleteCache: async (key) => { cache.delete(key); },
  };

  function fakeRequest(options, onResponse) {
    const host = options.hostname || "";
    const p = options.path || "";
    const url = `https://${host}${p}`;
    requested.push({ url, method: options.method || "GET" });

    let written = "";
    const emitter = {
      on(event, handler) {
        if (event === "error") emitter._onError = handler;
        if (event === "timeout") emitter._onTimeout = handler;
        return emitter;
      },
      write(chunk) { written += String(chunk == null ? "" : chunk); return emitter; },
      destroy() {},
      end() {
        const eff = Object.assign({}, options, { body: written || options.body });
        const matched = routes.find((r) => r.match(url, eff));
        if (!matched) {
          setImmediate(() => emitter._onError && emitter._onError(new Error("ENOTFOUND")));
          return;
        }
        const body = typeof matched.body === "function" ? matched.body(url, eff) : matched.body;
        const res = {
          statusCode: matched.status || 200,
          headers: {},
          on(event, handler) {
            if (event === "data") setImmediate(() => handler(Buffer.from(body, "utf8")));
            if (event === "end") setImmediate(() => handler());
            return res;
          },
          resume() {}, destroy() {},
        };
        setImmediate(() => onResponse(res));
      },
    };
    return emitter;
  }

  const localRequire = (id) => {
    if (id === "omnibox_sdk") return sdk;
    if (id === "spider_runner") return { run: () => {} };
    if (id === "https" || id === "http") return { request: fakeRequest };
    return require(id);
  };

  vm.runInNewContext(source, {
    module: spiderModule,
    exports: spiderModule.exports,
    require: localRequire,
    process: { env: Object.assign({ LXYY_PROXY_MIN_INTERVAL: "0" }, env) },
    URL, URLSearchParams, Buffer, Date,
    setTimeout, clearTimeout, setImmediate, Promise, console,
  }, { filename: "洛雪TV.js" });

  return { spider: spiderModule.exports, cache, logs, requested };
}

function baseRoutes(overrides = []) {
  return overrides.concat([
    { match: (u) => u.includes("action=config"), body: () => fixture("proxy-config.json") },
    { match: (u) => u.includes("action=search"), body: () => fixture("proxy-search.json") },
    { match: (u) => u.includes("action=detail"), body: () => fixture("proxy-detail.json") },
    { match: (u) => u.includes("quark-ranking.php"), body: () => fixture("rank-channel.json") },
    { match: (u) => u.includes("search/multi"), body: () => fixture("search.json") },
    { match: (u) => u.includes("tv/\\d+/season/") || u.includes("season/"), body: () => fixture("season.json") },
    { match: (u) => u.includes("path=tv/") && /tv\/\d+(&|$)/.test(u), body: () => fixture("tv-detail.json") },
    { match: (u) => u.includes("path=movie/"), body: () => fixture("movie-detail.json") },
    { match: (u) => u.includes("discover/"), body: () => fixture("discover.json") },
  ]);
}

test("洛雪TV v2 declares annotations and OM format", () => {
  assert.match(source, /\/\/ @name 洛雪TV/);
  assert.match(source, /\/\/ @version 2\.0\.0/);
  assert.match(source, /@downloadURL .*影视\/影视库\/洛雪TV\.js/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
  assert.doesNotMatch(source, /app\.get\(meta\.api/);
});

test("洛雪TV uses /api/proxy.php as the playback backbone", () => {
  // v1.x 漏掉的主链路，必须存在
  assert.match(source, /\/api\/proxy\.php/);
  assert.match(source, /action=.*search|proxySearch/);
  assert.match(source, /proxyDetail/);
  assert.match(source, /buildProxyEpisodes/);
});

test("洛雪TV home mixes collect-source results and ranking", async () => {
  const { spider } = loadSpider(baseRoutes());
  const result = await spider.home({}, { from: "web" });

  assert.ok(result.class.length >= 10, `分类应 10+，实际 ${result.class.length}`);
  assert.ok(result.list.length > 0, "首页应有数据");
  // 采集站条目 vod_id 形如 cs|source|id
  const csItems = result.list.filter((i) => i.vod_id.startsWith("cs|"));
  assert.ok(csItems.length > 0, "首页应包含采集站条目（可播内容）");
  // 榜单条目也应有
  const rkItems = result.list.filter((i) => i.vod_id.startsWith("rk|"));
  assert.ok(rkItems.length > 0, "首页应包含榜单条目");
});

test("洛雪TV detail of collect item returns real episode list", async () => {
  const { spider } = loadSpider(baseRoutes());
  const result = await spider.detail({ videoId: "cs|qilin|26653" }, {});

  assert.equal(result.list.length, 1);
  const vod = result.list[0];
  assert.ok(vod.vod_name, "应有标题");
  assert.ok(vod.vod_play_sources.length > 0, "采集站详情必须有播放源");
  const eps = vod.vod_play_sources[0].episodes;
  assert.ok(eps.length >= 20, `应解析出完整分集，实际 ${eps.length}`);
  assert.match(eps[0].playId, /^px\|/, "playId 应为 px|base64 形态");
  assert.ok(vod.vod_play_url.includes("$"), "应兼容 vod_play_url");
});

test("洛雪TV play decodes px playId into parse=1 urls", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const meta = { u: "https://www.mgtv.com/b/1/2.html", p: "https://svip.example/?url=", s: "qilin", i: "1", t: "测试", g: "mgtv" };
  const playId = `px|${Buffer.from(JSON.stringify(meta), "utf8").toString("base64")}`;

  const result = await spider.play({ playId }, { from: "web" });
  assert.equal(result.parse, 1, "平台播放页应 parse=1");
  assert.ok(result.urls.length >= 2, "应给出解析入口 + 原始播放页");
  assert.ok(result.urls[0].url.includes("svip.example"), "首条应为 player_api 解析入口");
  assert.ok(result.urls.some((u) => u.url.includes("mgtv.com")), "应保留原始播放页");
  assert.equal(requested.length, 0, "playId 自带信息，不应再请求站点");
});

test("洛雪TV play handles direct media url", async () => {
  const { spider } = loadSpider(baseRoutes());
  const meta = { u: "https://cdn.example.com/a.m3u8", p: "", t: "直链测试" };
  const playId = `px|${Buffer.from(JSON.stringify(meta), "utf8").toString("base64")}`;
  const result = await spider.play({ playId }, {});
  assert.equal(result.parse, 0, "直链应 parse=0");
  assert.ok(result.urls[0].url.endsWith(".m3u8"));
});

test("洛雪TV search prefers collect source", async () => {
  const { spider } = loadSpider(baseRoutes());
  const result = await spider.search({ keyword: "流浪地球", page: 1 }, {});

  assert.ok(result.list.length > 0);
  assert.ok(result.total > 0);
  const ids = result.list.map((i) => i.vod_id);
  assert.ok(ids.every((id) => id.startsWith("cs|")), "搜索应优先返回采集站条目");
});

test("洛雪TV search falls back to TMDB when collect empty", async () => {
  const routes = baseRoutes([
    { match: (u) => u.includes("action=search"), body: () => JSON.stringify({ success: true, results: [] }) },
  ]);
  const { spider } = loadSpider(routes);
  const result = await spider.search({ keyword: "流浪地球", page: 1 }, {});
  assert.ok(result.list.length > 0, "采集站为空应回退 TMDB");
  assert.ok(result.list.every((i) => i.vod_id.startsWith("tm|")));
});

test("洛雪TV category supports rank and tmdb discover", async () => {
  const { spider } = loadSpider(baseRoutes());

  const rank = await spider.category({ categoryId: "rank:电影", page: 1 }, {});
  assert.ok(rank.list.length > 0);

  const tmdb = await spider.category({ categoryId: "movie:popular", page: 1 }, {});
  assert.ok(tmdb.list.length > 0);
  assert.ok(tmdb.pagecount > 1);

  const unknown = await spider.category({ categoryId: "nope", page: 1 }, {});
  assert.equal(unknown.list.length, 0);
});

test("洛雪TV detects proxy rate-limit and enters cooldown", async () => {
  const routes = baseRoutes([
    {
      match: (u) => u.includes("action=search"),
      body: () => JSON.stringify({ message: "未知操作", success: false }),
    },
  ]);
  const { spider, logs } = loadSpider(routes);
  await spider.search({ keyword: "测试", page: 1 }, {});

  assert.ok(
    logs.some((l) => l.indexOf("被限流") >= 0 || l.indexOf("冷却") >= 0),
    `应识别限流并记录，实际：${logs.join(" | ")}`,
  );
});

test("洛雪TV reuses repo-standard PANSOU_* env vars", () => {
  for (const key of [
    "PANSOU_API", "PANSOU_CHANNELS", "PANSOU_PLUGINS", "PANSOU_CLOUD_TYPES",
    "PANSOU_FILTER", "PANSOU_CACHE_EX_SECONDS",
    "PANCHECK_API", "PANCHECK_ENABLED", "PANCHECK_PLATFORMS",
    "DRIVE_ORDER", "DRIVE_TYPE_CONFIG", "SOURCE_NAMES_CONFIG",
    "EXTERNAL_SERVER_PROXY_ENABLED",
  ]) {
    assert.ok(source.includes(`process.env.${key}`), `应复用 ${key}`);
  }
  assert.doesNotMatch(source, /PAN_API_BASE/);
});

test("洛雪TV never writes to stdout", () => {
  const head = source.slice(0, source.indexOf("const crypto"));
  assert.doesNotMatch(head, /console\.log/);
  assert.match(source, /Promise\.resolve\(OmniBox\.log/);
});
