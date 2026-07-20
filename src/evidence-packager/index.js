"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PR_URL_PATTERN = /https?:\/\/\S+\/pull\/\d+/g;

/**
 * EvidencePackager collects the artifacts needed to submit a MergeOS bounty
 * for review: runtime logs from `.mergeide/tasks/<taskId>`, PR URLs found in
 * the task directory or supplied explicitly, and the local test run result.
 *
 * The result is written to a single `.zip` archive suitable for offline
 * submission (no network calls are made during packaging).
 */
class EvidencePackager {
  constructor(options = {}) {
    this.taskId = options.taskId;
    this.taskDir = options.taskDir || null;
    this.workspaceRoot =
      options.workspaceRoot || (options.workspace ? path.resolve(options.workspace) : process.cwd());
    this.prUrls = Array.isArray(options.prUrls) ? [...options.prUrls] : [];
    if (options.prUrl) {
      this.prUrls.push(options.prUrl);
    }
    this.extraFiles = Array.isArray(options.extraFiles) ? [...options.extraFiles] : [];
    this.collected = {
      logs: [],
      prUrls: [],
      testResults: null
    };
  }

  /**
   * Locate the task directory under `.mergeide/tasks/<taskId>` by checking the
   * workspace root then the user home directory, mirroring the CLI resolver.
   */
  resolveTaskDir() {
    if (this.taskDir && fs.existsSync(this.taskDir) && fs.statSync(this.taskDir).isDirectory()) {
      return this.taskDir;
    }
    if (!this.taskId) {
      return null;
    }
    const candidates = [
      path.join(this.workspaceRoot, ".mergeide", "tasks", this.taskId),
      path.join(require("node:os").homedir(), ".mergeide", "tasks", this.taskId)
    ];
    return candidates.find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) || null;
  }

  /**
   * Recursively gather log-style files (`.log`, `.txt`, `.json`, `.md`) from the
   * task directory. Contents are read so callers can scan them for PR URLs.
   */
  collectLogs(dir = this.resolveTaskDir()) {
    this.collected.logs = [];
    if (!dir) {
      return this.collected.logs;
    }
    const walk = (current) => {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if ([".log", ".txt", ".json", ".md"].includes(ext)) {
          const relative = path.relative(dir, full);
          let content = "";
          try {
            content = fs.readFileSync(full, "utf8");
          } catch {
            content = "";
          }
          this.collected.logs.push({ path: relative, name: entry.name, content });
        }
      }
    };
    walk(dir);
    return this.collected.logs;
  }

  /**
   * Extract PR URLs from collected logs (and any provided directly).
   */
  extractPrUrls() {
    const found = new Set(this.prUrls);
    for (const log of this.collected.logs) {
      const matches = String(log.content || "").match(PR_URL_PATTERN) || [];
      for (const url of matches) {
        found.add(url.replace(/[)\]"]+$/, ""));
      }
    }
    this.collected.prUrls = [...found];
    return this.collected.prUrls;
  }

  /**
   * Run the workspace test command (offline friendly: defaults to
   * `npm test` with `--offline` when npm is used). Returns a small summary.
   */
  runTests(command = "npm", args = ["test"]) {
    const result = spawnSyncCapture(command, args, { cwd: this.workspaceRoot });
    this.collected.testResults = {
      command: [command, ...args].join(" "),
      code: result.code,
      passed: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
    return this.collected.testResults;
  }

  /**
   * Build the in-memory manifest describing the package contents.
   */
  buildManifest() {
    return {
      task_id: this.taskId || null,
      generated_at: new Date().toISOString(),
      task_dir: this.resolveTaskDir(),
      logs: this.collected.logs.map((log) => log.path),
      pr_urls: this.extractPrUrls(),
      test_results: this.collected.testResults
        ? {
            command: this.collected.testResults.command,
            passed: this.collected.testResults.passed,
            code: this.collected.testResults.code
          }
        : null,
      extra_files: this.extraFiles.map((f) => (typeof f === "string" ? f : f.name))
    };
  }

  /**
   * Produce the `.zip` archive. Requires the `archiver` dependency.
   * Returns `{ zipPath, bytes }`.
   */
  async pack(outputPath) {
    const archiverModule = require("archiver");
    const ZipArchive = archiverModule.ZipArchive || archiverModule;
    const taskDir = this.resolveTaskDir();
    if (!taskDir) {
      throw new Error(
        `Task directory not found for ${this.taskId}. Run 'mrgminner run ${this.taskId}' or 'mrgminner prompt ${this.taskId}' first.`
      );
    }

    const zipPath = path.resolve(outputPath || `${this.taskId || "evidence"}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);

      archive.directory(taskDir, "tasks");

      for (const url of this.extractPrUrls()) {
        archive.append(`${url}\n`, { name: "pr-url.txt" });
        break;
      }
      if (this.collected.prUrls.length > 1) {
        archive.append(`${this.collected.prUrls.join("\n")}\n`, { name: "pr-urls.txt" });
      }

      if (this.collected.testResults) {
        archive.append(
          `${JSON.stringify(this.collected.testResults, null, 2)}\n`,
          { name: "test-results.json" }
        );
      }

      const manifest = this.buildManifest();
      archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "evidence-manifest.json" });

      for (const file of this.extraFiles) {
        if (typeof file === "string") {
          if (fs.existsSync(file)) {
            archive.file(file, { name: path.basename(file) });
          }
        } else if (file && file.name) {
          archive.append(file.content || "", { name: file.name });
        }
      }

      archive.finalize();
    });

    const stats = fs.statSync(zipPath);
    return { zipPath, bytes: stats.size };
  }
}

function spawnSyncCapture(command, args, options) {
  try {
    const { execFileSync } = require("node:child_process");
    const stdout = execFileSync(command, args, {
      ...options,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { code: 0, stdout: String(stdout || ""), stderr: "" };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : error.message
    };
  }
}

module.exports = { EvidencePackager, PR_URL_PATTERN };
