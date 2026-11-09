import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { unlink } from 'node:fs/promises';
import { env } from '../config/env.js';
import { Conversation, type IConversation } from '../models/Conversation.js';
import { Message, type IMessage } from '../models/Message.js';
import { getLlmClient } from '../services/llm.service.js';
import { formatMinutesToMarkdown, formatMinutesToText } from '../services/minutesFormatter.js';
import { AppError } from '../utils/AppError.js';
import { extractUploadedFile } from '../services/extract.service.js';
import { transcribeUploadedAudio } from '../services/transcribe.service.js';
import type {
  ConversationSummary,
  ConversationDetail,
  MessageItem,
  CreateConversationResponse,
  GetMessagesResponse,
  PostMessagesResponse,
  RetryMessageResponse,
  ApiResponse,
} from '../types/api.js';
import type { Minutes } from '../schemas/minutes.schema.js';
import { followupMessageBodySchema } from '../schemas/followup.schema.js';
import { FOLLOWUP_HISTORY_LIMIT, type FollowupTurn } from '../prompts/followup.js';

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

  if (res.headersSent || res.destroyed) return;
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
  const uploadedFile = req.file;
  let responseBody: ApiResponse<CreateConversationResponse> | undefined;

  try {
    let rawText: string;
    let sourceType: 'text' | 'txt' | 'pdf' | 'audio' = 'text';
    let originalFilename: string | undefined;
    let uploadMetadata: { name: string; mimeType: string; sizeBytes: number } | undefined;
    let userMessageContent: string;

    if (uploadedFile) {
      if (Object.keys(req.body as Record<string, unknown>).length > 0) {
        throw AppError.badRequest('INVALID_INPUT', 'A file upload must contain only the "file" field.');
      }
      const fileExtension = uploadedFile.originalname.slice(uploadedFile.originalname.lastIndexOf('.')).toLowerCase();
      const isAudioUpload = fileExtension === '.mp3' || fileExtension === '.wav' || fileExtension === '.m4a' ||
        uploadedFile.mimetype.toLowerCase().startsWith('audio/');
      const extracted = isAudioUpload
        ? await transcribeUploadedAudio(uploadedFile)
        : await extractUploadedFile(uploadedFile);
      rawText = extracted.text;
      sourceType = extracted.sourceType;
      originalFilename = extracted.originalFilename;
      uploadMetadata = { name: extracted.originalFilename, mimeType: extracted.mimeType, sizeBytes: extracted.sizeBytes };
      userMessageContent = `Uploaded file: ${extracted.originalFilename}`;
    } else {
      if (req.is('multipart/form-data')) {
        throw AppError.badRequest('INVALID_INPUT', 'Attach one TXT, PDF, MP3, or WAV file using the "file" field.');
      }
      const body = req.body as { text?: unknown };
      if (typeof body?.text !== 'string') {
        throw AppError.badRequest('INVALID_INPUT', 'Field "text" is required and must be a string');
      }
      rawText = body.text;
      userMessageContent = rawText;
    }

    if (rawText.trim().length < 30) {
      throw AppError.badRequest('INVALID_INPUT', 'Meeting text is too short (minimum 30 characters required)');
    }

    if (rawText.length > env.MAX_TEXT_CHARS) {
      throw AppError.payloadTooLarge(
        'PAYLOAD_TOO_LARGE',
        `Meeting text exceeds maximum length of ${env.MAX_TEXT_CHARS} characters`
      );
    }

    const conversation = new Conversation({
      clientId,
      title: 'Generating minutes...',
      sourceType,
      originalFilename,
      sourceText: rawText,
      messageCount: 0,
    });
    await conversation.save();

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
      content: userMessageContent,
      messageType: 'text',
      attachments: uploadMetadata ? [uploadMetadata] : [],
    });
    await userMessage.save();

    let minutes: Minutes;
    try {
      minutes = await getLlmClient().generateMinutes(rawText);
    } catch (llmError) {
      const updatedForError = await Conversation.findOneAndUpdate(
        { _id: conversation._id, clientId },
        { $inc: { messageCount: 1 } },
        { new: true }
      );
      const errorSeq = updatedForError ? updatedForError.messageCount : userSeq + 1;
      const friendlyContent = llmError instanceof AppError
        ? llmError.message
        : 'Failed to generate meeting minutes. Please try again.';
      await new Message({
        conversationId: conversation._id,
        seq: errorSeq,
        role: 'assistant',
        content: friendlyContent,
        messageType: 'error',
      }).save();

      const mappedError = llmError instanceof AppError
        ? new AppError(llmError.statusCode, llmError.code, llmError.message, conversation._id.toString())
        : new AppError(502, 'LLM_UNAVAILABLE', 'Failed to generate meeting minutes. Please try again.', conversation._id.toString());
      throw mappedError;
    }

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
      content: formatMinutesToMarkdown(minutes),
      messageType: 'minutes',
      structuredData: minutes,
      attachments: [],
    });
    await assistantMessage.save();

    conversation.title = minutes.title || originalFilename || rawText.slice(0, 40);
    await conversation.save();
    responseBody = {
      data: {
        conversation: formatConversationDetail(conversation),
        messages: [formatMessage(userMessage), formatMessage(assistantMessage)],
      },
    };
  } finally {
    if (uploadedFile) {
      try {
        await unlink(uploadedFile.path);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }

  if (res.headersSent || res.destroyed) return;
  res.status(201).json(responseBody!);
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

  if (res.headersSent || res.destroyed) return;
  res.status(200).json({
    data: {
      conversation: formatConversationDetail(conversation),
      messages: messages.map(formatMessage),
    },
  });
}

export async function exportConversation(req: Request, res: Response): Promise<void> {
  const conversation = await findOwnedConversation(req.clientId!, req.params.id);
  const format = req.query.format === undefined ? 'md' : req.query.format;
  if (format !== 'md' && format !== 'txt') {
    throw AppError.badRequest('INVALID_INPUT', 'Export format must be "md" or "txt".');
  }
  const message = await Message.findOne({ conversationId: conversation._id, messageType: 'minutes' }).sort({ seq: -1 });
  if (!message?.structuredData) {
    throw AppError.conflict('NO_MINUTES', 'Minutes are not available for this conversation yet. Try again after generation completes.');
  }
  const minutes = message.structuredData as Minutes;
  const extension = format === 'md' ? 'md' : 'txt';
  const safeBase = (conversation.title || '').replace(/[\\/\r\n\u0000-\u001f\u007f"<>:|?*]/g, '').trim().slice(0, 100) || 'meeting-minutes';
  const filename = `${safeBase}.${extension}`;
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  const body = `Generated by MeetBrief AI. AI-generated content: please review before use.\n\n${format === 'md' ? formatMinutesToMarkdown(minutes) : formatMinutesToText(minutes)}\n`;
  if (res.headersSent || res.destroyed) return;
  res.status(200);
  res.setHeader('Content-Type', `text/${format === 'md' ? 'markdown' : 'plain'}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(body);
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

  if (res.headersSent || res.destroyed) return;
  res.status(204).end();
}

function friendlyLlmContent(err: unknown, fallback: string): string {
  return err instanceof AppError ? err.message : fallback;
}

async function findOwnedConversation(clientId: string, rawId: string | string[] | undefined): Promise<IConversation> {
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw AppError.invalidId();
  }
  const conversation = await Conversation.findOne({ _id: id, clientId });
  if (!conversation) {
    throw AppError.conversationNotFound();
  }
  return conversation;
}

async function allocateSeq(conversationId: mongoose.Types.ObjectId, clientId: string): Promise<number> {
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversationId, clientId },
    { $inc: { messageCount: 1 } },
    { new: true }
  );
  if (!updated) {
    throw AppError.conversationNotFound();
  }
  return updated.messageCount;
}

/**
 * Last 10 non-error messages, excluding the current question, oldest first.
 * Error messages are never included.
 */
async function loadFollowupHistory(
  conversationId: mongoose.Types.ObjectId,
  excludeMessageId: mongoose.Types.ObjectId
): Promise<FollowupTurn[]> {
  const recent = await Message.find({
    conversationId,
    messageType: { $ne: 'error' },
    _id: { $ne: excludeMessageId },
  })
    .sort({ seq: -1 })
    .limit(FOLLOWUP_HISTORY_LIMIT)
    .select({ role: 1, content: 1 });

  return recent.reverse().map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

/**
 * POST /api/conversations/:id/messages
 * Saves the user question, answers from the full sourceText, saves the assistant reply.
 * On LLM failure the user message stays and an error message is stored.
 */
export async function postConversationMessage(
  req: Request,
  res: Response<ApiResponse<PostMessagesResponse>>
): Promise<void> {
  const clientId = req.clientId!;
  const conversation = await findOwnedConversation(clientId, req.params.id);

  const parsed = followupMessageBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Field "content" must be a string between 1 and 2000 characters';
    throw AppError.badRequest('INVALID_INPUT', message);
  }

  const content = parsed.data.content;

  const userSeq = await allocateSeq(conversation._id, clientId);
  const userMessage = new Message({
    conversationId: conversation._id,
    seq: userSeq,
    role: 'user',
    content,
    messageType: 'text',
    attachments: [],
  });
  await userMessage.save();

  const history = await loadFollowupHistory(conversation._id, userMessage._id);

  let answer: string;
  try {
    answer = await getLlmClient().answerQuestion(conversation.sourceText, history, content);
  } catch (llmError) {
    const errorSeq = await allocateSeq(conversation._id, clientId);
    const errorMessage = new Message({
      conversationId: conversation._id,
      seq: errorSeq,
      role: 'assistant',
      content: friendlyLlmContent(llmError, 'Failed to answer the question. Please try again.'),
      messageType: 'error',
      attachments: [],
    });
    await errorMessage.save();
    throw llmError;
  }

  const assistantSeq = await allocateSeq(conversation._id, clientId);
  const assistantMessage = new Message({
    conversationId: conversation._id,
    seq: assistantSeq,
    role: 'assistant',
    content: answer,
    messageType: 'text',
    attachments: [],
  });
  await assistantMessage.save();

  if (res.headersSent || res.destroyed) return;
  res.status(201).json({
    data: {
      messages: [formatMessage(userMessage), formatMessage(assistantMessage)],
    },
  });
}

/**
 * POST /api/conversations/:id/retry
 * Replaces the last assistant error message. 409 when that message is not an error.
 * A failed minutes generation is regenerated with generateMinutes; a failed follow-up uses answerQuestion.
 */
export async function retryConversationMessage(
  req: Request,
  res: Response<ApiResponse<RetryMessageResponse>>
): Promise<void> {
  const clientId = req.clientId!;
  const conversation = await findOwnedConversation(clientId, req.params.id);

  const last = await Message.findOne({ conversationId: conversation._id }).sort({ seq: -1 });
  if (!last || last.messageType !== 'error') {
    throw AppError.conflict(
      'RETRY_NOT_ALLOWED',
      'Retry is only available when the last message is an error.'
    );
  }

  const lastUser = await Message.findOne({
    conversationId: conversation._id,
    role: 'user',
    seq: { $lt: last.seq },
  }).sort({ seq: -1 });

  if (!lastUser) {
    throw AppError.conflict(
      'RETRY_NOT_ALLOWED',
      'Retry is only available when the last message is an error.'
    );
  }

  const openingUser = await Message.findOne({
    conversationId: conversation._id,
    role: 'user',
  }).sort({ seq: 1 });

  const minutesAlreadySaved = await Message.exists({
    conversationId: conversation._id,
    messageType: 'minutes',
    seq: { $lt: last.seq },
  });

  const retryingMinutes =
    !minutesAlreadySaved && openingUser !== null && lastUser._id.equals(openingUser._id);

  try {
    if (retryingMinutes) {
      const minutes = await getLlmClient().generateMinutes(conversation.sourceText);
      last.content = formatMinutesToMarkdown(minutes);
      last.messageType = 'minutes';
      last.structuredData = minutes;
      await last.save();

      conversation.title = minutes.title || conversation.sourceText.slice(0, 40);
      await conversation.save();
    } else {
      const history = await loadFollowupHistory(conversation._id, lastUser._id);
      const answer = await getLlmClient().answerQuestion(
        conversation.sourceText,
        history,
        lastUser.content
      );
      last.content = answer;
      last.messageType = 'text';
      last.structuredData = undefined;
      await last.save();
    }
  } catch (llmError) {
    last.content = friendlyLlmContent(llmError, 'Failed to regenerate the reply. Please try again.');
    last.messageType = 'error';
    await last.save();
    throw llmError;
  }

  if (res.headersSent || res.destroyed) return;
  res.status(200).json({
    data: {
      message: formatMessage(last),
    },
  });
}
