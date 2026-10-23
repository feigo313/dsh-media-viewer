# Changelog

## 0.1.2 — 2026-10-23

- **强验证器**：ETag 去掉 `W/` 前缀——`If-Range` 按 RFC 9110 §13.1.5 只接受强实体标签。
- **manifest 契约测试**（7 个用例）：钉住 `dsh.client` 必须有 `exports["./client"]`、bundle patch 的 `name` 等于包名、`files` 里的每一项都存在、安装期不得有 `postinstall` / `prepare`、客户端 bundle 只能用 `require("react")`。0.1.0 的那个阻断 bug 现在会被测试直接拒绝。
- 测试总数 39（38 通过 + 1 个 Windows-only 跳过）。

## 0.1.1 — 2026-10-23

发布前的独立审计（三个子代理：安全/协议、对抗性测试、宿主集成）之后的硬化。0.1.0 从未发布到 npm。

### 修复

- **缺 `exports["./client"]`（阻断级）**：宿主 `dsh-client-modules` 对声明了 `dsh.client` 的包强制要求该导出，缺失会直接抛错、客户端半永不加载。补齐 `.` / `./client` / `./package.json` 三条。
- **可读任意文件**：加媒体扩展名白名单（其余一律 `415 unsupported-media`），拒绝控制字符与 Windows 网络/设备命名空间（UNC 目标会触发 NetNTLM 认证），并顺带挡住 NTFS 备用数据流（`clip.mp4:hidden`）。
- **文件被独占打开时无响应**：`openSync` 提前到 `writeHead` 之前，失败返回 500 JSON 信封，而不是让客户端拿到 ECONNRESET。
- **客户端中断泄漏文件描述符**：`res.on('close')` 销毁读流（原来依赖 `pipe` 的隐式清理，实测每次中断留一个句柄，GC 不回收）。
- **文件在传输中变短导致挂死**：短传时主动 `res.destroy()`，keep-alive 客户端不再等永远不会到的字节。
- **错误体泄露绝对路径**：错误消息只带错误码，路径写日志；只发相对名的调用方拿不到工作区根目录。
- **`Range` 语法过宽**：改用严格语法，`bytes=+2-3` / `bytes=0x2-3` / `bytes=1e1-` 一律忽略；`bytes=-0` 按 RFC 判 416。
- **405 缺 `Allow`**；连接围栏若抛错不再留下未应答的 socket（原来同时产生一个未处理的 rejection）。
- **空文件**改为 `200 + content-length: 0`（带 Range 则 `416 bytes */0`），删掉那条永不可达的 `is empty` 400。

### 改进

- 响应带 `ETag`（size+mtime）并遵守 `If-Range`：文件在播放中被重写时浏览器重取整份，不会把两个版本拼在一起。
- `cordis.patch.yml` 加双挂载守卫（聚合 bundle 已挂同名包时本行让位）。
- viewer id 命名空间化为 `dsh-av-preview:media`，避免与第三方抢 `media` 这个通用 id。
- 客户端 URL 改为按 `document.baseURI` 解析（反代目录前缀与桌面 `dsh-app://` 下都成立），不再用根绝对路径。
- `files` 带上 `test`；测试从 23 增至 32（31 通过 + 1 个 Windows-only 跳过）。

## 0.1.0 — 2026-10-23

首个版本，基于 [`zemul/dsh-video-preview@0.1.4`](https://github.com/zemul/dsh-video-preview)（MIT）重做。

### 新增

- **音频支持**：`mp3 / m4a / aac / wav / flac / oga / opus / weba / aiff / aif` 与视频共用一条路由与一个查看器（音频渲染 `<audio>`，视频渲染 `<video>`）。
