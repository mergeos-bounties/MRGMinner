"use strict";

const { normalizeBaseUrl } = require("./settings");

async function apiRequest(settings, method, route, body) {
  const baseUrl = normalizeBaseUrl(settings.mergeos && settings.mergeos.baseUrl);
  const headers = {
    Accept: "application/json"
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const token = settings.mergeos && settings.mergeos.token ? String(settings.mergeos.token).trim() : "";
  if (token) {
    headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
    throw new Error(`MergeOS ${method} ${route} failed: ${message}`);
  }
  return payload;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`MergeOS returned invalid JSON: ${error.message}`);
  }
}

async function login(settings, email, password) {
  return apiRequest(settings, "POST", "/api/auth/login", { email, password });
}

async function listTasks(settings) {
  const tasks = await apiRequest(settings, "GET", "/api/tasks");
  return Array.isArray(tasks) ? tasks : [];
}

async function publicGet(settings, route) {
  const baseUrl = normalizeBaseUrl(settings.mergeos && settings.mergeos.baseUrl);
  const response = await fetch(`${baseUrl}${route}`, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
    throw new Error(`MergeOS GET ${route} failed: ${message}`);
  }
  return payload;
}

async function listProtocolAgents(settings, limit = 50) {
  const payload = await publicGet(settings, `/api/public/protocol/agents?limit=${encodeURIComponent(limit)}`);
  if (Array.isArray(payload)) {
    return payload;
  }
  return Array.isArray(payload.agents) ? payload.agents : [];
}

async function getLiveFeed(settings, limit = 40) {
  return publicGet(settings, `/api/public/live-feed?limit=${encodeURIComponent(limit)}`);
}

async function getPublicLedger(settings, limit = 20) {
  try {
    const payload = await publicGet(settings, `/api/public/ledger?limit=${encodeURIComponent(limit)}`);
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload.entries)) {
      return payload.entries;
    }
    if (Array.isArray(payload.items)) {
      return payload.items;
    }
    return [];
  } catch {
    return [];
  }
}

async function getTokenEconomy(settings) {
  return publicGet(settings, "/api/public/token-economy");
}

async function getLedgerProof(settings) {
  return publicGet(settings, "/api/public/ledger/proof");
}

async function getMarketplace(settings, limit = 40) {
  return publicGet(settings, `/api/public/marketplace?limit=${encodeURIComponent(limit)}`);
}

async function getPublicConfig(settings) {
  try {
    return await publicGet(settings, "/api/config");
  } catch {
    return null;
  }
}

async function getSolanaProofManifest(settings) {
  const baseUrl = normalizeBaseUrl(settings.mergeos && settings.mergeos.baseUrl);
  const paths = [
    "/contracts/solana/mergeos_mrg.proof-manifest.v1.json",
    "/api/public/contracts/solana/mergeos_mrg.proof-manifest.v1.json"
  ];
  for (const route of paths) {
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      return text ? parseJson(text) : null;
    } catch {
      // try next path
    }
  }
  // Absolute public shop fallback (works even if local baseUrl has no contracts)
  try {
    const response = await fetch("https://mergeos.shop/contracts/solana/mergeos_mrg.proof-manifest.v1.json", {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    return text ? parseJson(text) : null;
  } catch {
    return null;
  }
}

async function findTask(settings, taskID) {
  const tasks = await listTasks(settings);
  const ref = String(taskID || "").trim();
  const task = tasks.find((row) => row && [row.id, row.task_id, row.claim_id, row.bounty_id].some((value) => String(value || "").trim() === ref));
  if (!task) {
    throw new Error(`task ${taskID} was not found in /api/tasks`);
  }
  return task;
}

async function claimTask(settings, task, overrides = {}) {
  const workerKind = overrides.workerKind || task.required_worker_kind || "agent";
  const request = {
    worker_kind: workerKind,
    worker_id: overrides.workerId || settings.worker.id
  };
  const agentType = overrides.agentType || settings.worker.agentType || "mergeide";
  if (workerKind !== "human") {
    request.agent_type = agentType;
  }
  return apiRequest(settings, "POST", `/api/tasks/${encodeURIComponent(taskRef(task))}/claim`, request);
}

async function submitTaskEvidence(settings, task, submission = {}) {
  return apiRequest(settings, "POST", `/api/tasks/${encodeURIComponent(taskRef(task))}/submit`, submissionPayload(submission));
}

async function recordAgentAction(settings, projectID, payload = {}) {
  const id = String(projectID || "").trim();
  if (!id) {
    throw new Error("project_id is required to record MergeOS agent evidence");
  }
  return apiRequest(settings, "POST", `/api/projects/${encodeURIComponent(id)}/agent-actions`, agentActionPayload(payload));
}

function taskRef(task) {
  if (!task || typeof task !== "object") {
    throw new Error("task is required");
  }
  const value = task.claim_id || task.claimID || task.id || task.task_id || task.taskID;
  if (!value) {
    throw new Error("task id is required");
  }
  return String(value);
}

function submissionPayload(submission = {}) {
  const payload = {
    pull_request_url: submission.pull_request_url || submission.pullRequestURL || submission.pullRequestUrl || submission.prUrl || "",
    evidence_url: submission.evidence_url || submission.evidenceURL || submission.evidenceUrl || "",
    review_notes: submission.review_notes || submission.reviewNotes || submission.notes || ""
  };
  return compactPayload(payload);
}

function agentActionPayload(payload = {}) {
  const body = {
    action: payload.action || "generate",
    claim_id: payload.claim_id || payload.claimID || payload.bounty_id || payload.bountyID || "",
    bounty_id: payload.bounty_id || payload.bountyID || payload.claim_id || payload.claimID || "",
    agent_type: payload.agent_type || payload.agentType || "",
    status: payload.status || "processed",
    reference_url: payload.reference_url || payload.referenceURL || payload.referenceUrl || "",
    pull_number: positiveInteger(payload.pull_number || payload.pullNumber),
    labels: listValue(payload.labels),
    context_urls: listValue(payload.context_urls || payload.contextURLs || payload.contextUrls),
    evidence: listValue(payload.evidence),
    runbook: listValue(payload.runbook),
    checks: Array.isArray(payload.checks) ? payload.checks : [],
    duration_millis: positiveInteger(payload.duration_millis || payload.durationMillis)
  };
  if (payload.delegated_by || payload.delegatedBy) {
    body.delegated_by = payload.delegated_by || payload.delegatedBy;
  }
  if (payload.design_agent || payload.designAgent) {
    body.design_agent = payload.design_agent || payload.designAgent;
  }
  if (payload.subagent_type || payload.subagentType) {
    body.subagent_type = payload.subagent_type || payload.subagentType;
  }
  if (payload.delegation_chain || payload.delegationChain) {
    body.delegation_chain = listValue(payload.delegation_chain || payload.delegationChain);
  }
  // Discoverable MRG chain binding (intent / pack / ledger tip)
  const chain = payload.chain_binding || payload.chainBinding || payload.claim_metadata || null;
  if (chain && typeof chain === "object") {
    body.chain_binding = compactPayload({
      protocol: chain.mrgminner_protocol || chain.protocol || "mrgminner.claim-intent.v2",
      intent_id: chain.intent_id,
      intent_hash: chain.intent_hash,
      pack_hash: chain.pack_hash,
      claim_block_id: chain.claim_block_id,
      ledger_tip_hash: chain.ledger_tip_hash,
      ledger_reference: chain.ledger_reference,
      reward_mrg: chain.reward_mrg,
      worker_id: chain.worker_id,
      solana_program_id: chain.solana_program_id || (chain.solana && chain.solana.program_id)
    });
    if (body.chain_binding.intent_hash || body.chain_binding.ledger_tip_hash) {
      const chainLines = [
        body.chain_binding.intent_id && `intent_id=${body.chain_binding.intent_id}`,
        body.chain_binding.intent_hash && `intent_hash=${body.chain_binding.intent_hash}`,
        body.chain_binding.pack_hash && `pack_hash=${body.chain_binding.pack_hash}`,
        body.chain_binding.ledger_tip_hash && `ledger_tip=${body.chain_binding.ledger_tip_hash}`,
        body.chain_binding.ledger_reference && `ledger_ref=${body.chain_binding.ledger_reference}`,
        body.chain_binding.reward_mrg != null && `reward_mrg=${body.chain_binding.reward_mrg}`
      ].filter(Boolean);
      body.evidence = [...(body.evidence || []), ...chainLines];
    }
  }
  return compactPayload(body);
}

function compactPayload(payload) {
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function listValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

module.exports = {
  apiRequest,
  agentActionPayload,
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
  publicGet,
  recordAgentAction,
  submissionPayload,
  submitTaskEvidence,
  taskRef
};
