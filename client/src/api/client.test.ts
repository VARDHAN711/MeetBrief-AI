import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './client';

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

describe('minutes export', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends x-client-id and returns the response Blob and safe filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Generated minutes', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': "attachment; filename=\"meeting-minutes.txt\"; filename*=UTF-8''Review%20notes.txt" } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await api.export('client-123', 'conversation-1', 'txt');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversations/conversation-1/export?format=txt');
    expect(new Headers(init.headers).get('x-client-id')).toBe('client-123');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.filename).toBe('Review notes.txt');
  });

  it('maps an export error response to ApiRequestError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NO_MINUTES', message: 'no minutes' } }), { status: 409, headers: { 'Content-Type': 'application/json' } })));
    await expect(api.export('client-123', 'conversation-1', 'md')).rejects.toMatchObject({ code: 'NO_MINUTES' } satisfies Partial<ApiRequestError>);
  });
});
