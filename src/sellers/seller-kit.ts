/**
 * Shared seller HTTP server kit.
 *
 * Both the honest and the rogue seller are built on the actual x402-express
 * paymentMiddleware with a configurable facilitator. The only difference is
 * the requested price (and metadata). The route handler serves a small,
 * deterministic JSON research resource.
 */
import express from "express";
import { paymentMiddleware } from "x402-express";
import type { Server } from "node:http";

export interface SellerOptions {
  /** "honest" | "rogue" — used for logging and demo output only. */
  kind: "honest" | "rogue";
  /** x402 price, e.g. "$0.01" (USDC dollars) or an ERC20TokenAmount object. */
  price: string | { amount: string; asset: { address: `0x${string}`; decimals: number; eip712?: { name: string; version: string } } };
  network: "base-sepolia" | "base";
  description: string;
  resourcePath: string;
  payTo: `0x${string}`;
  port: number;
  facilitatorUrl: string;
}

export interface SellerServer {
  server: Server;
  port: number;
  url: string;
  /** URL of the seller's own payment-observability endpoint. */
  statsUrl: string;
  options: SellerOptions;
  close(): Promise<void>;
}

/**
 * Build the seller express app. paymentMiddleware protects resourcePath; the
 * resource handler records that the resource was actually served.
 */
export function createSellerApp(options: SellerOptions) {
  const app = express();

  /** Server-side observation: how many times the protected resource was served. */
  const stats = { resourceServed: 0 };

  app.use(
    paymentMiddleware(
      options.payTo,
      {
        [options.resourcePath]: {
          price: options.price,
          network: options.network,
          config: {
            description: options.description,
            mimeType: "application/json",
            maxTimeoutSeconds: 60,
          },
        },
      },
      { url: options.facilitatorUrl as `${string}://${string}` },
    ),
  );

  app.get(options.resourcePath, (_req, res) => {
    stats.resourceServed++;
    res.json({
      seller: options.kind,
      resource: options.resourcePath,
      description: options.description,
      report: {
        title: "x402 Market Research Report",
        summary:
          options.kind === "honest"
            ? "Payment accepted by the buyer purse; this is the protected research content."
            : "This content should never be reachable by a policy-compliant buyer: the price exceeds the per-call ceiling.",
        generatedBy: "local deterministic seller",
      },
    });
  });

  /** Observability endpoint: server-side counters (no credentials). */
  app.get("/__seller-stats", (_req, res) => {
    res.json({ kind: options.kind, ...stats });
  });

  return { app, stats };
}

/** Start the seller on the configured port (0 = ephemeral). */
export async function startSellerServer(options: SellerOptions): Promise<SellerServer> {
  const { app, stats } = createSellerApp(options);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(options.port, "127.0.0.1");
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    statsUrl: `http://127.0.0.1:${port}/__seller-stats`,
    options,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
