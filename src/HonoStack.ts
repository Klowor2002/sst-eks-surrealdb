import { StackContext, Api } from "sst/constructs";

/**
 * HonoStack — the example Hono service (examples/hono-service) deployed as
 * a Lambda behind API Gateway. It talks to SurrealDB over HTTP/WebSocket
 * using the standard SURREALDB_* environment variables.
 *
 * Deploy order: deploy EksStack first, read the internal load balancer DNS
 * of the `surrealdb` Service (`kubectl get svc surrealdb -n default`), then
 * deploy with SURREALDB_URL=http://<lb-dns>:8000. For local development the
 * same variables work against a port-forwarded SurrealDB
 * (`kubectl port-forward svc/surrealdb 8000:8000`, SURREALDB_URL unset).
 */
export function HonoStack({ stack }: StackContext) {
  const api = new Api(stack, "HonoApi", {
    defaults: {
      function: {
        environment: {
          SURREALDB_URL: process.env.SURREALDB_URL ?? "http://localhost:8000",
          SURREALDB_USER: process.env.SURREALDB_USER ?? "root",
          SURREALDB_PASS: process.env.SURREALDB_PASS ?? "root",
          SURREALDB_NS: process.env.SURREALDB_NS ?? "test",
          SURREALDB_DB: process.env.SURREALDB_DB ?? "test",
        },
      },
    },
    routes: {
      $default: "examples/hono-service/index.handler",
    },
  });

  stack.addOutputs({
    HonoApiEndpoint: api.url,
  });
}
