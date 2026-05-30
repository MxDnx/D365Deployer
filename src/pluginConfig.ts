import * as fs from 'fs';
import * as path from 'path';

export const PLUGIN_CONFIG_FILENAME = 'PluginDeploymentConfig.json';

export interface ImageEntry {
    imageId: string;
    name: string;
    attributes: string;
}

export interface StepEntry {
    stepId: string;
    name: string;
    mode: number;
    stage: number;
    rank: number;
    filteringAttributes: string;
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
    prefix: string;
    packages: Record<string, PackageEntry>;
}

export function findPluginConfigPath(fromPath: string): string | null {
    let dir = fs.statSync(fromPath).isDirectory() ? fromPath : path.dirname(fromPath);
    const { root } = path.parse(dir);
    while (dir !== root) {
        const candidate = path.join(dir, PLUGIN_CONFIG_FILENAME);
        if (fs.existsSync(candidate)) { return candidate; }
        dir = path.dirname(dir);
    }
    return null;
}

export function loadPluginConfig(configPath: string): PluginDeploymentConfig {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as PluginDeploymentConfig;
}

export function savePluginConfig(configPath: string, config: PluginDeploymentConfig): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function getPackageId(config: PluginDeploymentConfig, projectName: string): string | undefined {
    return config.packages?.[projectName]?.packageId;
}

export function setPackageEntry(
    configPath: string,
    config: PluginDeploymentConfig,
    projectName: string,
    name: string,
    packageId: string
): void {
    if (!config.packages) { config.packages = {}; }
    config.packages[projectName] = { name, packageId };
    savePluginConfig(configPath, config);
}
