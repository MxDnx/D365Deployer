"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const commands_1 = require("./commands");
function activate(context) {
    const output = vscode.window.createOutputChannel('D365 Deployer');
    const log = (msg) => output.appendLine(msg);
    context.subscriptions.push(vscode.commands.registerCommand('d365WebResourceDeployer.deployFile', async (uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No file selected.');
            return;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is outside the workspace.');
            return;
        }
        output.show(true);
        output.appendLine('');
        if (!(0, commands_1.checkSettingsReady)(workspaceFolder.uri.fsPath, workspaceFolder.name, log)) {
            return;
        }
        const fileName = path.basename(uri.fsPath);
        const statusBar = showStatusBar(`D365: ${fileName}`);
        try {
            await (0, commands_1.deployFile)(uri.fsPath, workspaceFolder.uri.fsPath, log);
            statusBar.dispose();
            vscode.window.showInformationMessage(`Deployment of ${fileName} completed.`);
        }
        catch (err) {
            statusBar.dispose();
            const msg = err instanceof Error ? err.message : String(err);
            log(`\nError: ${msg}`);
            vscode.window.showErrorMessage(`Deployment of ${fileName} failed: ${msg}`);
        }
    }), vscode.commands.registerCommand('d365WebResourceDeployer.deployAll', async (uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No folder selected.');
            return;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Folder is outside the workspace.');
            return;
        }
        output.show(true);
        output.appendLine('');
        if (!(0, commands_1.checkSettingsReady)(workspaceFolder.uri.fsPath, workspaceFolder.name, log)) {
            return;
        }
        const statusBar = showStatusBar('D365: Deploy All');
        try {
            await (0, commands_1.deployAll)(path.join(workspaceFolder.uri.fsPath, 'src'), workspaceFolder.uri.fsPath, log);
            statusBar.dispose();
            vscode.window.showInformationMessage('Deploy All completed.');
        }
        catch (err) {
            statusBar.dispose();
            const msg = err instanceof Error ? err.message : String(err);
            log(`\nError: ${msg}`);
            vscode.window.showErrorMessage(`Deploy All failed: ${msg}`);
        }
    }), vscode.commands.registerCommand('d365WebResourceDeployer.diagnose', () => (0, commands_1.runDiagnose)(output)), vscode.commands.registerCommand('d365WebResourceDeployer.deployPackageToCrm', async (uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No folder selected.');
            return;
        }
        const fs = await Promise.resolve().then(() => require('fs'));
        const csprojFiles = fs.readdirSync(uri.fsPath).filter((f) => f.endsWith('.csproj'));
        if (csprojFiles.length === 0) {
            vscode.window.showErrorMessage(`No .csproj file found in ${uri.fsPath}`);
            return;
        }
        if (csprojFiles.length > 1) {
            vscode.window.showErrorMessage(`Multiple .csproj files found in ${uri.fsPath}. Only one is supported.`);
            return;
        }
        const path = await Promise.resolve().then(() => require('path'));
        const csprojPath = path.join(uri.fsPath, csprojFiles[0]);
        output.show(true);
        output.appendLine('');
        const statusBar = showStatusBar('D365: Deploy Package');
        try {
            await (0, commands_1.deployPackageToCrm)(csprojPath, log);
            statusBar.dispose();
            vscode.window.showInformationMessage('Package deployment to CRM completed.');
        }
        catch (err) {
            statusBar.dispose();
            const msg = err instanceof Error ? err.message : String(err);
            log(`\nError: ${msg}`);
            vscode.window.showErrorMessage(`Package deployment failed: ${msg}`);
        }
    }));
}
function deactivate() { }
function showStatusBar(text) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.text = `$(sync~spin) ${text}`;
    item.show();
    return item;
}
//# sourceMappingURL=extension.js.map