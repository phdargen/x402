import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  AuthCaptureEvmScheme,
  type AuthCaptureRouteExtra,
} from "@x402/evm/auth-capture/server";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { config } from "dotenv";
import express, { type Express } from "express";
import { getAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

config();

export const NETWORK = "eip155:84532" as const;
export const DEFAULT_PORT = 4021;

export type AuthCaptureServerFlow = "delegated-sync" | "delegated-deferred" | "custom-escrow";

export interface AuthCaptureServerEnv {
  payTo: `0x${string}`;
  facilitatorUrl: string;
  receiverAuthorizer: `0x${string}`;
  receiverAuthorizerPrivateKey: `0x${string}` | undefined;
  customOperatorAddress: `0x${string}` | undefined;
}

export interface AuthCaptureServerContext {
  app: Express;
  scheme: AuthCaptureEvmScheme;
  httpServer: x402HTTPResourceServer;
  flow: AuthCaptureServerFlow;
  env: AuthCaptureServerEnv;
}

/**
 * Load and validate environment variables shared by all auth-capture server flows.
 *
 * @param flow - Which example flow is starting.
 * @returns Parsed environment values.
 */
export function loadAuthCaptureServerEnv(flow: AuthCaptureServerFlow): AuthCaptureServerEnv {
  const payTo = process.env.EVM_ADDRESS?.trim();
  const facilitatorUrl = process.env.FACILITATOR_URL?.trim();
  const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim() as
    | `0x${string}`
    | undefined;
  const customOperatorAddress = process.env.CUSTOM_OPERATOR_ADDRESS?.trim() as
    | `0x${string}`
    | undefined;

  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
    process.exit(1);
  }

  if (!facilitatorUrl) {
    console.error("Missing required FACILITATOR_URL environment variable");
    process.exit(1);
  }

  if (flow !== "custom-escrow") {
    if (!receiverAuthorizerPrivateKey) {
      console.error(
        "Missing EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (required for delegated sync/deferred lifecycle)",
      );
      process.exit(1);
    }
  } else {
    if (!customOperatorAddress || !/^0x[0-9a-fA-F]{40}$/.test(customOperatorAddress)) {
      console.error(
        "Missing or invalid CUSTOM_OPERATOR_ADDRESS (deploy x402AuthCaptureOperator and allowlist it on the facilitator)",
      );
      process.exit(1);
    }
  }

  const receiverAuthorizerAccount = receiverAuthorizerPrivateKey
    ? privateKeyToAccount(receiverAuthorizerPrivateKey)
    : undefined;

  return {
    payTo: getAddress(payTo) as `0x${string}`,
    facilitatorUrl,
    receiverAuthorizer: (receiverAuthorizerAccount?.address ?? zeroAddress) as `0x${string}`,
    receiverAuthorizerPrivateKey,
    customOperatorAddress: customOperatorAddress
      ? (getAddress(customOperatorAddress) as `0x${string}`)
      : undefined,
  };
}

/**
 * Build route `extra` for the selected auth-capture v1.1 flow.
 *
 * @param flow - Server flow identifier.
 * @param env - Parsed environment.
 * @returns Route extra checked against {@link AuthCaptureRouteExtra}.
 */
export function buildRouteExtra(
  flow: AuthCaptureServerFlow,
  env: AuthCaptureServerEnv,
): AuthCaptureRouteExtra {
  const shared = {
    feeRecipient: zeroAddress,
    minFeeBps: 0,
    maxFeeBps: 0,
    captureDeadlineSeconds: 3600,
    refundDeadlineSeconds: 7200,
  } as const;

  if (flow === "delegated-sync") {
    return {
      ...shared,
      operatorType: "delegated",
      paymentFlow: "escrow",
      captureMode: "sync",
      receiverAuthorizer: env.receiverAuthorizer,
    } satisfies AuthCaptureRouteExtra;
  }

  if (flow === "delegated-deferred") {
    return {
      ...shared,
      operatorType: "delegated",
      paymentFlow: "escrow",
      captureMode: "deferred",
      receiverAuthorizer: env.receiverAuthorizer,
    } satisfies AuthCaptureRouteExtra;
  }

  return {
    ...shared,
    captureAuthorizer: env.customOperatorAddress!,
    operatorType: "custom",
    paymentFlow: "escrow",
    captureMode: "deferred",
  } satisfies AuthCaptureRouteExtra;
}

/**
 * Create the Express app, auth-capture scheme, and HTTP resource server for a flow.
 *
 * @param flow - Which example flow to configure.
 * @returns Initialized server context (call `startAuthCaptureServer` to listen).
 */
export function createAuthCaptureServer(flow: AuthCaptureServerFlow): AuthCaptureServerContext {
  const env = loadAuthCaptureServerEnv(flow);
  const facilitatorClient = new HTTPFacilitatorClient({ url: env.facilitatorUrl });

  const authorizerSigner = env.receiverAuthorizerPrivateKey
    ? privateKeyToAccount(env.receiverAuthorizerPrivateKey)
    : undefined;

  const scheme =
    flow === "custom-escrow"
      ? new AuthCaptureEvmScheme()
      : new AuthCaptureEvmScheme({
          lifecycle: {
            authorizerSigner: authorizerSigner!,
            facilitator: facilitatorClient,
          },
        });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);

  const routeExtra = buildRouteExtra(flow, env);
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /weather": {
      accepts: {
        scheme: "auth-capture",
        price: "$0.01",
        network: NETWORK,
        payTo: env.payTo,
        extra: routeExtra,
      },
      description: "Weather data",
      mimeType: "application/json",
    },
  });

  const app = express();

  return { app, scheme, httpServer, flow, env };
}

/**
 * Register demo admin routes for deferred capture (same-process in-memory storage).
 *
 * @param ctx - Server context from {@link createAuthCaptureServer}.
 * @returns Nothing.
 */
export function registerDeferredAdminRoutes(ctx: AuthCaptureServerContext): void {
  ctx.app.get("/admin/payments", async (_req, res) => {
    try {
      const payments = await ctx.scheme.listAuthorizedPayments();
      res.json(
        payments.map(payment => ({
          paymentInfoHash: payment.paymentInfoHash,
          capturableAmount: payment.capturableAmount,
          refundableAmount: payment.refundableAmount,
          collectTransaction: payment.collectTransaction,
          createdAt: payment.createdAt,
        })),
      );
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  ctx.app.post("/admin/capture", async (req, res) => {
    try {
      const paymentInfoHash = req.body?.paymentInfoHash as `0x${string}` | undefined;
      if (!paymentInfoHash) {
        return res.status(400).json({ error: "paymentInfoHash is required" });
      }

      const amount = req.body?.amount as string | undefined;
      const voidRemainder = Boolean(req.body?.voidRemainder);

      const response = await ctx.scheme.capture(
        paymentInfoHash,
        amount ? { amount, voidRemainder } : undefined,
      );
      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  ctx.app.post("/admin/void", async (req, res) => {
    try {
      const paymentInfoHash = req.body?.paymentInfoHash as `0x${string}` | undefined;
      if (!paymentInfoHash) {
        return res.status(400).json({ error: "paymentInfoHash is required" });
      }

      const response = await ctx.scheme.voidPayment(paymentInfoHash);
      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

/**
 * Start listening after capability checks succeed.
 *
 * @param ctx - Server context from {@link createAuthCaptureServer}.
 * @param options - Optional listen port override.
 * @returns Resolves when the server is listening.
 */
export async function startAuthCaptureServer(
  ctx: AuthCaptureServerContext,
  options?: { port?: number },
): Promise<void> {
  await ctx.httpServer.initialize();

  ctx.app.use(paymentMiddlewareFromHTTPServer(ctx.httpServer, undefined, undefined, false));

  ctx.app.get("/weather", (_req, res) => {
    if (ctx.flow === "delegated-sync") {
      const chargedPercent = 1 + Math.floor(Math.random() * 100);
      setSettlementOverrides(res, { amount: `${chargedPercent}%` });
    }

    res.send({
      report: {
        weather: "sunny",
        temperature: 70,
        flow: ctx.flow,
      },
    });
  });

  const port = options?.port ?? DEFAULT_PORT;

  ctx.app.listen(port, () => {
    console.log(`Auth-capture server (${ctx.flow}) listening at http://localhost:${port}`);
    console.log("  GET /weather");
    if (ctx.flow === "delegated-deferred") {
      console.log("  GET /admin/payments");
      console.log("  POST /admin/capture  { paymentInfoHash, amount?, voidRemainder? }");
      console.log("  POST /admin/void     { paymentInfoHash }");
      console.log("  Deferred captures use in-memory storage — call admin routes before restart.");
    }
    if (ctx.flow === "custom-escrow") {
      console.log(`  Custom operator: ${ctx.env.customOperatorAddress}`);
      console.log("  Collect-only: capture/void/refund run out of band on the operator contract.");
    }
    if (ctx.flow !== "custom-escrow") {
      console.log(`  Receiver authorizer: ${ctx.env.receiverAuthorizer}`);
      console.log("  Capture authorizer: resolved from facilitator /supported signers per request");
    }
  });
}
