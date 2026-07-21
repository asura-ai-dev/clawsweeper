import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeApplyObservabilityEvent,
  summarizeApplyObservability,
} from "../dashboard/apply-observability.ts";

const NOW = Date.parse("2026-07-21T12:00:00Z");

function event(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    repo: "openclaw/openclaw",
    run_id: "12345",
    run_attempt: 1,
    occurred_at: "2026-07-21T11:55:00Z",
    started_at: "2026-07-21T11:40:00Z",
    outcome: "success",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/12345",
    queue: {
      active: 1,
      capacity: 1,
      ready: 12,
      backoff: null,
      dispatching: 0,
      leased: null,
      oldest_ready_age_seconds: 900,
      oldest_backoff_age_seconds: null,
      oldest_lease_age_seconds: null,
    },
    arrivals: 5,
    results: { applied: 8, closed: 3, superseded: 1, retried: 2, dead_lettered: 0 },
    lease: { wait_ms: null, hold_ms: null },
    observed_failure_kinds: [
      "action_ledger_failure",
      "state_publication_failure",
      "safe_close_blocked",
      "workflow_failure",
    ],
    failures: [],
    ...overrides,
  };
}

test("apply observability preserves unknown values instead of making them healthy zeros", () => {
  const normalized = normalizeApplyObservabilityEvent(event({ arrivals: null }), NOW);
  assert.ok(normalized);
  const summary = summarizeApplyObservability({
    events: [normalized],
    range: "24h",
    repo: null,
    now: NOW,
  });
  assert.equal(summary.last_15_minutes.arrivals, null);
  assert.equal(summary.queue.leased, null);
  assert.equal(summary.lease.wait_ms, null);
  assert.equal(summary.failures.state_lease_timeout, null);
  const zero = normalizeApplyObservabilityEvent(
    event({
      run_id: "12349",
      arrivals: 0,
      results: { applied: 0, closed: 0, superseded: 0, retried: 0, dead_lettered: 0 },
    }),
    NOW,
  )!;
  const mixed = summarizeApplyObservability({
    events: [normalized, zero],
    range: "24h",
    repo: null,
    now: NOW,
  });
  assert.equal(mixed.totals.arrivals, null);
});

test("apply observability reports disjoint result and failure accounting in selected windows", () => {
  const first = normalizeApplyObservabilityEvent(event(), NOW)!;
  const second = normalizeApplyObservabilityEvent(
    event({
      run_id: "12346",
      occurred_at: "2026-07-21T11:20:00Z",
      started_at: "2026-07-21T11:00:00Z",
      results: { applied: 2, closed: 1, superseded: 0, retried: 1, dead_lettered: 1 },
      observed_failure_kinds: ["state_lease_contention"],
      failures: [{ kind: "state_lease_contention", at: "2026-07-21T11:20:00Z" }],
    }),
    NOW,
  )!;
  const summary = summarizeApplyObservability({
    events: [first, second],
    range: "24h",
    repo: null,
    now: NOW,
  });
  assert.equal(summary.last_60_minutes.applied, 10);
  assert.equal(summary.last_60_minutes.closed, 4);
  assert.equal(summary.totals.superseded, 1);
  assert.equal(summary.totals.dead_lettered, 1);
  assert.equal(summary.failures.state_lease_contention, 1);
  assert.equal(summary.retry_amplification, 0.3);
});

test("apply observability rejects malformed producer payloads", () => {
  assert.equal(normalizeApplyObservabilityEvent(event({ repo: "not-a-repo" }), NOW), null);
  assert.equal(
    normalizeApplyObservabilityEvent(
      event({ failures: [{ kind: "secret", at: "2026-07-21T11:55:00Z" }] }),
      NOW,
    ),
    null,
  );
});

test("all-repository queue health stays unknown until every configured target reports", () => {
  const first = normalizeApplyObservabilityEvent(event(), NOW)!;
  const missing = summarizeApplyObservability({
    events: [first],
    range: "24h",
    repo: null,
    repositories: ["openclaw/openclaw", "openclaw/other"],
    now: NOW,
  });
  assert.equal(missing.telemetry_complete, false);
  assert.equal(missing.queue.ready, null);

  const second = normalizeApplyObservabilityEvent(
    event({
      repo: "openclaw/other",
      run_id: "12347",
      queue: {
        active: 2,
        capacity: 3,
        ready: 4,
        backoff: 1,
        dispatching: 1,
        leased: 0,
        oldest_ready_age_seconds: 1_200,
        oldest_backoff_age_seconds: 300,
        oldest_lease_age_seconds: 0,
      },
    }),
    NOW,
  )!;
  const excluded = normalizeApplyObservabilityEvent(
    event({
      repo: "openclaw/excluded",
      run_id: "12348",
      arrivals: 99,
      results: { applied: 99, closed: 99, superseded: 0, retried: 0, dead_lettered: 0 },
    }),
    NOW,
  )!;
  const complete = summarizeApplyObservability({
    events: [first, second, excluded],
    range: "24h",
    repo: null,
    repositories: ["openclaw/openclaw", "openclaw/other"],
    now: NOW,
  });
  assert.equal(complete.telemetry_complete, true);
  assert.equal(complete.queue.active, 3);
  assert.equal(complete.queue.ready, 16);
  assert.equal(complete.queue.oldest_ready_age_seconds, 1_200);
  assert.equal(complete.lease.wait_ms, null);
  assert.equal(complete.last_60_minutes.applied, 16);
});
