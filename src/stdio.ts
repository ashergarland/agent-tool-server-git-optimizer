#!/usr/bin/env node
import { startStdioAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { gitOptimizerCapability } from './capability.js';

const configuredRoots = process.env['GIT_ALLOWED_ROOTS']?.trim();
const configuredLocalPaths = process.env['GIT_LOCAL_PATHS_ENABLED']?.trim();

await startStdioAgentToolApplication(gitOptimizerCapability, {
  env: {
    ...process.env,
    GIT_LOCAL_PATHS_ENABLED: configuredLocalPaths || (configuredRoots ? 'false' : 'true'),
  },
});
