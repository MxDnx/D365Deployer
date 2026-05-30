import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';
import { loadSettings, checkSettingsReady, SETTINGS_FILENAME } from './settings';
import { generateSolutionXml, syncSolutionWebResources, CUSTOMIZATIONS_TEMPLATE, RELATIONSHIPS_TEMPLATE } from './solution-xml';
import { runPac, runNpmScript, runDotnet, collectJsFiles, collectStaticFiles } from './pac';
import {
    PLUGIN_CONFIG_FILENAME, PluginDeploymentConfig, PluginEntry, StepEntry,
    findPluginConfigPath, loadPluginConfig, savePluginConfig, getPackageId, setPackageEntry,
} from './pluginConfig';

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

export async function deployAll(_srcFolder: string, workspaceRoot: string, log: (msg: string) => void): Promise<void> {
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
// Find all plugin projects in a directory tree
// ---------------------------------------------------------------------------

export interface PluginProject {
    label: string;
    description: string;
    csprojPath: string;
    pluginId: string;
}

export function findPluginProjects(rootPath: string): PluginProject[] {
    const configPath = findPluginConfigPath(rootPath);
    const config = configPath ? loadPluginConfig(configPath) : null;
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const results: PluginProject[] = [];

    function scan(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj') { continue; }
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.csproj')) {
                const projectName = path.basename(path.dirname(fullPath));
                const pluginId = config ? (getPackageId(config, projectName) ?? '') : '';
                if (pluginId && GUID_RE.test(pluginId)) {
                    const relDir = path.relative(rootPath, path.dirname(fullPath)) || projectName;
                    results.push({ label: relDir, description: pluginId, csprojPath: fullPath, pluginId });
                }
            }
        }
    }

    scan(rootPath);
    return results;
}

// ---------------------------------------------------------------------------
// Deploy Package to CRM via pac plugin push
// ---------------------------------------------------------------------------

export async function deployPackageToCrm(csprojPath: string, log: (msg: string) => void): Promise<void> {
    const projectName = path.basename(path.dirname(csprojPath));
    const configPath = findPluginConfigPath(csprojPath);
    if (!configPath) {
        throw new Error(
            `${PLUGIN_CONFIG_FILENAME} not found. Create it at your solution root with "prefix" and "plugins".`
        );
    }
    const config = loadPluginConfig(configPath);
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const pluginId = getPackageId(config, projectName) ?? '';

    if (!pluginId || !GUID_RE.test(pluginId)) {
        await createNewPluginPackage(csprojPath, configPath, config, log);
        return;
    }

    const cwd = path.dirname(csprojPath);

    log(`dotnet msbuild -t:Rebuild "${path.basename(csprojPath)}"`);
    const buildCode = await runDotnet(['msbuild', `-t:Rebuild`, csprojPath], cwd, log);
    if (buildCode !== 0) {
        throw new Error(`dotnet build failed (exit ${buildCode})`);
    }

    log(`pac plugin push --pluginId ${pluginId}`);
    const exitCode = await runPac(['plugin', 'push', '--pluginId', pluginId], cwd, log);
    if (exitCode !== 0) {
        const choice = await vscode.window.showWarningMessage(
            `Plugin push failed — the package ID "${pluginId}" may not exist in Dataverse. Create a new plugin package?`,
            { modal: true },
            'Create New Package'
        );
        if (choice !== 'Create New Package') {
            throw new Error(`pac plugin push failed (exit ${exitCode})`);
        }
        await createNewPluginPackage(csprojPath, configPath, config, log);
        return;
    }

    log('Refreshing plugin list...');
    try {
        const orgUrl = await getPacOrgUrl();
        const scope = `${orgUrl.replace(/\/$/, '')}/.default`;
        const session = await vscode.authentication.getSession('microsoft', [scope], { createIfNone: false });
        if (session && config.packages[projectName]) {
            const plugins = await fetchPluginAssemblies(orgUrl, session.accessToken, pluginId);
            config.packages[projectName].plugins = plugins;
            savePluginConfig(configPath, config);
            log(`  ${plugins.length} plugin(s) updated in ${PLUGIN_CONFIG_FILENAME}`);
        }
    } catch (err) {
        log(`  Could not refresh plugin list: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function createNewPluginPackage(
    csprojPath: string,
    configPath: string,
    config: PluginDeploymentConfig,
    log: (msg: string) => void
): Promise<void> {
    const projectName = path.basename(path.dirname(csprojPath));
    const prefix = config.prefix?.trim();
    if (!prefix) {
        throw new Error(`"prefix" not set in ${PLUGIN_CONFIG_FILENAME}.`);
    }
    const packageName = `${prefix}_${projectName}`;
    const cwd = path.dirname(csprojPath);

    log(`dotnet msbuild -t:Rebuild "${path.basename(csprojPath)}"`);
    const buildCode = await runDotnet(['msbuild', '-t:Rebuild', csprojPath], cwd, log);
    if (buildCode !== 0) {
        throw new Error(`dotnet build failed (exit ${buildCode})`);
    }

    const nupkgPath = findNupkg(cwd);
    if (!nupkgPath) {
        throw new Error('No .nupkg file found after build. Ensure your project produces a NuGet package.');
    }
    log(`Found package: ${path.basename(nupkgPath)}`);

    const orgUrl = await getPacOrgUrl();
    log(`Target environment: ${orgUrl}`);

    log('Authenticating with Dataverse...');
    const scope = `${orgUrl.replace(/\/$/, '')}/.default`;
    const session = await vscode.authentication.getSession('microsoft', [scope], { createIfNone: true });
    if (!session) {
        throw new Error('Authentication failed or was cancelled.');
    }

    const nupkgFilename = path.basename(nupkgPath);
    const versionFromFilename = nupkgFilename.match(/\.(\d+\.\d+(?:\.\d+)*)\.nupkg$/)?.[1] ?? '1.0.0.0';

    log(`Creating plugin package "${packageName}" v${versionFromFilename} in Dataverse...`);
    const packageContent = fs.readFileSync(nupkgPath).toString('base64');
    const packageId = await createPluginPackageRest(orgUrl, session.accessToken, packageName, versionFromFilename, packageContent);
    log(`  Package ID: ${packageId}`);

    setPackageEntry(configPath, config, projectName, packageName, packageId);

    log('Fetching registered plugin assemblies...');
    const plugins = await fetchPluginAssemblies(orgUrl, session.accessToken, packageId);
    if (plugins.length > 0 && config.packages[projectName]) {
        config.packages[projectName].plugins = plugins;
        savePluginConfig(configPath, config);
        for (const p of plugins) { log(`  Plugin: ${p.name} (${p.pluginId})`); }
    }

    log(`\nPlugin created successfully.`);
    log(`  ${projectName} → ${packageId} saved to ${PLUGIN_CONFIG_FILENAME}`);
    log('\nDeployment complete.');
}

function findNupkg(cwd: string): string | null {
    const dirs = [
        path.join(cwd, 'bin', 'Debug'),
        path.join(cwd, 'bin', 'Release'),
        path.join(cwd, 'bin'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) { continue; }
        const pkgs = fs.readdirSync(dir)
            .filter(f => f.endsWith('.nupkg'))
            .map(f => path.join(dir, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (pkgs.length > 0) { return pkgs[0]; }
    }
    return null;
}

interface RawImage {
    sdkmessageprocessingstepimageid: string;
    name: string;
    attributes?: string;
    imagetype: number; // 0=PreImage, 1=PostImage, 2=Both
}

interface RawStep {
    sdkmessageprocessingstepid: string;
    name: string;
    mode: number;
    stage: number;
    rank: number;
    filteringattributes?: string;
    sdkmessageprocessingstep_sdkmessageprocessingstepimage?: RawImage[];
}

async function fetchPluginAssemblies(orgUrl: string, token: string, packageId: string): Promise<PluginEntry[]> {
    const stepsExpand = 'plugintype_sdkmessageprocessingstep($select=sdkmessageprocessingstepid,name,mode,stage,rank,filteringattributes)';
    const typesExpand = `pluginassembly_plugintype($select=plugintypeid;$expand=${stepsExpand})`;
    const filter = encodeURIComponent(`_packageid_value eq '${packageId}'`);
    const query = `$filter=${filter}&$select=name,pluginassemblyid&$expand=${encodeURIComponent(typesExpand)}`;

    type RawAssembly = {
        name: string;
        pluginassemblyid: string;
        pluginassembly_plugintype?: { plugintype_sdkmessageprocessingstep?: RawStep[] }[];
    };

    const assembliesData = await dataverseGet(orgUrl, token, `api/data/v9.2/pluginassemblies?${query}`);
    const entries: PluginEntry[] = (assembliesData.value as RawAssembly[] ?? []).map((a) => {
        const rawSteps = (a.pluginassembly_plugintype ?? [])
            .flatMap(t => t.plugintype_sdkmessageprocessingstep ?? []);
        const steps: StepEntry[] = rawSteps.map(s => ({
            stepId: s.sdkmessageprocessingstepid,
            name: s.name,
            mode: s.mode,
            stage: s.stage,
            rank: s.rank,
            filteringAttributes: s.filteringattributes ?? '',
            preImages: [],
            postImages: [],
        }));
        return { name: a.name, pluginId: a.pluginassemblyid, steps };
    });

    const allStepIds = entries.flatMap(e => (e.steps ?? []).map(s => s.stepId));
    if (allStepIds.length > 0) {
        const imageFilter = allStepIds
            .map(id => `_sdkmessageprocessingstepid_value eq '${id}'`)
            .join(' or ');
        const imageQuery = `$filter=${encodeURIComponent(imageFilter)}&$select=sdkmessageprocessingstepimageid,name,attributes,imagetype,_sdkmessageprocessingstepid_value`;
        const imagesData = await dataverseGet(orgUrl, token, `api/data/v9.2/sdkmessageprocessingstepimages?${imageQuery}`);

        const stepMap = new Map<string, StepEntry>();
        for (const e of entries) {
            for (const s of e.steps ?? []) { stepMap.set(s.stepId, s); }
        }

        for (const i of (imagesData.value ?? []) as RawImage[]) {
            const step = stepMap.get((i as RawImage & { _sdkmessageprocessingstepid_value: string })._sdkmessageprocessingstepid_value);
            if (!step) { continue; }
            const image = { imageId: i.sdkmessageprocessingstepimageid, name: i.name, attributes: i.attributes ?? '' };
            if (i.imagetype === 0 || i.imagetype === 2) { step.preImages!.push(image); }
            if (i.imagetype === 1 || i.imagetype === 2) { step.postImages!.push(image); }
        }
    }

    return entries;
}

function dataverseGet(orgUrl: string, token: string, relativeUrl: string): Promise<{ value?: unknown[] }> {
    const apiUrl = new URL(relativeUrl, orgUrl);
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: apiUrl.hostname,
                path: apiUrl.pathname + apiUrl.search,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(data)); } catch { resolve({}); }
                    } else {
                        reject(new Error(`Failed to fetch plugin assemblies: ${res.statusCode} ${data}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function getPacOrgUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32';
        const [cmd, args]: [string, string[]] = isWindows
            ? ['cmd.exe', ['/c', 'pac', 'org', 'who']]
            : ['pac', ['org', 'who']];

        let output = '';
        const proc = spawn(cmd, args, { shell: false });
        proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });
        proc.on('close', (code: number) => {
            if (code !== 0) {
                reject(new Error('pac org who failed — ensure you are authenticated with PAC CLI.'));
                return;
            }
            const m = output.match(/Org URL:\s*(https:\/\/[^\s]+)/i);
            if (!m) {
                reject(new Error('Could not parse Org URL from pac org who output.'));
                return;
            }
            resolve(m[1].trim());
        });
    });
}

function createPluginPackageRest(
    orgUrl: string,
    token: string,
    name: string,
    version: string,
    content: string
): Promise<string> {
    const apiUrl = new URL('api/data/v9.2/pluginpackages', orgUrl);
    const body = JSON.stringify({ name, version, content });

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: apiUrl.hostname,
                path: apiUrl.pathname,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode === 201 || res.statusCode === 204) {
                        const entityId = res.headers['odata-entityid'] as string | undefined;
                        if (!entityId) {
                            reject(new Error('Plugin package created but ID not returned by API.'));
                            return;
                        }
                        const m = entityId.match(/\(([0-9a-f-]{36})\)/i);
                        if (!m) {
                            reject(new Error(`Cannot parse plugin ID from: ${entityId}`));
                            return;
                        }
                        resolve(m[1]);
                    } else {
                        reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
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
