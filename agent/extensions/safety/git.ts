import { dirname, isAbsolute, resolve, sep } from "node:path"
import { realpath } from "node:fs/promises"

const PROTECTED_BRANCHES = new Set(["main", "master", "dev", "develop"])
const READ_COMMANDS = new Set([
  "status", "log", "show", "diff", "diff-tree", "diff-files", "diff-index", "rev-parse",
  "rev-list", "ls-files", "ls-tree", "grep", "blame", "shortlog", "describe", "cat-file",
  "check-ignore", "check-attr", "check-ref-format", "for-each-ref", "count-objects",
  "verify-commit", "verify-tag", "merge-base", "name-rev", "whatchanged", "show-ref",
  "ls-remote", "help", "version", "var", "fsck",
])

const GLOBAL_FLAGS = new Set([
  "--no-pager", "--paginate", "-p", "--no-replace-objects", "--no-lazy-fetch",
  "--no-optional-locks", "--no-advice", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--bare", "--version", "--help",
  "--html-path", "--man-path", "--info-path",
])
const GLOBAL_VALUE_OPTIONS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--config-env", "--namespace", "--super-prefix",
])
const GLOBAL_UNSAFE_MUTATION_OPTIONS = new Set([
  "-c", "--git-dir", "--work-tree", "--exec-path", "--config-env", "--namespace", "--bare",
  "--super-prefix",
])
const MUTATION_ENV_NAMES = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
])
const OPAQUE_EXEC_ENV_NAMES = new Set(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND"])

type QueryResult = { code: number; stdout: string; stderr: string }
type Invocation = {
  executable: string
  cwd: string
  globalArgs: string[]
  globalOptions: string[]
  command: string
  args: string[]
}
type ParseResult = { invocation?: Invocation; error?: string }
type RepositoryState = { branch: string | null }

const ACTION = "switch to a feature branch (for example, `git switch -c feature/<name>`) and retry"

function blocked(operation: string, detail: string, nextAction = ACTION): string {
  return `Blocked ${operation}: ${detail}. Safe next action: ${nextAction}.`
}

function parseInvocation(argv: string[], cwd: string): ParseResult {
  if (!argv.length || !argv[0]) return { error: "the Git executable is missing" }
  const executable = argv[0]
  const basename = executable.replaceAll("\\", "/").split("/").at(-1)
  if (basename !== "git" && basename !== "git.exe") {
    return { error: "the executable is not Git" }
  }

  const globalArgs: string[] = []
  const globalOptions: string[] = []
  let index = 1
  for (; index < argv.length; index++) {
    const token = argv[index]
    if (token === "--") return { error: "an option terminator appeared before the Git subcommand" }
    if (GLOBAL_VALUE_OPTIONS.has(token)) {
      const value = argv[index + 1]
      if (value === undefined) return { error: `global option ${token} has no value` }
      globalArgs.push(token, value)
      globalOptions.push(token)
      index++
      continue
    }
    if (["--git-dir=", "--work-tree=", "--exec-path=", "--config-env=", "--namespace=", "--super-prefix="].some(prefix => token.startsWith(prefix))) {
      const option = token.slice(0, token.indexOf("="))
      if (!token.slice(token.indexOf("=") + 1)) return { error: `global option ${option} has no value` }
      globalArgs.push(token)
      globalOptions.push(option)
      continue
    }
    if (token.startsWith("-C") && token.length > 2) {
      globalArgs.push(token)
      globalOptions.push("-C")
      continue
    }
    if (token.startsWith("-c") && token.length > 2) {
      globalArgs.push(token)
      globalOptions.push("-c")
      continue
    }
    if (token.startsWith("-") && GLOBAL_FLAGS.has(token)) {
      globalArgs.push(token)
      globalOptions.push(token)
      continue
    }
    if (token.startsWith("-")) return { error: `unrecognized Git global option ${token}` }
    const command = token
    return {
      invocation: {
        executable,
        cwd,
        globalArgs,
        globalOptions,
        command,
        args: argv.slice(index + 1),
      },
    }
  }

  return {
    invocation: {
      executable,
      cwd,
      globalArgs,
      globalOptions,
      command: "",
      args: [],
    },
  }
}

async function runGit(invocation: Invocation, args: string[]): Promise<QueryResult | undefined> {
  try {
    const child = Bun.spawn([invocation.executable, ...invocation.globalArgs, ...args], {
      cwd: invocation.cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  } catch {
    return undefined
  }
}

async function configValues(invocation: Invocation, key: string): Promise<{ ok: true; values: string[] } | { ok: false }> {
  const result = await runGit(invocation, ["config", "--null", "--get-all", key])
  if (!result) return { ok: false }
  if (result.code === 1) return { ok: true, values: [] }
  if (result.code !== 0) return { ok: false }
  const output = result.stdout.endsWith("\0") ? result.stdout.slice(0, -1) : result.stdout
  return { ok: true, values: output ? output.split("\0") : result.stdout === "\0" ? [""] : [] }
}

async function oneConfigValue(invocation: Invocation, key: string): Promise<{ ok: true; value?: string } | { ok: false }> {
  const result = await configValues(invocation, key)
  if (!result.ok || result.values.length > 1) return { ok: false }
  return { ok: true, value: result.values[0] }
}

async function expandAlias(invocation: Invocation): Promise<{ invocation: Invocation } | { reason: string }> {
  let current = invocation
  const visited = new Set<string>()
  for (let depth = 0; depth < 8; depth++) {
    if (!current.command || current.command === "--help" || current.command === "--version") return { invocation: current }
    // Git aliases apply only to commands not implemented as built-ins.
    if (KNOWN_GIT_COMMANDS.has(current.command)) return { invocation: current }
    if (visited.has(current.command)) {
      return { reason: blocked(`Git alias ${current.command}`, "the alias chain is recursive", "invoke a supported Git built-in directly") }
    }
    visited.add(current.command)
    const alias = await oneConfigValue(current, `alias.${current.command}`)
    if (!alias.ok) {
      return { reason: blocked(`Git command ${current.command}`, "its effective alias could not be read safely", "invoke a supported Git built-in directly") }
    }
    if (alias.value === undefined) {
      return { reason: blocked(`Git command ${current.command}`, "unknown and external Git commands are opaque", "invoke a supported Git built-in directly") }
    }
    const definition = alias.value.trim()
    if (!definition || definition.startsWith("!") || !/^[A-Za-z0-9._/:@=+*,-]+(?:\s+[A-Za-z0-9._/:@=+*,-]+)*$/.test(definition)) {
      return { reason: blocked(`Git alias ${current.command}`, "shell aliases and complex expansions are not classifiable", "replace it with a simple built-in alias or invoke the built-in directly") }
    }
    const words = definition.split(/\s+/)
    if (!words.length || words[0] === "git" || words[0].startsWith("-")) {
      return { reason: blocked(`Git alias ${current.command}`, "its expansion is not a simple Git built-in", "invoke a supported Git built-in directly") }
    }
    current = { ...current, command: words[0], args: [...words.slice(1), ...current.args] }
  }
  return { reason: blocked("Git alias", "the alias chain is too deep to classify", "invoke a supported Git built-in directly") }
}

const KNOWN_GIT_COMMANDS = new Set([
  ...READ_COMMANDS,
  "add", "am", "apply", "archive", "bisect", "branch", "checkout", "cherry-pick", "clean",
  "clone", "commit", "commit-graph", "config", "fetch", "filter-branch", "gc", "init",
  "maintenance", "merge", "mv", "notes", "pull", "push", "rebase", "reflog", "remote",
  "replace", "reset", "restore", "revert", "rm", "stash", "submodule", "switch", "tag",
  "update-ref", "symbolic-ref", "worktree",
])

function isProtectedBranch(branch: string | null | undefined): boolean {
  return branch !== null && branch !== undefined && PROTECTED_BRANCHES.has(branch)
}


function protectedRefName(ref: string): string | undefined {
  if (ref.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length)
    return isProtectedBranch(branch) ? branch : undefined
  }
  if (ref.startsWith("heads/")) {
    const branch = ref.slice("heads/".length)
    return isProtectedBranch(branch) ? branch : undefined
  }
  if (!ref.startsWith("refs/") && isProtectedBranch(ref)) return ref
  return undefined
}

function mutationEnvironmentIssue(): string | undefined {
  for (const name of MUTATION_ENV_NAMES) {
    if (process.env[name] !== undefined) return `${name} redirects repository or configuration state`
  }
  for (const name of OPAQUE_EXEC_ENV_NAMES) {
    if (process.env[name] !== undefined) return `${name} overrides Git transport execution`
  }
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) return `${name} injects Git configuration`
  }
  return undefined
}

function globalMutationIssue(invocation: Invocation): string | undefined {
  for (const option of invocation.globalOptions) {
    if (GLOBAL_UNSAFE_MUTATION_OPTIONS.has(option)) return `${option} can redirect or override mutation context`
  }
  return mutationEnvironmentIssue()
}

async function repositoryState(invocation: Invocation): Promise<{ ok: true; state: RepositoryState } | { ok: false }> {
  const repo = await runGit(invocation, ["rev-parse", "--git-dir"])
  if (!repo || repo.code !== 0) return { ok: false }
  const branch = await runGit(invocation, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (!branch) return { ok: false }
  if (branch.code === 0) {
    const name = branch.stdout.trim()
    if (!name) return { ok: false }
    return { ok: true, state: { branch: name } }
  }
  if (branch.code === 1) return { ok: true, state: { branch: null } }
  return { ok: false }
}

async function currentBranch(invocation: Invocation): Promise<{ ok: true; branch: string | null } | { ok: false }> {
  const result = await repositoryState(invocation)
  return result.ok ? { ok: true, branch: result.state.branch } : { ok: false }
}

async function ensureMutableRepository(invocation: Invocation, operation: string): Promise<{ branch: string | null } | string> {
  const state = await currentBranch(invocation)
  if (!state.ok) return blocked(operation, "repository and current-branch metadata could not be verified", "run the command from the intended repository without Git redirection options")
  return { branch: state.branch }
}


function shortFlagPresent(token: string, flag: string): boolean {
  return token.length > 2 && token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes(flag)
}

function containsOption(args: string[], longOptions: string[], shortFlags: string[] = []): boolean {
  for (const token of args) {
    if (longOptions.some(option => token === option || token.startsWith(`${option}=`))) return true
    if (shortFlags.some(flag => token === flag || shortFlagPresent(token, flag))) return true
  }
  return false
}


async function refExists(invocation: Invocation, ref: string): Promise<boolean | undefined> {
  const result = await runGit(invocation, ["show-ref", "--verify", "--quiet", ref])
  if (!result) return undefined
  if (result.code === 0) return true
  if (result.code === 1) return false
  return undefined
}

async function commitExists(invocation: Invocation, revision: string): Promise<boolean | undefined> {
  const result = await runGit(invocation, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])
  if (!result) return undefined
  if (result.code === 0) return true
  if (result.code === 1) return false
  return undefined
}

type CreateBranch = { mode: "create" | "force-create" | "orphan"; name: string; startPoint?: string }

function parseCreateBranch(args: string[], command: "checkout" | "switch"): { create?: CreateBranch; error?: string } {
  const delimiter = args.indexOf("--")
  const before = delimiter < 0 ? args : args.slice(0, delimiter)
  const after = delimiter < 0 ? [] : args.slice(delimiter + 1)
  if (after.length) return { error: "path operands discard or overwrite worktree content" }

  let mode: CreateBranch["mode"] | undefined
  let name: string | undefined
  let startPoint: string | undefined
  const positionals: string[] = []
  const allowed = command === "checkout"
    ? new Set(["-q", "--quiet", "-f", "--force", "-m", "--merge", "--detach", "--ignore-other-worktrees", "--guess", "--no-guess", "--overlay", "--no-overlay", "--ignore-skip-worktree-bits", "--progress", "--no-progress", "--ours", "--theirs", "-p", "--patch", "--track", "--orphan", "-b", "-B", "--branch", "--conflict", "--recurse-submodules"])
    : new Set(["-q", "--quiet", "-f", "--force", "--discard-changes", "--merge", "--detach", "--guess", "--no-guess", "--ignore-other-worktrees", "--progress", "--no-progress", "--track", "--orphan", "-c", "-C", "--create", "--force-create", "--recurse-submodules"])

  for (let index = 0; index < before.length; index++) {
    const token = before[index]
    const equals = token.indexOf("=")
    const option = equals > 0 ? token.slice(0, equals) : token
    const inlineValue = equals > 0 ? token.slice(equals + 1) : undefined

    let currentMode: CreateBranch["mode"] | undefined
    if (command === "checkout") {
      if (option === "-b" || option === "--branch") currentMode = "create"
      else if (option === "-B") currentMode = "force-create"
      else if (option === "--orphan") currentMode = "orphan"
    } else {
      if (option === "-c" || option === "--create") currentMode = "create"
      else if (option === "-C" || option === "--force-create") currentMode = "force-create"
      else if (option === "--orphan") currentMode = "orphan"
    }
    if (currentMode) {
      if (mode) return { error: "multiple branch-creation modes are ambiguous" }
      mode = currentMode
      let value = inlineValue
      if (value === undefined) {
        value = before[++index]
        if (value === undefined) return { error: `${option} has no branch name` }
      }
      name = value
      continue
    }

    if (command === "checkout" && (option === "--conflict")) {
      if (inlineValue === undefined) index++
      if (inlineValue === undefined && before[index] === undefined) return { error: "--conflict has no value" }
      continue
    }
    if (command === "checkout" && (option === "--track" || option === "--recurse-submodules")) {
      // These options accept optional values; Git consumes only `=value`.
      continue
    }
    if (command === "switch" && (option === "--track" || option === "--recurse-submodules")) continue
    if (command === "switch" && option === "--orphan") {
      if (mode) return { error: "multiple branch-creation modes are ambiguous" }
      mode = "orphan"
      const value = inlineValue ?? before[++index]
      if (value === undefined) return { error: "--orphan has no branch name" }
      name = value
      continue
    }
    if (command === "checkout" && option === "--orphan") {
      if (mode) return { error: "multiple branch-creation modes are ambiguous" }
      mode = "orphan"
      const value = inlineValue ?? before[++index]
      if (value === undefined) return { error: "--orphan has no branch name" }
      name = value
      continue
    }

    if (option.startsWith("--") && !allowed.has(option)) return { error: `option ${option} cannot be classified safely` }
    if (option.startsWith("-") && !option.startsWith("--")) {
      if (option === "-b" || option === "-B" || option === "-c" || option === "-C") continue
      const chars = option.slice(1)
      let consumed = false
      for (let charIndex = 0; charIndex < chars.length; charIndex++) {
        const flag = `-${chars[charIndex]}`
        if (command === "checkout" && (flag === "-b" || flag === "-B")) {
          if (mode) return { error: "multiple branch-creation modes are ambiguous" }
          mode = flag === "-b" ? "create" : "force-create"
          const attached = chars.slice(charIndex + 1)
          const value = attached || before[++index]
          if (!value) return { error: `${flag} has no branch name` }
          name = value
          consumed = true
          break
        }
        if (command === "switch" && (flag === "-c" || flag === "-C")) {
          if (mode) return { error: "multiple branch-creation modes are ambiguous" }
          mode = flag === "-c" ? "create" : "force-create"
          const attached = chars.slice(charIndex + 1)
          const value = attached || before[++index]
          if (!value) return { error: `${flag} has no branch name` }
          name = value
          consumed = true
          break
        }
        if (!["-q", "-f", "-m", "-d", "-t", "-p", "-o", "-i", "-r", "-v"].includes(flag)) {
          return { error: `option ${flag} cannot be classified safely` }
        }
      }
      if (consumed) continue
      continue
    }
    positionals.push(token)
  }

  if (mode && name === undefined) return { error: "branch name could not be determined" }
  if (mode && positionals.length) startPoint = positionals[0]
  return { create: mode ? { mode, name: name!, startPoint } : undefined }
}

async function checkCheckout(invocation: Invocation): Promise<string | undefined> {
  const { command, args } = invocation
  const parsed = parseCreateBranch(args, command as "checkout" | "switch")
  if (parsed.error) {
    const force = containsOption(args, ["--force", "--discard-changes"], ["-f"])
    return blocked(`${command}`, parsed.error, force
      ? "remove the force/discard option and preserve local work before switching"
      : "use `git switch <existing-branch>` for branch changes; use `git restore --staged` only for unstaging")
  }
  const force = containsOption(args, ["--force", "--discard-changes"], ["-f"])
  if (force) {
    return blocked(`${command}`, "forced switching can discard local changes", "preserve or stash local work, then retry without `-f` or `--force`")
  }
  if (containsOption(args, ["--ours", "--theirs", "--patch"], ["-p"])) {
    return blocked(`${command}`, "interactive or conflict-side checkout can overwrite worktree content", "preserve the worktree and use a normal branch switch")
  }
  if (parsed.create?.mode === "force-create" && isProtectedBranch(parsed.create.name)) {
    return blocked(`${command} ${parsed.create.name}`, `it would reset protected local branch ${parsed.create.name}`, "create or switch to a non-protected feature branch without force-creating a protected name")
  }
  if (parsed.create) return undefined

  const delimiter = args.indexOf("--")
  const before = delimiter < 0 ? args : args.slice(0, delimiter)
  const positionals: string[] = []
  for (let index = 0; index < before.length; index++) {
    const token = before[index]
    const option = token.split("=", 1)[0]
    if (option === "--conflict") { if (!token.includes("=")) index++; continue }
    if (option.startsWith("-") && option !== "-") continue
    positionals.push(token)
  }
  if (!positionals.length) return undefined
  if (positionals.length !== 1) {
    return blocked(command, "multiple checkout targets are ambiguous", "switch to one named branch at a time")
  }

  const target = positionals[0]
  const state = await currentBranch(invocation)
  if (!state.ok) return blocked(command, "repository metadata could not verify the checkout target", "run the command from the intended repository")
  const branchRef = target.startsWith("refs/heads/") ? target : `refs/heads/${target}`
  const localBranch = await refExists(invocation, branchRef)
  if (localBranch === undefined) return blocked(command, "local branch metadata could not be read safely", "run `git branch --list` and use an explicit existing branch")
  if (localBranch) return undefined
  const isCommit = await commitExists(invocation, target)
  if (isCommit === undefined) return blocked(command, "revision metadata could not be read safely", "run `git show-ref` and use an explicit existing branch or commit")
  if (isCommit) return undefined
  return blocked(command, `target ${target} is not proven to be a branch or commit and may be a worktree path`, "use `git switch <existing-branch>` for a branch, or preserve the file before restoring it")
}

function checkRestore(args: string[]): string | undefined {
  let staged = false
  let worktree = false
  let interactive = false
  let pathPhase = false
  const valueOptions = new Set(["--source", "-s", "--pathspec-from-file"])
  const flagOptions = new Set(["--ignore-unmerged", "--overlay", "--no-overlay", "--quiet", "-q", "--pathspec-file-nul"])
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "--") { pathPhase = true; continue }
    if (pathPhase) continue
    const option = token.split("=", 1)[0]
    if (option === "--staged" || option === "-S") staged = true
    else if (option === "--worktree" || option === "-W") worktree = true
    else if (option === "--patch" || option === "-p" || option === "--ours" || option === "--theirs" || option === "--merge") interactive = true
    else if (valueOptions.has(option)) {
      if (!token.includes("=")) {
        if (args[index + 1] === undefined) return blocked("git restore", `${option} has no value`, "use `git restore --staged [path]` to unstage")
        index++
      }
    } else if (flagOptions.has(option)) continue
    else if (token.startsWith("-")) return blocked("git restore", `option ${option} cannot be classified safely`, "use only `git restore --staged [path]` for unstaging")
  }
  if (!staged || worktree || interactive) {
    return blocked("git restore", "only staged-only restores are allowed; worktree restore can discard changes", "use `git restore --staged [path]` to unstage, or preserve the worktree before restoring it")
  }
  return undefined
}

async function checkBranch(invocation: Invocation): Promise<string | undefined> {
  const args = invocation.args
  let action: "delete" | "move" | "copy" | "force" | "upstream" | "create" | undefined
  let remoteBranches = false
  let listMode = args.length === 0
  let force = false
  const positionals: string[] = []
  const recognizedLong = new Set([
    "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--track", "--no-track",
    "--unset-upstream", "--edit-description", "--create-reflog", "--color", "--no-color", "--column",
    "--no-column", "--list", "--all", "--remotes", "--verbose", "--no-merged", "--merged",
    "--contains", "--no-contains", "--points-at", "--sort", "--format", "--abbrev", "--ignore-case",
    "--omit-empty", "--show-current", "--recurse-submodules", "--no-recurse-submodules", "--end-of-options",
    "--unset-upstream", "--set-branch-description",
  ])
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    const option = token.split("=", 1)[0]
    if (token === "--") { positionals.push(...args.slice(index + 1)); break }
    if (option.startsWith("--")) {
      if (!recognizedLong.has(option)) return blocked("git branch", `option ${option} cannot be classified safely`, "invoke a simple branch list or an explicit supported branch operation")
      if (option === "--list" || option === "--all" || option === "--remotes" || option === "--verbose" || option === "--show-current") listMode = true
      if (option === "--remotes") remoteBranches = true
      if (option === "--delete") action = "delete"
      else if (option === "--move") action = "move"
      else if (option === "--copy") action = "copy"
      else if (option === "--force") { force = true; action ??= "force" }
      else if (option === "--set-upstream-to" || option === "--unset-upstream") action ??= "upstream"
      else if (option === "--edit-description") return blocked("git branch", "interactive description editing requires an editor", "use a non-interactive branch operation")
      else if (option === "--set-branch-description") action ??= "upstream"
      if (["--set-upstream-to", "--sort", "--format", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--abbrev", "--color", "--column"].includes(option) && !token.includes("=")) index++
      continue
    }
    if (token.startsWith("-") && token !== "-") {
      if (token === "-v" || token === "-vv" || token === "-a" || token === "-r" || token === "-l" || token === "-q") {
        listMode = true
        if (token === "-r") remoteBranches = true
        continue
      }
      const flags = token.slice(1)
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex++) {
        const flag = flags[flagIndex]
        if (flag === "d" || flag === "D") action = "delete"
        else if (flag === "m" || flag === "M") action = "move"
        else if (flag === "c" || flag === "C") action = "copy"
        else if (flag === "f") { force = true; action ??= "force" }
        else if (flag === "r") { remoteBranches = true; listMode = true }
        else if (flag === "a" || flag === "v" || flag === "l" || flag === "q") listMode = true
        else if (flag === "u") action ??= "upstream"
        else if (flag === "t") continue
        else return blocked("git branch", `option -${flag} cannot be classified safely`, "invoke a simple branch list or an explicit supported branch operation")
      }
      continue
    }
    positionals.push(token)
  }

  if (listMode && !action && !force) return undefined
  if (remoteBranches && action) {
    return blocked("git branch -r", "remote-tracking branch mutations can conceal remote state and are denied", "refresh tracking refs with an allowed fetch instead")
  }
  if (!action && positionals.length === 0) return undefined
  if (!action) action = "create"
  if (action === "upstream" && force) action = "force"
  if (action === "upstream") return undefined

  const state = await currentBranch(invocation)
  if (!state.ok) return blocked("git branch", "repository metadata could not be verified", "run the command from the intended repository")
  const names: string[] = []
  if (action === "delete") names.push(...positionals)
  else if (action === "force" || action === "create") {
    if (positionals[0]) names.push(positionals[0])
  } else if (action === "move" || action === "copy") {
    if (positionals.length === 1) {
      if (state.branch) names.push(state.branch)
      names.push(positionals[0])
    } else if (positionals.length >= 2) {
      names.push(positionals[0], positionals[1])
    }
  }
  const affectedNames = action === "copy" ? names.slice(1) : names
  const protectedName = affectedNames.map(name => protectedRefName(name)).find(Boolean)
  if (protectedName) {
    const verb = action === "delete" ? "delete" : action === "move" ? "rename" : action === "copy" ? "copy over" : "force-update"
    return blocked(`git branch ${verb} ${protectedName}`, `protected local branch ${protectedName} cannot be ${verb}d`, "keep the protected branch unchanged and create or update a non-protected feature branch")
  }
  if ((action === "delete" || action === "move" || action === "copy" || force) && !names.length) {
    return blocked("git branch", "the affected branch name could not be determined", "name the feature branch explicitly and retry")
  }
  return undefined
}

function isConfigRead(args: string[]): boolean {
  if (!args.length) return true
  let positional = 0
  let getter = false
  let writeOption = false
  const valueOptions = new Set(["--type", "--default", "--file"])
  const flagOptions = new Set(["--system", "--global", "--local", "--worktree", "--fixed-value", "--no-includes", "--includes"])
  const readOptions = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--list", "-l", "--show-origin", "--show-scope", "--name-only", "--null", "-z"])
  const writeOptions = new Set(["--edit", "-e", "--add", "--unset", "--unset-all", "--replace-all", "--remove-section", "--rename-section", "--comment"])
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    const option = token.split("=", 1)[0]
    if (readOptions.has(option)) {
      getter ||= ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--list", "-l"].includes(option)
      continue
    }
    if (writeOptions.has(option)) {
      writeOption = true
      continue
    }
    if (valueOptions.has(option)) {
      if (!token.includes("=")) index++
      continue
    }
    if (flagOptions.has(option)) continue
    if (token.startsWith("-")) return false
    positional++
  }
  return !writeOption && (getter || positional <= 1)
}

function isRemoteRead(args: string[]): boolean {
  if (!args.length) return true
  const action = args.find(arg => !arg.startsWith("-"))
  if (!action) return true
  return action === "show" || action === "get-url" || action === "verbose"
}

function isBranchRead(args: string[]): boolean {
  if (!args.length) return true
  if (containsOption(args, ["--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description", "--set-branch-description"], ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "-t"])) return false
  const listOption = containsOption(args, ["--list", "--all", "--remotes", "--verbose", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort", "--color", "--column"], ["-a", "-r", "-v", "-l", "-q"])
  return listOption || !args.some(arg => !arg.startsWith("-"))
}

function isStashRead(args: string[]): boolean {
  const subcommand = args.find(arg => !arg.startsWith("-"))
  return subcommand === "list" || subcommand === "show"
}

function isReadOnly(invocation: Invocation): boolean {
  const { command, args } = invocation
  if (READ_COMMANDS.has(command)) return true
  if (command === "branch") return isBranchRead(args)
  if (command === "tag") return args.length === 0 || containsOption(args, ["--list", "-l", "--contains", "--no-contains", "--points-at", "--sort", "--format", "--merged", "--no-merged"])
  if (command === "config") return isConfigRead(args)
  if (command === "remote") return isRemoteRead(args)
  if (command === "stash") return isStashRead(args)
  if (command === "clean") return isCleanDryRun(args)
  if (command === "commit") return containsDryRun(args, command)
  if (command === "push" || command === "fetch" || command === "pull") return containsDryRun(args, command)
  if (command === "apply") return containsOption(args, ["--check"])
  if (command === "symbolic-ref") return !containsOption(args, ["--delete"], ["-d"]) && args.filter(arg => !arg.startsWith("-")).length <= 1
  if (command === "update-ref") return !containsOption(args, ["--stdin"], ["-d"]) && containsOption(args, ["--verify"])
  if (command === "worktree") return args[0] === "list"
  if (command === "reflog") return args[0] === "show" || args.length === 0
  if (command === "bisect") return args[0] === "log" || args[0] === "visualize" || args[0] === "view"
  if (command === "submodule") return args[0] === "status" || args[0] === "summary"
  return false
}

function containsDryRun(args: string[], command: string): boolean {
  const longValueOptions = new Set<string>()
  const shortValueOptions = new Set<string>()
  if (command === "clean" || command === "remote") {
    longValueOptions.add("--exclude")
    shortValueOptions.add("e")
  }
  if (command === "fetch" || command === "pull") {
    for (const option of ["--upload-pack", "--filter", "--refmap", "--jobs", "--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--negotiation-tip", "--server-option", "--strategy", "--strategy-option"]) {
      longValueOptions.add(option)
    }
    for (const flag of ["j", "s", "X"]) shortValueOptions.add(flag)
  }
  if (command === "push") {
    for (const option of ["--repo", "--repository", "--push-option", "--receive-pack", "--exec"]) longValueOptions.add(option)
    shortValueOptions.add("o")
  }
  if (command === "commit") {
    for (const option of ["--message", "--reedit-message", "--reuse-message", "--fixup", "--squash", "--author", "--date", "--cleanup", "--trailer", "--pathspec-from-file", "--template", "--file"]) {
      longValueOptions.add(option)
    }
    for (const flag of ["m", "c", "C", "F"]) shortValueOptions.add(flag)
  }

  let dryRun = false
  const end = args.indexOf("--")
  const limit = end < 0 ? args.length : end
  for (let index = 0; index < limit; index++) {
    const token = args[index]
    if (token === "--dry-run") {
      dryRun = true
      continue
    }
    if (token === "--no-dry-run") {
      dryRun = false
      continue
    }
    if (token.startsWith("--dry-run=")) {
      dryRun = ["true", "yes", "on", "1"].includes(token.slice("--dry-run=".length).toLowerCase())
      continue
    }
    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0]
      if (longValueOptions.has(option) && !token.includes("=")) index++
      continue
    }
    if (!token.startsWith("-") || token === "-") continue
    let flags = token.slice(1)
    while (flags.length) {
      const flag = flags[0]
      flags = flags.slice(1)
      if (shortValueOptions.has(flag)) {
        if (!flags.length) index++
        break
      }
      if (flag === "n" && ["clean", "fetch", "push", "remote"].includes(command)) dryRun = true
    }
  }
  return dryRun
}

async function checkCommitLike(invocation: Invocation): Promise<string | undefined> {
  if (invocation.command === "commit" && containsDryRun(invocation.args, invocation.command)) return undefined
  if (invocation.command === "commit" && containsOption(invocation.args, ["--interactive", "--patch"], ["-p"])) {
    return blocked("git commit", "interactive patch selection requires prompts and cannot be classified autonomously", "stage reviewed paths explicitly, then commit on a feature branch")
  }
  if (invocation.command === "am" && containsOption(invocation.args, ["--interactive"], ["-i"])) {
    return blocked("git am --interactive", "interactive patch application requires prompts", "apply the reviewed patch non-interactively on a feature branch")
  }
  const state = await ensureMutableRepository(invocation, `git ${invocation.command}`)
  if (typeof state === "string") return state
  if (isProtectedBranch(state.branch)) {
    return blocked(`git ${invocation.command}`, `it would change history on protected branch ${state.branch}`, "switch to a feature branch before committing, merging, rebasing, cherry-picking, reverting, or pulling")
  }
  if (invocation.command === "rebase") {
    const reason = await checkRebaseTargets(invocation)
    if (reason) return reason
  }
  if (invocation.command === "rebase" && containsOption(invocation.args, ["--exec"], ["-x"])) {
    return blocked("git rebase --exec", "it executes an opaque command during history mutation", "run the command separately on a feature branch after reviewing it")
  }
  return undefined
}

function refPatternCanMatchProtected(pattern: string): string | undefined {
  let destination = pattern
  if (!destination.startsWith("refs/")) {
    if (destination.includes("/")) destination = `refs/heads/${destination}`
    else destination = `refs/heads/${destination}`
  }
  if (!destination.includes("*")) return protectedRefName(destination)
  const escaped = destination.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  const regex = new RegExp(`^${escaped}$`)
  for (const name of PROTECTED_BRANCHES) {
    const ref = `refs/heads/${name}`
    if (regex.test(ref)) return name
  }
  return undefined
}

function normalizeDestination(destination: string): string | undefined {
  if (!destination || destination.includes("\0")) return undefined
  if (destination.startsWith("refs/")) return destination
  if (destination.startsWith("heads/")) return `refs/${destination}`
  if (destination.startsWith("tags/")) return `refs/${destination}`
  if (destination.startsWith("remotes/")) return `refs/${destination}`
  return `refs/heads/${destination}`
}

async function analyzeExplicitPushRefspec(invocation: Invocation, spec: string, current: string | null): Promise<string | undefined> {
  if (!spec || spec.startsWith(":") || spec.endsWith(":")) {
    return blocked("git push", "deletion or empty-destination refspecs can remove remote refs", "push an explicit source to a non-protected feature destination instead")
  }
  if (spec.startsWith("+")) return blocked("git push", "forced refspecs are denied, including a leading `+`", "use a normal non-forced feature-branch refspec")
  if (spec.startsWith("^")) return blocked("git push", "negative refspecs cannot be classified safely", "use an explicit source:destination refspec")
  const colon = spec.indexOf(":")
  if (colon < 0) return classifySourceOnlyRefspec(invocation, spec, current)
  if (spec.indexOf(":", colon + 1) >= 0) return blocked("git push", "the refspec has multiple separators", "use one explicit source:destination refspec")

  const source = spec.slice(0, colon)
  const destination = normalizeDestination(spec.slice(colon + 1))
  if (!source || !destination) return blocked("git push", "the source or destination ref could not be parsed", "use an explicit source and a full `refs/heads/feature/<name>` destination")
  const protectedName = refPatternCanMatchProtected(destination)
  if (protectedName) return blocked("git push", `destination ${destination} can update protected branch ${protectedName}`, "push to `refs/heads/feature/<name>` instead of a protected branch")
  if (source.startsWith("^") || source.startsWith("+")) return blocked("git push", "the source refspec cannot be classified safely", "use a non-forced positive source and a feature destination")
  if (!source.startsWith("refs/") && !source.includes("*")) {
    const branch = await refExists(invocation, `refs/heads/${source}`)
    const tag = await refExists(invocation, `refs/tags/${source}`)
    if (branch === undefined || tag === undefined) return blocked("git push", "local source-ref metadata could not be read safely", "use an explicit full source ref and feature destination")
    if (branch && tag) return blocked("git push", `source ${source} is both a local branch and tag`, "disambiguate the source with `refs/heads/` or `refs/tags/`")
    if (!branch && !tag) {
      const commit = await commitExists(invocation, source)
      if (commit === undefined) return blocked("git push", "source-revision metadata could not be read safely", "use an explicit full source ref and feature destination")
      if (!commit) return blocked("git push", `source ${source} is not a proven local ref or commit`, "use an explicit full source ref and feature destination")
    }
  }
  return undefined
}

async function classifySourceOnlyRefspec(invocation: Invocation, spec: string, current: string | null): Promise<string | undefined> {
  if (spec.startsWith("+")) return blocked("git push", "forced refspecs are denied, including a leading `+`", "use a normal non-forced push to a non-protected feature branch")
  if (spec === "HEAD") {
    if (isProtectedBranch(current)) return blocked("git push", `HEAD points to protected branch ${current}`, "switch to a feature branch and push that branch")
    if (!current) return blocked("git push", "detached HEAD has no unambiguous push destination", "create or switch to a named feature branch before pushing")
    return undefined
  }
  if (spec.startsWith("refs/tags/")) return undefined
  if (spec.startsWith("refs/heads/")) {
    const protectedName = protectedRefName(spec)
    return protectedName ? blocked("git push", `source-only refspec ${spec} updates protected branch ${protectedName}`, "push to an explicit non-protected destination") : undefined
  }
  if (spec.startsWith("refs/")) return undefined
  if (spec.includes("*")) {
    const protectedName = refPatternCanMatchProtected(spec)
    return protectedName
      ? blocked("git push", `source-only wildcard can update protected branch ${protectedName}`, "use an explicit feature-branch destination")
      : undefined
  }
  if (spec.startsWith("-") || spec.includes("{")) return blocked("git push", `source-only refspec ${spec} cannot be resolved safely`, "use an explicit non-wildcard feature-branch destination")

  const branch = await refExists(invocation, `refs/heads/${spec}`)
  const tag = await refExists(invocation, `refs/tags/${spec}`)
  if (branch === undefined || tag === undefined) return blocked("git push", "local ref metadata could not be read safely", "run `git show-ref` and use an explicit source:destination refspec")
  if (branch && tag) return blocked("git push", `source ${spec} is both a local branch and tag`, "disambiguate the source with `refs/heads/` or `refs/tags/` and name an explicit destination")
  if (branch) {
    return isProtectedBranch(spec)
      ? blocked("git push", `source-only refspec ${spec} updates a protected branch`, "push to an explicit non-protected feature destination")
      : undefined
  }
  if (tag) return undefined
  return blocked("git push", `source ${spec} is not a proven local branch or tag`, "use an explicit full source ref and non-protected feature destination")
}


async function analyzeConfiguredPushRefspec(invocation: Invocation, refspec: string, current: string | null): Promise<string | undefined> {
  if (refspec.startsWith("+")) return blocked("git push", "configured remote.push refspec enables forced updates", "remove the force marker from the configured refspec and push a feature branch normally")
  if (refspec === ":" || refspec.startsWith(":") || refspec.endsWith(":")) {
    return blocked("git push", "configured remote.push refspec can delete remote refs", "replace it with an explicit feature-branch mapping")
  }
  const colon = refspec.indexOf(":")
  if (colon >= 0) {
    if (refspec.indexOf(":", colon + 1) >= 0) return blocked("git push", "configured remote.push refspec is malformed", "replace it with explicit source:destination mappings")
    const destination = normalizeDestination(refspec.slice(colon + 1))
    if (!destination) return blocked("git push", "configured push destination is malformed", "set an explicit non-protected feature destination")
    const protectedName = refPatternCanMatchProtected(destination)
    if (protectedName) return blocked("git push", `configured destination ${destination} can update protected branch ${protectedName}`, "change remote.push to map only to non-protected feature branches")
    return undefined
  }
  if (refspec === "HEAD") return classifySourceOnlyRefspec(invocation, refspec, current)
  if (refspec.startsWith("refs/heads/") || refspec.startsWith("refs/tags/") || refspec.startsWith("refs/")) return classifySourceOnlyRefspec(invocation, refspec, current)
  if (refspec.includes("*")) {
    const protectedName = refPatternCanMatchProtected(refspec)
    return protectedName
      ? blocked("git push", `configured wildcard can update protected branch ${protectedName}`, "configure explicit feature-branch mappings")
      : undefined
  }
  return classifySourceOnlyRefspec(invocation, refspec, current)
}

async function selectPushRemote(invocation: Invocation, branch?: string): Promise<{ ok: true; remote: string } | { ok: false }> {
  const branchPush = branch ? await oneConfigValue(invocation, `branch.${branch}.pushRemote`) : { ok: true as const, value: undefined }
  const defaultPush = await oneConfigValue(invocation, "remote.pushDefault")
  const branchRemote = branch ? await oneConfigValue(invocation, `branch.${branch}.remote`) : { ok: true as const, value: undefined }
  if (!branchPush.ok || !defaultPush.ok || !branchRemote.ok) return { ok: false }
  if (branchPush.value === "" || defaultPush.value === "" || branchRemote.value === "") return { ok: false }
  const remote = branchPush.value ?? defaultPush.value ?? branchRemote.value
  if (remote !== undefined) return { ok: true, remote }
  const listing = await runGit(invocation, ["remote"])
  if (!listing || listing.code !== 0) return { ok: false }
  const remotes = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (remotes.includes("origin")) return { ok: true, remote: "origin" }
  if (remotes.length === 1) return { ok: true, remote: remotes[0] }
  return { ok: false }
}

function isRepositoryUrl(remote: string): boolean {
  return remote.includes("://") || remote.startsWith("/") || remote.startsWith("./") || remote.startsWith("../") || (remote.includes("@") && remote.indexOf(":") > remote.indexOf("@"))
}

function isOpaqueRemoteUrl(remote: string): boolean {
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]*::/.test(remote)) return true
  const scheme = remote.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1].toLowerCase()
  return scheme !== undefined && !["file", "git", "http", "https", "ssh"].includes(scheme)
}

async function checkRemoteExecution(invocation: Invocation, remote: string, operation: "push" | "fetch"): Promise<string | undefined> {
  if (isOpaqueRemoteUrl(remote)) {
    return blocked(`git ${operation}`, "custom remote-helper transports execute opaque commands", "use a standard Git, SSH, HTTPS, or file transport")
  }
  if (remote === "." || isRepositoryUrl(remote)) return undefined

  const urls = await configValues(invocation, `remote.${remote}.url`)
  if (!urls.ok) return blocked(`git ${operation}`, `remote transport configuration for ${remote} could not be read safely`, "inspect the remote and use a standard Git, SSH, HTTPS, or file transport")
  const destinations = operation === "push" ? await configValues(invocation, `remote.${remote}.pushurl`) : { ok: true as const, values: [] }
  if (!destinations.ok) return blocked(`git ${operation}`, `remote transport configuration for ${remote} could not be read safely`, "inspect the remote and use a standard Git, SSH, HTTPS, or file transport")
  if ([...urls.values, ...destinations.values].some(isOpaqueRemoteUrl)) {
    return blocked(`git ${operation}`, `remote ${remote} uses an opaque custom transport`, "replace the custom helper URL with a standard Git, SSH, HTTPS, or file transport")
  }

  const option = operation === "push" ? "receivepack" : "uploadpack"
  const configuredCommand = await oneConfigValue(invocation, `remote.${remote}.${option}`)
  if (!configuredCommand.ok) return blocked(`git ${operation}`, `remote ${option} command for ${remote} could not be read safely`, "use the standard Git transport command")
  const expected = operation === "push" ? "git-receive-pack" : "git-upload-pack"
  if (configuredCommand.value !== undefined && configuredCommand.value !== expected) {
    return blocked(`git ${operation}`, `remote ${remote} overrides ${option} with an opaque command`, `use the standard ${expected} command`)
  }
  return undefined
}



async function checkRemoteMirror(invocation: Invocation, remote: string): Promise<string | undefined> {
  const executionIssue = await checkRemoteExecution(invocation, remote, "push")
  if (executionIssue) return executionIssue
  if (isRepositoryUrl(remote)) return undefined
  const configured = await oneConfigValue(invocation, `remote.${remote}.mirror`)
  if (!configured.ok) return blocked("git push", `mirror configuration for ${remote} could not be read safely`, "disable mirror mode and use an explicit feature-branch refspec")
  if (configured.value === undefined || ["false", "no", "off", "0"].includes(configured.value.toLowerCase())) return undefined
  if (["true", "yes", "on", "1"].includes(configured.value.toLowerCase())) {
    return blocked("git push", `remote ${remote} is configured for mirror updates`, "disable remote mirror mode and push an explicit feature-branch refspec")
  }
  return blocked("git push", `mirror setting for ${remote} is not a recognized boolean`, "set remote.<name>.mirror to false and push an explicit feature-branch refspec")
}

async function checkImplicitPush(invocation: Invocation, remote: string | undefined, current: string | null): Promise<string | undefined> {
  if (!remote) return blocked("git push", "the destination remote is ambiguous", "name a configured remote explicitly, such as `git push origin <feature-branch>`")
  if (!current) return blocked("git push", "detached HEAD has no unambiguous implicit destination", "create or switch to a named feature branch and push it explicitly")
  if (remote !== ".") {
    const mirrorIssue = await checkRemoteMirror(invocation, remote)
    if (mirrorIssue) return mirrorIssue
  }

  const pushConfig = await configValues(invocation, `remote.${remote}.push`)
  if (!pushConfig.ok) return blocked("git push", `push mappings for remote ${remote} could not be read safely`, "inspect `git config --get-all remote.<remote>.push` and use explicit feature refspecs")
  if (pushConfig.values.length) {
    for (const refspec of pushConfig.values) {
      const reason = await analyzeConfiguredPushRefspec(invocation, refspec, current)
      if (reason) return reason
    }
    return undefined
  }

  const pushDefault = await oneConfigValue(invocation, "push.default")
  if (!pushDefault.ok) return blocked("git push", "push.default could not be read safely", "set push.default explicitly and push a feature branch")
  const mode = pushDefault.value === undefined ? "simple" : pushDefault.value
  if (mode === "nothing") return undefined
  if (mode === "matching") return blocked("git push", "push.default=matching can update multiple remote branches, including protected branches", "use `push.default=current` or push an explicit feature-branch refspec")
  if (mode === "current") {
    return isProtectedBranch(current)
      ? blocked("git push", `push.default=current would update protected branch ${current}`, "switch to a feature branch before pushing")
      : undefined
  }
  if (mode !== "simple" && mode !== "upstream") {
    return blocked("git push", `unsupported push.default value ${mode}`, "set push.default to `current`, `upstream`, `simple`, or `nothing`, then use a feature branch")
  }

  const upstreamRemote = await oneConfigValue(invocation, `branch.${current}.remote`)
  if (!upstreamRemote.ok) return blocked("git push", "the upstream remote is ambiguous", "push an explicit feature source:destination refspec")
  if (mode === "simple" && upstreamRemote.value !== remote) {
    return isProtectedBranch(current) ? blocked("git push", `the destination branch is protected: ${current}`) : undefined
  }
  const mergeValues = await configValues(invocation, `branch.${current}.merge`)
  if (!mergeValues.ok || mergeValues.values.length !== 1) {
    return blocked("git push", `the upstream destination for ${current} is missing or ambiguous`, "set one upstream for the feature branch or push an explicit feature-branch refspec")
  }
  const destination = mergeValues.values[0]
  if (!destination.startsWith("refs/heads/")) {
    return blocked("git push", `upstream destination ${destination} is not a classifiable branch ref`, "push an explicit non-protected feature-branch destination")
  }
  if (mode === "simple" && destination !== `refs/heads/${current}`) {
    const protectedName = protectedRefName(destination)
    if (protectedName) return blocked("git push", `the upstream destination is protected branch ${protectedName}`, "push to a feature-branch destination instead")
    return blocked("git push", `push.default=simple requires the upstream to match branch ${current}`, "correct the feature branch upstream or use an explicit feature-branch refspec")
  }
  const protectedName = protectedRefName(destination)
  if (protectedName) return blocked("git push", `the implicit upstream destination is protected branch ${protectedName}`, "switch to a feature branch and push to a non-protected destination")
  return undefined
}

async function checkPush(invocation: Invocation): Promise<string | undefined> {
  const args = invocation.args
  if (containsOption(args, ["--force", "--force-with-lease", "--force-if-includes"], ["-f"])) {
    return blocked("git push", "force updates are denied, including -f bundles, --force-with-lease, and --force-if-includes", "use a normal non-forced push to a non-protected feature branch after reviewing remote state")
  }
  if (containsOption(args, ["--mirror", "--delete", "--prune"], ["-d"])) {
    return blocked("git push", "mirror, prune, and remote-ref deletion operations are denied", "push only explicit feature-branch refspecs without deletion or mirror options")
  }
  if (containsOption(args, ["--all", "--branches"])) {
    return blocked("git push", "pushing all local branches can update protected branches", "push an explicit non-protected feature-branch refspec")
  }
  if (containsDryRun(args, invocation.command)) return undefined

  const state = await ensureMutableRepository(invocation, "git push")
  if (typeof state === "string") return state
  const requiredValueOptions = new Set(["--repo", "--repository", "--push-option", "-o"])
  const optionalValueOptions = new Set(["--signed", "--recurse-submodules"])
  const optionsWithoutValue = new Set([
    "--tags", "--follow-tags", "--atomic", "--porcelain", "--thin", "--no-thin", "--quiet", "-q",
    "--verbose", "-v", "--progress", "--no-progress", "--ipv4", "--ipv6", "--verify", "--no-verify",
    "--set-upstream", "-u", "--no-signed", "--no-recurse-submodules", "--dry-run", "-n",
  ])
  const positionals: string[] = []
  let explicitRepository: string | undefined
  let repositoryOption: string | undefined
  let tagsOnly = false
  let followTags = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "--") { positionals.push(...args.slice(index + 1)); break }
    const option = token.split("=", 1)[0]
    if (option === "--tags") tagsOnly = true
    if (option === "--follow-tags") followTags = true
    if (requiredValueOptions.has(option)) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[++index]
      if (value === undefined) return blocked("git push", `${option} has no value`, "provide a repository and explicit feature-branch refspec")
      if (option === "--repo" || option === "--repository") repositoryOption = value
      continue
    }
    if (optionalValueOptions.has(option) || optionsWithoutValue.has(option)) continue
    if (option.startsWith("--force") || option.startsWith("--delete") || option.startsWith("--mirror") || option.startsWith("--prune")) {
      return blocked("git push", `unsupported safety-sensitive option ${option}`, "remove the option and use an explicit feature-branch refspec")
    }
    if (token.startsWith("--")) return blocked("git push", `option ${option} cannot be classified safely`, "remove the option and use an explicit feature-branch refspec")
    if (token.startsWith("-") && token !== "-") {
      let chars = token.slice(1)
      while (chars.length) {
        const flag = chars[0]
        chars = chars.slice(1)
        if (flag === "f" || flag === "d") return blocked("git push", `short option -${flag} enables force or deletion`, "use a normal non-forced push to a feature branch")
        if (flag === "u" || flag === "n" || flag === "q" || flag === "v" || flag === "s") continue
        if (flag === "o") {
          if (chars) chars = ""
          else index++
          continue
        }
        return blocked("git push", `short option -${flag} cannot be classified safely`, "remove the option and use an explicit feature-branch refspec")
      }
      continue
    }
    positionals.push(token)
  }
  if (repositoryOption) explicitRepository = repositoryOption
  else if (positionals.length) explicitRepository = positionals.shift()
  const refspecs = positionals
  const remote = explicitRepository
  if (remote && remote !== ".") {
    const mirrorIssue = await checkRemoteMirror(invocation, remote)
    if (mirrorIssue) return mirrorIssue
  }
  if (refspecs.length) {
    for (const refspec of refspecs) {
      if (!refspec.includes(":")) {
        const mappingIssue = await checkSourceOnlyPushMapping(invocation, refspec, remote, state.branch)
        if (mappingIssue) return mappingIssue
      }
      const reason = await analyzeExplicitPushRefspec(invocation, refspec, state.branch)
      if (reason) return reason
    }
    return undefined
  }
  if (tagsOnly && !followTags) {
    let tagRemote = remote
    if (!tagRemote) {
      const selected = await selectPushRemote(invocation, state.branch ?? undefined)
      if (!selected.ok) return blocked("git push --tags", "the destination remote is missing or ambiguous", "name a configured remote explicitly when pushing tags")
      tagRemote = selected.remote
    }
    if (!remote && tagRemote !== ".") {
      const mirrorIssue = await checkRemoteMirror(invocation, tagRemote)
      if (mirrorIssue) return mirrorIssue
    }
    return undefined
  }


  let targetRemote = remote
  if (remote && remote !== ".") {
    const urls = await configValues(invocation, `remote.${remote}.url`)
    const pushUrls = await configValues(invocation, `remote.${remote}.pushurl`)
    if (!urls.ok || !pushUrls.ok) {
      return blocked("git push", `remote configuration for ${remote} could not be read safely`, "inspect the configured remote and use an explicit feature-branch refspec")
    }
    const isConfigured = urls.values.length > 0 || pushUrls.values.length > 0
    if (!isConfigured && !isRepositoryUrl(remote)) {
      return blocked("git push", `remote ${remote} is not configured`, "name a configured remote or provide a repository URL")
    }
    if (!isConfigured) {
      return blocked("git push", "an implicit refspec to a repository URL has no verifiable push mapping", "name the destination branch explicitly and ensure it is not protected")
    }
  }
  if (!targetRemote) {
    if (!state.branch) return blocked("git push", "detached HEAD has no implicit remote mapping", "create or switch to a named feature branch and push it explicitly")
    const selected = await selectPushRemote(invocation, state.branch)
    if (!selected.ok) return blocked("git push", "the effective push remote is missing or ambiguous", "configure branch.<name>.pushRemote or remote.pushDefault, or name a remote explicitly")
    targetRemote = selected.remote
  }
  return checkImplicitPush(invocation, targetRemote, state.branch)
}

function resetPathOnlyArguments(args: string[]): { allowed: boolean; candidates?: string[]; reason?: string } {
  let hard = false
  let history = false
  const before: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "--") break
    if (token === "--hard") hard = true
    else if (token === "--soft" || token === "--merge" || token === "--keep") history = true
    else if (token === "--mixed" || token === "-q" || token === "--quiet" || token === "-N" || token === "--intent-to-add") continue
    else if (token === "-p" || token === "--patch") return { allowed: false, reason: "interactive reset is not allowed" }
    else if (token.startsWith("-")) return { allowed: false, reason: `option ${token} cannot be classified safely` }
    else before.push(token)
  }
  if (hard) return { allowed: false, reason: "reset --hard can discard staged and worktree changes" }
  if (history) return { allowed: false, reason: "reset target or mode can rewrite branch history" }
  if (before.some(token => /[~^:@{}]/.test(token))) return { allowed: false, reason: "revision expressions are history-reset targets, not unstaging paths" }
  if (before[0] === "HEAD") return { allowed: true }
  return { allowed: true, candidates: before }
}

async function checkReset(invocation: Invocation): Promise<string | undefined> {
  const parsed = resetPathOnlyArguments(invocation.args)
  if (!parsed.allowed) return blocked("git reset", parsed.reason || "history reset is not allowed", "use `git reset --mixed HEAD -- <path>` to unstage, or `git restore --staged <path>`")
  const state = await ensureMutableRepository(invocation, "git reset")
  if (typeof state === "string") return state
  for (const candidate of parsed.candidates || []) {
    const commit = await commitExists(invocation, candidate)
    if (commit === undefined) return blocked("git reset", "revision metadata could not be read safely", "use `git restore --staged <path>` to unstage")
    if (commit) return blocked("git reset", `target ${candidate} resolves to a commit and would reset history`, "use `git restore --staged <path>` to unstage")
  }
  return undefined
}

function refspecPatternMatches(refPattern: string, ref: string): boolean {
  const escaped = refPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${escaped}$`).test(ref)
}

function protectedDestinationForFetch(refspec: string): string | undefined {
  if (!refspec || refspec.startsWith("^")) return undefined
  const colon = refspec.indexOf(":")
  if (colon < 0) return undefined
  let destination = refspec.slice(colon + 1)
  if (destination.startsWith("+")) destination = destination.slice(1)
  if (!destination) return undefined
  if (!destination.startsWith("refs/")) destination = `refs/heads/${destination}`
  for (const branch of PROTECTED_BRANCHES) {
    const ref = `refs/heads/${branch}`
    if (refspecPatternMatches(destination, ref)) return branch
  }
  return undefined
}

async function remoteNames(invocation: Invocation): Promise<string[] | undefined> {
  const result = await runGit(invocation, ["remote"])
  if (!result || result.code !== 0) return undefined
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

async function fetchRefspecs(invocation: Invocation, remote: string): Promise<string[] | undefined> {
  const values = await configValues(invocation, `remote.${remote}.fetch`)
  return values.ok ? values.values : undefined
}

async function checkFetchMapping(invocation: Invocation, remote: string, refspecs: string[], prune: boolean): Promise<string | undefined> {
  for (const refspec of refspecs) {
    const protectedName = protectedDestinationForFetch(refspec)
    if (protectedName) {
      return blocked(`git fetch ${remote}`, `${prune ? "pruning or " : ""}fetch mapping can update protected local branch ${protectedName}`, "use the standard remote-tracking refspec and do not map fetches into refs/heads")
    }
  }
  return undefined
}

async function checkFetch(invocation: Invocation, isPull: boolean): Promise<string | undefined> {
  const args = invocation.args
  if (containsDryRun(args, invocation.command)) return undefined
  if (isPull) {
    const state = await ensureMutableRepository(invocation, "git pull")
    if (typeof state === "string") return state
    if (isProtectedBranch(state.branch)) return blocked("git pull", `it would mutate history on protected branch ${state.branch}`, "switch to a feature branch before pulling")
  }

  let remote: string | undefined
  let all = false
  let prune = containsOption(args, ["--prune", "--prune-tags"], ["-p"])
  const values: string[] = []
  const refmaps: string[] = []
  const valueOptions = new Set(["--upload-pack", "--filter", "--refmap", "--jobs", "-j", "--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--negotiation-tip", "--server-option", "--strategy", "--strategy-option", "-s", "-X"])
  const flagOptions = new Set([
    "--all", "--append", "--atomic", "--auto-maintenance", "--no-auto-maintenance", "--unshallow", "--update-shallow",
    "--no-tags", "--tags", "--force", "--keep", "--quiet", "-q", "--verbose", "-v", "--progress", "--no-progress",
    "--dry-run", "--prune", "--no-prune", "--prune-tags", "--no-write-fetch-head", "--write-fetch-head",
    "--no-recurse-submodules", "--recurse-submodules", "--recurse-submodules-default", "--rebase", "--no-rebase",
    "--ff-only", "--no-ff", "--ff", "--no-commit", "--commit", "--autostash", "--no-autostash", "--squash",
    "--no-squash", "--allow-unrelated-histories", "--no-edit", "--edit", "--stat", "--no-stat", "--verify-signatures",
  ])
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "--") { values.push(...args.slice(index + 1)); break }
    const option = token.split("=", 1)[0]
    if (option === "--all") all = true
    if (option === "--prune" || option === "--prune-tags") prune = true
    if (option === "--refmap" || valueOptions.has(option)) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[++index]
      if (value === undefined) return blocked(`git ${invocation.command}`, `${option} has no value`, "remove custom mapping options and use standard remote-tracking refs")
      if (option === "--refmap") refmaps.push(value)
      continue
    }
    if (flagOptions.has(option)) continue
    if (option.startsWith("--")) return blocked(`git ${invocation.command}`, `option ${option} cannot be classified safely`, "remove the option and use standard remote-tracking fetch mappings")
    if (token.startsWith("-") && token !== "-") {
      let flags = token.slice(1)
      if (flags.startsWith("j") && flags.length > 1) continue
      while (flags.length) {
        const flag = flags[0]
        flags = flags.slice(1)
        if (flag === "f" || flag === "q" || flag === "v" || flag === "a" || flag === "u" || flag === "n") continue
        if (flag === "p") { prune = true; continue }
        return blocked(`git ${invocation.command}`, `short option -${flag} cannot be classified safely`, "remove the option and use standard remote-tracking fetch mappings")
      }
      continue
    }
    values.push(token)
  }
  if (values.length) remote = values.shift()
  const explicitRefspecs = values
  if (all && remote) {
    return blocked(`git ${invocation.command} --all`, "an explicit remote or refspec makes the multi-remote target ambiguous", "omit positional arguments or fetch one named remote explicitly")
  }
  if (explicitRefspecs.length) {
    for (const spec of explicitRefspecs) {
      const protectedName = protectedDestinationForFetch(spec)
      if (protectedName) return blocked(`git ${invocation.command}`, `explicit refspec can update protected local branch ${protectedName}`, "fetch into a remote-tracking ref instead of refs/heads")
    }
  }
  for (const mapping of refmaps) {
    const protectedName = protectedDestinationForFetch(mapping)
    if (protectedName) return blocked(`git ${invocation.command}`, `custom refmap can update protected local branch ${protectedName}`, "use the standard remote-tracking refspec")
  }
  if (explicitRefspecs.length) {
    const targets = all ? await remoteNames(invocation) : remote ? [remote] : []
    if (!targets) return blocked(`git ${invocation.command}`, "remote configuration could not be read safely", "name a configured remote and use standard Git, SSH, HTTPS, or file transport")
    if (!targets.length) return blocked(`git ${invocation.command}`, "the fetch destination remote could not be determined", "name a configured remote explicitly")
    for (const name of targets) {
      const executionIssue = await checkRemoteExecution(invocation, name, "fetch")
      if (executionIssue) return executionIssue
      if (!refmaps.length) {
        const configured = await fetchRefspecs(invocation, name)
        if (!configured) return blocked(`git ${invocation.command}`, "configured fetch mappings could not be verified", "use standard remote-tracking refs")
        const mappingIssue = await checkFetchMapping(invocation, name, configured, prune)
        if (mappingIssue) return mappingIssue
      }
    }
    return undefined
  }

  let remotes: string[]
  if (all) {
    const names = await remoteNames(invocation)
    if (!names) return blocked("git fetch --all", "configured remotes could not be read safely", "name a configured remote and use standard remote-tracking refs")
    remotes = names
  } else if (remote) remotes = [remote]
  else {
    const state = await currentBranch(invocation)
    if (!state.ok) return blocked(`git ${invocation.command}`, "repository metadata could not be verified", "run from the intended repository")
    const selected = state.branch ? await oneConfigValue(invocation, `branch.${state.branch}.remote`) : { ok: true as const, value: undefined }
    if (!selected.ok) return blocked(`git ${invocation.command}`, "the upstream remote could not be read safely", "configure an upstream remote or name a remote explicitly")
    if (selected.value === "") return blocked(`git ${invocation.command}`, "the upstream remote is empty and cannot be classified", "configure a named remote or pass one explicitly")
    if (selected.value !== undefined) remotes = [selected.value]
    else {
      const names = await remoteNames(invocation)
      if (!names) return blocked(`git ${invocation.command}`, "configured remotes could not be read safely", "name a configured remote explicitly")
      if (names.includes("origin")) remotes = ["origin"]
      else if (names.length === 1) remotes = names
      else return blocked(`git ${invocation.command}`, "the default fetch remote is missing or ambiguous", "configure an upstream remote or name a remote explicitly")
    }
  }
  for (const name of remotes) {
    const executionIssue = await checkRemoteExecution(invocation, name, "fetch")
    if (executionIssue) return executionIssue
    const mappings = await fetchRefspecs(invocation, name)
    if (!mappings) return blocked(`git ${invocation.command}`, `fetch mappings for ${name} could not be read safely`, "inspect `remote.<name>.fetch` and use standard remote-tracking refs")
    const reason = await checkFetchMapping(invocation, name, mappings, prune)
    if (reason) return reason
  }
  return undefined
}

function isConfigMutation(args: string[]): boolean {
  return !isConfigRead(args)
}

function checkStash(args: string[]): string | undefined {
  const subcommand = args.find(arg => !arg.startsWith("-"))
  if (subcommand === "drop" || subcommand === "clear") {
    return blocked(`git stash ${subcommand}`, "discarding saved stash entries is denied", "keep the stash entry and apply or inspect it instead")
  }
  if (subcommand === "list" || subcommand === "show") return undefined
  if (subcommand === "apply" || subcommand === "pop" || subcommand === "push" || subcommand === "save" || subcommand === undefined) {
    if (containsOption(args, ["--patch", "--interactive"], ["-p", "-i"])) {
      return blocked("git stash", "interactive stash operations require prompts and cannot be classified autonomously", "use a non-interactive stash push/apply/pop command")
    }
    return undefined
  }
  if (subcommand === "branch") return undefined
  if (subcommand === "create") return undefined
  return blocked(`git stash ${subcommand}`, "the stash operation is not in the safe allow-list", "use `git stash push`, `apply`, or `pop`; do not drop or clear entries")
}

async function checkUpdateRef(invocation: Invocation): Promise<string | undefined> {
  const args = invocation.args
  if (args.includes("--stdin")) {
    return blocked("git update-ref --stdin", "stdin transactions can mutate refs that are not visible in argv", "name one ref explicitly and update only a non-protected feature branch")
  }
  let target: string | undefined
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "--") { target = args[index + 1]; break }
    if (token === "-m" || token === "--message") {
      if (args[index + 1] === undefined) return blocked("git update-ref", `${token} has no value`, "name the feature ref explicitly")
      index++
      continue
    }
    if (token === "-d" || token === "--no-deref" || token === "--create-reflog" || token === "--no-create-reflog") continue
    if (token.startsWith("--message=")) continue
    if (token.startsWith("-")) return blocked("git update-ref", `option ${token} cannot be classified safely`, "name one feature ref explicitly without stdin transactions")
    target = token
    break
  }
  if (!target) return blocked("git update-ref", "the target ref could not be determined", "name the feature ref explicitly")
  const state = await ensureMutableRepository(invocation, "git update-ref")
  if (typeof state === "string") return state
  const symbolic = await runGit(invocation, ["symbolic-ref", "--quiet", target])
  if (!symbolic || (symbolic.code !== 0 && symbolic.code !== 1)) return blocked("git update-ref", "the target's symbolic-ref chain could not be verified")
  if (symbolic.code === 0 && protectedRefName(symbolic.stdout.trim())) return blocked("git update-ref", "the symbolic target resolves to a protected branch")
  const protectedName = protectedRefName(target) || (PROTECTED_BRANCHES.has(target) ? target : undefined)
  if (protectedName || (target === "HEAD" && isProtectedBranch(state.branch))) {
    return blocked("git update-ref", `it would mutate protected ref ${protectedName ? `refs/heads/${protectedName}` : `HEAD on ${state.branch}`}`, "update only a non-protected feature ref")
  }
  return undefined
}

async function checkSymbolicRef(invocation: Invocation): Promise<string | undefined> {
  const args = invocation.args
  const operands: string[] = []
  let deleting = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "--") { operands.push(...args.slice(index + 1)); break }
    if (token === "--delete" || token === "-d") { deleting = true; continue }
    if (token === "--quiet" || token === "-q" || token === "--short") continue
    if (token === "-m" || token === "--message") {
      if (args[index + 1] === undefined) return blocked("git symbolic-ref", `${token} has no value`, "name the ref explicitly")
      index++
      continue
    }
    if (token.startsWith("--message=")) continue
    if (token.startsWith("-")) return blocked("git symbolic-ref", `option ${token} cannot be classified safely`, "name the ref explicitly without unsupported options")
    operands.push(token)
  }
  if (!deleting && operands.length <= 1) return undefined
  if (!operands.length) return blocked("git symbolic-ref", "the modified ref could not be determined", "name a non-protected feature ref explicitly")
  const state = await ensureMutableRepository(invocation, "git symbolic-ref")
  if (typeof state === "string") return state
  const target = operands[0]
  if (target === "HEAD") return blocked("git symbolic-ref", "direct HEAD rewrites bypass ordinary checkout safety", "use an ordinary git switch or checkout command instead")
  if (!deleting && operands[1]) {
    const symbolic = await runGit(invocation, ["symbolic-ref", "--quiet", operands[1]])
    if (protectedRefName(operands[1]) || (symbolic?.code === 0 && protectedRefName(symbolic.stdout.trim()))) {
      return blocked("git symbolic-ref", "the new symbolic target is a protected branch", "use ordinary checkout/switch for inspection")
    }
  }
  const protectedName = protectedRefName(target) || (PROTECTED_BRANCHES.has(target) ? target : undefined)
  if (protectedName || (deleting && target === "HEAD" && isProtectedBranch(state.branch))) {
    return blocked("git symbolic-ref", `it would mutate protected ref ${protectedName ? `refs/heads/${protectedName}` : `HEAD on ${state.branch}`}`, "change only a non-protected feature ref")
  }
  return undefined
}


function isCleanDryRun(args: string[]): boolean {
  return containsDryRun(args, "clean")
}

function checkRemote(invocation: Invocation): string | undefined {
  if (isRemoteRead(invocation.args)) return undefined
  const action = invocation.args.find(arg => !arg.startsWith("-"))
  if (action === "prune") {
    return containsDryRun(invocation.args, invocation.command)
      ? undefined
      : blocked("git remote prune", "it deletes remote-tracking refs and can conceal protected-ref state", "inspect remote refs without pruning")
  }
  if (action === "update") {
    return blocked("git remote update", "multi-remote fetch updates cannot be mapped safely from this command", "fetch a named remote after verifying its fetch refspec")
  }
  if (["add", "rename", "remove", "rm", "set-head", "set-branches", "set-url"].includes(action || "")) return undefined
  return blocked("git remote", `operation ${action || "(missing)"} cannot be classified safely`, "use `git remote -v` to inspect remotes or an explicit supported remote configuration command")
}


export function gitReadOnly(argv: string[]): boolean {
  const parsed = parseInvocation(argv, process.cwd())
  return parsed.invocation !== undefined && isReadOnly(parsed.invocation)
}

/**
 * Returns true when a Git segment can change current HEAD/branch state or the
 * metadata used to choose a later implicit push target. The shell guard uses
 * this between chained commands so branch/config changes are never checked
 * against stale repository metadata. Ordinary add, commit, and push chains are
 * intentionally not barriers.
 */
export function gitChangesContext(argv: string[]): boolean {
  const parsed = parseInvocation(argv, process.cwd())
  if (!parsed.invocation) return true
  const invocation = parsed.invocation
  if (!invocation.command) return false
  const command = invocation.command
  if (command === "checkout" || command === "switch" || command === "pull" || command === "merge" || command === "rebase" || command === "cherry-pick" || command === "revert") return true
  if (command === "fetch") return !containsDryRun(invocation.args, command)
  if (command === "reset") return containsOption(invocation.args, ["--hard", "--soft", "--merge", "--keep"])
  if (command === "update-ref" || command === "symbolic-ref") return !isReadOnly(invocation)
  if (command === "branch") return !isBranchRead(invocation.args)
  if (command === "remote") {
    const action = invocation.args.find(arg => !arg.startsWith("-"))
    return action === "prune" && containsDryRun(invocation.args, command) ? false : !isRemoteRead(invocation.args)
  }
  if (command === "config") return isConfigMutation(invocation.args)
  if (command === "stash") return !isStashRead(invocation.args) && invocation.args.some(arg => arg === "pop" || arg === "branch")
  if (command === "worktree") return invocation.args[0] !== "list"
  if (command === "reflog") return invocation.args[0] !== "show" && invocation.args.length > 0
  if (!KNOWN_GIT_COMMANDS.has(command)) return true
  return false
}

function opaqueExecutionOptionIssue(invocation: Invocation): string | undefined {
  const { command, args } = invocation
  if (command === "push") {
    if (containsOption(args, ["--receive-pack", "--exec"])) {
      return blocked("git push", "custom receive-pack execution is opaque", "use the configured remote transport without a custom receive-pack command")
    }
    if (containsOption(args, ["--recurse-submodules"])) {
      return blocked("git push", "recursive submodule pushes can mutate refs outside the inspected repository", "push submodule repositories separately after checking each target branch")
    }
  }
  if (command === "fetch" || command === "pull") {
    if (containsOption(args, ["--upload-pack", "--exec"])) {
      return blocked(`git ${command}`, "custom remote execution commands are opaque", "use the configured remote transport without a custom execution option")
    }
    if (containsOption(args, ["--recurse-submodules", "--recurse-submodules-default"])) {
      return blocked(`git ${command}`, "recursive submodule operations can mutate repositories outside the inspected branch", "fetch or pull each submodule separately after checking its current branch")
    }
  }
  return undefined
}

export async function checkGit(argv: string[], cwd: string): Promise<string | undefined> {
  const parsed = parseInvocation(argv, cwd)
  if (parsed.error) return blocked("Git command", parsed.error, "invoke Git with its executable, supported global options, and a built-in subcommand")
  if (!parsed.invocation) return undefined
  if (!parsed.invocation.command) return undefined

  const expanded = await expandAlias(parsed.invocation)
  if ("reason" in expanded) return expanded.reason
  const invocation = expanded.invocation
  const { command, args } = invocation
  if (!command) return undefined
  if (command === "--help" || command === "--version") return undefined

  const executionIssue = opaqueExecutionOptionIssue(invocation)
  if (executionIssue) return executionIssue
  const outputIssue = await checkReadOutput(invocation)
  if (outputIssue) return outputIssue
  if (isReadOnly(invocation)) return undefined

  const globalIssue = globalMutationIssue(invocation)
  if (globalIssue) return blocked(`git ${command}`, globalIssue, "remove the repository/configuration override and rerun from the intended repository")

  if (command === "checkout" || command === "switch") return checkCheckout(invocation)
  if (command === "restore") return checkRestore(args)
  if (command === "branch") return checkBranch(invocation)
  if (command === "commit" || command === "merge" || command === "rebase" || command === "cherry-pick" || command === "revert" || command === "pull" || command === "am") {
    if (command === "pull") return checkFetch(invocation, true)
    return checkCommitLike(invocation)
  }
  if (command === "push") return checkPush(invocation)
  if (command === "reset") return checkReset(invocation)
  if (command === "clean") {
    if (isCleanDryRun(args)) return undefined
    return blocked("git clean", "it can permanently delete untracked files", "review `git clean -nd` output and preserve files before any cleanup")
  }
  if (command === "stash") return checkStash(args)
  if (command === "fetch") return checkFetch(invocation, false)
  if (command === "config") {
    return isConfigMutation(args)
      ? blocked("git config", "configuration writes can change aliases or push/ref policy and are denied", "inspect configuration with `git config --get` and make policy changes outside the guarded shell")
      : undefined
  }
  if (command === "update-ref") return checkUpdateRef(invocation)
  if (command === "symbolic-ref") return checkSymbolicRef(invocation)
  if (command === "remote") return checkRemote(invocation)
  if (command === "tag") return undefined
  if (command === "add") {
    return containsOption(args, ["--interactive", "--patch"], ["-i", "-p"])
      ? blocked("git add", "interactive staging requires prompts and cannot be classified autonomously", "stage reviewed paths with a non-interactive `git add <path>` command")
      : undefined
  }
  if (command === "rm" || command === "mv") {
    return containsOption(args, ["--force"], ["-f"])
      ? blocked(`git ${command}`, "force can discard or overwrite local files", "use the ordinary non-forced command")
      : undefined
  }
  if (command === "apply") {
    return containsOption(args, ["--unsafe-paths"])
      ? blocked("git apply", "unsafe paths can write outside the worktree", "apply a patch using ordinary repository-relative paths")
      : undefined
  }
  if (command === "bisect" && args[0] === "run") return blocked("git bisect run", "it executes an opaque test command", "run reviewed tests separately and use explicit bisect steps")
  if (command === "submodule" && args[0] === "foreach") return blocked("git submodule foreach", "it executes an opaque command in submodules", "inspect and operate on each submodule explicitly")
  if (command === "worktree") {
    if (containsOption(args, ["--force"], ["-f", "-B"])) return blocked("git worktree", "forced worktree/ref changes can discard local work", "use a non-forced worktree operation")
    if (args[0] === "add") {
      for (let index = 1; index < args.length; index++) {
        const name = args[index] === "-b" ? args[index + 1] : args[index].startsWith("-b") ? args[index].slice(2) : undefined
        if (name && isProtectedBranch(name)) return blocked("git worktree add", `it would create protected branch ${name}`, "create a feature branch instead")
      }
    }
    if (["list", "add", "move", "remove", "prune", "lock", "unlock", "repair"].includes(args[0])) return undefined
  }
  if (command === "reflog" && args[0] === "show") return undefined
  if (command === "bisect" && ["log", "visualize", "view"].includes(args[0])) return undefined
  if (command === "submodule" && ["status", "summary"].includes(args[0])) return undefined
  if (command === "clone" || command === "init") {
    return containsOption(args, ["--separate-git-dir"])
      ? blocked(`git ${command}`, "a separate Git directory can redirect existing repository metadata", "use ordinary repository setup without metadata redirection")
      : undefined
  }
  return blocked(`git ${command}`, "the command is not in the safe Git allow-list and may execute or mutate opaque repository state", "use a supported Git built-in with an explicit non-destructive operation")
}

async function checkRebaseTargets(invocation: Invocation): Promise<string | undefined> {
  const configured = await oneConfigValue(invocation, "rebase.updateRefs")
  if (!configured.ok) return blocked("git rebase", "rebase.updateRefs could not be verified")
  let updateRefs = configured.value !== undefined && !["false", "no", "off", "0"].includes(configured.value.toLowerCase())
  const positionals: string[] = []
  const valueOptions = ["--onto", "--exec", "-x", "--strategy", "-s", "--strategy-option", "-X", "--empty", "--whitespace"]
  for (let index = 0; index < invocation.args.length; index++) {
    const arg = invocation.args[index]
    if (arg === "--") { positionals.push(...invocation.args.slice(index + 1)); break }
    if (arg === "--update-refs") updateRefs = true
    if (arg === "--no-update-refs") updateRefs = false
    if (valueOptions.includes(arg)) { index++; continue }
    if (!arg.startsWith("-")) positionals.push(arg)
  }
  if (updateRefs) return blocked("git rebase", "effective update-refs can rewrite other branches", "use --no-update-refs on the feature branch")
  const branch = positionals.length > 1 || invocation.args.includes("--root") ? positionals.at(-1) : undefined
  if (branch) {
    const ref = await runGit(invocation, ["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", branch])
    if (!ref || ref.code !== 0) return blocked("git rebase", "the explicit branch target could not be verified", "switch to the feature branch first and rebase it separately")
    if (protectedRefName(branch) || protectedRefName(ref.stdout.trim())) return blocked("git rebase", `the explicit target ${branch} is protected`)
  }
}

async function checkSourceOnlyPushMapping(invocation: Invocation, source: string, remote: string | undefined, current: string | null): Promise<string | undefined> {
  if (!remote) return blocked("git push", "the remote for the source-only refspec is ambiguous", "use an explicit source:feature-destination refspec")
  const mappings = await configValues(invocation, `remote.${remote}.push`)
  if (!mappings.ok) return blocked("git push", "configured push mappings could not be verified")
  for (const mapping of mappings.values) {
    const issue = await analyzeConfiguredPushRefspec(invocation, mapping, current)
    if (issue) return issue
  }
  if (mappings.values.length) return undefined
  const mode = await oneConfigValue(invocation, "push.default")
  if (!mode.ok) return blocked("git push", "push.default could not be verified")
  if (mode.value !== "upstream") return undefined
  const branch = source === "HEAD" ? current : source.startsWith("refs/heads/") ? source.slice(11) : source
  if (!branch || source.startsWith("refs/tags/")) return undefined
  const upstream = await configValues(invocation, `branch.${branch}.merge`)
  if (!upstream.ok) return blocked("git push", "the source branch upstream could not be verified")
  if (upstream.values.some(ref => protectedRefName(ref))) return blocked("git push", "the source-only refspec maps to a protected upstream", "name an explicit non-protected destination after ':'")
}

async function checkReadOutput(invocation: Invocation): Promise<string | undefined> {
  if (!READ_COMMANDS.has(invocation.command)) return undefined
  const outputs: string[] = []
  for (let index = 0; index < invocation.args.length; index++) {
    const arg = invocation.args[index]
    if (arg === "--") break
    if (arg === "--output") {
      const value = invocation.args[++index]
      if (value === undefined) return blocked(`git ${invocation.command}`, "the output path is missing")
      outputs.push(value)
    } else if (arg.startsWith("--output=")) outputs.push(arg.slice(9))
  }
  if (!outputs.length) return undefined
  if (globalMutationIssue(invocation)) return blocked(`git ${invocation.command}`, "output with repository/config overrides cannot be verified")
  const metadata = await runGit(invocation, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"])
  if (!metadata || metadata.code !== 0) return blocked(`git ${invocation.command}`, "output destinations require a verified worktree")
  const [rootName, gitName, commonName] = metadata.stdout.trim().split("\n")
  if (!rootName || !gitName || !commonName) return blocked(`git ${invocation.command}`, "repository output boundaries could not be verified")
  const [root, gitDir, commonDir] = await Promise.all([realpath(rootName), realpath(gitName), realpath(commonName)])
  let cwd = invocation.cwd
  for (let index = 0; index < invocation.globalArgs.length; index++) {
    const arg = invocation.globalArgs[index]
    if (arg === "-C") { const value = invocation.globalArgs[++index]; if (value) cwd = resolve(cwd, value) }
    else if (arg.startsWith("-C") && arg.length > 2) cwd = resolve(cwd, arg.slice(2))
  }
  for (const output of outputs) {
    if (output.split(/[\\\\/]/).some(part => part === ".git" || part === "..")) return blocked(`git ${invocation.command}`, "output may not traverse parents or Git metadata")
    const path = isAbsolute(output) ? output : resolve(cwd, output)
    let actual: string
    try { actual = await realpath(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      actual = resolve(await realpath(dirname(path)), path.slice(path.lastIndexOf(sep) + 1))
    }
    if (!actual.startsWith(root + sep) || [gitDir, commonDir].some(dir => actual === dir || actual.startsWith(dir + sep))) {
      return blocked(`git ${invocation.command}`, "output would overwrite metadata or leave the worktree", "write output to a normal file inside the worktree")
    }
  }
}
