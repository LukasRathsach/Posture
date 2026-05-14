export function postSessionUpdate(session) {
  window.postMessage({
    source: "posture-page",
    type: "session_update",
    access_token: session?.access_token ?? null,
    refresh_token: session?.refresh_token ?? null,
    user: session?.user ?? null,
  }, "*");
}

export function postOpenPositionsUpdate(value) {
  window.postMessage({
    source: "posture-page",
    type: "open_positions_update",
    value,
  }, "*");
}

export function requestBalanceSync() {
  window.postMessage({
    source: "posture-page",
    type: "request_balance",
  }, "*");
}

export function attachPostureBridge({
  onInjectSession,
  onInjectBalance,
  onInjectOpenPositions,
}) {
  const handleBridgeMessage = async event => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== "posture-bridge") return;

    if (event.data?.type === "inject_session") {
      const { access_token, refresh_token } = event.data;
      if (access_token && refresh_token) {
        await onInjectSession?.({ access_token, refresh_token });
      }
      return;
    }

    if (event.data?.type === "inject_balance") {
      onInjectBalance?.(event.data.value);
      return;
    }

    if (event.data?.type === "inject_open_positions") {
      onInjectOpenPositions?.(event.data.value);
    }
  };

  window.addEventListener("message", handleBridgeMessage);
  return () => window.removeEventListener("message", handleBridgeMessage);
}
