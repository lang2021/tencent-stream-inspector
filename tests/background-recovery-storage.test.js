const assert = require("node:assert/strict");
const storage = new Map();

const context = {
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  URL,
  atob,
  chrome: {
    debugger: {
      sendCommand() {},
      onEvent: { addListener() {} },
      onDetach: { addListener() {} }
    },
    runtime: {
      lastError: null,
      getURL: (name) => name,
      async getContexts() { return []; },
      async sendMessage() { return { ok: true }; },
      onMessage: { addListener() {} }
    },
    downloads: {
      async download() { return 1; },
      onChanged: { addListener() {} }
    },
    offscreen: { async createDocument() {} },
    storage: {
      local: {
        async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
        async get(key) { return { [key]: storage.get(key) }; },
        async remove(key) { storage.delete(key); }
      }
    },
    tabs: { async get() { return {}; } }
  }
};

(async () => {
  globalThis.chrome = context.chrome;
  const { createTabRecordingModule } = await import("../features/tab-recording/background.js");
  const module = createTabRecordingModule({ isMediaCaptureBusy: async () => false });
  async function sendToBackground(message) {
    return module.handleMessage(message);
  }

  const value = { fileName: "recording.webm", status: "recording", bytes: 123 };
  assert.equal((await sendToBackground({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "set",
    value
  })).ok, true);

  const read = await sendToBackground({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "get"
  });
  assert.deepEqual(read.value, value);

  assert.equal((await sendToBackground({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "remove"
  })).ok, true);

  const afterRemove = await sendToBackground({
    target: "background",
    type: "OFFSCREEN_RECOVERY_STORAGE",
    action: "get"
  });
  assert.equal(afterRemove.value, null);
  console.log("background recovery storage bridge: PASS");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
