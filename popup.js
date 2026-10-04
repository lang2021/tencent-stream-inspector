let activeTabId = null;
let currentState = null;
let recordingState = null;
let recordingClock = null;

const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, tabId: activeTabId, ...extra }, resolve));
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const core = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${String(hours).padStart(2, "0")}:${core}` : core;
}

function renderCapture(state) {
  currentState = state;
  const running = state?.status === "running" || state?.status === "attaching";
  const eme = state?.emeDetected;
  $("statusDot").className = `status-dot ${running ? (eme ? "warn" : "live") : ""}`;
  $("statusText").textContent = !state ? "等待开始捕获" :
    state.status === "running" ? (eme ? "正在捕获，受保护内容将被跳过" : "正在捕获媒体数据") :
    state.status === "stopped" ? "捕获已停止，可以保存内容" : state.status;
  $("captureCount").textContent = `${state?.capturedSegments?.length || 0} 份`;
  $("captureBytes").textContent = formatBytes(state?.capturedBytes || 0);
  $("startButton").disabled = running;
  $("stopButton").disabled = !running;
  $("saveButton").disabled = !state || running || !state.capturedSegments?.length;
  $("errorText").hidden = !state?.lastError;
  $("errorText").textContent = state?.lastError || "";
}

function updateRecordingMetrics() {
  if (!recordingState) return;
  const liveElapsed = recordingState.status === "recording" && recordingState.startedAt
    ? Date.now() - recordingState.startedAt
    : recordingState.durationMs || 0;
  $("recordingDuration").textContent = formatDuration(liveElapsed);
  $("recordingBytes").textContent = formatBytes(recordingState.bytes || 0);
}

function recordingFormat(state) {
  const active = ["starting", "recording", "stopping", "saving"].includes(state?.status);
  const mimeType = !active && state?.recoveryAvailable
    ? state.recoveryMimeType
    : state?.mimeType;
  const isWebm = /^video\/webm(?:;|$)/i.test(mimeType);
  return {
    name: isWebm ? "WebM" : "MP4",
    label: isWebm ? "WebM · 旧恢复文件" : "MP4 · H.264/AAC"
  };
}

function renderRecording(state) {
  recordingState = state || { status: "idle", bytes: 0, durationMs: 0 };
  const status = recordingState.status;
  const active = ["starting", "recording", "stopping", "saving"].includes(status);
  const otherTab = Boolean(recordingState.tabId && activeTabId && recordingState.tabId !== activeTabId);
  const lockEnabled = Boolean(recordingState.interactionLockActive);
  const format = recordingFormat(recordingState);
  $("recordingDot").className = `status-dot ${status === "recording" ? "recording" : active ? "warn" : ""}`;
  $("recordingStatusText").textContent = status === "starting" ? "正在连接当前标签页" :
    status === "recording" ? `${otherTab ? "正在录制另一个标签页" : "正在录制当前标签页"}${lockEnabled ? " · 鼠标已隔离" : ""}` :
    status === "stopping" ? "正在结束录制" :
    status === "saving" ? `正在保存 ${format.name}` :
    status === "saved" ? "录制已保存到下载目录" :
    status === "error" ? "录制失败" : "等待手动开始";
  if (recordingState.recoveryAvailable && !active) {
    $("recordingStatusText").textContent = "发现未完成录像，可导出已写入内容";
  }
  $("recordingFormat").textContent = format.label;
  $("startRecordingButton").disabled = active || ["running", "attaching"].includes(currentState?.status);
  $("stopRecordingButton").disabled = status !== "recording";
  $("recoverRecordingButton").hidden = !recordingState.recoveryAvailable || active;
  $("recoverRecordingButton").disabled = active;
  $("startButton").disabled = ["running", "attaching"].includes(currentState?.status) || active;
  const recordingError = recordingState.lastError || recordingState.interactionLockError || "";
  $("recordingErrorText").hidden = !recordingError;
  $("recordingErrorText").textContent = recordingError;
  $("interactionLockCheckbox").checked = status === "recording" || status === "starting" ? lockEnabled : false;
  $("interactionLockCheckbox").disabled = ["starting", "stopping", "saving"].includes(status);
  updateRecordingMetrics();

  clearInterval(recordingClock);
  recordingClock = status === "recording" ? setInterval(updateRecordingMetrics, 500) : null;
}

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0]?.id;
  const [captureResult, recordingResult] = activeTabId
    ? await Promise.all([send("GET_STATE"), send("GET_RECORDING_STATE")])
    : [{ state: null }, { state: null }];
  renderCapture(captureResult.state || null);
  renderRecording(recordingResult.state || null);
}

$("startButton").addEventListener("click", async () => {
  const result = await send("START");
  if (!result.ok) renderCapture({ status: "error", lastError: result.error, capturedSegments: [], capturedBytes: 0 });
  else renderCapture(result.state);
  renderRecording(recordingState);
});

$("stopButton").addEventListener("click", async () => {
  const result = await send("STOP");
  if (!result.ok) renderCapture({ ...(currentState || {}), lastError: result.error });
  else renderCapture(result.state);
  renderRecording(recordingState);
});

$("saveButton").addEventListener("click", async () => {
  const result = await send("DOWNLOAD_CONTENT");
  if (!result.ok) {
    renderCapture({ ...(currentState || {}), lastError: result.error });
    return;
  }
  const suffix = result.failures?.length ? `，${result.failures.length} 份失败` : "";
  $("statusText").textContent = `已保存 ${result.count} 份内容到下载目录${suffix}`;
});

$("startRecordingButton").addEventListener("click", async () => {
  const interactionLockEnabled = $("interactionLockCheckbox").checked;
  renderRecording({
    status: "starting",
    tabId: activeTabId,
    startedAt: Date.now(),
    bytes: 0,
    durationMs: 0,
    interactionLockRequested: interactionLockEnabled,
    interactionLockActive: interactionLockEnabled
  });
  const result = await send("START_TAB_RECORDING", { interactionLockEnabled });
  if (!result?.ok) {
    renderRecording({ status: "error", tabId: activeTabId, bytes: 0, durationMs: 0, lastError: result?.error || "无法开始录制" });
    return;
  }
  renderRecording(result.state);
});

$("interactionLockCheckbox").addEventListener("change", async () => {
  if (recordingState?.status !== "recording") return;
  const checkbox = $("interactionLockCheckbox");
  const enabled = checkbox.checked;
  checkbox.disabled = true;
  const result = await send("SET_RECORDING_INTERACTION_LOCK", { enabled });
  if (!result?.ok) {
    renderRecording({
      ...(result?.state || recordingState || {}),
      interactionLockError: result?.error || "无法切换鼠标隔离"
    });
    return;
  }
  renderRecording(result.state);
});

$("stopRecordingButton").addEventListener("click", async () => {
  const result = await send("STOP_TAB_RECORDING");
  if (!result?.ok) {
    renderRecording({ ...(recordingState || {}), status: "error", lastError: result?.error || "无法停止录制" });
    return;
  }
  renderRecording(result.state);
});

$("recoverRecordingButton").addEventListener("click", async () => {
  renderRecording({ ...(recordingState || {}), status: "saving" });
  const result = await send("EXPORT_RECOVERABLE_RECORDING");
  if (!result?.ok) {
    renderRecording({ ...(recordingState || {}), status: "error", lastError: result?.error || "无法导出未完成录像" });
    return;
  }
  renderRecording(result.state);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE" && message.state?.tabId === activeTabId) {
    renderCapture(message.state);
    renderRecording(recordingState);
  }
  if (message.type === "RECORDING_STATE") {
    renderRecording(message.state);
  }
});

init();
