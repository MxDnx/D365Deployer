# D365 Deployer

Deploy **Web Resources** and **Plugin Packages** to Dynamics 365 CE directly from the VS Code Explorer context menu.

---

## Prerequisites

### 1. Power Platform CLI (PAC)

**Option A — via VS Code extension (recommended)**

Install the **[Power Platform Tools](https://marketplace.visualstudio.com/items?itemName=microsoft-IsvExpTools.powerplatform-vscode)** extension by Microsoft. PAC CLI is bundled — no separate install needed.

**Option B — via winget**
```powershell
winget install Microsoft.PowerPlatformCLI
```

**Option C — via MSI**
Download and install from: https://aka.ms/PowerAppsCLI

Verify:
```powershell
pac help
```

### 2. .NET SDK *(plugin deployment only)*

Required for `dotnet msbuild`. Download from: https://dot.net

Verify:
```powershell
dotnet --version
```

### 3. Connect to your D365 environment

```powershell
pac auth create --url https://<your-org>.crm.dynamics.com
```

This opens a Microsoft login window. Sign in with an account that has access to the environment.

```powershell
pac auth list          # list connections
pac auth select --index <n>   # switch active connection
```

---

## Web Resources

### Project setup

At the root of the project (workspace folder), create `d365-deployment.settings.json`:

```json
{
  "publisherName": "Mx Dynamics",
  "publisherPrefix": "mx",
  "solutionUniqueName": "FormScript"
}
```

| Field | Description | Example |
|---|---|---|
| `publisherName` | Full publisher name in D365 | `Mx Dynamics` |
| `publisherPrefix` | Publisher prefix | `mx` |
| `solutionUniqueName` | Unique name of the target solution | `FormScript` |

> If the file is missing, it is created automatically with empty values on the first deployment.

### Project structure

```
<project>/
├── d365-deployment.settings.json   ← configuration
├── src/
│   ├── myScript.form.ts            ← TypeScript files to deploy
│   └── static/
│       └── myFile.html             ← Static files to deploy
├── dist/                           ← pre-built output (build before deploying)
└── build/                          ← auto-generated (staging + .zip)
```

> The extension reads from `dist/` — run your build step before deploying.

### Deploy

| Action | How |
|---|---|
| Deploy a single file | Right-click a file in `src/` → **Deploy to D365** |
| Deploy all files | Right-click the `src/` folder → **Deploy All to D365** |

---

## Plugin Packages

### Project setup

#### 1. Expected structure

Each plugin project must contain a `.csproj` file. The **folder name** of the project is used as the key in the configuration file.

```
solution-root/
├── PluginDeploymentConfig.json   ← plugin package configuration
├── Plugins.Core/
│   └── Plugins.Core.csproj
├── Plugins.Finance/
│   └── Plugins.Finance.csproj
└── Plugins.Notifications/
    └── Plugins.Notifications.csproj
```

#### 2. `PluginDeploymentConfig.json`

Create this file at the **root of your solution** (or any ancestor folder of your plugin projects). The extension walks up the directory tree to find it automatically.

```json
{
  "prefix": "mx",
  "packages": {
    "Plugins.Core": {
      "name": "mx_Plugins.Core",
      "packageId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    },
    "Plugins.Finance": {
      "name": "mx_Plugins.Finance",
      "packageId": ""
    }
  }
}
```

| Field | Level | Description |
|---|---|---|
| `prefix` | Root | Publisher prefix used to name new packages: `{prefix}_{folderName}` |
| `packages` | Root | Dictionary where **the key is the project folder name** (not the `.csproj` filename) |
| `packages[…].name` | Package | Full package name in Dataverse |
| `packages[…].packageId` | Package | Package GUID in Dataverse — **auto-populated on first deployment**; leave empty `""` to trigger creation |
| `packages[…].plugins` | Package | Snapshot of registered assemblies and steps — **auto-generated**, do not edit manually |

> **First deployment**: if `packageId` is missing or empty, the extension creates the package in Dataverse via the REST API, retrieves its GUID, and writes it back to the file.

#### 3. Auto-generated `plugins` section

After each successful deployment, the extension fetches the list of plugin assemblies, steps, and images from Dataverse and saves them under `plugins`. This block is read-only reference data — it gives you a live view of what is registered in D365 without leaving VS Code.

```json
{
  "prefix": "mx",
  "packages": {
    "Plugins.Core": {
      "name": "mx_Plugins.Core",
      "packageId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "plugins": [
        {
          "name": "Plugins.Core",
          "pluginId": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
          "steps": [
            {
              "stepId": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
              "name": "MyPlugin.Execute: Create of account",
              "mode": 0,
              "stage": 20,
              "rank": 1,
              "filteringAttributes": "",
              "preImages": [],
              "postImages": []
            }
          ]
        }
      ]
    }
  }
}
```

| Step field | Type | Values |
|---|---|---|
| `mode` | `number` | `0` = Synchronous · `1` = Asynchronous |
| `stage` | `number` | `10` = PreValidation · `20` = PreOperation · `40` = PostOperation |
| `rank` | `number` | Execution order (1 = first) |
| `filteringAttributes` | `string` | Comma-separated filtered attributes (empty = all) |
| `preImages` / `postImages` | `ImageEntry[]` | Images registered on the step |

### Deploy

Right-click a plugin project **folder** in the Explorer → **Deploy Package To CRM**

You can select multiple folders at once (Ctrl/Shift multi-select) to deploy several plugins in sequence.

Each selected plugin goes through:
1. `dotnet msbuild -t:Rebuild` — full clean rebuild
2. `pac plugin push --pluginId <GUID>` — pushes to the connected D365 environment
3. Automatic refresh of the `plugins` block in `PluginDeploymentConfig.json`

> If `pac plugin push` fails (package not found in D365), the extension offers to **create a new package** automatically.

---

## Diagnostics

**Ctrl+Shift+P** → `D365: Diagnose Settings`

The **D365 Deployer** output panel shows the configuration state and PAC connection info.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `pac` not recognized | Restart VS Code after installing PAC CLI |
| Authentication error | Run `pac auth create` and sign in again |
| Missing settings file | Fill in `d365-deployment.settings.json` at the project root |
| `pac pack failed` | Verify the solution and publisher exist in D365 |
| `pac import failed` | Check that the account has write permissions on the solution |
| `PluginDeploymentConfig.json not found` | Create the file at your solution root with `prefix` and `packages` |
| `"prefix" not set` | Fill in the `prefix` field in `PluginDeploymentConfig.json` |
| `dotnet` not recognized | Install the .NET SDK and restart VS Code |
| `pac plugin push failed` | The GUID in `packageId` does not match any Dataverse package — choose *Create New Package* to create one |
| `No .nupkg found after build` | Ensure the `.csproj` produces a NuGet package (`<IsPackable>true</IsPackable>`) |
