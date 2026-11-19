# Установка opencode-reservoiros-dashboard

Живой дашборд стадии реализации ReservoirOS: drill-down архитектура, граф задач, CRAP,
покрытие тестами, real-time обновление при параллельной работе агентов.

## 1. Требования

| Компонент | Условие |
|---|---|
| OpenCode | 2.x с поддержкой `plugins` |
| Проект | ReservoirOS (рядом с harness) |
| Порт | 8091 (дашборд); 8080/8090 заняты эталонным сервером/Jenkins |

## 2. Установка

Локальный каталог плагина:
```
~/.config/opencode/plugins/reservoiros-dashboard/
  package.json
  index.ts          # сервер: инструменты, команда, HTTP+SSE, file-watch
  dashboard.html    # SPA-клиент
  seed.json         # начальная модель (архитектура + задачи)
```
OpenCode авто-загружает плагины из этого каталога. Либо явная регистрация в `opencode.json`:
```jsonc
{ "plugins": ["C:/Users/<user>/.config/opencode/plugins/reservoiros-dashboard"] }
```

## 3. Пред-настройки проекта (выполняются автоматически / вручную)

1. **Runtime-состояние** `ReservoirOS/project-state.json` — создаётся плагином из `seed.json`
   при первом открытии. Добавлен в `.gitignore` (живое состояние, не коммитится).
2. **Соглашение для агентов**: по ходу работы агент вызывает инструменты плагина:
   - `project_agent_heartbeat` — отметка активности (какую задачу делает);
   - `project_task_update` — статус/стадия loop/прогресс задачи;
   - `project_report_tests` — покрытие + passed/failed после прогона тестов;
   - `project_report_crap` — CRAP после замера;
   - `project_component_update` — готовность/статус компонента.
   Это обеспечивает real-time обновление дашборда для всех параллельных агентов.
3. **Порт 8091** свободен (дашборд). Сервер стартует при `project_dashboard_open` / `/reservoiros-dashboard`.

## 4. Использование

- **Команда**: `/reservoiros-dashboard` — запускает сервер и открывает дашборд.
- **Инструмент**: `project_dashboard_open` → URL `http://127.0.0.1:8091/`.
- Откройте URL в браузере. Дашборд обновляется в реальном времени (SSE).

## 5. Возможности

1. Общая архитектура: статус (planned/in-progress/done/blocked), готовность %, CRAP.
2. Drill-down: клик по модулю → внутренняя схема + документация (рекурсивно по дереву).
3. CRAP на каждом уровне (бейдж + по-функционная таблица).
4. Граф задач (DAG): заблокированные/ожидающие утверждения/готовые/реализуемые; клик по
   задаче → документация + стадия loop разработки (степпер).
5. Покрытие тестами + проходимость (passed/failed) на каждом уровне.
6. Real-time: SSE + file-watch; параллельные агенты обновляют общее состояние (атомарные
   мутации), дашборд обновляется у всех.

## 6. Проверка

1. `project_dashboard_open` → URL.
2. Откройте URL — видны дерево, граф задач, CRAP, покрытие, live-индикатор.
3. `project_task_update` / `project_report_tests` → дашборд обновляется без перезагрузки.

Источник: плагин для ReservoirOS (https://github.com/AnsKaz-yu/ReservoirOS-harness).