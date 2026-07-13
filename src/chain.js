"use strict";

/**
 * Blockchain-facing layer for MRGMinner:
 * - Discover token economy + marketplace bounties
 * - Explore ledger / hash-chain proof
 * - Split work across job/review/audit nodes (claim-block)
 * - Bind claims to ledger tip hashes for MRG-eligible packs
 */

const crypto = require("node:crypto");
const { formClaimBlock, buildFleetReport, mockFleetPayload } = require("./nodes");

const SCAN_BASE = "https://scan.mergeos.shop";
const SHOP_BASE = "https://mergeos.shop";

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function mrgFromCents(cents) {
  const n = Number(cents || 0);
  if (!Number.isFinite(n)) {
    return 0;
  }
  // MergeOS ledger often stores whole MRG in cents-like fields (25 MRG = 25)
  // Prefer reward_mrg when present; else cents/100 if large.
  if (Math.abs(n) >= 1000 && n % 100 === 0) {
    return n / 100;
  }
  return n;
}

function formatMrg(amount) {
  const n = Number(amount || 0);
  return `${n} MRG`;
}

function scanAddressUrl(address) {
  const a = String(address || "").trim();
  if (!a) {
    return null;
  }
  return `${SCAN_BASE}/address/${encodeURIComponent(a)}`;
}

function scanTxUrl(hash) {
  const h = String(hash || "").trim();
  if (!h) {
    return null;
  }
  return `${SCAN_BASE}/tx/${encodeURIComponent(h)}`;
}

/** Summarize token economy for CLI discovery. */
function summarizeTokenEconomy(economy = {}) {
  const totals = economy.totals || {};
  const stats = economy.stats || {};
  return {
    protocol_version: economy.protocol_version || "mergeos.token-economy.v1",
    token_symbol: economy.token_symbol || "MRG",
    stats: {
      ledger_entry_count: stats.ledger_entry_count || 0,
      escrow_event_count: stats.escrow_event_count || 0,
      payout_count: stats.payout_count || 0,
      balance_count: stats.balance_count || 0,
      updated_at: stats.updated_at || null
    },
    totals: {
      verified_funding_cents: totals.verified_funding_cents || 0,
      minted_cents: totals.minted_cents || 0,
      project_reserve_cents: totals.project_reserve_cents || 0,
      task_reserve_cents: totals.task_reserve_cents || 0,
      released_cents: totals.released_cents || 0,
      remaining_reserve_cents: totals.remaining_reserve_cents || 0,
      platform_fee_cents: totals.platform_fee_cents || 0
    },
    balances: Array.isArray(economy.balances)
      ? economy.balances.slice(0, 12).map((b) => ({
          id: b.id,
          label: b.label,
          role: b.role,
          amount_cents: b.amount_cents,
          amount_mrg: mrgFromCents(b.amount_cents),
          entry_count: b.entry_count
        }))
      : [],
    recent_entries: Array.isArray(economy.recent_entries)
      ? economy.recent_entries.slice(0, 8).map(normalizeLedgerEntry)
      : [],
    explore: {
      scan: SCAN_BASE,
      shop: SHOP_BASE,
      token_economy: `${SHOP_BASE}/api/public/token-economy`,
      ledger_proof: `${SHOP_BASE}/api/public/ledger/proof`
    }
  };
}

function normalizeLedgerEntry(entry = {}) {
  const hash = entry.entry_hash || entry.hash || entry.public_hash || "";
  const seq = entry.sequence || entry.ledger_sequence || entry.id || null;
  const actor = entry.actor || entry.worker_id || "";
  return {
    sequence: seq,
    type: entry.type || entry.kind || "",
    amount_cents: entry.amount_cents || entry.amount || 0,
    amount_mrg: mrgFromCents(entry.amount_cents || entry.amount || 0),
    reference: entry.reference || "",
    actor,
    status: entry.status || "",
    entry_hash: hash,
    public_hash: entry.public_hash || "",
    previous_hash: entry.previous_hash || entry.prev_hash || "",
    created_at: entry.created_at || entry.time || "",
    project_id: entry.project_id || "",
    scan_tx: hash ? scanTxUrl(hash) : null,
    scan_address: actor ? scanAddressUrl(actor) : null
  };
}

/** Summarize ledger proof chain for explorers. */
function summarizeLedgerProof(proof = {}) {
  const entries = Array.isArray(proof.entries) ? proof.entries.map(normalizeLedgerEntry) : [];
  const tip = entries.length ? entries[entries.length - 1] : entries[0] || null;
  return {
    protocol_version: proof.protocol_version || "mergeos.ledger-proof.v1",
    token_symbol: proof.token_symbol || "MRG",
    valid: Boolean(proof.valid),
    entry_count: proof.entry_count || entries.length,
    verified_count: proof.verified_count || 0,
    broken_count: proof.broken_count || 0,
    root_hash: proof.root_hash || "",
    public_root_hash: proof.public_root_hash || proof.contract_reference || "",
    contract_reference: proof.contract_reference || proof.public_root_hash || "",
    tip,
    sample_entries: entries.slice(0, 12),
    integrity: {
      hash_chain_complete: Boolean(proof.root_hash && String(proof.root_hash).length >= 32),
      explorer: SCAN_BASE,
      proof_url: `${SHOP_BASE}/api/public/ledger/proof`
    },
    generated_at: proof.generated_at || null
  };
}

/** Discover open marketplace bounties / projects for work splitting. */
function discoverMarketplace(market = {}, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const projects = Array.isArray(market.projects) ? market.projects : [];
  const bounties = Array.isArray(market.bounties) ? market.bounties : [];
  const contributors = Array.isArray(market.contributors) ? market.contributors : [];
  const agents = Array.isArray(market.agents) ? market.agents : [];
  const stats = market.stats || {};

  const openBounties = bounties
    .filter((b) => {
      const st = String(b.status || b.task_status || "open").toLowerCase();
      return !st || st === "open" || st === "funded" || st === "available";
    })
    .slice(0, limit)
    .map((b) => {
      const reward =
        b.reward_mrg != null
          ? Number(b.reward_mrg)
          : mrgFromCents(b.reward_cents || b.amount_cents || b.budget_cents || 0);
      const claimId = b.claim_id || b.bounty_id || b.id || b.task_id || "";
      return {
        id: claimId,
        title: b.title || b.name || claimId,
        project_id: b.project_id || "",
        project_title: b.project_title || "",
        status: b.status || "open",
        worker_kind: b.required_worker_kind || b.worker_kind || "agent",
        suggested_agent: b.suggested_agent_type || b.agent_type || "",
        reward_mrg: reward,
        repo: b.repo_url || b.source_repo_url || b.bounty_repo_name || "",
        claim_endpoint: b.claim_endpoint || (claimId ? `/api/tasks/${claimId}/claim` : ""),
        scan: reward ? `${SCAN_BASE}` : SCAN_BASE
      };
    });

  const fundedProjects = projects
    .filter((p) => String(p.status || "").toLowerCase() === "funded" || p.budget_cents)
    .slice(0, limit)
    .map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      budget_cents: p.budget_cents || 0,
      budget_mrg: mrgFromCents(p.budget_cents || 0),
      repo: p.repo_url || p.bounty_repo_name || p.source_repo_url || "",
      open_tasks: p.open_task_count || p.task_count || null
    }));

  return {
    protocol_version: market.protocol_version || "mergeos.marketplace.v1",
    token_symbol: stats.token_symbol || "MRG",
    stats: {
      project_count: stats.project_count || projects.length,
      open_task_count: stats.open_task_count || openBounties.length,
      accepted_task_count: stats.accepted_task_count || 0,
      total_budget_cents: stats.total_budget_cents || 0,
      work_pool_cents: stats.work_pool_cents || 0,
      ledger_entry_count: stats.ledger_entry_count || 0
    },
    open_bounties: openBounties,
    funded_projects: fundedProjects,
    contributor_count: contributors.length,
    agent_count: agents.length,
    explore: {
      marketplace: `${SHOP_BASE}/api/public/marketplace`,
      live_feed: `${SHOP_BASE}/api/public/live-feed`,
      scan: SCAN_BASE
    }
  };
}

/**
 * Split open bounties across claim-block roles (job / review / audit).
 * Produces discoverable work packs bound to ledger tip hash.
 */
function splitWork({
  bounties = [],
  fleet = null,
  proof = null,
  maxPacks = 10
} = {}) {
  const report = fleet || mockFleetPayload();
  const block = report.claim_block || formClaimBlock(report.nodes || [], []);
  const tipHash =
    (proof && (proof.public_root_hash || proof.root_hash || (proof.tip && proof.tip.entry_hash))) ||
    (block.ledger_tip && block.ledger_tip.entry_hash) ||
    "";

  const packs = [];
  const list = bounties.slice(0, Math.max(1, Math.min(maxPacks, 50)));
  for (const bounty of list) {
    const material = [
      bounty.id,
      bounty.project_id || "",
      block.block_id || "",
      tipHash,
      bounty.reward_mrg || 0
    ].join("|");
    const packHash = sha256Hex(material);
    packs.push({
      pack_id: `pack_${packHash.slice(0, 12)}`,
      pack_hash: packHash,
      task_id: bounty.id,
      title: bounty.title,
      project_id: bounty.project_id || "",
      reward_mrg: bounty.reward_mrg || 0,
      worker_kind: bounty.worker_kind || "agent",
      assignment: {
        job: block.members && block.members.job ? block.members.job.id : null,
        review: block.members && block.members.review ? block.members.review.id : null,
        audit: block.members && block.members.audit ? block.members.audit.id : null
      },
      claim_block_id: block.block_id,
      ledger_tip_hash: tipHash || null,
      mrg_bound: Boolean(tipHash && block.ready),
      status: block.ready && tipHash ? "ready_to_claim" : "waiting_block",
      steps: [
        { role: "job", action: "claim+implement", command: `mrgminner claim ${bounty.id}` },
        { role: "job", action: "run", command: `mrgminner run ${bounty.id}` },
        { role: "review", action: "review evidence", command: "agent-actions review" },
        { role: "audit", action: "verify ledger hash", command: "mrgminner proof" },
        { role: "job", action: "submit", command: `mrgminner submit ${bounty.id} --pr-url <url>` }
      ],
      explore: {
        scan: SCAN_BASE,
        tip_tx: tipHash ? scanTxUrl(tipHash) : null
      }
    });
  }

  return {
    protocol_version: "mrgminner.work-split.v1",
    kind: "work_split",
    claim_block: {
      block_id: block.block_id,
      ready: block.ready,
      mrg_eligible: block.mrg_eligible,
      members: block.members
    },
    ledger_tip_hash: tipHash || null,
    pack_count: packs.length,
    packs,
    formed_at: new Date().toISOString()
  };
}

/**
 * Build a discoverable claim intent for a task, bound to claim-block + ledger tip.
 * Does not release payout — only structures claim metadata for workers/agents.
 */
function buildClaimIntent({
  task = {},
  fleet = null,
  proof = null,
  workerId = "",
  prUrl = ""
} = {}) {
  const report = fleet || mockFleetPayload();
  const block = report.claim_block;
  const tipHash =
    (proof && (proof.public_root_hash || proof.root_hash || (proof.tip && proof.tip.entry_hash))) ||
    (block && block.ledger_tip && block.ledger_tip.entry_hash) ||
    "";
  const taskId = task.claim_id || task.id || task.task_id || "";
  const reward =
    task.reward_mrg != null
      ? Number(task.reward_mrg)
      : mrgFromCents(task.reward_cents || 0);
  const intentMaterial = [
    taskId,
    workerId,
    block && block.block_id,
    tipHash,
    prUrl,
    reward
  ].join("|");
  const intentHash = sha256Hex(intentMaterial);
  const ready = Boolean(block && block.ready && tipHash && taskId);

  return {
    protocol_version: "mrgminner.claim-intent.v1",
    kind: "claim_intent",
    ready,
    mrg_eligible: ready && Boolean(block.mrg_eligible),
    intent_id: `intent_${intentHash.slice(0, 16)}`,
    intent_hash: intentHash,
    task_id: taskId,
    title: task.title || "",
    reward_mrg: reward,
    worker_id: workerId || null,
    claim_block_id: block && block.block_id,
    ledger_tip_hash: tipHash || null,
    hash_binding: {
      block_hash: block && block.block_hash,
      tip_hash: tipHash || null,
      intent_hash: intentHash,
      complete: ready
    },
    members: block ? block.members : null,
    commands: {
      claim: taskId ? `mrgminner claim ${taskId}` : null,
      run: taskId ? `mrgminner run ${taskId}` : null,
      submit: taskId
        ? `mrgminner submit ${taskId} --pr-url ${prUrl || "<url>"}`
        : null,
      explore: tipHash ? scanTxUrl(tipHash) : SCAN_BASE
    },
    notice:
      "Payout release requires owner/admin accept on MergeOS. This intent only binds claim work to ledger proof.",
    formed_at: new Date().toISOString()
  };
}

/** Full chain discovery bundle for explorers / agents. */
function buildChainDiscovery({
  economy = {},
  proof = {},
  market = {},
  fleet = null,
  options = {}
} = {}) {
  const token = summarizeTokenEconomy(economy);
  const ledger = summarizeLedgerProof(proof);
  const marketplace = discoverMarketplace(market, options);
  const report = fleet || mockFleetPayload();
  const split = splitWork({
    bounties: marketplace.open_bounties,
    fleet: report,
    proof: ledger,
    maxPacks: options.maxPacks || 10
  });

  return {
    protocol_version: "mrgminner.chain.v1",
    kind: "chain_discovery",
    token,
    ledger,
    marketplace,
    fleet: {
      online_nodes: report.stats.online_nodes,
      total_nodes: report.stats.total_nodes,
      online_by_role: report.stats.online_by_role,
      claim_block_ready: report.stats.claim_block_ready,
      claim_block: report.claim_block
    },
    work_split: split,
    explore: {
      scan: SCAN_BASE,
      shop: SHOP_BASE,
      token_economy: token.explore.token_economy,
      ledger_proof: token.explore.ledger_proof,
      marketplace: marketplace.explore.marketplace
    },
    generated_at: new Date().toISOString()
  };
}

function mockEconomy() {
  return {
    protocol_version: "mergeos.token-economy.v1",
    token_symbol: "MRG",
    stats: {
      ledger_entry_count: 40,
      escrow_event_count: 20,
      payout_count: 5,
      balance_count: 4,
      updated_at: new Date().toISOString()
    },
    totals: {
      verified_funding_cents: 500000,
      minted_cents: 500000,
      project_reserve_cents: 450000,
      task_reserve_cents: 450000,
      released_cents: 2500,
      remaining_reserve_cents: 447500,
      platform_fee_cents: 50000
    },
    balances: [
      { id: "token_supply", label: "MRG supply", role: "token_supply", amount_cents: 500000, entry_count: 10 },
      { id: "treasury", label: "Treasury", role: "treasury", amount_cents: 50000, entry_count: 4 }
    ],
    recent_entries: [
      {
        sequence: 40,
        type: "ledger_manual_credit",
        amount_cents: 25,
        entry_hash: "a".repeat(64),
        status: "verified",
        actor: "github:demo",
        reference: "pr:https://github.com/example/repo/pull/1"
      }
    ]
  };
}

function mockProof() {
  return {
    protocol_version: "mergeos.ledger-proof.v1",
    token_symbol: "MRG",
    valid: true,
    entry_count: 40,
    verified_count: 40,
    broken_count: 0,
    root_hash: "b".repeat(64),
    public_root_hash: "c".repeat(64),
    contract_reference: "c".repeat(64),
    entries: [
      {
        sequence: 1,
        type: "payment_verified",
        entry_hash: "d".repeat(64),
        previous_hash: "0".repeat(64),
        status: "verified",
        amount_cents: 100000
      },
      {
        sequence: 40,
        type: "ledger_manual_credit",
        entry_hash: "a".repeat(64),
        previous_hash: "e".repeat(64),
        status: "verified",
        amount_cents: 25
      }
    ]
  };
}

function mockMarket() {
  return {
    protocol_version: "mergeos.marketplace.v1",
    stats: {
      project_count: 2,
      open_task_count: 3,
      accepted_task_count: 1,
      total_budget_cents: 500000,
      work_pool_cents: 450000,
      token_symbol: "MRG"
    },
    projects: [
      {
        id: "prj_0428",
        title: "MRGMinner",
        status: "funded",
        budget_cents: 500000,
        bounty_repo_name: "mergeos-bounties/MRGMinner"
      }
    ],
    bounties: [
      {
        id: "prj_0428:1",
        title: "Docs screenshots",
        project_id: "prj_0428",
        status: "open",
        reward_mrg: 25,
        required_worker_kind: "agent",
        suggested_agent_type: "coding-agent"
      },
      {
        id: "prj_0428:2",
        title: "CLI status command",
        project_id: "prj_0428",
        status: "open",
        reward_mrg: 50,
        required_worker_kind: "agent",
        suggested_agent_type: "coding-agent"
      }
    ],
    contributors: [],
    agents: []
  };
}

function mockChainDiscovery() {
  return buildChainDiscovery({
    economy: mockEconomy(),
    proof: mockProof(),
    market: mockMarket(),
    fleet: mockFleetPayload()
  });
}

module.exports = {
  SCAN_BASE,
  SHOP_BASE,
  sha256Hex,
  mrgFromCents,
  formatMrg,
  scanAddressUrl,
  scanTxUrl,
  summarizeTokenEconomy,
  summarizeLedgerProof,
  normalizeLedgerEntry,
  discoverMarketplace,
  splitWork,
  buildClaimIntent,
  buildChainDiscovery,
  mockEconomy,
  mockProof,
  mockMarket,
  mockChainDiscovery
};
