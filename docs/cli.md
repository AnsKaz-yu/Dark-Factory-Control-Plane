# factory CLI Documentation

`factory` is a thin interface to the Core Product over HTTP. It auto-starts the core in the
background when a command needs it (pid file in the data dir).

Run: `npm run factory -- <command> [flags]` or `node packages/cli/src/main.ts <command>`.

Global flags: `--url URL` (core API, default `http://127.0.0.1:8095` / `DFCP_URL`),
`--data DIR` (core data dir, default `~/.dfcp` / `DFCP_DATA`).

## Lifecycle

| Command | Description |
|---|---|
| `start [--port] [--data] [--host]` | run the core in the foreground (Core + Integration Layer) |
| `stop` | stop the background core via pid file |
| `status` | core health + registered projects |

## Integration

| Command | Description |
|---|---|
| `setup --root DIR [--name N] [--id ID]` | register + discover + verify + sync; prints Capability Manifest |
| `discover --project ID` | re-run read-only discovery + capability verification |
| `sync --project ID` | collect from all adapters (failure-isolated) |
| `doctor --project ID` | integration health checks + recommendations |
| `reconcile --project ID [--approve t1,t2]` | drift reconciliation; C actions need approve targets |
| `diff --project ID` | harness drift diff + action plan (no apply) |
| `adapter:status --project ID` | versions, compatibility, sync state, history |
| `adapter:update --project ID --adapter ID` | contract-tested adapter update |
| `adapter:rollback --project ID --adapter ID` | restore previous adapter version |
| `adapter:generate --project ID --spec spec.json` | generate + contract-test + activate a custom adapter |
| `uninstall --root DIR --yes` | remove only `.dark-factory/` tracked files |

`spec.json` example:
```json
{ "name": "crew-registry", "kind": "agent-registry", "path": "crew-state.json",
  "fields": { "status": "status", "task": "task", "lastSeen": "lastSeen" },
  "statusMap": { "running": "working", "idle": "waiting" } }
```

## Work management

| Command | Description |
|---|---|
| `task:list --project ID [--status S] [--q TEXT]` | filtered task list |
| `task:create --project ID --id T1 --title "..." [--kind] [--deps a,b] [--parent] [--estimate N] [--priority] [--component]` | create task |
| `task:get --project ID --id T1` | task card + dependents + sessions |
| `task:update --project ID --id T1 [--status] [--progress] [--assignee] [--deps] ...` | update fields/status |
| `task:claim --project ID --id T1 --agent A` | atomic claim (409 on conflict/blocked) |
| `task:release --project ID --id T1` | release claim |
| `release:create --project ID --id r1 --name v1 [--scope T1,T2]` | create release |
| `release:get --project ID --id r1` | release + readiness + critical path |

## Observability

| Command | Description |
|---|---|
| `dashboard --project ID` | print dashboard URL |
| `overview --project ID` | overview JSON (counts, alerts, freshness) |
| `events --project ID [--after N] [--limit N]` | event log tail |

## Exit codes

0 success; 1 error (message on stderr). HTTP errors from the core are surfaced with status
and body. The CLI never writes into target projects except through the core's confined
integration layer.
