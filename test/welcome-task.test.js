"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  WELCOME_AI_RESULT_PATH,
  WELCOME_AI_TASK_ID,
  validateWelcomeAIResult,
  welcomeAITask
} = require("../src/welcome-task");

test("welcomeAITask describes a local host AI runtime validation task", () => {
  const task = welcomeAITask();

  assert.equal(task.id, WELCOME_AI_TASK_ID);
  assert.match(task.title, /runtime/);
  assert.equal(task.local_test, true);
  assert.match(task.acceptance, /welcome-ai-result\.json/);
  assert.match(task.acceptance, /"status": "pass"/);
});

test("validateWelcomeAIResult fails before the AI writes the result file", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-welcome-"));
  const result = await validateWelcomeAIResult(workspace);

  assert.equal(result.passed, false);
  assert.equal(result.checks[0].name, "result_file");
});

test("validateWelcomeAIResult passes for the expected result JSON", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-welcome-"));
  const filePath = path.join(workspace, WELCOME_AI_RESULT_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    task_id: WELCOME_AI_TASK_ID,
    status: "pass",
    message: "sandbox write verified"
  }), "utf8");

  const result = await validateWelcomeAIResult(workspace);
  assert.equal(result.passed, true);
  assert.equal(result.relative_path, WELCOME_AI_RESULT_PATH);
});
