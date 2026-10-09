# Conductor — VS Code extension

Companion to the `conductor` CLI, for people whose agents and teammates live in the same
repository they edit in VS Code.

The extension holds no credentials of its own: every piece of data comes from the `conductor`
CLI (run with `--json`, with the first workspace folder as cwd so project resolution matches
the repo you have open), and shows only what the control plane shares — intent and territory,
never prompts.

## What it does

### In Flight tree (activity bar)

An activity-bar view with four sections, refreshed from one `conductor status --json` call
(every `conductor.refreshIntervalSeconds`, default 30; 0 disables polling):

- **In Flight** — active tasks: ref, title (or `(private)`), status, owner. Expand a task to
  see its scopes; `path:`/`dir:` scopes reveal in the Explorer when clicked.
- **Ready** — the ready queue (first 20, with a count of the rest).
- **Presence** — who is live, their state, and what task they are on.
- **Conflicts** — contested resources, severity-colored, when any exist.

Clicking a task opens its task card (the same Markdown `conductor task show` prints) in a
preview.

### Status bar

`◈ 2 in flight · 3 online` with a hover summary of what and who. Clicking it opens a quick
pick of every command below. When the CLI or control plane is unreachable the item degrades
to an offline indicator instead of hiding the problem.

### Commands

| Command | What it runs |
|---|---|
| **Conductor: Check Before Editing…** | `conductor check` — the pre-edit collision gate. Prompts for a summary, offers the active file / its directory / the repo / a custom scope, then shows the verdict: blocked (red), warning (yellow), or clear. Non-clear outcomes offer a **Create Task…** follow-through. |
| **Conductor: Create Task…** | `conductor task create` with title + picked scope; offers to claim the new task. |
| **Conductor: Claim Next Task** | `conductor task claim --next`; offers to open the task card or start a wrapped session. |
| **Conductor: Show Task Card…** | pick a task from the current snapshot, preview its card. |
| **Conductor: Release Task…** | pick an in-flight task, confirm, `conductor task release`. |
| **Conductor: Start Wrapped Agent Session…** | opens an integrated terminal running `conductor wrap <harness>` — a registered, heartbeating session contributing interactive capacity to the swarm. |
| **Conductor: Open Dashboard** | `conductor dashboard` — opens the ready link in your browser. |
| **Conductor: Pause / Resume All Agent Sessions** | `conductor pause` / `conductor resume`. |

### Resume handoffs

Pausing already works without this extension: a VS Code integrated terminal is an ordinary
pty, so `conductor pause` freezes sessions running there like any others, and
`conductor resume` wakes them in place. What VS Code cannot do without help is **reopen** a
session whose terminal tab (or window) was closed — there is no command-line way to open an
integrated terminal running a command. This extension supplies that missing piece: when
`conductor resume` finds a paused session that was running in a VS Code integrated terminal
(recorded from `TERM_PROGRAM` at pause time) and this extension is installed, it fires
`vscode://conductor.conductor-sessions/resume?id=<record-id>` instead of opening tmux or a
GUI emulator. The extension reads the session record from `~/.conductor/sessions/`, opens an
integrated terminal in the session's working directory, and runs the harness's own
conversation-resume invocation (`claude --continue`, `codex resume --last`,
`opencode --continue`) — under `conductor wrap` with the original capability flags when the
session was wrapped.

The URI deliberately carries only a record id, never a command line. The command is
reconstructed from the record file on disk, which is owner-only (0600) — a hostile
`vscode://` link cannot inject anything a local process could not already do.

The record is deleted only after the terminal is actually open (ownership passes from the
CLI to the extension with the handoff), so a handoff that goes nowhere — extension
uninstalled mid-flight, window closed — leaves the session paused and retryable.

## Install

The extension is plain JavaScript with no build step. Package and install it locally:

```bash
cd integrations/vscode
npx @vscode/vsce package        # produces conductor-sessions-0.2.0.vsix
code --install-extension conductor-sessions-0.2.0.vsix
```

`conductor resume` detects the extension via `code --list-extensions` and falls back to its
normal terminal chain when it is absent, so installing (or removing) it never breaks resume.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `conductor.cliPath` | `conductor` | Path to the CLI binary, if it is not on VS Code's PATH. |
| `conductor.stateDir` | *(empty)* | Conductor state directory, mirroring the CLI's `CONDUCTOR_STATE_DIR`. Empty means `~/.conductor`. |
| `conductor.refreshIntervalSeconds` | `30` | Seconds between automatic refreshes of in-flight status. `0` disables polling. |

## Notes

- The extension's id is `conductor.conductor-sessions` and must stay that way: the CLI's
  resume handoff (`internal/localstate/vscode.go`) fires a URI at that exact authority.
- The CLI is always run with the first workspace folder as cwd, so project resolution
  follows the repo you have open. Environment overrides (`CONDUCTOR_ENDPOINT`,
  `CONDUCTOR_TOKEN`, `CONDUCTOR_PROJECT`, `CONDUCTOR_CA_CERT`) pass through unchanged.
- Claimed-from-VS Code leases expire unless a wrapped session heartbeats them — same rule
  as the CLI; the claim confirmation says so.
- With several VS Code windows open, the resume URI lands in the last-focused window; the
  terminal still opens in the session's recorded working directory, so the session is
  correct even if the window is not the one it originally lived in.
- `TERM_PROGRAM` detection for *bare* (unwrapped) sessions reads `/proc/<pid>/environ` and is
  therefore Linux-only; sessions launched through `conductor wrap` record it on every
  platform. A session without a recorded terminal program simply resumes through the CLI's
  normal terminal chain.
