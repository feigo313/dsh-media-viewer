/*!
 * dsh-av-preview — client half (browser bundle).
 *
 * Registers ONE file viewer with `dsh-better-sidebar` through its public
 * service (`ctx.betterSidebar.registerFileViewer`), so a `.mp4` / `.mp3` opened
 * in the side card renders a real player instead of falling through the `code`
 * catch-all to the "download to view" pane.
 *
 * Bundle shape: the official DSH client-bundle wrapper — a lazy-CJS factory
 * registered with `window.__ModuleLoader__.load({ id, factory })`. `react` is
 * an external resolved from the shell's module table at runtime; nothing else
 * is imported, so the bundle carries no dependency of its own.
 *
 * The `<video>` / `<audio>` element streams the plugin's own `/media` host
 * route (HTTP Range → seeking works, `preload="metadata"` → no full download).
 * A container the bundled ffmpeg cannot decode, or a path the host refuses,
 * ends in a readable notice plus the sidebar's own download link instead of a
 * silent black box.
 */
window.__ModuleLoader__.load({
  id: "dsh-av-preview",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");

    /** Video containers this viewer claims. */
    var VIDEO_EXTS = [
      "mp4", "m4v", "webm", "mov", "qt", "ogv", "ogg", "mkv", "avi",
      "wmv", "flv", "mpeg", "mpg", "3gp", "3g2", "m2ts"
    ];

    /** Audio containers: same transport, no stage. */
    var AUDIO_EXTS = [
      "mp3", "m4a", "aac", "wav", "flac", "oga", "opus", "weba", "aiff", "aif"
    ];

    /** The plugin's range-capable media route for one file. */
    function mediaUrl(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return "/media?" + params.toString();
    }

    /** The sidebar's raw-byte route, forced into a download. */
    function downloadUrl(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      params.set("download", "1");
      return "/sidebar/file?" + params.toString();
    }

    function extOf(path) {
      var match = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
      return match === null ? "" : match[1].toLowerCase();
    }

    function isAudioPath(path) {
      return AUDIO_EXTS.indexOf(extOf(path)) !== -1;
    }

    /** Outline glyph (16px, 1.5px stroke, currentColor): a screen + play mark. */
    function IconMediaOutline16(size) {
      var s = size || 16;
      return react.createElement("svg", {
        width: s,
        height: s,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
        focusable: "false"
      }, [
        react.createElement("rect", {
          key: "frame",
          x: "1.75",
          y: "3.25",
          width: "12.5",
          height: "9.5",
          rx: "1.75",
          stroke: "currentColor",
          strokeWidth: "1.5"
        }),
        react.createElement("path", {
          key: "play",
          d: "M6.75 6.1v3.8l3.25-1.9-3.25-1.9z",
          fill: "currentColor"
        })
      ]);
    }

    /**
     * The player pane.
     *
     * Transport is chosen by container, not by a setting: an audio file's whole
     * UI is its transport, a video file needs the stage for the picture.
     */
    function MediaView(props) {
      var scope = props.scope;
      var path = props.path;
      var audio = isAudioPath(path);
      var failedState = react.useState(false);
      var failed = failedState[0];
      var setFailed = failedState[1];
      var url = mediaUrl(scope, path);

      var media = audio
        ? react.createElement("audio", {
            key: "media",
            src: url,
            controls: true,
            preload: "metadata",
            style: { width: "100%", margin: "auto 0" },
            onError: function () { setFailed(true); }
          })
        : react.createElement("video", {
            key: "media",
            src: url,
            controls: true,
            preload: "metadata",
            playsInline: true,
            style: {
              flex: "1 1 auto",
              minHeight: "0",
              width: "100%",
              objectFit: "contain",
              borderRadius: "6px",
              // Token, never a literal: a skin restyles the letterbox with the panel.
              background: "var(--dsw-alias-bg-base)"
            },
            onError: function () { setFailed(true); }
          });

      var notice = react.createElement("div", {
        key: "notice",
        style: {
          flex: "1 1 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 16px",
          textAlign: "center",
          fontSize: "12px",
          lineHeight: "1.6",
          color: "var(--dsw-alias-label-tertiary)"
        }
      }, "无法播放这个文件：编码不受支持，或宿主拒绝读取该路径。可以先下载到本地播放器打开。");

      return react.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "12px",
          minWidth: "0",
          minHeight: "0",
          height: "100%",
          boxSizing: "border-box"
        }
      }, [
        failed ? notice : media,
        react.createElement("div", {
          key: "meta",
          style: {
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "12px",
            color: "var(--dsw-alias-label-tertiary)"
          }
        }, [
          react.createElement("a", {
            key: "download",
            href: downloadUrl(scope, path),
            download: true,
            style: { color: "inherit", textDecoration: "underline" }
          }, "下载原文件")
        ])
      ]);
    }

    /** Cordis service dependency: the sidebar's file-viewer registry. */
    var inject = ["betterSidebar"];

    function apply(ctx) {
      // Registration must ride ctx.effect: the disposer returned by
      // registerFileViewer has to run on fiber teardown (HMR / disable), or a
      // re-activation throws "already registered".
      ctx.effect(function () {
        return ctx.betterSidebar.registerFileViewer({
          id: "media",
          title: "Media",
          icon: function (size) { return IconMediaOutline16(size); },
          exts: VIDEO_EXTS.concat(AUDIO_EXTS),
          // The element builds its own /media URL, so the host has no document
          // to read on our behalf (an fsRead viewer would classify a container
          // as binary and bounce straight back to the download pane).
          fetchStrategy: "none",
          component: MediaView
        });
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});
