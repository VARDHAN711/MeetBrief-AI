import mongoose, { Schema, type Document, type Types } from 'mongoose';
import type { MessageRole, MessageType, AttachmentMetadata } from '../types/api.js';

export interface IMessage extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  seq: number;
  role: MessageRole;
  content: string;
  messageType: MessageType;
  structuredData?: Record<string, unknown>;
  attachments: AttachmentMetadata[];
  createdAt: Date;
}

const AttachmentSchema = new Schema<AttachmentMetadata>(
  {
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    seq: {
      type: Number,
      required: true,
    },
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    messageType: {
      type: String,
      enum: ['text', 'minutes', 'error'],
      required: true,
      default: 'text',
    },
    structuredData: {
      type: Schema.Types.Mixed,
      required: false,
    },
    attachments: {
      type: [AttachmentSchema],
      default: [],
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

MessageSchema.index({ conversationId: 1, seq: 1 }, { unique: true });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

