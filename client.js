/*!
 * dsh-media-viewer — client half.
 *
 * Registers ONE file viewer with dsh-better-sidebar (its public service), so
 * .mp4 / .mp3 opened in the side card render a real player instead of the
 * "cannot be previewed" pane.
 *
 * Same playback logic as the in-place patch that already works on this machine:
 * the sidebar hands us `mediaUrl` (/sidebar/file?...), we fetch those bytes and
 * play them from a Blob — no dependency on that route's Content-Type or on
 * HTTP Range, and nothing of ours needs to survive a sidebar upgrade because
 * this file belongs to its own package.
 *
 * priority 50 outranks the in-place patch's viewer (20), so while both exist
 * this one wins; if this package ever fails to load, the patch still plays.
 */
window.__ModuleLoader__.load({
  id: "dsh-media-viewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");

    var VIDEO_EXTS = [
      "mp4", "m4v", "webm", "mov", "qt", "ogv", "mkv", "avi",
      "wmv", "flv", "mpeg", "mpg", "3gp", "3g2", "m2ts"
    ];
    var AUDIO_EXTS = [
      "mp3", "m4a", "aac", "wav", "flac", "oga", "opus", "weba", "aiff", "aif", "ogg"
    ];

    var MIME = {
      mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
      qt: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska", avi: "video/x-msvideo",
      wmv: "video/x-ms-wmv", flv: "video/x-flv", mpeg: "video/mpeg", mpg: "video/mpeg",
      "3gp": "video/3gpp", "3g2": "video/3gpp2", m2ts: "video/mp2t",
      mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
      flac: "audio/flac", oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
      weba: "audio/webm", aiff: "audio/aiff", aif: "audio/aiff"
    };

    /** Above this, copy-free streaming beats a Blob (memory). */
    var MAX_BLOB = 256 * 1024 * 1024;

    function extOf(path) {
      var m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
      return m === null ? "" : m[1].toLowerCase();
    }
    function isAudio(path) { return AUDIO_EXTS.indexOf(extOf(path)) !== -1; }
    function mimeOf(path) { return MIME[extOf(path)] || "application/octet-stream"; }
    function downloadOf(mediaUrl) {
      if (typeof mediaUrl !== "string" || mediaUrl === "") return "";
      return mediaUrl + (mediaUrl.indexOf("?") === -1 ? "?" : "&") + "download=1";
    }

    /** The player pane: <video> for pictures, <audio> when sound is the whole point. */
    function MediaView(props) {
      var mediaUrl = props.mediaUrl;
      var audio = isAudio(props.path);
      var state = react.useState(null);
      var src = state[0], setSrc = state[1];
      var failState = react.useState(false);
      var failed = failState[0], setFailed = failState[1];

      react.useEffect(function () {
        if (typeof mediaUrl !== "string" || mediaUrl === "") { setFailed(true); return; }
        var cancelled = false;
        var objectUrl = null;
        fetch(mediaUrl)
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            var declared = Number(response.headers.get("content-length") || 0);
            if (declared > MAX_BLOB) return mediaUrl;
            return response.arrayBuffer().then(function (buffer) {
              objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeOf(props.path) }));
              return objectUrl;
            });
          })
          .then(function (next) { if (!cancelled && next) setSrc(next); })
          .catch(function () { if (!cancelled) setFailed(true); });
        return function () {
          cancelled = true;
          if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        };
      }, [mediaUrl]);

      var media = audio
        ? react.createElement("audio", {
            key: "media", src: src || undefined, controls: true, preload: "metadata",
            style: { width: "100%", margin: "auto 0" },
            onError: function () { setFailed(true); }
          })
        : react.createElement("video", {
            key: "media", src: src || undefined, controls: true, preload: "metadata", playsInline: true,
            style: {
              flex: "1 1 auto", minHeight: "0", width: "100%", objectFit: "contain",
              borderRadius: "6px", background: "var(--dsw-alias-bg-base)"
            },
            onError: function () { setFailed(true); }
          });

      var notice = react.createElement("div", {
        key: "notice",
        style: {
          flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center",
          padding: "24px 16px", textAlign: "center", fontSize: "12px", lineHeight: "1.6",
          color: "var(--dsw-alias-label-tertiary)"
        }
      }, "无法播放这个文件：编码不受支持，或读取失败。可以先下载到本地播放器打开。");

      return react.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", gap: "10px", padding: "12px",
          minWidth: "0", minHeight: "0", height: "100%", boxSizing: "border-box"
        }
      }, [
        failed ? notice : media,
        react.createElement("div", {
          key: "meta",
          style: { flex: "none", display: "flex", gap: "10px", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" }
        }, [
          react.createElement("a", {
            key: "download", href: downloadOf(mediaUrl), download: true,
            style: { color: "inherit", textDecoration: "underline" }
          }, "下载原文件")
        ])
      ]);
    }

    /** Cordis service dependency: the sidebar's file-viewer registry. */
    var inject = ["betterSidebar"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.betterSidebar.registerFileViewer({
          id: "dsh-media-viewer:media",
          title: "视频 / 音频",
          exts: VIDEO_EXTS.concat(AUDIO_EXTS),
          // 50 > the in-place patch's 20, so this viewer wins while both exist.
          priority: 50,
          // The sidebar resolves the path and hands us a media URL; we read the
          // bytes ourselves (Blob), like the patch does.
          fetchStrategy: "mediaUrl",
          component: MediaView
        });
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});
