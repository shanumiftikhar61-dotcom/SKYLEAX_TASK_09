import type { AdminUser, ApiContext } from "./types";

const SESSION_COOKIE = "skyleax_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 8;
const PASSWORD_ITERATIONS = 310_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const DUMMY_PASSWORD_HASH = "v1$310000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % Math.max(1, left.length)] ?? 0) ^
      (right[index % Math.max(1, right.length)] ?? 0);
  }
  return difference === 0;
}

async function passwordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function createPasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt, PASSWORD_ITERATIONS);
  return `v1$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, iterationText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationText);
  if (
    version !== "v1" ||
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 1_000_000 ||
    !saltText ||
    !hashText
  ) {
    return false;
  }
  try {
    const expected = base64UrlToBytes(hashText);
    const actual = await passwordHash(password, base64UrlToBytes(saltText), iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

function cookieValue(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const pair = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return pair ? pair.slice(SESSION_COOKIE.length + 1) : null;
}

function sessionCookie(value: string, secure: boolean, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function guardOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  responseHeaders.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return null;
  }
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function createInitialAdmin(
  ctx: ApiContext,
  body: Record<string, unknown> | null,
): Promise<Response> {
  const { env } = ctx;
  const configuredToken = env.ADMIN_BOOTSTRAP_TOKEN?.trim();
  if (!configuredToken) {
    return errorResponse("Admin setup is not configured. Add ADMIN_BOOTSTRAP_TOKEN to the server environment.", 503);
  }
  if (!body || typeof body.bootstrapToken !== "string" || typeof body.password !== "string") {
    return errorResponse("A valid setup token and password are required.", 400);
  }

  const configuredEmail = env.ADMIN_EMAIL?.trim().toLowerCase();
  const submittedEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!configuredEmail || submittedEmail !== configuredEmail) {
    return errorResponse("The setup email does not match the authorized administrator.", 403);
  }

  const supplied = await digest(body.bootstrapToken.trim());
  const expected = await digest(configuredToken);
  if (!constantTimeEqual(supplied, expected)) {
    return errorResponse("The setup token is not valid.", 403);
  }
  if (body.password.length < 12 || body.password.length > 128) {
    return errorResponse("Use a password between 12 and 128 characters.", 400);
  }

  const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) {
    return errorResponse("Initial administrator setup has already been completed.", 409);
  }

  const name = typeof body.name === "string" && body.name.trim().length >= 2
    ? body.name.trim().slice(0, 100)
    : "Administrator";
  const id = crypto.randomUUID();
  const hash = await createPasswordHash(body.password);
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, name, email, role, status, password_hash) VALUES (?, ?, ?, 'admin', 'active', ?)",
    ).bind(id, name, configuredEmail, hash).run();
  } catch (error) {
    console.error("Initial administrator setup failed.", error);
    return errorResponse("Could not create the administrator account.", 500);
  }
  return json({ message: "Administrator account created. Sign in to continue." }, 201);
}

export async function login(ctx: ApiContext, body: Record<string, unknown> | null): Promise<Response> {
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    return errorResponse("Email and password are required.", 400);
  }
  if (body.email.length > 254 || body.password.length > 128) {
    return errorResponse("Email or password is not valid.", 400);
  }
  const email = body.email.trim().toLowerCase();
  const identifierHash = await digest(
    `${email}\0${ctx.request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  );
  const identifier = Array.from(identifierHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = new Date();
  const attempt = await ctx.env.DB.prepare(
    "SELECT attempts, window_start, locked_until FROM login_attempts WHERE identifier = ?",
  ).bind(identifier).first<{ attempts: number; window_start: string; locked_until: string | null }>();
  if (attempt?.locked_until && Date.parse(attempt.locked_until) > now.getTime()) {
    return errorResponse("Too many sign-in attempts. Try again in 15 minutes.", 429);
  }
  const row = await ctx.env.DB.prepare(
    "SELECT id, name, email, role, status, password_hash FROM users WHERE email = ? COLLATE NOCASE",
  ).bind(email).first<AdminUser & { password_hash: string }>();

  const passwordMatches = await verifyPassword(body.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || row.role !== "admin" || row.status !== "active" || !passwordMatches) {
    const windowStart = attempt && Date.parse(attempt.window_start) > now.getTime() - LOGIN_WINDOW_MS
      ? attempt.window_start
      : now.toISOString();
    const attempts = attempt && windowStart === attempt.window_start ? attempt.attempts + 1 : 1;
    const lockedUntil = attempts >= MAX_LOGIN_ATTEMPTS
      ? new Date(now.getTime() + LOGIN_WINDOW_MS).toISOString()
      : null;
    await ctx.env.DB.prepare(
      `INSERT INTO login_attempts (identifier, attempts, window_start, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(identifier) DO UPDATE SET
         attempts = excluded.attempts,
         window_start = excluded.window_start,
         locked_until = excluded.locked_until`,
    ).bind(identifier, attempts, windowStart, lockedUntil).run();
    return errorResponse("Email or password is incorrect.", 401);
  }
  await ctx.env.DB.prepare("DELETE FROM login_attempts WHERE identifier = ?").bind(identifier).run();

  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digest(token);
  const tokenHashHex = Array.from(tokenHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
  await ctx.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  ).bind(tokenHashHex, row.id, expiresAt).run();
  await ctx.env.DB.prepare(
    "INSERT INTO activities (id, actor_id, action, target_id, target_name, details) VALUES (?, ?, 'admin_login', ?, ?, ?)",
  ).bind(crypto.randomUUID(), row.id, row.id, row.name, "Signed in to the dashboard").run();

  const { password_hash: _passwordHash, ...admin } = row;
  return json(
    { admin },
    200,
    { "Set-Cookie": sessionCookie(token, ctx.url.protocol === "https:", SESSION_DURATION_SECONDS) },
  );
}

export async function authenticate(ctx: ApiContext): Promise<AdminUser | null> {
  const token = cookieValue(ctx.request);
  if (!token || token.length > 256) return null;
  const tokenHash = await digest(token);
  const tokenHashHex = Array.from(tokenHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const row = await ctx.env.DB.prepare(
    `SELECT users.id, users.name, users.email, users.role, users.status
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHashHex, new Date().toISOString()).first<AdminUser>();
  return row && row.role === "admin" && row.status === "active" ? row : null;
}

export async function logout(ctx: ApiContext): Promise<Response> {
  const token = cookieValue(ctx.request);
  if (token) {
    const tokenHash = await digest(token);
    const tokenHashHex = Array.from(tokenHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await ctx.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHashHex).run();
  }
  return json(
    { message: "Signed out." },
    200,
    { "Set-Cookie": sessionCookie("", ctx.url.protocol === "https:", 0) },
  );
}
