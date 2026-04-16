import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';

// ---------------------------------------------------------------------------
// PAC CLI
// ---------------------------------------------------------------------------

export function runPac(args: string[], cwd: string, log: (msg: string) => void): Promise<number> {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const [cmd, cmdArgs]: [string, string[]] = isWindows
            ? ['cmd.exe', ['/c', 'pac', ...args]]
            : ['pac', args];

        const proc = spawn(cmd, cmdArgs, { cwd, shell: false });

        proc.stdout.on('data', (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) { log(line); }
            }
        });
        proc.stderr.on('data', (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) { log(line); }
            }
        });
        proc.on('close', (code) => resolve(code ?? 0));
    });
}

// ---------------------------------------------------------------------------
// dotnet CLI runner
// ---------------------------------------------------------------------------

export function runDotnet(args: string[], cwd: string, log: (msg: string) => void): Promise<number> {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const [cmd, cmdArgs]: [string, string[]] = isWindows
            ? ['cmd.exe', ['/c', 'dotnet', ...args]]
            : ['dotnet', args];

        const proc = spawn(cmd, cmdArgs, { cwd, shell: false });

        proc.stdout.on('data', (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) { log(line); }
            }
        });
        proc.stderr.on('data', (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) { log(line); }
            }
        });
        proc.on('close', (code) => resolve(code ?? 0));
    });
}

// ---------------------------------------------------------------------------
// npm script runner
// ---------------------------------------------------------------------------

export function runNpmScript(script: string, cwd: string, log: (msg: string) => void): Promise<number> {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const [cmd, cmdArgs]: [string, string[]] = isWindows
            ? ['cmd.exe', ['/c', 'npm', 'run', script]]
            : ['npm', ['run', script]];

        const proc = spawn(cmd, cmdArgs, { cwd, shell: false });

        proc.stdout.on('data', (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) { log(line); }
            }
        });
        proc.stderr.on('data', (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) { log(line); }
            }
        });
        proc.on('close', (code) => resolve(code ?? 0));
    });
}

// ---------------------------------------------------------------------------
// esbuild
// ---------------------------------------------------------------------------

export async function buildFiles(entryPoints: string[], srcDir: string, distDir: string): Promise<void> {
    await build({
        entryPoints,
        bundle: true,
        format: 'iife',
        legalComments: 'none',
        minify: false,
        outbase: srcDir,
        outdir: distDir,
        platform: 'browser',
        sourcemap: true,
        target: ['es2022'],
    });
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

export function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            results.push(fullPath);
        }
    }
    return results;
}

export function collectJsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectJsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            results.push(fullPath);
        }
    }
    return results;
}

export function collectStaticFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) { return []; }
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectStaticFiles(fullPath));
        } else if (entry.isFile()) {
            results.push(fullPath);
        }
    }
    return results;
}
