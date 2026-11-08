import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { Surreal } from "surrealdb";

const app = new Hono();
const db = new Surreal();

const config = {
  url: process.env.SURREALDB_URL ?? "http://localhost:8000",
  user: process.env.SURREALDB_USER ?? "root",
  pass: process.env.SURREALDB_PASS ?? "root",
  ns: process.env.SURREALDB_NS ?? "test",
  db: process.env.SURREALDB_DB ?? "test",
};

let connecting: Promise<void> | null = null;

// Lazily establish (once) the SurrealDB connection. Lambda containers are
// reused across invocations, so connect on first use instead of at module
// scope — and never process.exit() from inside a web handler.
function ensureConnected(): Promise<void> {
  if (!connecting) {
    connecting = (async () => {
      await db.connect(config.url);
      await db.signin({ username: config.user, password: config.pass });
      await db.use({ namespace: config.ns, database: config.db });
      console.log("Connected to SurrealDB");
    })().catch((error) => {
      connecting = null; // allow the next request to retry
      throw error;
    });
  }
  return connecting;
}

// Health check endpoint — also verifies the SurrealDB connection.
app.get("/health", async (c) => {
  try {
    await ensureConnected();
    return c.json({ status: "ok", surrealdb: "connected" });
  } catch {
    return c.json({ status: "ok", surrealdb: "unavailable" }, 503);
  }
});

// Example endpoint to create a record
app.post("/users", async (c) => {
  try {
    await ensureConnected();
    const body = await c.req.json();
    const user = await db.create("user", body);
    return c.json(user);
  } catch (error) {
    console.error("Failed to create user:", error);
    return c.json({ error: "Failed to create user" }, 500);
  }
});

// Example endpoint to get all users
app.get("/users", async (c) => {
  try {
    await ensureConnected();
    const users = await db.select("user");
    return c.json(users);
  } catch (error) {
    console.error("Failed to fetch users:", error);
    return c.json({ error: "Failed to fetch users" }, 500);
  }
});

// Used by SST (Lambda entrypoint: index.handler)
export const handler = handle(app);

// Used for local development (`pnpm dev`, see package.json)
export default app;
