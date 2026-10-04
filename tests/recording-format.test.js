const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8");
const preferredMimeType = "video/mp4;codecs=avc1.640028,mp4a.40.2";

function makeHarness({ files = [], recoveryMeta = null } = {}) {
  let onRuntimeMessage = null;
  let storedMeta = recoveryMeta;
  const workerMessages = [];

  class FakeWorker {
    constructor() {
      this.listeners = { message: [], error: [] };
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    postMessage(message) {
      workerMessages.push(message);
      queueMicrotask(() => {
        const payload = message.type === "list" ? { files } : {};
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
        return type === preferredMimeType;
      }
    },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    navigator: {
      storage: {
        async getDirectory() {
          return {
            async getFileHandle(fileName) {
              const entry = files.find((file) => file.fileName === fileName);
              if (!entry) throw new Error("missing test file");
              return {
                async getFile() {
                  return { size: entry.byteSize, lastModified: entry.lastModified };
                }
              };
            }
          };
        }
      }
    },
    chrome: {
      runtime: {
        getURL: (name) => name,
        onMessage: { addListener(listener) { onRuntimeMessage = listener; } },
        async sendMessage(message) {
          if (message.type === "OFFSCREEN_RECORDING_COMPLETE") {
            return { ok: true, downloadId: 42 };
          }
          if (message.type !== "OFFSCREEN_RECOVERY_STORAGE") return { ok: true };
          if (message.action === "get") return { ok: true, value: storedMeta };
          if (message.action === "set") storedMeta = message.value;
          if (message.action === "remove") storedMeta = null;
          return { ok: true };
        }
      }
    }
  };
  vm.runInNewContext(source, context, { filename: "offscreen.js" });

  return {
    context,
    workerMessages,
    send(message) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("offscreen response timeout")), 1_000);
        onRuntimeMessage({ target: "offscreen", ...message }, {}, (response) => {
          clearTimeout(timeout);
          resolve(response);
        });
      });
    }
  };
}

function makeStartHarness() {
  const openedFiles = [];
  const recorderOptions = [];
  const startIntervals = [];

  class FakeWorker {
    constructor() {
      this.listeners = { message: [], error: [] };
    }

    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }

    postMessage(message) {
      if (message.type === "open") openedFiles.push(message.fileName);
      queueMicrotask(() => {
        const payload = message.type === "list" ? { files: [] } : {};
        for (const listener of this.listeners.message) {
          listener({ data: { requestId: message.requestId, ok: true, ...payload } });
        }
      });
    }
  }

  class FakeMediaRecorder {
    static isTypeSupported(type) {
      return type === preferredMimeType;
    }

    constructor(stream, options) {
      this.state = "inactive";
      this.mimeType = options.mimeType;
      this.listeners = {};
      recorderOptions.push(options);
    }

    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }

    start(interval) {
      this.state = "recording";
      startIntervals.push(interval);
    }
  }

  const capturedStream = {
    getAudioTracks: () => [],
    getTracks: () => []
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Worker: FakeWorker,
    MediaRecorder: FakeMediaRecorder,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    navigator: {
      storage: {},
      mediaDevices: { async getUserMedia() { return capturedStream; } }
    },
    chrome: {
      runtime: {
        getURL: (name) => name,
        onMessage: { addListener() {} },
        async sendMessage(message) {
          if (message.type === "OFFSCREEN_RECOVERY_STORAGE" && message.action === "get") {
            return { ok: true, value: null };
          }
          return { ok: true };
        }
      }
    }
  };
  vm.runInNewContext(source, context, { filename: "offscreen.js" });
  return { context, openedFiles, recorderOptions, startIntervals };
}

test("new recording helpers select MP4 without a WebM fallback", () => {
  const { context } = makeHarness();
  const capabilities = context.recordingCapabilities();

  assert.equal(capabilities.mp4Supported, true);
  assert.equal(capabilities.mimeType, preferredMimeType);
  assert.match(context.recordingFilename(Date.UTC(2026, 9, 4), preferredMimeType), /\.mp4$/);
  assert.match(context.recordingFileName(Date.UTC(2026, 9, 4), preferredMimeType), /\.mp4$/);
  assert.equal(context.mimeTypeForFileName("authorized-tab-recording-old.webm"), "video/webm");
  assert.equal(context.mimeTypeForFileName("authorized-tab-recording-new.mp4"), "video/mp4");
});

test("new recordings create an MP4 file and pass the selected MIME to MediaRecorder", async () => {
  const harness = makeStartHarness();
  const state = await harness.context.startRecording("stream-id", 12, {
    mimeType: preferredMimeType,
    requested: false,
    active: false
  });

  assert.equal(state.status, "recording");
  assert.equal(state.mimeType, preferredMimeType);
  assert.equal(harness.openedFiles.length, 1);
  assert.match(harness.openedFiles[0], /\.mp4$/);
  assert.equal(harness.recorderOptions[0].mimeType, preferredMimeType);
  assert.equal(harness.recorderOptions[0].videoBitsPerSecond, 5_000_000);
  assert.equal(harness.recorderOptions[0].audioBitsPerSecond, 128_000);
  assert.deepEqual(harness.startIntervals, [5_000]);
});

test("legacy WebM recovery is inferred from its extension", async () => {
  const { send } = makeHarness({
    files: [{
      fileName: "authorized-tab-recording-legacy.webm",
      byteSize: 1234,
      lastModified: Date.UTC(2026, 9, 3)
    }]
  });

  const response = await send({ type: "OFFSCREEN_GET_STATE" });
  assert.equal(response.ok, true);
  assert.equal(response.state.recoveryAvailable, true);
  assert.equal(response.state.recoveryMimeType, "video/webm");
});

test("legacy WebM recovery exports unchanged and successful cleanup deletes its OPFS source", async () => {
  const sourceFileName = "authorized-tab-recording-legacy.webm";
  const harness = makeHarness({
    files: [{
      fileName: sourceFileName,
      byteSize: 1234,
      lastModified: Date.UTC(2026, 9, 3)
    }]
  });
  await harness.send({ type: "OFFSCREEN_GET_STATE" });

  const exported = await harness.send({ type: "OFFSCREEN_EXPORT_RECOVERY" });
  assert.equal(exported.ok, true);
  assert.equal(exported.state.mimeType, "video/webm");
  assert.match(exported.state.filename, /\.webm$/);

  const cleaned = await harness.send({
    type: "OFFSCREEN_CLEANUP_FILE",
    fileName: sourceFileName
  });
  assert.equal(cleaned.ok, true);
  assert.equal(
    harness.workerMessages.some((message) => message.type === "delete" && message.fileName === sourceFileName),
    true
  );
});

test("a failed recovery download keeps the OPFS source available", async () => {
  const sourceFileName = "authorized-tab-recording-retry.webm";
  const harness = makeHarness({
    files: [{
      fileName: sourceFileName,
      byteSize: 2468,
      lastModified: Date.UTC(2026, 9, 3)
    }]
  });
  await harness.send({ type: "OFFSCREEN_GET_STATE" });
  await harness.send({ type: "OFFSCREEN_EXPORT_RECOVERY" });

  const failed = await harness.send({
    type: "OFFSCREEN_DOWNLOAD_FAILED",
    fileName: sourceFileName,
    error: "cancelled"
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.state.recoveryAvailable, true);
  assert.equal(failed.state.recoveryMimeType, "video/webm");
  assert.equal(harness.workerMessages.some((message) => message.type === "delete"), false);
});

test("stale MP4 metadata cannot relabel a different WebM recovery file", async () => {
  const { send } = makeHarness({
    files: [{
      fileName: "authorized-tab-recording-legacy.webm",
      byteSize: 5678,
      lastModified: Date.UTC(2026, 9, 3)
    }],
    recoveryMeta: {
      fileName: "authorized-tab-recording-missing.mp4",
      mimeType: "video/mp4",
      filename: "authorized-tab-recording-missing.mp4",
      status: "recoverable"
    }
  });

  const response = await send({ type: "OFFSCREEN_GET_STATE" });
  assert.equal(response.ok, true);
  assert.equal(response.state.recoveryMimeType, "video/webm");
});
