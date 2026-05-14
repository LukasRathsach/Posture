# Posture — Design System

This document is the single source of truth for all visual decisions in the Posture dashboard and Chrome extension. Reference it before introducing any new UI element. If something isn't covered here, extend the system rather than improvising.

---

## Principles

1. **Color carries meaning, not decoration.** Accent green is reserved for P/L values, win/profit indicators, and live position state. Never use it on structural chrome.
2. **Black and white, not black and grey.** Dark mode is pure near-black with a white text hierarchy. No additional grey steps, no semi-transparent surface layers on main panels.
3. **Sharp where the structure is sharp.** The calendar grid, progress bars, and layout dividers use `borderRadius: 0`. Cards, inputs, tooltips, and floating elements use moderate radius.
4. **Dividers are structural, not decorative.** All lines use one color: `tk.borderSub`. Never vary divider weight or color for visual interest.
5. **No over-designed hover states.** Hover = subtle opacity shift. No brightness filters, color shifts, or box-shadow transitions on cells or icon buttons.
6. **No drop shadows on inline panels.** Shadows are only for floating elements (modals, tooltips, settings popup) to convey elevation. Flat panels: `boxShadow: "none"`.
7. **Inline styles in JSX everywhere.** No CSS framework, no utility classes. Use `src/index.css` only for pseudo-elements, keyframe animations, and scrollbar styling.

---

## Color tokens

All colors are accessed via `tk` (the active theme object) or the named constants below. Never hardcode hex values that have a token equivalent.

### Base palette (axiom/dark — default theme)

| Token | Value | Usage |
|---|---|---|
| `tk.bg` | `#0C0D10` | Page background, leftmost surface |
| `tk.surface1` | `#0C0D10` | Primary panel background |
| `tk.surface2` | `#111214` | Secondary panel, inputs, quiet cards |
| `tk.surface3` | `#131416` | Tertiary / nested surfaces |
| `tk.border` | `rgba(255,255,255,0.10)` | Primary structural borders |
| `tk.borderSub` | `rgba(255,255,255,0.07)` | Dividers, subtle separators |
| `tk.modalBg` | `#0C0D10` | Modal overlay background |
| `tk.modalSurf` | `#0C0D10` | Modal card surface |

### Text hierarchy

| Token | Value | Role |
|---|---|---|
| `tk.text` | `#FFFFFF` | Primary — headings, values, active labels |
| `tk.textMid` | `#E2E4EA` | Secondary — supporting labels, nav items |
| `tk.textDim` | `#B0B6C2` | Tertiary — metadata, timestamps, counts |

### Semantic colors (import from `utils.js`)

| Constant | Value | Usage |
|---|---|---|
| `green` | `#50FF6C` | Profit, wins, positive P/L |
| `red` | `#E05050` | Loss, negative P/L, destructive actions |
| `accent` | `activeAccentPreset.base` | Active theme accent — same as `green` on axiom |

### Accent presets

The accent color drives text highlights, progress indicators, and interactive accents. The axiom preset (default) uses green `#50ff6c`. Other presets (amber, teal, violet, rose) follow the same structure. Access via `accent` / `accentDim` variables, never hardcode.

### Input colors

| Token | Usage |
|---|---|
| `tk.inp.bg` | Input field background |
| `tk.inp.border` | Input field border |
| `tk.inp.color` | Input text color |

### Light mode

Light mode always uses `THEME.light` from `utils.js`. Accent presets only affect dark mode. When writing conditional color logic: `dark ? darkValue : lightValue`.

---

## Typography

Single font family throughout. Import from `utils.js`:

```js
import { sans } from "./utils";
// sans = "'Inter', 'Geist Sans', system-ui, sans-serif"
```

### Type scale

| Use | Size | Weight | Color |
|---|---|---|---|
| Section heading / label | 10px | 700 | `tk.textDim`, uppercase + `letterSpacing: "0.08em"` |
| Body / panel label | 12px | 500–600 | `tk.textMid` |
| Standard body | 13px | 400–500 | `tk.text` |
| Input text | 14px | 400 | `tk.inp.color` |
| Sub-metric value | 15px | 500–600 | semantic color |
| Section value | 22px | 700 | `fmtColor(value)` |
| Large headline | 32–36px | 850 | `tk.text` or semantic |

Always set `fontFamily: sans` on any text element. Never omit it.

### Letter spacing rules

- Section labels (uppercase): `letterSpacing: "0.08em"` to `"0.10em"`
- Large numeric values: `letterSpacing: "-0.01em"` to `"-0.015em"`
- Everything else: default (do not set)

---

## Spacing

Based on an 8pt grid. Use multiples of 4 for micro-spacing and multiples of 8 for layout spacing.

| Token | Value | Usage |
|---|---|---|
| `cardPad` | `10px` | Internal padding on stat cards |
| `sectionPad` | `16px` | Panel internal padding |
| `shellPadX` | `22px` desktop / `14px` mobile | Page horizontal padding |
| `modalPad` | `20px` | Modal internal padding |

### Gap scale

| Gap | Usage |
|---|---|
| 4–6px | Tight inline gaps (icon + label, badge elements) |
| 8–10px | Card grid gaps, form field gaps |
| 12–14px | Between sections within a panel |
| 16–18px | Between major layout sections |
| 22–24px | Page-level padding |

---

## Border radius

**This is strict.** Radius reflects the geometric nature of the element.

| Value | When to use |
|---|---|
| `0` | Calendar cells, progress bars, structural dividers, full-width layout edges |
| `4–6px` | Small cells, mobile calendar cells, minor decorative elements |
| `8px` | Cards (`panel`, `quietPanel`), inputs (`inp`), action buttons, settings items |
| `10px` | Settings popup, floating panels |
| `999px` | Pills: streak badge, currency toggle, rounded CTA buttons |

---

## Elevation & shadows

| Layer | Shadow |
|---|---|
| Inline panels (`panel`, `quietPanel`) | `boxShadow: "none"` — always |
| Floating popups (settings, tooltip) | `0 12px 32px rgba(0,0,0,0.28)` dark / `0 12px 28px rgba(15,23,42,0.12)` light |
| Modal overlays | `backdropFilter: "blur(8px)"` on the scrim |

Never add `box-shadow` or `filter: drop-shadow` to icon buttons or inline content.

---

## Component patterns

### `panel` — primary card

```js
const panel = {
  background: tk.surface1,
  border: `1px solid ${tk.border}`,
  borderRadius: 8,
  boxShadow: "none",
};
```

### `quietPanel` — secondary / nested card

```js
const quietPanel = {
  background: tk.surface2,
  border: `1px solid ${tk.borderSub}`,
  borderRadius: 8,
};
```

### `inp` — text input

```js
const inp = {
  fontSize: 14, padding: "11px 13px", borderRadius: 8,
  border: `1px solid ${tk.inp.border}`, background: tk.inp.bg,
  color: tk.inp.color, fontFamily: sans, width: "100%",
  WebkitAppearance: "none", outline: "none",
};
```

### `actionButton` — bordered button

```js
const actionButton = {
  border: `1px solid ${tk.border}`,
  background: dark ? "rgba(255,255,255,0.03)" : tk.surface2,
  color: tk.text,
  borderRadius: 8,
  cursor: "pointer",
  fontFamily: sans,
  fontWeight: 600,
};
```

### `headerAction` — ghost button (header / toolbar)

```js
const headerAction = {
  background: "transparent",
  border: "none",
  color: tk.textMid,
  cursor: "pointer",
  fontFamily: sans,
  fontSize: 13,
  fontWeight: 600,
  padding: 0,
};
```

### Section label (uppercase eyebrow)

```jsx
<div style={{
  fontSize: 10,
  color: tk.textDim,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 700,
  marginBottom: 8,
}}>
  Label
</div>
```

### Divider line

```jsx
<div style={{ height: 1, background: tk.borderSub }} />
```
All dividers use `tk.borderSub`. Never vary the color.

### Progress bar

```jsx
<div style={{ height: 2, borderRadius: 0, background: tk.borderSub, overflow: "hidden" }}>
  <div style={{ height: "100%", width: `${pct}%`, background: dark ? "#ffffff" : "#0f0f0f", borderRadius: 0 }} />
</div>
```
- Track: `tk.borderSub`
- Fill: white in dark mode, near-black in light mode
- No rounded ends. No accent color fill unless the value is inherently informational (e.g. win rate in green).

### Tooltip / popover

```jsx
<div style={{
  position: "absolute",
  top: "calc(100% + 6px)",   // below trigger
  background: dark ? tk.surface2 : tk.modalBg,
  border: `1px solid ${tk.borderSub}`,
  borderRadius: 5,
  padding: "5px 8px",
  fontSize: 11,
  color: tk.textDim,
  whiteSpace: "nowrap",
  pointerEvents: "none",
  zIndex: 300,
  fontFamily: sans,
}}>
  Tooltip text
</div>
```

### Floating panel / popup (e.g. settings)

```jsx
<div style={{
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  background: tk.modalSurf,
  border: `1px solid ${tk.border}`,
  borderRadius: 10,
  boxShadow: dark ? "0 12px 32px rgba(0,0,0,0.28)" : "0 12px 28px rgba(15,23,42,0.12)",
  padding: 12,
  zIndex: 200,
  fontFamily: sans,
}}>
```

---

## Icons

- All icons are inline SVG. No emoji, no icon fonts.
- Size: `14×14` for header/toolbar icons, `13×13` for badge icons, `18×18` for navigation chevrons.
- Color: always `currentColor` — inherit from parent `color`.
- Active state: `color: "#ffffff"` (white). Never accent color for active icon state.
- No `filter: drop-shadow` or `box-shadow` on icons, ever.

---

## Interaction states

### Hover

- Calendar cells: `opacity: 0.88` (via CSS class `.calendar-session-cell:hover`)
- Buttons / interactive rows: `background: rgba(255,255,255,0.05)` subtle tint — never a color shift
- No `transform`, no brightness filter, no box-shadow on hover

### Active / selected

- Icon buttons: `color: "#ffffff"`
- Tab / toggle: filled background `rgba(255,255,255,0.08)`, no border change
- Calendar cell selected: `outline: 1px solid {border}` — no filled overlay

### Disabled

- `opacity: 0.35`, `cursor: "default"` — no other visual change

### Loading

- Use `InlineLoader` component from `uiPrimitives.jsx`
- No spinner on buttons — disable the button while async, restore after

---

## Semantic color usage rules

| Situation | Color to use |
|---|---|
| Positive P/L value | `green` (`#50FF6C`) |
| Negative P/L value | `red` (`#E05050`) |
| Neutral / zero value | `tk.textDim` |
| Progress bar fill (structural) | `dark ? "#ffffff" : "#0f0f0f"` |
| Active icon | `#ffffff` |
| Win streak (warm/hot/inferno) | Orange tone scale — see `streakTone` |
| Rule violation | `accent` with `77` or `aa` opacity suffix |
| Destructive action | `red` |
| Live position indicator (extension) | Breathing white animation — CSS `td-icon-breathe` |

---

## Calendar cells

Calendar cells represent sessions (days). They use a toned background derived from the session's USD P/L magnitude via `getPositiveCalendarTone` / `getNegativeCalendarTone`.

- `borderRadius: 0` — always
- `boxShadow: "none"` — always
- No border in desktop grid (transparent), border visible on mobile
- Selected cell: `outline: 1px solid {border}`
- Hover: CSS `.calendar-session-cell:hover { opacity: 0.88; }` — no JS state change

---

## Extension overlay

The extension follows the same token system but implemented in CSS variables in `overlay.css`:

| CSS var | Value |
|---|---|
| `--td-bg` | `#0B0C0F` |
| `--td-surface` | `#111214` |
| `--td-border` | `rgba(255,255,255,0.08)` |
| `--td-text` | `#ffffff` |
| `--td-text-mid` | `#e2e4ea` |
| `--td-text-dim` | `#b0b6c2` |
| `--td-green` | `#50ff6c` |
| `--td-red` | `#e05050` |

Icons in the extension: `.is-active { color: #ffffff }`. `.is-live { animation: td-icon-breathe 2.6s ease-in-out infinite }` — opacity only, no drop-shadow.

---

## New element checklist

Before shipping any new UI element, verify:

- [ ] Colors come from `tk.*` tokens or named constants — no raw hex
- [ ] Font family set to `sans` on all text
- [ ] `borderRadius` matches the element type (0 for structural, 8 for cards, 999 for pills)
- [ ] `boxShadow: "none"` on inline panels
- [ ] Hover state is opacity-only or subtle background tint — no color shifts
- [ ] Accent green not used on structural/decorative elements
- [ ] Dividers use `tk.borderSub` only
- [ ] No drop-shadow on icons
- [ ] Progress bars: `borderRadius: 0`, fill is white/near-black (not accent) unless the bar is inherently informational
