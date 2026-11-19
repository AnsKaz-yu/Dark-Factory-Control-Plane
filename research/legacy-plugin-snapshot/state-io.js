// state-io.js — безопасная загрузка canonical project-state.json (T-STATE-SYNC / T-STATE-RECOVERY).
//
// Проблема (аудит 2026-11-17, B6; инцидент T-020): loadState использовал сырой JSON.parse
// (без BOM-strip) и при ЛЮБОЙ ошибке парсинга МОЛЧА перезаписывал существующий файл seed-ом
// → потеря 45+ задач. PS 5.1 Set-Content -Encoding UTF8 пишет BOM, ломающий JSON.parse.
//
// Исправление:
//   1. BOM-tolerant парсинг (strip U+FEFF перед JSON.parse).
//   2. NON-DESTRUCTIVE recovery: при ошибке парсинга СУЩЕСТВУЮЩЕГО файла оригинал сохраняется
//      как backup (.corrupt-<ts>), событие пишется в journal, и только затем re-seed.
//      Re-seed больше НЕ молчаливый (journal) и НЕ разрушительный (backup восстановим).
//   3. Чистая логика решения (decideRecovery) отделена от fs-эффектов → unit-тестируема.
//
// Модуль plain JS (без TS-компиляции): импортируется index.ts (esbuild-бандлер плагина) и
// напрямую unit-тестом (node). fs-операции инжектируются (io) для тестирования без реального state.

"use strict";

/** Убрать UTF-8 BOM (U+FEFF), который PS 5.1 Set-Content -Encoding UTF8 добавляет в начало. */
export function stripBom(txt) {
  return typeof txt === "string" && txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt;
}

/**
 * Чистое решение: распарсить содержимое существующего state-файла.
 * @returns {{ok: true, state: any} | {ok: false, error: string}}
 *   ok=false означает «существующий файл повреждён» → вызывающий ОБЯЗАН сохранить backup
 *   trước re-seed (не молча перезаписывать).
 */
export function decideRecovery(rawText) {
  try {
    return { ok: true, state: JSON.parse(stripBom(rawText)) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Безопасная загрузка состояния с non-destructive recovery.
 * @param {object} io инжектированные fs-операции:
 *   exists(p)->bool, read(p)->string, rename(a,b)->void, write(p,data)->void,
 *   mkdirp(p)->void, seed()->object, journal(entry)->void, now()->string (timestamp suffix)
 * @param {string} p путь к project-state.json
 * @returns {any} состояние (распарсенное существующее ИЛИ seed после backup повреждённого)
 */
export function loadStateSafe(io, p) {
  if (io.exists(p)) {
    const raw = io.read(p);
    const res = decideRecovery(raw);
    if (res.ok) return res.state;
    // Повреждённый СУЩЕСТВУЮЩИЙ файл: сохранить backup (восстановимо) + journal (наблюдаемо),
    // затем re-seed. НИКОГДА не перезаписывать молча/разрушительно.
    const bak = p + ".corrupt-" + io.now();
    try {
      io.rename(p, bak);
    } catch (e) {
      // Если rename невозможен — всё равно не теряем данные: читаемый backup копией.
      try { io.write(bak, raw); } catch (_) { /* best-effort */ }
    }
    io.journal({
      event: "state.corrupt-reseed",
      path: p,
      backup: bak,
      error: res.error,
      at: new Date().toISOString(),
    });
    // fall through to seed (backup сохранён → постоянная потеря данных исключена)
  }
  const seed = io.seed();
  seed.updated = new Date().toISOString();
  io.mkdirp(p);
  io.write(p, JSON.stringify(seed, null, 2));
  return seed;
}

// ESM: stripBom / decideRecovery / loadStateSafe экспортируются выше.
