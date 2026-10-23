import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_ELEMENTS,
  DIAGRAM_DEFAULT_MAX_BYTES,
  PNG_DEFAULT_SCALE,
  applyScopedCss,
  fetchDiagram,
  filterDeclarations,
  isSafeValue,
  renderSource,
  sanitizeSvg,
  scopeCss,
  scopeSelector,
  serializeSvg,
  toPng,
} from '../src/assets/diagram.js';

// --- a DOM small enough to audit -------------------------------------------
//
// There is no node_modules in this repository and there must not be one, so
// the sanitiser is tested against a hand-written XML parser and DOM rather than
// jsdom or a browser. That is not only a packaging constraint: the fake is
// about two hundred lines and can be read in full, which means an assertion
// about what the sanitiser dropped cannot be quietly satisfied by a helpful
// host object somewhere.
//
// It implements exactly the surface diagram.js uses: nodeType, localName,
// nodeName, namespaceURI, attributes, childNodes, textContent,
// createElementNS, createTextNode, setAttribute(NS), appendChild,
// getAttribute, style.setProperty, and an XMLSerializer.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

function makeDocument() {
  const doc = {
    nodeType: 9,
    documentElement: null,
    adoptedStyleSheets: [],
    createElementNS(ns, name) {
      return makeElement(ns, name, doc);
    },
    createTextNode(data) {
      return { nodeType: 3, data, nodeValue: data, textContent: data, childNodes: [] };
    },
    createElement(name) {
      return makeElement(null, name, doc);
    },
  };
  return doc;
}

function makeElement(ns, qualifiedName, ownerDocument) {
  const parts = String(qualifiedName).split(':');
  const prefix = parts.length > 1 ? parts[0] : null;
  const localName = parts.length > 1 ? parts[1] : parts[0];
  const declarations = new Map();
  const el = {
    nodeType: 1,
    namespaceURI: ns,
    prefix,
    localName,
    nodeName: qualifiedName,
    tagName: qualifiedName,
    ownerDocument,
    attributes: [],
    childNodes: [],
    style: {
      setProperty(prop, value) {
        declarations.set(prop, value);
      },
      removeProperty(prop) {
        declarations.delete(prop);
      },
      getPropertyValue(prop) {
        return declarations.get(prop) ?? '';
      },
      get size() {
        return declarations.size;
      },
      entries() {
        return [...declarations.entries()];
      },
    },
    setAttribute(name, value) {
      const existing = el.attributes.find((a) => a.name === name);
      if (existing) existing.value = String(value);
      else
        el.attributes.push({
          name,
          localName: name.includes(':') ? name.split(':')[1] : name,
          prefix: name.includes(':') ? name.split(':')[0] : null,
          namespaceURI: null,
          value: String(value),
        });
    },
    setAttributeNS(attrNs, name, value) {
      el.attributes.push({
        name,
        localName: name.includes(':') ? name.split(':')[1] : name,
        prefix: name.includes(':') ? name.split(':')[0] : null,
        namespaceURI: attrNs,
        value: String(value),
      });
    },
    getAttribute(name) {
      return el.attributes.find((a) => a.name === name)?.value ?? null;
    },
    hasAttribute(name) {
      return el.attributes.some((a) => a.name === name);
    },
    appendChild(child) {
      el.childNodes.push(child);
      return child;
    },
    get textContent() {
      return el.childNodes
        .map((c) => (c.nodeType === 1 ? c.textContent : (c.data ?? '')))
        .join('');
    },
  };
  return el;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** An XML parser that throws on anything it cannot account for. */
function parseXmlStrict(source) {
  const doc = makeDocument();
  const stack = [];
  const nsStack = [new Map([['xml', XML_NS], ['xmlns', XMLNS_NS]])];
  let i = 0;
  let root = null;

  const current = () => stack[stack.length - 1] ?? null;

  while (i < source.length) {
    if (source[i] !== '<') {
      const next = source.indexOf('<', i);
      const end = next === -1 ? source.length : next;
      const raw = source.slice(i, end);
      i = end;
      if (current()) {
        if (raw !== '') current().appendChild(doc.createTextNode(decodeEntities(raw)));
      } else if (raw.trim() !== '') {
        throw new Error('text outside the root element');
      }
      continue;
    }

    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i);
      if (end === -1) throw new Error('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      if (end === -1) throw new Error('unterminated comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      if (end === -1) throw new Error('unterminated CDATA');
      const data = source.slice(i + 9, end);
      if (!current()) throw new Error('CDATA outside the root element');
      current().appendChild(doc.createTextNode(data));
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', i)) {
      const end = source.indexOf('>', i);
      if (end === -1) throw new Error('unterminated declaration');
      i = end + 1;
      continue;
    }

    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (end === -1) throw new Error('unterminated end tag');
      const name = source.slice(i + 2, end).trim();
      const open = current();
      if (!open || open.nodeName !== name) {
        throw new Error(`mismatched end tag </${name}>`);
      }
      stack.pop();
      nsStack.pop();
      i = end + 1;
      continue;
    }

    const end = findTagEnd(source, i);
    if (end === -1) throw new Error('unterminated start tag');
    const body = source.slice(i + 1, end);
    i = end + 1;
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (!nameMatch) throw new Error('start tag with no name');
    const name = nameMatch[1];
    const attrs = parseAttrs(inner.slice(name.length));

    const scope = new Map(nsStack[nsStack.length - 1]);
    for (const attr of attrs) {
      if (attr.name === 'xmlns') scope.set('', attr.value);
      else if (attr.name.startsWith('xmlns:')) scope.set(attr.name.slice(6), attr.value);
    }

    const prefix = name.includes(':') ? name.split(':')[0] : null;
    const ns = prefix ? (scope.get(prefix) ?? null) : (scope.get('') ?? null);
    const el = makeElement(ns, name, doc);
    for (const attr of attrs) {
      const attrPrefix = attr.name.includes(':') ? attr.name.split(':')[0] : null;
      el.attributes.push({
        name: attr.name,
        localName: attrPrefix ? attr.name.slice(attrPrefix.length + 1) : attr.name,
        prefix: attrPrefix,
        namespaceURI:
          attr.name === 'xmlns' || attrPrefix === 'xmlns'
            ? XMLNS_NS
            : attrPrefix
              ? (scope.get(attrPrefix) ?? null)
              : null,
        value: decodeEntities(attr.value),
      });
    }

    if (current()) current().appendChild(el);
    else if (root) throw new Error('more than one root element');
    else root = el;

    if (!selfClosing) {
      stack.push(el);
      nsStack.push(scope);
    }
  }

  if (stack.length) throw new Error(`unclosed <${current().nodeName}>`);
  if (!root) throw new Error('no root element');
  doc.documentElement = root;
  return doc;
}

function findTagEnd(source, start) {
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(text) {
  const attrs = [];
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  let consumed = 0;
  while ((match = pattern.exec(text)) !== null) {
    attrs.push({ name: match[1], value: match[2] ?? match[3] ?? '' });
    consumed = pattern.lastIndex;
  }
  if (text.slice(consumed).trim() !== '') throw new Error('malformed attribute');
  return attrs;
}

/** DOMParser's contract: a malformed document is a <parsererror> root, not a throw. */
class FakeDOMParser {
  parseFromString(source, type) {
    assert.equal(type, 'image/svg+xml', 'the parser must be asked for SVG, never HTML');
    try {
      return parseXmlStrict(source);
    } catch (err) {
      const doc = makeDocument();
      const el = makeElement('http://www.w3.org/1999/xhtml', 'parsererror', doc);
      el.appendChild(doc.createTextNode(err.message));
      doc.documentElement = el;
      return doc;
    }
  }
}

function escapeXml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

class FakeXMLSerializer {
  serializeToString(node) {
    if (node.nodeType === 3) return escapeXml(node.data ?? '');
    const attrs = [...node.attributes];
    if (node.localName === 'svg' && !attrs.some((a) => a.name === 'xmlns')) {
      attrs.unshift({ name: 'xmlns', value: SVG_NS });
    }
    const inline = node.style?.entries?.() ?? [];
    if (inline.length) {
      attrs.push({
        name: 'style',
        value: inline.map(([p, v]) => `${p}: ${v}`).join('; '),
      });
    }
    const open = attrs
      .map((a) => ` ${a.name}="${escapeXml(a.value).replace(/"/g, '&quot;')}"`)
      .join('');
    const kids = node.childNodes.map((c) => this.serializeToString(c)).join('');
    if (kids === '') return `<${node.nodeName}${open}/>`;
    return `<${node.nodeName}${open}>${kids}</${node.nodeName}>`;
  }
}

const domDeps = () => ({
  DOMParser: FakeDOMParser,
  XMLSerializer: FakeXMLSerializer,
  document: makeDocument(),
});

// --- walking the result -----------------------------------------------------

function walk(el, visit) {
  visit(el);
  for (const child of el.childNodes ?? []) {
    if (child.nodeType === 1) walk(child, visit);
  }
}

function names(el) {
  const found = [];
  walk(el, (node) => found.push(node.localName));
  return found;
}

function attrNames(el) {
  const found = [];
  walk(el, (node) => {
    for (const attr of node.attributes) found.push(attr.name);
  });
  return found;
}

function sanitize(markup, options = {}) {
  return sanitizeSvg(markup, { scopeId: 'diagram-panel', deps: domDeps(), ...options });
}

function svg(inner, attrs = '') {
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" viewBox="0 0 100 100"${attrs ? ' ' + attrs : ''}>${inner}</svg>`;
}

// --- the shim itself, because the assertions rest on it --------------------

test('the test parser reports malformed XML the way DOMParser does', () => {
  const doc = new FakeDOMParser().parseFromString('<svg><g></svg>', 'image/svg+xml');
  assert.equal(doc.documentElement.localName, 'parsererror');
});

test('the test parser resolves namespaces and keeps element case', () => {
  const doc = new FakeDOMParser().parseFromString(
    svg('<linearGradient id="g"><stop offset="0"/></linearGradient>'),
    'image/svg+xml',
  );
  assert.equal(doc.documentElement.namespaceURI, SVG_NS);
  assert.equal(doc.documentElement.childNodes[0].localName, 'linearGradient');
});

// --- the sanitiser: one adversarial fixture per construct ------------------

test('a script element is gone, with its contents', () => {
  const out = sanitize(svg('<script>globalThis.pwned = 1;</script><rect width="10" height="10"/>'));
  assert.equal(out.error, undefined);
  assert.ok(!names(out.el).includes('script'));
  assert.equal(out.dropped.elements, 1);
  assert.ok(out.dropped.total >= 1);
  assert.ok(names(out.el).includes('rect'), 'the legitimate sibling survives');
});

test('a script smuggled under a foreign namespace prefix is gone', () => {
  const out = sanitize(
    `<svg xmlns="${SVG_NS}" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>x</h:script><rect/></svg>`,
  );
  assert.equal(out.error, undefined);
  assert.ok(!names(out.el).includes('script'));
  assert.equal(out.dropped.elements, 1);
});

test('foreignObject takes its embedded HTML subtree with it', () => {
  const out = sanitize(
    svg(
      `<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://example.org/x.png"/></div></foreignObject>`,
    ),
  );
  assert.equal(out.error, undefined);
  assert.deepEqual(names(out.el), ['svg']);
  assert.equal(out.dropped.elements, 3, 'the container and both descendants are counted');
});

test('a base element is gone, so nothing can rewrite URL resolution', () => {
  const out = sanitize(svg('<base href="https://example.org/"/><circle r="1"/>'));
  assert.ok(!names(out.el).includes('base'));
  assert.equal(out.dropped.elements, 1);
});

test('handler and every animation element are gone', () => {
  const fixtures = [
    '<handler type="text/javascript">x</handler>',
    '<animate attributeName="fill" from="red" to="blue" dur="1s"/>',
    '<animateTransform attributeName="transform" type="rotate" values="0;360"/>',
    '<animateMotion path="M0 0 L10 10"/>',
    '<animateColor attributeName="fill" to="red"/>',
    '<set attributeName="fill" to="red" begin="0s"/>',
    '<discard begin="1s"/>',
  ];
  for (const fixture of fixtures) {
    const out = sanitize(svg(`<rect width="1" height="1">${fixture}</rect>`));
    assert.equal(out.error, undefined, fixture);
    assert.deepEqual(names(out.el), ['svg', 'rect'], fixture);
    assert.equal(out.dropped.elements, 1, fixture);
  }
});

test('an mpath inside a dropped animation is counted and gone', () => {
  const out = sanitize(svg('<animateMotion><mpath xlink:href="#p"/></animateMotion><path d="M0 0"/>'));
  assert.deepEqual(names(out.el), ['svg', 'path']);
  assert.equal(out.dropped.elements, 2);
});

test('every on* attribute is removed, whatever the element', () => {
  const out = sanitize(
    svg(
      '<rect width="1" height="1" onload="globalThis.pwned = 1" onclick="alert(1)" ONMOUSEOVER="alert(2)"/><g onfocusin="x"><circle r="1" onbegin="x"/></g>',
    ),
  );
  assert.equal(out.error, undefined);
  const attrs = attrNames(out.el);
  assert.equal(
    attrs.filter((name) => name.toLowerCase().startsWith('on')).length,
    0,
    `no handler survives, got ${attrs.join(',')}`,
  );
  assert.equal(out.dropped.attributes, 5);
});

test('an external href, xlink:href or src is dropped; a fragment is kept', () => {
  const out = sanitize(
    svg(
      '<use href="https://example.org/evil.svg#x"/>' +
        '<use xlink:href="#good"/>' +
        '<use href="#also-good"/>' +
        '<use xlink:href="//example.com/evil.svg#x"/>' +
        '<use href="/local/evil.svg#x"/>' +
        '<text src="https://example.org/x">t</text>',
    ),
  );
  assert.equal(out.error, undefined);
  const refs = [];
  walk(out.el, (node) => {
    for (const attr of node.attributes) {
      if (attr.localName === 'href' || attr.name === 'src') refs.push(attr.value);
    }
  });
  assert.deepEqual(refs.sort(), ['#also-good', '#good']);
  assert.equal(out.dropped.attributes, 4);
});

test('a javascript: URL is dropped even dressed up', () => {
  for (const value of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'javascript\t:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lw==',
  ]) {
    const out = sanitize(svg(`<a href="${value}"><rect width="1" height="1"/></a>`));
    assert.equal(out.error, undefined, value);
    assert.deepEqual(attrNames(out.el), ['viewBox', 'width', 'height'], value);
    assert.equal(out.dropped.attributes, 1, value);
  }
});

test('a url() to anywhere but a fragment is dropped, including in a presentation attribute', () => {
  const out = sanitize(
    svg(
      '<rect width="1" height="1" fill="url(https://example.org/p.svg#g)"/>' +
        '<rect width="1" height="1" fill="url(#local)" clip-path="url(#c)" filter="url(\'#f\')"/>' +
        '<rect width="1" height="1" mask="url(//example.com/m#m)"/>',
    ),
  );
  assert.equal(out.error, undefined);
  const values = [];
  walk(out.el, (node) => {
    for (const attr of node.attributes) {
      if (/^(fill|clip-path|filter|mask)$/.test(attr.name)) values.push(attr.value);
    }
  });
  assert.deepEqual(values.sort(), ['url(#c)', 'url(#local)', "url('#f')"]);
  assert.equal(out.dropped.attributes, 2);
});

test('animation-bearing attributes are refused on any element that reaches the allowlist', () => {
  const out = sanitize(
    svg('<rect width="1" height="1" from="0" to="100" values="0;1" begin="click" by="2"/>'),
  );
  assert.deepEqual(attrNames(out.el), ['viewBox', 'width', 'height']);
  assert.equal(out.dropped.attributes, 5);
});

test('a namespace-prefixed attribute we do not recognise is dropped', () => {
  const out = sanitize(
    `<svg xmlns="${SVG_NS}" xmlns:sodipodi="http://example.org/ns" xmlns:xlink="${XLINK_NS}">` +
      '<rect sodipodi:nodetypes="cccc" xlink:role="https://example.org/r" xml:space="preserve" width="1" height="1"/>' +
      '</svg>',
  );
  assert.equal(out.error, undefined);
  const attrs = attrNames(out.el);
  assert.ok(!attrs.includes('sodipodi:nodetypes'));
  assert.ok(!attrs.includes('xlink:role'));
  assert.ok(attrs.includes('xml:space'), 'xml:space is recognised and harmless');
  assert.equal(out.dropped.attributes, 2);
});

test('an image element is refused outright, external or inline', () => {
  const out = sanitize(
    svg(
      '<image href="https://example.org/x.png" width="10" height="10"/>' +
        '<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>',
    ),
  );
  assert.deepEqual(names(out.el), ['svg']);
  assert.equal(out.dropped.elements, 2);
});

test('metadata, with whatever foreign XML it carries, is not copied', () => {
  const out = sanitize(
    svg('<metadata><rdf:RDF xmlns:rdf="http://example.org/rdf"><rdf:x/></rdf:RDF></metadata>'),
  );
  assert.deepEqual(names(out.el), ['svg']);
  assert.equal(out.dropped.elements, 3);
});

test('a parse failure is an error, not a half-built tree', () => {
  const out = sanitize('<svg><g></svg>');
  assert.equal(out.el, undefined);
  assert.equal(out.error.kind, 'parse');
  assert.match(out.error.message, /not valid SVG/);
  assert.match(out.error.message, /mismatched end tag/);
});

test('a non-svg root is refused, which is also how a parsererror is caught', () => {
  const out = sanitize('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>');
  assert.equal(out.el, undefined);
  assert.equal(out.error.kind, 'parse');
  assert.match(out.error.message, /root element is <html>/);
});

test('an empty file is an error and nothing else', () => {
  const out = sanitize('   ');
  assert.equal(out.error.kind, 'parse');
  assert.equal(out.dropped.total, 0);
});

test('the sanitiser never asks the parser for HTML', () => {
  // The assertion lives in FakeDOMParser.parseFromString; this test is here so
  // that it is obvious the mime type is part of the contract and not a detail.
  const out = sanitize(svg('<rect width="1" height="1"/>'));
  assert.equal(out.error, undefined);
});

test('an entity-encoded javascript URL is still refused', () => {
  const out = sanitize(svg('<a href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a>'));
  assert.equal(out.error, undefined);
  assert.ok(!attrNames(out.el).includes('href'));
  assert.equal(out.dropped.attributes, 1);
});

test('a second reference attribute on the same element is judged on its own', () => {
  const out = sanitize(svg('<use xlink:href="#good" href="https://example.org/x#bad"/>'));
  const refs = [];
  walk(out.el, (node) => node.attributes.forEach((a) => refs.push(`${a.name}=${a.value}`)));
  assert.deepEqual(refs.sort(), ['viewBox=0 0 100 100', 'xlink:href=#good']);
  assert.equal(out.dropped.attributes, 1);
});

test('a dangerous declaration nested in @media is removed, not carried inside', () => {
  const out = sanitize(
    svg('<style>@media screen { .a { background: url(https://example.org/t.png); fill: red } }</style>'),
  );
  assert.ok(!/example\.org/.test(out.css), out.css);
  assert.match(out.css, /@media screen \{\n#diagram-panel \.a \{\n  fill: red;/);
  assert.equal(out.dropped.declarations, 1);
});

// --- the sanitiser must not mangle good input ------------------------------

const LEGITIMATE = svg(
  '<title>Architecture</title>' +
    '<desc>Ingress to portal to apps</desc>' +
    '<defs>' +
    '<linearGradient id="grad" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">' +
    '<stop offset="0" stop-color="#112233" stop-opacity="1"/>' +
    '<stop offset="1" stop-color="#445566"/>' +
    '</linearGradient>' +
    '<radialGradient id="rgrad" cx="0.5" cy="0.5" r="0.5" spreadMethod="pad">' +
    '<stop offset="0" stop-color="#fff"/>' +
    '</radialGradient>' +
    '<marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto" markerUnits="strokeWidth">' +
    '<path d="M0 0 L8 4 L0 8 z" fill="#334455"/>' +
    '</marker>' +
    '<clipPath id="clip" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="100" height="100"/></clipPath>' +
    '<pattern id="hatch" patternUnits="userSpaceOnUse" width="4" height="4">' +
    '<line x1="0" y1="0" x2="4" y2="4" stroke="#000" stroke-width="1"/>' +
    '</pattern>' +
    '<filter id="shadow" filterUnits="objectBoundingBox">' +
    '<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b"/>' +
    '<feOffset in="b" dx="1" dy="1" result="o"/>' +
    '<feFlood flood-color="#000" flood-opacity="0.3"/>' +
    '<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>' +
    '</filter>' +
    '<symbol id="box" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol>' +
    '</defs>' +
    '<g id="nodes" class="layer" transform="translate(10,10)" clip-path="url(#clip)" filter="url(#shadow)">' +
    '<rect x="0" y="0" width="40" height="20" rx="3" ry="3" fill="url(#grad)" stroke="#223344" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<circle cx="60" cy="10" r="8" fill="url(#rgrad)" fill-opacity="0.9"/>' +
    '<ellipse cx="80" cy="10" rx="6" ry="4" fill="#abcdef"/>' +
    '<polygon points="0,30 10,40 0,50" fill="url(#hatch)"/>' +
    '<polyline points="20,30 30,40 40,30" fill="none" stroke="#000" stroke-dasharray="2 2"/>' +
    '<path d="M0 60 C 10 70, 20 70, 30 60" fill="none" stroke="#000" marker-end="url(#arrow)" pathLength="100"/>' +
    '<line x1="0" y1="80" x2="100" y2="80" stroke="#999" stroke-opacity="0.5"/>' +
    '<use href="#box" x="50" y="50"/>' +
    '<text x="4" y="14" font-family="system-ui" font-size="10" font-weight="600" text-anchor="middle" dominant-baseline="middle" fill="#fff" xml:space="preserve">' +
    'Portal <tspan dx="2" dy="0" font-style="italic">v1</tspan>' +
    '</text>' +
    '<text><textPath href="#curve" startOffset="10%">along</textPath></text>' +
    '<a href="#nodes" role="link" aria-label="nodes"><rect width="1" height="1"/></a>' +
    '</g>',
  'width="100" height="100" role="img" aria-labelledby="t" preserveAspectRatio="xMidYMid meet" version="1.1"',
);

test('a legitimate diagram loses nothing at all', () => {
  const out = sanitize(LEGITIMATE);
  assert.equal(out.error, undefined);
  assert.deepEqual(
    out.dropped,
    { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 },
    'a sanitiser that mangles good input is as useless as one that lets scripts through',
  );
});

test('a legitimate diagram keeps its structure, references and text', () => {
  const out = sanitize(LEGITIMATE);
  const kept = names(out.el);
  for (const name of [
    'svg',
    'title',
    'desc',
    'defs',
    'linearGradient',
    'radialGradient',
    'stop',
    'marker',
    'clipPath',
    'pattern',
    'filter',
    'feGaussianBlur',
    'feMerge',
    'feMergeNode',
    'symbol',
    'g',
    'rect',
    'circle',
    'ellipse',
    'polygon',
    'polyline',
    'path',
    'line',
    'use',
    'text',
    'tspan',
    'textPath',
    'a',
  ]) {
    assert.ok(kept.includes(name), `<${name}> survived`);
  }
  assert.equal(out.el.getAttribute('viewBox'), '0 0 100 100');
  assert.match(out.el.textContent, /Portal/);
  assert.match(out.el.textContent, /v1/);
  assert.ok(attrNames(out.el).includes('xml:space'));
});

test('every allowlisted element can actually be built', () => {
  // Guards against a name in ALLOWED_ELEMENTS that no fixture exercises and
  // that is misspelled or shadowed by the special case for <style>.
  for (const name of ALLOWED_ELEMENTS) {
    if (name === 'svg') continue;
    const out = sanitize(svg(`<${name}/>`));
    assert.equal(out.error, undefined, name);
    assert.ok(names(out.el).includes(name), `${name} was rebuilt`);
    assert.equal(out.dropped.elements, 0, name);
  }
});

// --- styles: extracted, filtered, scoped ----------------------------------

test('a style element is extracted rather than dropped or inlined', () => {
  const out = sanitize(
    svg('<style>.node rect { fill: #112233; stroke: #000; }</style><rect class="node"/>'),
  );
  assert.equal(out.error, undefined);
  assert.ok(!names(out.el).includes('style'), 'no style element reaches the document');
  assert.match(out.css, /#diagram-panel \.node rect/);
  assert.match(out.css, /fill: #112233;/);
  assert.equal(out.dropped.total, 0, 'extraction is not a drop');
});

test('dangerous declarations in the extracted stylesheet are removed', () => {
  const out = sanitize(
    svg(
      '<style>' +
        '@import url(https://example.org/evil.css);' +
        '.a { background-image: url(https://example.org/t.png); fill: red; }' +
        '.b { width: expression(alert(1)); height: 10px; }' +
        '.c { behavior: url(#x); color: blue; }' +
        '.d { fill: url(#grad); }' +
        '</style><rect class="a"/>',
    ),
  );
  assert.ok(!/example\.org/.test(out.css), out.css);
  assert.ok(!/@import/.test(out.css));
  assert.ok(!/expression/.test(out.css));
  assert.ok(!/behavior/.test(out.css));
  assert.match(out.css, /#diagram-panel \.a[^]*fill: red;/);
  assert.match(out.css, /#diagram-panel \.d[^]*fill: url\(#grad\);/);
  assert.ok(out.dropped.declarations >= 3, `declarations counted: ${out.dropped.declarations}`);
  assert.ok(out.dropped.rules >= 1, 'the @import rule is counted');
});

test('a style attribute is applied through the CSSOM and never left on the element', () => {
  const out = sanitize(
    svg(
      '<rect width="1" height="1" ' +
        String.fromCharCode(115, 116, 121, 108, 101) +
        '="fill: #0a0; background-image: url(https://example.org/x.png); stroke: #000"/>',
    ),
  );
  assert.equal(out.error, undefined);
  assert.ok(!attrNames(out.el).includes('style'), 'the attribute is gone');
  assert.equal(out.inlineStyles.length, 1);
  assert.deepEqual(out.inlineStyles[0].declarations, [
    ['fill', '#0a0'],
    ['stroke', '#000'],
  ]);
  assert.equal(out.inlineStyles[0].el.style.getPropertyValue('fill'), '#0a0');
  assert.equal(out.dropped.declarations, 1);
});

test('selector lists, @media and comments all scope correctly', () => {
  const css =
    '/* a comment with a } brace and "quote" */\n' +
    '.a, .b > .c, .d:is(.e, .f) { fill: red }\n' +
    '@media (min-width: 40rem) { .a { fill: blue } .g { stroke: #000 } }\n' +
    'svg .h { opacity: 0.5 }';
  const dropped = { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
  const out = scopeCss(css, 'diagram-panel', dropped);
  assert.match(out, /#diagram-panel \.a,\n#diagram-panel \.b > \.c,\n#diagram-panel \.d:is\(\.e, \.f\)/);
  assert.match(out, /@media \(min-width: 40rem\) \{/);
  assert.match(out, /#diagram-panel \.g \{/);
  assert.match(out, /#diagram-panel svg \.h \{/);
  assert.ok(!/comment/.test(out));
  assert.equal(dropped.rules, 0);
});

test('a rule that cannot be scoped safely is dropped and counted, never emitted bare', () => {
  const cases = [
    ':root { --x: 1 }',
    'html { fill: red }',
    'body .node { fill: red }',
    '.a, :root { fill: red }',
    '@font-face { font-family: X; src: url(https://example.org/f.woff2) }',
    '@keyframes spin { from { opacity: 0 } }',
    '@charset "utf-8";',
    '@namespace svg url(http://www.w3.org/2000/svg);',
  ];
  for (const css of cases) {
    const dropped = { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
    const out = scopeCss(css, 'diagram-panel', dropped);
    assert.ok(!/^\s*[^#@]/.test(out), `${css} -> ${out}`);
    assert.ok(!/:root|html \{|body |@font-face|@keyframes|@charset|@namespace/.test(out), css);
    assert.ok(dropped.rules >= 1, `${css} was counted`);
  }
});

test('an unbalanced or injected selector is refused', () => {
  assert.equal(scopeSelector('.a)', '#d'), null);
  assert.equal(scopeSelector('.a { } .b', '#d'), null);
  assert.equal(scopeSelector('.a; .b', '#d'), null);
  assert.equal(scopeSelector('</style><script>', '#d'), null);
  assert.equal(scopeSelector('   ', '#d'), null);
  assert.equal(scopeSelector('.a .b', '#d'), '#d .a .b');
});

test('without a usable scope id every rule is dropped rather than left unscoped', () => {
  for (const scopeId of ['', undefined, 'not valid', '1bad', 'a}b']) {
    const dropped = { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
    const out = scopeCss('.a { fill: red } .b { fill: blue }', scopeId, dropped);
    assert.equal(out, '');
    assert.equal(dropped.rules, 2);
  }
});

test('nothing in an unterminated stylesheet escapes', () => {
  const dropped = { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
  const out = scopeCss('.a { fill: red', 'd', dropped);
  assert.equal(out, '');
  assert.equal(dropped.rules, 1);
});

test('a dangerous property name is refused however innocent its value', () => {
  const dropped = { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
  assert.deepEqual(
    filterDeclarations('behavior: url(#x); -moz-binding: url(#y); fill: red', dropped),
    [['fill', 'red']],
  );
  assert.equal(dropped.declarations, 2);
});

test('filterDeclarations keeps a fragment url and refuses the rest', () => {
  const dropped = { elements: 0, attributes: 0, declarations: 0, rules: 0, total: 0 };
  assert.deepEqual(
    filterDeclarations('fill: url(#g); stroke: url(https://example.org/x); ; bogus', dropped),
    [['fill', 'url(#g)']],
  );
  assert.equal(dropped.declarations, 2);
});

test('isSafeValue draws the line in one place', () => {
  for (const good of ['url(#a)', '#fff', 'translate(1,2)', 'url("#a") url(#b)', '2 2']) {
    assert.equal(isSafeValue(good), true, good);
  }
  for (const bad of [
    'url(https://example.org/x)',
    'url(//example.com/x)',
    'url(x.svg#a)',
    'url(',
    'javascript:alert(1)',
    'expression(alert(1))',
    'behavior: url(#x)',
    '@import "x"',
  ]) {
    assert.equal(isSafeValue(bad), false, bad);
  }
});

// --- applying the CSS ------------------------------------------------------

test('applyScopedCss adopts a constructed stylesheet and stop() removes it', () => {
  const adopted = [];
  class FakeSheet {
    replaceSync(text) {
      this.text = text;
      adopted.push(text);
    }
  }
  const doc = { adoptedStyleSheets: [] };
  const stop = applyScopedCss('#d .a { fill: red }', {
    deps: { document: doc, CSSStyleSheet: FakeSheet },
  });
  assert.equal(doc.adoptedStyleSheets.length, 1);
  assert.deepEqual(adopted, ['#d .a { fill: red }']);
  stop();
  assert.equal(doc.adoptedStyleSheets.length, 0);
  stop();
  assert.equal(doc.adoptedStyleSheets.length, 0, 'stop() is idempotent');
});

test('applyScopedCss never falls back to a style element', () => {
  // A <style> element would need style-src unsafe-inline for the whole page,
  // which is the one thing this function exists to avoid. Unstyled is correct.
  const doc = {
    adoptedStyleSheets: [],
    createElement() {
      throw new Error('applyScopedCss must not create elements');
    },
  };
  const stop = applyScopedCss('.a { fill: red }', { deps: { document: doc } });
  assert.equal(typeof stop, 'function');
  assert.equal(doc.adoptedStyleSheets.length, 0);
  stop();
});

test('applyScopedCss on empty CSS or no document is a no-op', () => {
  assert.equal(typeof applyScopedCss('', { deps: { document: {} } }), 'function');
  assert.equal(typeof applyScopedCss('.a{fill:red}', { deps: { document: null } }), 'function');
});

// --- fetching --------------------------------------------------------------

function fakeResponse(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
  };
}

test('fetchDiagram returns the text and its byte length', async () => {
  const body = svg('<rect width="1" height="1"/>');
  const out = await fetchDiagram('./config/diagram.svg', {
    deps: { fetch: async () => fakeResponse(body) },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.text, body);
  assert.equal(out.bytes, Buffer.byteLength(body));
});

test('fetchDiagram counts bytes, not characters', async () => {
  const body = `${svg('<text>ä€</text>')}`;
  const out = await fetchDiagram('./d.svg', { deps: { fetch: async () => fakeResponse(body) } });
  assert.equal(out.bytes, Buffer.byteLength(body));
  assert.ok(out.bytes > body.length);
});

test('a declared Content-Length over the limit refuses before the body is read', async () => {
  let read = false;
  const response = fakeResponse('x', { headers: { 'content-length': '999999' } });
  response.text = async () => {
    read = true;
    return 'x';
  };
  const out = await fetchDiagram('./d.svg', {
    maxBytes: 1024,
    deps: { fetch: async () => response },
  });
  assert.equal(read, false, 'the body must not be read');
  assert.equal(out.error.kind, 'too-large');
  assert.equal(out.error.bytes, 999999);
  assert.equal(out.error.maxBytes, 1024);
  assert.match(out.error.message, /999999 bytes, over the 1024 byte limit/);
});

test('a body over the limit is refused even with no Content-Length', async () => {
  const out = await fetchDiagram('./d.svg', {
    maxBytes: 8,
    deps: { fetch: async () => fakeResponse('x'.repeat(100)) },
  });
  assert.equal(out.error.kind, 'too-large');
  assert.equal(out.error.bytes, 100);
});

test('the default limit is the documented 512KiB', async () => {
  assert.equal(DIAGRAM_DEFAULT_MAX_BYTES, 524288);
  const out = await fetchDiagram('./d.svg', {
    deps: { fetch: async () => fakeResponse('x'.repeat(DIAGRAM_DEFAULT_MAX_BYTES + 1)) },
  });
  assert.equal(out.error.kind, 'too-large');
  assert.equal(out.error.maxBytes, DIAGRAM_DEFAULT_MAX_BYTES);
});

test('a 404 names the path it tried', async () => {
  const out = await fetchDiagram('./config/diagram.svg', {
    deps: { fetch: async () => fakeResponse('', { status: 404 }) },
  });
  assert.equal(out.error.kind, 'http');
  assert.equal(out.error.status, 404);
  assert.match(out.error.message, /\.\/config\/diagram\.svg/);
});

test('a network failure is an error, never a throw', async () => {
  const out = await fetchDiagram('./d.svg', {
    deps: {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    },
  });
  assert.equal(out.error.kind, 'network');
  assert.match(out.error.message, /Failed to fetch/);
});

test('a hung fetch times out and says so', async () => {
  const out = await fetchDiagram('./d.svg', {
    timeoutMs: 5,
    deps: {
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout,
      fetch: (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    },
  });
  assert.equal(out.error.kind, 'timeout');
  assert.match(out.error.message, /did not answer in time/);
});

test('no url configured is a config error and no fetch happens', async () => {
  let called = false;
  const out = await fetchDiagram('  ', {
    deps: {
      fetch: async () => {
        called = true;
        return fakeResponse('x');
      },
    },
  });
  assert.equal(called, false);
  assert.equal(out.error.kind, 'config');
});

// --- the renderer ----------------------------------------------------------

const RENDERER_URL = 'https://cdn.example.com/mermaid@11/dist/mermaid.esm.min.mjs';

test('renderSource initializes, renders and returns the SVG', async () => {
  const calls = [];
  const out = await renderSource('flowchart TD\n  a --> b', {
    url: RENDERER_URL,
    options: { theme: 'dark', securityLevel: 'strict' },
  }, {
    deps: {
      import: async (url) => {
        calls.push(['import', url]);
        return {
          default: {
            initialize(options) {
              calls.push(['initialize', options]);
            },
            async render(id, source) {
              calls.push(['render', id, source]);
              return { svg: svg('<rect width="1" height="1"/>') };
            },
          },
        };
      },
    },
  });
  assert.equal(out.error, undefined);
  assert.match(out.text, /<rect/);
  assert.deepEqual(calls[0], ['import', RENDERER_URL]);
  assert.deepEqual(calls[1], ['initialize', { theme: 'dark', securityLevel: 'strict' }]);
  assert.equal(calls[2][0], 'render');
  assert.match(calls[2][1], /^qp-diagram-\d+$/);
  assert.equal(calls[2][2], 'flowchart TD\n  a --> b');
});

test('a renderer exposed on the namespace rather than a default export works', async () => {
  const out = await renderSource('a', { url: RENDERER_URL }, {
    deps: { import: async () => ({ render: async () => ({ svg: svg('<g/>') }) }) },
  });
  assert.equal(out.error, undefined);
  assert.match(out.text, /<g/);
});

test('an unreachable or forbidden renderer names the origin and the policy', async () => {
  const out = await renderSource('a', { url: RENDERER_URL }, {
    deps: {
      import: async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
    },
  });
  assert.equal(out.error.kind, 'renderer-unreachable');
  assert.equal(out.error.origin, 'https://cdn.example.com');
  assert.match(out.error.message, /needs https:\/\/cdn\.example\.com/);
  assert.match(out.error.message, /script-src/);
});

test('a module with no render function is an error, not a crash', async () => {
  const out = await renderSource('a', { url: RENDERER_URL }, {
    deps: { import: async () => ({ default: { initialize() {} } }) },
  });
  assert.equal(out.error.kind, 'renderer-shape');
});

test('a renderer that throws, or returns nothing, is an error', async () => {
  const thrown = await renderSource('bad source', { url: RENDERER_URL }, {
    deps: {
      import: async () => ({
        render: async () => {
          throw new Error('Parse error on line 2');
        },
      }),
    },
  });
  assert.equal(thrown.error.kind, 'renderer-failed');
  assert.match(thrown.error.message, /Parse error on line 2/);

  const empty = await renderSource('a', { url: RENDERER_URL }, {
    deps: { import: async () => ({ render: async () => ({}) }) },
  });
  assert.equal(empty.error.kind, 'renderer-shape');
});

test('a renderer that rejects its options is an error', async () => {
  const out = await renderSource('a', { url: RENDERER_URL, options: { theme: 'nope' } }, {
    deps: {
      import: async () => ({
        initialize() {
          throw new Error('unknown theme');
        },
        render: async () => ({ svg: svg('<g/>') }),
      }),
    },
  });
  assert.equal(out.error.kind, 'renderer-failed');
  assert.match(out.error.message, /unknown theme/);
});

test('no renderer or no source is a config error and nothing is imported', async () => {
  let imported = false;
  const deps = {
    import: async () => {
      imported = true;
      return {};
    },
  };
  assert.equal((await renderSource('', { url: RENDERER_URL }, { deps })).error.kind, 'config');
  assert.equal((await renderSource('a', {}, { deps })).error.kind, 'config');
  assert.equal((await renderSource('a', null, { deps })).error.kind, 'config');
  assert.equal(imported, false);
});

test('initialize is called even when the operator supplied no options', async () => {
  // config.js surfaces `options: null`, and mermaid still expects to be
  // initialised, so the call happens with an empty object rather than not at
  // all.
  const seen = [];
  const out = await renderSource('a', { url: RENDERER_URL, options: null }, {
    deps: {
      import: async () => ({
        initialize(options) {
          seen.push(options);
        },
        render: async () => ({ svg: svg('<g/>') }),
      }),
    },
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(seen, [{}]);
});

test('rendered output over maxBytes is refused before anything is sanitised', async () => {
  const out = await renderSource('a', { url: RENDERER_URL }, {
    maxBytes: 256,
    deps: {
      import: async () => ({
        render: async () => ({ svg: svg(`<rect width="1" height="1"/>`.repeat(200)) }),
      }),
    },
  });
  assert.equal(out.error.kind, 'too-large');
  assert.equal(out.error.maxBytes, 256);
  assert.ok(out.error.bytes > 256);
  assert.match(out.error.message, /The rendered diagram is \d+ bytes, over the 256 byte limit\./);
  assert.equal(out.text, undefined);
});

test('only a failed import is worth falling back to a committed SVG for', async () => {
  // The panel wires the fallback; these flags are what it switches on, so they
  // are part of the contract rather than a convenience.
  const unreachable = await renderSource('a', { url: RENDERER_URL }, {
    deps: {
      import: async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
    },
  });
  assert.equal(unreachable.error.fallbackable, true);

  for (const deps of [
    { import: async () => ({ render: async () => { throw new Error('syntax'); } }) },
    { import: async () => ({ render: async () => ({}) }) },
    { import: async () => ({ initialize() {} }) },
  ]) {
    const out = await renderSource('a', { url: RENDERER_URL }, { deps });
    assert.equal(out.error.fallbackable, false, out.error.kind);
    assert.match(out.error.message, /loaded but|has no render/);
  }
});

test('renderer output is sanitised exactly like a supplied file', async () => {
  const rendered = await renderSource('a', { url: RENDERER_URL }, {
    deps: {
      import: async () => ({
        render: async (id) => ({
          svg: svg(
            `<g id="${id}"><script>globalThis.pwned = 1;</script>` +
              '<style>.node { fill: red }</style>' +
              '<rect class="node" width="1" height="1"/></g>',
          ),
        }),
      }),
    },
  });
  const out = sanitize(rendered.text);
  assert.equal(out.error, undefined);
  assert.ok(!names(out.el).includes('script'));
  assert.equal(out.dropped.elements, 1);
  assert.match(out.css, /#diagram-panel \.node/);
});

// --- export ----------------------------------------------------------------

test('serializeSvg writes out the sanitised tree, not the source', () => {
  const out = sanitize(svg('<script>globalThis.pwned = 1;</script><rect width="10" height="10"/>'));
  const text = serializeSvg(out.el, { deps: { XMLSerializer: FakeXMLSerializer } });
  assert.match(text, /<rect/);
  assert.ok(!/script/.test(text));
  assert.match(text, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('serializeSvg with nothing to serialise returns an empty string', () => {
  assert.equal(serializeSvg(null), '');
});

function pngDeps() {
  const made = [];
  class FakeImage {
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return this._src;
    }
  }
  const doc = {
    createElement(name) {
      if (name !== 'canvas') throw new Error(`unexpected element ${name}`);
      const canvas = {
        width: 0,
        height: 0,
        drawn: null,
        getContext: () => ({
          drawImage(img, x, y, w, h) {
            canvas.drawn = { x, y, w, h };
          },
        }),
        toBlob(cb) {
          cb({ type: 'image/png', size: canvas.width * canvas.height });
        },
      };
      made.push(canvas);
      return canvas;
    },
  };
  const urls = {
    created: [],
    revoked: [],
    createObjectURL(blob) {
      urls.created.push(blob);
      return `blob:example-${urls.created.length}`;
    },
    revokeObjectURL(url) {
      urls.revoked.push(url);
    },
  };
  const harness = {
    made,
    urls,
    lastSrc: null,
    deps: {
      document: doc,
      Image: FakeImage,
      URL: urls,
      Blob: class FakeBlob {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = opts?.type;
        }
      },
      XMLSerializer: FakeXMLSerializer,
    },
  };
  // Record the src the module assigns, so a test can assert the scheme it uses.
  const Base = harness.deps.Image;
  harness.deps.Image = class extends Base {
    set src(value) {
      harness.lastSrc = value;
      super.src = value;
    }
  };
  return harness;
}

test('toPng draws the viewBox at the requested scale and resolves a blob', async () => {
  const out = sanitize(svg('<rect width="100" height="100"/>'));
  const harness = pngDeps();
  const blob = await toPng(out.el, { scale: 3, deps: harness.deps });
  assert.equal(blob.type, 'image/png');
  assert.equal(harness.made[0].width, 300);
  assert.equal(harness.made[0].height, 300);
  assert.deepEqual(harness.made[0].drawn, { x: 0, y: 0, w: 300, h: 300 });
  assert.equal(harness.deps.Blob.name, 'FakeBlob');

  // No object URL, deliberately. The policy this project ships is
  // `img-src 'self' https: data:`, with no blob:, so an <img> pointed at an
  // object URL never decodes and the export fails silently. It must be a data:
  // URL, and nothing may reintroduce a blob URL here without this failing.
  assert.equal(harness.urls.created.length, 0, 'no blob URL is created');
  assert.match(harness.lastSrc, /^data:image\/svg\+xml;charset=utf-8,/);
});

test('the PNG source carries the export stylesheet, or a styled diagram exports bare', async () => {
  const out = sanitize(svg('<rect class="box" width="10" height="10"/>'));
  const harness = pngDeps();
  await toPng(out.el, { deps: harness.deps, css: '.box { fill: #2a52c9; }' });
  const decoded = decodeURIComponent(harness.lastSrc.split(',')[1]);
  assert.match(decoded, /<style type="text\/css">/);
  assert.match(decoded, /\.box \{ fill: #2a52c9; \}/);
});

test('toPng defaults to the documented scale and falls back to width/height', async () => {
  const out = sanitize(`<svg xmlns="${SVG_NS}" width="50" height="20"><rect/></svg>`);
  const harness = pngDeps();
  await toPng(out.el, { deps: harness.deps });
  assert.equal(PNG_DEFAULT_SCALE, 2);
  assert.equal(harness.made[0].width, 100);
  assert.equal(harness.made[0].height, 40);
});

test('toPng rejects rather than throwing when the SVG cannot be decoded', async () => {
  const out = sanitize(svg('<rect/>'));
  const harness = pngDeps();
  harness.deps.Image = class {
    set src(_value) {
      queueMicrotask(() => this.onerror?.());
    }
  };
  await assert.rejects(() => toPng(out.el, { deps: harness.deps }), /could not be decoded/);
  assert.equal(harness.urls.created.length, 0, 'still no blob URL to leak');
});

test('toPng rejects when the browser cannot do it at all', async () => {
  const out = sanitize(svg('<rect/>'));
  await assert.rejects(
    () => toPng(out.el, { deps: { document: null } }),
    /not available in this browser/,
  );
});
