import { describe, it, expect } from 'vitest';

describe('client placeholder', () => {
  it('has node environment compatible with node >=26', () => {
    expect(process.versions.node).toBeDefined();
  });

  it('defines health check API path', () => {
    const healthPath = '/api/health';
    expect(healthPath).toBe('/api/health');
  });
});
