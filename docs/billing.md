# Billing & subscription (W8.2 — skeleton)

The daemon tracks per-org subscription state and exposes the four
endpoints a billing dashboard needs. **Live Stripe Checkout sessions
and webhook signature verification ship behind the optional `stripe`
PyPI dep** — the OSS path returns deterministic placeholders so a
self-hosted control plane keeps working without merchant credentials.

## Tiers

| Tier       | Token allowance        | Audit retention | Status      |
| ---------- | ---------------------- | --------------- | ----------- |
| `free`     | 100k tokens / month    | 90 days         | default     |
| `team`     | usage-based            | 7 years         | skeleton    |
| `business` | usage + flat seat fee  | 7 years         | skeleton    |

Tier rules are surfaced in code via `billing.AUDIT_RETENTION_DAYS`
and `billing.free_tier_token_cap()`. The hosted control plane
applies them; self-hosters can ignore the tier and run on `free`
forever.

## API

```bash
# Current subscription (any role).
curl -H "Authorization: Bearer $KEY" $BASE/v1/billing/subscription
# {"org_slug": "acme", "tier": "free", "status": null,
#  "stripe_customer_id": null, "current_period_end": null}

# Period-to-date token usage (any role). Falls back to the UTC
# calendar month for free orgs.
curl -H "Authorization: Bearer $KEY" $BASE/v1/billing/usage

# Create a Stripe Checkout session (admin only). Returns a stub
# URL until live merchant keys are provisioned.
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"tier":"team","success_url":"https://app/ok","cancel_url":"https://app/no"}' \
  $BASE/v1/billing/checkout

# Stripe webhook receiver (unauthenticated; signature-verified).
# Returns 503 with a clear message when the stripe SDK is missing
# instead of crashing with a 500.
curl -X POST -H "Stripe-Signature: t=...,v1=..." \
  -d "@webhook-payload.json" \
  $BASE/v1/billing/webhook
```

## Stripe SDK gating

`billing.stripe_sdk_available()` is the single seam. When True
(`pip install 'claudestruct[hosted]'` once the extra ships), the
checkout route can construct real Stripe Checkout sessions and the
webhook verifies signatures via `stripe.Webhook.construct_event()`.

When False (the OSS path), checkout returns a deterministic stub
URL and the webhook returns **503** with a clear "Stripe SDK not
installed" message. The route still exists in OpenAPI so the
frontend can be written against the final shape today.

## Audit integration

Every billing.checkout.create call writes an audit row under the
caller's org chain:

```json
{
  "action": "billing.checkout.create",
  "resource_type": "checkout_session",
  "resource_id": "cs_test_acme_team",
  "payload": {"tier": "team"}
}
```

Successful Stripe webhook deliveries (when the SDK is wired) record
`stripe.<event_type>` rows so an external consumer can replay
billing state changes against the audit chain.

## What's pending

- Live Stripe Checkout integration (behind `claudestruct[hosted]`)
- Webhook handlers for the canonical events (`customer.subscription.created`,
  `.updated`, `.deleted`, `invoice.payment_succeeded`, `.failed`)
- Per-tier token cap enforcement at run-submit time (today the
  cumulative cap (W5.6) is the only enforcement)
- Invoice PDF passthrough (Stripe-hosted; just a redirect)
- Free-tier email verification
