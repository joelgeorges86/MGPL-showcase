# ACT-08 — Phase 0 Refresh and Probe Reconciliation

**Date:** 2026-09-24 (commands executed 21:39–21:52 UTC)
**Governed by:** the evidence contract in `DOCS/specs/ACT-08-google-cloud-capability-exploration.md`
**Scope:** read-only. No API enabled, no resource created, no billable request issued, no Phase 1 probe run.
**Supersedes:** nothing. Refreshes `DOCS/research/ACT-08-phase0-inventory.md` (2026-09-18, operator-executed, on unmerged branch `feature/act-08-phase0-recording`).

---

## 0. Execution mode (contract §3)

| Factor              | Value                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness             | Claude Code, VS Code extension                                                                                                                                                                                                                  |
| Model               | `claude-opus-5-5` (Opus 5.5, 1M context)                                                                                                                                                                                                        |
| Model billing route | Anthropic, not Vertex. No Vertex/Bedrock provider variables in the environment or settings (block 0.1). This lane does not bill to `mgpl-508415`.                                                                                               |
| Mode                | Auto mode (permission classifier active). Two actions were denied by it; see §0.3.                                                                                                                                                              |
| Terminal            | Yes — Git Bash and Windows PowerShell 5.1                                                                                                                                                                                                       |
| `gcloud`            | Google Cloud SDK 585.0.0, authenticated as the operator's user account (`roles/owner`). **Every agent-executed call below ran under the operator's owner credential**, not under ADC or `mgpl-agent`. Only list/describe/get calls were issued. |
| Console access      | **No.** Nothing in this document is read from the Cloud Console.                                                                                                                                                                                |

Every block in this document is **Agent-executed** (contract §4) unless it is marked otherwise. Blocks are copied from the saved command output by script, not retyped. The only changes are that CRLF line endings are normalised to LF, PowerShell's UTF-8 byte-order mark is removed, and Prettier strips trailing whitespace. Only the three `bq` tables had any, and a whitespace-insensitive compare confirmed no other character changed.

### 0.1 Lane billing check

```text
# executed: 2026-09-24T21:52:14Z
$ env | grep -icE '^(CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_VERTEX_PROJECT_ID|CLOUD_ML_REGION|ANTHROPIC_BASE_URL)='
0
$ grep -ciE 'vertex|bedrock|ANTHROPIC_|CLOUD_ML|apiKeyHelper' ~/.claude/settings.json C:/dev/MGPL/.claude/settings.json
/c/Users/joelg/.claude/settings.json:0
/c/dev/MGPL/.claude/settings.json:0
$ ls ~/.claude/settings.local.json C:/dev/MGPL/.claude/settings.local.json
ls: cannot access '/c/Users/joelg/.claude/settings.local.json': No such file or directory
ls: cannot access '/c/dev/MGPL/.claude/settings.local.json': No such file or directory
```

### 0.2 TLS interception and the workaround used

On this machine, Norton Antivirus intercepts TLS. Node already trusts Norton's root through `NODE_EXTRA_CA_CERTS=C:\ProgramData\Norton\Antivirus\wscert.pem`. `gcloud`'s bundled Python does not trust it, so the first call failed:

```text
# executed: 2026-09-24T21:39:29Z
$ gcloud projects describe mgpl-508415
ERROR: (gcloud.projects.describe) There was a problem refreshing your current auth tokens: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1082)')))
Please run:

  $ gcloud auth login

to obtain new credentials.

If you have already logged in with a different account, run:

  $ gcloud config set account ACCOUNT

to select an already authenticated account to use.
# exit: 1
```

For each later call, `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` was set to the same Norton certificate as a per-process environment variable. **No `gcloud` configuration property was changed.** Anyone reproducing these results on this machine needs the same override.

### 0.3 Actions denied in this session (effective-capability boundaries, §2.3)

1. **Disabling `gcloud` prompts** (`CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false`, `CLOUDSDK_CORE_DISABLE_PROMPTS=1`) was denied as a safety bypass. As a result, **no command was sent to an API that is not enabled.** Without that guard, `gcloud` might offer to enable the API. That rules out budgets (`billingbudgets`), org policy (`orgpolicy`) and Cloud Quotas (`cloudquotas`) from this harness.
2. **Listing service-account keys** (`gcloud iam service-accounts keys list`) was denied as credential exploration. It was not pursued by any other route.

Everything that depends on either action is marked UNVERIFIED below, with the access it needs.

---

## 1. Identifier cross-check (contract §5)

| Identifier            | Value                                                    | Source                    | Cross-check                                                                                                                                                      |
| --------------------- | -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project number        | `327364075881`                                           | block 1.1                 | Matches the 2026-09-18 inventory and the cache resource name in RETEST-EVIDENCE P2 (`projects/327364075881/...`). The fabricated `330443048383` does not appear. |
| Billing account       | `01F946-FEE88E-6171D8`                                   | blocks 1.2, 1.3           | Same ID appears in the billing-export dataset name (block 3.6)                                                                                                   |
| Operator identity     | `joelgeorges@gmail.com`                                  | block 3.2 (`roles/owner`) | —                                                                                                                                                                |
| Probe service account | `mgpl-agent@mgpl-508415.iam.gserviceaccount.com`         | blocks 3.2, 3.3           | Matches the 2026-09-18 inventory §4 and the Phase 1 results header                                                                                               |
| Default compute SA    | `327364075881-compute@developer.gserviceaccount.com`     | blocks 3.2, 3.3, 3.5      | Uses the verified project number                                                                                                                                 |
| Organization / parent | **none** — `projects describe` returns no `parent` field | block 1.1                 | —                                                                                                                                                                |

### 1.1 Project

```text
# executed: 2026-09-24T21:41:04Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud projects describe mgpl-508415
createTime: '2026-09-12T15:39:41.625Z'
lifecycleState: ACTIVE
name: MGPL
projectId: mgpl-508415
projectNumber: '327364075881'
# exit: 0
```

### 1.2 Billing linkage

```text
# executed: 2026-09-24T21:41:24Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud billing projects describe mgpl-508415
billingAccountName: billingAccounts/01F946-FEE88E-6171D8
billingEnabled: true
name: projects/mgpl-508415/billingInfo
projectId: mgpl-508415
# exit: 0
```

### 1.3 Billing accounts visible to the operator credential

```text
# executed: 2026-09-24T21:41:26Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud billing accounts list
ACCOUNT_ID            NAME                OPEN  MASTER_ACCOUNT_ID
01F946-FEE88E-6171D8  My Billing Account  True
# exit: 0
```

---

## 2. Task 1 — Precondition: payment guardrail

> **Addendum, later on 2026-09-24.** The Principal Operator decided to proceed on a procedural ceiling with the card retained. That decision is recorded as the "Resolution — 2026-09-24" in the spec's Precondition section. The body of this section is left as written at 21:52 UTC.

| Item                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment method attached?                     | **UNVERIFIED — not obtainable from this harness.** The Cloud Billing API and `gcloud billing` do not expose payment instruments. Block 1.2 shows only that billing is enabled and linked. Needs: the Principal Operator reading Console → Billing → Payment method.                                                                                                                                            |
| Credit balance and expiry, all three entries | **UNVERIFIED — not obtainable from this harness.** No CLI or API surface returns remaining promotional credit or expiry. Needs: Console → Billing → Credits, or its CSV export (the 2026-09-18 source). The export in §3.6 has an `x_Credits` column, so credit _consumption_ per SKU could be queried. That is a BigQuery query (a billable request) and it still would not give remaining balance or expiry. |
| Budget alert still configured?               | **UNVERIFIED.** `billingbudgets.googleapis.com` is not enabled (block 3.1), and querying it is excluded by §0.3. Needs: Console → Billing → Budgets & alerts.                                                                                                                                                                                                                                                  |

**Last known values (not re-verified today, carried forward with their sources):**

- 2026-09-18 inventory §6 (operator-executed, console CSV): GCP Free Credit $299.73 of $300.00, 2026-08-06 → 2026-11-05. Two Developer Program grants of $10.00, type One-time, starting 2026-08-28 and 2026-09-11, expiring 2027.
- 2026-09-17 spec precondition (operator-verified): promotional credit $320.00, automatic payments against a card, $100 threshold, $20 budget alert.

**Discrepancy on the guardrail itself.** Both sources are recorded; neither is adjusted to fit the other.

- The spec (`DOCS/specs/ACT-08-…`, on `develop`) prefers removing the payment method and says: _"Until this closes, ACT-08 does not start."_
- `DOCS/research/WUD-PILOT-GCP-01-evidence.md` line 34 (commit `517be9e`, **only on unmerged branch `feature/act-08-phase0-recording`**) says: _"The payment method described in this record was subsequently removed and then restored by deliberate decision. Automatic payments remain configured against a card on file. … spending ceilings in ACT-08 and its successors are PROCEDURAL, not mechanical."_
- `DOCS/specs/AGENTS-md-amendment-authorized-probe-work-units.md` line 36 (on `develop`) repeats the procedural-ceiling position.

If that record is current, the precondition was **not** closed by either route the spec allows: payment method removed, or a tested billing-disable function. The operator decided instead to accept the exposure. The spec does not provide for that choice. Either the spec's precondition is amended to record it, or the precondition stays open. **That is a Principal Operator decision. Per the prompt, Task 3 proceeds as read-only, and no Phase 1 probe proceeds until the operator confirms.**

---

## 3. Task 3 — Inventory refresh

### Summary of change since 2026-09-18

| Item                                 | 2026-09-18 record (operator-executed)                                                             | 2026-09-24 (agent-executed)                                                                                                                                                                                          | Finding                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled API count                    | 48 at inventory time. Four disabled (Spanner, Datastore, Notebooks, Text-to-Speech), "leaving 44" | **47** (block 3.1)                                                                                                                                                                                                   | **Discrepancy, not reconciled.** 47 ≠ 44, and `datastore.googleapis.com` **is still enabled** although the inventory records it as disabled. Spanner, Notebooks and Text-to-Speech are absent from the current list. |
| `roles/editor` on default compute SA | Present — "the primary blast radius"                                                              | **Still present** (block 3.2)                                                                                                                                                                                        | **Unchanged. The primary blast radius stands.**                                                                                                                                                                      |
| `roles/owner` on operator            | Present                                                                                           | Present                                                                                                                                                                                                              | Unchanged                                                                                                                                                                                                            |
| `mgpl-agent` SA                      | `roles/aiplatform.user` only                                                                      | `roles/aiplatform.user` at project level (block 3.2)                                                                                                                                                                 | Unchanged at project level. SA-level policy (the operator's `serviceAccountTokenCreator`) not read; see §3.7.                                                                                                        |
| `vertex-express` SA                  | Not recorded                                                                                      | **Present**, `roles/aiplatform.expressUser` (blocks 3.2, 3.3)                                                                                                                                                        | **New, or unrecorded on 2026-09-18.** When it was created and by what is UNVERIFIED (Admin Activity audit log, not read).                                                                                            |
| Billing export to BigQuery           | Not recorded                                                                                      | **Present.** `billing-export-bigquery@system.gserviceaccount.com` has `roles/bigquery.user`; dataset holds a FOCUS export table, 1,213 rows, last modified 24 Sep 17:39:44 (blocks 3.2, 3.6)                         | **New, or unrecorded.** This is the route to per-SKU cost capture (§5).                                                                                                                                              |
| Notebooks service agent              | Present                                                                                           | Still bound (`roles/notebooks.serviceAgent`) though `notebooks.googleapis.com` is no longer enabled                                                                                                                  | Residual binding. Recorded, not actioned.                                                                                                                                                                            |
| Region                               | `us-central1` (Phase 1 results header)                                                            | **No default region set** in `gcloud` config or compute project metadata (blocks 3.4, 3.5). `us-central1` appears only as a hard-coded constant in the probe script and in the RETEST P2 cache name.                 | Region is a per-call choice, not a project setting.                                                                                                                                                                  |
| Quota ceilings (RPM, TPM)            | Not recorded                                                                                      | **UNVERIFIED**                                                                                                                                                                                                       | Needs: Console → IAM & Admin → Quotas, filtered to `aiplatform.googleapis.com`. Alternatively `cloudquotas.googleapis.com`, which is not enabled; enabling it is outside this task.                                  |
| Organization policy                  | Not recorded                                                                                      | Project has **no parent** (block 1.1), so no organization or folder policy can be inherited. Project-level policy is **UNVERIFIED**: `orgpolicy.googleapis.com` is not enabled, and querying it is excluded by §0.3. | Inference, labelled as such: with no organization, inherited constraints are absent.                                                                                                                                 |

### 3.1 Enabled APIs

```text
# executed: 2026-09-24T21:41:28Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud services list --enabled --project=mgpl-508415 --format=value(config.name) --sort-by=config.name
agentidentity.googleapis.com
agentidentitycredentials.googleapis.com
agentregistry.googleapis.com
aiplatform.googleapis.com
analyticshub.googleapis.com
apphub.googleapis.com
apptopology.googleapis.com
artifactregistry.googleapis.com
bigquery.googleapis.com
bigqueryconnection.googleapis.com
bigquerydatapolicy.googleapis.com
bigquerydatatransfer.googleapis.com
bigquerymigration.googleapis.com
bigqueryreservation.googleapis.com
bigquerystorage.googleapis.com
cloudaicompanion.googleapis.com
cloudapiregistry.googleapis.com
cloudapis.googleapis.com
cloudbuild.googleapis.com
cloudtrace.googleapis.com
compute.googleapis.com
containerregistry.googleapis.com
dataform.googleapis.com
dataplex.googleapis.com
datastore.googleapis.com
edgecache.googleapis.com
iam.googleapis.com
iamcredentials.googleapis.com
iap.googleapis.com
logging.googleapis.com
modelarmor.googleapis.com
monitoring.googleapis.com
networksecurity.googleapis.com
networkservices.googleapis.com
observability.googleapis.com
oslogin.googleapis.com
pubsub.googleapis.com
saasservicemgmt.googleapis.com
securitycenter.googleapis.com
securitycentermanagement.googleapis.com
servicemanagement.googleapis.com
serviceusage.googleapis.com
sql-component.googleapis.com
storage-api.googleapis.com
storage-component.googleapis.com
storage.googleapis.com
telemetry.googleapis.com
# exit: 0
```

Count of the block above, same session: `grep -c 'googleapis.com$'` → `47`. None of `notebooks`, `texttospeech`, `spanner`, `generativelanguage`, `cloudquotas`, `billingbudgets`, `cloudresourcemanager`, `cloudbilling` or `orgpolicy` is in the list.

### 3.2 Project IAM policy

```text
# executed: 2026-09-24T21:41:38Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud projects get-iam-policy mgpl-508415 --format=yaml
bindings:
- members:
  - serviceAccount:vertex-express@mgpl-508415.iam.gserviceaccount.com
  role: roles/aiplatform.expressUser
- members:
  - serviceAccount:service-327364075881@gcp-sa-aiplatform.iam.gserviceaccount.com
  role: roles/aiplatform.serviceAgent
- members:
  - serviceAccount:mgpl-agent@mgpl-508415.iam.gserviceaccount.com
  role: roles/aiplatform.user
- members:
  - serviceAccount:billing-export-bigquery@system.gserviceaccount.com
  role: roles/bigquery.user
- members:
  - serviceAccount:327364075881@cloudbuild.gserviceaccount.com
  role: roles/cloudbuild.builds.builder
- members:
  - serviceAccount:service-327364075881@gcp-sa-cloudbuild.iam.gserviceaccount.com
  role: roles/cloudbuild.serviceAgent
- members:
  - serviceAccount:327364075881@cloudservices.gserviceaccount.com
  role: roles/compute.instanceGroupManagerServiceAgent
- members:
  - serviceAccount:service-327364075881@compute-system.iam.gserviceaccount.com
  role: roles/compute.serviceAgent
- members:
  - serviceAccount:service-327364075881@containerregistry.iam.gserviceaccount.com
  role: roles/containerregistry.ServiceAgent
- members:
  - serviceAccount:327364075881-compute@developer.gserviceaccount.com
  role: roles/editor
- members:
  - serviceAccount:service-327364075881@gcp-sa-notebooks.iam.gserviceaccount.com
  role: roles/notebooks.serviceAgent
- members:
  - user:joelgeorges@gmail.com
  role: roles/owner
- members:
  - serviceAccount:service-327364075881@gcp-sa-pubsub.iam.gserviceaccount.com
  role: roles/pubsub.serviceAgent
etag: BwZcE3sPmnE=
version: 1
# exit: 0
```

### 3.3 Service accounts

```text
# executed: 2026-09-24T21:41:40Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud iam service-accounts list --project=mgpl-508415
DISPLAY NAME                            EMAIL                                               DISABLED
Compute Engine default service account  327364075881-compute@developer.gserviceaccount.com  False
                                        vertex-express@mgpl-508415.iam.gserviceaccount.com  False
MGPL agent - Vertex inference only      mgpl-agent@mgpl-508415.iam.gserviceaccount.com      False
# exit: 0
```

### 3.4 Local `gcloud` region configuration

```text
# executed: 2026-09-24T21:43:26Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud config list --all --format=yaml(compute,ai,billing)
ai:
  region: null
billing:
  quota_project: null
compute:
  image_family_scope: null
  region: null
  use_new_list_usable_subnets_api: null
  zone: null
# exit: 0
```

### 3.5 Compute project metadata (default region / zone)

```text
# executed: 2026-09-24T21:43:28Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> gcloud compute project-info describe --project=mgpl-508415 --format=yaml(commonInstanceMetadata.items,defaultServiceAccount)
defaultServiceAccount: 327364075881-compute@developer.gserviceaccount.com
# exit: 0
```

No `commonInstanceMetadata.items` were returned, so `google-compute-default-region` and `google-compute-default-zone` are not set.

### 3.6 Billing export (BigQuery metadata only — no query issued)

Under Git Bash, `bq` failed on its Python shim:

```text
# executed: 2026-09-24T21:43:38Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> bq ls --project_id=mgpl-508415
ERROR: (bq) python3.14: command not found
# exit: 1
```

It was re-run through `bq.cmd` in PowerShell:

```text
# executed: 2026-09-24T21:44:01Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> bq.cmd ls --project_id=mgpl-508415  (PowerShell)
                    datasetId
 -----------------------------------------------
  gcp_billing_immutable_01F946_FEE88E_6171D8_us
# exit: 0
```

```text
# executed: 2026-09-24T21:44:36Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> bq.cmd ls --max_results=50 mgpl-508415:gcp_billing_immutable_01F946_FEE88E_6171D8_us  (PowerShell)
                     tableId                      Type    Labels          Time Partitioning          Clustered Fields
 ----------------------------------------------- ------- -------- --------------------------------- ------------------
  gcp_billing_export_focus_01F946_FEE88E_6171D8   TABLE            DAY (expirationMs: 63072000000)
# exit: 0
```

```text
# executed: 2026-09-24T21:45:14Z
$ CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=<norton-wscert.pem> bq.cmd show mgpl-508415:gcp_billing_immutable_01F946_FEE88E_6171D8_us.gcp_billing_export_focus_01F946_FEE88E_6171D8  (PowerShell)
Table mgpl-508415:gcp_billing_immutable_01F946_FEE88E_6171D8_us.gcp_billing_export_focus_01F946_FEE88E_6171D8

   Last modified                        Schema                       Total Rows   Total Bytes   Expiration          Time Partitioning          Clustered Fields   Total Logical Bytes   Total Physical Bytes   Labels
 ----------------- ------------------------------------------------ ------------ ------------- ------------ --------------------------------- ------------------ --------------------- ---------------------- --------
  24 Sep 17:39:44   |- AvailabilityZone: string                      1213         978520                     DAY (expirationMs: 63072000000)                      978520                454797
                    |- BilledCost: numeric
                    |- BillingAccountId: string
                    |- BillingCurrency: string
                    |- BillingPeriodStart: timestamp
                    |- BillingPeriodEnd: timestamp
                    |- ChargeCategory: string
                    |- ChargeClass: string
                    |- ChargeDescription: string
                    |- ChargePeriodStart: timestamp
                    |- ChargePeriodEnd: timestamp
                    |- ConsumedQuantity: numeric
                    |- ConsumedUnit: string
                    |- ContractedCost: numeric
                    |- ContractedUnitPrice: numeric
                    |- ListCost: numeric
                    |- ListUnitPrice: numeric
                    |- PricingCategory: string
                    |- PricingQuantity: numeric
                    |- PricingUnit: string
                    |- ProviderName: string
                    |- PublisherName: string
                    |- RegionId: string
                    |- RegionName: string
                    |- ResourceId: string
                    |- ResourceName: string
                    |- ServiceName: string
                    |- SkuId: string
                    |- SkuPriceId: string
                    |- SubAccountId: string
                    |- SubAccountName: string
                    +- x_Credits: record (repeated)
                    |  |- Name: string
                    |  |- Amount: numeric
                    |  |- FullName: string
                    |  |- Id: string
                    |  |- Type: string
                    |- x_CostType: string
                    |- x_CurrencyConversionRate: float
                    |- x_ExportTime: timestamp
                    |- x_Location: string
                    +- x_Project: record
                    |  |- Id: string
                    |  |- Number: string
                    |  |- Name: string
                    |  |- AncestryNumbers: string
                    |  +- Ancestors: record (repeated)
                    |  |  |- ResourceName: string
                    |  |  |- DisplayName: string
                    |- x_ServiceId: string
                    +- x_SystemLabels: record (repeated)
                    |  |- Key: string
                    |  |- Value: string
                    +- x_Labels: record (repeated)
                    |  |- Key: string
                    |  |- Value: string
                    +- x_ProjectLabels: record (repeated)
                    |  |- Key: string
                    |  |- Value: string
                    +- x_Tags: record (repeated)
                    |  |- Key: string
                    |  |- Value: string
                    |  |- x_Inherited: boolean
                    |  |- x_Namespace: string
                    |- EffectiveCost: numeric
                    |- PricingCurrency: string
                    |- PricingCurrencyContractedUnitPrice: numeric
                    |- PricingCurrencyEffectiveCost: numeric
                    |- PricingCurrencyListUnitPrice: numeric
                    |- BillingAccountType: string
                    |- x_SubscriptionInstanceId: string
                    |- x_PriceEffectivePriceDefault: numeric
                    |- x_PriceListPriceConsumptionModel: numeric
                    |- x_CostAtEffectivePriceDefault: numeric
                    |- x_CostAtListConsumptionModel: numeric
                    |- x_ConsumptionModelId: string
                    |- x_ConsumptionModelDescription: string
# exit: 0
```

The `Last modified` value is printed without a zone. It is taken to be local time (UTC−4), which is an inference. The schema carries `SkuId`, `ChargePeriodStart/End`, `x_Credits` and `x_Labels`.

### 3.7 Not read — UNVERIFIED, with the access needed

| Item                                                                               | Why not                                                          | Needs                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| User-managed keys on any service account                                           | Denied as credential exploration (§0.3)                          | Operator: `gcloud iam service-accounts keys list --iam-account=<sa>` for each of the three SAs        |
| SA-level IAM on `mgpl-agent`, i.e. who can impersonate it                          | Not attempted. Same class as the denied read.                    | Operator: `gcloud iam service-accounts get-iam-policy mgpl-agent@mgpl-508415.iam.gserviceaccount.com` |
| ADC identity currently resolved on this machine                                    | Not attempted. Reading ADC configuration is credential-adjacent. | Operator                                                                                              |
| Quota ceilings                                                                     | See §3 summary                                                   | Console → Quotas                                                                                      |
| When `vertex-express` was created, when Datastore was re-enabled or never disabled | Audit-log read not in the task scope                             | Operator: Logs Explorer, Admin Activity                                                               |
| Budgets                                                                            | API not enabled, §0.3                                            | Console → Budgets & alerts                                                                            |
| Gemini CLI authentication mode                                                     | Reading `~/.gemini` configuration is credential-adjacent         | Operator                                                                                              |

---

## 4. Task 2 — Reconciliation of the two probe numbering schemes

### 4.1 Sources read

| Source                                                      | Date       | Executed by                                                                                                                                                                                                         | Numbering                                              |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `DOCS/specs/ACT-08-google-cloud-capability-exploration.md`  | 2026-09-17 | —                                                                                                                                                                                                                   | Spec P-1 to P-8, plus an "Already passed" set of three |
| `DOCS/research/ACT-08-phase1-results-and-gemini-charter.md` | 2026-09-17 | **Operator-executed** (header: "no agent ran these calls")                                                                                                                                                          | **Spec numbering**: P-1, P-2, P-4, P-5                 |
| `DOCS/research/ACT-08-RETEST-EVIDENCE.md`                   | 2026-09-22 | **UNVERIFIED.** The file carries no executor label. It was written by `scripts/probes/full-gcp-retest.mjs`, commit `463bf96`. Under the shared identity (AI-029), the commit author field does not identify a lane. | Its own P1–P8                                          |

The prompt names only the spec and RETEST. The Phase 1 results document also uses **spec numbering** and is operator-executed evidence, so it is included. Leaving it out would record finished work as unstarted.

**Provenance of RETEST-EVIDENCE.** The script refuses to run unless `AGENTS.md` contains `§3.1 Authorized probe work units` and `ACT-08 Capability Retest Authorization Ledger`. Both strings were **added to `AGENTS.md` in the same commit (`463bf96`) that added the script and its evidence.** That commit rewrote `AGENTS.md` (279 lines changed) and merged as PR #71. Commit `6a671f9`, "restore AGENTS.md destroyed by PR #71" (PR #72), removed it. Current `AGENTS.md` on `develop` contains neither string, so the script as merged would now exit with code 2. The authorization the RETEST run relied on was therefore self-inserted. Its results are not fabricated: the formatting defect below and the project-number match both point to real script output. **But they were not produced under an authorization the governance recognises.** They are used below as evidence of what the platform returned, not as authorized Phase 1 results.

**Integrity check on RETEST-EVIDENCE.** The file contains 8 vertical-tab characters. This is the `ert{}` artefact: the script's template literal contains `\vert{}`, which JavaScript reads as `\v` + `ert{}`. The defect is consistent with the file being machine-written by that script, not hand-edited. The P2 cache name contains the verified project number `327364075881`.

### 4.2 What each RETEST entry actually tested (from the script source, not the name)

| RETEST | Name                               | What the script does                                                                                                                                                              | Pass criterion in code                                  |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| P1     | Controlled Generation              | Inline hand-written `responseSchema`, one unambiguous input ("Hollow Knight" 2017), `thinkingBudget: 0`                                                                           | `parsed.title` is truthy                                |
| P2     | Context Caching at Qualified Scale | `AGENTS.md` + `README.md` + `package.json` concatenated and **repeated 6×** to exceed the caching minimum. Explicit cache created (TTL 300 s). **One** follow-up call against it. | `cachedTokens > 0` **or** a cache name exists           |
| P3     | Semantic Drift Audit               | Two synthetic one-sentence clauses written into the prompt, asked whether they contradict                                                                                         | `contradictionDetected === true`                        |
| P4     | Semantic Embeddings                | 4 one-line fixtures, 1 query, `text-embedding-005`                                                                                                                                | Top result is "Outer Wilds"                             |
| P5     | Multimodal Visual QA               | A **1×1 pixel PNG**, asked for rendering defects                                                                                                                                  | **Hard-coded `"PASS"`** — the response is not evaluated |
| P6     | Live Search Grounding              | One question with `googleSearch` tool                                                                                                                                             | Any `webSearchQueries` or `groundingChunks` returned    |
| P7     | Code Execution Sandbox             | Std. deviation of `[10,20,30,40,50]` with `codeExecution` tool                                                                                                                    | Response text contains `"14.14"` or `"15."`             |
| P8     | GCS XML API Reachability           | Unauthenticated `HEAD https://storage.googleapis.com`                                                                                                                             | Any HTTP status returned                                |

No RETEST entry recorded cost. Every row reads `UNVERIFIED (Promotional Credit)` or `N/A`, because the script writes that string as a constant.

### 4.3 Reconciliation table — one row per spec probe

| Spec probe                                            | Already covered?                                                                                                                                                                                                                                                                                                                                                  | By which evidence entry                                                                                                                                                                                                           | Cost captured?                                                                                                                                                               | Still to run                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P-1** Structured output under a _repository_ schema | **Partially.** Both sources show that `responseSchema` enforces shape. **Neither used one of MGPL's existing Zod schemas**, and neither validated the response against one, which is the thing P-1 asks for.                                                                                                                                                      | Phase 1 P-1 (operator, 4 calls, including the ambiguous-input failure and the `"null"` string finding). RETEST P1 is weaker: inline schema, one easy input, passes on any truthy title.                                           | **No.** Phase 1 has tokens per call (177 / 68 / 224 / 43), no dollar cost. RETEST has tokens (39 / 120), cost a constant string.                                             | **Yes.** Pick a real Zod schema from `src/`, derive `responseSchema` from it, validate output with Zod without post-processing, and include an ambiguous input. Record cost.                                                                                                                               |
| **P-2** Context caching at _repository_ scale         | **No.** "Qualified scale" ≠ "repository scale". RETEST P2 inflated a three-file corpus by repeating it six times, just to exceed the minimum. The spec asks for the real stable context (repo tree, rule files, schema authority) submitted **twice**, with the **cost difference** between calls measured. RETEST made one post-cache call and measured no cost. | RETEST P2 shows an explicit cache **can** be created and hit (46,562 cached tokens). Phase 1 P-2 (operator) reported both implicit and explicit caching **failing** on `src/db.ts` (~18.4k tokens; explicit cache "of 1 tokens"). | **No**, in either source. Cache creation and storage (TTL 300 s) charges also went unrecorded.                                                                               | **Yes.** **Contradiction recorded, not resolved:** explicit caching failed on 2026-09-17 (raw REST, operator) and succeeded on 2026-09-22 (`@google/genai` SDK, unattributed lane). Corpus, client and executor all differed. The P-2 run should settle it on the real corpus, with cost before and after. |
| **P-3** Batch inference (≥100 fixture records)        | **No.** RETEST "P3" is a drift audit, not batch.                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                 | No                                                                                                                                                                           | **Yes.** It needs a GCS bucket or BigQuery dataset for input and output, i.e. **resource creation** plus an IAM grant; see §5.                                                                                                                                                                             |
| **P-4** Embeddings over the game catalogue            | **Yes, functionally.** Phase 1 P-4 covers what the spec asks for: 20 fixtures, 5 queries that keyword search cannot serve, top-N assessment, and limitations named. RETEST P4 is a 4-string smoke test and adds nothing to it.                                                                                                                                    | Phase 1 P-4 (operator)                                                                                                                                                                                                            | **No.** RETEST reports tokens as `N/A`. Phase 1 gives only a session aggregate ("approximately 25,000 tokens across roughly 40 calls. Under $0.05"), not a per-probe figure. | **Cost re-run only.** The Phase 1 limitation (fixtures that state the searched attribute literally) is still open. The spec does not require it, but it is the obvious refinement if P-4 is re-run anyway.                                                                                                 |
| **P-5** Code execution sandbox                        | **Yes, functionally.** Phase 1 P-5 returned code and a result, and the result was independently verified (47.22 vs 47.2171). RETEST P7 also executed, but its raw output is truncated to 150 characters and shows no code. Its pass test (`"15."` substring) would accept many wrong answers.                                                                     | Phase 1 P-5 (operator). RETEST P7 corroborates.                                                                                                                                                                                   | **Tokens only.** Phase 1 reports 739 total, 61% of it machinery. No dollar cost in either.                                                                                   | **Cost re-run only.**                                                                                                                                                                                                                                                                                      |
| **P-6** Long-context drift audit                      | **No.** RETEST "P3" gave the model two synthetic sentences written to contradict each other. The spec asks for the **full governance document set plus rule files in one call**, scored against the findings of the three 2026-09-17 reviews.                                                                                                                     | Closest related evidence is Phase 1 P-2's large-context accuracy test: `CREATE TABLE` count 38 vs 45, a single 18k-token file. It **failed**.                                                                                     | No                                                                                                                                                                           | **Yes.** The answer key is the three 2026-09-17 reviews. **No document matching them was found on `develop` in this session**, so their location is UNVERIFIED and the operator should name it. Without an answer key the probe cannot be scored.                                                          |
| **P-7** Gemini CLI as a terminal surface              | **No.** RETEST "P7" is code execution.                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                 | No                                                                                                                                                                           | **Yes.** Local check (block 4.4): `@google/gemini-cli@0.59.0` is **already installed globally** on this machine, so "install" is done and unregistered. Its authentication mode is UNVERIFIED. Still to do: authentication route, the six §2.3 factors, and a Tool Qualification Register line.            |
| **P-8** Rate and quota under sustained load           | **No.** RETEST "P8" is an unauthenticated HEAD to the GCS endpoint. It tests network reachability, not quota. GCS is also the ACT-07 surface the spec excludes from Phase 1.                                                                                                                                                                                      | —                                                                                                                                                                                                                                 | No                                                                                                                                                                           | **Yes, with a hard request counter** (see below). The quota ceiling to compare against is UNVERIFIED (§3.7).                                                                                                                                                                                               |

### 4.4 Gemini CLI local presence

```text
# executed: 2026-09-24T21:50:48Z
$ command -v gemini; npm ls -g --depth=0 @google/gemini-cli
/c/Users/joelg/AppData/Local/Author Software/nvm/.nodejs/gemini
C:\Users\joelg\AppData\Local\Author Software\nvm\installs\v22.23.2
`-- @google/gemini-cli@0.59.0

# exit: 0
```

### 4.5 The "Already passed (2026-09-17)" set

The spec lists three probes that passed on 2026-09-17 with latency but no spend. It instructs: _"Re-run each with token and cost recorded."_ They sit **outside** spec P-1–P-8. The RETEST scheme folded them into its own numbering, which is the main reason the two lists look shifted.

| Carry-forward                    | Relation to spec P-1–P-8   | RETEST counterpart                                                                                                                                                                                                                                                                      | Re-verified?                                                                                                                   | Cost captured?                                                                      |
| -------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Inference and ADC authentication | None (precondition to all) | Implicit in RETEST P1: `GoogleGenAI({vertexai:true})` with no key, so ADC. **The ADC identity used was not recorded.** The 2026-09-18 inventory §5 has the stronger evidence: an operator-executed deliberate-failure test (Storage 403 / Vertex 200) under `mgpl-agent` impersonation. | Inference yes. ADC identity for the RETEST run UNVERIFIED.                                                                     | No                                                                                  |
| Multimodal vision                | None                       | RETEST P5                                                                                                                                                                                                                                                                               | **No.** A 1×1 PNG with a hard-coded PASS re-verifies nothing. The Phase 1 charter also lists it as "UNVERIFIED in this phase". | No                                                                                  |
| Search grounding                 | None                       | RETEST P6                                                                                                                                                                                                                                                                               | Yes: 2 queries, 1 chunk, 12 in / 36 out tokens                                                                                 | No. Grounding may carry a per-request charge separate from tokens; unverified here. |

**How the three lists relate:**

- RETEST P1, P2, P4 and P7 map to spec P-1, P-2, P-4 and P-5 respectively.
- RETEST P5 and P6 are two of the three carry-forwards.
- RETEST P3 is a weak stand-in for spec P-6.
- RETEST P8 has no spec counterpart and touches an excluded surface.
- **Spec P-3, P-7 and P-8 have no RETEST counterpart.**
- The Phase 1 results document covers spec P-1, P-2, P-4 and P-5 under the spec's own numbering.

---

## 5. What the outstanding probes need

`aiplatform.googleapis.com` is already enabled (block 3.1). `mgpl-agent` holds `roles/aiplatform.user` (block 3.2), which the 2026-09-18 inventory showed reaches Vertex (200) and not Storage (403).

| Spec probe | API needed                                                                                                                                                                                                                                                                                                | Already enabled?  | New resource or permission                                                                                                                                                                                                                                                                                                    | Cost shape                                                                                                                                               | Bounded by design?                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P-1        | `aiplatform`                                                                                                                                                                                                                                                                                              | Yes               | None                                                                                                                                                                                                                                                                                                                          | Tokens, small                                                                                                                                            | Yes                                                            |
| P-2        | `aiplatform` (`cachedContents`)                                                                                                                                                                                                                                                                           | Yes               | Creates a short-lived cache resource inside Vertex (as RETEST P2 already did)                                                                                                                                                                                                                                                 | Input tokens, then cache-creation and cache-storage (per token-hour, TTL-bound), then the discounted call. Three components, and all three must be read. | Yes, given a TTL                                               |
| P-3        | `aiplatform` (batch prediction) **plus** `storage` or `bigquery` for input and output                                                                                                                                                                                                                     | All three enabled | **Yes, and the largest footprint of any probe.** A bucket or dataset must be created, and `mgpl-agent` has no Storage access (403 on 2026-09-18). A grant to it, or to the Vertex service agent, on that resource would be needed. That is resource creation and an IAM change, both beyond this task and requiring approval. | Batch tokens plus storage                                                                                                                                | Yes, by record count                                           |
| P-4        | `aiplatform` (`text-embedding-005`)                                                                                                                                                                                                                                                                       | Yes               | None                                                                                                                                                                                                                                                                                                                          | Per-input embedding charge                                                                                                                               | Yes                                                            |
| P-5        | `aiplatform` (`codeExecution` tool)                                                                                                                                                                                                                                                                       | Yes               | None                                                                                                                                                                                                                                                                                                                          | Tokens, with ~61% overhead observed                                                                                                                      | Yes                                                            |
| P-6        | `aiplatform`                                                                                                                                                                                                                                                                                              | Yes               | None                                                                                                                                                                                                                                                                                                                          | **Large input tokens.** The whole governance corpus in one call. Cost scales with corpus size and should be estimated from a `countTokens` call first.   | Yes, by corpus size                                            |
| P-7        | Depends on the CLI's auth route: `aiplatform` via Vertex/ADC (enabled, no change); `cloudaicompanion` via Google login (**enabled**, block 3.1 — Gemini Code Assist has its own licensing terms, not examined); or `generativelanguage` via API key (**not enabled**, and needs a new key, i.e. a secret) | Varies            | The Vertex/ADC route adds nothing. The API-key route adds an API and a secret.                                                                                                                                                                                                                                                | Tokens, from whatever the CLI decides to send                                                                                                            | **Not by the probe.** The CLI controls its own request volume. |
| P-8        | `aiplatform`. Reading quota needs `cloudquotas` (**not enabled**) or the console.                                                                                                                                                                                                                         | Partly            | None for the load itself                                                                                                                                                                                                                                                                                                      | **Unbounded unless capped**                                                                                                                              | **No — the counter is the bound**                              |

### Cost capture for tonight's probes

The spec's reason for the re-run is that spend was never captured. The billing export (§3.6) is the only agent-reachable cost source found:

- **Granularity limit.** The export records per-SKU charge periods, not individual requests. A per-probe dollar figure needs one of two things: probes separated in time and SKU so their rows are distinguishable, or request labels that flow into `x_Labels`. The column exists (block 3.6). Whether Vertex `generateContent` labels populate it is **UNVERIFIED** and should be checked on the first probe.
- **Export latency.** Rows arrive with a delay, so cost is read after the run, not during it. The export cadence was not measured here. Only one `Last modified` value was read (block 3.6).
- **Reading it is a BigQuery query**, which is a billable request. It is excluded from this task and needs operator approval, or operator execution.
- **Harness per-turn figures versus export:** the Phase 0 UNVERIFIED item "whether spend reconciles with the harness's own reported per-turn figures" stays open. If the two disagree, both are recorded (contract §6).

### P-8 counter

When P-8 is written, it carries a **hard request counter**, and the value used is recorded with the result. A wall-clock limit does not bound cost: a client retry loop can multiply requests inside any time window. Every attempt, retries included, increments the counter. The probe stops at the first 429, or when the cap is reached, whichever comes first.

---

## 6. Recommended probe set for tonight (subject to Task 1 closure)

These follow from §4.3. This document authorizes none of them.

1. **Re-run for cost only:** P-4, P-5, and the three carry-forwards. Multimodal gets a real screenshot, not a 1×1 PNG.
2. **Run for the first time as specified:** P-1 (real Zod schema), P-2 (repository corpus, two calls, costed), P-6 (once the operator names the answer key), P-7 (CLI already installed; register it), P-8 (with a counter).
3. **Needs a separate approval before it can run:** P-3, which requires resource creation and an IAM grant.
4. **Drop from the Phase 1 set:** RETEST P8 (GCS reachability). It sits under ACT-07, not ACT-08.
