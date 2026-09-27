/**
 * The buyer's x402 HTTP client.
 *
 * Implements the actual x402 payment flow using the x402 SDK (v0.6.x):
 *
 *   1. fetch(url)                      -> 402 Payment Required
 *   2. parse the 402 body              -> { x402Version, error?, accepts: [...] }
 *   3. delegate the payment decision   -> SpendingPolicy (via PaymentService)
 *   4. ONLY IF ACCEPTED:
 *        createPaymentHeader(...)      -> real EIP-712 signature via x402 SDK
 *        retry fetch with X-PAYMENT    -> x402 protocol retry
 *   5. read X-PAYMENT-RESPONSE header  -> settlement outcome (transaction hash)
 *
 * The policy decision and its persistence happen BEFORE any signing. A
 * refused payment is never signed and never submitted. The private key is
 * never handled here: a signer factory is injected, and the key itself lives
 * only in the environment.
 */
import { createPaymentHeader, selectPaymentRequirements } from "x402/client";
import { decodeXPaymentResponse } from "x402/shared";
import type { PaymentRequirements, Signer } from "x402/types";
import type { PaidFetchResult } from "../types/index.js";
import type { PaymentService } from "./payment-service.js";

/** A signer factory: returns the buyer's x402 signer. Created OUTSIDE this module so the private key never passes through tool arguments. */
export type SignerFactory = () => Promise<Signer>;

export interface X402ClientOptions {
  paymentService: PaymentService;
  signerFactory: SignerFactory;
  /** x402 protocol version (1). */
  x402Version?: number;
  /** Extra HTTP headers sent with every request (never credentials used for payment auth). */
  defaultHeaders?: Record<string, string>;
}

/** An x402 "402 Payment Required" response body. */
export interface X402PaymentRequiredBody {
  x402Version?: number;
  error?: unknown;
  accepts?: Array<Record<string, unknown>>;
}

export class X402Client {
  private readonly paymentService: PaymentService;
  private readonly signerFactory: SignerFactory;
  private readonly x402Version: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: X402ClientOptions) {
    this.paymentService = options.paymentService;
    this.signerFactory = options.signerFactory;
    this.x402Version = options.x402Version ?? 1;
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  /**
   * Paid fetch following the x402 protocol. Returns a PaidFetchResult with
   * the decision, ledger id, signing/submission state, and (when available)
   * the protected resource body.
   */
  async paidFetch(url: string, init: RequestInit = {}): Promise<PaidFetchResult> {
    // 1. First attempt without payment.
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(init.headers as Record<string, string> | undefined),
    };
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: `request failed before payment: ${describeError(error)}`,
        ledgerId: null,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    if (response.status !== 402) {
      // No payment required (open resource, or an unexpected status).
      const body = await safeText(response);
      return {
        url,
        ok: response.ok,
        decision: "ACCEPTED",
        reason: response.ok
          ? "no payment required (HTTP " + response.status + ")"
          : "no payment required, but request failed (HTTP " + response.status + ")",
        status: response.status,
        body,
        ledgerId: null,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    // 2. Parse the x402 payment requirement from the 402 response.
    const body = await safeText(response);
    let parsed: X402PaymentRequiredBody;
    try {
      parsed = JSON.parse(body ?? "") as X402PaymentRequiredBody;
    } catch {
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: "402 response body is not valid JSON; not a recognizable x402 payment requirement",
        status: response.status,
        body,
        ledgerId: null,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    const accepts = Array.isArray(parsed.accepts) ? parsed.accepts : [];
    if (accepts.length === 0) {
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: "402 response contained no payment requirements",
        status: response.status,
        body,
        ledgerId: null,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    // 3. Policy decision. The payment service validates network/asset/amount
    //    against trusted configuration, PERSISTS the decision, and only then
    //    allows signing.
    const serviceResult = await this.paymentService.decide(accepts, url, this.x402Version);

    if (serviceResult.decision === "REFUSED") {
      // 4. REJECT path: no signing, no payment, no second request.
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: serviceResult.reason,
        status: response.status,
        body,
        ledgerId: serviceResult.ledgerId,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    if (!serviceResult.requirements) {
      // Defensive: an ACCEPTED decision must carry the requirement to pay.
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: "internal error: accepted decision without payment requirements",
        status: response.status,
        body,
        ledgerId: serviceResult.ledgerId,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    // 5. ACCEPTED path: sign through the actual x402 SDK and retry.
    let paymentHeader: string;
    try {
      const signer = await this.signerFactory();
      const requirements = serviceResult.requirements as PaymentRequirements;
      paymentHeader = await createPaymentHeader(signer, this.x402Version, requirements);
    } catch (error) {
      // Signing failed: the persisted record stays paymentSigned=false.
      const message = describeError(error);
      await this.paymentService.markSigningFailure(serviceResult.ledgerId, message);
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: `payment signing failed: ${message}`,
        status: response.status,
        body,
        ledgerId: serviceResult.ledgerId,
        paymentSigned: false,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    await this.paymentService.markSigned(serviceResult.ledgerId);

    // 6. x402 protocol retry with the signed X-PAYMENT header.
    let retryResponse: Response;
    try {
      retryResponse = await fetch(url, {
        ...init,
        headers: { ...headers, "X-PAYMENT": paymentHeader },
      });
    } catch (error) {
      const message = describeError(error);
      await this.paymentService.markSubmissionFailure(serviceResult.ledgerId, message);
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: `signed payment retry failed: ${message}`,
        status: undefined,
        ledgerId: serviceResult.ledgerId,
        paymentSigned: true,
        paymentSubmitted: false,
        transactionHash: null,
      };
    }

    // 7. Read the settlement outcome from X-PAYMENT-RESPONSE (x402 standard header).
    const settleHeader = retryResponse.headers.get("X-PAYMENT-RESPONSE");
    let paymentSubmitted = false;
    let transactionHash: string | null = null;
    if (settleHeader) {
      try {
        const settle = decodeXPaymentResponse(settleHeader) as {
          success?: boolean;
          transaction?: string;
          network?: string;
          errorReason?: string;
        };
        paymentSubmitted = settle.success === true;
        transactionHash = typeof settle.transaction === "string" ? settle.transaction : null;
        if (!paymentSubmitted && settle.errorReason) {
          await this.paymentService.markSubmissionFailure(serviceResult.ledgerId, settle.errorReason);
        }
      } catch {
        // Settlement header present but unparseable; treat as not submitted.
      }
    }
    if (!paymentSubmitted) {
      await this.paymentService.markNotSubmitted(serviceResult.ledgerId);
    } else {
      await this.paymentService.markSubmitted(serviceResult.ledgerId, transactionHash);
    }

    const retryBody = await safeText(retryResponse);
    if (!retryResponse.ok) {
      return {
        url,
        ok: false,
        decision: "REFUSED",
        reason: `payment was signed and submitted but the protected request failed (HTTP ${retryResponse.status})`,
        status: retryResponse.status,
        body: retryBody,
        ledgerId: serviceResult.ledgerId,
        paymentSigned: true,
        paymentSubmitted,
        transactionHash,
      };
    }

    return {
      url,
      ok: true,
      decision: "ACCEPTED",
      reason: "payment accepted, signed and settled; protected resource received",
      status: retryResponse.status,
      body: retryBody,
      ledgerId: serviceResult.ledgerId,
      paymentSigned: true,
      paymentSubmitted,
      transactionHash,
    };
  }
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
