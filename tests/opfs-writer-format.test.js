const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "opfs-writer.js"), "utf8");

test("OPFS recovery scan recognizes MP4 and legacy WebM only", async () => {
  const entries = [
    ["authorized-tab-recording-new.mp4", { getFile: async () => ({ size: 200, lastModified: 20 }) }],
    ["authorized-tab-recording-old.webm", { getFile: async () => ({ size: 100, lastModified: 10 }) }],
    ["authorized-tab-recording-ignore.txt", { getFile: async () => ({ size: 300, lastModified: 30 }) }],
    ["unrelated.mp4", { getFile: async () => ({ size: 400, lastModified: 40 }) }]
  ];
  const directory = {
    async *entries() {
      yield* entries;
    }
  };

  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const context = {
    performance,
    navigator: { storage: { async getDirectory() { return directory; } } },
    self: { postMessage(message) { resolveResponse(message); } }
  };
  vm.runInNewContext(source, context, { filename: "opfs-writer.js" });

  context.self.onmessage({ data: { requestId: "list-1", type: "list" } });
  const response = await responsePromise;

  assert.equal(response.ok, true);
  assert.deepEqual(
    Array.from(response.files, (file) => file.fileName),
    ["authorized-tab-recording-new.mp4", "authorized-tab-recording-old.webm"]
  );
});
