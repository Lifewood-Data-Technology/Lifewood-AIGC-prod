import { createBuilder, build } from 'vite';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvironment } from './mysql/environment.mjs';
const target = process.argv[3];
if (target !== undefined && !['local', 'test', 'production','audit'].includes(target)) throw Error('Invalid launch environment');
if (target) {
    if (process.env.LIFEWOOD_EXPECT_ENV && process.env.LIFEWOOD_EXPECT_ENV !== target) throw Error('Conflicting launch environment');
    process.env.LIFEWOOD_EXPECT_ENV = target;
    process.env.LIFEWOOD_ENV_FILE ||= join(homedir(), 'Library', 'Application Support', 'Lifewood', target === 'production' ? 'app.env' : `${target}.env`);
    // Explicit production command supports the unchanged legacy configuration file.
    if (target === 'production') process.env.LIFEWOOD_ENV ||= 'production';
}
if (process.argv[2] !== 'build') loadEnvironment();
const action = process.argv[2];
if (!['build', 'start', 'dev'].includes(action))
    throw Error('Use build, start or dev');
if (action !== 'start') {
    process.env.NODE_ENV = 'production';
    await (await createBuilder({ configFile: 'vite.config.ts' })).buildApp();
    await build({ configFile: false, build: { ssr: 'runtime/server.ts', outDir: 'dist-mysql/launcher', rollupOptions: { output: { entryFileNames: 'server.mjs' } } } });
}
if (action !== 'build') {
    const child = spawn(process.execPath, ['dist-mysql/launcher/server.mjs'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, () => child.kill(signal));
    child.on('exit', code => process.exitCode = code ?? 1);
}
