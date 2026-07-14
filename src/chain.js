"use strict";

/**
 * Blockchain-facing layer for MRGMinner:
 * - Discover token economy + marketplace bounties (correct MRG rewards)
 * - Explore + locally verify ledger / hash-chain proof
 * - Split work across job/review/audit nodes (claim-block packs)
 * - Bind claims to ledger tip + Solana proof anchors for discoverable MRG
 */

const crypto = require("node:crypto");
const { formClaimBlock, buildFleetReport, mockFleetPayload, ROLE_JOB, ROLE_REVIEW, ROLE_AUDIT } = require("./nodes");

const SCAN_BASE = "https://scan.mergeos.shop";
const SHOP_BASE = "https://mergeos.shop";
const SOLANA_MANIFEST_URL = `${SHOP_BASE}/contracts/solana/mergeos_mrg.proof-manifest.v1.json`;
const SOLANA_IDL_URL = `${SHOP_BASE}/contracts/solana/mergeos_mrg.v1.idl.json`;

/** Localnet / scaffold program id from mergeos-contracts (replace on mainnet deploy). */
const DEFAULT_SOLANA_PROGRAM_ID = "4gUBWum3fGKfm7BeGXryzXjPDBDLfhVJRcjN5MPnfDNW";

const TITLE_MRG_RE =
  /\[(\d+(?:\.\d+)?)\s*MRG\]|\((\d+(?:\.\d+)?)\s*MRG\)|(?:^|[\s|:/-])(\d+(?:\.\d+)?)\s*MRG(?:\b|$)/i;

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

/**
 * Convert ledger amount fields to whole MRG when possible.
 * MergeOS often stores whole MRG in amount_cents-like fields (25 MRG → 25).
 */
function mrgFromCents(cents) {
  const n = Number(cents || 0);
  if (!Number.isFinite(n) || n === 0) {
    return 0;
  }
  if (Math.abs(n) >= 1000 && n % 100 === 0) {
    return n / 100;
  }
  return n;
}

/** Parse declared bounty reward from titles like "Fix #1: [25 MRG] Docs…". */
function parseRewardFromTitle(title) {
  const m = String(title || "").match(TITLE_MRG_RE);
  if (!m) {
    return null;
  }
  const raw = m[1] || m[2] || m[3];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve discoverable MRG reward for a marketplace/task row.
 * Title bracket wins — public marketplace reward_cents is often a ranking score, not the bounty.
 */
function resolveRewardMrg(item = {}) {
  const fromTitle = parseRewardFromTitle(item.title || item.name || item.summary || "");
  if (fromTitle != null) {
    return fromTitle;
  }
  if (item.reward_mrg != null && item.reward_mrg !== "") {
    const v = Number(item.reward_mrg);
    if (Number.isFinite(v) && v > 0) {
      // Prefer clean integer tiers; reject scoring-like floats when > typical max
      if (Number.isInteger(v) && v <= 10000) {
        return v;
      }
      if (v <= 500 && Number.isInteger(Math.round(v))) {
        return Math.round(v);
      }
    }
  }
  const cents = item.reward_cents ?? item.amount_cents ?? item.budget_cents ?? item.bid_cents;
  if (cents != null && cents !== "") {
    const n = Number(cents);
    // Known bounty tiers stored as whole MRG
    if (Number.isFinite(n) && [25, 50, 100, 150, 200, 250, 500, 1000].includes(n)) {
      return n;
    }
    return mrgFromCents(n);
  }
  return 0;
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

function ledgerReferenceBytes32(entryOrHash = {}) {
  const hex = String(
    (typeof entryOrHash === "string" ? entryOrHash : null) ||
      entryOrHash.entry_hash ||
      entryOrHash.public_hash ||
      entryOrHash.contract_reference ||
      entryOrHash.root_hash ||
      ""
  )
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return null;
  }
  return hex;
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
      token_event_count: stats.token_event_count || 0,
      updated_at: stats.updated_at || null
    },
    totals: {
      verified_funding_cents: totals.verified_funding_cents || 0,
      minted_cents: totals.minted_cents || 0,
      project_reserve_cents: totals.project_reserve_cents || 0,
      task_reserve_cents: totals.task_reserve_cents || 0,
      released_cents: totals.released_cents || 0,
      remaining_reserve_cents: totals.remaining_reserve_cents || 0,
      platform_fee_cents: totals.platform_fee_cents || 0,
      treasury_balance_cents: totals.treasury_balance_cents || 0,
      manual_credit_cents: totals.manual_credit_cents || 0
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
  const amount = entry.amount_cents || entry.amount || 0;
  return {
    sequence: seq,
    type: entry.type || entry.kind || "",
    amount_cents: amount,
    amount_mrg: mrgFromCents(amount),
    reference: entry.reference || "",
    actor,
    status: entry.status || "",
    entry_hash: hash,
    public_hash: entry.public_hash || "",
    previous_hash: entry.previous_hash || entry.prev_hash || "",
    public_previous_hash: entry.public_previous_hash || "",
    valid: entry.valid !== undefined ? Boolean(entry.valid) : null,
    created_at: entry.created_at || entry.time || "",
    project_id: entry.project_id || "",
    ledger_reference: ledgerReferenceBytes32(entry),
    scan_tx: hash ? scanTxUrl(hash) : null,
    scan_address: actor ? scanAddressUrl(actor) : null
  };
}

/**
 * Client-side walk of previous_hash links (does not re-hash payloads —
 * verifies the published chain pointer integrity from the proof API).
 */
function verifyHashChain(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(normalizeLedgerEntry)
    .filter((e) => e.entry_hash && String(e.entry_hash).length >= 16);
  const sorted = normalized.slice().sort((a, b) => {
    const sa = Number(a.sequence);
    const sb = Number(b.sequence);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) {
      return sa - sb;
    }
    return 0;
  });

  const broken = [];
  let prevHash = null;
  let checkedLinks = 0;
  for (const entry of sorted) {
    if (prevHash) {
      checkedLinks += 1;
      const expected = String(prevHash).toLowerCase();
      const actual = String(entry.previous_hash || "").toLowerCase();
      if (!actual) {
        broken.push({
          sequence: entry.sequence,
          entry_hash: entry.entry_hash,
          expected_previous: expected,
          actual_previous: "",
          type: entry.type,
          reason: "missing_previous_hash"
        });
      } else if (actual !== expected) {
        broken.push({
          sequence: entry.sequence,
          entry_hash: entry.entry_hash,
          expected_previous: expected,
          actual_previous: actual,
          type: entry.type,
          reason: "previous_hash_mismatch"
        });
      }
    }
    prevHash = entry.entry_hash;
  }

  const tip = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    protocol_version: "mrgminner.hash-verify.v1",
    entry_count: sorted.length,
    links_checked: checkedLinks,
    broken_count: broken.length,
    valid: sorted.length > 0 && broken.length === 0,
    tip_hash: tip ? tip.entry_hash : null,
    tip_sequence: tip ? tip.sequence : null,
    broken: broken.slice(0, 25),
    sample_path: sorted.slice(0, 3).map((e) => ({
      sequence: e.sequence,
      entry_hash: e.entry_hash,
      previous_hash: e.previous_hash
    }))
  };
}

/** Summarize ledger proof chain for explorers. */
function summarizeLedgerProof(proof = {}) {
  const entries = Array.isArray(proof.entries) ? proof.entries.map(normalizeLedgerEntry) : [];
  const tip = entries.length ? entries[entries.length - 1] : null;
  const local = verifyHashChain(proof.entries || entries);
  const serverValid = proof.valid;
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
    ledger_reference: ledgerReferenceBytes32(proof.public_root_hash || proof.root_hash || tip || {}),
    tip,
    sample_entries: entries.slice(0, 12),
    integrity: {
      hash_chain_complete: Boolean(proof.root_hash && String(proof.root_hash).length >= 32),
      server_valid: serverValid === undefined ? null : Boolean(serverValid),
      local_verify: local,
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
  const projectFilter = options.projectId || options.project || "";

  const openBounties = bounties
    .filter((b) => {
      const st = String(b.status || b.task_status || "open").toLowerCase();
      if (st && st !== "open" && st !== "funded" && st !== "available") {
        return false;
      }
      if (projectFilter) {
        return String(b.project_id || "") === String(projectFilter);
      }
      return true;
    })
    .slice(0, limit)
    .map((b) => {
      const reward = resolveRewardMrg(b);
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
        reward_raw_cents: b.reward_cents != null ? Number(b.reward_cents) : null,
        reward_source: parseRewardFromTitle(b.title) != null ? "title" : "api",
        repo: b.repo_url || b.source_repository || b.source_repo_url || b.bounty_repo_name || "",
        issue_url: b.issue_url || "",
        claim_endpoint: b.claim_endpoint || (claimId ? `/api/tasks/${claimId}/claim` : ""),
        proposal_endpoint: b.proposal_endpoint || "",
        can_claim: b.proposal_packet ? Boolean(b.proposal_packet.can_claim) : true,
        scan: SCAN_BASE
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
      work_pool_cents: p.work_pool_cents || 0,
      repo: p.repo_url || p.bounty_repo_name || p.source_repo_url || "",
      open_tasks: p.open_task_count || p.task_count || null
    }));

  const activeProjects = projects
    .filter((p) => {
      const st = String(p.status || "").toLowerCase().replace(/[\s-]+/g, "_");
      return ["in_progress", "active", "running", "claimed", "assigned"].includes(st);
    })
    .slice(0, limit)
    .map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      budget_cents: p.budget_cents || 0,
      budget_mrg: mrgFromCents(p.budget_cents || 0),
      work_pool_cents: p.work_pool_cents || 0,
      repo: p.repo_url || p.bounty_repo_name || p.source_repo_url || "",
      open_tasks: p.open_task_count || p.task_count || null
    }));

  const totalOpenMrg = openBounties.reduce((sum, b) => sum + (b.reward_mrg || 0), 0);

  return {
    protocol_version: market.protocol_version || "mergeos.marketplace.v1",
    token_symbol: stats.token_symbol || "MRG",
    stats: {
      project_count: stats.project_count || projects.length,
      open_task_count: stats.open_task_count || openBounties.length,
      accepted_task_count: stats.accepted_task_count || 0,
      total_budget_cents: stats.total_budget_cents || 0,
      work_pool_cents: stats.work_pool_cents || 0,
      ledger_entry_count: stats.ledger_entry_count || 0,
      discoverable_open_mrg: totalOpenMrg,
      listed_bounty_count: openBounties.length
    },
    open_bounties: openBounties,
    funded_projects: fundedProjects,
    active_projects: activeProjects,
    contributor_count: contributors.length,
    agent_count: agents.length,
    explore: {
      marketplace: `${SHOP_BASE}/api/public/marketplace`,
      live_feed: `${SHOP_BASE}/api/public/live-feed`,
      scan: SCAN_BASE
    }
  };
}

function poolByRole(nodes, role) {
  return (nodes || []).filter((n) => n.role === role && n.online);
}

function pickRotating(pool, index) {
  if (!pool || !pool.length) {
    return null;
  }
  return pool[index % pool.length];
}

/**
 * Split open bounties across claim-block roles (job / review / audit).
 * Rotates online nodes so packs are load-balanced; each pack binds ledger tip.
 */
function splitWork({
  bounties = [],
  fleet = null,
  proof = null,
  maxPacks = 10
} = {}) {
  const report = fleet || mockFleetPayload();
  const block = report.claim_block || formClaimBlock(report.nodes || [], []);
  const nodes = report.nodes || [];
  const jobPool = poolByRole(nodes, ROLE_JOB);
  const reviewPool = poolByRole(nodes, ROLE_REVIEW);
  const auditPool = poolByRole(nodes, ROLE_AUDIT);

  const tipHash =
    (proof && (proof.public_root_hash || proof.root_hash || (proof.tip && proof.tip.entry_hash))) ||
    (block.ledger_tip && block.ledger_tip.entry_hash) ||
    "";
  const tipRef = ledgerReferenceBytes32(tipHash || proof || {});

  const packs = [];
  const list = bounties.slice(0, Math.max(1, Math.min(maxPacks, 50)));
  for (let i = 0; i < list.length; i += 1) {
    const bounty = list[i];
    const job = pickRotating(jobPool, i) || (block.members && block.members.job);
    const review = pickRotating(reviewPool, i) || (block.members && block.members.review);
    const audit = pickRotating(auditPool, i) || (block.members && block.members.audit);
    const material = [
      bounty.id,
      bounty.project_id || "",
      block.block_id || "",
      tipHash,
      bounty.reward_mrg || 0,
      job && job.id,
      review && review.id,
      audit && audit.id
    ].join("|");
    const packHash = sha256Hex(material);
    const rolesReady = Boolean(job && review && audit && tipHash);
    packs.push({
      pack_id: `pack_${packHash.slice(0, 12)}`,
      pack_hash: packHash,
      task_id: bounty.id,
      title: bounty.title,
      project_id: bounty.project_id || "",
      reward_mrg: bounty.reward_mrg || 0,
      worker_kind: bounty.worker_kind || "agent",
      assignment: {
        job: job ? job.id : null,
        review: review ? review.id : null,
        audit: audit ? audit.id : null
      },
      assignment_detail: {
        job: job ? { id: job.id, type: job.type, status: job.status } : null,
        review: review ? { id: review.id, type: review.type, status: review.status } : null,
        audit: audit ? { id: audit.id, type: audit.type, status: audit.status } : null
      },
      claim_block_id: block.block_id,
      ledger_tip_hash: tipHash || null,
      ledger_reference: tipRef,
      mrg_bound: Boolean(tipHash && block.ready && rolesReady),
      status: tipHash && block.ready && rolesReady ? "ready_to_claim" : "waiting_block",
      steps: [
        { role: "job", action: "claim+implement", command: `mrgminner claim ${bounty.id} --with-intent` },
        { role: "job", action: "run", command: `mrgminner run ${bounty.id}` },
        { role: "review", action: "review evidence", command: "agent-actions review" },
        { role: "audit", action: "verify ledger hash", command: "mrgminner verify" },
        {
          role: "job",
          action: "submit",
          command: `mrgminner submit ${bounty.id} --pr-url <url> --with-intent`
        }
      ],
      explore: {
        scan: SCAN_BASE,
        tip_tx: tipHash ? scanTxUrl(tipHash) : null
      }
    });
  }

  return {
    protocol_version: "mrgminner.work-split.v2",
    kind: "work_split",
    claim_block: {
      block_id: block.block_id,
      ready: block.ready,
      mrg_eligible: block.mrg_eligible,
      members: block.members
    },
    node_pools: {
      job: jobPool.length,
      review: reviewPool.length,
      audit: auditPool.length
    },
    ledger_tip_hash: tipHash || null,
    ledger_reference: tipRef,
    total_reward_mrg: packs.reduce((s, p) => s + (p.reward_mrg || 0), 0),
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
  prUrl = "",
  pack = null,
  solana = null
} = {}) {
  const report = fleet || mockFleetPayload();
  const block = report.claim_block;
  const tipHash =
    (proof && (proof.public_root_hash || proof.root_hash || (proof.tip && proof.tip.entry_hash))) ||
    (block && block.ledger_tip && block.ledger_tip.entry_hash) ||
    "";
  const taskId = task.claim_id || task.id || task.task_id || "";
  const reward = resolveRewardMrg(task);
  const packHash = pack && pack.pack_hash ? pack.pack_hash : "";
  const intentMaterial = [
    taskId,
    workerId,
    block && block.block_id,
    tipHash,
    packHash,
    prUrl,
    reward
  ].join("|");
  const intentHash = sha256Hex(intentMaterial);
  const ready = Boolean(block && block.ready && tipHash && taskId);
  const ledgerRef = ledgerReferenceBytes32(tipHash || proof || {});

  return {
    protocol_version: "mrgminner.claim-intent.v2",
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
    pack_id: pack && pack.pack_id ? pack.pack_id : null,
    pack_hash: packHash || null,
    ledger_tip_hash: tipHash || null,
    ledger_reference: ledgerRef,
    solana: solana
      ? {
          program_id: solana.program_id,
          target_chain: solana.target_chain || "solana",
          release_instruction: "releasePayout",
          proof_argument: "ledgerReference",
          ledger_reference: ledgerRef
        }
      : null,
    hash_binding: {
      block_hash: block && block.block_hash,
      tip_hash: tipHash || null,
      pack_hash: packHash || null,
      intent_hash: intentHash,
      complete: ready
    },
    members: block ? block.members : null,
    claim_metadata: {
      // Attached to agent-actions / local evidence — API claim body stays minimal
      mrgminner_protocol: "mrgminner.claim-intent.v2",
      intent_id: `intent_${intentHash.slice(0, 16)}`,
      intent_hash: intentHash,
      pack_hash: packHash || undefined,
      claim_block_id: block && block.block_id,
      ledger_tip_hash: tipHash || undefined,
      ledger_reference: ledgerRef || undefined,
      reward_mrg: reward,
      worker_id: workerId || undefined
    },
    commands: {
      claim: taskId ? `mrgminner claim ${taskId} --with-intent` : null,
      run: taskId ? `mrgminner run ${taskId}` : null,
      submit: taskId
        ? `mrgminner submit ${taskId} --pr-url ${prUrl || "<url>"} --with-intent`
        : null,
      verify: "mrgminner verify",
      explore: tipHash ? scanTxUrl(tipHash) : SCAN_BASE
    },
    notice:
      "Payout release requires owner/admin accept on MergeOS (and optional Solana releasePayout). This intent only binds claim work to ledger proof.",
    formed_at: new Date().toISOString()
  };
}

/** Solana / on-chain proof surface from public manifest or scaffold defaults. */
function summarizeSolana(manifest = null) {
  const m = manifest || mockSolanaManifest();
  const instructions = Array.isArray(m.instruction_map)
    ? m.instruction_map.map((row) => ({
        ledger_types: row.ledger_types || [],
        instruction: row.instruction,
        anchor_method: row.anchor_method,
        proof_argument: row.proof_argument,
        public_sources: row.public_sources || []
      }))
    : [];
  return {
    protocol_version: m.protocol_version || "mergeos.solana-contract-proof.v1",
    kind: "solana_binding",
    program: m.program || "mergeos_mrg",
    program_id: m.program_id || DEFAULT_SOLANA_PROGRAM_ID,
    target_chain: m.target_chain || "solana",
    token_symbol: m.token_symbol || "MRG",
    status: m.program_id ? "manifest" : "scaffold",
    idl_url: m.idl_url || SOLANA_IDL_URL,
    public_manifest_url: m.public_manifest_url || SOLANA_MANIFEST_URL,
    ledger_reference_format:
      m.ledger_reference_format || "bytes32:hex_decode(entry_hash|public_hash|contract_reference)",
    instruction_map: instructions,
    claim_path: {
      discover: "mrgminner market | chain",
      split: "mrgminner split",
      intent: "mrgminner intent <task>",
      claim: "mrgminner claim <task> --with-intent",
      verify: "mrgminner verify",
      payout: "owner/admin accept → optional Solana releasePayout(ledgerReference)"
    },
    explore: {
      scan: SCAN_BASE,
      manifest: m.public_manifest_url || SOLANA_MANIFEST_URL,
      contracts_repo: "https://github.com/mergeos-bounties/mergeos-contracts"
    }
  };
}

function mockSolanaManifest() {
  return {
    protocol_version: "mergeos.solana-contract-proof.v1",
    kind: "solana_contract_proof_manifest",
    program: "mergeos_mrg",
    program_id: DEFAULT_SOLANA_PROGRAM_ID,
    target_chain: "solana",
    token_symbol: "MRG",
    idl_url: SOLANA_IDL_URL,
    public_manifest_url: SOLANA_MANIFEST_URL,
    ledger_reference_format: "bytes32:hex_decode(entry_hash|public_hash|contract_reference)",
    instruction_map: [
      {
        ledger_types: ["token_mint", "payment_verified"],
        instruction: "mintVerifiedMrg",
        anchor_method: "mint_verified_mrg",
        proof_argument: "ledgerReference"
      },
      {
        ledger_types: ["project_reserve", "task_reserve"],
        instruction: "openEscrow",
        anchor_method: "open_escrow",
        proof_argument: "ledgerReference"
      },
      {
        ledger_types: ["task_payment"],
        instruction: "releasePayout",
        anchor_method: "release_payout",
        proof_argument: "ledgerReference"
      }
    ]
  };
}

/** Full chain discovery bundle for explorers / agents. */
function buildChainDiscovery({
  economy = {},
  proof = {},
  market = {},
  fleet = null,
  solanaManifest = null,
  options = {}
} = {}) {
  const token = summarizeTokenEconomy(economy);
  const ledger = summarizeLedgerProof(proof);
  const marketplace = discoverMarketplace(market, options);
  const report = fleet || mockFleetPayload();
  const solana = summarizeSolana(solanaManifest);
  const split = splitWork({
    bounties: marketplace.open_bounties,
    fleet: report,
    proof: ledger,
    maxPacks: options.maxPacks || 10
  });

  return {
    protocol_version: "mrgminner.chain.v2",
    kind: "chain_discovery",
    token,
    ledger,
    marketplace,
    solana,
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
      marketplace: marketplace.explore.marketplace,
      solana_manifest: solana.public_manifest_url
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
      platform_fee_cents: 50000,
      treasury_balance_cents: 50000
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
  const h1 = "d".repeat(64);
  const h2 = "a".repeat(64);
  return {
    protocol_version: "mergeos.ledger-proof.v1",
    token_symbol: "MRG",
    valid: true,
    entry_count: 40,
    verified_count: 40,
    broken_count: 0,
    root_hash: h2,
    public_root_hash: "c".repeat(64),
    contract_reference: "c".repeat(64),
    entries: [
      {
        sequence: 1,
        type: "payment_verified",
        entry_hash: h1,
        previous_hash: "0".repeat(64),
        status: "verified",
        amount_cents: 100000
      },
      {
        sequence: 40,
        type: "ledger_manual_credit",
        entry_hash: h2,
        previous_hash: h1,
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
        title: "Fix #1: [25 MRG] Docs screenshots",
        project_id: "prj_0428",
        status: "open",
        reward_cents: 40302,
        required_worker_kind: "agent",
        suggested_agent_type: "coding-agent"
      },
      {
        id: "prj_0428:2",
        title: "Fix #2: [50 MRG] CLI status command",
        project_id: "prj_0428",
        status: "open",
        reward_cents: 99999,
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
    fleet: mockFleetPayload(),
    solanaManifest: mockSolanaManifest()
  });
}

module.exports = {
  SCAN_BASE,
  SHOP_BASE,
  SOLANA_MANIFEST_URL,
  SOLANA_IDL_URL,
  DEFAULT_SOLANA_PROGRAM_ID,
  sha256Hex,
  mrgFromCents,
  parseRewardFromTitle,
  resolveRewardMrg,
  formatMrg,
  scanAddressUrl,
  scanTxUrl,
  ledgerReferenceBytes32,
  summarizeTokenEconomy,
  summarizeLedgerProof,
  normalizeLedgerEntry,
  verifyHashChain,
  discoverMarketplace,
  splitWork,
  buildClaimIntent,
  summarizeSolana,
  buildChainDiscovery,
  mockEconomy,
  mockProof,
  mockMarket,
  mockSolanaManifest,
  mockChainDiscovery
};
