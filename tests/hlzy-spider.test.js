const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "颜色", "黑料资源.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "hlzy");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

/**
 * routes 里每条可带：
 *   match(url) -> bool
 *   body / status / encoding
 *   hang: true  -> 模拟「TCP 通但永不应答」（视频 CDN 在不可用地区的真实表现）
 */
function loadSpider(routes, env = {}) {
  const spiderModule = { exports: {} };
  const cache = new Map();
  const logs = [];
  const requested = [];
  const timers = [];

  const sdk = {
    log: async (level, message) => { logs.push(`[${level}] ${message}`); },
    getCache: async (key) => (cache.has(key) ? cache.get(key) : null),
    setCache: async (key, value) => { cache.set(key, value); },
    deleteCache: async (key) => { cache.delete(key); },
    sniffVideo: async () => "",
  };

  function fakeRequest(options, onResponse) {
    const host = options.hostname || "";
    const p = options.path || "";
    const url = `https://${host}${p}`;
    requested.push({ url, headers: options.headers || {} });

    const emitter = {
      on(event, handler) {
        if (event === "error") emitter._onError = handler;
        if (event === "timeout") emitter._onTimeout = handler;
        return emitter;
      },
      write() { return emitter; },
      destroy() { emitter._destroyed = true; },
      end() {
        const matched = routes.find((r) => r.match(url, options));
        if (!matched) return respond(404, "");
        if (matched.hang) return; // 永不应答：模拟黑洞 CDN
        const body = typeof matched.body === "function" ? matched.body(url, options) : matched.body;
        return respond(matched.status || 200, body, matched.encoding);
      },
    };

    function respond(statusCode, body, encoding) {
      let payload = Buffer.from(body, "utf8");
      const headers = {};
      if (encoding === "gzip") {
        payload = zlib.gzipSync(payload);
        headers["content-encoding"] = "gzip";
      }
      const res = {
        statusCode,
        headers,
        on(event, handler) {
          if (event === "data") setImmediate(() => handler(payload));
          if (event === "end") setImmediate(handler);
          return res;
        },
        once(event, handler) {
          if (event === "data") setImmediate(() => handler(payload));
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

  // 用真实定时器，但记录以便清理（探测的超时是核心被测行为）
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  const wrappedSetTimeout = (fn, ms) => {
    const t = realSetTimeout(fn, ms);
    timers.push(t);
    return t;
  };

  vm.runInNewContext(source, {
    module: spiderModule,
    exports: spiderModule.exports,
    require: localRequire,
    process: { env: Object.assign({
      SITE_API: "https://www.heiliaozyapi.com/api.php/provide/vod",
      SITE_VIDEO_PROBE_TIMEOUT: "120",
      SITE_DANMAKU_WAIT_MS: "10",
    }, env) },
    URL, URLSearchParams, Buffer, Date, Math, JSON,
    setTimeout: wrappedSetTimeout, clearTimeout: realClearTimeout,
    setImmediate, Promise, console,
  }, { filename: "黑料资源.js" });

  return { spider: spiderModule.exports, cache, logs, requested, timers };
}

function baseRoutes(overrides = []) {
  return overrides.concat([
    { match: (u) => /ac=class/.test(u), body: () => fixture("class.json") },
    { match: (u) => /ac=detail/.test(u), body: () => fixture("detail.json") },
    { match: (u) => /ac=videolist/.test(u) && /wd=/.test(u), body: () => fixture("search.json") },
    { match: (u) => /ac=videolist/.test(u), body: () => fixture("videolist.json"), encoding: "gzip" },
  ]);
}

// 视频源可用：正常返回 200
const VIDEO_OK = { match: (u) => /bf\.qugt\.com/.test(u), body: "#EXTM3U\n" };
// 视频源不可用：永不应答（真实表现）
const VIDEO_HANG = { match: (u) => /bf\.qugt\.com/.test(u), hang: true };

test("黑料资源 声明注解与 OM 五方法格式", () => {
  assert.match(source, /@name 🔞黑料资源/);
  assert.match(source, /@version 2\.0\.0/);
  assert.match(source, /@downloadURL .*影视\/颜色\/黑料资源\.js/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
  assert.doesNotMatch(source, /app\.get\(meta\.api/);
});

test("黑料资源 剔除 7 个恒 0 条的图文分类", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_OK]));
  const home = await spider.home({}, { from: "web" });

  const ids = home.class.map((c) => c.type_id);
  for (const dead of ["20", "21", "22", "23", "24", "25", "26"]) {
    assert.equal(ids.includes(dead), false, `分类 ${dead} 恒 0 条，必须剔除`);
  }
  assert.ok(ids.includes("1"), "中文字幕应保留");
  assert.ok(ids.includes("38"), "抖阴视频应保留");
  assert.equal(home.class.length, 17, "24 - 7 = 17 个有效分类");
});

test("黑料资源 死分类直接返回空，不发请求", async () => {
  const { spider, requested } = loadSpider(baseRoutes([VIDEO_OK]));
  const before = requested.length;
  const res = await spider.category({ categoryId: "24", page: 1 }, {});
  assert.equal(res.list.length, 0);
  assert.equal(requested.length, before, "死分类不应再打接口");
});

test("黑料资源 只提供实测生效的 year 筛选", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_OK]));
  const home = await spider.home({}, { from: "web" });
  const keys = home.filters["1"].map((f) => f.key).join(",");
  assert.equal(keys, "year", "area/lang/by 实测被忽略，不应提供");
  const values = home.filters["1"][0].value.map((v) => v.value);
  assert.ok(values.includes("2024"));
  assert.equal(values.includes("0_1979"), false, "「更早」在该接口会退化成全部，必须去掉");
});

test("黑料资源 非法 year 被忽略", async () => {
  const { spider, requested } = loadSpider(baseRoutes([VIDEO_OK]));
  const before = requested.length;
  await spider.category({ categoryId: "1", page: 1, filters: { year: "0_1979" } }, {});
  const hit = requested.slice(before).find((r) => /ac=videolist&t=1/.test(r.url));
  assert.ok(hit, "应请求 t=1");
  assert.doesNotMatch(hit.url, /year=/, "非法 year 不应拼进请求");
});

test("黑料资源 category 正常拼 year 与分页", async () => {
  const { spider, requested } = loadSpider(baseRoutes([VIDEO_OK]));
  const res = await spider.category({ categoryId: "1", page: 3, filters: { year: "2024" } }, {});
  const hit = requested.find((r) => /ac=videolist&t=1/.test(r.url));
  assert.match(hit.url, /pg=3/);
  assert.match(hit.url, /year=2024/);
  assert.ok(res.list.length > 0);
});

test("黑料资源 列表走 videolist 并解 gzip", async () => {
  const { spider, requested } = loadSpider(baseRoutes([VIDEO_OK]));
  const home = await spider.home({}, { from: "web" });
  const hit = requested.find((r) => /ac=videolist/.test(r.url));
  assert.match(String(hit.headers["Accept-Encoding"]), /gzip/);
  assert.ok(home.list[0].vod_pic, "videolist 应带封面");
  assert.ok(home.list[0].vod_year, "videolist 应带年份");
});

test("黑料资源 detail 线路名保持原样不带 -vodId", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_OK]));
  const res = await spider.detail({ videoId: "104450" }, {});
  const vod = res.list[0];
  assert.equal(vod.vod_name, "游.Voyage.2013.BD720P");
  assert.equal(vod.vod_play_sources.length, 1);
  assert.equal(vod.vod_play_sources[0].name, "heiliaom3u8");
  assert.doesNotMatch(vod.vod_play_from, /heiliaom3u8-\d+/);
  assert.match(vod.vod_play_sources[0].episodes[0].playId, /\|\|\|/);
});

test("黑料资源 play 补 domianurl 并给全 header", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_OK]));
  const detail = await spider.detail({ videoId: "104450" }, {});
  const ep = detail.list[0].vod_play_sources[0].episodes[0];

  const res = await spider.play({ playId: ep.playId, flag: "heiliaom3u8" }, {});
  assert.equal(res.parse, 0, "m3u8 应 parse=0");
  assert.match(res.urls[0].url, /\.m3u8/);
  assert.match(res.urls[0].url, /domianurl=heiliaozy\.com/, "官方播放器会给分片加 domianurl");
  assert.ok(res.header.Referer, "必须带 Referer");
  assert.ok(res.header.Origin, "必须带 Origin");
  assert.match(res.header.Referer, /heiliaozy\.com/);
});

test("黑料资源 play 带 query 的 m3u8 仍判直链", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_OK]));
  const meta = { sid: "1", v: "测试", e: "高清", n: 1 };
  const playId = `https://bf.qugt.com:65/videos/a/b/index.m3u8?sign=abc|||${Buffer.from(JSON.stringify(meta)).toString("base64")}`;
  const res = await spider.play({ playId }, {});
  assert.equal(res.parse, 0, "带参数也是直链");
  assert.match(res.urls[0].url, /sign=abc/);
  assert.match(res.urls[0].url, /domianurl=/);
});

test("黑料资源 视频源黑洞时快速失败（核心修复）", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_HANG]));
  const detail = await spider.detail({ videoId: "104450" }, {});
  const ep = detail.list[0].vod_play_sources[0].episodes[0];

  const started = Date.now();
  const res = await spider.play({ playId: ep.playId, flag: "heiliaom3u8" }, {});
  const elapsed = Date.now() - started;

  // 修复前：整条链路要空等 11~13 秒才 ECONNRESET
  assert.ok(elapsed < 1000, `黑洞源必须在硬超时内返回，实际 ${elapsed}ms`);
  assert.equal(res.parse, 0, "仍返回直链交由播放器决定");
  assert.ok(res.urls.length > 0);
  assert.match(res.urls[0].name, /源不可达/, "应明确标注源状态");
});

test("黑料资源 探测结论按 host 缓存，不重复拖慢", async () => {
  const { spider, logs } = loadSpider(baseRoutes([VIDEO_HANG]));
  const detail = await spider.detail({ videoId: "104450" }, {});
  const ep = detail.list[0].vod_play_sources[0].episodes[0];
  await spider.play({ playId: ep.playId }, {});
  await spider.play({ playId: ep.playId }, {});
  const probes = logs.filter((l) => /\[probe\] host=/.test(l) && /ok=/.test(l) && !/复用/.test(l));
  assert.ok(probes.length <= 1, `同 host 只应实测一次，实际 ${probes.length} 次`);
  assert.ok(logs.some((l) => /复用结论/.test(l)), "第二次应命中缓存");
});

test("黑料资源 视频源正常时不标不可达", async () => {
  const { spider } = loadSpider(baseRoutes([VIDEO_OK]));
  const detail = await spider.detail({ videoId: "104450" }, {});
  const ep = detail.list[0].vod_play_sources[0].episodes[0];
  const res = await spider.play({ playId: ep.playId }, {});
  assert.equal(res.parse, 0);
  assert.doesNotMatch(res.urls[0].name, /源不可达/);
});

test("黑料资源 search 走 videolist 带全字段", async () => {
  const { spider, requested } = loadSpider(baseRoutes([VIDEO_OK]));
  const res = await spider.search({ keyword: "游", page: 1 }, {});
  assert.ok(res.list.length > 0);
  const hit = requested.find((r) => /wd=/.test(r.url));
  assert.match(hit.url, /ac=videolist/);
});

test("黑料资源 接口失败安全返回空结构", async () => {
  const { spider } = loadSpider([]);
  const home = await spider.home({}, {});
  assert.equal(home.list.length, 0);
  const d = await spider.detail({ videoId: "1" }, {});
  assert.equal(d.list.length, 0);
  const s = await spider.search({ keyword: "x", page: 1 }, {});
  assert.equal(s.list.length, 0);
  const p = await spider.play({ playId: "" }, {});
  assert.equal(p.urls.length, 0);
});
