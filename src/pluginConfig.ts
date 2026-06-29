import * as fs from 'fs';
import * as path from 'path';

// Matches the pluginDeploymentConfig.json shape produced by the MxMcpDataverse MCP:
//   one file per plugin project, sitting next to the .csproj (lowercase filename).
//   top-level packageId (back-compat) + prefix/publisherName/solutionUniqueName +
//   packages[] → plugins[] → steps[] → pre/postImages[].
//   filteringAttributes and image attributes are string arrays (not CSV strings).
export const PLUGIN_CONFIG_FILENAME = 'pluginDeploymentConfig.json';

export interface ImageEntry {
    imageId: string;
    name: string;
    attributes: string[];
}

export interface StepEntry {
    stepId: string;
    name: string;
    mode: number;
    stage: number;
    rank: number;
    filteringAttributes: string[];
    preImages?: ImageEntry[];
    postImages?: ImageEntry[];
}

export interface PluginEntry {
    name: string;
    pluginId: string;
    steps?: StepEntry[];
}

export interface PackageEntry {
    name: string;
    packageId: string;
    plugins?: PluginEntry[];
}

export interface PluginDeploymentConfig {
    packageId?: string; // kept top-level for back-compat with the MCP output
    prefix: string;
    publisherName?: string;
    solutionUniqueName?: string;
    packages: PackageEntry[];
}

/**
 * Resolve the pluginDeploymentConfig.json that sits in the same directory as the
 * given path (per-project convention — no walking up the tree).
 */
export function findPluginConfigPath(fromPath: string): string | null {
    const dir = fs.statSync(fromPath).isDirectory() ? fromPath : path.dirname(fromPath);
    const candidate = path.join(dir, PLUGIN_CONFIG_FILENAME);
    return fs.existsSync(candidate) ? candidate : null;
}

export function loadPluginConfig(configPath: string): PluginDeploymentConfig {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as PluginDeploymentConfig;
}

export function savePluginConfig(configPath: string, config: PluginDeploymentConfig): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** Per-project config holds a single package — return it (or undefined). */
export function getPackageEntry(config: PluginDeploymentConfig): PackageEntry | undefined {
    return config.packages?.[0];
}

export function getPackageId(config: PluginDeploymentConfig): string | undefined {
    return getPackageEntry(config)?.packageId ?? config.packageId;
}

export function setPackageEntry(
    configPath: string,
    config: PluginDeploymentConfig,
    name: string,
    packageId: string
): void {
    const existingPlugins = getPackageEntry(config)?.plugins ?? [];
    config.packageId = packageId;
    config.packages = [{ name, packageId, plugins: existingPlugins }];
    savePluginConfig(configPath, config);
}
