# k9s

A Claude Code mod: a live, interactive k9s terminal in a pane, plus two tools so the model can read what k9s shows and drive it.

How it works: k9s runs on the host under a private tmux server (socket `claude-k9s`, started with `-f /dev/null`, so your own tmux config is not involved). The mod polls `tmux capture-pane` and draws the screen in the pane; keys you type in the pane go back through `tmux send-keys`. Because tmux is started by the Claude Code process, k9s inherits the kube context and credentials of the shell that launched Claude Code (`KUBECONFIG`, `AWS_PROFILE`, SSO tokens, ...). Nothing is stored.

## Use

- `/k9s` opens the pane and starts k9s if needed. `/k9s stop`, `/k9s restart`.
- Click the screen to give it the keyboard; Esc hands the keys back to the prompt. The `[Esc]` and `[^C]` buttons in the header send those keys to k9s, since the terminal keeps them for itself.
- The pane's size is pushed to tmux, so k9s redraws to fit it.
- k9s is stopped when the session ends (not on `/clear`).

## Nothing left behind

- One tmux server per Claude Code process, on the socket `claude-k9s-<pid>`. Two sessions never share a k9s, and one ending cannot stop the other's.
- A watchdog inside that server polls the Claude Code pid every 3 s and ends the server when the pid is gone, so a crash or a closed terminal takes k9s with it.
- At every session start the mod sweeps `claude-k9s-*` sockets whose pid is dead: their servers are killed and the socket files removed.
- Idle stop: with the pane closed and no tool or key activity for `idleMinutes` (default 15), k9s is stopped so it does not keep polling the cluster unseen. `/k9s` starts it again. Set it to 0 to disable.
- While k9s is not running the mod makes no tmux calls at all; while the pane is closed it reads the screen eight times less often.
- Manual cleanup, should you ever need it: `ls /tmp/tmux-$(id -u)/` and `tmux -L <name> kill-server`.

To make k9s itself lighter, pass `--refresh 5` (seconds between cluster polls, default 2) in the `args` setting.

## Install

```
/plugin install k9s --marketplace holdennguyen/claude-code-setup
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one). From a shell: `claude plugin marketplace add holdennguyen/claude-code-setup` then `claude plugin install k9s@claude-code-setup`. Requires `tmux` and `k9s` on PATH; k9s inherits the kube context of the shell that launched Claude Code. Built against Claude Code 2.1.295 (the mods API is early access).

## What it reaches

A mod runs inside Claude Code with your permissions. `claude plugin validate plugins/k9s` lists everything this one does, without running it:

- hooks: `session.start`, `session.end`, `ui.close{id=k9s}`, `command.run{command=k9s}`, `tool.call{tool=Bash}`, `tool.call{tool=mcp__k9s__screen}`, `tool.call{tool=mcp__k9s__keys}`, `ui.message`, `ui.render{component=Pane, requestId=k9s}`
- calls: `$.clock.after`, `$.clock.every`, `$.clock.sleep`, `$.command.register`, `$.process.run` (tmux only: a private server, `capture-pane`, `send-keys`, `kill-server`, and the pid sweep), `$.state.get`, `$.state.set`, `$.tool.register`, `$.ui.open`, `$.ui.panes`, `$.ui.resolve`, `$.ui.toast`

No network, no file writes, no model calls. The only process it starts is tmux running the `command` you configure (k9s by default). The `tool.call{tool=Bash}` hook reads the command text to spot kubectl and refuses the call while k9s runs; it never rewrites or runs anything.

## Tools the model gets

- `mcp__k9s__screen`: the visible text of the k9s screen plus the cursor position. Starts k9s if it is not running.
- `mcp__k9s__keys`: sends a list of keys (`[":pods", "Enter"]`, `["Escape"]`, `["C-d"]`) and returns the screen afterwards.

## kubectl while k9s is open

While k9s is running in this session, a Bash call that invokes kubectl is refused and the model is told to use the two tools above instead: you are watching the pane, and k9s already runs on your context. The guard looks for kubectl in command position only (start of a line, after a pipe or `&&`, under `sudo`/`watch`/`KUBECONFIG=... kubectl`, in `$(...)`, by full path); a mention inside a string, a file name, `which kubectl` or `brew info kubectl` is left alone. When k9s is not running (never opened, `/k9s stop`, idle stop) kubectl works as usual.

## Settings (`/config`, or `pluginConfigs.k9s.options` in `~/.claude/settings.json`)

- `command` (default `k9s`), `args` (extra arguments as typed in a shell), `tmux` (path to tmux), `pollMs` (refresh interval, default 250), `autoOpen` (start and open at session start), `idleMinutes` (idle stop, default 15).

Requires `tmux` and `k9s` on PATH.
