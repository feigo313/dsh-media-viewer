# dsh-av-preview

**给 DSH 侧边栏的内联音视频预览**：在 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的侧栏里打开 `.mp4` / `.mkv` / `.mp3` / `.flac`，直接出播放器——能播、能拖时间轴、不必先下载。

> Inline video/audio preview for the DSH side card. One HTTP `Range` route, one file viewer, zero dependencies.

---

## 为什么需要它

侧边栏本身没有媒体查看器：`.mp4` 会落进 `code` 兜底、被判成二进制，最后停在「此文件类型不支持预览 · 下载查看」。而它自己的 `/sidebar/file` 路由对所有非图片一律回 `application/octet-stream`，也不支持 `Range`——浏览器因此选不到 demuxer、也拖不动进度条。

两条缺口各补一块：

| 缺口 | 本项目的处理 |
|---|---|
| 没有媒体查看器 | 通过 `ctx.betterSidebar.registerFileViewer` 注册 `media` 查看器：16 种视频容器 + 10 种音频容器；视频 `<video>`、音频 `<audio>`，`preload="metadata"` 不预下整片 |
| 路由类型盲 + 无 Range | 自带 `/media` 路由：正确 `Content-Type`、`Range`（206 / `content-range` / 后缀区间 / 越界 416）、`HEAD`、`accept-ranges`，`createReadStream` 流式不缓冲 |

## 安装

DSH Web profile（官方 CLI）：

```bash
cd ~/.dsh && dsh plugin --profile web add dsh-av-preview
```

桌面版（profile 由 Electron 独占管理，CLI 会拒绝）改 profile 清单后安装：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-av-preview": "^0.1.0" },
"dsh": { "profile": { "bundles": [ /* …追加 */ "dsh-av-preview" ] } }
```

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

宿主半要**重启一次 App**；客户端 bundle 由 `dsh-client-hmr` 轮询自动热更新。

也可以直接从 GitHub 安装（不经过 npm）：

```bash
dsh plugin --profile web add https://github.com/feigo313/dsh-av-preview.git
```

## 行为约定

- **只服务媒体**：扩展名白名单（16 视频 + 10 音频）之外一律 `415 unsupported-media`。这条是安全边界——路由可以读绝对路径，但只允许读媒体文件，不做通用本地文件读取（顺带挡掉 NTFS 备用数据流）。
- **路径**：相对路径按会话工作目录解析，`~` 展开到 home，绝对路径原样——**不做包含性限制**，与侧边栏自己的文件路由同语义（它的包含策略已废弃）；越界只由上面的白名单限定。Windows 的网络/设备命名空间（`\\host\share`、`\\?\`、`\\.\`）与控制字符直接拒绝；未知会话且没有 cwd 线索时回 `404 unknown-session`。
- **准入**：请求先过宿主连接围栏 `ctx.connection.requestRejection(req)`，与 `/api` 网关同一判定；只接受 `GET` / `HEAD`（`405` 带 `Allow`）。
- **一致性**：响应带 `ETag`（size+mtime）并遵守 `If-Range`——文件在播放中被重写时，浏览器会重新取整份而不是把两个版本拼在一起。
- **失败**：容器解不了、文件打不开时，面板给一句明确提示 + 常驻「下载原文件」，不再是一块黑。错误体**不回显绝对路径**（避免把工作区根目录泄露给只知道相对名的调用方）。
- **缓存**：`cache-control: no-store`——预览的常常是 agent 刚写出的文件。
- **空文件 / 缩短**：0 字节按 `200 + content-length: 0`（带 Range 则 `416 bytes */0`）；流到一半文件被截断时主动断开连接，不让 keep-alive 客户端干等。

## 开发与测试

```bash
node --test     # 32 个用例（31 通过 + 1 个 Windows-only 跳过）：真 node:http 服务器驱动的
                # Range/路径/白名单/ETag/错误/围栏/中断用例 + 客户端注册与渲染树
```

实现只有两个文件，零构建、零依赖：`index.js`（宿主路由）、`client.js`（浏览器 bundle，官方 `window.__ModuleLoader__.load` 形状）。

## 已知边界

- 能播哪些编码取决于宿主 Electron 自带的 ffmpeg（H.264/AAC 正常；MKV 里的 HEVC 等看宿主编译选项）。解不了会走上面的失败提示，不会静默。
- 相对路径按 `session.header.cwd` 解析，**不跟随活跃 worktree 根**（侧边栏自己会先取 `activeWorktreeRootOf`）。文件树/聊天传的都是绝对路径，所以正常路径不受影响。
- 只做预览，不做转码、不做缩略图、不做播放列表。

## 致谢与许可

MIT，见 [LICENSE](LICENSE)。项目的起点是 [`zemul/dsh-video-preview`](https://github.com/zemul/dsh-video-preview)（2026-08 后未再更新，其 `inject` 的 `webRuntime` 在 DSH 0.2.x 已被移除）；本仓库在其基础上重写了宿主路由与查看器，并补齐音频、路径解析与失败提示。上游版权在 LICENSE 中保留。
