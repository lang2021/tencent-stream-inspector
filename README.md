# Authorized Stream Inspector

当前版本：`0.8.0`

一个本地 Chrome Manifest V3 扩展。当前里程碑默认只显示录屏模块；媒体数据捕获模块仍保留在代码中，但默认休眠，便于后续独立开发和恢复。

在用户明确有权处理的页面上，扩展可以：

1. 直接录制当前标签页，输出 H.264/AAC MP4。
2. 观察并保存浏览器已经收到的媒体响应数据（开发模块，默认隐藏）。

扩展不调用服务器、不重新请求媒体 URL、不尝试绕过 DRM，也不会录制桌面、其他窗口或浏览器工具栏。

## 功能一：当前标签页录屏

- 用户手动开始、手动停止。
- 使用 `tabCapture + MediaRecorder`，由 Chrome 直接编码为 MP4。
- 默认规格为最高 1080p、30 fps、5 Mbps 视频和 128 kbps 音频。
- 视频编码为 H.264 `avc1`，音频编码为 AAC-LC。
- 严格 MP4-only：浏览器不支持目标格式时明确报错，不回退为 WebM。
- 不经过录后转码，最终只产生一个连续的 `.mp4` 文件。
- 录制数据通过 OPFS Worker 连续写入磁盘，内存不会随录像总长度线性增长。
- 内部约每 5 秒请求一次数据输出；MP4 数据块可能等待 H.264 关键帧才真正写入。
- 关闭插件弹窗不会停止录像；重新打开弹窗仍可查看状态并停止保存。
- 浏览器或扩展异常中断后，最近一份已写入磁盘的录像可以从弹窗恢复导出。
- 升级前遗留的未完成 WebM 仍按 WebM 原样恢复，但新录像不会创建 WebM。

### 鼠标与键盘隔离

录制前和录制过程中均可独立切换：

- **鼠标隔离**：隐藏指针，并阻止点击、移动、滚轮、拖拽和触摸事件影响页面。
- **键盘隔离**：阻止空格、方向键、Esc、普通按键和文字输入影响页面。
- 两个开关每次打开插件均默认关闭，不保存上次选择。
- Chrome 自身的系统级快捷键，例如 `⌘L`、`⌘W`，不属于网页事件，扩展无法屏蔽。
- 任一隔离开启时发生完整页面导航，录像会自动停止并保存已有内容。
- 隔离使用约 12 秒安全租约并定期续租；扩展重载或注入脚本失活后会自动失效。

## 开发模块：媒体响应捕获（默认隐藏）

媒体捕获代码没有删除，只是由 `features/feature-flags.js` 中的 `mediaCapture.enabled = false` 关闭。关闭时不会挂载弹窗界面、创建捕获缓存、注册 `chrome.debugger` 监听器，也不会响应媒体捕获消息。

如需恢复该模块，只修改功能开关：

```js
mediaCapture: Object.freeze({ enabled: true })
```

然后在 `chrome://extensions` 重新加载扩展。Manifest 中仍保留 `debugger` 权限，因此不需要再次调整权限文件。

- 使用 Chrome DevTools Protocol 观察当前标签页的网络响应。
- 识别 HLS `m3u8` 清单和 `ts`、`m4s`、`mp4` 分片。
- 读取页面媒体元素的时长、播放状态和 `mediaKeys` 状态。
- 在响应第一次传输完成时，通过对应的 `requestId` 读取并缓存浏览器收到的响应体。
- 点击“保存内容”后，从内存副本生成文件，不根据 URL 再次请求服务器。
- 检测到 EME 或 HLS 加密标记时，继续观察请求，但跳过受保护的媒体响应体。
- 不调用 `captureStream()`，不抓取解码后的画面，不解密、不拼接、不转码。
- 界面只显示已获取份数和数据量，不显示或导出 URL 观察清单。

## 安装

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择目录：

   ```text
   /Users/marsdrifter/My_Digital_Vault/Nexus/30_Workbench/tencent-stream-inspector
   ```

5. 更新代码后，在扩展管理页面点击本扩展的“重新加载”。

## 使用

### 录制当前标签页

1. 打开需要录制的 HTTP/HTTPS 页面。
2. 点击扩展图标。
3. 按需开启鼠标隔离或键盘隔离。
4. 点击“开始录制当前标签页”。
5. 需要结束时点击“停止并保存”。
6. 完成的 MP4 自动保存到 Chrome 下载目录。

### 保存媒体响应

媒体捕获默认不可见。重新启用后，才会在弹窗中显示“媒体数据捕获”模块，并按原流程操作：开始捕获、播放内容、停止、保存内容。

## 正常运行架构

扩展内部按功能划分为以下逻辑组件：

- `background.js`：Manifest V3 ES Module Service Worker，只负责读取功能开关、分发消息和协调模块互斥；空闲时可被 Chrome 挂起。
- `features/feature-flags.js`：功能开关，当前启用录屏、关闭媒体捕获。
- `features/tab-recording/`：录屏后台生命周期和弹窗控制；根目录的离屏页面、OPFS Worker 与隔离脚本是它使用的运行资源。
- `features/media-capture/`：媒体响应捕获后台逻辑和弹窗控制；默认不注册。
- `offscreen.html` / `offscreen.js`：离屏扩展页面，承载 `MediaRecorder`，保证关闭弹窗后录像仍可继续。
- `opfs-writer.js`：离屏页面创建的专用 Worker，按顺序把录像数据写入 OPFS。
- `interaction-lock.js`、`keyboard-lock.js`：仅在用户开启相应隔离时注入目标页面。
- `popup.html` / `popup.js`：共享弹窗外壳；具体功能界面由对应模块挂载。

这些是扩展内部的逻辑上下文，不等于多个独立 Chrome 应用。Chrome 还会为所有网页和扩展共享 GPU、网络、音频、视频捕获和存储进程。

正常使用本扩展不会启动 Headless Chrome，也不会启动外部进程。自动化测试同样不应创建 Headless Chrome 或 `/tmp/codex-mp4-*` 临时 profile；如果开发者另行运行浏览器探针，测试结束后必须确认进程退出并删除对应 profile。

## 存储与清理

- 正在录制的数据临时保存在扩展自己的 OPFS 中。
- 正常停止后，扩展等待最后数据块和磁盘队列完成，再发起 Chrome 下载。
- 下载成功后，对应的 OPFS 源文件会被删除。
- 下载取消或失败时，OPFS 源文件会保留，并在弹窗显示“导出未完成录像”。
- 正式导出的 MP4/WebM 位于 Chrome 下载目录，由用户自行保留或删除。
- Chrome 会保留少量扩展设置和 OPFS 索引数据库；这是浏览器管理数据，不是第二份录像。
- 媒体响应捕获的数据只保存在 Service Worker 内存中，不写入项目目录。
- 扩展不会在项目仓库生成录像、缓存、日志、构建目录或临时文件。

## 权限说明

- `activeTab`：仅访问用户主动操作的当前标签页。
- `tabCapture`：录制当前标签页画面和该标签页声音。
- `offscreen`：让录制在弹窗关闭后继续运行。
- `downloads`：保存录像和媒体响应文件。
- `storage`、`unlimitedStorage`：保存恢复元数据并允许长时间 OPFS 录制。
- `scripting`：按需注入鼠标或键盘隔离脚本。
- `debugger`：通过 Chrome DevTools Protocol 观察媒体网络响应；Chrome 会显示调试连接提示。

扩展不申请 `<all_urls>` 永久访问权限。

## 开发与验证

本项目是 `30_Workbench` 下的独立 Git 仓库，不属于 Nexus 生产知识流程。

检查 JavaScript 和 ES Module 语法：

```bash
for file in background.js popup.js offscreen.js opfs-writer.js interaction-lock.js keyboard-lock.js \
  features/feature-flags.js features/tab-recording/background.js features/tab-recording/popup.js \
  features/media-capture/background.js features/media-capture/popup.js; do
  node --check "$file"
done
```

检查 Manifest JSON：

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("manifest.json", "utf8"))'
```

运行自动化测试：

```bash
node --test tests/*.test.js
```

录制和导出的媒体文件不应提交到仓库。

## 已知限制

- 标签页录屏要求 Chrome 116 或更高版本；直接 MP4 还要求当前 Chrome 和系统支持目标 H.264/AAC MIME。
- 受 DRM/EME 保护的内容可能黑屏、静音或拒绝播放；扩展不会尝试规避保护。
- OPFS 不可用、磁盘空间不足、写入失败或队列持续积压时，扩展会拒绝开始或保护性停止。
- 异常中断的 MP4 或旧 WebM 可能缺少最终索引，表现为无法播放或拖动定位不完整。
- 录制期间应尽量避免改变浏览器窗口或标签页捕获分辨率。
- `unlimitedStorage` 只避免扩展配额限制，不能绕过系统磁盘容量。
- 通用鼠标隔离不能绝对阻止网站更早注册的全局捕获监听器或页面定时显示的悬浮控件。
- 单个媒体响应体缓存上限为 32 MiB；一次捕获最多缓存 20 份、合计 128 MiB。
- Chrome 可能无法提供某些流式、缓存或已回收请求的响应体，扩展不会回退为 URL 下载。
- 保存的媒体响应可能仍是加密数据、TS 封装或不能独立播放的分片。
