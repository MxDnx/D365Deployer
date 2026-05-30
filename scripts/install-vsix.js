const { execSync } = require('child_process');
const { name, version } = require('../package.json');

const vsix = `${name}-${version}.vsix`;
const code = 'C:/Users/maxim/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd';

console.log(`Installing ${vsix}...`);
execSync(`"${code}" --install-extension ${vsix} --force`, { stdio: 'inherit' });
