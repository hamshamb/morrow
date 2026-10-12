# UI Reference: nochan (visual language)

**Source:** https://nochan.vercel.app — the user's own site. It is this
app's **visual source of truth** (palette, typography, corners, rules,
chips, labels). No licensing concern: it's the user's design system.

Division of labor with the other reference (see docs/DECISIONS.md ADR-018):

- **nochan = visual language** — everything in this doc.
- **OpenCode = structure and interaction** (docs/UI_REFERENCE_OPENCODE.md) —
  workspace rail + session list, unboxed assistant turns / user turn blocks,
  compact one-line activity rows, composer footer row, command palette,
  right context panel, resize handles, keybind hints.

Aim: someone who knows nochan should recognize the same hand in this app.

## Tokens (inspected from the live site's computed styles + stylesheet)

```css
:root { /* light */
  --paper:#eeede7; --raised:#f7f6f1; --sunken:#e4e2da; --ink:#161616; --muted:#5f5d57;
  --rule:#b8b5ac; --rule-strong:#85827a; --signal:#b8321f; --link:#1455d9; --ok:#286245;
  --highlight:#f3e7a6; --focus:#1455d9; --selection:#c9d8f7; --code-function:#7a3e00; --code-changed:#7a5c00;
}
/* dark — @media (prefers-color-scheme: dark) :root:not([data-theme="light"])
   and :root[data-theme="dark"] */
  --paper:#131312; --raised:#1b1b19; --sunken:#0d0d0c; --ink:#e9e5da; --muted:#a39f94;
  --rule:#3b3a36; --rule-strong:#77746b; --signal:#f07361; --link:#8db0ff; --ok:#74c294;
  --highlight:#4a4320; --focus:#8db0ff; --selection:#2b3d63; --code-function:#e3a866; --code-changed:#d9bd5c;
/* shared */
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --font-serif: "Iowan Old Style", "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif;
  --text-xs:.75rem; --text-sm:.8125rem; --text-md:.9375rem; --text-body:1.0625rem; --text-lg:1.25rem;
  --s-1:.125rem; --s-2:.25rem; --s-3:.5rem; --s-4:.75rem; --s-5:1rem; --s-6:1.5rem; --s-7:2rem;
  --hairline:1px solid var(--rule); --heavy:2px solid var(--ink); --measure:72ch;
  --t-fast:90ms; --t-med:.16s; --ease:cubic-bezier(.2,0,0,1);
body { background:var(--paper); color:var(--ink); font-family:var(--font-mono);
       font-size:var(--text-sm); line-height:1.5; font-variant-numeric:tabular-nums; }
a { color:var(--link); text-underline-offset:.15em; text-decoration-thickness:1px; }
```

These live verbatim in `apps/desktop/src/renderer/src/styles/global.css`.

## Signature traits (all observed on the site) and where they live here

1. **Zero border-radius everywhere** — chips, inputs, buttons, popovers,
   palette, user turns. (`*, *::before, *::after { border-radius: 0 }`)
2. **IBM Plex Mono for all chrome; serif for long-form prose** — assistant
   answers render in the serif stack at `--text-md` (`.prose`); code blocks,
   tables and headings stay mono; the user's own turn is mono. Plex Mono is
   bundled locally (`@fontsource/ibm-plex-mono`, OFL-1.1, latin 400/500/600) —
   offline-first, the renderer CSP is `'self'`.
3. **Rules, not boxes** — 2px `--heavy` ink rule under the top bar, page /
   dialog / section titles and the palette and picker search fields; 1px
   `--hairline` between list rows (settings keys, context sources, keyboard
   sheet, onboarding providers). No shadows; the composer is a 1px
   `--rule-strong` border on `--raised`.
4. **Inverted chips for active/emphasis** (ink background, paper text) —
   active session row, active workspace tile, active segmented option,
   selected model in the picker, Settings nav. **Outline chips** (1px
   rule-strong, muted, UPPERCASE) for tags — the per-message model chip
   `SONNET 5 · ANTHROPIC`, the composer model chip, provider tags in
   Settings, detected-provider tag in key entry.
5. **Slash-prefixed top nav** — `/chat /code /terminal /git`, hairline
   separators, active one emphasized with an ink bottom bar; `/code`,
   `/terminal`, `/git` disabled ("coming soon").
6. **Bracketed text actions** in link color — `[copy] [regenerate]
   [regenerate with…]`, `[retry] [switch model]`, `[close]`, `[remove]`,
   `[keyboard] [settings]`.
7. **Uppercase, small, muted, letter-spaced section labels** — `SESSIONS`,
   `CONTEXT`, `FAVORITES`/`RECENT` in the picker, palette groups,
   `PASTE API KEY`, table headers (`.label`).
8. **kbd chips** — 2px `--rule-strong`, mono, square — for keybind hints,
   e.g. `+ new session [c]` top-right (nochan: `+ new thread [c]`).
9. **Code blocks** — header bar with the language + `[copy]`, muted line
   numbers in a ruled gutter, `--sunken` body, square (`CodeBlock.tsx`).
10. **Footer link bar** — small muted row at the bottom of the session panel:
    `[keyboard] [settings] v…` (placed there so it doesn't crowd the composer).
11. **Accent color is never a fill** — `--link` for links/focus rings,
    `--signal` only for errors/destructive (failed model chip, error line,
    armed `[confirm delete]`), `--ok` for success (`connected`).

## Deliberate departures

- nochan has no workspace rail, session list, or right panel — those come
  from OpenCode's structure, drawn with nochan's tiles, rules and labels.
- No syntax highlighting yet (`--code-function`/`--code-changed` tokens are
  present for when a highlighter is adopted); code is monochrome.
