import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0001_initial_schema.sql?raw";
import { createInitialAdmin } from "../src/worker/auth";

const ADMIN_EMAIL = "shanumiftikhar61@gmail.com";
const ADMIN_PASSWORD = `${crypto.randomUUID()}-AdminA9`;
const ADMIN_BOOTSTRAP_TOKEN = env.ADMIN_BOOTSTRAP_TOKEN;
const BASE_URL = "http://example.com";
let sessionCookie = "";

if (!ADMIN_BOOTSTRAP_TOKEN) {
  throw new Error("The integration test bootstrap secret must be configured.");
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; headers?: HeadersInit } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  return workerExports.default.fetch(new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

async function createUser(input: Partial<Record<"name" | "email" | "role" | "status", string>>) {
  const response = await request("/api/users", {
    method: "POST",
    cookie: sessionCookie,
    body: {
      name: input.name ?? "Morgan Reed",
      email: input.email ?? `${crypto.randomUUID()}@example.com`,
      role: input.role ?? "user",
      status: input.status ?? "active",
    },
  });
  return { response, body: await response.json() as { record?: { id: string } } };
}

beforeEach(async () => {
  const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM activities"),
    env.DB.prepare("DELETE FROM login_attempts"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: {
      email: ADMIN_EMAIL,
      name: "Shanum Iftikhar",
      bootstrapToken: ADMIN_BOOTSTRAP_TOKEN,
      password: ADMIN_PASSWORD,
    },
  });
  expect(setup.status).toBe(201);
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("Set-Cookie");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  sessionCookie = setCookie?.split(";")[0] ?? "";
  expect(sessionCookie).toMatch(/^skyleax_session=.+$/);
});

describe("admin authentication and protected endpoints", () => {
  it("bootstraps only the configured admin and revokes sessions on logout", async () => {
    const status = await request("/api/auth/status", { cookie: sessionCookie });
    expect(await status.json()).toEqual({ setupRequired: false, setupReady: true, authenticated: true });

    const wrongEmail = await request("/api/auth/setup", {
      method: "POST",
      body: {
        email: "someone-else@example.com",
        bootstrapToken: ADMIN_BOOTSTRAP_TOKEN,
        password: ADMIN_PASSWORD,
      },
    });
    expect(wrongEmail.status).toBe(403);

    const wrongToken = await request("/api/auth/setup", {
      method: "POST",
      body: {
        email: ADMIN_EMAIL,
        bootstrapToken: "incorrect-token",
        password: ADMIN_PASSWORD,
      },
    });
    expect(wrongToken.status).toBe(403);

    const whitespaceToken = await request("/api/auth/setup", {
      method: "POST",
      body: {
        email: ADMIN_EMAIL,
        bootstrapToken: ` \r\n${ADMIN_BOOTSTRAP_TOKEN}\t `,
        password: ADMIN_PASSWORD,
      },
    });
    expect(whitespaceToken.status).toBe(409);

    const paddedSecretContext = {
      env: {
        DB: env.DB,
        ASSETS: env.ASSETS,
        ADMIN_EMAIL,
        ADMIN_BOOTSTRAP_TOKEN: ` \r\n${ADMIN_BOOTSTRAP_TOKEN}\t `,
      },
      request: new Request(`${BASE_URL}/api/auth/setup`),
      url: new URL(`${BASE_URL}/api/auth/setup`),
    };
    const paddedSecret = await createInitialAdmin(paddedSecretContext, {
      email: ADMIN_EMAIL,
      bootstrapToken: ADMIN_BOOTSTRAP_TOKEN,
      password: ADMIN_PASSWORD,
    });
    expect(paddedSecret.status).toBe(409);

    const anotherSetup = await request("/api/auth/setup", {
      method: "POST",
      body: {
        email: ADMIN_EMAIL,
        bootstrapToken: ADMIN_BOOTSTRAP_TOKEN,
        password: ADMIN_PASSWORD,
      },
    });
    expect(anotherSetup.status).toBe(409);

    const wrongPassword = await request("/api/auth/login", {
      method: "POST",
      body: { email: ADMIN_EMAIL, password: "not the password" },
    });
    expect(wrongPassword.status).toBe(401);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await request("/api/auth/login", {
        method: "POST",
        body: { email: ADMIN_EMAIL, password: "not the password" },
      })).status).toBe(401);
    }
    expect((await request("/api/auth/login", {
      method: "POST",
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })).status).toBe(429);

    const whoami = await request("/api/auth/me", { cookie: sessionCookie });
    expect((await whoami.json() as { admin: { email: string; role: string } }).admin).toMatchObject({
      email: ADMIN_EMAIL,
      role: "admin",
    });

    const loggedOut = await request("/api/auth/logout", { method: "POST", cookie: sessionCookie });
    expect(loggedOut.status).toBe(200);
    expect((await request("/api/dashboard", { cookie: sessionCookie })).status).toBe(401);
  });

  it("rejects anonymous access and cross-origin state changes", async () => {
    expect((await request("/api/dashboard")).status).toBe(401);
    expect((await request("/api/users")).status).toBe(401);
    expect((await request("/api/users", {
      method: "POST",
      cookie: sessionCookie,
      headers: { Origin: "https://attacker.example" },
      body: { name: "Denied User", email: "denied@example.com", role: "user", status: "active" },
    })).status).toBe(403);
  });
});

describe("user records, filters, sorting, and pagination", () => {
  it("supports persistent create, view, update, and delete operations with audit events", async () => {
    const created = await createUser({
      name: "Avery Quinn",
      email: "avery@example.com",
      role: "manager",
      status: "pending",
    });
    expect(created.response.status).toBe(201);
    expect(created.body.record?.id).toMatch(/^usr_[a-f0-9]+$/);

    const read = await request(`/api/users/${created.body.record?.id}`, { cookie: sessionCookie });
    expect((await read.json() as { record: { name: string; email: string } }).record).toMatchObject({
      name: "Avery Quinn",
      email: "avery@example.com",
    });

    const changed = await request(`/api/users/${created.body.record?.id}`, {
      method: "PUT",
      cookie: sessionCookie,
      body: { name: "Avery Quinn", email: "avery@example.com", role: "editor", status: "active" },
    });
    expect(changed.status).toBe(200);
    expect((await changed.json() as { record: { role: string; status: string } }).record).toMatchObject({
      role: "editor",
      status: "active",
    });

    const dashboard = await request("/api/dashboard", { cookie: sessionCookie });
    const data = await dashboard.json() as {
      stats: { totalUsers: number; activeUsers: number; totalActivities: number; registrationsThisMonth: number };
      charts: {
        growth: { month: string; count: number }[];
        roles: { role: string; count: number }[];
        status: { status: string; count: number }[];
      };
      activities: { action: string }[];
    };
    expect(data.stats).toMatchObject({
      totalUsers: 2,
      activeUsers: 2,
      totalActivities: 3,
      registrationsThisMonth: 2,
    });
    expect(data.charts.roles).toEqual(expect.arrayContaining([
      { role: "admin", count: 1 },
      { role: "editor", count: 1 },
    ]));
    expect(data.charts.status).toEqual([
      { status: "active", count: 2 },
      { status: "inactive", count: 0 },
      { status: "pending", count: 0 },
    ]);
    expect(data.charts.growth.find((month) => month.month === new Date().toISOString().slice(0, 7))).toEqual({
      month: new Date().toISOString().slice(0, 7),
      count: 2,
    });
    expect(data.activities.map((activity) => activity.action)).toEqual(["update", "registration", "admin_login"]);

    expect((await request(`/api/users/${created.body.record?.id}`, {
      method: "DELETE",
      cookie: sessionCookie,
    })).status).toBe(200);
    const gone = await request(`/api/users/${created.body.record?.id}`, { cookie: sessionCookie });
    expect(gone.status).toBe(404);
    const activityCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM activities")
      .first<{ count: number }>();
    expect(activityCount?.count).toBe(4);
  });

  it("combines text, role, status, active, and date filters with stable sorting and pagination", async () => {
    const records = [
      { name: "Zoe Avery", email: "zoe@example.com", role: "manager", status: "active" },
      { name: "Ada Lovelace", email: "ada@example.com", role: "manager", status: "active" },
      { name: "Sam Viewer", email: "sam@example.com", role: "viewer", status: "inactive" },
      { name: "Mina Pending", email: "mina@example.com", role: "editor", status: "pending" },
    ];
    const ids: string[] = [];
    for (const record of records) {
      const created = await createUser(record);
      expect(created.response.status).toBe(201);
      ids.push(created.body.record?.id ?? "");
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind("2025-01-03T12:00:00.000Z", ids[0]),
      env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind("2025-01-04T12:00:00.000Z", ids[1]),
      env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind("2025-02-04T12:00:00.000Z", ids[2]),
    ]);

    const combined = await request(
      "/api/users?search=ada%40example.com&role=manager&status=active&active=true&from=2025-01-01&to=2025-01-31",
      { cookie: sessionCookie },
    );
    const match = await combined.json() as { total: number; records: { id: string }[] };
    expect(match.total).toBe(1);
    expect(match.records[0].id).toBe(ids[1]);

    const ascending = await request("/api/users?role=manager&sort=name&direction=asc&pageSize=1&page=1", { cookie: sessionCookie });
    const first = await ascending.json() as { total: number; totalPages: number; records: { name: string }[] };
    expect(first).toMatchObject({ total: 2, totalPages: 2 });
    expect(first.records[0].name).toBe("Ada Lovelace");

    const second = await request("/api/users?role=manager&sort=name&direction=asc&pageSize=1&page=2", { cookie: sessionCookie });
    expect((await second.json() as { records: { name: string }[] }).records[0].name).toBe("Zoe Avery");

    const byId = await request(`/api/users?search=${ids[0]}`, { cookie: sessionCookie });
    expect((await byId.json() as { total: number }).total).toBe(1);

    const byName = await request("/api/users?search=Lovelace", { cookie: sessionCookie });
    expect((await byName.json() as { records: { id: string }[] }).records[0].id).toBe(ids[1]);

    const emailDescending = await request(
      "/api/users?role=manager&sort=email&direction=desc",
      { cookie: sessionCookie },
    );
    expect((await emailDescending.json() as { records: { name: string }[] }).records[0].name).toBe("Zoe Avery");

    const createdAscending = await request(
      "/api/users?role=manager&sort=createdAt&direction=asc",
      { cookie: sessionCookie },
    );
    expect((await createdAscending.json() as { records: { name: string }[] }).records[0].name).toBe("Zoe Avery");

    const roleAscending = await request("/api/users?sort=role&direction=asc", { cookie: sessionCookie });
    expect((await roleAscending.json() as { records: { role: string }[] }).records[0].role).toBe("admin");

    const statusDescending = await request("/api/users?sort=status&direction=desc", { cookie: sessionCookie });
    expect((await statusDescending.json() as { records: { status: string }[] }).records[0].status).toBe("pending");

    const invalid = await request("/api/users?sort=unknown", { cookie: sessionCookie });
    expect(invalid.status).toBe(400);
    const invalidDateRange = await request("/api/users?from=2025-02-01&to=2025-01-01", { cookie: sessionCookie });
    expect(invalidDateRange.status).toBe(400);
  });

  it("validates payloads and returns useful conflicts and not-found errors", async () => {
    const invalidInput = await request("/api/users", {
      method: "POST",
      cookie: sessionCookie,
      body: { name: "x", email: "not-an-email", role: "owner", status: "active" },
    });
    expect(invalidInput.status).toBe(400);

    const duplicateEmail = await request("/api/users", {
      method: "POST",
      cookie: sessionCookie,
      body: { name: "Existing Admin", email: ADMIN_EMAIL, role: "user", status: "active" },
    });
    expect(duplicateEmail.status).toBe(409);

    const invalidBody = await request("/api/users", {
      method: "POST",
      cookie: sessionCookie,
      headers: { "Content-Type": "application/json" },
    });
    expect(invalidBody.status).toBe(400);

    const missing = await request("/api/users/usr_missing", {
      method: "DELETE",
      cookie: sessionCookie,
    });
    expect(missing.status).toBe(404);

    const forbiddenRole = await request("/api/users", {
      method: "POST",
      cookie: sessionCookie,
      body: { name: "Another Admin", email: "other@example.com", role: "admin", status: "active" },
    });
    expect(forbiddenRole.status).toBe(400);
  });
});
