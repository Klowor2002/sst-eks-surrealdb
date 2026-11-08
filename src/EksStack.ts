import { StackContext } from "sst/constructs";
import * as eks from "aws-cdk-lib/aws-eks";
import * as ec2 from "aws-cdk-lib/aws-ec2";

/**
 * EksStack — everything that lives in AWS/EKS for the challenge:
 *
 *   VPC -> EKS cluster -> dedicated node groups (PD / TiKV / TiDB)
 *       -> EBS CSI driver + gp3 StorageClass (TiKV/PD need real volumes)
 *       -> TiDB Operator (Helm) -> TidbCluster CR (PD + TiKV + TiDB)
 *       -> SurrealDB (Helm) running on top of TiKV
 *          (path: tikv://basic-pd.tidb-cluster:2379)
 *
 * The Kubernetes-side pieces consolidate the earlier Pulumi-style draft
 * (surrealdb.ts) into this single SST v2 stack so `sst deploy` brings up
 * the whole thing in one pass, in dependency order.
 */
export function EksStack({ stack }: StackContext) {
  // Create VPC
  const vpc = new ec2.Vpc(stack, "SurrealDBVPC", {
    maxAzs: 3,
    natGateways: 1,
  });

  // Create EKS Cluster
  const cluster = new eks.Cluster(stack, "SurrealDBCluster", {
    vpc,
    version: eks.KubernetesVersion.V1_28,
    defaultCapacity: 2,
    defaultCapacityInstance: ec2.InstanceType.of(
      ec2.InstanceClass.M5,
      ec2.InstanceSize.LARGE
    ),
  });

  // Add TiKV node group
  cluster.addNodegroupCapacity("TiKVNodeGroup", {
    instanceTypes: [
      ec2.InstanceType.of(ec2.InstanceClass.R5B, ec2.InstanceSize.XLARGE2),
    ],
    minSize: 3,
    maxSize: 3,
    desiredSize: 3,
    labels: {
      dedicated: "tikv",
    },
    taints: [
      {
        key: "dedicated",
        value: "tikv",
        effect: eks.TaintEffect.NO_SCHEDULE,
      },
    ],
  });

  // Add PD node group
  cluster.addNodegroupCapacity("PDNodeGroup", {
    instanceTypes: [
      ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE),
    ],
    minSize: 3,
    maxSize: 3,
    desiredSize: 3,
    labels: {
      dedicated: "pd",
    },
    taints: [
      {
        key: "dedicated",
        value: "pd",
        effect: eks.TaintEffect.NO_SCHEDULE,
      },
    ],
  });

  // Add TiDB node group
  cluster.addNodegroupCapacity("TiDBNodeGroup", {
    instanceTypes: [
      ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE2),
    ],
    minSize: 2,
    maxSize: 2,
    desiredSize: 2,
    labels: {
      dedicated: "tidb",
    },
    taints: [
      {
        key: "dedicated",
        value: "tidb",
        effect: eks.TaintEffect.NO_SCHEDULE,
      },
    ],
  });

  // EBS CSI driver — EKS no longer ships an in-tree EBS provisioner on
  // current versions, and PD/TiKV PersistentVolumes stay Pending without one.
  const ebsCsiDriver = cluster.addHelmChart("AwsEbsCsiDriver", {
    chart: "aws-ebs-csi-driver",
    version: "2.30.0",
    repository: "https://kubernetes-sigs.github.io/aws-ebs-csi-driver",
    namespace: "kube-system",
    values: {
      controller: {
        serviceAccount: {
          create: true,
          name: "ebs-csi-controller-sa",
        },
      },
    },
  });

  // gp3 as the default StorageClass so the TidbCluster volume requests
  // (which do not name a class) bind immediately.
  const gp3StorageClass = cluster.addManifest("Gp3StorageClass", {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: {
      name: "gp3",
      annotations: {
        "storageclass.kubernetes.io/is-default-class": "true",
      },
    },
    provisioner: "ebs.csi.aws.com",
    parameters: {
      type: "gp3",
      fsType: "ext4",
    },
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
  });
  gp3StorageClass.node.addDependency(ebsCsiDriver);

  // TiDB Operator. The pingcap chart ships the CRDs in its crds/ directory,
  // which Helm installs before the operator itself.
  const tidbOperator = cluster.addHelmChart("TiDBOperator", {
    chart: "tidb-operator",
    version: "v1.6.1",
    repository: "https://charts.pingcap.org",
    namespace: "tidb-operator",
    createNamespace: true,
  });

  // The TiKV cluster itself: PD (metadata/quorum) + TiKV (storage)
  // + TiDB (SQL layer), each pinned to its dedicated node group through
  // nodeSelector + tolerations matching the node group labels/taints above.
  // Replica counts match the node groups (PD 3 for quorum, TiKV 3, TiDB 2).
  const tidbCluster = cluster.addManifest("TidbCluster", {
    apiVersion: "pingcap.com/v1alpha1",
    kind: "TidbCluster",
    metadata: {
      name: "basic",
      namespace: "tidb-cluster",
    },
    spec: {
      version: "v8.5.0",
      timezone: "UTC",
      tlsCluster: { enabled: false },
      pd: {
        replicas: 3,
        requests: { storage: "10Gi" },
        nodeSelector: { dedicated: "pd" },
        tolerations: [{ key: "dedicated", value: "pd", effect: "NoSchedule" }],
      },
      tikv: {
        replicas: 3,
        requests: { storage: "100Gi" },
        nodeSelector: { dedicated: "tikv" },
        tolerations: [
          { key: "dedicated", value: "tikv", effect: "NoSchedule" },
        ],
      },
      tidb: {
        replicas: 2,
        service: { type: "ClusterIP" },
        nodeSelector: { dedicated: "tidb" },
        tolerations: [
          { key: "dedicated", value: "tidb", effect: "NoSchedule" },
        ],
      },
    },
  });
  tidbCluster.node.addDependency(tidbOperator);
  tidbCluster.node.addDependency(gp3StorageClass);

  // SurrealDB on top of TiKV. PD's client endpoint inside the cluster is
  // basic-pd.tidb-cluster:2379 — that is the storage path SurrealDB opens.
  // The Service is an internal load balancer: reachable from inside the VPC
  // (and from the Hono Lambda once SURREALDB_URL points at its DNS name),
  // not from the public internet. Change the root credentials before any
  // real use — see SOLUTION.md.
  const surrealdb = cluster.addHelmChart("SurrealDB", {
    chart: "surrealdb",
    version: "0.3.7",
    repository: "https://surrealdb.github.io/helm-charts",
    namespace: "default",
    values: {
      image: {
        pullPolicy: "IfNotPresent",
        repository: "surrealdb/surrealdb",
        tag: "v2.2.2",
      },
      service: {
        type: "LoadBalancer",
        annotations: {
          "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
        },
      },
      surrealdb: {
        auth: true,
        username: "root",
        password: "root",
        path: "tikv://basic-pd.tidb-cluster:2379",
      },
    },
  });
  surrealdb.node.addDependency(tidbCluster);

  stack.addOutputs({
    ClusterName: cluster.clusterName,
    ClusterEndpoint: cluster.clusterEndpoint,
    UpdateKubeconfig: `aws eks update-kubeconfig --name ${cluster.clusterName} --region us-east-1`,
    SurrealDBService:
      "kubectl get svc surrealdb -n default (internal NLB DNS -> SURREALDB_URL)",
  });

  return {
    vpc,
    cluster,
  };
}
