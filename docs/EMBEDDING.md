# Embedding apps in the portal

QuickPortal can open an app *inside* the page, in a tab strip, instead of in a
browser tab. It is off by default and turning it on takes two deliberate steps,
plus cooperation from the app you are embedding.

If you only want a launcher, you can stop reading. Nothing here affects you.

## The three things that must all be true

Embedding fails if any one of them is missing, and the symptom is the same every
time: an empty rectangle.

1. **The item asks for it**, in your config.
2. **The portal permits it**, in the server config. The portal's own
   Content-Security-Policy sends `frame-src 'none'` by default, which forbids it
   from loading *any* frame.
3. **The app permits being framed.** This is the part QuickPortal cannot do
   anything about, and the part that most often blocks it.

### 1. The item

```yaml
items:
  - name: Dashboards
    url: https://dashboards.example.com
    embed: true
    allow: [fullscreen]        # optional
```

`allow` delegates a browser permission to the framed app. The accepted tokens
are `autoplay`, `clipboard-read`, `clipboard-write`, `encrypted-media`,
`fullscreen` and `picture-in-picture`. Camera, microphone, geolocation and
screen capture are deliberately **not** delegable: a bookmark list is the wrong
place to hand a device to another origin.

`sandbox` is available and opt-in. Note that asking for both `allow-scripts` and
`allow-same-origin` lets the framed page remove its own sandbox, so the sandbox
then protects nothing; the portal warns about that and still honours it.

### 2. The portal's policy

**Helm:**

```yaml
embedding:
  frameOrigins:
    - https://dashboards.example.com
    - https://*.example.org
```

With `config.inline`, the chart refuses to render if an item asks to be embedded
and no permitted origin covers it, naming the item. That check cannot run when
you supply `config.existingConfigMap`, because the chart cannot read it.

**Kustomize:** patch the `frame-src.inc` key of the server config ConfigMap.
`examples/kustomize/embedding/` is a copy-out example that does exactly this.

An origin is `scheme://host[:port]`. Four ways to get it subtly wrong:

- **A path does not narrow or widen it.** `https://app.example.com/grafana` is
  not a valid origin; use `https://app.example.com`.
- **A sibling subdomain is a different origin.** `https://a.example.com` does not
  cover `https://b.example.com`. Use `https://*.example.com` if you mean both.
- **A scheme mismatch fails.** An HTTPS portal cannot frame an HTTP app at all;
  browsers block that as mixed content regardless of your policy.
- **Never use `https:` or `*`.** It would let the portal frame anything on the
  internet, which is the protection you are paying for.

Verify what is actually being served:

```sh
curl -sI https://portal.example.com/ | grep -o "frame-src [^;]*"
```

### 3. The app you are embedding

This is the part to hand to whoever owns that app. For the portal at
`https://portal.example.com` to frame it, the app's responses must:

- **not** send `X-Frame-Options: DENY` or `SAMEORIGIN`
- **and** either send no `frame-ancestors`, or send one that includes the portal:

```
Content-Security-Policy: frame-ancestors 'self' https://portal.example.com
```

Browsers enforce whichever of the two is stricter, so leaving an old
`X-Frame-Options: DENY` in place will block framing even with a correct
`frame-ancestors`. `X-Frame-Options: ALLOW-FROM` is obsolete and ignored; use
`frame-ancestors`.

Check with:

```sh
curl -sI https://dashboards.example.com/ | grep -iE 'x-frame-options|content-security-policy'
```

## Why QuickPortal cannot tell you which one is wrong

A page cannot read anything about a cross-origin frame: not its status, not its
headers, not its content. A frame that was refused, a frame that is slow, and a
frame returning a 500 are indistinguishable from the outside. The browser's
`load` event fires even on its own refusal page.

So the portal does not guess. A few seconds after a frame mounts, a dismissible
strip appears at the edge of the frame area offering to open the app in a
browser tab and stating the headers above. **It appears even when the app loaded
perfectly well**, because the alternative is suppressing the only escape hatch
in exactly the case it exists for. It never covers or dims the app.

The one thing the portal *can* detect is its own policy refusing to load a
frame, because that raises a CSP violation in our own page. That case gets a
specific message naming the server config.

Set `embedding.docsUrl` to point the strip at your own runbook:

```yaml
embedding:
  docsUrl: https://runbook.example.org/embedding
```

## The session problem nobody expects

An embedded app on a **different site** may show you a login screen forever
while working fine in a browser tab.

A cookie without `SameSite=None; Secure` is not sent in a third-party context,
and browsers are restricting third-party cookies further. Inside a frame, an app
on an unrelated domain is third-party, so its session cookie may simply not be
sent. Apps on sibling subdomains of one site are usually fine.

Nothing in the portal can fix this, and the symptom looks like an application
bug rather than a browser policy. If an embedded app will not stay logged in,
this is almost certainly why. Options: serve it on a subdomain of the same site
as the portal, have it set `SameSite=None; Secure` (and consider partitioned
cookies), or do not embed it.

Single sign-on flows can fail for a related reason: an identity provider usually
refuses to be framed, so a redirect to a login page inside a frame dead-ends.
Log in to the app in a normal browser tab first, then embed it.

## Resource use

Each mounted frame is an entire application. Four is the default cap and the
strip shows the count, for example `3 of 4 open`. Opening a fifth closes the
least recently focused one and says which.

Lowering `embedding.maxFrames` below the number currently open closes nothing:
the count drains one action at a time, and the strip says `over the limit` until
it does. Closing five apps because a number changed would be a hostile
surprise.

Refreshing is always explicit, because it is a navigation that discards whatever
the app held. Nothing else reloads a frame, including a config change: your
scroll position, half-written form or open console survives an edit to the
ConfigMap.
