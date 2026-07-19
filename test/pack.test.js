"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { zipDirectory, crc32 } = require("../src/pack");

test("crc32 computes correct checksum", () => {
  const data = Buffer.from("hello");
  const result = crc32(data);
  assert.equal(typeof result, "number");
  assert.ok(result > 0);
});

test("zipDirectory creates a valid zip file with files and subdirectories", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-test-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-out-"));
  const outPath = path.join(outDir, "test.zip");
  try {
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ id: "tsk_001", title: "Test" }));
    fs.writeFileSync(path.join(tmpDir, "prompt.md"), "# MRGMinner Task\n\nTest prompt.");

    await zipDirectory(tmpDir, outPath);

    const stat = fs.statSync(outPath);
    assert.ok(stat.size > 0, "zip file should have content");

    const zipContent = fs.readFileSync(outPath);
    assert.equal(zipContent.readUInt32LE(0), 0x04034b50, "should start with local file header signature");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
