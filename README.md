# dsh-media-viewer

<h3 align="center">
<code>dsh-better-sidebar</code> 好用，唯一短板是播不了音视频——<br/>
这个仓库就是它的「插件中的插件」，只补这一件事。
</h3>

<p align="center"><i>A plugin-of-a-plugin: it adds the one thing <code>dsh-better-sidebar</code> cannot do — playing video and audio in the side card.</i></p>

<p align="center"><b>就是个小玩意，自用为主：不上插件市场，也不发 npm。</b>想用就 clone 本仓库，在 profile 里用 <code>file:</code> 指过来。</p>

点开侧栏里的 `.mp4` / `.mp3`，直接出播放器，能播、能拖时间轴；不用下载，也不用起本地服务。

---

## 它解决什么

侧栏自己没有媒体查看器：`.mp4` 会落进 `code` 兜底、被判成二进制，最后停在「此文件类型不支持预览 · 下载查看」；它自己的 `/sidebar/file` 对非图片一律回 `application/octet-stream`，也不支持 `Range`，浏览器于是既选不到 demuxer、也拖不动进度条。

这个插件用一个**独立包**补上这件事，而不是去改侧栏的源码：侧栏升级不会覆盖它。

## 怎么实现的（三行说清）

1. **host 半是空的**：`index.js` 只导出 `name` / `inject: []` / 空 `apply()`。不起路由、不读会话、不依赖 `webRuntime` 之类随宿主变化的服务。
2. **client 半只调一个公开 API**：
   ```js
   ctx.effect(() => ctx.betterSidebar.registerFileViewer({
     id: 'dsh-media-viewer:media',
     exts: [...26 种音视频容器],
     priority: 50,
     fetchStrategy: 'mediaUrl',     // 侧栏把路径解析好，交给我们一个 /sidebar/file URL
     component: MediaView,
   }))
   ```
3. **播放**：`fetch(mediaUrl)` → `Blob({ type: 'video/mp4' … })` → `<video>` / `<audio>`。因为字节进了内存，拖动时间轴不依赖服务端 `Range`；>256 MB 自动退化为直链播放；解不了码时给一句明确提示 + 「下载原文件」，不是一块黑屏。

## 安装

```powershell
# 复制到任意目录，然后把路径写进 profile
#   ~/.dsh/profiles/desktop/package.json
#     "dependencies": { "dsh-media-viewer": "file:G:/dsh-media-viewer" }
#     "dsh": { "profile": { "bundles": [ ... , "dsh-media-viewer" ] } }

cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

宿主半要**重启一次 App**；之后侧栏客户端会按内容哈希自动加载插件。

依赖：`dsh-better-sidebar`（提供 `betterSidebar` 服务）。没装侧栏时本插件不会激活，也不会报错。

## 支持的容器

- 视频：`mp4 m4v webm mov qt ogv mkv avi wmv flv mpeg mpg 3gp 3g2 m2ts`
- 音频：`mp3 m4a aac wav flac oga ogg opus weba aiff aif`

能不能解出画面取决于宿主 Electron 自带的 ffmpeg：H.264 / VP9 / AAC 正常；**`qtrle`（QuickTime Animation RLE，常见于带通道特效素材）、ProRes 等解不了**——外部播放器（QQ影音等）能播不代表侧栏能播，这类素材要先转码：

```powershell
# 保留透明通道，Chromium 可解
ffmpeg -i in.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 out.webm
# 或丢掉通道，最通用
ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4
```

## 边界与取舍

- 只做预览：不转码、不做缩略图、不做播放列表、不记忆播放进度。
- 不碰侧栏源码，也不改宿主；`/sidebar/file` 缺媒体 MIME 与 `Range` 这件事属于上游（见 [DSH-better-sidebar#1027](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1027)），本插件用 Blob 绕开它。
- 侧栏哪天改了 `registerFileViewer` 的签名，本插件要跟着改一次——这是所有伴生插件共同的义务。

## License

MIT，见 [LICENSE](LICENSE)。
