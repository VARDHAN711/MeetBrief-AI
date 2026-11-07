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
};
