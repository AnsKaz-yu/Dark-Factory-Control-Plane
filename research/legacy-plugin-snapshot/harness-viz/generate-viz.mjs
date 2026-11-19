// generate-viz.mjs — генератор интерактивной HTML-визуализации harness.
// Чистая функция generateVizHtml(model) -> HTML-строка (self-contained, без внешних зависимостей).
// CLI: node generate-viz.mjs <harness-model.json> <out.html>

import { readFileSync, writeFileSync } from "node:fs";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const KIND_COLORS = {
  orchestration: "#3b82f6",
  step: "#64748b",
  gate: "#a855f7",
  ci: "#22c55e",
};
const KIND_LABELS = {
  orchestration: "оркестрация",
  step: "шаг",
  gate: "гейт",
  ci: "CI/CD",
};
const CAT_LABELS = {
  orchestration: "Оркестрация",
  documentation: "Документация",
  quality: "Качество / метрики",
  ci: "CI/CD",
  toolchain: "Toolchain",
};

// ФАКТИЧЕСКОЕ состояние («как есть и работает», а не «как должно быть по записям»).
const STATUS = {
  verified:       { label: "работает",    color: "#22c55e", desc: "проверено реальным прогоном" },
  partial:        { label: "частично",    color: "#f59e0b", desc: "работает частично / есть ограничения" },
  conditional:    { label: "условный",    color: "#38bdf8", desc: "реализован, но skip до появления кода/данных Phase 2" },
  vacuous:        { label: "пустой pass", color: "#fb923c", desc: "формально проходит, но реально ничего не проверяет (0 тестов/бенчей/pending)" },
  stub:           { label: "заглушка",    color: "#ef4444", desc: "не реализован (placeholder / hardcoded skip)" },
  "not-enforced": { label: "не enforced", color: "#ef4444", desc: "механизм описан, но фактически не применяется" },
};
function statusBadge(s) {
  if (!s) return "";
  const st = STATUS[s];
  if (!st) return `<span class="status-badge" style="--sc:#64748b" title="неизвестный статус">${esc(s)}</span>`;
  return `<span class="status-badge" style="--sc:${st.color}" title="${esc(st.desc)}">${esc(st.label)}</span>`;
}
function realitySummary(gates) {
  const counts = {};
  for (const g of gates || []) { const s = g.status || "unknown"; counts[s] = (counts[s] || 0) + 1; }
  const order = ["verified", "partial", "conditional", "vacuous", "stub", "not-enforced"];
  const chips = order.filter((k) => counts[k]).map((k) =>
    `<span class="reality-chip" style="--sc:${STATUS[k].color}"><b>${counts[k]}</b> ${esc(STATUS[k].label)}</span>`).join("");
  const unknown = counts.unknown ? `<span class="reality-chip" style="--sc:#64748b"><b>${counts.unknown}</b> без статуса</span>` : "";
  return chips + unknown;
}
function statusLegend() {
  return Object.entries(STATUS).map(([k, st]) =>
    `<span class="legend-item" title="${esc(st.desc)}"><span class="dot" style="background:${st.color}"></span>${esc(st.label)} — ${esc(st.desc)}</span>`).join("");
}

// Статус loop-шага ВЫВОДИТСЯ из статусов его гейтов (авто-соответствие разделу «Гейты качества»).
function expandGateRefs(ref) {
  const ids = [];
  for (const part of String(ref).split(",")) {
    const p = part.trim();
    const m = p.match(/^G(\d+)\s*-\s*G(\d+)$/);
    if (m) { for (let k = +m[1]; k <= +m[2]; k++) ids.push("G" + k); }
    else if (/^G\d+$/.test(p)) ids.push(p);
  }
  return ids;
}
function deriveLoopStatus(ref, gateMap) {
  const sts = expandGateRefs(ref).map((id) => gateMap[id]).filter(Boolean);
  if (!sts.length) return null;
  const bad = sts.find((s) => s === "stub" || s === "not-enforced" || s === "vacuous");
  if (bad) return bad;
  if (sts.every((s) => s === "verified")) return "verified";
  return "partial"; // часть гейтов работает, часть условна (skip до кода Phase 2)
}
function loopNode(n, i, arr, gateMap) {
  const color = KIND_COLORS[n.kind] || "#64748b";
  const status = (n.gate && gateMap) ? (deriveLoopStatus(n.gate, gateMap) || n.status) : n.status;
  const gateBadge = n.gate ? `<span class="gate-badge">${esc(n.gate)}</span>` : "";
  const toolBadge = n.tool ? `<span class="tool-badge">${esc(n.tool)}</span>` : "";
  const arrow = i < arr.length - 1 ? `<div class="arrow">→</div>` : `<div class="arrow loopback" title="цикл повторяется">↺</div>`;
  return `
    <div class="loop-item">
      <div class="loop-card" style="--c:${color}" data-gate="${esc(n.gate || "")}" tabindex="0">
        <div class="loop-kind" style="background:${color}">${esc(KIND_LABELS[n.kind] || n.kind)}</div>
        <div class="loop-title">${esc(n.label)} ${statusBadge(status)}</div>
        <div class="loop-detail">${esc(n.detail || "")}</div>
        ${n.note ? `<div class="loop-note">↳ ${esc(n.note)}</div>` : ""}
        <div class="loop-badges">${gateBadge}${toolBadge}</div>
      </div>
      ${arrow}
    </div>`;
}

function gateCard(g) {
  return `
    <div class="gate-card" id="gate-${esc(g.id)}" data-gate="${esc(g.id)}">
      <div class="gate-head"><span class="gate-id">${esc(g.id)}</span><span class="gate-name">${esc(g.name)}</span>${statusBadge(g.status)}</div>
      <div class="gate-row"><span class="k">Инструмент</span><span class="v">${esc(g.tool)}</span></div>
      <div class="gate-row"><span class="k">Порог</span><span class="v thr">${esc(g.threshold)}</span></div>
      <div class="gate-row"><span class="k">Когда</span><span class="v">${esc(g.when)}</span></div>
      ${g.note ? `<div class="gate-row reality"><span class="k">Фактически</span><span class="v">${esc(g.note)}</span></div>` : ""}
      <div class="gate-cmd"><code>${esc(g.command)}</code></div>
    </div>`;
}

function humanRow(h) {
  return `
    <div class="ctrl-row human">
      <span class="ctrl-id">${esc(h.id)}</span>
      <div class="ctrl-body"><div class="ctrl-name">${esc(h.name)} ${statusBadge(h.status)}</div>
      <div class="ctrl-meta">${esc(h.trigger)} · ${esc(h.who)}</div>
      ${h.note ? `<div class="ctrl-note">↳ ${esc(h.note)}</div>` : ""}</div>
    </div>`;
}

function detRow(g) {
  return `
    <div class="ctrl-row det" data-gate="${esc(g.id)}">
      <span class="ctrl-id">${esc(g.id)}</span>
      <div class="ctrl-body"><div class="ctrl-name">${esc(g.name)}</div>
      <div class="ctrl-meta">${esc(g.threshold)}</div></div>
      ${g.status ? statusBadge(g.status) : `<span class="auto-tag">auto</span>`}
    </div>`;
}

function toolCard(t) {
  const ver = t.version ? `<span class="tool-ver">v${esc(t.version)}</span>` : "";
  return `
    <div class="tool-card">
      <div class="tool-name">${esc(t.name)} ${ver} ${statusBadge(t.status)}</div>
      <div class="tool-role">${esc(t.role)}</div>
      ${t.note ? `<div class="tool-note">↳ ${esc(t.note)}</div>` : ""}
    </div>`;
}

export function generateVizHtml(model) {
  const m = model || {};
  const gateMap = {}; for (const g of m.gates || []) gateMap[g.id] = g.status;
  const loop = (m.loop || []).map((n, i, arr) => loopNode(n, i, arr, gateMap)).join("");
  const gates = (m.gates || []).map(gateCard).join("");
  const det = (m.gates || []).map(detRow).join("");
  const human = (m.humanControls || []).map(humanRow).join("");
  const principles = (m.principles || []).map((p) => `<li>${esc(p)}</li>`).join("");
  const realityChips = realitySummary(m.gates);
  const statusLegendHtml = statusLegend();
  const asOf = m.asOf ? ` · аудит ${esc(m.asOf)}` : "";
  const realityNote = m.realityNote || "Визуализация отражает фактическое рабочее состояние («как есть и работает»), а не только записи документации.";

  const cats = {};
  for (const t of m.tools || []) (cats[t.category] ||= []).push(t);
  const toolsHtml = Object.entries(cats)
    .map(
      ([cat, items]) => `
      <div class="tool-group">
        <div class="tool-group-title">${esc(CAT_LABELS[cat] || cat)}</div>
        <div class="tool-grid">${items.map(toolCard).join("")}</div>
      </div>`
    )
    .join("");

  const legend = Object.entries(KIND_LABELS)
    .map(([k, label]) => `<span class="legend-item"><span class="dot" style="background:${KIND_COLORS[k]}"></span>${esc(label)}</span>`)
    .join("");

  const metrics = m.metrics || {};
  const crap = metrics.crap || {};
  const acc = metrics.accuracy || {};
  const accRows = ["blackoil", "compositional", "thermal"]
    .filter((k) => acc[k])
    .map((k) => `<tr><td>${esc(k)}</td><td><code>${esc(acc[k])}</code></td></tr>`)
    .join("");

  const repos = m.repos || {};
  const repoHtml = Object.values(repos)
    .map((r) => `<div class="repo"><b>${esc(r.name)}</b><span>${esc(r.role)}</span></div>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title || "Harness")} — визуализация</title>
<style>
  :root{--bg:#0b1020;--panel:#141b2e;--panel2:#1c2540;--txt:#e6ebf5;--muted:#93a0bd;--line:#2a3554;--acc:#a855f7;}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#1a2340,#0b1020);color:var(--txt);
    font-family:'Segoe UI',system-ui,-apple-system,sans-serif;line-height:1.5;padding:32px 20px 80px}
  .wrap{max-width:1200px;margin:0 auto}
  header{margin-bottom:28px}
  h1{font-size:30px;margin:0 0 6px;font-weight:700}
  .subtitle{color:var(--muted);font-size:15px}
  .ver{display:inline-block;margin-top:10px;background:var(--panel2);border:1px solid var(--line);
    padding:3px 12px;border-radius:20px;font-size:12px;color:var(--muted)}
  h2{font-size:20px;margin:38px 0 16px;display:flex;align-items:center;gap:10px}
  h2 .num{display:inline-flex;width:28px;height:28px;border-radius:8px;background:var(--acc);
    align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff}
  .repos{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px}
  .repo{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 16px;flex:1;min-width:260px}
  .repo b{display:block;font-size:15px;margin-bottom:3px}
  .repo span{color:var(--muted);font-size:13px}
  .principles{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-top:16px}
  .principles ul{margin:0;padding-left:20px}.principles li{margin:5px 0;font-size:14px}
  .legend{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 16px;font-size:13px;color:var(--muted)}
  .legend-item{display:inline-flex;align-items:center;gap:7px}
  .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
  .loop{display:flex;flex-wrap:wrap;align-items:stretch;gap:4px}
  .loop-item{display:flex;align-items:center;gap:4px}
  .loop-card{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--c);
    border-radius:12px;padding:12px 14px;width:210px;min-height:120px;cursor:pointer;transition:.18s;position:relative}
  .loop-card:hover,.loop-card:focus{transform:translateY(-3px);border-color:var(--c);box-shadow:0 8px 24px rgba(0,0,0,.4);outline:none}
  .loop-card.highlight{border-color:var(--c);box-shadow:0 0 0 2px var(--c),0 8px 24px rgba(0,0,0,.5)}
  .loop-kind{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#fff;
    padding:2px 8px;border-radius:6px;margin-bottom:8px;font-weight:600}
  .loop-title{font-size:14px;font-weight:600;margin-bottom:5px}
  .loop-detail{font-size:12px;color:var(--muted)}
  .loop-badges{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
  .gate-badge{background:var(--acc);color:#fff;font-size:11px;font-weight:700;padding:1px 8px;border-radius:6px}
  .tool-badge{background:var(--panel2);border:1px solid var(--line);color:var(--muted);font-size:11px;padding:1px 8px;border-radius:6px}
  .arrow{font-size:22px;color:var(--muted);padding:0 2px;align-self:center}
  .arrow.loopback{color:var(--acc);font-size:26px;font-weight:700}
  .gates{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
  .gate-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;transition:.18s}
  .gate-card.highlight{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc)}
  .gate-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .gate-id{background:var(--acc);color:#fff;font-weight:700;font-size:14px;padding:3px 11px;border-radius:8px}
  .gate-name{font-size:16px;font-weight:600}
  .gate-row{display:flex;gap:10px;font-size:13px;margin:6px 0}
  .gate-row .k{color:var(--muted);min-width:88px;flex-shrink:0}
  .gate-row .v{color:var(--txt)}.gate-row .thr{color:#7dd3fc;font-weight:500}
  .gate-cmd{margin-top:10px;background:#0d1424;border:1px solid var(--line);border-radius:8px;padding:8px 10px}
  .gate-cmd code{font-size:12px;color:#a5f3fc;font-family:'Cascadia Code',Consolas,monospace}
  .controls{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:820px){.controls{grid-template-columns:1fr}}
  .ctrl-col{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
  .ctrl-col h3{margin:0 0 14px;font-size:15px;display:flex;align-items:center;gap:8px}
  .ctrl-col.det h3{color:#4ade80}.ctrl-col.human h3{color:#fbbf24}
  .ctrl-row{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:9px;margin:5px 0;background:var(--panel2)}
  .ctrl-row.det{cursor:pointer}.ctrl-row.det:hover{background:#22304f}
  .ctrl-id{font-weight:700;font-size:13px;padding:2px 9px;border-radius:6px;flex-shrink:0}
  .det .ctrl-id{background:#14532d;color:#4ade80}.human .ctrl-id{background:#78350f;color:#fbbf24}
  .ctrl-body{flex:1}.ctrl-name{font-size:14px;font-weight:500}.ctrl-meta{font-size:12px;color:var(--muted)}
  .auto-tag{font-size:10px;background:#14532d;color:#4ade80;padding:2px 8px;border-radius:6px;text-transform:uppercase;font-weight:600}
  .tool-group{margin-bottom:20px}
  .tool-group-title{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:10px;font-weight:600}
  .tool-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
  .tool-card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 15px}
  .tool-name{font-size:14px;font-weight:600;margin-bottom:4px}
  .tool-ver{font-size:11px;color:var(--muted);font-weight:400}
  .tool-role{font-size:12px;color:var(--muted)}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:820px){.metrics{grid-template-columns:1fr}}
  .metric{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
  .metric h3{margin:0 0 10px;font-size:15px}
  .formula{background:#0d1424;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-family:'Cascadia Code',Consolas,monospace;font-size:13px;color:#a5f3fc;margin-bottom:10px}
  .metric table{width:100%;border-collapse:collapse;font-size:13px}
  .metric td{padding:5px 8px;border-bottom:1px solid var(--line)}.metric td:first-child{color:var(--muted)}
  .pill{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:3px 10px;font-size:12px;margin:3px 4px 0 0}
  .pill b{color:#7dd3fc}
  footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
  .hint{font-size:12px;color:var(--muted);margin:-8px 0 14px}
  .status-badge{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;
    color:var(--sc);background:color-mix(in srgb,var(--sc) 16%,transparent);border:1px solid var(--sc);
    padding:1px 8px;border-radius:6px;vertical-align:middle;white-space:nowrap}
  .reality-banner{background:linear-gradient(135deg,#141b2e,#1a2340);border:1px solid var(--line);
    border-left:4px solid var(--acc);border-radius:14px;padding:16px 20px;margin-top:18px}
  .reality-title{font-size:16px;font-weight:700;margin-bottom:4px}
  .reality-note{font-size:13px;color:var(--muted);margin-bottom:12px}
  .reality-counts{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .reality-chip{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--txt);
    background:color-mix(in srgb,var(--sc) 14%,transparent);border:1px solid var(--sc);border-radius:20px;padding:3px 12px}
  .reality-chip b{color:var(--sc);font-size:15px}
  .reality-legend{margin:0;font-size:12px}
  .loop-note{font-size:11px;color:#fbbf24;margin-top:5px}
  .gate-row.reality .k{color:#fbbf24}.gate-row.reality .v{color:#fcd34d;font-size:12px}
  .ctrl-note{font-size:11px;color:#fbbf24;margin-top:2px}
  .tool-note{font-size:11px;color:#fbbf24;margin-top:4px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(m.title || "Harness")}</h1>
    <div class="subtitle">${esc(m.subtitle || "")}</div>
    <span class="ver">версия ${esc(m.version || "?")} · ${esc(m.generatedFrom || "")}</span>
    <div class="repos">${repoHtml}</div>
    <div class="principles"><ul>${principles}</ul></div>
  </header>

  <div class="reality-banner">
    <div class="reality-title">📊 Фактическое состояние${asOf}</div>
    <div class="reality-note">${esc(realityNote)}</div>
    <div class="reality-counts">${realityChips}</div>
    <div class="legend reality-legend">${statusLegendHtml}</div>
  </div>

  <h2><span class="num">1</span> Loop разработки</h2>
  <div class="legend">${legend}<span class="legend-item"><span class="dot" style="background:var(--acc)"></span>↺ — цикл повторяется для каждой задачи</span></div>
  <div class="hint">Кликните на шаг с гейтом — подсветится карточка гейта ниже.</div>
  <div class="loop">${loop}</div>

  <h2><span class="num">2</span> Гейты качества (детерминированные)</h2>
  <div class="hint">Бейдж показывает фактический статус гейта; строка «Фактически» — что реально проверено/ограничения.</div>
  <div class="gates">${gates}</div>

  <h2><span class="num">3</span> Точки контроля</h2>
  <div class="controls">
    <div class="ctrl-col det"><h3>⚙ Детерминированный контроль (автоматически)</h3>${det}</div>
    <div class="ctrl-col human"><h3>👤 Человеческий контроль</h3>${human}</div>
  </div>

  <h2><span class="num">4</span> Инструменты</h2>
  ${toolsHtml}

  <h2><span class="num">5</span> Ключевые метрики</h2>
  <div class="metrics">
    <div class="metric">
      <h3>CRAP (Change Risk Anti-Patterns)</h3>
      <div class="formula">${esc(crap.formula || "")}</div>
      <span class="pill">гейт <b>≤ ${esc(crap.threshold ?? 30)}</b></span>
      <span class="pill">цель <b>≤ ${esc(crap.target ?? 15)}</b></span>
    </div>
    <div class="metric">
      <h3>Точность vs эталон (max relative error)</h3>
      <table>${accRows}</table>
      <div style="margin-top:8px;font-size:12px;color:var(--muted)">${esc(acc.note || "")}</div>
    </div>
  </div>

  <footer>Сгенерировано плагином harness-viz из harness-model.json · ${esc(m.title || "")}</footer>
</div>
<script>
  // Подсветка связанных гейтов: клик по шагу loop или строке детерминированного контроля.
  function clearHl(){document.querySelectorAll('.highlight').forEach(e=>e.classList.remove('highlight'));}
  function hlGate(id){
    clearHl();
    if(!id) return;
    id.split('/').forEach(g=>{
      const card=document.getElementById('gate-'+g.trim());
      if(card){card.classList.add('highlight');card.scrollIntoView({behavior:'smooth',block:'center'});}
    });
    document.querySelectorAll('.loop-card[data-gate="'+id+'"]').forEach(e=>e.classList.add('highlight'));
  }
  document.querySelectorAll('.loop-card[data-gate]').forEach(el=>{
    if(!el.dataset.gate) return;
    el.addEventListener('click',()=>hlGate(el.dataset.gate));
    el.addEventListener('keydown',e=>{if(e.key==='Enter')hlGate(el.dataset.gate);});
  });
  document.querySelectorAll('.ctrl-row.det[data-gate]').forEach(el=>{
    el.addEventListener('click',()=>hlGate(el.dataset.gate));
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('.loop-card')&&!e.target.closest('.ctrl-row.det'))clearHl();
  });
</script>
</body>
</html>`;
}

// CLI
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("generate-viz.mjs");
if (isMain) {
  const [modelPath, outPath] = process.argv.slice(2);
  if (!modelPath || !outPath) {
    console.error("usage: node generate-viz.mjs <harness-model.json> <out.html>");
    process.exit(2);
  }
  const model = JSON.parse(readFileSync(modelPath, "utf8"));
  writeFileSync(outPath, generateVizHtml(model), "utf8");
  console.log(`visualization written: ${outPath}`);
}