import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env['npm_execpath'];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runNode = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_update_notifier: 'false' },
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${process.execPath} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
};

const runNpm = (args, options = {}) => {
  assert(npmCli, 'package:smoke must be invoked through npm');
  return runNode([npmCli, ...args], options);
};

const runGit = (cwd, scratch, args) => {
  const environment = {
    PATH: process.env['PATH'] ?? '',
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(scratch, 'fixture-global.gitconfig'),
    GIT_AUTHOR_NAME: 'Package Smoke',
    GIT_AUTHOR_EMAIL: 'package-smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Package Smoke',
    GIT_COMMITTER_EMAIL: 'package-smoke@example.invalid',
    GIT_AUTHOR_DATE: '2024-01-01T00:00:00+0000',
    GIT_COMMITTER_DATE: '2024-01-01T00:00:00+0000',
  };
  for (const key of ['SystemRoot', 'windir']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=',
      '-c',
      'diff.external=',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
};

class McpClient {
  constructor(entrypoint, cwd) {
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.nonProtocolOutput = [];
    this.stderr = '';
    this.child = spawn(process.execPath, [entrypoint], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        GIT_ALLOWED_ROOTS: '',
        GIT_LOCAL_PATHS_ENABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  dispatch(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.nonProtocolOutput.push(line);
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'git-optimizer-package-smoke', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async shutdown() {
    this.child.stdin.end();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Packed stdio entrypoint did not exit')), 15_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exit, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  terminate() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }
}

const createFixture = async (consumer, scratch) => {
  const fixture = join(consumer, 'fixture');
  await mkdir(fixture);
  runGit(fixture, scratch, ['init', '--quiet', '--initial-branch', 'main']);
  await writeFile(join(fixture, 'app.ts'), 'export const value = 1;\n');
  await writeFile(join(fixture, 'deployment.yaml'), 'containerPort: 8080\n');
  runGit(fixture, scratch, ['add', '--all']);
  runGit(fixture, scratch, ['commit', '--quiet', '--message', 'root']);
  await writeFile(
    join(fixture, 'app.ts'),
    'export const value = Number(process.env.PORT ?? 8080);\n',
  );
  runGit(fixture, scratch, ['add', '--all']);
  runGit(fixture, scratch, ['commit', '--quiet', '--message', 'change']);
};

const main = async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const packageName = manifest.name;
  const bins = Object.entries(manifest.bin ?? {});
  assert(typeof packageName === 'string' && packageName.length > 0, 'Package name is missing');
  assert(bins.length === 1, 'Package smoke expects exactly one public executable');
  const [binName, binTarget] = bins[0];

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'git-optimizer-package-smoke-'));
  let client;
  try {
    const outside = relative(repositoryRoot, temporaryRoot);
    assert(
      outside.startsWith('..') || isAbsolute(outside),
      'The package consumer must be outside the source checkout',
    );

    runNpm(['run', 'build']);
    const packDirectory = join(temporaryRoot, 'pack');
    await mkdir(packDirectory);
    const packed = JSON.parse(
      runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory]),
    );
    assert(Array.isArray(packed) && packed.length === 1, 'npm pack returned no single candidate');
    const candidate = packed[0];
    assert(candidate.name === packageName, `npm pack selected ${String(candidate.name)}`);

    const packedFiles = candidate.files.map((file) => file.path);
    for (const required of [
      'LICENSE',
      'README.md',
      'dist/public.d.ts',
      'dist/public.js',
      binTarget,
      'package.json',
    ]) {
      assert(packedFiles.includes(required), `Packed package is missing ${required}`);
    }
    for (const forbidden of ['src/', 'tests/', 'scripts/', '.github/', 'coverage/']) {
      assert(
        !packedFiles.some((path) => path.startsWith(forbidden)),
        `Packed package contains ${forbidden}`,
      );
    }

    const tarball = join(packDirectory, candidate.filename);
    const consumer = join(temporaryRoot, 'consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify(
        { name: 'git-optimizer-package-smoke-consumer', private: true, type: 'module' },
        null,
        2,
      )}\n`,
    );
    runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      { cwd: consumer },
    );

    const installed = join(consumer, 'node_modules', ...packageName.split('/'));
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert(installedManifest.name === packageName, 'External consumer installed the wrong package');
    assert(
      installedManifest.version === candidate.version,
      'Installed version differs from the packed candidate',
    );
    assert(installedManifest.bin?.[binName] === binTarget, 'Installed bin target changed');

    await writeFile(
      join(consumer, 'consumer.mjs'),
      `import { gitEnvSchema, gitOptimizerCapability, gitOptimizerManifest } from ${JSON.stringify(
        packageName,
      )};\n` +
        `if (gitOptimizerCapability.manifest !== gitOptimizerManifest) throw new Error('exports do not compose');\n` +
        `if (gitEnvSchema.parse({}).GIT_MAX_FILES !== 200) throw new Error('config export failed');\n`,
    );
    runNode(['consumer.mjs'], { cwd: consumer });

    const installedEntry = join(installed, binTarget);
    await access(installedEntry, fsConstants.R_OK);
    const installedBin = join(
      consumer,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${binName}.cmd` : binName,
    );
    await access(installedBin, fsConstants.R_OK);
    if (process.platform !== 'win32') {
      assert(((await stat(installedBin)).mode & 0o111) !== 0, 'Installed bin is not executable');
    }

    await createFixture(consumer, temporaryRoot);
    client = new McpClient(installedEntry, consumer);
    const initialized = await client.initialize();
    assert(initialized.result?.serverInfo, 'Packed entrypoint returned no MCP server identity');
    assert(
      initialized.result.serverInfo.version === candidate.version,
      `Packed entrypoint reported ${String(
        initialized.result.serverInfo.version,
      )}, expected ${candidate.version}`,
    );

    const listed = await client.request('tools/list');
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert(
      JSON.stringify(names) === JSON.stringify(['summarize_commit_diff']),
      `Packed entrypoint exposed unexpected tools: ${names.join(', ')}`,
    );

    const invocation = await client.request('tools/call', {
      name: 'summarize_commit_diff',
      arguments: { repositoryPath: 'fixture', targetRef: 'HEAD', whitespace: 'preserve' },
    });
    assert(
      invocation.result?.isError !== true,
      `summarize_commit_diff failed from the packed entrypoint: ${JSON.stringify(
        invocation.result,
      )}`,
    );
    const result = invocation.result?.structuredContent;
    assert(result?.returnedFiles === 1, 'Packed tool returned the wrong file count');
    assert(result.files?.[0]?.path === 'app.ts', 'Packed tool returned the wrong changed file');
    assert(
      !result.files.some((file) => file.path === 'deployment.yaml'),
      'Packed tool reported an unchanged file',
    );
    assert(result.truncated === false, 'Packed tool unexpectedly truncated its output');

    const exit = await client.shutdown();
    assert(exit.code === 0, `Packed entrypoint exited with code ${String(exit.code)}`);
    assert(client.nonProtocolOutput.length === 0, 'Packed entrypoint wrote non-protocol stdout');
    assert(client.stderr === '', `Packed entrypoint wrote to stderr:\n${client.stderr}`);

    process.stdout.write(
      `Package smoke passed for ${packageName}@${candidate.version}: ` +
        `${packedFiles.length} files, installed and invoked outside the repository.\n`,
    );
  } finally {
    client?.terminate();
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
};

await main();
