export const UI_STATE = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  SAVING: "saving",
  SUCCESS: "success",
  ERROR: "error",
  EMPTY: "empty",
});

export function getCollectionUiState({ loading = false, error = false, items = [] }) {
  if (loading) return UI_STATE.LOADING;
  if (error) return UI_STATE.ERROR;
  return Array.isArray(items) && items.length > 0 ? UI_STATE.IDLE : UI_STATE.EMPTY;
}

export function getSyncPresentation(syncStatus) {
  const map = {
    loading: { state: UI_STATE.LOADING, label: "Syncing", tone: "accent" },
    saving: { state: UI_STATE.SAVING, label: "Saving", tone: "accent" },
    ok: { state: UI_STATE.SUCCESS, label: "Synced", tone: "success" },
    local: { state: UI_STATE.SUCCESS, label: "Saved locally", tone: "success" },
    setup: { state: UI_STATE.ERROR, label: "Setup needed", tone: "accent" },
    error: { state: UI_STATE.ERROR, label: "Sync issue", tone: "error" },
  };

  return map[syncStatus] || { state: UI_STATE.IDLE, label: "Checking", tone: "neutral" };
}
