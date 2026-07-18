"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EvidencePackager, PR_URL_PATTERN } = require("../../src/evidence-packager");

const FIXTURE_ROOT = path.join(__dirname, "..", "fixtures", "evidence-packager");
const TASK_ID = "test-pack-001";

function makeTmpWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-"));
  const taskDir = path.join(tmp, ".mergeide", "tasks", TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "task.json"),
    JSON.stringify({ id: TASK_ID, title: "Evidence fixture" }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(taskDir, "run.log"),
    "Implementation complete.\nPR: https://github.com/mergeos-bounties/MRGMinner/pull/42\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(taskDir, "notes.txt"),
    "See also https://github.com/mergeos-bounties/MRGMinner/pull/43",
    "utf8"
  );
  return tmp;
}

test("EvidencePackager resolves the task directory from workspace root", () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({ taskId: TASK_ID, workspaceRoot: tmp });
    const dir = packager.resolveTaskDir();
    assert.ok(dir, "task dir should resolve");
    assert.ok(fs.existsSync(path.join(dir, "task.json")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager collects log files from the task directory", () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({ taskId: TASK_ID, workspaceRoot: tmp });
    const logs = packager.collectLogs();
    const names = logs.map((log) => log.name).sort();
    assert.deepEqual(names, ["notes.txt", "run.log", "task.json"]);
    const runLog = logs.find((log) => log.name === "run.log");
    assert.match(runLog.content, /Implementation complete/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager extracts PR URLs from collected logs", () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({ taskId: TASK_ID, workspaceRoot: tmp });
    packager.collectLogs();
    const urls = packager.extractPrUrls();
    assert.ok(urls.includes("https://github.com/mergeos-bounties/MRGMinner/pull/42"));
    assert.ok(urls.includes("https://github.com/mergeos-bounties/MRGMinner/pull/43"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager merges explicitly provided PR URLs", () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({
      taskId: TASK_ID,
      workspaceRoot: tmp,
      prUrls: ["https://github.com/mergeos-bounties/MRGMinner/pull/99"]
    });
    packager.collectLogs();
    const urls = packager.extractPrUrls();
    assert.ok(urls.includes("https://github.com/mergeos-bounties/MRGMinner/pull/99"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager records test results without network", () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({ taskId: TASK_ID, workspaceRoot: tmp });
    const result = packager.runTests(process.execPath, [
      "-e",
      "process.exit(0)"
    ]);
    assert.equal(result.passed, true);
    assert.equal(result.code, 0);
    assert.ok(packager.collected.testResults);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager builds a manifest describing collected evidence", () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({
      taskId: TASK_ID,
      workspaceRoot: tmp,
      prUrls: ["https://github.com/mergeos-bounties/MRGMinner/pull/7"]
    });
    packager.collectLogs();
    packager.runTests(process.execPath, ["-e", "process.exit(0)"]);
    const manifest = packager.buildManifest();
    assert.equal(manifest.task_id, TASK_ID);
    assert.ok(manifest.task_dir);
    assert.ok(manifest.logs.includes("run.log"));
    assert.ok(manifest.pr_urls.includes("https://github.com/mergeos-bounties/MRGMinner/pull/7"));
    assert.equal(manifest.test_results.passed, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager generates a zip archive (offline)", async () => {
  const tmp = makeTmpWorkspace();
  try {
    const packager = new EvidencePackager({ taskId: TASK_ID, workspaceRoot: tmp });
    packager.collectLogs();
    packager.runTests(process.execPath, ["-e", "process.exit(0)"]);
    const zipPath = path.join(tmp, "evidence.zip");
    const { bytes } = await packager.pack(zipPath);
    assert.ok(fs.existsSync(zipPath), "zip should exist");
    assert.ok(bytes > 0, "zip should be non-empty");

    // Verify zip validity and entry presence without external deps. archiver
    // writes entry names in plaintext in the local file headers, so we assert
    // the expected members are present and the archive starts with the PK
    // local-file-header magic bytes.
    const buf = fs.readFileSync(zipPath);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "zip should start with PK local header magic");
    const text = buf.toString("latin1");
    assert.ok(text.includes("tasks/task.json"), "zip should contain tasks/task.json");
    assert.ok(text.includes("tasks/run.log"), "zip should contain tasks/run.log");
    assert.ok(text.includes("evidence-manifest.json"), "zip should contain manifest");
    assert.ok(text.includes("test-results.json"), "zip should contain test results");
    assert.ok(text.includes("pr-url.txt"), "zip should contain pr-url.txt");

    // Independently confirm the packager's manifest records the collected PR URL.
    const manifest = packager.buildManifest();
    assert.equal(manifest.task_id, TASK_ID);
    assert.ok(manifest.pr_urls.includes("https://github.com/mergeos-bounties/MRGMinner/pull/42"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("EvidencePackager throws when task directory is missing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-"));
  try {
    const packager = new EvidencePackager({ taskId: "missing-task", workspaceRoot: tmp });
    await assert.rejects(() => packager.pack(path.join(tmp, "x.zip")), /Task directory not found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("PR_URL_PATTERN matches github pull URLs", () => {
  const text = "fix at https://github.com/o/r/pull/12 and https://gitlab.com/a/b/-/merge_requests/3";
  const matches = text.match(PR_URL_PATTERN) || [];
  assert.deepEqual(matches, ["https://github.com/o/r/pull/12"]);
});
