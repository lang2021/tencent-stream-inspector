const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const storage = new Map();
let onRuntimeMessage = null;

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
      onMessage: { addListener(listener) { onRuntimeMessage = listener; } }
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

vm.runInNewContext(source, context, { filename: "background.js" });

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("background response timeout")), 1_000);
    onRuntimeMessage(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

(async () => {
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
