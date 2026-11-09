const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "颜色", "91porn.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "91porn");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

/**
 * 91porn.js 用自己的 https/http 直连，不经过 SDK.request。
 * 这里把 node:https / node:http 的 request 打桩，按 URL 返回 fixture。
 */
function loadSpider(routes, env = {}) {
  const spiderModule = { exports: {} };
  const cache = new Map();
  const logs = [];
  const requested = [];

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
  };

  function fakeRequest(options, onResponse) {
    const host = options.hostname || "";
    const reqPath = `${options.path || ""}`;
    const fullUrl = `https://${host}${reqPath}`;
    requested.push(fullUrl);

    const emitter = {
      on(event, handler) {
        if (event === "error") emitter._onError = handler;
        if (event === "timeout") emitter._onTimeout = handler;
        return emitter;
      },
      write() { return emitter; },
      destroy() {
        if (emitter._onError) emitter._onError(new Error("destroyed"));
      },
      end() {
        const matched = routes.find((r) => r.match(fullUrl, options));
        if (!matched) {
          setImmediate(() => {
            if (emitter._onError) emitter._onError(new Error("ENOTFOUND"));
          });
          return;
        }
        if (matched.error) {
          setImmediate(() => {
            if (emitter._onError) emitter._onError(Object.assign(new Error(matched.error), { code: matched.error }));
          });
          return;
        }
        const body = typeof matched.body === "function" ? matched.body(fullUrl) : matched.body;
        const res = {
          statusCode: matched.status || 200,
          headers: matched.headers || {},
          on(event, handler) {
            if (event === "data") setImmediate(() => handler(Buffer.from(body, "utf8")));
            if (event === "end") setImmediate(() => handler());
            return res;
          },
          resume() {},
          destroy() {},
        };
        setImmediate(() => onResponse(res));
      },
    };
    return emitter;
  }

  const fakeHttps = { request: fakeRequest };
  const fakeHttp = { request: fakeRequest };

  const localRequire = (id) => {
    if (id === "omnibox_sdk") return sdk;
    if (id === "spider_runner") return { run: () => {} };
    if (id === "https") return fakeHttps;
    if (id === "http") return fakeHttp;
    if (id === "crypto") return require("crypto");
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
    Date,
    setTimeout,
    clearTimeout,
    setImmediate,
    Promise,
    console,
  }, { filename: "91porn.js" });

  return { spider: spiderModule.exports, cache, logs, requested };
}

const PRIMARY = "https://91porn.com";
const MIRROR = "https://903.9p234.com";

function makeRoutes(overrides = []) {
  const base = [
    { match: (u) => u === `${PRIMARY}/index.php`, body: () => fixture("index.html") },
    { match: (u) => u.includes("search_result.php"), body: () => fixture("search.html") },
    { match: (u) => u.includes("category=hd"), body: () => fixture("category-hd.html") },
    { match: (u) => u.includes("view_video.php?viewkey=71d16f2b4dcc490972b8"), body: () => fixture("detail.html") },
    { match: (u) => u.includes("view_video.php?viewkey=0000000000000000000"), body: () => fixture("detail-missing.html") },
    { match: (u) => u.includes("/v.php"), body: () => fixture("list-watch.html") },
  ];
  return overrides.concat(base);
}

test("91porn declares version 1.6.0 and OM format", () => {
  assert.match(source, /@version 1\.6\.0/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
});

test("91porn parses HD category cards (view_video_hd.php)", async () => {
  const { spider, logs } = loadSpider(makeRoutes());
  const result = await spider.category({ categoryId: "hd", page: 1 }, {});

  assert.ok(result.list.length >= 20, `高清分类应有卡片，实际 ${result.list.length}`);
  assert.ok(result.total > 0, "应解析出真实总数");
  assert.equal(result.pagecount, 20, "视频列表上限 20 页");
  // 旧实现只匹配 view_video.php，HD 页全是 view_video_hd.php 导致 0 条
  assert.ok(source.indexOf("view_video(?:_hd)?") >= 0, "正则应兼容 view_video_hd.php");
  assert.ok(logs.some((l) => l.indexOf("[category]") >= 0));
});

test("91porn clamps deep pages to site ceiling", async () => {
  const { spider } = loadSpider(makeRoutes());
  const result = await spider.category({ categoryId: "hot", page: 9999 }, {});
  assert.equal(result.page, 20, "超过站点上限应钳制到第 20 页");
  assert.equal(result.pagecount, 20);
  assert.ok(result.total > 0);
});

test("91porn search passes page param and reports totals", async () => {
  const captured = [];
  const routes = makeRoutes([
    {
      match: (u) => u.includes("search_result.php"),
      body: (u) => {
        captured.push(u);
        return fixture("search.html");
      },
    },
  ]);
  const { spider } = loadSpider(routes);

  const result = await spider.search({ keyword: "巨乳", page: 3 }, {});
  assert.ok(captured.some((u) => /[?&]page=3(&|$)/.test(u)), `搜索应带上 page=3，实际 ${captured[0]}`);
  assert.ok(result.pagecount > 1, "应返回 pagecount");
  assert.ok(result.total > 0, "应返回 total");
  assert.equal(result.limit, 24);
});

test("91porn detail extracts author from main info block", async () => {
  const { spider } = loadSpider(makeRoutes());
  const result = await spider.detail({ videoId: "71d16f2b4dcc490972b8" }, {});

  assert.equal(result.list.length, 1);
  const vod = result.list[0];
  assert.equal(vod.vod_actor, "老番茄6699", `作者应取主信息区真值，实际 ${vod.vod_actor}`);
  assert.ok(vod.vod_name.includes("HR经理"));
  assert.ok(vod.vod_pic.includes("/thumb/"));
});

test("91porn detail returns empty for missing video", async () => {
  const { spider } = loadSpider(makeRoutes());
  const result = await spider.detail({ videoId: "0000000000000000000" }, {});
  assert.equal(result.list.length, 0, "无效 viewkey 应返回空列表而不是空壳条目");
});

test("91porn normalizes double-slash media urls", () => {
  // 站点 btc620 线路会给出 host 后双斜杠的地址，必须规范化成单斜杠
  assert.ok(source.indexOf("{2,}") >= 0, '应有双斜杠规范化');
});

test("91porn failover tolerates small-but-valid bodies", async () => {
  // 200 且 600 字节（>=512）不应被判为失败
  const routes = [
    { match: (u) => u.includes("/v.php"), body: () => "x".repeat(600) },
  ].concat(makeRoutes());
  const { spider, logs } = loadSpider(routes);
  await spider.category({ categoryId: "hot", page: 1 }, {});
  assert.equal(
    logs.some((l) => l.indexOf("响应体过小") >= 0),
    false,
    "600B 的 200 响应不应触发“过小”判死",
  );
});

test("91porn empty result triggers one base retry", async () => {
  let calls = 0;
  const routes = [
    {
      match: (u) => u.includes("/v.php"),
      body: () => {
        calls += 1;
        // 第一次返回「页面正常但没有卡片」，第二次返回正常列表
        return calls === 1
          ? fixture("list-watch.html").replace(/<a[^>]*view_video[\s\S]*?<\/a>/gi, "")
          : fixture("list-watch.html");
      },
    },
  ].concat(makeRoutes());
  const { spider, logs } = loadSpider(routes);
  const result = await spider.category({ categoryId: "hot", page: 1 }, {});
  assert.ok(result.list.length > 0, "空结果应重试并拿到数据");
  assert.ok(logs.some((l) => l.indexOf("首次 0 条，重试一次") >= 0));
});
