"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  summarizeTokenEconomy,
  summarizeLedgerProof,
  discoverMarketplace,
  splitWork,
  buildClaimIntent,
  mockChainDiscovery,
  mockEconomy,
  mockMarket,
  mockProof,
  mockSolanaManifest,
  parseRewardFromTitle,
  resolveRewardMrg,
  verifyHashChain,
  summarizeSolana,
  ledgerReferenceBytes32
} = require("../src/chain");
const { mockFleetPayload } = require("../src/nodes");
const { agentActionPayload } = require("../src/api");

test("token economy summary exposes MRG totals", () => {
  const token = summarizeTokenEconomy(mockEconomy());
  assert.equal(token.token_symbol, "MRG");
  assert.ok(token.totals.minted_cents > 0);
  assert.ok(token.explore.scan.includes("scan.mergeos.shop"));
});

test("ledger proof summary has hash chain tip and local verify", () => {
  const ledger = summarizeLedgerProof(mockProof());
  assert.equal(ledger.integrity.hash_chain_complete, true);
  assert.ok(ledger.root_hash.length >= 32);
  assert.ok(ledger.tip.entry_hash);
  assert.equal(ledger.integrity.local_verify.valid, true);
  assert.equal(ledger.integrity.local_verify.broken_count, 0);
});

test("parseRewardFromTitle extracts bracket MRG", () => {
  assert.equal(parseRewardFromTitle("Fix #1: [25 MRG] Docs screenshots"), 25);
  assert.equal(parseRewardFromTitle("Fix #3: [50 MRG] VS Code panel"), 50);
  assert.equal(parseRewardFromTitle("no reward here"), null);
});

test("resolveRewardMrg prefers title over ranking reward_cents", () => {
  const mrg = resolveRewardMrg({
    title: "Fix #1: [25 MRG] Docs screenshots",
    reward_cents: 40302,
    reward_mrg: 403.02
  });
  assert.equal(mrg, 25);
});

test("marketplace discovery lists open bounties with correct title MRG", () => {
  const market = discoverMarketplace(mockMarket());
  assert.ok(market.open_bounties.length >= 1);
  assert.equal(market.open_bounties[0].reward_mrg, 25);
  assert.equal(market.open_bounties[0].reward_source, "title");
  assert.equal(market.open_bounties[1].reward_mrg, 50);
  assert.ok(market.funded_projects.length >= 1);
  assert.equal(market.stats.discoverable_open_mrg, 75);
});

test("marketplace discovery exposes in-progress projects", () => {
  const market = discoverMarketplace({
    projects: [
      { id: "prj_active", title: "Active", status: "in_progress", budget_cents: 1000, open_task_count: 2 }
    ],
    bounties: []
  });

  assert.equal(market.active_projects.length, 1);
  assert.equal(market.active_projects[0].id, "prj_active");
});

test("work split packs bind claim-block and ledger tip", () => {
  const market = discoverMarketplace(mockMarket());
  const fleet = mockFleetPayload();
  const proof = summarizeLedgerProof(mockProof());
  const split = splitWork({
    bounties: market.open_bounties,
    fleet,
    proof,
    maxPacks: 5
  });
  assert.ok(split.pack_count >= 1);
  assert.equal(split.claim_block.ready, true);
  assert.ok(split.packs[0].pack_hash.length === 64);
  assert.equal(split.packs[0].mrg_bound, true);
  assert.equal(split.packs[0].status, "ready_to_claim");
  assert.ok(split.packs[0].assignment.job);
  assert.ok(split.packs[0].assignment.review);
  assert.ok(split.packs[0].assignment.audit);
  assert.ok(split.packs[0].ledger_reference);
  assert.equal(split.total_reward_mrg, 75);
});

test("claim intent binds task to ledger tip hash and pack", () => {
  const fleet = mockFleetPayload();
  const proof = summarizeLedgerProof(mockProof());
  const market = discoverMarketplace(mockMarket());
  const split = splitWork({ bounties: market.open_bounties, fleet, proof, maxPacks: 1 });
  const solana = summarizeSolana(mockSolanaManifest());
  const intent = buildClaimIntent({
    task: { id: "prj_0428:1", title: "Fix #1: [25 MRG] Demo", reward_cents: 40302 },
    fleet,
    proof,
    workerId: "github:demo",
    pack: split.packs[0],
    solana
  });
  assert.equal(intent.ready, true);
  assert.equal(intent.mrg_eligible, true);
  assert.equal(intent.reward_mrg, 25);
  assert.match(intent.intent_id, /^intent_/);
  assert.ok(intent.intent_hash.length === 64);
  assert.ok(intent.ledger_tip_hash);
  assert.ok(intent.pack_hash);
  assert.ok(intent.claim_metadata.intent_hash);
  assert.ok(intent.solana.program_id);
  assert.match(intent.commands.claim, /mrgminner claim/);
});

test("verifyHashChain detects broken previous_hash links", () => {
  const good = verifyHashChain(mockProof().entries);
  assert.equal(good.valid, true);
  const bad = verifyHashChain([
    { sequence: 1, entry_hash: "aa".repeat(32), previous_hash: "0".repeat(64) },
    { sequence: 2, entry_hash: "bb".repeat(32), previous_hash: "cc".repeat(32) }
  ]);
  assert.equal(bad.valid, false);
  assert.equal(bad.broken_count, 1);
});

test("ledgerReferenceBytes32 accepts 64-hex hashes", () => {
  const h = "ab".repeat(32);
  assert.equal(ledgerReferenceBytes32(h), h);
  assert.equal(ledgerReferenceBytes32({ entry_hash: h }), h);
  assert.equal(ledgerReferenceBytes32("nope"), null);
});

test("solana summary exposes program and release path", () => {
  const solana = summarizeSolana(mockSolanaManifest());
  assert.equal(solana.program, "mergeos_mrg");
  assert.ok(solana.program_id.length > 20);
  assert.ok(solana.instruction_map.some((r) => r.instruction === "releasePayout"));
});

test("agent action payload embeds chain binding evidence", () => {
  const body = agentActionPayload({
    action: "generate",
    claim_id: "prj_0428:1",
    agent_type: "mrgminner",
    evidence: ["notes"],
    chain_binding: {
      intent_id: "intent_abc",
      intent_hash: "ff".repeat(32),
      pack_hash: "ee".repeat(32),
      ledger_tip_hash: "dd".repeat(32),
      reward_mrg: 25
    }
  });
  assert.ok(body.chain_binding);
  assert.equal(body.chain_binding.reward_mrg, 25);
  assert.ok(body.evidence.some((line) => String(line).includes("intent_hash=")));
});

test("mock chain discovery bundle is complete v2", () => {
  const d = mockChainDiscovery();
  assert.equal(d.kind, "chain_discovery");
  assert.match(d.protocol_version, /mrgminner\.chain/);
  assert.ok(d.token.totals.minted_cents > 0);
  assert.ok(d.ledger.entry_count > 0);
  assert.ok(d.marketplace.open_bounties.length > 0);
  assert.equal(d.marketplace.open_bounties[0].reward_mrg, 25);
  assert.ok(d.work_split.pack_count > 0);
  assert.ok(d.fleet.claim_block_ready);
  assert.ok(d.solana.program_id);
});
