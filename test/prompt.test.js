"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTaskPrompt } = require("../src/prompt");
const { welcomeAITask } = require("../src/welcome-task");

test("buildTaskPrompt includes MergeOS task and commit workflow", () => {
  const prompt = buildTaskPrompt({
    id: "tsk_123",
    title: "Fix checkout ledger",
    acceptance: "Ledger proof must be visible.",
    reward_cents: 25000,
    required_worker_kind: "agent",
    suggested_agent_type: "codex",
    issue_url: "https://github.com/example/repo/issues/12"
  }, { workspaceRoot: "C:/work/repo" });

  assert.match(prompt, /tsk_123/);
  assert.match(prompt, /Fix checkout ledger/);
  assert.match(prompt, /Ledger proof must be visible/);
  assert.match(prompt, /MRGMinner tsk_123:/);
  assert.match(prompt, /mrgminner claim --with-intent/);
  assert.match(prompt, /mrgminner submit --pr-url/);
  assert.doesNotMatch(prompt, /claim the payout/);
});

test("buildTaskPrompt uses local workflow for the welcome AI task", () => {
  const prompt = buildTaskPrompt(welcomeAITask(), { workspaceRoot: "C:/work/repo" });

  assert.match(prompt, /local-only test task/);
  assert.match(prompt, /Do not claim, submit, release payout, or create a git commit/);
  assert.doesNotMatch(prompt, /MRGMinner local:welcome-ai:/);
});
