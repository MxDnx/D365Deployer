import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';
import { loadSettings, checkSettingsReady, SETTINGS_FILENAME } from './settings';
import { runNpmScript, runDotnet, runDotnetCapture, collectJsFiles, collectStaticFiles } from './pac';
import {
    PLUGIN_CONFIG_FILENAME, PluginDeploymentConfig, PluginEntry, StepEntry,
    findPluginConfigPath, loadPluginConfig, savePluginConfig, getPackageId, getPackageEntry, setPackageEntry,
} from './pluginConfig';

/** Split a Dataverse CSV attribute string into the string[] shape used in the config. */
function csv(value?: string): string[] {
    return (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Deploy Package With Attributes — analyze, build, upload, sync steps/images
// ---------------------------------------------------------------------------

export async function deployPackageWithAttributes(csprojPath: string, log: (msg: string) => void): Promise<void> {
    const projectName  = path.basename(path.dirname(csprojPath));
    const projectDir   = path.dirname(csprojPath);
    const solutionRoot = path.dirname(projectDir);
    const toolDir      = path.join(__dirname, '..', 'tools', 'PluginAnalyzer');

    const configPath = findPluginConfigPath(csprojPath);
    if (!configPath) throw new Error(`${PLUGIN_CONFIG_FILENAME} not found. Run "Deploy Package To CRM" first.`);
    const config = loadPluginConfig(configPath);
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const packageId = getPackageId(config) ?? '';
    if (!packageId || !GUID_RE.test(packageId)) {
        throw new Error(`No valid package ID for "${projectName}". Run "Deploy Package To CRM" first.`);
    }

    // 1. Analyze source with Roslyn
    log('\nAnalyzing plugin source...');
    const { code, stdout } = await runDotnetCapture(
        ['run', '--project', toolDir, '--', csprojPath, solutionRoot],
        toolDir, log
    );
    if (code !== 0) throw new Error(`PluginAnalyzer exited with code ${code}`);

    interface StepInfo { entityName: string; message: string; stage: string; isAsync: boolean; order: number; }
    interface AnalysisResult { className: string; pluginStep: StepInfo; targetFields: string[]; preImageFields: string[]; }
    const analysisResults: AnalysisResult[] = JSON.parse(stdout.trim());
    if (analysisResults.length === 0) { log('No [PluginStep] classes found.'); return; }

    for (const r of analysisResults) {
        log(`\n  [${r.className}]  entity=${r.pluginStep.entityName}  msg=${r.pluginStep.message}  stage=${r.pluginStep.stage}`);
        log(`    Target:   ${r.targetFields.join(', ')   || '(all)'}`);
        log(`    PreImage: ${r.preImageFields.join(', ') || '(none)'}`);
    }

    // 2. Build + upload
    log(`\nBuilding ${projectName}...`);
    const buildCode = await runDotnet(['msbuild', '-t:Rebuild', csprojPath], projectDir, log);
    if (buildCode !== 0) throw new Error(`Build failed (exit ${buildCode})`);

    const nupkgPath = findNupkg(projectDir);
    if (!nupkgPath) throw new Error('No .nupkg found after build.');

    log('\nAuthenticating...');
    const { orgUrl, token } = await getOrgAuth(log);

    const version = path.basename(nupkgPath).match(/\.(\d+\.\d+(?:\.\d+)*)\.nupkg$/)?.[1] ?? '1.0.0.0';
    log(`Uploading v${version}...`);
    await updatePluginPackageRest(orgUrl, token, packageId, version, fs.readFileSync(nupkgPath).toString('base64'));

    // 3. Fetch current Dataverse state
    log('\nFetching plugin assemblies...');
    const plugins = await fetchPluginAssemblies(orgUrl, token, packageId);
    const pkgEntry = getPackageEntry(config);
    if (pkgEntry) {
        pkgEntry.plugins = plugins;
        savePluginConfig(configPath, config);
    }

    // 4. Sync steps & pre-images
    const solvedStepIds: string[] = [];
    for (const r of analysisResults) {
        log(`\nSyncing [${r.className}]...`);
        const filteringAttr = r.targetFields.join(',');
        const preImageAttr  = r.preImageFields.join(',');

        // Match the existing step on the exact name produced at creation time
        // (`${className}: ${message} of ${entity}`). The previous `.${className}:`
        // substring expected a namespaced name that creation never emits, so the
        // lookup always missed and every redeploy created a duplicate step/image.
        const expectedStepName = `${r.className}: ${r.pluginStep.message} of ${r.pluginStep.entityName}`;
        let matchingStep: StepEntry | undefined;
        for (const plugin of plugins) {
            matchingStep = (plugin.steps ?? []).find(s => s.name === expectedStepName);
            if (matchingStep) break;
        }

        if (matchingStep) {
            // Idempotent update path. Each Dataverse write is best-effort: the step and
            // image already carry the right values from creation, so a redundant PATCH/POST
            // that the platform rejects (e.g. 0x80040216) must not abort the whole deploy.
            solvedStepIds.push(matchingStep.stepId);
            const tryWrite = async (label: string, fn: () => Promise<unknown>) => {
                try { await fn(); log(`  ${label}`); }
                catch (e) { log(`  ${label} → skipped (${e instanceof Error ? e.message : String(e)})`); }
            };

            if (filteringAttr) {
                await tryWrite(`filteringAttributes → ${filteringAttr}`, () =>
                    patchPluginStep(orgUrl, token, matchingStep!.stepId, filteringAttr));
            } else {
                log(`  filteringAttributes → (no [Target] in source — skipping, user manages manually)`);
            }

            const preImg = matchingStep.preImages?.[0];
            if (preImg) {
                if (preImageAttr) {
                    await tryWrite(`preImage.attributes → ${preImageAttr}`, () =>
                        patchPreImage(orgUrl, token, preImg.imageId, preImageAttr));
                } else {
                    log(`  preImage.attributes → (no [PreImage] in source — skipping, user manages manually)`);
                }
            } else if (preImageAttr) {
                await tryWrite(`Created preImage → ${preImageAttr}`, () =>
                    createPreImage(orgUrl, token, matchingStep!.stepId, preImageAttr));
            }
        } else {
            log(`  Step not found — creating...`);
            const pluginTypeId = await fetchPluginTypeId(orgUrl, token, plugins, r.className);
            if (!pluginTypeId) { log(`  Plugin type not found, skipping.`); continue; }

            const sdkMessageId = await fetchSdkMessageId(orgUrl, token, r.pluginStep.message);
            if (!sdkMessageId) { log(`  SDK message "${r.pluginStep.message}" not found, skipping.`); continue; }

            const sdkFilterId = await fetchSdkMessageFilterId(orgUrl, token, sdkMessageId, r.pluginStep.entityName);
            if (!sdkFilterId) { log(`  Message filter for "${r.pluginStep.entityName}" not found, skipping.`); continue; }

            const newStepId = await createPluginStep(orgUrl, token, {
                name: expectedStepName,
                mode: r.pluginStep.isAsync ? 1 : 0,
                stage: stageToInt(r.pluginStep.stage),
                rank: r.pluginStep.order,
                filteringAttributes: filteringAttr,
                pluginTypeId, sdkMessageId, sdkFilterId,
            });
            log(`  Created step ${newStepId}`);
            solvedStepIds.push(newStepId);

            if (preImageAttr) {
                await createPreImage(orgUrl, token, newStepId, preImageAttr);
                log(`  Created preImage → ${preImageAttr}`);
            }
        }
    }

    // Add every synced step to the configured solution (type 92), best-effort.
    // Re-adding a member already in the solution is rejected by Dataverse
    // (0x80040216) on an idempotent redeploy, so treat any add failure as a skip.
    const solutionUniqueName = config.solutionUniqueName?.trim();
    if (solutionUniqueName && !/^<.+>$/.test(solutionUniqueName) && solvedStepIds.length > 0) {
        log(`\nAdding ${solvedStepIds.length} step(s) to solution "${solutionUniqueName}"...`);
        for (const id of solvedStepIds) {
            try {
                await addSolutionComponentRest(orgUrl, token, id, solutionUniqueName, 92);
                log(`  Step ${id} → added (type 92)`);
            } catch (e) {
                log(`  Step ${id} → already in solution (skipped: ${e instanceof Error ? e.message : String(e)})`);
            }
        }
    }

    // Refresh config with final state
    try {
        const refreshed = await fetchPluginAssemblies(orgUrl, token, packageId);
        const refreshEntry = getPackageEntry(config);
        if (refreshEntry) {
            refreshEntry.plugins = refreshed;
            savePluginConfig(configPath, config);
            log(`\n${PLUGIN_CONFIG_FILENAME} updated.`);
        }
    } catch (err) {
        log(`\nWarning: could not refresh ${PLUGIN_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    }

    log('\nDeployment with attributes complete.');
}

// ─── Step / image REST helpers ───────────────────────────────────────────────

function stageToInt(stage: string): number {
    if (stage === 'PreValidation') return 10;
    if (stage === 'PreOperation')  return 20;
    return 40;
}

function patchPluginStep(orgUrl: string, token: string, stepId: string, filteringAttributes: string): Promise<void> {
    return dataversePatch(orgUrl, token, `api/data/v9.2/sdkmessageprocessingsteps(${stepId})`, { filteringattributes: filteringAttributes });
}

function patchPreImage(orgUrl: string, token: string, imageId: string, attributes: string): Promise<void> {
    return dataversePatch(orgUrl, token, `api/data/v9.2/sdkmessageprocessingstepimages(${imageId})`, { attributes });
}

function createPreImage(orgUrl: string, token: string, stepId: string, attributes: string): Promise<string> {
    return dataversePost(orgUrl, token, 'api/data/v9.2/sdkmessageprocessingstepimages', {
        name: 'PreImage', entityalias: 'PreImage', imagetype: 0, attributes, messagepropertyname: 'Target',
        'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
    });
}

async function fetchPluginTypeId(orgUrl: string, token: string, plugins: PluginEntry[], className: string): Promise<string | null> {
    for (const plugin of plugins) {
        const data = await dataverseGet(orgUrl, token,
            `api/data/v9.2/plugintypes?$filter=_pluginassemblyid_value eq '${plugin.pluginId}'&$select=plugintypeid,typename`);
        const types = data.value as { plugintypeid: string; typename: string }[] ?? [];
        const match = types.find(t => t.typename === className || t.typename.endsWith(`.${className}`));
        if (match) return match.plugintypeid;
    }
    return null;
}

async function fetchSdkMessageId(orgUrl: string, token: string, messageName: string): Promise<string | null> {
    const data = await dataverseGet(orgUrl, token, `api/data/v9.2/sdkmessages?$filter=name eq '${messageName}'&$select=sdkmessageid`);
    return (data.value as { sdkmessageid: string }[])?.[0]?.sdkmessageid ?? null;
}

async function fetchSdkMessageFilterId(orgUrl: string, token: string, sdkMessageId: string, entityName: string): Promise<string | null> {
    const filter = encodeURIComponent(`_sdkmessageid_value eq '${sdkMessageId}' and primaryobjecttypecode eq '${entityName}'`);
    const data = await dataverseGet(orgUrl, token, `api/data/v9.2/sdkmessagefilters?$filter=${filter}&$select=sdkmessagefilterid`);
    return (data.value as { sdkmessagefilterid: string }[])?.[0]?.sdkmessagefilterid ?? null;
}

interface NewStepConfig {
    name: string; mode: number; stage: number; rank: number;
    filteringAttributes: string; pluginTypeId: string; sdkMessageId: string; sdkFilterId: string;
}

function createPluginStep(orgUrl: string, token: string, cfg: NewStepConfig): Promise<string> {
    return dataversePost(orgUrl, token, 'api/data/v9.2/sdkmessageprocessingsteps', {
        name: cfg.name, mode: cfg.mode, stage: cfg.stage, rank: cfg.rank,
        ...(cfg.filteringAttributes ? { filteringattributes: cfg.filteringAttributes } : {}),
        'eventhandler_plugintype@odata.bind': `/plugintypes(${cfg.pluginTypeId})`,
        'sdkmessageid@odata.bind':       `/sdkmessages(${cfg.sdkMessageId})`,
        'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${cfg.sdkFilterId})`,
    });
}

function dataversePatch(orgUrl: string, token: string, relativeUrl: string, body: Record<string, unknown>): Promise<void> {
    const apiUrl = new URL(relativeUrl, orgUrl);
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
                       'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Length': Buffer.byteLength(bodyStr) },
        }, (res) => {
            let data = ''; res.on('data', (c: Buffer) => { data += c; });
            res.on('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`PATCH ${res.statusCode}: ${data}`)));
        });
        req.on('error', reject); req.write(bodyStr); req.end();
    });
}

function dataversePost(orgUrl: string, token: string, relativeUrl: string, body: Record<string, unknown>): Promise<string> {
    const apiUrl = new URL(relativeUrl, orgUrl);
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
                       'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json',
                       'Content-Length': Buffer.byteLength(bodyStr) },
        }, (res) => {
            let data = ''; res.on('data', (c: Buffer) => { data += c; });
            res.on('end', () => {
                if (res.statusCode === 201 || res.statusCode === 204) {
                    const m = (res.headers['odata-entityid'] as string | undefined)?.match(/\(([0-9a-f-]{36})\)/i);
                    m ? resolve(m[1]) : reject(new Error('POST succeeded but no entity ID returned'));
                } else { reject(new Error(`POST ${res.statusCode}: ${data}`)); }
            });
        });
        req.on('error', reject); req.write(bodyStr); req.end();
    });
}

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
    const relToSrc = path.relative(srcDir, sourceFile);
    const isTypeScript = sourceFile.endsWith('.ts') && !sourceFile.endsWith('.d.ts');

    let relOutput: string;
    if (isTypeScript) {
        relOutput = relToSrc.replace(/\.ts$/, '.js');
    } else {
        log(`Copy: ${path.relative(workspaceRoot, sourceFile)}`);
        relOutput = relToSrc;
        const destPath = path.join(distDir, relOutput);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(sourceFile, destPath);
    }

    const builtFile = path.join(distDir, relOutput);
    if (!fs.existsSync(builtFile)) {
        throw new Error(`File not found in dist: ${relOutput}\nRun a build first.`);
    }

    const prefix = `${settings.publisherPrefix}_`;
    const wrName = prefix + '/' + relOutput.replace(/\\/g, '/');
    const files: { filePath: string; wrName: string }[] = [{ filePath: builtFile, wrName }];

    const builtMap = isTypeScript ? builtFile + '.map' : null;
    if (builtMap && fs.existsSync(builtMap)) {
        files.push({ filePath: builtMap, wrName: wrName + '.map' });
    }

    const { orgUrl, token } = await getOrgAuth(log);
    await deployWebResourcesRest(files, settings.solutionUniqueName, orgUrl, token, log);
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
    if (!fs.existsSync(distDir)) { throw new Error('dist/ folder not found. Run a build first.'); }

    const jsFiles = collectJsFiles(distDir);
    if (jsFiles.length === 0) { throw new Error('No .js files found in dist/. Run a build first.'); }
    log(`Found ${jsFiles.length} pre-built file(s) in dist/`);

    const prefix = `${settings.publisherPrefix}_`;
    const files: { filePath: string; wrName: string }[] = [];

    for (const jsFile of jsFiles) {
        const relJs = path.relative(distDir, jsFile);
        const jsWrName = prefix + '/' + relJs.replace(/\\/g, '/');
        files.push({ filePath: jsFile, wrName: jsWrName });
        const builtMap = jsFile + '.map';
        if (fs.existsSync(builtMap)) {
            files.push({ filePath: builtMap, wrName: jsWrName + '.map' });
        }
    }

    const staticFiles = collectStaticFiles(path.join(distDir, 'static'));
    if (staticFiles.length > 0) {
        log(`Found ${staticFiles.length} static file(s) in dist/static/`);
        for (const staticFile of staticFiles) {
            const relStatic = path.relative(distDir, staticFile);
            files.push({ filePath: staticFile, wrName: prefix + '/' + relStatic.replace(/\\/g, '/') });
        }
    }

    const { orgUrl, token } = await getOrgAuth(log);
    await deployWebResourcesRest(files, settings.solutionUniqueName, orgUrl, token, log);
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
                // Per-project convention: the config sits next to the .csproj.
                const configPath = findPluginConfigPath(fullPath);
                const config = configPath ? loadPluginConfig(configPath) : null;
                const pluginId = config ? (getPackageId(config) ?? '') : '';
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
            `${PLUGIN_CONFIG_FILENAME} not found. Create it next to the .csproj with "prefix" and "packages".`
        );
    }
    const config = loadPluginConfig(configPath);
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const packageId = getPackageId(config) ?? '';

    if (!packageId || !GUID_RE.test(packageId)) {
        await createNewPluginPackage(csprojPath, configPath, config, log);
        return;
    }

    const cwd = path.dirname(csprojPath);

    log(`dotnet msbuild -t:Rebuild "${path.basename(csprojPath)}"`);
    const buildCode = await runDotnet(['msbuild', `-t:Rebuild`, csprojPath], cwd, log);
    if (buildCode !== 0) {
        throw new Error(`dotnet build failed (exit ${buildCode})`);
    }

    const nupkgPath = findNupkg(cwd);
    if (!nupkgPath) {
        throw new Error('No .nupkg file found after build. Ensure your project produces a NuGet package.');
    }
    log(`Found package: ${path.basename(nupkgPath)}`);

    log('Authenticating with Dataverse...');
    const { orgUrl, token: accessToken } = await getOrgAuth(log);

    const nupkgFilename = path.basename(nupkgPath);
    const version = nupkgFilename.match(/\.(\d+\.\d+(?:\.\d+)*)\.nupkg$/)?.[1] ?? '1.0.0.0';
    const packageContent = fs.readFileSync(nupkgPath).toString('base64');

    log(`Updating plugin package ${packageId} v${version}...`);
    try {
        await updatePluginPackageRest(orgUrl, accessToken, packageId, version, packageContent);
    } catch (err) {
        const choice = await vscode.window.showWarningMessage(
            `Plugin package update failed — the package ID "${packageId}" may not exist in Dataverse. Create a new plugin package?`,
            { modal: true },
            'Create New Package'
        );
        if (choice !== 'Create New Package') {
            throw err;
        }
        await createNewPluginPackage(csprojPath, configPath, config, log);
        return;
    }

    log('Refreshing plugin list...');
    try {
        const pkgEntry = getPackageEntry(config);
        if (pkgEntry) {
            const plugins = await fetchPluginAssemblies(orgUrl, accessToken, packageId);
            pkgEntry.plugins = plugins;
            savePluginConfig(configPath, config);
            log(`  ${plugins.length} plugin(s) updated in ${PLUGIN_CONFIG_FILENAME}`);
        }
    } catch (err) {
        log(`  Could not refresh plugin list: ${err instanceof Error ? err.message : String(err)}`);
    }

    log('\nDeployment complete.');
}

async function checkPluginConfigSettings(configPath: string, config: PluginDeploymentConfig): Promise<boolean> {
    const isBlank = (v?: string) => !v?.trim() || /^<.+>$/.test(v.trim());
    const missing: string[] = [];
    if (isBlank(config.prefix)) { missing.push('prefix'); }
    if (isBlank(config.publisherName)) { missing.push('publisherName'); }
    if (isBlank(config.solutionUniqueName)) { missing.push('solutionUniqueName'); }

    if (missing.length === 0) { return true; }

    if (isBlank(config.prefix)) { config.prefix = '<publisher prefix ex: mx>'; }
    if (isBlank(config.publisherName)) { config.publisherName = '<publisher full name ex: Mx Dynamics>'; }
    if (isBlank(config.solutionUniqueName)) { config.solutionUniqueName = '<solution unique name>'; }
    savePluginConfig(configPath, config);

    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showWarningMessage(
        `D365: Fill in the following fields in ${PLUGIN_CONFIG_FILENAME}: ${missing.join(', ')}.`
    );
    return false;
}

async function createNewPluginPackage(
    csprojPath: string,
    configPath: string,
    config: PluginDeploymentConfig,
    log: (msg: string) => void
): Promise<void> {
    if (!await checkPluginConfigSettings(configPath, config)) { return; }

    const projectName = path.basename(path.dirname(csprojPath));
    const prefix = config.prefix.trim();
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

    log('Authenticating with Dataverse...');
    const { orgUrl, token: accessToken } = await getOrgAuth(log);

    const nupkgFilename = path.basename(nupkgPath);
    const versionFromFilename = nupkgFilename.match(/\.(\d+\.\d+(?:\.\d+)*)\.nupkg$/)?.[1] ?? '1.0.0.0';

    const packageContent = fs.readFileSync(nupkgPath).toString('base64');

    let packageId = await findExistingPackageId(orgUrl, accessToken, packageName);
    if (packageId) {
        log(`Found existing package "${packageName}" (${packageId}), updating content...`);
        await updatePluginPackageRest(orgUrl, accessToken, packageId, versionFromFilename, packageContent);
    } else {
        log(`Creating plugin package "${packageName}" v${versionFromFilename} in Dataverse...`);
        packageId = await createPluginPackageRest(orgUrl, accessToken, packageName, versionFromFilename, packageContent);
    }
    log(`  Package ID: ${packageId}`);

    setPackageEntry(configPath, config, packageName, packageId);

    const solutionUniqueName = config.solutionUniqueName!.trim();
    log(`Registering package in solution "${solutionUniqueName}"...`);
    try {
        await addSolutionComponentRest(orgUrl, accessToken, packageId, solutionUniqueName, 10041);
        log(`  Package registered in solution "${solutionUniqueName}".`);
    } catch (err) {
        log(`Warning: could not register package in solution: ${err instanceof Error ? err.message : String(err)}`);
    }

    log('Fetching registered plugin assemblies...');
    const plugins = await fetchPluginAssemblies(orgUrl, accessToken, packageId);
    const createdEntry = getPackageEntry(config);
    if (plugins.length > 0 && createdEntry) {
        createdEntry.plugins = plugins;
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
            filteringAttributes: csv(s.filteringattributes),
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
            const image = { imageId: i.sdkmessageprocessingstepimageid, name: i.name, attributes: csv(i.attributes) };
            if (i.imagetype === 0 || i.imagetype === 2) { step.preImages!.push(image); }
            if (i.imagetype === 1 || i.imagetype === 2) { step.postImages!.push(image); }
        }
    }

    return entries;
}

function dataverseGet(orgUrl: string, token: string, relativeUrl: string): Promise<Record<string, unknown>> {
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

function getPacOrgInfo(): Promise<{ orgUrl: string; userEmail: string }> {
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
            const urlMatch = output.match(/Org URL:\s*(https:\/\/[^\s]+)/i);
            if (!urlMatch) {
                reject(new Error('Could not parse Org URL from pac org who output.'));
                return;
            }
            const emailMatch = output.match(/User Email:\s*(\S+)/i);
            resolve({ orgUrl: urlMatch[1].trim(), userEmail: emailMatch?.[1].trim() ?? '' });
        });
    });
}

async function findExistingPackageId(orgUrl: string, token: string, packageName: string): Promise<string | null> {
    const query = `api/data/v9.2/pluginpackages?$filter=name eq '${encodeURIComponent(packageName)}'&$select=pluginpackageid`;
    const data = await dataverseGet(orgUrl, token, query);
    const values = data.value as { pluginpackageid: string }[] | undefined;
    return values && values.length > 0 ? values[0].pluginpackageid : null;
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

function updatePluginPackageRest(
    orgUrl: string,
    token: string,
    packageId: string,
    version: string,
    content: string
): Promise<void> {
    const apiUrl = new URL(`api/data/v9.2/pluginpackages(${packageId})`, orgUrl);
    const body = JSON.stringify({ version, content });

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: apiUrl.hostname,
                path: apiUrl.pathname,
                method: 'PATCH',
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
                    if (res.statusCode === 204) {
                        resolve();
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



function addSolutionComponentRest(
    orgUrl: string,
    token: string,
    componentId: string,
    solutionUniqueName: string,
    componentType: number
): Promise<void> {
    const apiUrl = new URL('api/data/v9.2/AddSolutionComponent', orgUrl);
    const body = JSON.stringify({
        ComponentId: componentId,
        ComponentType: componentType,
        SolutionUniqueName: solutionUniqueName,
        AddRequiredComponents: false,
    });

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
                    if (res.statusCode === 200 || res.statusCode === 204) {
                        resolve();
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

async function getOrgAuth(log: (msg: string) => void): Promise<{ orgUrl: string; token: string }> {
    const { orgUrl, userEmail } = await getPacOrgInfo();
    log(`Target environment: ${orgUrl}`);
    const scope = `${orgUrl.replace(/\/$/, '')}/.default`;

    const silent = await vscode.authentication.getSession('microsoft', [scope], { silent: true });
    const isWrongAccount = !!silent && !!userEmail &&
        !silent.account.label.toLowerCase().includes(userEmail.toLowerCase()) &&
        !silent.account.id.toLowerCase().includes(userEmail.toLowerCase());

    const session = await vscode.authentication.getSession('microsoft', [scope], {
        createIfNone: true,
        clearSessionPreference: isWrongAccount,
    });
    if (!session) { throw new Error('Authentication failed or was cancelled.'); }
    log(`Authenticated as: ${session.account.label}`);
    return { orgUrl, token: session.accessToken };
}

async function deployWebResourcesRest(
    files: { filePath: string; wrName: string }[],
    solutionUniqueName: string,
    orgUrl: string,
    token: string,
    log: (msg: string) => void
): Promise<void> {
    const updatedIds: string[] = [];
    for (const { filePath, wrName } of files) {
        const content = fs.readFileSync(filePath).toString('base64');
        const id = await upsertWebResourceRest(orgUrl, token, wrName, content, solutionUniqueName, log);
        updatedIds.push(id);
    }
    log('Publishing...');
    await publishWebResourcesRest(orgUrl, token, updatedIds);
    log('\nDeployment complete.');
}

async function upsertWebResourceRest(
    orgUrl: string,
    token: string,
    wrName: string,
    content: string,
    solutionUniqueName: string,
    log: (msg: string) => void
): Promise<string> {
    const filter = encodeURIComponent(`name eq '${wrName}'`);
    const existing = await dataverseGet(orgUrl, token, `api/data/v9.2/webresourceset?$filter=${filter}&$select=webresourceid`);
    const record = (existing.value as { webresourceid: string }[])?.[0];

    if (record) {
        log(`  [UPDATE] ${wrName}`);
        await patchWebResourceRest(orgUrl, token, record.webresourceid, content);
        return record.webresourceid;
    }

    log(`  [CREATE] ${wrName}`);
    const id = await createWebResourceRest(orgUrl, token, wrName, content, wrTypeFromName(wrName));
    await addSolutionComponentRest(orgUrl, token, id, solutionUniqueName, 61);
    return id;
}

function wrTypeFromName(name: string): number {
    if (name.endsWith('.js')) { return 3; }
    if (name.endsWith('.map')) { return 4; }
    if (name.endsWith('.css')) { return 2; }
    if (name.endsWith('.html') || name.endsWith('.htm')) { return 1; }
    if (name.endsWith('.png')) { return 5; }
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) { return 6; }
    if (name.endsWith('.gif')) { return 7; }
    if (name.endsWith('.svg')) { return 11; }
    if (name.endsWith('.ico')) { return 10; }
    if (name.endsWith('.xsl') || name.endsWith('.xslt')) { return 9; }
    if (name.endsWith('.resx')) { return 12; }
    return 4;
}

function patchWebResourceRest(orgUrl: string, token: string, id: string, content: string): Promise<void> {
    const apiUrl = new URL(`api/data/v9.2/webresourceset(${id})`, orgUrl);
    const body = JSON.stringify({ content });
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                let data = ''; res.on('data', (c: Buffer) => { data += c; });
                res.on('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`)));
            }
        );
        req.on('error', reject); req.write(body); req.end();
    });
}

function createWebResourceRest(orgUrl: string, token: string, name: string, content: string, wrType: number): Promise<string> {
    const apiUrl = new URL('api/data/v9.2/webresourceset', orgUrl);
    const body = JSON.stringify({ name, displayname: path.basename(name), content, webresourcetype: wrType });
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                let data = ''; res.on('data', (c: Buffer) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode === 201 || res.statusCode === 204) {
                        const entityId = res.headers['odata-entityid'] as string | undefined;
                        const m = entityId?.match(/\(([0-9a-f-]{36})\)/i);
                        m ? resolve(m[1]) : reject(new Error(`Cannot parse web resource ID from: ${entityId}`));
                    } else { reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`)); }
                });
            }
        );
        req.on('error', reject); req.write(body); req.end();
    });
}

function publishWebResourcesRest(orgUrl: string, token: string, ids: string[]): Promise<void> {
    const apiUrl = new URL('api/data/v9.2/PublishXml', orgUrl);
    const paramXml = `<importexportxml><webresources>${ids.map(id => `<webresource>{${id}}</webresource>`).join('')}</webresources></importexportxml>`;
    const body = JSON.stringify({ ParameterXml: paramXml });
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                let data = ''; res.on('data', (c: Buffer) => { data += c; });
                res.on('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`Publish error ${res.statusCode}: ${data}`)));
            }
        );
        req.on('error', reject); req.write(body); req.end();
    });
}

export async function switchAccount(log: (msg: string) => void): Promise<void> {
    const { orgUrl, userEmail } = await getPacOrgInfo();
    log(`Target environment: ${orgUrl}`);
    const scope = `${orgUrl.replace(/\/$/, '')}/.default`;
    const session = await vscode.authentication.getSession('microsoft', [scope], {
        forceNewSession: { detail: userEmail ? `PAC is connected as ${userEmail}` : undefined },
    });
    if (!session) { throw new Error('Authentication cancelled.'); }
    log(`Now authenticated as: ${session.account.label}`);
}

// Re-export for use in extension.ts
export { checkSettingsReady };
