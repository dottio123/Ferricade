---
name: ferricade
description: Self-hosted admin console for stock RustDesk clients; calm when the fleet is healthy, unmistakable when it is not.
colors:
  background: "#ffffff"
  foreground: "#0f172a"
  card: "#ffffff"
  surface-2: "#f8fafc"
  surface-3: "#f1f5f9"
  primary: "#4338ca"
  primary-foreground: "#ffffff"
  muted-foreground: "#475569"
  accent: "#f1f5f9"
  border: "#e2e8f0"
  input: "#e2e8f0"
  ring: "#4338ca"
  destructive: "#dc2626"
  status-online: "#15803d"
  status-online-fg: "#065f46"
  status-pending: "#92400e"
  status-offline: "#475569"
  status-alert: "#b91c1c"
  status-live: "#4338ca"
  dark-background: "#0b0f19"
  dark-foreground: "#f8fafc"
  dark-card: "#111827"
  dark-surface-2: "#1e293b"
  dark-surface-3: "#334155"
  dark-primary: "#818cf8"
  dark-primary-foreground: "#0b0f19"
  dark-muted-foreground: "#94a3b8"
  dark-border: "#1e293b"
  dark-input: "#334155"
  dark-status-online: "#22c55e"
  dark-status-pending: "#f59e0b"
  dark-status-offline: "#94a3b8"
  dark-status-alert: "#f87171"
typography:
  headline:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  data:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "\"tnum\" 1"
  metric:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "\"tnum\" 1"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  control: "36px"
  control-sm: "28px"
  control-compact: "30px"
  dashboard-row: "176px"
  dashboard-row-compact: "152px"
  gutter: "16px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control}"
    padding: "0 16px"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control}"
    padding: "0 16px"
  button-ghost:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control}"
    padding: "0 12px"
  button-quiet-destructive:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control-sm}"
    padding: "0 10px"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control}"
    padding: "0 12px"
  badge-alert:
    textColor: "{colors.status-alert}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-pending:
    textColor: "{colors.status-pending}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
---

# Design System: ferricade

## Overview

**Creative North Star: "The Quiet Control Room"**

ferricade is the screen an operator glances at between other jobs. When the fleet is healthy the console is close to silent: white or near-black surfaces, slate text, hairline borders, and almost no colour. Colour, weight and size are spent only where something needs the admin: a device waiting for approval, a UUID mismatch, a session in progress, a dropped connection. The page should get quieter as the fleet gets healthier, never busier.

Density is that of an operations tool, not a marketing dashboard. Lists are tight, numbers are exact and set in mono, and every module fits its grid box without clipping in both densities. The look is precise but not austere: controls have clear affordances, focus is always visible, and destructive actions are labelled in words, not icons alone. This is the "middle ground" component feel the user chose (option C) over a flatter, icon-only version and a heavier, shadowed one.

The base theme is indigo on slate. It is one of six themes (Default, Graphite, Ocean, Violet, Moss, Sandstone): the system is built so that a theme changes colours only, and every theme ships a light and a dark variant.

**Key Characteristics:**
- Calm by default; the accent marks place and action, status colours mark status.
- Flat surfaces separated by 1px hairlines; only overlays lift.
- Inter for words, JetBrains Mono for machine values (IDs, versions, counts, timers).
- Labelled, low-key destructive actions; visible focus everywhere.
- Every colour comes from a semantic token, so a theme can replace them all.

## Colors

Slate neutrals carry the interface; indigo marks what you can act on; four status hues say what state a device is in.

### Primary
- **Control-Room Indigo** (#4338ca light / #818cf8 dark): primary buttons (Approve, Save layout), links, the focus ring, the selected preset, and the "Live" connection state. It is the base theme's accent, not part of the contract: another theme supplies its own.

### Neutral
- **Paper** (#ffffff) / **Night Console** (#0b0f19): the page background.
- **Card** (#ffffff / #111827): module and panel surfaces.
- **Raised Slate 2 and 3** (#f8fafc, #f1f5f9 / #1e293b, #334155): hover rows, pressed states, track fills, secondary surfaces.
- **Ink** (#0f172a / #f8fafc): primary text.
- **Slate Muted** (#475569 / #94a3b8): secondary text, icons, idle destructive buttons.
- **Hairline** (#e2e8f0 / #1e293b): every border and divider.

### Frame and Navigation
- **Chrome** (`--chrome`): sidebar and header frame surface carrying a faint (2-4%) tint of the accent over neutral.
- **Chrome Foreground** (`--chrome-foreground`): text, labels, and icons sitting on the chrome surface.
- **Nav Active** (`--nav-active`): tinted accent background fill for the selected navigation item, active tabs, and option selectors.
- **Nav Active Foreground** (`--nav-active-foreground`): saturated accent-family text and icons on the active navigation surface.

### Status (semantic, separate from the accent)
- **Online Green** (#15803d / #22c55e): online devices, healthy progress bars.
- **Pending Amber** (#92400e / #f59e0b): waiting for approval, pending counts, "Reconnecting…".
- **Offline Slate** (#475569 / #94a3b8): offline devices.
- **Alert Red** (#b91c1c / #f87171): UUID mismatches, open alerts, failures.
- **Destructive Red** (#dc2626): the colour a destructive control turns on hover and in confirmations.

### Graphite Theme
Neutral zinc greys, near-monochrome restraint; the primary action is ink-dark in light mode and near-white in dark mode. The quietest theme in the console.
- Primary: #18181b (light) / #f4f4f5 (dark)
- Background: #fafafa (light) / #09090b (dark)

### Ocean Theme
Cool slate neutrals with a cerulean and sky blue accent, lighter and bluer than Default's indigo.
- Primary: #0369a1 (light) / #38bdf8 (dark)
- Background: #f8fafc (light) / #07131e (dark)

### Violet Theme
A vibrant royal violet accent set against neutrals carrying a subtle purple tint.
- Primary: #6d28d9 (light) / #a78bfa (dark)
- Background: #fbfaff (light) / #0f0c1b (dark)

### Moss Theme
Muted olive-tinted neutrals with a deep olive accent in light mode and a lively sage-olive accent in dark mode. Softer and greener than Default and Ocean, kept apart from status green by tone and saturation.
- Primary: #3f5a2a (light) / #a3b88c (dark)
- Background: #f6f8f5 (light) / #101411 (dark)

### Sandstone Theme
Warm stone neutrals paired with a deep earthy umber in light mode and an architectural sandstone tan in dark mode. The warm theme of the console, kept apart from pending amber by tone.
- Primary: #54462e (light) / #bfa674 (dark)
- Background: #faf8f5 (light) / #141210 (dark)

### Named Rules
**The Theme Contract Rule.** A theme is a complete set of the semantic colour tokens (surfaces, text, border, input, ring, primary, destructive, the five status colours, the five chart colours), defined twice: once for light and once for dark. The API field is `palette`, offering six options: `default`, `graphite`, `ocean`, `violet`, `moss`, and `sandstone`. A theme changes colours only; fonts, corner radii, spacing, control heights and the dashboard row are shared by every theme, so modules fit their boxes whatever the theme. Each admin picks a theme and a light, dark or system mode in their own preferences. Components never name a palette colour (`text-slate-500`, `bg-indigo-600`); `src/styles/no-palette-colors.test.ts` enforces it.

**The Accent Marks Place And Action Rule.** The theme's accent shows where you are and what you can act on: the primary action, the current page in the navigation, active tabs, switches and selected options, links, focus, and a faint tint in the sidebar and header. It never marks status.

**The Status Is The Colour Rule.** Amber and red appear only when a device is pending or in trouble, and they always come with a word or icon, never colour alone.

**The Contrast Floor Rule.** Every text colour meets WCAG AA on every surface it sits on, including the tinted status backgrounds, in both modes of every theme.

## Typography

**Body Font:** Inter Variable (with ui-sans-serif, system-ui)
**Data Font:** JetBrains Mono Variable (with ui-monospace)

**Character:** Inter is neutral and legible at small sizes; JetBrains Mono gives machine values a distinct voice, so an ID or a timer never reads as prose.

### Hierarchy
- **Headline** (700, 1.5rem, 1.2, tracking -0.025em): the page title (`Command center`, `Groups`). One per page.
- **Title** (600, 0.875rem, 1.4): module and panel titles.
- **Body** (400, 0.875rem, 1.5): list rows, descriptions, form text.
- **Label** (500, 0.75rem): secondary lines, captions, tile labels, badges.
- **Data** (JetBrains Mono 500, 0.75rem, tabular figures): RustDesk IDs, versions, durations, counts in pills.
- **Metric** (JetBrains Mono 600, 1.875rem, tabular figures): fleet pulse numbers. The wall preset scales these up with its own tokens.

### Named Rules
**The Mono Means Machine Rule.** JetBrains Mono is for values a machine produced: IDs, versions, counts, durations, IPs. Labels, headings and prose stay in Inter. A theme cannot change this.

**The 12px Floor Rule.** Text is 12px (0.75rem) or larger. The one exception is an 11px `--text-2xs` token for badges inside dense lists. Nothing is 10px, and nothing is sized with an arbitrary `text-[Npx]` value.

## Layout

The app is a sidebar (240px, 64px collapsed) beside a 56px top bar and a scrolling content area padded 16px on phones and 24px from 768px. At phone width the sidebar becomes a sheet.

The command center is a bento grid of fixed-height rows: 1 column on phones (rows size to content), 2 columns from 768px, 4 columns from 1024px. A row is 176px in comfortable density and 152px in compact. Modules span the columns and rows their size allows, and presets are ordered so they leave no holes. Gaps are 16px.

Density changes control heights (36px to 30px), table cell padding and the dashboard row, nothing else. The Monitoring wall preset fits one screen from 1024px and can drop the app chrome in kiosk mode.

## Elevation & Depth

Flat by default. Cards, tiles, tables and inputs sit on the page with a 1px hairline border and at most an extra-small shadow (`shadow-xs`); depth comes from the surface steps (card, surface-2, surface-3), not from shadows. Only things that float above the page lift: dialogs, sheets, menus, popovers, the command palette and toasts.

### Named Rules
**The Only Overlays Lift Rule.** A surface that stays in the page never gets a shadow larger than `shadow-xs`, never lifts on hover, and never glows. Hover is a background shift to the accent surface.

## Shapes

Gently rounded: 6px on controls and badges, 8px on cards, tiles, dialogs and the dashboard edit canvas, 4px on small controls and key caps, and full pills only for status dots and counts. Borders are 1px hairlines in the border token. Lists separate rows with the same hairline; there are no card-in-card nests.

## Components

### Buttons
Precise and legible, never decorative.
- **Shape:** gently rounded (6px), 36px tall (30px compact), 28px for small row actions.
- **Primary:** indigo fill, white or dark text by mode, medium weight; one primary action per region (Approve in a row, Save layout in edit mode). Hover darkens the fill; no lift, no glow.
- **Outline:** card background with a hairline border for secondary actions (Connect, Customize).
- **Ghost:** muted text, accent background on hover (Change layout, toolbar actions).
- **Quiet destructive:** Reject and Remove are labelled in words, muted at rest, and turn destructive red with a faint red tint on hover. Destructive actions that cannot be undone open a confirmation dialog; those that can be undone show a toast with Undo.
- **Focus:** a visible ring in the ring token on every control, with a soft outer halo; never removed.

### Badges and counts
- **Status badges:** a 6px-rounded label with a 11% tint of the status colour behind status-coloured text (`UUID mismatch`, `Pending long`, `Remote`). Always text, never a coloured dot alone.
- **Counts:** a tinted mono pill next to a module title (`6` waiting in amber).

### Cards / Modules
- **Corner Style:** 8px.
- **Background:** card token.
- **Shadow Strategy:** none beyond `shadow-xs`; see Elevation.
- **Border:** 1px hairline. The header is separated from the body by a hairline, not by a tinted band.
- **Internal Padding:** 16px; list rows 10 to 12px vertically.
- **States:** loading (skeleton), empty (a plain sentence), error (`ModuleErrorState` with Try again, never an empty message), and data kept on screen through a failed refetch.

### Inputs / Fields
- **Style:** hairline border in the input token, background token, 6px radius, 36px tall.
- **Focus:** the border turns to the ring colour with a soft halo.
- **Error / Disabled:** destructive border and halo for invalid; 50% opacity for disabled.

### Navigation
Sidebar links in body type with an icon; the active page has the `--nav-active` surface and `--nav-active-foreground` text. Collapsed links keep accessible names. The pending count sits beside Devices as an amber count.

### Links
Plain text in the primary colour with an underline on hover. No trailing arrows or other glyphs; one "view all" link per module, in its header.

### Fleet pulse (signature)
Four readouts in one hairline-divided strip: a mono metric, a label above it, and one line of plain context below ("71% online · 8 offline", "2 waiting more than 24 h"). A number turns amber or red only when it needs action, and then links to the devices it counts.

## Do's and Don'ts

### Do:
- **Do** take every colour from a semantic token, so each theme's light and dark variants apply everywhere.
- **Do** set IDs, versions, counts and durations in JetBrains Mono with tabular figures.
- **Do** label destructive actions in words, and give undoable ones an Undo toast.
- **Do** keep a visible focus ring on every interactive element.
- **Do** keep every module inside its grid box at every size, in both densities (`e2e/module-fit.spec.ts`).
- **Do** use lucide icons for symbols, and the literal character when text needs one (never a CSS escape that can be mangled into a missing glyph).

### Don't:
- **Don't** use palette colour classes or hex values in components; only tokens.
- **Don't** let a theme change fonts, radii, spacing, control heights or the dashboard row.
- **Don't** set text below 12px, except the 11px `--text-2xs` badge token; never `text-[10px]`.
- **Don't** lift, glow or shadow in-page surfaces on hover; only overlays lift.
- **Don't** use colour as the only signal of state.
- **Don't** add trailing arrows or decorative glyphs to links and buttons.
- **Don't** add `<style>` elements, `style="…"` strings or inline scripts; the CSP blocks them (React `style` props are fine).
