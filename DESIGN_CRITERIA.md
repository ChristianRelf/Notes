# Design criteria

How Kern should look, read and behave, so that a new screen feels like it was
always there. [CLAUDE.md](CLAUDE.md) covers code conventions and invariants;
this covers the interface. When the two meet - styling, components, errors -
both apply.

Use it three ways: read **Principles** once, check **Choosing a pattern**
when you start a screen, and run the **Checklist** before you call it done.

## Principles

1. **Calm by default.** Kern is greyscale. Colour is a personal accent or a
   restrained signal (warning, danger, update), never decoration. A screen at
   rest should have nothing competing for attention.
2. **Say where things stand, then offer one way in.** A row, card or header
   shows the current state in words ("Listening · 2 connected", "Tested 3d
   ago") and offers the single most likely action. Everything else is one
   click deeper.
3. **Simple first, everything reachable.** The common path needs no
   configuration; every option still exists. Fold the rest away
   (Disclosure, "Model and organisation…", a Manage dialog) rather than
   deleting it or putting it all on screen at once.
4. **Honest about consequences.** If something leaves the computer, costs
   money, runs a program, or can't be undone, say so plainly at the point of
   decision, in one sentence. Don't reassure with ceremony the code doesn't
   back up.
5. **Reversible over confirmed.** Prefer doing it and offering Undo to asking
   "are you sure?". Deletes go to Trash. Only irreversible actions get a
   confirm.
6. **Local and quiet.** No background chatter: no polling where an event
   exists, no toasts for things the person can already see, no spinners for
   work under ~150 ms.
7. **One way to do a thing.** Reach for the shared component before writing
   a control. A second visual dialect for the same idea is a bug, even if it
   looks nice.

## Visual language

Everything comes from `src/styles/tokens.css`. Light, dark, accent, density,
font and motion are all redefined there, so a hard-coded value breaks at
least one of them.

### Colour

| Use | Tokens |
| --- | --- |
| Page and panels | `--bg`, `--bg-sunken` (wells, code, inputs at rest), `--surface`, `--surface-2` (dialogs), `--surface-3` (buttons, chips) |
| Interaction | `--hover`, `--hover-strong`, `--active`, `--selection` |
| Lines | `--border`, `--border-subtle` (group outlines), `--border-strong` (emphasis), `--divider` (between rows) |
| Text | `--text` → `--text-2` (secondary) → `--text-3` (hints) → `--text-4` (disabled, idle dots) |
| Accent | `--accent`, `--accent-fg`, `--accent-soft` (selected fill), `--accent-line` (selected border) |
| Signals | `--danger` / `--danger-soft`, `--warning`, `--update` / `--update-soft` |
| Series | `--hue-0…7`, for charts and lanes only |

- Never write a hex or `rgba()` in feature CSS. If no token fits, add one to
  `tokens.css` with values for both themes.
- A signal colour is never the only signal. Pair it with words or a shape:
  the status pill is a dot *and* a label.
- Selected means `--accent-soft` fill + `--accent-line` border (radio cards,
  drop targets). Don't invent a second selected style.

### Type

`--fs-2xs` 10.5 · `--fs-xs` 11.5 · `--fs-sm` 12.5 · `--fs-md` 13.5 ·
`--fs-lg` 15 · `--fs-xl` 18 · `--fs-2xl` 21 (all scale with the font-size
setting).

| Role | Size / weight / colour |
| --- | --- |
| Page title, settings heading | `--fs-xl`, 600 |
| Dialog title | `--fs-lg`, 600 |
| Body, row label | `--fs-md` |
| Controls, buttons, lists in dialogs | `--fs-sm`, 500 for buttons |
| Hints, meta, captions | `--fs-xs`, `--text-3` |
| Group title | `--fs-sm`, 600, `--text-2` |

Weights are 400, 500, 550 (names, emphasised labels) and 600 (titles). Use
`.mono` for paths, commands, ids, keys and tool names; `.tabular` for numbers
that update or line up.

### Space, size, shape

- Heights: `--control-h` (30) for controls, `--control-h-sm` for controls
  inside rows and toolbars, `--row-h` for list rows, `--nav-item-h` for nav.
  They change with density, so never fix a control's height in px.
- Gaps of 4, 6, 8, 10, 12, 14, 16, 20 px. Groups are 18-20 apart; fields in a
  dialog 14; a label to its hint 1-2.
- Radius: `--r-sm` for controls, `--r-md` for wells and lists, `--r-lg` for
  cards and groups, `--r-xl` for dialogs.
- Elevation is for things that float: `--shadow-pop` for menus, popovers and
  dialogs. Cards on a page are a border, not a shadow.

### Icons

`lucide-react`, `strokeWidth={1.75}`. 16 in navigation and page headers, 14
in buttons and rows, 12-13 inline with small text, 15-16 in a dialog's title
or callout. An icon beside a label is optional; an icon *instead of* a label
needs a tooltip and an `aria-label` (`IconButton` does both). Brand marks
come from `BrandIcon` with Simple Icons; never draw an imitation logo.

### Motion

Use `--t-hover`, `--t-press`, `--t-menu`, `--t-panel`, `--t-layout` with
`--ease` / `--ease-out`, and `--enter-scale` / `--enter-shift` for entrances.
These collapse under `data-motion="reduced"` and `"off"`, which is how Kern
honours `prefers-reduced-motion` - so a literal `200ms` is a bug. Motion
explains a change (something opened, moved, finished); it never decorates.

## Layout and navigation

- **A page** is `.page` with a 46px `.page-header` (icon + title, actions on
  the right) and its body. Lists and boards fill the width; reading content
  and settings cap at ~760px.
- **Navigation lives in rails, never in the body.** The app sidebar moves
  between pages; the settings rail moves between sections and, for a
  section with pages of its own (API), lists them indented beneath it while
  it's open. Don't put a tab strip inside a settings section: `.tabs` is for
  page headers.
- **Details open where the person chose.** Task details follow
  `general.detailMode` (side panel, dialog or page); a new detail view should
  respect the same setting where it can.
- **Kern Lite** runs over the same data in a small window. Anything global -
  a dialog raised by a backend event, a toast action - must work there too:
  mount hosts in both `Shell.tsx` and `LiteApp.tsx`.

### Settings

Settings is the model for any screen that configures something.

- A section is a stack of **groups**: a `set-group__title` and a
  `set-group` of `set-row`s. Build it as `GroupDef[]` (see
  `useAssistantGroups`, `useCalendarGroups`) so settings search finds every
  row; a section that returns arbitrary JSX can't be searched.
- A **row** is a label (what it is), a hint (what it does, or where it stands
  now), and one control on the right. Buttons in rows are `size="sm"`.
- A row that would need more than one control, a list longer than a few
  items, or a form opens a **dialog** from a button in the row ("Manage…",
  "View…"). Rows for things that come and go (accounts, servers, connected
  apps) are one row per thing, with a stable `id` on the `RowDef`.
- Every key in `schema.ts` that a person can change has a row, with
  `keywords` for the words someone might search with.

## Choosing a pattern

### Controls

| The choice is… | Use |
| --- | --- |
| On / off, applies immediately | `Switch` (`SToggle` in settings) |
| 2-4 options whose labels say it all | `Segmented` (`SSegmented`) |
| Many options, or labels that are values | `Select` (`SSelect`) |
| 2-6 options that each need a sentence to explain | `RadioCards` |
| A number with bounds | `SNumber`, with a unit suffix |
| Several of a list | Checkboxes in a dialog list; a `Dropdown` with checked items only for short lists |
| Actions on one item | A `Dropdown` from an `Ellipsis` `IconButton`, destructive last after a separator |

### Containers

| The task… | Use |
| --- | --- |
| Is one setting | A settings row |
| Needs a few related decisions about one thing | `Dialog` (520 wide; `wide` for 760) |
| Has a sequence - a later decision depends on an earlier one, or something has to happen between (start a server, wait for an app to connect) | `Wizard` |
| Is irreversible | `confirm()` / `confirmDelete()` |
| Needs one word or name | `prompt()` |
| Is a small picker anchored to a control | `Popover`, `DatePicker`, `Dropdown` |
| Is an outcome to read beside its cause | `Callout` |
| Already happened elsewhere | `toast()` |

### Multistep modals (`Wizard`)

`src/components/ui/Wizard.tsx`. It lays every flow out the same way: a
stepper along the top, one step's body, and a footer that reads
**Back · why-not · secondary · primary**.

- **Two to four steps**, each named with a verb or noun ("Choose", "Set up",
  "Approve"). More than four means the flow is doing two jobs. (The
  workspace creator's side-rail wizard is the one longer flow; don't copy it
  for short ones.)
- **Open each step with one lead sentence** (`.wizard-lead`) saying what
  this step is for.
- **The first step works with defaults.** Pre-select the common choice so
  Continue is enabled on arrival.
- **Do the work, don't describe it.** If Kern can write the config, start the
  server or turn the setting on, put that behind a button in the step, and
  show the result in a `Callout`. Copy-paste (`CopyBlock`) is the fallback.
- **One primary button on screen.** Buttons inside a step are default
  buttons; the footer's is the primary. When a step's decision is made in
  the body (approve or block), the footer steps down (`quiet`) to a way out
  ("Decide later").
- **End on the outcome, not on instructions.** A flow that sets something up
  ends by confirming it works - the test result, the connected assistant -
  and offers the next useful thing.
- **Say why Continue is disabled** with `blocking`, in a sentence ("Choose at
  least one folder."). Never a disabled button with no reason.
- **Long-running steps set `busy`**: Back, close and the stepper lock, and
  the primary button shows a spinner. Say what is happening and roughly how
  long ("The first start can take a minute").
- **Advanced options fold away** inside the step that owns them, with a
  one-line summary of what's set when folded.
- **Save before you test.** A test must run what's saved, not what's on
  screen. If a flow saves part-way, closing it leaves a sane saved state and
  the last step says what that is.
- Editing an existing thing opens the same wizard at the step that matters,
  with a quick way out ("Save without testing").

### Dialogs

- Title says what this is about, as a noun phrase or a question for confirms
  ("Forget Claude Desktop?"). A request from something else is phrased as
  that thing asking ("Claude Desktop wants to connect").
- Footer: secondary and destructive actions left (`marginRight: auto`), then
  Cancel / Not now, then the primary on the far right. One primary button.
- If choices apply only on the primary button, say nothing changes until
  then. If they apply immediately (managing something that already exists),
  the footer has **Done**, not Save.
- Autofocus the first field, or the primary button when there is no field.
  For a dangerous request, focus the safe answer.
- Dialogs of settings code are lazy (`lazy(() => import(…))`) and rendered
  only while open.

## Behaviour

- **Mutations** follow the idiom in CLAUDE.md: optimistic patch, command,
  invalidate, `pushUndo`, rollback with a retryable `toastError`.
- **Loading** is a `Skeleton` the shape of what's coming. Spinners only for
  something the person started and is waiting on.
- **Empty** is an `EmptyState`: what would be here, and the button that puts
  something here.
- **Errors** go through `describeError(e, fallback)`, and the fallback starts
  "Couldn't…" and names the thing ("Couldn't save the server."). Never show a
  raw error string. An error inside a flow is a `Callout` next to the cause,
  with a way to try again; a toast is for errors from somewhere else.
- **Live state** comes from `kern://` events invalidating a query domain.
  Poll only when no event exists, only while the screen is visible, and
  faster only while someone is actively waiting (the connect flow's 2 s).
- **Secrets** are never shown unless the person asks, masked by default
  (show / copy / rotate), and copy actions say the copied text is a
  password.
- **Something from outside asks for attention** (an app connects, a write
  needs approval): a toast whose action opens the decision in place. Don't
  send the person to Settings to find it.

## Writing

- **British English**: organisation, behaviour, colour, summarise, minimise.
- **Sentence case** for everything: titles, labels, buttons, menu items.
- **Second person, present tense, plain words.** "Kern runs it as you", not
  "The command will be executed with user privileges".
- **Labels** name the thing or the decision, no full stop ("Ask before
  changes"). **Hints** are full sentences with full stops; one or two, never
  a paragraph.
- **Buttons** are verbs ("Add server", "Approve", "Turn on"). An ellipsis
  means "opens something where you'll decide more" ("Connect…", "Remove…");
  no ellipsis means it acts now.
- **State words**: Connected, Listening, Waiting for approval, Blocked, Not
  tested yet, Wouldn't start. Pair with a dot pill (`.mcp-status`,
  `.ai-status`), not colour alone.
- **Times** are relative (`relativeTime`): "used 2h ago", "tested 3d ago".
  Counts agree with their noun ("1 tool", "3 tools").
- **Dashes** in UI strings are a spaced hyphen (` - `); em dashes belong to
  Markdown and release notes.
- **Toasts** are past tense and name the thing: "Added Playwright", "Forgot
  Claude Desktop", "Command copied".
- No exclamation marks, no "Oops", no "simply"/"just", no blaming the person.

## Accessibility

- Every control has an accessible name: `label` on `Switch` and `Checkbox`,
  `ariaLabel` on `Segmented`, `Select` and `RadioCards`, `label` on
  `IconButton`.
- Keyboard reaches everything; Enter and Space activate, Escape closes.
  Reordering has a keyboard path (Alt+↑/↓) and announces the result.
- Changes that don't move focus (a step changing, a background event,
  a reorder) are spoken with `announce()`.
- Respect the motion tokens (above), and never rely on hover alone to
  reveal a required action.

## Checklist for a new screen

- [ ] Every colour, size, radius and duration is a token; it looks right in
      light, dark, an accent, compact and relaxed density.
- [ ] Built from `src/components/ui` and the settings controls; no new
      look-alike control.
- [ ] Navigation in a rail, not a tab strip in the body.
- [ ] Settings rows are `GroupDef[]` with `keywords`; dynamic rows have `id`s.
- [ ] Each row shows state in words and offers one way in; extra options are
      in a dialog or folded away.
- [ ] Multi-decision tasks are a `Dialog`; sequences are a `Wizard` that
      ends on a working outcome.
- [ ] Destructive actions are reversible or confirmed; deletes go to Trash.
- [ ] Loading, empty and error states all exist and read well.
- [ ] Copy is British, sentence case, second person, with consequences said
      plainly.
- [ ] Accessible names, keyboard path, announcements, reduced motion.
- [ ] Works in Kern Lite if it's global; heavy or settings-only code is lazy.

## Not precedents

These exist and work, but predate the criteria above. Don't copy them into
new work; bring them in line when you're next in the file.

- **Settings → API → Accounts** uses its own expanding account cards with an
  in-card property grid (`.ai-account`, `.ai-details__grid`) and a large
  account picker (`.ai-active`). The criteria's version is one row per
  account with a Manage dialog.
- **Settings → API → Usage** uses bespoke stat tiles and bars (`.ai-tile`,
  `.ai-strip`). New charts take their colours from `--hue-*` and use the
  shared chart tooltip (`.chart-tip`) rather than starting another set.
- **Create workspace** is a five-step side-rail wizard with its own styles in
  `cloud.css`.
- A few feature stylesheets (`cloud.css`, `habits.css`, `lite.css`, and the
  accent swatch in `pages.css`) still contain literal colours.
