/* ============================================================
   WatchVIM CMS Portal app.js (Admin)
   - Loads /config.json (CMS root)
   - Initializes Supabase (anon key)
   - Admin login via Supabase
   - Fetches users + PayPal subscription info via /api/admin/users
   - Simple tabbed CMS shell + Users table
   ============================================================ */

(() => {
  // ---------------------------
  // CONFIG
  // ---------------------------
  const DEFAULT_CONFIG = {
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    CMS_API_BASE: "/api/admin",   // your Vercel serverless route base
    THEME: {
      accent: "#e50914"
    }
  };

  let CONFIG = { ...DEFAULT_CONFIG };

  // ---------------------------
  // STATE
  // ---------------------------
  const state = {
    supabase: null,
    session: null,
    user: null,
    activeTab: "content",
    users: [],
    usersLoading: false,
    usersError: "",
    usersQuery: ""
  };

  const root = document.getElementById("app") || document.body;

  // ---------------------------
  // UTIL
  // ---------------------------
  function esc(str = "") {
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function fmtDate(d) {
    try {
      const dt = new Date(d);
      if (Number.isNaN(dt.getTime())) return "";
      return dt.toLocaleString();
    } catch {
      return "";
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function setAccent() {
    document.documentElement.style.setProperty("--watch-accent", CONFIG.THEME?.accent || "#e50914");
  }

  // ---------------------------
  // LOAD CONFIG.JSON
  // ---------------------------
  async function loadConfigJSON() {
    try {
      const res = await fetch(`/config.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        CONFIG = { ...DEFAULT_CONFIG, ...json };
      }
    } catch (e) {
      console.warn("config.json not found, using defaults.");
    }
    setAccent();
  }

  // ---------------------------
  // SUPABASE INIT + AUTH
  // ---------------------------
  async function initSupabaseCMS() {
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
      console.warn("Supabase not configured in config.json");
      return;
    }

    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    state.supabase = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );

    const { data } = await state.supabase.auth.getSession();
    state.session = data.session || null;
    state.user = data.session?.user || null;

    state.supabase.auth.onAuthStateChange((_event, newSession) => {
      state.session = newSession;
      state.user = newSession?.user || null;
      render();
    });
  }

  async function cmsLogin(email, password) {
    if (!state.supabase) return alert("Supabase not ready.");
    const { data, error } = await state.supabase.auth.signInWithPassword({
      email, password
    });
    if (error) return alert(error.message);

    state.session = data.session;
    state.user = data.session?.user || null;
    render();
  }

  async function cmsLogout() {
    if (!state.supabase) return;
    await state.supabase.auth.signOut();
    state.session = null;
    state.user = null;
    render();
  }

  // ---------------------------
  // ADMIN API CALL
  // ---------------------------
  async function fetchCMSUsers() {
    const token = state.session?.access_token;
    if (!token) {
      state.usersError = "You must log in as an admin first.";
      render();
      return [];
    }

    state.usersLoading = true;
    state.usersError = "";
    render();

    try {
      const res = await fetch(`${CONFIG.CMS_API_BASE}/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error || "Fetch users failed.");
      }

      state.users = Array.isArray(json.users) ? json.users : [];
      return state.users;
    } catch (err) {
      state.usersError = err.message || String(err);
      state.users = [];
      return [];
    } finally {
      state.usersLoading = false;
      render();
    }
  }

  // ---------------------------
  // NORMALIZERS (schema-flexible)
  // ---------------------------
  function normalizeUser(u) {
    const id = u.id || u.user_id || u.uid || "";
    const email = u.email || u.user_email || "";
    const name =
      u.full_name ||
      u.name ||
      u.profile?.full_name ||
      u.profile?.name ||
      "";
    const createdAt = u.created_at || u.createdAt || u.inserted_at || "";
    const subs =
      u.subscriptions ||
      u.subscription ||
      u.paypalSubscriptions ||
      [];

    return { id, email, name, createdAt, subs };
  }

  function normalizeSubscription(s) {
    if (!s) return null;
    return {
      id: s.id || s.subscription_id || s.paypal_subscription_id || "",
      status: s.status || s.state || "unknown",
      plan:
        s.plan_name ||
        s.plan ||
        s.tier ||
        s.plan_id ||
        "",
      start:
        s.start_date ||
        s.started_at ||
        s.start_time ||
        s.created_at ||
        "",
      nextBilling:
        s.next_billing_date ||
        s.next_bill_time ||
        s.current_period_end ||
        "",
      gateway: s.gateway || "paypal"
    };
  }

  // ---------------------------
  // UI SHELL
  // ---------------------------
  function TabButton(id, label) {
    const active = state.activeTab === id;
    return `
      <button
        class="px-3 py-2 rounded-lg text-sm font-semibold ${
          active ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"
        }"
        data-tab="${id}"
      >${label}</button>
    `;
  }

  function Header() {
    return `
      <header class="sticky top-0 z-20 bg-black/90 backdrop-blur border-b border-white/10">
        <div class="px-4 py-3 flex items-center gap-3">
          <div class="text-lg font-black tracking-wide">WatchVIM CMS</div>

          <nav class="ml-auto flex gap-2">
            ${TabButton("content", "Content")}
            ${TabButton("users", "Users")}
            ${TabButton("settings", "Settings")}
          </nav>

          <div class="ml-3 flex items-center gap-2">
            ${
              state.user
                ? `
                  <div class="text-xs text-white/70">${esc(state.user.email)}</div>
                  <button id="btnLogout"
                    class="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-sm">
                    Log out
                  </button>
                `
                : `
                  <button id="btnShowLogin"
                    class="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-sm">
                    Admin Log in
                  </button>
                `
            }
          </div>
        </div>
      </header>
    `;
  }

  function LoginPanel() {
    if (state.user) return "";
    return `
      <section class="mx-4 mt-4 p-4 rounded-2xl bg-white/5 border border-white/10">
        <h2 class="text-lg font-bold mb-2">Admin Login (Supabase)</h2>
        <div class="grid md:grid-cols-3 gap-2">
          <input id="adminEmail"
            class="px-3 py-2 rounded bg-black/40 border border-white/10 outline-none"
            placeholder="admin@email.com" />
          <input id="adminPass" type="password"
            class="px-3 py-2 rounded bg-black/40 border border-white/10 outline-none"
            placeholder="password" />
          <button id="btnLogin"
            class="px-4 py-2 rounded bg-[var(--watch-accent)] font-bold">
            Log in
          </button>
        </div>
        <div class="text-xs text-white/60 mt-2">
          You must be marked as <b>admin</b> in Supabase profiles to access users.
        </div>
      </section>
    `;
  }

  // ---------------------------
  // CONTENT TAB (placeholder)
  // ---------------------------
  function ContentTab() {
    return `
      <section class="p-4 md:p-6">
        <h2 class="text-xl font-bold mb-2">Content Management</h2>
        <div class="text-white/70 text-sm">
          Your content upload/editor UI lives here.
          (No changes made in this update.)
        </div>
      </section>
    `;
  }

  // ---------------------------
  // USERS TAB
  // ---------------------------
  function UsersTab() {
    // Filtered users based on search
    const users = state.users
      .map(normalizeUser)
      .filter(u => {
        const q = state.usersQuery.toLowerCase();
        if (!q) return true;
        return (
          u.email.toLowerCase().includes(q) ||
          u.name.toLowerCase().includes(q) ||
          String(u.id).toLowerCase().includes(q)
        );
      });

    // Stats
    let activeSubs = 0;
    let canceledSubs = 0;
    users.forEach(u => {
      (u.subs || []).forEach(s0 => {
        const s = normalizeSubscription(s0);
        if (!s) return;
        if (/active|approved/i.test(s.status)) activeSubs++;
        if (/cancel|expired|suspend/i.test(s.status)) canceledSubs++;
      });
    });

    return `
      <section class="p-4 md:p-6 space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-bold mr-auto">Users & Subscriptions</h2>

          <input id="usersSearch"
            class="px-3 py-2 rounded bg-white/10 border border-white/10 outline-none text-sm w-[240px]"
            placeholder="Search users..."
            value="${esc(state.usersQuery)}" />

          <button id="btnLoadUsers"
            class="px-4 py-2 rounded bg-white text-black font-bold text-sm">
            ${state.usersLoading ? "Loading..." : "Refresh Users"}
          </button>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div class="p-3 rounded-xl bg-white/5 border border-white/10">
            <div class="text-xs text-white/60">Total Users</div>
            <div class="text-2xl font-bold">${users.length}</div>
          </div>
          <div class="p-3 rounded-xl bg-white/5 border border-white/10">
            <div class="text-xs text-white/60">Active Subs</div>
            <div class="text-2xl font-bold">${activeSubs}</div>
          </div>
          <div class="p-3 rounded-xl bg-white/5 border border-white/10">
            <div class="text-xs text-white/60">Canceled/Expired</div>
            <div class="text-2xl font-bold">${canceledSubs}</div>
          </div>
          <div class="p-3 rounded-xl bg-white/5 border border-white/10">
            <div class="text-xs text-white/60">Gateway</div>
            <div class="text-lg font-bold">PayPal</div>
          </div>
        </div>

        ${
          state.usersError
            ? `<div class="p-3 rounded bg-red-500/20 border border-red-500/40 text-sm">
                 ${esc(state.usersError)}
               </div>`
            : ""
        }

        <div class="overflow-x-auto rounded-2xl border border-white/10">
          <table class="min-w-full text-sm">
            <thead class="bg-white/5 text-white/80">
              <tr>
                <th class="text-left p-3">Name</th>
                <th class="text-left p-3">Email</th>
                <th class="text-left p-3">User ID</th>
                <th class="text-left p-3">Joined</th>
                <th class="text-left p-3">Subscriptions (PayPal)</th>
              </tr>
            </thead>
            <tbody>
              ${
                users.length === 0 && !state.usersLoading
                  ? `<tr><td colspan="5" class="p-4 text-white/60">No users found.</td></tr>`
                  : users.map(u => {
                      const subs = (u.subs || [])
                        .map(normalizeSubscription)
                        .filter(Boolean);

                      return `
                        <tr class="border-t border-white/10 align-top">
                          <td class="p-3 font-semibold">${esc(u.name || "—")}</td>
                          <td class="p-3">${esc(u.email || "—")}</td>
                          <td class="p-3 text-xs text-white/60">${esc(u.id)}</td>
                          <td class="p-3 text-xs">${esc(fmtDate(u.createdAt))}</td>
                          <td class="p-3">
                            ${
                              subs.length
                                ? subs.map(s => `
                                    <div class="mb-2 p-2 rounded-lg bg-black/40 border border-white/10">
                                      <div class="flex items-center gap-2">
                                        <span class="text-xs px-2 py-0.5 rounded bg-white/10">
                                          ${esc(s.plan || "Plan")}
                                        </span>
                                        <span class="text-xs px-2 py-0.5 rounded ${
                                          /active|approved/i.test(s.status)
                                            ? "bg-green-500/20 text-green-200"
                                            : "bg-yellow-500/20 text-yellow-100"
                                        }">
                                          ${esc(s.status)}
                                        </span>
                                      </div>
                                      <div class="text-xs text-white/60 mt-1">
                                        Start: ${esc(fmtDate(s.start) || "—")}
                                      </div>
                                      <div class="text-xs text-white/60">
                                        Next Bill: ${esc(fmtDate(s.nextBilling) || "—")}
                                      </div>
                                      <div class="text-[10px] text-white/40 mt-1 break-all">
                                        PayPal Sub ID: ${esc(s.id || "—")}
                                      </div>
                                    </div>
                                  `).join("")
                                : `<div class="text-xs text-white/60">No subscriptions.</div>`
                            }
                          </td>
                        </tr>
                      `;
                    }).join("")
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  // ---------------------------
  // SETTINGS TAB (shows config status)
  // ---------------------------
  function SettingsTab() {
    return `
      <section class="p-4 md:p-6 space-y-3">
        <h2 class="text-xl font-bold">Settings</h2>

        <div class="p-3 rounded-xl bg-white/5 border border-white/10 text-sm">
          <div class="text-white/60 text-xs mb-1">Supabase URL</div>
          <div>${esc(CONFIG.SUPABASE_URL || "Not set")}</div>
        </div>

        <div class="p-3 rounded-xl bg-white/5 border border-white/10 text-sm">
          <div class="text-white/60 text-xs mb-1">Anon Key</div>
          <div>${CONFIG.SUPABASE_ANON_KEY ? "✅ Set" : "Not set"}</div>
        </div>

        <div class="p-3 rounded-xl bg-white/5 border border-white/10 text-sm">
          <div class="text-white/60 text-xs mb-1">Admin API Base</div>
          <div>${esc(CONFIG.CMS_API_BASE)}</div>
        </div>

        <div class="text-xs text-white/60 mt-2">
          PayPal subscriptions should be written into Supabase via webhooks.
          CMS reads them from your admin endpoint.
        </div>
      </section>
    `;
  }

  // ---------------------------
  // MAIN RENDER
  // ---------------------------
  function render() {
    let tabHTML = "";
    if (state.activeTab === "content") tabHTML = ContentTab();
    if (state.activeTab === "users") tabHTML = UsersTab();
    if (state.activeTab === "settings") tabHTML = SettingsTab();

    root.innerHTML = `
      ${Header()}
      ${LoginPanel()}
      <main class="min-h-[calc(100vh-64px)] bg-black text-white pb-24">
        ${tabHTML}
      </main>
    `;

    wireEvents();
  }

  function wireEvents() {
    // Tabs
    root.querySelectorAll("[data-tab]").forEach(btn => {
      btn.onclick = () => {
        state.activeTab = btn.getAttribute("data-tab");
        render();
      };
    });

    // Login toggle (just scrolls to panel)
    const showLogin = document.getElementById("btnShowLogin");
    if (showLogin) {
      showLogin.onclick = () => {
        state.activeTab = state.activeTab || "content";
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
    }

    // Login
    const btnLogin = document.getElementById("btnLogin");
    if (btnLogin) {
      btnLogin.onclick = () => {
        const email = document.getElementById("adminEmail")?.value.trim();
        const pass = document.getElementById("adminPass")?.value.trim();
        if (!email || !pass) return alert("Enter email + password.");
        cmsLogin(email, pass);
      };
    }

    // Logout
    const btnLogout = document.getElementById("btnLogout");
    if (btnLogout) btnLogout.onclick = cmsLogout;

    // Load users
    const btnLoadUsers = document.getElementById("btnLoadUsers");
    if (btnLoadUsers) btnLoadUsers.onclick = fetchCMSUsers;

    // Search users
    const usersSearch = document.getElementById("usersSearch");
    if (usersSearch) {
      usersSearch.oninput = (e) => {
        state.usersQuery = e.target.value || "";
        render();
      };
    }
  }

  // ---------------------------
  // BOOT
  // ---------------------------
  async function init() {
    await loadConfigJSON();
    await initSupabaseCMS();
    render();

    // Optional: auto-load users if already logged in
    if (state.session) fetchCMSUsers();
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();
})();
