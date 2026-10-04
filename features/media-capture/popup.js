export function createMediaCaptureView({ $, send }) {
  let state = null;

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function render(nextState) {
    state = nextState;
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

  function install() {
    $("startButton").addEventListener("click", async () => {
      const result = await send("START_MEDIA_CAPTURE");
      render(result?.ok ? result.state : { status: "error", lastError: result?.error, capturedSegments: [], capturedBytes: 0 });
    });
    $("stopButton").addEventListener("click", async () => {
      const result = await send("STOP_MEDIA_CAPTURE");
      render(result?.ok ? result.state : { ...(state || {}), lastError: result?.error });
    });
    $("saveButton").addEventListener("click", async () => {
      const result = await send("DOWNLOAD_MEDIA_CONTENT");
      if (!result?.ok) {
        render({ ...(state || {}), lastError: result?.error });
        return;
      }
      const suffix = result.failures?.length ? `，${result.failures.length} 份失败` : "";
      $("statusText").textContent = `已保存 ${result.count} 份内容到下载目录${suffix}`;
    });
  }

  return { install, render, getState: () => state };
}
