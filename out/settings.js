"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETTINGS_FILENAME = void 0;
exports.checkSettingsReady = checkSettingsReady;
exports.loadSettings = loadSettings;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
exports.SETTINGS_FILENAME = 'd365-deployment.settings.json';
const SETTINGS_PLACEHOLDER = {
    publisherName: '',
    publisherPrefix: '',
    solutionUniqueName: '',
    preDeploymentLocalScript: '',
};
function openSettingsFile(settingsPath) {
    vscode.workspace.openTextDocument(settingsPath).then(doc => vscode.window.showTextDocument(doc));
}
function createPlaceholderFile(settingsPath, folderName, log) {
    fs.writeFileSync(settingsPath, JSON.stringify(SETTINGS_PLACEHOLDER, null, 2), 'utf8');
    log(`[settings] File created with placeholder values: ${settingsPath}. Please fill in your values before deploying.`);
    vscode.window.showWarningMessage(`D365: "${exports.SETTINGS_FILENAME}" was created in "${folderName}". Fill in your values and try again.`, 'Open File').then(action => {
        if (action === 'Open File') {
            openSettingsFile(settingsPath);
        }
    });
}
function checkSettingsReady(workspaceRoot, folderName, log) {
    const settingsPath = path.join(workspaceRoot, exports.SETTINGS_FILENAME);
    if (!fs.existsSync(settingsPath)) {
        createPlaceholderFile(settingsPath, folderName, log);
        return false;
    }
    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    catch {
        vscode.window.showErrorMessage(`D365: Failed to parse "${exports.SETTINGS_FILENAME}". Please check the JSON syntax.`);
        return false;
    }
    const unfilledKeys = Object.keys(SETTINGS_PLACEHOLDER).filter((key) => !settings[key] || /^<.+>$/.test(settings[key].trim()));
    if (unfilledKeys.length > 0) {
        const list = unfilledKeys.map(k => `• ${k}: "${settings[k]}"`).join('\n');
        log(`[settings] Unfilled placeholder values:\n${list}`);
        vscode.window.showWarningMessage(`D365: "${exports.SETTINGS_FILENAME}" still contains placeholder values. Fill in: ${unfilledKeys.join(', ')}.`, 'Open File').then(action => {
            if (action === 'Open File') {
                openSettingsFile(settingsPath);
            }
        });
        return false;
    }
    return true;
}
function loadSettings(workspaceRoot, log) {
    const localPath = path.join(workspaceRoot, exports.SETTINGS_FILENAME);
    if (fs.existsSync(localPath)) {
        return JSON.parse(fs.readFileSync(localPath, 'utf8'));
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const p = path.join(folder.uri.fsPath, exports.SETTINGS_FILENAME);
        if (fs.existsSync(p)) {
            log(`Settings found in: ${folder.name}`);
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
    }
    throw new Error(`${exports.SETTINGS_FILENAME} not found.\n` +
        'Create this file at the project root with publisherName, publisherPrefix and solutionUniqueName.');
}
//# sourceMappingURL=settings.js.map