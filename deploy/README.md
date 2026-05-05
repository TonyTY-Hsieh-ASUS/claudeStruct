# Deploy artifacts (W8.1)

Skeletons for running the `cs serve` daemon as a hosted SaaS or a
self-hosted control plane. Two halves:

```
deploy/helm/claudestruct/   # Helm chart (k8s workload)
deploy/terraform/           # Terraform module (cloud infra)
```

Neither is "production-ready" yet — they're starting points that
encode the shape so each follow-up PR can layer in the missing
pieces (multi-AZ Postgres, HPA, ACM, WAF, multi-region replicas,
CMEK from W8.6, status-page integration from W8.7).

## Helm chart

`deploy/helm/claudestruct/` provisions:

- 1× Deployment running `cs serve run` on uvicorn
- 1× Service exposing port 8787 internally
- 1× Ingress (gated by `.Values.ingress.enabled`)
- 1× Secret with Anthropic + Stripe credentials and the DB URL
- Probe wiring against `/healthz` and `/readyz` (already exposed
  unauthenticated by the daemon in W6.2)

### Install (development cluster)

```bash
helm install claudestruct deploy/helm/claudestruct \
  --set secrets.inline.anthropicApiKey=$ANTHROPIC_API_KEY \
  --set config.databaseUrl="postgresql+psycopg://user:pass@host/db"
```

### Install (production)

Use a pre-provisioned Secret managed by SealedSecrets / ExternalSecrets
/ AWS Secrets Manager rather than the inline values:

```bash
helm install claudestruct deploy/helm/claudestruct \
  -f my-prod-values.yaml \
  --set secrets.existingSecret=claudestruct-prod-secrets
```

### Security posture (defaults)

- `runAsNonRoot: true`, `runAsUser: 1000`, `fsGroup: 1000`
- Container `readOnlyRootFilesystem: true`
- All capabilities dropped
- Writable mounts only for `/var/lib/claudestruct` (run logs) and
  `/tmp` — both `emptyDir`
- Service is `ClusterIP` by default; ingress opt-in

## Terraform module

`deploy/terraform/main.tf` provisions:

- VPC with two AZs (private + public subnets)
- RDS Postgres 16 (single instance for dev; Multi-AZ when `environment = "prod"`)
- Security group locked to in-VPC traffic
- Master credentials managed by AWS Secrets Manager
- Outputs the DB endpoint + secret ARN for the Helm chart

### Apply

```bash
cd deploy/terraform
terraform init
terraform plan -var environment=dev -var region=us-east-1
terraform apply -var environment=prod -var region=us-east-1
```

### What's intentionally missing

- **EKS cluster** — left out so the module is portable across
  GKE/AKS/self-hosted k8s. Wire your preferred cluster module
  alongside.
- **ALB / ACM** — the Helm ingress assumes nginx-ingress for now.
  Add `aws_acm_certificate` + ALB controller annotations when
  switching to AWS-native ingress.
- **Per-region instantiation** — W8.5 data residency calls for
  Postgres-per-region. Use `terraform apply -var region=eu-west-1`
  in a separate workspace and tag the data accordingly.
- **CMEK** — W8.6 introduces an envelope-encryption layer; the RDS
  module already enables `storage_encrypted = true` against the AWS
  default KMS key, but BYOK requires `kms_key_id` to be filled in
  from a customer-managed key.

## Roadmap mapping

| Item   | Status in this PR                                       |
| ------ | ------------------------------------------------------- |
| W8.1   | Helm + Terraform skeletons (this directory)             |
| W8.2   | Subscription model + Stripe stub (in `server/billing.py`)|
| W8.3   | Pending — depends on W6.1 daemon worker model           |
| W8.4   | Audit chain (in `server/audit.py`)                      |
| W8.5   | Region tag wired into Helm config; module per-region pending |
| W8.6   | Pending — separate PR (envelope encryption + KMS provider)   |
| W8.7   | Pending — external (statuspage.io / Cachet)             |
