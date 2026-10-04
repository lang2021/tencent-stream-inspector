const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const script = fs.readFileSync(path.join(root, "popup.js"), "utf8");

test("mouse isolation is an opt-in, non-persisted popup setting", () => {
  assert.match(html, /id="interactionLockCheckbox"[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /id="interactionLockCheckbox"[^>]*checked/);
  assert.match(script, /interactionLockCheckbox.*\.checked/);
  assert.match(script, /interactionLockEnabled/);
  assert.match(script, /SET_RECORDING_INTERACTION_LOCK/);
  assert.doesNotMatch(script, /2_000|2 秒/);
  assert.doesNotMatch(script, /chrome\.storage/);
});

test("popup reports MP4 recording and preserves the old WebM recovery label", () => {
  assert.match(html, /id="recordingFormat"/);
  assert.match(html, /MP4 · H\.264\/AAC/);
  assert.match(script, /正在保存 \$\{format\.name\}/);
  assert.match(script, /WebM · 旧恢复文件/);
  assert.doesNotMatch(script, /正在保存 WebM/);
});
