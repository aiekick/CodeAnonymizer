const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
    // Extension host (Node) context
    const extensionContext = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/extension.js',
        external: ['vscode'],
        logLevel: 'warning',
        plugins: [esbuildProblemMatcherPlugin]
    });

    // Web extension host (browser worker) context: vscode.dev, github.dev
    const webContext = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'out/web/extension.js',
        external: ['vscode'],
        logLevel: 'warning',
        plugins: [esbuildProblemMatcherPlugin]
    });

    const contexts = [extensionContext, webContext];
    if (watch) {
        await Promise.all(contexts.map(aContext => aContext.watch()));
    } else {
        await Promise.all(contexts.map(aContext => aContext.rebuild()));
        await Promise.all(contexts.map(aContext => aContext.dispose()));
    }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd(result => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location == null) return;
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    }
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
