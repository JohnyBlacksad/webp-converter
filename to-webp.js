#!/usr/bin/env node
/**
 * Конвертация изображений в WebP.
 *
 * Использование:
 *   node to-webp.js <входная_папка> <выходная_папка> [опции]
 *
 * Примеры:
 *   node to-webp.js ./images ./webp
 *   node to-webp.js ./images ./webp --quality 90
 *   node to-webp.js ./images ./webp --lossless
 *   node to-webp.js ./images ./webp --lossless --overwrite --concurrency 4
 *
 * Опции:
 *   --quality N        Качество 1-100 (по умолчанию 90). Игнорируется при --lossless.
 *   --lossless         Сжатие без потерь (хорошо для скриншотов, иконок, PNG-графики).
 *   --overwrite        Перезаписывать существующие .webp
 *   --concurrency N    Сколько файлов обрабатывать параллельно (по умолчанию 4)
 *   --quiet            Меньше вывода в консоль
 *   --help             Показать справку
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// ---------- Разбор аргументов ----------

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        input: null,
        output: null,
        quality: 90,
        lossless: false,
        overwrite: false,
        concurrency: 4,
        quiet: false,
    };

    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        switch (a) {
            case '--quality':
                opts.quality = parseInt(args[++i], 10);
                if (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100) {
                    throw new Error('--quality должен быть числом от 1 до 100');
                }
                break;
            case '--lossless':
                opts.lossless = true;
                break;
            case '--overwrite':
                opts.overwrite = true;
                break;
            case '--concurrency':
                opts.concurrency = parseInt(args[++i], 10);
                if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
                    throw new Error('--concurrency должен быть положительным числом');
                }
                break;
            case '--quiet':
                opts.quiet = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
            default:
                if (a.startsWith('--')) {
                    throw new Error(`Неизвестная опция: ${a}`);
                }
                positional.push(a);
        }
    }

    opts.input = positional[0];
    opts.output = positional[1];

    if (!opts.input || !opts.output) {
        printHelp();
        process.exit(1);
    }

    return opts;
}

function printHelp() {
    console.log(`
Конвертация изображений в WebP.

Использование:
  node to-webp.js <входная_папка> <выходная_папка> [опции]

Опции:
  --quality N        Качество 1-100 (по умолчанию 90)
  --lossless         Без потерь (для скриншотов/графики)
  --overwrite        Перезаписывать существующие .webp
  --concurrency N    Параллельных задач (по умолчанию 4)
  --quiet            Меньше вывода
  --help, -h         Эта справка

Примеры:
  node to-webp.js ./images ./webp
  node to-webp.js ./images ./webp --quality 85
  node to-webp.js ./images ./webp --lossless --overwrite
`);
}

// ---------- Обход файлов ----------

const SUPPORTED_EXTS = new Set([
    '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.gif', '.avif', '.heic', '.heif', '.svg'
]);

async function collectImages(dir) {
    const result = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...await collectImages(full));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_EXTS.has(ext)) result.push(full);
        }
    }

    return result;
}

// ---------- Конвертация одного файла ----------

async function convertOne(srcPath, inputRoot, outputRoot, opts) {
    const rel = path.relative(inputRoot, srcPath);
    const relDir = path.dirname(rel);
    const baseName = path.basename(rel, path.extname(rel));

    const outDir = path.join(outputRoot, relDir);
    const outPath = path.join(outDir, baseName + '.webp');

    await fsp.mkdir(outDir, { recursive: true });

    if (!opts.overwrite) {
        try {
            await fsp.access(outPath);
            // Файл существует
            return { status: 'skip', srcPath, outPath };
        } catch {
            // Не существует — идём дальше
        }
    }

    const pipeline = sharp(srcPath, { animated: true, failOn: 'none' });

    if (opts.lossless) {
        await pipeline.webp({ lossless: true, effort: 6 }).toFile(outPath);
    } else {
        await pipeline.webp({ quality: opts.quality, effort: 4 }).toFile(outPath);
    }

    return { status: 'ok', srcPath, outPath };
}

// ---------- Пул воркеров ----------

async function runPool(tasks, concurrency, worker) {
    let index = 0;
    let active = 0;
    let resolved = 0;

    return new Promise((resolve) => {
        const next = () => {
            if (index >= tasks.length && active === 0) return resolve();
            while (active < concurrency && index < tasks.length) {
                const task = tasks[index++];
                active++;
                worker(task).finally(() => {
                    active--;
                    resolved++;
                    next();
                });
            }
        };
        next();
    });
}

// ---------- main ----------

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv);
    } catch (e) {
        console.error('Ошибка аргументов:', e.message);
        process.exit(1);
    }

    const inputDir = path.resolve(opts.input);
    const outputDir = path.resolve(opts.output);

    // Проверяем вход
    let stat;
    try {
        stat = await fsp.stat(inputDir);
    } catch {
        console.error(`Входная папка не найдена: ${inputDir}`);
        process.exit(1);
    }
    if (!stat.isDirectory()) {
        console.error(`Входной путь не является папкой: ${inputDir}`);
        process.exit(1);
    }

    // Создаём выходную папку
    await fsp.mkdir(outputDir, { recursive: true });

    const log = opts.quiet ? () => {} : (...a) => console.log(...a);

    log(`Вход:  ${inputDir}`);
    log(`Выход: ${outputDir}`);
    log(`Режим: ${opts.lossless ? 'lossless' : `quality=${opts.quality}`}`);
    log(`Параллельно: ${opts.concurrency}`);
    log('');

    const files = await collectImages(inputDir);

    if (files.length === 0) {
        log('Изображений не найдено.');
        return;
    }

    log(`Найдено файлов: ${files.length}\n`);

    let ok = 0, skipped = 0, failed = 0;
    const startTime = Date.now();

    await runPool(files, opts.concurrency, async (file) => {
        try {
            const r = await convertOne(file, inputDir, outputDir, opts);
            if (r.status === 'ok') {
                ok++;
                log(`[ok]   ${path.relative(inputDir, r.srcPath)}  ->  ${path.relative(outputDir, r.outPath)}`);
            } else {
                skipped++;
                log(`[skip] ${path.relative(inputDir, r.srcPath)}  (уже есть)`);
            }
        } catch (e) {
            failed++;
            console.error(`[fail] ${path.relative(inputDir, file)}: ${e.message}`);
        }
    });

    const dt = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log(`Готово за ${dt} с.`);
    console.log(`  Успешно:     ${ok}`);
    console.log(`  Пропущено:   ${skipped}`);
    console.log(`  Ошибок:      ${failed}`);
}

main().catch((e) => {
    console.error('Критическая ошибка:', e);
    process.exit(1);
});