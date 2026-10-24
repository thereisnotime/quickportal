## Why

A healthy mermaid diagram raised a security warning on every page load:

> The diagram was altered: 261 attributes and 3 style rules removed
> It is displayed below without them. An SVG is executable content...

Nothing dangerous had been removed. Measured against a real flowchart, the 261 attributes were 260 `data-*` (mermaid's own `data-id`, `data-points`, `data-et`, `data-look`) and one `aria-roledescription`. None of them can execute anything, and `aria-roledescription` is an accessibility attribute the sanitiser was destroying for no gain.

Of the 3 style rules, two were `@keyframes` blocks that mermaid emits whether or not anything animates. The third was `:root { --mermaid-font-family: ... }`, refused because a `:root` rule could restyle the page. Refusing it was the wrong answer to a real concern: the rule is not a threat, it just cannot stay where it is, and scoping is exactly the operation that moves it somewhere safe.

The result was a warning that fires on correct input, forever, which is worse than no warning: it teaches the reader to dismiss the notice, and the one time it means something it looks identical.

Separately, the hint that names the mermaid option behind missing labels could never appear: the count it reads was stripped before the notice was built.

## What Changes

- `data-*` and `aria-*` attributes are **kept**. Both are inert by definition and neither can be acted on by anything in a sanitised SVG.
- A `:root` or `:host` compound is **rewritten to the diagram container** instead of being refused, so a renderer's custom properties survive and stay confined. A `:root` the rewrite does not claim, such as `.a:root`, is refused exactly as before.
- Drops are classified: removed **because it could execute or reach out**, versus removed **because the allowlist cannot carry it**. The panel's notice fires only on the first.
- The `foreignObjects` count reaches the notice, so the hint naming `htmlLabels: false` can appear.

Not in this change: widening what may execute, carrying `@keyframes` or `@font-face`, or removing the notice for anything genuinely removed as a hazard.

## Capabilities

### Modified Capabilities
- `architecture-diagram`: inert attributes are preserved, document-root selectors are scoped rather than refused, and the alteration notice is tied to risk rather than to volume.

## Impact

- A mermaid diagram that previously reported 264 removals now reports none, and shows no notice.
- Diagram CSS gains the renderer's custom properties, confined to the container.
- The sanitised SVG is larger, because `data-*` is now carried. That is the renderer's own output and the right default: dropping what a renderer emits is how a sanitiser mangles legitimate input.
- The notice still appears, unchanged, for a script, an `on*` handler, a foreignObject, an external reference, or CSS carrying `url()`, `@import`, `expression()` or `behavior:`.
