---
name: ittop
description: Multi-workspace mission control for parallel terminal AI agents.
colors:
  phosphor: "#4ee2a3"
  bezel: "#17181a"
  elevated: "#1c1e21"
  border: "#303338"
  ink: "#d4d4d4"
  engraved: "#7c8790"
  waiting: "#58a6ff"
  working: "#3fb950"
  fault: "#f85149"
typography:
  title:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.08em"
  mono:
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "20px"
spacing:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.phosphor}"
    textColor: "#0b0e0c"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 12px"
  button-default:
    backgroundColor: "rgba(139, 148, 158, 0.08)"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 12px"
  button-chip:
    backgroundColor: "rgba(139, 148, 158, 0.08)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 10px"
  button-tab:
    backgroundColor: "transparent"
    textColor: "{colors.engraved}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 12px"
  button-danger:
    backgroundColor: "{colors.fault}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 14px"
  card:
    backgroundColor: "{colors.bezel}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  input:
    backgroundColor: "{colors.bezel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  badge:
    backgroundColor: "rgba(139, 148, 158, 0.08)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  modal:
    backgroundColor: "{colors.bezel}"
    rounded: "{rounded.lg}"
    padding: "20px"
    width: "420px"
---

# Design System: ittop

## Overview

**Creative North Star: "Phosphor Darkroom"**

The agent rig as a calibrated bench: every session an instrument bay, every state a meter reading. Matte near-black bezels drink the light; flat phosphor burns through it exactly where the eye must land. Engraved gray legends whisper, hairline graticules divide, tally lamps breathe for the agents that need you. Chrome recedes behind terminal output, which stays byte-identical; density is a feature, not a flaw — this is a night-shift instrument, not a lounge.

The system serves operators running parallel agents at 2 a.m.: glanceable, tactile, honest. It refuses the category default of flat panels with blue accent, and it refuses glow, gradients, and noise with the same conviction. Nothing glides here; things snap, blink, and settle like hardware.

The system serves night-shift operators running parallel agents: glanceable, tactile, honest. It refuses the category default of flat panels with blue accent, and it refuses glow, gradients, and noise with the same conviction.

**Key Characteristics:**
- Instrument bays, not cards: screwed bezels, engraved strips, hairline rules.
- One control system: 28px buttons, 8px radii, named roles (primary, default, chip, tab, danger).
- Mono for measurement, grotesk for reading; tabular numerals everywhere counts appear.
- Snap, don't glide: state changes cut instantly; one unfold moment, reduced-motion safe.
- Emptiness with posture: every void carries a mark, a sentence, and the next action.

## Colors

Dark-first instrument palette: near-black grounds, one phosphor accent, engraved gray for secondary text, signal colors reserved for state. (Five themes re-tokenize these roles; values below are the dark default.)

### Primary
- **Bench Phosphor** (#4ee2a3): the single accent. Active states, primary actions, tally selections, focus rings. Its rarity is the point.

### Neutral
- **Bezel Black** (#17181a): app ground.
- **Elevated** (#1c1e21): raised surfaces (modals, panels).
- **Border** (#303338): hairlines, rails, bay edges.
- **Ink** (#d4d4d4): primary text.
- **Engraved Grey** (#7c8790): secondary text, micro-labels, meters. Never body copy.

### State (reserved, never decorative)
- **Waiting Signal** (#58a6ff): needs-input states, blinking tally.
- **Working** (#3fb950): live/rolling states, solid tally.
- **Fault** (#f85149): destructive actions, errors.

### Named Rules
**The No-Glow Rule.** Phosphor stays flat: no gradients, no glow, no zero-offset halos, no block shadows. Depth comes from tonal layering, never from light effects.
**The Overlay Rule.** State rides the chrome above terminal output, which stays byte-identical. Nothing draws over agent content.

## Typography

**Body Font:** 'Segoe UI', system-ui, sans-serif (with system fallback)
**Label/Mono Font:** 'Cascadia Code', 'JetBrains Mono', Consolas, monospace
**Display Font:** none — Operate surface; headings are the UI grotesk at weight steps, never a display face.

**Character:** Workhorse grotesk for reading, real terminal mono for measurement. No costume mono, no system display voice.

### Hierarchy
- **Title** (650, 21px, 1.3): detail and dialog headings. Carries its own weight — no kickers or eyebrows above it.
- **Body** (400, 13px, 1.5): prose, list content. Max measure 70ch in detail views.
- **Label** (700, 10.5px, 0.06–0.08em tracked, uppercase): engraved micro-labels, stat names, section eyebrows in lists only.
- **Mono** (400, 12px, 1.5): readouts, counts, statuses, terminal-adjacent data.

### Named Rules
**The Tabular-Numerals Rule.** Every count, readout, and meter value sets tabular-nums. Jumping digits are a defect.
**The Engraved-Label Rule.** Micro-labels are uppercase, tracked, and gray. They label instruments; they never headline.

## Layout

Rack-rail sidebar (200–480px, resizable) left; readout strip on top with the waiting count monumental; terminal tiles fill the rig in a fluid grid (10px gutters). Memory: list/detail two-column (2fr/3fr) collapsing to one column at or below 1080px; smallest widths pin the rail to 200px with a scrolling toolbar. Spacing rhythm 8/12/16/24; more space above a heading than below it (16/6).

### Motion

Hardware motion, not interface animation: things snap, blink, and rise once — then hold still.

- **Unfold** (`bay-in 0.18s ease-out`, 35ms stagger per tile): opening a workspace deploys the rig in one stepped cascade. The single authored moment.
- **Tally blink** (`tally-blink 1.1s steps(2, start)`): waiting states blink in hard steps; working holds solid. No easing on a lamp.
- **Hovers cut**: border-color shifts land instantly or in 0.12s; nothing fades, slides, or scales into place.
- **Reduced motion**: unfold and blink go static under `prefers-reduced-motion`. No exceptions.

### Named Rules
**The Snap-Not-Glide Rule.** State changes cut; only the unfold rises, once. Anything that glides is decoration wearing motion's clothes.

## Elevation & Depth

Flat by default with tonal layering; no shadow vocabulary at rest.

### Shadow Vocabulary
- **Modal lift** (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45)`): dialogs only.
- **Toast float** (`box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3)`): transient notifications only.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadow appears only on overlays (modal, toast), never on cards, rows, or tiles.

## Shapes

8px radius on controls and inputs, 10px on cards/tiles/modals, 20px pills on chips/badges/status. 1px hairline borders throughout; active states use a full 1px accent border, never a side bar. Corner screws (1.4px dots) mark terminal bays. 4px radii survive only on legacy icon buttons.

## Components

### Buttons
- **Shape:** 8px radius, 28px height, 0 12px padding.
- **Primary:** phosphor ground, near-black text, semibold. The one main action per context.
- **Hover / Focus:** border shifts to phosphor; focus-visible draws a 1px phosphor outline offset 2px.
- **Secondary:** translucent gray ground, ink text. **Danger:** fault ground, white text. **Chip:** 24px pill, mono, active state tints phosphor. **Tab:** transparent, gray; active gets bordered bay ground.

### Cards / Containers
- **Corner Style:** 10px radius.
- **Background:** bezel (derived per theme, not a fixed hex).
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px hairline; active swaps the full border to phosphor.
- **Internal Padding:** 10px 12px (rows), 14px (panes).

### Inputs / Fields
- **Style:** bezel ground, hairline stroke, 8px radius, 6px 10px padding.
- **Focus:** border shifts to phosphor; caret renders phosphor.
- **Error / Disabled:** disabled drops to 50% opacity; errors name the problem in fault-colored text beside the field.

### Navigation
- Sidebar rows: full-row hover wash, active row gets the full phosphor border on bay ground. Status arrives as a tally dot (blinking for waiting, solid otherwise). Counts render mono tabular. Collapsed rail keeps icon buttons with tooltips.

### Focus & Keyboard
- Focus-visible draws a 1px phosphor outline offset 2px on every control — the same ring everywhere, no exceptions.
- Text caret renders phosphor in all inputs; text selection tints phosphor at 28%.
- Scrollbars stay quiet: transparent track, thumb in active ground with padding-box inset. No custom arrows, no glow on hover.
- Every action reachable by keyboard keeps its visible focus; Escape closes overlays and the memory screen; Ctrl+1…9 switches workspaces from anywhere.

### Readout Strip
- Monumental waiting numeral (27px mono tabular, state-colored, gray at zero) plus a small working/idle sub-line. The single number that matters, set huge.

### Toast
- Bottom-right stack, 8px gap; elevated ground, hairline border, 8px radius, 10px 14px padding, 12.5px text. Carries its own tally dot — no side bars, no glow beyond the restrained float shadow. Clicking focuses the waiting session; auto-dismisses after 6s.

### Confirm Dialog
- Modal shell (420px, bezel, 10px, 16px/650 heading); plain-language consequence paragraph naming exactly what stops and what stays untouched; actions right-aligned: default Cancel, danger Delete. No icon, no warning stripes — the words do the work.

### Empty, Loading, Error
- **Empty:** centered mark (mono glyph, phosphor at 60%), one sentence naming the void, one sub-line with the next action. Never a blank panel.
- **Loading:** plain dim sentence plus ellipsis ("Loading entries…"). No spinners, no skeleton shimmer — the bench doesn't perform waiting.
- **Error:** fault-colored sentence naming the problem and the recovery ("Retry" button beside it). Inline where the content will land, never a modal for a recoverable read.

## Do's and Don'ts

### Do:
- **Do** keep terminal output byte-identical; all state lives on surrounding chrome.
- **Do** use tabular numerals for every count and meter.
- **Do** collapse raw data behind "Developer details" (or equivalent); humans read prose first.
- **Do** honor `prefers-reduced-motion` (unfold and blink go static).
- **Do** give every void a mark, a sentence, and the next action — never ship a blank panel.
- **Do** name the recovery next to every error, with its button beside it.

### Don't:
- **Don't** add glow, gradients, or shadows to cards, rows, or tiles.
- **Don't** use side-tab accent bars (thick colored left/right borders) on any element.
- **Don't** use emoji or text glyphs as icons — draw 16px stroke SVG.
- **Don't** put kickers or eyebrows above headings; headings carry their own weight.
- **Don't** use monospace as costume — mono is for code, data, and measurement only.
- **Don't** animate state changes with fades or slides — cut, blink, or rise once.
- **Don't** modal a recoverable error — inline it where the content will land.
