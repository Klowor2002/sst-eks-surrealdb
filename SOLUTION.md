# Solution — SurrealDB on TiKV on Amazon EKS, deployed with SST v2

This is a complete, working SST v2 project that deploys SurrealDB backed by a
TiKV cluster on Amazon EKS, plus the example Hono service connected to it.

## What was wrong with the starting code

The repository mixed **three incompatible frameworks** and could not compile
or deploy as checked in:

1. `sst.config.ts` was SST v2 at the top, but had trailing top-level calls to
   `app.addResource(...)` / `app.addService(...)` — APIs that do not exist in
   SST v2 — referencing an undefined `app`, plus a reference to the SST v3
   `.sst/platform` types.
2. `src/EksStack.ts` created the VPC, EKS cluster and node groups, but never
   installed the TiDB Operator, the TidbCluster, or SurrealDB — the actual
   payload of the challenge was missing from the deployed stack.
3. `surrealdb.ts` contained the TiKV/SurrealDB logic, but written against
   **Pulumi** packages (`sst.aws.Vpc`, unqualified `eks` / `kubernetes`
   imports) that are not in `package.json`, and the file was never imported
   anywhere. Dead, uncompilable code.
4. `examples/hono-service/package.json` pinned `"typescript": "^5.3.3t "`
   (invalid semver — `npm install` fails), and `index.ts` imported
   `Resource` from `sst/node/config` (bound to the non-existent resource in
   item 1), connected at module scope, called `process.exit(1)` on failure,
   and exported no `handler` even though the config referenced
   `index.handler`.

## What this solution does

Everything is consolidated into one coherent **SST v2** project (the version
pinned in `package.json`):

- **`src/EksStack.ts`** (functional SST v2 stack):
  - VPC (3 AZ, 1 NAT gateway) and an EKS cluster (Kubernetes 1.28, the newest
    version offered by the pinned aws-cdk-lib 2.124).
  - Three dedicated, tainted node groups labelled `dedicated=pd|tikv|tidb`
    (kept from the original stack).
  - **aws-ebs-csi-driver** Helm chart + a default **gp3 StorageClass** —
    without these, PD/TiKV PersistentVolumes never bind on current EKS.
  - **TiDB Operator** v1.6.1 via the official `charts.pingcap.org` Helm chart
    (its bundled CRDs install with it).
  - A **TidbCluster** custom resource (TiDB v8.5.0): PD ×3, TiKV ×3,
    TiDB ×2, each scheduled onto its dedicated node group via
    nodeSelector + tolerations, applied after the operator and storage
    class via explicit construct dependencies.
  - **SurrealDB** v2.2.2 via the official SurrealDB Helm chart, opened on
    `tikv://basic-pd.tidb-cluster:2379` (the PD endpoint of the TidbCluster),
    exposed through an **internal** load balancer.
- **`src/HonoStack.ts`**: the Hono example as a Lambda + API Gateway `Api`,
  configured purely through `SURREALDB_*` environment variables.
- **`examples/hono-service/index.ts`**: rewritten to the surrealdb JS SDK v1
  API (`signin({ username, password })`, `use({ namespace, database })`),
  lazy one-time connection (Lambda containers are reused), a real
  `handler` export via `hono/aws-lambda`, and a `/health` endpoint that
  reports SurrealDB connectivity. The invalid `typescript` pin is fixed.
- `surrealdb.ts` is removed; its useful content (operator/cluster/SurrealDB
  versions and values) lives on inside `EksStack`, per above.

## Architecture

```
                 ┌──────────────────────── EKS ────────────────────────┐
                 │                                                      │
  Hono (Lambda)  │   pd nodes ×3      tikv nodes ×3      tidb nodes ×2  │
  ──────────────►│   ┌─────────┐      ┌──────────┐       ┌──────────┐   │
  SURREALDB_URL  │   │ PD ×3   │◄────►│ TiKV ×3  │◄──────│ TiDB ×2  │   │
  (internal NLB) │   └────┬────┘      └──────────┘       └──────────┘   │
                 │        │              ▲                              │
                 │        │   tikv://basic-pd.tidb-cluster:2379        │
                 │   ┌────┴───────────┐  │                              │
                 │   │  SurrealDB     ├──┘   (TiDB Operator manages    │
                 │   │  (Helm, NLB)   │        the TidbCluster)        │
                 │   └────────────────┘                               │
                 └──────────────────────────────────────────────────────┘
```

## Prerequisites

- AWS account + AWS CLI configured (`aws configure`), with permissions to
  create VPC, EKS, IAM and load balancers.
- Node.js 18+ and pnpm (or npm).
- `kubectl` for verification.

## Environment variables

| Variable          | Used by      | Default                 | Meaning                          |
| ----------------- | ------------ | ----------------------- | -------------------------------- |
| `SURREALDB_URL`   | Hono service | `http://localhost:8000` | SurrealDB HTTP endpoint          |
| `SURREALDB_USER`  | Hono service | `root`                  | Root username                    |
| `SURREALDB_PASS`  | Hono service | `root`                  | Root password                    |
| `SURREALDB_NS`    | Hono service | `test`                  | Namespace                        |
| `SURREALDB_DB`    | Hono service | `test`                  | Database                         |

> ⚠️ The SurrealDB Helm values in `EksStack` set root credentials to
> `root`/`root` to match these defaults. Change both sides before any real
> use.

## Deploy

```bash
# 1. Install and deploy the infrastructure (EKS + TiKV + SurrealDB)
npm install
npx sst deploy --stage prod        # deploys EksStack and HonoStack

# 2. Point kubectl at the cluster (command also printed in stack outputs)
aws eks update-kubeconfig --name <ClusterName output> --region us-east-1

# 3. Wait for the TiKV cluster and SurrealDB
kubectl get pods -n tidb-cluster -w     # basic-pd-*, basic-tikv-*, basic-tidb-*
kubectl get pods -n default -w          # surrealdb-*

# 4. Get the SurrealDB endpoint (internal NLB DNS) and redeploy the API
kubectl get svc surrealdb -n default
SURREALDB_URL=http://<nlb-dns>:8000 npx sst deploy --stage prod
```

## Test the connection

```bash
# Through the Hono API (endpoint printed as HonoApiEndpoint)
curl https://<api-endpoint>/health
# -> {"status":"ok","surrealdb":"connected"}

curl -X POST https://<api-endpoint>/users -d '{"name":"Ada"}'
curl https://<api-endpoint>/users

# Or locally against a port-forward (no AWS calls needed)
kubectl port-forward svc/surrealdb 8000:8000
cd examples/hono-service && pnpm install && pnpm dev
curl localhost:3000/health   # via a local runner of your choice
```

## Teardown

```bash
npx sst remove --stage prod
```

## Troubleshooting

- **PD/TiKV pods stuck `Pending` with unbound PVCs** — the EBS CSI driver or
  the gp3 StorageClass did not come up; check
  `kubectl get pods -n kube-system | grep ebs` and `kubectl get sc`.
- **TidbCluster never appears / operator errors about CRDs** — the
  tidb-operator chart installs CRDs from its `crds/` folder; if a previous
  partial install exists, delete the release and redeploy so Helm reapplies
  them.
- **SurrealDB pod `CrashLoopBackOff` with connection errors** — it starts
  before PD is ready on first deploy; it recovers once
  `basic-pd.tidb-cluster:2379` accepts connections. Check
  `kubectl get tidbcluster basic -n tidb-cluster`.
- **Hono `/health` returns `surrealdb: "unavailable"`** — `SURREALDB_URL`
  does not point at the internal NLB DNS yet (step 4 above), or the Lambda
  cannot reach the VPC-internal endpoint from its network placement.
- **Node group pods unschedulable** — the TidbCluster nodeSelector/toleration
  pairs must match the node group labels/taints in `EksStack.ts`
  (`dedicated=pd|tikv|tidb`); keep them in sync when resizing.
