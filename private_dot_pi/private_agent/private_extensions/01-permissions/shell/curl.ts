import type { ShellEffect } from "../types.ts";

type CurlVerdict = { effect: ShellEffect; reason?: string; usesNetwork: true };

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "CONNECT"]);
const DATA_OPTIONS = /^(?:--(?:data(?:-ascii|-binary|-raw|-urlencode)?|json|form(?:-string)?|upload-file)|-[dFT])(?:=|.|$)/;
const LOCAL_OUTPUT_LONG = new Set([
  "--output", "--remote-name", "--remote-header-name", "--cookie-jar", "--trace", "--trace-ascii",
  "--dump-header", "--stderr", "--libcurl", "--etag-save", "--alt-svc", "--hsts",
]);
const SAFE_FLAGS = new Set([
  "--silent", "--show-error", "--fail", "--fail-with-body", "--help", "--version", "--location", "--location-trusted", "--head",
  "--compressed", "--insecure", "--include", "--no-progress-meter", "--ipv4", "--ipv6", "--http1.0",
  "--http1.1", "--http2", "--http2-prior-knowledge", "--globoff", "--get", "--path-as-is", "--fail-early",
  "--raw", "--remote-time", "--skip-existing", "--remove-on-error", "--retry-all-errors", "--ssl", "--ssl-reqd", "--tcp-nodelay",
  "--tcp-fastopen", "--tr-encoding", "--no-alpn", "--no-npn", "--cert-status", "--false-start",
]);
const SAFE_VALUE_OPTIONS = new Set([
  "--url", "--url-query", "--header", "--user", "--oauth2-bearer", "--user-agent", "--referer", "--cookie",
  "--connect-timeout", "--max-time", "--retry", "--retry-delay", "--retry-max-time",
  "--cacert", "--capath", "--cert", "--cert-type", "--key", "--key-type", "--pass", "--proxy", "--proxy-user",
  "--noproxy", "--resolve", "--connect-to", "--interface", "--local-port", "--range", "--limit-rate",
  "--max-filesize", "--proto", "--proto-redir", "--tls-max", "--tls13-ciphers", "--ciphers", "--curves",
  "--dns-interface", "--dns-ipv4-addr", "--dns-ipv6-addr", "--request-target", "--unix-socket", "--abstract-unix-socket",
]);
const SAFE_SHORT_FLAGS = new Set(["s", "S", "I", "L", "f", "k", "v", "g", "i", "h", "V", "4", "6"]);
const SAFE_SHORT_VALUES = new Set(["H", "u", "A", "e", "b", "m", "r", "x", "U"]);

export function classifyCurl(argv: string[]): CurlVerdict {
  let method = argv.includes("--head") || argv.some((arg) => /^-[^-]*I/.test(arg)) ? "HEAD" : "GET";
  const forceGet = argv.includes("--get") || argv.some((arg) => /^-[^-]*G/.test(arg));

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") continue;
    if (arg === "-X" || arg === "--request") {
      const value = argv[++index];
      if (!value) return unknown("curl request method is missing");
      method = value.toUpperCase();
      continue;
    }
    if (arg.startsWith("--request=")) { method = arg.slice("--request=".length).toUpperCase(); continue; }
    if (arg.startsWith("-X") && arg.length > 2) { method = arg.slice(2).toUpperCase(); continue; }
    if (DATA_OPTIONS.test(arg)) {
      if (!forceGet) return { effect: "mutating", reason: "curl sends request data or uploads content", usesNetwork: true };
      if (!arg.includes("=") && /^-(?:d|F|T)$/.test(arg) || /^--/.test(arg) && !arg.includes("=")) index++;
      continue;
    }
    if (arg === "--ftp-create-dirs" || arg === "--quote" || arg.startsWith("--quote=")) {
      return { effect: "mutating", reason: "curl option can change remote state", usesNetwork: true };
    }
    if (arg === "--config" || arg.startsWith("--config=") || arg === "-K" || arg.startsWith("-K") || arg === "--next") {
      return unknown(`curl ${arg} is not reviewed`);
    }
    if (arg === "-O" || /^-[^-]*O/.test(arg) || arg === "--remote-name" || arg === "--remote-header-name") {
      return { effect: "mutating", reason: "curl writes a local output file", usesNetwork: true };
    }
    if (arg === "-o" || arg === "-D" || LOCAL_OUTPUT_LONG.has(arg)) {
      const value = argv[++index];
      if (value !== "-") return { effect: "mutating", reason: "curl writes a local output file", usesNetwork: true };
      continue;
    }
    if (/^-(?:o|D).+/.test(arg)) {
      if (arg.slice(2) !== "-") return { effect: "mutating", reason: "curl writes a local output file", usesNetwork: true };
      continue;
    }
    const longOutput = /^--([^=]+)=(.*)$/.exec(arg);
    if (longOutput && LOCAL_OUTPUT_LONG.has(`--${longOutput[1]}`)) {
      if (longOutput[2] !== "-") return { effect: "mutating", reason: "curl writes a local output file", usesNetwork: true };
      continue;
    }
    if (SAFE_FLAGS.has(arg)) continue;
    if (SAFE_VALUE_OPTIONS.has(arg)) {
      if (argv[++index] === undefined) return unknown(`curl ${arg} needs a value`);
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0]!;
      if (SAFE_VALUE_OPTIONS.has(name) && arg.includes("=")) continue;
      return unknown(`unreviewed curl option: ${arg}`);
    }
    if (arg.startsWith("-") && arg !== "-") {
      const cluster = arg.slice(1);
      let position = 0;
      while (position < cluster.length) {
        const option = cluster[position++]!;
        if (option === "G") continue;
        if (SAFE_SHORT_FLAGS.has(option)) continue;
        if (SAFE_SHORT_VALUES.has(option)) {
          if (position === cluster.length && argv[++index] === undefined) return unknown(`curl -${option} needs a value`);
          break;
        }
        if (option === "w") return unknown("curl --write-out can write files and is not reviewed");
        return unknown(`unreviewed curl option: -${option}`);
      }
    }
  }

  if (forceGet) method = "GET";
  if (["GET", "HEAD"].includes(method)) return { effect: "read-only", usesNetwork: true };
  return { effect: MUTATING_METHODS.has(method) ? "mutating" : "unknown", reason: `curl ${method} is not a read-only request`, usesNetwork: true };
}

function unknown(reason: string): CurlVerdict {
  return { effect: "unknown", reason, usesNetwork: true };
}
