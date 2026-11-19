import test from "node:test";
import assert from "node:assert/strict";
import { decide, check, lookupUrl, nohumansGuard, reportOutcome, failureKind } from "./index.mjs";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const rec = (over = {}) => ({ match: "active", detail: {
  id: "abc", status: "verified", paid_verified: true, payto_unstable: false, payto_sentinel: false,
  paid_verification_latest: { delivered: true }, latest_purchase_delivered: true,
  observed: { network: "eip155:8453", asset: USDC, pay_to: PAYTO, amount_atomic: "20000", scheme: "exact" },
  ...over } });
const req = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, payTo: PAYTO, amount: "20000", ...over });

test("allows a verified, delivered endpoint", () => {
  const d = decide(rec(), req());
  assert.equal(d.action, "allow"); assert.equal(d.rule, "ok"); assert.match(d.record, /\/l\/abc$/);
});
test("rule 1: a failure any buyer would hit blocks even when verified", () => {
  for (const fr of ["paid_but_status_500", "paid_but_status_503;settlement_junk:x", "paid_but_status_402", "empty_body", "paid_but_error_ECONNRESET", "accepted_no_result"]) {
    const d = decide(rec({ paid_verification_latest: { delivered: false, failure_reason: fr } }), req());
    assert.equal(d.action, "block", fr); assert.equal(d.rule, "latest_purchase_failed"); assert.equal(d.failure_kind, "any_buyer");
  }
  // the server's failure_kind wins over the local copy
  assert.equal(decide(rec({ paid_verification_latest: { delivered: false, failure_reason: "invalid_json", failure_kind: "any_buyer" } }), req()).action, "block");
});
test("rule 1 (0.2.0): a failure that depended on the request, or on the form of the answer, warns and allows", () => {
  for (const fr of ["invalid_json", "error_payload", "paid_but_status_405", "paid_but_status_404", "paid_but_status_422"]) {
    const d = decide(rec({ paid_verification_latest: { delivered: false, failure_reason: fr } }), req());
    assert.equal(d.action, "allow", fr); assert.equal(d.warn, true); assert.equal(d.rule, "latest_purchase_failed_request");
  }
  const q = decide(rec({ paid_verification_latest: { delivered: false, failure_reason: "stale_data" } }), req());
  assert.equal(q.rule, "latest_purchase_failed_quality"); assert.equal(q.action, "allow");
  // no reason on the record: not evidence that every buyer fails
  assert.equal(decide(rec({ paid_verification_latest: null, latest_purchase_delivered: false }), req()).warn, true);
  // strict restores 0.1
  assert.equal(decide(rec({ paid_verification_latest: { delivered: false, failure_reason: "invalid_json" } }), req(), { strict: true }).action, "block");
  // the later rules still apply on top of the warning
  assert.equal(decide(rec({ paid_verification_latest: { delivered: false, failure_reason: "invalid_json" } }), req({ payTo: "0x000000000000000000000000000000000000dEaD" })).rule, "payto_mismatch");
  assert.equal(decide(rec({ status: "failing", paid_verification_latest: { delivered: false, failure_reason: "invalid_json" } }), req()).rule, "failing");
});
test("failureKind", () => {
  assert.equal(failureKind("paid_but_status_502"), "any_buyer");
  assert.equal(failureKind("schema_mismatch"), "quality");
  assert.equal(failureKind("rejected_400_blind_request"), "request_dependent");
  assert.equal(failureKind(null), "request_dependent");
});
test("rule 2: failing, delisted, unstable payTo", () => {
  assert.equal(decide(rec({ status: "failing" }), req()).rule, "failing");
  assert.equal(decide({ match: "delisted", listing: { id: "x" } }, req()).action, "block");
  assert.equal(decide(rec({ payto_unstable: true }), req()).rule, "payto_unstable");
});
test("rule 3: payTo mismatch on the same network; case does not matter on EVM", () => {
  assert.equal(decide(rec(), req({ payTo: "0x000000000000000000000000000000000000dEaD" })).rule, "payto_mismatch");
  assert.equal(decide(rec(), req({ payTo: PAYTO.toUpperCase().replace("0X", "0x") })).action, "allow");
  assert.equal(decide(rec(), req({ network: "base" })).action, "allow");            // v1 name = same network
  assert.equal(decide(rec(), req({ network: "eip155:137", payTo: "0xabc" })).action, "allow"); // other network: not compared
});
test("rule 3: price above the record, with and without slack", () => {
  assert.equal(decide(rec(), req({ amount: "20001" })).rule, "price_above_record");
  assert.equal(decide(rec(), req({ amount: "24000" }), { priceSlack: 0.2 }).action, "allow");
  assert.equal(decide(rec(), req({ amount: "24001" }), { priceSlack: 0.2 }).rule, "price_above_record");
  assert.equal(decide(rec(), req({ amount: "100" })).action, "allow");
  assert.equal(decide(rec(), req({ amount: "999999", scheme: "upto" })).action, "allow"); // different scheme: not compared
  assert.equal(decide(rec(), req({ amount: undefined, maxAmountRequired: "30000" })).rule, "price_above_record"); // v1 field
});
test("rule 5: unknown and unverified follow the unknown policy", () => {
  assert.equal(decide({ match: "unknown" }, req()).action, "allow");
  assert.equal(decide({ match: "unknown" }, req(), { unknown: "block" }).action, "block");
  assert.equal(decide(rec({ status: "unverified" }), req()).rule, "unverified");
  assert.equal(decide(rec({ status: "unverified" }), req(), { unknown: "block" }).action, "block");
});
test("several listings on one path: only the payment address is compared", () => {
  const shared = { ...rec({ paid_verification_latest: { delivered: false }, status: "failing" }), match_basis: "path", path_listings: 3 };
  assert.equal(decide(shared, req({ amount: "999999" })).rule, "path_shared");
  assert.equal(decide(shared, req({ payTo: "0x000000000000000000000000000000000000dEaD" })).rule, "payto_mismatch");
  const single = { ...rec({ paid_verification_latest: { delivered: false, failure_reason: "paid_but_status_500" } }), match_basis: "path", path_listings: 1 };
  assert.equal(decide(single, req()).rule, "latest_purchase_failed");
});
test("lookup failure allows unless failClosed", () => {
  assert.equal(decide(null, req()).action, "allow");
  assert.equal(decide(null, req(), { failClosed: true }).action, "block");
});
test("sentinel payTo blocks", () => assert.equal(decide(rec({ payto_sentinel: true }), req()).rule, "payto_sentinel"));

test("lookupUrl strips query, fragment and credentials by default", () => {
  assert.equal(lookupUrl("https://u:p@Example.com/a/b?text=secret#x"), "https://example.com/a/b");
  assert.equal(lookupUrl("https://example.com/a?b=1", "keep"), "https://example.com/a?b=1");
  assert.equal(lookupUrl("ftp://example.com/a"), null);
  assert.equal(lookupUrl("nonsense"), null);
});

const fakeFetch = (status, body, seen = []) => async (u, init) => { seen.push({ u: String(u), init });
  return { status, ok: status < 400, json: async () => body }; };

test("check: sends origin+path only, caches, treats 404 as unknown, survives errors", async () => {
  const seen = [], cache = new Map();
  const d = await check("https://example.com/v1/x?text=my+private+words", req(), { fetch: fakeFetch(200, rec(), seen), cache });
  assert.equal(d.action, "allow");
  assert.ok(!seen[0].u.includes("private")); assert.ok(seen[0].u.includes("match=path"));
  assert.ok(seen[0].u.includes(encodeURIComponent("https://example.com/v1/x")));
  await check("https://example.com/v1/x?text=other", req(), { fetch: fakeFetch(200, rec(), seen), cache });
  assert.equal(seen.length, 1, "second call answered from cache");
  assert.equal((await check("https://e.com/a", req(), { fetch: fakeFetch(404, { match: "unknown" }), cache: new Map() })).rule, "unknown");
  assert.equal((await check("https://e.com/a", req(), { fetch: fakeFetch(503, {}), cache: new Map() })).rule, "lookup_failed");
  assert.equal((await check("https://e.com/a", req(), { fetch: async () => { throw new Error("down"); }, cache: new Map() })).rule, "lookup_failed");
  const slow = (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  assert.equal((await check("https://e.com/a", req(), { fetch: slow, timeoutMs: 20, cache: new Map() })).rule, "lookup_failed");
});

test("hook: aborts in enforce mode, never in observe mode, reports every decision", async () => {
  const bad = rec({ paid_verification_latest: { delivered: false, failure_reason: "paid_but_status_500" } });
  const ctx = { paymentRequired: { resource: { url: "https://example.com/p" } }, selectedRequirements: req() };
  const seen = [];
  const r = await nohumansGuard({ fetch: fakeFetch(200, bad), cache: new Map(), onDecision: (d) => seen.push(d) })(ctx);
  assert.equal(r.abort, true); assert.match(r.reason, /did not deliver/); assert.match(r.reason, /nohumans\.directory\/l\/abc/);
  assert.equal(await nohumansGuard({ mode: "observe", fetch: fakeFetch(200, bad), cache: new Map(), onDecision: (d) => seen.push(d) })(ctx), undefined);
  assert.equal(seen.length, 2);
  assert.equal(await nohumansGuard({ fetch: fakeFetch(200, rec()), cache: new Map(), onDecision: () => { throw new Error("x"); } })(ctx), undefined);
  assert.equal(await nohumansGuard({ fetch: fakeFetch(200, bad), cache: new Map() })({}), undefined, "no URL: nothing to check");
  const soft = rec({ paid_verification_latest: { delivered: false, failure_reason: "invalid_json" } });
  const warned = [];
  assert.equal(await nohumansGuard({ fetch: fakeFetch(200, soft), cache: new Map(), onDecision: (d) => warned.push(d) })(ctx), undefined, "a request-dependent failure does not abort");
  assert.equal(warned[0].warn, true);
});

test("reportOutcome signs the directory's message and posts it", async () => {
  const seen = []; let signed;
  const out = await reportOutcome({ listingId: "abc", ok: false, txHash: "0xABCD", signMessage: async (m) => { signed = m; return "0xsig"; },
    fetch: fakeFetch(200, { ok: true }, seen) });
  assert.equal(signed, "nohumans.directory report v1\nlisting_id: abc\ntx_hash: 0xabcd\nok: false");
  assert.deepEqual(JSON.parse(seen[0].init.body), { listing_id: "abc", ok: false, tx_hash: "0xabcd", payer_signature: "0xsig" });
  assert.equal(out.accepted, true);
  await assert.rejects(() => reportOutcome({ listingId: "a", ok: "yes", txHash: "0x1", signMessage: async () => "" }));
});
