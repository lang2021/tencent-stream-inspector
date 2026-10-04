import { FEATURE_FLAGS } from "./features/feature-flags.js";
import { createTabRecordingView } from "./features/tab-recording/popup.js";
import { createMediaCaptureView } from "./features/media-capture/popup.js";

let activeTabId = null;
let mediaCaptureState = null;
const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, tabId: activeTabId, ...extra }, resolve));
}

const recordingView = createTabRecordingView({
  $,
  send,
  getActiveTabId: () => activeTabId,
  getMediaCaptureState: () => mediaCaptureState
});

const mediaCaptureView = FEATURE_FLAGS.mediaCapture.enabled
  ? createMediaCaptureView({ $, send })
  : null;

function handleRuntimeMessage(message) {
  if (message.type === "MEDIA_CAPTURE_STATE" && message.state?.tabId === activeTabId) {
    mediaCaptureState = message.state;
    mediaCaptureView?.render(message.state);
    recordingView.render(recordingView.getState());
  }
  if (message.type === "RECORDING_STATE") recordingView.render(message.state);
}

async function init() {
  $("mediaCaptureModule").hidden = !FEATURE_FLAGS.mediaCapture.enabled;
  recordingView.install();
  mediaCaptureView?.install();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0]?.id || null;
  const recordingResult = activeTabId
    ? await send("GET_RECORDING_STATE")
    : { state: null };
  if (FEATURE_FLAGS.mediaCapture.enabled && activeTabId) {
    const captureResult = await send("GET_MEDIA_CAPTURE_STATE");
    mediaCaptureState = captureResult.state || null;
    mediaCaptureView.render(mediaCaptureState);
  }
  recordingView.render(recordingResult.state || null);
}

init();
