export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_EMAIL: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: "admin";
  status: "active";
}

export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "editor" | "viewer" | "user";
  status: "active" | "pending" | "inactive";
  created_at: string;
  updated_at: string;
}

export interface ApiContext {
  env: Env;
  request: Request;
  url: URL;
  admin?: AdminUser;
}

declare global {
  interface Env {
    ADMIN_BOOTSTRAP_TOKEN?: string;
  }

  namespace Cloudflare {
    interface Env {
      ADMIN_BOOTSTRAP_TOKEN?: string;
    }
  }
}
