// test_state_io.js — unit-тест безопасной загрузки состояния (T-STATE-SYNC/T-STATE-RECOVERY).
// Запуск: node plugin/reservoiros-dashboard/tests/test_state_io.js
// Проверяет: BOM-tolerant парсинг; NON-DESTRUCTIVE recovery (backup+journal вместо молчаливого
// re-seed); отсутствие потери данных при повреждении; нормальный seed для нового файла.
"use strict";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripBom, decideRecovery, loadStateSafe } from "../state-io.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok - " + name); }
  catch (e) { console.error("  FAIL - " + name + "\n    " + (e && e.stack || e)); process.exitCode = 1; }
}

// io-адаптер над реальным fs во временном каталоге.
function makeIo(dir, seedObj) {
  const journal = [];
  return {
    journal,
    io: {
      exists: (p) => fs.existsSync(p),
      read: (p) => fs.readFileSync(p, "utf8"),
      rename: (a, b) => fs.renameSync(a, b),
      write: (p, data) => fs.writeFileSync(p, data, "utf8"),
      mkdirp: (p) => fs.mkdirSync(path.dirname(p), { recursive: true }),
      seed: () => JSON.parse(JSON.stringify(seedObj)),
      journal: (e) => { journal.push(e); fs.appendFileSync(path.join(dir, "journal.jsonl"), JSON.stringify(e) + "\n"); },
      now: () => "2026-11-17T23-59-59-000Z",
    },
  };
}

console.log("test_state_io:");

test("stripBom removes U+FEFF", () => {
  assert.strictEqual(stripBom("\uFEFF{\"a\":1}"), "{\"a\":1}");
  assert.strictEqual(stripBom("{\"a\":1}"), "{\"a\":1}");
});

test("decideRecovery parses valid JSON with and without BOM", () => {
  assert.deepStrictEqual(decideRecovery("\uFEFF{\"a\":1}"), { ok: true, state: { a: 1 } });
  assert.deepStrictEqual(decideRecovery("{\"a\":1}"), { ok: true, state: { a: 1 } });
});

test("decideRecovery flags corrupt content (ok=false)", () => {
  const r = decideRecovery("{not json");
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error === "string" && r.error.length > 0);
});

test("loadStateSafe: existing valid file WITH BOM is parsed, no reseed/backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-io-"));
  const p = path.join(dir, "project-state.json");
  fs.writeFileSync(p, "\uFEFF" + JSON.stringify({ tasks: { T1: { status: "done" } } }), "utf8");
  const { io, journal } = makeIo(dir, { tasks: {} });
  const s = loadStateSafe(io, p);
  assert.strictEqual(s.tasks.T1.status, "done");          // данные сохранены (BOM не сломал)
  assert.strictEqual(journal.length, 0);                  // re-seed не было
  assert.ok(!fs.existsSync(p + ".corrupt-2026-11-17T23-59-59-000Z")); // backup не создан
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadStateSafe: corrupt existing file -> backup preserved + journal + reseed (NON-DESTRUCTIVE)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-io-"));
  const p = path.join(dir, "project-state.json");
  const corrupt = "\uFEFF{tasks: BROKEN";   // BOM + невалидный JSON (инцидент T-020)
  fs.writeFileSync(p, corrupt, "utf8");
  const { io, journal } = makeIo(dir, { tasks: { SEED: {} } });
  const s = loadStateSafe(io, p);
  const bak = p + ".corrupt-2026-11-17T23-59-59-000Z";
  assert.ok(fs.existsSync(bak), "backup должен существовать");
  assert.strictEqual(fs.readFileSync(bak, "utf8"), corrupt);  // оригинал восстановим
  assert.strictEqual(journal.length, 1);                       // событие зафиксировано
  assert.strictEqual(journal[0].event, "state.corrupt-reseed");
  assert.strictEqual(journal[0].backup, bak);
  assert.ok(s.tasks.SEED, "re-seed произошёл (после backup)");
  assert.ok(fs.existsSync(p), "новый state записан");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadStateSafe: missing file -> seed, no backup/journal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-io-"));
  const p = path.join(dir, "project-state.json");
  const { io, journal } = makeIo(dir, { tasks: { SEED: {} } });
  const s = loadStateSafe(io, p);
  assert.ok(s.tasks.SEED);
  assert.ok(s.updated, "updated timestamp проставлен");
  assert.strictEqual(journal.length, 0);
  assert.ok(fs.existsSync(p));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(passed + " passed" + (process.exitCode ? " (WITH FAILURES)" : ""));
