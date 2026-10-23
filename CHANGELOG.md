# Changelog

## 0.1.0 — 2026-10-23

首个版本，基于 [`zemul/dsh-video-preview@0.1.4`](https://github.com/zemul/dsh-video-preview)（MIT）重做。

### 新增

- **音频支持**：`mp3 / m4a / aac / wav / flac / oga / opus / weba / aiff / aif` 与视频共用一条路由与一个查看器（音频渲染 `<audio>`，视频渲染 `<video>`）。
- **失败可见**：解码失败或宿主拒绝读取时给一句明确提示 + 常驻「下载原文件」，不再是一块黑屏。
- **`HEAD` 支持**与 `cache-control: no-store`（预览的常常是 agent 刚写出的文件，不能让缓存挡住）。

### 修复（对照上游仓库的 open issues）

- `webRuntime` 服务已被 DSH 0.2.x 移除，插件永远 `pending`（上游 #6）→ `inject` 改为 `['webServer','sessions','connection']`，准入走 `ctx.connection.requestRejection(req)`。
- `dsh.client.inject` 指向不存在的 `@deepseek-ai/dsh-client-runtime` → 置空。
- 相对路径被拒（上游 #3 / #4）→ 按会话 cwd 解析，`~` 展开；从聊天卡片打开的视频可直接播。
- 工作区外文件 403 且黑屏（上游 #5）→ 与侧边栏自己的路由同语义（绝对路径不做包含性围栏），失败给可见提示。
- 200 响应丢 `content-length` 导致不可 seek（上游 #6 后半）→ 始终 `accept-ranges`，`bytes=0-` 即 206 + `content-range`。

### 其它

- 路由从 `/video` 改名 `/media`（覆盖音视频两类容器）。
- 主题令牌化：播放器的托底背景用 `var(--dsw-alias-bg-base)`，不再是写死的 `#000`。
- 23 个 `node --test` 用例（真 `node:http` 服务器驱动的 Range / 路径 / 错误 / 围栏用例）。
