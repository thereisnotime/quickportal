// Live config reload by ETag polling.
//
// We poll the config URL with If-None-Match. A 304 costs almost nothing and
// parses nothing. On a 200 the body is hashed and compared with the last hash
// before anything is signalled, because a proxy or a ConfigMap remount can
// hand out a fresh ETag over byte-identical content, and re-rendering for that
// is pure noise.

/**
 * Hash a config body for change detection.
 *
 * FNV-1a, 32-bit, plus the length. This is a non-cryptographic hash and is not
 * meant to resist anything: we only need "did these bytes change", on content
 * the same origin just served us.
 *
 * @param {string} text
 * @returns {string}
 */
export function hashBody(text) {
  const body = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${body.length}`;
}

/**
 * Watch a config URL and signal real changes.
 *
 * @param {string} url              the config URL, e.g. "./config/config.yaml"
 * @param {number} intervalSeconds  poll period; 0 disables polling entirely
 * @param {function} onChange       called as onChange(text, {etag, hash}) when
 *                                  the body differs from the last one seen
 * @param {object} [deps]  injected browser bits and a starting baseline:
 *   fetch(url, init)        default globalThis.fetch
 *   document                default the global document, or null with no DOM
 *   setInterval/clearInterval  default the globals
 *   onError(error)          called on a failed fetch or a non-OK status
 *   etag / body             the ETag and body the page already rendered, so the
 *                           first poll does not report them as a change
 * @returns {function} stop(), idempotent, removing every timer and listener it
 *                     added. stop.refresh(opts) refetches immediately, ignoring
 *                     the interval; stop.refresh({force: true}) skips
 *                     If-None-Match and signals even on unchanged content.
 */
export function watchConfig(url, intervalSeconds, onChange, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const doc = deps.document ?? (typeof document === 'undefined' ? null : document);
  const startTimer = deps.setInterval ?? globalThis.setInterval;
  const cancelTimer = deps.clearInterval ?? globalThis.clearInterval;
  const onError = deps.onError ?? noop;

  const period = toPeriodMs(intervalSeconds);
  let etag = deps.etag ?? null;
  let hash = deps.body == null ? (deps.hash ?? null) : hashBody(deps.body);

  let timer = null;
  let stopped = false;
  let inFlight = false;

  function schedule() {
    if (stopped || !period || timer !== null || isHidden()) return;
    timer = startTimer(() => {
      poll();
    }, period);
  }

  function unschedule() {
    if (timer === null) return;
    cancelTimer(timer);
    timer = null;
  }

  function isHidden() {
    return doc?.hidden === true;
  }

  async function poll(options = {}) {
    if (stopped) return;
    // One request at a time. A slow response must not pile up behind the
    // interval; the next tick polls again anyway.
    if (inFlight) return;
    inFlight = true;
    try {
      const headers = {};
      if (etag && !options.force) headers['If-None-Match'] = etag;

      const response = await fetchImpl(url, { headers, cache: 'no-store' });
      if (stopped) return;

      // Unchanged: parse nothing, signal nothing.
      if (response.status === 304) return;

      if (response.ok === false) {
        onError(new Error(`config fetch failed with status ${response.status}`));
        return;
      }

      const text = await response.text();
      if (stopped) return;

      etag = headerValue(response, 'etag');
      const nextHash = hashBody(text);
      const changed = nextHash !== hash;
      hash = nextHash;

      if (changed || options.force) onChange(text, { etag, hash });
    } catch (error) {
      // A failed fetch must not kill the watcher: the next tick retries, and
      // onChange is not called, so the last good render stays.
      onError(error);
    } finally {
      inFlight = false;
    }
  }

  function handleVisibilityChange() {
    if (stopped) return;
    if (isHidden()) {
      unschedule();
      return;
    }
    // Exactly one poll on becoming visible, not one per missed interval.
    schedule();
    poll();
  }

  const listening = Boolean(period) && typeof doc?.addEventListener === 'function';
  if (listening) doc.addEventListener('visibilitychange', handleVisibilityChange);
  schedule();

  function stop() {
    if (stopped) return;
    stopped = true;
    unschedule();
    if (listening) doc.removeEventListener('visibilitychange', handleVisibilityChange);
  }

  stop.refresh = (options = {}) => poll(options);
  return stop;
}

function toPeriodMs(intervalSeconds) {
  const seconds = Number(intervalSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds * 1000;
}

function headerValue(response, name) {
  const value = response?.headers?.get?.(name);
  return value ?? null;
}

function noop() {}
