import { Plugin } from "@opencode/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { generateVizHtml } from "./generate-viz.mjs"

// Поиск harness-model.json: override -> options.modelPath -> проект -> sibling ReservoirOS-harness.
function findModel(ctx: any, override?: string): string | null {
  const candidates: string[] = []
  if (override) candidates.push(override)
  if (ctx.options?.modelPath) candidates.push(ctx.options.modelPath)
  const dir = ctx.location?.directory
  if (dir) {
    candidates.push(join(dir, "harness-model.json"))
    candidates.push(join(dir, "ReservoirOS-harness", "harness-model.json"))
    candidates.push(join(dir, "..", "ReservoirOS-harness", "harness-model.json"))
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return resolve(c)
  }
  return null
}

function generate(ctx: any, input?: { modelPath?: string; outPath?: string }) {
  const modelPath = findModel(ctx, input?.modelPath)
  if (!modelPath) {
    return {
      content:
        "harness-model.json не найден. Укажите modelPath или разместите модель в проекте " +
        "(например ReservoirOS-harness/harness-model.json).",
    }
  }
  const model = JSON.parse(readFileSync(modelPath, "utf8"))
  const html = generateVizHtml(model)
  const outPath = input?.outPath
    ? resolve(input.outPath)
    : join(dirname(modelPath), "harness-viz.html")
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, html, "utf8")
  return {
    content:
      `Визуализация harness сгенерирована: ${outPath}\n` +
      `Модель: ${modelPath}\n` +
      `Гейтов: ${(model.gates || []).length}, шагов loop: ${(model.loop || []).length}, ` +
      `инструментов: ${(model.tools || []).length}, точек человеческого контроля: ${(model.humanControls || []).length}.\n` +
      `Откройте HTML в браузере (Review pane / browser.preview).`,
  }
}

export default Plugin.define({
  id: "harness-viz",
  async setup(ctx) {
    // Инструмент: harness_visualize
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "harness", description: "Harness visualization tools" })
      editor.add({
        name: "visualize",
        description:
          "Generate an interactive HTML visualization of the project harness: development loop, " +
          "all quality gates, tools, and deterministic/human control points. Reads harness-model.json.",
        input: {
          type: "object",
          properties: {
            modelPath: { type: "string", description: "Path to harness-model.json (optional; auto-detected in project)" },
            outPath: { type: "string", description: "Output HTML path (optional; default <modelDir>/harness-viz.html, committed to repo)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "harness", codemode: true },
        execute: async (input) => generate(ctx, input as any),
      })
    })

    // Команда: /harness-viz
    await ctx.command.transform((editor) => {
      editor.add({
        name: "harness-viz",
        description: "Generate the harness visualization (gates, development loop, tools, control points)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const res = generate(ctx, {})
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${res.content}\n\nОткрой сгенерированный HTML в Review pane (browser.preview) и кратко опиши визуализацию.`,
            delivery,
          })
        },
      })
    })
  },
})