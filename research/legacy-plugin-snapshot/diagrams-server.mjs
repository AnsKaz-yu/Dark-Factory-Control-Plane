// diagrams-server.mjs — сервер C4-модели LikeC4 для дашборда (рендер диаграмм на клиенте).
// Порт 8092, CORS. Отдаёт модель LikeC4 (views/elements/relations) из architecture/dist/model.json.
// Детекция C4: если модели нет → {available:false} (дашборд покажет заглушку).
// Запуск: node diagrams-server.mjs (рядом с дашбордом 8091). НЕ копирует картинки — рендер из модели.
import { createServer } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..", "..") // корень workspace (с ReservoirOS/ и ReservoirOS-harness/)
const MODEL = join(ROOT, "ReservoirOS", "architecture", "dist", "model.json")
const PORT = 8092

// component → C4 view (для авто-выбора диаграммы при навигации)
const MAPPING = {
  "reservoiros": ["c1-context", "c2-containers"],
  "reservoiros.engine": ["c3-engine"],
  "reservoiros.engine.core": ["c4-core"],
  "reservoiros.engine.solver": ["c4-solver"],
  "reservoiros.engine.physics": ["c4-physics"],
  "reservoiros.engine.io": ["c4-io"],
  "reservoiros.engine.parallel": ["c4-parallel"],
  "reservoiros.engine.gpu": ["c4-gpu"],
}

function readModel() {
  if (!existsSync(MODEL)) return null
  try {
    let m = JSON.parse(readFileSync(MODEL, "utf8"))
    if (Array.isArray(m)) m = m[0]
    return m
  } catch { return null }
}

const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0]
  res.setHeader("Access-Control-Allow-Origin", "*")
  if (url === "/" || url === "/c4") {
    const m = readModel()
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    if (m && m.views) {
      res.end(JSON.stringify({ available: true, projectId: m.projectId, views: m.views, elements: m.elements, relations: m.relations, mapping: MAPPING }))
    } else {
      res.end(JSON.stringify({ available: false, message: "C4-документация не найдена. Если в проекте появится C4 (LikeC4), здесь появятся UML-диаграммы компонентов." }))
    }
  } else { res.writeHead(404); res.end("not found") }
})
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[c4] model server at http://127.0.0.1:${PORT}/ (model: ${MODEL}, exists: ${existsSync(MODEL)})`)
})