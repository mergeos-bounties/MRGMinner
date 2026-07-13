"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const distDir = path.resolve(__dirname, "..", "dist");
const exeName = "MRGMinner-Windows-x64.exe";
const checksumName = "MRGMinner-Windows-x64.exe.sha256";
const buildInfoName = "MRGMinner-Windows-x64.build.json";
const zipName = "MRGMinner-Windows-x64.zip";

const exePath = path.join(distDir, exeName);
if (!fs.existsSync(exePath)) {
  console.error(`Executable not found at ${exePath}. Run npm run build:exe first.`);
  process.exitCode = 1;
  return;
}

const cmd = [
  `Compress-Archive`,
  `-Path "${exeName}", "${checksumName}", "${buildInfoName}"`,
  `-DestinationPath "${zipName}"`,
  `-Force`
].join(" ");

execSync(`powershell -Command "${cmd}"`, {
  cwd: distDir,
  stdio: "inherit"
});

console.log(`Portable package created: ${path.join(distDir, zipName)}`);
