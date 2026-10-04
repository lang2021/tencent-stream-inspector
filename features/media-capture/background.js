const MAX_CAPTURED_SEGMENTS = 20;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export function createMediaCaptureModule(runtime) {
  const chrome = globalThis.chrome;
  const sessions = new Map();
  const pendingRequests = new Map();
  const capturedBodies = new Map();

  const send = (tabId, method, params = {}) =>
    new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });

  function broadcast(tabId) {
    const state = sessions.get(tabId);
    if (!state) return;
    chrome.runtime.sendMessage({ type: "MEDIA_CAPTURE_STATE", state }).catch(() => {});
  }

  function addUnique(list, value, limit = 300) {
    if (!value || list.includes(value)) return;
    list.push(value);
    if (list.length > limit) list.shift();
  }

  function requestKey(tabId, requestId) {
    return `${tabId}:${requestId}`;
  }

  function getCaptureStore(tabId) {
    if (!capturedBodies.has(tabId)) capturedBodies.set(tabId, new Map());
    return capturedBodies.get(tabId);
  }

  function clearPendingForTab(tabId) {
    const prefix = `${tabId}:`;
    for (const key of pendingRequests.keys()) {
      if (key.startsWith(prefix)) pendingRequests.delete(key);
    }
  }

  function bodyByteLength(body, base64Encoded) {
    if (!body) return 0;
    if (!base64Encoded) return new TextEncoder().encode(body).byteLength;
    const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
  }

  function safeFilename(url, index) {
    let sourceName = "segment.ts";
    try {
      sourceName = decodeURIComponent(new URL(url).pathname.split("/").pop() || sourceName);
    } catch {}
    const cleaned = sourceName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "segment.ts";
    return `authorized-stream-capture-${String(index + 1).padStart(2, "0")}-${cleaned}`;
  }

  function isPlaylist(url, mime = "") {
    return /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(mime);
  }

  function isSegment(url, mime = "") {
    return /\.(?:ts|m4s|mp4)(?:$|[?#])/i.test(url) || /video\/mp2t|audio\/mp4|video\/mp4/i.test(mime);
  }

  function parsePlaylist(text, playlistUrl) {
    const segments = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      try {
        const url = new URL(line, playlistUrl).href;
        if (/\.(?:ts|m4s|mp4)(?:$|[?#])/i.test(url)) segments.push(url);
      } catch {
        // Ignore malformed or non-URL playlist lines.
      }
    }
    return segments;
  }

  async function inspectMediaElement(tabId) {
    const result = await send(tabId, "Runtime.evaluate", {
      expression: `(() => Array.from(document.querySelectorAll("video,audio")).map((media) => ({
        tag: media.tagName,
        duration: Number.isFinite(media.duration) ? media.duration : null,
        currentTime: media.currentTime,
        readyState: media.readyState,
        paused: media.paused,
        hasMediaKeys: Boolean(media.mediaKeys),
        currentSrc: media.currentSrc || media.src || ""
      })))()`,
      returnByValue: true
    });
    return result?.result?.value || [];
  }

  async function inspectCompletedResponse(tabId, requestId, record) {
    const state = sessions.get(tabId);
    if (!state) return;
    try {
      const responseBody = await send(tabId, "Network.getResponseBody", { requestId });
      if (record.kind === "playlist") {
        const text = responseBody.base64Encoded ? atob(responseBody.body) : responseBody.body;
        const segments = parsePlaylist(text, record.url);
        const hasHlsKey = /#EXT-X-KEY/i.test(text);
        state.playlistBodies[record.url] = {
          bytes: bodyByteLength(responseBody.body, responseBody.base64Encoded),
          hasHlsKey,
          segmentCount: segments.length
        };
        state.playlistHasKey ||= hasHlsKey;
        for (const segment of segments) addUnique(state.segmentUrls, segment);
        return;
      }

      try {
        state.mediaInfo = await inspectMediaElement(tabId);
        state.emeDetected = state.mediaInfo.some((media) => media.hasMediaKeys);
      } catch {
        // Network capture can continue when media-element inspection is unavailable.
      }
      if (state.emeDetected || state.playlistHasKey) {
        state.protectedSegmentsSkipped += 1;
        return;
      }

      const bytes = bodyByteLength(responseBody.body, responseBody.base64Encoded);
      if (!bytes) throw new Error("响应体为空");
      if (bytes > MAX_SEGMENT_BYTES) {
        state.oversizeSegmentsSkipped += 1;
        return;
      }
      if (state.capturedSegments.length >= MAX_CAPTURED_SEGMENTS || state.capturedBytes + bytes > MAX_TOTAL_BYTES) {
        state.capacitySegmentsSkipped += 1;
        return;
      }

      const captureId = requestKey(tabId, requestId);
      const filename = safeFilename(record.url, state.capturedSegments.length);
      getCaptureStore(tabId).set(captureId, {
        body: responseBody.body,
        base64Encoded: Boolean(responseBody.base64Encoded),
        mime: record.mime || "application/octet-stream"
      });
      state.capturedSegments.push({
        captureId,
        url: record.url,
        mime: record.mime || "application/octet-stream",
        bytes,
        filename
      });
      state.capturedBytes += bytes;
    } catch (error) {
      state.captureFailures += 1;
      state.lastError = `无法直接读取响应体：${error.message}`;
    } finally {
      broadcast(tabId);
    }
  }

  async function start(message) {
    const tabId = message.tabId;
    if (!tabId) throw new Error("没有找到活动标签页");
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/i.test(tab.url)) throw new Error("只支持 HTTP/HTTPS 页面");
    if (await runtime.isRecordingBusy()) throw new Error("请先停止标签页录屏，再开始媒体数据捕获");

    if (sessions.has(tabId)) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }
    clearPendingForTab(tabId);
    capturedBodies.delete(tabId);
    const state = {
      tabId,
      pageUrl: tab.url,
      status: "attaching",
      startedAt: Date.now(),
      lastEventAt: null,
      playlistUrls: [],
      playlistBodies: {},
      segmentUrls: [],
      capturedSegments: [],
      capturedBytes: 0,
      captureFailures: 0,
      protectedSegmentsSkipped: 0,
      oversizeSegmentsSkipped: 0,
      capacitySegmentsSkipped: 0,
      mediaInfo: [],
      emeDetected: false,
      playlistHasKey: false,
      lastError: null
    };
    sessions.set(tabId, state);
    await chrome.debugger.attach({ tabId }, "1.3");
    await send(tabId, "Network.enable", {});
    state.mediaInfo = await inspectMediaElement(tabId);
    state.emeDetected = state.mediaInfo.some((media) => media.hasMediaKeys);
    state.status = "running";
    broadcast(tabId);
    return { ok: true, state };
  }

  async function stop(message) {
    const tabId = message.tabId;
    const state = sessions.get(tabId);
    if (!state) throw new Error("当前没有观察会话");
    try { await send(tabId, "Network.disable", {}); } catch {}
    try { await chrome.debugger.detach({ tabId }); } catch {}
    clearPendingForTab(tabId);
    state.status = "stopped";
    state.stoppedAt = Date.now();
    broadcast(tabId);
    return { ok: true, state };
  }

  async function downloadContent(message) {
    const state = sessions.get(message.tabId);
    if (!state) throw new Error("没有可用的观察结果");
    if (!state.capturedSegments.length) throw new Error("尚未获取到可保存的数据内容");
    const stamp = new Date(state.startedAt).toISOString().replace(/[:.]/g, "-");
    const folder = `authorized-stream-capture-${stamp}`;
    const downloadIds = [];
    const failures = [];
    for (const capture of state.capturedSegments) {
      const stored = getCaptureStore(message.tabId).get(capture.captureId);
      if (!stored) {
        failures.push(capture.filename);
        continue;
      }
      const dataUrl = stored.base64Encoded
        ? `data:${stored.mime};base64,${stored.body}`
        : `data:${stored.mime};charset=utf-8,${encodeURIComponent(stored.body)}`;
      try {
        const id = await chrome.downloads.download({
          url: dataUrl,
          filename: `${folder}/${capture.filename}`,
          saveAs: false,
          conflictAction: "uniquify"
        });
        downloadIds.push(id);
      } catch {
        failures.push(capture.filename);
      }
    }
    if (!downloadIds.length) throw new Error("保存失败，请重新捕获后再试");
    return { ok: true, count: downloadIds.length, failures, folder, downloadIds };
  }

  function register() {
    chrome.debugger.onEvent.addListener(async (source, method, params) => {
      if (!source.tabId || !sessions.has(source.tabId)) return;
      const state = sessions.get(source.tabId);
      if (method === "Network.loadingFinished") {
        const key = requestKey(source.tabId, params.requestId);
        const record = pendingRequests.get(key);
        if (!record) return;
        pendingRequests.delete(key);
        await inspectCompletedResponse(source.tabId, params.requestId, record);
        return;
      }
      if (method === "Network.loadingFailed") {
        pendingRequests.delete(requestKey(source.tabId, params.requestId));
        return;
      }
      if (method !== "Network.responseReceived") return;
      const response = params.response || {};
      const url = response.url || "";
      const mime = response.mimeType || "";
      if (isPlaylist(url, mime)) {
        addUnique(state.playlistUrls, url, 30);
        state.lastPlaylist = url;
        pendingRequests.set(requestKey(source.tabId, params.requestId), { kind: "playlist", url, mime });
      } else if (isSegment(url, mime)) {
        addUnique(state.segmentUrls, url);
        pendingRequests.set(requestKey(source.tabId, params.requestId), { kind: "segment", url, mime });
      }
      state.lastEventAt = Date.now();
      broadcast(source.tabId);
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      if (!source.tabId || !sessions.has(source.tabId)) return;
      const state = sessions.get(source.tabId);
      state.status = "detached";
      state.lastError = `调试连接已断开：${reason}`;
      clearPendingForTab(source.tabId);
      broadcast(source.tabId);
    });
  }

  return {
    name: "mediaCapture",
    handles(message) {
      return ["GET_MEDIA_CAPTURE_STATE", "START_MEDIA_CAPTURE", "STOP_MEDIA_CAPTURE", "DOWNLOAD_MEDIA_CONTENT"].includes(message.type);
    },
    async handleMessage(message) {
      if (message.type === "GET_MEDIA_CAPTURE_STATE") return { ok: true, state: sessions.get(message.tabId) || null };
      if (message.type === "START_MEDIA_CAPTURE") return start(message);
      if (message.type === "STOP_MEDIA_CAPTURE") return stop(message);
      if (message.type === "DOWNLOAD_MEDIA_CONTENT") return downloadContent(message);
      throw new Error("未知媒体捕获操作");
    },
    register,
    async isBusy(tabId) {
      const state = sessions.get(tabId);
      return ["attaching", "running"].includes(state?.status);
    }
  };
}
