# The diagram panel

QuickPortal can show an architecture diagram in a collapsible panel beside your
bookmarks, with pan, zoom, fit-to-view and export to SVG and PNG. It is off
until you configure it, nothing is fetched until someone opens the panel, and a
diagram that is missing, too large or malformed never stops the bookmarks
rendering.

If you only want a launcher, you can stop reading. Nothing here affects you.

There are **two ways in**, and the difference between them is the whole reason
this document is long:

| | `diagram.src` | `diagram.renderer` |
| --- | --- | --- |
| What you commit | an SVG you rendered | diagram source text |
| Who renders it | you, in CI or on your laptop | the page, in the browser |
| Code the page imports | none | a module you name |
| Deployment change | none | widen `script-src` |
| Works offline | yes | only if you self-host the renderer |

**Prefer `diagram.src`.** It is the path with no concessions. The renderer path
exists because writing diagram source in the config and having it just render
is what most people actually want, and refusing to support it only sends people
back to hand-maintaining an HTML file.

## 1. An SVG you supply

```yaml
version: 1
title: Home

diagram:
  title: Architecture          # optional panel heading
  src: ./config/diagram.svg    # another key of your own ConfigMap
  maxBytes: 524288             # refuse anything larger (default: 512KiB)

groups:
  - name: Infrastructure
    items:
      - name: Dashboards
        url: https://dashboards.example.com
```

`./config/` is where your own ConfigMap is exposed to the browser, so
`./config/diagram.svg` means another key of the same ConfigMap that holds your
`config.yaml`:

```yaml
configMapGenerator:
  - name: quickportal-config
    behavior: replace
    files:
      - config.yaml
      - diagram.svg
    options:
      disableNameSuffixHash: true
```

Same volume as the config, so the same update path: committing a new SVG takes
effect **without rolling the pod**, and the panel shows it the next time it is
opened. Keep `disableNameSuffixHash: true`, or every diagram edit restarts the
pod, which is the thing this delivery shape exists to avoid.

The diagram never goes in the application ConfigMap. That one is content-hashed
on purpose, so putting it there would roll the pod on every edit, and it would
make your diagram ours to ship rather than yours to change.

### Authoring it

Anything that emits SVG works. The portal has no opinion and no preferred tool:
it displays an SVG. Inkscape, draw.io, Excalidraw, Graphviz, D2, PlantUML,
Structurizr, a diagram language's CLI, or a hand-written file are all fine.

If you write in a diagram language, render it once in CI. For mermaid that is
the `@mermaid-js/mermaid-cli` package and one command:

```sh
npx @mermaid-js/mermaid-cli -i architecture.mmd -o diagram.svg
```

Commit both files if you like: keep the source beside the SVG for provenance,
in the same ConfigMap. The portal only reads the SVG and ignores the rest.

## 2. Diagram source rendered in the page

```yaml
diagram:
  title: Architecture
  renderer:
    url: https://cdn.example.com/mermaid@11.12.0/dist/mermaid.esm.min.mjs
    options:
      securityLevel: strict
      theme: dark
  source: |
    flowchart TD
      ingress[Ingress] --> portal[QuickPortal]
      portal --> apps[Apps]
```

Now the diagram *is* the config: editing `source` is editing the ConfigMap, so
it updates without a restart like your bookmarks do, and there is no render step
in your pipeline.

The hostname above is a reserved placeholder, as everywhere in this repository.
The module is mermaid's ESM build, from the `mermaid` npm package: `url` points
at `mermaid.esm.min.mjs` in whatever copy of it **you** serve. Read
[Self-hosting the renderer](#self-hosting-the-renderer) before you point it at a
public CDN.

### Why QuickPortal does not ship a renderer

This is the question the rest of this section answers, and it is a measurement
rather than a preference:

```
mermaid.min.js        2,748,992 bytes
ConfigMap hard limit  1,048,576 bytes
full dist             66 MB, 20 runtime dependencies
```

The renderer is **2.6 times the entire delivery envelope**. QuickPortal has no
image to build and no registry: the app is files in a ConfigMap, and a ConfigMap
cannot hold 2.7MB. Every alternative renderer worth having is in the same order
of magnitude, because the hard part is graph layout and nobody has made that
small.

So there is no version of this feature where the project bundles a renderer. The
page imports the one you name, or you render to SVG yourself. Those are the two
options that exist.

### What it costs: `script-src`

The page is served under `script-src 'self'`, which is exactly what forbids
importing a module from anywhere else. Enabling this path means widening that
directive, and it is the only concession of its kind in the project: **the page
executes code QuickPortal did not ship and cannot vouch for.**

So it is off by default and takes two deliberate steps, exactly like embedding,
with the same half-configured detection. One without the other looks broken:

**Helm:**

```yaml
diagram:
  rendererOrigins:
    - https://cdn.example.com
```

With `config.inline`, the chart refuses to render if your config names a
`diagram.renderer.url` whose origin no entry permits, naming the renderer and
the policy it would have served. That check cannot run when you supply
`config.existingConfigMap`, because the chart cannot read it.

**Kustomize:** patch the `script-src.inc` key of the server config ConfigMap.
`examples/kustomize/diagram/` is a copy-out example that does exactly this, with
both halves in one place.

```yaml
patches:
  - target:
      version: v1
      kind: ConfigMap
      name: quickportal-server-config
    patch: |
      apiVersion: v1
      kind: ConfigMap
      metadata:
        name: quickportal-server-config
      data:
        script-src.inc: |
          set $quickportal_script_src "'self' https://cdn.example.com";
```

Either way only that one key changes. `security-headers.inc`, which holds the
single Content-Security-Policy, stays exactly as shipped, so upgrades keep
bringing you policy fixes and there is never a second copy of the policy to
drift.

An origin is `scheme://host[:port]`. Five ways to get it wrong:

- **Dropping `'self'` breaks the whole portal.** It is not a default underneath
  your value: the entire application is served from this origin, so a
  `script-src` without it refuses QuickPortal's own modules and you get a blank
  page rather than a missing diagram. Keep it, first. The Helm value adds it for
  you; the kustomize patch does not.
- **A path does not narrow it usefully.** CSP matches a path as a prefix, and a
  renderer pulls further chunks from its own origin on demand, so a path can
  cover the entry module and refuse a chunk. List the origin.
- **A sibling subdomain is a different origin.** `https://cdn.example.com` does
  not cover `https://assets.example.com`. Use `https://*.example.com` if you
  mean both.
- **A scheme mismatch fails.** An HTTPS portal cannot load a script over HTTP at
  all; browsers block that as mixed content regardless of your policy.
- **Never use `https:` or `*`.** That permits the page to execute anything it
  can reach, which is the protection you are paying for.

Verify what is actually being served:

```sh
curl -sI https://portal.example.com/ | tr ';' '\n' | grep script-
```

When the policy forbids the import, the panel says the diagram needs that origin
and names the server config as the thing to change. That one case QuickPortal
*can* detect, because a refused import raises a CSP violation in our own page.
When the origin is simply unreachable, which is what an offline laptop gets, the
panel says so. Either way the bookmarks are untouched.

### Self-hosting the renderer

Serving the renderer yourself is better than pointing at a public CDN, and the
reasons are the ordinary ones: a third party can change or lose the file, the
request tells them who your users are, it breaks on an airgapped network, and it
puts your start page's availability behind someone else's.

The field takes any URL the policy permits, because refusing to let you point at
a CDN while your current page already does would be theatre. But if you can,
host it:

1. Fetch the renderer's ESM build once (for mermaid, `mermaid.esm.min.mjs` and
   the chunks beside it from the `mermaid` npm package) and commit it to your own
   repository.
2. Serve it from somewhere you control and set `diagram.renderer.url` to that
   URL, then add its origin to `rendererOrigins`.
3. **Or serve it from the portal's own origin**, in which case `'self'` already
   covers it, `rendererOrigins` stays empty and there is no policy change at
   all. Note that the renderer loads further chunks at runtime and a ConfigMap
   key cannot contain a slash, so the single-file app ConfigMap is not a good
   home for it; put it behind the same Ingress on a path you serve separately.

Option 3 gets you in-page rendering with none of the cost described above. It is
the best outcome available and worth the hour.

### The renderer contract

QuickPortal calls a renderer module like this, and nothing else:

```js
const mod = await import(renderer.url);
// mod.default if it has a render(), otherwise mod itself
const api = [mod.default, mod].find(c => typeof c?.render === "function");
if (typeof api.initialize === "function") {
  api.initialize(renderer.options || {});     // only when present
}
const result = await api.render(id, source);  // {svg} or the SVG string
```

So a module qualifies if its default export, **or the module namespace itself**,
has:

- **`render(id, source)`** — required. Returns, or resolves to, either an object
  with an `svg` string or the SVG string directly. `id` is a unique element id
  the renderer may use for its own internal references.
- **`initialize(options)`** — optional. Called once, before the first render,
  whenever it exists, handed `renderer.options` verbatim (or `{}` when you set
  none, because a call that happens only sometimes is the kind of thing two
  modules drift on).

That is mermaid's shape, deliberately: it is the renderer almost everyone means,
and matching it means the common case needs no adapter. It is written down here
so that another renderer, or a thin wrapper module of your own, can match it —
and a wrapper is often the shortest route, since a module that just re-exports
`render` and `initialize` is a few lines.

`options` is passed through verbatim and unvalidated. They are your settings for
your renderer, not QuickPortal's. `securityLevel` is the one worth a note:
leaving it `strict` is the right default, and a renderer told to trust its input
will happily emit things QuickPortal then removes, which reads like a bug when it
is really this setting.

Nothing here ever throws into the page. The panel reports, each with its own
message: an import that failed (which covers an unreachable origin, a refusal by
`script-src`, a 404 and a syntax error in the module, because the browser
reports all four identically and does not say which), a module with no `render`,
`initialize` rejecting its options, `render` failing on your source — usually a
syntax error in it, so the renderer's own message is passed through verbatim —
a renderer returning no SVG, and output over `maxBytes`.

## Everything that reaches the page is sanitised

**An SVG is executable content.** It can carry `<script>`, `on*` handlers,
`<foreignObject>` with arbitrary HTML, `<use href="http://...">`,
`<image href>` pointing at a remote host, CSS `@import`, and animation elements.

Pan and zoom need the SVG in the document, so it is inlined rather than put in
an `<img>`, and that makes sanitisation mandatory. The SVG is parsed with
`DOMParser` as `image/svg+xml` and **rebuilt against an allowlist** of elements
and attributes. It is never assigned as markup. Dropped unconditionally:

- `<script>`, every `on*` attribute, and anything else that executes
- `<foreignObject>`, `<animate*>`, `<set>`, `<handler>`
- `<base>`, and namespace-prefixed attributes we do not recognise
- `href`, `xlink:href`, `src`, `from`, `to`, `values` and `begin` values that are
  not a fragment (`#id`) — so external references and `javascript:` go, and
  references to ids within the same diagram stay
- `url(`, `@import`, `expression(` and `behavior:` wherever they appear in CSS

The strict CSP is a backstop, not the mechanism. The portal does not rely on it
and does not widen it for a diagram.

**This applies to a renderer's output exactly as it does to a file you
supplied**, and regardless of the renderer's own security setting. A renderer is
third-party code; its output is not more trusted than a file. The threat model
for the file you commit is "my own SVG does something I did not intend", not "a
stranger is attacking me" — but people paste SVGs from the internet, so the
allowlist is applied either way.

**When sanitisation removes anything, the panel says how much.** Silently
altering your diagram would be worse than telling you: if an arrow vanished, the
drop count is where to look. A diagram containing only shapes, paths, text,
groups, gradients, markers and fragment references loses nothing.

### A renderer's CSS is extracted, not inlined

Renderer output carries a `<style>` element, and its appearance depends on it:
mermaid's SVG is a pile of elements with classes, so dropping that stylesheet
does not degrade the diagram, it destroys it.

But an inline `<style>` in the document would require
`style-src 'unsafe-inline'`, which is far too high a price for a picture, and a
static nginx cannot mint a per-request nonce. So the stylesheet is **extracted**
instead: the CSS text is filtered, scoped to the diagram container, and applied
through a constructed stylesheet adopted in the CSSOM. **CSSOM is not subject to
`style-src`**, so the diagram keeps the appearance the renderer intended and the
policy stays `style-src 'self'`.

`style` attributes the renderer emits are handled the same way: read and
re-applied with `setProperty`, never left as attributes.

This is why `style-src` is **not** configurable, unlike `script-src`, and CI
asserts it stays `'self'`. The extraction machinery exists precisely so that
directive never has to move. If you find yourself wanting to widen it for a
diagram, the diagram is not the problem.

## Export

The panel exports to SVG and PNG, both computed in the browser from what is on
screen. No dependency and no network request: SVG serialises the sanitised tree,
PNG draws it to a canvas at a chosen scale and calls `toBlob`.

**Fonts are the one surprise worth stating.** Text in the exported PNG renders
with whatever font the browser actually resolved, so a diagram relying on a
webfont exports with the substituted fallback, and the PNG will not match the
screen on a machine that has the font. The SVG export keeps the font *name* and
so re-renders correctly wherever that font is available. If the PNG has to be
exact, use a font you know is installed, or export SVG.

`canvas.drawImage` of an SVG would taint the canvas if the SVG held external
references, which would make PNG export fail outright. The sanitiser has already
removed them, so this does not arise.

## The size budget

The diagram shares the **1MiB ConfigMap limit** with your `config.yaml`, because
they are keys of the same ConfigMap. The app itself is in a separate ConfigMap
and does not compete with them.

`maxBytes` defaults to **512KiB**, half of that limit. It exists for two
reasons: so you notice the budget before a cluster refuses your commit, and
because inlining a megabyte of SVG makes the page janky on a phone long before
the cluster has an opinion.

Over the limit, nothing is inlined and the panel names the actual and permitted
sizes. The bookmarks render normally. Raising `maxBytes` raises the notice, not
the 1MiB ceiling.

**It applies to a renderer's output too**, checked before the sanitiser sees the
text. Three lines of diagram source can render into megabytes of SVG, so a
renderer with no ceiling would be a hole straight through the size limit, and an
oversized render is reported exactly like an oversized file. Note that this is
the only part of the budget that `source` does not get for free: the text you
commit is tiny, but what it renders into need not be.

A rendered SVG of a readable architecture diagram is usually tens of kilobytes,
so this is rarely tight. If yours is not: the usual cause is an embedded raster
image or an exporter writing one path per glyph, and the fix is in the exporter.
The `source` path is far smaller still, since you commit text.

## When something is wrong

Every failure degrades to a notice and leaves the bookmark tree working.

| What you see | What it means |
| --- | --- |
| No panel at all | No `diagram` section, or the key is absent and `src` was never configured. |
| "could not be fetched", naming a path | `diagram.src` is set but the file is not at that served path. Check it is a key of `quickportal-config` and that the path starts `./config/`. |
| Actual and permitted sizes | Over `maxBytes`. |
| A parse error | The file is not valid SVG. Check you committed the SVG and not the source. |
| "n dropped" and a diagram | Sanitisation removed something. Usually `securityLevel` on a renderer, or an exporter emitting `<foreignObject>` text. |
| The diagram needs an origin | `script-src` forbids the renderer's origin, or that origin is unreachable. See above. |
| A blank page, no portal at all | `'self'` was dropped from `script-src`. The portal's own modules are being refused. |

## Also worth knowing

- **One diagram.** One panel covers the use case; several would want naming,
  ordering and a selector, and that can wait for someone who needs it.
- **Lazy.** With the panel closed, nothing is requested and no renderer is
  imported, so a large diagram costs nothing until someone looks at it.
- **The panel is a view, not a route.** Its open state, pan and zoom are
  remembered per browser and survive a config edit re-rendering the page.
- **It is a viewer.** There is no editing in the browser.

## One console message you can ignore

Loading a diagram that contains a `<style>` element logs a Content-Security-Policy
error in the browser console, naming `style-src`:

```
Applying inline style violates the following Content Security Policy directive: "style-src 'self'"
```

Nothing is broken and nothing is being applied to the page. `DOMParser` evaluates
a `<style>` element while parsing the document it builds, before the portal gets
a chance to remove it, and the browser reports that evaluation. The portal then
extracts the stylesheet text and applies it through the CSSOM, which is why the
diagram is styled correctly despite the message.

It cannot be suppressed from the page. Every parser MIME type produces it, and
the alternative, stripping `<style>` from the text before parsing, would mean
the sanitiser inspecting a different document from the one the parser produced,
which is the classic way a sanitiser gets bypassed. A cosmetic console message
is a much better trade.

If you collect CSP reports, expect `style-src-elem` reports from this and nothing
else from it.

