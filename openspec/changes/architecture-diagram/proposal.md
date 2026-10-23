## Why

A start page for a cluster is often where the diagram of that cluster lives: how the pieces connect, which storage backs what, where traffic enters. It is the one page everyone already has open, and a diagram in a wiki nobody opens is a diagram nobody reads.

QuickPortal has no way to show one. The obvious answer, rendering a diagram language in the browser, is not available: the usual renderer is 2.7MB minified against a 1MiB ConfigMap limit, with twenty runtime dependencies, and it would have to be fetched from a CDN. That breaks the airgap guarantee and needs `script-src` widened to a third party, which is a far bigger concession than any in this project so far.

So the capability has to be shaped around the delivery model rather than around the renderer.

## What Changes

- A new optional **diagram** view: a panel showing a diagram the operator supplies as **SVG**, with pan, zoom, fit-to-view and export.
- The diagram is **authored however the operator likes** and rendered to SVG before it reaches the cluster, by any tool: a diagram language compiled in their own CI, a drawing program, anything that emits SVG. QuickPortal displays it and does not care how it was made.
- The SVG lives in the operator's own ConfigMap, like their config, so updating the diagram is a commit and does not roll the pod.
- **Export** to SVG and to PNG, rendered in the browser from the SVG with no dependency.
- An **optional, explicitly opt-in renderer hook** for operators who want a diagram language rendered live in the page: a URL to a self-hosted renderer, which requires widening `script-src` in the deployment. Off by default, documented as the only feature in the project that loads code the project did not ship.
- The diagram is **not** on the critical path: a missing, oversized or malformed diagram must leave the bookmarks working.

Not in this change: shipping a diagram renderer, bundling a diagram language, fetching anything from a CDN by default, or editing diagrams in the browser.

## Capabilities

### New Capabilities
- `architecture-diagram`: declaring a diagram, loading it, the panel, pan/zoom/fit, export to SVG and PNG, the sanitisation an untrusted SVG needs, the failure modes, and the opt-in renderer hook.

### Modified Capabilities
- `bookmark-config`: a `diagram` section and its validation.
- `kubernetes-deployment`: delivering the SVG as a ConfigMap key, its size budget against the 1MiB limit, and the `script-src` switch for the optional renderer.
- `portal-ui`: the diagram panel alongside the bookmark tree, and its keyboard and accessibility behaviour.

## Impact

- No change for anyone who does not configure a diagram: nothing new is loaded, no policy changes.
- **An SVG is executable content.** An inline SVG can carry `<script>`, event handlers and external references, so a diagram the portal inlines must be sanitised, and the CSP must not be widened to accommodate it. This is the main engineering risk in the change and it is not optional work.
- A second size budget to watch: the diagram shares the 1MiB ConfigMap with the config, and a detailed SVG can be hundreds of kilobytes.
- Operators whose diagram source is a diagram language gain a step: render to SVG in CI rather than having the page do it. The alternative is the opt-in renderer hook, with the policy cost stated plainly.
