"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
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
    }), vscode.commands.registerCommand('d365WebResourceDeployer.diagnose', () => (0, commands_1.runDiagnose)(output)), vscode.commands.registerCommand('d365WebResourceDeployer.deployPackageToCrm', async (uri, uris) => {
        const targets = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        if (targets.length === 0) {
            vscode.window.showErrorMessage('No folder selected.');
            return;
        }
        const csprojPaths = [];
        for (const target of targets) {
            const files = fs.readdirSync(target.fsPath).filter((f) => f.endsWith('.csproj'));
            if (files.length === 0) {
                vscode.window.showErrorMessage(`No .csproj found in ${path.basename(target.fsPath)}`);
                return;
            }
            if (files.length > 1) {
                vscode.window.showErrorMessage(`Multiple .csproj found in ${path.basename(target.fsPath)}`);
                return;
            }
            csprojPaths.push(path.join(target.fsPath, files[0]));
        }
        output.show(true);
        output.appendLine('');
        const statusBar = showStatusBar('D365: Deploy Plugin(s)');
        try {
            for (const csprojPath of csprojPaths) {
                log(`\n--- Deploying ${path.basename(path.dirname(csprojPath))} ---`);
                await (0, commands_1.deployPackageToCrm)(csprojPath, log);
            }
            statusBar.dispose();
            vscode.window.showInformationMessage(csprojPaths.length === 1
                ? `Plugin deployment completed: ${path.basename(path.dirname(csprojPaths[0]))}`
                : `${csprojPaths.length} plugin(s) deployed successfully.`);
        }
        catch (err) {
            statusBar.dispose();
            const msg = err instanceof Error ? err.message : String(err);
            log(`\nError: ${msg}`);
            vscode.window.showErrorMessage(`Plugin deployment failed: ${msg}`);
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