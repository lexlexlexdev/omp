import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lexShellCommand } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { checkGit, gitChangesContext, gitReadOnly } from "./safety/git";

// Intentionally small: source directories and dependencies are not cleanup targets.
export const CLEANUP_DIRECTORIES = new Set(["dist", "build", "out", ".next", "coverage", ".cache", ".tmp"]);
const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true };
const dynamic = (value: string) => /[$`*?\[\]{}~]/.test(value);
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const fail = (reason: string) => `Safety rails: ${reason}`;

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = resolve(path, "..");
    if (parent === path) throw error;
    return resolve(await canonical(parent), basename(path));
  }
}

async function workspace(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  return canonical(await proc.exited === 0 ? output.trim() : cwd);
}

async function checkDeletion(targets: string[], cwd: string, generatedOnly = true): Promise<string | undefined> {
  if (!targets.length) return fail("Deletion has no literal target. Use an explicit generated-directory path.");
  const root = await workspace(cwd);
  const home = await canonical(homedir());
  const actualCwd = await canonical(cwd);
  for (const target of targets) {
    if (dynamic(target)) return fail(`Dynamic deletion target '${target}' is not allowed. Use a literal generated-directory path.`);
    // Do not normalize away a symlink followed by '..': the kernel walks the link first.
    const components = target.split(sep).filter(part => part && part !== ".");
    const firstName = components.findIndex(part => part !== "..");
    if (components.includes(".git") || (firstName >= 0 && components.slice(firstName).includes(".."))) {
      return fail(`Deletion target '${target}' traverses metadata or an unresolved parent. Use a direct path.`);
    }
    const lexical = resolve(actualCwd, target);
    const actual = await canonical(lexical);
    if (!inside(root, lexical) || !inside(root, actual) || actual === root || actual === home || actual === sep) {
      return fail(`Deletion of '${target}' reaches a protected root or leaves the workspace.`);
    }
    const parts = relative(root, lexical).split(sep);
    if (parts.includes(".git") || (generatedOnly && !CLEANUP_DIRECTORIES.has(parts[0]))) {
      return fail(`Deletion of '${target}' is outside approved generated directories (${[...CLEANUP_DIRECTORIES].join(", ")}).`);
    }
    // No symlink component may redirect a cleanup path, even within this repository.
    let current = root;
    for (const part of parts) {
      current = resolve(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) return fail(`Deletion through symlink '${current}' is not allowed.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}

function unwrap(argv: string[]): string[] {
  let args = [...argv];
  while (args.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
      // Git environment overrides can change the repository or effective configuration.
      if (/^(GIT_|HOME=|XDG_CONFIG_HOME=|GH_CONFIG_DIR=|PATH=|CDPATH=|ENV=|BASH_ENV=|ZDOTDIR=)/.test(args[0])) return ["__unsafe_environment"];
      args.shift();
    } else if (["command", "exec", "builtin", "rtk"].includes(basename(args[0]))) {
      const wrapper = basename(args.shift()!);
      if (wrapper === "command") {
        if (args[0] === "-v" || args[0] === "-V") return ["__inspection"];
        if (args[0] === "-p") args.shift();
      }
      if (args[0] === "--") args.shift();
      if (args[0]?.startsWith("-")) return ["__unsafe_environment"];
    } else if (args[0] === "!" || basename(args[0]) === "time") {
      args.shift();
      if (args[0] === "-p") args.shift();
    } else if (basename(args[0]) === "env") {
      args.shift();
      if (args[0] === "--") args.shift();
      if (args[0]?.startsWith("-")) return ["__unsafe_environment"];
    } else if (["timeout", "gtimeout", "nice", "nohup"].includes(basename(args[0]))) {
      const wrapper = basename(args.shift()!);
      if (wrapper === "nice" && ["-n", "--adjustment"].includes(args[0])) args.splice(0, 2);
      if (wrapper === "timeout" || wrapper === "gtimeout") {
        while (args[0]?.startsWith("-")) {
          if (["-k", "--kill-after", "-s", "--signal"].includes(args[0])) args.splice(0, 2);
          else args.shift();
        }
        args.shift();
      }
    } else break;
  }
  return args;
}

function hasExpansion(raw: string, commandsOnly = false): boolean {
  let quote = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote === "'") { if (char === "'") quote = ""; continue; }
    if (char === "\\") { index++; continue; }
    if (char === '"' || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = "";
      continue;
    }
    if (char === "`" || (char === "$" && (!commandsOnly || raw[index + 1] === "("))) return true;
  }
  return quote !== "";
}


async function checkCommand(command: string, cwd: string, depth: number): Promise<string | undefined> {
  if (depth > 4) return fail("Shell wrappers are too deeply nested to inspect.");
  command = normalizeContinuations(command);
  if (hasExpansion(command, true)) return fail("Command substitution cannot be inspected safely. Run the inner command as a separate literal call.");
  // Native critical checks are only approval overrides and are bypassed in yolo.
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/.test(command) ||
      /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b/.test(command) ||
      /(?:\b(?:sh|bash|zsh|source)\s+|(?:^|[;&|]\s*)\.\s+)<\(\s*(?:curl|wget|fetch)\b/.test(command) ||
      /\beval\b.*(?:curl|wget|fetch)\b/.test(command) ||
      /(?:>|\btee\s+(?:-a\s+)?)\s*\/?etc\/(?:passwd|shadow|sudoers)\b/.test(command)) {
    return fail("Catastrophic host operation or remote-script execution is not allowed.");
  }
  const tokens = lexShellCommand(command);
  const segments: { argv: string[]; raw: string; boundary: string }[] = [];
  let argv: string[] = [], raw = "";
  for (const token of tokens) {
    if (token.kind === "word") { argv.push(token.value); raw += token.raw + " "; }
    else if (/[;&|()\n]/.test(token.raw)) {
      if (argv.length) segments.push({ argv, raw, boundary: token.raw.trim() });
      argv = []; raw = "";
    }
  }
  if (argv.length) segments.push({ argv, raw, boundary: "" });
  let current = cwd;
  let changedGitState = false;
  for (const segment of segments) {
    let args = unwrap(segment.argv);
    if (!args.length) continue;
    if (/^\d*[<>]/.test(args[0])) return fail("Leading redirections hide the executable. Put the literal command first.");
    const name = basename(args[0]);
    args = [name, ...args.slice(1)];
    if (name === "__unsafe_environment") return fail("Repository/configuration environment overrides cannot be inspected safely. Use cwd and git -C instead.");
    if (name === "cd" || name === "chdir") {
      if (args.length !== 2 || dynamic(args[1]) || (segment.boundary && segment.boundary !== "&&") || segments.some(item => /[|()]/.test(item.boundary) || item.boundary === "&")) return fail("Use a literal cwd instead of conditional, piped, or dynamic directory changes.");
      current = resolve(current, args[1]);
      continue;
    }
    if (dynamic(name)) return fail("Dynamic executable names cannot be inspected. Use a literal command.");
    if (["pushd", "popd", "source", ".", "eval"].includes(name) || (name === "alias" && args.length > 1)) return fail("Shell state/evaluation changes are not inspected. Use cwd and separate literal commands.");
    if (["export", "unset", "declare", "typeset", "local", "readonly", "read"].includes(name) && /\b(?:GIT_|GH_CONFIG_DIR|HOME|XDG_CONFIG_HOME|PATH|CDPATH|ENV|BASH_ENV|ZDOTDIR)/.test(segment.raw)) return fail("Shell repository/configuration environment changes cannot be inspected safely.");
    if (["if", "then", "elif", "else", "for", "while", "until", "do", "case", "function", "alias", "eval", "source", ".", "pushd", "popd", "export", "unset", "set", "declare", "typeset", "local", "readonly", "read"].includes(name) && /\b(?:git|rm|rmdir|find|gh)\b/.test(command)) {
      return fail("Safety-sensitive shell control flow cannot be inspected. Use separate literal calls.");
    }
    if (Object.hasOwn(SHELLS, name)) {
      const flag = args.findIndex((arg, index) => index > 0 && /^-[^-]*c/.test(arg));
      if (flag >= 0 && args[flag + 1] && args.length === flag + 2) {
        const reason = await checkCommand(args[flag + 1], current, depth + 1);
        if (reason) return reason;
        changedGitState = true;
        continue;
      }
      if (flag >= 0 || args.some(arg => /^-[^-]*s/.test(arg)) || args.length === 1) return fail("Shell payload is not a single literal command or script path.");
      let scriptIndex = 1;
      while (args[scriptIndex]?.startsWith("-") && args[scriptIndex] !== "-") {
        const option = args[scriptIndex++];
        if (option === "--") break;
        if (/^-[euxv]+$/.test(option) || ["--noprofile", "--norc", "--posix"].includes(option)) continue;
        if (/^-[euxv]*[oO]$/.test(option)) { scriptIndex++; continue; }
        return fail("Shell startup options cannot establish a literal script boundary.");
      }
      if (!args[scriptIndex] || args[scriptIndex] === "-" || /^[<>]/.test(args[scriptIndex])) return fail("Shell stdin execution is not allowed. Use a literal -c command or explicit script path.");
      // Shell scripts are executable code, not statically inspected by this guard.
      continue;
    }
    const sensitive = ["git", "rm", "rmdir", "find", "gh"].includes(name);
    if (sensitive && (hasExpansion(segment.raw) || segment.raw.includes("<<"))) return fail("Dynamic safety-sensitive shell commands cannot be inspected. Use literal arguments in a separate call.");
    if (sensitive && segments.some(item => /[()]/.test(item.boundary))) return fail("Grouped safety-sensitive commands must be split into separate literal calls.");
    if (["xargs", "parallel", "busybox"].includes(name) && /\b(?:git|rm|rmdir|find|gh)\b/.test(segment.raw)) return fail("Indirect safety-sensitive commands must be run as separate literal calls.");
    if (["sudo", "su", "doas", "mkfs", "dd", "shred", "cryptsetup", "shutdown", "reboot", "poweroff", "halt"].includes(name) || name.startsWith("mkfs.")) {
      return fail(`Host-level operation '${name}' is not allowed.`);
    }
    if (["chmod", "chown", "chgrp"].includes(name) && args.some(arg => /^-[^-]*[Rr]/.test(arg) || arg === "--recursive")) return fail("Recursive permission/ownership changes are not allowed.");
    if (name === "git") {
      if (changedGitState && !gitReadOnly(args)) return fail("Split Git state changes and subsequent mutations into separate calls so each target can be checked.");
      const reason = await checkGit(args, current);
      if (reason) return fail(reason);
      if (gitChangesContext(args)) changedGitState = true;
    }
    if (name === "gh") {
      const result = await checkGh(args, current);
      if (result.reason) return fail(result.reason);
      if (result.changesContext) changedGitState = true;
    }
    if (name === "rm" || name === "rmdir") {
      let options = true;
      const targets: string[] = [];
      let recursive = false;
      for (const arg of args.slice(1)) {
        if (options && arg === "--") { options = false; continue; }
        if (options && arg.startsWith("-")) {
          if (name === "rmdir" && (arg === "--parents" || /^-[^-]*p/.test(arg))) return fail("rmdir --parents can remove unchecked ancestors. Use an explicit directory.");
          if (arg === "--recursive" || /^-[^-]*[rR]/.test(arg)) recursive = true;
          continue;
        }
        targets.push(arg);
      }
      const reason = await checkDeletion(targets, current, recursive);
      if (reason) return reason;
    }
    if (name === "find" && args.some(arg => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
      if (args.some(arg => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) return fail("find execution actions are not inspected. Use explicit cleanup targets.");
      const roots = args.slice(1).filter((arg, index, all) => !arg.startsWith("-") && all.slice(0, index).every(item => !item.startsWith("-")));
      const reason = await checkDeletion(roots.length ? roots : ["."], current);
      if (reason) return reason;
    }
  }
}

export async function checkShell(command: string, cwd: string): Promise<string | undefined> {
  try { return await checkCommand(command, isAbsolute(cwd) ? cwd : resolve(cwd), 0); }
  catch (error) { return fail(`Cannot verify command safety: ${error instanceof Error ? error.message : String(error)}. Use a separate literal command.`); }
}

export default function safetyRails(pi: ExtensionAPI) {
  pi.setLabel("Safety Rails");
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const cwd = typeof event.input.cwd === "string" ? resolve(ctx.cwd, event.input.cwd) : ctx.cwd;
    const reason = await checkShell(event.input.command, cwd);
    if (reason) return { block: true, reason };
  });
  pi.on("user_bash", async (event, ctx) => {
    const reason = await checkShell(event.command, ctx.cwd);
    if (reason) return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
  });
}

function normalizeContinuations(command: string): string {
  let result = "", quote = "";
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      result += char;
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\\") {
      if (command[index + 1] === "\n") { index++; continue; }
      result += char;
      if (index + 1 < command.length) result += command[++index];
      continue;
    }
    if (char === '"' || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = "";
    }
    result += char;
  }
  return result;
}

async function checkGh(argv: string[], cwd: string, depth = 0): Promise<{ reason?: string; changesContext?: boolean }> {
  if (depth > 4) return { reason: "GitHub CLI alias recursion is too deep." };
  const args: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (["-R", "--repo", "--hostname"].includes(arg)) { index++; continue; }
    if (/^(?:-R.+|--repo=|--hostname=)/.test(arg)) continue;
    args.push(arg);
  }
  const command = args[0];
  if (!command || command.startsWith("-")) return {};
  if (command === "alias") {
    return !args[1] || args[1] === "list" ? {} : { reason: "Changing GitHub CLI aliases is not allowed inside guarded calls." };
  }
  const builtins = ["api", "auth", "browse", "codespace", "completion", "config", "extension", "gist", "gpg-key", "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "workflow", "attestation", "cache", "help"];
  if (!builtins.includes(command)) {
    const proc = Bun.spawn(["gh", "alias", "list"], { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, NO_COLOR: "1", GH_FORCE_TTY: "0", GH_PAGER: "cat" } });
    const output = await new Response(proc.stdout).text();
    if (await proc.exited !== 0) return { reason: "GitHub CLI aliases could not be inspected." };
    const line = output.split("\n").find(line => line.startsWith(command + ":"));
    const expansion = line?.slice(command.length + 1).trim();
    if (!expansion || /[!$`;|&<>()]/.test(expansion)) return { reason: `GitHub CLI command '${command}' is not a verified literal alias.` };
    const tokens = lexShellCommand(expansion);
    return checkGh(["gh", ...tokens.filter(token => token.kind === "word").map(token => token.value), ...args.slice(1)], cwd, depth + 1);
  }
  const action = args.slice(1).find(arg => !arg.startsWith("-"));
  if (command === "pr" && action === "merge") return { reason: "Automatic PR merging is not allowed. Open the PR for review instead." };
  if (command === "repo" && ["sync", "delete"].includes(action ?? "")) return { reason: "Repository sync/deletion is not allowed. Use a feature branch and open a PR." };
  if (command === "pr" && action === "checkout") return { changesContext: true };
  if (command === "api") {
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--") break;
      if (/^--(?:method|field|raw-field|input)(?:=|$)/.test(arg)) return { reason: "Explicit API methods and payloads are not allowed. Use the feature-branch/PR workflow." };
      if (["--header", "--jq", "--template", "--cache"].includes(arg)) { index++; continue; }
      if (!arg.startsWith("-") || arg.startsWith("--")) continue;
      for (let offset = 1; offset < arg.length; offset++) {
        const flag = arg[offset];
        if ("XfF".includes(flag)) return { reason: "API method/payload flags, including shorthand clusters, are not allowed." };
        if ("Hqt".includes(flag)) { if (offset === arg.length - 1) index++; break; }
        if (!"ips".includes(flag)) return { reason: `GitHub API flag '-${flag}' cannot be inspected safely.` };
      }
    }
  }
  return {};
}
