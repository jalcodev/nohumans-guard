export declare const VERSION: string;

export interface GuardOptions {
  /** "enforce" (default) stops a blocked payment; "observe" never stops one and only reports through onDecision. */
  mode?: "enforce" | "observe";
  /** What to do with an endpoint the directory has no verified record of. Default "allow". */
  unknown?: "allow" | "block";
  /** Allowed rise of the asked amount over the recorded one, as a fraction (0.2 = 20%). Default 0. */
  priceSlack?: number;
  /** Block when the directory cannot be reached. Default false: a lookup failure never stops a payment. */
  failClosed?: boolean;
  /** Block on ANY failed latest purchase, as 0.1.x did. Default false: only failures any buyer would hit block (0.2.0). */
  strict?: boolean;
  /** "strip" (default) sends only the endpoint's origin and path; "keep" sends the query string too (exact match). */
  query?: "strip" | "keep";
  /** Lookup timeout in milliseconds. Default 2500. */
  timeoutMs?: number;
  /** Seconds an answer is reused in memory. Default 60; 0 disables. */
  cacheSeconds?: number;
  /** Called with every decision, allowed or blocked. */
  onDecision?: (decision: Decision) => void;
  /** API origin. Default https://api.nohumans.directory */
  api?: string;
  fetch?: typeof globalThis.fetch;
  cache?: Map<string, unknown>;
}

export type Rule =
  | "ok" | "path_shared" | "unknown" | "unverified" | "lookup_failed" | "not_a_url" | "guard_error"
  | "latest_purchase_failed_request" | "latest_purchase_failed_quality"
  | "delisted" | "latest_purchase_failed" | "failing" | "payto_unstable"
  | "payto_mismatch" | "price_above_record" | "payto_sentinel";

export type FailureKind = "any_buyer" | "quality" | "request_dependent";

export interface Decision {
  action: "allow" | "block";
  /** true on an allowed payment the record has a concern about (0.2.0): a failed purchase that depended on the request or the form of the answer. */
  warn?: boolean;
  /** On a failed latest purchase: who it fails for. */
  failure_kind?: FailureKind;
  rule: Rule;
  reason: string;
  /** The directory's listing id, when the endpoint is listed. */
  listing_id?: string | null;
  /** The listing's public page. */
  record?: string | null;
  /** The URL that was looked up (query removed unless query: "keep"). */
  url?: string | null;
}

export interface Requirements {
  scheme?: string; network?: string; asset?: string; payTo?: string;
  amount?: string; maxAmountRequired?: string; resource?: string;
}

/** Who a failed purchase fails for, from its failure_reason (used when the record has no failure_kind). */
export declare function failureKind(reason: string | null | undefined): FailureKind;
/** The pay rules as a pure function over a /v1/resolve answer. */
export declare function decide(resolved: unknown, requirements?: Requirements, opts?: GuardOptions): Decision;
/** Look an endpoint URL up and apply the rules. Never throws on network errors. */
export declare function check(url: string, requirements?: Requirements, opts?: GuardOptions): Promise<Decision>;
/** The URL the guard sends for a given endpoint URL, or null if it is not http(s). */
export declare function lookupUrl(raw: string, query?: "strip" | "keep"): string | null;

/** A hook for x402Client.onBeforePaymentCreation. */
export declare function nohumansGuard(opts?: GuardOptions): (context: {
  paymentRequired?: { resource?: { url?: string } };
  selectedRequirements?: Requirements;
}) => Promise<void | { abort: true; reason: string }>;

export declare function reportOutcome(r: {
  listingId: string; ok: boolean; txHash: string;
  signMessage: (message: string) => Promise<string>;
  detail?: string; api?: string; fetch?: typeof globalThis.fetch;
}): Promise<{ accepted: boolean; status: number; body: unknown }>;
