import { errorResponse, json } from "./auth";
import type { AdminUser, ApiContext, ManagedUser } from "./types";

const USER_ROLES = ["manager", "editor", "viewer", "user"] as const;
const USER_STATUSES = ["active", "pending", "inactive"] as const;
const SORT_COLUMNS: Record<string, string> = {
  name: "name",
  email: "email",
  role: "role",
  status: "status",
  createdAt: "created_at",
};

interface UserInput {
  name: string;
  email: string;
  role: (typeof USER_ROLES)[number];
  status: (typeof USER_STATUSES)[number];
}

function isRole(value: unknown): value is UserInput["role"] {
  return typeof value === "string" && USER_ROLES.includes(value as UserInput["role"]);
}

function isStatus(value: unknown): value is UserInput["status"] {
  return typeof value === "string" && USER_STATUSES.includes(value as UserInput["status"]);
}

function isFilterRole(value: string): boolean {
  return value === "admin" || isRole(value);
}

function validateInput(value: unknown): UserInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.name !== "string" ||
    body.name.trim().length < 2 ||
    body.name.trim().length > 100 ||
    typeof body.email !== "string" ||
    body.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
    !isRole(body.role) ||
    !isStatus(body.status)
  ) {
    return null;
  }
  return {
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    role: body.role,
    status: body.status,
  };
}

function logActivity(
  ctx: ApiContext,
  action: "registration" | "update" | "deletion",
  targetId: string,
  targetName: string,
  details: string,
): D1PreparedStatement {
  return ctx.env.DB.prepare(
    "INSERT INTO activities (id, actor_id, action, target_id, target_name, details) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), ctx.admin?.id ?? null, action, targetId, targetName, details);
}

function getUserId(ctx: ApiContext): string | null {
  const match = ctx.url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function parsePage(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : null;
}

function validDate(value: string | null): boolean {
  return value === null || /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

async function listUsers(ctx: ApiContext): Promise<Response> {
  const params = ctx.url.searchParams;
  const page = parsePage(params.get("page"), 1, 1_000_000);
  const pageSize = parsePage(params.get("pageSize"), 10, 100);
  if (page === null || pageSize === null) {
    return errorResponse("Page must be positive, and page size must be between 1 and 100.", 400);
  }

  const role = params.get("role");
  const status = params.get("status");
  const active = params.get("active");
  const from = params.get("from");
  const to = params.get("to");
  const sort = params.get("sort") ?? "createdAt";
  const direction = params.get("direction") ?? "desc";
  const search = params.get("search")?.trim().slice(0, 200) ?? "";

  if (role !== null && role !== "all" && !isFilterRole(role)) return errorResponse("Role filter is not valid.", 400);
  if (status !== null && status !== "all" && !isStatus(status)) return errorResponse("Status filter is not valid.", 400);
  if (active !== null && active !== "all" && active !== "true" && active !== "false") {
    return errorResponse("Active filter must be true, false, or all.", 400);
  }
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) {
    return errorResponse("Date range is not valid.", 400);
  }
  if (!Object.hasOwn(SORT_COLUMNS, sort) || (direction !== "asc" && direction !== "desc")) {
    return errorResponse("Sort options are not valid.", 400);
  }

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (search) {
    conditions.push(
      "(instr(lower(id), lower(?)) > 0 OR instr(lower(name), lower(?)) > 0 OR instr(lower(email), lower(?)) > 0 OR instr(lower(role), lower(?)) > 0 OR instr(lower(status), lower(?)) > 0)",
    );
    bindings.push(search, search, search, search, search);
  }
  if (role && role !== "all") {
    conditions.push("role = ?");
    bindings.push(role);
  }
  if (status && status !== "all") {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (active === "true") conditions.push("status = 'active'");
  if (active === "false") conditions.push("status != 'active'");
  if (from) {
    conditions.push("created_at >= ?");
    bindings.push(`${from}T00:00:00.000Z`);
  }
  if (to) {
    conditions.push("created_at < ?");
    bindings.push(new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString());
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM users ${where}`,
  ).bind(...bindings).first<{ total: number }>();
  const total = count?.total ?? 0;
  const offset = (page - 1) * pageSize;
  const results = await ctx.env.DB.prepare(
    `SELECT id, name, email, role, status, created_at, updated_at
     FROM users ${where}
     ORDER BY ${SORT_COLUMNS[sort]} ${direction.toUpperCase()}, id ASC
     LIMIT ? OFFSET ?`,
  ).bind(...bindings, pageSize, offset).all<ManagedUser>();

  return json({
    records: results.results,
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  });
}

async function createUser(ctx: ApiContext, body: unknown): Promise<Response> {
  const input = validateInput(body);
  if (!input) return errorResponse("Provide a valid name, email, role, and account status.", 400);
  const id = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO users (id, name, email, role, status) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, input.name, input.email, input.role, input.status),
      logActivity(ctx, "registration", id, input.name, `Created ${input.role} account`),
    ]);
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      return errorResponse("An account with this email already exists.", 409);
    }
    console.error("Could not create user record.", error);
    return errorResponse("Could not create the user record.", 500);
  }
  const user = await ctx.env.DB.prepare(
    "SELECT id, name, email, role, status, created_at, updated_at FROM users WHERE id = ?",
  ).bind(id).first<ManagedUser>();
  return json({ record: user }, 201);
}

async function updateUser(ctx: ApiContext, id: string, body: unknown): Promise<Response> {
  if (!id) return errorResponse("Record ID is not valid.", 400);
  const input = validateInput(body);
  if (!input) return errorResponse("Provide a valid name, email, role, and account status.", 400);
  const current = await ctx.env.DB.prepare(
    "SELECT id, name, email, role, status FROM users WHERE id = ?",
  ).bind(id).first<Pick<ManagedUser, "id" | "name" | "email" | "role" | "status">>();
  if (!current) return errorResponse("Record was not found.", 404);
  if (current.role === "admin") return errorResponse("Administrator accounts cannot be changed here.", 403);

  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "UPDATE users SET name = ?, email = ?, role = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      ).bind(input.name, input.email, input.role, input.status, id),
      logActivity(ctx, "update", id, input.name, `Updated ${input.role} account`),
    ]);
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      return errorResponse("An account with this email already exists.", 409);
    }
    console.error("Could not update user record.", error);
    return errorResponse("Could not update the user record.", 500);
  }
  const user = await ctx.env.DB.prepare(
    "SELECT id, name, email, role, status, created_at, updated_at FROM users WHERE id = ?",
  ).bind(id).first<ManagedUser>();
  return json({ record: user });
}

async function deleteUser(ctx: ApiContext, id: string): Promise<Response> {
  if (!id) return errorResponse("Record ID is not valid.", 400);
  const target = await ctx.env.DB.prepare(
    "SELECT id, name, role FROM users WHERE id = ?",
  ).bind(id).first<{ id: string; name: string; role: string }>();
  if (!target) return errorResponse("Record was not found.", 404);
  if (target.role === "admin" || target.id === ctx.admin?.id) {
    return errorResponse("Administrator accounts cannot be deleted here.", 403);
  }
  await ctx.env.DB.batch([
    logActivity(ctx, "deletion", id, target.name, "Deleted user account"),
    ctx.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return json({ message: "Record deleted." });
}

function utcMonth(offset: number): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

async function dashboard(ctx: ApiContext): Promise<Response> {
  const [totalUsers, activeUsers, pendingUsers, inactiveUsers, recentUsers, activityCount, roleRows, growthRows, activities] =
    await Promise.all([
      ctx.env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
      ctx.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").first<{ count: number }>(),
      ctx.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'pending'").first<{ count: number }>(),
      ctx.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'inactive'").first<{ count: number }>(),
      ctx.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE created_at >= ?",
      ).bind(`${utcMonth(0)}-01T00:00:00.000Z`).first<{ count: number }>(),
      ctx.env.DB.prepare("SELECT COUNT(*) AS count FROM activities").first<{ count: number }>(),
      ctx.env.DB.prepare(
        "SELECT role, COUNT(*) AS count FROM users GROUP BY role",
      ).all<{ role: string; count: number }>(),
      ctx.env.DB.prepare(
        "SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count FROM users WHERE created_at >= ? GROUP BY month",
      ).bind(`${utcMonth(-5)}-01T00:00:00.000Z`).all<{ month: string; count: number }>(),
      ctx.env.DB.prepare(
        `SELECT activities.id, activities.action, activities.target_id, activities.target_name,
                activities.details, activities.created_at, users.name AS actor_name
         FROM activities LEFT JOIN users ON users.id = activities.actor_id
         ORDER BY activities.created_at DESC LIMIT 8`,
      ).all<{
        id: string;
        action: string;
        target_id: string | null;
        target_name: string;
        details: string;
        created_at: string;
        actor_name: string | null;
      }>(),
    ]);

  const growthByMonth = new Map((growthRows.results ?? []).map((row) => [row.month, row.count]));
  const growth = Array.from({ length: 6 }, (_, index) => {
    const month = utcMonth(index - 5);
    return { month, count: growthByMonth.get(month) ?? 0 };
  });
  return json({
    stats: {
      totalUsers: totalUsers?.count ?? 0,
      activeUsers: activeUsers?.count ?? 0,
      pendingRequests: pendingUsers?.count ?? 0,
      inactiveUsers: inactiveUsers?.count ?? 0,
      totalRecords: totalUsers?.count ?? 0,
      registrationsThisMonth: recentUsers?.count ?? 0,
      totalActivities: activityCount?.count ?? 0,
    },
    charts: {
      growth,
      roles: roleRows.results ?? [],
      status: [
        { status: "active", count: activeUsers?.count ?? 0 },
        { status: "inactive", count: inactiveUsers?.count ?? 0 },
        { status: "pending", count: pendingUsers?.count ?? 0 },
      ],
    },
    activities: activities.results ?? [],
  });
}

async function listActivities(ctx: ApiContext): Promise<Response> {
  const limit = parsePage(ctx.url.searchParams.get("limit"), 10, 50);
  if (limit === null) return errorResponse("Limit must be between 1 and 50.", 400);
  const activities = await ctx.env.DB.prepare(
    `SELECT activities.id, activities.action, activities.target_id, activities.target_name,
            activities.details, activities.created_at, users.name AS actor_name
     FROM activities LEFT JOIN users ON users.id = activities.actor_id
     ORDER BY activities.created_at DESC LIMIT ?`,
  ).bind(limit).all();
  return json({ activities: activities.results });
}

export async function handleProtectedRequest(ctx: ApiContext, body: unknown): Promise<Response> {
  if (ctx.url.pathname === "/api/dashboard" && ctx.request.method === "GET") {
    return dashboard(ctx);
  }
  if (ctx.url.pathname === "/api/activities" && ctx.request.method === "GET") {
    return listActivities(ctx);
  }
  if (ctx.url.pathname === "/api/users" && ctx.request.method === "GET") {
    return listUsers(ctx);
  }
  if (ctx.url.pathname === "/api/users" && ctx.request.method === "POST") {
    return createUser(ctx, body);
  }
  if (ctx.url.pathname === "/api/users") return errorResponse("Method not allowed.", 405);

  if (ctx.url.pathname.startsWith("/api/users/")) {
    const id = getUserId(ctx);
    if (ctx.request.method === "GET" && id) {
      const record = await ctx.env.DB.prepare(
        "SELECT id, name, email, role, status, created_at, updated_at FROM users WHERE id = ?",
      ).bind(id).first<ManagedUser>();
      return record ? json({ record }) : errorResponse("Record was not found.", 404);
    }
    if (ctx.request.method === "PUT") return updateUser(ctx, id ?? "", body);
    if (ctx.request.method === "DELETE") return deleteUser(ctx, id ?? "");
    return errorResponse("Method not allowed.", 405);
  }
  return errorResponse("Not found.", 404);
}

export function isAdmin(_admin: AdminUser): boolean {
  return _admin.role === "admin" && _admin.status === "active";
}
