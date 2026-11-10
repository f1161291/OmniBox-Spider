const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const crypto = require("node:crypto");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "采集", "可可影视.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "kkys");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

/**
 * 可可影视.js 用 node https/http 直连 + cdndefend 850 挑战解算，
 * 这里把 https/http 替换成按 URL 返回 fixture 的假实现，并默认返回一次 850 挑战页。
 */
function loadSpider(routes, env = {}) {
  const spiderModule = { exports: {} };
  const cache = new Map();
  const logs = [];
  const requested = [];
  let challengeServed = false;

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
    const cookie = (options.headers && options.headers.Cookie) || "";
    requested.push({ url, method: options.method || "GET", cookie });

    const emitter = {
      on(event, handler) {
        if (event === "error") emitter._onError = handler;
        if (event === "timeout") emitter._onTimeout = handler;
        return emitter;
      },
      write() { return emitter; },
      destroy() {},
      end() {
        // 首次主站请求返回 850 挑战页；带正确挑战 cookie 后放行
        if (!challengeServed && /kkys/.test(host) && !/cdndefend_js_cookie=[A-F0-9]{40}\d+/.test(cookie)) {
          challengeServed = true;
          return respond(850, fixture("challenge.html"));
        }
        const matched = routes.find((r) => r.match(url, options));
        if (!matched) return respond(503, "");
        const body = typeof matched.body === "function" ? matched.body(url, options) : matched.body;
        return respond(matched.status || 200, body);
      },
    };

    function respond(statusCode, body) {
      const res = {
        statusCode,
        headers: {},
        on(event, handler) {
          if (event === "data") setImmediate(() => handler(Buffer.from(body, "utf8")));
          if (event === "end") setImmediate(handler);
          return res;
        },
        resume() {}, destroy() {},
      };
      setImmediate(() => onResponse(res));
    }

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
    process: { env: Object.assign({ SITE_API: "https://www.kkys14.com" }, env) },
    URL, URLSearchParams, Buffer, Date, Math, JSON,
    setTimeout, clearTimeout, setImmediate, Promise, console,
  }, { filename: "可可影视.js" });

  return { spider: spiderModule.exports, cache, logs, requested };
}

function baseRoutes(overrides = []) {
  return overrides.concat([
    { match: (u) => /rdul\.js/.test(u), body: () => fixture("rdul.js") },
    { match: (u) => /\/vod1\/heartbeat\.check/.test(u), body: "" },
    { match: (u) => u.endsWith("/") || /kkys14\.com\/$/.test(u), body: () => fixture("home.html") },
    { match: (u) => /\/show\/\d+.*\.html/.test(u), body: () => fixture("show.html") },
    { match: (u) => /\/new\/\d+\.html/.test(u), body: () => fixture("new.html") },
    { match: (u) => /\/ranking\/\w+\.html/.test(u), body: () => fixture("rank.html") },
    { match: (u) => /\/detail\/\d+\.html/.test(u), body: () => fixture("detail.html") },
    { match: (u) => /\/search\?/.test(u) && /&t=/.test(u) || /\/search\?k=/.test(u), body: () => fixture("search.html") },
    { match: (u) => /\/play\/[\d-]+\.html/.test(u), body: () => fixture("play.html") },
  ]);
}

test("可可影视 声明注解与 OM 五方法格式", () => {
  assert.match(source, /@name 可可影视/);
  assert.match(source, /@version 1\.0\.0/);
  assert.match(source, /@downloadURL .*影视\/采集\/可可影视\.js/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
  assert.doesNotMatch(source, /app\.get\(meta\.api/);
  assert.doesNotMatch(source, /@name 网飞猫/);
});

test("可可影视 能解算 cdndefend 850 挑战", async () => {
  const { spider, requested, logs } = loadSpider(baseRoutes());
  const home = await spider.home({}, { from: "web" });
  assert.ok(home.list.length > 0, "首页应有数据");
  const challengeHits = logs.filter((l) => /850 挑战/.test(l));
  assert.ok(challengeHits.length > 0, "应记录到 850 挑战");
  const retried = requested.filter((r) => /cdndefend_js_cookie=/.test(r.cookie));
  assert.ok(retried.length > 0, "重试请求应带上挑战 cookie");
});

test("可可影视 home 返回分类 / 轮播 / 筛选", async () => {
  const { spider } = loadSpider(baseRoutes());
  const home = await spider.home({}, { from: "web" });

  assert.equal(home.class.length, 7);
  assert.ok(home.class.some((c) => c.type_id === "1" && c.type_name === "电影"));
  assert.ok(home.list.length > 0);
  assert.ok(home.list[0].vod_id, "卡片应有 vod_id");
  assert.ok(home.list[0].vod_name, "卡片应有名称");
  assert.match(home.list[0].vod_pic, /^https:\/\/vres\.test\//, "封面应改写为资源域名");
  assert.ok(home.banner.length > 0, "应解析出轮播");
  assert.ok(home.banner[0].description, "轮播应有简介");
  assert.ok(home.filters["1"], "电影分类应有筛选");
  const typeRow = home.filters["1"].find((f) => f.key === "type");
  assert.ok(typeRow.value.some((v) => v.value === "剧情"));
  assert.ok(home.filters.rank, "排行榜应有 tab 筛选");
  assert.equal(home.filters.new, undefined, "今日更新不提供无效排序按钮");
});

test("可可影视 category 按 /show/ 路由拼装并翻页", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const res = await spider.category({ categoryId: "1", page: 2, filters: { type: "剧情", sort: "2" } }, {});

  assert.equal(res.page, 2);
  assert.ok(res.pagecount >= 2);
  assert.ok(res.list.length > 0);
  const hits = requested.filter((r) => /\/show\/1-/.test(r.url));
  assert.ok(hits.length > 0, "应请求 show 路由");
  const filtered = hits[hits.length - 1];
  assert.match(filtered.url, /-2-2\.html$/, "filters + page 应拼进 show 路径");
});

test("可可影视 category 支持今日更新与排行榜虚拟分类", async () => {
  const { spider } = loadSpider(baseRoutes());
  const nw = await spider.category({ categoryId: "new", page: 1 }, {});
  assert.ok(nw.list.length > 0, "今日更新应有数据");
  assert.ok(nw.pagecount >= 2, "今日更新应能翻页");

  const rk = await spider.category({ categoryId: "rank", page: 1, filters: { tab: "week" } }, {});
  assert.ok(rk.list.length > 0, "排行榜应有数据");
  assert.match(rk.list[0].type_name, /周榜/, "周榜应写入分类名");
  assert.match(rk.list[0].vod_remarks, /TOP\d/, "榜单应带名次");
});

test("可可影视 detail 解析线路 / 分集 / 元数据", async () => {
  const { spider } = loadSpider(baseRoutes());
  const res = await spider.detail({ videoId: "13898" }, {});

  assert.equal(res.list.length, 1);
  const vod = res.list[0];
  assert.equal(vod.vod_name, "后宫·甄嬛传");
  assert.equal(vod.vod_year, "2011");
  assert.match(vod.vod_actor, /孙俪/);
  assert.match(vod.vod_director, /郑晓龙/);
  assert.ok(vod.vod_content.length > 0);
  assert.equal(vod.vod_play_sources.length, 2, "fixture 两条线路");
  const eps = vod.vod_play_sources[0].episodes;
  assert.equal(eps.length, 3);
  assert.match(eps[0].playId, /^\/play\/13898-\d+-\d+\.html\|\|\|/, "playId 应透传播放页 URL + meta");
  assert.ok(vod.vod_play_from.includes("$$$"), "应兼容 vod_play_from");
  assert.ok(vod.vod_play_url.includes("$"), "应兼容 vod_play_url");
});

test("可可影视 play 从 playSource 取直链并 parse=0", async () => {
  const { spider } = loadSpider(baseRoutes());
  const detail = await spider.detail({ videoId: "13898" }, {});
  const ep = detail.list[0].vod_play_sources[0].episodes[0];

  const res = await spider.play({ playId: ep.playId, flag: "超清2" }, {});
  assert.equal(res.parse, 0, "解析到媒体直链应 parse=0");
  assert.match(res.urls[0].url, /\.m3u8/);
  assert.ok(res.header.Referer, "应带 Referer");
  assert.ok(res.header.Origin, "应带 Origin");
});

test("可可影视 play 支持直链 playId 直通", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const meta = { sid: "1", fid: "1#a#0", v: "测试", e: "第1集", n: 1 };
  const playId = `https://cdn.example.com/a/index.m3u8|||${Buffer.from(JSON.stringify(meta)).toString("base64")}`;
  const before = requested.length;
  const res = await spider.play({ playId }, {});

  assert.equal(res.parse, 0);
  assert.equal(res.urls[0].url, "https://cdn.example.com/a/index.m3u8");
  assert.equal(requested.length, before, "直链不应再发请求");
});

test("可可影视 search 使用实时 t token 并按 total 推页数", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const res = await spider.search({ keyword: "甄嬛", page: 1 }, {});

  assert.ok(res.list.length > 0);
  assert.equal(res.total, 90);
  assert.equal(res.pagecount, 5, "90 条 / 每页 18 条 = 5 页");
  const withToken = requested.filter((r) => /\/search\?/.test(r.url) && /t=/.test(r.url));
  assert.ok(withToken.length > 0, "搜索请求应带 t token");
});

test("可可影视 请求失败安全返回空结构", async () => {
  const { spider } = loadSpider([
    { match: (u) => /rdul\.js/.test(u), body: () => fixture("rdul.js") },
  ]);
  const home = await spider.home({}, {});
  assert.equal(home.list.length, 0);
  assert.equal(home.class.length, 7);
  const cat = await spider.category({ categoryId: "1", page: 1 }, {});
  assert.equal(cat.list.length, 0);
  const d = await spider.detail({ videoId: "1" }, {});
  assert.equal(d.list.length, 0);
  const s = await spider.search({ keyword: "x", page: 1 }, {});
  assert.equal(s.list.length, 0);
});
