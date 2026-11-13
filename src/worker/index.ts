import {
  authenticate,
  createInitialAdmin,
  errorResponse,
  guardOrigin,
  json,
  login,
  logout,
  readJson,
} from "./auth";
import { handleProtectedRequest, isAdmin } from "./records";
import type { ApiContext, Env } from "./types";

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ctx: ApiContext = { env, request, url };
  try {
    if (!guardOrigin(request, url)) return errorResponse("Cross-origin requests are not allowed.", 403);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ status: "ok" });
    }
    if (url.pathname === "/api/auth/status" && request.method === "GET") {
      const [count, admin] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
        authenticate(ctx),
      ]);
      return json({
        setupRequired: (count?.count ?? 0) === 0,
        setupReady: Boolean(env.ADMIN_BOOTSTRAP_TOKEN && env.ADMIN_EMAIL),
        authenticated: Boolean(admin),
      });
    }
    if (url.pathname === "/api/auth/setup" && request.method === "POST") {
      return createInitialAdmin(ctx, await readJson(request));
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return login(ctx, await readJson(request));
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return logout(ctx);
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const admin = await authenticate(ctx);
      return admin ? json({ admin }) : errorResponse("Authentication required.", 401);
    }

    if (!url.pathname.startsWith("/api/")) return errorResponse("Not found.", 404);
    const admin = await authenticate(ctx);
    if (!admin || !isAdmin(admin)) return errorResponse("Authentication required.", 401);
    ctx.admin = admin;
    const body = request.method === "POST" || request.method === "PUT"
      ? await readJson(request)
      : null;
    if ((request.method === "POST" || request.method === "PUT") && body === null) {
      return errorResponse("Request body must be valid JSON.", 400);
    }
    return handleProtectedRequest(ctx, body);
  } catch (error) {
    console.error("Dashboard API request failed.", error);
    return errorResponse("The request could not be completed. Please try again.", 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
