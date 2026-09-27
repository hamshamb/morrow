# UI Reference: OpenCode (anomalyco/opencode)

Research notes for redesigning `apps/desktop/src/renderer/src/` (React 19 +
plain CSS custom properties) to feel like **OpenCode** (github.com/anomalyco/
opencode, MIT, opencode.ai) — dense, fast, calm, code-first, keyboard-first,
minimal chrome.

**Source repo:** `anomalyco/opencode`, default branch `dev`, MIT license,
confirmed via `gh api repos/anomalyco/opencode`. All UI packages
(`packages/ui`, `packages/app`, `packages/session-ui`, `packages/desktop`) are
**SolidJS**, not React — different reactivity/JSX model, so components cannot
be imported directly. Everything marked REIMPLEMENT below means: study the
structure/behavior, write an original React component. Everything marked
REUSE is framework-agnostic data (CSS values, JSON, raw SVG path strings) that
can be copied/adapted directly and is legitimate under the MIT license
(subject to the attribution requirement at the end of this doc).

All file paths below are relative to the opencode repo root, fetched at
`?ref=dev` via `gh api repos/anomalyco/opencode/contents/<path>`.

---

## 1. Theme / design tokens

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Theme JSON (dark palette + syntax/markdown overrides) | `packages/ui/src/theme/themes/opencode.json` | MIT | **REUSE** | Pure JSON data — copy hex values directly into our CSS custom properties. |
| Full semantic token set (backgrounds/surfaces/text/border/icon/syntax/diff) | `packages/ui/src/styles/theme.css` | MIT | **REUSE** | Plain `:root { --var: value }` CSS, no Solid/JSX. Directly portable to our `theme.css`-equivalent. |
| Raw color ramps (gray/blue/amber/mint/etc., 1–12 scale + alpha variants) | `packages/ui/src/styles/colors.css` | MIT | **REUSE** | Plain CSS custom properties, framework-agnostic. |
| Layer/import structure (`@layer theme, base, components, utilities`) | `packages/ui/src/styles/index.css` | MIT | **ADAPT** | The `@layer` cascade ordering pattern is worth adopting even though our app uses plain CSS (no build-time Tailwind layer merge needed, but the *ordering discipline* — tokens → base → components → utilities — is a reusable convention). |

### Real dark theme values (OpenCode's own `opencode` theme, from `themes/opencode.json`)

```json
"dark": {
  "palette": {
    "neutral": "#0a0a0a",
    "ink": "#eeeeee",
    "primary": "#fab283",
    "accent": "#9d7cd8",
    "success": "#7fd88f",
    "warning": "#f5a742",
    "error": "#e06c75",
    "info": "#56b6c2",
    "diffAdd": "#b8db87",
    "diffDelete": "#e26a75"
  },
  "overrides": {
    "text-weak": "#808080",
    "syntax-comment": "#808080",
    "syntax-keyword": "#9d7cd8",
    "syntax-string": "#7fd88f",
    "syntax-primitive": "#fab283",
    "syntax-variable": "#e06c75",
    "syntax-property": "#56b6c2",
    "syntax-type": "#e5c07b",
    "syntax-constant": "#f5a742",
    "markdown-heading": "#9d7cd8",
    "markdown-link": "#fab283",
    "markdown-code": "#7fd88f"
  }
}
```

Light theme uses `neutral: #ffffff`, `ink: #1a1a1a`, `primary: #3b7dd8` (blue),
`accent: #d68c27` (amber) — a cooler, more muted palette than the dark theme's
warm orange/purple accents.

### Real semantic surface/background values (from `theme.css`, the actual rendered app tokens — "OC-2" token set)

Dark mode (`@media (prefers-color-scheme: dark)` block):
```css
--background-base: #101010;
--background-weak: #1e1e1e;
--background-strong: #121212;
--background-stronger: #151515;
--surface-base: rgba(255, 255, 255, 0.031);
--surface-raised-base: rgba(255, 255, 255, 0.059);
--surface-raised-strong: rgba(255, 255, 255, 0.078);
--surface-float-base: #161616;
--text-base: rgba(255, 255, 255, 0.618);
--text-weak: rgba(255, 255, 255, 0.422);
--text-strong: rgba(255, 255, 255, 0.936);
--border-base: rgba(255, 255, 255, 0.195);
--border-weak-base: #282828;
--icon-base: #7e7e7e;
--icon-strong-base: #ededed;
```
This confirms the near-black/charcoal surface stack the user wants: base
`#101010`, layered surfaces built almost entirely from **white-alpha
overlays** (`rgba(255,255,255,0.03)` → `0.17`) rather than flat hex steps —
this is what gives OpenCode's dark UI its subtle, non-flat depth. Text is
also alpha-based (`rgba(255,255,255,0.62/0.42/0.94)`) rather than solid gray
hexes, so it blends correctly over any surface layer.

### Typography (from `theme.css`)
```css
--font-family-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-family-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
--font-size-small: 13px;
--font-size-base: 14px;
--font-size-large: 16px;
--font-size-x-large: 20px;
--font-weight-regular: 400;
--font-weight-medium: 500;
--line-height-normal: 130%;
--line-height-large: 150%;
```
Body text throughout the app is **13–14px**, not 16px — a deliberately dense,
information-rich sizing consistent with a code tool rather than a marketing
SaaS UI.

### Spacing / radius / shadow scale (from `theme.css`)
```css
--spacing: 0.25rem;  /* 4px base unit */
--radius-xs: 0.125rem;  /* 2px */
--radius-sm: 0.25rem;   /* 4px */
--radius-md: 0.375rem;  /* 6px */
--radius-lg: 0.5rem;    /* 8px */
--radius-xl: 0.625rem;  /* 10px */
--shadow-xs: 0 1px 2px -0.5px light-dark(hsl(0 0% 0% / 0.04), hsl(0 0% 0% / 0.06)), ...
```
Border radii are small (2–10px) — chips/buttons/inputs mostly sit at
`--radius-md` (6px) and `--radius-lg` (8px); nothing uses today's common
12–16px "soft SaaS card" radius except dialogs (12px, see command palette
below).

---

## 2. App shell / layout

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Root shell (titlebar + main content + toast region) | `packages/app/src/pages/layout-new.tsx` | MIT | **REIMPLEMENT** | Solid JSX/control-flow (`Suspense`, stores); trivial structure to re-express in React. |
| Titlebar / session tab strip | `packages/app/src/components/titlebar.tsx` (673 lines) + `titlebar.css` | MIT | **REIMPLEMENT** (logic) / **ADAPT** (CSS pattern) | Complex Solid state machine for tab drag/scroll; the scroll-driven fade-edge CSS technique is portable. |
| Sidebar rail + expandable panel | `packages/app/src/pages/layout/sidebar-shell.tsx` | MIT | **REIMPLEMENT** | Uses `@thisbeyond/solid-dnd` for project reordering; React port would use `@dnd-kit/core` (already common in React) or a simpler custom drag handler. |

### Shell structure (from `layout-new.tsx`)
```tsx
<div class="... bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col ...">
  <Titlebar update={update} debugTools={...} />
  <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
    <Suspense>{props.children}</Suspense>
  </main>
  <TabsInfoPopup />
  <ToastRegion v2 />
</div>
```
Top-level shape: **titlebar (browser-tab-like session strip) → full-height
main content → toast region**. The sidebar is *not* part of this root shell —
it's composed one level down, inside the directory/project layout, as a rail
+ collapsible panel (see `sidebar-shell.tsx`):

```tsx
<div class="flex h-full w-full min-w-0 overflow-hidden">
  <div data-component="sidebar-rail" class="w-16 shrink-0 bg-background-base flex flex-col items-center ...">
    {/* project icons (drag-sortable), + "new project" button, then settings/help at bottom */}
  </div>
  <div class="flex-1 flex h-full min-h-0 min-w-0 overflow-hidden" aria-hidden={!expanded()}>
    {/* the expandable session-list panel */}
  </div>
</div>
```
Key structural insight: OpenCode's sidebar is a **64px icon-only rail**
(projects as avatars) plus a *separate, collapsible* session-list panel that
expands next to it — not a single always-wide sidebar. This is a strong
"dense/calm" pattern: the persistent chrome cost is only 64px; the session
list panel opens on demand (hover/pin) rather than permanently consuming
width. Notably it also uses `inert` on the collapsed panel (`el.setAttribute("inert", "")`)
rather than `display:none`/unmounting — good practice for a11y + preserving
scroll position under a directly-portable pattern.

Real (unofficial) opencode.ai screenshots and this source both point to a
titlebar with horizontally-scrolling session/file tabs (browser-tab
metaphor) rather than a fixed top app bar — worth deciding deliberately
whether our simpler workspace/conversation model wants full tab-strip
complexity or a lighter single-row breadcrumb.

---

## 3. Session sidebar

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Session list item, project icon, "new session" row, skeleton loader | `packages/app/src/pages/layout/sidebar-items.tsx` | MIT | **REIMPLEMENT** | Solid component logic (`createMemo`, stores); the *visual structure and Tailwind utility classes* are directly quotable as a spec. |
| Generic list container (search box, sticky group headers, item rows, dividers) | `packages/ui/src/components/list.css` | MIT | **REUSE** (CSS) / **REIMPLEMENT** (component logic) | `list.css` is plain data-attribute CSS — copy the visual rules; the underlying `List` Solid component (grouping/filtering logic) must be rewritten. |

### Compact list item structure (from `sidebar-items.tsx`, `SessionRow`)
```tsx
<A href={...} class="flex items-center gap-2 min-w-0 w-full text-left py-1">
  {/* status dot: spinner (working) | amber dot (needs permission) | red dot (error) | blue dot (unseen) */}
  <div class="shrink-0 size-6 flex items-center justify-center" style={{ color: tint }}>
    <Spinner /> {/* or a size-1.5 rounded-full colored dot */}
  </div>
  <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{title}</span>
</A>
```
Row container (hover/active state, archive action reveal-on-hover):
```html
<div class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3
            transition-colors hover:bg-surface-raised-base-hover
            has-[.active]:bg-surface-base-active"
     style="padding-left: 8px;"> <!-- + 16px per nesting level for child/sub-sessions -->
  <!-- row content -->
  <!-- archive icon-button: width animates 0 -> 24px on row hover/focus-within -->
</div>
```
Concrete, reusable details:
- **Status indicator is a single 6px dot or 15px spinner**, not a badge/pill —
  color communicates state (warning amber = needs permission, error red,
  interactive blue = unseen, no dot = idle). This is the "borrow the compact
  event visual language" pattern the redesign should apply to our
  attachment/context-source chips too.
- **Hover-reveal actions** (archive button) use a width+opacity transition
  from `0` to `24px`/`opacity-0` to `opacity-100` gated on
  `group-hover/session:` and `group-focus-within/session:` — not
  `visibility:hidden`, so it stays keyboard-accessible.
- Active row state uses `has-[.active]:bg-surface-base-active` (CSS `:has()`
  targeting the router's own `.active` class on the link) rather than a
  separate JS-driven "isActive" prop plumbed down — a nice simplification
  our React version can approximate via NavLink's `isActive`-derived class.
- No "Earlier"/date-grouping was found in this specific file (grouping by
  project happens one level up via the sidebar rail's per-project session
  lists, not by recency-within-a-project); the *generic* `List` component
  (`list.css`, section 6 below) does support sticky grouped headers
  (`[data-slot="list-header"]` with `position: sticky; top: 0`) which is the
  mechanism a "Today / Earlier" grouping would use if added.

### List component's grouped/sticky header CSS (from `list.css`, directly reusable)
```css
[data-slot="list-header"] {
  display: flex;
  padding: 8px 12px 8px 8px;
  background: var(--surface-raised-stronger-non-alpha);
  position: sticky;
  top: 0;
  color: var(--text-weak);
  font-size: 14px;
  font-weight: var(--font-weight-medium);
}
[data-slot="list-item"] {
  padding: 6px 8px;
  font-size: 14px;
  font-weight: var(--font-weight-medium);
}
[data-slot="list-item"][data-active="true"] {
  border-radius: var(--radius-md);
  background: var(--surface-raised-base-hover);
}
```

---

## 4. Composer (message input)

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Composer container, contenteditable input, footer control row, submit button | `packages/session-ui/src/v2/components/prompt-input/index.tsx` (723 lines) | MIT | **REIMPLEMENT** | Heavy Solid-specific editor state machine (custom contenteditable parsing, mention highlighting); port the *interaction contract* not the code. |
| Composer wiring (model control slot, keybind display) | `packages/app/src/components/prompt-input-v2.tsx` | MIT | **REIMPLEMENT** | |

### Concrete structure (from `prompt-input/index.tsx`)
```tsx
<form data-component="prompt-input-v2"
      class="group/prompt-input relative min-h-[96px] w-full overflow-clip
             rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
  {/* drag-and-drop file overlay */}
  {/* attachments row (images/files as small cards, only in "normal" mode) */}
  <div class="relative min-h-[60px]">
    <div data-component="prompt-input"
         contenteditable
         role="textbox" aria-multiline="true"
         class="... min-h-[60px] max-h-[180px] overflow-y-auto whitespace-pre-wrap
                bg-transparent px-4 pt-4 pb-2 text-[13px] font-[440] leading-5
                focus:outline-none
                [&_[data-mention=file]]:text-syntax-property
                [&_[data-mention=agent]]:text-syntax-type" />
    {/* placeholder overlay div, shown only when empty, absolutely positioned over the editor */}
  </div>
  <div class="flex h-11 items-center px-2"> <!-- footer row -->
    <div class="flex min-w-0 flex-1 items-center gap-1"> <!-- left: contextual controls -->
      <PromptInputV2AddMenu /> {/* attach / commands / context / shell — one "+" menu, not separate buttons */}
      <PromptInputV2ConfiguredSelect model /> {/* agent picker */}
      <ModelSelectorPopoverV2 />              {/* model + effort picker */}
      <PromptInputV2ConfiguredSelect />       {/* variant picker, only shown if >1 option */}
    </div>
    <PromptInputV2SubmitButton mode={state.mode} stopping={...} disabled={!canSubmit()} />
  </div>
</form>
```
Concrete, reusable findings:
- **Editable surface is a `contenteditable` `<div role="textbox">`, not a
  `<textarea>`** — this is what enables inline colored "mentions" (`@file`,
  `@agent`) rendered as styled spans inside the input itself
  (`[&_[data-mention=file]]:text-syntax-property`). Our React app currently
  likely uses a plain `<textarea>`; matching this exactly is a bigger lift
  (needs a small contenteditable/rich-text layer) — flag as an optional
  future enhancement rather than a v1 requirement, but even a
  `<textarea>` can adopt the *visual* spec below immediately.
- **Container**: `min-h-[96px]`, `rounded-xl` (10px), `shadow` (not a hard
  1px border in the default state) — the border only appears as a dashed
  highlight during file drag-over. This is a "soft raised surface", not a
  boxed bordered card.
- **Placeholder** is a separate absolutely-positioned overlay `<div>` shown
  only `Show when={!value()}`, not the native `placeholder` attribute
  (required because the input is contenteditable). Placeholder copy pattern:
  `i18n.t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" })` →
  i.e. literally hints at `/` for commands and `@` for mentions/attachments
  directly in the placeholder text — a good "keyboard-first, discoverable"
  pattern worth copying verbatim in spirit ("Type a message, / for commands, @ to attach").
  Shell-mode uses a distinct monospace placeholder + `font-mono!` class.
  Footer height is fixed at `h-11` (44px), `px-2`.
- **Footer control order**: one unified "+" add-menu (attach/commands/
  context/shell) on the far left, then agent, then model+effort, then
  optional variant — **all left-aligned**, with the submit button alone on
  the right (`justify-content` is achieved via `flex-1` on the left group,
  not `justify-between` on discrete children). Submit is an icon button
  (arrow-up glyph, see icon set) that swaps to a stop/square icon while
  streaming (`GenericTool`/`icons.stop` = a filled square, matching the
  common "stop generating" convention).
- **Keybinds are surfaced directly in the UI**, not hidden in a menu: each
  control (`attach`, `model.choose`, `chooseVariant`) passes a `keybind`
  prop rendered as a small `<Keybind>` chip, e.g. attach defaults to
  `["Mod", "U"]`, model choose to `Mod+M`, variant to `Shift+Mod+D`. This is
  a core "keyboard-first" signal: every composer affordance advertises its
  shortcut inline via a tooltip/badge rather than requiring the user to
  discover it.

---

## 5. Message / chat rendering (boxed vs. unboxed, and compact tool-event lines)

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| User/assistant message layout + bubble styling | `packages/session-ui/src/components/message-part.css` (1582 lines) | MIT | **REUSE** (CSS rules) / **REIMPLEMENT** (component) | The exact selectors/values below are plain CSS, directly portable. |
| Message part dispatch (text/tool/file/reasoning parts) | `packages/session-ui/src/components/message-part.tsx` (2642 lines) | MIT | **REIMPLEMENT** | Very large Solid component tree; port only the pattern (see below), not the code. |
| Compact collapsible tool-call row ("● Read file.ts" equivalent) | `packages/session-ui/src/components/basic-tool.tsx` + `basic-tool.css` | MIT | **REIMPLEMENT** (component) / **REUSE** (CSS) | This is *the* pattern the task called out — see full breakdown below. |

### The critical finding: assistant messages are NOT boxed, user messages ARE
```css
[data-component="assistant-message"] {
  content-visibility: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  /* no background, no border, no padding, no border-radius at all */
}

[data-component="user-message"] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;   /* right-aligned, like a chat bubble */
  width: 100%;
}
[data-slot="user-message-body"] {
  width: fit-content;
  max-width: min(82%, 64ch);   /* bubble never spans the full width */
  margin-inline-start: auto;
}
[data-slot="user-message-text"] {
  background: var(--v2-background-bg-layer-02);  /* subtle raised surface, not a strong color */
  border: none;
  padding: 8px 12px;
  border-radius: 10px;
}
```
This exactly matches the user's ask ("less boxed" chat): **only the user's
own message is a bubble** (right-aligned, max 82%/64ch wide, soft
background, 10px radius, no border) — the assistant's reply is plain flowing
content on the page background, left-aligned, full width, no card at all.
Our current app almost certainly boxes both sides equally; switching to this
asymmetric model is probably the single highest-impact visual change for the
"less boxed" goal.

### Compact tool/activity-event line pattern (from `basic-tool.tsx` / `.css`)

This is the "● Read file.ts" / "● Edit +12 -4" equivalent the task asked
about. Structure:
```
[icon]  Read          src/app.tsx        <chevron if expandable>
        ^title(shimmers while pending)   ^"subtitle" (truncated, muted)
```
```tsx
<div data-component="tool-trigger">
  <div data-slot="basic-tool-tool-info-structured">
    <div data-slot="basic-tool-tool-info-main">
      <span data-slot="basic-tool-tool-title"><TextShimmer text={title} active={pending} /></span>
      <span data-slot="basic-tool-tool-subtitle">{subtitle}</span>  <!-- e.g. file path, query -->
      <For each={args}><span data-slot="basic-tool-tool-arg">{arg}</span></For> <!-- key=value chips, max 3 -->
    </div>
    <span data-slot="basic-tool-tool-action">{action}</span> <!-- optional trailing element, e.g. diff stat -->
  </div>
  <Collapsible.Arrow /> <!-- only if it has expandable children and isn't hidden/locked -->
</div>
```
Generic fallback for any tool: title = `"Called {tool}"`, subtitle = first
of `description|query|url|filePath|path|pattern|name` found in the tool's
input object, args = remaining scalar input fields as `key=value`, capped at
3.

CSS (`basic-tool.css`, directly reusable rules):
```css
[data-component="tool-trigger"] {
  display: flex;
  align-items: center;
  gap: 0px;              /* gap comes from data-slot children's own gap: 8px */
}
[data-slot="basic-tool-tool-title"] {
  font-size: 14px;
  font-weight: var(--font-weight-medium);
  color: var(--v2-text-text-base);
}
[data-slot="basic-tool-tool-subtitle"] {
  font-size: 14px;
  font-weight: var(--font-weight-regular);
  color: var(--v2-text-text-muted);   /* visibly dimmer than the title */
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
```
Behavioral details worth reproducing:
- **Pending state = animated text-shimmer on the title only** (not a spinner
  replacing the icon) — `<TextShimmer text={title} active={pending}>`. A
  16×16 spinner icon is reserved for a separate slot
  (`basic-tool-tool-spinner`) used elsewhere, but the primary "in progress"
  signal is the shimmering label text itself, which is a distinctive,
  low-chrome way to show activity.
  y
- **Collapsible details, closed by default**, driven by a `defer` + deferred
  requestAnimationFrame-batched mount (`scheduleDeferredMount`) so that
  expensive tool-output bodies (e.g. full file diffs) don't all mount at
  once when a long conversation renders — only becomes "ready" the frame
  after it's opened, and mounts are flushed newest-first (bottom of
  viewport first) since that's what's visible. This is a meaningful
  performance pattern worth adopting if our context/attachment previews
  ever get heavy.
- **Everything is one single-line-height row** unless expanded — icon,
  title, subtitle, and up to 3 small arg chips all sit on one flex row with
  `overflow: hidden; text-overflow: ellipsis` on the subtitle/args so long
  paths truncate rather than wrap.

**Direct application to our app**: our attachment chips, context-source
rows, and "N files indexed" status lines in `ContextInspectorView` /
`WorkspaceFilesPanel` should adopt this exact shape — icon + medium-weight
title + muted truncating subtitle + optional small trailing chips, all on
one row, collapsible for detail — rather than today's likely more
verbose/boxed presentation.

---

## 6. Model/provider picker (command-menu style)

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Model selector dialog (search, provider grouping, tooltip preview) | `packages/app/src/components/dialog-select-model.tsx` | MIT | **REIMPLEMENT** | Built on the generic Solid `List` component; port the *behavioral spec* below. |
| Fuzzy-ish search normalization | `packages/app/src/components/dialog-select-model-search.ts` (18 lines) | MIT | **ADAPT** | Trivial, framework-free pure functions — safe to port near-verbatim into TypeScript. |

### Search matching logic (full file, 18 lines, directly portable as-is)
```ts
export const normalizeModelSearch = (value: string) =>
  value.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim().replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)
  if (!search) return true
  const compactSearch = compactModelSearch(query)
  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}
```
Notably **not a fuzzy-match library** — just normalized substring matching
tried two ways (space-normalized and fully compacted, e.g. so `"gpt4o"`
matches `"GPT-4o"`). This matches our app's existing
`filterModelPickerOptions` approach (also "simple scored substring filter,
no fuzzy-match library" per `docs/BUILD_STATE.md`) — good validation that
our existing choice already aligns with OpenCode's, no change needed there.

### Grouping/search UI wiring (from `dialog-select-model.tsx`)
```tsx
<List
  search={{ placeholder: "...", autofocus: true }}
  filterKeys={["provider.name", "name", "id"]}
  sortBy={(a, b) => a.name.localeCompare(b.name)}
  groupBy={(x) => x.provider.name}
  sortGroupsBy={(a, b) => {
    // "popular" providers (a fixed ordered list, e.g. Anthropic/OpenAI first) sort before the rest
    if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
    ...
  }}
  itemWrapper={(item, node) => <Tooltip value={<ModelTooltip model={item} .../>}>{node}</Tooltip>}
  onSelect={(x) => model.set({ modelID: x.id, providerID: x.provider.id }, { recent: true })}
>
  {(model) => <span>{model.name}</span> /* + "free" and "latest" Tag chips inline */}
</List>
```
- **Grouped by provider name**, not a separate flat list with provider
  icons — each group header shows the provider name once.
- **No distinct "Recent" section header** was found; instead, selecting a
  model records `{ recent: true }` in a `set()` call — recency is tracked as
  metadata used elsewhere (e.g. sort weighting or the composer's default),
  not rendered as its own group in this dialog. If a literal "Recent"
  section is wanted, it would need to be added on top of this pattern
  (store recent model ids, prepend a synthetic group).
- **Hover tooltip preview** on each row (`itemWrapper`) shows a
  `<ModelTooltip>` with extra detail (cost, "free"/"latest" tags) without
  navigating away — worth adopting for our `ModelSelector` popover.
- Search input placeholder, autofocus on open — standard command-menu UX.

### Command palette (Cmd/Ctrl+K)

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Unified command/file/session search-and-select | `packages/app/src/components/dialog-command-palette-v2.tsx` + `command-palette.ts` | MIT | **REIMPLEMENT** | Solid resources/memos; the *merge strategy* (commands+sessions+files into one ranked, grouped list) is the reusable idea. |
| Default keybind | `packages/app/src/context/command.tsx` | MIT | **REUSE** (the value) | `export const DEFAULT_PALETTE_KEYBIND = "mod+k,mod+shift+p"` — both Cmd/Ctrl+K *and* Cmd/Ctrl+Shift+P open it. |
| Dialog visual chrome | `packages/app/src/components/dialog-command-palette-v2.css` | MIT | **REUSE** | Plain CSS, no Solid dependency — copy near-verbatim. |

Behavior: with an empty query it shows "preferred commands" + "recent
files"; once typing, it concurrently searches files (async) and sessions
(sync from cache) and merges with command matches, deduped by id
(`uniqueCommandPaletteEntries`), grouped by category, each row rendered with
an icon + title + muted description/meta, active row highlighted.

Reusable CSS (`dialog-command-palette-v2.css`, values worth matching exactly):
```css
[data-slot="dialog-container"] {
  width: min(calc(100vw - 24px), 640px);
  max-height: min(calc(100vh - 96px), 480px);
  margin-top: max(48px, calc((100vh - 480px) / 2));  /* anchored near top, not vertically centered */
  border-radius: 12px;
}
.command-palette-v2-row { height: 36px; border-radius: 6px; padding: 0 12px; }
.command-palette-v2-row[data-active] { background: var(--v2-overlay-simple-overlay-hover); }
.command-palette-v2-group-title { font-size: 13px; font-weight: 440; color: var(--v2-text-text-muted); }
```
640px max width, 36px-tall rows, anchored near the top of the viewport
(not perfectly centered) so it doesn't jump around as result-count changes
its height — all good, concrete, copyable numbers.

---

## 7. Diff / changes rendering

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Compact "+N -M" / mini bar-chart summary (pre-expand) | `packages/ui/src/components/diff-changes.tsx` (115 lines, full file read) + `.css` (44 lines, full file read) | MIT | **ADAPT** | Small, self-contained, no heavy dependency — very close to a direct port. |
| Full expanded diff viewer | `packages/session-ui/src/pierre/*` (wraps `@pierre/diffs`/`@pierre/trees`, virtualized + worker-based) | MIT (wrapper) / separate license for `@pierre/*` (verify before using) | **REIMPLEMENT or skip** | Heavy, virtualization/worker-based dependency — out of scope unless we adopt a real code-editing/diff surface; not needed for V1's context/attachment use case. |

The compact summary component is exactly the "file-list with added/removed
counts before expanding into a full diff" pattern the task asked about, and
it's small enough to essentially transliterate:
- Two variants: `"default"` (text `+12`/`-4` in green/red monospace) and
  `"bars"` (a tiny 18×14 SVG of 5 colored blocks, proportionally allocated
  between additions/deletions/neutral by a deterministic rounding algorithm
  — full algorithm is in the 115-line file, safe to port as-is since it's
  pure arithmetic with no Solid dependency beyond the JSX wrapper).
- Colors: `var(--icon-diff-add-base)` / `var(--icon-diff-delete-base)` /
  `var(--icon-weak-base)` for neutral blocks — reuses the same diff-add/
  diff-delete tokens already defined in `theme.css` (`--text-diff-add-base:
  #9bcd97` dark / `#3a8437` light, `--text-diff-delete-base: #fc533a` dark /
  `#ed4831` light).
- CSS: `font-family: var(--font-family-mono)`, `font-size: 14px`, right-
  aligned, simple two-span layout — trivially portable.

---

## 8. Resizable panels / drag interaction

| COMPONENT | SOURCE PATH | LICENSE | REUSE / ADAPT / REIMPLEMENT | WHY |
|---|---|---|---|---|
| Resize handle (drag-to-resize logic + hit target) | `packages/ui/src/components/resize-handle.tsx` (full file read, ~90 lines) | MIT | **ADAPT** | Pure vanilla DOM (`mousedown`/`mousemove`/`mouseup`), zero framework dependency in the drag math — nearly a direct port, just re-wire the JSX/props to React. |
| Resize handle hit-area/hover CSS | `packages/ui/src/components/resize-handle.css` (full file read) | MIT | **REUSE** | Plain CSS. |

**No resizable-panel library is used** — confirmed by checking
`packages/app/package.json` dependencies (only `@dnd-kit/*` and
`@thisbeyond/solid-dnd` for drag-*reordering* of tabs/sidebar items, plus
`@solid-primitives/resize-observer` for measuring — nothing named
resizable/split/panel). OpenCode implements panel resizing itself with a
small custom `<ResizeHandle>`:

```tsx
// core drag algorithm (framework-agnostic, directly adaptable):
const onMouseDown = (e: MouseEvent) => {
  const start = direction === "horizontal" ? e.clientX : e.clientY
  const startSize = size
  document.body.style.userSelect = "none"       // prevent text selection while dragging
  const onMouseMove = (moveEvent: MouseEvent) => {
    const pos = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
    const delta = /* sign depends on direction + edge + RTL */
    const next = startSize + delta
    if (collapseThreshold > 0 && next < collapseThreshold) onCollapseChange?.(true) // "snap to collapse"
    onResize(Math.min(max, Math.max(min, next)))
  }
  const onMouseUp = () => { document.body.style.userSelect = ""; /* remove listeners */ }
  document.addEventListener("mousemove", onMouseMove)
  document.addEventListener("mouseup", onMouseUp)
}
```
Hit-target CSS pattern: an 8px-wide invisible hit area straddling the panel
edge (`transform: translateX(50%)`), with a thin 3px visible affordance bar
that fades in only on `:hover`/`:active` — i.e. the resize handle is
invisible until interacted with, keeping the UI calm/uncluttered:
```css
[data-component="resize-handle"] {
  position: absolute;
  width: 8px;              /* generous hit target */
  transform: translateX(50%);
  cursor: col-resize;
}
[data-component="resize-handle"]::after {
  content: ""; width: 3px; opacity: 0; transition: opacity 0.15s ease-in-out;
}
[data-component="resize-handle"]:hover::after,
[data-component="resize-handle"]:active::after { opacity: 1; }
```
It also supports a `collapseThreshold` (drag a panel below N px and it
snaps closed via `onCollapse`) — a nice detail for a collapsible sidebar/
context panel in our app.

This is one of the cleanest "port nearly verbatim" opportunities in the
whole investigation: ~90 lines, zero dependencies, well-isolated logic.

---

## 9. Icons (bonus — directly reusable asset class)

`packages/ui/src/components/icon.tsx` stores icons as a plain object of raw
SVG path-data strings keyed by name (not a sprite `<symbol>` file, not an
icon font), e.g.:
```ts
const icons = {
  "arrow-up": `<path fill-rule="evenodd" ... fill="currentColor"/>`,
  "chevron-down": `<path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square"/>`,
  stop: `<rect x="5" y="5" width="10" height="10" fill="currentColor"/>`,
  // ...
}
```
All on a 20×20 viewBox, `currentColor`-based (theme automatically via CSS
`color`). This is pure SVG markup data — **REUSE** directly: copy the path
strings for any icons we need (arrow-up/send, chevron, stop/square,
archive, terminal, file-tree, etc.) into our own icon component. No Solid
dependency whatsoever.

---

## Attribution requirements (MIT license)

Confirmed by fetching `LICENSE` at the repository root (`packages/ui` also
carries an identical copy at `packages/ui/LICENSE`; `packages/app` and
`packages/desktop` have no separate LICENSE file, so the root license
governs the whole monorepo):

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**What this means practically for this project:**

- **REUSE items** (theme JSON, `theme.css`/`colors.css` custom-property
  values, `resize-handle.css`, `list.css`, `diff-changes.css`,
  `basic-tool.css`, `dialog-command-palette-v2.css`, the raw SVG icon path
  strings) — if copied verbatim or near-verbatim into this codebase, MIT
  requires the **copyright notice and permission notice above accompany any
  substantial portion copied**. In practice: add a `THIRD_PARTY_NOTICES.md`
  (or extend `docs/OPEN_SOURCE_INVENTORY.md`, which already tracks this kind
  of thing for this project) entry naming `opencode (c) 2025 opencode,
  MIT License`, with a link to `https://github.com/anomalyco/opencode` and
  the license text, wherever these values are copied wholesale (e.g. as a
  `theme.css` we ship). A source comment (`/* color values adapted from
  opencode, MIT License, https://github.com/anomalyco/opencode */`) at the
  top of the adapted file is good practice in addition to the central
  notices file.
- **ADAPT items** (search-matching functions, diff-changes bar algorithm,
  resize-handle drag math) — these are small enough that a rewrite-with-
  attribution-comment is appropriate: keep a one-line code comment crediting
  the source file/repo even though the code has been translated to React,
  since the *logic* (not just the license text) was taken from there.
- **REIMPLEMENT items** (all Solid component trees/JSX/state machines) — no
  attribution obligation is triggered by writing an original React
  component "inspired by" an observed pattern; MIT's copyright-notice
  requirement attaches to copying the software's expression, not to
  reimplementing an idea. Still worth an internal comment noting "layout
  pattern studied from opencode.ai" for future maintainers, but not a legal
  requirement.
- No trademark rights are granted by MIT — avoid using "OpenCode" branding,
  logo, or name in our product; this doc and any code comments should refer
  to it only as a design reference/inspiration source, not imply
  affiliation or endorsement.
