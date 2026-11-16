# 红果 App v5 播放签名（JS 移植，验证中）

从 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) `kotlin-tv/` 的 v04.10.03
签名实现移植（`SIGNING_V5.md` / `V5Constants.kt` / `Signer.kt` / `AesV3.kt`，
均为 GPL-3.0-only）。

## 背景

红果 `multi_video_model/player/v1` 播放接口自 2026-11 起拒绝旧 v3 签名，
表现为 **HTTP 200 + content-length 0（EMPTY_RESPONSE）**。
v3 的 Argus/Ladon/Medusa 全部失效，必须升级到 v5：

| 项 | v3（旧，红果短剧.js 在用） | v5（本项目） |
|---|---|---|
| 版本串 | `v04.06.04` | `v04.10.03` |
| license | `1588093228` / `1611921764` | `646637794` |
| magic | `f7e85ffad7d7dc3...` | `2d4b4fca49750d43...` |
| hashF13 seed | 六选一 | 固定 `0x9d4a97c2` |
| hashF13 轮次 | 分支表 | `[96,1,3,4,0,6,5,2,0,7,7]` |
| 末校验位 | 无 | OR `0x20` |
| AesV3 | 旧 sbox | 新 sbox + 新 con/order/initial |
| 请求头 | x-argus/x-ladon/x-gorgon/x-helios/x-medusa | **仅** x-khronos/x-helios/x-medusa |
| branch | iv&15 % 3 == 0 | iv&15 == 12 |

## 文件

- `sign.js` — 基础模块：hashF13-v5、AesV3-v5、sm3、工具函数、v5 常量
- `playback.js` — 完整签名：signPlayback / medusaV5 / helios / branch
- `test-f13.js` — hashF13 对拍（官方 32 个测试向量）
- `test-carrier.js` — AesV3-v5 对拍（官方 4 个测试向量）
- `signing-v5-f13.json` / `signing-v5-carrier.json` — 官方测试向量（来自上游仓库）
- `hashtable.txt` / `v5sbox.txt` — v5 常量表（来自 V5Constants.kt）

## 验证状态

**已验证（官方向量对拍，100% 一致）：**
```
node test-f13.js      → pass=32 fail=0 / 32
node test-carrier.js  → pass=4  fail=0 / 4
```

**未完全验证：**
- `medusaV5` 的字节级编码（protobuf 字段顺序/xmxor/AES 链）无官方测试向量可直接对拍；
  Kotlin 侧对拍是自比对（`signer.medusa(...) == request.headers["x-medusa"]`），
  没有外部独立 oracle。
- 实测（含新注册匿名设备 + 强制 IPv4）在当前出口环境播放接口仍返回 HTTP 200 空体。
  响应头显示 `origin; dur=61` / 有 `x-tt-logid` / `cdn-cache: MISS`，
  即请求到达源站后被业务层拒绝，非网络层拦截。

## 结论与后续

本模块的核心算法（f13 / carrier）已按官方向量验证正确，但 medusa 封装层
与服务端实际验收未能通过。**不要直接把 `playback.js` 接到生产脚本的播放链路**，
除非先在可直接访问红果 App 接口的网络环境下确认能拿到 video_model。

后续方向：
1. 找到 medusa 的独立测试向量（上游 `signing-v5-*` 只覆盖 f13 / carrier），
   或用 Android TV 模拟器跑上游 `LivePlaybackInstrumentation` 抓取真实 envelope 对拍。
2. 确认请求参数：v5 是否需要 `dr_scene=player`、特定的 `channel`/`version_code`
   （上游 v5 用 `7.4.1.10`，可能与本模块测试时用的值不同）。
3. 排查 `processNonce` / `processStarted` 是否需要跨请求保持稳定（进程级随机一次）。

## 授权

移植代码遵循上游 GPL-3.0-only / 相关声明，常量表来自上游仓库公开文件，
未包含任何账号凭据或捕获的会话。
