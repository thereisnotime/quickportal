## 1. Preference storage

- [x] 1.1 Add contrast, density and motion keys to `state.js` alongside the theme key, each with its own option list and default
- [x] 1.2 Give each a `get*`/`getStored*`/`set*` trio, following theme: `getStored*` returns `null` when nothing was chosen, so a deliberate "auto" is distinguishable from an absent choice
- [x] 1.3 Remove an unset or unrecognised value rather than storing it, so a fresh browser and a cleared preference behave the same
- [x] 1.4 Tests: each preference round-trips, an unrecognised value falls back, one corrupt key does not affect the others, and every accessor works against the memory storage stand-in

## 2. Stylesheet

- [x] 2.1 Add a high-contrast token block for light, under `@media (prefers-contrast: more)` guarded with `:not([data-contrast="normal"])` and under `:root[data-contrast="high"]`
- [x] 2.2 Add the same for dark, in both the `prefers-color-scheme` block and the `[data-theme="dark"]` block
- [x] 2.3 Widen the focus ring and remove the shadow under high contrast
- [x] 2.4 Add `[data-motion="reduced"]` as a second selector for the existing reduced-motion declarations
- [x] 2.5 Audit every rule for a hardcoded colour that would not follow the contrast tokens, and convert it
- [x] 2.6 Style the radio groups as a segmented control, keeping the inputs real and focusable
- [x] 2.7 Measure the contrast ratios: body text at least 4.5:1, borders and focus indicators at least 3:1, in all four theme and contrast combinations

## 3. Markup

- [x] 3.1 Add `data-contrast`, `data-density` and `data-motion` to `<html>` with their defaults
- [x] 3.2 Replace the theme cycle button in the toolbar with a single settings button
- [x] 3.3 Add the settings `<dialog>`: one `fieldset` per preference, a `legend` each, radios with real labels, and a close control
- [x] 3.4 Mention the settings popup in the keyboard shortcuts dialog

## 4. Wiring

- [x] 4.1 Apply every preference on load from `getStored*`, falling back to the default
- [x] 4.2 Write each preference as an attribute on `<html>`, never as an inline style, so the CSP is satisfied
- [x] 4.3 Make density resolve `stored ?? config.layout.density ?? comfortable`, and remove the competing write in `render.js` so there is one writer
- [x] 4.4 Keep the config's theme applying only while nothing is stored, as it does today, and extend the same rule to density
- [x] 4.5 Sync the popup's checked radios from the live values whenever it opens, so it cannot show a stale state
- [x] 4.6 Announce each change through the existing live region
- [x] 4.7 Bind the dialog with the existing helper: backdrop click, close control, Escape, focus returned to the opener
- [x] 4.8 Add palette entries: open settings, and change each preference

## 5. Verification

- [x] 5.1 Unit tests for the resolution rules: stored beats config, config beats default, and a live config reload does not overwrite a stored choice
- [x] 5.2 Render the page under all four theme and contrast combinations and check every surface, including the dialogs, the tab strip and the diagram panel
- [x] 5.3 Check the popup at 320px: no horizontal scroll, every target at least 44px
- [x] 5.4 Check with storage blocked: the page renders, the popup opens, changes apply for the session
- [x] 5.5 Confirm no CSP violation is reported with the real `default-src 'self'` policy in force
- [x] 5.6 Run the full test suite and the config validator

## 6. Documentation

- [x] 6.1 Document the four preferences, their defaults, and that contrast and motion are viewer-only, in `docs/CONFIGURATION.md`
- [x] 6.2 Note in the `layout.density` row that it is now a default a viewer can override
- [x] 6.3 Update the README's feature list and any screenshot or description mentioning the theme button
