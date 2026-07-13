"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { redactToken } = require("../src/settings");

test("redactToken masks all but the last four characters", () => {
  assert.equal(redactToken("supersecrettoken1234"), "****1234");
});

test("redactToken strips a Bearer prefix before masking", () => {
  assert.equal(redactToken("Bearer supersecrettoken1234"), "****1234");
});

test("redactToken reports missing tokens without leaking length", () => {
  assert.equal(redactToken(""), "(not set)");
  assert.equal(redactToken(undefined), "(not set)");
  assert.equal(redactToken(null), "(not set)");
});

test("redactToken never returns the raw token", () => {
  const raw = "mergeide-live-token-9f8e7d6c5b4a";
  const redacted = redactToken(raw);
  assert.notEqual(redacted, raw);
  assert.doesNotMatch(redacted, /9f8e7d6c5b4a/);
  assert.match(redacted, /^\*{4}/);
});

test("redactToken fully masks short tokens", () => {
  assert.equal(redactToken("abcd"), "****");
  assert.equal(redactToken("ab"), "****");
});
