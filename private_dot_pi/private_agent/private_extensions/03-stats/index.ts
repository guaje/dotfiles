import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_PATH = path.resolve(__dirname, "../../models.json");
const MODEL_COST_OVERRIDES_PATH = path.resolve(__dirname, "assets/model-cost-overrides.json");

export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelsFile {
  providers?: Record<string, { models?: Array<{ id?: string; cost?: Partial<CostRates> }> }>;
}

type ModelCostOverridesFile = Record<string, unknown> & {
  models?: Record<string, unknown>;
};

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
  inputCost: number;
  outputCost: number;
  cacheCost: number;
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
  inputCost: number;
  outputCost: number;
  cacheCost: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function costField(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function costRateFrom(raw: unknown, base?: CostRates): CostRates | undefined {
  const source = isRecord(raw) && isRecord(raw.cost) ? raw.cost : raw;
  if (!isRecord(source)) return base;
  const hasCostField = ["input", "output", "cacheRead", "cacheWrite"].some((field) => typeof source[field] === "number" && Number.isFinite(source[field]));
  if (!base && !hasCostField) return undefined;
  return {
    input: costField(source.input, base?.input ?? 0),
    output: costField(source.output, base?.output ?? 0),
    cacheRead: costField(source.cacheRead, base?.cacheRead ?? 0),
    cacheWrite: costField(source.cacheWrite, base?.cacheWrite ?? 0),
  };
}

async function mergeModelCostOverrides(rates: Map<string, CostRates>, overridesPath: string): Promise<void> {
  let parsed: ModelCostOverridesFile;
  try {
    parsed = JSON.parse(await readFile(overridesPath, "utf8")) as ModelCostOverridesFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const overrides = isRecord(parsed.models) ? parsed.models : parsed;
  for (const [modelId, override] of Object.entries(overrides)) {
    const cost = costRateFrom(override, rates.get(modelId));
    if (cost) rates.set(modelId, cost);
  }
}

export async function loadModelCostRates(modelsPath = MODELS_PATH, overridesPath = MODEL_COST_OVERRIDES_PATH): Promise<Map<string, CostRates>> {
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
  await mergeModelCostOverrides(rates, overridesPath);
  return rates;
}

export interface UsageCostBreakdown {
  input: number;
  output: number;
  cache: number;
  total: number;
}

export function calculateUsageCostBreakdown(usage: UsageLike | undefined, rates: CostRates | undefined): UsageCostBreakdown {
  if (!usage) return { input: 0, output: 0, cache: 0, total: 0 };
  if (!rates) {
    const total = typeof usage.cost === "number" ? usage.cost : num(usage.cost?.total);
    return { input: 0, output: 0, cache: 0, total };
  }

  const input = (rates.input / 1_000_000) * num(usage.input);
  const output = (rates.output / 1_000_000) * num(usage.output);
  const cacheRead = (rates.cacheRead / 1_000_000) * num(usage.cacheRead);
  const longWrite = num(usage.cacheWrite1h);
  const shortWrite = Math.max(0, num(usage.cacheWrite) - longWrite);
  const cacheWrite = ((rates.cacheWrite * shortWrite) + (rates.input * 2 * longWrite)) / 1_000_000;
  const cache = cacheRead + cacheWrite;
  return { input, output, cache, total: input + output + cache };
}

export function calculateUsageCost(usage: UsageLike | undefined, rates: CostRates | undefined): number {
  return calculateUsageCostBreakdown(usage, rates).total;
}

function resolveCostRates(costRates: Map<string, CostRates>, model: string): { rates?: CostRates; model: string } {
  const direct = costRates.get(model);
  if (direct) return { rates: direct, model };
  if (model.includes("/")) return { model };
  const matches = [...costRates.entries()].filter(([id]) => id.endsWith(`/${model}`));
  if (matches.length === 1) return { rates: matches[0][1], model: matches[0][0] };
  return { model };
}

function addToBucket(bucket: ModelBucket, usage: UsageLike, cost: UsageCostBreakdown): void {
  bucket.turns += 1;
  bucket.input += num(usage.input);
  bucket.output += num(usage.output);
  bucket.cacheRead += num(usage.cacheRead);
  bucket.cacheWrite += num(usage.cacheWrite);
  bucket.cost += cost.total;
  bucket.inputCost += cost.input;
  bucket.outputCost += cost.output;
  bucket.cacheCost += cost.cache;
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
      const resolved = resolveCostRates(costRates, model);
      const rates = resolved.rates;
      const cost = calculateUsageCostBreakdown(usage, rates);
      if (cost.total > 0) hasCost = true;
      if (rates) hasNotionalCost = true;
      const bucket = mainByModel.get(resolved.model) ?? zeroBucket(resolved.model);
      addToBucket(bucket, usage ?? {}, cost);
      mainByModel.set(resolved.model, bucket);
      continue;
    }

    if (message?.role === "toolResult" && message.toolName === "subagent") {
      for (const result of message.details?.results ?? []) {
        const usage = result?.usage as UsageLike | undefined;
        const rawModel = typeof result?.model === "string" && result.model.length > 0 ? result.model : "(default)";
        const resolved = resolveCostRates(costRates, rawModel);
        const rates = resolved.rates;
        const cost = calculateUsageCostBreakdown(usage, rates);
        if (cost.total > 0) hasCost = true;
        if (rates) hasNotionalCost = true;
        subagents.push({
          agent: typeof result?.agent === "string" ? result.agent : "(unknown)",
          task: typeof result?.task === "string" ? result.task : "",
          model: resolved.model,
          modelSelector: result?.modelSelector,
          thinkingLevel: result?.thinkingLevel,
          input: num(usage?.input),
          output: num(usage?.output),
          cacheRead: num(usage?.cacheRead),
          cacheWrite: num(usage?.cacheWrite),
          turns: num(usage?.turns),
          cost: cost.total,
          inputCost: cost.input,
          outputCost: cost.output,
          cacheCost: cost.cache,
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
  if (cost <= 0) return "$0";
  const rounded = Math.round(cost * 100) / 100;
  if (rounded <= 0) return "$0";
  return `$${rounded.toFixed(2)}`;
}

function fmtPercent(part: number, total: number): string {
  if (total <= 0) return "0";
  return String(Math.round((part / total) * 100));
}

function fmtCostShare(cost: number, total: number): string {
  return `${fmtCost(cost)}(${fmtPercent(cost, total)}%)`;
}

const COST_COLUMN_WIDTH = 15;

function usageHeader(hasCost: boolean): string {
  const values = [
    ...(hasCost ? ["Cost".padStart(COST_COLUMN_WIDTH)] : []),
    "In".padStart(hasCost ? 13 : 8),
    "Out".padStart(hasCost ? 13 : 8),
    "Cache".padStart(hasCost ? 16 : 8),
    "Turns".padStart(5),
  ];
  return values.join("  ");
}

function tokenCostPair(cost: number, tokens: number): string {
  return `${fmtCost(cost)}(${fmtTokens(tokens)})`;
}

function usageValues(row: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost" | "inputCost" | "outputCost" | "cacheCost">, hasCost: boolean, costTotal?: number): string {
  const input = hasCost ? tokenCostPair(num(row.inputCost), num(row.input)) : fmtTokens(num(row.input));
  const output = hasCost ? tokenCostPair(num(row.outputCost), num(row.output)) : fmtTokens(num(row.output));
  const cache = hasCost
    ? tokenCostPair(num(row.cacheCost), num(row.cacheRead) + num(row.cacheWrite))
    : fmtTokens(num(row.cacheRead) + num(row.cacheWrite));
  const cost = costTotal === undefined ? fmtCost(num(row.cost)) : fmtCostShare(num(row.cost), costTotal);
  const values = [
    ...(hasCost ? [cost.padStart(COST_COLUMN_WIDTH)] : []),
    input.padStart(hasCost ? 13 : 8),
    output.padStart(hasCost ? 13 : 8),
    cache.padStart(hasCost ? 16 : 8),
    String(num(row.turns)).padStart(5),
  ];
  return values.join("  ");
}

function mainRow(bucket: ModelBucket, theme: StatsTheme, hasCost: boolean, costTotal?: number): string {
  const model = theme.fg("text", truncate(bucket.model, 30).padEnd(30));
  return `  ${model}  ${theme.fg("toolOutput", usageValues(bucket, hasCost, costTotal))}`;
}

function subagentValues(row: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost" | "inputCost" | "outputCost" | "cacheCost">, hasCost: boolean, costTotal?: number): string {
  return usageValues(row, hasCost, costTotal);
}

function subagentGroupHeader(model: string, theme: StatsTheme): string {
  return `  ${theme.fg("text", truncate(model, 64))}`;
}

function displayThinking(value: string | undefined): string {
  return value ? truncate(value, 6) : "—";
}

function displayRoute(value: string | undefined): string {
  switch ((value ?? "").toLowerCase()) {
    case "heuristic": return "auto";
    case "explicit": return "set";
    case "llm": return "llm";
    default: return value ? truncate(value, 5) : "—";
  }
}

function subagentRow(row: SubagentRow, theme: StatsTheme, hasCost: boolean): string {
  const agent = truncate(row.agent, 12).padEnd(12);
  const thinking = displayThinking(row.thinkingLevel).padEnd(6);
  const selector = displayRoute(row.modelSelector).padEnd(5);
  const left = row.failed
    ? theme.fg("error", [agent, thinking, selector].join("  "))
    : [
      theme.fg("thinkingText", agent),
      theme.fg("thinkingText", thinking),
      theme.fg("thinkingText", selector),
    ].join("  ");
  const suffix = row.failed ? "  ✗" : "";
  return `    ${left}  ${theme.fg("toolOutput", subagentValues(row, hasCost))}${row.failed ? theme.fg("error", suffix) : suffix}`;
}

function addSubagentTotals(
  total: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost" | "inputCost" | "outputCost" | "cacheCost">,
  row: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost" | "inputCost" | "outputCost" | "cacheCost">,
): void {
  total.input += num(row.input);
  total.output += num(row.output);
  total.cacheRead += num(row.cacheRead);
  total.cacheWrite += num(row.cacheWrite);
  total.turns += num(row.turns);
  total.cost += num(row.cost);
  total.inputCost += num(row.inputCost);
  total.outputCost += num(row.outputCost);
  total.cacheCost += num(row.cacheCost);
}

function subagentSummaryRow(
  label: string,
  total: Pick<SubagentRow, "input" | "output" | "cacheRead" | "cacheWrite" | "turns" | "cost" | "inputCost" | "outputCost" | "cacheCost">,
  theme: StatsTheme,
  hasCost: boolean,
  emphasis: "subtotal" | "total" | "summary" = "subtotal",
  costTotal?: number,
): string {
  const left = truncate(emphasis === "total" ? label : `${label} subtotal`, 29).padEnd(29);
  const values = subagentValues(total, hasCost, costTotal);
  if (emphasis === "total") {
    return `  ${theme.fg("accent", theme.bold(left))}  ${theme.fg("accent", theme.bold(values))}`;
  }
  if (emphasis === "summary") {
    return `  ${theme.fg("text", left)}  ${theme.fg("toolOutput", values)}`;
  }
  return `  ${theme.fg("accent", left)}  ${theme.fg("accent", values)}`;
}

function addBucketTotals(total: ModelBucket, bucket: Pick<ModelBucket, "turns" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "inputCost" | "outputCost" | "cacheCost">): void {
  total.turns += bucket.turns;
  total.input += bucket.input;
  total.output += bucket.output;
  total.cacheRead += bucket.cacheRead;
  total.cacheWrite += bucket.cacheWrite;
  total.cost += bucket.cost;
  total.inputCost += bucket.inputCost;
  total.outputCost += bucket.outputCost;
  total.cacheCost += bucket.cacheCost;
}

function zeroBucket(model = "Total"): ModelBucket {
  return { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCost: 0 };
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
  const subagentTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCost: 0 };

  if (summary.main.length > 0) {
    const header = `${"Model".padEnd(30)}  ${usageHeader(summary.hasCost)}`;
    lines.push("");
    lines.push(theme.fg("mdHeading", theme.bold("Main session")));
    lines.push(`  ${theme.fg("dim", header)}`);
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);
    for (const bucket of summary.main) {
      addBucketTotals(mainTotal, bucket);
    }
    for (const bucket of summary.main) {
      lines.push(mainRow(bucket, theme, summary.hasCost, mainTotal.cost));
    }
    const mainTotalValues = usageValues(mainTotal, summary.hasCost);
    lines.push(`  ${theme.fg("accent", theme.bold("Main session total".padEnd(30)))}  ${theme.fg("accent", theme.bold(mainTotalValues))}`);
  }

  if (summary.subagents.length > 0) {
    const header = `  ${"Agent".padEnd(12)}  ${"Think".padEnd(6)}  ${"Route".padEnd(5)}  ${usageHeader(summary.hasCost)}`;
    lines.push("");
    lines.push(theme.fg("mdHeading", theme.bold("Subagents")));
    lines.push(`  ${theme.fg("dim", header)}`);
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);

    let currentModel: string | undefined;
    let modelTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCost: 0 };
    const modelTotals: Array<{ model: string; total: typeof modelTotal }> = [];
    const flushModelTotal = () => {
      if (!currentModel) return;
      modelTotals.push({ model: currentModel, total: { ...modelTotal } });
      lines.push(subagentSummaryRow(currentModel, modelTotal, theme, summary.hasCost));
    };

    for (const row of summary.subagents) {
      if (currentModel !== undefined && row.model !== currentModel) {
        flushModelTotal();
        modelTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCost: 0 };
      }
      if (row.model !== currentModel) {
        currentModel = row.model;
        lines.push(subagentGroupHeader(currentModel, theme));
      }
      addSubagentTotals(modelTotal, row);
      addSubagentTotals(subagentTotal, row);
      lines.push(subagentRow(row, theme, summary.hasCost));
    }
    flushModelTotal();
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);
    for (const { model, total } of modelTotals) {
      lines.push(subagentSummaryRow(model, total, theme, summary.hasCost, "summary", subagentTotal.cost));
    }
    lines.push(subagentSummaryRow("Subagents total", subagentTotal, theme, summary.hasCost, "total"));
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
    combined.inputCost += subagentTotal.inputCost;
    combined.outputCost += subagentTotal.outputCost;
    combined.cacheCost += subagentTotal.cacheCost;
    const header = `${"Scope".padEnd(30)}  ${usageHeader(summary.hasCost)}`;
    lines.push("");
    lines.push(theme.fg("mdHeading", theme.bold("Session total")));
    lines.push(`  ${theme.fg("dim", header)}`);
    lines.push(`  ${theme.fg("dim", "─".repeat(header.length))}`);
    const mainValues = usageValues(mainTotal, summary.hasCost, combined.cost);
    const subagentValuesTotal = usageValues(subagentTotal, summary.hasCost, combined.cost);
    const combinedValues = usageValues(combined, summary.hasCost);
    lines.push(`  ${theme.fg("toolOutput", "Main session".padEnd(30))}  ${theme.fg("toolOutput", mainValues)}`);
    lines.push(`  ${theme.fg("toolOutput", "Subagents".padEnd(30))}  ${theme.fg("toolOutput", subagentValuesTotal)}`);
    lines.push(`  ${theme.fg("accent", theme.bold("Session total".padEnd(30)))}  ${theme.fg("accent", theme.bold(combinedValues))}`);
  }

  if (summary.hasNotionalCost) {
    lines.push("");
    lines.push(theme.fg("muted", "Costs use notional commercial-equivalent rates from models.json and stats overrides."));
  }

  return lines;
}

export const STATS_VIEW_BODY_LINES = 22;

interface CustomStatsUi {
  theme?: StatsTheme;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  custom?: <T>(
    factory: (
      tui: { requestRender?: () => void },
      theme: StatsTheme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
    options?: unknown,
  ) => Promise<T>;
}

function fitsWidth(line: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(line, width);
}

function borderLine(width: number, theme: StatsTheme): string {
  return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
}

function closeHint(theme: StatsTheme, scroll: number, maxScroll: number): string {
  const scrollText = maxScroll > 0 ? `↑↓/PgUp/PgDn scroll (${scroll + 1}/${maxScroll + 1}) • ` : "";
  return theme.fg("dim", `  ${scrollText}q/esc/ctrl+c close`);
}

export class StatsTableView implements Component {
  private scroll = 0;
  private lastPageSize = STATS_VIEW_BODY_LINES;

  constructor(
    private readonly summary: StatsSummary,
    private readonly theme: StatsTheme,
    private readonly done: () => void,
    private readonly requestRender: () => void = () => {},
  ) {}

  render(width: number): string[] {
    const content = formatStatsTable(this.summary, this.theme);
    const pageSize = Math.min(STATS_VIEW_BODY_LINES, Math.max(1, content.length));
    this.lastPageSize = pageSize;
    const maxScroll = Math.max(0, content.length - pageSize);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const body = content.slice(this.scroll, this.scroll + pageSize);
    return [
      borderLine(width, this.theme),
      ...body.map((line) => fitsWidth(line, width)),
      fitsWidth(closeHint(this.theme, this.scroll, maxScroll), width),
      borderLine(width, this.theme),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
      this.done();
      return;
    }

    const previous = this.scroll;
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scroll -= 1;
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scroll += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scroll -= Math.max(1, this.lastPageSize - 1);
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
      this.scroll += Math.max(1, this.lastPageSize - 1);
    } else if (matchesKey(data, Key.home)) {
      this.scroll = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scroll = Number.MAX_SAFE_INTEGER;
    } else {
      return;
    }

    this.scroll = Math.max(0, this.scroll);
    if (this.scroll !== previous) this.requestRender();
  }

  invalidate(): void {}
}

export async function renderStatsTable(summary: StatsSummary, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<void> {
  const ui = ctx.ui as CustomStatsUi;
  if (ctx.mode === "tui" && typeof ui.custom === "function") {
    await ui.custom<void>((tui, theme, _keybindings, done) => new StatsTableView(
      summary,
      theme ?? PASSTHROUGH_STATS_THEME,
      () => done(undefined),
      () => tui.requestRender?.(),
    ));
    return;
  }
  ui.notify?.(formatStatsTable(summary, ui.theme ?? PASSTHROUGH_STATS_THEME).join("\n"), "info");
}

export default function statsExtension(pi: ExtensionAPI) {
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
