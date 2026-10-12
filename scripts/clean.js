// Cross-platform replacement for 'rm -rf out': npm runs scripts through
// cmd.exe on Windows, where rm is only available from a git-bash PATH.
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
for (const folderName of ['out', 'out-tests']) {
    fs.rmSync(path.join(projectRoot, folderName), { recursive: true, force: true });
}
