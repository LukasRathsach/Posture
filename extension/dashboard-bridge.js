"use strict";
(function () {
  const config = window.POSTURE_EXTENSION_CONFIG;
  if (!config?.supabaseUrl) return;

  // sb-<projectRef>-auth-token is the key Supabase JS client uses in localStorage
  const projectRef = config.supabaseUrl.replace(/^https?:\/\//, "").split(".")[0];
  const lsKey = `sb-${projectRef}-auth-token`;

  // Extension → Dashboard: inject session and balance before the app reads localStorage
  chrome.storage.local.get(["td_session", "td_virtual_balance", "td_open_positions"], result => {
    const session = result.td_session;
    const balance = result.td_virtual_balance;
    const openPositions = result.td_open_positions;
    if (session?.access_token) {
      try {
        if (!localStorage.getItem(lsKey)) {
          localStorage.setItem(lsKey, JSON.stringify(session));
        }
      } catch (_) {}
    }
    try {
      if (balance !== undefined && balance !== null) {
        localStorage.setItem("posture_virtual_balance", String(balance));
      }
    } catch (_) {}
    try {
      localStorage.setItem("posture_extension_open_positions", JSON.stringify(openPositions || {}));
    } catch (_) {}
    // Fallback postMessage in case Supabase client already initialized
    if (session?.access_token) {
      window.postMessage({
        source: "posture-bridge",
        type: "inject_session",
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }, "*");
    }
    if (balance !== undefined && balance !== null) {
      window.postMessage({
        source: "posture-bridge",
        type: "inject_balance",
        value: balance,
      }, "*");
    }
    window.postMessage({
      source: "posture-bridge",
      type: "inject_open_positions",
      value: openPositions || {},
    }, "*");
  });

  // Dashboard → Extension: receive messages from the React app
  window.addEventListener("message", e => {
    if (e.source !== window || e.data?.source !== "posture-page") return;
    if (e.data.type === "session_update") {
      if (e.data.access_token) {
        chrome.storage.local.set({
          td_session: {
            access_token: e.data.access_token,
            refresh_token: e.data.refresh_token,
            user: e.data.user ?? null,
          },
        });
      } else {
        chrome.storage.local.remove("td_session");
      }
    }
    if (e.data.type === "reset_balance") {
      chrome.storage.local.remove("td_virtual_balance");
    }
    if (e.data.type === "balance_update") {
      const value = Number(e.data.value);
      if (Number.isFinite(value) && value >= 0) {
        chrome.storage.local.set({ td_virtual_balance: Number(value.toFixed(4)) });
      }
    }
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.td_virtual_balance) {
      const next = changes.td_virtual_balance.newValue;
      try {
        if (next === undefined || next === null) {
          localStorage.removeItem("posture_virtual_balance");
        } else {
          localStorage.setItem("posture_virtual_balance", String(next));
        }
      } catch (_) {}
      window.postMessage({
        source: "posture-bridge",
        type: "inject_balance",
        value: next ?? null,
      }, "*");
    }
    if (changes.td_open_positions) {
      const nextOpenPositions = changes.td_open_positions.newValue || {};
      try {
        localStorage.setItem("posture_extension_open_positions", JSON.stringify(nextOpenPositions));
      } catch (_) {}
      window.postMessage({
        source: "posture-bridge",
        type: "inject_open_positions",
        value: nextOpenPositions,
      }, "*");
    }
  });
})();
