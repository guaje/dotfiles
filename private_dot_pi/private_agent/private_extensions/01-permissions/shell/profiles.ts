import type { ShellContext, ShellEffect } from "../types.ts";

type Verdict = { effect: ShellEffect; reason?: string };

const LOCAL_CONTEXT: ShellContext = { location: "local", usesNetwork: false };
const READ_ONLY = new Set([
  "basename", "bat", "cat", "cmp", "cut", "df", "dig", "dirname", "du", "echo", "fd", "file",
  "false", "grep", "head", "host", "id", "jq", "ls", "lsof", "md5", "md5sum", "nslookup",
  "pgrep", "printenv", "printf", "ps", "pwd", "readlink", "realpath", "rg", "shasum", "sha256sum",
  "stat", "strings", "tail", "test", "tree", "true", "tr", "type", "uname", "uniq", "wc", "which", "whoami", "[",
]);
const MUTATING = new Set(["rm", "mv", "cp", "mkdir", "rmdir", "touch", "ln", "truncate", "tee", "install", "rsync", "dd", "patch", "chmod", "chown", "chgrp"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "fish", "ksh", "node", "python", "python3", "ruby", "perl", "php", "lua", "awk"]);
export function isProgrammableInterpreter(executable: string) { return INTERPRETERS.has(executable.replace(/^.*[\\/]/, "").toLowerCase()); }
const EXECUTION_WRAPPERS = new Set(["sudo", "doas", "su", "xargs", "nohup"]);
const DYNAMIC_EXECUTORS = new Set(["make", "gmake", "parallel", "watch"]);

export function hasRuntimeExecutionRisk(rawName: string, argv: string[]) {
  const name = rawName.replace(/^.*[\\/]/, "").toLowerCase();
  if (INTERPRETERS.has(name) || name === "sed" || EXECUTION_WRAPPERS.has(name) || DYNAMIC_EXECUTORS.has(name)) return true;
  if (name === "find") return argv.some((argument) => ["-exec", "-execdir", "-ok", "-okdir"].includes(argument));
  if (name === "fd") return argv.some((argument) => ["-x", "-X", "--exec", "--exec-batch"].includes(argument) || /^-(?:x|X).+/.test(argument) || argument.startsWith("--exec="));
  if (name === "rg") return argv.some((argument) => argument === "--pre" || argument.startsWith("--pre="));
  if (name === "sort") return argv.some((argument) => argument === "--compress-program" || argument.startsWith("--compress-program="));
  if (name === "tar") return argv.some((argument) => argument.startsWith("--checkpoint-action=exec="));
  if (name === "rsync") return argv.some((argument) => argument === "-e" || /^-e.+/.test(argument) || argument === "--rsh" || argument.startsWith("--rsh=") || argument === "--rsync-path" || argument.startsWith("--rsync-path="));
  return false;
}

const GIT_QUERY = new Set(["status", "diff", "show", "log", "rev-parse", "ls-files", "grep", "cat-file"]);
const LOCAL_GIT_QUERY = new Set(["ls-tree", "merge-base", "rev-list", "show-ref", "for-each-ref", "blame", "describe", "name-rev", "diff-tree", "diff-index", "diff-files", "shortlog"]);
const CHEZMOI_QUERY = new Set(["status", "diff", "verify", "managed", "unmanaged", "ignored", "cat", "source-path", "target-path", "dump-config", "cat-config", "help", "version", "completion"]);
const CHEZMOI_MUTATION = new Set(["add", "apply", "chattr", "destroy", "edit", "encrypt", "forget", "git", "import", "init", "merge", "merge-all", "purge", "re-add", "remove", "rm", "unmanage", "update", "upgrade"]);

function executable(name: string) { return name.replace(/^.*[\\/]/, "").toLowerCase(); }
function hasOption(argv: string[], ...names: string[]) {
  return argv.some((arg) => names.some((name) => arg === name
    || (name.startsWith("--") && arg.startsWith(`${name}=`))
    || (name.startsWith("-") && !name.startsWith("--") && arg.startsWith(name) && arg.length > name.length)));
}
function localOnly(name: string, context: ShellContext): Verdict | undefined {
  return context.location === "local" ? undefined : { effect: "unknown", reason: `${name} read-only profile is local-only` };
}

export function classifyProfile(rawName: string, argv: string[], context: ShellContext = LOCAL_CONTEXT): Verdict {
  if (/[\\/]/.test(rawName)) return { effect: "unknown", reason: "path-qualified executables require approval" };
  const name = executable(rawName);
  if (rawName !== name) return { effect: "unknown", reason: "executable spelling is not a canonical reviewed name" };
  if (MUTATING.has(name)) return { effect: "mutating", reason: `${name} can change files or system state` };
  if (name === "sudo" || name === "doas") return { effect: "unknown", reason: `${name} runs with elevated privileges` };
  if (name === "su") return { effect: "unknown", reason: "su changes user identity" };
  if (EXECUTION_WRAPPERS.has(name)) return { effect: "unknown", reason: `${name} changes execution semantics` };
  if (INTERPRETERS.has(name)) return { effect: "unknown", reason: `${name} is a programmable interpreter` };

  if (name === "sed") {
    if (argv.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) return { effect: "mutating", reason: "sed in-place mode writes files" };
    return { effect: "unknown", reason: "sed programs can execute commands or write files and are not reviewed" };
  }
  if (name === "date" && hasOption(argv, "-s", "--set")) return { effect: "mutating", reason: "date set option changes the system clock" };
  if (name === "sort") {
    if (hasOption(argv, "-o", "--output")) return { effect: "mutating", reason: "sort output option writes a file" };
    if (hasOption(argv, "--compress-program")) return { effect: "unknown", reason: "sort compress program executes another command" };
    return { effect: "read-only" };
  }
  if (name === "tree" && hasOption(argv, "-o", "--output")) return { effect: "mutating", reason: "tree output option writes a file" };
  if (name === "diff" && hasOption(argv, "--output")) return { effect: "mutating", reason: "diff output option writes a file" };
  if (name === "fd" && argv.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg) || /^-(?:x|X).+/.test(arg) || arg.startsWith("--exec="))) return { effect: "unknown", reason: "fd execution options run another command" };
  if (name === "rg" && hasOption(argv, "--pre")) return { effect: "unknown", reason: "rg --pre executes another command" };
  if (name === "bat" && forcedBatPager(argv)) return { effect: "unknown", reason: "bat forced paging can execute a pager" };
  if (name === "tail" && followsTail(argv)) return { effect: "unknown", reason: "tail follow mode is unbounded" };
  if (name === "file" && argv.some((arg) => arg === "--compile" || arg.startsWith("--compile=") || /^-[^-]*C/.test(arg))) return { effect: "mutating", reason: "file compile mode writes a magic database" };
  if (name === "uniq") return classifyUniq(argv);
  if (name === "find") return classifyFind(argv);
  if (name === "git") return classifyGit(argv, context);
  if (name === "chezmoi") return classifyChezmoi(argv);
  if (name === "glab" || name === "gh") return classifyForgeCli(name, argv, context);
  if (name === "adb") {
    const remote = localOnly(name, context); if (remote) return remote;
    return (argv.length === 1 && argv[0] === "devices") || (argv.length === 2 && argv[0] === "devices" && argv[1] === "-l")
      ? { effect: "read-only" }
      : { effect: "unknown", reason: "only adb devices and adb devices -l are reviewed inspections" };
  }
  if (name === "cd") {
    const remote = localOnly(name, context); if (remote) return remote;
    return argv.length <= 1 && argv[0] !== "-" && !argv[0]?.startsWith("-")
      ? { effect: "read-only" }
      : { effect: "unknown", reason: "unreviewed cd form" };
  }
  if (name === "nl") {
    const remote = localOnly(name, context); if (remote) return remote;
    return { effect: "read-only" };
  }
  if (name === "command" && argv[0] === "-v" && argv.length === 2) return { effect: "read-only" };
  if (name === "env" && argv.length === 0) return { effect: "read-only" };
  if (["command", "env", "timeout"].includes(name)) return { effect: "unknown", reason: `${name} must be safely unwrapped before classification` };
  if (READ_ONLY.has(name)) return { effect: "read-only" };
  return { effect: "unknown", reason: `unreviewed executable: ${name || "(none)"}` };
}

function forcedBatPager(argv: string[]) {
  return argv.some((arg, index) => arg === "--pager" || arg.startsWith("--pager=")
    || arg === "--paging=always" || (arg === "--paging" && argv[index + 1] === "always"));
}
function followsTail(argv: string[]) {
  return argv.some((arg) => arg === "--follow" || arg.startsWith("--follow=") || /^-[^-]*[fF]/.test(arg));
}

function classifyUniq(argv: string[]): Verdict {
  const operands: string[] = [];
  let options = true;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (options && arg === "--") { options = false; continue; }
    if (options && arg.startsWith("--")) {
      if (["--count", "--repeated", "--all-repeated", "--separate", "--unique", "--ignore-case", "--zero-terminated", "--help", "--version", "--group"].includes(arg) || arg.startsWith("--group=")) continue;
      if (["--skip-fields", "--skip-chars", "--check-chars"].includes(arg)) {
        if (!argv[++index]) return { effect: "unknown", reason: `uniq option ${arg} needs a value` };
        continue;
      }
      if (/^--(?:skip-fields|skip-chars|check-chars)=.+/.test(arg)) continue;
      return { effect: "unknown", reason: `unreviewed uniq option: ${arg}` };
    }
    if (options && arg.startsWith("-") && arg !== "-") {
      const cluster = arg.slice(1);
      let valid = true;
      for (let position = 0; position < cluster.length; position++) {
        const option = cluster[position]!;
        if ("cdDuiz".includes(option)) continue;
        if ("fsw".includes(option)) {
          if (position + 1 < cluster.length) { position = cluster.length; break; }
          if (!argv[++index]) return { effect: "unknown", reason: `uniq option -${option} needs a value` };
          break;
        }
        valid = false; break;
      }
      if (!valid) return { effect: "unknown", reason: `unreviewed uniq option: ${arg}` };
      continue;
    }
    operands.push(arg);
  }
  if (operands.length > 2) return { effect: "unknown", reason: "uniq has too many operands" };
  if (operands.length === 2 && operands[1] !== "-") return { effect: "mutating", reason: "uniq INPUT OUTPUT writes the output file" };
  return { effect: "read-only" };
}

function classifyFind(argv: string[]): Verdict {
  const unsafe = argv.find((arg) => ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(arg) || /^-(?:fprint|fprintf|fls)(?:$|[^a-z])/.test(arg));
  return unsafe
    ? { effect: unsafe === "-delete" ? "mutating" : "unknown", reason: `find action ${unsafe} is not read-only` }
    : { effect: "read-only" };
}

const GLAB_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  mr: new Set(["view", "list", "diff", "pipelines"]),
  ci: new Set(["lint", "list", "trace", "view", "status"]),
  auth: new Set(["status"]), repo: new Set(["view"]), job: new Set(["trace"]),
  pipeline: new Set(["list", "view"]), variable: new Set(["list"]), config: new Set(["list"]),
};
const GH_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  run: new Set(["list", "view"]), pr: new Set(["checks", "view", "list"]),
  auth: new Set(["status"]), repo: new Set(["view"]), release: new Set(["view", "list"]),
};
const FORGE_MUTATIONS = new Set([
  "issue create", "issue edit", "issue close", "mr create", "mr update", "mr merge", "mr note", "mr delete",
  "ci run", "ci retry", "ci cancel", "pipeline run", "pipeline retry", "pipeline cancel", "variable set", "variable delete",
  "pr create", "pr merge", "pr edit", "workflow run", "run rerun", "run cancel", "release create", "release delete",
]);

function classifyForgeCli(name: "glab" | "gh", argv: string[], context: ShellContext): Verdict {
  const remote = localOnly(name, context); if (remote) return remote;
  if (argv[0] === "api") return classifyForgeApi(name, argv.slice(1));
  const pair = `${argv[0] ?? ""} ${argv[1] ?? ""}`.trim();
  if (pair === "issue create") return { effect: "mutating", reason: `${name} issue create creates a remote issue` };
  if (FORGE_MUTATIONS.has(pair)) return { effect: "mutating", reason: `${name} ${pair} changes remote state` };
  const read = (name === "glab" ? GLAB_READ : GH_READ)[argv[0] ?? ""];
  if (!read?.has(argv[1] ?? "")) return { effect: "unknown", reason: `unreviewed ${name} command` };
  const rest = argv.slice(2);
  if (rest.some((arg) => arg === "--web" || arg === "--browser" || arg.startsWith("--browser=") || arg === "--watch" || /(?:^|-)download(?:$|-)/.test(arg) || /(?:^|-)artifact(?:$|-)/.test(arg))) {
    return { effect: "unknown", reason: `${name} query option can launch a helper or write downloaded data` };
  }
  if (name === "glab" && argv[0] === "ci" && argv[1] === "status" && rest.some((arg) => arg === "--live" || arg === "--wait")) {
    return { effect: "unknown", reason: "glab ci status polling mode is unbounded" };
  }
  return { effect: "read-only" };
}

function classifyForgeApi(name: "glab" | "gh", argv: string[]): Verdict {
  const endpoint = argv[0];
  if (!endpoint || endpoint.startsWith("-") || endpoint.toLowerCase().includes("graphql")) return { effect: "unknown", reason: `${name} GraphQL or missing API endpoint is not reviewed` };
  let method = "";
  let hasFields = false;
  let hasMultipartForm = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") return { effect: "unknown", reason: `${name} api arguments after -- are not reviewed` };
    if (arg === "-X" || arg === "--method") { method = (argv[++index] ?? "").toUpperCase(); if (!method) return { effect: "unknown", reason: `${name} api method is missing` }; continue; }
    if (arg.startsWith("--method=")) { method = arg.slice("--method=".length).toUpperCase(); continue; }
    if (arg === "--input" || arg === "--body" || arg.startsWith("--input=") || arg.startsWith("--body=")) return { effect: "unknown", reason: `${name} api request bodies are not reviewed` };
    if (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field" || (name === "glab" && arg === "--form")) {
      if (!argv[++index]) return { effect: "unknown", reason: `${name} api field value is missing` };
      hasFields = true;
      hasMultipartForm ||= arg === "--form";
      continue;
    }
    if (/^-(?:f|F).+/.test(arg) || /^--(?:field|raw-field)=.+/.test(arg)) { hasFields = true; continue; }
    if (name === "glab" && /^--form=.+/.test(arg)) { hasFields = true; hasMultipartForm = true; continue; }
    if (name === "gh" && (arg === "--cache" || arg.startsWith("--cache="))) return { effect: "unknown", reason: "gh api cache mode can write local cache state" };
    const valueOptions = name === "glab"
      ? new Set(["--hostname", "--output", "--jq", "-q", "--header", "-H", "--page", "--per-page"])
      : new Set(["--hostname", "--jq", "-q", "--template", "-t", "--header", "-H", "--preview", "-p"]);
    if (valueOptions.has(arg)) { if (!argv[++index]) return { effect: "unknown", reason: `${name} api option ${arg} needs a value` }; continue; }
    if (/^--(?:hostname|output|jq|header|page|per-page|template|preview)=.+/.test(arg)) continue;
    if (["--paginate", "--silent", "--include", "--verbose", "--slurp", "--help", "-h"].includes(arg)) continue;
    return { effect: "unknown", reason: `unreviewed ${name} api option: ${arg}` };
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return { effect: "mutating", reason: `${name} api ${method} can change remote state` };
  if (method && method !== "GET" && method !== "HEAD") return { effect: "unknown", reason: `unreviewed ${name} api method: ${method}` };
  if (hasMultipartForm) return { effect: "unknown", reason: "glab api multipart form requests are not reviewed" };
  if (!method && hasFields) return { effect: "mutating", reason: `${name} api fields implicitly select POST` };
  return { effect: "read-only" };
}

function classifyChezmoi(argv: string[]): Verdict {
  if (hasOption(argv, "-o", "--output")) return { effect: "mutating", reason: "chezmoi output option writes a file" };
  if (hasOption(argv, "--init", "--apply")) return { effect: "mutating", reason: "chezmoi initialization/application changes managed state" };
  const refresh = argv.findIndex((arg) => arg === "--refresh-externals" || arg.startsWith("--refresh-externals="));
  if (refresh >= 0) {
    const value = argv[refresh]!.includes("=") ? argv[refresh]!.split("=", 2)[1] : argv[refresh + 1];
    if (value !== "never") return { effect: "mutating", reason: "chezmoi external refresh can update its cache" };
  }
  if (["--config", "--source", "--destination", "--persistent-state", "--pager", "--diff-command"].some((option) => hasOption(argv, option))) return { effect: "unknown", reason: "chezmoi path or helper overrides cross the reviewed configuration boundary" };
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const option = argv[index]!;
    if (option === "--") break;
    if (["-h", "--help", "--version", "-v", "--verbose", "--debug", "--no-tty", "--no-pager", "--use-builtin-diff", "--skip-secrets"].includes(option) || /^(?:--color|--log-level)=/.test(option)) { index++; continue; }
    if (["--color", "--log-level"].includes(option) && argv[index + 1]) { index += 2; continue; }
    if (option === "--refresh-externals" && argv[index + 1] === "never") { index += 2; continue; }
    if (option === "--refresh-externals=never") { index++; continue; }
    return { effect: "unknown", reason: `unreviewed chezmoi global option: ${option}` };
  }
  const subcommand = argv[index];
  if (!subcommand) return { effect: "read-only" };
  if (CHEZMOI_QUERY.has(subcommand)) return { effect: "read-only" };
  if (CHEZMOI_MUTATION.has(subcommand)) return { effect: "mutating", reason: `chezmoi ${subcommand} can change managed state` };
  return { effect: "unknown", reason: `unreviewed chezmoi subcommand: ${subcommand}` };
}

function classifyGit(argv: string[], context: ShellContext): Verdict {
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const option = argv[index]!;
    if (option === "-c" || option.startsWith("-c") || option === "--config-env" || option.startsWith("--config-env=") || ["-p", "--paginate", "--exec-path"].includes(option) || option.startsWith("--exec-path=")) return { effect: "unknown", reason: "git configuration, paging, or helper paths can execute external programs" };
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(option)) { if (!argv[++index]) return { effect: "unknown", reason: `git option ${option} needs a value` }; }
    else if (!option.startsWith("--no-pager") && !option.startsWith("--no-optional-locks") && !["--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"].includes(option)) return { effect: "unknown", reason: `unreviewed git global option: ${option}` };
    index++;
  }
  const subcommand = argv[index++];
  if (!subcommand) return { effect: "unknown", reason: "git subcommand is missing" };
  const args = argv.slice(index);
  if (["--ext-diff", "--textconv", "--open-files-in-pager", "--filters"].some((option) => hasOption(args, option))) return { effect: "unknown", reason: "git query can execute an external helper" };
  if (hasOption(args, "--output")) return { effect: "mutating", reason: "git output option writes a file" };
  if (GIT_QUERY.has(subcommand)) return { effect: "read-only" };
  if (LOCAL_GIT_QUERY.has(subcommand)) return context.location === "local" ? { effect: "read-only" } : { effect: "unknown", reason: `git ${subcommand} read-only profile is local-only` };
  if (subcommand === "branch") {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (args.length === 0 || hasOption(args, "--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged")) return { effect: "read-only" };
    return positional.length ? { effect: "mutating", reason: "git branch arguments can create or change branches" } : { effect: "unknown", reason: "unreviewed git branch options" };
  }
  if (subcommand === "worktree") return args[0] === "list" ? { effect: "read-only" } : { effect: "mutating", reason: "only git worktree list is read-only" };
  if (subcommand === "remote") return args.length === 1 && args[0] === "-v" ? { effect: "read-only" } : { effect: "mutating", reason: "only git remote -v is read-only" };
  if (subcommand === "tag") return args.length === 0 || hasOption(args, "-l", "--list") ? { effect: "read-only" } : { effect: "mutating", reason: "git tag arguments can create tags" };
  if (subcommand === "config") return args.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"].includes(arg)) ? { effect: "read-only" } : { effect: "mutating", reason: "git config form can change configuration" };
  if (subcommand === "commit") return { effect: "mutating", reason: "git commit creates a commit and updates repository history" };
  return { effect: "mutating", reason: `git ${subcommand} can change repository state` };
}
