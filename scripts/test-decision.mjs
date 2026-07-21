// Unit tests for the alert decision state machine (pure logic, no AWS).
// Run: node scripts/test-decision.mjs
import assert from "node:assert";
import { applyDecision } from "../src/handlers/alerts.js";

const NOW = "2026-06-23T00:00:00.000Z";
const op1 = { id: "op1", role: "operator" };
const op2 = { id: "op2", role: "operator" };
const admin = { id: "adm", role: "site_admin" };
const sup = { id: "sup", role: "superuser" };

// Decision bodies (contract: { status, decision_label, note? }).
const escalate = (label) => ({ status: "submitted_for_review", decision_label: label });
const resolve = (label, note) => ({ status: "incident", decision_label: label, note }); // status ignored in review

const mk = (over = {}) => ({
  id: "a1", site_id: "s1", camera_id: "c", alert_type: "t",
  status: "unprocessed", proposer_id: null, proposer_label: null,
  proposed_at: null, conflicted: false, decided_by: null, decided_at: null,
  resolved_by: null, review_by: null, review_label: null, review_note: null,
  resolved_at: null, decision_label: null, created_at: NOW, ...over,
});

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const denies = (alert, user, body, code) => {
  try { applyDecision(alert, user, body, NOW); }
  catch (e) { assert.equal(e.statusCode, code, `expected ${code}, got ${e.statusCode}`); return; }
  assert.fail("expected a throw");
};

console.log("unprocessed:");
ok("operator escalate proposing genuine -> submitted_for_review, decided_by=proposer", () => {
  const a = mk();
  const action = applyDecision(a, op1, escalate("genuine"), NOW);
  assert.equal(action, "submitted_for_review");
  assert.equal(a.status, "submitted_for_review");
  assert.equal(a.proposer_id, "op1");
  assert.equal(a.proposer_label, "genuine");
  assert.equal(a.decided_by, "op1");        // decided_by stays the proposer
  assert.equal(a.conflicted, false);
});
ok("operator escalate proposing false_alarm", () => {
  const a = mk();
  applyDecision(a, op1, escalate("false_alarm"), NOW);
  assert.equal(a.proposer_label, "false_alarm");
});
ok("operator direct resolve -> 403 (escalate-only)", () =>
  denies(mk(), op1, resolve("false_alarm"), 403));
ok("admin direct resolve false_alarm -> discarded", () => {
  const a = mk();
  applyDecision(a, admin, { status: "discarded", decision_label: "false_alarm" }, NOW);
  assert.equal(a.status, "discarded");
  assert.equal(a.resolved_by, "adm");
  assert.equal(a.review_label, "false_alarm");
  assert.equal(a.decided_by, "adm");
});
ok("admin direct resolve genuine -> incident", () => {
  const a = mk();
  applyDecision(a, sup, { status: "incident", decision_label: "genuine" }, NOW);
  assert.equal(a.status, "incident");
});

console.log("submitted_for_review (proposer=op1, label=false_alarm):");
const review = () => mk({ status: "submitted_for_review", proposer_id: "op1", proposer_label: "false_alarm", decided_by: "op1" });
ok("2nd operator AGREES (false_alarm) -> discarded (2-op), decided_by stays proposer", () => {
  const a = review();
  applyDecision(a, op2, resolve("false_alarm"), NOW);
  assert.equal(a.status, "discarded");
  assert.equal(a.resolved_by, "op2");
  assert.equal(a.decided_by, "op1");
});
ok("2nd operator DIFFERENT label that derives the SAME status (false_positive) -> conflicted", () => {
  // false_alarm and false_positive both -> discarded, but labels differ => conflict.
  const a = review();
  const action = applyDecision(a, op2, resolve("false_positive", "looks staged"), NOW);
  assert.equal(action, "conflicted");
  assert.equal(a.conflicted, true);
  assert.equal(a.status, "submitted_for_review");
  assert.equal(a.review_note, "looks staged");
});
ok("2nd operator DISAGREES (genuine) -> conflicted", () => {
  const a = review();
  applyDecision(a, op2, resolve("genuine"), NOW);
  assert.equal(a.conflicted, true);
  assert.equal(a.status, "submitted_for_review");
});
ok("proposer cannot resolve own escalation -> 403", () =>
  denies(review(), op1, resolve("false_alarm"), 403));
ok("single admin resolves review (overrules to genuine) -> incident, decided_by stays proposer", () => {
  const a = review();
  applyDecision(a, admin, resolve("genuine"), NOW);
  assert.equal(a.status, "incident");
  assert.equal(a.resolved_by, "adm");
  assert.equal(a.decided_by, "op1");
});

console.log("submitted_for_review (proposer=op1, label=genuine):");
ok("2nd operator agrees genuine -> incident (2 ops can confirm an incident)", () => {
  const a = mk({ status: "submitted_for_review", proposer_id: "op1", proposer_label: "genuine", decided_by: "op1" });
  applyDecision(a, op2, resolve("genuine"), NOW);
  assert.equal(a.status, "incident");
});

console.log("conflicted review:");
const conflicted = () => mk({ status: "submitted_for_review", proposer_id: "op1", proposer_label: "false_alarm", conflicted: true, decided_by: "op1" });
ok("operator (non-proposer) cannot resolve conflicted -> 403", () =>
  denies(conflicted(), op2, resolve("genuine"), 403));
ok("operator (proposer) cannot act on conflicted -> 403", () =>
  denies(conflicted(), op1, resolve("false_alarm"), 403));
ok("admin resolves conflicted (false_positive) -> discarded", () => {
  const a = conflicted();
  applyDecision(a, admin, resolve("false_positive"), NOW);
  assert.equal(a.status, "discarded");
  assert.equal(a.review_label, "false_positive");
  assert.equal(a.decided_by, "op1");
});

console.log("guards:");
ok("deciding an already-resolved (incident) alert -> 409", () =>
  denies(mk({ status: "incident" }), admin, resolve("genuine"), 409));
ok("deciding an already-discarded alert -> 409", () =>
  denies(mk({ status: "discarded" }), admin, resolve("false_alarm"), 409));
ok("operator cannot act on resolved alert -> 403 (not visible)", () =>
  denies(mk({ status: "incident" }), op2, resolve("genuine"), 403));

console.log(`\n✓ all ${pass} decision-machine checks passed`);
