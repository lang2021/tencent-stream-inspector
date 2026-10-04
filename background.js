import { FEATURE_FLAGS } from "./features/feature-flags.js";
import { createTabRecordingModule } from "./features/tab-recording/background.js";
import { createMediaCaptureModule } from "./features/media-capture/background.js";

const runtime = {
  recordingModule: null,
  mediaCaptureModule: null,
  async isRecordingBusy() {
    return this.recordingModule ? this.recordingModule.isBusy() : false;
  },
  async isMediaCaptureBusy(tabId) {
    return this.mediaCaptureModule ? this.mediaCaptureModule.isBusy(tabId) : false;
  }
};

runtime.recordingModule = FEATURE_FLAGS.tabRecording.enabled
  ? createTabRecordingModule(runtime)
  : null;
runtime.mediaCaptureModule = FEATURE_FLAGS.mediaCapture.enabled
  ? createMediaCaptureModule(runtime)
  : null;

const modules = [runtime.recordingModule, runtime.mediaCaptureModule].filter(Boolean);
for (const module of modules) module.register();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === "offscreen") return false;

  (async () => {
    const module = modules.find((candidate) => candidate.handles(message));
    if (!module) throw new Error("当前未启用此功能模块");
    return module.handleMessage(message, sender);
  })().then(respond).catch((error) => respond({ ok: false, error: error.message }));

  return true;
});
