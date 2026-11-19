# opencode-reservoiros-dashboard

OpenCode-плагин: **живой дашборд стадии реализации ReservoirOS**.

## Возможности

1. **Общая архитектура** — статус модулей (planned/in-progress/done/blocked), готовность %,
   CRAP; готовность пересчитывается вверх по дереву.
2. **Drill-down** — клик по модулю/ядру → внутренняя схема + краткая документация; рекурсивно
   по всему дереву (подмодули).
3. **CRAP на каждом уровне** — бейдж (порог 30 / цель 15) + по-функционная таблица.
4. **Граф задач (DAG)** — заблокированные / ожидающие утверждения / готовые / реализуемые;
   зависимости; клик по задаче → документация + стадия loop разработки (степпер).
5. **Покрытие тестами + проходимость** — coverage %, passed/failed/total на каждом уровне.
6. **Real-time** — HTTP + SSE + file-watch; параллельные агенты обновляют общее состояние
   (атомарные мутации), дашборд обновляется у всех без перезагрузки.

## Архитектура плагина

- `index.ts` — серверная часть (OpenCode V2): инструменты `project_*`, команда
  `/reservoiros-dashboard`, HTTP-сервер (порт 8091: `/`, `/state`, `/events` SSE),
  file-watch состояния, сериализованные мутации (multi-agent safe).
- `dashboard.html` — SPA-клиент (vanilla JS, self-contained): дерево, drill-down, SVG-графы
  (архитектура + задачи), CRAP, покрытие, модалка задачи, SSE.
- `seed.json` — начальная модель (архитектура из C4 + граф задач из roadmap).

## Источник данных

`ReservoirOS/project-state.json` (runtime, gitignore) — живое состояние. Инициализируется
из `seed.json`. Агенты обновляют его инструментами `project_*` по ходу работы.

## Инструменты

| Инструмент | Назначение |
|---|---|
| `project_dashboard_open` | запустить сервер + URL |
| `project_component_update` | статус/готовность/doc/CRAP/покрытие компонента |
| `project_task_create` / `project_task_update` | задачи: статус/loop/прогресс/зависимости |
| `project_report_tests` | покрытие + passed/failed |
| `project_report_crap` | CRAP (worst + по функциям) |
| `project_agent_heartbeat` | активность агента (multi-agent view) |

Установка: [INSTALL.md](INSTALL.md). Предложения по развитию: `ReservoirOS-harness/dashboard/SUGGESTIONS.md`.