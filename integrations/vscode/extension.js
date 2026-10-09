// Conductor — VS Code companion to the `conductor` CLI.
//
// Two jobs:
//
// 1. Surface what the control plane already knows — who is live, what work is
//    in flight, and where two efforts are about to collide — in an activity-bar
//    tree, a status bar item, and palette commands (`check` before you edit,
//    task claim/create/show/release, `wrap`, dashboard, pause/resume). All data
//    flows through the CLI with `--json`, run with the workspace folder as cwd
//    so project resolution matches the repo you have open. The extension holds
//    no credentials of its own and shows only what `conductor status` shares:
//    intent and territory, never prompts.
//
// 2. Handle resume handoffs from `conductor resume`. VS Code cannot be told to
//    open an integrated terminal from the command line, so the CLI fires a
//    vscode:// URI at this extension when a paused session lived in a VS Code
//    integrated terminal. The URI carries only a record id — never a command
//    line — and this extension reads the actual session record from Conductor's
//    own state directory. A URI that carried a command would let any page
//    rendering a vscode:// link inject one; a record id is useless to anyone
//    who cannot already write the user's 0600 record files.
//
// Plain JavaScript on purpose: no compile step, no toolchain in a Go repository.
// Package with `npx @vscode/vsce package` and install the .vsix with
// `code --install-extension`.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Task statuses that count as "in flight" (internal/domain/enums.go TaskStatus).
const IN_FLIGHT_STATUSES = new Set([
  'claimed', 'running', 'verifying', 'blocked_dependency', 'blocked_conflict',
  'blocked_input', 'review_required', 'merging',
]);
// Presence states that count as online (internal/domain/enums.go PresenceState).
const ONLINE_STATES = new Set([
  'online_idle', 'planning', 'working', 'waiting_for_input', 'reviewing', 'blocked',
]);
const READY_SECTION_LIMIT = 20;
const HARNESS_CHOICES = ['claude', 'codex', 'opencode'];

let channel; // vscode.OutputChannel
let tree;     // ConductorTree
let bar;      // vscode.StatusBarItem
let pollTimer = null;
let refreshing = false;

function activate(context) {
  channel = vscode.window.createOutputChannel('Conductor');
  tree = new ConductorTree();
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 60);
  bar.command = 'conductor.menu';

  context.subscriptions.push(
    channel,
    bar,
    { dispose: () => { if (pollTimer) clearInterval(pollTimer); } },
    vscode.window.registerUriHandler({ handleUri }),
    vscode.window.registerTreeDataProvider('conductor.inFlight', tree),
    vscode.commands.registerCommand('conductor.refresh', () => refresh()),
    vscode.commands.registerCommand('conductor.menu', () => menu()),
    vscode.commands.registerCommand('conductor.check', () => checkCommand()),
    vscode.commands.registerCommand('conductor.taskCreate', () => taskCreate()),
    vscode.commands.registerCommand('conductor.taskClaimNext', () => claimNextCommand()),
    vscode.commands.registerCommand('conductor.taskShow', (task) => taskShowCommand(task)),
    vscode.commands.registerCommand('conductor.taskRelease', () => releaseCommand()),
    vscode.commands.registerCommand('conductor.wrap', () => wrapCommand()),
    vscode.commands.registerCommand('conductor.dashboard', () => dashboardCommand()),
    vscode.commands.registerCommand('conductor.pauseAll', () => runSimple(['pause'])),
    vscode.commands.registerCommand('conductor.resumeAll', () => runSimple(['resume'])),
    vscode.workspace.onDidChangeConfiguration(onConfigChanged),
  );

  bar.show();
  schedulePoll();
  refresh();
}

// ---------------------------------------------------------------------------
// Status snapshot: one `conductor status --json` feeds the tree and the bar.
// ---------------------------------------------------------------------------

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await runCLI(['status', '--json']);
    let status = null;
    let error = '';
    if (res.code === 'ENOENT') {
      error = 'conductor CLI not found — set conductor.cliPath in settings.';
    } else if (res.code !== 0) {
      error = firstLine(res.stderr) || 'conductor status failed.';
    } else {
      try {
        status = JSON.parse(res.stdout);
      } catch {
        error = 'could not parse conductor status output.';
      }
    }
    tree.setData(status, error);
    updateStatusBar(status, error);
  } finally {
    refreshing = false;
  }
}

function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = vscode.workspace.getConfiguration('conductor').get('refreshIntervalSeconds', 30);
  if (seconds > 0) {
    pollTimer = setInterval(refresh, seconds * 1000);
  }
}

function onConfigChanged(e) {
  if (!e.affectsConfiguration('conductor')) return;
  schedulePoll();
  refresh();
}

function updateStatusBar(status, error) {
  if (error) {
    bar.text = '$(circle-slash) conductor';
    bar.tooltip = error;
    return;
  }
  const counts = (status && status.counts) || {};
  let inflight = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (IN_FLIGHT_STATUSES.has(name)) inflight += n;
  }
  const online = ((status && status.presence) || []).filter((p) => ONLINE_STATES.has(p.state)).length;
  bar.text = `$(pulse) ${inflight} in flight · ${online} online`;
  bar.tooltip = statusTooltip(status);
}

function statusTooltip(status) {
  const lines = [`**${(status && status.project) || 'conductor'}**`];
  const active = (status && status.active) || [];
  if (active.length) {
    lines.push('', 'In flight:');
    active.slice(0, 10).forEach((t) => {
      lines.push(`- \`${t.ref}\` ${t.title || '(private)'} — ${t.status}${t.owner ? ' · ' + t.owner : ''}`);
    });
  }
  const presence = (status && status.presence) || [];
  if (presence.length) {
    lines.push('', 'Presence:');
    presence.slice(0, 10).forEach((p) => {
      const where = p.task_ref ? ` · ${p.task_ref}` : '';
      lines.push(`- ${p.principal} · ${p.state}${where}`);
    });
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tree: sections for in-flight tasks, ready tasks, presence, and conflicts.
// ---------------------------------------------------------------------------

class ConductorTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.status = undefined; // undefined = loading, null = error, object = ok
    this.error = '';
  }

  setData(status, error) {
    this.status = status;
    this.error = error || '';
    this.emitter.fire();
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (el) return el.children || [];
    if (this.status === undefined) return [infoNode('Loading…', 'sync~spin')];
    if (this.status === null) {
      return [infoNode('conductor unavailable', 'error'), infoNode(this.error, 'info')];
    }
    return this.sections();
  }

  sections() {
    const s = this.status;
    const active = s.active || [];
    const ready = s.ready || [];
    const presence = s.presence || [];
    const conflicts = s.conflicts || [];
    const readyTotal = (s.counts && s.counts.ready) || ready.length;

    const sections = [
      sectionNode(`In Flight (${active.length})`, 'pulse', active.map(taskNode),
        vscode.TreeItemCollapsibleState.Expanded),
      sectionNode(`Ready (${readyTotal})`, 'inbox', readyTasks(ready, readyTotal),
        vscode.TreeItemCollapsibleState.Collapsed),
      sectionNode(`Presence (${presence.length})`, 'people', presence.map(presenceNode),
        vscode.TreeItemCollapsibleState.Expanded),
    ];
    if (conflicts.length) {
      sections.push(sectionNode(`Conflicts (${conflicts.length})`, 'warning',
        conflicts.map(conflictNode), vscode.TreeItemCollapsibleState.Expanded));
    }
    return sections;
  }
}

function readyTasks(ready, total) {
  const nodes = ready.slice(0, READY_SECTION_LIMIT).map(taskNode);
  if (total > ready.length) {
    nodes.push(infoNode(`… and ${total - ready.length} more`, 'more'));
  }
  return nodes;
}

function sectionNode(label, icon, children, state) {
  const item = new vscode.TreeItem(label, state);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.children = children;
  item.contextValue = 'section';
  return item;
}

function infoNode(label, icon) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function taskNode(t) {
  const item = new vscode.TreeItem(`${t.ref} ${t.title || '(private)'}`);
  item.description = `${t.status} · ${t.owner || 'unowned'}`;
  item.tooltip = taskTooltip(t);
  item.iconPath = new vscode.ThemeIcon('tasklist');
  item.contextValue = 'task';
  item.collapsibleState = (t.scopes && t.scopes.length)
    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
  item.children = (t.scopes || []).map(scopeNode);
  item.command = { command: 'conductor.taskShow', title: 'Show Task Card', arguments: [t] };
  return item;
}

function taskTooltip(t) {
  const lines = [`**${t.ref}** — ${t.title || 'private work'}`, `- status: ${t.status}`];
  if (t.owner) lines.push(`- owner: ${t.owner}`);
  if (t.harness) lines.push(`- harness: ${t.harness}`);
  if (t.branch) lines.push(`- branch: \`${t.branch}\``);
  (t.scopes || []).forEach((s) => lines.push(`- scope: \`${s}\``));
  if (t.updated_at) lines.push(`- updated: ${t.updated_at}`);
  return lines.join('\n');
}

// scopeNode: path:/dir: scopes reveal in the Explorer; other kinds are inert.
function scopeNode(scope) {
  const item = new vscode.TreeItem(scope, vscode.TreeItemCollapsibleState.None);
  const sep = scope.indexOf(':');
  const kind = sep > 0 ? scope.slice(0, sep) : '';
  const key = sep > 0 ? scope.slice(sep + 1) : '';
  item.iconPath = new vscode.ThemeIcon(
    kind === 'dir' ? 'folder' : kind === 'path' ? 'file' : 'tag');
  const uri = scopeUri(kind, key);
  if (uri) {
    item.tooltip = 'Reveal in Explorer';
    item.command = { command: 'revealInExplorer', title: 'Reveal', arguments: [uri] };
  }
  return item;
}

function scopeUri(kind, key) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder || (kind !== 'path' && kind !== 'dir')) return undefined;
  if (!key || key.startsWith('/') || key.split('/').includes('..')) return undefined;
  return vscode.Uri.joinPath(folder.uri, ...key.split('/'));
}

function presenceNode(p) {
  const item = new vscode.TreeItem(p.principal);
  item.description = `${p.state}${p.task_ref ? ' · ' + p.task_ref : ''}`;
  item.iconPath = new vscode.ThemeIcon(p.state === 'working' ? 'sync' : 'person');
  const lines = [`**${p.principal}** — ${p.state}`];
  if (p.harness) lines.push(`- harness: ${p.harness}`);
  if (p.kind) lines.push(`- kind: ${p.kind}`);
  if (p.task_ref) lines.push(`- task: \`${p.task_ref}\`${p.task_title ? ' — ' + p.task_title : ''}`);
  (p.scopes || []).forEach((s) => lines.push(`- scope: \`${s}\``));
  if (p.last_heartbeat) lines.push(`- last heartbeat: ${p.last_heartbeat}`);
  item.tooltip = lines.join('\n');
  return item;
}

function conflictNode(c) {
  const item = new vscode.TreeItem(`${(c.other && c.other.task_ref) || c.id}`);
  item.description = `${c.severity} · ${c.kind}`;
  const hot = c.severity === 'high' || c.severity === 'critical';
  item.iconPath = new vscode.ThemeIcon('warning',
    hot ? new vscode.ThemeColor('list.errorForeground') : undefined);
  const lines = [`**${c.kind}** (${c.severity})`];
  if (c.reason) lines.push('', c.reason);
  (c.resources || []).forEach((r) => lines.push(`- resource: \`${r}\``));
  if (c.other && c.other.task_ref) {
    lines.push(`- other: \`${c.other.task_ref}\`${c.other.owner ? ' — ' + c.other.owner : ''}`);
  }
  if (c.suggestion) lines.push(`- suggestion: ${c.suggestion}`);
  item.tooltip = lines.join('\n');
  return item;
}

// ---------------------------------------------------------------------------
// Palette commands.
// ---------------------------------------------------------------------------

async function menu() {
  const pick = await vscode.window.showQuickPick([
    { label: '$(eye) Check Before Editing…', run: () => checkCommand() },
    { label: '$(add) Create Task…', run: () => taskCreate() },
    { label: '$(arrow-down) Claim Next Task', run: () => claimNextCommand() },
    { label: '$(book) Show Task Card…', run: () => taskShowCommand() },
    { label: '$(arrow-right) Release Task…', run: () => releaseCommand() },
    { label: '$(terminal) Start Wrapped Agent Session…', run: () => wrapCommand() },
    { label: '$(globe) Open Dashboard', run: () => dashboardCommand() },
    { label: '$(debug-pause) Pause All Agent Sessions', run: () => runSimple(['pause']) },
    { label: '$(play) Resume All Agent Sessions', run: () => runSimple(['resume']) },
    { label: '$(refresh) Refresh', run: () => refresh() },
  ], { placeHolder: 'Conductor' });
  if (pick && pick.run) pick.run();
}

// checkCommand mirrors the CLI's pre-edit gate: `conductor check --summary …
// --scope …`. Exit 3 (blocked) still carries the decision JSON on stdout.
async function checkCommand() {
  const summary = await vscode.window.showInputBox({
    prompt: 'What are you about to do?',
    placeHolder: 'e.g. add retry-aware model routing',
  });
  if (!summary) return;
  const scope = await pickScope();
  if (scope === undefined) return;

  const res = await runCLI(['check', '--summary', summary, '--scope', scope, '--json']);
  let decision = null;
  try {
    decision = JSON.parse(res.stdout);
  } catch { /* fall through to error handling */ }
  if (!decision || !decision.outcome) {
    showError('conductor check failed', res);
    return;
  }
  presentDecision(decision, summary, scope);
}

function presentDecision(d, summary, scope) {
  const headline = decisionHeadline(d);
  const buttons = d.outcome === 'allow' ? [] : ['Create Task…'];
  const show = d.outcome === 'block_conflict' || d.outcome === 'block_duplicate'
    ? vscode.window.showErrorMessage
    : d.outcome === 'allow' ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage;
  show(headline, ...buttons).then((choice) => {
    if (choice === 'Create Task…') taskCreate({ summary, scope });
  });
}

function decisionHeadline(d) {
  const c = (d.conflicts || [])[0];
  const dup = (d.duplicates || [])[0];
  const advice = d.advice ? ' ' + d.advice : '';
  switch (d.outcome) {
    case 'allow':
      return 'Clear to proceed. Nothing else in flight touches this.';
    case 'allow_with_warning':
      if (c) {
        return `Proceed with care: ${c.holder_owner || 'someone'} holds ${c.resource} for ` +
          `${c.holder_task_ref} (${c.holder_mode}).`;
      }
      return 'Proceed with care.' + advice;
    case 'block_conflict':
      if (c) {
        return `Blocked: ${c.holder_owner || 'someone'} holds ${c.resource} for ` +
          `${c.holder_task_ref} (${c.holder_mode}). Wait, split your scope, or join their task.`;
      }
      return 'Blocked: scope conflict.' + advice;
    case 'block_duplicate':
      return dup
        ? `Blocked: duplicate of ${dup.task_ref}${dup.owner ? ' (' + dup.owner + ')' : ''}.`
        : 'Blocked: duplicate work already in flight.' + advice;
    case 'suggest_join':
      return dup
        ? `Similar work already in flight: ${dup.task_ref}${dup.owner ? ' (' + dup.owner + ')' : ''}. Join it, or narrow your scope.`
        : 'Similar work already in flight.' + advice;
    case 'suggest_wait':
      return 'Related work is in flight — wait for it.' + advice;
    case 'suggest_split':
      return 'Split your scope — part of it is contested.' + advice;
    case 'suggest_supersede':
      return 'Consider superseding the existing task for this work.' + advice;
    default:
      return `${d.outcome}.${advice}`;
  }
}

// pickScope offers the active file / its directory / the repo / a custom value.
// Returns a scope string, or undefined when cancelled.
async function pickScope() {
  const items = [];
  const editor = vscode.window.activeTextEditor;
  const folder = editor ? containingFolder(editor.document.fileName) : workspaceRoot();
  if (editor && folder) {
    const rel = path.relative(folder, editor.document.fileName);
    if (rel && !rel.startsWith('..')) {
      items.push({ label: 'This file', description: `path:${rel}`, scope: `path:${rel}` });
      const dir = path.dirname(rel);
      if (dir !== '.') {
        items.push({ label: 'This directory', description: `dir:${dir}`, scope: `dir:${dir}` });
      }
    }
  }
  if (workspaceRoot()) {
    items.push({ label: 'Whole repository', description: 'repo:', scope: 'repo:' });
  }
  items.push({ label: 'Custom…', description: 'dir:…, path:…, migration:…', scope: null });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Scope to check or reserve',
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked.scope !== null) return picked.scope;
  const custom = await vscode.window.showInputBox({
    prompt: 'Scope (e.g. dir:internal/api, path:README.md, repo:)',
    placeHolder: 'dir:internal/api',
  });
  return custom && custom.trim() ? custom.trim() : undefined;
}

async function taskCreate(prefill) {
  const title = await vscode.window.showInputBox({
    prompt: 'Task title',
    value: (prefill && prefill.summary) || '',
  });
  if (!title) return;
  const scope = await pickScope();
  if (scope === undefined) return;

  const res = await runCLI(['task', 'create', '--title', title, '--scope', scope]);
  if (res.code !== 0) {
    showError('conductor task create failed', res);
    return;
  }
  const ref = extractRef(res.stdout);
  const msg = ref ? `Created ${ref} — ${title}` : (firstLine(res.stdout) || 'Task created.');
  if (ref) {
    vscode.window.showInformationMessage(msg, 'Claim it').then((choice) => {
      if (choice === 'Claim it') claimRef(ref);
    });
  } else {
    vscode.window.showInformationMessage(msg);
  }
  refresh();
}

function extractRef(stdout) {
  try {
    const v = JSON.parse(stdout);
    const ref = (v.task && v.task.ref) || v.ref || (v.task && v.task.id);
    if (ref) return ref;
  } catch { /* text output */ }
  return (stdout.match(/T-\d+/) || [])[0];
}

async function claimNextCommand() {
  const res = await runCLI(['task', 'claim', '--next', '--json']);
  let data = null;
  try {
    data = JSON.parse(res.stdout);
  } catch { /* fall through */ }
  if (data && data.task) {
    const t = data.task;
    const choice = await vscode.window.showInformationMessage(
      `Claimed ${t.ref} — ${t.title || '(private)'}. ` +
      'The lease expires unless a wrapped session heartbeats it.',
      'Open task card', 'Start wrapped session');
    if (choice === 'Open task card') taskShowCommand(t);
    if (choice === 'Start wrapped session') wrapCommand();
  } else {
    vscode.window.showWarningMessage(
      firstLine(res.stderr) || firstLine(res.stdout) || 'No task claimed.');
  }
  refresh();
}

async function claimRef(ref) {
  const res = await runCLI(['task', 'claim', ref]);
  if (res.code !== 0) {
    showError(`conductor task claim ${ref} failed`, res);
    return;
  }
  vscode.window.showInformationMessage(firstLine(res.stdout) || `Claimed ${ref}.`);
  refresh();
}

async function taskShowCommand(task) {
  let t = task;
  if (!t) {
    const list = cachedTasks();
    if (!list.length) {
      vscode.window.showInformationMessage('No tasks in the current status snapshot.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      list.map((x) => ({
        label: `${x.ref} ${x.title || '(private)'}`,
        description: `${x.status} · ${x.owner || 'unowned'}`,
        task: x,
      })),
      { placeHolder: 'Show task card' });
    if (!picked) return;
    t = picked.task;
  }
  const res = await runCLI(['task', 'show', t.ref]);
  if (res.code !== 0) {
    showError(`conductor task show ${t.ref} failed`, res);
    return;
  }
  const file = path.join(os.tmpdir(),
    `conductor-${String(t.ref).replace(/[^A-Za-z0-9-]/g, '_')}.md`);
  fs.writeFileSync(file, res.stdout);
  vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

function cachedTasks() {
  if (!tree.status || typeof tree.status !== 'object') return [];
  return (tree.status.active || []).concat(tree.status.ready || []);
}

async function releaseCommand() {
  const list = (tree.status && tree.status.active) || [];
  if (!list.length) {
    vscode.window.showInformationMessage('Nothing in flight to release.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((x) => ({
      label: `${x.ref} ${x.title || '(private)'}`,
      description: `${x.status} · ${x.owner || 'unowned'}`,
      task: x,
    })),
    { placeHolder: 'Release task (its scopes go back to the pool)' });
  if (!picked) return;
  const t = picked.task;
  const confirm = await vscode.window.showWarningMessage(
    `Release ${t.ref}?`, { modal: true }, 'Release');
  if (confirm !== 'Release') return;
  const res = await runCLI(['task', 'release', t.ref]);
  if (res.code !== 0) {
    showError(`conductor task release ${t.ref} failed`, res);
    return;
  }
  vscode.window.showInformationMessage(`Released ${t.ref}.`);
  refresh();
}

// wrapCommand opens an integrated terminal running `conductor wrap <harness>`:
// a registered, heartbeating session — the VS Code-native way to contribute
// interactive capacity to the swarm.
async function wrapCommand() {
  const items = HARNESS_CHOICES.map((h) => ({ label: h }));
  items.push({ label: 'Custom…' });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Harness to wrap (registers a session and heartbeats)',
  });
  if (!picked) return;
  let harness = picked.label;
  if (harness === 'Custom…') {
    harness = await vscode.window.showInputBox({
      prompt: 'Harness command (e.g. claude)',
      placeHolder: 'claude',
    });
    if (!harness) return;
  }
  const terminal = vscode.window.createTerminal({
    name: `conductor · ${harness}`,
    cwd: workdir(),
  });
  terminal.show();
  terminal.sendText([shellQuote(cliPath()), 'wrap', harness].join(' '));
}

async function dashboardCommand() {
  const res = await runCLI(['dashboard']);
  const link = (res.stdout.match(/https?:\/\/\S+/) || [])[0];
  if (link) {
    vscode.env.openExternal(vscode.Uri.parse(link));
    return;
  }
  showError('conductor dashboard produced no link', res);
}

async function runSimple(args) {
  const res = await runCLI(args);
  if (res.code !== 0) {
    showError(`conductor ${args[0]} failed`, res);
    return;
  }
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  vscode.window.showInformationMessage('Conductor: ' + (lines[lines.length - 1] || 'done.'));
}

// ---------------------------------------------------------------------------
// CLI plumbing.
// ---------------------------------------------------------------------------

// runCLI resolves {code, stdout, stderr}. code is the exit status (number), or
// a spawn error string like 'ENOENT'. Exit 3 is a coordination refusal, not an
// infrastructure failure — callers that expect JSON should parse stdout anyway.
function runCLI(args) {
  return new Promise((resolve) => {
    cp.execFile(cliPath(), args, { timeout: 60000, cwd: workdir() },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : (err.code || 1)) : 0;
        const extra = err && typeof err.code !== 'number' ? '\n' + err.message : '';
        resolve({ code, stdout: stdout || '', stderr: (stderr || '') + extra });
      });
  });
}

function showError(prefix, res) {
  channel.appendLine(`! ${prefix}`);
  if (res.stderr) channel.appendLine(res.stderr.trim());
  if (res.stdout) channel.appendLine(res.stdout.trim());
  vscode.window.showErrorMessage(prefix + ': ' + (firstLine(res.stderr) || 'failed'),
    'Show Output').then((choice) => {
    if (choice === 'Show Output') channel.show();
  });
}

function firstLine(s) {
  return (s || '').trim().split('\n')[0] || '';
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : undefined;
}

function containingFolder(fileName) {
  const folders = vscode.workspace.workspaceFolders || [];
  const match = folders.find((f) => fileName.startsWith(f.uri.fsPath + path.sep));
  return match ? match.uri.fsPath : undefined;
}

function workdir() {
  return workspaceRoot();
}

// ---------------------------------------------------------------------------
// Resume handoff (vscode://conductor.conductor-sessions/resume?id=<record-id>).
// ---------------------------------------------------------------------------

function handleUri(uri) {
  if (uri.path !== '/resume') {
    return;
  }
  const id = scrubId(new URLSearchParams(uri.query).get('id') || '');
  if (!id) {
    return;
  }
  const file = path.join(sessionsDir(), id + '.json');

  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Already resumed elsewhere, or the record never existed. Saying so beats silence:
    // the user clicked resume and something should acknowledge it.
    vscode.window.showInformationMessage('Conductor: that session is already resumed (or its record is gone).');
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: (rec.harness || 'agent') + ' · conductor',
    cwd: rec.cwd || undefined,
  });
  terminal.show();
  terminal.sendText(relaunchCommand(rec), true);

  // Ownership protocol with the CLI: `conductor resume` leaves the record in place so an
  // unhandled handoff stays retryable; the record is deleted only here, once the terminal
  // actually exists. A relaunched `conductor wrap` writes a fresh record of its own.
  try {
    fs.unlinkSync(file);
  } catch {
    // Losing the delete only means the next `conductor pause` prunes a dead record.
  }
}

// relaunchCommand mirrors relaunchArgv in cmd/conductor/pause.go: the harness's own resume
// invocation, under `conductor wrap` (with the original capability flags) when the session
// was wrapped, bare when it was not.
function relaunchCommand(rec) {
  const tail = (rec.resume_args && rec.resume_args.length) ? rec.resume_args : (rec.args || []);
  let argv;
  if (rec.wrapped) {
    argv = [cliPath(), 'wrap', ...(rec.wrap_flags || []), rec.harness, ...tail];
  } else {
    argv = [rec.command || rec.harness, ...tail];
  }
  return argv.map(shellQuote).join(' ');
}

function sessionsDir() {
  const configured = vscode.workspace.getConfiguration('conductor').get('stateDir');
  const base = configured || process.env.CONDUCTOR_STATE_DIR || path.join(os.homedir(), '.conductor');
  return path.join(base, 'sessions');
}

function cliPath() {
  return vscode.workspace.getConfiguration('conductor').get('cliPath') || 'conductor';
}

// scrubId applies the same mapping as the CLI's record file naming (localstate.fileName):
// anything outside [A-Za-z0-9-] becomes '_'. The id arrives from a URI, and an id must never
// be able to name a path outside the sessions directory.
function scrubId(id) {
  return id.replace(/[^A-Za-z0-9-]/g, '_');
}

// shellQuote matches the CLI's quoting: bare when safe, single-quoted otherwise.
function shellQuote(s) {
  if (s === '') {
    return "''";
  }
  if (!/[ \t\n"'\\$&|;<>()*?\[\]#~`!{}]/.test(s)) {
    return s;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function deactivate() {}

module.exports = { activate, deactivate };
