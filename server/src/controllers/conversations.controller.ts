import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Conversation, type IConversation } from '../models/Conversation.js';
import { Message, type IMessage } from '../models/Message.js';
import { getLlmClient } from '../services/llm.service.js';
import { formatMinutesToMarkdown } from '../services/minutesFormatter.js';
import { AppError } from '../utils/AppError.js';
import type {
  ConversationSummary,
  ConversationDetail,
  MessageItem,
  CreateConversationResponse,
  GetMessagesResponse,
  ApiResponse,
} from '../types/api.js';
import type { Minutes } from '../schemas/minutes.schema.js';

function formatConversationDetail(conv: IConversation): ConversationDetail {
  return {
    id: conv._id.toString(),
    title: conv.title,
    sourceType: conv.sourceType,
    originalFilename: conv.originalFilename,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
  };
}

function formatMessage(msg: IMessage): MessageItem {
  return {
    id: msg._id.toString(),
    conversationId: msg.conversationId.toString(),
    seq: msg.seq,
    role: msg.role,
    content: msg.content,
    messageType: msg.messageType,
    structuredData: msg.structuredData as Minutes | undefined,
    attachments: msg.attachments || [],
    createdAt: msg.createdAt.toISOString(),
  };
}

/**
 * GET /api/conversations
 * List conversations for the authenticated clientId (newest first, max 100, excludes sourceText)
 */
export async function listConversations(
  req: Request,
  res: Response<ApiResponse<ConversationSummary[]>>
): Promise<void> {
  const clientId = req.clientId!;

  const conversations = await Conversation.find({ clientId })
    .select('-sourceText')
    .sort({ updatedAt: -1 })
    .limit(100);

  const data: ConversationSummary[] = conversations.map((conv) => ({
    id: conv._id.toString(),
    title: conv.title,
    sourceType: conv.sourceType,
    updatedAt: conv.updatedAt.toISOString(),
  }));

  res.status(200).json({ data });
}

/**
 * POST /api/conversations
 * Create conversation from initial meeting text, save user message (seq 1),
 * generate minutes, save assistant message (seq 2), set title, and return { conversation, messages }.
 */
export async function createConversation(
  req: Request,
  res: Response<ApiResponse<CreateConversationResponse>>
): Promise<void> {
  const clientId = req.clientId!;
  const body = req.body as { text?: unknown };

  if (typeof body?.text !== 'string') {
    throw AppError.badRequest('INVALID_INPUT', 'Field "text" is required and must be a string');
  }

  const rawText = body.text;
  const trimmed = rawText.trim();

  if (trimmed.length < 30) {
    throw AppError.badRequest(
      'INVALID_INPUT',
      'Meeting text is too short (minimum 30 characters required)'
    );
  }

  if (rawText.length > env.MAX_TEXT_CHARS) {
    throw AppError.payloadTooLarge(
      'PAYLOAD_TOO_LARGE',
      `Meeting text exceeds maximum length of ${env.MAX_TEXT_CHARS} characters`
    );
  }

  // 1. Create conversation document
  const conversation = new Conversation({
    clientId,
    title: 'Generating minutes...',
    sourceType: 'text',
    sourceText: rawText,
    messageCount: 0,
  });
  await conversation.save();

  // 2. Allocate seq 1 for user message
  const updatedForUser = await Conversation.findOneAndUpdate(
    { _id: conversation._id, clientId },
    { $inc: { messageCount: 1 } },
    { new: true }
  );

  const userSeq = updatedForUser ? updatedForUser.messageCount : 1;

  const userMessage = new Message({
    conversationId: conversation._id,
    seq: userSeq,
    role: 'user',
    content: rawText,
    messageType: 'text',
    attachments: [],
  });
  await userMessage.save();

  // 3. Call LLM to generate minutes
  let minutes: Minutes;
  try {
    const llmClient = getLlmClient();
    minutes = await llmClient.generateMinutes(rawText);
  } catch (llmError) {
    // If LLM fails after user message is saved, save assistant error message
    const updatedForError = await Conversation.findOneAndUpdate(
      { _id: conversation._id, clientId },
      { $inc: { messageCount: 1 } },
      { new: true }
    );
    const errorSeq = updatedForError ? updatedForError.messageCount : userSeq + 1;

    const errorMessage = new Message({
      conversationId: conversation._id,
      seq: errorSeq,
      role: 'assistant',
      content: 'Failed to generate meeting minutes. Please try again.',
      messageType: 'error',
    });
    await errorMessage.save();

    throw llmError;
  }

  // 4. Save assistant minutes message
  const markdown = formatMinutesToMarkdown(minutes);

  const updatedForAssistant = await Conversation.findOneAndUpdate(
    { _id: conversation._id, clientId },
    { $inc: { messageCount: 1 } },
    { new: true }
  );
  const assistantSeq = updatedForAssistant ? updatedForAssistant.messageCount : userSeq + 1;

  const assistantMessage = new Message({
    conversationId: conversation._id,
    seq: assistantSeq,
    role: 'assistant',
    content: markdown,
    messageType: 'minutes',
    structuredData: minutes,
    attachments: [],
  });
  await assistantMessage.save();

  // 5. Update conversation title from minutes.title, fallback to first 40 chars of source
  conversation.title = minutes.title || rawText.slice(0, 40);
  await conversation.save();

  res.status(201).json({
    data: {
      conversation: formatConversationDetail(conversation),
      messages: [formatMessage(userMessage), formatMessage(assistantMessage)],
    },
  });
}

/**
 * GET /api/conversations/:id/messages
 * Restores conversation messages sorted by seq ascending. Never calls LLM.
 */
export async function getConversationMessages(
  req: Request,
  res: Response<ApiResponse<GetMessagesResponse>>
): Promise<void> {
  const clientId = req.clientId!;
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw AppError.invalidId();
  }

  const conversation = await Conversation.findOne({ _id: id, clientId });
  if (!conversation) {
    throw AppError.conversationNotFound();
  }

  const messages = await Message.find({ conversationId: conversation._id }).sort({ seq: 1 });

  res.status(200).json({
    data: {
      conversation: formatConversationDetail(conversation),
      messages: messages.map(formatMessage),
    },
  });
}

/**
 * DELETE /api/conversations/:id
 * Deletes messages first, then conversation. Returns 204 No Content.
 */
export async function deleteConversation(req: Request, res: Response): Promise<void> {
  const clientId = req.clientId!;
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw AppError.invalidId();
  }

  const conversation = await Conversation.findOne({ _id: id, clientId });
  if (!conversation) {
    throw AppError.conversationNotFound();
  }

  // Delete messages first, then the conversation
  await Message.deleteMany({ conversationId: conversation._id });
  await Conversation.deleteOne({ _id: conversation._id, clientId });

  res.status(204).end();
}
