// The diagram pipeline: fetch or render an SVG, sanitise it, and hand the view
// layer a tree it can inline.
//
// This module is a security boundary, not a formatting pass. The diagram is
// inlined rather than shown in an <img>, because pan, zoom and scaled export
// all need the nodes in the document, and an inlined SVG is executable
// content: <script>, on* handlers, <foreignObject> with arbitrary HTML,
// <use href="https://..."> pulling in a remote document, CSS @import,
// animation elements that fire on load.
//
// So nothing here ever assigns markup. The text is parsed with DOMParser as
// image/svg+xml and a new tree is built from it, element by element and
// attribute by attribute, against an allowlist, so a construct nobody here
// thought of is dropped by default rather than passed through by default.
// innerHTML, outerHTML, insertAdjacentHTML and createContextualFragment
// appear nowhere in this file and must not be added to it.
//
// The page's CSP (script-src 'self'; style-src 'self') is a backstop, not the
// mechanism: assume it is absent, and never ask for it to be widened. Hence
// also the extracted stylesheet (CSSOM is not governed by style-src) rather
// than a <style> element, and `style` attributes returned as declarations for
// setProperty rather than left on the elements.
//
// Everything browser-shaped arrives through `deps`, so the module imports in
// plain Node with no DOM and the tests need neither a browser nor a network.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Default ceiling on a fetched diagram, matching `diagram.maxBytes`. */
export const DIAGRAM_DEFAULT_MAX_BYTES = 524288;

/** How long a diagram fetch, or an SVG decode during PNG export, may take. */
export const DIAGRAM_FETCH_TIMEOUT_MS = 15000;
export const DIAGRAM_DECODE_TIMEOUT_MS = 10000;

/** Default PNG export scale, documented in docs/ so the output is predictable. */
export const PNG_DEFAULT_SCALE = 2;

/** Fallback export size when the SVG declares neither viewBox nor dimensions. */
const PNG_FALLBACK_SIZE = { width: 1024, height: 768 };

/**
 * Elements copied into the rebuilt tree. Everything else is dropped.
 *
 * Static drawing primitives, their containers, paint servers, markers,
 * clipping and a conservative core of filter primitives. What is excluded on
 * purpose is as much part of the boundary as what is included:
 *
 *   script, handler         execute, trivially
 *   foreignObject, switch    a hole through which arbitrary HTML arrives
 *   base                     rewrites URL resolution for the whole document
 *   animate*, set, discard,  declarative animation can mutate any attribute
 *   mpath                    of any element after sanitisation has finished
 *   image, feImage           only an external or data: reference is useful in
 *                            one, and both are refused; restricted to a
 *                            fragment it would draw nothing
 *   feColorMatrix,           need `values`, refused everywhere (ATTR_URLISH)
 *   feComponentTransfer      because of the animation elements
 *   metadata                 a container for foreign-namespace XML, which is
 *                            exactly what is not copied
 *   font, font-face, glyph   SVG fonts: obsolete and barely tested anywhere
 *   style                    not dropped but extracted; see rebuild()
 */
export const ALLOWED_ELEMENTS = new Set(
  (
    'svg g defs symbol use a title desc ' +
    'rect circle ellipse line polyline polygon path text tspan textPath ' +
    'linearGradient radialGradient stop pattern marker clipPath mask ' +
    'filter feBlend feComposite feDropShadow feFlood feGaussianBlur ' +
    'feMerge feMergeNode feOffset'
  ).split(' '),
);

/**
 * Attributes copied when they appear on an allowed element, after their value
 * has passed isSafeValue().
 *
 * One flat list rather than a per-element table. A table reads as if it were
 * stricter, but every name here is geometry, paint or text metrics: `rx` on a
 * <text> is meaningless, not dangerous, and the table would be a hundred lines
 * of surface for no boundary. Presentation attributes are included because a
 * renderer emits them and dropping them would mangle a legitimate diagram,
 * which is its own kind of failure.
 *
 * `href` is on the list and is additionally forced through the fragment rule
 * below; `style` is read and removed rather than copied, see collectInlineStyle.
 */
export const ALLOWED_ATTRIBUTES = new Set(
  (
    // identity, structure, accessibility
    'id class transform viewBox preserveAspectRatio version role ' +
    'aria-label aria-labelledby aria-describedby aria-hidden ' +
    // geometry
    'x y x1 y1 x2 y2 cx cy r rx ry width height d points dx dy rotate ' +
    'pathLength textLength lengthAdjust side startOffset spacing method ' +
    // paint and compositing
    'fill fill-opacity fill-rule stroke stroke-width stroke-linecap ' +
    'stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit ' +
    'stroke-opacity opacity color display visibility overflow clip-path ' +
    'clip-rule mask filter marker-start marker-mid marker-end paint-order ' +
    'vector-effect shape-rendering text-rendering color-interpolation ' +
    'color-interpolation-filters mix-blend-mode isolation ' +
    // text
    'font-family font-size font-size-adjust font-style font-variant ' +
    'font-weight font-stretch letter-spacing word-spacing text-anchor ' +
    'text-decoration dominant-baseline alignment-baseline baseline-shift ' +
    'direction unicode-bidi writing-mode white-space ' +
    // paint servers
    'gradientUnits gradientTransform spreadMethod fx fy fr offset ' +
    'stop-color stop-opacity patternUnits patternContentUnits ' +
    'patternTransform ' +
    // markers, clipping, masking
    'markerWidth markerHeight markerUnits refX refY orient clipPathUnits ' +
    'maskUnits maskContentUnits ' +
    // filters
    'filterUnits primitiveUnits in in2 result mode operator stdDeviation ' +
    'flood-color flood-opacity ' +
    // checked further before they are copied
    'href style'
  ).split(' '),
);

/**
 * Attributes whose value must be a pure fragment reference (`#id`) or nothing.
 *
 * `from`, `to`, `values`, `begin`, `by` and `end` are the animation
 * attributes, and the rule is absolute rather than conditional on the element:
 * a conditional rule is one refactor away from being wrong, and the elements
 * that use them legitimately are not on the element allowlist anyway.
 */
export const ATTR_URLISH = new Set(
  'href src from to values begin by end action formaction data ping poster xlink:href'.split(
    ' ',
  ),
);

/**
 * Namespace-prefixed attributes we recognise. Anything else prefixed is
 * dropped: an unrecognised prefix means an unrecognised vocabulary, and copying
 * it would be copying something nobody audited.
 *
 * xmlns declarations are neither copied nor counted as a drop. They carry no
 * information once the tree is rebuilt with createElementNS, and counting them
 * would tell an operator their clean diagram had been altered when it had not.
 */
const KNOWN_PREFIXED = new Map([
  ['xlink:href', XLINK_NS],
  ['xml:space', XML_NS],
  ['xml:lang', XML_NS],
]);

/** Substrings that disqualify any attribute value or CSS declaration. */
const UNSAFE_VALUE =
  /\b(?:javascript|vbscript|livescript|data|blob|filesystem|file|about)\s*:|expression\s*\(|behaviou?r\s*:|-moz-binding|@import|<\s*\//i;

/**
 * Properties refused by name, whatever their value.
 *
 * UNSAFE_VALUE catches `behavior:` written as a value, which is where it
 * appears in an attribute, but in a declaration block it is the property name
 * and the value is an innocent-looking url(#x). Both legacy IE behaviours and
 * -moz-binding fetch and execute a document, so the name is refused first.
 */
const BANNED_PROPERTIES = new Set(['behavior', 'behaviour', '-moz-binding', '-ms-behavior']);

/** A pure same-document fragment reference. */
const FRAGMENT = /^#[^\s'"<>()\\{}]+$/;

/** Scope ids are interpolated into a selector, so they are checked, not trusted. */
const SCOPE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

// --- fetching ---------------------------------------------------------------

/**
 * Fetch a diagram, refusing anything over the size limit.
 *
 * Checked against Content-Length before the body is read where the server
 * declares one, and always against the decoded byte length before the text is
 * handed back. A chunked response with no Content-Length cannot slip past the
 * second check.
 *
 * @param {string} url
 * @param {object} [options]  maxBytes, timeoutMs, deps {fetch, TextEncoder,
 *                            AbortController, setTimeout, clearTimeout}
 * @returns {Promise<{text?: string, bytes?: number, error?: object}>}
 */
export async function fetchDiagram(url, options = {}) {
  const deps = options.deps ?? {};
  const target = typeof url === 'string' ? url.trim() : '';
  if (target === '') return { error: issue('config', 'No diagram source is configured.') };

  const maxBytes = toPositiveInt(options.maxBytes, DIAGRAM_DEFAULT_MAX_BYTES);
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { error: issue('unsupported', 'This browser cannot fetch the diagram.') };
  }

  const timer = startTimeout(options.timeoutMs ?? DIAGRAM_FETCH_TIMEOUT_MS, deps);
  let response;
  try {
    response = await doFetch(target, {
      cache: 'no-cache',
      credentials: 'same-origin',
      signal: timer.signal,
      ...(options.fetchInit ?? {}),
    });
  } catch (err) {
    return {
      error: issue(
        timer.fired ? 'timeout' : 'network',
        timer.fired
          ? `The diagram at ${target} did not answer in time.`
          : `The diagram at ${target} could not be fetched: ${messageOf(err)}`,
        { url: target },
      ),
    };
  } finally {
    timer.cancel();
  }

  if (!response || response.ok === false) {
    const status = response?.status ?? 0;
    return {
      error: issue('http', `The diagram at ${target} returned ${status || 'no response'}.`, {
        url: target,
        status,
      }),
    };
  }

  // Cheapest refusal available: the declared length, before a byte of body.
  const declared = toPositiveInt(headerOf(response, 'content-length'), 0);
  if (declared > maxBytes) {
    return { error: tooLarge(`The diagram at ${target}`, declared, maxBytes, { url: target }) };
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    return {
      error: issue('network', `The diagram at ${target} could not be read: ${messageOf(err)}`, {
        url: target,
      }),
    };
  }

  const bytes = byteLength(text, deps);
  if (bytes > maxBytes) {
    return { error: tooLarge(`The diagram at ${target}`, bytes, maxBytes, { url: target }) };
  }
  return { text, bytes };
}

/**
 * One message shape for both oversized cases, a fetched file and a renderer's
 * output, so the panel can treat them alike.
 */
function tooLarge(subject, bytes, maxBytes, extra = {}) {
  return issue('too-large', `${subject} is ${bytes} bytes, over the ${maxBytes} byte limit.`, {
    bytes,
    maxBytes,
    ...extra,
  });
}

// --- rendering diagram source ----------------------------------------------

let renderCounter = 0;

/**
 * Render diagram source with a renderer module the operator named.
 *
 * The expected shape is mermaid's, because that is what people have: a default
 * export (or the namespace itself) offering `initialize(options)` when present
 * and `render(id, source) -> {svg}`. The docs state that shape so another
 * renderer can match it.
 *
 * Nothing throws out of here: an unreachable URL, a forbidden origin, a module
 * with no `render` and a renderer that rejects the source are all `{error}`,
 * because the panel's job is to say what to fix and leave the bookmarks alone.
 * The panel's fallback to a committed `diagram.src` needs two of those told
 * apart, so the distinction is explicit rather than inferred from the message:
 *
 *   error.fallbackable true   the module never loaded (unreachable origin,
 *                             blocked by script-src, 404); the committed SVG
 *                             is the right thing to show instead
 *   error.fallbackable false  the renderer loaded and then refused the source
 *                             or returned nothing: the author's own mistake,
 *                             which an older picture would hide
 *
 * @param {string} source
 * @param {{url: string, options?: object|null}} renderer
 * @param {object} [options]  maxBytes, deps {import, TextEncoder}
 * @returns {Promise<{text?: string, bytes?: number, error?: object}>}
 */
export async function renderSource(source, renderer, options = {}) {
  const deps = options.deps ?? {};
  const text = typeof source === 'string' ? source.trim() : '';
  const url = typeof renderer?.url === 'string' ? renderer.url.trim() : '';
  const maxBytes = toPositiveInt(options.maxBytes, DIAGRAM_DEFAULT_MAX_BYTES);
  if (text === '') return { error: issue('config', 'The diagram source is empty.') };
  if (url === '') return { error: issue('config', 'No renderer URL is configured.') };

  const origin = originOf(url);
  const importModule = deps.import ?? ((specifier) => import(specifier));

  let mod;
  try {
    mod = await importModule(url);
  } catch (err) {
    // Unreachable host, blocked by script-src, 404, syntax error in the
    // module: the browser reports all of these as one failed import and does
    // not say which. So the message names the origin and the policy, the pair
    // an operator has to act on either way.
    return {
      error: issue(
        'renderer-unreachable',
        `The diagram needs ${origin || url}: the renderer could not be loaded. ` +
          `Check that the origin is reachable and allowed by script-src. (${messageOf(err)})`,
        { url, origin, fallbackable: true },
      ),
    };
  }

  const api = pickRendererApi(mod);
  if (!api) {
    return {
      error: issue('renderer-shape', `The module at ${url} has no render(id, source) function.`, {
        url,
        origin,
        fallbackable: false,
      }),
    };
  }

  if (typeof api.initialize === 'function') {
    // Always, even with no options: mermaid expects to be initialised, and a
    // call that happens only sometimes is the kind of thing two modules drift
    // on. config.js surfaces `options: null` when the operator supplied none.
    try {
      api.initialize(renderer?.options || {});
    } catch (err) {
      return {
        error: issue(
          'renderer-failed',
          `The renderer loaded but rejected its options: ${messageOf(err)}`,
          { url, origin, fallbackable: false },
        ),
      };
    }
  }

  renderCounter += 1;
  const id = `qp-diagram-${renderCounter}`;
  let result;
  try {
    result = await api.render(id, text);
  } catch (err) {
    // Almost always a syntax error in the operator's own source, so the
    // renderer's message is the useful part and is passed through verbatim.
    return {
      error: issue(
        'renderer-failed',
        `The renderer loaded but could not draw this source: ${messageOf(err)}`,
        { url, origin, fallbackable: false },
      ),
    };
  }

  const svg = typeof result === 'string' ? result : result?.svg;
  if (typeof svg !== 'string' || svg.trim() === '') {
    return {
      error: issue('renderer-shape', 'The renderer loaded but returned no SVG.', {
        url,
        origin,
        fallbackable: false,
      }),
    };
  }

  // The same ceiling as a fetched file, before the sanitiser sees the text:
  // three lines of source can render into megabytes of SVG, and an unbounded
  // renderer would be a hole straight through the size limit.
  const bytes = byteLength(svg, deps);
  if (bytes > maxBytes) {
    return {
      error: tooLarge('The rendered diagram', bytes, maxBytes, {
        url,
        origin,
        fallbackable: false,
      }),
    };
  }

  // The caller now puts this through exactly the same sanitiser as a file from
  // the ConfigMap. The renderer is third-party code the project did not ship,
  // so its output is not more trusted than a supplied file; it is less.
  return { text: svg, bytes };
}

function pickRendererApi(mod) {
  for (const candidate of [mod?.default, mod]) {
    if (candidate && typeof candidate.render === 'function') return candidate;
  }
  return null;
}

// --- sanitising -------------------------------------------------------------

/**
 * Parse an SVG and rebuild it against the allowlist.
 *
 * @param {string} text
 * @param {object} [options]  scopeId (the id of the container the CSS is scoped
 *                            to), deps {DOMParser, document}
 * @returns {{el?: object, css: string, inlineStyles: Array, dropped: object, error?: object}}
 *   el            the rebuilt <svg>, owned by `deps.document`, never appended
 *   css           the extracted <style> text, filtered and scoped to scopeId
 *   cssExport     the same declarations unscoped, for serializeSvg/toPng
 *   inlineStyles  [{el, declarations: [[prop, value], ...]}] for every element
 *                 that carried a `style` attribute. Already applied to `el`
 *                 through the CSSOM; returned too so the panel can re-apply
 *                 them after a clone, and so a test can see them with no DOM
 *   dropped       {elements, attributes, declarations, rules, total}
 */
export function sanitizeSvg(text, options = {}) {
  const deps = options.deps ?? {};
  const empty = { css: '', inlineStyles: [], dropped: zeroDropped() };
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') {
    return { ...empty, error: issue('parse', 'The diagram file is empty.') };
  }

  const Parser = deps.DOMParser ?? globalThis.DOMParser;
  if (typeof Parser !== 'function') {
    return { ...empty, error: issue('unsupported', 'This browser cannot parse the diagram.') };
  }

  let doc;
  try {
    doc = new Parser().parseFromString(source, 'image/svg+xml');
  } catch (err) {
    return { ...empty, error: issue('parse', `The diagram is not valid SVG: ${messageOf(err)}`) };
  }

  const root = doc?.documentElement ?? null;
  if (!root) {
    return { ...empty, error: issue('parse', 'The diagram is not valid SVG: nothing was parsed.') };
  }
  // DOMParser reports a malformed document with a <parsererror> root rather
  // than a throw, and the engines disagree about where it puts it. So the
  // check is positive: the root must be <svg>, which rejects <parsererror>,
  // <html> and a stray fragment in one condition.
  if (localNameOf(root) !== 'svg') {
    const detail = parseErrorText(root) || `the root element is <${nodeNameOf(root)}>, not <svg>`;
    return { ...empty, error: issue('parse', `The diagram is not valid SVG: ${detail}.`) };
  }

  const targetDoc = deps.document ?? doc;
  const ctx = {
    doc: targetDoc,
    scopeId: typeof options.scopeId === 'string' ? options.scopeId : '',
    css: [],
    inlineStyles: [],
    dropped: zeroDropped(),
  };

  const el = rebuild(root, ctx);
  if (!el) {
    return {
      ...empty,
      dropped: ctx.dropped,
      error: issue('parse', 'The diagram contained nothing that could be displayed.'),
    };
  }

  const raw = ctx.css.join('\n');
  const css = scopeCss(raw, ctx.scopeId, ctx.dropped);
  return {
    el,
    css,
    // The same declarations without the container prefix, for an exported file
    // where that container does not exist. Computed here so a caller never has
    // to keep the raw stylesheet around, or try to unpick the scoped one.
    cssExport: filterCssForExport(raw),
    inlineStyles: ctx.inlineStyles,
    dropped: total(ctx.dropped),
  };
}

/**
 * Copy one element, or refuse to.
 *
 * @returns {object|null} the new element, or null when the source was dropped
 */
function rebuild(srcEl, ctx) {
  const name = localNameOf(srcEl);
  const ns = srcEl.namespaceURI ?? null;

  // A foreign namespace at this point means markup smuggled in through a
  // container we do not copy, or an element whose prefix resolves somewhere
  // unexpected. Either way it is not SVG. A null namespace is treated as SVG:
  // an operator who forgot the xmlns gets a working diagram, not a silent one.
  if (ns !== null && ns !== SVG_NS) {
    ctx.dropped.elements += countElements(srcEl);
    return null;
  }

  // <style> is extracted, not dropped: the rules are what a renderer's output
  // depends on, and losing them does not degrade the diagram, it destroys it.
  if (name === 'style') {
    ctx.css.push(textOf(srcEl));
    return null;
  }

  if (!ALLOWED_ELEMENTS.has(name)) {
    ctx.dropped.elements += countElements(srcEl);
    return null;
  }

  const el = ctx.doc.createElementNS(SVG_NS, name);
  copyAttributes(srcEl, el, ctx);

  for (const child of childNodesOf(srcEl)) {
    const type = child?.nodeType;
    if (type === 1) {
      const built = rebuild(child, ctx);
      if (built) el.appendChild(built);
    } else if (type === 3 || type === 4) {
      // Text and CDATA. Appended as a text node, which cannot become markup.
      const data = child.data ?? child.nodeValue ?? '';
      if (data !== '') el.appendChild(ctx.doc.createTextNode(data));
    }
    // Comments and processing instructions are not copied. They render nothing,
    // and they are not counted as drops because nothing visible was lost.
  }
  return el;
}

function copyAttributes(srcEl, el, ctx) {
  for (const attr of attributesOf(srcEl)) {
    const name = attr?.name ?? '';
    if (name === '') continue;

    // xmlns declarations: silently not copied. createElementNS has already put
    // the tree in the right namespace, and the serializer re-emits what it
    // needs, so there is nothing to lose and nothing to report.
    if (name === 'xmlns' || name.startsWith('xmlns:') || attr.namespaceURI === XMLNS_NS) continue;

    const lower = name.toLowerCase();
    const value = String(attr.value ?? '');

    // Every on* attribute, first and unconditionally, so no later rule can
    // accidentally be the thing standing between a handler and the document.
    if (lower.startsWith('on')) {
      ctx.dropped.attributes += 1;
      continue;
    }

    if (name.includes(':')) {
      const ns = KNOWN_PREFIXED.get(name);
      if (!ns) {
        ctx.dropped.attributes += 1;
        continue;
      }
      if (ATTR_URLISH.has(name) && !isFragment(value)) {
        ctx.dropped.attributes += 1;
        continue;
      }
      if (!isSafeValue(value)) {
        ctx.dropped.attributes += 1;
        continue;
      }
      el.setAttributeNS(ns, name, value);
      continue;
    }

    if (lower === 'style') {
      collectInlineStyle(value, el, ctx);
      continue;
    }

    if (!ALLOWED_ATTRIBUTES.has(name)) {
      ctx.dropped.attributes += 1;
      continue;
    }

    // A reference-bearing attribute survives only as `#id`. An empty value is
    // allowed through as empty: dropping it changes nothing and reporting it
    // would be noise.
    if (ATTR_URLISH.has(lower)) {
      if (value.trim() !== '' && !isFragment(value)) {
        ctx.dropped.attributes += 1;
        continue;
      }
    }

    if (!isSafeValue(value)) {
      ctx.dropped.attributes += 1;
      continue;
    }

    el.setAttribute(name, value);
  }
}

/**
 * Read a `style` attribute, filter it, and apply it through the CSSOM.
 *
 * The attribute itself is never set on the rebuilt element: an inline style
 * attribute is exactly what style-src 'self' forbids, and the whole point of
 * this module is that the policy does not have to be widened for a picture.
 */
function collectInlineStyle(value, el, ctx) {
  const declarations = filterDeclarations(value, ctx.dropped);
  if (declarations.length === 0) return;
  for (const [prop, val] of declarations) {
    try {
      el.style?.setProperty?.(prop, val);
    } catch {
      // A property the engine does not know, or a stand-in element without a
      // style object. The declaration is still returned, so the panel can try.
    }
  }
  ctx.inlineStyles.push({ el, declarations });
}

// --- CSS: filter and scope --------------------------------------------------

/**
 * Filter a stylesheet and scope every rule to `#scopeId`.
 *
 * String manipulation of CSS is easy to get wrong, so the rule here is: when a
 * construct cannot be scoped with confidence, the rule is dropped and counted,
 * never emitted unscoped. A missing rule is a diagram that looks slightly off
 * and says so; an unscoped rule is a stylesheet rewriting the rest of the page.
 *
 * Handled: comments, CDO/CDC, strings, several selectors per rule, nested
 * @media/@supports/@layer. Dropped: @import and @charset (no body to scope),
 * @font-face and @keyframes (not scopable by prefixing, and @font-face is a
 * fetch), any other at-rule, and any selector that reaches outside the
 * container (:root, :host, a bare html or body type selector).
 */
export function scopeCss(css, scopeId, dropped = zeroDropped()) {
  const text = typeof css === 'string' ? css : '';
  if (text.trim() === '') return '';

  if (!SCOPE_ID.test(String(scopeId ?? ''))) {
    // Without a container id there is nothing to scope to, and emitting the
    // sheet anyway would let a renderer's `.node rect` rule repaint the
    // bookmark tree. Everything goes, and the count tells the operator.
    for (const node of splitNodes(stripCssNoise(text))) {
      if (node.body !== null) dropped.rules += 1;
    }
    return '';
  }

  return emitNodes(splitNodes(stripCssNoise(text)), `#${scopeId}`, dropped).join('\n');
}

/**
 * The same filtered stylesheet with no scope prefix, for an exported file.
 *
 * An export is a standalone document: the panel's container id does not exist
 * in it, so the scoped sheet would match nothing and the diagram would come out
 * unstyled. Scoping exists to stop a renderer's `.node rect` rule repainting
 * the bookmark tree, and in a file there is no bookmark tree to protect.
 *
 * Declarations and at-rules are filtered exactly as for the page, so this is
 * not a laxer path: it is the same rules without a prefix. Nothing calls it to
 * put CSS back into this document.
 */
export function filterCssForExport(css) {
  const text = typeof css === 'string' ? css : '';
  if (text.trim() === '') return '';
  return emitNodes(splitNodes(stripCssNoise(text)), '', zeroDropped()).join('\n');
}

function emitNodes(nodes, prefix, dropped) {
  const out = [];
  for (const node of nodes) {
    const prelude = node.prelude.trim();
    if (prelude.startsWith('@')) {
      const at = prelude.slice(1).split(/[\s({]/, 1)[0].toLowerCase();
      if (node.body === null || !NESTABLE_AT_RULES.has(at)) {
        // @import, @charset, @namespace: no body, and nothing good inside.
        // @font-face, @keyframes, @property: a body that prefixing cannot
        // scope. Both are drops, because the alternative is letting them out.
        dropped.rules += 1;
        continue;
      }
      const inner = emitNodes(splitNodes(node.body), prefix, dropped);
      if (inner.length) out.push(`${prelude} {\n${inner.join('\n')}\n}`);
      continue;
    }

    if (node.body === null) {
      // A stray declaration or garbage at the top level of a stylesheet.
      dropped.rules += 1;
      continue;
    }

    const selectors = [];
    let unsafe = false;
    for (const raw of splitSelectors(prelude)) {
      const scoped = scopeSelector(raw, prefix);
      if (scoped) selectors.push(scoped);
      else unsafe = true;
    }
    if (unsafe) dropped.rules += 1;
    if (selectors.length === 0) continue;

    const declarations = filterDeclarations(node.body, dropped);
    if (declarations.length === 0) continue;
    const body = declarations.map(([prop, value]) => `  ${prop}: ${value};`).join('\n');
    out.push(`${selectors.join(',\n')} {\n${body}\n}`);
  }
  return out;
}

const NESTABLE_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'scope']);

/** Selectors that would escape the container, however they are prefixed. */
const ESCAPING_SELECTOR = /:root\b|:host\b|::?(?:backdrop|view-transition)|(?:^|[\s,>+~(])(?:html|body)\b/i;

/**
 * Prefix one selector, or refuse it.
 *
 * @returns {string|null} the scoped selector, or null when it is not safe
 */
export function scopeSelector(selector, prefix) {
  const s = String(selector ?? '').trim();
  if (s === '') return null;
  // A brace, semicolon, at-sign or comment opener here means the split above
  // misread something; refusing is cheaper than guessing what.
  if (/[{};@]|\/\*/.test(s)) return null;
  if (!balanced(s)) return null;
  if (ESCAPING_SELECTOR.test(s)) return null;
  if (UNSAFE_VALUE.test(s)) return null;
  // Descendant combinator only. The container is a div the panel owns, so no
  // rule from a renderer's sheet is ever meant to match it directly.
  return `${prefix} ${s}`;
}

/**
 * Split a declaration block into surviving [property, value] pairs.
 *
 * Shared by the stylesheet and by `style` attributes on purpose: the spec asks
 * for both to be filtered the same way, and two filters would drift.
 */
export function filterDeclarations(block, dropped = zeroDropped()) {
  const out = [];
  for (const chunk of splitTop(String(block ?? ''), ';')) {
    const decl = chunk.trim();
    if (decl === '') continue;
    const colon = decl.indexOf(':');
    if (colon <= 0) {
      dropped.declarations += 1;
      continue;
    }
    const prop = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (
      !/^(?:--)?-?[A-Za-z][A-Za-z0-9-]*$/.test(prop) ||
      BANNED_PROPERTIES.has(prop.toLowerCase()) ||
      value === '' ||
      !isSafeValue(value)
    ) {
      dropped.declarations += 1;
      continue;
    }
    out.push([prop, value]);
  }
  return out;
}

/** Remove comments and CDO/CDC markers without touching string contents. */
function stripCssNoise(css) {
  let out = '';
  let quote = null;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += css[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      out += ' ';
      continue;
    }
    if (css.startsWith('<!--', i)) {
      i += 3;
      continue;
    }
    if (css.startsWith('-->', i)) {
      i += 2;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Split a stylesheet into {prelude, body} nodes at the top level.
 *
 * `body` is null for an at-rule that ends in a semicolon, which is how @import
 * is recognised and refused.
 */
function splitNodes(css) {
  const nodes = [];
  let prelude = '';
  let depth = 0;
  let body = '';
  let quote = null;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      if (depth > 0) body += c;
      else prelude += c;
      if (c === '\\') {
        const next = css[i + 1] ?? '';
        if (depth > 0) body += next;
        else prelude += next;
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (depth > 0) body += c;
      else prelude += c;
      continue;
    }
    if (c === '{') {
      depth += 1;
      if (depth > 1) body += c;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth > 0) {
        body += c;
        continue;
      }
      if (depth < 0) {
        // An unbalanced closing brace: the remainder cannot be trusted to mean
        // what it looks like, so parsing stops here.
        return nodes;
      }
      nodes.push({ prelude, body });
      prelude = '';
      body = '';
      continue;
    }
    if (c === ';' && depth === 0) {
      if (prelude.trim() !== '') nodes.push({ prelude, body: null });
      prelude = '';
      continue;
    }
    if (depth > 0) body += c;
    else prelude += c;
  }
  // Trailing text with an unclosed brace: a node whose body never ended.
  if (depth > 0 || prelude.trim() !== '') {
    nodes.push({ prelude, body: null });
  }
  return nodes;
}

/** Split on a separator at nesting depth zero, outside strings. */
function splitTop(text, separator) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (c === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/** `a, b:is(c, d)` is two selectors, not three. */
function splitSelectors(prelude) {
  return splitTop(prelude, ',');
}

function balanced(s) {
  let round = 0;
  let square = 0;
  for (const c of s) {
    if (c === '(') round += 1;
    else if (c === ')') round -= 1;
    else if (c === '[') square += 1;
    else if (c === ']') square -= 1;
    if (round < 0 || square < 0) return false;
  }
  return round === 0 && square === 0;
}

// --- values -----------------------------------------------------------------

function isFragment(value) {
  const v = String(value ?? '').trim();
  return FRAGMENT.test(v);
}

/**
 * Whether a value may be copied.
 *
 * Two independent reasons to refuse: a scheme or CSS construct that executes or
 * fetches (UNSAFE_VALUE), and a `url()` pointing anywhere but at a fragment in
 * this document. The second is what keeps `fill="url(#grad)"` working while
 * refusing `fill="url(https://example.org/x#grad)"`, and it is also what keeps
 * the PNG export possible: see toPng.
 */
export function isSafeValue(value) {
  const v = String(value ?? '');
  if (UNSAFE_VALUE.test(v)) return false;
  if (!/url\(/i.test(v)) return true;

  const pattern = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let seen = 0;
  let match;
  while ((match = pattern.exec(v)) !== null) {
    seen += 1;
    if (!isFragment(match[2])) return false;
  }
  // `url(` appeared but no complete url() was matched: malformed, and a
  // malformed value is not a value we can reason about.
  return seen > 0;
}

// --- applying the extracted CSS --------------------------------------------

/**
 * Adopt the scoped CSS as a constructed stylesheet.
 *
 * A constructed stylesheet lives in the CSSOM, which style-src does not govern,
 * so the diagram keeps the appearance its renderer intended while the page
 * keeps `style-src 'self'`. A <style> element with the same text would need
 * 'unsafe-inline' for the whole document, which is far too much to pay for a
 * picture, and a static nginx cannot mint a per-request nonce.
 *
 * Where constructed stylesheets are unavailable the diagram renders unstyled.
 * That is deliberate: injecting a <style> element as a fallback would quietly
 * require the policy this function exists to avoid.
 *
 * @returns {function} stop(), idempotent
 */
export function applyScopedCss(css, options = {}) {
  const deps = options.deps ?? {};
  const doc = deps.document ?? (typeof document === 'undefined' ? null : document);
  const text = typeof css === 'string' ? css.trim() : '';
  const noop = () => {};
  if (!doc || text === '') return noop;

  const Sheet =
    deps.CSSStyleSheet ?? (typeof CSSStyleSheet === 'undefined' ? null : CSSStyleSheet);
  if (typeof Sheet !== 'function' || !Array.isArray(doc.adoptedStyleSheets)) return noop;

  let sheet;
  try {
    sheet = new Sheet();
    sheet.replaceSync(text);
  } catch {
    return noop;
  }

  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
  };
}

// --- export -----------------------------------------------------------------

/**
 * Serialise the sanitised tree.
 *
 * What is written out is the rebuilt tree, not the file that arrived, so an
 * exported SVG carries only what passed the allowlist.
 *
 * @param {object} el
 * @param {object} [options]  deps {XMLSerializer}
 * @returns {string}
 */
export function serializeSvg(el, options = {}) {
  if (!el) return '';
  const deps = options.deps ?? {};
  const Serializer =
    deps.XMLSerializer ??
    el.ownerDocument?.defaultView?.XMLSerializer ??
    (typeof XMLSerializer === 'undefined' ? null : XMLSerializer);
  if (typeof Serializer !== 'function') return '';

  let text = new Serializer().serializeToString(el);
  // Some serializers omit the default namespace for a detached element, which
  // makes the downloaded file open as plain XML in a viewer.
  if (!text.includes('xmlns=')) {
    text = text.replace(/^<svg\b/, `<svg xmlns="${SVG_NS}"`);
  }

  // The renderer's stylesheet lives in an adopted stylesheet, not in the tree,
  // so without this an exported mermaid diagram is a pile of unstyled shapes:
  // every fill, stroke and font it depends on is in that CSS. The declarations
  // were already filtered by the sanitiser, and `css` is expected to be the
  // UNSCOPED form, since the panel's container id does not exist in the file.
  //
  // Putting a <style> in an exported file is not the thing the allowlist
  // forbids: that rule is about what this page parses and inlines. This text is
  // never parsed here, it is handed to the user. The file will not round-trip
  // through our own importer, which drops style elements, and that is the right
  // trade for an export meant for a document or a slide.
  const css = typeof options.css === 'string' ? options.css.trim() : '';
  if (css !== '') {
    const style = `<style type="text/css">\n${css}\n</style>`;
    text = text.replace(/^(<svg\b[^>]*>)/, `$1${style}`);
  }
  return text;
}

/**
 * Draw the diagram to a canvas and resolve a PNG blob.
 *
 * Why this works at all: drawing an SVG image to a canvas and then reading the
 * canvas back is only permitted while the SVG has no external references.
 * Anything fetched from another origin, through <image href>, a CSS url(), an
 * @import or a remote <use>, taints the canvas, and toBlob on a tainted canvas
 * throws a SecurityError. The sanitiser has already removed every one of those,
 * so there is nothing left to taint it. The security boundary is what makes the
 * feature possible, not a tax on it.
 *
 * Fonts are the honest exception. The rasterised text uses whatever font the
 * browser resolved at draw time, so a diagram that depends on a webfont exports
 * with a substitute. Documented rather than hidden.
 *
 * @param {object} el     the sanitised <svg>
 * @param {object} [options]  scale, deps {document, Blob, Image, URL,
 *                            XMLSerializer, setTimeout, clearTimeout}
 * @returns {Promise<Blob>}
 */
export function toPng(el, options = {}) {
  const deps = options.deps ?? {};
  const doc = deps.document ?? (typeof document === 'undefined' ? null : document);
  const BlobCtor = deps.Blob ?? (typeof Blob === 'undefined' ? null : Blob);
  const urls = deps.URL ?? (typeof URL === 'undefined' ? null : URL);
  const scale = toScale(options.scale);

  return new Promise((resolve, reject) => {
    if (!el || !doc || typeof BlobCtor !== 'function') {
      reject(new Error('PNG export is not available in this browser.'));
      return;
    }

    const text = serializeSvg(el, { deps, css: options.css });
    if (text === '') {
      reject(new Error('The diagram could not be serialised.'));
      return;
    }

    const size = sizeOf(el);
    // A data: URL, not a blob: URL. The policy this project ships is
    // `img-src 'self' https: data:`, which does not include blob:, so an <img>
    // pointed at an object URL never decodes and the export fails with nothing
    // to show for it. This was found by exporting under the real policy rather
    // than by reading the code, and widening img-src to blob: would have been
    // the wrong fix: it changes every deployment's policy to serve one feature
    // that does not need it.
    const sourceUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    const img = deps.Image ? new deps.Image() : doc.createElement('img');
    let settled = false;

    const timer = startTimeout(options.timeoutMs ?? DIAGRAM_DECODE_TIMEOUT_MS, deps, () => {
      finish(() => reject(new Error('The diagram took too long to rasterise.')));
    });

    function finish(action) {
      if (settled) return;
      settled = true;
      timer.cancel();
      try {
      } catch {
        // Nothing to do if the URL was never registered.
      }
      action();
    }

    img.onload = () => {
      try {
        const canvas = doc.createElement('canvas');
        canvas.width = Math.max(1, Math.round(size.width * scale));
        canvas.height = Math.max(1, Math.round(size.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((out) => {
          finish(() =>
            out ? resolve(out) : reject(new Error('The canvas produced no PNG data.')),
          );
        }, 'image/png');
      } catch (err) {
        finish(() => reject(new Error(`The diagram could not be rasterised: ${messageOf(err)}`)));
      }
    };

    img.onerror = () => {
      finish(() => reject(new Error('The diagram could not be decoded as an image.')));
    };

    img.src = sourceUrl;
  });
}

/** The drawing size: viewBox first, then width/height, then a documented default. */
function sizeOf(el) {
  const viewBox = el.getAttribute?.('viewBox');
  if (typeof viewBox === 'string') {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = toLength(el.getAttribute?.('width'));
  const height = toLength(el.getAttribute?.('height'));
  if (width && height) return { width, height };
  return { ...PNG_FALLBACK_SIZE };
}

function toLength(value) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PNG_DEFAULT_SCALE;
  return Math.min(n, 8);
}

// --- small shared helpers ---------------------------------------------------

function zeroDropped() {
  return { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
}

function total(dropped) {
  dropped.total =
    dropped.elements + dropped.attributes + dropped.declarations + dropped.rules;
  return dropped;
}

function issue(kind, message, extra = {}) {
  return { kind, message, ...extra };
}

function messageOf(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return String(err.message ?? err);
}

function originOf(url) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(String(url ?? '').trim());
  return match ? match[1] : '';
}

function headerOf(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function byteLength(text, deps) {
  const Encoder = deps.TextEncoder ?? globalThis.TextEncoder;
  if (typeof Encoder === 'function') return new Encoder().encode(text).length;
  // No TextEncoder anywhere: the character count is a lower bound, which still
  // refuses the cases the limit exists for.
  return text.length;
}

function toPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * One timeout, cancellable, with an AbortController when there is one.
 *
 * `fired` lets the caller tell a timeout apart from a genuine network failure,
 * since both arrive as a rejected fetch.
 */
function startTimeout(ms, deps, onFire) {
  const delay = toPositiveInt(ms, 0);
  const start = deps.setTimeout ?? globalThis.setTimeout;
  const stop = deps.clearTimeout ?? globalThis.clearTimeout;
  const Controller =
    deps.AbortController ?? (typeof AbortController === 'undefined' ? null : AbortController);
  const controller = typeof Controller === 'function' ? new Controller() : null;
  const state = { fired: false, signal: controller?.signal, cancel: () => {} };
  if (!delay || typeof start !== 'function') return state;

  const handle = start(() => {
    state.fired = true;
    try {
      controller?.abort();
    } catch {
      // An abort that cannot be delivered still leaves `fired` set.
    }
    onFire?.();
  }, delay);

  state.cancel = () => {
    if (typeof stop === 'function') stop(handle);
  };
  return state;
}

function localNameOf(node) {
  const name = node?.localName ?? node?.nodeName ?? '';
  // localName is already case-correct for XML; nodeName on an HTML fallback is
  // not, and the allowlist holds camelCase names such as linearGradient.
  return String(name).includes(':') ? String(name).split(':').pop() : String(name);
}

function nodeNameOf(node) {
  return String(node?.nodeName ?? node?.localName ?? 'unknown');
}

function childNodesOf(node) {
  const kids = node?.childNodes;
  if (!kids) return [];
  return Array.isArray(kids) ? kids : Array.from(kids);
}

function attributesOf(node) {
  const attrs = node?.attributes;
  if (!attrs) return [];
  return Array.isArray(attrs) ? attrs : Array.from(attrs);
}

function textOf(node) {
  if (typeof node?.textContent === 'string') return node.textContent;
  return childNodesOf(node)
    .map((child) => child?.data ?? child?.nodeValue ?? '')
    .join('');
}

function countElements(node) {
  let n = 1;
  for (const child of childNodesOf(node)) {
    if (child?.nodeType === 1) n += countElements(child);
  }
  return n;
}

function parseErrorText(root) {
  if (localNameOf(root).toLowerCase() === 'parsererror') return textOf(root).trim().slice(0, 200);
  for (const child of childNodesOf(root)) {
    if (child?.nodeType === 1 && localNameOf(child).toLowerCase() === 'parsererror') {
      return textOf(child).trim().slice(0, 200);
    }
  }
  return '';
}
