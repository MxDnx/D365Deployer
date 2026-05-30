"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPac = runPac;
exports.runDotnet = runDotnet;
exports.runNpmScript = runNpmScript;
exports.collectTsFiles = collectTsFiles;
exports.collectJsFiles = collectJsFiles;
exports.collectStaticFiles = collectStaticFiles;
const fs = require("fs");
const path = require("path");
const child_process_1 = require("child_process");
// ---------------------------------------------------------------------------
// PAC CLI
// ---------------------------------------------------------------------------
function runPac(args, cwd, log) {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const [cmd, cmdArgs] = isWindows
            ? ['cmd.exe', ['/c', 'pac', ...args]]
            : ['pac', args];
        const proc = (0, child_process_1.spawn)(cmd, cmdArgs, { cwd, shell: false });
        proc.stdout.on('data', (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) {
                    log(line);
                }
            }
        });
        proc.stderr.on('data', (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) {
                    log(line);
                }
            }
        });
        proc.on('close', (code) => resolve(code ?? 0));
    });
}
// ---------------------------------------------------------------------------
// dotnet CLI runner
// ---------------------------------------------------------------------------
function runDotnet(args, cwd, log) {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const [cmd, cmdArgs] = isWindows
            ? ['cmd.exe', ['/c', 'dotnet', ...args]]
            : ['dotnet', args];
        const proc = (0, child_process_1.spawn)(cmd, cmdArgs, { cwd, shell: false });
        proc.stdout.on('data', (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) {
                    log(line);
                }
            }
        });
        proc.stderr.on('data', (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) {
                    log(line);
                }
            }
        });
        proc.on('close', (code) => resolve(code ?? 0));
    });
}
// ---------------------------------------------------------------------------
// npm script runner
// ---------------------------------------------------------------------------
function runNpmScript(script, cwd, log) {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const [cmd, cmdArgs] = isWindows
            ? ['cmd.exe', ['/c', 'npm', 'run', script]]
            : ['npm', ['run', script]];
        const proc = (0, child_process_1.spawn)(cmd, cmdArgs, { cwd, shell: false });
        proc.stdout.on('data', (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) {
                    log(line);
                }
            }
        });
        proc.stderr.on('data', (data) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) {
                    log(line);
                }
            }
        });
        proc.on('close', (code) => resolve(code ?? 0));
    });
}
// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------
function collectTsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTsFiles(fullPath));
        }
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            results.push(fullPath);
        }
    }
    return results;
}
function collectJsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectJsFiles(fullPath));
        }
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            results.push(fullPath);
        }
    }
    return results;
}
function collectStaticFiles(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectStaticFiles(fullPath));
        }
        else if (entry.isFile()) {
            results.push(fullPath);
        }
    }
    return results;
}
//# sourceMappingURL=pac.js.map