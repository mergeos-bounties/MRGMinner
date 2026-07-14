"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const WELCOME_AI_TASK_ID = "local:welcome-ai";
const WELCOME_AI_PROJECT_ID = "local-tests";
const WELCOME_AI_RESULT_PATH = ".mergeide/welcome-ai-result.json";

function welcomeAITask() {
  return {
    id: WELCOME_AI_TASK_ID,
    title: "Welcome AI runtime test",
    status: "open",
    required_worker_kind: "agent",
    suggested_agent_type: "codex",
    reward_cents: 0,
    project_id: WELCOME_AI_PROJECT_ID,
    project_title: "Local test tasks",
    source: "local",
    local_test: true,
    acceptance: [
      "This is a local-only test task for validating the host AI CLI and Docker-mounted workspace.",
      "",
      `Create or update ${WELCOME_AI_RESULT_PATH} with valid JSON:`,
      "{",
      `  \"task_id\": \"${WELCOME_AI_TASK_ID}\",`,
      "  \"status\": \"pass\",",
      "  \"message\": \"short note about what you verified\"",
      "}",
      "",
      "Do not claim, submit, or release payout. This task passes only when the IDE validator can read that JSON file from the workspace."
    ].join("\n")
  };
}

function isWelcomeAITaskID(value) {
  return String(value || "").trim() === WELCOME_AI_TASK_ID;
}

async function validateWelcomeAIResult(workspaceRoot) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const resultPath = path.join(root, WELCOME_AI_RESULT_PATH);
  const checks = [];
  let payload = null;
  let raw = "";

  try {
    raw = await fs.readFile(resultPath, "utf8");
    checks.push(pass("result_file", `Found ${WELCOME_AI_RESULT_PATH}`));
  } catch (error) {
    checks.push(fail("result_file", `Missing ${WELCOME_AI_RESULT_PATH}`));
    return validationResult(root, resultPath, checks, payload);
  }

  try {
    payload = JSON.parse(raw);
    checks.push(pass("valid_json", "Result file is valid JSON"));
  } catch (error) {
    checks.push(fail("valid_json", `Invalid JSON: ${error.message}`));
    return validationResult(root, resultPath, checks, payload);
  }

  checks.push(payload && payload.task_id === WELCOME_AI_TASK_ID
    ? pass("task_id", `task_id is ${WELCOME_AI_TASK_ID}`)
    : fail("task_id", `task_id must be ${WELCOME_AI_TASK_ID}`));
  checks.push(payload && payload.status === "pass"
    ? pass("status", "status is pass")
    : fail("status", "status must be pass"));
  checks.push(payload && typeof payload.message === "string" && payload.message.trim()
    ? pass("message", "message is present")
    : fail("message", "message must be a non-empty string"));

  return validationResult(root, resultPath, checks, payload);
}

function validationResult(root, resultPath, checks, payload) {
  return {
    passed: checks.every((check) => check.passed),
    result_path: resultPath,
    relative_path: (path.relative(root, resultPath) || WELCOME_AI_RESULT_PATH).replace(/\\/g, "/"),
    checks,
    payload
  };
}

function pass(name, message) {
  return { name, passed: true, message };
}

function fail(name, message) {
  return { name, passed: false, message };
}

module.exports = {
  WELCOME_AI_PROJECT_ID,
  WELCOME_AI_RESULT_PATH,
  WELCOME_AI_TASK_ID,
  isWelcomeAITaskID,
  validateWelcomeAIResult,
  welcomeAITask
};
