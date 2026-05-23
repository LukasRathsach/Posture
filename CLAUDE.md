<!-- AI-CONFIG:START -->
> Shared AI context: read `~/.claude/AI_CONFIG_INDEX.md` first, then this project file. Universal rules and skills live in `~/.claude/`; project-specific context stays here.
<!-- AI-CONFIG:END -->

# Posture — Project Instructions

## Purpose

This file is the **entry point for any AI working on this project**. It adds project-specific rules on top of `~/.claude/CLAUDE.md` (global rules). Keep it short — deep context lives in `AI_HANDOFF.md`.

`AGENTS.md` is a symlink to `CLAUDE.md`. Claude Code reads `CLAUDE.md`; Codex reads `AGENTS.md`. No manual sync needed.

## When to update this file

Update when a hard rule changes, the tech stack changes, or a pointer to another doc goes stale. Do NOT put architecture, P/L logic, or roadmap here — that belongs in `AI_HANDOFF.md`.

---

> Read **[AI_HANDOFF.md](AI_HANDOFF.md)** before doing any work.

The design system is documented in **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** — follow it for all UI work.

## Project-specific skills

The following skills live in `.claude/skills/` and are specific to this project:

| Skill | Invoke when |
|---|---|
| `chrome-extension-developer` | Any change to `extension/overlay.js`, `background.js`, `manifest.json`, `dashboard-bridge.js` |
| `design-system` | Adding or changing UI tokens, component patterns, or visual rules for this project |

All universal skills (ui-ux-pro-max, react-best-practices, javascript-mastery, etc.) are inherited from `~/.claude/skills/` — see `~/.claude/CLAUDE.md`.

## Hard rules (project-specific)

- No blue accent borders — removed, do not re-add
- No compact mode — permanently removed, do not re-add
- Inline styles in JSX everywhere — no CSS framework, no Tailwind
- Extension settings panel must be a floating popup, not inline
- Update local state before Supabase in any sell/close operation
- Update `extension/overlay.js` AND `src/api.js` together if the `__TD_OPEN__` note payload shape changes

## Versioning

Extension version lives in `extension/manifest.json`. Bump it on every meaningful release.
Use semver where the version number reflects real scope: `0.x.0` for new features, `0.x.y` for fixes.
Current: `0.2.0`. Next feature release: `0.3.0`.

## Stack

- React 18 + Vite (single `App.jsx` component — intentional, do not split)
- Supabase (auth + data)
- Chrome Extension MV3 (`extension/` folder)
- No CSS framework — all styles are inline JSX objects
