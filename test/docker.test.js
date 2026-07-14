"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildDockerRunArgs,
  formatBytes,
  sandboxImage,
  withWorkspaceFlag
} = require("../src/docker");

test("withWorkspaceFlag keeps commands inside the mounted workspace", () => {
  assert.deepEqual(withWorkspaceFlag(["status"]), ["status", "--workspace", "/workspace"]);
  assert.deepEqual(withWorkspaceFlag(["status", "--workspace", "custom"]), ["status", "--workspace", "custom"]);
  assert.deepEqual(withWorkspaceFlag(["status", "--workspace=/tmp/ws"]), ["status", "--workspace=/tmp/ws"]);
});

test("buildDockerRunArgs mounts workspace and package read-only source", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mrgminner-docker-workspace-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mrgminner-docker-package-"));
  const args = buildDockerRunArgs(["status"], {
    workspaceRoot: workspace,
    packageRoot,
    image: "node:test",
    settingsFile: path.join(workspace, "missing-settings.json"),
    containerName: "mrgminner-test",
    env: {
      MERGEOS_URL: "https://mergeos.shop"
    }
  });

  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("mrgminner-test"));
  assert.ok(args.includes("node:test"));
  assert.ok(args.includes("node"));
  assert.ok(args.includes("/opt/mrgminner/bin/mrgminner.js"));
  assert.ok(args.includes("status"));
  assert.ok(args.includes("/workspace"));
  assert.ok(args.some((item) => item.includes(`source=${workspace}`) && item.includes("target=/workspace")));
  assert.ok(args.some((item) => item.includes(`source=${packageRoot}`) && item.includes("target=/opt/mrgminner") && item.includes("readonly")));
  assert.ok(args.includes("MERGEOS_URL=https://mergeos.shop"));
});

test("sandboxImage and formatBytes expose readable sandbox defaults", () => {
  assert.equal(sandboxImage({}), "node:22-bookworm-slim");
  assert.equal(sandboxImage({ MRGMINNER_SANDBOX_IMAGE: "node:custom" }), "node:custom");
  assert.equal(formatBytes(1073741824), "1.0 GB");
});
