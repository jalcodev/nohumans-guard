# nohumans-guard

Check an x402 endpoint against [nohumans.directory](https://nohumans.directory) before your agent signs a payment.

A valid HTTP 402 says an endpoint asks for money. It does not say the endpoint delivers after it is paid. nohumans.directory probes every listing and buys many of them with real USDC, and records what came back. This package reads that record at the one moment it matters: after the 402 arrives, before anything is signed.

```sh
npm install nohumans-guard
```

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { nohumansGuard } from "nohumans-guard";

const client = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));
client.onBeforePaymentCreation(nohumansGuard());

const fetchWithPay = wrapFetchWithPayment(fetch, client);
```

A blocked payment makes the paid fetch throw before a signature exists; the message says why and links the record. No key, no account, no dependencies. Node 18 or later.

## Works with

The hook goes on the `x402Client`, so it is the same line whichever official wrapper carries the payment (tested with version 2.31 of each):

| Package | How the client is used |
|---|---|
| `@x402/fetch` | `wrapFetchWithPayment(fetch, client)` |
| `@x402/axios` | `wrapAxiosWithPayment(axios.create(), client)` |
| `@x402/mcp` | `wrapMCPClientWithPayment(mcpClient, client)`: accepted, but see below |

Agent frameworks (LangChain, the OpenAI Agents SDK, the Vercel AI SDK and others) do not pay by themselves; their tools pay through one of these clients, so the guard goes wherever that client is built.

Not covered in this version: a paid MCP tool call names its resource `mcp://tool/<name>`, which is not a URL the directory can look up, so those payments pass through unchecked (`not_a_url`). Paid HTTP endpoints are covered.

## What it blocks

The directory's published pay rules, in order; the first that matches decides.

| Rule | Blocks when |
|---|---|
| `delisted` | the endpoint was listed and later removed |
| `latest_purchase_failed` | the directory's most recent real purchase settled and did not deliver |
| `failing` | the endpoint is failing the directory's checks |
| `payto_unstable` | its payment address keeps changing |
| `payto_mismatch` | the 402 names a different payment address than the record, on the same network |
| `price_above_record` | the 402 asks more than the recorded price (same network, asset and scheme) |
| `payto_sentinel` | the payment address is a zero or burn address |

Everything else is allowed, with the reason attached: `ok`, `unknown` (never listed: most of the web), `unverified`, `path_shared` (several listings share the path; only the payment address was compared), `lookup_failed`.

It is dated evidence about an endpoint's behaviour, not a guarantee and not a safety rating. A patient seller that keeps its address and answers well-formed responses passes every check here.

## Options

```js
nohumansGuard({
  mode: "enforce",      // "observe" never blocks; it only calls onDecision
  unknown: "allow",     // "block" = pay only endpoints with a verified record
  priceSlack: 0,        // 0.2 allows the asked price to be up to 20% above the record
  failClosed: false,    // true = block when the directory cannot be reached
  query: "strip",       // "keep" sends the query string too (exact match)
  timeoutMs: 2500,
  cacheSeconds: 60,
  onDecision: (d) => console.log(d.action, d.rule, d.record),
});
```

Start with `mode: "observe"` if you want to see what it would have stopped before letting it stop anything.

## What leaves your process

One GET per endpoint per minute at most: `https://api.nohumans.directory/v1/resolve?url=<origin + path>&match=path`. The query string is removed by default, so your query values are not sent. Never sent: the request body, headers, the payment, your wallet address. The directory logs the host and path looked up and a hash of the caller's IP address ([privacy](https://nohumans.directory/privacy)).

If the lookup fails or takes longer than `timeoutMs`, the payment goes ahead (unless `failClosed`).

## Without the hook

```js
import { check } from "nohumans-guard";

const d = await check("https://api.example.com/v1/quote", { network: "eip155:8453", payTo, asset, amount });
if (d.action === "block") throw new Error(d.reason);
```

`decide(resolveAnswer, requirements, options)` is the same rules as a pure function, for callers that already hold a `/v1/resolve` answer.

## Reporting what you got (optional)

After a payment on Base, the wallet that paid can report whether it delivered. Reports count toward ranking once three different payers have reported a listing.

```js
import { reportOutcome } from "nohumans-guard";

await reportOutcome({
  listingId: decision.listing_id,
  ok: true,                                   // did it deliver what it promised?
  txHash,                                     // your payment's transaction on Base
  signMessage: (message) => account.signMessage({ message }),   // the wallet that paid
});
```

## Links

Rules: https://nohumans.directory/integrate#rules · Method: https://nohumans.directory/methodology · API: https://api.nohumans.directory/openapi.json

MIT
