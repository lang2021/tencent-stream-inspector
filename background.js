const sessions = new Map();
const pendingRequests = new Map();
const capturedBodies = new Map();

const MAX_CAPTURED_SEGMENTS = 20;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const OFFSCREEN_DOCUMENT_URL = "offscreen.html";
const DOWNLOAD_KEY_PREFIX = "authorizedTabRecordingDownload:";
const RECOVERY_KEY = "authorizedTabRecordingRecovery";

let creatingOffscreenDocument = null;
let lastRecordingState = {
  status: "idle",
  tabId: null,
  startedAt: null,
  stoppedAt: null,
  durationMs: 0,
  bytes: 0,
  pendingBytes: 0,
  mimeType: null,
  filename: null,
  sourceFileName: null,
  downloadId: null,
  storageBackend: "opfs",
  recoveryAvailable: false,
  recoveryBytes: 0,
  recoveryStartedAt: null,
  lastError: null
};

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
  chrome.runtime.sendMessage({ type: "STATE", state }).catch(() => {});
}

function broadcastRecording(state) {
  lastRecordingState = state;
  chrome.runtime.sendMessage({ type: "RECORDING_STATE", state }).catch(() => {});
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_URL,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "Record and save the current Chrome tab after the user clicks the recording button."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function messageOffscreen(type, details = {}) {
  return chrome.runtime.sendMessage({ target: "offscreen", type, ...details });
}

async function getRecordingState() {
  if (!(await hasOffscreenDocument())) {
    try {
      await ensureOffscreenDocument();
    } catch {
      return lastRecordingState;
    }
  }
  try {
    const result = await messageOffscreen("OFFSCREEN_GET_STATE");
    if (result?.state) lastRecordingState = result.state;
  } catch {
    // Fall back to the most recent state cached by the service worker.
  }
  return lastRecordingState;
}

async function savePendingDownload(downloadId, details) {
  await chrome.storage.local.set({
    [`${DOWNLOAD_KEY_PREFIX}${downloadId}`]: details
  });
}

async function readPendingDownload(downloadId) {
  const key = `${DOWNLOAD_KEY_PREFIX}${downloadId}`;
  const stored = await chrome.storage.local.get(key);
  return { key, details: stored?.[key] || null };
}

async function finishRecordingDownload(downloadId, delta) {
  const pending = await readPendingDownload(downloadId);
  if (!pending.details?.sourceFileName) return;

  try {
    await ensureOffscreenDocument();
    if (delta.state?.current === "complete") {
      await messageOffscreen("OFFSCREEN_CLEANUP_FILE", {
        fileName: pending.details.sourceFileName
      });
    } else if (delta.error?.current) {
      await messageOffscreen("OFFSCREEN_DOWNLOAD_FAILED", {
        fileName: pending.details.sourceFileName,
        error: delta.error.current
      });
    }
    await chrome.storage.local.remove(pending.key);
  } catch {
    // Keep the mapping if the offscreen document could not be reached. The
    // OPFS source remains recoverable and can be exported from the popup.
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete" || delta.error?.current) {
    finishRecordingDownload(delta.id, delta).catch(() => {});
  }
});

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
    pendingRequests.set(requestKey(source.tabId, params.requestId), {
      kind: "playlist",
      url,
      mime
    });
  } else if (isSegment(url, mime)) {
    addUnique(state.segmentUrls, url);
    pendingRequests.set(requestKey(source.tabId, params.requestId), {
      kind: "segment",
      url,
      mime
    });
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === "offscreen") return false;
  (async () => {
    if (message.target === "background" && message.type === "OFFSCREEN_RECORDING_STATE") {
      broadcastRecording(message.state);
      respond({ ok: true });
      return;
    }

    if (message.target === "background" && message.type === "OFFSCREEN_RECOVERY_STORAGE") {
      if (message.action === "get") {
        const stored = await chrome.storage.local.get(RECOVERY_KEY);
        respond({ ok: true, value: stored?.[RECOVERY_KEY] || null });
        return;
      }
      if (message.action === "set") {
        await chrome.storage.local.set({ [RECOVERY_KEY]: message.value });
        respond({ ok: true });
        return;
      }
      if (message.action === "remove") {
        await chrome.storage.local.remove(RECOVERY_KEY);
        respond({ ok: true });
        return;
      }
      throw new Error("未知的录制恢复存储操作");
    }

    if (message.target === "background" && message.type === "OFFSCREEN_RECORDING_COMPLETE") {
      const downloadId = await chrome.downloads.download({
        url: message.objectUrl,
        filename: message.filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      await savePendingDownload(downloadId, {
        sourceFileName: message.sourceFileName,
        filename: message.filename,
        createdAt: Date.now()
      });
      respond({ ok: true, downloadId });
      return;
    }

    if (message.type === "GET_STATE") {
      respond({ ok: true, state: sessions.get(message.tabId) || null });
      return;
    }

    if (message.type === "GET_RECORDING_STATE") {
      respond({ ok: true, state: await getRecordingState() });
      return;
    }

    if (message.type === "START_TAB_RECORDING") {
      const tabId = message.tabId;
      if (!tabId) throw new Error("没有找到活动标签页");
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !/^https?:/i.test(tab.url)) throw new Error("只支持 HTTP/HTTPS 页面");

      const captureState = sessions.get(tabId);
      if (["attaching", "running"].includes(captureState?.status)) {
        throw new Error("请先停止媒体数据捕获，再开始标签页录屏");
      }

      const recordingState = await getRecordingState();
      if (["starting", "recording", "stopping", "saving"].includes(recordingState.status)) {
        throw new Error("已有标签页正在录制或保存");
      }

      try {
        await ensureOffscreenDocument();
        lastRecordingState = {
          ...lastRecordingState,
          status: "starting",
          tabId,
          startedAt: Date.now(),
          stoppedAt: null,
          durationMs: 0,
          bytes: 0,
          pendingBytes: 0,
          filename: null,
          sourceFileName: null,
          downloadId: null,
          storageBackend: "opfs",
          lastError: null
        };
        broadcastRecording(lastRecordingState);

        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        const result = await messageOffscreen("OFFSCREEN_START_RECORDING", { streamId, tabId });
        if (!result?.ok) throw new Error(result?.error || "无法开始录制当前标签页");
        lastRecordingState = result.state;
        respond({ ok: true, state: result.state });
      } catch (error) {
        lastRecordingState = {
          ...lastRecordingState,
          status: "error",
          durationMs: 0,
          bytes: 0,
          lastError: error.message
        };
        broadcastRecording(lastRecordingState);
        throw error;
      }
      return;
    }

    if (message.type === "STOP_TAB_RECORDING") {
      if (!(await hasOffscreenDocument())) throw new Error("当前没有标签页录制会话");
      const result = await messageOffscreen("OFFSCREEN_STOP_RECORDING");
      if (!result?.ok) throw new Error(result?.error || "无法停止标签页录制");
      lastRecordingState = result.state;
      respond({ ok: true, state: result.state });
      return;
    }

    if (message.type === "EXPORT_RECOVERABLE_RECORDING") {
      const recordingState = await getRecordingState();
      if (recordingState.status === "recording" || recordingState.status === "saving") {
        throw new Error("请先停止当前标签页录制");
      }
      const result = await messageOffscreen("OFFSCREEN_EXPORT_RECOVERY");
      if (!result?.ok) throw new Error(result?.error || "无法导出未完成录像");
      lastRecordingState = result.state;
      respond({ ok: true, state: result.state });
      return;
    }

    if (message.type === "START") {
      const tabId = message.tabId;
      if (!tabId) throw new Error("没有找到活动标签页");
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !/^https?:/i.test(tab.url)) throw new Error("只支持 HTTP/HTTPS 页面");

      const recordingState = await getRecordingState();
      if (["starting", "recording", "stopping", "saving"].includes(recordingState.status)) {
        throw new Error("请先停止标签页录屏，再开始媒体数据捕获");
      }

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
      respond({ ok: true, state });
      return;
    }

    if (message.type === "STOP") {
      const tabId = message.tabId;
      const state = sessions.get(tabId);
      if (!state) throw new Error("当前没有观察会话");
      try { await send(tabId, "Network.disable", {}); } catch {}
      try { await chrome.debugger.detach({ tabId }); } catch {}
      clearPendingForTab(tabId);
      state.status = "stopped";
      state.stoppedAt = Date.now();
      broadcast(tabId);
      respond({ ok: true, state });
      return;
    }

    if (message.type === "DOWNLOAD_CONTENT") {
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
      respond({ ok: true, count: downloadIds.length, failures, folder, downloadIds });
      return;
    }

    throw new Error("未知操作");
  })().catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
