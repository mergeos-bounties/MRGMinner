"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packagePath = path.resolve(__dirname, "../package.json");
const electronMainPath = path.resolve(__dirname, "../src/electron-main.js");
const workflowPath = path.resolve(__dirname, "../.github/workflows/mrgminner-electron-release.yml");

test("package config builds Electron desktop app for Windows and Linux", () => {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

  assert.equal(pkg.scripts.electron, "electron ./src/electron-main.js");
  assert.equal(pkg.scripts["electron:smoke"], "electron ./src/electron-main.js --smoke-test --workspace .");
  assert.match(pkg.scripts["build:electron:win"], /electron-builder --win portable --x64/);
  assert.match(pkg.scripts["build:electron:linux"], /electron-builder --linux AppImage tar\.gz --x64/);
  assert.equal(pkg.build.productName, "MRGMinner");
  assert.equal(pkg.build.asar, false);
  assert.equal(pkg.build.extraMetadata.main, "src/electron-main.js");
  assert.equal(pkg.build.win.target[0].target, "portable");
  assert.equal(pkg.build.linux.target[0].target, "AppImage");
  assert.equal(pkg.build.linux.target[1].target, "tar.gz");
});

test("Electron main process starts the local IDE server", () => {
  const source = fs.readFileSync(electronMainPath, "utf8");

  assert.match(source, /startIDE/);
  assert.match(source, /BrowserWindow/);
  assert.match(source, /Open Workspace/);
  assert.match(source, /--smoke-test/);
  assert.match(source, /port:\s*0/);
});

test("Electron release workflow builds Windows and Linux assets", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /npm run build:electron:win/);
  assert.match(workflow, /npm run build:electron:linux/);
  assert.match(workflow, /mrgminner-electron-latest/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /actions\/download-artifact@v7/);
  assert.match(workflow, /gh release upload \$tag/);
  assert.match(workflow, /\.AppImage/);
  assert.match(workflow, /\.tar\.gz/);
  assert.match(workflow, /\.exe/);
});
