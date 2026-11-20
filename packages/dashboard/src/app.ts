// DFCP Dashboard — single-codebase capability-driven SPA (vanilla TS, zero dependencies).
// i18n: EN/RU (Settings selector, persisted per browser). All domain data comes from the
// Core API; the UI never recomputes business logic.

type Json = Record<string, any>

const $ = (id: string): HTMLElement => document.getElementById(id)!
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))

// ---------------- i18n ----------------
type Lang = "en" | "ru"
const urlLang = new URLSearchParams(location.search).get("lang")
let LANG: Lang = (urlLang === "ru" || urlLang === "en") ? urlLang : ((localStorage.getItem("dfcp-lang") as Lang) || "en")
if (LANG !== "ru") LANG = "en"
// capture mode: quiescent page for deterministic documentation screenshots (no SSE)
const CAPTURE = new URLSearchParams(location.search).has("capture")

const DICT: Record<Lang, Record<string, string>> = {
  en: {
    "nav.overview": "Overview", "nav.tasks": "Tasks", "nav.task-tree": "Task Tree", "nav.agents": "Agents",
    "nav.workflow": "Workflow", "nav.pipelines": "CI/CD Pipelines", "nav.merge-queue": "Merge Queue",
    "nav.critical-path": "Critical Path", "nav.releases": "Releases", "nav.components": "Components",
    "nav.metrics": "Metrics", "nav.activity": "Activity", "nav.integrations": "Integrations", "nav.settings": "Settings",
    "h.data": "data", "h.refresh": "⟳ Refresh", "h.sync": "Sync", "h.syncing": "Syncing…", "h.core": "core",
    "h.connecting": "connecting…", "h.live": "live", "h.reconnecting": "reconnecting…", "h.polling": "polling",
    "c.loading": "Loading…", "c.error": "Error", "c.unknownSection": "Unknown section", "c.close": "✕",
    "c.save": "Save", "c.create": "Create", "c.edit": "Edit", "c.back": "← Back",
    "c.allStatuses": "all statuses", "c.allKinds": "all kinds", "c.allPriorities": "all priorities",
    "c.search": "search id / title…", "c.newTask": "+ New task", "c.newRelease": "+ New release",
    "c.partial": "◐ Partial support", "c.notAvailable": "⊘ Not available for this project",
    "c.notAvailableText": "This section requires a verified capability that the project's harness does not currently provide.",
    "c.seeIntegrations": "See Integrations for the capability matrix and how to connect a source.",
    "c.source": "Source", "c.fetched": "fetched", "c.authoritative": "authoritative", "c.auxiliary": "auxiliary",
    "c.confidence": "confidence", "c.mapping": "Mapping", "c.ruleSet": "rule set", "c.version": "v",
    "c.status": "Status", "c.kind": "Kind", "c.priority": "Priority", "c.assignee": "Assignee",
    "c.component": "Component", "c.progress": "Progress", "c.estimate": "estimate", "c.updated": "Updated",
    "c.deps": "Deps", "c.blocks": "Blocks", "c.dependsOn": "Depends on", "c.acceptance": "Acceptance criteria",
    "c.noAc": "No acceptance criteria.", "c.links": "Links", "c.description": "Description",
    "c.history": "History", "c.noHistory": "No history.", "c.actions": "Actions", "c.claim": "Claim",
    "c.release": "Release", "c.setStatus": "Set status", "c.agentPrompt": "Agent name:",
    "c.id": "ID", "c.title": "Title", "c.parentId": "Parent ID", "c.depsCsv": "Dependencies (csv)",
    "c.estimateHours": "Estimate hours", "c.name": "Name", "c.tag": "Tag", "c.scope": "Scope",
    "c.scopeCsv": "Scope task IDs (csv)", "c.target": "Target", "c.verdict": "Verdict", "c.blockers": "Blockers",
    "c.checks": "Readiness checks", "c.check": "Check", "c.result": "Result", "c.evidence": "Evidence",
    "c.assessed": "Assessed", "c.task": "Task", "c.pos": "Pos", "c.branch": "Branch", "c.agent": "Agent",
    "c.state": "State", "c.wait": "Wait", "c.reason": "Reason", "c.queueEmpty": "Queue is empty.",
    "c.noQueue": "⊘ No merge queue source", "c.noQueueText": "The project has no verified merge queue integration.",
    "c.independentStates": "Task, Pipeline and Merge are independent states — this project simply has no queue mechanism connected.",
    "c.from": "From", "c.to": "To", "c.count": "Count", "c.last": "Last", "c.noTransitions": "No transitions recorded yet.",
    "c.observableStages": "Observable stages", "c.observed": "observed", "c.notObserved": "not observed",
    "c.runs": "Runs", "c.pipeline": "Pipeline", "c.duration": "Duration", "c.started": "Started",
    "c.finished": "Finished", "c.trigger": "Trigger", "c.retries": "Retries", "c.artifacts": "Artifacts",
    "c.noRuns": "No pipeline runs observed.", "c.noStages": "No stage data (provider may not expose stages).",
    "c.backRuns": "← Runs", "c.backRel": "← Releases", "c.stages": "Stages",
    "c.cpComputed": "Longest path by duration estimates", "c.cpEstimated": "Structural longest path — duration estimates incomplete; this is NOT a time forecast.",
    "c.cpMissing": "No open tasks to schedule.", "c.path": "Path", "c.cycles": "Dependency cycles",
    "c.gantt": "Gantt — schedule to release", "c.ganttAll": "All open tasks", "c.ganttRelease": "Release scope",
    "c.ganttProjected": "Projected finish", "c.ganttTarget": "Release target", "c.ganttLate": "Projected finish is {h} working hours AFTER the release target.",
    "c.ganttOnTime": "Projected finish is on or before the release target.",
    "c.ganttWhpd": "{h} working hours/day", "c.ganttLegendCritical": "critical path", "c.ganttLegendEstimated": "estimated duration (placeholder)",
    "c.ganttLegendNormal": "scheduled task", "c.ganttDay": "day", "c.ganttNoTasks": "No open tasks to schedule.",
    "c.repoActivity": "Repository activity", "c.repoActivitySub": "commits & events per day (last {n} days)",
    "c.commits": "commits", "c.events": "events", "c.noCommits": "no commits observed",
    "c.metricsNote": "Computed only from verified data. Null = insufficient data (never fabricated). Snapshot",
    "c.alerts": "Alerts & blockers", "c.noAlerts": "No alerts.", "c.freshness": "Source freshness",
    "c.recentActivity": "Recent activity", "c.tasksKpi": "Tasks", "c.agentsKpi": "Agents", "c.working": "working",
    "c.unknownAgents": "unknown", "c.lastPipeline": "Last pipeline", "c.queueKpi": "Merge queue", "c.idle": "idle",
    "c.mergeInFlight": "merge in flight", "c.releaseKpi": "Release", "c.readiness": "readiness",
    "c.cpKpi": "Critical path", "c.structural": "structural", "c.done": "done", "c.inProgress": "in progress",
    "c.blocked": "blocked", "c.noAgents": "No agents registered. Connect the OpenCode plugin or a harness agent source.",
    "c.noHeartbeat": "⚠ no heartbeat", "c.noHeartbeatTitle": "no recent heartbeat — absence of heartbeat is NOT proof of completion",
    "c.evidenceCol": "Evidence", "c.session": "Session", "c.model": "Model", "c.lastEvent": "Last event",
    "c.errors": "Errors", "c.sessions": "Sessions", "c.noSessions": "No sessions.", "c.noErrors": "No errors.",
    "c.recentEvents": "Recent events", "c.role": "Role", "c.currentTask": "Current task", "c.lastHeartbeat": "Last heartbeat",
    "c.noComponents": "No components reported.", "c.archMap": "Architecture map", "c.tasksCount": "tasks",
    "c.filterType": "filter by type prefix (e.g. task.)", "c.eventsCount": "events", "c.logSeq": "log seq",
    "c.time": "Time", "c.event": "Event", "c.detail": "Detail", "c.noEvents": "No events yet.",
    "c.discoveredHarness": "Discovered harness", "c.adapters": "Adapters", "c.adapter": "Adapter",
    "c.capabilities": "Capabilities", "c.syncState": "Sync", "c.lastSuccess": "Last success",
    "c.capMatrix": "Capability matrix", "c.capability": "Capability", "c.lastSync": "Last sync",
    "c.limitations": "Limitations", "c.doctorChecks": "Doctor checks", "c.recommendations": "Recommendations",
    "c.lastReconciliation": "Last reconciliation", "c.driftChanges": "drift changes", "c.manifestUpdated": "manifest updated",
    "c.verified": "verified", "c.applied": "applied", "c.needsApproval": "needs approval", "c.pending": "pending",
    "c.discover": "Discover", "c.reconcile": "Reconcile", "c.integrationDiff": "Integration diff",
    "c.doctor": "doctor", "c.healthy": "healthy", "c.issuesFound": "issues found", "c.notDiscovered": "not discovered yet",
    "c.project": "Project", "c.registered": "Registered", "c.plugin": "Plugin", "c.notConnected": "not connected",
    "c.dashboardConfig": "Dashboard configuration (computed from Capability Manifest)",
    "c.configNote": "Project integration config lives in <project>/.dark-factory/config/project.json (adapters, permissions, authoritative sources). Edit it there or via the Setup Agent; changes are tracked and reversible.",
    "c.language": "Language", "c.languageNote": "UI language is a browser-local preference (stored in this browser). Domain values (statuses, IDs) keep their canonical form; labels are translated.",
    "c.langEn": "English", "c.langRu": "Русский", "c.noProjects": "No projects registered yet.",
    "c.connectHint": "Connect a project: factory setup --root <project-dir> or install the OpenCode plugin and run /factory-setup.",
    "c.workflowNote": "Stages and transitions observed from the harness — not an imposed canonical pipeline.",
    "c.queueNote": "FIFO order", "c.synced": "synced", "c.treeNote": "Hierarchy (epic → feature → task → subtask). Dependency graph is separate — see Critical Path.",
    "c.noTasksMatch": "No tasks match.", "c.noTasks": "No tasks.", "c.noReleases": "No releases planned.",
    "c.newTaskTitle": "New task", "c.editTask": "Edit", "c.newReleaseTitle": "New release",
    "c.scopeTasks": "tasks", "c.open": "open", "c.dagNote": "Red = critical path · click a node to open the task · gray edges = non-critical dependencies",
    "c.stale": "stale", "c.degraded": "degraded", "c.ok": "ok", "c.never": "never",
    "c.metric.throughput_7d": "Throughput (7d)", "c.metric.lead_time_hours_avg": "Lead time avg (h)",
    "c.metric.wip": "WIP", "c.metric.blocked": "Blocked", "c.metric.tasks_total": "Tasks total",
    "c.metric.agents_working": "Agents working", "c.metric.agents_total": "Agents total",
    "c.metric.pipeline_success_rate": "Pipeline success (%)", "c.metric.queue_wait_avg_min": "Queue wait avg (min)",
    "c.metric.queue_depth": "Queue depth",
    "st.backlog": "backlog", "st.planning": "planning", "st.ready": "ready", "st.in_progress": "in progress",
    "st.review": "review", "st.verification": "verification", "st.blocked": "blocked", "st.merged": "merged",
    "st.done": "done", "st.cancelled": "cancelled", "st.unknown": "unknown",
    "st.working": "working", "st.waiting": "waiting", "st.reviewing": "reviewing", "st.completed": "completed",
    "st.failed": "failed", "st.stopped": "stopped", "st.pending": "pending", "st.running": "running",
    "st.success": "success", "st.checking": "checking", "st.merging": "merging", "st.conflict": "conflict",
    "st.dead_letter": "dead letter", "st.supported": "supported", "st.partial": "partial",
    "st.not_configured": "not configured", "st.unavailable": "unavailable", "st.stale": "stale",
    "st.degraded": "degraded", "st.open": "open", "st.closed": "closed", "st.released": "released",
    "st.not_ready": "not ready", "st.insufficient_data": "insufficient data", "st.never": "never",
    "st.exact": "exact", "st.high": "high", "st.medium": "medium", "st.low": "low", "st.unmapped": "unmapped",
    "st.planning_r": "planning", "st.in_progress_r": "in progress", "st.ready_r": "ready",
  },
  ru: {
    "nav.overview": "Обзор", "nav.tasks": "Задачи", "nav.task-tree": "Дерево задач", "nav.agents": "Агенты",
    "nav.workflow": "Workflow", "nav.pipelines": "CI/CD пайплайны", "nav.merge-queue": "Очередь слияния",
    "nav.critical-path": "Критический путь", "nav.releases": "Релизы", "nav.components": "Компоненты",
    "nav.metrics": "Метрики", "nav.activity": "Активность", "nav.integrations": "Интеграции", "nav.settings": "Настройки",
    "h.data": "данные", "h.refresh": "⟳ Обновить", "h.sync": "Синхр.", "h.syncing": "Синхронизация…", "h.core": "ядро",
    "h.connecting": "подключение…", "h.live": "live", "h.reconnecting": "переподключение…", "h.polling": "опрос",
    "c.loading": "Загрузка…", "c.error": "Ошибка", "c.unknownSection": "Неизвестный раздел", "c.close": "✕",
    "c.save": "Сохранить", "c.create": "Создать", "c.edit": "Изменить", "c.back": "← Назад",
    "c.allStatuses": "все статусы", "c.allKinds": "все типы", "c.allPriorities": "все приоритеты",
    "c.search": "поиск id / название…", "c.newTask": "+ Новая задача", "c.newRelease": "+ Новый релиз",
    "c.partial": "◐ Частичная поддержка", "c.notAvailable": "⊘ Недоступно для этого проекта",
    "c.notAvailableText": "Раздел требует подтверждённой возможности, которую harness проекта сейчас не предоставляет.",
    "c.seeIntegrations": "См. Интеграции: матрица возможностей и способы подключения источника.",
    "c.source": "Источник", "c.fetched": "получено", "c.authoritative": "authoritative", "c.auxiliary": "вспомогательный",
    "c.confidence": "уверенность", "c.mapping": "Маппинг", "c.ruleSet": "набор правил", "c.version": "v",
    "c.status": "Статус", "c.kind": "Тип", "c.priority": "Приоритет", "c.assignee": "Исполнитель",
    "c.component": "Компонент", "c.progress": "Прогресс", "c.estimate": "оценка", "c.updated": "Обновлено",
    "c.deps": "Зависимости", "c.blocks": "Блокирует", "c.dependsOn": "Зависит от", "c.acceptance": "Критерии приёмки",
    "c.noAc": "Критериев приёмки нет.", "c.links": "Связи", "c.description": "Описание",
    "c.history": "История", "c.noHistory": "Истории нет.", "c.actions": "Действия", "c.claim": "Взять",
    "c.release": "Освободить", "c.setStatus": "Установить статус", "c.agentPrompt": "Имя агента:",
    "c.id": "ID", "c.title": "Название", "c.parentId": "ID родителя", "c.depsCsv": "Зависимости (csv)",
    "c.estimateHours": "Оценка, часов", "c.name": "Название", "c.tag": "Тег", "c.scope": "Объём",
    "c.scopeCsv": "ID задач объёма (csv)", "c.target": "Цель", "c.verdict": "Вердикт", "c.blockers": "Блокеры",
    "c.checks": "Проверки готовности", "c.check": "Проверка", "c.result": "Результат", "c.evidence": "Доказательство",
    "c.assessed": "Оценено", "c.task": "Задача", "c.pos": "Поз", "c.branch": "Ветка", "c.agent": "Агент",
    "c.state": "Состояние", "c.wait": "Ожидание", "c.reason": "Причина", "c.queueEmpty": "Очередь пуста.",
    "c.noQueue": "⊘ Нет источника очереди слияния", "c.noQueueText": "У проекта нет подтверждённой интеграции очереди слияния.",
    "c.independentStates": "Задача, пайплайн и слияние — независимые состояния; у проекта просто не подключён механизм очереди.",
    "c.from": "Из", "c.to": "В", "c.count": "Кол-во", "c.last": "Последний", "c.noTransitions": "Переходов пока не зафиксировано.",
    "c.observableStages": "Наблюдаемые стадии", "c.observed": "наблюдается", "c.notObserved": "не наблюдается",
    "c.runs": "Прогоны", "c.pipeline": "Пайплайн", "c.duration": "Длительность", "c.started": "Начат",
    "c.finished": "Завершён", "c.trigger": "Триггер", "c.retries": "Повторы", "c.artifacts": "Артефакты",
    "c.noRuns": "Прогонов пайплайнов не наблюдалось.", "c.noStages": "Нет данных о стадиях (провайдер может не отдавать стадии).",
    "c.backRuns": "← Прогоны", "c.backRel": "← Релизы", "c.stages": "Стадии",
    "c.cpComputed": "Длиннейший путь по оценкам длительности", "c.cpEstimated": "Структурный длиннейший путь — оценки длительности неполные; это НЕ прогноз по времени.",
    "c.cpMissing": "Нет открытых задач для планирования.", "c.path": "Путь", "c.cycles": "Циклы зависимостей",
    "c.gantt": "Гант — план до релиза", "c.ganttAll": "Все открытые задачи", "c.ganttRelease": "Объём релиза",
    "c.ganttProjected": "Прогноз завершения", "c.ganttTarget": "Цель релиза", "c.ganttLate": "Прогноз завершения на {h} раб. часов ПОЗЖЕ целевой даты релиза.",
    "c.ganttOnTime": "Прогноз завершения не позже целевой даты релиза.",
    "c.ganttWhpd": "{h} раб. часов/день", "c.ganttLegendCritical": "критический путь", "c.ganttLegendEstimated": "оценочная длительность (placeholder)",
    "c.ganttLegendNormal": "запланированная задача", "c.ganttDay": "день", "c.ganttNoTasks": "Нет открытых задач для планирования.",
    "c.repoActivity": "Активность репозитория", "c.repoActivitySub": "коммиты и события по дням (последние {n} дней)",
    "c.commits": "коммиты", "c.events": "события", "c.noCommits": "коммитов не наблюдалось",
    "c.metricsNote": "Вычисляется только из подтверждённых данных. Null = недостаточно данных (без выдумок). Снимок",
    "c.alerts": "Алерты и блокеры", "c.noAlerts": "Алертов нет.", "c.freshness": "Свежесть источников",
    "c.recentActivity": "Последняя активность", "c.tasksKpi": "Задачи", "c.agentsKpi": "Агенты", "c.working": "в работе",
    "c.unknownAgents": "unknown", "c.lastPipeline": "Последний пайплайн", "c.queueKpi": "Очередь слияния", "c.idle": "простой",
    "c.mergeInFlight": "идёт слияние", "c.releaseKpi": "Релиз", "c.readiness": "готовность",
    "c.cpKpi": "Критический путь", "c.structural": "структурный", "c.done": "готово", "c.inProgress": "в работе",
    "c.blocked": "заблокировано", "c.noAgents": "Агенты не зарегистрированы. Подключите OpenCode-плагин или источник агентов harness.",
    "c.noHeartbeat": "⚠ нет heartbeat", "c.noHeartbeatTitle": "нет свежего heartbeat — отсутствие heartbeat НЕ доказательство завершения",
    "c.evidenceCol": "Доказательство", "c.session": "Сессия", "c.model": "Модель", "c.lastEvent": "Последнее событие",
    "c.errors": "Ошибки", "c.sessions": "Сессии", "c.noSessions": "Сессий нет.", "c.noErrors": "Ошибок нет.",
    "c.recentEvents": "Последние события", "c.role": "Роль", "c.currentTask": "Текущая задача", "c.lastHeartbeat": "Последний heartbeat",
    "c.noComponents": "Компоненты не переданы.", "c.archMap": "Карта архитектуры", "c.tasksCount": "задач",
    "c.filterType": "фильтр по префиксу типа (напр. task.)", "c.eventsCount": "событий", "c.logSeq": "seq лога",
    "c.time": "Время", "c.event": "Событие", "c.detail": "Детали", "c.noEvents": "Событий пока нет.",
    "c.discoveredHarness": "Обнаруженный harness", "c.adapters": "Адаптеры", "c.adapter": "Адаптер",
    "c.capabilities": "Возможности", "c.syncState": "Синхр.", "c.lastSuccess": "Последний успех",
    "c.capMatrix": "Матрица возможностей", "c.capability": "Возможность", "c.lastSync": "Последняя синхр.",
    "c.limitations": "Ограничения", "c.doctorChecks": "Проверки doctor", "c.recommendations": "Рекомендации",
    "c.lastReconciliation": "Последняя reconciliation", "c.driftChanges": "изменений drift", "c.manifestUpdated": "manifest обновлён",
    "c.verified": "проверено", "c.applied": "применено", "c.needsApproval": "нужно подтверждение", "c.pending": "ожидает",
    "c.discover": "Исследовать", "c.reconcile": "Reconcile", "c.integrationDiff": "Diff интеграции",
    "c.doctor": "doctor", "c.healthy": "здорово", "c.issuesFound": "есть проблемы", "c.notDiscovered": "ещё не исследовано",
    "c.project": "Проект", "c.registered": "Зарегистрирован", "c.plugin": "Плагин", "c.notConnected": "не подключён",
    "c.dashboardConfig": "Конфигурация дашборда (вычисляется из Capability Manifest)",
    "c.configNote": "Конфигурация интеграции проекта хранится в <project>/.dark-factory/config/project.json (адаптеры, права, authoritative-источники). Правьте там или через Setup Agent; изменения отслеживаются и обратимы.",
    "c.language": "Язык", "c.languageNote": "Язык интерфейса — локальная настройка браузера. Доменные значения (статусы, ID) сохраняют каноническую форму; переводятся подписи.",
    "c.langEn": "English", "c.langRu": "Русский", "c.noProjects": "Проекты ещё не зарегистрированы.",
    "c.connectHint": "Подключите проект: factory setup --root <каталог> или установите OpenCode-плагин и выполните /factory-setup.",
    "c.workflowNote": "Стадии и переходы, наблюдаемые из harness — не навязанный канонический pipeline.",
    "c.queueNote": "Порядок FIFO", "c.synced": "синхр.", "c.treeNote": "Иерархия (epic → feature → task → subtask). Граф зависимостей отдельно — см. Критический путь.",
    "c.noTasksMatch": "Нет задач по фильтру.", "c.noTasks": "Задач нет.", "c.noReleases": "Релизы не запланированы.",
    "c.newTaskTitle": "Новая задача", "c.editTask": "Изменить", "c.newReleaseTitle": "Новый релиз",
    "c.scopeTasks": "задач", "c.open": "открыто", "c.dagNote": "Красный = критический путь · клик по узлу открывает задачу · серые рёбра = некритические зависимости",
    "c.stale": "stale", "c.degraded": "degraded", "c.ok": "ok", "c.never": "никогда",
    "c.metric.throughput_7d": "Throughput (7д)", "c.metric.lead_time_hours_avg": "Lead time средн. (ч)",
    "c.metric.wip": "WIP", "c.metric.blocked": "Заблокировано", "c.metric.tasks_total": "Всего задач",
    "c.metric.agents_working": "Агентов в работе", "c.metric.agents_total": "Всего агентов",
    "c.metric.pipeline_success_rate": "Успех пайплайнов (%)", "c.metric.queue_wait_avg_min": "Ожидание очереди средн. (мин)",
    "c.metric.queue_depth": "Глубина очереди",
    "st.backlog": "бэклог", "st.planning": "планирование", "st.ready": "готова", "st.in_progress": "в работе",
    "st.review": "ревью", "st.verification": "верификация", "st.blocked": "заблокирована", "st.merged": "слита",
    "st.done": "готово", "st.cancelled": "отменена", "st.unknown": "unknown",
    "st.working": "работает", "st.waiting": "ожидает", "st.reviewing": "ревьюит", "st.completed": "завершён",
    "st.failed": "ошибка", "st.stopped": "остановлен", "st.pending": "ожидает", "st.running": "выполняется",
    "st.success": "успех", "st.checking": "проверки", "st.merging": "слияние", "st.conflict": "конфликт",
    "st.dead_letter": "dead letter", "st.supported": "поддерживается", "st.partial": "частично",
    "st.not_configured": "не настроено", "st.unavailable": "недоступно", "st.stale": "устарело",
    "st.degraded": "деградация", "st.open": "открыт", "st.closed": "закрыт", "st.released": "выпущен",
    "st.not_ready": "не готов", "st.insufficient_data": "недостаточно данных", "st.never": "никогда",
    "st.exact": "точно", "st.high": "высокая", "st.medium": "средняя", "st.low": "низкая", "st.unmapped": "не сопоставлен",
    "st.planning_r": "планирование", "st.in_progress_r": "в работе", "st.ready_r": "готов",
  },
}

function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICT[LANG][key] ?? DICT.en[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v))
  return s
}
const st = (s: string): string => t("st." + s)

/** Client-side translation of core-generated alert messages (known patterns only). */
function trAlert(msg: string): string {
  if (LANG === "en") return msg
  let m = /^adapter (\S+) stale \(last success (.+)\)$/.exec(msg)
  if (m) return `адаптер ${m[1]} устарел (последний успех ${m[2]})`
  m = /^adapter (\S+) degraded: (.*)$/.exec(msg)
  if (m) return `адаптер ${m[1]} деградировал: ${m[2]}`
  m = /^task (\S+) blocked \((.*)\)$/.exec(msg)
  if (m) return `задача ${m[1]} заблокирована (${m[2]})`
  m = /^merge queue (\S+): ([a-z_]+) — (.*)$/.exec(msg)
  if (m) return `очередь слияния ${m[1]}: ${st(m[2])} — ${m[3]}`
  m = /^merge queue (\S+): ([a-z_]+)$/.exec(msg)
  if (m) return `очередь слияния ${m[1]}: ${st(m[2])}`
  m = /^pipeline run (\S+) failed(.*)$/.exec(msg)
  if (m) return `прогон пайплайна ${m[1]} провален${m[2]}`
  m = /^event diagnostics: (\d+) unknown, (\d+) schema violations$/.exec(msg)
  if (m) return `диагностика событий: ${m[1]} неизвестных, ${m[2]} нарушений схемы`
  return msg
}

/** Client-side translation of core-generated critical-path notes (known patterns only). */
function trNote(msg: string): string {
  if (LANG === "en") return msg
  let m = /^Projected finish is (.+) working hours AFTER the release target date\.$/.exec(msg)
  if (m) return `Прогноз завершения на ${m[1]} раб. часов позже целевой даты релиза.`
  if (msg === "Blocked tasks included; their wait time is not estimated.") return "Заблокированные задачи учтены; время ожидания не оценивается."
  if (msg === "No open tasks in scope — nothing to schedule.") return "Нет открытых задач в объёме — нечего планировать."
  m = /^Duration estimates missing for some tasks: showing STRUCTURAL longest path \(by task count\), not a time forecast\.$/.exec(msg)
  if (m) return "Оценки длительности отсутствуют для части задач: показан СТРУКТУРНЫЙ длиннейший путь (по числу задач), не прогноз по времени."
  m = /^Gantt uses placeholder durations \((.+)h = mean of known estimates\) for tasks without estimates — marked as estimated\.$/.exec(msg)
  if (m) return `Гант использует placeholder-длительности (${m[1]}ч = среднее известных оценок) для задач без оценок — помечены как оценочные.`
  m = /^Dependency cycles detected \((\d+)\): path is approximate\.$/.exec(msg)
  if (m) return `Обнаружены циклы зависимостей (${m[1]}): путь приближённый.`
  return msg
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "#64748b", planning: "#f59e0b", ready: "#06b6d4", in_progress: "#3b82f6",
  review: "#a855f7", verification: "#8b5cf6", blocked: "#ef4444", merged: "#10b981",
  done: "#22c55e", cancelled: "#475569", unknown: "#64748b",
  working: "#3b82f6", waiting: "#f59e0b", reviewing: "#a855f7", completed: "#22c55e",
  failed: "#ef4444", stopped: "#475569",
  pending: "#64748b", running: "#3b82f6", success: "#22c55e",
  checking: "#f59e0b", merging: "#3b82f6", conflict: "#ef4444", dead_letter: "#dc2626",
  supported: "#22c55e", partial: "#f59e0b", not_configured: "#64748b", unavailable: "#475569",
  stale: "#f59e0b", degraded: "#ef4444",
  open: "#3b82f6", closed: "#64748b",
  planning_r: "#f59e0b", in_progress_r: "#3b82f6", ready_r: "#22c55e", released: "#10b981",
}
const color = (s: string): string => STATUS_COLORS[s] ?? "#64748b"
const chip = (s: string, label?: string): string => `<span class="chip" style="background:${color(s)}22;color:${color(s)};border:1px solid ${color(s)}55">${esc(label ?? st(s))}</span>`
const natureTag = (n: string): string => n === "computed" ? '<span class="nature" title="computed">∑</span>' : n === "estimated" ? '<span class="nature est" title="estimated">≈</span>' : n === "missing" ? '<span class="nature miss" title="no data">—</span>' : ""

function fmtTime(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function ago(iso?: string | null): string {
  if (!iso) return t("c.never")
  const ms = Date.now() - Date.parse(iso)
  if (isNaN(ms)) return "—"
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`
  return `${Math.round(ms / 86400000)}d`
}
function dur(ms?: number | null): string {
  if (ms === undefined || ms === null || isNaN(ms)) return "—"
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------- state ----------
let PROJECTS: Json[] = []
let PID = ""
let CONFIG: Json | null = null
let SECTION = "overview"
let ES: EventSource | null = null
let lastSeq = 0
let refreshTimer: number | null = null

async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${res.status}`)
  return data
}

function parseHash(): { pid: string; section: string; arg?: string } {
  const h = location.hash.replace(/^#\/?/, "")
  const parts = h.split("/").filter(Boolean)
  return { pid: parts[0] ?? "", section: parts[1] ?? "overview", arg: parts[2] }
}
function nav(section: string, arg?: string): void { location.hash = `#/${PID}/${section}${arg ? "/" + arg : ""}` }

// ---------- shell ----------
async function boot(): Promise<void> {
  document.documentElement.lang = LANG
  PROJECTS = await api("/api/projects")
  const h = parseHash()
  PID = h.pid || (PROJECTS[0]?.project?.id ?? "")
  SECTION = h.section
  if (!PID) { renderNoProjects(); return }
  await loadConfig()
  renderShell()
  if (!CAPTURE) connectSSE()
  await renderSection()
}

function renderNoProjects(): void {
  $("app").innerHTML = `<div class="noprog"><h1>Dark Factory Control Plane</h1>
  <p>${esc(t("c.noProjects"))}</p><p>${esc(t("c.connectHint"))}</p>
  <p><select id="langSel0"><option value="en" ${LANG === "en" ? "selected" : ""}>English</option><option value="ru" ${LANG === "ru" ? "selected" : ""}>Русский</option></select></p></div>`
  $("langSel0").onchange = () => setLang(($("langSel0") as HTMLSelectElement).value as Lang)
}

function setLang(l: Lang): void {
  LANG = l
  localStorage.setItem("dfcp-lang", l)
  document.documentElement.lang = l
  if (PID) { renderShell(); if (!CAPTURE) connectSSE(); renderSection() } else renderNoProjects()
}

async function loadConfig(): Promise<void> { CONFIG = await api(`/api/projects/${PID}/dashboard-config`) }

function renderShell(): void {
  const sections = (CONFIG?.sections ?? []).filter((s: Json) => s.visible)
  const projOptions = PROJECTS.map(p => `<option value="${esc(p.project?.id)}" ${p.project?.id === PID ? "selected" : ""}>${esc(p.project?.name ?? p.project?.id)}</option>`).join("")
  $("app").innerHTML = `
  <header>
    <div class="brand">◆ DFCP</div>
    <select id="projSel" title="Project">${projOptions}</select>
    <span class="live off" id="live"><span class="dot"></span><span id="liveTxt">${esc(t("h.connecting"))}</span></span>
    <span class="hstat">${esc(t("h.data"))}: <b id="dataAge">—</b></span>
    <button class="btn" id="refreshBtn">${esc(t("h.refresh"))}</button>
    <button class="btn" id="syncBtn" title="Sync">${esc(t("h.sync"))}</button>
    <span class="spacer"></span>
    <span class="hstat">${esc(t("h.core"))} <b id="coreVer">—</b></span>
  </header>
  <aside><nav id="nav">
    ${sections.map((s: Json) => `<a class="navlink ${s.id === SECTION ? "active" : ""}" data-sec="${esc(s.id)}">${esc(t("nav." + s.id))}${s.mode === "partial" ? ' <span class="partial-dot" title="partial">◐</span>' : ""}</a>`).join("")}
  </nav></aside>
  <main id="main"><div class="loading">${esc(t("c.loading"))}</div></main>
  <div class="modal-bg" id="modalBg"><div class="modal" id="modal"></div></div>`
  $("projSel").onchange = () => { PID = ($("projSel") as HTMLSelectElement).value; location.hash = `#/${PID}/overview` }
  $("refreshBtn").onclick = () => renderSection()
  $("syncBtn").onclick = async () => {
    $("syncBtn").textContent = t("h.syncing")
    try { await api(`/api/projects/${PID}/sync`, "POST"); await renderSection() } finally { $("syncBtn").textContent = t("h.sync") }
  }
  $("nav").querySelectorAll(".navlink").forEach(a => (a as HTMLElement).onclick = () => nav((a as HTMLElement).dataset.sec!))
  $("modalBg").onclick = e => { if (e.target === $("modalBg")) closeModal() }
  if (CAPTURE) { $("live").classList.remove("off"); $("liveTxt").textContent = "live" }
  api("/api/health").then(h => { $("coreVer").textContent = h.coreVersion }).catch(() => {})
}

function connectSSE(): void {
  ES?.close()
  try {
    ES = new EventSource(`/api/projects/${PID}/stream?lastSeq=${lastSeq}`)
    ES.onopen = () => { $("live").classList.remove("off"); $("liveTxt").textContent = t("h.live") }
    ES.onerror = () => { $("live").classList.add("off"); $("liveTxt").textContent = t("h.reconnecting") }
    ES.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data)
        if (d.seq) lastSeq = Math.max(lastSeq, d.seq)
        if (d.type === "hello") return
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => renderSection(), 400)
      } catch { /* ignore */ }
    }
  } catch { $("liveTxt").textContent = t("h.polling") }
}

function closeModal(): void { $("modalBg").classList.remove("show") }
function openModal(html: string): void { $("modal").innerHTML = `<span class="close" id="mclose">${esc(t("c.close"))}</span>` + html; $("modalBg").classList.add("show"); $("mclose").onclick = closeModal }

function banner(mode: string, limitations: string[]): string {
  if (mode !== "partial" || !limitations.length) return ""
  return `<div class="banner">${esc(t("c.partial"))}: ${limitations.map(esc).join(" · ")}</div>`
}
function sectionMeta(id: string): Json { return (CONFIG?.sections ?? []).find((s: Json) => s.id === id) ?? { mode: "full", limitations: [] } }

// ---------- charts ----------
function repoActivityChart(act: Json, height = 150): string {
  const days: Json[] = act?.days ?? []
  if (!days.length) return `<div class="empty">${esc(t("c.noCommits"))}</div>`
  const W = 660, H = height, padL = 34, padB = 22, padT = 10
  const max = Math.max(1, ...days.map(d => Math.max(d.commits, d.events)))
  const bw = (W - padL - 10) / days.length
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  for (let g = 0; g <= 2; g++) {
    const y = padT + (H - padT - padB) * g / 2
    svg += `<line x1="${padL}" y1="${y}" x2="${W - 6}" y2="${y}" stroke="#2a3554" stroke-width="0.6"/><text x="${padL - 6}" y="${y + 3}" fill="#93a0bd" font-size="9" text-anchor="end">${Math.round(max * (1 - g / 2))}</text>`
  }
  const pts: string[] = []
  days.forEach((d, i) => {
    const x = padL + i * bw
    const h = (H - padT - padB) * d.commits / max
    svg += `<rect x="${x + 2}" y="${H - padB - h}" width="${Math.max(2, bw - 4)}" height="${h}" rx="2" fill="#3b82f6" opacity="0.85"><title>${esc(d.date)}: ${d.commits} ${esc(t("c.commits"))}</title></rect>`
    const ey = H - padB - (H - padT - padB) * d.events / max
    pts.push(`${x + bw / 2},${ey}`)
    if (i % 2 === 0) svg += `<text x="${x + bw / 2}" y="${H - 8}" fill="#93a0bd" font-size="8.5" text-anchor="middle">${esc(d.date.slice(5))}</text>`
  })
  svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="#22c55e" stroke-width="1.6" opacity="0.9"/>`
  svg += "</svg>"
  return `<div class="graph">${svg}</div>
  <div class="legend"><span><i class="sw" style="background:#3b82f6"></i>${esc(t("c.commits"))} (${act.totalCommits})</span><span><i class="sw line" style="background:#22c55e"></i>${esc(t("c.events"))} (${act.totalEvents})</span>${(act.notes ?? []).map((n: string) => `<span class="amuted">${esc(n)}</span>`).join("")}</div>`
}

function ganttChart(cp: Json, now = Date.now()): string {
  const bars: Json[] = cp.schedule ?? []
  if (!bars.length) return `<div class="empty">${esc(t("c.ganttNoTasks"))}</div>`
  const whpd = cp.workingHoursPerDay ?? 8
  const horizon = Math.max(cp.horizonHours ?? 0, whpd)
  const labelW = 150, rowH = 26, padT = 26, padB = 30
  const px = Math.max(2.5, Math.min(9, 860 / horizon))
  const W = labelW + horizon * px + 90
  const H = padT + bars.length * rowH + padB
  const xOf = (h: number) => labelW + h * px
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  // day grid
  const days = Math.ceil(horizon / whpd)
  for (let d = 0; d <= days; d++) {
    const x = xOf(d * whpd)
    const date = new Date(now + d * 86400000)
    svg += `<line x1="${x}" y1="${padT - 6}" x2="${x}" y2="${H - padB}" stroke="#2a3554" stroke-width="0.7"/>`
    svg += `<text x="${x + 3}" y="${padT - 10}" fill="#93a0bd" font-size="9">${esc(t("c.ganttDay"))} ${d + 1} · ${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}</text>`
  }
  // release target line
  if (cp.releaseTargetAt) {
    const targetH = (Date.parse(cp.releaseTargetAt) - now) / 86400000 * whpd
    if (targetH >= 0 && targetH <= horizon * 1.15) {
      const x = xOf(targetH)
      svg += `<line x1="${x}" y1="${padT - 6}" x2="${x}" y2="${H - padB}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6,4"/>`
      svg += `<text x="${x + 4}" y="${H - padB + 14}" fill="#f59e0b" font-size="10" font-weight="600">${esc(t("c.ganttTarget"))}</text>`
    }
  }
  // projected finish line
  const xf = xOf(horizon)
  svg += `<line x1="${xf}" y1="${padT - 6}" x2="${xf}" y2="${H - padB}" stroke="#22c55e" stroke-width="1.6" stroke-dasharray="3,3"/>`
  svg += `<text x="${xf + 4}" y="${H - padB + 14}" fill="#22c55e" font-size="10">${esc(t("c.ganttProjected"))}: ${fmtTime(cp.projectedFinishAt)}</text>`
  // bars
  bars.forEach((b, i) => {
    const y = padT + i * rowH + 4
    const x = xOf(b.startH), w = Math.max(3, (b.endH - b.startH) * px)
    const c = b.onPath ? "#ef4444" : color(b.status)
    svg += `<text x="6" y="${y + 13}" fill="#e6ebf5" font-size="11" font-family="ui-monospace,monospace">${esc(b.taskId)}</text>`
    svg += `<text x="${labelW - 8}" y="${y + 13}" fill="#93a0bd" font-size="9" text-anchor="end">${esc((b.title ?? "").slice(0, 18))}</text>`
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${rowH - 10}" rx="4" fill="${c}${b.estimated ? "55" : "cc"}" stroke="${c}" stroke-width="${b.onPath ? 2 : 1}" ${b.estimated ? 'stroke-dasharray="4,3"' : ""}><title>${esc(b.taskId)}: ${b.startH}h → ${b.endH}h${b.estimated ? " (estimated)" : ""}</title></rect>`
    if (w > 34) svg += `<text x="${x + 5}" y="${y + 12}" fill="#0b1020" font-size="9" font-weight="700">${b.endH - b.startH}h</text>`
  })
  svg += "</svg>"
  const late = (cp.lateByHours ?? 0) > 0
  return `<div class="graph">${svg}</div>
  <div class="legend">
    <span><i class="sw" style="background:#ef4444"></i>${esc(t("c.ganttLegendCritical"))}</span>
    <span><i class="sw" style="background:#3b82f6"></i>${esc(t("c.ganttLegendNormal"))}</span>
    <span><i class="sw dash" style="background:#3b82f655;border:1px dashed #3b82f6"></i>${esc(t("c.ganttLegendEstimated"))}</span>
    <span class="amuted">${esc(t("c.ganttWhpd", { h: whpd }))}</span>
  </div>
  ${cp.releaseTargetAt ? (late ? `<div class="alert error">${esc(t("c.ganttLate", { h: cp.lateByHours }))}</div>` : `<div class="alert info">${esc(t("c.ganttOnTime"))}</div>`) : ""}`
}

// ---------- sections ----------
async function renderSection(): Promise<void> {
  const h = parseHash()
  if (h.pid && h.pid !== PID) { PID = h.pid; await loadConfig(); renderShell(); connectSSE() }
  SECTION = h.section || "overview"
  $("nav")?.querySelectorAll(".navlink").forEach(a => a.classList.toggle("active", (a as HTMLElement).dataset.sec === SECTION))
  const main = $("main")
  main.innerHTML = `<div class="loading">${esc(t("c.loading"))}</div>`
  try {
    switch (SECTION) {
      case "overview": await renderOverview(main); break
      case "tasks": await renderTasks(main); break
      case "task-tree": await renderTaskTree(main); break
      case "agents": await renderAgents(main); break
      case "workflow": await renderWorkflow(main); break
      case "pipelines": await renderPipelines(main, h.arg); break
      case "merge-queue": await renderQueue(main); break
      case "critical-path": await renderCriticalPath(main, h.arg); break
      case "releases": await renderReleases(main, h.arg); break
      case "components": await renderComponents(main); break
      case "metrics": await renderMetrics(main); break
      case "activity": await renderActivity(main); break
      case "integrations": await renderIntegrations(main); break
      case "settings": await renderSettings(main); break
      default: main.innerHTML = `<div class="empty">${esc(t("c.unknownSection"))}</div>`
    }
    $("dataAge").textContent = new Date().toLocaleTimeString()
  } catch (e) {
    main.innerHTML = `<div class="error">${esc(t("c.error"))}: ${esc((e as Error).message)}</div>`
  }
}

async function renderOverview(main: HTMLElement): Promise<void> {
  const ov = await api(`/api/projects/${PID}`)
  const c = ov.counts ?? {}
  const cards: string[] = []
  const visible = (id: string) => (CONFIG?.sections ?? []).some((s: Json) => s.id === id && s.visible)
  if (visible("tasks")) {
    const bs = c.tasks?.byStatus ?? {}
    cards.push(kpi(t("c.tasksKpi"), c.tasks?.total ?? 0, `${bs.done ?? 0} ${esc(t("c.done"))} · ${bs.in_progress ?? 0} ${esc(t("c.inProgress"))} · ${bs.blocked ?? 0} ${esc(t("c.blocked"))}`, "tasks"))
  }
  if (visible("agents")) cards.push(kpi(t("c.agentsKpi"), `${c.agents?.working ?? 0}/${c.agents?.total ?? 0}`, `${esc(t("c.working"))} · ${c.agents?.unknown ?? 0} ${esc(t("c.unknownAgents"))}`, "agents"))
  if (visible("pipelines") && c.pipelines?.lastRun) {
    const r = c.pipelines.lastRun
    cards.push(kpi(t("c.lastPipeline"), `#${r.number} ${st(r.status)}`, `${esc(r.pipelineId)} · ${ago(r.startedAt)}`, "pipelines", color(r.status)))
  }
  if (visible("merge-queue") && c.queue) cards.push(kpi(t("c.queueKpi"), c.queue.waiting, c.queue.inFlight ? esc(t("c.mergeInFlight")) : esc(t("c.idle")), "merge-queue"))
  if (visible("releases") && c.releases?.active) {
    const r = c.releases.active, rd = c.releases.readiness
    cards.push(kpi(`${esc(t("c.releaseKpi"))} ${esc(r.name)}`, rd ? `${rd.tasks.done}/${rd.tasks.total}` : "—", rd ? `${esc(t("c.readiness"))}: ${st(rd.verdict)}` : "", "releases", rd?.verdict === "ready" ? "#22c55e" : "#f59e0b"))
  }
  if (visible("critical-path") && ov.criticalPath?.path?.length) {
    cards.push(kpi(t("c.cpKpi"), ov.criticalPath.path.length, ov.criticalPath.lengthHours ? `${ov.criticalPath.lengthHours}h ${natureTag(ov.criticalPath.nature)}` : `${esc(t("c.structural"))} ${natureTag(ov.criticalPath.nature)}`, "critical-path"))
  }
  const alerts = (ov.alerts ?? []).map((a: Json) => `<div class="alert ${esc(a.severity)}"><span class="asev">${a.severity === "error" ? "⛔" : a.severity === "warning" ? "⚠" : "ℹ"}</span> ${esc(trAlert(a.message))} <span class="amuted">${ago(a.at)}</span></div>`).join("") || `<div class="empty">${esc(t("c.noAlerts"))}</div>`
  const fresh = Object.entries(ov.freshness ?? {}).map(([id, f]: [string, any]) =>
    `<span class="fresh ${f.degraded ? "degraded" : f.stale ? "stale" : "ok"}" title="last success: ${esc(f.lastSuccessAt ?? "never")}">${esc(id)}: ${esc(t(f.degraded ? "c.degraded" : f.stale ? "c.stale" : "c.ok"))} · ${ago(f.lastSuccessAt)}</span>`).join(" ") || `<span class="empty">—</span>`
  const activity = (await api(`/api/projects/${PID}/activity?limit=8`)).events ?? []
  const gitVisible = visible("integrations") && Object.keys(ov.freshness ?? {}).includes("git")
  const act = gitVisible ? (await api(`/api/projects/${PID}/git`)).activity : null
  main.innerHTML = `<h2>${esc(t("nav.overview"))} — ${esc(ov.project?.name ?? PID)}</h2>
    <div class="kpis">${cards.join("")}</div>
    <div class="cols">
      <section><h3>${esc(t("c.alerts"))}</h3>${alerts}</section>
      <section><h3>${esc(t("c.freshness"))}</h3><div class="freshwrap">${fresh}</div>
        <h3>${esc(t("c.recentActivity"))}</h3>${activityTable(activity)}</section>
    </div>
    ${act ? `<section><h3>${esc(t("c.repoActivity"))} <span class="amuted">${esc(t("c.repoActivitySub", { n: act.days.length }))}</span></h3>${repoActivityChart(act, 130)}</section>` : ""}`
  main.querySelectorAll("[data-goto]").forEach(el => (el as HTMLElement).onclick = () => nav((el as HTMLElement).dataset.goto!))
}

function kpi(label: string, value: unknown, sub: string, goto: string, valColor?: string): string {
  return `<div class="kpi" data-goto="${esc(goto)}"><div class="lbl">${esc(label)}</div><div class="val" ${valColor ? `style="color:${valColor}"` : ""}>${value}</div><div class="sub">${sub}</div></div>`
}

function activityTable(events: Json[]): string {
  if (!events.length) return `<div class="empty">${esc(t("c.noEvents"))}</div>`
  return `<table><tr><th>${esc(t("c.time"))}</th><th>${esc(t("c.event"))}</th><th>${esc(t("c.source"))}</th><th>${esc(t("c.detail"))}</th></tr>
  ${events.map(e => `<tr><td class="mono">${fmtTime(e.occurredAt)}</td><td>${chip(e.type.split(".")[0], e.type)}</td><td class="mono">${esc(e.source?.adapterId ?? "?")}</td><td class="detail">${esc(JSON.stringify(e.payload).slice(0, 120))}</td></tr>`).join("")}</table>`
}

// ---------- tasks ----------
let taskFilters = { status: "", kind: "", priority: "", q: "" }

async function renderTasks(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("tasks")
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(taskFilters)) if (v) qs.set(k, v)
  const { tasks } = await api(`/api/projects/${PID}/tasks?${qs}`)
  const statuses = ["", "backlog", "planning", "ready", "in_progress", "review", "verification", "blocked", "merged", "done", "cancelled", "unknown"]
  main.innerHTML = `<h2>${esc(t("nav.tasks"))}</h2>${banner(meta.mode, meta.limitations)}
  <div class="filterbar">
    <select id="fStatus">${statuses.map(s => `<option value="${s}" ${taskFilters.status === s ? "selected" : ""}>${s ? st(s) : esc(t("c.allStatuses"))}</option>`).join("")}</select>
    <select id="fKind">${["", "epic", "feature", "task", "subtask"].map(s => `<option value="${s}" ${taskFilters.kind === s ? "selected" : ""}>${s || esc(t("c.allKinds"))}</option>`).join("")}</select>
    <select id="fPriority">${["", "P0", "P1", "P2", "P3"].map(s => `<option value="${s}" ${taskFilters.priority === s ? "selected" : ""}>${s || esc(t("c.allPriorities"))}</option>`).join("")}</select>
    <input id="fQ" placeholder="${esc(t("c.search"))}" value="${esc(taskFilters.q)}">
    <button class="btn primary" id="newTask">${esc(t("c.newTask"))}</button>
  </div>
  <table id="taskTable"><tr><th>${esc(t("c.id"))}</th><th>${esc(t("c.title"))}</th><th>${esc(t("c.kind"))}</th><th>${esc(t("c.status"))}</th><th>${esc(t("c.priority"))}</th><th>${esc(t("c.assignee"))}</th><th>${esc(t("c.deps"))}</th><th>${esc(t("c.progress"))}</th><th>${esc(t("c.updated"))}</th></tr>
  ${tasks.map((tk: Json) => `<tr class="rowlink" data-task="${esc(tk.id)}">
    <td class="mono">${esc(tk.id)}</td><td>${esc(tk.title)}</td><td>${esc(tk.kind)}</td>
    <td>${chip(tk.status)}${tk.sourceStatus && tk.sourceStatus !== tk.status ? `<span class="orig" title="source status">${esc(tk.sourceStatus)}</span>` : ""}</td>
    <td>${esc(tk.priority)}</td><td>${esc(tk.assignee ?? "—")}</td>
    <td class="mono">${(tk.dependencies ?? []).map((d: string) => esc(d)).join(", ") || "—"}</td>
    <td>${tk.progress !== undefined ? tk.progress + "%" : tk.status === "done" ? "100%" : "—"}</td>
    <td class="mono">${fmtTime(tk.updatedAt)}</td></tr>`).join("")}</table>
  ${!tasks.length ? `<div class="empty">${esc(t("c.noTasksMatch"))}</div>` : ""}`
  $("fStatus").onchange = () => { taskFilters.status = ($("fStatus") as HTMLSelectElement).value; renderTasks(main) }
  $("fKind").onchange = () => { taskFilters.kind = ($("fKind") as HTMLSelectElement).value; renderTasks(main) }
  $("fPriority").onchange = () => { taskFilters.priority = ($("fPriority") as HTMLSelectElement).value; renderTasks(main) }
  $("fQ").oninput = () => { taskFilters.q = ($("fQ") as HTMLInputElement).value; renderTasks(main) }
  $("newTask").onclick = () => taskForm()
  main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

function taskForm(existing?: Json): void {
  const tk = existing ?? {}
  openModal(`<h3>${existing ? esc(t("c.editTask")) + " " + esc(tk.id) : esc(t("c.newTaskTitle"))}</h3>
  <div class="form">
    ${existing ? "" : `<label>${esc(t("c.id"))} <input id="tId" placeholder="T-100"></label>`}
    <label>${esc(t("c.title"))} <input id="tTitle" value="${esc(tk.title ?? "")}"></label>
    <label>${esc(t("c.kind"))} <select id="tKind">${["task", "epic", "feature", "subtask"].map(k => `<option ${tk.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>${esc(t("c.status"))} <select id="tStatus">${["ready", "backlog", "planning", "in_progress", "review", "verification", "blocked", "done", "cancelled"].map(k => `<option ${tk.status === k ? "selected" : ""} value="${k}">${st(k)}</option>`).join("")}</select></label>
    <label>${esc(t("c.priority"))} <select id="tPriority">${["P0", "P1", "P2", "P3"].map(k => `<option ${(tk.priority ?? "P2") === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>${esc(t("c.parentId"))} <input id="tParent" value="${esc(tk.parentId ?? "")}"></label>
    <label>${esc(t("c.depsCsv"))} <input id="tDeps" value="${esc((tk.dependencies ?? []).join(","))}"></label>
    <label>${esc(t("c.estimateHours"))} <input id="tEst" type="number" value="${tk.estimateHours ?? ""}"></label>
    <label>${esc(t("c.component"))} <input id="tComp" value="${esc(tk.componentId ?? "")}"></label>
    <label>${esc(t("c.description"))} <textarea id="tDesc">${esc(tk.description ?? "")}</textarea></label>
    <button class="btn primary" id="tSave">${existing ? esc(t("c.save")) : esc(t("c.create"))}</button>
  </div>`)
  $("tSave").onclick = async () => {
    const body: Json = {
      title: ($("tTitle") as HTMLInputElement).value, kind: ($("tKind") as HTMLSelectElement).value,
      status: ($("tStatus") as HTMLSelectElement).value, priority: ($("tPriority") as HTMLSelectElement).value,
      parentId: ($("tParent") as HTMLInputElement).value || undefined,
      dependencies: ($("tDeps") as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean),
      estimateHours: ($("tEst") as HTMLInputElement).value ? Number(($("tEst") as HTMLInputElement).value) : undefined,
      componentId: ($("tComp") as HTMLInputElement).value || undefined,
      description: ($("tDesc") as HTMLTextAreaElement).value || undefined,
    }
    try {
      if (existing) await api(`/api/projects/${PID}/tasks/${tk.id}`, "PATCH", body)
      else await api(`/api/projects/${PID}/tasks`, "POST", { id: ($("tId") as HTMLInputElement).value, ...body })
      closeModal(); renderSection()
    } catch (e) { alert((e as Error).message) }
  }
}

async function openTask(id: string): Promise<void> {
  const { task: tk, dependents } = await api(`/api/projects/${PID}/tasks/${id}`)
  const deps = (tk.dependencies ?? []).map((d: string) => `<span class="depchip" data-task="${esc(d)}">${esc(d)}</span>`).join(" ") || "—"
  const acs = (tk.acceptanceCriteria ?? []).map((a: Json) => `<div class="ac ${a.done ? "done" : ""}">${a.done ? "☑" : "☐"} ${esc(a.text)}</div>`).join("") || `<div class="empty">${esc(t("c.noAc"))}</div>`
  const hist = (tk.history ?? []).slice(-12).reverse().map((h: Json) => `<div class="hist"><span class="mono">${fmtTime(h.at)}</span> <b>${esc(h.field)}</b>: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}${h.actor ? ` <span class="amuted">by ${esc(h.actor)}</span>` : ""}</div>`).join("") || `<div class="empty">${esc(t("c.noHistory"))}</div>`
  const links = tk.links ?? {}
  openModal(`<h3>${esc(tk.id)} — ${esc(tk.title)}</h3>
  <div class="kvgrid">
    <div><b>${esc(t("c.status"))}</b> ${chip(tk.status)} ${tk.sourceStatus ? `<span class="orig">source: ${esc(tk.sourceStatus)}</span>` : ""}</div>
    <div><b>${esc(t("c.kind"))}</b> ${esc(tk.kind)} · <b>${esc(t("c.priority"))}</b> ${esc(tk.priority)}</div>
    <div><b>${esc(t("c.assignee"))}</b> ${esc(tk.assignee ?? "—")}</div>
    <div><b>${esc(t("c.component"))}</b> ${esc(tk.componentId ?? "—")}</div>
    <div><b>${esc(t("c.progress"))}</b> ${tk.progress ?? (tk.status === "done" ? 100 : 0)}% ${tk.estimateHours ? `· ${esc(t("c.estimate"))} ${tk.estimateHours}h (${esc(tk.estimateConfidence ?? "?")})` : ""}</div>
    <div><b>${esc(t("c.source"))}</b> <span class="mono">${esc(tk.source?.adapterId)}</span> ${tk.source?.authoritative ? `(${esc(t("c.authoritative"))})` : `(${esc(t("c.auxiliary"))})`} · ${esc(t("c.fetched"))} ${ago(tk.source?.fetchedAt)}</div>
    <div><b>${esc(t("c.mapping"))}</b> ${esc(t("c.ruleSet"))} <span class="mono">${esc(tk.mapping?.ruleSetId)}</span> ${esc(t("c.version"))}${esc(tk.mapping?.ruleSetVersion)} · ${esc(t("c.confidence"))} ${chip(tk.mapping?.confidence ?? "exact")}</div>
  </div>
  <h4>${esc(t("c.dependsOn"))}</h4><div>${deps}</div>
  ${dependents?.length ? `<h4>${esc(t("c.blocks"))}</h4><div>${dependents.map((d: string) => `<span class="depchip" data-task="${esc(d)}">${esc(d)}</span>`).join(" ")}</div>` : ""}
  <h4>${esc(t("c.acceptance"))}</h4>${acs}
  <h4>${esc(t("c.links"))}</h4><div class="mono">branches: ${(links.branches ?? []).map(esc).join(", ") || "—"} · PRs: ${(links.pullRequests ?? []).map(esc).join(", ") || "—"} · runs: ${(links.pipelineRunIds ?? []).map(esc).join(", ") || "—"} · release: ${esc(links.releaseId ?? "—")}</div>
  ${tk.description ? `<h4>${esc(t("c.description"))}</h4><div class="doc">${esc(tk.description)}</div>` : ""}
  <h4>${esc(t("c.history"))}</h4>${hist}
  <div class="actions">
    <button class="btn" id="tEdit">${esc(t("c.edit"))}</button>
    <button class="btn" id="tClaim">${esc(t("c.claim"))}</button>
    <button class="btn" id="tRelease">${esc(t("c.release"))}</button>
    <select id="tStatusSel">${["ready", "in_progress", "review", "verification", "blocked", "done", "cancelled"].map(s => `<option ${tk.status === s ? "selected" : ""} value="${s}">${st(s)}</option>`).join("")}</select>
    <button class="btn primary" id="tStatusGo">${esc(t("c.setStatus"))}</button>
  </div>`)
  $("tEdit").onclick = () => taskForm(tk)
  $("tClaim").onclick = async () => {
    const agent = prompt(t("c.agentPrompt"))
    if (!agent) return
    try { await api(`/api/projects/${PID}/tasks/${id}/claim`, "POST", { agent }); closeModal(); renderSection() } catch (e) { alert((e as Error).message) }
  }
  $("tRelease").onclick = async () => { await api(`/api/projects/${PID}/tasks/${id}/release`, "POST"); closeModal(); renderSection() }
  $("tStatusGo").onclick = async () => { await api(`/api/projects/${PID}/tasks/${id}`, "PATCH", { status: ($("tStatusSel") as HTMLSelectElement).value }); closeModal(); renderSection() }
  $("modal").querySelectorAll(".depchip").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- task tree ----------
async function renderTaskTree(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("task-tree")
  const { tree } = await api(`/api/projects/${PID}/task-tree`)
  function node(n: Json, depth: number): string {
    const tk = n.task, r = n.rollup
    const kids = (n.children ?? []).map((c: Json) => node(c, depth + 1)).join("")
    return `<div class="tnode" style="margin-left:${depth * 18}px">
      <div class="trow rowlink" data-task="${esc(tk.id)}">
        <span class="twisty">${(n.children ?? []).length ? "▾" : "·"}</span>
        ${chip(tk.status)} <span class="mono tid">${esc(tk.id)}</span> <span class="ttitle">${esc(tk.title)}</span>
        <span class="troll">${r.done}/${r.total} ${esc(t("c.done"))}${r.blocked ? ` · <span style="color:#ef4444">${r.blocked} ${esc(t("c.blocked"))}</span>` : ""}</span>
        <span class="bar"><i style="width:${r.progress}%"></i></span><span class="tpct">${r.progress}%</span>
      </div>${kids}</div>`
  }
  main.innerHTML = `<h2>${esc(t("nav.task-tree"))}</h2>${banner(meta.mode, meta.limitations)}
  <p class="muted">${esc(t("c.treeNote"))}</p>
  ${tree.map((n: Json) => node(n, 0)).join("") || `<div class="empty">${esc(t("c.noTasks"))}</div>`}`
  main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- agents ----------
async function renderAgents(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("agents")
  const { agents } = await api(`/api/projects/${PID}/agents`)
  main.innerHTML = `<h2>${esc(t("nav.agents"))}</h2>${banner(meta.mode, meta.limitations)}
  <table><tr><th>${esc(t("c.name"))}</th><th>${esc(t("c.kind"))}</th><th>${esc(t("c.status"))}</th><th>${esc(t("c.evidenceCol"))}</th><th>${esc(t("c.task"))}</th><th>${esc(t("c.session"))}</th><th>${esc(t("c.model"))}</th><th>${esc(t("c.lastEvent"))}</th><th>${esc(t("c.errors"))}</th></tr>
  ${agents.map((a: Json) => {
    const eff = a.effective ?? { status: a.status, stale: false }
    return `<tr class="rowlink" data-agent="${esc(a.id)}">
    <td><b>${esc(a.name)}</b>${a.role ? `<div class="amuted">${esc(a.role)}</div>` : ""}</td>
    <td>${esc(a.kind)}</td>
    <td>${chip(eff.status)}${eff.stale && eff.status === "unknown" ? `<span class="stalewarn" title="${esc(t("c.noHeartbeatTitle"))}">${esc(t("c.noHeartbeat"))}</span>` : ""}</td>
    <td>${esc(eff.evidence ?? a.statusEvidence)}</td>
    <td class="mono">${esc(a.currentTaskId ?? "—")}</td>
    <td class="mono">${esc(a.sessionId ?? "—")}</td>
    <td class="mono">${esc(a.model ?? "—")}</td>
    <td class="mono">${ago(a.lastEventAt)}</td>
    <td>${a.errors?.length ? `<span style="color:#ef4444">${a.errors.length}</span>` : "0"}</td></tr>`
  }).join("")}</table>
  ${!agents.length ? `<div class="empty">${esc(t("c.noAgents"))}</div>` : ""}`
  main.querySelectorAll("[data-agent]").forEach(el => (el as HTMLElement).onclick = () => openAgent((el as HTMLElement).dataset.agent!))
}

async function openAgent(id: string): Promise<void> {
  const { agent: a, sessions, timeline } = await api(`/api/projects/${PID}/agents/${id}`)
  openModal(`<h3>${esc(a.name)} <span class="mono amuted">${esc(a.id)}</span></h3>
  <div class="kvgrid">
    <div><b>${esc(t("c.status"))}</b> ${chip(a.effective?.status ?? a.status)} (${esc(t("c.evidenceCol"))}: ${esc(a.effective?.evidence ?? a.statusEvidence)})</div>
    <div><b>${esc(t("c.kind"))}</b> ${esc(a.kind)} · <b>${esc(t("c.role"))}</b> ${esc(a.role ?? "—")}</div>
    <div><b>${esc(t("c.currentTask"))}</b> ${esc(a.currentTaskId ?? "—")}</div>
    <div><b>${esc(t("c.model"))}</b> ${esc(a.model ?? "—")}</div>
    <div><b>${esc(t("c.started"))}</b> ${fmtTime(a.startedAt)} · <b>${esc(t("c.lastEvent"))}</b> ${ago(a.lastEventAt)} · <b>${esc(t("c.lastHeartbeat"))}</b> ${ago(a.lastHeartbeatAt)}</div>
  </div>
  <h4>${esc(t("c.sessions"))}</h4>${sessions.length ? sessions.map((s: Json) => `<div class="hist"><span class="mono">${esc(s.id)}</span> ${s.opencodeSessionId ? `· oc ${esc(s.opencodeSessionId)}` : ""} · ${fmtTime(s.startedAt)} → ${s.endedAt ? fmtTime(s.endedAt) : "active"}</div>`).join("") : `<div class="empty">${esc(t("c.noSessions"))}</div>`}
  <h4>${esc(t("c.errors"))}</h4>${a.errors?.length ? a.errors.slice(-5).map((e: Json) => `<div class="alert error">${esc(e.message)} <span class="amuted">${ago(e.at)}</span></div>`).join("") : `<div class="empty">${esc(t("c.noErrors"))}</div>`}
  <h4>${esc(t("c.recentEvents"))}</h4>${activityTable((timeline ?? []).slice(-10).reverse())}`)
}

// ---------- workflow ----------
async function renderWorkflow(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("workflow")
  const wf = await api(`/api/projects/${PID}/workflow`)
  const stages = wf.stages ?? []
  const strip = stages.map((s: Json) => `<div class="wstage ${s.observed ? "" : "unobserved"}"><div class="wname">${esc(s.label)}</div><div class="wcount">${s.taskCount}</div><div class="amuted">${esc(t(s.observed ? "c.observed" : "c.notObserved"))}</div></div>`).join(`<div class="warrow">→</div>`)
  const trs = (wf.transitions ?? []).slice(0, 20)
  main.innerHTML = `<h2>${esc(t("nav.workflow"))}</h2>${banner(meta.mode, meta.limitations)}
  <p class="muted">${esc(t("c.workflowNote"))}</p>
  <div class="wstrip">${strip || `<div class="empty">—</div>`}</div>
  <h3>${esc(t("c.observableStages"))}</h3>
  ${trs.length ? `<table><tr><th>${esc(t("c.from"))}</th><th>${esc(t("c.to"))}</th><th>${esc(t("c.count"))}</th><th>${esc(t("c.last"))}</th></tr>${trs.map((tr: Json) => `<tr><td>${chip(tr.from)}</td><td>${chip(tr.to)}</td><td>${tr.count}</td><td class="mono">${fmtTime(tr.lastAt)}</td></tr>`).join("")}</table>` : `<div class="empty">${esc(t("c.noTransitions"))}</div>`}
  ${wf.observableStages?.length ? `<p class="muted">${esc(t("c.observableStages"))}: ${wf.observableStages.map(esc).join(", ")}</p>` : ""}`
}

// ---------- pipelines ----------
async function renderPipelines(main: HTMLElement, runId?: string): Promise<void> {
  const meta = sectionMeta("pipelines")
  if (runId) {
    const { run: r } = await api(`/api/projects/${PID}/pipelines/${runId}`)
    const stages = (r.stages ?? []).map((s: Json) => `<div class="pstage" style="border-color:${color(s.status)}"><div class="pname">${esc(s.name)}</div>${chip(s.status)}<div class="amuted">${s.startedAt ? fmtTime(s.startedAt) : ""}${s.finishedAt ? " → " + fmtTime(s.finishedAt) : ""}</div>${(s.jobs ?? []).map((j: Json) => `<div class="pjob">${esc(j.name)} ${chip(j.status)}</div>`).join("")}</div>`).join("")
    main.innerHTML = `<button class="btn" id="backRuns">${esc(t("c.backRuns"))}</button>
    <h2>${esc(t("c.runs"))} #${r.number} — ${esc(r.pipelineId)}</h2>${banner(meta.mode, meta.limitations)}
    <div class="kvgrid">
      <div><b>${esc(t("c.status"))}</b> ${chip(r.status)}</div><div><b>${esc(t("c.branch"))}</b> <span class="mono">${esc(r.branch ?? "—")}</span></div>
      <div><b>${esc(t("c.task"))}</b> ${r.taskId ? `<span class="mono link" data-task="${esc(r.taskId)}">${esc(r.taskId)}</span>` : "—"}</div>
      <div><b>${esc(t("c.trigger"))}</b> ${esc(r.trigger ?? "—")}</div>
      <div><b>${esc(t("c.started"))}</b> ${fmtTime(r.startedAt)} · <b>${esc(t("c.finished"))}</b> ${fmtTime(r.finishedAt)}</div>
      <div><b>${esc(t("c.retries"))}</b> ${r.retries ?? 0}</div>
    </div>
    ${r.error ? `<div class="alert error">${esc(r.error)}</div>` : ""}
    <h3>${esc(t("c.stages"))}</h3><div class="pstrip">${stages || `<div class="empty">${esc(t("c.noStages"))}</div>`}</div>
    ${(r.artifacts ?? []).length ? `<h3>${esc(t("c.artifacts"))}</h3>${r.artifacts.map((a: Json) => `<div>${esc(a.name)} ${a.url ? `<a href="${esc(a.url)}">link</a>` : ""}</div>`).join("")}` : ""}`
    $("backRuns").onclick = () => nav("pipelines")
    main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
    return
  }
  const { runs } = await api(`/api/projects/${PID}/pipelines`)
  main.innerHTML = `<h2>${esc(t("nav.pipelines"))}</h2>${banner(meta.mode, meta.limitations)}
  <table><tr><th>#</th><th>${esc(t("c.pipeline"))}</th><th>${esc(t("c.status"))}</th><th>${esc(t("c.branch"))}</th><th>${esc(t("c.task"))}</th><th>${esc(t("c.started"))}</th><th>${esc(t("c.duration"))}</th></tr>
  ${runs.map((r: Json) => `<tr class="rowlink" data-run="${esc(r.id)}"><td class="mono">${r.number}</td><td>${esc(r.pipelineId)}</td><td>${chip(r.status)}</td><td class="mono">${esc(r.branch ?? "—")}</td><td class="mono">${esc(r.taskId ?? "—")}</td><td class="mono">${fmtTime(r.startedAt)}</td><td>${r.startedAt && r.finishedAt ? dur(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : "…"}</td></tr>`).join("")}</table>
  ${!runs.length ? `<div class="empty">${esc(t("c.noRuns"))}</div>` : ""}`
  main.querySelectorAll("[data-run]").forEach(el => (el as HTMLElement).onclick = () => nav("pipelines", (el as HTMLElement).dataset.run!))
}

// ---------- merge queue ----------
async function renderQueue(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("merge-queue")
  const res = await api(`/api/projects/${PID}/merge-queue`)
  if (!res.available || !res.queue) {
    main.innerHTML = `<h2>${esc(t("nav.merge-queue"))}</h2><div class="unavailable"><div class="big">${esc(t("c.noQueue"))}</div>
    <p>${esc(res.capability?.limitations?.join("; ") || t("c.noQueueText"))}</p>
    <p class="muted">${esc(t("c.independentStates"))}</p></div>`
    return
  }
  const q = res.queue
  main.innerHTML = `<h2>${esc(t("nav.merge-queue"))}</h2>${banner(meta.mode, meta.limitations)}
  <p class="muted">${esc(t("c.queueNote"))} · ${esc(t("c.source"))}: <span class="mono">${esc(q.source?.adapterId)}</span> · ${esc(t("c.synced"))} ${ago(q.source?.fetchedAt)}</p>
  <table><tr><th>${esc(t("c.pos"))}</th><th>${esc(t("c.branch"))}</th><th>${esc(t("c.task"))}</th><th>${esc(t("c.agent"))}</th><th>${esc(t("c.state"))}</th><th>${esc(t("c.checks"))}</th><th>${esc(t("c.wait"))}</th><th>${esc(t("c.reason"))}</th></tr>
  ${(q.entries ?? []).map((e: Json) => `<tr class="${e.state === "merging" ? "inflight" : ""}">
    <td>${e.position}</td><td class="mono">${esc(e.branch)}</td>
    <td class="mono">${e.taskId ? `<span class="link" data-task="${esc(e.taskId)}">${esc(e.taskId)}</span>` : "—"}</td>
    <td>${esc(e.agent ?? "—")}</td><td>${chip(e.state)}</td>
    <td>${(e.checks ?? []).map((c: Json) => `${esc(c.name)}:${chip(c.status)}`).join(" ") || "—"}</td>
    <td>${e.enqueuedAt ? dur(Date.now() - Date.parse(e.enqueuedAt)) : "—"}</td>
    <td class="reason">${esc(e.reason ?? "")}</td></tr>`).join("")}</table>
  ${!q.entries?.length ? `<div class="empty">${esc(t("c.queueEmpty"))}</div>` : ""}`
  main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- critical path + gantt ----------
async function renderCriticalPath(main: HTMLElement, releaseId?: string): Promise<void> {
  const cp = await api(`/api/projects/${PID}/critical-path${releaseId ? "?releaseId=" + encodeURIComponent(releaseId) : ""}`)
  const { tasks } = await api(`/api/projects/${PID}/tasks`)
  const { releases } = await api(`/api/projects/${PID}/releases`)
  const byId = new Map(tasks.map((tk: Json) => [tk.id, tk]))
  const pathSet = new Set(cp.path ?? [])
  const layers = new Map<number, string[]>()
  for (const l of cp.layers ?? []) { const a = layers.get(l.layer) ?? []; a.push(l.taskId); layers.set(l.layer, a) }
  const W = 200, H = 54, GX = 90, GY = 22
  const maxLayer = Math.max(0, ...[...layers.keys()])
  const maxRows = Math.max(1, ...[...layers.values()].map(a => a.length))
  const width = 60 + (maxLayer + 1) * (W + GX), height = 40 + maxRows * (H + GY)
  const pos = new Map<string, { x: number; y: number }>()
  for (const [l, ids] of layers) ids.forEach((id, i) => pos.set(id, { x: 30 + l * (W + GX), y: 20 + i * (H + GY) }))
  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  svg += `<defs><marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#94a3b8"/></marker><marker id="arrR" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#ef4444"/></marker></defs>`
  for (const e of cp.edges ?? []) {
    const a = pos.get(e.from), b = pos.get(e.to)
    if (!a || !b) continue
    const onPath = pathSet.has(e.from) && pathSet.has(e.to)
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 4, y2 = b.y + H / 2, mx = (x1 + x2) / 2
    svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${onPath ? "#ef4444" : "#94a3b8"}" stroke-width="${onPath ? 2.2 : 1.3}" marker-end="url(#${onPath ? "arrR" : "arr"})" opacity="${onPath ? 1 : 0.6}"/>`
  }
  for (const [id, p] of pos) {
    const tk = byId.get(id) as Json | undefined
    const onPath = pathSet.has(id)
    const c = color(tk?.status ?? "unknown")
    svg += `<g class="dagNode" data-task="${esc(id)}" style="cursor:pointer"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="9" fill="#141b2e" stroke="${onPath ? "#ef4444" : c}" stroke-width="${onPath ? 2.2 : 1.4}"/>
    <text x="${p.x + 12}" y="${p.y + 20}" fill="${c}" font-size="10" font-style="italic">${esc(st(tk?.status ?? "?"))}${tk?.estimateHours ? ` · ${tk.estimateHours}h` : ""}</text>
    <text x="${p.x + 12}" y="${p.y + 38}" fill="#e6ebf5" font-size="12" font-weight="600">${esc(id)}</text></g>`
  }
  svg += "</svg>"
  const relOptions = `<option value="">${esc(t("c.ganttAll"))}</option>` + releases.map((r: Json) => `<option value="${esc(r.id)}" ${releaseId === r.id ? "selected" : ""}>${esc(t("c.ganttRelease"))}: ${esc(r.name)}</option>`).join("")
  main.innerHTML = `<h2>${esc(t("nav.critical-path"))}</h2>
  <div class="banner ${cp.nature === "computed" ? "ok" : ""}">${natureTag(cp.nature)} ${cp.nature === "computed" ? `${esc(t("c.cpComputed"))}: <b>${cp.lengthHours}h</b>` : cp.nature === "estimated" ? esc(t("c.cpEstimated")) : esc(t("c.cpMissing"))} ${cp.path?.length ? `${esc(t("c.path"))}: <span class="mono">${cp.path.map(esc).join(" → ")}</span>` : ""}</div>
  ${(cp.notes ?? []).map((n: string) => `<div class="muted">· ${esc(trNote(n))}</div>`).join("")}
  ${cp.cycles?.length ? `<div class="alert error">${esc(t("c.cycles"))}: ${cp.cycles.map((c: string[]) => c.join("→")).map(esc).join("; ")}</div>` : ""}
  <div class="graph">${svg}</div>
  <p class="muted">${esc(t("c.dagNote"))}</p>
  <h3>${esc(t("c.gantt"))}</h3>
  <div class="filterbar"><select id="ganttRel">${relOptions}</select></div>
  ${ganttChart(cp)}`
  $("ganttRel").onchange = () => nav("critical-path", ($("ganttRel") as HTMLSelectElement).value || undefined)
  main.querySelectorAll(".dagNode").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- releases ----------
async function renderReleases(main: HTMLElement, rid?: string): Promise<void> {
  const meta = sectionMeta("releases")
  if (rid) {
    const { release: r, readiness: rd, criticalPath: cp } = await api(`/api/projects/${PID}/releases/${rid}`)
    main.innerHTML = `<button class="btn" id="backRel">${esc(t("c.backRel"))}</button>
    <h2>${esc(t("c.releaseKpi"))} ${esc(r.name)} ${r.tag ? `<span class="mono">(${esc(r.tag)})</span>` : ""}</h2>${banner(meta.mode, meta.limitations)}
    <div class="kpis">
      ${kpi(t("c.verdict"), st(rd.verdict), `${natureTag(rd.nature)} ${rd.tasks.done}/${rd.tasks.total} ${esc(t("c.done"))}`, "releases", rd.verdict === "ready" ? "#22c55e" : rd.verdict === "not_ready" ? "#f59e0b" : "#64748b")}
      ${kpi(t("c.blockers"), rd.blockers.length, esc(t("c.open")), "releases")}
      ${kpi(t("c.cpKpi"), cp.path?.length ?? 0, cp.lengthHours ? cp.lengthHours + "h" : esc(t("c.structural")), "critical-path")}
    </div>
    <h3>${esc(t("c.checks"))}</h3>
    <table><tr><th>${esc(t("c.check"))}</th><th>${esc(t("c.result"))}</th><th>${esc(t("c.evidence"))}</th></tr>
    ${rd.checks.map((c: Json) => `<tr><td>${esc(c.name)}</td><td>${c.ok ? '<span style="color:#22c55e">✓</span>' : '<span style="color:#ef4444">✗</span>'}</td><td>${esc(c.evidence)}</td></tr>`).join("")}</table>
    <p class="muted">${esc(t("c.assessed"))}: ${rd.coverage.map(esc).join(" · ")}</p>
    ${rd.blockers.length ? `<h3>${esc(t("c.blockers"))}</h3>${rd.blockers.map((b: Json) => `<div class="alert warning"><span class="mono">${esc(b.taskId)}</span>: ${esc(b.reason)}</div>`).join("")}` : ""}
    <h3>${esc(t("c.gantt"))}</h3>${ganttChart(cp)}
    <h3>${esc(t("c.scope"))}</h3><table><tr><th>${esc(t("c.task"))}</th><th>${esc(t("c.status"))}</th></tr>${r.scopeTaskIds.map((id: string) => `<tr class="rowlink" data-task="${esc(id)}"><td class="mono">${esc(id)}</td><td>—</td></tr>`).join("")}</table>`
    $("backRel").onclick = () => nav("releases")
    main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
    return
  }
  const { releases } = await api(`/api/projects/${PID}/releases`)
  main.innerHTML = `<h2>${esc(t("nav.releases"))}</h2>${banner(meta.mode, meta.limitations)}
  <div class="filterbar"><button class="btn primary" id="newRel">${esc(t("c.newRelease"))}</button></div>
  <table><tr><th>${esc(t("c.name"))}</th><th>${esc(t("c.tag"))}</th><th>${esc(t("c.status"))}</th><th>${esc(t("c.scope"))}</th><th>${esc(t("c.readiness"))}</th><th>${esc(t("c.target"))}</th></tr>
  ${releases.map((r: Json) => `<tr class="rowlink" data-rel="${esc(r.id)}"><td><b>${esc(r.name)}</b></td><td class="mono">${esc(r.tag ?? "—")}</td><td>${chip(r.status)}</td><td>${r.scopeTaskIds?.length ?? 0} ${esc(t("c.scopeTasks"))}</td><td>${r.readiness ? chip(r.readiness.verdict === "ready" ? "success" : r.readiness.verdict === "not_ready" ? "failed" : "unknown", st(r.readiness.verdict)) + ` ${r.readiness.tasks.done}/${r.readiness.tasks.total}` : "—"}</td><td class="mono">${fmtTime(r.targetDate)}</td></tr>`).join("")}</table>
  ${!releases.length ? `<div class="empty">${esc(t("c.noReleases"))}</div>` : ""}`
  $("newRel").onclick = () => {
    openModal(`<h3>${esc(t("c.newReleaseTitle"))}</h3><div class="form">
    <label>${esc(t("c.id"))} <input id="rId" placeholder="v0.2"></label>
    <label>${esc(t("c.name"))} <input id="rName" placeholder="v0.2"></label>
    <label>${esc(t("c.scopeCsv"))} <input id="rScope"></label>
    <label>${esc(t("c.target"))} <input id="rTarget" type="date"></label>
    <button class="btn primary" id="rSave">${esc(t("c.create"))}</button></div>`)
    $("rSave").onclick = async () => {
      try {
        await api(`/api/projects/${PID}/releases`, "POST", { id: ($("rId") as HTMLInputElement).value, name: ($("rName") as HTMLInputElement).value, scopeTaskIds: ($("rScope") as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean), targetDate: ($("rTarget") as HTMLInputElement).value ? new Date(($("rTarget") as HTMLInputElement).value).toISOString() : undefined })
        closeModal(); renderSection()
      } catch (e) { alert((e as Error).message) }
    }
  }
  main.querySelectorAll("[data-rel]").forEach(el => (el as HTMLElement).onclick = () => nav("releases", (el as HTMLElement).dataset.rel!))
}

// ---------- components ----------
async function renderComponents(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("components")
  const { components } = await api(`/api/projects/${PID}/components`)
  const arch = await api(`/api/projects/${PID}/architecture`)
  const byParent = new Map<string | undefined, Json[]>()
  for (const c of components) { const k = c.parentId ?? undefined; const a = byParent.get(k) ?? []; a.push(c); byParent.set(k, a) }
  function cnode(c: Json, depth: number): string {
    const kids = (byParent.get(c.id) ?? []).map(k => cnode(k, depth + 1)).join("")
    const d = c.derived ?? {}
    return `<div class="tnode" style="margin-left:${depth * 18}px"><div class="trow">
      ${chip(c.status)} <b>${esc(c.name)}</b> <span class="mono amuted">${esc(c.id)}</span>
      <span class="troll">${d.readiness ?? 0}% ${natureTag(d.nature ?? "missing")} · ${d.taskCount ?? 0} ${esc(t("c.tasksCount"))}</span>
      <span class="bar"><i style="width:${d.readiness ?? 0}%"></i></span></div>
      ${c.doc ? `<div class="doc" style="margin-left:20px">${esc(c.doc)}</div>` : ""}${kids}</div>`
  }
  let archHtml = ""
  if (arch.available && arch.views?.length) {
    const v = arch.views[0]
    const nodes = (arch.elements ?? []).filter((e: Json) => (v.nodes ?? []).includes(e.id))
    const W = 190, H = 56, GX = 120, GY = 30
    const pos = new Map<string, { x: number; y: number }>()
    nodes.forEach((n: Json, i: number) => pos.set(n.id, { x: 30 + (i % 3) * (W + GX), y: 20 + Math.floor(i / 3) * (H + GY) }))
    const width = 30 + Math.min(nodes.length, 3) * (W + GX), height = 40 + Math.ceil(nodes.length / 3) * (H + GY)
    let svg = `<svg width="${width}" height="${height}"><defs><marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#7dd3fc"/></marker></defs>`
    for (const e of v.edges ?? []) {
      const a = pos.get(e.source), b = pos.get(e.target)
      if (!a || !b) continue
      svg += `<path d="M${a.x + W},${a.y + H / 2} C${a.x + W + 50},${a.y + H / 2} ${b.x - 50},${b.y + H / 2} ${b.x - 4},${b.y + H / 2}" fill="none" stroke="#7dd3fc" stroke-width="1.4" stroke-dasharray="6,4" marker-end="url(#a2)"/>`
      if (e.label) svg += `<text x="${(a.x + W + b.x) / 2}" y="${(a.y + b.y) / 2 + H / 2 - 6}" fill="#93a0bd" font-size="10" text-anchor="middle">${esc(e.label)}</text>`
    }
    for (const n of nodes) {
      const p = pos.get(n.id)!
      svg += `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="#141b2e" stroke="#2a3554"/><text x="${p.x + 12}" y="${p.y + 22}" fill="#e6ebf5" font-size="12" font-weight="600">${esc(n.title)}</text><text x="${p.x + 12}" y="${p.y + 40}" fill="#7dd3fc" font-size="10">${esc(n.technology ?? n.kind ?? "")}</text>`
    }
    svg += "</svg>"
    archHtml = `<h3>${esc(t("c.archMap"))} — ${esc(v.title)} <span class="amuted">(${esc(t("c.source"))}: ${esc(arch.source ?? "likec4")})</span></h3><div class="graph">${svg}</div>`
  } else {
    archHtml = `<div class="unavailable"><p>⊘ ${esc(arch.message ?? t("c.notAvailableText"))}</p></div>`
  }
  main.innerHTML = `<h2>${esc(t("nav.components"))}</h2>${banner(meta.mode, meta.limitations)}
  ${components.length ? components.filter((c: Json) => !c.parentId).map((c: Json) => cnode(c, 0)).join("") : `<div class="empty">${esc(t("c.noComponents"))}</div>`}
  ${archHtml}`
}

// ---------- metrics ----------
async function renderMetrics(main: HTMLElement): Promise<void> {
  const { current, repoActivity: act } = await api(`/api/projects/${PID}/metrics`)
  const m = current.metrics ?? {}, cov = current.coverage ?? {}
  main.innerHTML = `<h2>${esc(t("nav.metrics"))}</h2>
  <p class="muted">${esc(t("c.metricsNote"))}: ${fmtTime(current.at)}</p>
  <div class="kpis">${Object.entries(m).map(([k, v]) => `<div class="kpi"><div class="lbl">${esc(t("c.metric." + k))}</div><div class="val">${v === null ? "—" : v}</div><div class="sub">${esc(cov[k] ?? "")}</div></div>`).join("")}</div>
  <h3>${esc(t("c.repoActivity"))} <span class="amuted">${esc(t("c.repoActivitySub", { n: act?.days?.length ?? 14 }))}</span></h3>
  ${repoActivityChart(act, 170)}`
}

// ---------- activity ----------
async function renderActivity(main: HTMLElement): Promise<void> {
  const res = await api(`/api/projects/${PID}/activity?limit=200`)
  main.innerHTML = `<h2>${esc(t("nav.activity"))}</h2>
  <div class="filterbar"><input id="aType" placeholder="${esc(t("c.filterType"))}"><span class="muted">${res.events.length} ${esc(t("c.eventsCount"))} · ${esc(t("c.logSeq"))} ${res.lastSeq}</span></div>
  <div id="aTable">${activityTable(res.events)}</div>`
  $("aType").oninput = async () => {
    const v = ($("aType") as HTMLInputElement).value
    const r = await api(`/api/projects/${PID}/activity?limit=200&type=${encodeURIComponent(v)}`)
    $("aTable").innerHTML = activityTable(r.events)
  }
}

// ---------- integrations ----------
async function renderIntegrations(main: HTMLElement): Promise<void> {
  const integ = await api(`/api/projects/${PID}/integrations`)
  const caps = await api(`/api/projects/${PID}/capabilities`)
  const doctor = await api(`/api/projects/${PID}/doctor`)
  const adapters = integ.adapters ?? []
  const sync = integ.sync ?? {}
  const fresh = integ.freshness ?? {}
  const capRows = Object.values(caps.capabilities ?? {}).map((c: any) => `<tr>
    <td><b>${esc(c.id)}</b></td><td>${chip(c.status)}</td><td class="mono">${esc(c.adapterId ?? "—")}</td>
    <td>${esc(c.confidence)}</td><td class="mono">${ago(c.lastSyncAt)}</td>
    <td class="reason">${(c.limitations ?? []).map(esc).join("; ") || "—"}</td></tr>`).join("")
  const rec = integ.lastReconciliation
  main.innerHTML = `<h2>${esc(t("nav.integrations"))}</h2>
  <div class="filterbar">
    <button class="btn" id="iDiscover">${esc(t("c.discover"))}</button>
    <button class="btn" id="iSync">${esc(t("h.sync"))}</button>
    <button class="btn" id="iReconcile">${esc(t("c.reconcile"))}</button>
    <button class="btn" id="iDiff">${esc(t("c.integrationDiff"))}</button>
    <span class="muted">${esc(t("c.doctor"))}: ${doctor.healthy ? `<span style="color:#22c55e">${esc(t("c.healthy"))}</span>` : `<span style="color:#f59e0b">${esc(t("c.issuesFound"))}</span>`}</span>
  </div>
  <h3>${esc(t("c.discoveredHarness"))}</h3>
  <p class="mono">${(integ.discovery?.detectedTools ?? []).map(esc).join(" · ") || esc(t("c.notDiscovered"))}</p>
  <h3>${esc(t("c.adapters"))}</h3>
  <table><tr><th>${esc(t("c.adapter"))}</th><th>${esc(t("c.kind"))}</th><th>${esc(t("c.version"))}</th><th>${esc(t("c.capabilities"))}</th><th>${esc(t("c.syncState"))}</th><th>${esc(t("c.lastSuccess"))}</th><th>${esc(t("c.errors"))}</th></tr>
  ${adapters.map((a: Json) => {
    const s = sync[a.id] ?? {}, f = fresh[a.id] ?? {}
    return `<tr><td><b>${esc(a.id)}</b><div class="amuted">${esc(a.title)}</div></td><td>${esc(a.kind)}</td><td class="mono">${esc(a.version)}</td>
    <td class="mono">${(a.capabilities ?? []).map(esc).join(", ")}</td>
    <td>${chip(s.state ?? "never")}${f.stale ? ` <span class="stalewarn">${esc(t("c.stale"))}</span>` : ""}</td>
    <td class="mono">${ago(s.lastSuccessAt)}</td><td>${s.errors?.length ?? 0}</td></tr>`
  }).join("")}</table>
  <h3>${esc(t("c.capMatrix"))}</h3>
  <table><tr><th>${esc(t("c.capability"))}</th><th>${esc(t("c.status"))}</th><th>${esc(t("c.adapter"))}</th><th>${esc(t("c.confidence"))}</th><th>${esc(t("c.lastSync"))}</th><th>${esc(t("c.limitations"))}</th></tr>${capRows}</table>
  <h3>${esc(t("c.doctorChecks"))}</h3>
  <table><tr><th>${esc(t("c.check"))}</th><th>${esc(t("c.result"))}</th><th>${esc(t("c.detail"))}</th></tr>
  ${doctor.checks.map((c: Json) => `<tr><td>${esc(c.name)}</td><td>${c.ok ? '<span style="color:#22c55e">✓</span>' : '<span style="color:#ef4444">✗</span>'}</td><td class="reason">${esc(c.detail)}</td></tr>`).join("")}</table>
  ${doctor.recommendations.length ? `<h3>${esc(t("c.recommendations"))}</h3>${doctor.recommendations.map((r: string) => `<div class="alert info">${esc(r)}</div>`).join("")}` : ""}
  ${rec ? `<h3>${esc(t("c.lastReconciliation"))} (${fmtTime(rec.at)})</h3>
    <p class="muted">${esc(t("c.driftChanges"))}: ${rec.drift?.changes?.length ?? 0} · ${esc(t("c.manifestUpdated"))}: ${rec.manifestUpdated} · ${esc(t("c.verified"))}: ${rec.verified}</p>
    ${(rec.actions ?? []).map((a: Json) => `<div class="hist">${chip(a.category === "A" ? "success" : a.category === "B" ? "waiting" : "failed", "cat " + a.category)} <b>${esc(a.action)}</b> ${esc(a.target)} — ${esc(t(a.applied ? "c.applied" : a.requiresApproval ? "c.needsApproval" : "c.pending"))}<div class="amuted">${esc(a.detail)}</div></div>`).join("")}` : ""}
  <div id="iResult"></div>`
  const showResult = (v: unknown) => { $("iResult").innerHTML = `<h3>${esc(t("c.result"))}</h3><pre class="json">${esc(JSON.stringify(v, null, 2).slice(0, 6000))}</pre>` }
  $("iDiscover").onclick = async () => showResult(await api(`/api/projects/${PID}/discover`, "POST"))
  $("iSync").onclick = async () => showResult(await api(`/api/projects/${PID}/sync`, "POST"))
  $("iReconcile").onclick = async () => showResult(await api(`/api/projects/${PID}/reconcile`, "POST", { approve: [] }))
  $("iDiff").onclick = async () => showResult(await api(`/api/projects/${PID}/integration/diff`))
}

// ---------- settings ----------
async function renderSettings(main: HTMLElement): Promise<void> {
  const ov = await api(`/api/projects/${PID}`)
  const cfg = await api(`/api/projects/${PID}/dashboard-config`)
  main.innerHTML = `<h2>${esc(t("nav.settings"))}</h2>
  <h3>${esc(t("c.language"))}</h3>
  <div class="filterbar">
    <select id="langSel">
      <option value="en" ${LANG === "en" ? "selected" : ""}>${esc(t("c.langEn"))}</option>
      <option value="ru" ${LANG === "ru" ? "selected" : ""}>${esc(t("c.langRu"))}</option>
    </select>
  </div>
  <p class="muted">${esc(t("c.languageNote"))}</p>
  <h3>${esc(t("c.project"))}</h3>
  <div class="kvgrid">
    <div><b>${esc(t("c.id"))}</b> <span class="mono">${esc(ov.project?.id)}</span></div>
    <div><b>${esc(t("c.name"))}</b> ${esc(ov.project?.name)}</div>
    <div><b>Root</b> <span class="mono" title="${esc(ov.project?.root)}">…/${esc(String(ov.project?.root ?? "").split(/[\\/]/).filter(Boolean).slice(-2).join("/"))}</span></div>
    <div><b>${esc(t("c.registered"))}</b> ${fmtTime(ov.project?.registeredAt)}</div>
    <div><b>${esc(t("h.core"))}</b> ${esc(ov.project?.coreVersion)} · <b>${esc(t("c.plugin"))}</b> ${esc(ov.project?.pluginVersion ?? t("c.notConnected"))}</div>
  </div>
  <h3>${esc(t("c.dashboardConfig"))}</h3>
  <pre class="json">${esc(JSON.stringify(cfg.sections.map((s: Json) => ({ id: s.id, visible: s.visible, mode: s.mode })), null, 2))}</pre>
  <p class="muted">${esc(t("c.configNote"))}</p>`
  $("langSel").onchange = () => setLang(($("langSel") as HTMLSelectElement).value as Lang)
}

// ---------- router ----------
window.addEventListener("hashchange", () => renderSection())
boot().catch(e => { $("app").innerHTML = `<div class="error">${esc(t("c.error"))}: ${esc(e.message)}</div>` })
