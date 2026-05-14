"use strict";
(function () {
  const config = window.POSTURE_EXTENSION_CONFIG;
  if (!config?.supabaseUrl) return;
  const BALANCE_KEY = "td_virtual_balance";
  const OPEN_POSITIONS_KEY = "td_open_positions";

  // sb-<projectRef>-auth-token is the key Supabase JS client uses in localStorage
  const projectRef = config.supabaseUrl.replace(/^https?:\/\//, "").split(".")[0];
  const lsKey = `sb-${projectRef}-auth-token`;

  const broadcastBalance = value => {
    window.postMessage({
      source: "posture-bridge",
      type: "inject_balance",
      value: value ?? null,
    }, window.location.origin);
  };

  const broadcastOpenPositions = value => {
    window.postMessage({
      source: "posture-bridge",
      type: "inject_open_positions",
      value: value || {},
    }, window.location.origin);
  };

  const applyImmediateStateSync = ({ balance, openPositions }) => {
    try {
      if (balance === undefined || balance === null) {
        localStorage.removeItem("posture_virtual_balance");
      } else {
        localStorage.setItem("posture_virtual_balance", String(balance));
      }
    } catch (_) {}
    try {
      localStorage.setItem("posture_extension_open_positions", JSON.stringify(openPositions || {}));
    } catch (_) {}
    if (balance !== undefined) {
      broadcastBalance(balance);
    }
    broadcastOpenPositions(openPositions || {});
  };

  const loadAndBroadcastBalance = () => {
    chrome.storage.local.get([BALANCE_KEY], result => {
      const balance = result[BALANCE_KEY];
      try {
        if (balance === undefined || balance === null) {
          localStorage.removeItem("posture_virtual_balance");
        } else {
          localStorage.setItem("posture_virtual_balance", String(balance));
        }
      } catch (_) {}
      broadcastBalance(balance);
    });
  };

  // Extension → Dashboard: inject session and balance before the app reads localStorage
  chrome.storage.local.get(["td_session", BALANCE_KEY, OPEN_POSITIONS_KEY], result => {
    const session = result.td_session;
    const balance = result[BALANCE_KEY];
    const openPositions = result[OPEN_POSITIONS_KEY];
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
      }, window.location.origin);
    }
    if (balance !== undefined && balance !== null) {
      window.postMessage({
        source: "posture-bridge",
        type: "inject_balance",
        value: balance,
      }, window.location.origin);
    }
    broadcastOpenPositions(openPositions || {});
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
    if (e.data.type === "request_balance") {
      loadAndBroadcastBalance();
    }
    if (e.data.type === "reset_balance") {
      chrome.storage.local.set({ [BALANCE_KEY]: 0 }, () => loadAndBroadcastBalance());
    }
    if (e.data.type === "balance_update") {
      const value = Number(e.data.value);
      if (Number.isFinite(value) && value >= 0) {
        chrome.storage.local.set({ [BALANCE_KEY]: Number(value.toFixed(4)) }, () => loadAndBroadcastBalance());
      }
    }
    if (e.data.type === "open_positions_update") {
      const next = e.data.value && typeof e.data.value === "object" ? e.data.value : {};
      chrome.storage.local.set({ [OPEN_POSITIONS_KEY]: next });
    }
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes[BALANCE_KEY]) {
      const next = changes[BALANCE_KEY].newValue;
      try {
        if (next === undefined || next === null) {
          localStorage.removeItem("posture_virtual_balance");
        } else {
          localStorage.setItem("posture_virtual_balance", String(next));
        }
      } catch (_) {}
      broadcastBalance(next);
    }
    if (changes[OPEN_POSITIONS_KEY]) {
      const nextOpenPositions = changes[OPEN_POSITIONS_KEY].newValue || {};
      try {
        localStorage.setItem("posture_extension_open_positions", JSON.stringify(nextOpenPositions));
      } catch (_) {}
      broadcastOpenPositions(nextOpenPositions);
    }
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== "td_sync_dashboard_state") return;
    applyImmediateStateSync({
      balance: message.balance,
      openPositions: message.openPositions,
    });
  });
})();
