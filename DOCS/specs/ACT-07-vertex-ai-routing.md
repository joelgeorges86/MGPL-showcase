# ACT-07 — Vertex AI Routing Qualification

## Status

- **State:** Open specification; execution not authorized
- **Work unit:** ACT-07
- **Owner:** Principal Operator approval required before execution
- **Proposed execution lane:** Cline / VS Code configuration with explicit human supervision
- **Risk class:** External cloud service, model routing, credentials, and billing
- **Current decision:** Do not execute from this specification PR

## Objective

Qualify Google Cloud Vertex AI as an approved Cline model-routing path before
the promotional credit expires, while proving that the first request is
non-sensitive, attributable to the intended Google Cloud project, and charged
against promotional credit rather than a payment card.

## Authorization boundary

Writing or approving this specification does **not** authorize:

- Google Cloud resource provisioning or project changes.
- Installation of the Google Cloud CLI.
- Browser-based OAuth consent or application-default credential creation.
- IAM role grants, service-account creation, key creation, or scope changes.
- Cline provider or model-routing changes.
- Any Vertex AI request or other billable model invocation.
- Billing-console changes, payment-method changes, or quota changes.
- Enabling cloud or infrastructure MCP servers.

Execution requires separate Principal Operator approval under v3.3 §22.1 and a
recorded decision on the open items below. Browser consent is Principal
Operator-only. Cloud MCP servers remain disabled during the first inference
test.

## In scope after separate approval

1. Install and verify the Google Cloud CLI using the official distribution and
   a version recorded in the execution evidence.
2. Establish Google application-default credentials through the approved
   browser-consent flow. The Principal Operator performs and observes the
   consent step; no agent handles or records the resulting credential value.
3. Configure the Cline Vertex AI provider with the approved project, region,
   and model. Record names and non-secret configuration metadata only.
4. Run exactly one minimal, non-sensitive inference test with a deterministic
   prompt that contains no user data, credentials, private library data,
   internal identifiers, or proprietary source content.
5. Verify in the Google Cloud billing console that the request is attributed to
   the approved project, draws on promotional credit, and produces no payment
   card charge.
6. Capture sanitized evidence of the CLI version, provider configuration
   metadata, inference result status, billing attribution, and rollback state.

## Non-sensitive inference test

The first request must use a fixed smoke-test prompt such as:

> Return exactly `MGPL-VERTEX-SMOKE-OK` and nothing else.

The prompt must not include user identity, emails, passwords, JWTs, API keys,
session cookies, internal database identifiers, private library records, or
unpublished source material. The response must be treated as a verification
signal only and must not be persisted as application data.

## Required verification

The execution record must demonstrate all of the following:

- `gcloud` is installed and reports the expected version.
- Application-default credentials were established by the Principal Operator
  through browser consent without exposing credential values.
- Cline is configured for Vertex AI with the approved project, region, and
  model names.
- Cloud MCP servers were disabled throughout the first inference test.
- Exactly one minimal inference request was made.
- The request returned the expected smoke-test result or a sanitized failure.
- The billing console shows promotional-credit attribution and no card charge.
- No secret values, access tokens, credential files, or sensitive prompt data
  were committed, logged, or added to the repository.
- The configuration can be disabled or reverted without changing MGPL runtime
  code or production infrastructure.

## Open decisions — Principal Operator

These decisions must be resolved before execution:

1. **Google Cloud project:** Which project is authorized for the test?
2. **IAM scope:** Which minimum roles or permissions are approved for CLI
   authentication, Vertex AI inference, and billing verification?
3. **Billing attribution:** Which billing account and promotional-credit grant
   should receive the request, and what evidence confirms no card charge?
4. **Region:** Which Vertex AI region is approved, considering availability,
   latency, data handling, and pricing?
5. **Model:** Which exact model and version are approved for the smoke test?
6. **Credit ceiling:** What maximum request count and spend ceiling are
   authorized if the first request is retried or fails?
7. **Credential lifecycle:** How and when will application-default credentials
   be revoked or removed after qualification?
8. **Cline configuration ownership:** Which local Cline profile may be changed,
   and what is the rollback configuration if Vertex AI is not approved?

## Security and privacy constraints

- Never read, print, commit, or transmit secret values.
- Do not send MGPL user data, private library data, authentication material,
  internal IDs, or proprietary source content to the model.
- Use least-privilege IAM and an approved project only.
- Do not create service-account keys unless separately approved; prefer the
  approved application-default credential flow.
- Do not add a runtime dependency or application integration in ACT-07.
- Do not add a new external domain to an application allowlist.
- Keep cloud and infrastructure MCP servers disabled during the first test.
- Do not persist prompts, responses, credentials, or billing artifacts in the
  MGPL database.

## Rollback and stop conditions

Stop immediately and request Principal Operator review if:

- The project, billing account, region, model, or IAM scope is ambiguous.
- Browser consent requests an unexpected account, permission, or payment action.
- A credential value, token, or sensitive prompt would be exposed.
- The billing console shows a card charge or unexpected paid usage.
- The model response is not deterministic or the request count is unclear.
- Vertex AI, Cline, or a cloud MCP server requires broader access than approved.

Rollback consists of disabling the Vertex provider selection, restoring the
previous Cline provider configuration, revoking/removing the approved local
credential state, and recording the sanitized outcome. No production rollback
or application deployment is part of ACT-07.

## Deliverables after approval

- Sanitized execution record with command outcomes and timestamps.
- Exact `gcloud` and model metadata, excluding secrets.
- Evidence of one non-sensitive inference request.
- Billing-console verification showing promotional-credit use and no card
  charge.
- Updated Tool Register entry for the qualified provider/configuration.
- Principal Operator decision on whether Vertex AI remains enabled or is
  disabled after the smoke test.

## Exclusions

- No MGPL runtime integration.
- No application code or database changes.
- No production deployment.
- No cloud resource provisioning.
- No billing or payment-method changes.
- No cloud MCP enablement.
- No batch inference, embeddings, grounding, fine-tuning, or application data
  transfer.
