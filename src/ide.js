"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { listTasks, getMarketplace } = require("./api");
const { discoverMarketplace, resolveRewardMrg } = require("./chain");
const { getDockerStatus, runInDockerSandbox, runShellInDockerSandbox } = require("./docker");
const { prepareTaskArtifacts, resolveAIInvocation } = require("./runner");
const { loadSettings, mergeSettings, parseArgList, PROVIDER_PRESETS, providerPreset, redactToken, saveSettings } = require("./settings");
const { isWelcomeAITaskID, validateWelcomeAIResult, welcomeAITask } = require("./welcome-task");

const DEFAULT_IDE_HOST = "127.0.0.1";
const DEFAULT_IDE_PORT = 17331;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);
const ALLOWED_COMMANDS = new Set([
  "block",
  "chain",
  "claim",
  "claim-block",
  "compare",
  "discover",
  "economy",
  "intent",
  "ledger",
  "live",
  "market",
  "next",
  "nodes",
  "prompt",
  "proof",
  "run",
  "solana",
  "split",
  "stats",
  "status",
  "submit",
  "tasks",
  "token",
  "verify"
]);

async function startIDE(options = {}) {
  const settings = await loadSettings(options.settings, ideSettingsFromOptions(options));
  const workspaceRoot = resolveWorkspaceRoot(settings, options);
  const host = String(options.host || DEFAULT_IDE_HOST);
  const requestedPort = options.port === undefined ? DEFAULT_IDE_PORT : Number(options.port);
  const server = http.createServer((request, response) => {
    handleRequest(request, response, {
      settingsPath: options.settings,
      workspaceRoot,
      packageRoot: path.resolve(__dirname, "..")
    }).catch((error) => sendError(response, error));
  });

  const port = await listenOnAvailablePort(server, host, requestedPort);
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}/`,
    workspaceRoot
  };
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    return sendText(response, 200, clientHtml(), "text/html; charset=utf-8");
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const settings = await loadSettings(context.settingsPath);
    const docker = await getDockerStatus();
    const welcome = await validateWelcomeAIResult(context.workspaceRoot);
    return sendJson(response, 200, {
      app: {
        name: "MRGMinner IDE",
        version: await packageVersion(context.packageRoot)
      },
      workspace: {
        root: context.workspaceRoot
      },
      settings: presentSettings(settings),
      ai: presentAI(settings),
      docker,
      welcome
    });
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, await buildIDEStatus(context));
  }
  if (request.method === "GET" && url.pathname === "/api/docker") {
    return sendJson(response, 200, await getDockerStatus());
  }
  if (request.method === "GET" && url.pathname === "/api/tasks") {
    return sendJson(response, 200, await loadIDETasks(context));
  }
  if (request.method === "GET" && url.pathname === "/api/workspaces") {
    return sendJson(response, 200, {
      workspaces: await listLocalWorkspaces(context.workspaceRoot)
    });
  }
  if (request.method === "POST" && /^\/api\/tasks\/.+\/prepare$/.test(url.pathname)) {
    const taskID = decodeURIComponent(url.pathname.replace(/^\/api\/tasks\//, "").replace(/\/prepare$/, ""));
    const body = await readJsonBody(request);
    const settings = await loadSettings(context.settingsPath);
    const task = body.task || await taskById(context, taskID);
    const artifacts = await prepareTaskArtifacts(settings, task, {
      workspaceRoot: context.workspaceRoot
    });
    return sendJson(response, 200, {
      task,
      artifacts: {
        artifactRoot: artifacts.artifactRoot,
        promptFile: artifacts.promptFile,
        taskFile: artifacts.taskFile,
        relativePromptPath: relativeWorkspacePath(context.workspaceRoot, artifacts.promptFile),
        relativeTaskPath: relativeWorkspacePath(context.workspaceRoot, artifacts.taskFile)
      }
    });
  }
  if (request.method === "POST" && /^\/api\/tasks\/.+\/check$/.test(url.pathname)) {
    const taskID = decodeURIComponent(url.pathname.replace(/^\/api\/tasks\//, "").replace(/\/check$/, ""));
    if (!isWelcomeAITaskID(taskID)) {
      throw new Error(`no local validator is available for task ${taskID}`);
    }
    return sendJson(response, 200, await validateWelcomeAIResult(context.workspaceRoot));
  }
  if (request.method === "POST" && /^\/api\/tasks\/.+\/smoke$/.test(url.pathname)) {
    const taskID = decodeURIComponent(url.pathname.replace(/^\/api\/tasks\//, "").replace(/\/smoke$/, ""));
    if (!isWelcomeAITaskID(taskID)) {
      throw new Error(`no local smoke runner is available for task ${taskID}`);
    }
    const result = await runWelcomeAISmoke(context);
    return sendJson(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/files") {
    const directory = resolveWorkspacePath(context.workspaceRoot, url.searchParams.get("path") || ".");
    return sendJson(response, 200, await listDirectory(context.workspaceRoot, directory));
  }
  if (request.method === "GET" && url.pathname === "/api/file") {
    const filePath = resolveWorkspacePath(context.workspaceRoot, url.searchParams.get("path") || "");
    return sendJson(response, 200, await readWorkspaceFile(context.workspaceRoot, filePath));
  }
  if (request.method === "PUT" && url.pathname === "/api/file") {
    const body = await readJsonBody(request);
    const filePath = resolveWorkspacePath(context.workspaceRoot, body.path || "");
    await fs.writeFile(filePath, String(body.content === undefined ? "" : body.content), "utf8");
    const stat = await fs.stat(filePath);
    return sendJson(response, 200, {
      ok: true,
      path: relativeWorkspacePath(context.workspaceRoot, filePath),
      size: stat.size,
      mtime: stat.mtime.toISOString()
    });
  }
  if (request.method === "POST" && url.pathname === "/api/command") {
    const body = await readJsonBody(request);
    const args = normalizeCommandArgs(body.args || parseCommandLine(body.commandLine || ""));
    const result = isHostAICommand(args)
      ? await runMRGMinnerHostAICommand(args, {
        workspaceRoot: context.workspaceRoot,
        packageRoot: context.packageRoot,
        settingsFile: context.settingsPath,
        timeoutMs: Number(body.timeoutMs || COMMAND_TIMEOUT_MS)
      })
      : await runMRGMinnerSandboxCommand(args, {
        workspaceRoot: context.workspaceRoot,
        packageRoot: context.packageRoot,
        settingsFile: context.settingsPath,
        timeoutMs: Number(body.timeoutMs || COMMAND_TIMEOUT_MS)
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/command/stream") {
    return streamCommandResponse(request, response, context);
  }
  if (request.method === "PUT" && url.pathname === "/api/settings/ai") {
    const body = await readJsonBody(request);
    const saved = await saveAISettings(context, body);
    return sendJson(response, 200, {
      ok: true,
      settings: presentSettings(saved),
      ai: presentAI(saved)
    });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/test") {
    const body = await readJsonBody(request);
    const result = await testAISettings(context, body);
    return sendJson(response, 200, result);
  }
  return sendJson(response, 404, { error: "not found" });
}

function ideSettingsFromOptions(options = {}) {
  const settings = {};
  if (options.mergeosUrl) {
    settings.mergeos = { baseUrl: options.mergeosUrl };
  }
  if (options.workspaceRoot || options.workspace) {
    settings.workspace = { root: options.workspaceRoot || options.workspace };
  }
  return settings;
}

function resolveWorkspaceRoot(settings, options = {}) {
  const root =
    options.workspaceRoot ||
    options.workspace ||
    (settings.workspace && settings.workspace.root) ||
    process.cwd();
  return path.resolve(root);
}

async function listenOnAvailablePort(server, host, startPort) {
  let port = Number.isFinite(startPort) && startPort >= 0 ? Math.trunc(startPort) : DEFAULT_IDE_PORT;
  for (;;) {
    try {
      return await listenOnce(server, host, port);
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw error;
    }
  }
}

function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : port);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, host);
  });
}

async function buildIDEStatus(context) {
  const settings = await loadSettings(context.settingsPath);
  const tasks = await loadIDETasks(context, settings);
  const docker = await getDockerStatus();
  const welcome = await validateWelcomeAIResult(context.workspaceRoot);
  return {
    settings: presentSettings(settings),
    ai: presentAI(settings),
    docker,
    welcome,
    workspace: {
      root: context.workspaceRoot
    },
    tasks: {
      source: tasks.source,
      count: tasks.tasks.length,
      open: tasks.tasks.filter((task) => task.status === "open").length,
      reward_mrg: tasks.tasks.reduce((sum, task) => sum + resolveRewardMrg(task), 0),
      groups: tasks.work_groups || []
    },
    generated_at: new Date().toISOString()
  };
}

async function loadIDETasks(context, loadedSettings) {
  const settings = loadedSettings || await loadSettings(context.settingsPath);
  const hasToken = Boolean(settings.mergeos && settings.mergeos.token);
  if (hasToken) {
    try {
      const authTasks = normalizeTasks(await listTasks(settings));
      const marketplace = await loadMarketplaceDiscovery(settings).catch((error) => ({
        source: "unavailable",
        warning: error.message,
        discovery: emptyMarketplaceDiscovery()
      }));
      const tasks = mergeTaskLists([welcomeAITask()], authTasks, normalizeTasks(marketplace.discovery.open_bounties || []));
      return {
        source: "auth",
        tasks,
        marketplace: marketplace.discovery,
        marketplace_warning: marketplace.warning || "",
        work_groups: buildWorkGroups(tasks, marketplace.discovery)
      };
    } catch (error) {
      const fallback = await marketplaceTasks(settings);
      fallback.warning = error.message;
      return fallback;
    }
  }
  return marketplaceTasks(settings);
}

async function marketplaceTasks(settings) {
  try {
    const marketplace = await loadMarketplaceDiscovery(settings);
    const discovery = marketplace.discovery;
    const tasks = mergeTaskLists([welcomeAITask()], normalizeTasks(discovery.open_bounties || []));
    return {
      source: "public-marketplace",
      tasks,
      marketplace: discovery,
      work_groups: buildWorkGroups(tasks, discovery)
    };
  } catch (error) {
    const discovery = emptyMarketplaceDiscovery();
    return {
      source: "unavailable",
      warning: error.message,
      tasks: [welcomeAITask()],
      marketplace: discovery,
      work_groups: buildWorkGroups([welcomeAITask()], discovery)
    };
  }
}

async function loadMarketplaceDiscovery(settings) {
  const market = await getMarketplace(settings, 100);
  return {
    source: "public-marketplace",
    discovery: discoverMarketplace(market, { limit: 100 })
  };
}

function emptyMarketplaceDiscovery() {
  return {
    protocol_version: "mergeos.marketplace.v1",
    token_symbol: "MRG",
    stats: {
      project_count: 0,
      open_task_count: 0,
      accepted_task_count: 0,
      total_budget_cents: 0,
      work_pool_cents: 0,
      ledger_entry_count: 0,
      discoverable_open_mrg: 0,
      listed_bounty_count: 0
    },
    open_bounties: [],
    funded_projects: [],
    active_projects: [],
    contributor_count: 0,
    agent_count: 0,
    explore: {}
  };
}

function buildWorkGroups(tasks, marketplace = emptyMarketplaceDiscovery()) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const groups = [];
  const byProject = new Map();
  const addProject = (project, statusGroup) => {
    if (!project || !project.id) {
      return;
    }
    const id = String(project.id);
    const existing = byProject.get(id) || {
      id: `project:${id}`,
      project_id: id,
      title: project.title || id,
      status: project.status || statusGroup,
      status_group: statusGroup,
      repo: project.repo || "",
      budget_cents: Number(project.budget_cents || 0),
      budget_mrg: Number(project.budget_mrg || 0),
      task_count: 0,
      open_tasks: Number(project.open_tasks || 0),
      reward_mrg: 0
    };
    existing.status_group = mergeStatusGroup(existing.status_group, statusGroup);
    existing.title = existing.title || project.title || id;
    existing.status = existing.status || project.status || statusGroup;
    existing.repo = existing.repo || project.repo || "";
    existing.budget_cents = Math.max(existing.budget_cents || 0, Number(project.budget_cents || 0));
    existing.budget_mrg = Math.max(existing.budget_mrg || 0, Number(project.budget_mrg || 0));
    existing.open_tasks = Math.max(existing.open_tasks || 0, Number(project.open_tasks || 0));
    byProject.set(id, existing);
  };

  for (const project of marketplace.funded_projects || []) {
    addProject(project, "funded");
  }
  for (const project of marketplace.active_projects || []) {
    addProject(project, "in_progress");
  }
  for (const task of normalizedTasks) {
    const projectID = String(task.project_id || "").trim();
    if (!projectID) {
      continue;
    }
    const statusGroup = task.local_test ? "local" : inProgressStatus(task.status) ? "in_progress" : "funded";
    addProject({
      id: projectID,
      title: task.project_title || projectID,
      status: statusGroup,
      repo: task.repo || "",
      open_tasks: 0
    }, statusGroup);
    const group = byProject.get(projectID);
    group.task_count += 1;
    group.reward_mrg += resolveRewardMrg(task);
  }

  const projectGroups = [...byProject.values()]
    .filter((group) => group.task_count > 0 || group.open_tasks > 0 || group.status_group === "funded" || group.status_group === "in_progress")
    .sort((a, b) => {
      const order = groupOrder(a.status_group) - groupOrder(b.status_group);
      if (order !== 0) {
        return order;
      }
      return a.title.localeCompare(b.title);
    });

  groups.push({
    id: "all",
    project_id: "",
    title: "All funded / in-progress work",
    status: "available",
    status_group: "all",
    task_count: normalizedTasks.length,
    open_tasks: normalizedTasks.filter((task) => task.status === "open" || task.status === "funded" || task.status === "available").length,
    reward_mrg: normalizedTasks.reduce((sum, task) => sum + resolveRewardMrg(task), 0)
  });
  return groups.concat(projectGroups);
}

function mergeStatusGroup(left, right) {
  if (left === "local" || right === "local") {
    return "local";
  }
  if (left === "in_progress" || right === "in_progress") {
    return "in_progress";
  }
  if (left === "funded" || right === "funded") {
    return "funded";
  }
  return left || right || "funded";
}

function groupOrder(group) {
  if (group === "local") {
    return -1;
  }
  if (group === "in_progress") {
    return 0;
  }
  if (group === "funded") {
    return 1;
  }
  return 2;
}

function inProgressStatus(status) {
  const normalized = String(status || "").toLowerCase().replace(/[\s-]+/g, "_");
  return ["in_progress", "progress", "active", "running", "claimed", "assigned", "submitted", "review"].includes(normalized);
}

async function taskById(context, taskID) {
  if (isWelcomeAITaskID(taskID)) {
    return welcomeAITask();
  }
  const loaded = await loadIDETasks(context);
  const ref = String(taskID || "").trim();
  const task = loaded.tasks.find((row) => [row.id, row.task_id, row.claim_id, row.bounty_id].some((value) => String(value || "") === ref));
  if (task) {
    return task;
  }
  return {
    id: ref,
    title: ref || "Untitled task",
    status: "open",
    required_worker_kind: "agent",
    reward_cents: 0,
    source: "manual"
  };
}

function normalizeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(Boolean).map((task) => ({
    id: String(task.id || task.task_id || task.claim_id || task.bounty_id || ""),
    title: String(task.title || task.name || task.id || "Untitled task"),
    status: String(task.status || "open"),
    required_worker_kind: String(task.required_worker_kind || task.worker_kind || "agent"),
    suggested_agent_type: String(task.suggested_agent_type || task.suggested_agent || task.agent_type || ""),
    reward_cents: Number.isFinite(Number(task.reward_cents))
      ? Number(task.reward_cents)
      : Math.round(resolveRewardMrg(task) * 100),
    project_id: task.project_id || task.projectID || "",
    project_title: task.project_title || task.projectTitle || "",
    repo: task.repo || task.repo_url || task.source_repository || "",
    issue_url: task.issue_url || task.issueURL || "",
    acceptance: task.acceptance || task.acceptance_criteria || "",
    source: task.source || ""
  })).filter((task) => task.id);
}

function mergeTaskLists(...lists) {
  const merged = [];
  const seen = new Set();
  for (const task of lists.flatMap((list) => Array.isArray(list) ? list : [])) {
    const id = String(task && task.id || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(task);
  }
  return merged;
}

function presentSettings(settings) {
  return {
    mergeosUrl: settings.mergeos && settings.mergeos.baseUrl,
    hasToken: Boolean(settings.mergeos && settings.mergeos.token),
    token: redactToken(settings.mergeos && settings.mergeos.token),
    provider: settings.ai && settings.ai.provider,
    workerId: settings.worker && settings.worker.id,
    agentType: settings.worker && settings.worker.agentType
  };
}

function presentAI(settings) {
  const provider = settings.ai && settings.ai.provider || "custom";
  const preset = providerPreset(provider);
  const command = settings.ai && settings.ai.command ? settings.ai.command : preset.command;
  const args = settings.ai && Array.isArray(settings.ai.args) && settings.ai.args.length
    ? settings.ai.args
    : preset.args;
  return {
    provider,
    command,
    args,
    argsText: args.join(" "),
    autoClaimAfterRun: Boolean(settings.claim && settings.claim.afterRun),
    providers: Object.keys(PROVIDER_PRESETS).map((name) => ({
      name,
      command: PROVIDER_PRESETS[name].command,
      args: PROVIDER_PRESETS[name].args
    }))
  };
}

async function saveAISettings(context, body = {}) {
  const settings = await loadSettings(context.settingsPath);
  const provider = String(body.provider || settings.ai.provider || "custom").trim().toLowerCase();
  const command = String(body.command === undefined ? "" : body.command).trim();
  const args = body.args !== undefined ? parseArgList(body.args) : parseArgList(body.argsText || "");
  const next = mergeSettings(settings, {
    ai: {
      provider,
      command,
      args
    },
    claim: {
      afterRun: Boolean(body.autoClaimAfterRun)
    }
  });
  return saveSettings(next, context.settingsPath);
}

async function testAISettings(context, body = {}) {
  const provider = String(body.provider || "custom").trim().toLowerCase();
  const command = String(body.command === undefined ? "" : body.command).trim();
  const args = body.args !== undefined ? parseArgList(body.args) : parseArgList(body.argsText || "");
  const effectiveCommand = command || providerPreset(provider).command;
  const settings = mergeSettings(await loadSettings(context.settingsPath), {
    ai: { provider, command, args }
  });
  const task = welcomeAITask();
  const artifacts = await prepareTaskArtifacts(settings, task, {
    workspaceRoot: context.workspaceRoot,
    sandbox: dockerPromptContext(context)
  });
  let invocation = null;
  let commandCheck = null;
  let error = "";
  try {
    invocation = resolveAIInvocation(settings, artifacts, task);
  } catch (resolveError) {
    error = resolveError.message;
  }
  if (effectiveCommand) {
    commandCheck = await checkHostCommand(effectiveCommand, { timeoutMs: 15000 });
  }
  const commandMissing = commandCheck && commandCheck.code !== 0;
  return {
    code: error || commandMissing ? 1 : 0,
    stdout: "",
    stderr: commandCheck && commandCheck.stderr || "",
    duration_ms: commandCheck && commandCheck.duration_ms || 0,
    runner: {
      type: "host-ai-test",
      cwd: context.workspaceRoot
    },
    ai_test: {
      ok: !error && !commandMissing,
      error: error || (commandMissing
        ? `AI CLI not found on host: ${effectiveCommand}`
        : ""),
      selected: {
        id: task.id,
        title: task.title
      },
      ai_command: invocation && invocation.command || effectiveCommand || "",
      ai_args: invocation && invocation.args || [],
      prompt_file: artifacts.promptFile,
      command_check: commandCheck && {
        code: commandCheck.code,
        stdout: commandCheck.stdout,
        stderr: commandCheck.stderr
      }
    }
  };
}

async function runWelcomeAISmoke(context) {
  const script = [
    "node",
    "-e",
    shellQuote([
      "const fs = require('fs');",
      "fs.mkdirSync('.mergeide', { recursive: true });",
      "fs.writeFileSync('.mergeide/welcome-ai-result.json', JSON.stringify({",
      "  task_id: 'local:welcome-ai',",
      "  status: 'pass',",
      "  message: 'Docker sandbox smoke wrote this file from inside /workspace.'",
      "}, null, 2) + '\\n');",
      "console.log('welcome-ai-result.json written');"
    ].join(" "))
  ].join(" ");
  const run = await runShellInDockerSandbox(script, {
    workspaceRoot: context.workspaceRoot,
    packageRoot: context.packageRoot,
    settingsFile: context.settingsPath,
    timeoutMs: 60000
  });
  const validation = await validateWelcomeAIResult(context.workspaceRoot);
  return {
    run,
    validation
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveWorkspacePath(workspaceRoot, requestedPath) {
  const root = path.resolve(workspaceRoot);
  const requested = String(requestedPath || ".").trim() || ".";
  const candidate = path.resolve(root, requested);
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error("path escapes workspace");
}

function relativeWorkspacePath(workspaceRoot, absolutePath) {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  return relative || ".";
}

async function listDirectory(workspaceRoot, directory) {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    throw new Error("path is not a directory");
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    let entryStat = null;
    try {
      entryStat = await fs.stat(absolute);
    } catch {
      entryStat = null;
    }
    rows.push({
      name: entry.name,
      path: relativeWorkspacePath(workspaceRoot, absolute),
      type: entry.isDirectory() ? "directory" : "file",
      size: entryStat ? entryStat.size : 0,
      mtime: entryStat ? entryStat.mtime.toISOString() : ""
    });
  }
  rows.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return {
    path: relativeWorkspacePath(workspaceRoot, directory),
    parent: parentRelativePath(workspaceRoot, directory),
    entries: rows
  };
}

async function listLocalWorkspaces(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const rows = [];
  for (const source of await localTaskSources(root)) {
    let entries = [];
    try {
      entries = await fs.readdir(source.tasksRoot, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const artifactRoot = path.join(source.tasksRoot, entry.name);
      const taskFile = path.join(artifactRoot, "task.json");
      const promptFile = path.join(artifactRoot, "prompt.md");
      let task = null;
      try {
        task = JSON.parse(await fs.readFile(taskFile, "utf8"));
      } catch {
        task = { id: entry.name, title: entry.name, project_id: "" };
      }
      let stat = null;
      try {
        stat = await fs.stat(artifactRoot);
      } catch {
        stat = null;
      }
      rows.push({
        id: String(task.id || entry.name),
        title: String(task.title || entry.name),
        project_id: String(task.project_id || task.projectID || ""),
        project_title: String(task.project_title || task.projectTitle || task.project_id || task.projectID || source.projectName || ""),
        repo: String(task.repo || task.repo_url || ""),
        status: String(task.status || "local"),
        required_worker_kind: String(task.required_worker_kind || task.worker_kind || ""),
        local_test: Boolean(task.local_test),
        artifact_path: relativeWorkspacePath(root, artifactRoot).replace(/\\/g, "/"),
        prompt_path: relativeWorkspacePath(root, promptFile).replace(/\\/g, "/"),
        task_path: relativeWorkspacePath(root, taskFile).replace(/\\/g, "/"),
        project_workspace_path: relativeWorkspacePath(root, source.workspaceRoot).replace(/\\/g, "/"),
        project_checkout: source.workspaceRoot !== root,
        mtime: stat ? stat.mtime.toISOString() : ""
      });
    }
  }

  rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return rows;
}

async function localTaskSources(root) {
  const sources = [{
    tasksRoot: path.join(root, ".mergeide", "tasks"),
    workspaceRoot: root,
    projectName: ""
  }];
  const projectsRoot = path.join(root, ".mergeide", "projects");
  let projects = [];
  try {
    projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workspace = path.join(projectsRoot, entry.name);
    sources.push({
      tasksRoot: path.join(workspace, ".mergeide", "tasks"),
      workspaceRoot: workspace,
      projectName: entry.name
    });
  }
  return sources;
}

function parentRelativePath(workspaceRoot, directory) {
  const root = path.resolve(workspaceRoot);
  const current = path.resolve(directory);
  if (current === root) {
    return "";
  }
  return relativeWorkspacePath(root, path.dirname(current));
}

async function readWorkspaceFile(workspaceRoot, filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("path is not a file");
  }
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`file is larger than ${MAX_TEXT_FILE_BYTES} bytes`);
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    throw new Error("binary files cannot be edited in MRGMinner IDE");
  }
  return {
    path: relativeWorkspacePath(workspaceRoot, filePath),
    content: buffer.toString("utf8"),
    size: stat.size,
    mtime: stat.mtime.toISOString()
  };
}

function normalizeCommandArgs(input) {
  const args = Array.isArray(input) ? input.map(String).filter(Boolean) : [];
  if (!args.length) {
    throw new Error("command is empty");
  }
  const normalized = args[0] === "mrgminner" || args[0] === "mergeide" ? args.slice(1) : args.slice();
  if (!normalized.length) {
    normalized.push("status");
  }
  const command = String(normalized[0] || "").toLowerCase();
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`command is not available in IDE: ${command}`);
  }
  if (command === "run" || command === "claim" || command === "submit" || (command === "next" && !normalized.includes("--dry-run"))) {
    const confirmed = normalized.includes("--yes") || normalized.includes("--confirm");
    if (!confirmed) {
      throw new Error(`${command} requires --yes in the IDE terminal`);
    }
  }
  return normalized.filter((arg) => arg !== "--yes" && arg !== "--confirm");
}

function parseCommandLine(text) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of String(text || "")) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("unterminated quote");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

async function runMRGMinnerSandboxCommand(args, options) {
  emitRunEvent(options, `starting Docker sandbox command: mrgminner ${args.join(" ")}`);
  const result = await runInDockerSandbox(args, {
    workspaceRoot: options.workspaceRoot,
    packageRoot: options.packageRoot,
    settingsFile: options.settingsFile,
    timeoutMs: options.timeoutMs || COMMAND_TIMEOUT_MS,
    env: options.env || process.env,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  });
  emitRunEvent(options, `Docker sandbox command finished with exit ${result.code}`);
  return {
    ...result,
    args,
    commandLine: ["mrgminner", ...args].join(" "),
    sandbox_required: true
  };
}

function isHostAICommand(args) {
  const command = String(args && args[0] || "").toLowerCase();
  if (command === "run") {
    return true;
  }
  if (command === "next" && !(args || []).includes("--dry-run")) {
    return true;
  }
  return false;
}

async function runMRGMinnerHostAICommand(args, options) {
  const command = String(args[0] || "").toLowerCase();
  emitRunEvent(options, `resolving ${command} task`);
  const taskID = command === "run"
    ? args[1]
    : await nextHostAITaskID(args, options);
  if (!taskID) {
    return {
      code: 1,
      signal: null,
      timedOut: false,
      duration_ms: 0,
      stdout: "No open MergeOS task matched the current filters.\n",
      stderr: "",
      args,
      commandLine: ["mrgminner", ...args].join(" "),
      runner: {
        type: "host-ai",
        cwd: options.workspaceRoot
      },
      sandbox: dockerPromptContext(options)
    };
  }
  emitRunEvent(options, `loading settings for host AI`);
  const settings = await loadSettings(options.settingsFile);
  emitRunEvent(options, `loading task ${taskID}`);
  const task = await taskById({
    settingsPath: options.settingsFile,
    workspaceRoot: options.workspaceRoot
  }, taskID);
  const taskWorkspaceRoot = await ensureTaskWorkspace(task, options);
  emitRunEvent(options, `writing prompt/task artifacts for ${task.id}`);
  const artifacts = await prepareTaskArtifacts(settings, task, {
    workspaceRoot: taskWorkspaceRoot,
    sandbox: dockerPromptContext({ ...options, workspaceRoot: taskWorkspaceRoot })
  });
  const invocation = resolveAIInvocation(settings, artifacts, task);
  const aiLogFile = path.join(artifacts.artifactRoot, "host-ai.log");
  await fs.writeFile(aiLogFile, `# MRGMinner host AI log\n# task ${task.id}\n# started ${new Date().toISOString()}\n\n`, "utf8");
  emitRunEvent(options, `streaming host AI output to ${aiLogFile}`);
  const tee = teeProcessOutput(options, aiLogFile);
  emitRunEvent(options, `starting host AI: ${invocation.command} ${invocation.args.join(" ")}`);
  const result = await runHostProcess(invocation.command, invocation.args, {
    cwd: taskWorkspaceRoot,
    timeoutMs: options.timeoutMs || COMMAND_TIMEOUT_MS,
    env: hostAIEnv({ ...options, workspaceRoot: taskWorkspaceRoot }),
    stdin: invocation.stdin,
    onStdout: tee.onStdout,
    onStderr: tee.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  });
  await fs.appendFile(aiLogFile, `\n# finished ${new Date().toISOString()} exit=${result.code} signal=${result.signal || ""}\n`, "utf8");
  emitRunEvent(options, `host AI exited with code ${result.code}`);
  if (task.local_test) {
    emitRunEvent(options, `validating local task result`);
  }
  const validation = task.local_test ? await validateWelcomeAIResult(taskWorkspaceRoot) : null;
  let publishPR = null;
  if (!task.local_test && result.code === 0 && !result.cancelled) {
    publishPR = await autoPublishTaskPR(task, taskWorkspaceRoot, artifacts, result, {
      ...options,
      runner: {
        command: invocation.command,
        args: invocation.args
      },
      aiLogFile
    });
  }
  return {
    ...result,
    args,
    commandLine: ["mrgminner", ...args].join(" "),
    runner: {
      type: "host-ai",
      command: invocation.command,
      args: invocation.args,
      cwd: taskWorkspaceRoot
    },
    sandbox: dockerPromptContext({ ...options, workspaceRoot: taskWorkspaceRoot }),
    artifacts: {
      promptFile: artifacts.promptFile,
      taskFile: artifacts.taskFile,
      artifactRoot: artifacts.artifactRoot,
      aiLogFile
    },
    validation,
    publish_pr: publishPR
  };
}

function teeProcessOutput(options, logFile) {
  const write = (text) => {
    fs.appendFile(logFile, sanitizeTerminalText(text), "utf8").catch(() => {});
  };
  return {
    onStdout: (text) => {
      write(text);
      if (typeof options.onStdout === "function") {
        options.onStdout(text);
      }
    },
    onStderr: (text) => {
      write(text);
      if (typeof options.onStderr === "function") {
        options.onStderr(text);
      }
    }
  };
}

async function autoPublishTaskPR(task, workspaceRoot, artifacts, runResult, options = {}) {
  const commandOptions = {
    cwd: workspaceRoot,
    timeoutMs: options.timeoutMs || COMMAND_TIMEOUT_MS,
    env: process.env,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onEvent: options.onEvent,
    signal: options.signal
  };
  try {
    emitRunEvent(options, "checking git workspace for publish");
    const inside = await runHostProcess("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspaceRoot,
      timeoutMs: 15000,
      env: process.env,
      signal: options.signal
    });
    if (inside.code !== 0 || !/true/i.test(inside.stdout)) {
      return { skipped: true, reason: "workspace is not a git checkout" };
    }

    const baseBranch = await resolveBaseBranch(workspaceRoot, options);
    const branch = await uniqueTaskBranch(workspaceRoot, task, options);
    emitRunEvent(options, `creating task branch ${branch}`);
    const checkout = await runHostProcess("git", ["checkout", "-B", branch], commandOptions);
    if (checkout.code !== 0) {
      return publishError("git checkout failed", checkout);
    }

    emitRunEvent(options, "staging code changes for PR");
    const add = await runHostProcess("git", ["add", "-A", "--", "."], commandOptions);
    if (add.code !== 0) {
      return publishError("git add failed", add);
    }
    await runHostProcess("git", ["reset", "--", ".mergeide"], {
      cwd: workspaceRoot,
      timeoutMs: 15000,
      env: process.env,
      signal: options.signal
    });
    const staged = await runHostProcess("git", ["diff", "--cached", "--name-only"], {
      cwd: workspaceRoot,
      timeoutMs: 15000,
      env: process.env,
      signal: options.signal
    });
    const files = staged.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!files.length) {
      emitRunEvent(options, "no staged code changes; skipping PR");
      return { skipped: true, reason: "no code changes to commit" };
    }

    const message = commitTitle(task);
    emitRunEvent(options, `committing ${files.length} changed file(s)`);
    const commit = await runHostProcess("git", ["commit", "-m", message], commandOptions);
    if (commit.code !== 0) {
      return publishError("git commit failed", commit);
    }
    const shaResult = await runHostProcess("git", ["rev-parse", "--short", "HEAD"], {
      cwd: workspaceRoot,
      timeoutMs: 15000,
      env: process.env,
      signal: options.signal
    });
    const diffStat = await runHostProcess("git", ["show", "--stat", "--oneline", "--no-renames", "HEAD"], {
      cwd: workspaceRoot,
      timeoutMs: 15000,
      env: process.env,
      signal: options.signal
    });

    const body = buildPullRequestBody(task, {
      branch,
      baseBranch,
      commit: shaResult.stdout.trim(),
      files,
      diffStat: diffStat.stdout,
      runResult,
      artifacts,
      runner: options.runner,
      aiLogFile: options.aiLogFile
    });
    const bodyFile = path.join(artifacts.artifactRoot, "pull-request.md");
    const commentFile = path.join(artifacts.artifactRoot, "pull-request-comment.md");
    await fs.writeFile(bodyFile, body, "utf8");
    await fs.writeFile(commentFile, body, "utf8");

    emitRunEvent(options, `pushing ${branch} to origin`);
    const push = await runHostProcess("git", ["push", "-u", "origin", branch], commandOptions);
    if (push.code !== 0) {
      return publishError("git push failed", push);
    }

    emitRunEvent(options, "creating GitHub pull request");
    const create = await runHostProcess("gh", [
      "pr",
      "create",
      "--title",
      message,
      "--body-file",
      bodyFile,
      "--base",
      baseBranch,
      "--head",
      branch
    ], commandOptions);
    let url = extractFirstURL(create.stdout);
    if (create.code !== 0) {
      const existing = await runHostProcess("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
        cwd: workspaceRoot,
        timeoutMs: 30000,
        env: process.env,
        signal: options.signal
      });
      url = extractFirstURL(existing.stdout);
      if (!url) {
        return publishError("gh pr create failed", create);
      }
    }

    emitRunEvent(options, `commenting PR evidence ${url}`);
    const comment = await runHostProcess("gh", ["pr", "comment", url, "--body-file", commentFile], commandOptions);
    if (comment.code !== 0) {
      return {
        url,
        branch,
        base: baseBranch,
        commit: shaResult.stdout.trim(),
        files,
        bodyFile,
        commentFile,
        comment_error: comment.stderr || comment.stdout || `exit ${comment.code}`
      };
    }
    emitRunEvent(options, `pull request ready ${url}`);
    return {
      url,
      branch,
      base: baseBranch,
      commit: shaResult.stdout.trim(),
      files,
      bodyFile,
      commentFile
    };
  } catch (error) {
    return {
      error: error && error.message ? error.message : String(error)
    };
  }
}

function publishError(message, result) {
  return {
    error: message,
    code: result && result.code,
    stdout: sanitizeTerminalText(result && result.stdout || ""),
    stderr: sanitizeTerminalText(result && result.stderr || "")
  };
}

async function resolveBaseBranch(workspaceRoot, options = {}) {
  const remoteHead = await runHostProcess("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
    cwd: workspaceRoot,
    timeoutMs: 15000,
    env: process.env,
    signal: options.signal
  });
  const normalized = remoteHead.stdout.trim().replace(/^origin\//, "");
  if (remoteHead.code === 0 && normalized) {
    return normalized;
  }
  const current = await runHostProcess("git", ["branch", "--show-current"], {
    cwd: workspaceRoot,
    timeoutMs: 15000,
    env: process.env,
    signal: options.signal
  });
  return current.stdout.trim() || "master";
}

async function uniqueTaskBranch(workspaceRoot, task, options = {}) {
  const base = `mrgminner/${safeBranchSegment(task.id)}`;
  const exists = await runHostProcess("git", ["rev-parse", "--verify", base], {
    cwd: workspaceRoot,
    timeoutMs: 15000,
    env: process.env,
    signal: options.signal
  });
  if (exists.code !== 0) {
    return base;
  }
  return `${base}-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 12)}`;
}

function safeBranchSegment(value) {
  return String(value || "task")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "task";
}

function commitTitle(task) {
  const raw = `MRGMinner ${task.id}: ${task.title || "task update"}`;
  return raw.replace(/\s+/g, " ").slice(0, 140);
}

function buildPullRequestBody(task, details = {}) {
  const taskJson = JSON.stringify(task, null, 2);
  const files = (details.files || []).map((file) => `- \`${file}\``).join("\n") || "- No file list available";
  return [
    "## MergeOS Task",
    "",
    `- Task: \`${task.id}\``,
    `- Title: ${task.title || task.id}`,
    `- Project: \`${task.project_id || "-"}\` ${task.project_title || ""}`.trim(),
    `- Reward: ${(Number(task.reward_cents || 0) / 100).toFixed(2)} MRG`,
    task.issue_url ? `- Issue: ${task.issue_url}` : "- Issue: not provided",
    "",
    "## Code Changes",
    "",
    files,
    "",
    "```text",
    sanitizeTerminalText(details.diffStat || "").trim() || "No diff stat available",
    "```",
    "",
    "## Verification",
    "",
    `- Host AI exit code: \`${details.runResult && details.runResult.code}\``,
    `- Runner: \`${details.runner ? [details.runner.command, ...(details.runner.args || [])].join(" ") : "host AI"}\``,
    `- Prompt file: \`${details.artifacts && details.artifacts.promptFile || ""}\``,
    `- AI log file: \`${details.aiLogFile || ""}\``,
    "- Payout release: not performed by MRGMinner",
    "",
    "## Task Payload",
    "",
    "```json",
    taskJson,
    "```"
  ].join("\n");
}

function extractFirstURL(text) {
  const match = String(text || "").match(/https:\/\/[^\s]+/);
  return match ? match[0] : "";
}

async function ensureTaskWorkspace(task, options) {
  if (!task || task.local_test || !task.repo) {
    return path.resolve(options.workspaceRoot || process.cwd());
  }
  const projectsRoot = path.join(path.resolve(options.workspaceRoot || process.cwd()), ".mergeide", "projects");
  const projectID = String(task.project_id || task.projectID || repoNameFromUrl(task.repo) || task.id || "project");
  const projectRoot = path.join(projectsRoot, safePathSegment(projectID));
  let stat = null;
  try {
    stat = await fs.stat(projectRoot);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!stat) {
    await fs.mkdir(projectsRoot, { recursive: true });
    emitRunEvent(options, `cloning ${task.repo} into ${projectRoot}`);
    const cloned = await runHostProcess("git", ["clone", "--depth", "1", task.repo, projectRoot], {
      cwd: projectsRoot,
      timeoutMs: options.timeoutMs || COMMAND_TIMEOUT_MS,
      env: process.env,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      onEvent: options.onEvent,
      signal: options.signal
    });
    if (cloned.code !== 0) {
      throw new Error(`git clone failed for ${task.repo}: ${cloned.stderr || cloned.stdout || `exit ${cloned.code}`}`);
    }
    return projectRoot;
  }
  const gitDir = path.join(projectRoot, ".git");
  try {
    const gitStat = await fs.stat(gitDir);
    if (!gitStat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(`project workspace exists but is not a git checkout: ${projectRoot}`);
  }
  emitRunEvent(options, `using existing project workspace ${projectRoot}`);
  return projectRoot;
}

function repoNameFromUrl(repoUrl) {
  const clean = String(repoUrl || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = clean.split(/[\\/]/).pop() || "";
  return name.replace(/\.git$/i, "");
}

function safePathSegment(value) {
  return String(value || "project")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120) || "project";
}

function emitRunEvent(options, message) {
  if (options && typeof options.onEvent === "function") {
    options.onEvent(message);
  }
}

async function nextHostAITaskID(args, options) {
  const loaded = await loadIDETasks({
    settingsPath: options.settingsFile,
    workspaceRoot: options.workspaceRoot
  });
  const kind = optionValue(args, "--kind");
  const selected = loaded.tasks.find((task) => {
    if (!task || task.local_test) {
      return false;
    }
    const status = String(task.status || "").toLowerCase();
    const open = !status || ["open", "funded", "available", "in_progress", "claimed"].includes(status);
    if (!open) {
      return false;
    }
    if (kind && String(task.required_worker_kind || "agent").toLowerCase() !== String(kind).toLowerCase()) {
      return false;
    }
    return true;
  });
  return selected && selected.id || "";
}

function optionValue(args, name) {
  const index = (args || []).indexOf(name);
  if (index === -1) {
    return "";
  }
  return String(args[index + 1] || "");
}

function dockerPromptContext(options = {}) {
  return {
    type: "docker",
    image: process.env.MRGMINNER_SANDBOX_IMAGE || process.env.MERGEIDE_SANDBOX_IMAGE || "node:22-bookworm-slim",
    workspace: path.resolve(options.workspaceRoot || process.cwd()),
    mount: "/workspace"
  };
}

function hostAIEnv(options = {}) {
  return {
    ...process.env,
    MRGMINNER_SANDBOX: "docker",
    MRGMINNER_SANDBOX_IMAGE: process.env.MRGMINNER_SANDBOX_IMAGE || process.env.MERGEIDE_SANDBOX_IMAGE || "node:22-bookworm-slim",
    MRGMINNER_SANDBOX_WORKSPACE: "/workspace",
    MRGMINNER_HOST_WORKSPACE: path.resolve(options.workspaceRoot || process.cwd())
  };
}

async function checkHostCommand(commandName, options = {}) {
  const command = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [commandName] : ["-lc", `command -v ${shellQuote(commandName)}`];
  return runHostProcess(command, args, {
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs || 15000,
    env: process.env
  });
}

function runHostProcess(command, args, options) {
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
      env: options.env || process.env,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
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
      terminateChildProcess(child, options);
    };
    if (typeof options.onEvent === "function") {
      options.onEvent(`spawned ${command} pid ${child.pid || "unknown"}`);
    }
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.stdin && child.stdin) {
      child.stdin.end(options.stdin);
    }
    const timer = setTimeout(() => {
      killedForLimit = true;
      if (typeof options.onEvent === "function") {
        options.onEvent(`timeout reached; stopping ${command}`);
      }
      terminateChildProcess(child, options);
    }, options.timeoutMs || COMMAND_TIMEOUT_MS);
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
      if (error && error.code === "ENOENT") {
        resolve({
          args,
          commandLine: [command, ...args].join(" "),
          code: 127,
          signal: null,
          timedOut: false,
          cancelled,
          duration_ms: Date.now() - startedAt,
          stdout,
          stderr: error.message
        });
        return;
      }
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

function terminateChildProcess(child, options = {}) {
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
    } catch {
      // Fall back to the normal kill path below.
    }
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

function appendLimited(current, chunk) {
  const limit = 1024 * 1024;
  const next = current + chunk.toString("utf8");
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function sanitizeTerminalText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

async function packageVersion(packageRoot) {
  try {
    const raw = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version || "";
  } catch {
    return "";
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, statusCode, payload) {
  return sendText(response, statusCode, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

function sendText(response, statusCode, text, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(text);
}

function sendError(response, error) {
  const status = error && error.statusCode ? error.statusCode : 400;
  sendJson(response, status, {
    error: error && error.message ? error.message : String(error)
  });
}

async function streamCommandResponse(request, response, context) {
  const body = await readJsonBody(request);
  const args = normalizeCommandArgs(body.args || parseCommandLine(body.commandLine || ""));
  const abortController = new AbortController();
  let completed = false;
  const abortStream = () => {
    if (!completed) {
      abortController.abort();
    }
  };
  request.on("aborted", abortStream);
  response.on("close", abortStream);
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  const write = (type, payload = {}) => {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    response.write(`${JSON.stringify({ type, ...payload })}\n`);
  };
  const streamOptions = {
    onStdout: (text) => write("stdout", { text: sanitizeTerminalText(text) }),
    onStderr: (text) => write("stderr", { text: sanitizeTerminalText(text) }),
    onEvent: (message) => write("event", { message }),
    signal: abortController.signal
  };
  try {
    write("start", {
      commandLine: ["mrgminner", ...args].join(" "),
      runner: isHostAICommand(args) ? "host-ai" : "docker-sandbox"
    });
    const result = isHostAICommand(args)
      ? await runMRGMinnerHostAICommand(args, {
        workspaceRoot: context.workspaceRoot,
        packageRoot: context.packageRoot,
        settingsFile: context.settingsPath,
        timeoutMs: Number(body.timeoutMs || COMMAND_TIMEOUT_MS),
        ...streamOptions
      })
      : await runMRGMinnerSandboxCommand(args, {
        workspaceRoot: context.workspaceRoot,
        packageRoot: context.packageRoot,
        settingsFile: context.settingsPath,
        timeoutMs: Number(body.timeoutMs || COMMAND_TIMEOUT_MS),
        ...streamOptions
      });
    write("result", {
      result: {
        ...result,
        stdout: "",
        stderr: ""
      }
    });
  } catch (error) {
    write("error", {
      error: error && error.message ? error.message : String(error)
    });
  } finally {
    completed = true;
    request.off("aborted", abortStream);
    response.off("close", abortStream);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }
}

function clientHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MRGMinner IDE</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101215;
      --panel: #171a1f;
      --panel-2: #1f242b;
      --line: #2d333d;
      --text: #f2f5f8;
      --muted: #9aa6b2;
      --blue: #65a9ff;
      --green: #39d98a;
      --red: #ff6f6f;
      --yellow: #f4c95d;
      --focus: #88b7ff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    * {
      scrollbar-width: thin;
      scrollbar-color: #4b5563 #15191f;
    }
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track { background: #15191f; }
    *::-webkit-scrollbar-thumb {
      background: #4b5563;
      border: 2px solid #15191f;
      border-radius: 999px;
    }
    [hidden] { display: none !important; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
      letter-spacing: 0;
    }
    button, input, select, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: #242a32;
      color: var(--text);
      min-height: 28px;
      padding: 0 9px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover { border-color: var(--focus); background: #2a323d; }
    button.primary { background: #1f5d42; border-color: #2b8f61; }
    button.warn { background: #4f3820; border-color: #8a6428; }
    button.danger { background: #532728; border-color: #9c3d3f; }
    button.icon { width: 34px; padding: 0; }
    input, select {
      width: 100%;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #111419;
      color: var(--text);
      padding: 0 10px;
      outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--focus); }
    .shell {
      height: 100vh;
      display: grid;
      grid-template-rows: 42px 30px minmax(0, 1fr) var(--terminal-height, 168px);
      min-width: 0;
    }
    .topbar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 0 12px;
      border-bottom: 1px solid var(--line);
      background: #14181d;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 164px;
      font-weight: 700;
    }
    .mark {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      background: linear-gradient(135deg, var(--green), var(--blue));
    }
    .workspace {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .top-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
      overflow: hidden;
      justify-content: flex-end;
    }
    .top-actions .pill {
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .activity-bar {
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-bottom: 1px solid var(--line);
      background: #11161c;
      color: var(--muted);
      font-size: 12px;
    }
    .activity-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activity-elapsed {
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      color: #7f91a6;
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid #2d3743;
      border-top-color: var(--green);
      border-radius: 999px;
    }
    body.is-busy .spinner {
      animation: spin .75s linear infinite;
    }
    body.is-busy button:not(.stop-button),
    body.is-busy input,
    body.is-busy select {
      opacity: .58;
      pointer-events: none;
    }
    .stop-button {
      min-height: 22px;
      padding: 0 10px;
      font-size: 12px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .main {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-columns:
        clamp(220px, 18vw, 280px)
        clamp(270px, 24vw, 360px)
        minmax(280px, 1fr)
        clamp(300px, 25vw, 360px);
    }
    body.workspace-mode .main {
      grid-template-columns: clamp(260px, 28vw, 340px) minmax(280px, 1fr);
    }
    body.workspace-mode .task-column {
      display: none;
    }
    body.workspace-mode .detail {
      display: none;
    }
    .navigator, .task-column, .detail {
      min-height: 0;
      min-width: 0;
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: grid;
    }
    .navigator { grid-template-rows: auto auto minmax(0, 1fr); }
    .task-column { grid-template-rows: auto minmax(0, 1fr); }
    .detail {
      border-right: 0;
      border-left: 1px solid var(--line);
      grid-template-rows: auto minmax(0, 1fr);
    }
    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--line);
    }
    .tab {
      height: 34px;
      border: 0;
      border-right: 1px solid var(--line);
      border-radius: 0;
      background: #15191f;
      color: var(--muted);
    }
    .tab.active {
      background: var(--panel);
      color: var(--text);
      box-shadow: inset 0 -2px var(--green);
    }
    .task-list, .file-list {
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
    }
    .task-row, .file-row {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      min-height: 44px;
      text-align: left;
      padding: 8px 10px;
      display: grid;
      gap: 4px;
    }
    .file-row {
      min-height: 36px;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
    }
    .task-row.active, .file-row.active {
      background: #203142;
    }
    .task-row .title, .file-row .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .file-row .title {
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      color: #d7e3ef;
    }
    .file-row .meta {
      justify-content: flex-end;
      font-size: 11px;
      color: #8fa1b3;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      height: 20px;
      padding: 0 7px;
      border-radius: 999px;
      background: #252c34;
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .pill.green { color: var(--green); }
    .pill.yellow { color: var(--yellow); }
    .pill.red { color: var(--red); }
    .pill.blue { color: var(--blue); }
    .tasks-panel {
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .work-groups {
      min-height: 0;
      overflow: auto;
    }
    .workspace-panel {
      min-height: 0;
      display: grid;
      grid-template-rows: minmax(120px, 36%) auto minmax(0, 1fr);
    }
    .local-workspaces {
      min-height: 0;
      overflow: auto;
      border-bottom: 1px solid var(--line);
    }
    .workspace-row {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: #15191f;
      min-height: 46px;
      text-align: left;
      padding: 8px 10px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .workspace-row.active {
      background: #203142;
      box-shadow: inset 2px 0 var(--blue);
    }
    .workspace-main {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .workspace-row .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
    }
    .mini-button {
      min-height: 24px;
      padding: 0 8px;
      font-size: 12px;
    }
    .work-row {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: #15191f;
      min-height: 42px;
      text-align: left;
      padding: 8px 10px;
      display: grid;
      gap: 4px;
    }
    .work-row.active {
      background: #203142;
      box-shadow: inset 2px 0 var(--green);
    }
    .work-row.locked {
      opacity: .48;
      cursor: not-allowed;
    }
    .work-row .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
    }
    .list-heading {
      min-height: 30px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      background: #12161b;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nav-heading {
      min-height: 32px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      background: #12161b;
      text-transform: uppercase;
    }
    .editor {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-rows: 40px minmax(0, 1fr);
      background: #111419;
    }
    .editorbar, .sectionbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 36px;
      padding: 0 10px;
      border-bottom: 1px solid var(--line);
      background: #15191f;
    }
    .filename, .section-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--muted);
    }
    .editor-actions, .section-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .inspector-tabs {
      display: flex;
      min-width: 0;
      gap: 4px;
      align-items: center;
    }
    .inspector-tab {
      min-height: 26px;
      padding: 0 8px;
      color: var(--muted);
      background: transparent;
      border-color: transparent;
    }
    .inspector-tab.active {
      color: var(--text);
      background: #242a32;
      border-color: var(--line);
    }
    textarea {
      width: 100%;
      height: 100%;
      resize: none;
      border: 0;
      outline: none;
      background: #101215;
      color: #e9edf2;
      padding: 16px;
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      font-size: 13px;
      line-height: 1.55;
      tab-size: 2;
    }
    .task-detail {
      min-height: 0;
      min-width: 0;
      overflow: auto;
      padding: 10px;
      display: grid;
      align-content: start;
      gap: 10px;
    }
    .detail-title {
      font-weight: 700;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .kv {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .kv strong { color: var(--text); font-weight: 600; }
    .kv span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .actions-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .actions-grid button {
      min-height: 28px;
      font-size: 12px;
      min-width: 72px;
      flex: 1 1 74px;
      padding: 0 8px;
    }
    .summary-panel {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #111419;
      padding: 10px;
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .summary-panel strong {
      color: var(--text);
      font-weight: 600;
    }
    .summary-panel code {
      color: #d7e3ef;
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .summary-row {
      display: grid;
      grid-template-columns: 70px minmax(0, 1fr);
      gap: 8px;
    }
    .summary-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tool-panel {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      display: grid;
      gap: 10px;
    }
    .tool-title {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
    }
    .form-grid {
      display: grid;
      gap: 8px;
    }
    .form-grid label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .checkbox-row input {
      width: auto;
      min-height: auto;
    }
    .terminal {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-rows: 7px minmax(0, 1fr);
      border-top: 1px solid var(--line);
      background: #090b0e;
    }
    .terminal-resizer {
      cursor: row-resize;
      background: #141a20;
      border-bottom: 1px solid #202833;
      position: relative;
    }
    .terminal-resizer::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 2px;
      width: 42px;
      height: 2px;
      transform: translateX(-50%);
      border-radius: 999px;
      background: #3a4654;
    }
    .terminal-resizer:hover::after {
      background: var(--focus);
    }
    .termout {
      overflow: auto;
      margin: 0;
      padding: 12px;
      color: #d8e0e8;
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .empty {
      padding: 18px 12px;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 1180px) {
      .main { grid-template-columns: 220px 300px minmax(0, 1fr); }
      .detail { display: none; }
      body.workspace-mode .main { grid-template-columns: 260px minmax(0, 1fr); }
      .top-actions .pill:nth-child(n+3) { display: none; }
    }
    @media (max-width: 820px) {
      .brand { min-width: 0; }
      .brand span:last-child { display: none; }
      .main { grid-template-columns: 210px minmax(0, 1fr); }
      .task-column { display: none; }
      body.workspace-mode .main { grid-template-columns: 230px minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="mark"></span><span>MRGMinner IDE</span></div>
      <div class="workspace" id="workspace">Loading workspace...</div>
      <div class="top-actions">
        <span class="pill yellow" id="docker-status">Docker</span>
        <span class="pill blue" id="sandbox-image">sandbox</span>
        <span class="pill" id="provider">provider</span>
        <span class="pill green" id="task-count">tasks</span>
        <button id="refresh" title="Refresh workspace state">Refresh</button>
      </div>
    </header>
    <div class="activity-bar" id="activity-bar">
      <span class="spinner" id="activity-spinner" hidden></span>
      <span class="activity-text" id="activity-text">Starting IDE...</span>
      <span class="activity-elapsed" id="activity-elapsed"></span>
      <button id="stop-run" class="danger stop-button" hidden>Stop</button>
    </div>
    <main class="main">
      <aside class="navigator">
        <div class="tabs">
          <button class="tab active" data-tab="tasks">Tasks</button>
          <button class="tab" data-tab="files">Workspace</button>
        </div>
        <div class="nav-heading" id="navigator-heading">Work pools</div>
        <div id="work-groups" class="work-groups"></div>
        <div id="workspace-pane" class="workspace-panel" hidden>
          <div id="local-workspaces" class="local-workspaces"></div>
          <div class="nav-heading" id="workspace-files-heading">Workspace files</div>
          <div id="files-pane" class="file-list"></div>
        </div>
      </aside>
      <aside id="tasks-pane" class="task-column">
        <div class="list-heading" id="task-list-heading">Tasks</div>
        <div id="task-list" class="task-list"></div>
      </aside>
      <section class="editor">
        <div class="editorbar">
          <div class="filename" id="filename">No file open</div>
          <div class="editor-actions">
            <button id="reload-file" title="Reload current file">Reload</button>
            <button id="save-file" class="primary" title="Save current file">Save</button>
          </div>
        </div>
        <textarea id="editor" spellcheck="false"></textarea>
      </section>
      <aside class="detail">
        <div class="sectionbar">
          <div class="inspector-tabs">
            <button class="inspector-tab active" data-inspector="task">Task</button>
            <button class="inspector-tab" data-inspector="ai">AI</button>
            <button class="inspector-tab" data-inspector="docker">Docker</button>
          </div>
          <div class="section-actions">
            <button id="prepare-task" class="primary">Prepare</button>
          </div>
        </div>
        <div id="task-detail" class="task-detail"></div>
      </aside>
    </main>
    <section class="terminal">
      <div id="terminal-resizer" class="terminal-resizer" title="Drag to resize console"></div>
      <pre id="terminal-output" class="termout"></pre>
    </section>
  </div>
  <script>
    const state = {
      tasks: [],
      groups: [],
      selectedGroup: "all",
      selectedTask: null,
      currentFile: "",
      currentDir: ".",
      localWorkspaces: [],
      selectedWorkspace: "",
      activeTab: "tasks",
      inspectorTab: "task",
      docker: null,
      ai: null,
      aiTested: false,
      welcomePassed: false,
      terminalHeight: 168,
      activity: null,
      activitySeq: 0,
      activityTimer: null,
      activityHeartbeat: null
    };
    const $ = (id) => document.getElementById(id);
    const terminal = $("terminal-output");

    function appendTerminal(text) {
      writeTerminal(cleanTerminalText(text));
    }

    function logStep(text) {
      appendTerminalLine("# " + new Date().toLocaleTimeString() + " " + text);
    }

    function appendTerminalLine(text) {
      const cleaned = cleanTerminalText(text);
      if (!cleaned) return;
      if (terminal.textContent && !terminal.textContent.endsWith("\\n")) {
        writeTerminal("\\n", false);
      }
      writeTerminal(cleaned.endsWith("\\n") ? cleaned : cleaned + "\\n", false);
    }

    function writeTerminal(text, clean) {
      const next = clean === false ? text : cleanTerminalText(text);
      if (!next) return;
      terminal.textContent += next;
      terminal.scrollTop = terminal.scrollHeight;
    }

    function cleanTerminalText(value) {
      const ANSI_CSI = new RegExp(String.fromCharCode(27) + "\\\\[[0-?]*[ -/]*[@-~]", "g");
      return String(value || "")
        .replace(/\\r\\n/g, "\\n")
        .replace(/\\r/g, "\\n")
        .replace(ANSI_CSI, "")
        .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, "");
    }

    function initTerminalResize() {
      const saved = Number(localStorage.getItem("mrgminner-terminal-height") || 0);
      setTerminalHeight(saved || state.terminalHeight);
      const handle = $("terminal-resizer");
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = state.terminalHeight;
        handle.setPointerCapture(event.pointerId);
        const move = (moveEvent) => {
          const next = startHeight - (moveEvent.clientY - startY);
          setTerminalHeight(next);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          localStorage.setItem("mrgminner-terminal-height", String(state.terminalHeight));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
      });
    }

    function setTerminalHeight(value) {
      const max = Math.max(140, Math.floor(window.innerHeight * 0.7));
      const next = Math.max(96, Math.min(max, Math.round(Number(value) || 168)));
      state.terminalHeight = next;
      document.documentElement.style.setProperty("--terminal-height", next + "px");
    }

    function beginActivity(label, detail, options) {
      const opts = options || {};
      const id = ++state.activitySeq;
      clearActivityTimers();
      state.activity = {
        id,
        label,
        detail: detail || "",
        startedAt: Date.now(),
        stop: typeof opts.stop === "function" ? opts.stop : null
      };
      updateActivityUI();
      if (opts.log !== false) {
        logStep("start: " + label + (detail ? " - " + detail : ""));
      }
      state.activityTimer = setInterval(updateActivityUI, 1000);
      if (opts.heartbeat) {
        const interval = Math.max(5000, Number(opts.heartbeatMs || 15000));
        state.activityHeartbeat = setInterval(() => {
          if (state.activity && state.activity.id === id) {
            logStep("still running: " + opts.heartbeat + " (" + elapsedText(Date.now() - state.activity.startedAt) + ")");
          }
        }, interval);
      }
      return (status, message) => finishActivity(id, status, message);
    }

    function finishActivity(id, status, message) {
      if (!state.activity || state.activity.id !== id) {
        return;
      }
      const elapsed = elapsedText(Date.now() - state.activity.startedAt);
      clearActivityTimers();
      if (status) {
        logStep(status + ": " + state.activity.label + " in " + elapsed + (message ? " - " + message : ""));
      }
      state.activity = null;
      updateActivityUI();
    }

    function clearActivityTimers() {
      if (state.activityTimer) {
        clearInterval(state.activityTimer);
        state.activityTimer = null;
      }
      if (state.activityHeartbeat) {
        clearInterval(state.activityHeartbeat);
        state.activityHeartbeat = null;
      }
    }

    function updateActivityUI() {
      const activity = state.activity;
      const busy = Boolean(activity);
      const canStop = busy && typeof activity.stop === "function";
      document.body.classList.toggle("is-busy", busy);
      $("activity-spinner").hidden = !busy;
      $("activity-text").textContent = busy
        ? activity.label + (activity.detail ? " - " + activity.detail : "")
        : "Ready";
      $("activity-elapsed").textContent = busy ? elapsedText(Date.now() - activity.startedAt) : "";
      $("stop-run").hidden = !canStop;
      $("stop-run").disabled = !canStop;
      $("stop-run").textContent = "Stop";
    }

    function stopActiveActivity() {
      if (!state.activity || typeof state.activity.stop !== "function") {
        return;
      }
      $("stop-run").disabled = true;
      $("stop-run").textContent = "Stopping";
      logStep("stop requested by user");
      state.activity.stop();
    }

    function elapsedText(ms) {
      const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes ? minutes + "m " + String(seconds).padStart(2, "0") + "s" : seconds + "s";
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      const payload = await response.json();
      if (!response.ok || payload.error) {
        throw new Error(payload.error || response.statusText);
      }
      return payload;
    }

    async function streamCommand(line, signal) {
      const response = await fetch("/api/command/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandLine: line }),
        signal
      });
      if (!response.ok) {
        let message = response.statusText;
        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch {}
        throw new Error(message);
      }
      if (!response.body || !response.body.getReader) {
        const result = await api("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandLine: line })
        });
        if (result.stdout) appendTerminal(result.stdout);
        if (result.stderr) appendTerminal(result.stderr);
        return result;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      let streamError = "";
      for (;;) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        buffer += decoder.decode(read.value, { stream: true });
        const lines = buffer.split("\\n");
        buffer = lines.pop();
        for (const item of lines) {
          const event = parseStreamEvent(item);
          if (!event) continue;
          if (event.type === "result") {
            finalResult = event.result;
          } else if (event.type === "error") {
            streamError = event.error || "command stream failed";
          } else {
            renderCommandEvent(event);
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = parseStreamEvent(buffer);
        if (event && event.type === "result") {
          finalResult = event.result;
        } else if (event && event.type === "error") {
          streamError = event.error || "command stream failed";
        } else if (event) {
          renderCommandEvent(event);
        }
      }
      if (streamError) {
        throw new Error(streamError);
      }
      if (!finalResult) {
        throw new Error("command stream ended without a result");
      }
      return finalResult;
    }

    function parseStreamEvent(line) {
      const text = String(line || "").trim();
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        appendTerminal("# stream parse error: " + error.message + "\\n");
        return null;
      }
    }

    function renderCommandEvent(event) {
      if (event.type === "stdout" && event.text) {
        appendTerminal(event.text);
      } else if (event.type === "stderr" && event.text) {
        appendTerminal(event.text);
      } else if (event.type === "event" && event.message) {
        logStep(event.message);
      } else if (event.type === "start") {
        logStep("stream started: " + event.commandLine + " via " + event.runner);
      }
    }

    function reward(task) {
      return (Number(task.reward_cents || 0) / 100).toFixed(2);
    }

    function groupLabel(statusGroup) {
      if (statusGroup === "local") return "local";
      if (statusGroup === "in_progress") return "in progress";
      if (statusGroup === "funded") return "funded";
      return "all";
    }

    function groupPillClass(statusGroup) {
      if (statusGroup === "local") return "blue";
      if (statusGroup === "in_progress") return "yellow";
      if (statusGroup === "funded") return "green";
      return "blue";
    }

    function selectTask(task) {
      if (!state.welcomePassed && task && !task.local_test) {
        appendTerminal("# Run and pass the Welcome host-AI + Docker workspace test before selecting funded project tasks.\\n");
        return;
      }
      state.selectedTask = task;
      renderTasks();
      renderTaskDetail();
    }

    function selectGroup(groupId) {
      const target = state.groups.find((group) => group.id === groupId);
      if (!state.welcomePassed && target && target.status_group !== "local") {
        appendTerminal("# Welcome gate: pass the local host-AI + Docker workspace test before choosing a funded project.\\n");
        return;
      }
      state.selectedGroup = groupId || "all";
      const tasks = filteredTasks();
      if (!state.selectedTask || !tasks.some((task) => task.id === state.selectedTask.id)) {
        state.selectedTask = tasks[0] || null;
      }
      renderWorkGroups();
      renderTasks();
      renderTaskDetail();
    }

    function filteredTasks() {
      if (!state.welcomePassed) {
        return state.tasks.filter((task) => task.local_test);
      }
      const selected = state.groups.find((group) => group.id === state.selectedGroup);
      if (!selected || !selected.project_id) {
        return state.tasks.slice();
      }
      return state.tasks.filter((task) => String(task.project_id || "") === String(selected.project_id));
    }

    function renderWorkGroups() {
      const pane = $("work-groups");
      const groups = state.groups.length ? state.groups : [{
        id: "all",
        title: "All funded / in-progress work",
        status_group: "all",
        task_count: state.tasks.length,
        reward_mrg: state.tasks.reduce((sum, task) => sum + Number(task.reward_cents || 0) / 100, 0)
      }];
      pane.innerHTML = "";
      for (const group of groups) {
        const row = document.createElement("button");
        const locked = !state.welcomePassed && group.status_group !== "local";
        row.className = "work-row" + (state.selectedGroup === group.id ? " active" : "") + (locked ? " locked" : "");
        row.innerHTML = '<div class="title"></div><div class="meta"></div>';
        row.querySelector(".title").textContent = group.title || group.project_id || group.id;
        row.querySelector(".meta").innerHTML =
          '<span class="pill ' + groupPillClass(group.status_group) + '">' + escapeHtml(groupLabel(group.status_group)) + '</span>' +
          '<span>' + escapeHtml(String(group.task_count || group.open_tasks || 0)) + ' tasks</span>' +
          '<span>' + escapeHtml(locked ? "locked" : Number(group.reward_mrg || group.budget_mrg || 0).toFixed(2) + " MRG") + '</span>';
        row.addEventListener("click", () => selectGroup(group.id));
        pane.appendChild(row);
      }
    }

    function renderTasks() {
      const pane = $("task-list");
      const tasks = filteredTasks();
      const group = state.groups.find((item) => item.id === state.selectedGroup);
      $("task-list-heading").textContent = group && group.title ? "Tasks / " + group.title : "Tasks";
      if (!tasks.length) {
        pane.innerHTML = '<div class="empty">No tasks loaded.</div>';
        return;
      }
      pane.innerHTML = "";
      for (const task of tasks) {
        const row = document.createElement("button");
        row.className = "task-row" + (state.selectedTask && state.selectedTask.id === task.id ? " active" : "");
        row.innerHTML = '<div class="title"></div><div class="meta"></div>';
        row.querySelector(".title").textContent = task.title;
        row.querySelector(".meta").innerHTML =
          '<span class="pill green">' + escapeHtml(reward(task)) + ' MRG</span>' +
          '<span class="pill">' + escapeHtml(task.status) + '</span>' +
          '<span>' + escapeHtml(task.id) + '</span>';
        row.addEventListener("click", () => selectTask(task));
        pane.appendChild(row);
      }
    }

    function renderTaskDetail() {
      const box = $("task-detail");
      const task = state.selectedTask;
      box.innerHTML = "";
      updateInspectorTabs();
      if (state.inspectorTab === "ai") {
        renderAIPanel(box);
        return;
      }
      if (state.inspectorTab === "docker") {
        renderDockerPanel(box);
        return;
      }
      if (!task) {
        box.innerHTML = '<div class="empty">Select a task.</div>';
        return;
      }
      const title = document.createElement("div");
      title.className = "detail-title";
      title.textContent = task.title;
      box.appendChild(title);
      const fields = [
        ["ID", task.id],
        ["Status", task.status],
        ["Kind", task.required_worker_kind],
        ["Reward", reward(task) + " MRG"],
        ["Project", task.project_id || "-"]
      ];
      for (const [key, value] of fields) {
        const row = document.createElement("div");
        row.className = "kv";
        row.innerHTML = '<strong></strong><span></span>';
        row.querySelector("strong").textContent = key;
        row.querySelector("span").textContent = value;
        box.appendChild(row);
      }
      const actions = document.createElement("div");
      actions.className = "actions-grid";
      actions.innerHTML = task.local_test
        ? '<button data-action="run" class="primary">Run test</button>' +
          '<button data-action="check">Check</button>'
        : '<button data-action="run" class="primary">Run task</button>' +
          '<button data-action="dryrun">Dry run</button>' +
          '<button data-action="claim" class="warn">Claim</button>';
      actions.querySelector('[data-action="run"]').addEventListener("click", () => runAutoCommand("run " + quoteArg(task.id) + " --yes"));
      if (task.local_test) {
        actions.querySelector('[data-action="check"]').addEventListener("click", () => checkSelectedTaskPass());
      } else {
        actions.querySelector('[data-action="dryrun"]').addEventListener("click", () => runCommand("next --dry-run --kind " + quoteArg(task.required_worker_kind || "agent")));
        actions.querySelector('[data-action="claim"]').addEventListener("click", () => runCommand("claim " + quoteArg(task.id) + " --with-intent --yes"));
      }
      box.appendChild(actions);
      if (task.local_test) {
        renderLocalTestSummary(box);
      } else if (task.acceptance) {
        renderAcceptanceSummary(box, task.acceptance);
      }
    }

    function renderLocalTestSummary(box) {
      const panel = document.createElement("div");
      panel.className = "summary-panel";
      panel.innerHTML =
        '<strong>Welcome test</strong>' +
        '<div class="summary-row"><span>Goal</span><span>Confirm the host AI can edit this workspace.</span></div>' +
        '<div class="summary-row"><span>File</span><span><code>.mergeide/welcome-ai-result.json</code></span></div>' +
        '<div class="summary-row"><span>Runtime</span><span>AI runs on host; Docker mounts source at <code>/workspace</code>.</span></div>' +
        '<div class="summary-tags">' +
          '<span class="pill blue">local only</span>' +
          '<span class="pill green">no claim</span>' +
          '<span class="pill">no submit</span>' +
        '</div>';
      box.appendChild(panel);
    }

    function renderAcceptanceSummary(box, acceptanceText) {
      const panel = document.createElement("div");
      panel.className = "summary-panel";
      const title = document.createElement("strong");
      title.textContent = "Acceptance";
      const body = document.createElement("div");
      body.textContent = String(acceptanceText || "").trim();
      panel.appendChild(title);
      panel.appendChild(body);
      box.appendChild(panel);
    }

    function updateInspectorTabs() {
      document.querySelectorAll(".inspector-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.inspector === state.inspectorTab);
      });
      $("prepare-task").hidden = state.inspectorTab !== "task";
    }

    function renderAIPanel(box) {
      const ai = state.ai || { provider: "codex", command: "codex", argsText: "exec --skip-git-repo-check --sandbox workspace-write - {{promptStdin}}", providers: [] };
      const panel = document.createElement("div");
      panel.className = "tool-panel";
      panel.innerHTML =
        '<div class="tool-title">AI CLI</div>' +
        '<div class="form-grid">' +
          '<label>Provider<select id="ai-provider"></select></label>' +
          '<label>Command<input id="ai-command" spellcheck="false"></label>' +
          '<label>Args<input id="ai-args" spellcheck="false"></label>' +
          '<label class="checkbox-row"><input id="ai-auto-claim" type="checkbox"> Auto claim after run</label>' +
        '</div>' +
        '<div class="actions-grid">' +
          '<button id="save-ai">Save AI</button>' +
          '<button id="test-ai" class="primary">Test</button>' +
          '<button id="auto-next" class="warn">Auto next</button>' +
        '</div>';
      box.appendChild(panel);

      const provider = panel.querySelector("#ai-provider");
      const providers = ai.providers && ai.providers.length ? ai.providers : [
        { name: "codex", command: "codex", args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-", "{{promptStdin}}"] },
        { name: "claude", command: "claude", args: ["-p", "--output-format", "text", "{{promptStdin}}"] },
        { name: "grok", command: "grok", args: ["--no-alt-screen", "--minimal", "--permission-mode", "auto", "--prompt-file", "{{promptFile}}"] },
        { name: "custom", command: "", args: ["{{prompt}}"] }
      ];
      provider.innerHTML = providers.map((item) => '<option value="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</option>').join("");
      provider.value = ai.provider || "custom";
      panel.querySelector("#ai-command").value = ai.command || "";
      panel.querySelector("#ai-args").value = ai.argsText || (Array.isArray(ai.args) ? ai.args.join(" ") : "");
      panel.querySelector("#ai-auto-claim").checked = Boolean(ai.autoClaimAfterRun);

      provider.addEventListener("change", () => {
        const preset = providers.find((item) => item.name === provider.value);
        panel.querySelector("#ai-command").value = preset ? preset.command : "";
        panel.querySelector("#ai-args").value = preset && preset.args ? preset.args.join(" ") : "{{prompt}}";
        state.aiTested = false;
      });
      panel.querySelector("#save-ai").addEventListener("click", () => saveAIFromPanel(panel).catch((error) => appendTerminal("# error: " + error.message + "\\n")));
      panel.querySelector("#test-ai").addEventListener("click", () => testAIFromPanel(panel).catch((error) => appendTerminal("# error: " + error.message + "\\n")));
      panel.querySelector("#auto-next").addEventListener("click", () => runAutoCommand("next --yes"));
    }

    function renderDockerPanel(box) {
      const docker = state.docker;
      const panel = document.createElement("div");
      panel.className = "tool-panel";
      panel.innerHTML = '<div class="tool-title">Docker sandbox</div>';
      const rows = dockerRows(docker);
      for (const [key, value] of rows) {
        const row = document.createElement("div");
        row.className = "kv";
        row.innerHTML = '<strong></strong><span></span>';
        row.querySelector("strong").textContent = key;
        row.querySelector("span").textContent = value;
        panel.appendChild(row);
      }
      box.appendChild(panel);
    }

    function dockerRows(docker) {
      if (!docker) {
        return [["Status", "checking"]];
      }
      if (!docker.available) {
        return [
          ["Status", "unavailable"],
          ["Image", docker.image || "-"],
          ["Error", docker.error || "Docker is required"]
        ];
      }
      return [
        ["Status", "ready"],
        ["Engine", (docker.engine && docker.engine.version || "-") + " / " + (docker.engine && docker.engine.os_type || "-")],
        ["Image", docker.image || "-"],
        ["Containers", String(docker.engine && docker.engine.running || 0) + " running"],
        ["CPU/Mem", String(docker.engine && docker.engine.cpus || 0) + " CPU / " + formatBytes(docker.engine && docker.engine.memory_bytes)]
      ];
    }

    function currentAIForm(panel) {
      return {
        provider: panel.querySelector("#ai-provider").value,
        command: panel.querySelector("#ai-command").value,
        argsText: panel.querySelector("#ai-args").value,
        autoClaimAfterRun: panel.querySelector("#ai-auto-claim").checked
      };
    }

    async function saveAIFromPanel(panel) {
      const finish = beginActivity("Saving AI settings", "updating host AI provider");
      const payload = currentAIForm(panel);
      try {
        logStep("saving provider " + payload.provider + " with command " + (payload.command || "(preset)"));
        const saved = await api("/api/settings/ai", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        state.ai = saved.ai;
        state.aiTested = false;
        updateAIUI();
        renderTaskDetail();
        appendTerminal("# Saved AI CLI settings. Run Test before auto task.\\n");
        finish("done");
      } catch (error) {
        finish("failed", error.message);
        throw error;
      }
    }

    async function testAIFromPanel(panel) {
      const finish = beginActivity("Testing host AI CLI", "checking command and preparing Welcome prompt", {
        heartbeat: "checking host AI CLI"
      });
      const payload = currentAIForm(panel);
      appendTerminal("\\n$ host AI > check CLI and prepare Welcome prompt\\n");
      try {
        logStep("checking host command " + (payload.command || payload.provider || "preset"));
        logStep("building local Welcome prompt with Docker mount context");
        const result = await api("/api/ai/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (result.stdout) appendTerminal(result.stdout);
        if (result.stderr) appendTerminal(result.stderr);
        if (result.ai_test && result.ai_test.error) {
          state.aiTested = false;
          appendTerminal("\\n# AI test failed: " + result.ai_test.error + "\\n");
        } else {
          state.aiTested = result.code === 0;
          appendTerminal("\\n# AI test " + (state.aiTested ? "OK" : "failed") + " on host. Docker mount context is written into the prompt.\\n");
        }
        appendTerminal("# exit " + result.code + " in " + result.duration_ms + "ms\\n");
        finish(result.code === 0 ? "done" : "failed", "exit " + result.code);
      } catch (error) {
        finish("failed", error.message);
        throw error;
      }
    }

    function runAutoCommand(commandLine) {
      if (!state.welcomePassed && state.selectedTask && !state.selectedTask.local_test) {
        appendTerminal("# Welcome gate: pass the local host-AI + Docker workspace test before running funded project tasks.\\n");
        return;
      }
      runCommand(commandLine);
    }

    async function prepareSelectedTask() {
      if (!state.selectedTask) {
        appendTerminal("# Select a task first.\\n");
        return;
      }
      const finish = beginActivity("Preparing task workspace", state.selectedTask.id, {
        heartbeat: "preparing prompt/task files"
      });
      const id = encodeURIComponent(state.selectedTask.id);
      try {
        logStep("writing task.json and prompt.md for " + state.selectedTask.id);
        const result = await api("/api/tasks/" + id + "/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: state.selectedTask })
        });
        appendTerminal("# Prepared " + state.selectedTask.id + "\\n");
        appendTerminal("prompt_file\\t" + result.artifacts.relativePromptPath + "\\n");
        state.selectedWorkspace = state.selectedTask.id;
        logStep("refreshing local workspace list");
        await loadWorkspaces();
        logStep("opening generated prompt file");
        await openFile(result.artifacts.relativePromptPath);
        await loadFiles(pathDirname(result.artifacts.relativePromptPath));
        finish("done", result.artifacts.relativePromptPath);
      } catch (error) {
        finish("failed", error.message);
        throw error;
      }
    }

    async function checkSelectedTaskPass() {
      if (!state.selectedTask) {
        appendTerminal("# Select a task first.\\n");
        return;
      }
      const finish = beginActivity("Checking task pass", state.selectedTask.id);
      const id = encodeURIComponent(state.selectedTask.id);
      try {
        logStep("reading validator output for " + state.selectedTask.id);
        const result = await api("/api/tasks/" + id + "/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        state.welcomePassed = Boolean(result.passed);
        appendTerminal("\\n# Welcome AI check: " + (result.passed ? "PASS" : "FAIL") + "\\n");
        for (const check of result.checks || []) {
          appendTerminal((check.passed ? "ok\\t" : "fail\\t") + check.name + "\\t" + check.message + "\\n");
        }
        if (result.relative_path) {
          appendTerminal("result\\t" + result.relative_path + "\\n");
          if (result.passed) {
            await openFile(result.relative_path).catch(() => {});
          }
        }
        renderWorkGroups();
        renderTasks();
        renderTaskDetail();
        finish(result.passed ? "done" : "failed", result.passed ? "validator PASS" : "validator FAIL");
      } catch (error) {
        finish("failed", error.message);
        throw error;
      }
    }

    function updateAIUI() {
      const ai = state.ai || {};
      $("provider").textContent = "Host AI: " + (ai.provider || "custom") + " / " + (ai.command || "not configured");
    }

    function updateDockerUI() {
      const docker = state.docker;
      const status = $("docker-status");
      const image = $("sandbox-image");
      if (!docker) {
        status.textContent = "Docker checking";
        status.className = "pill yellow";
        image.textContent = "sandbox";
        return;
      }
      image.textContent = docker.image || "sandbox";
      if (!docker.available) {
        status.textContent = "Docker unavailable";
        status.className = "pill red";
        return;
      }
      const engine = docker.engine || {};
      status.textContent = "Docker " + (engine.version || "ready") + " / " + (engine.running || 0) + " running";
      status.className = "pill green";
    }

    async function loadBootstrap() {
      const boot = await api("/api/bootstrap");
      $("workspace").textContent = boot.workspace.root;
      state.ai = boot.ai;
      state.docker = boot.docker;
      state.welcomePassed = Boolean(boot.welcome && boot.welcome.passed);
      state.aiTested = state.welcomePassed || state.aiTested;
      updateAIUI();
      updateDockerUI();
    }

    async function loadStatus() {
      const status = await api("/api/status");
      $("task-count").textContent = status.tasks.open + " open / " + status.tasks.count + " tasks";
      state.ai = status.ai || state.ai;
      state.docker = status.docker || state.docker;
      state.welcomePassed = Boolean(status.welcome && status.welcome.passed);
      state.aiTested = state.welcomePassed || state.aiTested;
      updateAIUI();
      updateDockerUI();
      if (status.tasks.source === "unavailable") {
        appendTerminal("# Task source unavailable.\\n");
      }
    }

    async function loadTasks() {
      const loaded = await api("/api/tasks");
      state.tasks = loaded.tasks || [];
      state.groups = loaded.work_groups || [];
      if (!state.welcomePassed) {
        const localGroup = state.groups.find((group) => group.status_group === "local");
        state.selectedGroup = localGroup ? localGroup.id : "all";
      }
      if (!state.groups.some((group) => group.id === state.selectedGroup)) {
        state.selectedGroup = state.groups.length ? state.groups[0].id : "all";
      }
      const tasks = filteredTasks();
      if (!state.selectedTask && tasks.length) {
        state.selectedTask = tasks[0];
      } else if (state.selectedTask && !tasks.some((task) => task.id === state.selectedTask.id)) {
        state.selectedTask = tasks[0] || null;
      }
      renderWorkGroups();
      renderTasks();
      renderTaskDetail();
    }

    async function loadWorkspaces() {
      const loaded = await api("/api/workspaces");
      state.localWorkspaces = loaded.workspaces || [];
      if (!state.localWorkspaces.some((workspace) => workspace.id === state.selectedWorkspace)) {
        state.selectedWorkspace = state.localWorkspaces.length ? state.localWorkspaces[0].id : "";
      }
      renderLocalWorkspaces();
      const selected = state.localWorkspaces.find((workspace) => workspace.id === state.selectedWorkspace);
      if (selected) {
        await loadFiles(selected.artifact_path);
      } else {
        $("files-pane").innerHTML = '<div class="empty">Prepare or run a task to create a local workspace.</div>';
      }
    }

    function renderLocalWorkspaces() {
      const pane = $("local-workspaces");
      if (!state.localWorkspaces.length) {
        pane.innerHTML = '<div class="empty">No local task workspaces yet.</div>';
        return;
      }
      pane.innerHTML = "";
      for (const workspace of state.localWorkspaces) {
        const row = document.createElement("div");
        row.className = "workspace-row" + (state.selectedWorkspace === workspace.id ? " active" : "");
        row.tabIndex = 0;
        row.innerHTML =
          '<div class="workspace-main">' +
            '<div class="title"></div>' +
            '<div class="meta"></div>' +
          '</div>' +
          '<button class="mini-button primary" data-resume="1" title="Resume this task">Resume</button>';
        row.querySelector(".title").textContent = workspace.project_title || workspace.title || workspace.id;
        row.querySelector(".meta").innerHTML =
          '<span class="pill ' + (workspace.local_test ? "blue" : "green") + '">' + escapeHtml(workspace.local_test ? "test" : workspace.status || "local") + '</span>' +
          '<span>' + escapeHtml(workspace.id) + '</span>' +
          (workspace.project_checkout ? '<span class="pill blue">checkout</span>' : '');
        const openWorkspace = async () => {
          state.selectedWorkspace = workspace.id;
          renderLocalWorkspaces();
          await loadFiles(workspace.artifact_path);
          if (workspace.prompt_path) {
            await openFile(workspace.prompt_path).catch(() => {});
          }
        };
        row.addEventListener("click", openWorkspace);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openWorkspace().catch((error) => appendTerminal("# error: " + error.message + "\\n"));
          }
        });
        row.querySelector('[data-resume="1"]').addEventListener("click", (event) => {
          event.stopPropagation();
          resumeWorkspaceTask(workspace);
        });
        pane.appendChild(row);
      }
    }

    function resumeWorkspaceTask(workspace) {
      if (!workspace || !workspace.id) {
        appendTerminal("# No local workspace selected.\\n");
        return;
      }
      const existing = state.tasks.find((task) => task.id === workspace.id);
      state.selectedTask = existing || {
        id: workspace.id,
        title: workspace.title || workspace.id,
        status: workspace.status || "open",
        project_id: workspace.project_id || "",
        project_title: workspace.project_title || "",
        repo: workspace.repo || "",
        required_worker_kind: workspace.required_worker_kind || "agent"
      };
      state.selectedWorkspace = workspace.id;
      state.activeTab = "tasks";
      renderWorkGroups();
      renderTasks();
      renderTaskDetail();
      setTab("tasks").catch((error) => appendTerminal("# error: " + error.message + "\\n"));
      appendTerminal("\\n# Resuming local workspace " + workspace.id + "\\n");
      runAutoCommand("run " + quoteArg(workspace.id) + " --yes");
    }

    async function loadFiles(dir) {
      state.currentDir = dir || ".";
      const listed = await api("/api/files?path=" + encodeURIComponent(state.currentDir));
      const pane = $("files-pane");
      pane.innerHTML = "";
      if (listed.parent !== "") {
        const up = fileButton({ name: "..", path: listed.parent, type: "directory" });
        pane.appendChild(up);
      }
      for (const entry of listed.entries) {
        pane.appendChild(fileButton(entry));
      }
    }

    function fileButton(entry) {
      const row = document.createElement("button");
      row.className = "file-row" + (state.currentFile === entry.path ? " active" : "");
      row.innerHTML = '<div class="title"></div><div class="meta"></div>';
      row.querySelector(".title").textContent = (entry.type === "directory" ? "/ " : "") + entry.name;
      row.querySelector(".meta").textContent = entry.type === "directory" ? "directory" : String(entry.size || 0) + " bytes";
      row.addEventListener("click", async () => {
        if (entry.type === "directory") {
          await loadFiles(entry.path);
        } else {
          await openFile(entry.path);
        }
      });
      return row;
    }

    async function openFile(filePath) {
      const loaded = await api("/api/file?path=" + encodeURIComponent(filePath));
      state.currentFile = loaded.path;
      $("filename").textContent = loaded.path;
      $("editor").value = loaded.content;
      await loadFiles(state.currentDir);
    }

    async function saveFile() {
      if (!state.currentFile) {
        appendTerminal("# No file open.\\n");
        return;
      }
      const finish = beginActivity("Saving file", state.currentFile);
      try {
        logStep("writing " + state.currentFile);
        const result = await api("/api/file", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: state.currentFile, content: $("editor").value })
        });
        appendTerminal("# Saved " + result.path + " (" + result.size + " bytes)\\n");
        finish("done", result.size + " bytes");
      } catch (error) {
        finish("failed", error.message);
        throw error;
      }
    }

    async function runCommand(commandLine) {
      const line = commandLine || "";
      if (!line) {
        appendTerminal("# No command selected. Use task actions or AI panel actions.\\n");
        return;
      }
      const mode = /^\\s*(run|next)(\\s|$)/.test(line) && !/--dry-run/.test(line) ? "host AI" : "docker sandbox";
      const activity = commandActivity(line, mode);
      const abortController = new AbortController();
      const finish = beginActivity(activity.label, activity.detail, {
        heartbeat: activity.heartbeat,
        heartbeatMs: activity.heartbeatMs,
        stop: () => abortController.abort()
      });
      appendTerminal("\\n$ " + mode + " > mrgminner " + line + "\\n");
      try {
        logStep(activity.start);
        const result = await streamCommand(line, abortController.signal);
        logStep("received command result from " + mode);
        if (result.runner) {
          appendTerminal("\\n# runner " + result.runner.type + " cwd=" + result.runner.cwd + "\\n");
        }
        if (result.sandbox) {
          appendTerminal("\\n# sandbox " + result.sandbox.type + " image=" + result.sandbox.image + " mount=" + (result.sandbox.mount || result.sandbox.workspace) + "\\n");
        }
        if (result.validation) {
          appendTerminal("# validation " + (result.validation.passed ? "PASS" : "FAIL") + "\\n");
        }
        if (result.publish_pr) {
          renderPublishResult(result.publish_pr);
        }
        appendTerminal("\\n# exit " + result.code + " in " + result.duration_ms + "ms\\n");
        finish(result.code === 0 ? "done" : "failed", "exit " + result.code);
      } catch (error) {
        if (abortController.signal.aborted) {
          finish("stopped", "cancelled by user");
          appendTerminal("# stopped by user\\n");
          return;
        }
        finish("failed", error.message);
        appendTerminal("# error: " + error.message + "\\n");
      }
    }

    function renderPublishResult(publish) {
      if (publish.url) {
        appendTerminal("\\n# pull request ready: " + publish.url + "\\n");
        appendTerminal("# branch " + publish.branch + " commit " + (publish.commit || "") + "\\n");
        if (publish.comment_error) {
          appendTerminal("# PR comment failed: " + publish.comment_error + "\\n");
        }
        return;
      }
      if (publish.skipped) {
        appendTerminal("\\n# PR skipped: " + publish.reason + "\\n");
        return;
      }
      if (publish.error) {
        appendTerminal("\\n# PR publish failed: " + publish.error + "\\n");
        if (publish.stderr) appendTerminal(publish.stderr + "\\n");
        if (publish.stdout) appendTerminal(publish.stdout + "\\n");
      }
    }

    function commandActivity(line, mode) {
      const taskMatch = String(line || "").match(/^\\s*(run|prompt|intent|claim)\\s+([^\\s]+)/);
      const taskID = taskMatch ? taskMatch[2].replace(/^"|"$/g, "") : "";
      if (mode === "host AI") {
        return {
          label: "Running host AI",
          detail: taskID || line,
          start: "sending prompt to host AI; Docker workspace is mounted at /workspace",
          heartbeat: "waiting for host AI to finish " + (taskID || line),
          heartbeatMs: 15000
        };
      }
      if (/^\\s*next\\s+--dry-run/.test(line)) {
        return {
          label: "Dry running task selection",
          detail: line,
          start: "asking Docker sandbox for next dry-run task",
          heartbeat: "waiting for Docker dry-run"
        };
      }
      return {
        label: "Running sandbox command",
        detail: line,
        start: "sending command to Docker sandbox",
        heartbeat: "waiting for Docker sandbox command"
      };
    }

    async function setTab(name) {
      state.activeTab = name;
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
      document.body.classList.toggle("workspace-mode", name === "files");
      $("navigator-heading").textContent = name === "files" ? "Workspace files" : "Work pools";
      $("work-groups").hidden = name !== "tasks";
      $("tasks-pane").hidden = name !== "tasks";
      $("workspace-pane").hidden = name !== "files";
      if (name === "files") {
        await loadWorkspaces();
      }
    }

    function setInspectorTab(name) {
      state.inspectorTab = name || "task";
      renderTaskDetail();
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function formatBytes(bytes) {
      const number = Number(bytes || 0);
      if (!Number.isFinite(number) || number <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
      const value = number / Math.pow(1024, index);
      return value.toFixed(index === 0 ? 0 : 1) + " " + units[index];
    }

    function quoteArg(value) {
      const text = String(value || "");
      return /\\s/.test(text) ? '"' + text.replace(/"/g, "\\\\\\"") + '"' : text;
    }

    function pathDirname(value) {
      const parts = String(value || ".").split(/[\\\\/]/);
      parts.pop();
      return parts.length ? parts.join("/") : ".";
    }

    $("refresh").addEventListener("click", async () => {
      const finish = beginActivity("Refreshing IDE state", "Docker, tasks, and local workspaces", {
        heartbeat: "refreshing task and workspace state"
      });
      try {
        logStep("loading status");
        await loadStatus();
        logStep("loading task list");
        await loadTasks();
        logStep("loading local workspaces");
        await loadWorkspaces();
        finish("done");
      } catch (error) {
        finish("failed", error.message);
        appendTerminal("# error: " + error.message + "\\n");
      }
    });
    $("stop-run").addEventListener("click", stopActiveActivity);
    $("prepare-task").addEventListener("click", () => prepareSelectedTask().catch((error) => appendTerminal("# error: " + error.message + "\\n")));
    $("save-file").addEventListener("click", () => saveFile().catch((error) => appendTerminal("# error: " + error.message + "\\n")));
    $("reload-file").addEventListener("click", () => state.currentFile && openFile(state.currentFile).catch((error) => appendTerminal("# error: " + error.message + "\\n")));
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => setTab(button.dataset.tab).catch((error) => appendTerminal("# error: " + error.message + "\\n")));
    });
    document.querySelectorAll(".inspector-tab").forEach((button) => {
      button.addEventListener("click", () => setInspectorTab(button.dataset.inspector));
    });
    initTerminalResize();
    setTab(state.activeTab).catch((error) => appendTerminal("# error: " + error.message + "\\n"));

    (async function boot() {
      const finish = beginActivity("Loading IDE", "checking Docker, marketplace, tasks, and workspaces", {
        heartbeat: "loading IDE startup state",
        heartbeatMs: 10000
      });
      try {
        logStep("loading bootstrap settings and Docker status");
        await loadBootstrap();
        logStep("loading MergeOS status");
        await loadStatus();
        logStep("loading funded and in-progress tasks");
        await loadTasks();
        logStep("loading local workspaces");
        await loadWorkspaces();
        logStep("selecting Tasks view");
        await setTab("tasks");
        if (state.docker && state.docker.available) {
          appendTerminal("# Docker sandbox ready: " + state.docker.image + "\\n");
        } else if (state.docker) {
          appendTerminal("# Docker sandbox unavailable: " + (state.docker.error || "Docker is required") + "\\n");
        }
        appendTerminal("# MRGMinner IDE ready.\\n");
        finish("done");
      } catch (error) {
        finish("failed", error.message);
        appendTerminal("# boot error: " + error.message + "\\n");
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  ALLOWED_COMMANDS,
  DEFAULT_IDE_HOST,
  DEFAULT_IDE_PORT,
  buildWorkGroups,
  clientHtml,
  normalizeCommandArgs,
  parseCommandLine,
  relativeWorkspacePath,
  resolveWorkspacePath,
  sanitizeTerminalText,
  startIDE
};
