(() => {
  if (window.__TD_AXIOM_SOCKET_HOOK__) return;
  window.__TD_AXIOM_SOCKET_HOOK__ = true;

  const emit = payload => {
    window.postMessage({ source: "td-axiom-socket", payload }, window.location.origin);
  };

  const wireSocket = socket => {
    socket.addEventListener("message", event => {
      try {
        const data = JSON.parse(event.data);
        if (!data || typeof data !== "object") return;
        emit(data);
      } catch (_) {}
    });
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const socket = new NativeWebSocket(...args);
    wireSocket(socket);
    return socket;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
  window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  window.WebSocket.OPEN = NativeWebSocket.OPEN;
  window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
  window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
})();
