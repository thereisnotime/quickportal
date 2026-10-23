# Configuration reference

Your config lives in the `quickportal-config` ConfigMap under the key
`config.yaml`, and is served to the browser at `./config/config.yaml`. YAML and
JSON are both accepted: JSON is tried first and YAML second, so a `.yaml` key
holding JSON works fine.

Validate before committing:

```sh
node tools/validate-config.mjs config.yaml          # also takes - for stdin
node tools/validate-config.mjs --strict config.yaml # warnings fail too
```

## Top level

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `version` | integer | **required** | Must be `1`. A missing or newer version renders nothing, deliberately. |
| `title` | string | `QuickPortal` | Page heading and `<title>`. |
| `subtitle` | string | `""` | Shown under the title. |
| `theme` | `auto` \| `light` \| `dark` | `auto` | A theme the viewer picks in the UI always wins over this. |
| `layout.density` | `comfortable` \| `compact` | `comfortable` | `compact` tightens spacing, and on precise pointers only, target sizes. |
| `layout.minCardWidth` | CSS length | `14rem` | Drives the grid; the columns are computed from it. |
| `reload.interval` | integer seconds | `30` | `0` disables polling. The manual reload button always works. |
| `embedding.maxFrames` | integer 1-16 | `4` | Cap on apps open inside the portal at once. |
| `embedding.docsUrl` | URL | none | Points the "why can a frame stay blank" help at your own runbook. |
| `diagram` | mapping | none | An architecture diagram panel. See below. |
| `groups` | list of group | `[]` | The tree. |
| `sets` | list of set | `[]` | Named groups of targets that open together. |

## Group

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | **required** | |
| `id` | string | derived | See ids below. |
| `icon` | string | none | Emoji or text, a URL, or `auto`. |
| `collapsed` | boolean | `false` | Initial state only; the browser remembers the viewer's choice afterwards. |
| `items` | list of item | `[]` | |
| `groups` | list of group | `[]` | Nests recursively, to five levels. |

## Item

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | **required** | |
| `url` | string | **required** | Absolute or relative. `javascript:` and `vbscript:` are rejected. |
| `id` | string | derived | |
| `description` | string | none | Shown under the name, and searched. |
| `icon` | string | none | Emoji or text, a URL, or `auto` for the origin's favicon. Falls back to initials. |
| `tags` | list of string | `[]` | Searched, shown as chips. |
| `target` | `_blank` \| `_self` | `_blank` | Ignored when `embed` is true. |
| `embed` | boolean | `false` | Open inside the portal in a tab strip instead of a browser tab. Requires a server-config change too: see [EMBEDDING.md](EMBEDDING.md). |
| `allow` | list of string | `[]` | Browser permissions delegated to the embedded app: `autoplay`, `clipboard-read`, `clipboard-write`, `encrypted-media`, `fullscreen`, `picture-in-picture`. Camera, microphone, geolocation and screen capture are deliberately not delegable. |
| `sandbox` | list of string | `[]` | Standard `allow-*` iframe sandbox tokens. Empty means no `sandbox` attribute at all, which is not the same as HTML's `sandbox=""`. |

## Diagram

An optional architecture diagram, shown in a collapsible panel beside the
bookmarks. Omit the section and no panel is rendered, nothing is fetched and
nothing changes.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `title` | string | a generic heading | Panel heading. |
| `src` | string | none | Served path of an SVG **you** rendered, normally `./config/diagram.svg`: another key of your own ConfigMap. Required unless `renderer` is set. |
| `maxBytes` | integer | `524288` | Refuse a larger diagram: both a fetched `src` file and a renderer's output, since a few lines of source can render into megabytes. Zero, negative, non-integer or beyond what a ConfigMap can hold is a warning and falls back to the default. |
| `renderer.url` | string | none | Module the page imports to render `source`. Must be an absolute HTTPS URL or a same-origin path: this field decides what code the page runs. **Also needs a server-config change**, see [DIAGRAM.md](DIAGRAM.md). |
| `renderer.options` | mapping | `{}` | Passed verbatim to the renderer's own `initialize()`. Your renderer's settings, not QuickPortal's. |
| `source` | string | none | Diagram source text for `renderer` to render. Required when `renderer.url` is set. |

Set either `src` or `renderer` plus `source`. A `diagram` section with neither
is an error at `diagram.src`, because there is nothing to show; a `renderer`
with no `source` is an error too, because a renderer with nothing to render is a
misconfiguration rather than a diagram that happens to be missing.

```yaml
# The path with no concessions: an SVG you rendered, committed beside this file.
diagram:
  title: Architecture
  src: ./config/diagram.svg
  maxBytes: 524288
```

```yaml
# The path where the page renders your source. Needs `script-src` widened.
diagram:
  title: Architecture
  renderer:
    url: https://cdn.example.com/mermaid@11.12.0/dist/mermaid.esm.min.mjs
    options: {securityLevel: strict, htmlLabels: false, flowchart: {htmlLabels: false}}
  source: |
    flowchart TD
      ingress[Ingress] --> portal[Portal]
```

Four things worth knowing here, with the rest in
[DIAGRAM.md](DIAGRAM.md):

- **A new diagram does not roll the pod.** It lives in the same ConfigMap as
  this file, so committing one takes effect on the next open, like a bookmark
  edit. Keep `disableNameSuffixHash: true` on that generator.
- **Whatever reaches the page is sanitised** against an allowlist, including a
  renderer's output and regardless of the renderer's own `securityLevel`. When
  anything is dropped the panel says how much, rather than altering your
  diagram silently.
- **QuickPortal ships no renderer**, because the usual one is 2.7MB against a
  1MiB ConfigMap limit. `renderer.url` names one you serve; self-hosting it is
  preferable to a public CDN, and serving it from the portal's own origin needs
  no policy change at all.
- **PNG export uses whatever font the browser substituted**, so a diagram
  relying on a webfont will not match the screen. SVG export keeps the font
  name.

## Set

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | **required** | |
| `id` | string | derived | Set ids are their own namespace and never collide with group or item ids. |
| `icon` | string | none | |
| `targets` | list of string | `[]` | An item id, a group id (everything beneath it, depth-first), or a bare URL. |

Targets are de-duplicated by URL, so naming both a group and one of its items
opens that item once.

Opening more than ten targets asks for confirmation first. When your browser
blocks the pop-ups, the blocked targets are listed as ordinary links rather than
quietly dropped, because browsers cap how many tabs one click may open.

## Ids

Set `id` yourself and it is used verbatim. Leave it out and it is derived by
slugifying the name and qualifying it with its parent's id:

```yaml
groups:
  - name: Media            # media
    items:
      - name: Library      # media/library
    groups:
      - name: Downloads    # media/downloads
        items:
          - name: Queue    # media/downloads/queue
```

Two different parents can each hold a "Status" without colliding.

Ids matter beyond the config: sets reference them, and the viewer's open and
closed folders are remembered by group id. **Renaming a group changes its
derived id**, which forgets that folder's remembered state and breaks any set
pointing at it. Set an explicit `id` on anything you expect to rename.

Duplicate ids are an error naming both places, rather than one silently
replacing the other.

## Errors and warnings

Problems are reported on the page as `path: message`, where the path is the
position in your config (`groups[0].items[2].url`) or `config` for something
wrong with the document as a whole.

**Errors** that make the document unusable render nothing: not a mapping, and a
missing or unsupported `version`. There is nothing trustworthy to show.

**Errors in an entry** drop that entry, list the problem above the tree, and
render everything else. A missing `name` or `url`, broken structure such as
`items` not being a list, a duplicate id, an unresolvable set target, or a
`javascript:` URL. One typo does not blank your portal.

**Warnings** change nothing but are worth knowing: an unknown key (so a config
written for a later version still works), a bad enum value or wrong type, which
falls back to the documented default, and nesting past five levels, which is
truncated there.

## Embedding

`embed: true` opens an item inside the portal rather than in a browser tab. It
needs two things beyond this file: the deployment must widen the portal's own
`frame-src` policy, and the app being embedded must permit framing. Neither is
something this config can do, and when either is missing the result is an empty
rectangle.

[EMBEDDING.md](EMBEDDING.md) covers the headers the target app must send, how to
widen the policy with Helm or kustomize, why the portal cannot tell you which of
the three steps is missing, and the third-party cookie problem that makes an
embedded app on an unrelated domain refuse to stay logged in.

Two behaviours worth knowing here:

- `embed: true` on a URL that cannot be framed, such as a `mailto:` link, is a
  **warning**, not an error. The item stays and opens in a browser tab.
- An unrecognised `allow` or `sandbox` token is a warning and is dropped rather
  than passed through to the browser.

## Limits

- **Five levels** of nesting. Deeper is a warning and is truncated.
- **1MiB per ConfigMap**, which is a hard limit in Kubernetes rather than a
  setting. There are two that matter and they do not compete:
  - **The app's**, holding only the application files. About 396KiB, roughly
    105KiB of which is the vendored YAML parser. Not yours to worry about; CI
    fails above 512KiB.
  - **Yours**, holding this config *and* a diagram if you have one, because
    they are keys of the same object. This is the one with your name on it.
    `diagram.maxBytes` defaults to **512KiB**, half of it, so you hear about
    the budget from the page rather than from a rejected commit. Raising it
    raises the notice, not the ceiling.
- **No `subPath`** on the config volume, or kubelet will never update it and live
  reload silently stops working.
- **Never `immutable: true`** on `quickportal-config`: it could then never
  change at all.
- A config edit does **not** roll the pod, by design. Expect up to the kubelet
  projection delay (about a minute) plus one `reload.interval`.

## Examples

- `examples/config/minimal.yaml` — the smallest config that renders.
- `examples/config/nested-sets.yaml` — nesting, and sets using item ids, group
  ids and a bare URL.
- `examples/config/full.yaml` — every field above, annotated.
- `examples/config/diagram.yaml` — the diagram panel, on the path that imports
  nothing.
- `examples/kustomize/embedding/` — a copy-out overlay enabling embedding, with
  both halves of the switch in one place.
- `examples/kustomize/diagram/` — a copy-out overlay for rendering diagram
  source in the page, with both halves of that switch in one place. You do not
  need it to show a diagram: `diagram.src` works without any overlay.
