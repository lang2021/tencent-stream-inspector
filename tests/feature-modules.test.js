const assert = require("node:assert/strict");
const test = require("node:test");

test("media capture is dormant by default and does not register debugger listeners", async () => {
  let runtimeMessageListener = null;
  let debuggerEventRegistrations = 0;
  const chrome = {
    runtime: {
      getURL: (name) => name,
      async getContexts() { return []; },
      async sendMessage() { return { ok: true }; },
      onMessage: { addListener(listener) { runtimeMessageListener = listener; } }
    },
    downloads: { onChanged: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    debugger: {
      onEvent: { addListener() { debuggerEventRegistrations += 1; } },
      onDetach: { addListener() { debuggerEventRegistrations += 1; } },
      sendCommand() {}
    },
    offscreen: { async createDocument() {} }
  };
  globalThis.chrome = chrome;
  await import(`../background.js?feature-test=${Date.now()}`);

  assert.equal(debuggerEventRegistrations, 0);
  assert.ok(runtimeMessageListener);
  const response = await new Promise((resolve) => {
    runtimeMessageListener({ type: "START_MEDIA_CAPTURE", tabId: 1 }, {}, resolve);
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /未启用/);
});

test("media capture module registers its debugger listeners when explicitly constructed", async () => {
  let debuggerEventRegistrations = 0;
  globalThis.chrome = {
    debugger: {
      onEvent: { addListener() { debuggerEventRegistrations += 1; } },
      onDetach: { addListener() { debuggerEventRegistrations += 1; } }
    },
    runtime: { lastError: null, async sendMessage() { return { ok: true }; } }
  };
  const { createMediaCaptureModule } = await import(`../features/media-capture/background.js?feature-test=${Date.now()}`);
  const module = createMediaCaptureModule({ isRecordingBusy: async () => false });
  module.register();
  assert.equal(debuggerEventRegistrations, 2);
  assert.equal(module.handles({ type: "START_MEDIA_CAPTURE" }), true);
  assert.equal(await module.isBusy(1), false);
});

test("enabled media capture module preserves start and stop flow", async () => {
  let attached = false;
  const commands = [];
  globalThis.chrome = {
    debugger: {
      async attach() { attached = true; },
      async detach() { attached = false; },
      sendCommand(_target, method, _params, callback) {
        commands.push(method);
        callback(method === "Runtime.evaluate" ? { result: { value: [] } } : {});
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} }
    },
    runtime: { lastError: null, async sendMessage() { return { ok: true }; } },
    tabs: { async get() { return { url: "https://example.test/video" }; } }
  };
  const { createMediaCaptureModule } = await import(`../features/media-capture/background.js?flow-test=${Date.now()}`);
  const module = createMediaCaptureModule({ isRecordingBusy: async () => false });
  const started = await module.handleMessage({ type: "START_MEDIA_CAPTURE", tabId: 9 });
  assert.equal(started.ok, true);
  assert.equal(started.state.status, "running");
  assert.equal(attached, true);
  assert.deepEqual(commands, ["Network.enable", "Runtime.evaluate"]);
  const stopped = await module.handleMessage({ type: "STOP_MEDIA_CAPTURE", tabId: 9 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.status, "stopped");
  assert.equal(attached, false);
});
