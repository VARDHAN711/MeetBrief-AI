import { Router } from 'express';
import { clientIdMiddleware } from '../middleware/clientId.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { geminiRateLimit } from '../middleware/rateLimit.js';
import { responseTimeout } from '../middleware/responseTimeout.js';
import {
  listConversations,
  createConversation,
  getConversationMessages,
  deleteConversation,
  postConversationMessage,
  retryConversationMessage,
  exportConversation,
} from '../controllers/conversations.controller.js';

export const conversationsRouter = Router();

conversationsRouter.use(clientIdMiddleware);

conversationsRouter.get('/', responseTimeout(120_000), asyncHandler(listConversations));
conversationsRouter.post('/', geminiRateLimit, responseTimeout(420_000), uploadSingleFile, asyncHandler(createConversation));
conversationsRouter.get('/:id/messages', responseTimeout(120_000), asyncHandler(getConversationMessages));
conversationsRouter.post('/:id/messages', geminiRateLimit, responseTimeout(120_000), asyncHandler(postConversationMessage));
conversationsRouter.post('/:id/retry', geminiRateLimit, responseTimeout(120_000), asyncHandler(retryConversationMessage));
conversationsRouter.get('/:id/export', responseTimeout(120_000), asyncHandler(exportConversation));
conversationsRouter.delete('/:id', responseTimeout(120_000), asyncHandler(deleteConversation));

