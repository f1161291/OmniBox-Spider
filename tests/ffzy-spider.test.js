const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "采集", "非凡资源.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "ffzy");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

/**
 * 非凡资源.js 用 node https/http 直连采集站 API，
 * 这里把两者替换成按 query 返回 fixture 的假实现。
 */
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
      destroy() {},
      end() {
        const matched = routes.find((r) => r.match(url, options));
        if (!matched) return respond(404, "");
        const body = typeof matched.body === "function" ? matched.body(url, options) : matched.body;
        return respond(matched.status || 200, body, matched.encoding);
      },
    };

    function respond(statusCode, body, encoding) {
      // 模拟 gzip：body 由 httpGet 的 decompress 解压
      let payload = Buffer.from(body, "utf8");
      const headers = {};
      if (encoding === "gzip") {
        payload = require("node:zlib").gzipSync(payload);
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
    process: { env: Object.assign({ SITE_API: "https://api.ffzyapi.com/api.php/provide/vod" }, env) },
    URL, URLSearchParams, Buffer, Date, Math, JSON,
    setTimeout, clearTimeout, setImmediate, Promise, console,
  }, { filename: "非凡资源.js" });

  return { spider: spiderModule.exports, cache, logs, requested };
}

function baseRoutes(overrides = []) {
  return overrides.concat([
    { match: (u) => /ac=class/.test(u), body: () => fixture("class.json") },
    { match: (u) => /ac=detail/.test(u), body: () => fixture("detail.json") },
    { match: (u) => /ac=videolist/.test(u) && /wd=/.test(u), body: () => fixture("search.json") },
    { match: (u) => /ac=videolist/.test(u), body: () => fixture("videolist.json"), encoding: "gzip" },
    { match: (u) => /\/share\//.test(u), body: () => fixture("share.html") },
  ]);
}

test("非凡资源 声明注解与 OM 五方法格式", () => {
  assert.match(source, /@name 🎬非凡资源/);
  assert.match(source, /@version 2\.0\.0/);
  assert.match(source, /@downloadURL .*影视\/采集\/非凡资源\.js/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
  assert.doesNotMatch(source, /app\.get\(meta\.api/);
});

test("非凡资源 请求带 gzip（videolist 裸传 657KB 需压缩）", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  await spider.home({}, {});
  const hit = requested.find((r) => /ac=videolist/.test(r.url));
  assert.ok(hit, "首页应请求 ac=videolist");
  assert.match(String(hit.headers["Accept-Encoding"]), /gzip/, "必须显式声明 gzip");
});

test("非凡资源 能解 gzip 压缩的 videolist 响应", async () => {
  const { spider } = loadSpider(baseRoutes());
  const home = await spider.home({}, { from: "web" });
  assert.ok(home.list.length > 0, "gzip 解压后应有数据");
  assert.ok(home.list[0].vod_pic, "videolist 应带封面");
  assert.ok(home.list[0].vod_year, "videolist 应带年份");
});

test("非凡资源 home 剔除父分类并给出可用筛选", async () => {
  const { spider } = loadSpider(baseRoutes());
  const home = await spider.home({}, { from: "web" });

  const ids = home.class.map((c) => c.type_id);
  assert.equal(ids.includes("1"), false, "父分类 电影片 恒 0 条，必须剔除");
  assert.equal(ids.includes("2"), false, "父分类 连续剧 恒 0 条，必须剔除");
  assert.ok(ids.includes("6"), "叶子分类 动作片 应保留");
  assert.ok(ids.includes("new"), "应追加今日更新虚拟分类");
  assert.ok(home.class.length >= 25, `叶子分类应 25+，实际 ${home.class.length}`);
  assert.match(home.class.find((c) => c.type_id === "6").type_name, /电影·/, "叶子分类应带父级前缀");

  assert.ok(home.filters["6"], "分类应有筛选");
  const keys = home.filters["6"].map((f) => f.key).join(",");
  assert.equal(keys, "year,area", "只提供实测生效的 year/area");
  assert.equal(keys.includes("sort"), false, "接口不支持排序，不应给假筛选");
  assert.equal(keys.includes("lang"), false, "lang 参数被忽略，不应给假筛选");
  assert.equal(home.filters.new.length, 1, "今日更新只保留地区筛选");
});

test("非凡资源 关闭父分类请求后不发空查询", async () => {
  const { spider } = loadSpider(baseRoutes());
  const home = await spider.home({}, {});
  const parents = ["1", "2", "3", "4"];
  const bad = home.class.filter((c) => parents.includes(c.type_id));
  assert.equal(bad.length, 0);
});

test("非凡资源 category 拼 year/area 且翻页正确", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const res = await spider.category({ categoryId: "6", page: 2, filters: { year: "2024", area: "大陆" } }, {});

  const hit = requested.find((r) => /ac=videolist&t=6/.test(r.url));
  assert.ok(hit, "应请求 t=6");
  assert.match(hit.url, /pg=2/);
  assert.match(hit.url, /year=2024/);
  assert.match(hit.url, new RegExp(`area=${encodeURIComponent("大陆")}`));
  // fixture 里 page 字段是 1（真实接口会正确回显），这里主要校验请求参数与分页字段
  assert.ok(res.page >= 1);
  assert.ok(res.pagecount >= 1);
  assert.ok(res.list.length > 0);
});

test("非凡资源 category 过滤非法筛选值", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  await spider.category({ categoryId: "6", page: 1, filters: { year: "bogus", area: "火星" } }, {});
  const hit = requested.find((r) => /ac=videolist&t=6/.test(r.url));
  assert.doesNotMatch(hit.url, /year=bogus/);
  assert.doesNotMatch(hit.url, /area=/);
});

test("非凡资源 今日更新走 h=24", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const res = await spider.category({ categoryId: "new", page: 1, filters: { area: "韩国" } }, {});
  const hit = requested.find((r) => /ac=videolist/.test(r.url) && /h=24/.test(r.url));
  assert.ok(hit, "今日更新应带 h=24");
  assert.doesNotMatch(hit.url, /t=/, "今日更新不应带分类 t");
  assert.ok(res.list.length > 0);
});

test("非凡资源 detail 解析线路且线路名不带 -vodId 后缀", async () => {
  const { spider } = loadSpider(baseRoutes());
  const res = await spider.detail({ videoId: "98541" }, {});
  const vod = res.list[0];

  assert.equal(vod.vod_name, "家庭关系证明书");
  assert.equal(vod.vod_year, "2026");
  assert.equal(vod.vod_area, "韩国");
  assert.equal(vod.vod_lang, "韩语");
  assert.match(vod.vod_content, /本剧讲述/);
  assert.equal(vod.vod_play_sources.length, 2);
  assert.equal(vod.vod_play_sources.map((s) => s.name).join(","), "feifan,ffm3u8", "线路名应保持原样");
  assert.doesNotMatch(vod.vod_play_from, /-\d+/, "线路名不应拼 -vodId");
  assert.equal(vod.vod_play_sources[0].episodes.length, 3);
  assert.match(vod.vod_play_sources[0].episodes[0].playId, /\|\|\|/, "playId 应透传 meta");
  assert.ok(vod.vod_play_url.includes("$"), "应兼容 vod_play_url");
  assert.doesNotMatch(vod.vod_play_url, /feifan-\d+/);
});

test("非凡资源 play 直链带 query 也应 parse=0", async () => {
  const { spider } = loadSpider(baseRoutes());
  const detail = await spider.detail({ videoId: "98541" }, {});
  const ep = detail.list[0].vod_play_sources[1].episodes[0];

  const res = await spider.play({ playId: ep.playId, flag: "ffm3u8" }, {});
  assert.equal(res.parse, 0, "带 ?sign= 的 m3u8 也是直链");
  assert.match(res.urls[0].url, /\.m3u8/);
  assert.ok(res.header.Referer);
  assert.ok(res.header.Origin);
});

test("非凡资源 play 分享页解析 const url 得到 m3u8", async () => {
  const { spider } = loadSpider(baseRoutes());
  const detail = await spider.detail({ videoId: "98541" }, {});
  const ep = detail.list[0].vod_play_sources[0].episodes[0];
  assert.match(ep.playId, /\/share\//, "feifan 线路应是分享页");

  const res = await spider.play({ playId: ep.playId, flag: "feifan" }, {});
  assert.equal(res.parse, 0, "分享页应解出直链");
  assert.match(res.urls[0].url, /\.m3u8\?sign=/);
  assert.match(res.urls[0].url, /^https:\/\//);
});

test("非凡资源 play 分享页 403 时安全回退 parse=1", async () => {
  const routes = baseRoutes([
    { match: (u) => /\/share\//.test(u), body: () => fixture("share-403.html"), status: 403 },
  ]);
  const { spider } = loadSpider(routes);
  const meta = { sid: "1", v: "测试", e: "第01集", n: 1, l: "feifan" };
  const playId = `https://vip.ffzy-play9.com/share/deadbeef|||${Buffer.from(JSON.stringify(meta)).toString("base64")}`;

  const res = await spider.play({ playId, flag: "feifan" }, {});
  assert.equal(res.parse, 1, "403 分享页应回退 parse=1");
  assert.match(res.urls[0].url, /\/share\//);
});

test("非凡资源 play 直链 playId 直通不发请求", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const meta = { sid: "1", v: "测试", e: "第01集", n: 1 };
  const playId = `https://cdn.example.com/a/index.m3u8?sign=abc|||${Buffer.from(JSON.stringify(meta)).toString("base64")}`;
  const before = requested.length;
  const res = await spider.play({ playId }, {});
  assert.equal(res.parse, 0);
  assert.equal(res.urls[0].url, "https://cdn.example.com/a/index.m3u8?sign=abc");
  assert.equal(requested.length, before, "直链不应再发请求");
});

test("非凡资源 search 走到 videolist 拿全字段", async () => {
  const { spider, requested } = loadSpider(baseRoutes());
  const res = await spider.search({ keyword: "庆余年", page: 1 }, {});

  assert.ok(res.list.length > 0);
  assert.ok(res.list[0].vod_pic, "搜索应带封面（ac=list 没有，必须用 videolist）");
  const hit = requested.find((r) => /wd=/.test(r.url));
  assert.match(hit.url, /ac=videolist/, "搜索必须用 videolist");
  assert.doesNotMatch(hit.url, /ac=list/, "ac=list 搜索无封面/无 play_url");
});

test("非凡资源 接口失败安全返回空结构", async () => {
  const { spider } = loadSpider([]);
  const home = await spider.home({}, {});
  assert.equal(home.list.length, 0);
  const cat = await spider.category({ categoryId: "6", page: 1 }, {});
  assert.equal(cat.list.length, 0);
  const d = await spider.detail({ videoId: "1" }, {});
  assert.equal(d.list.length, 0);
  const s = await spider.search({ keyword: "x", page: 1 }, {});
  assert.equal(s.list.length, 0);
  const p = await spider.play({ playId: "" }, {});
  assert.equal(p.urls.length, 0);
});

test("非凡资源 非 JSON 响应会重试后降级", async () => {
  let calls = 0;
  const routes = [
    { match: (u) => /ac=class/.test(u), body: () => fixture("class.json") },
    {
      match: (u) => /ac=videolist/.test(u),
      body: () => { calls += 1; return calls === 1 ? "<html>502 Bad Gateway</html>" : fixture("videolist.json"); },
      encoding: "gzip",
    },
  ];
  const { spider } = loadSpider(routes);
  const home = await spider.home({}, {});
  assert.ok(calls >= 2, "首个非 JSON 响应应触发重试");
  assert.ok(home.list.length > 0, "重试后应拿到数据");
});
