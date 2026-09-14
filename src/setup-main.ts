import { setupMain } from './setup.js';
setupMain().catch(error => {console.error(error instanceof Error ? error.message : 'Setup failed.'); process.exitCode = 1;});
