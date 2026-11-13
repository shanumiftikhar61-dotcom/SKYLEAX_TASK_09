import {
  Activity as ActivityIcon,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Eye,
  Filter,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import {
  ArcElement,
  Chart as ChartJS,
  Legend,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from "chart.js";
import { Doughnut, Line } from "react-chartjs-2";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Activity, type Admin, type DashboardData, type UserInput, type UserList, type UserRecord, type UserRole, type UserStatus } from "./api";

ChartJS.register(ArcElement, Legend, LineElement, PointElement, CategoryScale, LinearScale, Tooltip);

type View = "overview" | "users" | "activity" | "profile";
type SortField = "name" | "email" | "role" | "status" | "createdAt";
type Notice = { message: string; kind: "success" | "error" };

const EMPTY_DASHBOARD: DashboardData = {
  stats: {
    totalUsers: 0,
    activeUsers: 0,
    pendingRequests: 0,
    inactiveUsers: 0,
    totalRecords: 0,
    registrationsThisMonth: 0,
    totalActivities: 0,
  },
  charts: { growth: [], roles: [], status: [] },
  activities: [],
};

const roleLabels: Record<string, string> = {
  admin: "Administrator",
  manager: "Manager",
  editor: "Editor",
  viewer: "Viewer",
  user: "User",
};

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return formatDate(value);
}

function friendlyError(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Check your connection and try again.";
}

function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [authScreen, setAuthScreen] = useState<"checking" | "login" | "setup">("checking");
  const [setupReady, setSetupReady] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [dashboard, setDashboard] = useState<DashboardData>(EMPTY_DASHBOARD);
  const [userList, setUserList] = useState<UserList>({ records: [], page: 1, pageSize: 10, total: 0, totalPages: 0 });
  const [activityList, setActivityList] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [modal, setModal] = useState<{ type: "create" | "edit" | "view"; record?: UserRecord } | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeFilter, setActiveFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const notify = useCallback((message: string, kind: Notice["kind"] = "success") => {
    setNotice({ message, kind });
    window.setTimeout(() => setNotice(null), 4200);
  }, []);

  useEffect(() => {
    let active = true;
    api<{ setupRequired: boolean; setupReady: boolean; authenticated: boolean }>("/api/auth/status")
      .then(async (status) => ({
        status,
        session: status.authenticated ? await api<{ admin: Admin }>("/api/auth/me") : null,
      }))
      .then(({ status, session }) => {
      if (!active) return;
      setSetupReady(status.setupReady);
      setAdmin(session?.admin ?? null);
      setAuthScreen(session?.admin ? "login" : status.setupRequired ? "setup" : "login");
      }).catch((error: unknown) => {
      if (!active) return;
      setPageError(friendlyError(error));
      setAuthScreen("login");
    });
    return () => { active = false; };
  }, []);

  const loadDashboard = useCallback(async (signal?: AbortSignal) => {
    const data = await api<DashboardData>("/api/dashboard", { signal });
    setDashboard(data);
  }, []);

  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    setBusy(true);
    loadDashboard(controller.signal)
      .then(() => setPageError(""))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPageError(friendlyError(error));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [admin, loadDashboard]);

  useEffect(() => {
    if (!admin || (view !== "users" && view !== "overview")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize),
        sort: sortField,
        direction: sortDirection,
      });
      if (search.trim()) params.set("search", search.trim());
      if (roleFilter !== "all") params.set("role", roleFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (activeFilter !== "all") params.set("active", activeFilter);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      setRecordsLoading(true);
      api<UserList>(`/api/users?${params}`, { signal: controller.signal })
        .then((result) => {
          setUserList(result);
          setPageError("");
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setPageError(friendlyError(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setRecordsLoading(false);
        });
    }, search ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      setRecordsLoading(false);
    };
  }, [admin, view, search, roleFilter, statusFilter, activeFilter, fromDate, toDate, sortField, sortDirection, currentPage, pageSize]);

  useEffect(() => {
    if (!admin || view !== "activity") return;
    const controller = new AbortController();
    api<{ activities: Activity[] }>("/api/activities?limit=50", { signal: controller.signal })
      .then(({ activities }) => setActivityList(activities))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPageError(friendlyError(error));
      });
    return () => controller.abort();
  }, [admin, view]);

  const reloadData = useCallback(async () => {
    const [dashboardData, userData] = await Promise.all([
      api<DashboardData>("/api/dashboard"),
      api<UserList>(`/api/users?${new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize),
        sort: sortField,
        direction: sortDirection,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(roleFilter !== "all" ? { role: roleFilter } : {}),
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(activeFilter !== "all" ? { active: activeFilter } : {}),
        ...(fromDate ? { from: fromDate } : {}),
        ...(toDate ? { to: toDate } : {}),
      })}`),
    ]);
    setDashboard(dashboardData);
    setUserList(userData);
  }, [activeFilter, currentPage, fromDate, pageSize, roleFilter, search, sortDirection, sortField, statusFilter, toDate]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setPageError("");
    const form = new FormData(event.currentTarget);
    const isSetup = authScreen === "setup";
    try {
      if (isSetup) {
        await api("/api/auth/setup", {
          method: "POST",
          body: {
            email: "shanumiftikhar61@gmail.com",
            name: String(form.get("name") ?? ""),
            bootstrapToken: String(form.get("bootstrapToken") ?? ""),
            password: String(form.get("password") ?? ""),
          },
        });
        setAuthScreen("login");
        notify("Administrator set up. You can now sign in.");
      } else {
        const result = await api<{ admin: Admin }>("/api/auth/login", {
          method: "POST",
          body: { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") },
        });
        setAdmin(result.admin);
        setView("overview");
        notify(`Welcome back, ${result.admin.name}.`);
      }
    } catch (error) {
      setPageError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setAdmin(null);
      setAuthScreen("login");
      setView("overview");
      notify("You have been signed out.");
    } catch (error) {
      setPageError(friendlyError(error));
    }
  }

  function clearFilters() {
    setSearch("");
    setRoleFilter("all");
    setStatusFilter("all");
    setActiveFilter("all");
    setFromDate("");
    setToDate("");
    setCurrentPage(1);
  }

  function changeFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setCurrentPage(1);
  }

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal) return;
    setBusy(true);
    setPageError("");
    const form = new FormData(event.currentTarget);
    const input: UserInput = {
      name: String(form.get("name") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      role: String(form.get("role") ?? "user") as UserRole,
      status: String(form.get("status") ?? "active") as UserStatus,
    };
    try {
      if (modal.type === "edit" && modal.record) {
        await api(`/api/users/${encodeURIComponent(modal.record.id)}`, { method: "PUT", body: input });
        notify("Record updated successfully.");
      } else {
        await api("/api/users", { method: "POST", body: input });
        notify("New record created successfully.");
        setCurrentPage(1);
      }
      setModal(null);
      await reloadData();
    } catch (error) {
      setPageError(friendlyError(error));
      notify(friendlyError(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord(record: UserRecord) {
    if (record.role === "admin") {
      notify("Administrator accounts cannot be deleted here.", "error");
      return;
    }
    if (!window.confirm(`Delete ${record.name} (${record.email})? This action cannot be undone.`)) return;
    setBusy(true);
    try {
      await api(`/api/users/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      notify("Record deleted.");
      if (userList.records.length === 1 && currentPage > 1) setCurrentPage(currentPage - 1);
      await reloadData();
    } catch (error) {
      setPageError(friendlyError(error));
      notify(friendlyError(error), "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleSort(field: SortField) {
    setCurrentPage(1);
    if (sortField === field) setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    else {
      setSortField(field);
      setSortDirection("asc");
    }
  }

  const filtered = Boolean(search || roleFilter !== "all" || statusFilter !== "all" || activeFilter !== "all" || fromDate || toDate);
  const pageItems = useMemo(() => {
    const total = userList.totalPages;
    if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1);
    const start = Math.max(1, Math.min(currentPage - 2, total - 4));
    return Array.from({ length: 5 }, (_, index) => start + index);
  }, [currentPage, userList.totalPages]);

  if (authScreen === "checking") {
    return <div className="loading-screen"><LoaderCircle className="spin" size={22} /> Checking your session…</div>;
  }

  if (!admin) {
    const setup = authScreen === "setup";
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="brand-mark"><ShieldCheck size={23} strokeWidth={2.2} /></div>
          <p className="eyebrow">{setup ? "SECURE ACCOUNT SETUP" : "ADMINISTRATOR PORTAL"}</p>
          <h1>{setup ? "Set up your admin account" : "Welcome back"}</h1>
          <p className="auth-subtitle">
            {setup
              ? "Create the first administrator account to get your workspace ready."
              : "Sign in with your administrator credentials to continue."}
          </p>
          {pageError && <div className="inline-alert error" role="alert">{pageError}</div>}
          {setup && !setupReady && (
            <div className="inline-alert error" role="alert">
              Admin setup is not configured on the server. Add the setup token and refresh this page.
            </div>
          )}
          {setup && (
            <div className="account-notice">
              <ShieldCheck size={17} />
              <span>Administrator account</span>
              <strong>shanumiftikhar61@gmail.com</strong>
            </div>
          )}
          <form onSubmit={submitAuth} className="form-stack">
            {setup && <Field label="Your name"><input name="name" autoComplete="name" minLength={2} maxLength={100} placeholder="e.g. Alex Morgan" required /></Field>}
            {setup && <Field label="One-time setup token"><input name="bootstrapToken" type="password" autoComplete="off" required disabled={!setupReady} /></Field>}
            {!setup && <Field label="Email address"><input name="email" type="email" autoComplete="username" placeholder="you@company.com" required /></Field>}
            <Field label="Password"><input name="password" type="password" autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 12 : undefined} required disabled={setup && !setupReady} /></Field>
            {setup && <p className="field-note">Use at least 12 characters. Your password is securely hashed before it is stored.</p>}
            <button type="submit" className="button primary full" disabled={busy || (setup && !setupReady)}>
              {busy ? <LoaderCircle size={16} className="spin" /> : null}
              {busy ? "Please wait…" : setup ? "Create administrator account" : "Sign in"}
            </button>
          </form>
          <p className="auth-footer"><ShieldCheck size={14} /> Protected by secure, httpOnly sessions</p>
        </div>
        <div className="auth-side-note">SKYLEAX <span>·</span> ADMINISTRATION</div>
      </main>
    );
  }

  const isOverview = view === "overview";
  return (
    <div className="app-shell">
      {mobileMenuOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}
      <aside className={`sidebar ${mobileMenuOpen ? "is-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark small"><ShieldCheck size={20} /></div>
          <div><strong>SKYLEAX</strong><span>ADMIN CONSOLE</span></div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}><X size={18} /></button>
        </div>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <NavItem active={view === "overview"} icon={<LayoutDashboard size={18} />} label="Overview" onClick={() => { setView("overview"); setMobileMenuOpen(false); }} />
          <NavItem active={view === "users"} icon={<UsersRound size={18} />} label="User management" badge={dashboard.stats.totalUsers} onClick={() => { setView("users"); setMobileMenuOpen(false); }} />
          <NavItem active={view === "activity"} icon={<ActivityIcon size={18} />} label="Activity log" onClick={() => { setView("activity"); setMobileMenuOpen(false); }} />
        </nav>
        <div className="sidebar-section-label tools-label">SUPPORT</div>
        <button className="nav-item support-item" onClick={() => notify("For account access, contact your system administrator.")}>
          <CircleHelp size={18} /><span>Help & support</span>
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-status"><span className="status-dot" /> All systems operational</div>
          <button className={`profile-menu ${view === "profile" ? "selected" : ""}`} onClick={() => { setView("profile"); setMobileMenuOpen(false); }}>
            <span className="avatar">{initials(admin.name)}</span>
            <span className="profile-copy"><strong>{admin.name}</strong><small>Administrator</small></span>
            <ChevronDown size={16} className="profile-chevron" />
          </button>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{viewTitle(view)}</strong></div>
          <div className="topbar-actions">
            <span className="workspace-label">ADMIN WORKSPACE</span>
            <button className="icon-button notification-button" aria-label="View activity" onClick={() => setView("activity")}><Bell size={18} /><i /></button>
            <div className="topbar-divider" />
            <button className="topbar-user" onClick={() => setView("profile")} aria-label="Open administrator profile">
              <span className="avatar small-avatar">{initials(admin.name)}</span><span>{admin.name}</span><ChevronDown size={15} />
            </button>
          </div>
        </header>

        <main className="page-content">
          {pageError && (
            <div className="inline-alert error global-alert" role="alert">
              <span>{pageError}</span><button className="alert-dismiss" aria-label="Dismiss error" onClick={() => setPageError("")}><X size={16} /></button>
            </div>
          )}
          {isOverview && (
            <Overview
              admin={admin}
              dashboard={dashboard}
              records={userList.records}
              busy={busy}
              onViewUsers={() => setView("users")}
              onViewActivity={() => setView("activity")}
              onAdd={() => setModal({ type: "create" })}
              onRecord={(record) => setModal({ type: "view", record })}
            />
          )}
          {view === "users" && (
            <section>
              <div className="page-heading heading-with-action">
                <div><div className="eyebrow">DIRECTORY</div><h1>User management</h1><p>Manage account access, roles, and status across your workspace.</p></div>
                <button className="button primary" onClick={() => setModal({ type: "create" })}><Plus size={17} /> Add user</button>
              </div>
              <div className="toolbar-card">
                <label className="search-field">
                  <Search size={17} />
                  <input aria-label="Search users" placeholder="Search name, email or ID…" value={search} onChange={(event) => changeFilter(setSearch, event.target.value)} />
                  {search && <button aria-label="Clear search" onClick={() => changeFilter(setSearch, "")}><X size={15} /></button>}
                </label>
                <div className="filter-divider" />
                <label className="filter-select"><UsersRound size={15} /><select aria-label="Filter by role" value={roleFilter} onChange={(event) => changeFilter(setRoleFilter, event.target.value)}><option value="all">All roles</option><option value="admin">Administrator</option><option value="manager">Manager</option><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="user">User</option></select><ChevronDown size={14} /></label>
                <label className="filter-select"><Filter size={15} /><select aria-label="Filter by status" value={statusFilter} onChange={(event) => changeFilter(setStatusFilter, event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="inactive">Inactive</option></select><ChevronDown size={14} /></label>
                <label className="filter-select active-filter"><select aria-label="Filter active users" value={activeFilter} onChange={(event) => changeFilter(setActiveFilter, event.target.value)}><option value="all">All accounts</option><option value="true">Active only</option><option value="false">Inactive / pending</option></select><ChevronDown size={14} /></label>
              </div>
              <div className="date-filter-row">
                <span><CalendarDays size={15} /> Created between</span>
                <input type="date" aria-label="Created from date" value={fromDate} max={toDate || undefined} onChange={(event) => changeFilter(setFromDate, event.target.value)} />
                <span className="date-separator">and</span>
                <input type="date" aria-label="Created to date" value={toDate} min={fromDate || undefined} onChange={(event) => changeFilter(setToDate, event.target.value)} />
                {filtered && <button className="text-button clear-filter" onClick={clearFilters}>Clear filters</button>}
                <span className="result-count">{recordsLoading ? "Updating…" : `${userList.total.toLocaleString()} ${userList.total === 1 ? "record" : "records"}`}</span>
              </div>
              {recordsLoading && <div className="records-loading" role="status"><LoaderCircle size={14} className="spin" /> Updating records…</div>}
              <UserTable
                records={userList.records}
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={toggleSort}
                onView={(record) => setModal({ type: "view", record })}
                onEdit={(record) => setModal({ type: "edit", record })}
                onDelete={deleteRecord}
                onAdd={() => setModal({ type: "create" })}
                filtered={filtered}
                onClearFilters={clearFilters}
              />
              <Pagination page={userList.page} pageSize={pageSize} total={userList.total} totalPages={userList.totalPages} pages={pageItems} onPage={setCurrentPage} onPageSize={(size) => { setPageSize(size); setCurrentPage(1); }} />
            </section>
          )}
          {view === "activity" && <ActivityPage activities={activityList} />}
          {view === "profile" && <ProfilePage admin={admin} onLogout={signOut} />}
        </main>
        <footer className="page-footer"><span>Skyleax Admin</span><span>Secure workspace · {new Date().getFullYear()}</span></footer>
      </div>

      {modal && <RecordModal modal={modal} busy={busy} onClose={() => setModal(null)} onSubmit={saveRecord} onEdit={() => setModal({ type: "edit", record: modal.record })} />}
      {notice && <div className={`toast ${notice.kind}`} role="status"><span className="toast-icon">{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}</span>{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    </div>
  );
}

function viewTitle(view: View): string {
  return { overview: "Overview", users: "User management", activity: "Activity log", profile: "My profile" }[view];
}

function NavItem({ active, icon, label, badge, onClick }: { active: boolean; icon: ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span>{badge !== undefined && <span className="nav-badge">{badge}</span>}</button>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>;
}

function Overview({ admin, dashboard, records, busy, onViewUsers, onViewActivity, onAdd, onRecord }: {
  admin: Admin;
  dashboard: DashboardData;
  records: UserRecord[];
  busy: boolean;
  onViewUsers: () => void;
  onViewActivity: () => void;
  onAdd: () => void;
  onRecord: (record: UserRecord) => void;
}) {
  const stats = dashboard.stats;
  const rate = stats.totalUsers ? Math.round((stats.activeUsers / stats.totalUsers) * 100) : 0;
  const statusChart = {
    labels: ["Active", "Inactive", "Pending"],
    datasets: [{
      data: dashboard.charts.status.map((item) => item.count),
      backgroundColor: ["#258265", "#d9e0eb", "#e7aa3d"],
      borderWidth: 0,
      hoverOffset: 3,
    }],
  };
  const roleChart = {
    labels: dashboard.charts.roles.map((item) => roleLabels[item.role] ?? item.role),
    datasets: [{
      data: dashboard.charts.roles.map((item) => item.count),
      backgroundColor: ["#4569d4", "#63a6a4", "#8f7fd4", "#e9ab4e", "#c5d0df"],
      borderWidth: 0,
      hoverOffset: 3,
    }],
  };
  const lineChart = {
    labels: dashboard.charts.growth.map((item) => {
      const [year, month] = item.month.split("-").map(Number);
      return new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(year, month - 1, 1));
    }),
    datasets: [{
      label: "Registrations",
      data: dashboard.charts.growth.map((item) => item.count),
      borderColor: "#4668d7",
      backgroundColor: "rgba(70, 104, 215, 0.1)",
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: "#fff",
      pointBorderWidth: 2,
      tension: 0.35,
      fill: true,
    }],
  };
  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: "72%",
    plugins: {
      legend: { position: "bottom" as const, labels: { color: "#66738a", usePointStyle: true, pointStyle: "circle" as const, boxWidth: 7, boxHeight: 7, padding: 18, font: { size: 11 } } },
      tooltip: { backgroundColor: "#17233d", padding: 10, cornerRadius: 7 },
    },
  };
  const lineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: "#17233d", padding: 10, cornerRadius: 7 } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: "#8691a3", font: { size: 11 } } },
      y: { beginAtZero: true, border: { display: false, dash: [3, 5] }, grid: { color: "#edf0f5" }, ticks: { precision: 0, color: "#8691a3", font: { size: 11 }, padding: 8 } },
    },
  };

  return (
    <>
      <div className="welcome-strip">
        <div><div className="eyebrow">TODAY, {new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase()}</div><h1>Good to see you, {admin.name.split(" ")[0]} <span>✦</span></h1><p>Here’s what’s happening across your workspace today.</p></div>
        <button className="button primary" onClick={onAdd}><Plus size={17} /> Add user</button>
      </div>
      <div className="section-title"><div><h2>Workspace overview</h2><span>Real-time account and activity summary</span></div><div className="live-indicator"><span className="status-dot" /> Live data</div></div>
      {busy && stats.totalUsers === 0 && <div className="loading-inline"><LoaderCircle size={17} className="spin" /> Loading workspace data…</div>}
      <div className="stat-grid">
        <StatCard label="Total users" value={stats.totalUsers} icon={<UsersRound size={19} />} tone="blue" foot={`${stats.registrationsThisMonth} registered this month`} />
        <StatCard label="Active users" value={stats.activeUsers} icon={<ActivityIcon size={19} />} tone="green" foot={`${rate}% of all accounts`} />
        <StatCard label="Pending requests" value={stats.pendingRequests} icon={<ClipboardList size={19} />} tone="amber" foot="Awaiting review" />
        <StatCard label="Total records" value={stats.totalRecords} icon={<ShieldCheck size={19} />} tone="violet" foot={`${stats.totalActivities} recorded actions`} />
      </div>

      <div className="section-title analytics-heading"><div><h2>Analytics</h2><span>Account activity based on stored records</span></div></div>
      <div className="charts-grid">
        <ChartCard title="User growth" subtitle="New registrations · last 6 months" className="growth-card">
          {dashboard.charts.growth.length ? <div className="line-chart"><Line data={lineChart} options={lineOptions} /></div> : <ChartEmpty />}
        </ChartCard>
        <ChartCard title="Account status" subtitle="Current user distribution">
          <div className="doughnut-chart"><Doughnut data={statusChart} options={doughnutOptions} /><div className="doughnut-center"><strong>{stats.totalUsers}</strong><span>users</span></div></div>
        </ChartCard>
        <ChartCard title="Role distribution" subtitle="Users by assigned role">
          <div className="doughnut-chart">{dashboard.charts.roles.length ? <Doughnut data={roleChart} options={doughnutOptions} /> : <ChartEmpty compact />}<div className="doughnut-center"><strong>{stats.totalUsers}</strong><span>users</span></div></div>
        </ChartCard>
      </div>

      <div className="section-title table-section-title"><div><h2>Recent users</h2><span>Latest accounts added to your workspace</span></div><button className="text-button" onClick={onViewUsers}>View all users <ArrowRight size={15} /></button></div>
      {records.length ? <div className="table-card"><table className="user-table compact-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created</th><th aria-label="Actions" /></tr></thead><tbody>{records.slice(0, 5).map((record) => <tr key={record.id}><td><button className="user-cell" onClick={() => onRecord(record)}><span className="avatar row-avatar">{initials(record.name)}</span><span><strong>{record.name}</strong><small>{record.email}</small></span></button></td><td><span className={`role-label role-${record.role}`}>{roleLabels[record.role]}</span></td><td><StatusPill status={record.status} /></td><td className="date-cell">{formatDate(record.created_at)}</td><td><button className="icon-button row-view" aria-label={`View ${record.name}`} onClick={() => onRecord(record)}><Eye size={16} /></button></td></tr>)}</tbody></table><button className="mobile-view-all" onClick={onViewUsers}>View all users <ArrowRight size={15} /></button></div> : <EmptyState title="No user records yet" detail="Add your first user to start seeing workspace analytics." action="Add first user" onAction={onAdd} />}

      <div className="activity-preview">
        <div className="section-title"><div><h2>Recent activity</h2><span>Latest changes across your workspace</span></div><button className="text-button" onClick={onViewActivity}>View activity log <ArrowRight size={15} /></button></div>
        <ActivityFeed activities={dashboard.activities.slice(0, 4)} />
      </div>
    </>
  );
}

function StatCard({ label, value, icon, tone, foot }: { label: string; value: number; icon: ReactNode; tone: string; foot: string }) {
  return <article className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><span className="stat-label">{label}</span><strong className="stat-value">{value.toLocaleString()}</strong><span className="stat-foot">{foot}</span></article>;
}

function ChartCard({ title, subtitle, className = "", children }: { title: string; subtitle: string; className?: string; children: ReactNode }) {
  return <article className={`chart-card ${className}`}><div className="chart-card-heading"><div><h3>{title}</h3><span>{subtitle}</span></div></div>{children}</article>;
}

function ChartEmpty({ compact = false }: { compact?: boolean }) {
  return <div className={`chart-empty ${compact ? "compact" : ""}`}>{compact ? "No records yet" : "Registration data will appear here as accounts are added."}</div>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}><span />{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function SortButton({ field, label, sortField, sortDirection, onSort }: { field: SortField; label: string; sortField: SortField; sortDirection: "asc" | "desc"; onSort: (field: SortField) => void }) {
  const active = sortField === field;
  return <button className={`sort-button ${active ? "sorted" : ""}`} onClick={() => onSort(field)}>{label}{active ? sortDirection === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ArrowDown size={12} className="sort-hint" />}</button>;
}

function UserTable({ records, sortField, sortDirection, onSort, onView, onEdit, onDelete, onAdd, filtered, onClearFilters }: {
  records: UserRecord[];
  sortField: SortField;
  sortDirection: "asc" | "desc";
  onSort: (field: SortField) => void;
  onView: (record: UserRecord) => void;
  onEdit: (record: UserRecord) => void;
  onDelete: (record: UserRecord) => void;
  onAdd: () => void;
  filtered: boolean;
  onClearFilters: () => void;
}) {
  if (records.length === 0) {
    return <div className="table-card"><EmptyState title={filtered ? "No users match these filters" : "No users yet"} detail={filtered ? "Try changing your search or clearing one or more filters." : "Create a user record to start managing workspace access."} action={filtered ? "Clear filters" : "Add a user"} onAction={filtered ? onClearFilters : onAdd} /></div>;
  }
  return (
    <div className="table-card">
      <div className="table-scroll"><table className="user-table"><thead><tr><th><SortButton field="name" label="Name" sortField={sortField} sortDirection={sortDirection} onSort={onSort} /></th><th><SortButton field="email" label="Email" sortField={sortField} sortDirection={sortDirection} onSort={onSort} /></th><th><SortButton field="role" label="Role" sortField={sortField} sortDirection={sortDirection} onSort={onSort} /></th><th><SortButton field="status" label="Status" sortField={sortField} sortDirection={sortDirection} onSort={onSort} /></th><th><SortButton field="createdAt" label="Created" sortField={sortField} sortDirection={sortDirection} onSort={onSort} /></th><th className="actions-heading">Actions</th></tr></thead>
      <tbody>{records.map((record) => <tr key={record.id}>
        <td><button className="user-cell" onClick={() => onView(record)}><span className="avatar row-avatar">{initials(record.name)}</span><span><strong>{record.name}</strong><small>{record.id}</small></span></button></td>
        <td className="email-cell">{record.email}</td>
        <td><span className={`role-label role-${record.role}`}>{roleLabels[record.role]}</span></td>
        <td><StatusPill status={record.status} /></td>
        <td className="date-cell">{formatDate(record.created_at)}</td>
        <td><div className="row-actions"><button className="icon-button" aria-label={`View ${record.name}`} title="View record" onClick={() => onView(record)}><Eye size={16} /></button><button className="icon-button" aria-label={`Edit ${record.name}`} title="Edit record" onClick={() => onEdit(record)} disabled={record.role === "admin"}><Pencil size={15} /></button><button className="icon-button danger-action" aria-label={`Delete ${record.name}`} title="Delete record" onClick={() => onDelete(record)} disabled={record.role === "admin"}><Trash2 size={15} /></button></div></td>
      </tr>)}</tbody></table></div>
      <div className="table-mobile-summary">{records.length} {records.length === 1 ? "record" : "records"} on this page</div>
    </div>
  );
}

function EmptyState({ title, detail, action, onAction }: { title: string; detail: string; action: string; onAction: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><UsersRound size={22} /></div><h3>{title}</h3><p>{detail}</p><button className="button secondary" onClick={onAction}>{action}</button></div>;
}

function Pagination({ page, pageSize, total, totalPages, pages, onPage, onPageSize }: { page: number; pageSize: number; total: number; totalPages: number; pages: number[]; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  if (total === 0) return <div className="pagination pagination-empty"><span>Showing 0 of 0 records</span></div>;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return <div className="pagination"><span className="pagination-summary">Showing <strong>{start}–{end}</strong> of <strong>{total.toLocaleString()}</strong></span><label className="rows-select">Rows per page<select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label><div className="page-controls"><button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={17} /></button>{pages.map((item) => <button key={item} className={`page-number ${page === item ? "current" : ""}`} aria-current={page === item ? "page" : undefined} onClick={() => onPage(item)}>{item}</button>)}<button className="icon-button" aria-label="Next page" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight size={17} /></button></div></div>;
}

function ActivityFeed({ activities }: { activities: Activity[] }) {
  const iconFor = (action: Activity["action"]) => action === "registration" ? <Plus size={15} /> : action === "deletion" ? <Trash2 size={15} /> : action === "admin_login" ? <ShieldCheck size={15} /> : <Pencil size={15} />;
  const toneFor = (action: Activity["action"]) => action === "registration" ? "green" : action === "deletion" ? "red" : action === "admin_login" ? "blue" : "amber";
  if (!activities.length) return <div className="activity-empty"><ActivityIcon size={18} /><span>Activity will appear here as your team works.</span></div>;
  return <div className="activity-feed">{activities.map((activity) => <div className="activity-item" key={activity.id}><span className={`activity-icon ${toneFor(activity.action)}`}>{iconFor(activity.action)}</span><span className="activity-copy"><strong>{activity.details}</strong><small>{activity.actor_name ?? "System"} · {activity.target_name}</small></span><time>{formatRelative(activity.created_at)}</time></div>)}</div>;
}

function ActivityPage({ activities }: { activities: Activity[] }) {
  return <section><div className="page-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h1>Activity log</h1><p>A transparent record of account changes and administrator actions.</p></div></div><div className="section-title activity-page-title"><div><h2>Recent events</h2><span>Latest 50 stored activities</span></div><span className="audit-badge"><ShieldCheck size={14} /> Audit trail</span></div><div className="panel activity-panel"><ActivityFeed activities={activities} /></div></section>;
}

function ProfilePage({ admin, onLogout }: { admin: Admin; onLogout: () => void }) {
  return <section><div className="page-heading"><div><div className="eyebrow">ACCOUNT</div><h1>My profile</h1><p>Your administrator account and security settings.</p></div></div><div className="panel profile-panel"><div className="profile-hero"><span className="avatar profile-avatar">{initials(admin.name)}</span><div><h2>{admin.name}</h2><span>{admin.email}</span></div><span className="role-label role-admin">Administrator</span></div><div className="profile-details"><div><span>Full name</span><strong>{admin.name}</strong></div><div><span>Email address</span><strong>{admin.email}</strong></div><div><span>Account role</span><strong>Administrator</strong></div><div><span>Account status</span><strong><StatusPill status={admin.status} /></strong></div><div><span>Account ID</span><strong className="profile-id">{admin.id}</strong></div></div><div className="security-note"><ShieldCheck size={19} /><div><strong>Protected administrator access</strong><p>Your session is encrypted, httpOnly, and automatically expires after 8 hours.</p></div></div><button className="button secondary logout-button" onClick={onLogout}><LogOut size={16} /> Sign out securely</button></div></section>;
}

function RecordModal({ modal, busy, onClose, onSubmit, onEdit }: { modal: { type: "create" | "edit" | "view"; record?: UserRecord }; busy: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onEdit: () => void }) {
  const record = modal.record;
  const isView = modal.type === "view";
  const isEdit = modal.type === "edit";
  const title = isView ? "User details" : isEdit ? "Edit user" : "Add a user";
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div className="modal-header"><div><div className="eyebrow">{isView ? "ACCOUNT RECORD" : isEdit ? "UPDATE ACCOUNT" : "NEW ACCOUNT"}</div><h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19} /></button></div>
    {isView && record ? <div className="record-detail"><div className="detail-person"><span className="avatar detail-avatar">{initials(record.name)}</span><span><strong>{record.name}</strong><small>{record.email}</small></span></div><div className="detail-grid"><div><span>Record ID</span><strong>{record.id}</strong></div><div><span>Role</span><strong>{roleLabels[record.role]}</strong></div><div><span>Status</span><strong><StatusPill status={record.status} /></strong></div><div><span>Created</span><strong>{formatDate(record.created_at)}</strong></div><div><span>Last updated</span><strong>{formatDate(record.updated_at)}</strong></div></div><div className="modal-actions"><button className="button secondary" onClick={onClose}>Close</button><button className="button primary" onClick={onEdit} disabled={record.role === "admin"}><Pencil size={15} /> Edit record</button></div></div> : <form onSubmit={onSubmit} className="record-form"><Field label="Full name"><input name="name" defaultValue={record?.name ?? ""} placeholder="e.g. Jordan Lee" minLength={2} maxLength={100} autoComplete="name" required /></Field><Field label="Email address"><input name="email" type="email" defaultValue={record?.email ?? ""} placeholder="name@company.com" maxLength={254} autoComplete="email" required /></Field><div className="form-grid"><Field label="Role"><select name="role" defaultValue={record?.role === "admin" ? "user" : record?.role ?? "user"} required><option value="manager">Manager</option><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="user">User</option></select></Field><Field label="Account status"><select name="status" defaultValue={record?.status ?? "active"} required><option value="active">Active</option><option value="pending">Pending</option><option value="inactive">Inactive</option></select></Field></div><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{isEdit ? "Save changes" : "Create user"}</button></div></form>}
  </section></div>;
}

export default App;
