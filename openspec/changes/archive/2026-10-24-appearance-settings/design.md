## Context

Four preferences (theme, contrast, density, motion), one popup, no server. Everything persists in `localStorage`, which can be absent or throw, and the page must render correctly when it is.

Three constraints shape the rest:

- **CSP is `default-src 'self'` with `style-src 'self'`.** No inline `style` attribute may be written by script, which is why the existing layout knobs go through CSSOM (`style.setProperty`) rather than markup. Preferences are therefore expressed as **attributes on `<html>`**, not as styles.
- **A re-render must not disturb what the viewer is doing.** The config is polled, so anything applied during a render has to be idempotent and must not fight a viewer choice made between polls.
- **The config's value is a default, not an instruction.** Theme already works this way: a stored choice beats `theme:` in the config, and the stored value has to distinguish "deliberately auto" from "never chose", which is why `getStoredTheme()` exists alongside `getTheme()`.

## Goals / Non-Goals

**Goals**

- One place to see and change every appearance preference, all options visible.
- Each preference independently stored, independently defaulted, and independently safe to be missing.
- Keyboard-first: the popup opens, traps focus, closes on Escape, returns focus to its opener.
- The stylesheet remains the only thing that knows what a preference looks like.

**Non-Goals**

- Operator-set contrast or motion. Both are properties of the person reading, and an operator who forces either is overriding an accessibility setting for someone they cannot see.
- Syncing. There is no server, and inventing one for four enum values is not worth a backend.
- A general preferences framework. Four enums do not need a registry.

## Decisions

### Decision: attributes on `<html>`, one per preference

`data-theme`, `data-contrast`, `data-density` and `data-motion` on the root element. The stylesheet selects on them; script only ever writes them.

- **Why the root and not the portal element:** the toolbar, the dialogs, the tab strip and the frame host are all outside `#portal`, and a preference that did not reach them would be visibly half-applied. The root is the only element that is an ancestor of everything.
- **Why attributes and not classes:** an attribute holds a value, so `data-theme="dark"` replaces `data-theme="light"` in one write with no stale-class bug, and the "unset" case is a missing attribute rather than the absence of one class among three.
- **Alternative rejected:** custom properties set on the root via CSSOM. It works under the CSP, but it moves the *values* of a theme into JavaScript, which is exactly where they should not live.

### Decision: density is owned by one writer

`applyLayout()` in render.js currently writes `data-density` onto `#portal` from the config. The viewer override has to live on `<html>`, and with both in play one of them loses: a viewer choosing comfortable over a compact config leaves `#portal[data-density="compact"]` matching the descendant selectors, and the override does nothing.

So density becomes app.js's alone. render.js stops writing it, app.js resolves `stored ?? config.layout.density ?? "comfortable"` and writes that one value to the root. The config's value keeps working exactly as before for anyone who has not chosen.

This is the one place where the change touches a module that is otherwise unrelated to it, and it is not optional: leaving both writers in place yields a setting that works in one direction only.

### Decision: motion is a forced override, not a replacement

`prefers-reduced-motion: reduce` already short-circuits every animation. The preference adds `data-motion="reduced"` as a second way in (same declarations, selected by attribute as well as by media query) and `data-motion="system"` means *do not interfere*, which is the default.

There is deliberately **no** "force motion on" state. A viewer whose OS asks for reduced motion asked for it; offering a switch to override their own OS setting from a bookmark page is not a feature, and the one legitimate case (the OS setting is wrong for this page) only ever points one way.

### Decision: high contrast is a token override, not a separate stylesheet

A `[data-contrast="high"]` block redefines the same custom properties the theme blocks define: borders to full-strength foreground, muted text collapsed toward the foreground, elevated and sunken surfaces collapsed toward the base, shadow removed, focus ring widened. Nothing else in the stylesheet learns about contrast.

Contrast has **three** states, not two, for the same reason theme does: `auto` follows `prefers-contrast: more`, and `normal` and `high` are explicit. Without `auto` there would be no way to say "follow my OS" after having once chosen, and a viewer whose OS asks for more contrast would be served a flat page by default.

So the high-contrast tokens are selected by a media query *and* by the attribute, in both themes:

```css
@media (prefers-contrast: more) { :root:not([data-contrast="normal"]) { ... } }
:root[data-contrast="high"] { ... }
```

guarded with `:not([data-contrast="normal"])` exactly as the dark media query is guarded with `:not([data-theme="light"])`. Crossed with the three theme blocks that is six places the same token set is written, which is the honest cost of doing theme and contrast as independent viewer preferences in plain CSS with no build step.

### Decision: a `<dialog>`, like the other two popups

The palette and the shortcuts list are both modal `<dialog>` elements with the same `bindDialog` helper: backdrop click closes, `[data-close-dialog]` closes, Escape is the platform's own. The settings popup is a third one. Focus trapping and the return of focus to the opener come free from `showModal()`.

**Alternative rejected:** a non-modal popover anchored to the button. It reads better as a menu, but it brings positioning, collision handling and its own focus management, and on a 320px screen it would end up full-width anyway, which is what the dialog already is.

### Decision: radio groups, not a list of buttons

Each preference is a `fieldset` of radios with a `legend`. Screen readers announce "Theme, group, dark, 3 of 3", the arrow keys move within a group and Tab moves between groups, and the current value is conveyed by the platform rather than by an `aria-pressed` on one of three buttons. The radios are visually styled as a segmented control; the inputs stay real and stay focusable.

### Decision: the palette keeps a path to each preference

Five entries: cycle theme (kept, since muscle memory exists), toggle high contrast, toggle compact density, toggle reduced motion, and open the settings popup. A preference reachable only from inside a popup would be the first thing in this project that the keyboard could not get to in one press.

## Risks / Trade-offs

- **Four render combinations per component instead of two.** Every surface now has a high-contrast form in both themes. The mitigation is that high contrast only ever redefines tokens, so a component that uses tokens correctly gets it for free, and one that hardcodes a colour is now visibly wrong. Reviewing for hardcoded colours is part of the work.
- **A fifth preference will want a framework.** Four enums, four storage keys and four attributes written by one function is honest at this size and would not be at eight. Noted, not pre-solved.
- **The popup is a new focus trap on a page that already has two.** Mitigated by reusing the same helper rather than writing a third set of dialog mechanics; the keyboard tests cover all three.
- **High contrast is a judgement, not a standard.** There is no spec that says what "high contrast" is, so the values are chosen to clear WCAG AA for body text and 3:1 for borders and focus indicators, measured, rather than to match any platform's idea of the mode.

## Migration Plan

None required. The storage key for theme is unchanged, so a viewer who had picked a theme keeps it. The other three keys are absent for everyone, which is the "never chose" state and yields today's behaviour exactly.

## Open Questions

None blocking. The six-way token duplication (three themes crossed with contrast) is the thing most likely to want revisiting: a build step or a nested `@media`/`:where()` restructure could collapse it, at the cost of this stylesheet no longer being a single file anyone can read top to bottom. Not worth trading away at four preferences.
