"use strict";

const path = require("node:path");
const {
  claimTask,
  findTask,
  getLedgerProof,
  getLiveFeed,
  getMarketplace,
  getPublicConfig,
  getPublicLedger,
  getTokenEconomy,
  listProtocolAgents,
  listTasks,
  login,
  recordAgentAction,
  submitTaskEvidence
} = require("./api");
const { loadSettings, mergeSettings, parseArgList, readSettingsFile, saveSettings, settingsPath } = require("./settings");
const { prepareTaskArtifacts, runAIForTask } = require("./runner");
const { buildFleetReport, mockFleetPayload } = require("./nodes");
const {
  buildChainDiscovery,
  buildClaimIntent,
  discoverMarketplace,
  mockChainDiscovery,
  mockEconomy,
  mockMarket,
  mockProof,
  splitWork,
  summarizeLedgerProof,
  summarizeTokenEconomy
} = require("./chain");

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
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      throw new Error(`unknown command: ${command}`);
  }
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
  const task = await findTask(settings, taskID);
  const artifacts = await prepareTaskArtifacts(settings, task, {
    workspaceRoot: flags.workspace
  });
  console.log(artifacts.promptFile);
}

async function runCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await findTask(settings, taskID);
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

async function claimCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await findTask(settings, taskID);
  const claimed = await claimTask(settings, task, claimOverrides(flags));
  printClaimed(claimed);
}

async function submitCommand(flags) {
  const taskID = requiredPositional(flags, "task id");
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const task = await findTask(settings, taskID);
  await submitAndRecord(settings, task, flags);
}

async function nextCommand(flags) {
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  const tasks = await listTasks(settings);
  const task = selectNextTask(tasks, flags);
  if (!task) {
    console.log("No open MergeOS task matched the current filters.");
    return;
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
  const action = await recordAgentAction(settings, submitted.project_id || task.project_id || task.projectID, agentActionFromSubmission(settings, task, submitted, flags));
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

function agentActionFromSubmission(settings, task, submitted, flags) {
  const pullRequestURL = submitted.pull_request_url || flags.pullRequestUrl || flags.prUrl || "";
  const evidenceURL = submitted.review_evidence_url || flags.evidenceUrl || "";
  const referenceURL = flags.referenceUrl || pullRequestURL || evidenceURL;
  const notes = submitted.review_notes || flags.reviewNotes || flags.notes || "MergeIDE submitted task evidence for review.";
  return {
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
      "Claim the funded task before recording evidence.",
      "Submit pull request or external evidence for customer review.",
      "Wait for customer or admin release before payout."
    ],
    delegated_by: flags.delegatedBy,
    design_agent: flags.designAgent,
    subagent_type: flags.subagentType,
    delegation_chain: flags.delegationChain
  };
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
    const [economy, proof, market, agents, feed, ledger] = await Promise.all([
      getTokenEconomy(settings),
      getLedgerProof(settings),
      getMarketplace(settings, Number(flags.limit || 40)),
      listProtocolAgents(settings, Number(flags.limit || 50)),
      getLiveFeed(settings, Number(flags.feedLimit || 40)),
      getPublicLedger(settings, Number(flags.ledgerLimit || 30))
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
      options: { limit: Number(flags.limit || 25), maxPacks: Number(flags.maxPacks || 10) }
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
  console.log(`# MRG ledger proof (${source}) · valid=${ledger.valid}`);
  console.log(`entries\t${ledger.entry_count}\tverified\t${ledger.verified_count}\tbroken\t${ledger.broken_count}`);
  console.log(`root_hash\t${ledger.root_hash}`);
  console.log(`public_root_hash\t${ledger.public_root_hash}`);
  console.log(`hash_chain_complete\t${ledger.integrity.hash_chain_complete}`);
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
  if (flags.mock || flags.offline) {
    const marketplace = discoverMarketplace(mockMarket(), { limit: Number(flags.limit || 25) });
    if (flags.json) {
      console.log(JSON.stringify(marketplace, null, 2));
      return;
    }
    printMarket(marketplace, "mock");
    return;
  }
  const settings = await loadSettings(flags.settings, settingsFromFlags(flags));
  try {
    const market = await getMarketplace(settings, Number(flags.limit || 40));
    const marketplace = discoverMarketplace(market, { limit: Number(flags.limit || 25) });
    if (flags.json) {
      console.log(JSON.stringify(marketplace, null, 2));
      return;
    }
    printMarket(marketplace, "live");
  } catch (error) {
    if (flags.strict) throw error;
    const marketplace = discoverMarketplace(mockMarket(), { limit: Number(flags.limit || 25) });
    console.log(`# live unavailable: ${error.message}`);
    printMarket(marketplace, "mock-fallback");
  }
}

function printMarket(marketplace, source) {
  console.log(`# Marketplace discovery (${source}) · ${marketplace.token_symbol}`);
  console.log(
    `projects\t${marketplace.stats.project_count}\topen_tasks\t${marketplace.stats.open_task_count}\twork_pool_cents\t${marketplace.stats.work_pool_cents}`
  );
  console.log("# open bounties (claimable MRG)");
  console.log("id\treward\tkind\tstatus\ttitle");
  for (const b of marketplace.open_bounties) {
    console.log(`${b.id}\t${b.reward_mrg} MRG\t${b.worker_kind}\t${b.status}\t${b.title}`);
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
    return;
  }
  if (discovery.warning) {
    console.log(`# ${discovery.warning}`);
  }
  console.log(`# Work split (${source}) · packs=${split.pack_count} · block=${split.claim_block.block_id || "—"}`);
  console.log(
    `claim_block_ready\t${split.claim_block.ready}\tmrg_eligible\t${split.claim_block.mrg_eligible}\ttip\t${(split.ledger_tip_hash || "").slice(0, 16)}…`
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
}

async function chainCommand(flags) {
  const { discovery, source } = await loadChainBundle(flags);
  if (flags.json) {
    console.log(JSON.stringify({ source, ...discovery }, null, 2));
    return;
  }
  if (discovery.warning) {
    console.log(`# ${discovery.warning}`);
  }
  console.log(`# Chain discovery (${source})`);
  console.log(
    `token\t${discovery.token.token_symbol}\tminted\t${discovery.token.totals.minted_cents}\treserve\t${discovery.token.totals.remaining_reserve_cents}`
  );
  console.log(
    `ledger\tvalid=${discovery.ledger.valid}\tentries=${discovery.ledger.entry_count}\tverified=${discovery.ledger.verified_count}\troot=${(discovery.ledger.root_hash || "").slice(0, 16)}…`
  );
  console.log(
    `fleet\tonline=${discovery.fleet.online_nodes}/${discovery.fleet.total_nodes}\tblock_ready=${discovery.fleet.claim_block_ready}`
  );
  console.log(
    `market\tprojects=${discovery.marketplace.stats.project_count}\topen=${discovery.marketplace.stats.open_task_count}\tpacks=${discovery.work_split.pack_count}`
  );
  console.log(`scan\t${discovery.explore.scan}`);
  console.log(`proof\t${discovery.explore.ledger_proof}`);
  console.log(`marketplace_api\t${discovery.explore.marketplace}`);
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
        task = await findTask(settings, taskId);
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
    prUrl: flags.prUrl || ""
  });

  if (flags.json) {
    console.log(JSON.stringify({ source, claim_intent: fullIntent }, null, 2));
    return;
  }
  console.log(`# Claim intent (${source}) · ready=${fullIntent.ready} · mrg_eligible=${fullIntent.mrg_eligible}`);
  console.log(`intent_id\t${fullIntent.intent_id}`);
  console.log(`intent_hash\t${fullIntent.intent_hash}`);
  console.log(`task_id\t${fullIntent.task_id}\treward\t${fullIntent.reward_mrg} MRG`);
  console.log(`worker_id\t${fullIntent.worker_id}`);
  console.log(`claim_block_id\t${fullIntent.claim_block_id || "—"}`);
  console.log(`ledger_tip_hash\t${fullIntent.ledger_tip_hash || "—"}`);
  console.log(`hash_complete\t${fullIntent.hash_binding.complete}`);
  if (fullIntent.commands.claim) {
    console.log(`cmd.claim\t${fullIntent.commands.claim}`);
  }
  if (fullIntent.commands.explore) {
    console.log(`explore\t${fullIntent.commands.explore}`);
  }
  console.log(`# ${fullIntent.notice}`);
}

function help() {
  console.log(`MRGMinner — MergeOS task runner + MRG chain discovery

Usage:
  mrgminner configure --mergeos-url https://mergeos.shop --provider claude --worker-id github:you
  mrgminner login --email you@example.com --password secret
  mrgminner tasks --open
  mrgminner prompt <task-id>
  mrgminner run <task-id> [--claim] [--submit --pr-url <url>]
  mrgminner claim <task-id>
  mrgminner submit <task-id> --pr-url <url> [--evidence-url <url>] [--notes <text>]
  mrgminner next [--kind agent] [--claim] [--submit --pr-url <url>]

  # Agent nodes + claim-block cluster
  mrgminner nodes [--online] [--role job|review|audit] [--json] [--mock]
  mrgminner stats [--json] [--mock]
  mrgminner block [--json] [--mock]

  # Blockchain discovery (public APIs — no login for most)
  mrgminner token [--json] [--mock]          # MRG token economy
  mrgminner proof [--json] [--mock]          # ledger hash-chain proof
  mrgminner market [--json] [--mock]         # open bounties / funded projects
  mrgminner split [--json] [--mock]          # split work across job/review/audit
  mrgminner chain [--json] [--mock]          # full discovery bundle
  mrgminner intent [task-id] [--json] [--mock]  # claim intent bound to ledger tip

Claim-block: online job + review + audit nodes + verified entry_hash → mrg_eligible cluster.
Work split packs bind each bounty to that block and ledger tip for discoverable MRG claims.
Payout release always stays with MergeOS owner/admin accept.

AI CLI placeholders:
  {{prompt}}  {{promptFile}}  {{taskFile}}  {{taskId}}

Explore: https://scan.mergeos.shop  ·  https://mergeos.shop
`);
}

module.exports = {
  main,
  parseFlags,
  selectNextTask,
  settingsFromFlags
};
