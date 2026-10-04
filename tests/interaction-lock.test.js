const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "interaction-lock.js"), "utf8");

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

class FakeElement extends FakeEventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.style = {
      cssText: "",
      setProperty: (name, value) => {
        this.style[name] = value;
        this.style[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      }
    };
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
  }

  setAttribute() {}

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  attachShadow() {
    this.shadowRoot = new FakeElement("#shadow-root");
    return this.shadowRoot;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  get offsetWidth() {
    return 0;
  }
}

function makeContext() {
  const timeouts = new Map();
  let nextTimer = 0;
  const document = new FakeEventTarget();
  document.documentElement = new FakeElement("html");
  document.createElement = (tagName) => new FakeElement(tagName);
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
  vm.runInNewContext(source, context, { filename: "interaction-lock.js" });
  return {
    context,
    document,
    timeouts,
    host() { return document.documentElement.children[0]; }
  };
}

test("interaction shield is idempotent and lease expiry releases interception", () => {
  const harness = makeContext();
  const controller = harness.context.__authorizedStreamInspectorInteractionLock;
  assert.equal(controller.isActive(), true);
  assert.equal(harness.document.documentElement.children.length, 1);
  assert.equal(harness.host().style.pointerEvents, "auto");

  vm.runInNewContext(source, harness.context, { filename: "interaction-lock.js" });
  assert.equal(harness.document.documentElement.children.length, 1);
  assert.equal(harness.context.__authorizedStreamInspectorInteractionLock.isActive(), true);

  const lease = [...harness.timeouts.values()].find((entry) => entry.delay === 12_000);
  assert.ok(lease, "a 12 second safety lease should be scheduled");
  lease.callback();
  const host = harness.host();
  const shield = host.shadowRoot.children[1];
  assert.equal(host.style.pointerEvents, "none");
  assert.equal(shield.style.pointerEvents, "none");

  harness.context.__authorizedStreamInspectorInteractionLock.deactivate();
  assert.equal(harness.document.documentElement.children.length, 0);
  assert.equal(harness.context.__authorizedStreamInspectorInteractionLock, undefined);
});
