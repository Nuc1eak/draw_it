# DESIGN.md — visual rules for the drawing rooms frontend

Applies to everything in /web (vanilla HTML, CSS, JS, no UI frameworks).
The reference mockup is the "Drawing Rooms UI" canvas: Login, Room, Connecting,
Room not found, Room full. When code and mockup disagree, ask before deviating.
UI copy is Ukrainian (`<html lang="uk">`). Code, comments and commits are English.

## Principles

- Light, minimal, calm. Lots of white space, one accent color, no gradients except
  inside color pickers, no emoji, no decorative illustrations.
- Rounded everything: pill buttons, soft cards. Borders are thin (1px), shadows are rare.
- The canvas is the hero. Chrome (toolbar, panels) stays quiet and never covers drawing.
- Prefer clarity over cleverness: visible labels, obvious states, plain words.

## Tokens (define once as CSS variables in :root, never hardcode elsewhere)

```css
:root {
  --bg: #F6F6F3;          /* page ground */
  --surface: #FFFFFF;     /* cards, canvas, toolbar */
  --ink: #1B1B19;         /* primary text, icons */
  --muted: #5E5E58;       /* secondary text (passes 4.5:1 on bg and surface) */
  --line: #E4E4DE;        /* card borders, dividers */
  --control-border: #8C8C84; /* input and outline-button borders (3:1 for UI) */
  --accent: #2B59E0;      /* primary actions, selected state ring */
  --accent-hover: #1F46C0;
  --accent-soft: #E7EDFC; /* selected tool background */
  --focus: #9DB4F5;       /* focus-visible outline, 3px */
  --danger: #B42318;
  --danger-soft: #FDE8E8;
  --font: 'Manrope', system-ui, sans-serif; /* weights 400 500 600 700 */
}
```

Drawing palette (10 defaults, in this order): #1B1B19 black, #6B7280 gray,
#E03131 red, #F76707 orange, #F59F00 yellow, #2F9E44 green, #1098AD teal,
#1971C2 blue, #7048E8 violet, #D6336C pink.

Participant avatars use soft tints with dark text: #DCE6FF, #FFDCD4, #D8F0DE, #EEDFFA.

## Type scale

| Use | Size / weight |
| --- | --- |
| Screen title (h1) | 30px / 700, letter-spacing -0.02em |
| State title (h1 on error/full/connecting) | 22-24px / 700 |
| Panel title (h2) | 16px / 700 |
| Body | 15px / 400-500, line-height 1.5 |
| Field label, helper text | 13px / 600 and 400 |
| Caption (toolbar group names) | 11px / 600, uppercase, letter-spacing 0.06em |
| Room code | 20-22px / 700, letter-spacing 0.14em |

## Shape, spacing, sizes

- Spacing scale: 4, 8, 12, 16, 20, 24, 28, 40. Use `gap`, not margins, between siblings.
- Radii: card 28px, canvas 24px, toolbar and chips 20px, inputs 14px, buttons 999px (pill), swatches 50%.
- Control heights: text input 48px, primary button 52px, secondary button 48px,
  toolbar buttons 40-44px, color swatch hit area about 38×32px on desktop, 44px high on narrow screens (visible dot 26px).
  Minimum hit target is 40px on desktop toolbar, 44px everywhere else.
- Page padding 16px in the room, 32px on centered cards. Centered cards max-width 400-440px.

## Components

- Primary button: filled `--accent`, white text, hover `--accent-hover`.
- Secondary button: white fill, 1px `--ink` border, hover #EDEDE8.
- Toolbar button: white, 1px `--control-border`; selected = `--accent-soft` fill + 2px `--accent` inset ring.
- Inputs: 1px `--control-border`, visible `<label>`, helper text below in `--muted`.
- Swatches: round, 1px rgba(0,0,0,.14) edge, selected = 2px `--ink` inset ring.
- Toasts and errors use `role="alert"` or `role="status"`; never color alone.

## Room screen layout

- One row: the canvas and a vertical toolbar on its right. The canvas keeps 16:10 and takes as
  much room as it can; the toolbar takes the width left, from 220px up to a limit on ultrawide
  windows, and its contents scale with the window. Spare height goes to the palette square.
  On narrow screens the toolbar stacks below the canvas.
- Toolbar groups, top to bottom: room code with copy and leave (or close room) buttons,
  participants dropdown, Colors (10 defaults over 10 recents), Palette picker, Tool (Brush, Fill,
  Text) with a Width slider below, actions (Eraser, Undo, Clear, Save). Groups separated by
  1px dividers.
- Tool and action buttons show icons only, with `aria-label` and a `title` tooltip.
- The participants dropdown lists members; it opens over the canvas beside the toolbar and
  closes on a click outside or Esc.
- The canvas card takes exactly the canvas size.
- On desktop the page fits the window and never scrolls; the toolbar and the participants
  list scroll inside themselves if they do not fit.
- Other users' cursors: arrow in their color with a dark name pill, pointer-events none.

## Color behavior

- Recent colors: up to 10 slots, newest first, no duplicates; empty slots render as dashed circles.
- Picking a default or recent color syncs the picker (hue, saturation, brightness).
- Picker: saturation (x) and brightness (y) square plus Hue and Saturation sliders, with
  a marker and a preview with hex. Square supports click and drag (pointer events).
  A color is added to recents only when a stroke is drawn with it, not when it is chosen.
- Choosing a color while the eraser is active switches back to the pen.

## Accessibility (non-negotiable)

- Text contrast 4.5:1 minimum (3:1 for 24px+ text and UI borders). Do not lighten `--muted`.
- Real `<button>`, `<a href>`, `<input>` with `<label>`. No clickable divs.
- Icon-only buttons need `aria-label`; selected state via `aria-pressed`.
- Always-visible focus ring: `outline: 3px solid var(--focus)`; never `outline: none` alone.
- Respect `prefers-reduced-motion` (spinner stops, no transitions that move content).
- Layout works from 360px width up: wrap toolbars, stack the participants panel.

## Don'ts

- No new colors, radii or font sizes outside this file without asking.
- No gradients, drop-shadow stacks, emoji, or stock illustrations.
- No external UI libraries or icon fonts; icons are small inline SVG, 2px stroke, round caps.
- Do not copy proprietary brand assets or fonts.

## Verification

After any UI change, take a screenshot at 1280px and 390px width, compare with the
mockup, and list differences before finishing.
