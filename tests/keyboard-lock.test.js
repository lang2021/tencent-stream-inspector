const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "keyboard-lock.js"), "utf8");

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }
}

function makeContext() {
  const timeouts = new Map();
  let nextTimer = 0;
  const document = new FakeEventTarget();
  const window = new FakeEventTarget();
  const context = {
    console,
    document,
    window,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "keyboard-lock.js" });
  return { context, document, window, timeouts };
}

test("keyboard lock blocks page keys, is idempotent, and lease expiry releases listeners", () => {
  const harness = makeContext();
  const controller = harness.context.__authorizedStreamInspectorKeyboardLock;
  assert.equal(controller.isActive(), true);
  assert.equal(harness.window.listeners.get("keydown").size, 1);
  assert.equal(harness.document.listeners.get("beforeinput").size, 1);

  const event = {
    prevented: false,
    immediateStopped: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.immediateStopped = true; },
    stopPropagation() { this.stopped = true; }
  };
  [...harness.window.listeners.get("keydown")][0](event);
  assert.equal(event.prevented, true);
  assert.equal(event.immediateStopped, true);
  assert.equal(event.stopped, true);

  vm.runInNewContext(source, harness.context, { filename: "keyboard-lock.js" });
  assert.equal(harness.window.listeners.get("keydown").size, 1);

  const lease = [...harness.timeouts.values()].find((entry) => entry.delay === 12_000);
  assert.ok(lease, "a 12 second safety lease should be scheduled");
  lease.callback();
  assert.equal(harness.context.__authorizedStreamInspectorKeyboardLock, undefined);
  assert.equal(harness.window.listeners.get("keydown").size, 0);
  assert.equal(harness.document.listeners.get("beforeinput").size, 0);
});
