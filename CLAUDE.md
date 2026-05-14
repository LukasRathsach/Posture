# Posture — Project Instructions

## Purpose

This file (`CLAUDE.md` / `AGENTS.md`) is the **entry point for any AI working on this project**. It tells the AI what it needs to know before touching any code: what to read, what rules are absolute, and what the stack looks like. Keep it short — deep context lives in `AI_HANDOFF.md`.

`AGENTS.md` is a symlink to `CLAUDE.md` so they are literally the same file. Claude Code reads `CLAUDE.md`; Codex and other agents read `AGENTS.md`. No manual sync needed.

## When to update this file

Update this file when:
- A hard rule is added, changed, or removed (e.g. "never use X", "always do Y before Z")
- The tech stack changes (new framework, removed dependency, changed build tool)
- A pointer to another doc becomes stale (e.g. DESIGN_SYSTEM.md is renamed)
- The project is renamed or the repo structure changes significantly

Do NOT put detailed architecture, P/L logic, or roadmap here — that belongs in `AI_HANDOFF.md`.

---

> Read **[AI_HANDOFF.md](AI_HANDOFF.md)** before doing any work. It has full context, architecture, hard rules, design principles, skills reference, and the roadmap.

Before starting any task, check `.claude/skills/` for relevant skills and apply them proactively without being asked — this applies to all work: UI, backend, architecture, database, code review.

If you encounter a situation where a skill would help but wasn't invoked, say so explicitly: *"This looks like a good place to apply the [skill-name] skill — should I?"*

The design system is documented in **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** — follow it for all UI work.

## Skills — when to use each

Skills live in `.claude/skills/`. Invoke them proactively when the trigger condition is met; don't wait to be asked.

| Skill | Invoke when |
|---|---|
| `ui-ux-pro-max` | Any visual change: new component, layout tweak, color, spacing, interaction |
| `react-best-practices` | Touching `src/App.jsx` or adding state/effects/memos — check for waterfalls, re-renders, bundle size |
| `supabase-postgres-best-practices` | Writing or changing any Supabase query, schema, RLS policy, or upsert |
| `chrome-extension-developer` | Any change to `extension/overlay.js`, `background.js`, `manifest.json`, `dashboard-bridge.js` |
| `senior-security` | Adding auth flows, storage of tokens/keys, new message passing, or any user-facing input handling |
| `code-reviewer` | Before marking a task complete on a non-trivial change — final pass for quality |
| `senior-architect` | Considering a structural change: new file, new data flow, refactor across contexts |
| `senior-backend` | Changing Supabase RPC functions, API auth, or the trade persistence layer |
| `ui-design-system` | Adding a new component type or token — check it fits the system |
| `product-strategist` | Roadmap decisions, feature prioritisation, or "should we build this?" questions |
| `webapp-testing` | Verifying a UI feature end-to-end after implementation |

## Skills — gaps (consider installing if the need arises)

These don't exist yet but would be worth adding if the work comes up:

- **`development/javascript-best-practices`** — `overlay.js` is 2000 lines of vanilla JS with no TypeScript. A JS-specific skill would catch patterns that `react-best-practices` doesn't cover (prototype patching, closure leaks, event listener hygiene).
- **`utilities/git-workflow`** — commit conventions, PR templates, branch strategy. Low priority while solo.
- **`monitoring/sentry`** — Sentry is already wired in. A skill here would help configure alerting, release tracking, and source maps properly before launch.

## Hard rules

- No GitHub push without the user explicitly asking
- No blue accent borders — removed, do not re-add
- No compact mode — permanently removed, do not re-add
- Inline styles in JSX everywhere — no CSS framework, no Tailwind
- Extension settings panel must be a floating popup, not inline
- Update local state before Supabase in any sell/close operation
- Update `extension/overlay.js` AND `src/api.js` together if the `__TD_OPEN__` note payload shape changes

## Stack

- React 18 + Vite (single `App.jsx` component — intentional, do not split)
- Supabase (auth + data)
- Chrome Extension MV3 (`extension/` folder)
- No CSS framework — all styles are inline JSX objects
