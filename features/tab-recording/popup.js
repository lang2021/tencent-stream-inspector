export function createTabRecordingView({ $, send, getActiveTabId, getMediaCaptureState }) {
  let recordingState = null;
  let recordingClock = null;

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

  function recordingFormat(state) {
    const active = ["starting", "recording", "stopping", "saving"].includes(state?.status);
    const mimeType = !active && state?.recoveryAvailable ? state.recoveryMimeType : state?.mimeType;
    const isWebm = /^video\/webm(?:;|$)/i.test(mimeType);
    return {
      name: isWebm ? "WebM" : "MP4",
      label: isWebm ? "WebM · 旧恢复文件" : "MP4 · H.264/AAC"
    };
  }

  function updateRecordingMetrics() {
    if (!recordingState) return;
    const liveElapsed = recordingState.status === "recording" && recordingState.startedAt
      ? Date.now() - recordingState.startedAt
      : recordingState.durationMs || 0;
    $("recordingDuration").textContent = formatDuration(liveElapsed);
    $("recordingBytes").textContent = formatBytes(recordingState.bytes || 0);
  }

  function render(state) {
    recordingState = state || { status: "idle", bytes: 0, durationMs: 0 };
    const status = recordingState.status;
    const active = ["starting", "recording", "stopping", "saving"].includes(status);
    const activeTabId = getActiveTabId();
    const otherTab = Boolean(recordingState.tabId && activeTabId && recordingState.tabId !== activeTabId);
    const captureState = getMediaCaptureState();
    const lockEnabled = Boolean(recordingState.interactionLockActive);
    const keyboardLockEnabled = Boolean(recordingState.keyboardLockActive);
    const isolationLabel = lockEnabled && keyboardLockEnabled
      ? " · 鼠标和键盘已隔离"
      : lockEnabled ? " · 鼠标已隔离" : keyboardLockEnabled ? " · 键盘已隔离" : "";
    const format = recordingFormat(recordingState);
    $("recordingDot").className = `status-dot ${status === "recording" ? "recording" : active ? "warn" : ""}`;
    $("recordingStatusText").textContent = status === "starting" ? "正在连接当前标签页" :
      status === "recording" ? `${otherTab ? "正在录制另一个标签页" : "正在录制当前标签页"}${isolationLabel}` :
      status === "stopping" ? "正在结束录制" : status === "saving" ? `正在保存 ${format.name}` :
      status === "saved" ? "录制已保存到下载目录" : status === "error" ? "录制失败" : "等待手动开始";
    if (recordingState.recoveryAvailable && !active) {
      $("recordingStatusText").textContent = "发现未完成录像，可导出已写入内容";
    }
    $("recordingFormat").textContent = format.label;
    $("startRecordingButton").disabled = active || ["running", "attaching"].includes(captureState?.status);
    $("stopRecordingButton").disabled = status !== "recording";
    $("recoverRecordingButton").hidden = !recordingState.recoveryAvailable || active;
    $("recoverRecordingButton").disabled = active;
    const error = recordingState.lastError || recordingState.interactionLockError || recordingState.keyboardLockError || "";
    $("recordingErrorText").hidden = !error;
    $("recordingErrorText").textContent = error;
    $("interactionLockCheckbox").checked = status === "recording" || status === "starting" ? lockEnabled : false;
    $("interactionLockCheckbox").disabled = ["starting", "stopping", "saving"].includes(status);
    $("keyboardLockCheckbox").checked = status === "recording" || status === "starting" ? keyboardLockEnabled : false;
    $("keyboardLockCheckbox").disabled = ["starting", "stopping", "saving"].includes(status);
    updateRecordingMetrics();
    clearInterval(recordingClock);
    recordingClock = status === "recording" ? setInterval(updateRecordingMetrics, 500) : null;
  }

  async function start() {
    const activeTabId = getActiveTabId();
    const interactionLockEnabled = $("interactionLockCheckbox").checked;
    const keyboardLockEnabled = $("keyboardLockCheckbox").checked;
    render({
      status: "starting", tabId: activeTabId, startedAt: Date.now(), bytes: 0, durationMs: 0,
      interactionLockRequested: interactionLockEnabled, interactionLockActive: interactionLockEnabled,
      keyboardLockRequested: keyboardLockEnabled, keyboardLockActive: keyboardLockEnabled
    });
    const result = await send("START_TAB_RECORDING", { interactionLockEnabled, keyboardLockEnabled });
    render(result?.ok ? result.state : { status: "error", tabId: activeTabId, bytes: 0, durationMs: 0, lastError: result?.error || "无法开始录制" });
  }

  function install() {
    $("startRecordingButton").addEventListener("click", start);
    $("stopRecordingButton").addEventListener("click", async () => {
      const result = await send("STOP_TAB_RECORDING");
      render(result?.ok ? result.state : { ...(recordingState || {}), status: "error", lastError: result?.error || "无法停止录制" });
    });
    for (const [id, type, errorKey, errorText] of [
      ["interactionLockCheckbox", "SET_RECORDING_INTERACTION_LOCK", "interactionLockError", "无法切换鼠标隔离"],
      ["keyboardLockCheckbox", "SET_RECORDING_KEYBOARD_LOCK", "keyboardLockError", "无法切换键盘隔离"]
    ]) {
      $(id).addEventListener("change", async () => {
        if (recordingState?.status !== "recording") return;
        const checkbox = $(id);
        checkbox.disabled = true;
        const result = await send(type, { enabled: checkbox.checked });
        render(result?.ok ? result.state : { ...(result?.state || recordingState), [errorKey]: result?.error || errorText });
      });
    }
    $("recoverRecordingButton").addEventListener("click", async () => {
      render({ ...(recordingState || {}), status: "saving" });
      const result = await send("EXPORT_RECOVERABLE_RECORDING");
      render(result?.ok ? result.state : { ...(recordingState || {}), status: "error", lastError: result?.error || "无法导出未完成录像" });
    });
  }

  return { install, render, getState: () => recordingState };
}
