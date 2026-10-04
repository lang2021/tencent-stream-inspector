const OFFSCREEN_DOCUMENT_URL = "offscreen.html";
const DOWNLOAD_KEY_PREFIX = "authorizedTabRecordingDownload:";
const RECOVERY_KEY = "authorizedTabRecordingRecovery";
const INTERACTION_LOCK_SCRIPT = "interaction-lock.js";
const KEYBOARD_LOCK_SCRIPT = "keyboard-lock.js";
const ACTIVE_RECORDING_STATUSES = new Set(["starting", "recording", "stopping", "saving"]);

export function createTabRecordingModule(runtime) {
  const chrome = globalThis.chrome;
  let creatingOffscreenDocument = null;
  let interactionLockTabId = null;
  let keyboardLockTabId = null;
  let pendingRecordingStart = null;
  let lastRecordingState = idleRecordingState();

  function idleRecordingState() {
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
      recoveryMimeType: null,
      lastError: null,
      interactionLockRequested: false,
      interactionLockActive: false,
      interactionLockError: null,
      keyboardLockRequested: false,
      keyboardLockActive: false,
      keyboardLockError: null,
      terminationReason: null
    };
  }

  function isRecordingActive(state) {
    return ACTIVE_RECORDING_STATUSES.has(state?.status);
  }

  function normalizeRecordingState(state) {
    return {
      ...state,
      interactionLockRequested: Boolean(state?.interactionLockRequested),
      interactionLockActive: Boolean(
        state?.interactionLockRequested &&
        interactionLockTabId === state?.tabId &&
        ACTIVE_RECORDING_STATUSES.has(state?.status)
      ),
      keyboardLockRequested: Boolean(state?.keyboardLockRequested),
      keyboardLockActive: Boolean(
        state?.keyboardLockRequested &&
        keyboardLockTabId === state?.tabId &&
        ACTIVE_RECORDING_STATUSES.has(state?.status)
      )
    };
  }

  function broadcastRecording(state) {
    const nextState = normalizeRecordingState(state);
    lastRecordingState = nextState;
    chrome.runtime.sendMessage({ type: "RECORDING_STATE", state: nextState }).catch(() => {});
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

  async function injectInteractionLock(tabId) {
    if (!chrome.scripting?.executeScript) {
      throw new Error("当前 Chrome 不支持脚本注入，无法启用鼠标隔离");
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: [INTERACTION_LOCK_SCRIPT] });
    const [confirmation] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__authorizedStreamInspectorInteractionLock?.isActive?.())
    });
    if (!confirmation?.result) throw new Error("无法确认鼠标隔离已启用");
  }

  async function releaseInteractionLock(tabId) {
    if (!tabId || interactionLockTabId !== tabId) return { ok: true, error: null };
    if (!chrome.scripting?.executeScript) {
      interactionLockTabId = null;
      return { ok: false, error: "当前 Chrome 无法立即解除鼠标隔离" };
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.__authorizedStreamInspectorInteractionLock?.deactivate?.() || { active: false }
      });
    } catch (error) {
      if (interactionLockTabId === tabId) interactionLockTabId = null;
      return { ok: false, error: `无法立即解除鼠标隔离：${error.message}` };
    }
    if (interactionLockTabId === tabId) interactionLockTabId = null;
    return { ok: true, error: null };
  }

  async function injectKeyboardLock(tabId) {
    if (!chrome.scripting?.executeScript) {
      throw new Error("当前 Chrome 不支持脚本注入，无法启用键盘隔离");
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: [KEYBOARD_LOCK_SCRIPT] });
    const [confirmation] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__authorizedStreamInspectorKeyboardLock?.isActive?.())
    });
    if (!confirmation?.result) throw new Error("无法确认键盘隔离已启用");
  }

  async function releaseKeyboardLock(tabId) {
    if (!tabId || keyboardLockTabId !== tabId) return { ok: true, error: null };
    if (!chrome.scripting?.executeScript) {
      keyboardLockTabId = null;
      return { ok: false, error: "当前 Chrome 无法立即解除键盘隔离" };
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.__authorizedStreamInspectorKeyboardLock?.deactivate?.() || { active: false }
      });
    } catch (error) {
      if (keyboardLockTabId === tabId) keyboardLockTabId = null;
      return { ok: false, error: `无法立即解除键盘隔离：${error.message}` };
    }
    if (keyboardLockTabId === tabId) keyboardLockTabId = null;
    return { ok: true, error: null };
  }

  async function releaseRecordingLocks(tabId) {
    const [pointer, keyboard] = await Promise.all([
      releaseInteractionLock(tabId),
      releaseKeyboardLock(tabId)
    ]);
    return {
      ok: pointer.ok && keyboard.ok,
      error: pointer.error || keyboard.error || null
    };
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
      if (result?.state) lastRecordingState = normalizeRecordingState(result.state);
    } catch {
      // Use the most recent state cached by the service worker.
    }
    return lastRecordingState;
  }

  async function savePendingDownload(downloadId, details) {
    await chrome.storage.local.set({ [`${DOWNLOAD_KEY_PREFIX}${downloadId}`]: details });
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
        await messageOffscreen("OFFSCREEN_CLEANUP_FILE", { fileName: pending.details.sourceFileName });
      } else if (delta.error?.current) {
        await messageOffscreen("OFFSCREEN_DOWNLOAD_FAILED", {
          fileName: pending.details.sourceFileName,
          error: delta.error.current
        });
      }
      await chrome.storage.local.remove(pending.key);
    } catch {
      // Keep the OPFS source and mapping recoverable when the offscreen page is unavailable.
    }
  }

  async function stopRecordingForNavigation(tabId) {
    const pending = pendingRecordingStart;
    if (pending?.tabId === tabId) {
      pending.cancelled = true;
      pending.cancelReason = "页面发生导航，已取消录制启动";
      await releaseRecordingLocks(tabId);
      if (lastRecordingState.tabId === tabId && lastRecordingState.status === "starting") {
        broadcastRecording({
          ...lastRecordingState,
          status: "error",
          interactionLockActive: false,
          interactionLockError: pending.cancelReason,
          keyboardLockActive: false,
          keyboardLockError: pending.cancelReason,
          lastError: pending.cancelReason
        });
      }
      return;
    }

    const current = lastRecordingState;
    if (current.tabId !== tabId ||
        (!current.interactionLockActive && !current.keyboardLockActive) ||
        !isRecordingActive(current)) return;

    const reason = "页面发生导航，已停止录制以保持交互隔离";
    try {
      const result = await messageOffscreen("OFFSCREEN_STOP_RECORDING", { reason });
      await releaseRecordingLocks(tabId);
      if (!result?.ok) throw new Error(result?.error || "页面导航时无法停止录制");
      broadcastRecording({ ...result.state, terminationReason: reason });
    } catch (error) {
      await releaseRecordingLocks(tabId);
      broadcastRecording({
        ...current,
        status: "error",
        interactionLockActive: false,
        keyboardLockActive: false,
        terminationReason: reason,
        lastError: error.message
      });
    }
  }

  async function handleMessage(message) {
    if (message.target === "background" && message.type === "OFFSCREEN_RECORDING_STATE") {
      if (message.state?.tabId && !isRecordingActive(message.state)) {
        await releaseRecordingLocks(message.state.tabId);
      }
      broadcastRecording(message.state);
      return { ok: true };
    }

    if (message.target === "background" && message.type === "OFFSCREEN_RECOVERY_STORAGE") {
      if (message.action === "get") {
        const stored = await chrome.storage.local.get(RECOVERY_KEY);
        return { ok: true, value: stored?.[RECOVERY_KEY] || null };
      }
      if (message.action === "set") {
        await chrome.storage.local.set({ [RECOVERY_KEY]: message.value });
        return { ok: true };
      }
      if (message.action === "remove") {
        await chrome.storage.local.remove(RECOVERY_KEY);
        return { ok: true };
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
      return { ok: true, downloadId };
    }

    if (message.type === "GET_RECORDING_STATE") {
      return { ok: true, state: await getRecordingState() };
    }

    if (message.type === "SET_RECORDING_INTERACTION_LOCK") {
      const recordingState = await getRecordingState();
      if (recordingState.status !== "recording" || !recordingState.tabId) {
        throw new Error("只有正在录制时才能切换鼠标隔离");
      }
      const enabled = message.enabled === true;
      const tabId = recordingState.tabId;
      if (enabled) {
        try {
          await injectInteractionLock(tabId);
          interactionLockTabId = tabId;
          const result = await messageOffscreen("OFFSCREEN_SET_INTERACTION_LOCK", {
            requested: true, active: true, error: null
          });
          if (!result?.ok) throw new Error(result?.error || "无法更新鼠标隔离状态");
          broadcastRecording(result.state);
          return { ok: true, state: lastRecordingState };
        } catch (error) {
          await releaseInteractionLock(tabId);
          const result = await messageOffscreen("OFFSCREEN_SET_INTERACTION_LOCK", {
            requested: false, active: false, error: error.message
          }).catch(() => null);
          if (result?.state) broadcastRecording(result.state);
          return { ok: false, error: error.message, state: lastRecordingState };
        }
      }
      const released = await releaseInteractionLock(tabId);
      const result = await messageOffscreen("OFFSCREEN_SET_INTERACTION_LOCK", {
        requested: false,
        active: false,
        error: released.ok ? null : released.error
      });
      if (!result?.ok) throw new Error(result?.error || "无法更新鼠标隔离状态");
      broadcastRecording(result.state);
      return { ok: released.ok, error: released.error, state: lastRecordingState };
    }

    if (message.type === "SET_RECORDING_KEYBOARD_LOCK") {
      const recordingState = await getRecordingState();
      if (recordingState.status !== "recording" || !recordingState.tabId) {
        throw new Error("只有正在录制时才能切换键盘隔离");
      }
      const enabled = message.enabled === true;
      const tabId = recordingState.tabId;
      if (enabled) {
        try {
          await injectKeyboardLock(tabId);
          keyboardLockTabId = tabId;
          const result = await messageOffscreen("OFFSCREEN_SET_KEYBOARD_LOCK", {
            requested: true, active: true, error: null
          });
          if (!result?.ok) throw new Error(result?.error || "无法更新键盘隔离状态");
          broadcastRecording(result.state);
          return { ok: true, state: lastRecordingState };
        } catch (error) {
          await releaseKeyboardLock(tabId);
          const result = await messageOffscreen("OFFSCREEN_SET_KEYBOARD_LOCK", {
            requested: false, active: false, error: error.message
          }).catch(() => null);
          if (result?.state) broadcastRecording(result.state);
          return { ok: false, error: error.message, state: lastRecordingState };
        }
      }
      const released = await releaseKeyboardLock(tabId);
      const result = await messageOffscreen("OFFSCREEN_SET_KEYBOARD_LOCK", {
        requested: false,
        active: false,
        error: released.ok ? null : released.error
      });
      if (!result?.ok) throw new Error(result?.error || "无法更新键盘隔离状态");
      broadcastRecording(result.state);
      return { ok: released.ok, error: released.error, state: lastRecordingState };
    }

    if (message.type === "START_TAB_RECORDING") {
      const tabId = message.tabId;
      if (!tabId) throw new Error("没有找到活动标签页");
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !/^https?:/i.test(tab.url)) throw new Error("只支持 HTTP/HTTPS 页面");
      if (await runtime.isMediaCaptureBusy(tabId)) {
        throw new Error("请先停止媒体数据捕获，再开始标签页录屏");
      }
      const recordingState = await getRecordingState();
      if (isRecordingActive(recordingState)) throw new Error("已有标签页正在录制或保存");

      const interactionLockRequested = message.interactionLockEnabled === true;
      const keyboardLockRequested = message.keyboardLockEnabled === true;
      const startAttempt = { tabId, cancelled: false, cancelReason: null };
      let interactionLockFailure = null;
      let keyboardLockFailure = null;
      pendingRecordingStart = startAttempt;
      try {
        await ensureOffscreenDocument();
        const capabilityResult = await messageOffscreen("OFFSCREEN_GET_RECORDING_CAPABILITIES");
        const selectedMimeType = capabilityResult?.capabilities?.mimeType;
        if (!capabilityResult?.ok || !capabilityResult.capabilities?.mp4Supported || !selectedMimeType) {
          throw new Error(capabilityResult?.error || "当前 Chrome 或系统不支持直接录制 H.264/AAC MP4");
        }
        lastRecordingState = {
          ...lastRecordingState,
          status: "starting",
          tabId,
          startedAt: Date.now(),
          stoppedAt: null,
          durationMs: 0,
          bytes: 0,
          pendingBytes: 0,
          mimeType: selectedMimeType,
          filename: null,
          sourceFileName: null,
          downloadId: null,
          storageBackend: "opfs",
          lastError: null,
          interactionLockRequested,
          interactionLockActive: false,
          interactionLockError: null,
          keyboardLockRequested,
          keyboardLockActive: false,
          keyboardLockError: null,
          terminationReason: null
        };
        broadcastRecording(lastRecordingState);

        if (interactionLockRequested) {
          try { await injectInteractionLock(tabId); }
          catch (error) { interactionLockFailure = error.message; throw error; }
          interactionLockTabId = tabId;
          broadcastRecording({ ...lastRecordingState, interactionLockActive: true });
          if (startAttempt.cancelled) throw new Error(startAttempt.cancelReason || "录制启动已取消");
        }
        if (keyboardLockRequested) {
          try { await injectKeyboardLock(tabId); }
          catch (error) { keyboardLockFailure = error.message; throw error; }
          keyboardLockTabId = tabId;
          broadcastRecording({ ...lastRecordingState, keyboardLockActive: true });
          if (startAttempt.cancelled) throw new Error(startAttempt.cancelReason || "录制启动已取消");
        }

        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        if (startAttempt.cancelled) throw new Error(startAttempt.cancelReason || "录制启动已取消");
        const result = await messageOffscreen("OFFSCREEN_START_RECORDING", {
          streamId,
          tabId,
          mimeType: selectedMimeType,
          interactionLockRequested,
          interactionLockActive: interactionLockRequested,
          keyboardLockRequested,
          keyboardLockActive: keyboardLockRequested
        });
        if (!result?.ok) throw new Error(result?.error || "无法开始录制当前标签页");
        if (startAttempt.cancelled) {
          await messageOffscreen("OFFSCREEN_STOP_RECORDING", {
            reason: startAttempt.cancelReason || "页面发生导航，已停止录制"
          });
          throw new Error(startAttempt.cancelReason || "录制启动已取消");
        }
        pendingRecordingStart = null;
        broadcastRecording(result.state);
        return { ok: true, state: lastRecordingState };
      } catch (error) {
        pendingRecordingStart = null;
        await releaseRecordingLocks(tabId);
        lastRecordingState = {
          ...lastRecordingState,
          status: "error",
          durationMs: 0,
          bytes: 0,
          interactionLockActive: false,
          interactionLockError: interactionLockFailure,
          keyboardLockActive: false,
          keyboardLockError: keyboardLockFailure,
          lastError: error.message
        };
        broadcastRecording(lastRecordingState);
        throw error;
      }
    }

    if (message.type === "STOP_TAB_RECORDING") {
      if (!(await hasOffscreenDocument())) {
        await releaseRecordingLocks(lastRecordingState.tabId);
        throw new Error("当前没有标签页录制会话");
      }
      const recordingState = await getRecordingState();
      const result = await messageOffscreen("OFFSCREEN_STOP_RECORDING");
      if (!result?.ok) throw new Error(result?.error || "无法停止标签页录制");
      await releaseRecordingLocks(recordingState.tabId || result.state?.tabId);
      broadcastRecording(result.state);
      return { ok: true, state: lastRecordingState };
    }

    if (message.type === "EXPORT_RECOVERABLE_RECORDING") {
      const recordingState = await getRecordingState();
      if (recordingState.status === "recording" || recordingState.status === "saving") {
        throw new Error("请先停止当前标签页录制");
      }
      const result = await messageOffscreen("OFFSCREEN_EXPORT_RECOVERY");
      if (!result?.ok) throw new Error(result?.error || "无法导出未完成录像");
      lastRecordingState = result.state;
      return { ok: true, state: result.state };
    }

    throw new Error("未知录屏操作");
  }

  function register() {
    chrome.downloads.onChanged.addListener((delta) => {
      if (delta.state?.current === "complete" || delta.error?.current) {
        finishRecordingDownload(delta.id, delta).catch(() => {});
      }
    });
    chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "loading") stopRecordingForNavigation(tabId).catch(() => {});
    });
    chrome.tabs?.onRemoved?.addListener((tabId) => {
      if (pendingRecordingStart?.tabId === tabId) {
        pendingRecordingStart.cancelled = true;
        pendingRecordingStart.cancelReason = "标签页已关闭，已取消录制启动";
      }
      if (interactionLockTabId === tabId) interactionLockTabId = null;
      if (keyboardLockTabId === tabId) keyboardLockTabId = null;
    });
  }

  return {
    name: "tabRecording",
    handles(message) {
      return message.type === "GET_RECORDING_STATE" ||
        message.type === "START_TAB_RECORDING" ||
        message.type === "STOP_TAB_RECORDING" ||
        message.type === "EXPORT_RECOVERABLE_RECORDING" ||
        message.type === "SET_RECORDING_INTERACTION_LOCK" ||
        message.type === "SET_RECORDING_KEYBOARD_LOCK" ||
        (message.target === "background" && [
          "OFFSCREEN_RECORDING_STATE",
          "OFFSCREEN_RECOVERY_STORAGE",
          "OFFSCREEN_RECORDING_COMPLETE"
        ].includes(message.type));
    },
    handleMessage,
    register,
    async isBusy() {
      return isRecordingActive(await getRecordingState());
    },
    getCachedState() {
      return lastRecordingState;
    }
  };
}
