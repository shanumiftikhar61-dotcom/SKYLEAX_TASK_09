export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    signal: options.signal,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let payload: { error?: string } & Record<string, unknown>;
  try {
    payload = await response.json() as { error?: string } & Record<string, unknown>;
  } catch {
    throw new ApiError("The server returned an unreadable response.", response.status);
  }
  if (!response.ok) {
    throw new ApiError(payload.error ?? "The request could not be completed.", response.status);
  }
  return payload as T;
}

export interface Admin {
  id: string;
  name: string;
  email: string;
  role: "admin";
  status: "active";
}

export type UserRole = "manager" | "editor" | "viewer" | "user";
export type UserStatus = "active" | "pending" | "inactive";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: UserRole | "admin";
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface Activity {
  id: string;
  action: "registration" | "update" | "deletion" | "admin_login";
  target_id: string | null;
  target_name: string;
  details: string;
  created_at: string;
  actor_name: string | null;
}

export interface DashboardData {
  stats: {
    totalUsers: number;
    activeUsers: number;
    pendingRequests: number;
    inactiveUsers: number;
    totalRecords: number;
    registrationsThisMonth: number;
    totalActivities: number;
  };
  charts: {
    growth: { month: string; count: number }[];
    roles: { role: string; count: number }[];
    status: { status: string; count: number }[];
  };
  activities: Activity[];
}

export interface UserList {
  records: UserRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UserInput {
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}
