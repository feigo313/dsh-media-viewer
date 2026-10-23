# dsh-av-preview

给 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的**内联音视频预览**插件：侧边栏打开 `.mp4` / `.mp3` 时直接出一个能播、能拖时间轴的播放器，而不是「此文件类型不支持预览 · 下载查看」。

## 它解决什么

侧边栏本身没有媒体查看器，`.mp4` 会落进 `code` 兜底、被当成二进制，最后停在下载面板；它自己的 `/sidebar/file` 路由对所有非图片一律回 `application/octet-stream`，也不支持 `Range`——浏览器因此选不到 demuxer、也拖不动进度条。

本插件补两块：

- **`/media` 宿主路由**：按扩展名给正确 `Content-Type`，支持 `Range`（206 / `content-range` / 后缀区间 / 越界 416）、`HEAD`、`accept-ranges`；流式 `createReadStream`，不把整份文件读进内存。
- **一个文件查看器**：通过 `ctx.betterSidebar.registerFileViewer` 注册（`id: media`，16 种视频容器 + 10 种音频容器），视频走 `<video>`、音频走 `<audio>`，`preload="metadata"` 不预下整片；解码失败给可见提示，并常驻「下载原文件」。

## 安装

```bash
cd ~/.dsh && dsh plugin --profile web add dsh-av-preview
```

桌面版（profile 由 Electron 管理，CLI 会拒绝）改 profile 的 `package.json` 后装：

```bash
# ~/.dsh/profiles/desktop/package.json
#   dependencies: "dsh-av-preview": "^0.1.0"
#   dsh.profile.bundles: 追加 "dsh-av-preview"
cd ~/.dsh/profiles/desktop
pnpm install
```

宿主代码要**重启一次 App** 才加载；客户端 bundle 由 `dsh-client-hmr` 轮询自动热更新。

## 与上游 `dsh-video-preview` 的关系

本项目的起点是 [`zemul/dsh-video-preview@0.1.4`](https://github.com/zemul/dsh-video-preview)（MIT）。它 2026-08-27 之后没有再更新，因此在 DSH 0.2.x 上**无法挂载**：

| 上游问题 | 本项目的处理 |
|---|---|
| `inject` 依赖已被移除的 `webRuntime` 服务 → 插件永远 `pending` | 改用 `['webServer','sessions','connection']`，准入走 `ctx.connection.requestRejection(req)` |
| `dsh.client.inject` 指向不存在的 `@deepseek-ai/dsh-client-runtime` | 置空（bundle 只用 react，无自有依赖） |
| 相对路径直接 400：从聊天卡片打开的视频播不了（上游 issue #3 / #4） | 按会话 cwd 解析相对路径，`~` 展开到 home |
| 工作区之外的文件 403，播放器黑屏无提示（上游 issue #5） | 与侧边栏自己的路由一致——绝对路径不做包含性围栏；失败时给可见提示 |
| 200 响应被剥 `content-length` 导致 `seekable=[0,0]`（上游 issue #6） | 路由始终 `accept-ranges`，浏览器首个 `bytes=0-` 请求即得 206 + `content-range` |
| 只有视频 | 同一路由 + 同一查看器覆盖音频容器 |

## 安全

- 请求先过宿主连接围栏 `ctx.connection.requestRejection(req)`（与 `/api` 网关同一判定）。
- 路径解析与侧边栏自己的路由**同语义**：相对路径按会话 cwd 解析，`~` 展开，绝对路径原样——**不做包含性限制**。这是刻意的：侧边栏的 `ensureWorkspacePath` 本身就是纯解析（它的包含策略已废弃），预览路由若自己加围栏，用户就会看到"黑屏但不知道为什么"。仅接受 `GET` / `HEAD`。
- 不引入任何第三方依赖；不读环境变量里的凭据。

## 开发与测试

```bash
node --test        # 23 个用例：路由（真 node:http 服务器）/ Range 解析 / 路径解析 / 客户端注册
```

两个文件就是全部实现：`index.js`（宿主路由）、`client.js`（浏览器 bundle，官方 `window.__ModuleLoader__.load` 形状，零构建）。

## License

MIT，见 [LICENSE](LICENSE)。上游版权与衍生说明都写在该文件里。
