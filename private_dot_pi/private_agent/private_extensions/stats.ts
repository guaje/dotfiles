import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_PATH = path.resolve(__dirname, "../models.json");

export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelsFile {
  providers?: Record<string, { models?: Array<{ id?: string; cost?: Partial<CostRates> }> }>;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cost?: { total?: number } | number;
}

export interface ModelBucket {
  model: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SubagentRow {
  agent: string;
  task: string;
  model: string;
  modelSelector?: string;
  thinkingLevel?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost: number;
  failed: boolean;
}

export interface StatsSummary {
  main: ModelBucket[];
  subagents: SubagentRow[];
  modelChanges: Array<{ provider: string; modelId: string; timestamp?: string }>;
  hasCost: boolean;
  hasNotionalCost: boolean;
}

interface StatsTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PASSTHROUGH_STATS_THEME: StatsTheme = { fg: (_c, t) => t, bold: (t) => t };

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function loadModelCostRates(modelsPath = MODELS_PATH): Promise<Map<string, CostRates>> {
  const rates = new Map<string, CostRates>();
  const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as ModelsFile;
  for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (!model.id || !model.cost) continue;
      rates.set(`${providerId}/${model.id}`, {
        input: num(model.cost.input),
        output: num(model.cost.output),
        cacheRead: num(model.cost.cacheRead),
        cacheWrite: num(model.cost.cacheWrite),
      });
    }
  }
  return rates;
}

export function calculateUsageCost(usage: UsageLike | undefined, rates: CostRates | undefined): number {
  if (!usage) return 0;
  if (!rates) return typeof usage.cost === "number" ? usage.cost : num(usage.cost?.total);

  const input = (rates.input / 1_000_000) * num(usage.input);
  const output = (rates.output / 1_000_000) * num(usage.output);
  const cacheRead = (rates.cacheRead / 1_000_000) * num(usage.cacheRead);
  const longWrite = num(usage.cacheWrite1h);
  const shortWrite = Math.max(0, num(usage.cacheWrite) - longWrite);
  const cacheWrite = ((rates.cacheWrite * shortWrite) + (rates.input * 2 * longWrite)) / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

function addToBucket(bucket: ModelBucket, usage: UsageLike, cost: number): void {
  bucket.turns += 1;
  bucket.input += num(usage.input);
  bucket.output += num(usage.output);
  bucket.cacheRead += num(usage.cacheRead);
  bucket.cacheWrite += num(usage.cacheWrite);
  bucket.cost += cost;
}

export function extractStats(entries: Array<any>, costRates: Map<string, CostRates> = new Map()): StatsSummary {
  const mainByModel = new Map<string, ModelBucket>();
  const subagents: SubagentRow[] = [];
  const modelChanges: StatsSummary["modelChanges"] = [];
  let hasCost = false;
  let hasNotionalCost = false;

  for (const entry of entries ?? []) {
    if (entry?.type === "model_change") {
      if (entry.provider && entry.modelId) modelChanges.push({ provider: entry.provider, modelId: entry.modelId, timestamp: entry.timestamp });
      continue;
    }

    if (entry?.type !== "message") continue;
    const message = entry.message;

    if (message?.role === "assistant") {
      const model = message.provider && message.model ? `${message.provider}/${message.model}` : message.model || "(unknown)";
      const usage = message.usage as UsageLike | undefined;
      const rates = costRates.get(model);
      const cost = calculateUsageCost(usage, rates);
      if (cost > 0) hasCost = true;
      if (rates) hasNotionalCost = true;
      const bucket = mainByModel.get(model) ?? { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      addToBucket(bucket, usage ?? {}, cost);
      mainByModel.set(model, bucket);
      continue;
    }

    if (message?.role === "toolResult" && message.toolName === "subagent") {
      for (const result of message.details?.results ?? []) {
        const usage = result?.usage as UsageLike | undefined;
        const model = typeof result?.model === "string" && result.model.length > 0 ? result.model : "(default)";
        const rates = costRates.get(model);
        const cost = calculateUsageCost(usage, rates);
        if (cost > 0) hasCost = true;
        if (rates) hasNotionalCost = true;
        subagents.push({
          agent: typeof result?.agent === "string" ? result.agent : "(unknown)",
          task: typeof result?.task === "string" ? result.task : "",
          model,
          modelSelector: result?.modelSelector,
          thinkingLevel: result?.thinkingLevel,
          input: num(usage?.input),
          output: num(usage?.output),
          cacheRead: num(usage?.cacheRead),
          cacheWrite: num(usage?.cacheWrite),
          turns: num(usage?.turns),
          cost,
          failed: result?.exitCode !== 0 || result?.stopReason === "error" || result?.stopReason === "aborted",
        });
      }
    }
  }

  return {
    main: [...mainByModel.values()].sort((a, b) => b.cost - a.cost || b.turns - a.turns || a.model.localeCompare(b.model)),
    subagents: subagents.sort((a, b) =>
      a.model.localeCompare(b.model) ||
      a.agent.localeCompare(b.agent) ||
      (a.thinkingLevel ?? "").localeCompare(b.thinkingLevel ?? "") ||
      (a.modelSelector ?? "").localeCompare(b.modelSelector ?? ""),
    ),
    modelChanges,
    hasCost,
    hasNotionalCost,
  };
}

function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function fmtTokens(tokens: number): string {
  if (Math.abs(tokens) < 1_000) return String(Math.round(tokens));
  if (Math.abs(tokens) < 1_000_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function fmtCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function mainRow(bucket: ModelBucket, theme: StatsTheme, hasCost: boolean): string {
  const model = theme.fg("text", truncate(bucket.model, 30).padEnd(30));
  const values = [
    String(bucket.turns).padStart(5),
    fmtTokens(bucket.input).padStart(8),
    fmtTokens(bucket.output).padStart(8),
    fmtTokens(bucket.cacheRead + bucket.cacheWrite).padStart(8),
  ];
  if (hasCost) values.push(fmtCost(bucket.cost).padStart(8));
  return `  ${model}  ${theme.fg("toolOutput", values.join("  "))}`;
}

function subagentValues(row: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost">, hasCost: boolean): string {
  const values = [
    String(num(row.turns)).padStart(5),
    fmtTokens(num(row.input)).padStart(8),
    fmtTokens(num(row.output)).padStart(8),
    fmtTokens(num(row.cacheRead) + num(row.cacheWrite)).padStart(8),
  ];
  if (hasCost) values.push(fmtCost(num(row.cost)).padStart(8));
  return values.join("  ");
}

function subagentRow(row: SubagentRow, theme: StatsTheme, hasCost: boolean): string {
  const model = truncate(row.model, 28).padEnd(28);
  const agent = truncate(row.agent, 12).padEnd(12);
  const thinking = truncate(row.thinkingLevel ?? "—", 7).padEnd(7);
  const selector = truncate(row.modelSelector ?? "—", 9).padEnd(9);
  const left = row.failed
    ? theme.fg("error", [model, agent, thinking, selector].join("  "))
    : [
      theme.fg("text", model),
      theme.fg("thinkingText", agent),
      theme.fg("thinkingText", thinking),
      theme.fg("thinkingText", selector),
    ].join("  ");
  const suffix = row.failed ? "  ✗" : "";
  return `  ${left}  ${theme.fg("toolOutput", subagentValues(row, hasCost))}${row.failed ? theme.fg("error", suffix) : suffix}`;
}

function addSubagentTotals(
  total: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost">,
  row: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost">,
): void {
  total.input += num(row.input);
  total.output += num(row.output);
  total.cacheRead += num(row.cacheRead);
  total.cacheWrite += num(row.cacheWrite);
  total.turns += num(row.turns);
  total.cost += num(row.cost);
}

function subagentSummaryRow(
  labelModel: string,
  labelAgent: string,
  total: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost">,
  theme: StatsTheme,
  hasCost: boolean,
  emphasis: "subtotal" | "total" = "subtotal",
): string {
  const modelLabel = emphasis === "subtotal" ? `↳ ${labelModel}` : labelModel;
  const left = [
    truncate(modelLabel, 28).padEnd(28),
    truncate(labelAgent, 12).padEnd(12),
    "".padEnd(7),
    "".padEnd(9),
  ].join("  ");
  const values = subagentValues(total, hasCost);
  if (emphasis === "total") {
    return `  ${theme.fg("accent", theme.bold(left))}  ${theme.fg("accent", theme.bold(values))}`;
  }
  return `  ${theme.fg("muted", left)}  ${theme.fg("toolOutput", values)}`;
}

function addBucketTotals(total: ModelBucket, bucket: Pick<ModelBucket, "turns" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost">): void {
  total.turns += bucket.turns;
  total.input += bucket.input;
  total.output += bucket.output;
  total.cacheRead += bucket.cacheRead;
  total.cacheWrite += bucket.cacheWrite;
  total.cost += bucket.cost;
}

function zeroBucket(model = "Total"): ModelBucket {
  return { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function formatStatsTable(summary: StatsSummary, theme: StatsTheme = PASSTHROUGH_STATS_THEME): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("mdLink", theme.bold("Session stats")));

  if (summary.main.length === 0 && summary.subagents.length === 0) {
    lines.push("");
    lines.push(theme.fg("muted", "No usage data available for this session."));
    return lines;
  }

  const mainTotal = zeroBucket("Main session total");
  const subagentTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 };

  if (summary.main.length > 0) {
    const header = `${"Model".padEnd(30)}  ${"Turns".padStart(5)}  ${"In".padStart(8)}  ${"Out".padStart(8)}  ${"Cache".padStart(8)}${summary.hasCost ? `  ${"Cost".padStart(8)}` : ""}`;
    lines.push("");
    lines.push(theme.fg("mdHeading", theme.bold("Main session")));
    lines.push(`  ${theme.fg("dim", header)}`);
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);
    for (const bucket of summary.main) {
      addBucketTotals(mainTotal, bucket);
      lines.push(mainRow(bucket, theme, summary.hasCost));
    }
    const mainTotalValues = [
      String(mainTotal.turns).padStart(5),
      fmtTokens(mainTotal.input).padStart(8),
      fmtTokens(mainTotal.output).padStart(8),
      fmtTokens(mainTotal.cacheRead + mainTotal.cacheWrite).padStart(8),
      ...(summary.hasCost ? [fmtCost(mainTotal.cost).padStart(8)] : []),
    ].join("  ");
    lines.push(`  ${theme.fg("accent", theme.bold("Main session total".padEnd(30)))}  ${theme.fg("accent", theme.bold(mainTotalValues))}`);
  }

  if (summary.subagents.length > 0) {
    const header = `${"Model".padEnd(28)}  ${"Agent".padEnd(12)}  ${"Think".padEnd(7)}  ${"Selector".padEnd(9)}  ${"Turns".padStart(5)}  ${"In".padStart(8)}  ${"Out".padStart(8)}  ${"Cache".padStart(8)}${summary.hasCost ? `  ${"Cost".padStart(8)}` : ""}`;
    lines.push("");
    lines.push(theme.fg("mdHeading", theme.bold("Subagents")));
    lines.push(`  ${theme.fg("dim", header)}`);
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);

    let currentModel: string | undefined;
    let modelTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 };
    const flushModelTotal = () => {
      if (!currentModel) return;
      lines.push(subagentSummaryRow(currentModel, "Subtotal", modelTotal, theme, summary.hasCost));
    };

    for (const row of summary.subagents) {
      if (currentModel !== undefined && row.model !== currentModel) {
        flushModelTotal();
        modelTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 };
      }
      currentModel = row.model;
      addSubagentTotals(modelTotal, row);
      addSubagentTotals(subagentTotal, row);
      lines.push(subagentRow(row, theme, summary.hasCost));
    }
    flushModelTotal();
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);
    lines.push(subagentSummaryRow("Subagents total", "", subagentTotal, theme, summary.hasCost, "total"));
  }

  if (summary.main.length > 0 || summary.subagents.length > 0) {
    const combined = zeroBucket("Main + Subagents total");
    addBucketTotals(combined, mainTotal);
    combined.turns += subagentTotal.turns;
    combined.input += subagentTotal.input;
    combined.output += subagentTotal.output;
    combined.cacheRead += subagentTotal.cacheRead;
    combined.cacheWrite += subagentTotal.cacheWrite;
    combined.cost += subagentTotal.cost;
    const header = `${"Scope".padEnd(30)}  ${"Turns".padStart(5)}  ${"In".padStart(8)}  ${"Out".padStart(8)}  ${"Cache".padStart(8)}${summary.hasCost ? `  ${"Cost".padStart(8)}` : ""}`;
    lines.push("");
    lines.push(theme.fg("mdHeading", theme.bold("Session total")));
    lines.push(`  ${theme.fg("dim", header)}`);
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);
    const combinedValues = [
      String(combined.turns).padStart(5),
      fmtTokens(combined.input).padStart(8),
      fmtTokens(combined.output).padStart(8),
      fmtTokens(combined.cacheRead + combined.cacheWrite).padStart(8),
      ...(summary.hasCost ? [fmtCost(combined.cost).padStart(8)] : []),
    ].join("  ");
    lines.push(`  ${theme.fg("accent", theme.bold(combined.model.padEnd(30)))}  ${theme.fg("accent", theme.bold(combinedValues))}`);
  }

  if (summary.hasNotionalCost) {
    lines.push("");
    lines.push(theme.fg("muted", "Costs use notional commercial-equivalent rates from models.json."));
  }

  return lines;
}

function statsMessageRenderer(
  message: { details?: StatsSummary },
  _options: { expanded: boolean },
  theme: StatsTheme,
) {
  const container = new Container();
  for (const line of formatStatsTable(message.details ?? { main: [], subagents: [], modelChanges: [], hasCost: false, hasNotionalCost: false }, theme)) {
    container.addChild(new Text(line, 1, 0));
  }
  return container;
}

export async function renderStatsTable(summary: StatsSummary, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const ui = ctx.ui as { theme?: StatsTheme; notify?: (message: string, type?: "info" | "warning" | "error") => void };
  const sendMessage = (pi as { sendMessage?: (message: unknown, options?: { triggerTurn?: boolean }) => Promise<void> }).sendMessage;
  if (ctx.mode === "tui" && typeof sendMessage === "function") {
    await sendMessage({ customType: "stats", content: "", display: true, details: summary }, { triggerTurn: false });
    return;
  }
  ui.notify?.(formatStatsTable(summary, ui.theme ?? PASSTHROUGH_STATS_THEME).join("\n"), "info");
}

export default function statsExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer?.("stats", statsMessageRenderer as never);
  pi.registerCommand?.("stats", {
    description: "Show per-model and subagent token/cost stats for this session",
    handler: async (_args, ctx) => {
      try {
        const entries = ctx.sessionManager.getBranch();
        const costRates = await loadModelCostRates();
        const summary = extractStats(entries as Array<any>, costRates);
        await renderStatsTable(summary, ctx, pi);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not build session stats: ${message}`, "error");
      }
    },
  });
}
