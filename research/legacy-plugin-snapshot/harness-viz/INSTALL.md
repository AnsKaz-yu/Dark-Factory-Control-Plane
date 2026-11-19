# Установка opencode-harness-viz

Плагин визуализации harness проекта: интерактивный HTML с loop разработки, всеми гейтами
качества, инструментами и точками контроля (детерминированными и человеческими).

## 1. Требования

| Компонент | Условие |
|---|---|
| OpenCode | 2.x с поддержкой `plugins` |
| Node/Bun | для генератора (среда OpenCode предоставляет SDK) |
| harness-model.json | модель harness в проекте (например `ReservoirOS-harness/harness-model.json`) |

## 2. Установка

Плагин — локальный каталог. Два варианта:

**A. Глобальный авто-загрузочный каталог** (рекомендуется):
```
~/.config/opencode/plugins/harness-viz/
  package.json
  index.ts
  generate-viz.mjs
```
OpenCode автоматически загружает плагины из этого каталога. Перезапуск не требуется
(конфигурация и плагины перезагружаются на лету; при необходимости `/reload`).

**B. Явная регистрация** в `opencode.json(c)` (сохраняя существующие настройки):
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/<user>/.config/opencode/plugins/harness-viz"
    // или путь к копии в репозитории: ".../ReservoirOS-harness/plugin/harness-viz"
  ]
}
```

## 3. Модель harness

Плагин читает `harness-model.json` (поиск: `modelPath` опция/аргумент → корень проекта →
`ReservoirOS-harness/harness-model.json` → sibling). Модель описывает: `loop`, `gates`,
`humanControls`, `tools`, `metrics`, `repos`, `principles`. Пример — в репозитории
`ReservoirOS-harness/harness-model.json`.

## 4. Использование

- **Команда**: `/harness-viz` — генерирует HTML и открывает в Review pane.
- **Инструмент**: `harness_visualize` (Code Mode: `tools.harness.visualize({ modelPath?, outPath? })`).
- **Standalone** (без OpenCode): `node generate-viz.mjs <harness-model.json> <out.html>`.

Результат по умолчанию: `<modelDir>/reports/harness-viz.html` (self-contained, без внешних
зависимостей; интерактив: клик по шагу loop подсвечивает связанный гейт).

## 5. Проверка

1. `opencode plugin list` показывает `harness-viz` (или инструмент `harness_visualize` в Code Mode).
2. `/harness-viz` генерирует HTML.
3. Откройте HTML — видны loop, гейты G1–G6, точки контроля, инструменты, метрики.

## 6. Состав

- `index.ts` — серверная часть: `Plugin.define`, инструмент `harness_visualize` + команда `/harness-viz`.
- `generate-viz.mjs` — генератор HTML (чистая функция `generateVizHtml(model)` + CLI).
- `package.json` — name/exports/зависимость `@opencode/plugin`.

Источник: плагин создан для визуализации harness ReservoirOS
(https://github.com/AnsKaz-yu/ReservoirOS-harness).