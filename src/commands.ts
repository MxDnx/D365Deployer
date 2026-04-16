import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadSettings, checkSettingsReady, SETTINGS_FILENAME } from './settings';
import { generateSolutionXml, syncSolutionWebResources, CUSTOMIZATIONS_TEMPLATE, RELATIONSHIPS_TEMPLATE } from './solution-xml';
import { runPac, runNpmScript, runDotnet, collectJsFiles, collectStaticFiles } from './pac';

// ---------------------------------------------------------------------------
// Deploy a single file
// ---------------------------------------------------------------------------

export async function deployFile(sourceFile: string, workspaceRoot: string, log: (msg: string) => void): Promise<void> {
    const settings = loadSettings(workspaceRoot, log);

    if (settings.preDeploymentLocalScript) {
        log(`Pre-deploy: npm run ${settings.preDeploymentLocalScript}`);
        const status = await runNpmScript(settings.preDeploymentLocalScript, workspaceRoot, log);
        if (status !== 0) {
            throw new Error(`Pre-deployment script "${settings.preDeploymentLocalScript}" failed (exit ${status})`);
        }
    }

    const srcDir = path.join(workspaceRoot, 'src');
    const distDir = path.join(workspaceRoot, 'dist');
    const relSourceFile = path.relative(workspaceRoot, sourceFile);
    const relToSrc = path.relative(srcDir, sourceFile);
    const isTypeScript = sourceFile.endsWith('.ts') && !sourceFile.endsWith('.d.ts');

    // 1. Resolve output path (no build — reads from dist)
    let relOutput: string;
    if (isTypeScript) {
        relOutput = relToSrc.replace(/\.ts$/, '.js');
    } else {
        log(`Copy: ${relSourceFile}`);
        relOutput = relToSrc;
        const destPath = path.join(distDir, relOutput);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(sourceFile, destPath);
    }

    const builtFile = path.join(distDir, relOutput);
    if (!fs.existsSync(builtFile)) {
        throw new Error(`File not found in dist: ${relOutput}\nRun a build first.`);
    }
    const builtMap = isTypeScript ? builtFile + '.map' : null;

    // 2. Prepare staging folder
    const stagingDir = prepareStagingDir(workspaceRoot, settings);

    // 3. Copy built file(s) into staging
    const prefix = `${settings.publisherPrefix}_`;
    const wrName = prefix + '/' + relOutput.replace(/\\/g, '/');
    const wrNames = [wrName];

    const stagingFilePath = path.join(stagingDir, 'WebResources', wrName);
    fs.mkdirSync(path.dirname(stagingFilePath), { recursive: true });
    fs.copyFileSync(builtFile, stagingFilePath);

    if (builtMap && fs.existsSync(builtMap)) {
        fs.copyFileSync(builtMap, stagingFilePath + '.map');
        wrNames.push(wrName + '.map');
    }

    // 4. Register web resources, pack, import
    await packAndImport(stagingDir, wrNames, settings.solutionUniqueName, workspaceRoot, log);
}

// ---------------------------------------------------------------------------
// Deploy all TypeScript files in src/
// ---------------------------------------------------------------------------

export async function deployAll(srcFolder: string, workspaceRoot: string, log: (msg: string) => void): Promise<void> {
    const settings = loadSettings(workspaceRoot, log);

    if (settings.preDeploymentLocalScript) {
        log(`Pre-deploy: npm run ${settings.preDeploymentLocalScript}`);
        const status = await runNpmScript(settings.preDeploymentLocalScript, workspaceRoot, log);
        if (status !== 0) {
            throw new Error(`Pre-deployment script "${settings.preDeploymentLocalScript}" failed (exit ${status})`);
        }
    }

    const distDir = path.join(workspaceRoot, 'dist');

    if (!fs.existsSync(distDir)) {
        throw new Error('dist/ folder not found. Run a build first.');
    }

    const jsFiles = collectJsFiles(distDir);

    if (jsFiles.length === 0) {
        throw new Error('No .js files found in dist/. Run a build first.');
    }

    log(`Found ${jsFiles.length} pre-built file(s) in dist/`);

    // 1. Prepare staging folder (no build step)
    const stagingDir = prepareStagingDir(workspaceRoot, settings);

    // 2. Copy all built files into staging
    const prefix = `${settings.publisherPrefix}_`;
    const wrNames: string[] = [];

    for (const jsFile of jsFiles) {
        const relJs = path.relative(distDir, jsFile);
        const builtMap = jsFile + '.map';
        const jsWrName = prefix + '/' + relJs.replace(/\\/g, '/');

        const stagingJsPath = path.join(stagingDir, 'WebResources', jsWrName);
        fs.mkdirSync(path.dirname(stagingJsPath), { recursive: true });
        fs.copyFileSync(jsFile, stagingJsPath);
        wrNames.push(jsWrName);

        if (fs.existsSync(builtMap)) {
            fs.copyFileSync(builtMap, stagingJsPath + '.map');
            wrNames.push(jsWrName + '.map');
        }
    }

    // 3. Copy static files from dist/static/
    const staticDir = path.join(distDir, 'static');
    const staticFiles = collectStaticFiles(staticDir);

    if (staticFiles.length > 0) {
        log(`Found ${staticFiles.length} static file(s) in dist/static/`);
        for (const staticFile of staticFiles) {
            const relStatic = path.relative(distDir, staticFile);
            const staticWrName = prefix + '/' + relStatic.replace(/\\/g, '/');
            const stagingStaticPath = path.join(stagingDir, 'WebResources', staticWrName);
            fs.mkdirSync(path.dirname(stagingStaticPath), { recursive: true });
            fs.copyFileSync(staticFile, stagingStaticPath);
            wrNames.push(staticWrName);
        }
    }

    // 4. Register web resources, pack, import
    await packAndImport(stagingDir, wrNames, settings.solutionUniqueName, workspaceRoot, log);
}

// ---------------------------------------------------------------------------
// Deploy Package to CRM via pac plugin push
// ---------------------------------------------------------------------------

export async function deployPackageToCrm(csprojPath: string, log: (msg: string) => void): Promise<void> {
    const content = fs.readFileSync(csprojPath, 'utf8');
    const match = content.match(/<PackagePluginId>\s*(.*?)\s*<\/PackagePluginId>/);
    if (!match || !match[1].trim()) {
        throw new Error(
            `PackagePluginId not found in ${path.basename(csprojPath)}.\n` +
            `Add the following inside a <PropertyGroup>:\n` +
            `  <PackagePluginId>your-plugin-id</PackagePluginId>`
        );
    }
    const pluginId = match[1].trim();
    const cwd = path.dirname(csprojPath);

    log(`dotnet build "${path.basename(csprojPath)}"`);
    const buildCode = await runDotnet(['build', csprojPath], cwd, log);
    if (buildCode !== 0) {
        throw new Error(`dotnet build failed (exit ${buildCode})`);
    }

    log(`pac plugin push --pluginId ${pluginId}`);
    const exitCode = await runPac(['plugin', 'push', '--pluginId', pluginId], cwd, log);
    if (exitCode !== 0) {
        throw new Error(`pac plugin push failed (exit ${exitCode})`);
    }
}

// ---------------------------------------------------------------------------
// Run diagnostics in the output panel
// ---------------------------------------------------------------------------

export function runDiagnose(output: vscode.OutputChannel): void {
    output.show(true);
    output.appendLine('');
    output.appendLine('=== D365 WebResource Deployer — Diagnostic ===');

    const folders = vscode.workspace.workspaceFolders ?? [];
    output.appendLine(`\nWorkspace folders (${folders.length}) :`);

    for (const f of folders) {
        output.appendLine(`  [${f.name}] ${f.uri.fsPath}`);
        const settingsPath = path.join(f.uri.fsPath, SETTINGS_FILENAME);
        const found = fs.existsSync(settingsPath);
        output.appendLine(`    settings file : ${found ? '✓ FOUND' : '✗ missing'} (${settingsPath})`);

        if (found) {
            try {
                const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                output.appendLine(`    → publisherName      : ${s.publisherName ?? '(empty)'}`);
                output.appendLine(`    → publisherPrefix    : ${s.publisherPrefix ?? '(empty)'}`);
                output.appendLine(`    → solutionUniqueName : ${s.solutionUniqueName ?? '(empty)'}`);
            } catch (e) {
                output.appendLine(`    → JSON PARSE ERROR : ${e}`);
            }
        }

        const cfg = vscode.workspace.getConfiguration('d365WebResourceDeployer', f.uri);
        output.appendLine(`    VS Code settings :`);
        output.appendLine(`    → publisherName      : "${cfg.get<string>('publisherName', '')}"`);
        output.appendLine(`    → publisherPrefix    : "${cfg.get<string>('publisherPrefix', '')}"`);
        output.appendLine(`    → solutionUniqueName : "${cfg.get<string>('solutionUniqueName', '')}"`);
    }

    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
        output.appendLine(`\nActive file : ${active.fsPath}`);
        const wf = vscode.workspace.getWorkspaceFolder(active);
        output.appendLine(`  Detected workspace folder : ${wf ? `[${wf.name}] ${wf.uri.fsPath}` : 'NONE — outside workspace!'}`);
    }

    output.appendLine(`\nOS platform : ${process.platform}`);
    output.appendLine('\n=== End diagnostic ===');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function prepareStagingDir(workspaceRoot: string, settings: ReturnType<typeof loadSettings>): string {
    const stagingDir = path.join(workspaceRoot, 'build', 'deploy-staging');
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const otherDir = path.join(stagingDir, 'Other');
    fs.mkdirSync(otherDir, { recursive: true });

    fs.writeFileSync(path.join(otherDir, 'Solution.xml'), generateSolutionXml(settings), 'utf8');
    fs.writeFileSync(path.join(otherDir, 'Customizations.xml'), CUSTOMIZATIONS_TEMPLATE, 'utf8');
    fs.writeFileSync(path.join(otherDir, 'Relationships.xml'), RELATIONSHIPS_TEMPLATE, 'utf8');

    return stagingDir;
}

async function packAndImport(
    stagingDir: string,
    wrNames: string[],
    solutionUniqueName: string,
    workspaceRoot: string,
    log: (msg: string) => void
): Promise<void> {
    // Register web resources in XMLs
    log('Registering web resources...');
    syncSolutionWebResources(stagingDir, wrNames);
    for (const name of wrNames) {
        log(`  [Solution XML]   ${name}`);
    }

    // Pack
    const buildDir = path.join(workspaceRoot, 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    const solutionZipPath = path.join(buildDir, `${solutionUniqueName}.zip`);

    log('Packing...');
    const packStatus = await runPac(
        ['solution', 'pack', '--folder', stagingDir, '--zipfile', solutionZipPath, '--packagetype', 'Unmanaged'],
        workspaceRoot,
        log
    );
    if (packStatus !== 0) {
        throw new Error(`pac pack failed (status ${packStatus})`);
    }

    // Import + publish
    log('Importing and publishing...');
    const importStatus = await runPac(
        ['solution', 'import', '--path', solutionZipPath, '--publish-changes'],
        workspaceRoot,
        log
    );
    if (importStatus !== 0) {
        throw new Error(`pac import failed (status ${importStatus})`);
    }

    log('\nDeployment complete.');
}

// Re-export for use in extension.ts
export { checkSettingsReady };
