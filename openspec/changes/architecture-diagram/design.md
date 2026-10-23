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

- **Shipping or bundling a renderer.** The page imports one the operator names, and that import is off until they name it.
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

### Rendering mermaid in the page: the normal path, not an afterthought

Supplying a rendered SVG is one way in. The other, and the one most people
actually want, is writing the diagram source in the config and having the page
render it:

```yaml
diagram:
  title: Architecture
  renderer:
    url: https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs
    options: {theme: dark, securityLevel: strict, flowchart: {htmlLabels: false}}
  source: |
    flowchart TD
      ingress[Ingress] --> portal[Portal]
      portal --> apps[Apps]
```

The renderer is a URL because the project cannot ship one: measured above, it is
2.6 times the ConfigMap limit. A URL is not a workaround, it is the only shape
that works, and it is what every portal doing this today already does.

The entry module is small (26KB for mermaid's ESM build) and pulls further
chunks on demand from the same origin, so the page stays light until the panel
is opened.

**What it costs, stated plainly:** the deployment must add that origin to
`script-src`. Nothing else. The page imports a module the project did not ship,
which is a real concession and the only one of its kind here, so it is off until
configured and it takes a deployment-level change exactly like `frame-src` for
embedding, with the same half-configured detection.

Self-hosting the renderer is better than a CDN and the docs say so, but the
field takes any URL the policy permits: refusing to let an operator point at a
public CDN while their current page already does would be theatre, and it would
just send them back to a hand-maintained HTML file.

When the renderer cannot be reached, the panel says the diagram needs that
origin and the bookmarks are untouched, which is the behaviour an offline
laptop should get.

### Renderer output needs its CSS, and the CSP must not be loosened for it

A renderer emits an SVG carrying a `<style>` element: mermaid's output is a pile
of elements with classes, and dropping that stylesheet does not degrade the
diagram, it destroys it. But an inline `<style>` in the document requires
`style-src 'unsafe-inline'`, which is too high a price for a picture, and a
static nginx cannot mint a per-request nonce.

So the sanitiser **extracts** the stylesheet instead of inlining it: the CSS
text is filtered (no `url(`, `@import`, `expression(`, `behavior:`), scoped to
the diagram container, and applied through a constructed stylesheet in the
CSSOM. CSSOM is not subject to `style-src`, so the diagram keeps its appearance
and the policy stays `style-src 'self'`.

The same applies to `style` attributes the renderer emits: they are read and
re-applied with `setProperty`, never left as attributes.

*Alternatives:* `style-src 'unsafe-inline'` when a renderer is configured (one
line, and it weakens the policy against the entire page rather than the
diagram); converting CSS rules to presentation attributes (lossy, and
mermaid's selectors do not map cleanly); dropping styles (produces a diagram
nobody would accept).

### Module layout and the contract between the pieces

Written here first so the pieces can be built independently.

**DOM, already in `index.html`:** `#diagram-panel` is a sibling of
`<main id="portal">`, outside everything that re-renders, for the same reason
the frame host is: rebuilding an inlined SVG on every config poll would discard
the pan and zoom position and re-run the renderer.

**`src/assets/diagram.js`**, which touches no DOM it was not handed and takes
`document`, `DOMParser`, `XMLSerializer`, `fetch` and timers through `deps` so
it is testable in plain Node:

- `fetchDiagram(url, {maxBytes, deps}) -> {text, bytes, error}` — enforces the
  size limit from the response before reading the body where possible, and
  always before parsing
- `renderSource(source, renderer, {deps}) -> {text, error}` — dynamically
  imports `renderer.url`, calls `initialize(renderer.options)` if present, then
  `render(id, source)` and takes the `svg` from the result. The adapter targets
  that shape because it is mermaid's, and the docs state it so another renderer
  can match it. A failed import is an `error`, never a throw
- `sanitizeSvg(text, {scopeId, deps}) -> {el, css, dropped, error}` — parses as
  `image/svg+xml`, rebuilds against the allowlist, and returns the element plus
  the **extracted, filtered, scoped** CSS as text. `dropped` counts elements,
  attributes and declarations, so the panel can say the diagram was altered
- `applyScopedCss(css, {deps}) -> stop()` — a constructed stylesheet, adopted on
  the document, which `style-src` does not govern. `stop()` removes it
- `serializeSvg(el) -> string`
- `toPng(el, {scale, deps}) -> Promise<Blob>`

**`src/assets/render.js`** — `renderDiagramPanel(host, model, handlers)`, where
the model carries the sanitised element or an error, the drop counts, the zoom
state and the title, and handlers cover toggle, zoom, fit, both exports and
retry. The panel never parses or sanitises anything itself.

**`config.js`** validates the `diagram` section; **`state.js`** gains
`getDiagramOpen()` / `setDiagramOpen(bool)` alongside the other per-viewer
preferences.

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
- Whether the renderer's `options` should be passed through verbatim or
  allowlisted. Verbatim for now, since they are the operator's own settings and
  the renderer is theirs; `securityLevel` is the one worth documenting, because
  a renderer told to trust its input will happily emit things the sanitiser then
  removes.
