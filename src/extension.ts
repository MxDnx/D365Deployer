import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { deployFile, deployAll, runDiagnose, checkSettingsReady, deployPackageToCrm } from './commands';

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('D365 Deployer');
    const log = (msg: string) => output.appendLine(msg);

    context.subscriptions.push(
        vscode.commands.registerCommand('d365WebResourceDeployer.deployFile', async (uri: vscode.Uri) => {
            if (!uri) { vscode.window.showErrorMessage('No file selected.'); return; }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) { vscode.window.showErrorMessage('File is outside the workspace.'); return; }

            output.show(true);
            output.appendLine('');
            if (!checkSettingsReady(workspaceFolder.uri.fsPath, workspaceFolder.name, log)) { return; }

            const fileName = path.basename(uri.fsPath);
            const statusBar = showStatusBar(`D365: ${fileName}`);
            try {
                await deployFile(uri.fsPath, workspaceFolder.uri.fsPath, log);
                statusBar.dispose();
                vscode.window.showInformationMessage(`Deployment of ${fileName} completed.`);
            } catch (err: unknown) {
                statusBar.dispose();
                const msg = err instanceof Error ? err.message : String(err);
                log(`\nError: ${msg}`);
                vscode.window.showErrorMessage(`Deployment of ${fileName} failed: ${msg}`);
            }
        }),

        vscode.commands.registerCommand('d365WebResourceDeployer.deployAll', async (uri: vscode.Uri) => {
            if (!uri) { vscode.window.showErrorMessage('No folder selected.'); return; }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) { vscode.window.showErrorMessage('Folder is outside the workspace.'); return; }

            output.show(true);
            output.appendLine('');
            if (!checkSettingsReady(workspaceFolder.uri.fsPath, workspaceFolder.name, log)) { return; }

            const statusBar = showStatusBar('D365: Deploy All');
            try {
                await deployAll(path.join(workspaceFolder.uri.fsPath, 'src'), workspaceFolder.uri.fsPath, log);
                statusBar.dispose();
                vscode.window.showInformationMessage('Deploy All completed.');
            } catch (err: unknown) {
                statusBar.dispose();
                const msg = err instanceof Error ? err.message : String(err);
                log(`\nError: ${msg}`);
                vscode.window.showErrorMessage(`Deploy All failed: ${msg}`);
            }
        }),

        vscode.commands.registerCommand('d365WebResourceDeployer.diagnose', () => runDiagnose(output)),

        vscode.commands.registerCommand('d365WebResourceDeployer.deployPackageToCrm', async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
            const targets = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
            if (targets.length === 0) { vscode.window.showErrorMessage('No folder selected.'); return; }

            const csprojPaths: string[] = [];
            for (const target of targets) {
                const files = fs.readdirSync(target.fsPath).filter((f: string) => f.endsWith('.csproj'));
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
                    await deployPackageToCrm(csprojPath, log);
                }
                statusBar.dispose();
                vscode.window.showInformationMessage(
                    csprojPaths.length === 1
                        ? `Plugin deployment completed: ${path.basename(path.dirname(csprojPaths[0]))}`
                        : `${csprojPaths.length} plugin(s) deployed successfully.`
                );
            } catch (err: unknown) {
                statusBar.dispose();
                const msg = err instanceof Error ? err.message : String(err);
                log(`\nError: ${msg}`);
                vscode.window.showErrorMessage(`Plugin deployment failed: ${msg}`);
            }
        }),
    );
}

export function deactivate() {}

function showStatusBar(text: string): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.text = `$(sync~spin) ${text}`;
    item.show();
    return item;
}
