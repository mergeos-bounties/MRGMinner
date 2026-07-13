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
  mockProof
} = require("../src/chain");
const { mockFleetPayload } = require("../src/nodes");

test("token economy summary exposes MRG totals", () => {
  const token = summarizeTokenEconomy(mockEconomy());
  assert.equal(token.token_symbol, "MRG");
  assert.ok(token.totals.minted_cents > 0);
  assert.ok(token.explore.scan.includes("scan.mergeos.shop"));
});

test("ledger proof summary has hash chain tip", () => {
  const ledger = summarizeLedgerProof(mockProof());
  assert.equal(ledger.integrity.hash_chain_complete, true);
  assert.ok(ledger.root_hash.length >= 32);
  assert.ok(ledger.tip.entry_hash);
});

test("marketplace discovery lists open bounties with MRG", () => {
  const market = discoverMarketplace(mockMarket());
  assert.ok(market.open_bounties.length >= 1);
  assert.ok(market.open_bounties[0].reward_mrg > 0);
  assert.ok(market.funded_projects.length >= 1);
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
});

test("claim intent binds task to ledger tip hash", () => {
  const fleet = mockFleetPayload();
  const proof = summarizeLedgerProof(mockProof());
  const intent = buildClaimIntent({
    task: { id: "prj_0428:1", title: "Demo", reward_mrg: 25 },
    fleet,
    proof,
    workerId: "github:demo"
  });
  assert.equal(intent.ready, true);
  assert.equal(intent.mrg_eligible, true);
  assert.match(intent.intent_id, /^intent_/);
  assert.ok(intent.intent_hash.length === 64);
  assert.ok(intent.ledger_tip_hash);
  assert.match(intent.commands.claim, /mrgminner claim/);
});

test("mock chain discovery bundle is complete", () => {
  const d = mockChainDiscovery();
  assert.equal(d.kind, "chain_discovery");
  assert.ok(d.token.totals.minted_cents > 0);
  assert.ok(d.ledger.entry_count > 0);
  assert.ok(d.marketplace.open_bounties.length > 0);
  assert.ok(d.work_split.pack_count > 0);
  assert.ok(d.fleet.claim_block_ready);
});
