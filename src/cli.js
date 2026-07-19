"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { spawn: spawnChild } = require("node:child_process");
const {
  claimTask,
  findTask,
  getLedgerProof,
  getLiveFeed,
  getMarketplace,
  getPublicConfig,
  getPublicLedger,
  getSolanaProofManifest,
  getTokenEconomy,
  listProtocolAgents,
  listTasks,
  login,
  recordAgentAction,
  submitTaskEvidence
} = require("./api");
const { loadSettings, mergeSettings, parseArgList, readSettingsFile, redactToken, saveSettings, settingsPath } = require("./settings");
const { prepareTaskArtifacts, resolveAIInvocation, runAIForTask } = require("./runner");
const { isWelcomeAITaskID, welcomeAITask } = require("./welcome-task");
const { buildFleetReport, mockFleetPayload } = require("./nodes");
const {
  buildChainDiscovery,
  buildClaimIntent,
  discoverMarketplace,
  mockChainDiscovery,
  mockEconomy,
  mockMarket,
  mockProof,
  mockSolanaManifest,
  resolveRewardMrg,
  splitWork,
  summarizeLedgerProof,
  summarizeSolana,
  summarizeTokenEconomy,
  verifyHashChain
} = require("./chain");
const { startShare, earningsReport, DEFAULT_MRG_PER_GB } = require("./share");
const { startIDE } = require("./ide");

async function main(argv) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "configure":
      return configure(flags);
    case "login":
      return loginCommand(flags);
    case "tasks":
      return tasksCommand(flags);
    case "prompt":
      return promptCommand(flags);
    case "run":
      return runCommand(flags);
    case "claim":
      return claimCommand(flags);
    case "submit":
      return submitCommand(flags);
    case "pack":
      return packCommand(flags);
    case "compare":
      return compareCommand(flags);
    case "next":
      return nextCommand(flags);
    case "nodes":
      return nodesCommand(flags);
    case "stats":
      return statsCommand(flags);
    case "block":
    case "claim-block":
      return blockCommand(flags);
    case "token":
    case "economy":
      return tokenCommand(flags);
    case "ledger":
    case "proof":
      return proofCommand(flags);
    case "market":
    case "discover":
      return marketCommand(flags);
    case "split":
      return splitCommand(flags);
    case "chain":
    case "explore":
      return chainCommand(flags);
    case "intent":
      return intentCommand(flags);
    case "verify":
      return verifyCommand(flags);
    case "demo":
    case "live":
      return demoCommand(flags);
    case "solana":
    case "contract":
      return solanaCommand(flags);
    case "status":
      return statusCommand(flags);
    case "ide":
    case "serve":
      return ideCommand(flags);
    case "share":
    case "bandwidth":
      return shareCommand(flags);
    case "version":
    case "--version":
    case "-V":
      return versionCommand(flags);
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function versionCommand(flags = {}) {
  const pkg = readPackageInfo();
  const payload = {
    name: pkg.name || "mrgminner",
    displayName: pkg.displayName || "MRGMinner",
    version: pkg.version || "0.0.0",
    node: process.version,
    platform: process.platform,
    arch: process.arch
  };
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  console.log(`${payload.displayName} ${payload.version}`);
  console.log(`node\t${payload.node}`);
  console.log(`platform\t${payload.platform}/${payload.arch}`);
  return payload;
}

function readPackageInfo() {
  try {
    const packagePath = path.join(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    return { name: "mrgminner", displayName: "MRGMinner", version: "0.0.0" };
  }
}

async function ideCommand(flags) {
  const handle = await startIDE({
    settings: flags.settings,
    host: flags.host,
    port: flags.port,
    workspaceRoot: flags.workspace
  });
  const runningFile = writeIDERunningFile(handle);
  const payload = {
    url: handle.url,
    host: handle.host,
    port: handle.port,
    workspace_root: handle.workspaceRoot,
    running_file: runningFile
  };
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("# MRGMinner IDE started");
    console.log(`url\t${handle.url}`);
    console.log(`workspace\t${handle.workspaceRoot}`);
    console.log(`state\t${runningFile}`);
    console.log("# Press Ctrl+C to stop.");
  }
  if (flags.once) {
    await closeIDEServer(handle, runningFile);
    return;
  }
  if (!flags.json && !flags.noOpen && flags.open !== "false") {
    openIDEURL(handle.url);
  }
  const stop = async () => {
    console.log("\n# stopping MRGMinner IDE...");
    await closeIDEServer(handle, runningFile);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

function writeIDERunningFile(handle) {
  const directory = path.join(handle.workspaceRoot, ".mergeide");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, "ide-running.json");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      url: handle.url,
      host: handle.host,
      port: handle.port,
      workspace_root: handle.workspaceRoot,
      started_at: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
  return filePath;
}

function openIDEURL(url) {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawnChild(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false
  });
  child.unref();
}

async function closeIDEServer(handle, runningFile) {
  await new Promise((resolve) => handle.server.close(() => resolve()));
  if (runningFile && fs.existsSync(runningFile)) {
    fs.unlinkSync(runningFile);
  }
}

/**
 * Bandwidth-share stream (residential exit for TrucVPN).
 * Subcommands via first positional or --start / flags:
 *   mrgminner share start|stop|status|earnings
 *   mrgminner share --start --region vn
 */
async function shareCommand(flags) {
  const sub = String((flags._ && flags._[0]) || flags.action || "").toLowerCase();
  if (sub === "earnings" || flags.earnings) {
    const report = earningsReport();
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log("# MRGMinner bandwidth-share earnings");
    console.log(`bytes_total\t${report.bytes_total}`);
    console.log(`sessions\t${report.sessions}`);
    console.log(`mrg_per_gb\t${report.mrg_per_gb}`);
    console.log(`mrg_earned_total\t${report.mrg_earned_total}`);
    console.log(`# Pair with TrucVPN: trucvpn connect --region <code>`);
    return;
  }
  if (sub === "status") {
    const report = earningsReport();
    console.log(JSON.stringify({ stream: "bandwidth-share", ...report }, null, 2));
    return;
  }
  if (sub === "stop") {
    console.log("Share nodes run in the foreground — stop with Ctrl+C in the share start process.");
    return;
  }
  if (sub === "start" || flags.start || !sub) {
    const settings = await loadSettings(flags.settings, settingsFromFlags(flags)).catch(() => ({
      mergeos: {},
      worker: {}
    }));
    const workerId =
      flags.workerId ||
      flags["worker-id"] ||
      (settings.worker && settings.worker.id) ||
      "mrgminner:share-local";
    const handle = await startShare({
      host: flags.host || "127.0.0.1",
      port: Number(flags.port || 17890),
      socksPort: flags.socksPort ? Number(flags.socksPort) : undefined,
      region: flags.region || "vn",
      city: flags.city || "Ho Chi Minh",
      regions: flags.regions,
      workerId,
      mrgPerGb: flags.mrgPerGb ? Number(flags.mrgPerGb) : DEFAULT_MRG_PER_GB,
      advertiseHost: flags.advertiseHost || flags.host || "127.0.0.1"
    });
    const stats = handle.getStats();
    console.log("# MRGMinner share started (bandwidth → MRG)");
    console.log(`exit_id\t${stats.exit_id}`);
    console.log(`control\t${stats.control}`);
    console.log(`socks\t${stats.socks}`);
    console.log(`region\t${stats.region}\t${stats.city}`);
    if (stats.advertised_regions && stats.advertised_regions.length > 1) {
      const listed = stats.advertised_regions
        .map((exit) => `${exit.region}:${exit.city}:${exit.weight}`)
        .join(",");
      console.log(`regions\t${listed}`);
    }
    console.log(`mrg_per_gb\t${stats.mrg_per_gb}`);
    console.log(`# TrucVPN: trucvpn configure --share-url ${stats.control}`);
    console.log(`#          trucvpn connect --region ${stats.region}`);
    console.log("# Press Ctrl+C to stop and flush session earnings.");

    const onSig = async () => {
      console.log("\n# stopping share…");
      await handle.stop();
      const end = handle.getStats();
      console.log(`session_bytes\t${end.bytes_total}`);
      console.log(`session_mrg\t${end.mrg_earned_session}`);
      process.exit(0);
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    // heartbeat log every 30s
    setInterval(() => {
      const s = handle.getStats();
      if (flags.quiet) {
        return;
      }
      console.log(
        `# share heartbeat bytes=${s.bytes_total} mrg_session=${s.mrg_earned_session} uptime=${s.uptime_sec}s`
      );
    }, 30000).unref?.();

    await new Promise(() => {});
    return;
  }
  throw new Error(`unknown share subcommand: ${sub || "(empty)"} — use start|status|earnings`);
}

async function configure(flags) {
  const filePath = flags.settings || settingsPath();
  const current = await readSettingsFile(filePath);
  const updates = settingsFromFlags(flags);
  const next = mergeSettings(current, updates);
  await saveSettings(next, filePath);
  console.log(`MRGMinner settings saved to ${filePath}`);
}

async function loginCommand(flags) {
  const email = requiredFlag(flags, "email");
  const password = requiredFlag(flags, "password");
  const filePath = flags.settings || settingsPath();
  const current = await readSettingsFile(filePath);
  const settings = mergeSettings(current, settingsFromFlags(flags));
  const auth = await login(settings, email, password);
  const next = mergeSettings(settings, { mergeos: { token: auth.token } });
  await saveSettings(next, filePath);
  console.log(`Logged in as ${auth.user && auth.user.email ? auth.user.email : email}`);
}

async function tasksCommand(flags) {
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  let tasks = await listTasks(settings);
  if (flags.open) {
    tasks = tasks.filter((task) => task.status === "open");
  }
  if (flags.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  printTasks(tasks);
}

async function promptCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await resolveRunnableTask(settings, taskID);
  const artifacts = await prepareTaskArtifacts(settings, task, {
    workspaceRoot: flags.workspace
  });
  console.log(artifacts.promptFile);
}

async function runCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await resolveRunnableTask(settings, taskID);
  const result = await runAIForTask(settings, task, {
    workspaceRoot: flags.workspace
  });
  if (result.code !== 0) {
    throw new Error(`AI CLI exited with code ${result.code}`);
  }
  if (flags.claim || settings.claim.afterRun) {
    const claimed = await claimTask(settings, task, claimOverrides(flags));
    printClaimed(claimed);
  }
  if (shouldSubmitAfterRun(flags)) {
    await submitAndRecord(settings, task, flags);
  }
}

async function resolveRunnableTask(settings, taskID) {
  if (isWelcomeAITaskID(taskID)) {
    return welcomeAITask();
  }
  return findTask(settings, taskID);
}

async function claimCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await findTask(settings, taskID);
  const claimed = await claimTask(settings, task, claimOverrides(flags));
  printClaimed(claimed);
  if (flags.withIntent || flags.bindChain || flags.chain) {
    const intent = await formLiveIntent(settings, task, flags);
    console.log(`intent_id\t${intent.intent_id}`);
    console.log(`intent_hash\t${intent.intent_hash}`);
    console.log(`ledger_tip_hash\t${intent.ledger_tip_hash || "—"}`);
    console.log(`reward_mrg\t${intent.reward_mrg}`);
    if (intent.pack_hash) {
      console.log(`pack_hash\t${intent.pack_hash}`);
    }
    if (flags.json) {
      console.log(JSON.stringify({ claimed, claim_intent: intent }, null, 2));
    }
  }
}

async function submitCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await findTask(settings, taskID);
  await submitAndRecord(settings, task, flags);
}

async function nextCommand(flags) {
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  let tasks = [];
  let source = "auth";
  try {
    tasks = await listTasks(settings);
  } catch (error) {
    // Public dry-run path: pick from marketplace when not logged in.
    if (!flags.dryRun) {
      throw error;
    }
    source = "public-market";
    const market = await getMarketplace(settings, 40);
    const discovery = discoverMarketplace(market, { limit: 40 });
    tasks = (discovery.open_bounties || []).map((b) => ({
      id: b.id,
      title: b.title || b.id,
      status: "open",
      required_worker_kind: b.kind === "hybrid" ? "hybrid" : b.kind === "agent" ? "agent" : "human",
      suggested_agent_type: b.suggested_agent_type || "",
      reward_cents: Math.round(Number(b.reward_mrg || 0) * 100),
      project_id: b.project_id,
      source: "marketplace"
    }));
  }
  const task = selectNextTask(tasks, flags);
  if (!task) {
    console.log("No open MergeOS task matched the current filters.");
    return;
  }
  if (flags.dryRun) {
    if (source === "public-market") {
      console.log("# next --dry-run via public marketplace (not logged in)");
    }
    return dryRunNext(settings, task, flags);
  }
  console.log(`Selected ${task.id}: ${task.title}`);
  const result = await runAIForTask(settings, task, {
    workspaceRoot: flags.workspace
  });
  if (result.code !== 0) {
    throw new Error(`AI CLI exited with code ${result.code}`);
  }
  if (flags.claim || settings.claim.afterRun) {
    const claimed = await claimTask(settings, task, claimOverrides(flags));
    printClaimed(claimed);
  }
  if (shouldSubmitAfterRun(flags)) {
    await submitAndRecord(settings, task, flags);
  }
}

async function compareCommand(flags) {
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const tasks = await listTasks(settings);
  const task = selectNextTask(tasks, flags);
  if (!task) {
    console.log("No open MergeOS task matched the current filters.");
    return;
  }
  console.log(`Selected ${task.id}: ${task.title}`);
  const presetsList = (flags.presets || "codex,claude").split(",").map((s) => s.trim()).filter(Boolean);
  const artifacts = await prepareTaskArtifacts(settings, task, {
    workspaceRoot: flags.workspace
  });
  const results = [];
  for (const preset of presetsList) {
    const presetSettings = mergeSettings(settings, {
      ai: { provider: preset, command: "", args: [] }
    });
    let invocation;
    try {
      invocation = resolveAIInvocation(presetSettings, artifacts, task);
    } catch (error) {
      results.push({ provider: preset, error: error.message, command: "", args: [], commandLine: "" });
      continue;
    }
    results.push({
      provider: preset,
      error: null,
      command: invocation.command,
      args: invocation.args,
      commandLine: [invocation.command, ...invocation.args].join(" ")
    });
  }
  const notes = buildCompareNotes(task, results, artifacts);
  const notesFile = path.join(artifacts.artifactRoot, "compare-notes.md");
  fs.writeFileSync(notesFile, notes, "utf8");
  console.log(`Comparison notes written to ${notesFile}`);
  console.log("");
  console.log(notes);
}

function buildCompareNotes(task, results, artifacts) {
  const lines = [
    "# Multi-Provider Compare",
    "",
    `Task: ${task.id} — ${task.title}`,
    `Reward: ${(Number(task.reward_cents || 0) / 100).toFixed(2)} MRG`,
    `Prompt: ${artifacts.promptFile}`,
    "",
    "## Provider Comparison",
    "",
    "| # | Provider | Command |",
    "|---|---|---|"
  ];
  for (let index = 0; index < results.length; index += 1) {
    const r = results[index];
    const num = index + 1;
    if (r.error) {
      lines.push(`| ${num} | ${r.provider} | _error: ${r.error}_ |`);
    } else {
      lines.push(`| ${num} | ${r.provider} | \`${r.commandLine}\` |`);
    }
  }
  lines.push("", "### Details", "");
  for (const r of results) {
    if (r.error) {
      lines.push(`**${r.provider}**`, "", `- Error: ${r.error}`, "");
    } else {
      lines.push(
        `**${r.provider}**`,
        "",
        `- Command: \`${r.command}\``,
        `- Args: \`${JSON.stringify(r.args)}\``,
        ""
      );
    }
  }
  return lines.join("\n");
}

async function dryRunNext(settings, task, flags) {
  const artifacts = await prepareTaskArtifacts(settings, task, {
    workspaceRoot: flags.workspace
  });
  let invocation = null;
  try {
    invocation = resolveAIInvocation(settings, artifacts, task);
  } catch (error) {
    invocation = { command: "", args: [], error: error.message };
  }
  if (flags.json) {
    console.log(JSON.stringify({
      dry_run: true,
      selected: {
        id: task.id,
        title: task.title,
        status: task.status,
        required_worker_kind: task.required_worker_kind,
        suggested_agent_type: task.suggested_agent_type,
        reward_mrg: Number(task.reward_cents || 0) / 100
      },
      workspace_root: artifacts.workspaceRoot,
      prompt_file: artifacts.promptFile,
      task_file: artifacts.taskFile,
      ai_command: invocation.command,
      ai_args: invocation.args,
      ai_stdin: Boolean(invocation.stdin),
      ai_error: invocation.error || null,
      prompt: artifacts.prompt
    }, null, 2));
    return;
  }
  console.log(`# MRGMinner next --dry-run (no AI CLI invoked)`);
  console.log(`Selected ${task.id}: ${task.title}`);
  console.log(`status\t${task.status}`);
  console.log(`required_worker_kind\t${task.required_worker_kind || "—"}`);
  console.log(`suggested_agent_type\t${task.suggested_agent_type || "—"}`);
  console.log(`workspace_root\t${artifacts.workspaceRoot}`);
  console.log(`prompt_file\t${artifacts.promptFile}`);
  if (invocation.error) {
    console.log(`ai_cli\t(not configured: ${invocation.error})`);
  } else {
    console.log(`ai_cli\t${[invocation.command, ...invocation.args].join(" ")}`);
  }
  console.log("");
  console.log("# --- prompt ---");
  console.log(artifacts.prompt);
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) {
      flags._.push(item);
      continue;
    }
    const raw = item.slice(2);
    const [key, inlineValue] = raw.split(/=(.*)/s).filter(Boolean);
    if (inlineValue !== undefined) {
      flags[toCamel(key)] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[toCamel(key)] = true;
      continue;
    }
    flags[toCamel(key)] = next;
    index += 1;
  }
  return flags;
}

function settingsFromFlags(flags) {
  const updates = {};
  if (flags.mergeosUrl) {
    updates.mergeos = { ...(updates.mergeos || {}), baseUrl: flags.mergeosUrl };
  }
  if (flags.token) {
    updates.mergeos = { ...(updates.mergeos || {}), token: flags.token };
  }
  if (flags.provider) {
    updates.ai = { ...(updates.ai || {}), provider: flags.provider };
  }
  if (flags.command) {
    updates.ai = { ...(updates.ai || {}), command: flags.command };
  }
  if (flags.args) {
    updates.ai = { ...(updates.ai || {}), args: parseArgList(flags.args) };
  }
  if (flags.workspace) {
    updates.workspace = { ...(updates.workspace || {}), root: path.resolve(flags.workspace) };
  }
  if (flags.workerId) {
    updates.worker = { ...(updates.worker || {}), id: flags.workerId };
  }
  if (flags.agentType) {
    updates.worker = { ...(updates.worker || {}), agentType: flags.agentType };
  }
  if (flags.autoClaim !== undefined) {
    updates.claim = { afterRun: flags.autoClaim === true || flags.autoClaim === "true" };
  }
  return updates;
}

function claimOverrides(flags) {
  return {
    workerId: flags.workerId,
    workerKind: flags.workerKind,
    agentType: flags.agentType
  };
}

async function submitAndRecord(settings, task, flags) {
  const payload = submissionFromFlags(flags);
  const submitted = await submitTaskEvidence(settings, task, payload);
  console.log(`Submitted ${submitted.claim_id || submitted.id} for review`);
  if (flags.agentAction === false || flags.noAgentAction) {
    return submitted;
  }
  let chainIntent = null;
  if (flags.withIntent || flags.bindChain || flags.chain) {
    try {
      chainIntent = await formLiveIntent(settings, task, flags);
      console.log(`bound intent_hash\t${chainIntent.intent_hash}`);
    } catch (error) {
      console.log(`# chain intent bind skipped: ${error.message}`);
    }
  }
  const action = await recordAgentAction(
    settings,
    submitted.project_id || task.project_id || task.projectID,
    agentActionFromSubmission(settings, task, submitted, flags, chainIntent)
  );
  console.log(`Recorded agent ${action.action} evidence ${action.action_id || action.id}`);
  return submitted;
}

function submissionFromFlags(flags) {
  const payload = {
    pull_request_url: flags.pullRequestUrl || flags.prUrl,
    evidence_url: flags.evidenceUrl,
    review_notes: flags.reviewNotes || flags.notes
  };
  if (!payload.pull_request_url && !payload.evidence_url && !payload.review_notes) {
    throw new Error("--pr-url, --pull-request-url, --evidence-url, or --notes is required");
  }
  return payload;
}

async function packCommand(flags) {
  const { ZipArchive } = await import("archiver");
  const taskId = requiredPositional(flags, "task id");
  const taskDir = resolveTaskDir(taskId, flags);
  if (!taskDir) {
    throw new Error(
      `Task directory not found for ${taskId}. Run 'mrgminner run ${taskId}' or 'mrgminner prompt ${taskId}' first.`
    );
  }

  const zipPath = path.resolve(`${taskId}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(taskDir, false);
    if (flags.prUrl) {
      archive.append(`${flags.prUrl}\n`, { name: "pr-url.txt" });
    }
    archive.finalize();
  });

  const stats = fs.statSync(zipPath);
  console.log(`Packaged ${zipPath} (${stats.size} bytes)`);
}

function resolveTaskDir(taskId, flags) {
  const candidates = [];
  const workspaceRoot = flags.workspace
    ? path.resolve(flags.workspace)
    : process.cwd();
  candidates.push(path.join(workspaceRoot, ".mergeide", "tasks", taskId));
  candidates.push(path.join(os.homedir(), ".mergeide", "tasks", taskId));
  return candidates.find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) || null;
}

function agentActionFromSubmission(settings, task, submitted, flags, chainIntent = null) {
  const pullRequestURL = submitted.pull_request_url || flags.pullRequestUrl || flags.prUrl || "";
  const evidenceURL = submitted.review_evidence_url || flags.evidenceUrl || "";
  const referenceURL = flags.referenceUrl || pullRequestURL || evidenceURL;
  const notes =
    submitted.review_notes ||
    flags.reviewNotes ||
    flags.notes ||
    "MRGMinner submitted task evidence for review.";
  const body = {
    action: flags.action || "generate",
    claim_id: submitted.claim_id || task.claim_id || task.id,
    bounty_id: submitted.claim_id || task.claim_id || task.id,
    agent_type: flags.agentType || settings.worker.agentType || task.suggested_agent_type || "mergeide",
    status: flags.status || "processed",
    reference_url: referenceURL,
    pull_number: flags.pullNumber || pullNumberFromURL(pullRequestURL),
    labels: flags.labels,
    context_urls: defaultContextURLs(submitted),
    evidence: [notes, pullRequestURL, evidenceURL].filter(Boolean),
    runbook: [
      "Discover open MRG work (mrgminner market / chain).",
      "Form claim intent bound to ledger tip (mrgminner intent).",
      "Claim + implement; submit PR evidence for review.",
      "Wait for customer or admin accept before payout (optional Solana releasePayout)."
    ],
    delegated_by: flags.delegatedBy,
    design_agent: flags.designAgent,
    subagent_type: flags.subagentType,
    delegation_chain: flags.delegationChain
  };
  if (chainIntent && chainIntent.claim_metadata) {
    body.chain_binding = {
      ...chainIntent.claim_metadata,
      solana_program_id: chainIntent.solana && chainIntent.solana.program_id
    };
  }
  return body;
}

async function formLiveIntent(settings, task, flags) {
  let economy = {};
  let proof = {};
  let market = { bounties: [], projects: [] };
  let agents = [];
  let feed = {};
  let ledger = [];
  let solanaManifest = null;
  try {
    [economy, proof, market, agents, feed, ledger, solanaManifest] = await Promise.all([
      getTokenEconomy(settings).catch(() => ({})),
      getLedgerProof(settings).catch(() => ({})),
      getMarketplace(settings, 40).catch(() => ({ bounties: [], projects: [] })),
      listProtocolAgents(settings, 50).catch(() => []),
      getLiveFeed(settings, 40).catch(() => ({})),
      getPublicLedger(settings, 30).catch(() => []),
      getSolanaProofManifest(settings)
    ]);
  } catch {
    // partial is fine
  }
  const fleet = buildFleetReport({
    agents,
    feed,
    ledgerItems: ledger.length ? ledger : feed.items || []
  });
  const ledgerSummary = summarizeLedgerProof(proof);
  const marketplace = discoverMarketplace(market, { limit: 40 });
  const bounty =
    marketplace.open_bounties.find((b) => b.id === (task.claim_id || task.id)) || {
      id: task.claim_id || task.id,
      title: task.title,
      reward_mrg: resolveRewardMrg(task),
      project_id: task.project_id || ""
    };
  const split = splitWork({
    bounties: [bounty],
    fleet,
    proof: ledgerSummary,
    maxPacks: 1
  });
  const pack = split.packs[0] || null;
  const solana = summarizeSolana(solanaManifest || mockSolanaManifest());
  return buildClaimIntent({
    task: { ...task, ...bounty },
    fleet,
    proof: ledgerSummary,
    workerId: flags.workerId || settings.worker.id,
    prUrl: flags.prUrl || flags.pullRequestUrl || "",
    pack,
    solana
  });
}

function shouldSubmitAfterRun(flags) {
  return Boolean(flags.submit || flags.prUrl || flags.pullRequestUrl || flags.evidenceUrl || flags.notes || flags.reviewNotes);
}

function defaultContextURLs(submitted) {
  const projectID = submitted.project_id || submitted.projectID || "";
  const claimID = submitted.claim_id || submitted.claimID || "";
  return [
    claimID ? `/api/public/protocol/tasks?task_id=${encodeURIComponent(claimID)}` : "",
    projectID ? `/api/public/projects/${encodeURIComponent(projectID)}/workflow` : "",
    projectID ? `/api/public/projects/${encodeURIComponent(projectID)}/pull-requests` : ""
  ].filter(Boolean);
}

function pullNumberFromURL(value) {
  const match = String(value || "").match(/\/pull\/(\d+)(?:\b|[/?#])/);
  return match ? Number(match[1]) : 0;
}

function printClaimed(claimed) {
  const id = claimed.claim_id || claimed.id;
  const worker = claimed.worker_id ? ` by ${claimed.worker_id}` : "";
  console.log(`Claimed ${id}${worker}; payout is pending review`);
}

function selectNextTask(tasks, flags) {
  const openTasks = tasks.filter((task) => task && task.status === "open");
  const kind = flags.kind;
  const agent = flags.agent;
  return openTasks.find((task) => {
    if (kind && task.required_worker_kind !== kind) {
      return false;
    }
    if (agent && task.suggested_agent_type !== agent) {
      return false;
    }
    return true;
  });
}

function printTasks(tasks) {
  if (!tasks.length) {
    console.log("No MergeOS tasks found.");
    return;
  }
  for (const task of tasks) {
    const reward = (Number(task.reward_cents || 0) / 100).toFixed(2);
    console.log(`${task.id}\t${task.status}\t${task.required_worker_kind}\t${reward} MRG\t${task.title}`);
  }
}

function requiredFlag(flags, key) {
  if (!flags[key]) {
    throw new Error(`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return flags[key];
}

function requiredPositional(flags, label) {
  const value = flags._[0];
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

async function loadFleet(flags) {
  if (flags.mock || flags.offline) {
    return { report: mockFleetPayload(), source: "mock" };
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const [agents, feed, ledger] = await Promise.all([
      listProtocolAgents(settings, Number(flags.limit || 50)),
      getLiveFeed(settings, Number(flags.feedLimit || 40)),
      getPublicLedger(settings, Number(flags.ledgerLimit || 20))
    ]);
    const report = buildFleetReport({
      agents,
      feed,
      ledgerItems: ledger.length ? ledger : feed.items || [],
      options: {
        taskId: flags.taskId || flags._[0] || "",
        projectId: flags.projectId || ""
      }
    });
    return { report, source: "live", settings };
  } catch (error) {
    if (flags.strict) {
      throw error;
    }
    const report = mockFleetPayload();
    report.warning = `live fleet unavailable (${error.message}); showing mock fleet`;
    return { report, source: "mock-fallback" };
  }
}

async function nodesCommand(flags) {
  const { report, source } = await loadFleet(flags);
  if (flags.json) {
    console.log(JSON.stringify({ source, ...report }, null, 2));
    return;
  }
  if (report.warning) {
    console.log(`# ${report.warning}`);
  }
  console.log(`# MRGMinner nodes (${source}) · online ${report.stats.online_nodes}/${report.stats.total_nodes}`);
  console.log(
    `# roles online job=${report.stats.online_by_role.job} review=${report.stats.online_by_role.review} audit=${report.stats.online_by_role.audit} · claim_block_ready=${report.stats.claim_block_ready}`
  );
  console.log("id\tonline\trole\tstatus\topen\tqueue\ttype\ttitle");
  for (const node of report.nodes) {
    if (flags.online && !node.online) {
      continue;
    }
    if (flags.role && node.role !== flags.role) {
      continue;
    }
    console.log(
      [
        node.id,
        node.online ? "yes" : "no",
        node.role,
        node.status,
        node.open_task_count,
        node.queue_depth,
        node.type,
        node.title
      ].join("\t")
    );
  }
}

async function statsCommand(flags) {
  const { report, source } = await loadFleet(flags);
  if (flags.json) {
    console.log(JSON.stringify({ source, stats: report.stats, claim_block: report.claim_block }, null, 2));
    return;
  }
  if (report.warning) {
    console.log(`# ${report.warning}`);
  }
  const s = report.stats;
  console.log(`# MRGMinner node stats (${source})`);
  console.log(`total_nodes\t${s.total_nodes}`);
  console.log(`online_nodes\t${s.online_nodes}`);
  console.log(`offline_nodes\t${s.offline_nodes}`);
  console.log(`job_nodes\t${s.by_role.job}\tonline\t${s.online_by_role.job}`);
  console.log(`review_nodes\t${s.by_role.review}\tonline\t${s.online_by_role.review}`);
  console.log(`audit_nodes\t${s.by_role.audit}\tonline\t${s.online_by_role.audit}`);
  console.log(`open_tasks_on_nodes\t${s.open_tasks_on_nodes}`);
  console.log(`queue_depth_total\t${s.queue_depth_total}`);
  console.log(`verified_hash_count\t${s.verified_hash_count}`);
  console.log(`ledger_entry_count\t${s.feed.ledger_entry_count}`);
  console.log(`active_agents_feed\t${s.feed.active_agent_count}`);
  console.log(`open_tasks_feed\t${s.feed.open_task_count}`);
  console.log(`claim_block_ready\t${s.claim_block_ready}`);
  console.log(`token\t${s.feed.token_symbol || "MRG"}`);
}

async function blockCommand(flags) {
  const { report, source } = await loadFleet(flags);
  const block = report.claim_block;
  if (flags.json) {
    console.log(JSON.stringify({ source, claim_block: block, stats: report.stats }, null, 2));
    return;
  }
  if (report.warning) {
    console.log(`# ${report.warning}`);
  }
  console.log(`# MRG claim-block (${source}) · status=${block.status} · ready=${block.ready}`);
  if (block.block_id) {
    console.log(`block_id\t${block.block_id}`);
    console.log(`block_hash\t${block.block_hash}`);
  }
  console.log(`mrg_eligible\t${block.mrg_eligible}`);
  if (block.missing && block.missing.length) {
    console.log(`missing\t${block.missing.join(",")}`);
  }
  for (const role of ["job", "review", "audit"]) {
    const member = block.members[role];
    if (member) {
      console.log(
        `member.${role}\t${member.id}\t${member.status}\tonline=${member.online}\ttype=${member.type}`
      );
    } else {
      console.log(`member.${role}\t—`);
    }
  }
  if (block.ledger_tip) {
    console.log(
      `ledger_tip\tseq=${block.ledger_tip.sequence || "?"}\thash=${block.ledger_tip.entry_hash}\tstatus=${block.ledger_tip.status}`
    );
  }
  console.log(
    `hash_chain\tcomplete=${block.hash_chain.complete}\tverified_count=${block.hash_chain.verified_count}`
  );
  if (block.claim_guidance && block.claim_guidance.steps) {
    console.log("# guidance");
    for (const step of block.claim_guidance.steps) {
      console.log(`- ${step}`);
    }
  }
}

async function loadChainBundle(flags) {
  if (flags.mock || flags.offline) {
    return { discovery: mockChainDiscovery(), source: "mock" };
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const [economy, proof, market, agents, feed, ledger, solanaManifest] = await Promise.all([
      getTokenEconomy(settings),
      getLedgerProof(settings),
      getMarketplace(settings, Number(flags.limit || 40)),
      listProtocolAgents(settings, Number(flags.limit || 50)),
      getLiveFeed(settings, Number(flags.feedLimit || 40)),
      getPublicLedger(settings, Number(flags.ledgerLimit || 30)),
      getSolanaProofManifest(settings)
    ]);
    const fleet = buildFleetReport({
      agents,
      feed,
      ledgerItems: ledger.length ? ledger : feed.items || []
    });
    const discovery = buildChainDiscovery({
      economy,
      proof,
      market,
      fleet,
      solanaManifest,
      options: {
        limit: Number(flags.limit || 25),
        maxPacks: Number(flags.maxPacks || 10),
        projectId: flags.projectId || flags.project || ""
      }
    });
    let config = null;
    try {
      config = await getPublicConfig(settings);
    } catch {
      config = null;
    }
    return { discovery, source: "live", settings, config };
  } catch (error) {
    if (flags.strict) {
      throw error;
    }
    const discovery = mockChainDiscovery();
    discovery.warning = `live chain unavailable (${error.message}); showing mock discovery`;
    return { discovery, source: "mock-fallback" };
  }
}

function maybeWriteOut(flags, payload) {
  if (!flags.out) {
    return;
  }
  const outPath = path.resolve(String(flags.out));
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`# wrote ${outPath}`);
}

async function tokenCommand(flags) {
  if (flags.mock || flags.offline) {
    const token = summarizeTokenEconomy(mockEconomy());
    if (flags.json) {
      console.log(JSON.stringify(token, null, 2));
      return;
    }
    printToken(token, "mock");
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const economy = await getTokenEconomy(settings);
    const token = summarizeTokenEconomy(economy);
    if (flags.json) {
      console.log(JSON.stringify(token, null, 2));
      return;
    }
    printToken(token, "live");
  } catch (error) {
    if (flags.strict) throw error;
    const token = summarizeTokenEconomy(mockEconomy());
    console.log(`# live unavailable: ${error.message}`);
    printToken(token, "mock-fallback");
  }
}

function printToken(token, source) {
  console.log(`# MRG token economy (${source}) · ${token.token_symbol}`);
  console.log(`ledger_entries\t${token.stats.ledger_entry_count}`);
  console.log(`escrow_events\t${token.stats.escrow_event_count}`);
  console.log(`payouts\t${token.stats.payout_count}`);
  console.log(`minted_cents\t${token.totals.minted_cents}`);
  console.log(`task_reserve_cents\t${token.totals.task_reserve_cents}`);
  console.log(`released_cents\t${token.totals.released_cents}`);
  console.log(`remaining_reserve_cents\t${token.totals.remaining_reserve_cents}`);
  console.log(`explore.scan\t${token.explore.scan}`);
  console.log(`explore.proof\t${token.explore.ledger_proof}`);
  if (token.balances && token.balances.length) {
    console.log("# balances");
    for (const b of token.balances.slice(0, 8)) {
      console.log(`${b.id}\t${b.amount_cents}\t${b.label || b.role}`);
    }
  }
}

async function proofCommand(flags) {
  if (flags.mock || flags.offline) {
    const ledger = summarizeLedgerProof(mockProof());
    if (flags.json) {
      console.log(JSON.stringify(ledger, null, 2));
      return;
    }
    printProof(ledger, "mock");
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const proof = await getLedgerProof(settings);
    const ledger = summarizeLedgerProof(proof);
    if (flags.json) {
      console.log(JSON.stringify(ledger, null, 2));
      return;
    }
    printProof(ledger, "live");
  } catch (error) {
    if (flags.strict) throw error;
    const ledger = summarizeLedgerProof(mockProof());
    console.log(`# live unavailable: ${error.message}`);
    printProof(ledger, "mock-fallback");
  }
}

function printProof(ledger, source) {
  console.log(`# MRG ledger proof (${source}) · server_valid=${ledger.valid}`);
  console.log(`entries\t${ledger.entry_count}\tverified\t${ledger.verified_count}\tbroken\t${ledger.broken_count}`);
  console.log(`root_hash\t${ledger.root_hash}`);
  console.log(`public_root_hash\t${ledger.public_root_hash}`);
  console.log(`hash_chain_complete\t${ledger.integrity.hash_chain_complete}`);
  if (ledger.integrity.local_verify) {
    const lv = ledger.integrity.local_verify;
    console.log(
      `local_verify\tvalid=${lv.valid}\tlinks=${lv.links_checked}\tbroken=${lv.broken_count}`
    );
  }
  console.log(`explore\t${ledger.integrity.explorer}`);
  if (ledger.tip) {
    console.log(
      `tip\tseq=${ledger.tip.sequence}\thash=${ledger.tip.entry_hash}\ttype=${ledger.tip.type}\tmrg=${ledger.tip.amount_mrg}`
    );
    if (ledger.tip.scan_tx) {
      console.log(`tip.scan\t${ledger.tip.scan_tx}`);
    }
  }
  if (ledger.sample_entries && ledger.sample_entries.length) {
    console.log("# sample entries");
    for (const e of ledger.sample_entries.slice(0, 8)) {
      console.log(`${e.sequence}\t${e.type}\t${e.amount_mrg} MRG\t${(e.entry_hash || "").slice(0, 16)}…`);
    }
  }
}

async function marketCommand(flags) {
  const opts = {
    limit: Number(flags.limit || 25),
    projectId: flags.projectId || flags.project || ""
  };
  if (flags.mock || flags.offline) {
    const marketplace = discoverMarketplace(mockMarket(), opts);
    if (flags.json) {
      console.log(JSON.stringify(marketplace, null, 2));
      maybeWriteOut(flags, marketplace);
      return;
    }
    printMarket(marketplace, "mock");
    maybeWriteOut(flags, marketplace);
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const market = await getMarketplace(settings, Number(flags.limit || 40));
    const marketplace = discoverMarketplace(market, opts);
    if (flags.json) {
      console.log(JSON.stringify(marketplace, null, 2));
      maybeWriteOut(flags, marketplace);
      return;
    }
    printMarket(marketplace, "live");
    maybeWriteOut(flags, marketplace);
  } catch (error) {
    if (flags.strict) throw error;
    const marketplace = discoverMarketplace(mockMarket(), opts);
    console.log(`# live unavailable: ${error.message}`);
    printMarket(marketplace, "mock-fallback");
  }
}

function printMarket(marketplace, source) {
  console.log(`# Marketplace discovery (${source}) · ${marketplace.token_symbol}`);
  console.log(
    `projects\t${marketplace.stats.project_count}\topen_tasks\t${marketplace.stats.open_task_count}\twork_pool_cents\t${marketplace.stats.work_pool_cents}\tdiscoverable_mrg\t${marketplace.stats.discoverable_open_mrg || 0}`
  );
  console.log("# open bounties (claimable MRG)");
  console.log("id\treward\tsource\tkind\tstatus\ttitle");
  for (const b of marketplace.open_bounties) {
    console.log(
      `${b.id}\t${b.reward_mrg} MRG\t${b.reward_source || "?"}\t${b.worker_kind}\t${b.status}\t${b.title}`
    );
  }
  if (marketplace.funded_projects.length) {
    console.log("# funded projects");
    for (const p of marketplace.funded_projects.slice(0, 10)) {
      console.log(`${p.id}\t${p.status}\t${p.budget_cents}\t${p.repo || ""}\t${p.title}`);
    }
  }
  console.log(`explore\t${marketplace.explore.scan}`);
}

async function splitCommand(flags) {
  const { discovery, source } = await loadChainBundle(flags);
  const split = discovery.work_split;
  if (flags.json) {
    console.log(JSON.stringify({ source, work_split: split }, null, 2));
    maybeWriteOut(flags, { source, work_split: split });
    return;
  }
  if (discovery.warning) {
    console.log(`# ${discovery.warning}`);
  }
  console.log(`# Work split (${source}) · packs=${split.pack_count} · block=${split.claim_block.block_id || "—"}`);
  console.log(
    `claim_block_ready\t${split.claim_block.ready}\tmrg_eligible\t${split.claim_block.mrg_eligible}\ttotal_reward\t${split.total_reward_mrg || 0} MRG`
  );
  console.log(
    `pools\tjob=${split.node_pools ? split.node_pools.job : "?"} review=${split.node_pools ? split.node_pools.review : "?"} audit=${split.node_pools ? split.node_pools.audit : "?"} · tip=${(split.ledger_tip_hash || "").slice(0, 16)}…`
  );
  console.log("pack_id\tstatus\treward\ttask\tjob\treview\taudit\ttitle");
  for (const p of split.packs) {
    console.log(
      [
        p.pack_id,
        p.status,
        `${p.reward_mrg} MRG`,
        p.task_id,
        p.assignment.job || "—",
        p.assignment.review || "—",
        p.assignment.audit || "—",
        p.title
      ].join("\t")
    );
  }
  maybeWriteOut(flags, { source, work_split: split });
}

async function chainCommand(flags) {
  const { discovery, source } = await loadChainBundle(flags);
  if (flags.json) {
    console.log(JSON.stringify({ source, ...discovery }, null, 2));
    maybeWriteOut(flags, { source, ...discovery });
    return;
  }
  if (discovery.warning) {
    console.log(`# ${discovery.warning}`);
  }
  console.log(`# Chain discovery (${source}) · ${discovery.protocol_version || "mrgminner.chain"}`);
  console.log(
    `token\t${discovery.token.token_symbol}\tminted\t${discovery.token.totals.minted_cents}\treserve\t${discovery.token.totals.remaining_reserve_cents}`
  );
  const lv = discovery.ledger.integrity && discovery.ledger.integrity.local_verify;
  console.log(
    `ledger\tserver_valid=${discovery.ledger.valid}\tentries=${discovery.ledger.entry_count}\tverified=${discovery.ledger.verified_count}\tlocal_broken=${lv ? lv.broken_count : "?"}\troot=${(discovery.ledger.root_hash || "").slice(0, 16)}…`
  );
  console.log(
    `fleet\tonline=${discovery.fleet.online_nodes}/${discovery.fleet.total_nodes}\tblock_ready=${discovery.fleet.claim_block_ready}`
  );
  console.log(
    `market\tprojects=${discovery.marketplace.stats.project_count}\topen=${discovery.marketplace.stats.open_task_count}\tpacks=${discovery.work_split.pack_count}\tdiscoverable_mrg=${discovery.marketplace.stats.discoverable_open_mrg || discovery.work_split.total_reward_mrg || 0}`
  );
  if (discovery.solana) {
    console.log(
      `solana\tprogram=${discovery.solana.program}\tid=${discovery.solana.program_id}\tstatus=${discovery.solana.status}`
    );
  }
  console.log(`scan\t${discovery.explore.scan}`);
  console.log(`proof\t${discovery.explore.ledger_proof}`);
  console.log(`marketplace_api\t${discovery.explore.marketplace}`);
  maybeWriteOut(flags, { source, ...discovery });
}

async function intentCommand(flags) {
  const taskId = flags._[0] || flags.taskId || "";
  const { discovery, source, settings } = await loadChainBundle(flags);
  let task = discovery.marketplace.open_bounties[0] || { id: taskId, title: taskId, reward_mrg: 0 };
  if (taskId) {
    const hit = discovery.marketplace.open_bounties.find((b) => b.id === taskId);
    if (hit) {
      task = hit;
    } else if (!flags.mock && settings) {
      try {
        const found = await findTask(settings, taskId);
        task = { ...found, reward_mrg: resolveRewardMrg(found) };
      } catch {
        task = { id: taskId, title: taskId, reward_mrg: 0 };
      }
    } else {
      task = { id: taskId, title: taskId, reward_mrg: 0 };
    }
  }
  const workerId =
    flags.workerId ||
    (settings && settings.worker && settings.worker.id) ||
    "mrgminner:local";
  const pack =
    discovery.work_split.packs.find((p) => p.task_id === task.id) ||
    discovery.work_split.packs[0] ||
    null;
  // Reattach full fleet nodes for assignment-aware intents when available
  const fleet = {
    claim_block: discovery.fleet.claim_block,
    nodes: [],
    stats: discovery.fleet
  };
  const fullIntent = buildClaimIntent({
    task,
    fleet,
    proof: discovery.ledger,
    workerId,
    prUrl: flags.prUrl || "",
    pack,
    solana: discovery.solana
  });

  if (flags.json) {
    console.log(JSON.stringify({ source, claim_intent: fullIntent }, null, 2));
    maybeWriteOut(flags, { source, claim_intent: fullIntent });
    return;
  }
  console.log(`# Claim intent (${source}) · ready=${fullIntent.ready} · mrg_eligible=${fullIntent.mrg_eligible}`);
  console.log(`intent_id\t${fullIntent.intent_id}`);
  console.log(`intent_hash\t${fullIntent.intent_hash}`);
  console.log(`task_id\t${fullIntent.task_id}\treward\t${fullIntent.reward_mrg} MRG`);
  console.log(`worker_id\t${fullIntent.worker_id}`);
  console.log(`claim_block_id\t${fullIntent.claim_block_id || "—"}`);
  console.log(`pack_id\t${fullIntent.pack_id || "—"}`);
  console.log(`pack_hash\t${fullIntent.pack_hash || "—"}`);
  console.log(`ledger_tip_hash\t${fullIntent.ledger_tip_hash || "—"}`);
  console.log(`ledger_reference\t${fullIntent.ledger_reference || "—"}`);
  if (fullIntent.solana) {
    console.log(`solana.program_id\t${fullIntent.solana.program_id}`);
  }
  console.log(`hash_complete\t${fullIntent.hash_binding.complete}`);
  if (fullIntent.commands.claim) {
    console.log(`cmd.claim\t${fullIntent.commands.claim}`);
  }
  if (fullIntent.commands.explore) {
    console.log(`explore\t${fullIntent.commands.explore}`);
  }
  console.log(`# ${fullIntent.notice}`);
  maybeWriteOut(flags, { source, claim_intent: fullIntent });
}

async function verifyCommand(flags) {
  if (flags.mock || flags.offline) {
    const proof = mockProof();
    const result = verifyHashChain(proof.entries);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printVerify(result, "mock");
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const proof = await getLedgerProof(settings);
    const result = verifyHashChain(proof.entries || []);
    result.server_valid = proof.valid;
    result.server_broken_count = proof.broken_count;
    result.root_hash = proof.root_hash;
    result.public_root_hash = proof.public_root_hash;
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      maybeWriteOut(flags, result);
      return;
    }
    printVerify(result, "live");
    maybeWriteOut(flags, result);
  } catch (error) {
    if (flags.strict) throw error;
    const result = verifyHashChain(mockProof().entries);
    console.log(`# live unavailable: ${error.message}`);
    printVerify(result, "mock-fallback");
  }
}

function printVerify(result, source) {
  console.log(`# Ledger hash-chain verify (${source}) · local_valid=${result.valid}`);
  console.log(`entries\t${result.entry_count}\tlinks_checked\t${result.links_checked}\tbroken\t${result.broken_count}`);
  if (result.server_valid !== undefined) {
    console.log(`server_valid\t${result.server_valid}\tserver_broken\t${result.server_broken_count}`);
  }
  console.log(`tip_seq\t${result.tip_sequence}\ttip_hash\t${result.tip_hash || "—"}`);
  if (result.root_hash) {
    console.log(`root_hash\t${result.root_hash}`);
  }
  if (result.broken && result.broken.length) {
    console.log("# broken links (sample)");
    for (const b of result.broken.slice(0, 8)) {
      console.log(
        `seq=${b.sequence}\texpected=${(b.expected_previous || "").slice(0, 12)}…\tactual=${(b.actual_previous || "").slice(0, 12)}…\t${b.reason || b.type || ""}`
      );
    }
  }
}

async function solanaCommand(flags) {
  if (flags.mock || flags.offline) {
    const solana = summarizeSolana(mockSolanaManifest());
    if (flags.json) {
      console.log(JSON.stringify(solana, null, 2));
      return;
    }
    printSolana(solana, "mock");
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const manifest = await getSolanaProofManifest(settings);
    const solana = summarizeSolana(manifest || mockSolanaManifest());
    if (!manifest) {
      solana.status = "scaffold-fallback";
    }
    if (flags.json) {
      console.log(JSON.stringify(solana, null, 2));
      maybeWriteOut(flags, solana);
      return;
    }
    printSolana(solana, manifest ? "live" : "scaffold-fallback");
    maybeWriteOut(flags, solana);
  } catch (error) {
    if (flags.strict) throw error;
    const solana = summarizeSolana(mockSolanaManifest());
    console.log(`# live unavailable: ${error.message}`);
    printSolana(solana, "mock-fallback");
  }
}

function printSolana(solana, source) {
  console.log(`# Solana MRG binding (${source}) · ${solana.program}`);
  console.log(`program_id\t${solana.program_id}`);
  console.log(`target_chain\t${solana.target_chain}`);
  console.log(`status\t${solana.status}`);
  console.log(`idl\t${solana.idl_url}`);
  console.log(`manifest\t${solana.public_manifest_url}`);
  console.log(`ledger_reference_format\t${solana.ledger_reference_format}`);
  console.log("# instruction map (ledger type → Anchor)");
  for (const row of solana.instruction_map || []) {
    console.log(`${(row.ledger_types || []).join(",")}\t→\t${row.instruction}\t(${row.anchor_method})`);
  }
  console.log("# claim path");
  for (const [k, v] of Object.entries(solana.claim_path || {})) {
    console.log(`${k}\t${v}`);
  }
}

/**
 * End-to-end live smoke against mergeos.shop public APIs (no login).
 * Proves discovery + ledger verify + work split + claim-intent + optional share health.
 */
async function demoCommand(flags) {
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const base = (settings.mergeos && settings.mergeos.baseUrl) || "https://mergeos.shop";
  console.log(`# MRGMinner live demo · ${base}`);
  console.log("");

  console.log("## 1) status");
  await statusCommand({ ...flags, mock: false });
  console.log("");

  console.log("## 2) token economy");
  await tokenCommand({ ...flags, mock: false });
  console.log("");

  console.log("## 3) ledger verify (local hash walk)");
  await verifyCommand({ ...flags, mock: false });
  console.log("");

  console.log("## 4) marketplace + split");
  await marketCommand({ ...flags, mock: false });
  console.log("");
  await splitCommand({ ...flags, mock: false });
  console.log("");

  console.log("## 5) claim-block + first intent");
  await blockCommand({ ...flags, mock: false });
  console.log("");
  const { discovery } = await loadChainBundle(flags);
  const first = (discovery.marketplace.open_bounties || [])[0];
  if (first) {
    await intentCommand({ ...flags, _: [first.id], mock: false });
  } else {
    console.log("(no open bounties for intent)");
  }
  console.log("");

  console.log("## 6) next --dry-run (public market if not logged in)");
  await nextCommand({ ...flags, dryRun: true });
  console.log("");

  console.log("## 7) solana binding");
  await solanaCommand({ ...flags, mock: false });
  console.log("");

  console.log("# demo complete — live public path OK");
  console.log("# claim/run/submit still need: mrgminner login + claim <id> --with-intent");
  console.log("# bandwidth share: mrgminner share start --region vn --port 17890");
}

async function statusCommand(flags) {
  if (flags.mock || flags.offline) {
    const discovery = mockChainDiscovery();
    const status = {
      source: "mock",
      token_symbol: discovery.token.token_symbol,
      minted_cents: discovery.token.totals.minted_cents,
      remaining_reserve_cents: discovery.token.totals.remaining_reserve_cents,
      ledger_entries: discovery.ledger.entry_count,
      ledger_server_valid: discovery.ledger.valid,
      claim_block_ready: discovery.fleet.claim_block_ready,
      online_nodes: discovery.fleet.online_nodes,
      open_bounties_listed: discovery.marketplace.open_bounties.length,
      discoverable_open_mrg: discovery.marketplace.stats.discoverable_open_mrg,
      solana_program_id: discovery.solana.program_id,
      mergeos_url: "http://localhost:8080",
      worker_id: "mrgminner:mock",
      provider: "mock",
      token: redactToken("mock-token-abcd1234")
    };
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    printStatus(status);
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const { discovery, source } = await loadChainBundle(flags);
  const status = {
    source,
    token_symbol: discovery.token.token_symbol,
    minted_cents: discovery.token.totals.minted_cents,
    remaining_reserve_cents: discovery.token.totals.remaining_reserve_cents,
    ledger_entries: discovery.ledger.entry_count,
    ledger_server_valid: discovery.ledger.valid,
    local_verify_valid: discovery.ledger.integrity.local_verify
      ? discovery.ledger.integrity.local_verify.valid
      : null,
    claim_block_ready: discovery.fleet.claim_block_ready,
    online_nodes: `${discovery.fleet.online_nodes}/${discovery.fleet.total_nodes}`,
    open_bounties_listed: discovery.marketplace.open_bounties.length,
    discoverable_open_mrg: discovery.marketplace.stats.discoverable_open_mrg,
    solana_program_id: discovery.solana && discovery.solana.program_id,
    worker_id: settings.worker && settings.worker.id,
    agent_type: settings.worker && settings.worker.agentType,
    provider: settings.ai && settings.ai.provider,
    mergeos_url: settings.mergeos && settings.mergeos.baseUrl,
    has_token: Boolean(settings.mergeos && settings.mergeos.token),
    token: redactToken(settings.mergeos && settings.mergeos.token)
  };
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    maybeWriteOut(flags, status);
    return;
  }
  printStatus(status);
  maybeWriteOut(flags, status);
}

function printStatus(status) {
  console.log(`# MRGMinner status (${status.source})`);
  for (const [key, value] of Object.entries(status)) {
    if (key === "source") continue;
    console.log(`${key}\t${value}`);
  }
}

function help() {
  console.log(`MRGMinner — MergeOS task runner + discoverable MRG chain

Usage:
  mrgminner version [--json]
  mrgminner configure --mergeos-url https://mergeos.shop --provider claude --worker-id github:you
  mrgminner login --email you@example.com --password secret
  mrgminner ide [--host 127.0.0.1] [--port 17331] [--workspace .] [--no-open]
  mrgminner status [--json] [--mock]
  mrgminner demo | live                             # full live smoke (public APIs)
  mrgminner tasks --open
  mrgminner prompt <task-id>
  mrgminner run <task-id> [--claim] [--submit --pr-url <url>]
  mrgminner claim <task-id> [--with-intent]
  mrgminner submit <task-id> --pr-url <url> [--with-intent]
  mrgminner pack <task-id> [--pr-url <url>]              # zip task artifacts
  mrgminner compare [--presets codex,claude] [--kind agent]
  mrgminner next [--kind agent] [--dry-run] [--claim] [--submit --pr-url <url>]

  # Agent nodes + claim-block cluster
  mrgminner nodes [--online] [--role job|review|audit] [--json] [--mock]
  mrgminner stats [--json] [--mock]
  mrgminner block [--json] [--mock]

  # Blockchain discovery (public APIs — no login for most)
  mrgminner token [--json] [--mock]             # MRG token economy
  mrgminner proof [--json] [--mock]             # ledger hash-chain proof
  mrgminner verify [--json] [--mock]            # local previous_hash walk
  mrgminner market [--json] [--project prj_…]   # open bounties (title MRG)
  mrgminner split [--json] [--mock]             # load-balanced work packs
  mrgminner chain [--json] [--out chain.json]   # full discovery bundle
  mrgminner intent [task-id] [--json]           # claim intent + ledger_ref
  mrgminner solana [--json] [--mock]            # Solana program + ix map

  # Bandwidth share stream (residential exit → earn MRG; pairs with TrucVPN)
  mrgminner share start [--region vn] [--city "Ho Chi Minh"] [--regions "vn:Ho Chi Minh:70,sg:Singapore:30"] [--port 17890]
  mrgminner share status
  mrgminner share earnings [--json]
  # TrucVPN client: trucvpn configure --share-url http://127.0.0.1:17890
  #                 trucvpn connect --region vn

Claim-block: online job + review + audit + verified entry_hash → mrg_eligible.
Work packs bind each bounty to block + ledger tip (+ Solana ledgerReference).
Payout release stays with owner/admin accept (optional Solana releasePayout).
Bandwidth share is a separate MRG stream: relay residential traffic for TrucVPN users.

AI CLI placeholders:
  {{prompt}}  {{promptFile}}  {{taskFile}}  {{taskId}}

Explore: https://scan.mergeos.shop  ·  https://mergeos.shop
`);
}

module.exports = {
  buildCompareNotes,
  compareCommand,
  main,
  packCommand,
  parseFlags,
  readPackageInfo,
  selectNextTask,
  settingsFromFlags,
  versionCommand
};
