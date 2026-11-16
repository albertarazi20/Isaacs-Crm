# Selective CRM — the design system

The look every page follows. Decided with the owner on 2026-11-16: **precise and minimal** (Linear / Attio
register), **light by default with a dark switch**, **compact** lists, the **Selective Capital brand** (Geist,
the S logomark, the blue → violet → fuchsia gradient), **top bar** navigation. Premium means quiet: hairline
borders, one accent, numbers that line up, nothing decorative.

## Tokens (src/app/globals.css)

Every colour is `light-dark(light, dark)`; the `html[data-theme]` attribute (cookie `theme`: light | dark |
system) sets `color-scheme`, so one token set serves both modes. Components use the Tailwind names, never hex.

| Use                           | Class                              | Light                            | Dark             |
| ----------------------------- | ---------------------------------- | -------------------------------- | ---------------- |
| Page background               | `bg-bg`                            | #f6f6f8                          | #0a0a0f          |
| Card / popover                | `bg-surface`                       | #ffffff                          | #13131a          |
| Inset, hover, pill            | `bg-surface-2`                     | #f1f1f5                          | #1b1b24          |
| Row hover                     | `bg-surface-3`                     | #f8f8fa                          | #17171f          |
| Hairline                      | `border-border`                    | #e5e5ec                          | #272730          |
| Hover / focus border          | `border-border-strong`             | #cfcfda                          | #3a3a46          |
| Primary text                  | `text-text`                        | #0a0a10                          | #ededf2          |
| Secondary text                | `text-text-2`                      | #45454f                          | #c3c3cd          |
| Labels, meta                  | `text-muted`                       | #6e6e7e                          | #8f8f9f          |
| Accent (links, active, focus) | `text-accent` `bg-accent`          | #7c3aed                          | #a78bfa          |
| Accent tint                   | `bg-accent-soft`                   | #f2ecff                          | #241d3b          |
| Good / warn / bad / info      | `text-good` … with `-soft` tints   | green / amber / red / blue       | lighter variants |
| The brand gradient            | `bg-[image:var(--brand-gradient)]` | primary button and logomark only | same             |

Radius: controls `rounded-lg` (10px), cards `rounded-xl` (14px), sheets and the login card `rounded-2xl` (18px),
badges `rounded-md`. Shadows: `shadow-card` (whisper, every card gets it automatically), `shadow-lift` (hover on
link cards), `shadow-pop` (menus, dialogs). Focus: 2px accent outline for the keyboard; inputs get a `ring-ring`.

Type: Geist. Page title `text-xl font-semibold tracking-tight` (phone) / `text-2xl` (desktop). Section title
`text-[13px] font-semibold`. Body `text-sm`. Meta `text-xs text-muted`. Table text `text-[13px]`. KPI numbers
`text-[26px] font-semibold tabular-nums`. Labels over numbers `text-[11px] font-semibold uppercase
tracking-wide text-muted`. All numbers in columns: `tabular-nums` (tables get it automatically).

## Primitives (src/components/ui.tsx, overlay.tsx)

- `Button` variants: `primary` (gradient; one per screen), `secondary` (bordered), `ghost`, `danger`. Sizes
  `md` (36px desktop / 40px phone) and `sm` (32 / 40). Pressed states dim; nothing moves.
- `Input`, `Select`, `Textarea`, `Field` (label above, hint below). `Badge` tones neutral / good / warn / bad /
  accent / info. `Card`, `SectionTitle`, `EmptyState`, `LinkButton`.
- `Dialog` (centred on desktop, bottom sheet on phones), toasts bottom-centre, `useToast`.

## Page anatomy

1. **Page header**: title left, one-line context under it (date, count, who), actions right (one primary at
   most). `flex items-end justify-between gap-4`, `mb-5`.
2. **Toolbar** (lists only): filter chips with counts as `Badge`-sized pills (`h-8 rounded-full border px-3
text-[13px]`, active = `bg-text text-bg` or `bg-accent-soft text-accent`), search on the right, sort as a
   `Select`. Sticky under the header on long lists.
3. **Content**: a `Card` for each block; tables inside cards with `p-0`; sections 24px apart (`space-y-6`).
4. **Side rail** (dashboard, deal page): `xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]`, every grid child
   `min-w-0` (nothing scrolls sideways on a phone).

## Lists and tables

- Compact rows: 40px desktop (`py-2`), 48px phone. `divide-y divide-border`. Hover `bg-surface-3`. The row is
  a link where it opens something; row actions appear on hover (`group-hover:opacity-100`) on desktop and are
  always visible on phones.
- Header row: `text-[11px] font-semibold uppercase tracking-wide text-muted`, `bg-surface-2/60`, sticky.
- Money right-aligned, tabular. Status as a `Badge`, never colour alone (the word is always there).
- Phone: tables become stacked cards (`sm:table`), or scroll inside their card (`overflow-x-auto` on the card,
  never on the page).

## Forms and dialogs

- Labels above fields, 12px. Errors below the field in `text-bad`. One primary button, right-aligned, with the
  ghost Cancel to its left. Destructive actions are `danger` and sit apart.
- Dialogs: `max-w-lg`, `rounded-2xl`, `shadow-pop`, title `text-base font-semibold`, body `p-5`. On a phone a
  dialog is a bottom sheet with a grab handle and safe-area padding.

## Motion

150–200ms, `transition` on colour and shadow only. Toasts slide 8px. No entrance animations on lists. Reduced
motion is honoured globally.

## Do not

- No raw hex in components. No emoji as icons (inline SVG from the Lucide set, 16px, `stroke-width 1.75`).
- No uppercase section titles (that was the old look); uppercase is for the 11px labels over numbers only.
- No second gradient, no coloured card backgrounds, no shadows heavier than `shadow-pop`.
- No layout that moves on hover or press.
