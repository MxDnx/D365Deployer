import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface Settings {
    publisherName: string;
    publisherPrefix: string;
    solutionUniqueName: string;
    preDeploymentLocalScript?: string;
}

export const SETTINGS_FILENAME = 'd365-deployment.settings.json';

const SETTINGS_PLACEHOLDER: Settings = {
    publisherName: '',
    publisherPrefix: '',
    solutionUniqueName: '',
    preDeploymentLocalScript: '',
};

function openSettingsFile(settingsPath: string): void {
    vscode.workspace.openTextDocument(settingsPath).then(doc => vscode.window.showTextDocument(doc));
}

function createPlaceholderFile(settingsPath: string, folderName: string, log: (msg: string) => void): void {
    fs.writeFileSync(settingsPath, JSON.stringify(SETTINGS_PLACEHOLDER, null, 2), 'utf8');
    log(`[settings] File created with placeholder values: ${settingsPath}. Please fill in your values before deploying.`);
    vscode.window.showWarningMessage(
        `D365: "${SETTINGS_FILENAME}" was created in "${folderName}". Fill in your values and try again.`,
        'Open File'
    ).then(action => {
        if (action === 'Open File') { openSettingsFile(settingsPath); }
    });
}

export function checkSettingsReady(workspaceRoot: string, folderName: string, log: (msg: string) => void): boolean {
    const settingsPath = path.join(workspaceRoot, SETTINGS_FILENAME);

    if (!fs.existsSync(settingsPath)) {
        createPlaceholderFile(settingsPath, folderName, log);
        return false;
    }

    let settings: Record<string, string>;
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
        vscode.window.showErrorMessage(`D365: Failed to parse "${SETTINGS_FILENAME}". Please check the JSON syntax.`);
        return false;
    }

    const unfilledKeys = Object.keys(SETTINGS_PLACEHOLDER).filter(
        (key) => !settings[key] || /^<.+>$/.test(settings[key].trim())
    );

    if (unfilledKeys.length > 0) {
        const list = unfilledKeys.map(k => `• ${k}: "${settings[k]}"`).join('\n');
        log(`[settings] Unfilled placeholder values:\n${list}`);
        vscode.window.showWarningMessage(
            `D365: "${SETTINGS_FILENAME}" still contains placeholder values. Fill in: ${unfilledKeys.join(', ')}.`,
            'Open File'
        ).then(action => {
            if (action === 'Open File') { openSettingsFile(settingsPath); }
        });
        return false;
    }

    return true;
}

export function loadSettings(workspaceRoot: string, log: (msg: string) => void): Settings {
    const localPath = path.join(workspaceRoot, SETTINGS_FILENAME);
    if (fs.existsSync(localPath)) {
        return JSON.parse(fs.readFileSync(localPath, 'utf8')) as Settings;
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const p = path.join(folder.uri.fsPath, SETTINGS_FILENAME);
        if (fs.existsSync(p)) {
            log(`Settings found in: ${folder.name}`);
            return JSON.parse(fs.readFileSync(p, 'utf8')) as Settings;
        }
    }

    throw new Error(
        `${SETTINGS_FILENAME} not found.\n` +
        'Create this file at the project root with publisherName, publisherPrefix and solutionUniqueName.'
    );
}
