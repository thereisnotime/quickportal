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
- **One ConfigMap**, so the app plus your config must fit in 1MiB. The app is
  about 288KiB of that, roughly 105KiB of which is the vendored YAML parser; CI
  fails above 384KiB.
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
- `examples/kustomize/embedding/` — a copy-out overlay enabling embedding, with
  both halves of the switch in one place.
