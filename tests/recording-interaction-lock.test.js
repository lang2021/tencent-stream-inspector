const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function makeHarness() {
  const calls = [];
  const scheduled = [];
  const listeners = { message: null, updated: null, removed: null };
  let offscreenAvailable = false;
  let lockInjected = false;
  let injectionShouldFail = false;
  let nextDownloadId = 1;
  let offscreenState = {
    status: "idle",
    tabId: null,
    interactionLockRequested: false,
    interactionLockActive: false
  };

  const runtime = {
    lastError: null,
    getURL: (name) => name,
    async getContexts() { return offscreenAvailable ? [{}] : []; },
    sendMessage(message) {
      calls.push({ type: "runtime", message });
      if (message.target !== "offscreen") return Promise.resolve({ ok: true });
      if (message.type === "OFFSCREEN_GET_STATE") return Promise.resolve({ ok: true, state: offscreenState });
      if (message.type === "OFFSCREEN_START_RECORDING") {
        offscreenState = {
          ...offscreenState,
          status: "recording",
          tabId: message.tabId,
          interactionLockRequested: Boolean(message.interactionLockRequested),
          interactionLockActive: Boolean(message.interactionLockActive)
        };
        calls.push({ type: "offscreen-start", message });
        return Promise.resolve({ ok: true, state: offscreenState });
      }
      if (message.type === "OFFSCREEN_STOP_RECORDING") {
        offscreenState = {
          ...offscreenState,
          status: "stopping",
          interactionLockActive: false,
          terminationReason: message.reason || null
        };
        calls.push({ type: "offscreen-stop", message });
        return Promise.resolve({ ok: true, state: offscreenState });
      }
      if (message.type === "OFFSCREEN_SET_INTERACTION_LOCK") {
        offscreenState = {
          ...offscreenState,
          interactionLockRequested: Boolean(message.requested),
          interactionLockActive: Boolean(message.active),
          interactionLockError: message.error || null
        };
        calls.push({ type: "offscreen-lock", message });
        return Promise.resolve({ ok: true, state: offscreenState });
      }
      return Promise.resolve({ ok: true, state: offscreenState });
    },
    onMessage: { addListener(listener) { listeners.message = listener; } }
  };

  const context = {
    console,
    TextEncoder,
    URL,
    setTimeout(callback, delay) {
      const item = { callback, delay };
      scheduled.push(item);
      return item;
    },
    clearTimeout() {},
    chrome: {
      runtime,
      tabs: {
        async get(id) { return { id, url: "https://example.test/video" }; },
        onUpdated: { addListener(listener) { listeners.updated = listener; } },
        onRemoved: { addListener(listener) { listeners.removed = listener; } }
      },
      scripting: {
        async executeScript(details) {
          calls.push({ type: "script", details });
          if (details.files) {
            if (injectionShouldFail) throw new Error("注入失败");
            lockInjected = true;
            return [];
          }
          if (details.func?.toString().includes("isActive")) return [{ result: lockInjected }];
          lockInjected = false;
          return [{ result: { active: false } }];
        }
      },
      tabCapture: {
        async getMediaStreamId(details) {
          calls.push({ type: "capture", details });
          return "stream-id";
        }
      },
      debugger: {
        sendCommand() {},
        onEvent: { addListener() {} },
        onDetach: { addListener() {} }
      },
      downloads: {
        async download() { return nextDownloadId++; },
        onChanged: { addListener() {} }
      },
      offscreen: {
        async createDocument() { offscreenAvailable = true; }
      },
      storage: {
        local: {
          async get() { return {}; },
          async set() {},
          async remove() {}
        }
      }
    }
  };
  vm.runInNewContext(source, context, { filename: "background.js" });

  return {
    calls,
    scheduled,
    listeners,
    setInjectionFailure(value) { injectionShouldFail = value; },
    setIdle() {
      offscreenState = {
        ...offscreenState,
        status: "idle",
        tabId: null,
        interactionLockRequested: false,
        interactionLockActive: false
      };
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const timeout = global.setTimeout(() => reject(new Error("background response timeout")), 1_000);
        listeners.message(message, {}, (response) => {
          global.clearTimeout(timeout);
          resolve(response);
        });
      });
    }
  };
}

test("isolation starts immediately after injection and injection failure is fail-closed", async () => {
  const harness = makeHarness();

  const ordinaryStart = harness.send({ type: "START_TAB_RECORDING", tabId: 7, interactionLockEnabled: false });
  const ordinaryResult = await ordinaryStart;
  assert.equal(ordinaryResult.ok, true);
  assert.equal(harness.calls.some((call) => call.type === "script"), false);
  assert.equal(harness.calls.some((call) => call.type === "capture"), true);

  const ordinaryStop = await harness.send({ type: "STOP_TAB_RECORDING", tabId: 7 });
  assert.equal(ordinaryStop.ok, true);
  harness.setIdle();
  harness.calls.length = 0;

  const isolatedResult = await harness.send({ type: "START_TAB_RECORDING", tabId: 7, interactionLockEnabled: true });
  const fileIndex = harness.calls.findIndex((call) => call.type === "script" && call.details.files);
  assert.ok(fileIndex >= 0);
  assert.equal(isolatedResult.ok, true);
  assert.equal(harness.scheduled.some((item) => item.delay === 2_000), false);
  const captureIndex = harness.calls.findIndex((call) => call.type === "capture");
  assert.ok(fileIndex < captureIndex);

  await harness.send({ type: "STOP_TAB_RECORDING", tabId: 7 });
  harness.setIdle();
  harness.calls.length = 0;
  harness.setInjectionFailure(true);
  const failed = await harness.send({ type: "START_TAB_RECORDING", tabId: 7, interactionLockEnabled: true });
  assert.equal(failed.ok, false);
  assert.equal(harness.calls.some((call) => call.type === "capture"), false);
});

test("mouse isolation can be enabled and disabled while recording", async () => {
  const harness = makeHarness();
  assert.equal((await harness.send({
    type: "START_TAB_RECORDING",
    tabId: 8,
    interactionLockEnabled: false
  })).ok, true);

  const enabled = await harness.send({
    type: "SET_RECORDING_INTERACTION_LOCK",
    tabId: 8,
    enabled: true
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.state.interactionLockActive, true);
  assert.equal(harness.calls.some((call) => call.type === "offscreen-lock" && call.message.active), true);

  const disabled = await harness.send({
    type: "SET_RECORDING_INTERACTION_LOCK",
    tabId: 8,
    enabled: false
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.state.interactionLockActive, false);
  assert.equal(harness.calls.some((call) => call.type === "script" && call.details.func?.toString().includes("deactivate")), true);

  const stopsBeforeNavigation = harness.calls.filter((call) => call.type === "offscreen-stop").length;
  harness.listeners.updated(8, { status: "loading" });
  await new Promise((resolve) => global.setImmediate(resolve));
  assert.equal(
    harness.calls.filter((call) => call.type === "offscreen-stop").length,
    stopsBeforeNavigation,
    "navigation should not stop recording after isolation is disabled"
  );
});

test("a failed runtime enable keeps the recording running", async () => {
  const harness = makeHarness();
  assert.equal((await harness.send({
    type: "START_TAB_RECORDING",
    tabId: 10,
    interactionLockEnabled: false
  })).ok, true);
  harness.setInjectionFailure(true);

  const result = await harness.send({
    type: "SET_RECORDING_INTERACTION_LOCK",
    tabId: 10,
    enabled: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.state.status, "recording");
  assert.equal(result.state.interactionLockActive, false);
  assert.equal(harness.calls.some((call) => call.type === "offscreen-stop"), false);
});

test("navigation stops an isolated recording and unlocks the tab", async () => {
  const harness = makeHarness();
  assert.equal((await harness.send({
    type: "START_TAB_RECORDING",
    tabId: 9,
    interactionLockEnabled: true
  })).ok, true);

  harness.listeners.updated(9, { status: "loading" });
  await new Promise((resolve) => global.setImmediate(resolve));
  assert.equal(harness.calls.some((call) => call.type === "offscreen-stop"), true);
  assert.equal(harness.calls.some((call) => call.type === "script" && call.details.func?.toString().includes("deactivate")), true);
});
