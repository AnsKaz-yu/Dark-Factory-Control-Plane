# Installing the DFCP OpenCode plugin

## 1. Start the Core Product

```bash
node packages/cli/src/serve.ts --port 8095 --data ~/.dfcp
# or: factory start
```

The core is independent of OpenCode; it can run before or after the plugin loads
(the plugin retries the connection every 15 s).

## 2. Register the plugin

Option A — config entry (recommended):

```jsonc
// opencode.json(c) in the target project or globally
{
  "plugins": [
    { "package": "/absolute/path/to/dark-factory-control-plane/packages/plugin",
      "options": { "coreUrl": "http://127.0.0.1:8095" } }
  ]
}
```

Option B — local discovery: copy or symlink `packages/plugin` into
`<project>/.opencode/plugins/dark-factory/` (or the global
`~/.config/opencode/plugins/dark-factory/`).

OpenCode loads the plugin's `src/index.ts` via its `exports["."]`.

## 3. Setup the project

In OpenCode: `/factory-setup` (command) or `factory_setup` (tool). This will:
1. register the project with the core;
2. run read-only harness discovery;
3. probe adapters and build the Capability Manifest;
4. generate project-specific adapters for custom sources (contract-tested);
5. sync data;
6. install the agent/skill kit into `.opencode/agent` and `.opencode/skills`
   (existing files are never overwritten; everything is tracked in
   `.dark-factory/generated/opencode-kit-manifest.json`).

Alternatively, without OpenCode: `factory setup --root <project-dir>`.

## 4. Verify

- `factory_doctor` → healthy checks;
- `factory_dashboard` → open the URL; only verified sections are shown;
- work in a session → agents appear with `working` status; stop → `waiting`/`unknown`
  (never auto-`completed`).

## 5. Uninstall

- remove the plugin entry / directory;
- `factory uninstall --root <project-dir> --yes` removes ONLY `.dark-factory/`
  (tracked files); kit files are listed in the kit manifest for manual removal.

No harness file is ever modified by installation.
