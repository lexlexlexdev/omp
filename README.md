# Personal omp setup

Configuration, instructions, extensions, theme, and selected installed skills for omp. Runtime databases, session history, caches, credentials, and secrets are intentionally excluded.

## Safety rails

`agent/extensions/safety-rails.ts` is an omp extension. Its Git policy lives in `agent/extensions/safety/git.ts`. It uses the native tool-call and user-Bash hooks; it does not replace Bash or show approval dialogs. `bash.gitGuard` stays disabled, and the old blanket push-deny patterns are removed.

### Allowed

- Ordinary checkout/switch, including checking out a protected branch for inspection.
- Feature-branch creation, staging, commits, normal pushes, and PR creation.
- Non-forced file moves/removal, ordinary patch application, repository creation, and worktree operations.
- Unstaging, normal stash save/apply/pop, and read-only Git commands.
- Individual literal file deletion inside the workspace, excluding Git metadata.
- Recursive cleanup under the repository-root directories `dist`, `build`, `out`, `.next`, `coverage`, `.cache`, and `.tmp`. Outside a Git repository, the explicit command cwd is the cleanup root.

### Refused

- Direct history changes on `main`, `master`, `dev`, or `develop`, and mutations of their local refs.
- Pushes to those protected destinations, including implicit/configured destinations and explicit refspecs.
- Force pushes, leading `+` refspecs, remote branch deletion, mirror pushes, and ambiguous push mappings.
- Forced checkout/switch, worktree-discarding restore/reset, destructive clean, and stash drop/clear.
- Automatic PR merge, repository sync/deletion through `gh`, and API calls with explicit methods or payloads.
- Arbitrary recursive deletion, workspace/home/root deletion, Git-metadata deletion, glob/variable cleanup targets, symlink traversal, and parent traversal hidden inside a target.
- Recognizable destructive host operations, privilege escalation, and fetched scripts executed by a shell.
- Command substitutions, unmodeled shell-state changes, and unclassifiable command prefixes. Literal GitHub CLI aliases are inspected; aliases cannot hide a PR merge.
- Git diff/log output files that target repository metadata or leave the worktree.

Protected names are defined at the top of `safety/git.ts`; generated cleanup roots are defined at the top of `safety-rails.ts`.

A refusal tells the agent what was blocked and how to continue. Ambiguous safety-sensitive commands must be split into literal calls. In particular, changing branches/configuration and then mutating Git in the same shell call is refused, because preflight cannot inspect future repository state. Ordinary `git add && git commit` and `git commit && git push` remain supported. Git configuration writes and opaque Git execution options are conservative refusals.

### Installation

Copy the tracked configuration and selected assets into your existing setup, preserving private/runtime files. Install these two paths together:

- `agent/extensions/safety-rails.ts` → `~/.omp/agent/extensions/safety-rails.ts`
- `agent/extensions/safety/git.ts` → `~/.omp/agent/extensions/safety/git.ts`

Restart omp to load the new extension. Editing configuration alone does not load a newly installed extension into an already-running session. Native child sessions inherit the parent's prepared extension factories and bind their own handlers; start a fresh parent session to cover its future children.

To require this extension to load successfully rather than merely relying on ambient discovery, launch omp with `--trusted-extension /absolute/path/to/safety-rails.ts`. This is an exact extension allowlist: include additional trusted extensions explicitly if you want them loaded too.

### Boundary

These are accident guardrails, not a sandbox. The hooks inspect recognizable Bash commands and literal shell wrappers. They do not inspect arbitrary code inside `eval`, Python/JavaScript subprocess APIs, executable scripts, package scripts, Git hooks, custom tools, or other trusted extensions. Direct filesystem tool operations are not governed by the Bash deletion policy. Checks are preflight checks, not transaction locks against another process changing refs or symlinks concurrently. GitHub branch protection, with credentials unable to bypass it, is the independent remote backstop.

Do not approve a forbidden operation by running it through another execution path. Use a feature branch, a PR, or an approved cleanup path instead.

## Verification

Requires Bun, Git, and GitHub CLI (`gh`):

```bash
bun install --ignore-scripts --no-save
bun test tests
```

The regression suite uses disposable repositories/directories and a local bare remote. It does not push to GitHub or delete user files.
