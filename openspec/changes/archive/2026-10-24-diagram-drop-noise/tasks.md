## 1. Preserve what is inert

- [x] 1.1 Accept `data-*` and `aria-*` through a predicate rather than by listing names
- [x] 1.2 Keep the value check on them, so a hostile value is still removed
- [x] 1.3 Test that a real mermaid flowchart loses no attribute

## 2. Scope the document root

- [x] 2.1 Rewrite a `:root` or `:host` compound to the container prefix
- [x] 2.2 Run the rewrite before the escape test, so an unclaimed `:root` is still refused
- [x] 2.3 Keep `:root` as written on the export path, where it means the `<svg>`
- [x] 2.4 Test that the rewritten rule is confined to the container and that `.a:root` is still refused

## 3. Tie the notice to risk

- [x] 3.1 Count, at each drop site, whether the removal was made because the construct could execute or reach out
- [x] 3.2 Show the notice only when that count is non-zero, and keep reporting full totals when it is
- [x] 3.3 Carry the foreignObject count through to the notice so its hint can appear
- [x] 3.4 Test that a `@keyframes` drop is quiet and an `@import` drop is not

## 4. Verification

- [x] 4.1 Render the real diagram with the real renderer and confirm the counts fall to zero attributes and zero unsafe
- [x] 4.2 Confirm the renderer's custom properties reach the diagram and do not reach the page
- [x] 4.3 Confirm `data-*` and `aria-roledescription` survive into the DOM
- [x] 4.4 Run the full suite
