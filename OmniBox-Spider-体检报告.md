# OmniBox-Spider 仓库脚本体检报告

- 仓库：https://github.com/f1161291/OmniBox-Spider
- 检查时间：2026-11-17
- 检查范围：207 个 spider 源脚本（影视/动漫/导航/直播/短剧/综合），另 14 个 tests/tools 脚本未计入可用性判定
- 检查方法：`node --check` 语法 → mock 宿主实际加载 → 五函数契约 → 依赖声明匹配 → 目标站点 DNS+TCP 连通性（不请求内容）

## 一、结论速览

| 层级 | 结果 | 说明 |
|---|---|---|
| 语法错误 | 0 个 | 221 个 JS 全部 `node --check` 通过 |
| 加载期崩溃（mock 宿主） | 0 个 | 所有脚本都能被 require 加载并完成模块初始化 |
| 结构契约缺陷 | 0 个 | 3 个"五函数不全"经核实是设计如此（导航源只需 home/category；虎牙直播用 detail 代替 search） |
| 依赖缺失导致报错 | 0 个 | Gimy剧迷的 opencc 系列均包在 try/catch 里做可选降级 |
| stdout 污染隐患 | 0 个 | 9 个含 console.log 的脚本，日志全部在 SDK 调用失败的 catch fallback 里，真实宿主不触发 |
| **目标站点不可达** | **47 个脚本** | 这是当前唯一确认的"报错误/用不了"来源 |
| 仓库自带测试 | 53/53 通过 | `node --test tests/*.test.js` 全绿 |

**一句话结论：脚本代码本身没有会报错的——语法、加载、结构、依赖、stdout 全部干净。真正的问题在目标站点：47 个脚本的站点已不可达，其中 6 个是硬编码死域名（基本可判失效），41 个支持环境变量覆盖（换 API 地址即可救活）。**

## 二、分类清单

### A 类：基本可判失效（站点地址硬编码 + 域名不可达）—— 6 个

这类脚本的站点写死在代码里且当前不可达，需要换源或废弃。

| 脚本 | 站点域名 | 症状 |
|---|---|---|
| 影视/采集/Gimy剧迷.js | play.gimyai.tw | DNS 解析失败 |
| 影视/采集/StreamingCommunity.js | streamingcommunityz.pink | DNS 解析失败 |
| 影视/采集/两个BT.js | www.bttwoo.com | 端口关闭 |
| 影视/采集/乌云影视.js | wooyun.tv | 端口关闭 |
| 影视/采集/威尔伯TV.js | wei2bo.com | 端口关闭 |
| 影视/采集/韩小圈.js | hanxiaoquan.hanju.workers.dev | 端口关闭 |

### B 类：默认站点不可达但支持环境变量覆盖 —— 41 个

这类脚本写的是 `SITE_API || "默认地址"`，只要在 OmniBox 后台把 `SITE_API`（或对应 `XXX_HOST`）指向新地址即可救活。**脚本本身没问题，只是默认地址过期。**

| 脚本 | 默认站点 | 症状 |
|---|---|---|
| 动漫/嗷呜动漫.js | www.aowu.tv | DNS 失败 |
| 影视/网盘/玩偶.js | wogg.xxooo.cf | DNS 失败 |
| 影视/网盘/至臻.js | www.miqk.cc | 端口关闭 |
| 影视/网盘/蜡笔.js | feimo.fun | DNS 失败 |
| 影视/采集/-奥斯卡-.js | aosikazy.com | DNS 失败 |
| 影视/采集/4KVM.js | www.4kvm.org | 端口关闭 |
| 影视/采集/iKun资源.js | ikunzyapi.com | DNS 失败 |
| 影视/采集/jkun资源.js | jkunzyapi.com | DNS 失败 |
| 影视/采集/souavZY.js | api.souavzyw.net | DNS 失败 |
| 影视/采集/唐人街影院.js | www.trvod.com | 端口关闭 |
| 影视/采集/布布影视.js | bubuzhuiju.com | 端口关闭 |
| 影视/采集/布布影视2.js | bbys.app | 端口关闭 |
| 影视/采集/旺旺资源.js | api.wwzy.tv | 端口关闭 |
| 影视/采集/桃花资源.js | thzy1.me | DNS 失败 |
| 影视/采集/独播库.js | w.duboku.io | DNS 失败 |
| 影视/采集/百万资源.js | api.bwzyz.com | DNS 失败 |
| 影视/采集/百度云zy.js | pz.168188.dpdns.org | DNS 失败 |
| 影视/采集/艾旦影视.js | pz.168188.dpdns.org | DNS 失败 |
| 影视/采集/豪华资源.js | pz.168188.dpdns.org | DNS 失败 |
| 影视/采集/这片海.js | www.zhepianhai.com | DNS 失败 |
| 影视/颜色/3Movs.js | www.3movs.com | 端口关闭 |
| 影视/颜色/91PORNY.js | 91porny.com | 端口关闭 ※ |
| 影视/颜色/91Porn.js | 91porn.com | 端口关闭 ※ |
| 影视/颜色/91成人短剧.js | 91crdjai.com | DNS 失败 |
| 影视/颜色/AV01.js | www.av01.media | 端口关闭 ※ |
| 影视/颜色/GCAV.js | gcav.me | 端口关闭 ※ |
| 影视/颜色/PornTrex.js | www.porntrex.com | 端口关闭 ※ |
| 影视/颜色/WhosTV.js | whos.tv | 端口关闭 ※ |
| 影视/颜色/XHamster.js | xhamster.com | 端口关闭 ※ |
| 影视/颜色/XNXX.js | www.xnxx.com | 端口关闭 ※ |
| 影视/颜色/丝袜资源.js | siwazyw.tv | DNS 失败 |
| 影视/颜色/小鸡资源.js | api.xiaojizy.live | DNS 失败 |
| 影视/颜色/每日大赛.js | www.mrds66.com | DNS 失败 |
| 影视/颜色/色猫资源.js | caiji.semaozy.net | DNS 失败 |
| 影视/颜色/辣椒资源.js | pz.168188.dpdns.org | DNS 失败 |
| 影视/颜色/香蕉资源.js | www.xiangjiaozyw.com | DNS 失败 |
| 影视/颜色/麻豆社.js | madou.club | 端口关闭 ※ |
| 影视/颜色/黄色仓库.js | hsckzy.xyz | DNS 失败 |
| 短剧/511短剧.js | 511dj.com | DNS 失败 |
| 短剧/嘟嘟短剧.js | api-v2.cenguigui.cn | DNS 失败 |
| 短剧/黄果短剧.js | huangguoai.com | 端口关闭 ※ |

※ 标注的多为境外成人站，"端口关闭"很可能是**本地网络封锁**而非站点下线，在你的 NAS 环境（网络条件不同）可能仍可访问，建议实地复测再决定。

### C 类：默认可达 / 本地探针未判死 —— 其余约 160 个

代码层面全部干净，目标站点 TCP 443/80 可达。这类在正常宿主环境下应可直接使用。注意：本检查只做到 TCP 连通性，**未验证站点 API 结构是否改版**（例如返回字段变化导致解析为空），最终以实际点播为准。

### 特别说明：你关注的两个脚本

- **影视/颜色/AV01.js**：代码健康（依赖声明 cheerio 正确、五函数齐全、清晰度降序逻辑在），但默认域名 `www.av01.media` 从当前网络探测端口关闭，且标注 ※（可能是网络封锁）。建议在 NAS 上实测。
- **短剧/红果短剧.js**：代码健康，依赖本地 10008 解密代理链路。其默认域名未进入不可达清单，但需确认你的 `--hg-stream` 流服务进程和 10008 代理已启动，否则播放环节会失败。

## 三、误报排除记录（避免误改）

| 初筛命中 | 结论 | 依据 |
|---|---|---|
| 导航/豆瓣.js、豆瓣推荐.js 只有 2 个函数 | 非缺陷 | 导航源设计上只需 home/category |
| 直播/虎牙直播.js 缺 search | 非缺陷 | 直播源用 detail，无需 search |
| Gimy剧迷 用了未声明的 opencc | 非缺陷 | 4 处 require 全在 try/catch 里可选降级 |
| 9 个脚本有 console.log 无 stdout guard | 非缺陷 | 日志全在 SDK require 失败的 catch fallback 里，真实宿主有 SDK 不触发 |
| 枝枝影视、歪比巴卜 无 @dependencies 行 | 需留意但非必错 | 顶层 require axios/crypto-js；若宿主未预装这两个包会加载失败（本环境 mock 通过）。部署前确认宿主依赖 |

## 四、建议动作

1. **优先处理 A 类 6 个**：换源或下架，避免用户点开报空。
2. **B 类 41 个**：给每个源在 OmniBox 后台配 `SITE_API` 指向新地址；`pz.168188.dpdns.org` 一个域名挂了 4 个源，换了能一次救 4 个。
3. **境外成人站（※）**：在你的 NAS 环境实地复测，别按本地结果判死。
4. **dependency 提示**：确认 OmniBox 宿主预装 axios / crypto-js，以免影响枝枝影视、歪比巴卜等顶层 require 的脚本。
5. **不要动代码**：本仓库脚本代码质量整体很好，无需为"报错"改脚本——问题都在站点侧和配置侧。

## 五、检查局限

- 连通性为 DNS + TCP 层，未做 HTTP 请求，不能证明 API 返回结构仍有效。
- 探测在网络出口 A 执行；成人站/被墙站的"端口关闭"可能随网络环境变化。
- 依赖加载用 mock 宿主，真实宿主若缺少 axios/crypto-js 等包，顶层 require 的脚本会失败（已在依赖提示中标注）。
