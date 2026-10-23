## Context

The request was "render a diagram in the portal", and the assumed implementation was to vendor the usual browser renderer. That assumption does not survive measurement:

```
mermaid.min.js        2,748,992 bytes
ConfigMap hard limit  1,048,576 bytes
full dist             66 MB, 20 runtime dependencies
```

It is 2.6 times the entire delivery envelope, and the only way to load it is from a CDN, which breaks the airgap guarantee and requires widening `script-src` to a third party. Every alternative renderer worth having is in the same order of magnitude, because the hard part is graph layout.

So the capability is shaped around what the delivery model can carry: the portal displays an SVG and does not care how it was produced. That is not a compromise on the output, since the SVG is exactly what a renderer would have produced anyway; it moves the rendering to where there is no 1MiB limit, which is the operator's own CI or laptop.

## Goals / Non-Goals

**Goals:**

- Show a diagram the operator supplies, with pan, zoom, fit-to-view and export to SVG and PNG.
- The diagram updates by committing a new ConfigMap key, without rolling the pod, like the config.
- Authoring stays free: anything that emits SVG works, and the portal has no opinion.
- A diagram that is missing, too large or malformed never breaks the bookmarks.
- No new dependency, no CDN, and no CSP widening in the default path.

**Non-Goals:**

- **Shipping a diagram renderer.** See the numbers above.
- **Rendering a diagram language in the page by default.** Available only through the opt-in hook below.
- **Editing diagrams in the browser.** This is a viewer.
- **Supporting arbitrary untrusted SVG from the internet.** The diagram is content the operator put in their own ConfigMap; it is still sanitised, but the threat model is "my own file does something I did not intend", not "a stranger's file".

## Decisions

### The diagram is an SVG in the operator's ConfigMap

```yaml
diagram:
  title: Architecture          # optional panel heading
  src: ./config/diagram.svg    # served path, same ConfigMap as the config
  maxBytes: 524288             # refuse anything larger, default 512KiB
```

Same volume as `config.yaml`, so the same no-restart update path and the same revalidated cache headers apply. The size cap exists because the diagram shares the 1MiB ConfigMap with the config and because inlining a megabyte of SVG will make the page janky long before the cluster refuses it.

*Alternatives:* a diagram baked into the app ConfigMap (then updating it rolls the pod and belongs to us, not the operator); an external URL (needs `img-src`/`connect-src` widening and an available host; allowed, but not the documented default).

### It is inlined, not an `<img>`, and that is why sanitisation is mandatory

Pan and zoom need the SVG in the document: an `<img src="diagram.svg">` is opaque, cannot be panned usefully, and cannot be exported to PNG at a chosen scale without re-fetching. So the SVG is parsed and inlined.

**An SVG is executable content.** It can carry `<script>`, `on*` handlers, `<foreignObject>` with HTML, `<use href="http://...">`, `<image href>` to a remote host, CSS `@import`, and animation elements. Our CSP blocks inline script execution, which is the backstop, but the portal must not rely on the CSP alone and must not widen it for a diagram.

So inlining goes through a parse-and-rebuild, not a string paste:

- parse with `DOMParser` as `image/svg+xml`, never `innerHTML`
- walk the tree against an **allowlist** of elements and attributes, dropping anything not on it
- drop every `on*` attribute, `<script>`, `<foreignObject>`, `<animate*>`, `<set>`, `<handler>`, and anything else that executes
- allow `href` only when it is a fragment (`#id`); drop external and `javascript:` references on `href`, `xlink:href`, `src`, `from`, `to`, `values`, `begin`
- drop `style` elements and attributes containing `url(`, `@import`, `expression(` or `behavior:`
- strip any `<base>`, and namespace-prefixed attributes we do not know

The allowlist is the security boundary and the test suite's main subject. A test must feed it an SVG carrying each of the above and assert the dangerous parts are gone, including the ones the CSP would have caught anyway, because defence in depth is the point.

*Alternatives:* `<img>` (no pan, no scaled export, and it would still need the file to be trusted for `img-src`); an `<iframe srcdoc>` sandbox (a sandboxed frame cannot be styled with the page's theme tokens, and it reintroduces the frame machinery for a static picture); trusting the file because the operator supplied it (the operator also pastes SVGs from the internet).

### Export is computed, not fetched

SVG export serialises the sanitised tree. PNG export draws it to a canvas at a chosen scale and calls `toBlob`. No dependency, and the PNG comes from what is on screen rather than from a round trip.

The one trap: `canvas.drawImage` of an SVG taints nothing only while the SVG has no external references, which the sanitiser has already removed. Fonts are the exception worth documenting: text in the exported PNG renders with whatever the browser resolved, so a diagram relying on a webfont will export with a fallback. Stating that beats an operator wondering why the PNG looks different.

### The panel is a view, not a route

The diagram is a collapsible panel in the page, not a separate page or a modal: no routing to invent, nothing to break when a config change re-renders, and the bookmarks stay visible. Open state is remembered per browser, like collapse state.

The diagram is fetched lazily on first open, so a deployment with a large diagram costs nothing until someone looks at it.

### Failure is quiet and specific

A diagram is decoration for most of the page's purpose, so every failure degrades rather than blocks:

- the key is absent or 404: the panel is not rendered at all, and a one-line notice appears only if `diagram.src` was configured
- over `maxBytes`: a notice naming the actual and permitted sizes, no inlining attempt
- not parseable as SVG: a notice naming the parse error
- sanitisation removed something: the diagram renders, and the notice says how many nodes or attributes were dropped, because silently altering someone's diagram is worse than telling them

In every case the bookmark tree renders normally.

### The optional renderer hook, and what it costs

For operators who want a diagram language rendered live in the page:

```yaml
diagram:
  renderer:
    url: https://portal.example.com/vendor/renderer.mjs   # self-hosted
    source: ./config/diagram.mmd
```

The portal imports that module and asks it to turn the source text into SVG, then puts the result through the same sanitiser. It is off unless configured, and configuring it requires widening `script-src` in the deployment exactly like `frame-src` for embedding, with the same two-part switch and the same half-configured detection.

This is the only feature in the project that executes code the project did not ship, so the documentation says so in those words, and the default path never touches it. Self-hosting is strongly recommended over a CDN in the docs, but the field takes any URL the policy permits, because refusing to let an operator point at their own mirror would be theatre.

*Alternatives:* no hook at all (honest, but it forces a CI step on everyone whose source is a diagram language, and some will just go back to a hand-maintained HTML page); a server-side render step (needs a backend).

### Module layout

- `src/assets/diagram.js` — `fetchDiagram(url, {maxBytes, deps}) -> {text, bytes, error}`, `sanitizeSvg(text, {deps}) -> {svg, dropped, error}`, `toPng(svgEl, {scale}) -> Promise<Blob>`, `serializeSvg(svgEl) -> string`
- `src/assets/render.js` — `renderDiagramPanel(root, model, handlers)`
- `config.js` — the `diagram` section, validated like the rest
- `state.js` — remembers whether the panel is open

`diagram.js` must import cleanly in plain Node with `DOMParser`, `XMLSerializer` and `document` injected, so the sanitiser is testable without a browser. The sanitiser is the part that must be tested hardest and it must not require a DOM to test.

## Risks / Trade-offs

- **An inlined SVG executes if the sanitiser misses something** → parse-and-rebuild against an allowlist, never `innerHTML`; the CSP stays strict as a backstop; a test feeds it every dangerous construct.
- **The sanitiser silently mangles a legitimate diagram** → the drop count is reported in the panel, so an operator can see that their diagram was altered rather than wondering why an arrow vanished.
- **Diagram plus config exceeds 1MiB** → a documented `maxBytes` default of 512KiB, a notice when exceeded, and the budget stated next to the app's own ceiling.
- **PNG export differs from the screen because of fonts** → documented, not hidden.
- **The renderer hook becomes the normal path and the airgap promise quietly dies** → off by default, requires a deployment-level policy change, and the documentation says plainly that it executes code the project did not ship.
- **Operators lose in-cluster authoring of a diagram language** → the honest consequence of the measurement; the CI step is one command, and the hook exists for those who refuse it.

## Migration Plan

Additive and optional. A deployment with no `diagram` section renders exactly as v0.2.0, which CI asserts the same way it does for embedding: headers unchanged, manifests differing only by what the feature adds. Ships as a minor release.

An operator moving from a page that rendered a diagram language in the browser renders it to SVG once, commits the result beside their config, and sets `diagram.src`. The source file can live in the same ConfigMap for provenance even though the portal does not read it.

## Open Questions

- Whether `maxBytes` should default to 512KiB or lower. 512KiB is half the ConfigMap and already enough to make inlining slow on a phone.
- Whether to support more than one diagram. One panel covers the use case; several would want naming, ordering and a selector, and that can wait for someone who needs it.
- Whether the sanitiser should keep `<style>` elements with a filtered allowlist of properties rather than dropping them. Dropping is safe and loses diagram theming that renderers commonly emit, so this one will probably need revisiting with a real file in hand.
