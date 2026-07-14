"use strict";

function buildTaskPrompt(task, options = {}) {
  const tokenSymbol = options.tokenSymbol || "MRG";
  const taskID = value(task.id);
  const title = value(task.title, "Untitled task");
  const acceptance = value(task.acceptance, "No acceptance criteria supplied.");
  const issueURL = value(task.issue_url || task.issueURL, "");
  const reward = Number(task.reward_cents || 0) / 100;
  const workerKind = value(task.required_worker_kind, "agent");
  const suggestedAgent = value(task.suggested_agent_type, options.agentType || "mergeide");
  const workspaceRoot = value(options.workspaceRoot, "the current repository");
  const sandboxLines = sandboxInstructions(options.sandbox);
  const localTest = Boolean(task.local_test);
  const workflow = task.local_test ? [
    "## Required Workflow",
    "1. Inspect the workspace briefly.",
    "2. Complete only the local acceptance criteria above.",
    "3. Do not claim, submit, release payout, or create a git commit for this local test.",
    "4. Leave the requested result file in the workspace so MRGMinner IDE can validate it."
  ] : [
    "## Required Workflow",
    "1. Inspect the repository before editing.",
    "2. Keep changes scoped to this task.",
    "3. Run the most relevant tests or verification commands available in the repo.",
    `4. Commit the finished work with a message that starts with \"MRGMinner ${taskID}:\".`,
    "5. Submit pull request or evidence URL back to MergeOS for customer/admin review.",
    "6. Do not release payout yourself; payout is released only after review.",
    "",
    "Use mrgminner market / chain to discover MRG work, mrgminner claim --with-intent to bind ledger tip, then mrgminner submit --pr-url <url> --with-intent for review evidence."
  ];

  return [
    "# MRGMinner Task",
    "",
    "You are running inside MRGMinner, a Visual Studio Code style workspace connected to MergeOS.",
    `Workspace: ${workspaceRoot}`,
    "",
    localTest
      ? "Complete this local validation task only; do not claim, submit, or commit it."
      : "Complete the MergeOS task below, verify your work, and create one git commit that can be submitted for review.",
    "",
    "## Task",
    `- ID: ${taskID}`,
    `- Title: ${title}`,
    `- Reward: ${reward.toFixed(2)} ${tokenSymbol}`,
    `- Required worker kind: ${workerKind}`,
    `- Suggested agent: ${suggestedAgent}`,
    issueURL ? `- Issue URL: ${issueURL}` : "- Issue URL: not provided",
    "",
    ...sandboxLines,
    ...(sandboxLines.length ? [""] : []),
    "## Acceptance",
    acceptance,
    "",
    ...workflow
  ].join("\n");
}

function sandboxInstructions(sandbox) {
  if (!sandbox || sandbox.type !== "docker") {
    return [];
  }
  return [
    "## Runtime Boundary",
    "The AI CLI is running on the host machine, not inside Docker.",
    `The task runtime is Docker. The host workspace is mounted into the container at ${value(sandbox.mount, "/workspace")}.`,
    `Default sandbox image: ${value(sandbox.image, "node:22-bookworm-slim")}.`,
    "Edit files in the host workspace. Run verification/task commands inside the Docker sandbox when possible."
  ];
}

function value(input, fallback = "") {
  const text = input === undefined || input === null ? "" : String(input).trim();
  return text || fallback;
}

module.exports = {
  buildTaskPrompt
};
