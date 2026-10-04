const FILE_PREFIX = "authorized-tab-recording-";
const SUPPORTED_RECORDING_EXTENSIONS = [".mp4", ".webm"];

let fileName = null;
let syncHandle = null;
let offset = 0;
let chunkCount = 0;
let lastFlushAt = 0;
let closed = false;
let queue = Promise.resolve();

function errorPayload(error) {
  return {
    error: String(error?.message || error),
    errorName: error?.name || "Error"
  };
}

function respond(requestId, type, payload = {}) {
  self.postMessage({ requestId, type, ...payload });
}

async function getDirectory() {
  if (!navigator.storage?.getDirectory) {
    throw new Error("当前 Chrome 不支持 OPFS 文件存储");
  }
  return navigator.storage.getDirectory();
}

async function listFiles() {
  const directory = await getDirectory();
  const files = [];
  for await (const [name, handle] of directory.entries()) {
    if (!name.startsWith(FILE_PREFIX) ||
        !SUPPORTED_RECORDING_EXTENSIONS.some((extension) => name.endsWith(extension))) continue;
    try {
      const file = await handle.getFile();
      files.push({
        fileName: name,
        byteSize: file.size,
        lastModified: file.lastModified
      });
    } catch {}
  }
  return { files: files.sort((a, b) => b.lastModified - a.lastModified) };
}

async function openFile(nextFileName) {
  if (syncHandle) throw new Error("OPFS 录制文件已经打开");
  const directory = await getDirectory();
  const handle = await directory.getFileHandle(nextFileName, { create: true });
  if (typeof handle.createSyncAccessHandle !== "function") {
    throw new Error("当前 Chrome 不支持 OPFS Worker 写入");
  }
  syncHandle = await handle.createSyncAccessHandle();
  syncHandle.truncate(0);
  fileName = nextFileName;
  offset = 0;
  chunkCount = 0;
  lastFlushAt = performance.now();
  closed = false;
  return { fileName };
}

async function writeBuffer(buffer) {
  if (closed || !syncHandle) throw new Error("OPFS 写入器未打开");
  const bytes = new Uint8Array(buffer);
  const written = syncHandle.write(bytes, { at: offset });
  const actual = typeof written === "number" ? written : bytes.byteLength;
  if (actual !== bytes.byteLength) {
    throw new Error(`OPFS 写入不完整：${actual}/${bytes.byteLength}`);
  }
  offset += actual;
  chunkCount += 1;
  if (performance.now() - lastFlushAt >= 10_000) {
    syncHandle.flush();
    lastFlushAt = performance.now();
  }
  return { byteSize: offset, chunkCount };
}

function closeFile() {
  if (!syncHandle) {
    return { fileName, byteSize: offset, chunkCount };
  }
  syncHandle.flush();
  const byteSize = typeof syncHandle.getSize === "function" ? syncHandle.getSize() : offset;
  syncHandle.close();
  syncHandle = null;
  closed = true;
  return { fileName, byteSize, chunkCount };
}

async function deleteFile(targetFileName) {
  const directory = await getDirectory();
  if (targetFileName === fileName && syncHandle) closeFile();
  await directory.removeEntry(targetFileName).catch(() => {});
  if (targetFileName === fileName) {
    fileName = null;
    offset = 0;
    chunkCount = 0;
  }
  return { fileName: targetFileName };
}

function enqueue(requestId, type, task) {
  const next = queue.then(async () => {
    try {
      const result = await task();
      respond(requestId, type, { ok: true, ...result });
    } catch (error) {
      respond(requestId, type, { ok: false, ...errorPayload(error) });
    }
  });
  queue = next.catch(() => {});
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message?.requestId || !message?.type) return;

  if (message.type === "list") {
    enqueue(message.requestId, "listed", listFiles);
    return;
  }
  if (message.type === "open") {
    enqueue(message.requestId, "opened", () => openFile(message.fileName));
    return;
  }
  if (message.type === "write") {
    enqueue(message.requestId, "written", () => writeBuffer(message.buffer));
    return;
  }
  if (message.type === "close") {
    enqueue(message.requestId, "closed", () => closeFile());
    return;
  }
  if (message.type === "delete") {
    enqueue(message.requestId, "deleted", () => deleteFile(message.fileName));
  }
};
