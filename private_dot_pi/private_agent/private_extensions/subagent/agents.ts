/**
 * Agent discovery and configuration for the subagent extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./model-selection.ts";

export type AgentScope = "user" | "project" | "both";

/** Valid pi thinking levels. Matches pi's --thinking flag values. */
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
    "off", "minimal", "low", "medium", "high", "xhigh",
]);

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    /** Explicit thinking level override. Wins over auto-estimated effort. */
    thinking?: ThinkingLevel;
    /** When false, the child skips AGENTS.md/CLAUDE.md discovery (--no-context-files). Default true. */
    contextFiles?: boolean;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
    const agents: AgentConfig[] = [];
    if (!fs.existsSync(dir)) return agents;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return agents; }
    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const filePath = path.join(dir, entry.name);
        let content: string;
        try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
        const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
        if (!frontmatter.name || !frontmatter.description) continue;
        const toolsRaw = frontmatter.tools;
        const tools = typeof toolsRaw === "string"
            ? toolsRaw.split(",").map((t) => t.trim()).filter(Boolean)
            : Array.isArray(toolsRaw) ? toolsRaw.map((t) => String(t).trim()).filter(Boolean) : undefined;
        const coerceStr = (v: unknown): string | undefined =>
            v === undefined || v === null ? undefined : String(v);
        const rawThinking = coerceStr(frontmatter.thinking)?.trim().toLowerCase();
        const thinking = rawThinking && VALID_THINKING_LEVELS.has(rawThinking as ThinkingLevel)
            ? (rawThinking as ThinkingLevel)
            : undefined;
        const rawContextFiles = frontmatter.contextFiles;
        const contextFiles = rawContextFiles === undefined ? undefined
            : rawContextFiles === false || coerceStr(rawContextFiles)?.toLowerCase() === "false" ? false
            : rawContextFiles === true || coerceStr(rawContextFiles)?.toLowerCase() === "true" ? true
            : undefined;
        agents.push({
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            thinking,
            contextFiles,
            systemPrompt: body,
            source,
            filePath,
        });
    }
    return agents;
}

function isDirectory(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
    let currentDir = cwd;
    while (true) {
        const candidate = path.join(currentDir, ".pi", "agents");
        if (isDirectory(candidate)) return candidate;
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
    }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
    const userDir = path.join(getAgentDir(), "agents");
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);
    const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
    const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
    const agentMap = new Map<string, AgentConfig>();
    if (scope === "both") {
        for (const a of userAgents) agentMap.set(a.name, a);
        for (const a of projectAgents) agentMap.set(a.name, a);
    } else if (scope === "user") {
        for (const a of userAgents) agentMap.set(a.name, a);
    } else {
        for (const a of projectAgents) agentMap.set(a.name, a);
    }
    return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
    if (agents.length === 0) return { text: "none", remaining: 0 };
    const listed = agents.slice(0, maxItems);
    const remaining = agents.length - listed.length;
    return {
        text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
        remaining,
    };
}
