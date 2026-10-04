const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8");
let onRuntimeMessage = null;
const supportedTypes = [];

class FakeWorker {
  constructor() {
    this.listeners = { message: [], error: [] };
  }

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  postMessage(message) {
    queueMicrotask(() => {
      const payload = message.type === "list"
        ? { files: [] }
        : message.type === "close"
          ? { byteSize: 0, chunkCount: 0 }
          : {};
      for (const listener of this.listeners.message) {
        listener({ data: { requestId: message.requestId, ok: true, ...payload } });
      }
    });
  }
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  Worker: FakeWorker,
  MediaRecorder: {
    isTypeSupported(type) {
      supportedTypes.push(type);
      return type === "video/mp4;codecs=avc1.640028,mp4a.40.2";
    }
  },
  URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
  navigator: { storage: {} },
  chrome: {
    runtime: {
      getURL: (name) => name,
      onMessage: { addListener(listener) { onRuntimeMessage = listener; } },
      async sendMessage() { return { ok: true }; }
    }
  }
};

vm.runInNewContext(source, context, { filename: "offscreen.js" });

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("offscreen response timeout")), 1_000);
    onRuntimeMessage(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

(async () => {
  const response = await sendToOffscreen({
    target: "offscreen",
    type: "OFFSCREEN_GET_STATE"
  });
  assert.equal(
    response.ok,
    true,
    `offscreen state failed without chrome.storage: ${response.error}`
  );
  const capabilities = await sendToOffscreen({
    target: "offscreen",
    type: "OFFSCREEN_GET_RECORDING_CAPABILITIES"
  });
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.capabilities.mp4Supported, true);
  assert.equal(capabilities.capabilities.mimeType, "video/mp4;codecs=avc1.640028,mp4a.40.2");
  assert.deepEqual(supportedTypes, ["video/mp4;codecs=avc1.640028,mp4a.40.2"]);
  console.log("offscreen runtime-only context: PASS");
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
