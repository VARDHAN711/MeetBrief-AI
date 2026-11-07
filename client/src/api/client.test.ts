import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

describe('multipart conversation creation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { conversation: {}, messages: [] } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends the file in FormData without manually setting Content-Type', async () => {
    const file = new File(['meeting text'], 'meeting.txt', { type: 'text/plain' });
    await api.create('client-id-test', file);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversations');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('x-client-id')).toBe('client-id-test');
    expect(headers.has('Content-Type')).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);
  });
});
