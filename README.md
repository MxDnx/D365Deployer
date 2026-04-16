# D365 WebResource Deployer — Deployment Guide

## Prerequisites

### 1. Install the Power Platform CLI (PAC)

**Option A — via .NET tool (recommended)**
```powershell
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```

**Option B — via winget**
```powershell
winget install Microsoft.PowerPlatformCLI
```

**Option C — via MSI**  
Download and install from: https://aka.ms/PowerAppsCLI

Verify the installation:
```powershell
pac help
```

---

### 2. Connect to your D365CE environment

```powershell
pac auth create --url https://<your-org>.crm.dynamics.com
```

This opens a Microsoft login window. Sign in with an account that has access to the environment.

Check the active connection:
```powershell
pac auth list
```

Switch the active connection:
```powershell
pac auth select --index <number>
```

---

### 3. Install the VS Code extension

Install the `.vsix` file from the `vsix/` folder:

```powershell
code --install-extension vsix\d365ce-deploy-button-0.9.0.vsix
```

Or in VS Code: **Extensions > ... > Install from VSIX...**

---

## Project Configuration

At the root of the project (workspace folder), create the file `d365-deployment.settings.json`:

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

> If the file is missing, it will be created automatically with empty values on the first deployment.

---

## Expected Project Structure

```
<project>/
├── d365-deployment.settings.json   ← configuration
├── src/
│   ├── myScript.ts                 ← TypeScript files to deploy
│   └── ...
├── dist/                           ← auto-generated (esbuild output)
└── build/                          ← auto-generated (staging + .zip)
```

TypeScript files in `src/` are automatically compiled (esbuild, IIFE format, ES2019) and deployed as Web Resources.

---

## Deployment

### Deploy a single file

In the VS Code Explorer, right-click a file inside `src/` → **Deploy to D365CE**

### Deploy all files

Right-click the `src/` folder (or a subfolder) → **Deploy All to D365CE**

---

## Diagnostics

If something goes wrong, use the command palette:  
**Ctrl+Shift+P** → `D365: Diagnose Settings`

The **D365 WebResource Deployer** output panel will show the state of the configuration files and the PAC connection.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `pac` not recognized | Restart VS Code / terminal after installing PAC CLI |
| Authentication error | Run `pac auth create` and sign in again |
| Missing settings | Fill in `d365-deployment.settings.json` at the project root |
| `pac pack failed` | Verify the solution and publisher exist in D365 |
| `pac import failed` | Check that the account has permissions on the target solution |
