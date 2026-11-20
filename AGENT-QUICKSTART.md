# Agent Quick Start — deploy DFCP into your project

Paste the prompt below into any coding agent running **in the project you want to connect**.
The agent needs only this repository's public documentation; everything else it discovers
from the target project itself.

Requirements on the machine: Node.js ≥ 22.18, git. OpenCode optional.

## Prompt (English)

```text
Deploy Dark Factory Control Plane (DFCP) into THIS project.
1. Clone https://github.com/AnsKaz-yu/Dark-Factory-Control-Plane.git into a sibling directory
   (e.g. ../dark-factory-control-plane). Never clone inside this repo's tracked tree.
2. Read its README.md "Quick start" and packages/plugin/INSTALL.md.
   Ensure Node >= 22.18 and git are available.
3. Start the core: node <clone>/packages/cli/src/serve.ts --port 8095
   (if http://127.0.0.1:8095/api/health is already healthy, reuse that core).
4. Install the plugin into THIS project: copy <clone>/packages/plugin to
   .opencode/plugins/dark-factory/ (additive only; do NOT edit opencode.json or any tracked file).
5. Run: node <clone>/packages/cli/src/main.ts setup --root .
   Discovery is read-only; writes go only to .dark-factory/ and .opencode kit additions.
6. Verify: node <clone>/packages/cli/src/main.ts doctor --project <id>, then open
   http://127.0.0.1:8095/#/<id>. Report the capability matrix and limitations honestly.
Constraints: no git commits/branch changes in this repo; do not execute this repo's scripts;
no npm install here. Uninstall later: factory uninstall --root . --yes (tracked files only).
```

## Промт (русский)

```text
Разверни Dark Factory Control Plane (DFCP) в ЭТОМ проекте.
1. Клонируй https://github.com/AnsKaz-yu/Dark-Factory-Control-Plane.git в соседний каталог
   (например ../dark-factory-control-plane). Не клонируй внутрь отслеживаемого дерева этого репо.
2. Прочитай его README.md «Quick start» и packages/plugin/INSTALL.md.
   Убедись, что доступны Node >= 22.18 и git.
3. Запусти ядро: node <clone>/packages/cli/src/serve.ts --port 8095
   (если http://127.0.0.1:8095/api/health уже healthy — используй это ядро).
4. Установи плагин в ЭТОТ проект: скопируй <clone>/packages/plugin в
   .opencode/plugins/dark-factory/ (только аддитивно; НЕ правь opencode.json и отслеживаемые файлы).
5. Выполни: node <clone>/packages/cli/src/main.ts setup --root .
   Discovery read-only; записи только в .dark-factory/ и kit-добавления .opencode.
6. Проверь: node <clone>/packages/cli/src/main.ts doctor --project <id>, затем открой
   http://127.0.0.1:8095/#/<id>. Честно отчитайся о матрице возможностей и ограничениях.
Ограничения: без git-коммитов/смены веток в этом репо; не исполняй скрипты этого репо;
без npm install здесь. Удаление позже: factory uninstall --root . --yes (только tracked-файлы).
```

## What the agent should report back

- Capability matrix (status + adapter + limitations per capability).
- Which dashboard sections are visible/hidden and why.
- `factory doctor` output; any friction encountered (doc gaps, errors).
- List of files created in the target (`.dark-factory/`, `.opencode` additions) and
  confirmation that no tracked file was modified.

## Notes

- The plugin activates when an OpenCode server loads it from `.opencode/plugins/`; a running
  server may need a restart to pick up a refreshed copy (documented in plugin INSTALL.md).
- One root = one project: the core dedups registrations by root path; older plugin ids keep
  working through aliases after merges.
- Everything the product writes into the target is tracked in
  `.dark-factory/generated/install-manifest.json` and removable with `factory uninstall`.
