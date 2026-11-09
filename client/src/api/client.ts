import type { ApiError, ApiResponse, ConversationSummary, CreateConversationResponse, GetMessagesResponse, MessageItem, RetryMessageResponse } from '../types/api';

const API = '/api/conversations';
export class ApiRequestError extends Error {
  code: string;
  conversationId?: string;
  constructor(error: ApiError['error']) {
    super(error.message);
    this.code = error.code;
    this.conversationId = error.conversationId;
  }
}
async function request<T>(path: string, clientId: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('x-client-id', clientId);
  if (typeof init?.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const body = await response.json() as ApiResponse<T> | ApiError;
  if (!response.ok || 'error' in body) throw new ApiRequestError((body as ApiError).error);
  return body.data;
}
export const api = {
  list: (id: string) => request<ConversationSummary[]>(API, id),
  create: (id: string, source: string | File) => {
    if (typeof source === 'string') {
      return request<CreateConversationResponse>(API, id, { method: 'POST', body: JSON.stringify({ text: source }) });
    }
    const body = new FormData();
    body.append('file', source);
    return request<CreateConversationResponse>(API, id, { method: 'POST', body });
  },
  messages: (id: string, conversationId: string) => request<GetMessagesResponse>(`${API}/${conversationId}/messages`, id),
  send: (id: string, conversationId: string, content: string) => request<{ messages: MessageItem[] }>(`${API}/${conversationId}/messages`, id, { method: 'POST', body: JSON.stringify({ content }) }),
  retry: (id: string, conversationId: string) => request<RetryMessageResponse>(`${API}/${conversationId}/retry`, id, { method: 'POST' }),
  remove: (id: string, conversationId: string) => request<void>(`${API}/${conversationId}`, id, { method: 'DELETE' }),
  export: async (id: string, conversationId: string, format: 'md' | 'txt'): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(`${API}/${conversationId}/export?format=${format}`, { headers: { 'x-client-id': id } });
    if (!response.ok) {
      let body: ApiError;
      try { body = await response.json() as ApiError; }
      catch { throw new Error('The download could not be completed. Please try again.'); }
      throw new ApiRequestError(body.error);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
    let filename = plain ?? `meeting-minutes.${format}`;
    if (encoded) { try { filename = decodeURIComponent(encoded); } catch { filename = plain ?? filename; } }
    return { blob: await response.blob(), filename };
  },
};
