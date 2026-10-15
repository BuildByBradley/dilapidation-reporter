// Cross-platform: run the Playwright suite against the Vite dev server (React StrictMode on).
import { spawn } from 'node:child_process';
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, E2E_MODE: 'dev' },
});
child.on('exit', (code) => process.exit(code ?? 1));
