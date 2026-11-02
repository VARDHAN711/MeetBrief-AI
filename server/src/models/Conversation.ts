import mongoose, { Schema, type Document, type Types } from 'mongoose';
import type { SourceType } from '../types/api.js';

export interface IConversation extends Document {
  _id: Types.ObjectId;
  clientId: string;
  title: string;
  sourceType: SourceType;
  originalFilename?: string;
  sourceText: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    clientId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
      default: 'Generating minutes...',
    },
    sourceType: {
      type: String,
      enum: ['text', 'txt', 'pdf', 'audio'],
      required: true,
      default: 'text',
    },
    originalFilename: {
      type: String,
      required: false,
    },
    sourceText: {
      type: String,
      required: true,
    },
    messageCount: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

ConversationSchema.index({ clientId: 1, updatedAt: -1 });

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);

