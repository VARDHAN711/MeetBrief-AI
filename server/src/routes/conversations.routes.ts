import { Router } from 'express';
import { clientIdMiddleware } from '../middleware/clientId.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { uploadSingleFile } from '../middleware/upload.js';
import {
  listConversations,
  createConversation,
  getConversationMessages,
  deleteConversation,
  postConversationMessage,
  retryConversationMessage,
} from '../controllers/conversations.controller.js';

export const conversationsRouter = Router();

conversationsRouter.use(clientIdMiddleware);

conversationsRouter.get('/', asyncHandler(listConversations));
conversationsRouter.post('/', uploadSingleFile, asyncHandler(createConversation));
conversationsRouter.get('/:id/messages', asyncHandler(getConversationMessages));
conversationsRouter.post('/:id/messages', asyncHandler(postConversationMessage));
conversationsRouter.post('/:id/retry', asyncHandler(retryConversationMessage));
conversationsRouter.delete('/:id', asyncHandler(deleteConversation));

