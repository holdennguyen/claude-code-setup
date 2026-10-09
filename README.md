# claude-code-setup

My Claude Code setup as a plugin marketplace: mods (plugins with a hooks module that runs inside Claude Code) and, over time, the skills and settings that go with them. Install what you want from here and keep receiving updates.

## Plugins

| Plugin | What it does | Needs |
| :- | :- | :- |
| [k9s](plugins/k9s) | A live, interactive [k9s](https://k9scli.io/) terminal in a pane, two tools so the model can read and drive it, and a guard that routes the model to those tools instead of kubectl while the pane is open. | `tmux`, `k9s` on PATH; Claude Code 2.1.295 or later |

## Install

Add the marketplace once, then install plugins by name:

```sh
claude plugin marketplace add holdennguyen/claude-code-setup
claude plugin install k9s@claude-code-setup
```

Or, inside a session, in one step:

```
/plugin install k9s --marketplace holdennguyen/claude-code-setup
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one). If a session was already open, run `/reload-plugins` in it.

### For a team

To give every member of a repository the same setup, add this to the repository's `.claude/settings.json`. Claude Code offers to install the marketplace and the plugins the first time each person opens the repository.

```json
{
  "extraKnownMarketplaces": {
    "claude-code-setup": {
      "source": { "source": "github", "repo": "holdennguyen/claude-code-setup" }
    }
  },
  "enabledPlugins": {
    "k9s@claude-code-setup": true
  }
}
```

## Before you install a mod

A mod runs inside Claude Code with your permissions. Before installing one, list what it hooks and what it asks Claude Code to do, without running it:

```sh
git clone https://github.com/holdennguyen/claude-code-setup
claude plugin validate claude-code-setup/plugins/k9s
```

The `hooks:` and `calls:` lines are the whole reach of the mod. Each plugin's README repeats them under "What it reaches".

## Update

```sh
claude plugin update k9s@claude-code-setup
```

Each plugin's `version` in its `plugin.json` is bumped on every release, so an update only lands when there is one.

## Development

```sh
claude plugin validate --strict .                 # the marketplace file
claude plugin validate --strict ./plugins/k9s     # one plugin
claude plugin test ./plugins/k9s                  # its tests, run against the engine
claude --plugin-dir ./plugins/k9s                 # try it in a session without installing
```

`.claude-plugin/types/` inside each plugin is written by Claude Code on every load and is gitignored.

## License

[MIT](LICENSE)
