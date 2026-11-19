/**
 * nohumans-guard — check an x402 endpoint against nohumans.directory before
 * a payment is signed.
 *
 *   import { nohumansGuard } from "nohumans-guard";
 *   client.onBeforePaymentCreation(nohumansGuard());
 *
 * The rules are the published pay rules (https://nohumans.directory/integrate#rules),
 * applied in order; the first that matches decides. Everything the guard
 * reads is the free public record: GET /v1/resolve?url=. No key, no account.
 *
 * What leaves your process: the endpoint's origin and path (the query string
 * is removed unless you pass query: "keep"). Never the request body, the
 * payment, your wallet address or any header.
 */

export const VERSION = "0.2.0";
const DEFAULT_API = "https://api.nohumans.directory";

/** CAIP-2 ids for the network names x402 v1 used, so "base" and "eip155:8453" compare equal. */
const NETWORK_ALIASES = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  polygon: "eip155:137",
  avalanche: "eip155:43114",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};
const net = (n) => {
  const s = String(n ?? "").trim();
  return NETWORK_ALIASES[s.toLowerCase()] ?? s;
};
// EVM addresses are case-insensitive; Solana (base58) addresses are not.
const sameAddress = (a, b, network) =>
  net(network).startsWith("eip155:") ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b);

const allow = (rule, reason, extra) => ({ action: "allow", rule, reason, ...extra });
const warn = (rule, reason, extra) => ({ action: "allow", warn: true, rule, reason, ...extra });

/**
 * Who a failed purchase fails for (0.2.0; the directory publishes it as failure_kind since 2026-11-19,
 * methodology #failure-kind-1119; this copy is used when an older record has none).
 * any_buyer: nothing usable could come back whatever was asked: a server error, a second 402 after
 * payment, an empty answer, a dropped connection, 202 with no job reference. Those block.
 * quality: something came back but not as promised (stale, not the declared shape). request_dependent:
 * the directory's own request was refused or answered in an undeclared form (missing parameters, wrong
 * method, a web page or binary). Those can work for your request, so they warn and allow (strict: true blocks).
 */
export function failureKind(reason) {
  const r = String(reason ?? "").split(";")[0].trim();
  if (/^paid_but_status_(5\d\d|402)/.test(r) || r === "empty_body" || r.startsWith("paid_but_error_") || r === "accepted_no_result")
    return "any_buyer";
  if (r === "stale_data" || r === "schema_mismatch") return "quality";
  return "request_dependent";
}
const block = (rule, reason, extra) => ({ action: "block", rule, reason, ...extra });

/**
 * The pay rules as a pure function: a /v1/resolve answer plus the payment
 * terms about to be signed in, a decision out. No network, no clock.
 *
 * @param {object|null} resolved  JSON body of /v1/resolve ({match, detail|listing}), or null when the lookup failed
 * @param {object} [requirements] the selected x402 payment requirements ({network, asset, amount, payTo, scheme})
 * @param {object} [opts]         { unknown: "allow"|"block", priceSlack: number, failClosed: boolean, strict: boolean }
 */
export function decide(resolved, requirements, opts = {}) {
  const unknownPolicy = opts.unknown === "block" ? block : allow;
  if (!resolved || typeof resolved !== "object")
    return (opts.failClosed ? block : allow)("lookup_failed",
      "nohumans.directory could not be reached; no evidence either way");

  if (resolved.match === "delisted")
    return block("delisted", "this endpoint was listed on nohumans.directory and later removed",
      { listing_id: resolved.listing?.id ?? null });
  if (resolved.match !== "active" || !resolved.detail)
    return unknownPolicy("unknown", "not listed on nohumans.directory; it has never been checked there");

  const d = resolved.detail;
  const ref = { listing_id: d.id ?? null, record: d.id ? `https://nohumans.directory/l/${d.id}` : null };

  // Several listings share this origin and path and differ by query string.
  // The record in hand is one of them, so its purchase history, status and
  // price are not evidence about this call. The payment address still is.
  if (resolved.match_basis === "path" && Number(resolved.path_listings) > 1) {
    const o = d.observed ?? {};
    if (requirements?.payTo && o.pay_to && o.network && net(requirements.network) === net(o.network)
        && !sameAddress(requirements.payTo, o.pay_to, o.network))
      return block("payto_mismatch",
        `the 402 asks to pay ${requirements.payTo}; the record shows ${o.pay_to} on the same network`, ref);
    return allow("path_shared", `${resolved.path_listings} listings share this path; only the payment address was compared`,
      { listing_id: null, record: null });
  }

  // 1. Our latest purchase failed. Blocks when the failure would hit any buyer (0.2.0); a failure that
  //    depended on the directory's own request, or an answer that came back but not as promised, is
  //    carried as a warning and checked against the rules below (strict: true restores the 0.1 block).
  let failedWarn = null;
  const pvl = d.paid_verification_latest;
  if (pvl?.delivered === false || d.latest_purchase_delivered === false) {
    const kind = pvl?.failure_kind ?? failureKind(pvl?.failure_reason);
    const why = pvl?.failure_reason ? ` (${pvl.failure_reason})` : "";
    if (kind === "any_buyer" || opts.strict)
      return block("latest_purchase_failed",
        `the directory's most recent real purchase of this endpoint settled and did not deliver${why}`, { ...ref, failure_kind: kind });
    failedWarn = { rule: "latest_purchase_failed_" + (kind === "quality" ? "quality" : "request"),
      reason: kind === "quality"
        ? `the directory's most recent real purchase settled and the answer was not as promised${why}`
        : `the directory's most recent real purchase settled and its request was not served${why}; this can depend on the request: send what the endpoint asks for`,
      failure_kind: kind };
  }

  // 2. Known bad.
  if (d.status === "failing")
    return block("failing", "this endpoint is failing the directory's checks", ref);
  if (d.payto_unstable === true)
    return block("payto_unstable", "this endpoint's payment address keeps changing", ref);

  // 3. The 402 in hand disagrees with the record.
  const obs = d.observed ?? {};
  if (requirements && obs.network && net(requirements.network) === net(obs.network)) {
    if (requirements.payTo && obs.pay_to && !sameAddress(requirements.payTo, obs.pay_to, obs.network))
      return block("payto_mismatch",
        `the 402 asks to pay ${requirements.payTo}; the record shows ${obs.pay_to} on the same network`, ref);
    const sameAsset = requirements.asset && obs.asset && sameAddress(requirements.asset, obs.asset, obs.network);
    const sameScheme = !requirements.scheme || !obs.scheme || requirements.scheme === obs.scheme;
    const asked = requirements.amount ?? requirements.maxAmountRequired; // v2 | v1
    if (sameAsset && sameScheme && asked != null && obs.amount_atomic != null) {
      try {
        const slackBp = BigInt(Math.round(Math.max(0, Number(opts.priceSlack ?? 0)) * 10000));
        const limit = (BigInt(obs.amount_atomic) * (10000n + slackBp)) / 10000n;
        if (BigInt(asked) > limit)
          return block("price_above_record",
            `the 402 asks ${asked} (atomic units); the record shows ${obs.amount_atomic}`, ref);
      } catch { /* a non-integer amount cannot be compared; not evidence either way */ }
    }
  }
  if (d.payto_sentinel === true)
    return block("payto_sentinel", "the payment address is a zero or burn address", ref);

  if (failedWarn) return warn(failedWarn.rule, failedWarn.reason, { ...ref, failure_kind: failedWarn.failure_kind });

  // 5. No evidence either way.
  if (d.status !== "verified")
    return unknownPolicy("unverified", "listed, but not yet verified by the directory's checks", ref);

  return allow("ok", d.paid_verified
    ? "verified, and the directory's latest real purchase delivered"
    : "verified by unpaid checks; the directory has not bought it", ref);
}

/** What is sent to the directory for a URL: origin + path, query removed unless asked to keep it. */
export function lookupUrl(raw, query = "strip") {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = ""; u.username = ""; u.password = "";
  if (query !== "keep") u.search = "";
  return u.toString();
}

const defaultCache = new Map();

/**
 * Look an endpoint URL up and apply the rules.
 * @returns {Promise<{action:"allow"|"block", rule:string, reason:string, listing_id?:string|null, record?:string|null, url:string|null}>}
 */
export async function check(url, requirements, opts = {}) {
  const target = lookupUrl(url, opts.query);
  if (!target) return { ...allow("not_a_url", "no http(s) URL to check"), url: null };
  const api = String(opts.api ?? DEFAULT_API).replace(/\/+$/, "");
  const ttl = opts.cacheSeconds ?? 60;
  const cache = opts.cache ?? defaultCache;
  const key = api + " " + target;
  const now = Date.now();
  let resolved;
  const hit = ttl > 0 ? cache.get(key) : undefined;
  if (hit && now - hit.at < ttl * 1000) resolved = hit.body;
  else {
    resolved = await lookup(api, target, opts);
    if (resolved && ttl > 0) {
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now, body: resolved });
    }
  }
  return { ...decide(resolved, requirements, opts), url: target };
}

async function lookup(api, target, opts) {
  const f = opts.fetch ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2500);
  try {
    // match=path: answer for the endpoint at this origin and path whatever its query string.
    const q = `url=${encodeURIComponent(target)}${opts.query === "keep" ? "" : "&match=path"}&client=guard-${VERSION}`;
    const res = await f(`${api}/v1/resolve?${q}`, {
      headers: { accept: "application/json", "user-agent": `nohumans-guard/${VERSION}` },
      signal: ctrl.signal,
    });
    if (res.status !== 200 && res.status !== 404) return null;   // 404 = { match: "unknown" }
    const body = await res.json();
    return body && typeof body === "object" && typeof body.match === "string" ? body : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * A hook for an x402 client: runs after a 402 arrives and before anything is signed.
 *
 *   client.onBeforePaymentCreation(nohumansGuard({ mode: "enforce" }));
 *
 * mode "enforce" (default) stops a blocked payment; "observe" never stops one
 * and only reports through onDecision.
 */
export function nohumansGuard(opts = {}) {
  return async (context) => {
    const req = context?.selectedRequirements;
    // v2 names the resource on the 402; v1 named it on each payment option.
    const url = context?.paymentRequired?.resource?.url ?? req?.resource ?? null;
    let decision;
    try { decision = await check(url, req, opts); }
    catch (e) { decision = { ...(opts.failClosed ? block : allow)("guard_error", String(e?.message ?? e)), url: null }; }
    try { opts.onDecision?.(decision); } catch { /* a logging callback must not decide a payment */ }
    if (decision.action === "block" && opts.mode !== "observe")
      return { abort: true, reason: `nohumans-guard: ${decision.reason}${decision.record ? ` (${decision.record})` : ""}` };
  };
}

/**
 * Report what a payment bought (optional). The directory accepts a report
 * only with the payment's transaction hash on Base and a signature from the
 * wallet that paid; reports count toward ranking once three payers report.
 *
 * @param {{listingId:string, ok:boolean, txHash:string, signMessage:(message:string)=>Promise<string>, detail?:string, api?:string, fetch?:typeof fetch}} r
 */
export async function reportOutcome(r) {
  if (typeof r?.ok !== "boolean") throw new TypeError("ok must be true or false");
  const txHash = String(r.txHash).toLowerCase();
  const message = `nohumans.directory report v1\nlisting_id: ${r.listingId}\ntx_hash: ${txHash}\nok: ${r.ok}`;
  const payer_signature = await r.signMessage(message);
  const api = String(r.api ?? DEFAULT_API).replace(/\/+$/, "");
  const res = await (r.fetch ?? globalThis.fetch)(`${api}/v1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `nohumans-guard/${VERSION}` },
    body: JSON.stringify({ listing_id: r.listingId, ok: r.ok, tx_hash: txHash, payer_signature,
                           ...(r.detail ? { detail: String(r.detail).slice(0, 500) } : {}) }),
  });
  let body = null; try { body = await res.json(); } catch { /* keep null */ }
  return { accepted: res.ok, status: res.status, body };
}
