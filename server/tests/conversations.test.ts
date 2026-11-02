import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Conversation } from '../src/models/Conversation.js';
import { Message } from '../src/models/Message.js';
import * as llmService from '../src/services/llm.service.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/meetbrief_test';
const VALID_CLIENT_ID_1 = '11111111-1111-4111-8111-111111111111';
const VALID_CLIENT_ID_2 = '22222222-2222-4222-8222-222222222222';
const VALID_MEETING_TEXT =
  'Discussion on Q4 roadmap and architecture deliverables. All stakeholders agreed to prioritize database stability and testing.';

describe('Phase 1 - Persistence core & conversations API', () => {
  beforeAll(async () => {
    await mongoose.connect(TEST_DB_URI);
    await Conversation.syncIndexes();
    await Message.syncIndexes();

    const convIndexes = await Conversation.collection.indexes();
    const msgIndexes = await Message.collection.indexes();
    console.log('\n--- Actual Database Indexes ---');
    console.log('Conversation Collection Indexes:', JSON.stringify(convIndexes, null, 2));
    console.log('Message Collection Indexes:', JSON.stringify(msgIndexes, null, 2));
    console.log('-------------------------------\n');
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Message.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await Message.deleteMany({});
  });

  it('prints and validates actual indexes on both collections', async () => {
    const convIndexes = await Conversation.collection.indexes();
    const msgIndexes = await Message.collection.indexes();

    const hasClientIdUpdatedAt = convIndexes.some(
      (idx) => idx.key && idx.key.clientId === 1 && idx.key.updatedAt === -1
    );
    expect(hasClientIdUpdatedAt).toBe(true);

    const hasConversationIdSeqUnique = msgIndexes.some(
      (idx) => idx.key && idx.key.conversationId === 1 && idx.key.seq === 1 && idx.unique === true
    );
    expect(hasConversationIdSeqUnique).toBe(true);
  });

  it('creates then GET messages returns identical content in seq order', async () => {
    const createRes = await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: VALID_MEETING_TEXT });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data).toBeDefined();
    expect(createRes.body.data.conversation).toBeDefined();
    expect(createRes.body.data.messages).toHaveLength(2);

    const convId = createRes.body.data.conversation.id;
    const [createMsg1, createMsg2] = createRes.body.data.messages;

    expect(createMsg1.seq).toBe(1);
    expect(createMsg1.role).toBe('user');
    expect(createMsg1.content).toBe(VALID_MEETING_TEXT);

    expect(createMsg2.seq).toBe(2);
    expect(createMsg2.role).toBe('assistant');
    expect(createMsg2.messageType).toBe('minutes');
    expect(createMsg2.structuredData).toBeDefined();

    const getRes = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.conversation.id).toBe(convId);
    expect(getRes.body.data.messages).toHaveLength(2);

    const [getMsg1, getMsg2] = getRes.body.data.messages;
    expect(getMsg1).toEqual(createMsg1);
    expect(getMsg2).toEqual(createMsg2);
    expect(getMsg1.seq).toBe(1);
    expect(getMsg2.seq).toBe(2);
  });

  it('concurrent message creation never duplicates seq', async () => {
    const conv = new Conversation({
      clientId: VALID_CLIENT_ID_1,
      title: 'Concurrency Test',
      sourceType: 'text',
      sourceText: VALID_MEETING_TEXT,
      messageCount: 0,
    });
    await conv.save();

    const CONCURRENCY_COUNT = 15;
    const seqPromises = Array.from({ length: CONCURRENCY_COUNT }, async (_, i) => {
      const updated = await Conversation.findOneAndUpdate(
        { _id: conv._id, clientId: VALID_CLIENT_ID_1 },
        { $inc: { messageCount: 1 } },
        { new: true }
      );
      const allocatedSeq = updated!.messageCount;

      const msg = new Message({
        conversationId: conv._id,
        seq: allocatedSeq,
        role: 'user',
        content: `Concurrent test message #${i + 1}`,
      });
      await msg.save();
      return allocatedSeq;
    });

    const allocatedSeqs = await Promise.all(seqPromises);

    const uniqueSeqs = new Set(allocatedSeqs);
    expect(uniqueSeqs.size).toBe(CONCURRENCY_COUNT);

    const sorted = [...allocatedSeqs].sort((a, b) => a - b);
    for (let i = 0; i < CONCURRENCY_COUNT; i++) {
      expect(sorted[i]).toBe(i + 1);
    }

    const messagesInDb = await Message.find({ conversationId: conv._id }).sort({ seq: 1 });
    expect(messagesInDb).toHaveLength(CONCURRENCY_COUNT);

    // Attempting to manually insert duplicate seq must fail due to unique index
    await expect(
      new Message({
        conversationId: conv._id,
        seq: 1,
        role: 'user',
        content: 'Duplicate seq attempt',
      }).save()
    ).rejects.toThrow();
  });

  it('a different x-client-id gets 404 on GET messages and on DELETE', async () => {
    const createRes = await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: VALID_MEETING_TEXT });

    const convId = createRes.body.data.conversation.id;

    const getOtherRes = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('x-client-id', VALID_CLIENT_ID_2);

    expect(getOtherRes.status).toBe(404);
    expect(getOtherRes.body.error.code).toBe('CONVERSATION_NOT_FOUND');

    const deleteOtherRes = await request(app)
      .delete(`/api/conversations/${convId}`)
      .set('x-client-id', VALID_CLIENT_ID_2);

    expect(deleteOtherRes.status).toBe(404);
    expect(deleteOtherRes.body.error.code).toBe('CONVERSATION_NOT_FOUND');

    const getOwnerRes = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(getOwnerRes.status).toBe(200);
  });

  it('a malformed id gets 400', async () => {
    const malformedId = 'not-a-valid-object-id';

    const getRes = await request(app)
      .get(`/api/conversations/${malformedId}/messages`)
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(getRes.status).toBe(400);
    expect(getRes.body.error.code).toBe('INVALID_ID');

    const deleteRes = await request(app)
      .delete(`/api/conversations/${malformedId}`)
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(deleteRes.status).toBe(400);
    expect(deleteRes.body.error.code).toBe('INVALID_ID');
  });

  it('the list omits sourceText', async () => {
    const secretSource =
      'Super confidential transcript with sensitive keyword ALPHA_BETA_GAMMA. All decisions agreed.';

    await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: secretSource });

    const listRes = await request(app)
      .get('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    const item = listRes.body.data[0];
    expect(item.id).toBeDefined();
    expect(item.title).toBeDefined();
    expect(item.sourceType).toBe('text');
    expect(item.updatedAt).toBeDefined();
    expect((item as Record<string, unknown>).sourceText).toBeUndefined();

    const responseString = JSON.stringify(listRes.body);
    expect(responseString).not.toContain('ALPHA_BETA_GAMMA');
  });

  it('delete leaves zero messages', async () => {
    const createRes = await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: VALID_MEETING_TEXT });

    const convId = createRes.body.data.conversation.id;

    const countBefore = await Message.countDocuments({ conversationId: convId });
    expect(countBefore).toBe(2);

    const deleteRes = await request(app)
      .delete(`/api/conversations/${convId}`)
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(deleteRes.status).toBe(204);

    const countAfter = await Message.countDocuments({ conversationId: convId });
    expect(countAfter).toBe(0);

    const convAfter = await Conversation.findById(convId);
    expect(convAfter).toBeNull();
  });

  it('GET messages never calls generateMinutes (spy)', async () => {
    const createRes = await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: VALID_MEETING_TEXT });

    const convId = createRes.body.data.conversation.id;

    const activeClient = llmService.getLlmClient();
    const spy = vi.spyOn(activeClient, 'generateMinutes');

    const getRes = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set('x-client-id', VALID_CLIENT_ID_1);

    expect(getRes.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('validates header x-client-id is a required UUID v4', async () => {
    const noHeaderRes = await request(app)
      .get('/api/conversations')
      .send();

    expect(noHeaderRes.status).toBe(400);
    expect(noHeaderRes.body.error.code).toBe('INVALID_CLIENT_ID');

    const invalidUuidRes = await request(app)
      .get('/api/conversations')
      .set('x-client-id', 'invalid-uuid-12345')
      .send();

    expect(invalidUuidRes.status).toBe(400);
    expect(invalidUuidRes.body.error.code).toBe('INVALID_CLIENT_ID');
  });

  it('rejects text under 30 characters with 400', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: 'Too short text' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects text exceeding MAX_TEXT_CHARS with 413', async () => {
    const hugeText = 'A'.repeat(200001);
    const res = await request(app)
      .post('/api/conversations')
      .set('x-client-id', VALID_CLIENT_ID_1)
      .send({ text: hugeText });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

