# Warren run notifications

## Recommendation

Use signed outbound webhooks from Warren to a small `kota-sense` Warren
adapter. The adapter turns terminal events into KOTA inbox items. This keeps
Warren independent of KOTA's storage model, avoids polling, and leaves KOTA
free to fetch full run details only when a user or agent needs them.

SSE remains useful for interactive dashboards, but it is a poor primary
notification channel: a disconnected consumer needs replay and cursor
management, while a webhook can be retried and dead-lettered at the boundary.
Direct writes to KOTA memory are the tightest coupling and are not recommended.

## Event contract

The first implementation slice should emit one event when a run reaches a
terminal state:

```json
{
  "event": "warren.run.terminal",
  "occurred_at": "2026-08-02T00:00:00.000Z",
  "run_id": "run_…",
  "project_id": "prj_…",
  "seed_id": "warren-…",
  "plot_id": "pl…",
  "state": "succeeded",
  "pr_url": "https://github.com/…/pull/123",
  "cost_usd": 0.42,
  "duration_ms": 123456,
  "failure_reason": null,
  "ui_url": "https://warren.example/runs/run_…"
}
```

`project_id`, `seed_id`, `plot_id`, `pr_url`, `cost_usd`, `duration_ms`,
`failure_reason`, and `ui_url` are nullable when unavailable. The initial
state set is `succeeded`, `failed`, `cancelled`, and `timed_out`; `paused`
should be a later opt-in event because it is not terminal. Preview-ready and
PR-opened events should be added only after terminal delivery is reliable.

## Configuration and security

Store a global list of notification endpoints in Warren configuration, with
an optional per-project or per-run opt-in override. Each endpoint has a URL,
an enabled flag, and a secret that is never returned by read APIs. Sign the
canonical UTF-8 request body with HMAC-SHA256 and send the signature, event
id, and timestamp in headers. The adapter rejects stale timestamps and
replayed event ids.

The payload must be deliberately small and contain identifiers, not prompt
or source contents. Warren should redact secrets before serialization and
never include rendered agent prompts.

## Delivery semantics

Persist an immutable event id and an attempt record before the first POST.
Retry transient DNS, connection, and 5xx failures with bounded exponential
backoff. Treat 2xx as delivered, 4xx as a non-retryable configuration error,
and exhaustions as dead-letter records visible in Warren diagnostics. Delivery
must be idempotent: the adapter deduplicates by event id, and Warren never
creates a second event for the same run/state transition.

The implementation should expose a small delivery seam so tests can inject a
transport and clock. It should not block run finalization on an unavailable
endpoint; enqueue delivery work after the terminal transition and surface
delivery health separately.

## Follow-up implementation slices

1. Add the event/attempt persistence seam and terminal transition emitter.
2. Add signed endpoint configuration, retry/dead-letter worker, and
   diagnostics.
3. Add the `kota-sense` adapter and an end-to-end acceptance scenario using a
   local receiver.

The first follow-up seed tracks slices 1–2. The adapter remains a separate
cross-repository seed because it belongs to KOTA, not Warren.
