// OmniBox runner stdout 消毒模块（通用，可用于任意 JS 爬虫源）
//
// 问题：Go 宿主通过 node 子进程的 stdout 读取 handler 返回的 JSON 对象；
// 但部分宿主版本的 omnibox_sdk.log 会把日志以 JSON.stringify(字符串) 写进
// 同一个 stdout，部分脚本的 console.log / fallback logger 也会写纯文本日志。
// Go 侧先读到字符串就报：
//   json: cannot unmarshal string into Go value of type models.SpiderSearchResponse
//   json: cannot unmarshal string into Go value of type map[string]interface {}
//
// 用法 A（推荐，一次覆盖全部源，无需改动任何脚本）：
//   把本文件放到容器内固定路径，例如 /app/data/omnibox-stdout-guard.js，
//   在 OmniBox 容器环境变量里加：
//     NODE_OPTIONS=--require /app/data/omnibox-stdout-guard.js
//   然后重启容器。
//
// 用法 B（容器 env 不便调整时）：用 inject-omnibox-stdout-guard.py 把本文件
//   内容注入到每个 spiders/*/index.js 顶部，脚本加载时自动生效。
//
// 规则：
//   - 完整 JSON 且为 string/number/boolean/null  -> 改走 stderr（SDK 日志）
//   - 纯文本日志行                              -> 改走 stderr
//   - 完整 JSON 且为 object/array               -> 放行（runner 响应）
//   - 以 { 或 JSON 数组开头但尚未完整           -> 进入透传状态，后续分片全部放行，
//     直到能 JSON.parse 成功，避免截断多行/分片响应
//
// 幂等：通过 process.stdout.__omniStdoutGuard 标记避免重复劫持。

(function () {
  if (typeof process === "undefined" || !process.stdout || process.stdout.__omniStdoutGuard) return;
  process.stdout.__omniStdoutGuard = true;

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const state = { inJson: false, pending: "" };

  function toStderr(chunk, encoding, cb) {
    try { return origErr(chunk, encoding, cb); } catch (_) { return true; }
  }
  function parseOk(text) {
    try { JSON.parse(text); return true; } catch (_) { return false; }
  }
  function looksLikeJsonStart(text) {
    return /^\{/.test(text) || /^\[\s*(?:\{|\[|"|-?\d|true|false|null|\])/.test(text);
  }

  process.stdout.write = function (chunk, encoding, cb) {
    let text;
    try { text = String(chunk == null ? "" : chunk); } catch (_) { return origOut(chunk, encoding, cb); }

    // 正在透传一个分块/多行 JSON 响应：后续分片一律放行，直到整体可解析。
    if (state.inJson) {
      state.pending += text;
      if (parseOk(state.pending.trim())) { state.pending = ""; state.inJson = false; }
      return origOut(chunk, encoding, cb);
    }

    const trimmed = text.trim();
    if (!trimmed) return origOut(chunk, encoding, cb);

    let parsed;
    let complete = false;
    try { parsed = JSON.parse(trimmed); complete = true; } catch (_) {}

    if (complete) {
      // SDK.log 常写 JSON 字符串；对象/数组是 runner 的响应，必须放行。
      if (parsed === null || ["string", "number", "boolean"].includes(typeof parsed)) {
        return toStderr(chunk, encoding, cb);
      }
      return origOut(chunk, encoding, cb);
    }

    if (looksLikeJsonStart(trimmed)) {
      // runner 可能把 JSON 对象分成多个 write；进入透传状态。
      state.inJson = true;
      state.pending = text;
      return origOut(chunk, encoding, cb);
    }

    // 其余纯文本一律视为日志（console.log / fallback logger），改走 stderr。
    return toStderr(chunk, encoding, cb);
  };
})();
