"use strict";

/**
 * Online agent nodes, stats, and MRG claim-blocks.
 *
 * A claim-block is ready when the fleet has:
 *  - ≥1 job worker node (implementation / coding)
 *  - ≥1 review node (code/evidence review)
 *  - ≥1 audit node (scan/security/ledger proof with entry_hash)
 * and recent ledger activity carries verified entry hashes.
 */

const crypto = require("node:crypto");

const ROLE_JOB = "job";
const ROLE_REVIEW = "review";
const ROLE_AUDIT = "audit";

const ONLINE_STATUSES = new Set(["active", "online", "busy", "running"]);
const STANDBY_STATUSES = new Set(["standby", "idle", "ready"]);

function classifyAgentRole(agent) {
  const type = String(agent.type || agent.id || "").toLowerCase();
  const role = String(agent.role || "").toLowerCase();
  const focus = (agent.focus || []).map((x) => String(x).toLowerCase());
  const caps = (agent.capabilities || []).map((x) => String(x).toLowerCase());
  const actions = (agent.supported_actions || []).map((x) => String(x).toLowerCase());
  const tags = (agent.tags || []).map((x) => String(x).toLowerCase());
  const hay = [type, role, ...focus, ...caps, ...actions, ...tags].join(" ");

  // Prefer explicit agent type names before capability soup
  if (/review-agent|qa-agent|design-review|pr-review|code-review-agent/.test(type)) {
    return ROLE_REVIEW;
  }
  if (/repo-scan|security-review|audit|scan-agent|risk-agent/.test(type)) {
    return ROLE_AUDIT;
  }
  if (/coding-agent|frontend-agent|backend-agent|deploy|implementation|job-agent/.test(type)) {
    return ROLE_JOB;
  }

  if (/repo.?scan|security_review|dependency_scan|ledger.?proof|audit/.test(hay) && !/design.?review|code.?review|pr.?review/.test(type)) {
    return ROLE_AUDIT;
  }
  if (/review|qa|pr_review|evidence_review|quality_gate|ux_review/.test(hay)) {
    return ROLE_REVIEW;
  }
  if (/coding|implement|generate|frontend|backend|job|worker|deploy/.test(hay)) {
    return ROLE_JOB;
  }
  if (actions.includes("generate") && !actions.includes("review")) {
    return ROLE_JOB;
  }
  if (actions.includes("review")) {
    return ROLE_REVIEW;
  }
  if (actions.includes("scan")) {
    return ROLE_AUDIT;
  }
  return ROLE_JOB;
}

function isNodeOnline(agent) {
  const status = String(agent.status || "").toLowerCase();
  if (ONLINE_STATUSES.has(status)) {
    return true;
  }
  if (STANDBY_STATUSES.has(status) && Number(agent.open_task_count || 0) > 0) {
    return true;
  }
  // queue_depth > 0 implies capacity / recent activity
  const depth = Number(agent.metadata && agent.metadata.queue_depth);
  if (Number.isFinite(depth) && depth > 0) {
    return true;
  }
  return false;
}

function normalizeNode(agent) {
  const role = classifyAgentRole(agent);
  const online = isNodeOnline(agent);
  return {
    id: agent.id || agent.type,
    type: agent.type || "",
    title: agent.title || agent.type || agent.id,
    role,
    worker_kind: agent.worker_kind || "agent",
    status: agent.status || "unknown",
    online,
    open_task_count: Number(agent.open_task_count || 0),
    task_count: Number(agent.task_count || 0),
    budget_mrg: Number(agent.budget_mrg || 0),
    supported_actions: agent.supported_actions || [],
    capabilities: agent.capabilities || [],
    focus: agent.focus || [],
    queue_depth: Number((agent.metadata && agent.metadata.queue_depth) || 0),
    open_task_ids: agent.open_task_ids || []
  };
}

function extractLedgerHashes(ledgerItems = []) {
  return ledgerItems
    .filter((item) => item && (item.entry_hash || item.hash))
    .map((item) => ({
      sequence: item.ledger_sequence || item.sequence || null,
      entry_hash: String(item.entry_hash || item.hash || ""),
      status: item.status || "",
      type: item.type || "",
      actor: item.actor || "",
      reference: item.reference || "",
      created_at: item.created_at || ""
    }))
    .filter((row) => row.entry_hash.length >= 16);
}

function buildNodeStats(nodes, feedStats = {}, ledgerHashes = []) {
  const online = nodes.filter((n) => n.online);
  const byRole = {
    [ROLE_JOB]: nodes.filter((n) => n.role === ROLE_JOB),
    [ROLE_REVIEW]: nodes.filter((n) => n.role === ROLE_REVIEW),
    [ROLE_AUDIT]: nodes.filter((n) => n.role === ROLE_AUDIT)
  };
  const onlineByRole = {
    job: byRole[ROLE_JOB].filter((n) => n.online).length,
    review: byRole[ROLE_REVIEW].filter((n) => n.online).length,
    audit: byRole[ROLE_AUDIT].filter((n) => n.online).length
  };
  const verifiedHashes = ledgerHashes.filter(
    (h) => !h.status || String(h.status).toLowerCase() === "verified"
  );
  return {
    protocol_version: "mrgminner.nodes.v1",
    total_nodes: nodes.length,
    online_nodes: online.length,
    offline_nodes: nodes.length - online.length,
    by_role: {
      job: byRole[ROLE_JOB].length,
      review: byRole[ROLE_REVIEW].length,
      audit: byRole[ROLE_AUDIT].length
    },
    online_by_role: onlineByRole,
    open_tasks_on_nodes: nodes.reduce((sum, n) => sum + n.open_task_count, 0),
    queue_depth_total: nodes.reduce((sum, n) => sum + n.queue_depth, 0),
    ledger_hash_count: ledgerHashes.length,
    verified_hash_count: verifiedHashes.length,
    feed: {
      project_count: feedStats.project_count || 0,
      open_task_count: feedStats.open_task_count || 0,
      active_agent_count: feedStats.active_agent_count || 0,
      active_contributor_count: feedStats.active_contributor_count || 0,
      ledger_entry_count: feedStats.ledger_entry_count || 0,
      token_symbol: feedStats.token_symbol || "MRG"
    },
    claim_block_ready:
      onlineByRole.job >= 1 &&
      onlineByRole.review >= 1 &&
      onlineByRole.audit >= 1 &&
      verifiedHashes.length >= 1
  };
}

function pickBest(nodes, role) {
  const pool = nodes.filter((n) => n.role === role && n.online);
  if (!pool.length) {
    return null;
  }
  pool.sort((a, b) => {
    // Prefer active over standby, then more open tasks / queue as signal of work
    const score = (n) =>
      (ONLINE_STATUSES.has(String(n.status).toLowerCase()) ? 100 : 0) +
      n.open_task_count * 2 +
      n.queue_depth +
      n.task_count * 0.01;
    return score(b) - score(a);
  });
  return pool[0];
}

/**
 * Form a claim-block cluster for MRG work.
 * Requires online job + review + audit nodes and at least one verified ledger hash.
 */
function formClaimBlock(nodes, ledgerHashes = [], options = {}) {
  const worker = pickBest(nodes, ROLE_JOB);
  const reviewer = pickBest(nodes, ROLE_REVIEW);
  const auditor = pickBest(nodes, ROLE_AUDIT);
  const verified = ledgerHashes.filter(
    (h) => !h.status || String(h.status).toLowerCase() === "verified"
  );
  const tip = verified[0] || ledgerHashes[0] || null;
  const missing = [];
  if (!worker) missing.push("job_worker");
  if (!reviewer) missing.push("reviewer");
  if (!auditor) missing.push("auditor");
  if (!tip || !tip.entry_hash) missing.push("ledger_hash");

  const members = [worker, reviewer, auditor].filter(Boolean);
  const material = [
    worker && worker.id,
    reviewer && reviewer.id,
    auditor && auditor.id,
    tip && tip.entry_hash,
    options.taskId || "",
    options.projectId || ""
  ]
    .filter(Boolean)
    .join("|");
  const blockHash = material
    ? crypto.createHash("sha256").update(material).digest("hex")
    : "";

  const ready = missing.length === 0;
  return {
    protocol_version: "mrgminner.claim-block.v1",
    kind: "claim_block",
    ready,
    status: ready ? "ready" : "incomplete",
    mrg_eligible: ready,
    block_id: blockHash ? `blk_${blockHash.slice(0, 16)}` : null,
    block_hash: blockHash || null,
    missing,
    members: {
      job: worker,
      review: reviewer,
      audit: auditor
    },
    ledger_tip: tip,
    hash_chain: {
      tip_hash: tip ? tip.entry_hash : null,
      tip_sequence: tip ? tip.sequence : null,
      verified_count: verified.length,
      complete: Boolean(tip && tip.entry_hash && tip.entry_hash.length >= 32)
    },
    claim_guidance: ready
      ? {
          steps: [
            "Assign job node to implement (mrgminner run / claim)",
            "Review node records evidence via agent-actions review",
            "Audit node confirms ledger proof (entry_hash present)",
            "Submit PR evidence; accept/payout stays with owner/admin"
          ],
          worker_id_hint: worker.id,
          review_agent_type: reviewer.type,
          audit_agent_type: auditor.type
        }
      : {
          steps: [`Fill missing roles/hashes: ${missing.join(", ")}`],
          worker_id_hint: null
        },
    formed_at: new Date().toISOString()
  };
}

function buildFleetReport({ agents = [], feed = {}, ledgerItems = [], options = {} }) {
  const list = Array.isArray(agents) ? agents : agents.agents || [];
  const nodes = list.map(normalizeNode);
  const feedStats = feed.stats || feed || {};
  const items = Array.isArray(ledgerItems)
    ? ledgerItems
    : ledgerItems.items || feed.items || [];
  // Prefer ledger-like items from feed when dedicated ledger missing
  const hashSource = items.filter(
    (item) => item.entry_hash || item.type && String(item.type).includes("ledger")
  );
  const ledgerHashes = extractLedgerHashes(hashSource.length ? hashSource : items);
  const stats = buildNodeStats(nodes, feedStats, ledgerHashes);
  const claimBlock = formClaimBlock(nodes, ledgerHashes, options);
  return {
    protocol_version: "mrgminner.fleet.v1",
    nodes: nodes.sort((a, b) => Number(b.online) - Number(a.online) || a.role.localeCompare(b.role)),
    online: nodes.filter((n) => n.online),
    stats,
    claim_block: claimBlock
  };
}

/** Offline seed for demos/tests without network. */
function mockFleetPayload() {
  const agents = [
    {
      id: "agt_coding_agent",
      type: "coding-agent",
      title: "Coding Agent",
      worker_kind: "agent",
      role: "subagent",
      status: "active",
      open_task_count: 2,
      task_count: 12,
      supported_actions: ["generate"],
      capabilities: ["implementation_generation", "task_intake"],
      focus: ["implementation"],
      metadata: { queue_depth: 2 }
    },
    {
      id: "agt_review_agent",
      type: "review-agent",
      title: "Review Agent",
      worker_kind: "agent",
      role: "subagent",
      status: "active",
      open_task_count: 1,
      task_count: 8,
      supported_actions: ["review"],
      capabilities: ["code_review", "evidence_reporting"],
      focus: ["code_review", "pr_review"],
      metadata: { queue_depth: 1 }
    },
    {
      id: "agt_repo_scan_agent",
      type: "repo-scan-agent",
      title: "Repo Scan Agent",
      worker_kind: "agent",
      role: "subagent",
      status: "active",
      open_task_count: 0,
      task_count: 5,
      supported_actions: ["scan"],
      capabilities: ["repository_scan", "security_review"],
      focus: ["repository_scan", "security_review"],
      metadata: { queue_depth: 0 }
    },
    {
      id: "agt_standby_coder",
      type: "frontend-agent",
      title: "Frontend Agent",
      status: "standby",
      open_task_count: 0,
      supported_actions: ["generate"],
      capabilities: ["implementation_generation"],
      metadata: { queue_depth: 0 }
    }
  ];
  const feed = {
    stats: {
      project_count: 3,
      open_task_count: 12,
      active_agent_count: 3,
      active_contributor_count: 5,
      ledger_entry_count: 40,
      token_symbol: "MRG"
    },
    items: [
      {
        type: "ledger_manual_credit",
        ledger_sequence: 40,
        entry_hash: "a".repeat(64),
        status: "verified",
        actor: "github:demo",
        reference: "pr:https://github.com/example/repo/pull/1"
      }
    ]
  };
  return buildFleetReport({ agents, feed, ledgerItems: feed.items });
}

module.exports = {
  ROLE_JOB,
  ROLE_REVIEW,
  ROLE_AUDIT,
  classifyAgentRole,
  isNodeOnline,
  normalizeNode,
  extractLedgerHashes,
  buildNodeStats,
  formClaimBlock,
  buildFleetReport,
  mockFleetPayload
};
