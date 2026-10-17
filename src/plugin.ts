import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";
const ORIGIN = "https://api.stakao.com";
const STATUS_URL = `${ORIGIN}/agent/allocation-analysis/reference-status`;
const PRICE_ATOMIC = "3000000";
const FETCH_TIMEOUT_MS = 4_000;

const payableId = z.enum([
  "quant_strat",
  "ai_agent",
  "price_top_10",
  "price_top_20",
  "theme_compute",
  "theme_inference_training",
  "theme_prediction",
  "theme_agents",
]);

const names: Record<z.infer<typeof payableId>, string> = {
  quant_strat: "Quant Core",
  ai_agent: "AI Agent",
  price_top_10: "Top 10 Market Cap",
  price_top_20: "Top 20 Market Cap",
  theme_compute: "Compute",
  theme_inference_training: "Inference / Training",
  theme_prediction: "Market Intelligence",
  theme_agents: "Agents",
};

const proposalSchema = x402OutputSchema.shape["io.paybox/transactionProposal"];

const freshFields = {
  catalog_item_id: payableId,
  generated_at: z.string().nullable(),
  age_seconds: z.number().int().nonnegative().nullable(),
  stale: z.boolean(),
};

const outputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("unchanged"), ...freshFields }).strict(),
  z.object({ outcome: z.literal("not_payable"), ...freshFields }).strict(),
  z.object({
    outcome: z.literal("payable"),
    ...freshFields,
    "io.paybox/transactionProposal": proposalSchema,
  }).strict(),
]);

type PayableId = z.infer<typeof payableId>;
type SnapshotOutput = z.infer<typeof outputSchema>;

const statusOutputSchema = z.object({
  catalog_item_id: payableId,
  generated_at: z.string().nullable(),
  age_seconds: z.number().int().nonnegative().nullable(),
  stale: z.boolean(),
  ready: z.boolean(),
}).strict();

type StatusOutput = z.infer<typeof statusOutputSchema>;

type ReferenceItem = {
  generated_at: string;
  age_seconds: number | null;
  stale: boolean;
  ready: boolean;
};

function portfolioUrl(id: PayableId): string {
  const url = new URL("/agent/allocation-analysis/model-portfolio", ORIGIN);
  url.searchParams.set("catalog_item_id", id);
  return url.toString();
}

function sameInstant(known: string, generatedAt: string): boolean {
  if (known === generatedAt) return true;
  const left = Date.parse(known);
  const right = Date.parse(generatedAt);
  return Number.isFinite(left) && left === right;
}

function readItem(body: unknown, id: PayableId): ReferenceItem | null {
  if (body === null || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) return null;
  const found = body.items.find((item) => (
    item !== null && typeof item === "object" && "catalog_item_id" in item && item.catalog_item_id === id
  ));
  if (found === null || typeof found !== "object") return null;
  if (!("generated_at" in found) || typeof found.generated_at !== "string" || found.generated_at.length === 0) return null;
  const age = "age_seconds" in found && typeof found.age_seconds === "number" && Number.isInteger(found.age_seconds) && found.age_seconds >= 0
    ? found.age_seconds
    : null;
  const stale = "stale" in found && found.stale === true;
  const ready = "status" in found && found.status === "completed" && !stale;
  return { generated_at: found.generated_at, age_seconds: age, stale, ready };
}

async function referenceItem(id: PayableId): Promise<ReferenceItem | null> {
  try {
    const response = await fetch(STATUS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readItem(await response.json(), id);
  } catch {
    return null;
  }
}

function statusResult(text: string, structured: SnapshotOutput) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: outputSchema.parse(structured),
  };
}

function freeStatusResult(text: string, structured: StatusOutput) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: statusOutputSchema.parse(structured),
  };
}

function createServer() {
  const server = new McpServer(
    { name: "stakao-snapshot", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool("strategy_status", {
    title: "Stakao strategy status",
    description: "Reads the public freshness status for one Stakao strategy. This free check never fetches a premium allocation, proposes a payment, selects a wallet, or performs a transaction.",
    inputSchema: z.object({ catalog_item_id: payableId }).strict(),
    outputSchema: statusOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ catalog_item_id: id }) => {
    const item = await referenceItem(id);
    const label = names[id];
    if (item === null) {
      return freeStatusResult(
        `${label} status could not be read. No payment is required.`,
        { catalog_item_id: id, generated_at: null, age_seconds: null, stale: true, ready: false },
      );
    }
    return freeStatusResult(
      `${label} is ${item.ready ? "ready" : "not ready"}. No payment is required. generated_at is ${item.generated_at}.`,
      {
        catalog_item_id: id,
        generated_at: item.generated_at,
        age_seconds: item.age_seconds,
        stale: item.stale || !item.ready,
        ready: item.ready,
      },
    );
  });

  server.registerTool("strategy_snapshot", {
    title: "Stakao snapshot",
    description: "Checks whether a Stakao Premium model portfolio snapshot is new, then proposes a 3 USDC payment on Base only when it is. catalog_item_id is one of quant_strat, ai_agent, price_top_10, price_top_20, theme_compute, theme_inference_training, theme_prediction, theme_agents. Pass known_generated_at from the previous result to skip payment when that snapshot is still current. Omit it to propose payment for the current snapshot. The result is an allocation table, not a staking action. PayBox asks the user to approve before anything is paid.",
    inputSchema: z.object({
      catalog_item_id: payableId,
      known_generated_at: z.string().min(1).max(80).optional(),
    }).strict(),
    outputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ catalog_item_id: id, known_generated_at: known }) => {
    const item = await referenceItem(id);
    const label = names[id];
    if (item === null) {
      return statusResult(
        `${label} freshness could not be read. Do not pay.`,
        { outcome: "not_payable", catalog_item_id: id, generated_at: null, age_seconds: null, stale: true },
      );
    }
    const fields = {
      catalog_item_id: id,
      generated_at: item.generated_at,
      age_seconds: item.age_seconds,
      stale: item.stale || !item.ready,
    };
    if (!item.ready) {
      return statusResult(
        `${label} snapshot is not payable. It is stale or unfinished. Do not pay. generated_at is ${item.generated_at}.`,
        { outcome: "not_payable", ...fields },
      );
    }
    if (known !== undefined && sameInstant(known, item.generated_at)) {
      return statusResult(
        `${label} snapshot is unchanged since ${item.generated_at}. Do not pay.`,
        { outcome: "unchanged", ...fields, stale: false },
      );
    }
    const prepared = proposeX402({
      chain: "eip155:8453",
      url: portfolioUrl(id),
      maxAmount: PRICE_ATOMIC,
    });
    const proposal = prepared.structuredContent["io.paybox/transactionProposal"];
    return statusResult(
      `${label} has a new snapshot at ${item.generated_at}. Approve 3 USDC on Base to fetch the allocation table. Store generated_at and pass it as known_generated_at next time. Nothing has been paid yet.`,
      { outcome: "payable", ...fields, stale: false, "io.paybox/transactionProposal": proposal },
    );
  });

  return server;
}

serveStdio(createServer, { legacy: "reject" });
