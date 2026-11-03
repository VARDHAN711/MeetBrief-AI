import type { Minutes } from '../schemas/minutes.schema.js';

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export type SourceType = 'text' | 'txt' | 'pdf' | 'audio';

export interface ConversationSummary {
  id: string;
  title: string;
  sourceType: SourceType;
  updatedAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  sourceType: SourceType;
  originalFilename?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentMetadata {
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type MessageRole = 'user' | 'assistant';
export type MessageType = 'text' | 'minutes' | 'error';

export interface MessageItem {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: string;
  messageType: MessageType;
  structuredData?: Minutes;
  attachments: AttachmentMetadata[];
  createdAt: string;
}

export interface CreateConversationRequest {
  text: string;
}

export interface CreateConversationResponse {
  conversation: ConversationDetail;
  messages: MessageItem[];
}

export interface GetMessagesResponse {
  conversation: ConversationDetail;
  messages: MessageItem[];
}

export interface PostMessagesResponse {
  messages: MessageItem[];
}

export interface RetryMessageResponse {
  message: MessageItem;
}

