import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { MemoryProvider } from '../../src/provider/memory.js';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';

describe('example provider and services', () => {
  it('lists, retrieves, updates, and rejects unknown items', async () => {
    const services = createServices(testConfig({ MUTATIONS_ENABLED: true }), new MemoryProvider());
    expect(await services.items.list()).toHaveLength(1);
    expect((await services.items.get('example-1')).status).toBe('pending');
    expect(
      await services.items.updateStatus({
        id: 'example-1',
        status: 'complete',
        confirm: true,
        dryRun: false,
      }),
    ).toMatchObject({ performed: true, dryRun: false, item: { status: 'complete' } });
    await expect(services.items.get('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('wires an injectable application', async () => {
    const application = createApplication({
      config: testConfig(),
      provider: new MemoryProvider(),
    });
    expect(application.registry.list()).toHaveLength(3);
    await application.http.close();
  });
});
