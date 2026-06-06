"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkSettingsReady = void 0;
exports.deployPackageWithAttributes = deployPackageWithAttributes;
exports.deployFile = deployFile;
exports.deployAll = deployAll;
exports.findPluginProjects = findPluginProjects;
exports.deployPackageToCrm = deployPackageToCrm;
exports.runDiagnose = runDiagnose;
exports.switchAccount = switchAccount;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const https = require("https");
const child_process_1 = require("child_process");
const settings_1 = require("./settings");
Object.defineProperty(exports, "checkSettingsReady", { enumerable: true, get: function () { return settings_1.checkSettingsReady; } });
const pac_1 = require("./pac");
const pluginConfig_1 = require("./pluginConfig");
// ---------------------------------------------------------------------------
// Deploy Package With Attributes — analyze, build, upload, sync steps/images
// ---------------------------------------------------------------------------
async function deployPackageWithAttributes(csprojPath, log) {
    const projectName = path.basename(path.dirname(csprojPath));
    const projectDir = path.dirname(csprojPath);
    const solutionRoot = path.dirname(projectDir);
    const toolDir = path.join(__dirname, '..', 'tools', 'PluginAnalyzer');
    const configPath = (0, pluginConfig_1.findPluginConfigPath)(csprojPath);
    if (!configPath)
        throw new Error(`${pluginConfig_1.PLUGIN_CONFIG_FILENAME} not found. Run "Deploy Package To CRM" first.`);
    const config = (0, pluginConfig_1.loadPluginConfig)(configPath);
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const packageId = (0, pluginConfig_1.getPackageId)(config, projectName) ?? '';
    if (!packageId || !GUID_RE.test(packageId)) {
        throw new Error(`No valid package ID for "${projectName}". Run "Deploy Package To CRM" first.`);
    }
    // 1. Analyze source with Roslyn
    log('\nAnalyzing plugin source...');
    const { code, stdout } = await (0, pac_1.runDotnetCapture)(['run', '--project', toolDir, '--', csprojPath, solutionRoot], toolDir, log);
    if (code !== 0)
        throw new Error(`PluginAnalyzer exited with code ${code}`);
    const analysisResults = JSON.parse(stdout.trim());
    if (analysisResults.length === 0) {
        log('No [PluginStep] classes found.');
        return;
    }
    for (const r of analysisResults) {
        log(`\n  [${r.className}]  entity=${r.pluginStep.entityName}  msg=${r.pluginStep.message}  stage=${r.pluginStep.stage}`);
        log(`    Target:   ${r.targetFields.join(', ') || '(all)'}`);
        log(`    PreImage: ${r.preImageFields.join(', ') || '(none)'}`);
    }
    // 2. Build + upload
    log(`\nBuilding ${projectName}...`);
    const buildCode = await (0, pac_1.runDotnet)(['msbuild', '-t:Rebuild', csprojPath], projectDir, log);
    if (buildCode !== 0)
        throw new Error(`Build failed (exit ${buildCode})`);
    const nupkgPath = findNupkg(projectDir);
    if (!nupkgPath)
        throw new Error('No .nupkg found after build.');
    log('\nAuthenticating...');
    const { orgUrl, token } = await getOrgAuth(log);
    const version = path.basename(nupkgPath).match(/\.(\d+\.\d+(?:\.\d+)*)\.nupkg$/)?.[1] ?? '1.0.0.0';
    log(`Uploading v${version}...`);
    await updatePluginPackageRest(orgUrl, token, packageId, version, fs.readFileSync(nupkgPath).toString('base64'));
    // 3. Fetch current Dataverse state
    log('\nFetching plugin assemblies...');
    const plugins = await fetchPluginAssemblies(orgUrl, token, packageId);
    if (config.packages[projectName]) {
        config.packages[projectName].plugins = plugins;
        (0, pluginConfig_1.savePluginConfig)(configPath, config);
    }
    // 4. Sync steps & pre-images
    for (const r of analysisResults) {
        log(`\nSyncing [${r.className}]...`);
        const filteringAttr = r.targetFields.join(',');
        const preImageAttr = r.preImageFields.join(',');
        let matchingStep;
        for (const plugin of plugins) {
            matchingStep = (plugin.steps ?? []).find(s => s.name.includes(`.${r.className}:`));
            if (matchingStep)
                break;
        }
        if (matchingStep) {
            await patchPluginStep(orgUrl, token, matchingStep.stepId, filteringAttr);
            log(`  filteringAttributes → ${filteringAttr || '(all)'}`);
            const preImg = matchingStep.preImages?.[0];
            if (preImg) {
                await patchPreImage(orgUrl, token, preImg.imageId, preImageAttr);
                log(`  preImage.attributes → ${preImageAttr || '(all)'}`);
            }
            else if (preImageAttr) {
                await createPreImage(orgUrl, token, matchingStep.stepId, preImageAttr);
                log(`  Created preImage → ${preImageAttr}`);
            }
        }
        else {
            log(`  Step not found — creating...`);
            const pluginTypeId = await fetchPluginTypeId(orgUrl, token, plugins, r.className);
            if (!pluginTypeId) {
                log(`  Plugin type not found, skipping.`);
                continue;
            }
            const sdkMessageId = await fetchSdkMessageId(orgUrl, token, r.pluginStep.message);
            if (!sdkMessageId) {
                log(`  SDK message "${r.pluginStep.message}" not found, skipping.`);
                continue;
            }
            const sdkFilterId = await fetchSdkMessageFilterId(orgUrl, token, sdkMessageId, r.pluginStep.entityName);
            if (!sdkFilterId) {
                log(`  Message filter for "${r.pluginStep.entityName}" not found, skipping.`);
                continue;
            }
            const newStepId = await createPluginStep(orgUrl, token, {
                name: `${r.className}: ${r.pluginStep.message} of ${r.pluginStep.entityName}`,
                mode: r.pluginStep.isAsync ? 1 : 0,
                stage: stageToInt(r.pluginStep.stage),
                rank: r.pluginStep.order,
                filteringAttributes: filteringAttr,
                pluginTypeId, sdkMessageId, sdkFilterId,
            });
            log(`  Created step ${newStepId}`);
            if (preImageAttr) {
                await createPreImage(orgUrl, token, newStepId, preImageAttr);
                log(`  Created preImage → ${preImageAttr}`);
            }
        }
    }
    // Refresh config with final state
    try {
        const refreshed = await fetchPluginAssemblies(orgUrl, token, packageId);
        if (config.packages[projectName]) {
            config.packages[projectName].plugins = refreshed;
            (0, pluginConfig_1.savePluginConfig)(configPath, config);
        }
    }
    catch { /* best-effort */ }
    log('\nDeployment with attributes complete.');
}
// ─── Step / image REST helpers ───────────────────────────────────────────────
function stageToInt(stage) {
    if (stage === 'PreValidation')
        return 10;
    if (stage === 'PreOperation')
        return 20;
    return 40;
}
function patchPluginStep(orgUrl, token, stepId, filteringAttributes) {
    return dataversePatch(orgUrl, token, `api/data/v9.2/sdkmessageprocessingsteps(${stepId})`, { filteringattributes: filteringAttributes });
}
function patchPreImage(orgUrl, token, imageId, attributes) {
    return dataversePatch(orgUrl, token, `api/data/v9.2/sdkmessageprocessingstepimages(${imageId})`, { attributes });
}
function createPreImage(orgUrl, token, stepId, attributes) {
    return dataversePost(orgUrl, token, 'api/data/v9.2/sdkmessageprocessingstepimages', {
        name: 'PreImage', entityalias: 'PreImage', imagetype: 0, attributes, messagepropertyname: 'Target',
        'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
    });
}
async function fetchPluginTypeId(orgUrl, token, plugins, className) {
    for (const plugin of plugins) {
        const data = await dataverseGet(orgUrl, token, `api/data/v9.2/plugintypes?$filter=_pluginassemblyid_value eq '${plugin.pluginId}'&$select=plugintypeid,typename`);
        const types = data.value ?? [];
        const match = types.find(t => t.typename === className || t.typename.endsWith(`.${className}`));
        if (match)
            return match.plugintypeid;
    }
    return null;
}
async function fetchSdkMessageId(orgUrl, token, messageName) {
    const data = await dataverseGet(orgUrl, token, `api/data/v9.2/sdkmessages?$filter=name eq '${messageName}'&$select=sdkmessageid`);
    return data.value?.[0]?.sdkmessageid ?? null;
}
async function fetchSdkMessageFilterId(orgUrl, token, sdkMessageId, entityName) {
    const filter = encodeURIComponent(`_sdkmessageid_value eq '${sdkMessageId}' and primaryobjecttypecode eq '${entityName}'`);
    const data = await dataverseGet(orgUrl, token, `api/data/v9.2/sdkmessagefilters?$filter=${filter}&$select=sdkmessagefilterid`);
    return data.value?.[0]?.sdkmessagefilterid ?? null;
}
function createPluginStep(orgUrl, token, cfg) {
    return dataversePost(orgUrl, token, 'api/data/v9.2/sdkmessageprocessingsteps', {
        name: cfg.name, mode: cfg.mode, stage: cfg.stage, rank: cfg.rank,
        filteringattributes: cfg.filteringAttributes,
        'eventhandler_plugintype@odata.bind': `/plugintypes(${cfg.pluginTypeId})`,
        'sdkmessageid@odata.bind': `/sdkmessages(${cfg.sdkMessageId})`,
        'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${cfg.sdkFilterId})`,
    });
}
function dataversePatch(orgUrl, token, relativeUrl, body) {
    const apiUrl = new URL(relativeUrl, orgUrl);
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
                'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Length': Buffer.byteLength(bodyStr) },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`PATCH ${res.statusCode}: ${data}`)));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}
function dataversePost(orgUrl, token, relativeUrl, body) {
    const apiUrl = new URL(relativeUrl, orgUrl);
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
                'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr) },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode === 201 || res.statusCode === 204) {
                    const m = res.headers['odata-entityid']?.match(/\(([0-9a-f-]{36})\)/i);
                    m ? resolve(m[1]) : reject(new Error('POST succeeded but no entity ID returned'));
                }
                else {
                    reject(new Error(`POST ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Deploy a single file
// ---------------------------------------------------------------------------
async function deployFile(sourceFile, workspaceRoot, log) {
    const settings = (0, settings_1.loadSettings)(workspaceRoot, log);
    if (settings.preDeploymentLocalScript) {
        log(`Pre-deploy: npm run ${settings.preDeploymentLocalScript}`);
        const status = await (0, pac_1.runNpmScript)(settings.preDeploymentLocalScript, workspaceRoot, log);
        if (status !== 0) {
            throw new Error(`Pre-deployment script "${settings.preDeploymentLocalScript}" failed (exit ${status})`);
        }
    }
    const srcDir = path.join(workspaceRoot, 'src');
    const distDir = path.join(workspaceRoot, 'dist');
    const relToSrc = path.relative(srcDir, sourceFile);
    const isTypeScript = sourceFile.endsWith('.ts') && !sourceFile.endsWith('.d.ts');
    let relOutput;
    if (isTypeScript) {
        relOutput = relToSrc.replace(/\.ts$/, '.js');
    }
    else {
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
    const files = [{ filePath: builtFile, wrName }];
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
async function deployAll(_srcFolder, workspaceRoot, log) {
    const settings = (0, settings_1.loadSettings)(workspaceRoot, log);
    if (settings.preDeploymentLocalScript) {
        log(`Pre-deploy: npm run ${settings.preDeploymentLocalScript}`);
        const status = await (0, pac_1.runNpmScript)(settings.preDeploymentLocalScript, workspaceRoot, log);
        if (status !== 0) {
            throw new Error(`Pre-deployment script "${settings.preDeploymentLocalScript}" failed (exit ${status})`);
        }
    }
    const distDir = path.join(workspaceRoot, 'dist');
    if (!fs.existsSync(distDir)) {
        throw new Error('dist/ folder not found. Run a build first.');
    }
    const jsFiles = (0, pac_1.collectJsFiles)(distDir);
    if (jsFiles.length === 0) {
        throw new Error('No .js files found in dist/. Run a build first.');
    }
    log(`Found ${jsFiles.length} pre-built file(s) in dist/`);
    const prefix = `${settings.publisherPrefix}_`;
    const files = [];
    for (const jsFile of jsFiles) {
        const relJs = path.relative(distDir, jsFile);
        const jsWrName = prefix + '/' + relJs.replace(/\\/g, '/');
        files.push({ filePath: jsFile, wrName: jsWrName });
        const builtMap = jsFile + '.map';
        if (fs.existsSync(builtMap)) {
            files.push({ filePath: builtMap, wrName: jsWrName + '.map' });
        }
    }
    const staticFiles = (0, pac_1.collectStaticFiles)(path.join(distDir, 'static'));
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
function findPluginProjects(rootPath) {
    const configPath = (0, pluginConfig_1.findPluginConfigPath)(rootPath);
    const config = configPath ? (0, pluginConfig_1.loadPluginConfig)(configPath) : null;
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const results = [];
    function scan(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj') {
                continue;
            }
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
            }
            else if (entry.isFile() && entry.name.endsWith('.csproj')) {
                const projectName = path.basename(path.dirname(fullPath));
                const pluginId = config ? ((0, pluginConfig_1.getPackageId)(config, projectName) ?? '') : '';
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
async function deployPackageToCrm(csprojPath, log) {
    const projectName = path.basename(path.dirname(csprojPath));
    const configPath = (0, pluginConfig_1.findPluginConfigPath)(csprojPath);
    if (!configPath) {
        throw new Error(`${pluginConfig_1.PLUGIN_CONFIG_FILENAME} not found. Create it at your solution root with "prefix" and "plugins".`);
    }
    const config = (0, pluginConfig_1.loadPluginConfig)(configPath);
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const packageId = (0, pluginConfig_1.getPackageId)(config, projectName) ?? '';
    if (!packageId || !GUID_RE.test(packageId)) {
        await createNewPluginPackage(csprojPath, configPath, config, log);
        return;
    }
    const cwd = path.dirname(csprojPath);
    log(`dotnet msbuild -t:Rebuild "${path.basename(csprojPath)}"`);
    const buildCode = await (0, pac_1.runDotnet)(['msbuild', `-t:Rebuild`, csprojPath], cwd, log);
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
    }
    catch (err) {
        const choice = await vscode.window.showWarningMessage(`Plugin package update failed — the package ID "${packageId}" may not exist in Dataverse. Create a new plugin package?`, { modal: true }, 'Create New Package');
        if (choice !== 'Create New Package') {
            throw err;
        }
        await createNewPluginPackage(csprojPath, configPath, config, log);
        return;
    }
    log('Refreshing plugin list...');
    try {
        if (config.packages[projectName]) {
            const plugins = await fetchPluginAssemblies(orgUrl, accessToken, packageId);
            config.packages[projectName].plugins = plugins;
            (0, pluginConfig_1.savePluginConfig)(configPath, config);
            log(`  ${plugins.length} plugin(s) updated in ${pluginConfig_1.PLUGIN_CONFIG_FILENAME}`);
        }
    }
    catch (err) {
        log(`  Could not refresh plugin list: ${err instanceof Error ? err.message : String(err)}`);
    }
    log('\nDeployment complete.');
}
async function checkPluginConfigSettings(configPath, config) {
    const isBlank = (v) => !v?.trim() || /^<.+>$/.test(v.trim());
    const missing = [];
    if (isBlank(config.prefix)) {
        missing.push('prefix');
    }
    if (isBlank(config.publisherName)) {
        missing.push('publisherName');
    }
    if (isBlank(config.solutionUniqueName)) {
        missing.push('solutionUniqueName');
    }
    if (missing.length === 0) {
        return true;
    }
    if (isBlank(config.prefix)) {
        config.prefix = '<publisher prefix ex: mx>';
    }
    if (isBlank(config.publisherName)) {
        config.publisherName = '<publisher full name ex: Mx Dynamics>';
    }
    if (isBlank(config.solutionUniqueName)) {
        config.solutionUniqueName = '<solution unique name>';
    }
    (0, pluginConfig_1.savePluginConfig)(configPath, config);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showWarningMessage(`D365: Fill in the following fields in ${pluginConfig_1.PLUGIN_CONFIG_FILENAME}: ${missing.join(', ')}.`);
    return false;
}
async function createNewPluginPackage(csprojPath, configPath, config, log) {
    if (!await checkPluginConfigSettings(configPath, config)) {
        return;
    }
    const projectName = path.basename(path.dirname(csprojPath));
    const prefix = config.prefix.trim();
    const packageName = `${prefix}_${projectName}`;
    const cwd = path.dirname(csprojPath);
    log(`dotnet msbuild -t:Rebuild "${path.basename(csprojPath)}"`);
    const buildCode = await (0, pac_1.runDotnet)(['msbuild', '-t:Rebuild', csprojPath], cwd, log);
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
    }
    else {
        log(`Creating plugin package "${packageName}" v${versionFromFilename} in Dataverse...`);
        packageId = await createPluginPackageRest(orgUrl, accessToken, packageName, versionFromFilename, packageContent);
    }
    log(`  Package ID: ${packageId}`);
    (0, pluginConfig_1.setPackageEntry)(configPath, config, projectName, packageName, packageId);
    const solutionUniqueName = config.solutionUniqueName.trim();
    log(`Registering package in solution "${solutionUniqueName}"...`);
    try {
        await addSolutionComponentRest(orgUrl, accessToken, packageId, solutionUniqueName, 10041);
        log(`  Package registered in solution "${solutionUniqueName}".`);
    }
    catch (err) {
        log(`Warning: could not register package in solution: ${err instanceof Error ? err.message : String(err)}`);
    }
    log('Fetching registered plugin assemblies...');
    const plugins = await fetchPluginAssemblies(orgUrl, accessToken, packageId);
    if (plugins.length > 0 && config.packages[projectName]) {
        config.packages[projectName].plugins = plugins;
        (0, pluginConfig_1.savePluginConfig)(configPath, config);
        for (const p of plugins) {
            log(`  Plugin: ${p.name} (${p.pluginId})`);
        }
    }
    log(`\nPlugin created successfully.`);
    log(`  ${projectName} → ${packageId} saved to ${pluginConfig_1.PLUGIN_CONFIG_FILENAME}`);
    log('\nDeployment complete.');
}
function findNupkg(cwd) {
    const dirs = [
        path.join(cwd, 'bin', 'Debug'),
        path.join(cwd, 'bin', 'Release'),
        path.join(cwd, 'bin'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            continue;
        }
        const pkgs = fs.readdirSync(dir)
            .filter(f => f.endsWith('.nupkg'))
            .map(f => path.join(dir, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (pkgs.length > 0) {
            return pkgs[0];
        }
    }
    return null;
}
async function fetchPluginAssemblies(orgUrl, token, packageId) {
    const stepsExpand = 'plugintype_sdkmessageprocessingstep($select=sdkmessageprocessingstepid,name,mode,stage,rank,filteringattributes)';
    const typesExpand = `pluginassembly_plugintype($select=plugintypeid;$expand=${stepsExpand})`;
    const filter = encodeURIComponent(`_packageid_value eq '${packageId}'`);
    const query = `$filter=${filter}&$select=name,pluginassemblyid&$expand=${encodeURIComponent(typesExpand)}`;
    const assembliesData = await dataverseGet(orgUrl, token, `api/data/v9.2/pluginassemblies?${query}`);
    const entries = (assembliesData.value ?? []).map((a) => {
        const rawSteps = (a.pluginassembly_plugintype ?? [])
            .flatMap(t => t.plugintype_sdkmessageprocessingstep ?? []);
        const steps = rawSteps.map(s => ({
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
        const stepMap = new Map();
        for (const e of entries) {
            for (const s of e.steps ?? []) {
                stepMap.set(s.stepId, s);
            }
        }
        for (const i of (imagesData.value ?? [])) {
            const step = stepMap.get(i._sdkmessageprocessingstepid_value);
            if (!step) {
                continue;
            }
            const image = { imageId: i.sdkmessageprocessingstepimageid, name: i.name, attributes: i.attributes ?? '' };
            if (i.imagetype === 0 || i.imagetype === 2) {
                step.preImages.push(image);
            }
            if (i.imagetype === 1 || i.imagetype === 2) {
                step.postImages.push(image);
            }
        }
    }
    return entries;
}
function dataverseGet(orgUrl, token, relativeUrl) {
    const apiUrl = new URL(relativeUrl, orgUrl);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: apiUrl.hostname,
            path: apiUrl.pathname + apiUrl.search,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                'Accept': 'application/json',
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    }
                    catch {
                        resolve({});
                    }
                }
                else {
                    reject(new Error(`Failed to fetch plugin assemblies: ${res.statusCode} ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}
function getPacOrgInfo() {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32';
        const [cmd, args] = isWindows
            ? ['cmd.exe', ['/c', 'pac', 'org', 'who']]
            : ['pac', ['org', 'who']];
        let output = '';
        const proc = (0, child_process_1.spawn)(cmd, args, { shell: false });
        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.stderr.on('data', (d) => { output += d.toString(); });
        proc.on('close', (code) => {
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
async function findExistingPackageId(orgUrl, token, packageName) {
    const query = `api/data/v9.2/pluginpackages?$filter=name eq '${encodeURIComponent(packageName)}'&$select=pluginpackageid`;
    const data = await dataverseGet(orgUrl, token, query);
    const values = data.value;
    return values && values.length > 0 ? values[0].pluginpackageid : null;
}
function createPluginPackageRest(orgUrl, token, name, version, content) {
    const apiUrl = new URL('api/data/v9.2/pluginpackages', orgUrl);
    const body = JSON.stringify({ name, version, content });
    return new Promise((resolve, reject) => {
        const req = https.request({
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
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode === 201 || res.statusCode === 204) {
                    const entityId = res.headers['odata-entityid'];
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
                }
                else {
                    reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function updatePluginPackageRest(orgUrl, token, packageId, version, content) {
    const apiUrl = new URL(`api/data/v9.2/pluginpackages(${packageId})`, orgUrl);
    const body = JSON.stringify({ version, content });
    return new Promise((resolve, reject) => {
        const req = https.request({
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
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode === 204) {
                    resolve();
                }
                else {
                    reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function addSolutionComponentRest(orgUrl, token, componentId, solutionUniqueName, componentType) {
    const apiUrl = new URL('api/data/v9.2/AddSolutionComponent', orgUrl);
    const body = JSON.stringify({
        ComponentId: componentId,
        ComponentType: componentType,
        SolutionUniqueName: solutionUniqueName,
        AddRequiredComponents: false,
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
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
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    resolve();
                }
                else {
                    reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Run diagnostics in the output panel
// ---------------------------------------------------------------------------
function runDiagnose(output) {
    output.show(true);
    output.appendLine('');
    output.appendLine('=== D365 WebResource Deployer — Diagnostic ===');
    const folders = vscode.workspace.workspaceFolders ?? [];
    output.appendLine(`\nWorkspace folders (${folders.length}) :`);
    for (const f of folders) {
        output.appendLine(`  [${f.name}] ${f.uri.fsPath}`);
        const settingsPath = path.join(f.uri.fsPath, settings_1.SETTINGS_FILENAME);
        const found = fs.existsSync(settingsPath);
        output.appendLine(`    settings file : ${found ? '✓ FOUND' : '✗ missing'} (${settingsPath})`);
        if (found) {
            try {
                const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                output.appendLine(`    → publisherName      : ${s.publisherName ?? '(empty)'}`);
                output.appendLine(`    → publisherPrefix    : ${s.publisherPrefix ?? '(empty)'}`);
                output.appendLine(`    → solutionUniqueName : ${s.solutionUniqueName ?? '(empty)'}`);
            }
            catch (e) {
                output.appendLine(`    → JSON PARSE ERROR : ${e}`);
            }
        }
        const cfg = vscode.workspace.getConfiguration('d365WebResourceDeployer', f.uri);
        output.appendLine(`    VS Code settings :`);
        output.appendLine(`    → publisherName      : "${cfg.get('publisherName', '')}"`);
        output.appendLine(`    → publisherPrefix    : "${cfg.get('publisherPrefix', '')}"`);
        output.appendLine(`    → solutionUniqueName : "${cfg.get('solutionUniqueName', '')}"`);
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
async function getOrgAuth(log) {
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
    if (!session) {
        throw new Error('Authentication failed or was cancelled.');
    }
    log(`Authenticated as: ${session.account.label}`);
    return { orgUrl, token: session.accessToken };
}
async function deployWebResourcesRest(files, solutionUniqueName, orgUrl, token, log) {
    const updatedIds = [];
    for (const { filePath, wrName } of files) {
        const content = fs.readFileSync(filePath).toString('base64');
        const id = await upsertWebResourceRest(orgUrl, token, wrName, content, solutionUniqueName, log);
        updatedIds.push(id);
    }
    log('Publishing...');
    await publishWebResourcesRest(orgUrl, token, updatedIds);
    log('\nDeployment complete.');
}
async function upsertWebResourceRest(orgUrl, token, wrName, content, solutionUniqueName, log) {
    const filter = encodeURIComponent(`name eq '${wrName}'`);
    const existing = await dataverseGet(orgUrl, token, `api/data/v9.2/webresourceset?$filter=${filter}&$select=webresourceid`);
    const record = existing.value?.[0];
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
function wrTypeFromName(name) {
    if (name.endsWith('.js')) {
        return 3;
    }
    if (name.endsWith('.map')) {
        return 4;
    }
    if (name.endsWith('.css')) {
        return 2;
    }
    if (name.endsWith('.html') || name.endsWith('.htm')) {
        return 1;
    }
    if (name.endsWith('.png')) {
        return 5;
    }
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        return 6;
    }
    if (name.endsWith('.gif')) {
        return 7;
    }
    if (name.endsWith('.svg')) {
        return 11;
    }
    if (name.endsWith('.ico')) {
        return 10;
    }
    if (name.endsWith('.xsl') || name.endsWith('.xslt')) {
        return 9;
    }
    if (name.endsWith('.resx')) {
        return 12;
    }
    return 4;
}
function patchWebResourceRest(orgUrl, token, id, content) {
    const apiUrl = new URL(`api/data/v9.2/webresourceset(${id})`, orgUrl);
    const body = JSON.stringify({ content });
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function createWebResourceRest(orgUrl, token, name, content, wrType) {
    const apiUrl = new URL('api/data/v9.2/webresourceset', orgUrl);
    const body = JSON.stringify({ name, displayname: path.basename(name), content, webresourcetype: wrType });
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode === 201) {
                    const entityId = res.headers['odata-entityid'];
                    const m = entityId?.match(/\(([0-9a-f-]{36})\)/i);
                    m ? resolve(m[1]) : reject(new Error(`Cannot parse web resource ID from: ${entityId}`));
                }
                else {
                    reject(new Error(`Dataverse API error ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function publishWebResourcesRest(orgUrl, token, ids) {
    const apiUrl = new URL('api/data/v9.2/PublishXml', orgUrl);
    const paramXml = `<importexportxml><webresources>${ids.map(id => `<webresource>{${id}}</webresource>`).join('')}</webresources></importexportxml>`;
    const body = JSON.stringify({ ParameterXml: paramXml });
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`Publish error ${res.statusCode}: ${data}`)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
async function switchAccount(log) {
    const { orgUrl, userEmail } = await getPacOrgInfo();
    log(`Target environment: ${orgUrl}`);
    const scope = `${orgUrl.replace(/\/$/, '')}/.default`;
    const session = await vscode.authentication.getSession('microsoft', [scope], {
        forceNewSession: { detail: userEmail ? `PAC is connected as ${userEmail}` : undefined },
    });
    if (!session) {
        throw new Error('Authentication cancelled.');
    }
    log(`Now authenticated as: ${session.account.label}`);
}
//# sourceMappingURL=commands.js.map