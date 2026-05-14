(function () {
  const config = window.POSTURE_EXTENSION_CONFIG;
  const storage = chrome.storage.local;
  const EXTENSION_ENABLED_KEY = "td_extension_enabled";
  const FORCE_OVERLAY_KEY = "td_force_overlay";
  const OVERLAY_POSITION_KEY = "td_overlay_position";

  const els = {
    setupState: document.getElementById("setup-state"),
    signedOutState: document.getElementById("signed-out-state"),
    signedInState: document.getElementById("signed-in-state"),
    authForm: document.getElementById("auth-form"),
    authSubmit: document.getElementById("auth-submit"),
    email: document.getElementById("email"),
    password: document.getElementById("password"),
    authMessage: document.getElementById("auth-message"),
    userEmail: document.getElementById("user-email"),
    syncToggle: document.getElementById("sync-toggle"),
    syncStatus: document.getElementById("sync-status"),
    forceToggle: document.getElementById("force-toggle"),
    forceStatus: document.getElementById("force-status"),
    openDashboard: document.getElementById("open-dashboard"),
    resetOverlay: document.getElementById("reset-overlay"),
    signOut: document.getElementById("sign-out"),
  };

  const state = {
    session: null,
    user: null,
    enabled: true,
    forceOverlay: false,
  };

  function setView(view) {
    els.setupState.classList.add("hidden");
    els.signedOutState.classList.add("hidden");
    els.signedInState.classList.add("hidden");
    if (view === "setup") els.setupState.classList.remove("hidden");
    if (view === "signed-out") els.signedOutState.classList.remove("hidden");
    if (view === "signed-in") els.signedInState.classList.remove("hidden");
  }

  function setMessage(message, type) {
    els.authMessage.textContent = message;
    els.authMessage.className = `message${message ? ` ${type}` : ""}`;
    els.authMessage.classList.toggle("hidden", !message);
  }

  function request(path, options) {
    return fetch(`${config.supabaseUrl}${path}`, options).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error_description || data.msg || data.message || "Request failed.");
      }
      return data;
    });
  }

  async function saveSession(session) {
    state.session = session;
    await storage.set({ td_session: session });
  }

  async function clearSession() {
    state.session = null;
    state.user = null;
    await storage.remove("td_session");
  }

  async function signIn(email, password) {
    const data = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ email, password }),
    });
    await saveSession(data);
    return data.user || fetchUser(data.access_token);
  }

  async function refreshSession() {
    if (!state.session?.refresh_token) {
      throw new Error("Session expired. Sign in again.");
    }
    const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: state.session.refresh_token }),
    });
    await saveSession(refreshed);
    return refreshed;
  }

  async function fetchUser(accessToken) {
    return request("/auth/v1/user", {
      method: "GET",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async function withSession(requester) {
    try {
      if (!state.session?.access_token) throw new Error("No session found.");
      return await requester(state.session.access_token);
    } catch (error) {
      const message = error?.message || "";
      const shouldRefresh = /jwt|token|expired|invalid/i.test(message);
      if (!shouldRefresh) throw error;
      const refreshed = await refreshSession();
      return requester(refreshed.access_token);
    }
  }

  function openDashboard() {
    chrome.runtime.sendMessage({ type: "td_open_dashboard", url: config.dashboardUrl }, () => {
      void chrome.runtime?.lastError;
    });
  }

  async function renderSignedIn() {
    els.userEmail.textContent = state.user?.email || "";
    els.syncToggle.checked = state.enabled;
    els.syncStatus.textContent = state.enabled ? "Enabled" : "Disabled";
    els.forceToggle.checked = state.forceOverlay;
    els.forceStatus.textContent = state.forceOverlay ? "On" : "Off";
    setView("signed-in");
  }

  async function boot() {
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey || !config.dashboardUrl) {
      setView("setup");
      return;
    }

    const stored = await storage.get(["td_session", EXTENSION_ENABLED_KEY, FORCE_OVERLAY_KEY]);
    state.session = stored.td_session || null;
    state.enabled = stored[EXTENSION_ENABLED_KEY] !== false;
    state.forceOverlay = stored[FORCE_OVERLAY_KEY] === true;

    els.openDashboard.addEventListener("click", openDashboard);
    els.syncToggle.addEventListener("change", async () => {
      state.enabled = els.syncToggle.checked;
      els.syncStatus.textContent = state.enabled ? "Enabled" : "Disabled";
      await storage.set({ [EXTENSION_ENABLED_KEY]: state.enabled });
    });
    els.forceToggle.addEventListener("change", async () => {
      state.forceOverlay = els.forceToggle.checked;
      els.forceStatus.textContent = state.forceOverlay ? "On" : "Off";
      await storage.set({ [FORCE_OVERLAY_KEY]: state.forceOverlay });
    });

    els.signOut.addEventListener("click", async () => {
      try {
        if (state.session?.access_token) {
          await request("/auth/v1/logout", {
            method: "POST",
            headers: {
              apikey: config.supabaseAnonKey,
              Authorization: `Bearer ${state.session.access_token}`,
            },
          });
        }
      } catch (_error) {
        // Ignore logout API failures.
      }
      await clearSession();
      setView("signed-out");
    });
    els.resetOverlay.addEventListener("click", async () => {
      await storage.set({
        [OVERLAY_POSITION_KEY]: { top: 120, left: 24 },
        [FORCE_OVERLAY_KEY]: true,
        [EXTENSION_ENABLED_KEY]: true,
      });
      state.enabled = true;
      state.forceOverlay = true;
      els.syncToggle.checked = true;
      els.forceToggle.checked = true;
      els.syncStatus.textContent = "Enabled";
      els.forceStatus.textContent = "On";
    });

    els.authForm.addEventListener("submit", async event => {
      event.preventDefault();
      setMessage("", "");
      els.authSubmit.disabled = true;
      try {
        state.user = await signIn(els.email.value.trim(), els.password.value);
        await renderSignedIn();
      } catch (error) {
        setMessage(error.message || "Sign-in failed.", "error");
      } finally {
        els.authSubmit.disabled = false;
      }
    });

    if (state.session?.access_token) {
      try {
        state.user = await withSession(async accessToken => fetchUser(accessToken));
        await renderSignedIn();
        return;
      } catch (_error) {
        await clearSession();
      }
    }

    setView("signed-out");
  }

  boot();
})();
