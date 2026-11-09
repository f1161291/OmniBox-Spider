const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "影视", "颜色", "WhosTV.js");
const source = fs.readFileSync(scriptPath, "utf8");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "whostv");

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
  }, { filename: "WhosTV.js" });

  return { spider: spiderModule.exports, cache, logs };
}

/**
 * 模拟双通道：
 * - 直连（whos.tv）默认返回 Cloudflare 挑战页
 * - reader 通道（r.jina.ai）返回渲染后的 HTML
 */
function makeRequest({ directWorks = false } = {}) {
  const requests = [];

  const request = async (url, options = {}) => {
    const currentUrl = String(url);
    requests.push({ url: currentUrl, headers: options.headers || {} });

    const isReader = currentUrl.indexOf("r.jina.ai") >= 0;
    if (isReader) {
      const realUrl = currentUrl.replace(/^https?:\/\/[^/]+\//, "");
      // 顺序敏感：/videos/page-N 必须先于 /videos/{code} 判定（page-2 也符合 code 形态）
      if (/\/ranking\/video/.test(realUrl)) {
        return { statusCode: 200, headers: {}, body: fixture("rank.html") };
      }
      if (/\/actresses\//.test(realUrl)) {
        return { statusCode: 200, headers: {}, body: fixture("actress.html") };
      }
      if (/\/videos\/page-\d+/.test(realUrl) || /\/videos(\?|$)/.test(realUrl)) {
        return { statusCode: 200, headers: {}, body: fixture("list.html") };
      }
      if (/\/videos\/[a-z0-9][a-z0-9._-]*$/i.test(realUrl)) {
        return { statusCode: 200, headers: {}, body: fixture("detail.html") };
      }
      return { statusCode: 404, headers: {}, body: "" };
    }

    if (directWorks) {
      if (/\/videos\/[a-z0-9][a-z0-9._-]*$/i.test(currentUrl)) {
        return { statusCode: 200, headers: {}, body: fixture("detail.html") };
      }
      if (/\/videos/.test(currentUrl)) {
        return { statusCode: 200, headers: {}, body: fixture("list.html") };
      }
    }
    return { statusCode: 403, headers: { "cf-mitigated": "challenge" }, body: fixture("challenge.html") };
  };

  return { request, requests };
}

test("WhosTV declares annotations and OM format", () => {
  assert.match(source, /\/\/ @name 🔞WhosTV/);
  assert.match(source, /\/\/ @version 2\.0\.1/);
  assert.match(source, /@downloadURL .*影视\/颜色\/WhosTV\.js/);
  assert.match(source, /module\.exports = \{ home, category, detail, search, play \}/);
  assert.match(source, /runner\.run\(module\.exports\)/);
  assert.doesNotMatch(source, /opt\.sites\.push/);
  assert.doesNotMatch(source, /app\.get\(meta\.api/);
});

test("WhosTV falls back to reader channel when Cloudflare challenges direct", async () => {
  const { request, requests } = makeRequest();
  const { spider, logs } = loadSpider(request);
  const result = await spider.home({}, {});

  assert.ok(result.list.length >= 10, `首页应有卡片，实际 ${result.list.length}`);
  assert.ok(requests.length >= 2, "应先试直连再回退 reader");
  assert.ok(requests[0].url.indexOf("whos.tv") >= 0, "首个请求应打向站点直连");
  assert.ok(requests.some((r) => r.url.indexOf("r.jina.ai") >= 0), "应走 reader 通道");
  assert.ok(
    requests.some((r) => String(r.headers["X-Return-Format"] || "") === "html"),
    "reader 应要求 HTML 而不是 markdown",
  );
  assert.ok(logs.some((l) => l.indexOf("Cloudflare") >= 0), "应记录被挑战");
});

test("WhosTV home parses cards with code/title/cover", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);
  const result = await spider.home({}, {});

  assert.ok(result.class.length >= 4);
  const first = result.list[0];
  assert.ok(first.vod_id, "应有 vod_id");
  assert.ok(/^[a-z0-9][a-z0-9._-]*$/i.test(first.vod_id), `vod_id 应是番号形态，实际 ${first.vod_id}`);
  assert.ok(first.vod_name.length > 2, "应有标题");
  assert.ok(
    first.vod_pic.startsWith("https://v.hersav.me/images/av/"),
    `封面应来自 v.hersav.me，实际 ${first.vod_pic}`,
  );
  assert.equal(result.list.map((i) => i.vod_id).indexOf("page-2"), -1, "不应混入分页链接");
});

test("WhosTV detail extracts stream url from source tag", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);
  const result = await spider.detail({ videoId: "rlmp-028" }, {});

  assert.equal(result.list.length, 1);
  const vod = result.list[0];
  assert.equal(vod.vod_play_sources[0].episodes.length, 1);
  const playId = vod.vod_play_sources[0].episodes[0].playId;
  const parts = playId.split("|");
  assert.equal(parts[0], "rlmp-028");
  assert.match(
    parts[1],
    /^https:\/\/v\.hersav\.me\/[a-f0-9]{32}\/[a-f0-9]{32}\.m3u8$/,
    `应解析出真实 m3u8，实际 ${parts[1]}`,
  );
  assert.ok(vod.vod_actor.includes("波多野結衣"), `应解析演员，实际 ${vod.vod_actor}`);
  assert.ok(vod.type_name.includes("潮吹"), `应解析标签，实际 ${vod.type_name}`);
});

test("WhosTV detail accepts full url as videoId", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);
  const result = await spider.detail({ videoId: "https://whos.tv/videos/rlmp-028" }, {});
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].vod_id, "rlmp-028");
});

test("WhosTV play returns direct HLS without extra page fetch", async () => {
  const { request, requests } = makeRequest();
  const { spider } = loadSpider(request);

  const stream = "https://v.hersav.me/abc123/abc123.m3u8";
  const result = await spider.play({ playId: `rlmp-028|${stream}` }, {});

  assert.equal(result.parse, 0);
  assert.equal(result.urls.length, 1);
  assert.equal(result.urls[0].url, stream);
  assert.equal(requests.length, 0, "playId 已带直链时不应再抓页面");
});

test("WhosTV play resolves stream by code when playId lacks url", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);

  const result = await spider.play({ playId: "rlmp-028" }, {});
  assert.equal(result.parse, 0);
  assert.match(result.urls[0].url, /\.m3u8$/);
});

test("WhosTV category supports sort, pagination and ranking", async () => {
  const { request, requests } = makeRequest();
  const { spider } = loadSpider(request);

  const popular = await spider.category({ categoryId: "sort:popular", page: 1 }, {});
  assert.ok(popular.list.length >= 10);
  assert.ok(requests.some((r) => r.url.indexOf("sort=popular") >= 0), "排序参数应进入 URL");

  const page2 = await spider.category({ categoryId: "sort:newest", page: 2 }, {});
  assert.ok(page2.list.length >= 10);
  assert.ok(requests.some((r) => /\/videos\/page-2/.test(r.url)), "分页应使用 /videos/page-N");

  const rank = await spider.category({ categoryId: "rank:video", page: 1 }, {});
  assert.ok(rank.list.length >= 10, `排行榜应有卡片，实际 ${rank.list.length}`);
  const withPic = rank.list.filter((item) => item.vod_pic.startsWith("https://v.hersav.me/"));
  assert.ok(withPic.length >= 5, `排行榜封面应解密成功，实际 ${withPic.length}/${rank.list.length}`);
});

test("WhosTV search handles code, actress and miss paths", async () => {
  const { request } = makeRequest();
  const { spider } = loadSpider(request);

  const byCode = await spider.search({ keyword: "rlmp-028" }, {});
  assert.equal(byCode.total, 1);
  assert.equal(byCode.list[0].vod_id, "rlmp-028");

  const byActress = await spider.search({ keyword: "波多野結衣" }, {});
  assert.ok(byActress.total >= 10, `演员搜索应有结果，实际 ${byActress.total}`);

  // 纯 ASCII 非番号关键词不会走演员页，走影片库本地匹配，应无结果
  const miss = await spider.search({ keyword: "zzzznotexist" }, {});
  assert.equal(miss.list.length, 0);
});

test("WhosTV targets video library, not the resource-share api", () => {
  assert.doesNotMatch(source, /\/api\/resources/);
  assert.match(source, /\/videos\/page-/);
});

test("WhosTV coolDecrypt recovers XOR-encoded cover", () => {
  assert.match(source, /function coolDecrypt/);
  const encoded = "4a56565251180d0d540c4a47505143540c4f470d4b4f434547510d43540d161215411641401a151615411114121741411716411b111a44434647121410160c48524522";
  const key = parseInt(encoded.slice(-2), 16);
  const body = encoded.slice(0, -2);
  let out = "";
  for (let i = 0; i + 1 < body.length; i += 2) {
    out += String.fromCharCode(parseInt(body.substr(i, 2), 16) ^ key);
  }
  assert.match(out, /^https:\/\/v\.hersav\.me\/images\/av\/[a-f0-9]{32}\.jpg$/);
});
