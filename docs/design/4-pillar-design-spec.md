# 4-Pillar Design Specification

> Design direction for the AI Productivity Dashboard frontend redesign.
> Last updated: 2026-03-09

---

## 1. Aesthetic Direction

### Current State

The existing design uses a two-tone split: a dark header (`#1d1d1b`) with white content cards on a light grey body (`#f4f6f8`). KPI cards have a left accent border in the brand orange (`#F15A2B`). The V2 stylesheet extends this with a full dark-mode base (`#0f172a` background, `#1e293b` cards) and introduces the 4-pillar nav system along a bento grid layout.

The design is functional but generic — it could belong to any analytics SaaS. There is no visual hierarchy distinguishing the four pillars, and KPI numbers lack the visual weight needed to anchor a command-center layout.

### Proposed Direction: Focused Command Center

Evolve toward a **"focused dark instrument panel"** aesthetic — inspired by Raycast and Linear, but with Global-e's warm orange as the anchor energy. The design should feel like a high-precision tool built for one person, not a corporate reporting suite.

Key principles:
- **One number per card dominates.** KPI values should be large enough to read from across the room. No competing elements in the hero tier.
- **Pillar identity.** Each of the four pillars (Performance, Activity, Insights, Growth) gets a distinct accent color so switching pillars feels like changing context, not just scrolling.
- **Purposeful darkness.** The dark base stays, but with subtle surface variation: 3 levels of depth rather than flat cards. Cards should feel like they are slightly raised from the page, not floating.
- **Orange as action, not decoration.** `#F15A2B` is reserved exclusively for interactive elements (active state, primary CTAs, the deep-analyze button) — not for every metric border.

---

## 2. Typography

### Rationale

System fonts (`-apple-system`, `Segoe UI`) read fine but create zero personality. The dashboard needs two distinct voices: one for the data (numbers, labels) that is clinical and precise, and one for headings/pillar titles that is confident and distinctive.

### Recommended Pairing

**Display / KPI values:** `DM Mono` (monospaced, but with designed personality)
- Tabular figures by default — no layout shift as numbers update
- Pairs authority with approachability
- Numbers at 2rem–3rem look engineered, not generic

**Body / UI text:** `DM Sans`
- Same design family as DM Mono — cohesive system
- Optical weights at 300/400/600 cover all hierarchy needs
- Slightly wider than Inter at small sizes — better legibility on dark backgrounds

**Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap');
```

**Application:**
```css
body {
  font-family: 'DM Sans', -apple-system, sans-serif;
  font-weight: 400;
}

.bento-value,
.kpi .value,
.kpi-hero-value {
  font-family: 'DM Mono', monospace;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.pillar-btn,
h1, h2, h3 {
  font-family: 'DM Sans', sans-serif;
  font-weight: 600;
}
```

**Scale:**
| Role | Size | Weight | Font |
|------|------|--------|------|
| Hero KPI value | 3rem (48px) | 500 | DM Mono |
| Standard KPI value | 2rem (32px) | 500 | DM Mono |
| Section title | 0.8rem (13px) | 600 | DM Sans |
| Body / description | 0.82rem (13px) | 400 | DM Sans |
| Label / uppercase tag | 0.68rem (11px) | 600 | DM Sans |

---

## 3. Command Center Bento Grid

### Layout Strategy

The bento grid uses a 12-column implicit layout at desktop. Cards are assigned to tier classes based on the importance of the metric they display.

```
┌──────────────────────────┬────────────┬────────────┐
│  Hero: Sessions This Week │  Cache Hit │  Efficiency│
│       (span 6)            │  (span 3)  │  (span 3)  │
├──────────┬──────────┬─────┴──────┬────┴────────────┤
│ Today    │ Streak   │ Flow State │ Top Model       │
│ (span 3) │ (span 3) │ (span 3)   │ (span 3)        │
├──────────┴──────────┴────────────┴────────────────-─┤
│  Recommendations (full width, dismissible)          │
├───────────────────────────────────┬─────────────────┤
│  Daily Automation Pick (span 8)   │ Deep Analyze    │
│                                   │ (span 4, CTA)   │
└───────────────────────────────────┴─────────────────┘
```

### Hero Card Sizing

Only **one** card per pillar view gets `grid-column: span 2` on desktop. It is the metric that defines the pillar's north-star:
- Performance pillar: Total Sessions (all-time or last 30 days)
- Activity pillar: Output Tokens This Week
- Insights pillar: Behavioral Pattern Summary (text card)
- Growth pillar: Efficiency Trend Sparkline

All other KPI cards are standard (1-column) with a 160px minimum row height.

### Color Coding by Metric Type

```css
/* Token metrics — blue family */
.bento-card[data-metric="tokens"] { --card-accent: #3b82f6; }

/* Cache / efficiency — green family */
.bento-card[data-metric="cache"],
.bento-card[data-metric="efficiency"] { --card-accent: #22c55e; }

/* Error / recovery — amber family */
.bento-card[data-metric="errors"] { --card-accent: #f59e0b; }

/* Cost — purple family */
.bento-card[data-metric="cost"] { --card-accent: #a855f7; }

/* Brand / primary (sessions, activity) */
.bento-card[data-metric="sessions"] { --card-accent: #F15A2B; }
```

Apply the accent as a 2px top border and a subtle background tint:
```css
.bento-card {
  border-top: 2px solid var(--card-accent);
  background: color-mix(in srgb, var(--card-accent) 4%, var(--bg-card));
}
```

### Recommendations Treatment

Recommendations appear in a horizontally-scrollable strip below the hero tier, not as a full-width block. Each rec is a compact pill-card:
- Width: 280px fixed
- Left border: 3px in severity color (`--error`, `--warning`, `--accent`)
- Priority treatment: `critical` cards have a subtle pulsing left border (`animation: borderPulse 2s ease infinite`)
- Dismiss button: `×` icon appears on hover only (reduces visual noise)

### Daily Pick Entry Point

The "Today's Automation Pick" card occupies `span 2` on the bottom row. It uses a typewriter reveal animation when the pillar loads. The card background is `color-mix(in srgb, #F15A2B 6%, var(--bg-card))` to give it warm visual weight without being garish.

The Deep Analyze button sits in an adjacent companion card (`span 1`) with:
- Background: dark, near-black `#111318`
- Border: `1px solid rgba(241, 90, 43, 0.3)` — barely-there orange
- On hover: border brightens to `rgba(241, 90, 43, 0.8)` with a faint orange glow: `box-shadow: 0 0 16px rgba(241,90,43,0.15)`

---

## 4. Motion and Micro-interactions

### Page Load Sequence

Bento cards stagger in using a CSS custom property for delay index:

```css
.bento-card {
  opacity: 0;
  transform: translateY(8px);
  animation: cardReveal 0.3s ease forwards;
  animation-delay: calc(var(--card-index, 0) * 50ms);
}

@keyframes cardReveal {
  to { opacity: 1; transform: translateY(0); }
}
```

Assign `style="--card-index: N"` in HTML (0–11). Total entrance window: ~600ms for 12 cards. This feels fast without being invisible.

### Hover States

```css
.bento-card {
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
.bento-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.08);
  border-top-color: color-mix(in srgb, var(--card-accent) 100%, transparent 0%);
}
```

KPI numbers on hover cards get a brief count-up animation (200ms) using a JS counter utility — this reinforces that the numbers are live data, not static labels.

### Modal Entrance

```css
@keyframes modalReveal {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-box { animation: modalReveal 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
```

Use `cubic-bezier(0.16, 1, 0.3, 1)` (the "overshoot" curve) for modals and drawers — it feels snappy and confident, not floaty.

### Drawer Entrance

Desktop (slide from right):
```css
@keyframes drawerSlideIn {
  from { transform: translateX(32px); opacity: 0; }
  to   { transform: translateX(0); opacity: 1; }
}
```

Mobile (slide up from bottom):
```css
@keyframes drawerSlideUp {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}
```
Duration: 280ms with `cubic-bezier(0.16, 1, 0.3, 1)`.

### Loading Skeleton

Replace spinner with skeleton pulse pattern:
```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-card) 25%,
    color-mix(in srgb, var(--text) 8%, var(--bg-card)) 50%,
    var(--bg-card) 75%
  );
  background-size: 400% 100%;
  animation: shimmer 1.4s ease infinite;
  border-radius: var(--radius-sm);
}
@keyframes shimmer { to { background-position: -400% 0; } }
```

Skeleton cards match the exact height of the real card they replace, so layout does not shift on load.

---

## 5. Dark/Light Mode Strategy

### Recommendation: Dark-first with system-respecting light mode

The V2 stylesheet already has a `prefers-color-scheme: light` override. This is the right approach. Extend it for the 4-pillar design:

**Dark mode (default):**
```css
:root {
  --bg: #0d1117;           /* slightly cooler than current #0f172a */
  --bg-card: #161b22;      /* GitHub-dark influence — distinctive */
  --bg-surface: #1c2128;   /* third level for nested cards */
  --bg-hover: #21262d;
  --border: rgba(255,255,255,0.08);
  --text: #e6edf3;
  --text-dim: #8b949e;
  --text-muted: #484f58;
}
```

**Light mode override (via `prefers-color-scheme: light`):**
```css
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f8fa;
    --bg-card: #ffffff;
    --bg-surface: #f0f3f6;
    --bg-hover: #eaeef2;
    --border: rgba(0,0,0,0.08);
    --text: #1f2328;
    --text-dim: #57606a;
    --text-muted: #8c959f;
  }
}
```

A manual toggle button (moon/sun icon) in the header allows override — store preference in `localStorage('theme')` and apply class `data-theme="light"` on `<html>`. This is a one-afternoon implementation, high user value.

The dark nav header (`#1d1d1b` or the new `#0d1117`) stays dark in both modes — it is a functional element, not a themed one.

---

## 6. Mobile-Specific Patterns

### Bottom Nav Icon Design

The four pillar icons should be custom SVG (24x24 viewbox, 1.5px stroke, rounded line caps). Avoid emoji or system icons — they render inconsistently across platforms.

Suggested icon language:
| Pillar | Icon concept |
|--------|-------------|
| Performance | Bar chart with upward trend line |
| Activity | Lightning bolt or pulse wave |
| Insights | Brain outline or sparkle |
| Growth | Sprout or ascending steps |

Active state: the icon fills with `#F15A2B`, the label below it brightens from `rgba(255,255,255,0.45)` to `#F15A2B`. No background bubble — the color change alone is sufficient and cleaner.

Tab bar height: 56px + `env(safe-area-inset-bottom)` to handle iPhone home indicator.

### Drawer Behavior

- Desktop: slides in from the right (480px max-width)
- Mobile: slides up from bottom, covers 75vh, with a drag handle indicator (centered 32px × 4px pill in `rgba(255,255,255,0.2)`)
- Drag-to-dismiss: detect `touchmove` delta — if user drags down more than 80px, animate out and close

```css
.drawer-handle {
  width: 32px; height: 4px;
  background: rgba(255,255,255,0.2);
  border-radius: 2px;
  margin: 0 auto 16px;
}
```

### FAB Placement and Design

Position: `bottom: calc(56px + env(safe-area-inset-bottom) + 12px); right: 16px`

Design: 52px circle, `#F15A2B` fill, white `+` or search icon, shadow `0 4px 16px rgba(241,90,43,0.4)`.

Context-awareness: the FAB icon changes per pillar:
- Performance: search (routing recommendation)
- Activity: plus (log manual session)
- Insights: wand/sparkle (Deep Analyze)
- Growth: trophy (view achievements)

Animate the icon change: fade out old icon, fade in new one over 150ms on pillar switch.

### Touch Feedback

```css
/* Active state scale transform — feels physical */
.bento-card:active { transform: scale(0.98); }
.pillar-bottom-btn:active { transform: scale(0.92); }
.fab:active { transform: scale(0.94); box-shadow: 0 2px 8px rgba(241,90,43,0.4); }

/* Prevent default tap highlight on all interactive elements */
* { -webkit-tap-highlight-color: transparent; }
```

Ripple is intentionally avoided — it dates the design (Material 2014). Scale transforms communicate the same "I received your tap" feedback without the visual noise.

---

## 7. Color Palette Extension

The current palette has brand orange and token-type colors. Add four pillar-identity accents that harmonize with `#F15A2B`:

| Pillar | Accent | Hex | Usage |
|--------|--------|-----|-------|
| Performance | Coral orange (brand, warm) | `#F15A2B` | Primary brand — sessions, activity counts |
| Activity | Electric indigo | `#6366f1` | Token flow, tool usage volume |
| Insights | Teal | `#14b8a6` | Behavioral patterns, analysis results |
| Growth | Amber gold | `#f59e0b` | Efficiency scores, achievements, streaks |

These four sit at equal perceptual weight against the dark background. Together they read as a designed set, not four unrelated choices:
- Orange (#F15A2B) and indigo (#6366f1) are split-complementary
- Teal (#14b8a6) and amber (#f59e0b) are analogous to their respective pillars
- All four are warm-leaning enough not to clash with the #1d1d1b dark header

**Status colors remain unchanged:**
```css
--success: #22c55e;   /* green — good values */
--warning: #f59e0b;   /* amber — attention (shares with Growth, acceptable) */
--error:   #ef4444;   /* red — problems */
--info:    #3b82f6;   /* blue — informational */
```

---

## 8. Inspiration References

### 1. Linear (linear.app)

**What to borrow:** Surface depth system. Linear uses 3 elevation levels (page, card, raised) with extremely subtle differences — you never consciously notice them, but the UI feels structured. Also borrow their keyboard-shortcut-first command palette (the `⌘K` pattern already exists in style.css as `.cmdk-*` — make it more prominent).

**Specific CSS reference:** Their card borders are `1px solid rgba(255,255,255,0.06)` at rest, brightening on hover. Much more refined than solid border colors.

### 2. Raycast (raycast.com)

**What to borrow:** The treatment of numbers as first-class UI. In Raycast's store stats, metric values are large, monospaced, and given room to breathe. There is no competition between the number and its label. Also borrow their preference for `DM Mono` for numeric displays.

**Specific pattern:** Raycast's bento-style feature cards use a subtle radial gradient from the accent color at the top-left corner — `background: radial-gradient(circle at 0% 0%, rgba(accent, 0.12), transparent 60%)`. This is a single CSS property that transforms a flat card into something with presence.

### 3. Vercel Dashboard

**What to borrow:** The "no wasted space, no decoration" philosophy. Every element earns its place. Their empty states are particularly good — a short message and one action, nothing more. Also borrow their approach to sparklines: inline, no axes, just trend shape.

**Specific pattern:** Vercel's KPI trend indicators (small +3.2% badges next to values) use `color-mix(in srgb, var(--success) 100%, transparent)` backgrounds at 10% opacity. Clean signal of direction without a full chart.

### 4. Stripe Dashboard

**What to borrow:** Table design. Stripe has perfected the "data table that doesn't feel like a spreadsheet" — alternating hover states, right-aligned numbers, badge labels that communicate at a glance. The Sessions tab should look like a Stripe transactions list.

**Specific pattern:** `tr:hover td { background: rgba(99, 102, 241, 0.04); }` — barely there, but physically satisfying.

### 5. Fig (now Windsurf) / Warp Terminal

**What to borrow:** The aesthetic of "developer tool made beautiful." Both products prove that terminal-adjacent UIs can be polished. The DM Mono pairing recommended above comes directly from Warp's design. Their use of orange as an accent in a dark interface is nearly identical to our brand situation.

**Specific pattern:** Warp uses a `box-shadow: inset 0 1px 0 rgba(255,255,255,0.06)` on cards — a top inner glow that simulates a light source from above. Subtle but makes dark cards feel 3D.

---

## Implementation Priority

| Phase | Work | Effort |
|-------|------|--------|
| 1 | Font import + apply DM Sans / DM Mono to body + KPIs | 2h |
| 2 | CSS variable refresh (new dark palette, 3-level surfaces) | 2h |
| 3 | Pillar accent colors + bento card top-border system | 3h |
| 4 | Stagger entrance animation for bento cards | 1h |
| 5 | Modal / drawer animation curves updated | 1h |
| 6 | Skeleton loading replacing spinners | 3h |
| 7 | Touch feedback (scale transforms) + FAB context icons | 2h |
| 8 | Light mode polish pass | 2h |
| 9 | Manual dark/light toggle with localStorage | 1h |

Total estimated: ~17 hours for full implementation.
