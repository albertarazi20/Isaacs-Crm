# Selective CRM — the design system ("Obsidian")

The look every page follows. Rebuilt on 2026-11-16 after the owner rejected the first, minimal pass as plain:
the product must **feel expensive**. So: **dark by default** (light is the same system on paper), a near-black
canvas lit by the brand's own blue, violet and fuchsia in the corners, panels that read as smoked glass, pill
controls, and one gradient that only the primary action, the logo and the headline figures carry.

## Structure

- **Four places, each a dropdown in the left sidebar** (`src/lib/nav.ts`, `src/components/shell/Sidebar.tsx`):
  Overview, Follow Up (every bucket with its live count), Merchants (all merchants, call list, power dial,
  import, trash), Settings (my account, buckets and templates, lead sources, email, team, AI). Alerts and the
  account (colour mode, log out) sit at the foot. Under 1024px the rail becomes a top bar whose menu button
  slides the same rail in.
- **Adding a lead is a button, never a page.** `NewLeadProvider` (`src/components/shell/NewLead.tsx`) holds one
  slide-over sheet that every "New lead" button opens over the page you are on. Press **N** anywhere. The old
  `/lead-intake` address redirects to `/?new-lead=1`, which opens it.
- **Search is ⌘K** (`GlobalSearch`); the sidebar field and the phone bar's button open the same palette.
- **Work stays on the page.** Detail and edit flows open in a `Drawer` (right slide-over); `Dialog` is for
  confirmations and short forms.

## Tokens (src/app/globals.css)

Every colour is `light-dark(light, dark)`; `html[data-theme]` (cookie `theme`: light | dark | system, default
dark) sets `color-scheme`, so one token set serves both modes. Components use the Tailwind names, never hex.

| Use                      | Class                            | Light   | Dark    |
| ------------------------ | -------------------------------- | ------- | ------- |
| Canvas                   | `bg-bg`                          | #f2f2f7 | #06060b |
| Panel                    | `bg-surface`                     | #ffffff | #0e0e16 |
| Inset, hover, pill       | `bg-surface-2`                   | #ededf3 | #191923 |
| Field, quiet fill        | `bg-surface-3`                   | #f7f7fb | #13131c |
| Hairline                 | `border-border`                  | #e2e2ea | #22222e |
| Hover / focus border     | `border-border-strong`           | #c9c9d6 | #363647 |
| Primary text             | `text-text`                      | #0b0b12 | #f4f4f9 |
| Secondary text           | `text-text-2`                    | #3f3f4c | #c4c4d1 |
| Labels, meta             | `text-muted`                     | #6a6a7b | #8c8ca0 |
| Accent                   | `text-accent` `bg-accent`        | #7c3aed | #a78bfa |
| Accent tint              | `bg-accent-soft`                 | #f1eaff | #1f1838 |
| Good / warn / bad / info | `text-good` … with `-soft` tints | deeper  | lighter |

Material classes: `glass` / `glass-strong` (the rail, sticky bars, sheets, toasts), `bg-brand` + `shadow-glow`
(the one primary action), `bg-brand-soft`, `text-gradient` (headline figures), `ring-brand` (the one hero panel),
`eyebrow` (small-caps labels), `lift`, `stagger`, `skeleton`, `live-dot`. Shadows: `shadow-card` (every panel
gets it, with an inner top highlight), `shadow-lift`, `shadow-pop`, `shadow-glow`. Radius: panels `rounded-2xl`
(20px), sheets `rounded-3xl`, controls and badges are full pills, fields `rounded-xl`.

A panel is written `rounded-2xl border border-border bg-surface`; the stylesheet adds the sheen, the inner
highlight and the depth to every element with those three classes.

## Primitives

`src/components/ui.tsx`: `Button` / `buttonClass` (primary, secondary, ghost, danger; sm, md, lg), `IconButton`,
`Input`, `Textarea`, `Select`, `Field`, `Badge`, `Card`, `SectionTitle`, `EmptyState`, `PageHeader`, `Kbd`,
`Avatar`, `Sparkline`, `ProgressRing`, `Meter`, `Delta`, `StatCard`, `Segmented`, `Skeleton`.
`src/components/overlay.tsx`: `Dialog`, `Drawer`, toasts (`useToast`, `useCall`).
`src/components/fx.tsx`: `CountUp`. `src/components/shell/icons.tsx`: `Glyph`, the app's line icons.

## Rules

- One primary (gradient) action per view. Everything else is glass or ghost.
- Every page opens with `PageHeader`: eyebrow, title, one line of what the page is for, its actions.
- Dense but calm: 13px in lists, `tabular-nums` for figures, rows about 48px, table headers in `eyebrow`.
- Motion is transform and opacity only, 150 to 300ms, and everything clickable answers the press
  (`active:scale-[0.97]`). Dialogs and sheets arrive with a short ease-out; nothing loops. `prefers-reduced-motion`
  and `prefers-reduced-transparency` are honoured in the stylesheet.
- No page scrolls sideways at 390px. Tables stack or scroll inside their own panel.
- Icon-only buttons carry an `aria-label`; focus rings are never removed.
