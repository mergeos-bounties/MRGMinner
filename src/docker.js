"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { settingsPath } = require("./settings");

const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm-slim";
const DOCKER_TIMEOUT_MS = 15000;
const DOCKER_OUTPUT_LIMIT = 1024 * 1024;

function sandboxImage(env = process.env) {
  return String(env.MRGMINNER_SANDBOX_IMAGE || env.MERGEIDE_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE).trim();
}

async function getDockerStatus(options = {}) {
  const image = options.image || sandboxImage(options.env);
  try {
    const [versionResult, infoResult] = await Promise.all([
      runDocker(["version", "--format", "{{json .}}"], {
        timeoutMs: options.timeoutMs || 5000,
        env: options.env
      }),
      runDocker(["info", "--format", "{{json .}}"], {
        timeoutMs: options.timeoutMs || 5000,
        env: options.env
      })
    ]);
    const version = parseJson(versionResult.stdout);
    const info = parseJson(infoResult.stdout);
    return {
      available: true,
      sandbox_enabled: true,
      image,
      client: {
        version: valueAt(version, ["Client", "Version"]) || valueAt(info, ["ClientInfo", "Version"]) || "",
        os: valueAt(version, ["Client", "Os"]) || valueAt(info, ["ClientInfo", "Os"]) || "",
        arch: valueAt(version, ["Client", "Arch"]) || valueAt(info, ["ClientInfo", "Arch"]) || "",
        context: valueAt(info, ["ClientInfo", "Context"]) || ""
      },
      engine: {
        version: valueAt(version, ["Server", "Version"]) || info.ServerVersion || "",
        operating_system: info.OperatingSystem || "",
        os_type: info.OSType || "",
        architecture: info.Architecture || "",
        name: info.Name || "",
        containers: numberValue(info.Containers),
        running: numberValue(info.ContainersRunning),
        images: numberValue(info.Images),
        cpus: numberValue(info.NCPU),
        memory_bytes: numberValue(info.MemTotal),
        driver: info.Driver || "",
        cgroup_version: String(info.CgroupVersion || "")
      }
    };
  } catch (error) {
    return {
      available: false,
      sandbox_enabled: true,
      image,
      error: error && error.message ? error.message : String(error)
    };
  }
}

async function runInDockerSandbox(commandArgs, options = {}) {
  const dockerArgs = buildDockerRunArgs(commandArgs, options);
  const result = await runDocker(dockerArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || DOCKER_TIMEOUT_MS,
    env: options.env,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  });
  return {
    ...result,
    sandbox: {
      type: "docker",
      image: options.image || sandboxImage(options.env),
      workspace: path.resolve(options.workspaceRoot || options.cwd || process.cwd()),
      package_root: path.resolve(options.packageRoot || path.resolve(__dirname, "..")),
      command: ["docker", ...dockerArgs].join(" ")
    }
  };
}

async function checkCommandInDockerSandbox(commandName, options = {}) {
  const command = String(commandName || "").trim();
  if (!command) {
    throw new Error("AI CLI command is empty");
  }
  const dockerArgs = buildDockerShellArgs(`command -v ${shellQuote(command)}`, options);
  const result = await runDocker(dockerArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || DOCKER_TIMEOUT_MS,
    env: options.env,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  });
  return {
    ...result,
    sandbox: sandboxDetails(dockerArgs, options)
  };
}

async function runShellInDockerSandbox(shellScript, options = {}) {
  const dockerArgs = buildDockerShellArgs(shellScript, options);
  const result = await runDocker(dockerArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || DOCKER_TIMEOUT_MS,
    env: options.env,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  });
  return {
    ...result,
    sandbox: sandboxDetails(dockerArgs, options)
  };
}

function buildDockerRunArgs(commandArgs, options = {}) {
  const args = Array.isArray(commandArgs) ? commandArgs.map(String).filter(Boolean) : [];
  if (!args.length) {
    throw new Error("sandbox command is empty");
  }
  const workspaceRoot = path.resolve(options.workspaceRoot || options.cwd || process.cwd());
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, ".."));
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`workspace does not exist: ${workspaceRoot}`);
  }
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    throw new Error(`package root must be a real directory for Docker sandbox: ${packageRoot}`);
  }

  const image = options.image || sandboxImage(options.env);
  const dockerArgs = buildDockerBaseArgs(options, workspaceRoot, packageRoot);
  dockerArgs.push(image, "node", "/opt/mrgminner/bin/mrgminner.js", ...withWorkspaceFlag(args));
  return dockerArgs;
}

function buildDockerShellArgs(shellScript, options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || options.cwd || process.cwd());
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, ".."));
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`workspace does not exist: ${workspaceRoot}`);
  }
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    throw new Error(`package root must be a real directory for Docker sandbox: ${packageRoot}`);
  }
  const image = options.image || sandboxImage(options.env);
  const dockerArgs = buildDockerBaseArgs(options, workspaceRoot, packageRoot);
  dockerArgs.push(image, "sh", "-lc", String(shellScript || ""));
  return dockerArgs;
}

function buildDockerBaseArgs(options, workspaceRoot, packageRoot) {
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    sandboxContainerName(options),
    "--workdir",
    "/workspace",
    "--network",
    "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    bindMount(workspaceRoot, "/workspace", false),
    "--mount",
    bindMount(packageRoot, "/opt/mrgminner", true),
    "--env",
    "MERGEIDE_WORKSPACE=/workspace",
    "--env",
    "MRGMINNER_WORKSPACE=/workspace"
  ];

  maybeAddUser(dockerArgs);
  addForwardedEnv(dockerArgs, options.env || process.env);
  addSettingsMount(dockerArgs, options.settingsFile || settingsPath());
  return dockerArgs;
}

function withWorkspaceFlag(args) {
  if (args.includes("--workspace") || args.some((arg) => String(arg).startsWith("--workspace="))) {
    return args.slice();
  }
  return [...args, "--workspace", "/workspace"];
}

function bindMount(source, target, readonly) {
  const parts = [
    "type=bind",
    `source=${source}`,
    `target=${target}`
  ];
  if (readonly) {
    parts.push("readonly");
  }
  return parts.join(",");
}

function addForwardedEnv(dockerArgs, env) {
  const names = [
    "MERGEOS_URL",
    "MERGEOS_TOKEN",
    "MERGEIDE_AI_PROVIDER",
    "MERGEIDE_AI_CLI",
    "MERGEIDE_AI_ARGS",
    "MERGEIDE_WORKER_ID",
    "MERGEIDE_AGENT_TYPE",
    "MRGMINNER_SANDBOX_IMAGE"
  ];
  for (const name of names) {
    if (env && env[name]) {
      dockerArgs.push("--env", `${name}=${env[name]}`);
    }
  }
}

function addSettingsMount(dockerArgs, filePath) {
  if (!filePath) {
    return;
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return;
  }
  dockerArgs.push(
    "--mount",
    bindMount(resolved, "/tmp/mrgminner-settings.json", true),
    "--env",
    "MERGEIDE_SETTINGS=/tmp/mrgminner-settings.json"
  );
}

function maybeAddUser(dockerArgs) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return;
  }
  dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
}

function sandboxContainerName(options = {}) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return String(options.containerName || `mrgminner-sandbox-${suffix}`).replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function sandboxDetails(dockerArgs, options = {}) {
  return {
    type: "docker",
    image: options.image || sandboxImage(options.env),
    workspace: path.resolve(options.workspaceRoot || options.cwd || process.cwd()),
    package_root: path.resolve(options.packageRoot || path.resolve(__dirname, "..")),
    command: ["docker", ...dockerArgs].join(" ")
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runDocker(args, options = {}) {
  if (typeof options.onEvent === "function") {
    options.onEvent(`docker ${args.slice(0, 4).join(" ")}`);
  }
  return runProcess("docker", args, {
    cwd: options.cwd,
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || DOCKER_TIMEOUT_MS,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  });
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let killedForLimit = false;
    let cancelled = false;
    let settled = false;
    if (options.signal && options.signal.aborted) {
      resolve({
        args,
        commandLine: [command, ...args].join(" "),
        code: 130,
        signal: "SIGTERM",
        timedOut: false,
        cancelled: true,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr
      });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (options.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      cancelled = true;
      if (typeof options.onEvent === "function") {
        options.onEvent(`cancel requested; stopping ${command}`);
      }
      terminateProcess(child, command, args, options);
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      killedForLimit = true;
      if (typeof options.onEvent === "function") {
        options.onEvent(`timeout reached; stopping ${command}`);
      }
      terminateProcess(child, command, args, options);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
      if (typeof options.onStdout === "function") {
        options.onStdout(chunk.toString("utf8"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
      if (typeof options.onStderr === "function") {
        options.onStderr(chunk.toString("utf8"));
      }
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve({
        args,
        commandLine: [command, ...args].join(" "),
        code: cancelled ? 130 : code === null ? 1 : code,
        signal: signal || (cancelled ? "SIGTERM" : signal),
        timedOut: killedForLimit,
        cancelled,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr
      });
    });
  });
}

function terminateProcess(child, command, args, options = {}) {
  if (command === "docker") {
    const containerName = dockerRunContainerName(args);
    if (containerName) {
      if (typeof options.onEvent === "function") {
        options.onEvent(`removing Docker container ${containerName}`);
      }
      try {
        const remover = spawn("docker", ["rm", "-f", containerName], {
          stdio: "ignore",
          windowsHide: true
        });
        remover.on("error", () => {});
        remover.unref();
      } catch {}
    }
  }
  if (!child || !child.pid || child.killed) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", () => {});
      killer.unref();
      return;
    } catch {}
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    } catch {}
  }, 2500).unref?.();
}

function dockerRunContainerName(args) {
  if (!Array.isArray(args) || args[0] !== "run") {
    return "";
  }
  const index = args.indexOf("--name");
  return index === -1 ? "" : String(args[index + 1] || "");
}

function appendLimited(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (next.length <= DOCKER_OUTPUT_LIMIT) {
    return next;
  }
  return next.slice(next.length - DOCKER_OUTPUT_LIMIT);
}

function parseJson(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

function valueAt(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      return "";
    }
    current = current[part];
  }
  return current === undefined || current === null ? "" : String(current);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatBytes(bytes) {
  const number = Number(bytes || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
  const value = number / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

module.exports = {
  DEFAULT_SANDBOX_IMAGE,
  buildDockerRunArgs,
  checkCommandInDockerSandbox,
  formatBytes,
  getDockerStatus,
  runShellInDockerSandbox,
  runInDockerSandbox,
  sandboxImage,
  withWorkspaceFlag
};
