const WRITE_INTERVAL_MS = 5_000;
const SOFT_PENDING_BYTES = 64 * 1024 * 1024;
const SOFT_PENDING_CHUNKS = 16;
const HARD_PENDING_BYTES = 256 * 1024 * 1024;
let recorder = null;
let capturedStream = null;
let audioContext = null;
let stopping = false;
let state = idleState();
let writer = null;
let writerRequestId = 0;
let writerRequests = new Map();
let writerFileName = null;
let writeChain = Promise.resolve();
let pendingBytes = 0;
let pendingChunks = 0;
let backpressurePaused = false;
let storageFailure = null;
let recovery = null;
let recoveryLoaded = false;
const objectUrls = new Map();

function idleState() {
  return {
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
    lastError: null,
    interactionLockRequested: false,
    interactionLockActive: false,
    lockSettlesAt: null,
    interactionLockError: null,
    terminationReason: null
  };
}

function publicState() {
  const downloadPending = state.status === "saved" && state.downloadId;
  return {
    ...state,
    recoveryAvailable: !downloadPending && Boolean(recovery),
    recoveryBytes: !downloadPending ? (recovery?.bytes || 0) : 0,
    recoveryStartedAt: !downloadPending ? (recovery?.startedAt || null) : null
  };
}

function broadcast() {
  chrome.runtime.sendMessage({
    target: "background",
    type: "OFFSCREEN_RECORDING_STATE",
    state: publicState()
  }).catch(() => {});
}

function supportedMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function recordingFilename(startedAt) {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `authorized-tab-recording-${stamp}.webm`;
}

function recordingFileName(startedAt) {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(16).slice(2, 8);
  return `authorized-tab-recording-${stamp}-${suffix}.webm`;
}

function writerRequest(type, details = {}, transfer = []) {
  if (!writer) {
    writer = new Worker(chrome.runtime.getURL("opfs-writer.js"));
    writer.addEventListener("message", handleWriterMessage);
    writer.addEventListener("error", handleWriterError, { once: true });
  }
  const requestId = `writer-${++writerRequestId}`;
  const promise = new Promise((resolve, reject) => {
    writerRequests.set(requestId, { resolve, reject });
  });
  writer.postMessage({ requestId, type, ...details }, transfer);
  return promise;
}

function handleWriterMessage(event) {
  const message = event.data;
  const pending = writerRequests.get(message?.requestId);
  if (!pending) return;
  writerRequests.delete(message.requestId);
  if (message.ok === false) {
    pending.reject(new Error(message.error || "OPFS 写入失败"));
    return;
  }
  pending.resolve(message);
}

function handleWriterError(event) {
  const error = new Error(event.message || "OPFS 写入 Worker 已停止");
  for (const pending of writerRequests.values()) pending.reject(error);
  writerRequests.clear();
  writer = null;
}

async function getOpfsFile(fileName) {
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle(fileName);
  return handle.getFile();
}

async function saveRecoveryMeta(meta) {
  const result = await chrome.runtime.sendMessage({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "set",
    value: {
      ...meta,
      updatedAt: Date.now()
    }
  });
  if (!result?.ok) throw new Error(result?.error || "无法保存录制恢复信息");
}

async function readRecoveryMeta() {
  const result = await chrome.runtime.sendMessage({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "get"
  });
  if (!result?.ok) throw new Error(result?.error || "无法读取录制恢复信息");
  return result.value || null;
}

async function removeRecoveryMeta() {
  const result = await chrome.runtime.sendMessage({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "remove"
  });
  if (!result?.ok) throw new Error(result?.error || "无法清除录制恢复信息");
}

async function loadRecovery() {
  if (recoveryLoaded) return recovery;
  recoveryLoaded = true;

  const files = await writerRequest("list");
  const meta = await readRecoveryMeta();
  let candidate = meta?.fileName
    ? files.files?.find((file) => file.fileName === meta.fileName)
    : null;

  if (!candidate && files.files?.length) candidate = files.files[0];
  if (!candidate) {
    recovery = null;
    return null;
  }

  if (meta?.status === "saved" && meta.fileName === candidate.fileName) {
    recovery = null;
    return null;
  }

  recovery = {
    fileName: candidate.fileName,
    bytes: candidate.byteSize,
    startedAt: meta?.startedAt || candidate.lastModified || Date.now(),
    mimeType: meta?.mimeType || "video/webm",
    filename: meta?.filename || recordingFilename(meta?.startedAt || candidate.lastModified || Date.now())
  };
  await saveRecoveryMeta({ ...recovery, status: "recoverable" });
  return recovery;
}

async function refreshRecoveryState() {
  await loadRecovery();
  state.recoveryAvailable = Boolean(recovery);
  state.recoveryBytes = recovery?.bytes || 0;
  state.recoveryStartedAt = recovery?.startedAt || null;
}

function releaseMedia() {
  if (capturedStream) {
    for (const track of capturedStream.getTracks()) track.stop();
  }
  capturedStream = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
  recorder = null;
  stopping = false;
  backpressurePaused = false;
  pendingBytes = 0;
  pendingChunks = 0;
  state.pendingBytes = 0;
  state.interactionLockActive = false;
}

async function preservePartial(error) {
  state.status = "error";
  state.lastError = error?.message || String(error);
  state.interactionLockActive = false;
  state.durationMs = state.startedAt ? Date.now() - state.startedAt : state.durationMs;

  try {
    await writeChain;
  } catch {}
  try {
    const closed = await writerRequest("close");
    state.bytes = closed.byteSize || state.bytes;
  } catch {}

  if (writerFileName) {
    recovery = {
      fileName: writerFileName,
      bytes: state.bytes,
      startedAt: state.startedAt || Date.now(),
      mimeType: state.mimeType || "video/webm",
      filename: state.filename || recordingFilename(state.startedAt || Date.now())
    };
    await saveRecoveryMeta({ ...recovery, status: "recoverable" });
  }
  releaseMedia();
  broadcast();
}

async function fail(error) {
  storageFailure ||= error;
  if (recorder && recorder.state !== "inactive") {
    stopping = true;
    try {
      recorder.stop();
      return;
    } catch {}
  }
  if (state.status === "starting" && (!recorder || recorder.state === "inactive") && writerFileName) {
    try { await writeChain; } catch {}
    try { await writerRequest("close"); } catch {}
    try { await writerRequest("delete", { fileName: writerFileName }); } catch {}
    writerFileName = null;
    state.status = "error";
    state.lastError = error?.message || String(error);
    state.interactionLockActive = false;
    releaseMedia();
    broadcast();
    return;
  }
  await preservePartial(error);
}

async function openRecordingFile() {
  const startedAt = state.startedAt || Date.now();
  writerFileName = recordingFileName(startedAt);
  await writerRequest("open", { fileName: writerFileName });
  await saveRecoveryMeta({
    fileName: writerFileName,
    startedAt,
    bytes: 0,
    mimeType: state.mimeType || "video/webm",
    filename: recordingFilename(startedAt),
    status: "recording"
  });
}

function maybeResumeAfterBackpressure() {
  if (!backpressurePaused || stopping || !recorder || recorder.state !== "paused") return;
  if (pendingBytes <= SOFT_PENDING_BYTES / 2 && pendingChunks <= SOFT_PENDING_CHUNKS / 2) {
    backpressurePaused = false;
    recorder.resume();
  }
}

function enqueueChunk(blob) {
  pendingBytes += blob.size;
  pendingChunks += 1;
  state.pendingBytes = pendingBytes;

  if (!stopping && recorder?.state === "recording" &&
      (pendingBytes > SOFT_PENDING_BYTES || pendingChunks > SOFT_PENDING_CHUNKS)) {
    backpressurePaused = true;
    recorder.pause();
  }

  if (pendingBytes > HARD_PENDING_BYTES) {
    fail(new Error("磁盘写入速度跟不上录制，已保护性停止并保留已写入内容")).catch(() => {});
  }

  const task = writeChain.then(async () => {
    const buffer = await blob.arrayBuffer();
    const written = await writerRequest("write", { buffer }, [buffer]);
    pendingBytes = Math.max(0, pendingBytes - blob.size);
    pendingChunks = Math.max(0, pendingChunks - 1);
    state.pendingBytes = pendingBytes;
    state.bytes = written.byteSize;
    state.durationMs = state.startedAt ? Date.now() - state.startedAt : state.durationMs;
    saveRecoveryMeta({
      fileName: writerFileName,
      startedAt: state.startedAt,
      bytes: state.bytes,
      mimeType: state.mimeType,
      filename: state.filename || recordingFilename(state.startedAt),
      status: "recording"
    }).catch(() => {});
    maybeResumeAfterBackpressure();
    broadcast();
  });
  writeChain = task;
  task.catch((error) => {
    storageFailure ||= error;
    fail(error).catch(() => {});
  });
}

async function sendCompletedDownload(objectUrl, filename, sourceFileName) {
  return chrome.runtime.sendMessage({
    target: "background",
    type: "OFFSCREEN_RECORDING_COMPLETE",
    objectUrl,
    filename,
    sourceFileName,
    state: publicState()
  });
}

async function finalizeRecording() {
  state.status = "saving";
  state.stoppedAt = Date.now();
  state.durationMs = state.startedAt ? state.stoppedAt - state.startedAt : state.durationMs;
  state.lastError = null;
  await saveRecoveryMeta({
    fileName: writerFileName,
    startedAt: state.startedAt,
    bytes: state.bytes,
    mimeType: state.mimeType,
    filename: recordingFilename(state.startedAt || Date.now()),
    status: "saving"
  });
  broadcast();

  await writeChain;
  if (storageFailure) throw storageFailure;
  const closed = await writerRequest("close");
  state.bytes = closed.byteSize || state.bytes;
  state.pendingBytes = 0;

  const file = await getOpfsFile(writerFileName);
  if (!file.size) throw new Error("没有录到可保存的标签页画面或声音");
  state.filename = recordingFilename(state.startedAt || Date.now());
  state.sourceFileName = writerFileName;
  const objectUrl = URL.createObjectURL(file);
  objectUrls.set(writerFileName, objectUrl);

  const result = await sendCompletedDownload(objectUrl, state.filename, writerFileName);
  if (!result?.ok) throw new Error(result?.error || "浏览器未能保存录制文件");
  state.status = "saved";
  state.downloadId = result.downloadId;
  state.lastError = null;
  await saveRecoveryMeta({
    fileName: writerFileName,
    startedAt: state.startedAt,
    bytes: state.bytes,
    mimeType: state.mimeType,
    filename: state.filename,
    downloadId: result.downloadId,
    status: "saved"
  });
  releaseMedia();
  broadcast();
}

async function stopRecording(reason = null) {
  if (!recorder || recorder.state === "inactive" || stopping) return publicState();
  stopping = true;
  state.status = "stopping";
  state.interactionLockActive = false;
  if (reason) state.terminationReason = reason;
  state.durationMs = state.startedAt ? Date.now() - state.startedAt : state.durationMs;
  broadcast();
  recorder.stop();
  return publicState();
}

async function startRecording(streamId, tabId, interactionDetails = {}) {
  if (recorder && recorder.state !== "inactive") throw new Error("已有标签页正在录制");

  await refreshRecoveryState();
  releaseMedia();
  storageFailure = null;
  writeChain = Promise.resolve();
  state = {
    ...idleState(),
    status: "starting",
    tabId,
    startedAt: Date.now(),
    interactionLockRequested: Boolean(interactionDetails.requested),
    interactionLockActive: Boolean(interactionDetails.active),
    lockSettlesAt: null
  };
  state.recoveryAvailable = Boolean(recovery);
  state.recoveryBytes = recovery?.bytes || 0;
  state.recoveryStartedAt = recovery?.startedAt || null;
  broadcast();

  const mimeType = supportedMimeType();
  state.mimeType = mimeType || "video/webm";
  await openRecordingFile();

  capturedStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    }
  });

  const audioTracks = capturedStream.getAudioTracks();
  if (audioTracks.length) {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
    source.connect(audioContext.destination);
  }

  recorder = new MediaRecorder(capturedStream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 128_000
  });
  stopping = false;
  state.mimeType = recorder.mimeType || mimeType || "video/webm";
  state.startedAt = Date.now();

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) enqueueChunk(event.data);
  });
  recorder.addEventListener("stop", () => {
    finalizeRecording().catch((error) => preservePartial(error).catch(() => {}));
  }, { once: true });
  recorder.addEventListener("error", (event) => {
    fail(event.error || new Error("MediaRecorder 录制失败")).catch(() => {});
  }, { once: true });
  for (const track of capturedStream.getTracks()) {
    track.addEventListener("ended", () => stopRecording().catch(fail), { once: true });
  }

  recorder.start(WRITE_INTERVAL_MS);
  state.status = "recording";
  await saveRecoveryMeta({
    fileName: writerFileName,
    startedAt: state.startedAt,
    bytes: 0,
    mimeType: state.mimeType,
    filename: recordingFilename(state.startedAt),
    status: "recording"
  });
  broadcast();
  return publicState();
}

async function exportRecovery() {
  await refreshRecoveryState();
  if (!recovery) throw new Error("没有可恢复的未完成录像");
  if (recorder && recorder.state !== "inactive") throw new Error("请先停止当前录制");

  state = {
    ...idleState(),
    status: "saving",
    startedAt: recovery.startedAt,
    bytes: recovery.bytes,
    mimeType: recovery.mimeType,
    filename: recovery.filename,
    sourceFileName: recovery.fileName,
    recoveryAvailable: true,
    recoveryBytes: recovery.bytes,
    recoveryStartedAt: recovery.startedAt
  };
  writerFileName = recovery.fileName;
  const file = await getOpfsFile(writerFileName);
  const objectUrl = URL.createObjectURL(file);
  objectUrls.set(writerFileName, objectUrl);
  const result = await sendCompletedDownload(objectUrl, state.filename, writerFileName);
  if (!result?.ok) throw new Error(result?.error || "浏览器未能导出未完成录像");
  state.status = "saved";
  state.downloadId = result.downloadId;
  await saveRecoveryMeta({ ...recovery, downloadId: result.downloadId, status: "saved" });
  broadcast();
  return publicState();
}

async function cleanupDownloadedFile(fileName) {
  await writerRequest("delete", { fileName });
  const url = objectUrls.get(fileName);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(fileName);
  }
  const files = await writerRequest("list");
  const protectedFiles = new Set([writerFileName, recovery?.fileName].filter(Boolean));
  for (const file of files.files || []) {
    if (file.fileName !== fileName && !protectedFiles.has(file.fileName)) {
      await writerRequest("delete", { fileName: file.fileName });
    }
  }
  const meta = await readRecoveryMeta();
  if (meta?.fileName === fileName) await removeRecoveryMeta();
  if (recovery?.fileName === fileName) recovery = null;
  if (state.sourceFileName === fileName) state.sourceFileName = null;
  state.recoveryAvailable = Boolean(recovery);
  state.recoveryBytes = recovery?.bytes || 0;
  state.recoveryStartedAt = recovery?.startedAt || null;
  broadcast();
}

async function markDownloadFailed(fileName, message) {
  const meta = await readRecoveryMeta();
  if (meta?.fileName === fileName) {
    recovery = {
      fileName,
      bytes: meta.bytes || state.bytes,
      startedAt: meta.startedAt || Date.now(),
      mimeType: meta.mimeType || "video/webm",
      filename: meta.filename || recordingFilename(meta.startedAt || Date.now())
    };
    await saveRecoveryMeta({ ...recovery, status: "recoverable" });
  }
  const url = objectUrls.get(fileName);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(fileName);
  }
  state.status = "error";
  state.lastError = `下载未完成：${message || "文件仍保留在本地缓存中"}`;
  broadcast();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "offscreen") return false;
  (async () => {
    if (message.type === "OFFSCREEN_GET_STATE") {
      await refreshRecoveryState();
      respond({ ok: true, state: publicState() });
      return;
    }
    if (message.type === "OFFSCREEN_START_RECORDING") {
      respond({
        ok: true,
        state: await startRecording(message.streamId, message.tabId, {
          requested: message.interactionLockRequested,
          active: message.interactionLockActive
        })
      });
      return;
    }
    if (message.type === "OFFSCREEN_STOP_RECORDING") {
      respond({ ok: true, state: await stopRecording(message.reason || null) });
      return;
    }
    if (message.type === "OFFSCREEN_EXPORT_RECOVERY") {
      respond({ ok: true, state: await exportRecovery() });
      return;
    }
    if (message.type === "OFFSCREEN_CLEANUP_FILE") {
      await cleanupDownloadedFile(message.fileName);
      respond({ ok: true, state: publicState() });
      return;
    }
    if (message.type === "OFFSCREEN_DOWNLOAD_FAILED") {
      await markDownloadFailed(message.fileName, message.error);
      respond({ ok: true, state: publicState() });
      return;
    }
    throw new Error("未知的离屏录制操作");
  })().catch(async (error) => {
    await fail(error);
    respond({ ok: false, error: error.message, state: publicState() });
  });
  return true;
});
