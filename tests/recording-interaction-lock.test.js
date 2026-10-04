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
          interactionLockActive: Boolean(message.interactionLockActive),
          lockSettlesAt: null
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
    setIdle() { offscreenState = { ...offscreenState, status: "idle", tabId: null, interactionLockActive: false }; },
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

test("isolation starts after injection and settle delay, and injection failure is fail-closed", async () => {
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

  const isolatedStart = harness.send({ type: "START_TAB_RECORDING", tabId: 7, interactionLockEnabled: true });
  await new Promise((resolve) => global.setImmediate(resolve));
  const fileIndex = harness.calls.findIndex((call) => call.type === "script" && call.details.files);
  const waitIndex = harness.scheduled.findIndex((item) => item.delay === 2_000);
  assert.ok(fileIndex >= 0);
  assert.ok(waitIndex >= 0);
  assert.equal(harness.calls.some((call) => call.type === "capture"), false);
  harness.scheduled[waitIndex].callback();
  const isolatedResult = await isolatedStart;
  assert.equal(isolatedResult.ok, true);
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

test("navigation stops an isolated recording and unlocks the tab", async () => {
  const harness = makeHarness();
  const start = harness.send({ type: "START_TAB_RECORDING", tabId: 9, interactionLockEnabled: true });
  await new Promise((resolve) => global.setImmediate(resolve));
  harness.scheduled.find((item) => item.delay === 2_000).callback();
  assert.equal((await start).ok, true);

  harness.listeners.updated(9, { status: "loading" });
  await new Promise((resolve) => global.setImmediate(resolve));
  assert.equal(harness.calls.some((call) => call.type === "offscreen-stop"), true);
  assert.equal(harness.calls.some((call) => call.type === "script" && call.details.func?.toString().includes("deactivate")), true);
});
