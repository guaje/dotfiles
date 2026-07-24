import type { ShellAnalysis, ShellEffect } from "../types.ts";

export interface SshInvocation {
  target?: string;
  payload?: string;
  payloadSpan?: { start: number; end: number };
  effect: ShellEffect;
  reason?: string;
}

const SAFE_FLAGS = new Set(["-4", "-6", "-A", "-a", "-C", "-K", "-k", "-n", "-q", "-T", "-t", "-v", "-X", "-x", "-Y", "-y"]);
const SAFE_VALUE_OPTIONS = new Set(["-b", "-c", "-i", "-J", "-l", "-m", "-p"]);
const ALWAYS_UNKNOWN_VALUE_OPTIONS = new Set(["-D", "-E", "-F", "-L", "-O", "-Q", "-R", "-S", "-W", "-w"]);
const SAFE_O_KEYS = new Set([
  "addressfamily", "batchmode", "canonicaldomains", "canonicalizehostname", "ciphers", "compression",
  "connectionattempts", "connecttimeout", "forwardagent", "forwardx11", "forwardx11trusted", "globalknownhostsfile",
  "gssapiauthentication", "hostkeyalgorithms", "hostname", "identityagent", "identityfile", "identitiesonly", "ipqos",
  "kbdinteractiveauthentication", "loglevel", "macs", "passwordauthentication", "port", "preferredauthentications",
  "proxyjump", "pubkeyacceptedalgorithms", "pubkeyauthentication", "rekeylimit", "requesttty", "sendenv", "serveralivecountmax",
  "serveraliveinterval", "setenv", "stricthostkeychecking", "tcpkeepalive", "updatehostkeys", "user", "userknownhostsfile",
  "verifyhostkeydns",
]);
const UNSAFE_O_KEYS = new Set([
  "controlmaster", "controlpath", "controlpersist", "dynamicforward", "knownhostscommand", "localcommand", "localforward",
  "permitlocalcommand", "pkcs11provider", "proxycommand", "remotecommand", "remoteforward", "securitykeyprovider", "tunnel",
]);

export function parseSsh(argv: string[], source: string, offset: number): SshInvocation {
  if (argv.length === 1 && argv[0] === "-V") return { effect: "read-only" };
  if (argv.length === 2 && argv[0] === "-Q") return { effect: "read-only" };
  let index = 0;
  let optionsEnded = false;
  let configOnly = false;
  while (index < argv.length && !optionsEnded && argv[index]!.startsWith("-")) {
    const option = argv[index]!;
    if (option === "--") { optionsEnded = true; index++; break; }
    if (option === "-N" || option === "-f" || option === "-M") return unknown(`ssh option ${option} changes session/control behavior`);
    if (option === "-G") { configOnly = true; index++; continue; }
    if (SAFE_FLAGS.has(option) || /^-(?:v+|t+)$/.test(option)) { index++; continue; }

    const short = option.slice(0, 2);
    if (ALWAYS_UNKNOWN_VALUE_OPTIONS.has(short)) return unknown(`ssh option ${short} changes forwarding, control, config, or local output behavior`);
    if (short === "-o") {
      const value = option.length > 2 ? option.slice(2) : argv[++index];
      if (!value) return unknown("ssh -o needs a value");
      const key = value.split("=", 1)[0]!.toLowerCase();
      if (UNSAFE_O_KEYS.has(key)) return unknown(`ssh option ${key} changes forwarding or command execution`);
      if (!SAFE_O_KEYS.has(key)) return unknown(`unreviewed ssh -o option: ${key}`);
      index++;
      continue;
    }
    if (SAFE_VALUE_OPTIONS.has(short)) {
      if (option.length === 2 && argv[++index] === undefined) return unknown(`ssh option ${short} needs a value`);
      index++;
      continue;
    }
    return unknown(`unreviewed ssh option: ${option}`);
  }

  const target = argv[index++];
  if (!target) return unknown("ssh destination is missing");
  const payload = argv.slice(index).join(" ");
  if (!payload) return configOnly ? { target, effect: "read-only" } : { target, effect: "unknown", reason: "interactive ssh session" };
  const begin = source.indexOf(payload, offset);
  return {
    target,
    payload,
    payloadSpan: begin < 0 ? undefined : { start: begin, end: begin + payload.length },
    effect: "read-only",
  };
}

function unknown(reason: string): SshInvocation {
  return { effect: "unknown", reason };
}

export function remoteContext(analysis: ShellAnalysis, target: string): ShellAnalysis {
  const context = { location: "remote" as const, transport: "ssh" as const, target, usesNetwork: true };
  return { ...analysis, context, commands: analysis.commands.map((command) => ({ ...command, context })) };
}

export interface SshRenderParts {
  outer: string;
  target: string;
  payload: string;
  localSuffix?: string;
}

/** Presentation-only scanner for a single SSH invocation. Authorization never depends on it. */
export function sshRenderParts(line: string): SshRenderParts | undefined {
  const tokens = scanWords(line);
  if (tokens[0]?.value !== "ssh") return undefined;
  const invocation = parseSsh(tokens.map((token) => token.value).slice(1), line, tokens[0].start);
  if (!invocation.target || !invocation.payload || !invocation.payloadSpan) return undefined;
  const payloadToken = tokens.find((token) => invocation.payloadSpan && token.start <= invocation.payloadSpan.start && token.end >= invocation.payloadSpan.end);
  const payloadStart = payloadToken?.start ?? invocation.payloadSpan.start;
  const invocationEnd = tokens.at(-1)?.end ?? line.length;
  const localSuffix = line.slice(invocationEnd).trim();
  return { outer: line.slice(0, payloadStart).trimEnd(), target: invocation.target, payload: invocation.payload, localSuffix: localSuffix || undefined };
}

function scanWords(source: string) {
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index++;
    if (index >= source.length || ";&|".includes(source[index]!)) break;
    const start = index;
    let value = "";
    let quote: "'" | '"' | undefined;
    while (index < source.length) {
      const current = source[index]!;
      if (!quote && (/\s/.test(current) || ";&|".includes(current))) break;
      if (current === "\\" && quote !== "'") { if (index + 1 < source.length) value += source[++index]!; index++; continue; }
      if (current === "'" || current === '"') {
        if (!quote) { quote = current; index++; continue; }
        if (quote === current) { quote = undefined; index++; continue; }
      }
      value += current;
      index++;
    }
    if (quote) return [];
    tokens.push({ value, start, end: index });
  }
  return tokens;
}
