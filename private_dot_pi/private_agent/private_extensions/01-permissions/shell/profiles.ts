import type { ShellEffect } from "../types.ts";

type Verdict = { effect: ShellEffect; reason?: string };

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
const CHEZMOI_QUERY = new Set(["status", "diff", "verify", "managed", "unmanaged", "ignored", "cat", "source-path", "target-path", "dump-config", "cat-config", "help", "version", "completion"]);
const CHEZMOI_MUTATION = new Set(["add", "apply", "chattr", "destroy", "edit", "encrypt", "forget", "git", "import", "init", "merge", "merge-all", "purge", "re-add", "remove", "rm", "unmanage", "update", "upgrade"]);

function executable(name: string) {
  return name.replace(/^.*[\\/]/, "").toLowerCase();
}

function hasOption(argv: string[], ...names: string[]) {
  return argv.some((arg) => names.some((name) => arg === name
    || (name.startsWith("--") && arg.startsWith(`${name}=`))
    || (name.startsWith("-") && !name.startsWith("--") && arg.startsWith(name) && arg.length > name.length)));
}

export function classifyProfile(rawName: string, argv: string[]): Verdict {
  const name = executable(rawName);
  if (MUTATING.has(name)) return { effect: "mutating", reason: `${name} can change files or system state` };
  if (name === "sudo" || name === "doas") return { effect: "unknown", reason: `${name} runs with elevated privileges` };
  if (name === "su") return { effect: "unknown", reason: "su changes user identity" };
  if (EXECUTION_WRAPPERS.has(name)) return { effect: "unknown", reason: `${name} changes execution semantics` };
  if (INTERPRETERS.has(name)) return { effect: "unknown", reason: `${name} is a programmable interpreter` };

  if (name === "sed") {
    if (argv.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) {
      return { effect: "mutating", reason: "sed in-place mode writes files" };
    }
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
  if (name === "fd" && argv.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg) || /^-(?:x|X).+/.test(arg) || arg.startsWith("--exec="))) {
    return { effect: "unknown", reason: "fd execution options run another command" };
  }
  if (name === "rg" && hasOption(argv, "--pre")) return { effect: "unknown", reason: "rg --pre executes another command" };
  if (name === "find") return classifyFind(argv);
  if (name === "git") return classifyGit(argv);
  if (name === "chezmoi") return classifyChezmoi(argv);
  if (name === "glab" || name === "gh") return classifyForgeCli(name, argv);
  if (name === "command" && argv[0] === "-v" && argv.length === 2) return { effect: "read-only" };
  if (name === "env" && argv.length === 0) return { effect: "read-only" };
  if (["command", "env", "timeout"].includes(name)) return { effect: "unknown", reason: `${name} must be safely unwrapped before classification` };
  if (READ_ONLY.has(name)) return { effect: "read-only" };
  return { effect: "unknown", reason: `unreviewed executable: ${name || "(none)"}` };
}

function classifyFind(argv: string[]): Verdict {
  const unsafe = argv.find((arg) => ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(arg)
    || /^-(?:fprint|fprintf|fls)/.test(arg));
  return unsafe
    ? { effect: unsafe === "-delete" ? "mutating" : "unknown", reason: `find action ${unsafe} is not read-only` }
    : { effect: "read-only" };
}

function classifyForgeCli(name: "glab" | "gh", argv: string[]): Verdict {
  if (argv[0] === "issue" && argv[1] === "create") return { effect: "mutating", reason: `${name} issue create creates a remote issue` };
  return { effect: "unknown", reason: `unreviewed ${name} command` };
}

function classifyChezmoi(argv: string[]): Verdict {
  if (hasOption(argv, "-o", "--output")) return { effect: "mutating", reason: "chezmoi output option writes a file" };
  if (hasOption(argv, "--init", "--apply")) return { effect: "mutating", reason: "chezmoi initialization/application changes managed state" };
  const refresh = argv.findIndex((arg) => arg === "--refresh-externals" || arg.startsWith("--refresh-externals="));
  if (refresh >= 0) {
    const value = argv[refresh]!.includes("=") ? argv[refresh]!.split("=", 2)[1] : argv[refresh + 1];
    if (value !== "never") return { effect: "mutating", reason: "chezmoi external refresh can update its cache" };
  }
  if (["--config", "--source", "--destination", "--persistent-state", "--pager", "--diff-command"].some((option) => hasOption(argv, option))) {
    return { effect: "unknown", reason: "chezmoi path or helper overrides cross the reviewed configuration boundary" };
  }

  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const option = argv[index]!;
    if (option === "--") break;
    if (["-h", "--help", "--version", "-v", "--verbose", "--debug", "--no-tty", "--no-pager", "--use-builtin-diff", "--skip-secrets"].includes(option)
      || /^(?:--color|--log-level)=/.test(option)) { index++; continue; }
    if (["--color", "--log-level"].includes(option) && argv[index + 1]) { index += 2; continue; }
    if (option === "--refresh-externals" && argv[index + 1] === "never") { index += 2; continue; }
    if (option === "--refresh-externals=never") { index++; continue; }
    return { effect: "unknown", reason: `unreviewed chezmoi global option: ${option}` };
  }

  const subcommand = argv[index];
  if (!subcommand) return { effect: "read-only" };
  if (CHEZMOI_QUERY.has(subcommand)) return { effect: "read-only" };
  if (CHEZMOI_MUTATION.has(subcommand)) return { effect: "mutating", reason: `chezmoi ${subcommand} can change source, destination, or managed state` };
  return { effect: "unknown", reason: `unreviewed chezmoi subcommand: ${subcommand}` };
}

function classifyGit(argv: string[]): Verdict {
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const option = argv[index]!;
    if (option === "-c" || option.startsWith("-c") || ["-p", "--paginate"].includes(option)) {
      return { effect: "unknown", reason: "git configuration or paging can execute external programs" };
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(option)) {
      if (!argv[++index]) return { effect: "unknown", reason: `git option ${option} needs a value` };
    }
    else if (!option.startsWith("--no-pager") && !option.startsWith("--no-optional-locks")
      && !["--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"].includes(option)) {
      return { effect: "unknown", reason: `unreviewed git global option: ${option}` };
    }
    index++;
  }

  const subcommand = argv[index++];
  if (!subcommand) return { effect: "unknown", reason: "git subcommand is missing" };
  const args = argv.slice(index);
  if (["--ext-diff", "--textconv", "--open-files-in-pager", "--filters"].some((option) => hasOption(args, option))) {
    return { effect: "unknown", reason: "git query can execute an external helper" };
  }
  if (hasOption(args, "--output")) return { effect: "mutating", reason: "git output option writes a file" };
  if (GIT_QUERY.has(subcommand)) return { effect: "read-only" };
  if (subcommand === "branch") {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (args.length === 0 || hasOption(args, "--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged")) return { effect: "read-only" };
    return positional.length ? { effect: "mutating", reason: "git branch arguments can create or change branches" } : { effect: "unknown", reason: "unreviewed git branch options" };
  }
  if (subcommand === "worktree") return args[0] === "list" ? { effect: "read-only" } : { effect: "mutating", reason: "only git worktree list is read-only" };
  if (subcommand === "remote") return args.length === 1 && args[0] === "-v" ? { effect: "read-only" } : { effect: "mutating", reason: "only git remote -v is read-only" };
  if (subcommand === "tag") return args.length === 0 || hasOption(args, "-l", "--list") ? { effect: "read-only" } : { effect: "mutating", reason: "git tag arguments can create tags" };
  if (subcommand === "config") {
    return args.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"].includes(arg))
      ? { effect: "read-only" }
      : { effect: "mutating", reason: "git config form can change configuration" };
  }
  if (subcommand === "commit") return { effect: "mutating", reason: "git commit creates a commit and updates repository history" };
  return { effect: "mutating", reason: `git ${subcommand} can change repository state` };
}
