import React from "react";

export function InlineLoader({ label = "Loading", tone = "neutral", align = "left" }) {
  return (
    <div
      className={`ui-inline-loader ui-inline-loader--${tone}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : "flex-start",
        gap: 9,
        minWidth: 0,
      }}
    >
      <span className="ui-inline-loader-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>{label}</span>
    </div>
  );
}

export function StatusNotice({ tone = "neutral", title, detail, palette, compact = false }) {
  if (!title && !detail) return null;

  const colors = palette?.[tone] || palette?.neutral || {};
  return (
    <div
      className="ui-status-notice"
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        borderRadius: compact ? 10 : 12,
        padding: compact ? "10px 11px" : "12px 13px",
      }}
    >
      {title && (
        <div style={{ fontSize: compact ? 12 : 13, fontWeight: 700, lineHeight: 1.35 }}>
          {title}
        </div>
      )}
      {detail && (
        <div style={{ fontSize: 12, lineHeight: 1.55, marginTop: title ? 4 : 0, opacity: 0.92 }}>
          {detail}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ eyebrow, title, detail, palette, compact = false, align = "left" }) {
  const colors = palette?.neutral || {};
  return (
    <div
      className="ui-empty-state"
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        borderRadius: compact ? 12 : 14,
        padding: compact ? "14px 15px" : "18px 18px",
        textAlign: align,
      }}
    >
      {eyebrow && (
        <div
          style={{
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: "0.09em",
            fontWeight: 700,
            marginBottom: 7,
            opacity: 0.72,
          }}
        >
          {eyebrow}
        </div>
      )}
      <div style={{ fontSize: compact ? 14 : 16, fontWeight: 700, lineHeight: 1.2, color: colors.strongText || colors.text }}>
        {title}
      </div>
      {detail && (
        <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 7, opacity: 0.9 }}>
          {detail}
        </div>
      )}
    </div>
  );
}
