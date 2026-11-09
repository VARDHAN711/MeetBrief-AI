import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { Composer, MinutesCard } from './App';
import type { ConversationDetail, ConversationSummary, CreateConversationResponse, MessageItem, Minutes } from './types/api';
import { ApiRequestError, api } from './api/client';

vi.mock('./api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('./api/client')>();
  return { ...actual, api: { ...actual.api, list: vi.fn(), messages: vi.fn(), create: vi.fn(), send: vi.fn(), retry: vi.fn(), remove: vi.fn() } };
});

const owner = 'client-id-test';
const summary: ConversationSummary = { id: 'conv-1', title: 'Weekly review', sourceType: 'text', updatedAt: '2026-11-07T00:00:00.000Z' };
const detail: ConversationDetail = { id: summary.id, title: summary.title, sourceType: 'text', createdAt: summary.updatedAt, updatedAt: summary.updatedAt };
const minutes: Minutes = { title: 'Review', summary: 'Summary', decisions: [], actionItems: [{ task: '<b>Ship</b>', assignee: '', deadline: '' }], suggestions: [], pendingIssues: [], limitations: [] };
const msg = (id: string, seq: number, role: 'user' | 'assistant', content: string, messageType: MessageItem['messageType'] = 'text'): MessageItem => ({ id, conversationId: summary.id, seq, role, content, messageType, attachments: [], createdAt: summary.updatedAt });
const storedFailure = [msg('m1', 1, 'user', 'Earlier meeting notes'), msg('m2', 2, 'assistant', 'Earlier answer'), msg('m3', 3, 'user', 'Question that failed'), msg('m4', 4, 'assistant', 'Stored failure message', 'error')];
const response = (messages: MessageItem[] = storedFailure) => ({ conversation: detail, messages });
const rawServerText = 'RAW SERVER DETAILS: private exception text';

async function submit(text = 'The team reviewed the project timeline and agreed to follow up next week.') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } });
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}
async function mountWithList(list: ConversationSummary[] = []) {
  vi.mocked(api.list).mockResolvedValue(list);
  render(<App />);
  await waitFor(() => expect(api.list).toHaveBeenCalled());
}
function getStoredRetryButton() {
  const row = screen.getByText('Stored failure message').closest('.error-message');
  if (!row) throw new Error('Stored error bubble was not rendered');
  return within(row as HTMLElement).queryByRole('button', { name: 'Retry' });
}

describe('Phase 4 client behavior (mock API; no server calls)', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('crypto', { randomUUID: () => owner });
    vi.mocked(api.list).mockResolvedValue([]);
  });

  it('MinutesCard uses missing-value fallbacks and renders HTML-looking text safely', () => {
    const { container } = render(<MinutesCard minutes={minutes} />);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Not specified')).toBeInTheDocument();
    expect(screen.getByText('<b>Ship</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('Composer disables its input and send button while busy', () => {
    render(<Composer busy onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('shows a selected-file chip with name and size and removes it on request', () => {
    const file = new File(['TXT meeting notes for the next review.'], 'agenda.txt', { type: 'text/plain' });
    render(<App />);
    fireEvent.change(screen.getByLabelText('Attach a meeting file'), { target: { files: [file] } });
    expect(screen.getByText('agenda.txt')).toBeInTheDocument();
    expect(screen.getByText('1 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove attached file' }));
    expect(screen.queryByText('agenda.txt')).not.toBeInTheDocument();
  });

  it('disables file attachment inside an existing conversation with the one-meeting tooltip', async () => {
    vi.mocked(api.messages).mockResolvedValue(response([msg('m1', 1, 'user', 'Existing meeting source')]));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    const attach = screen.getByRole('button', { name: '＋' });
    expect(attach).toBeDisabled();
    expect(attach).toHaveAttribute('title', 'One meeting per chat. Start a New Chat to upload another');
  });

  it('shows upload, PDF extraction, and minutes generation stages in order', async () => {
    let resolveCreate!: (value: CreateConversationResponse) => void;
    const createPromise = new Promise<CreateConversationResponse>(resolve => { resolveCreate = resolve; });
    vi.mocked(api.create).mockReturnValue(createPromise);
    await mountWithList();
    const file = new File(['PDF fixture'], 'agenda.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Attach a meeting file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Uploading...')).toBeInTheDocument();
    expect(await screen.findByText('Extracting PDF text...')).toBeInTheDocument();
    expect(await screen.findByText('Generating meeting minutes...')).toBeInTheDocument();
    expect(api.create).toHaveBeenCalledWith(owner, file);
    await act(async () => resolveCreate({ conversation: detail, messages: [msg('m1', 1, 'user', 'Uploaded file: agenda.pdf')] }));
  });

  it('accepts MP3 and WAV audio types and shows audio transcription stages', async () => {
    let resolveCreate!: (value: CreateConversationResponse) => void;
    vi.mocked(api.create).mockReturnValue(new Promise<CreateConversationResponse>(resolve => { resolveCreate = resolve; }));
    await mountWithList();
    const input = screen.getByLabelText('Attach a meeting file') as HTMLInputElement;
    expect(input.accept).toContain('.mp3');
    expect(input.accept).toContain('.wav');
    expect(input.accept).not.toContain('.m4a');
    const file = new File(['small wav fixture'], 'meeting.wav', { type: 'audio/wav' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Uploading...')).toBeInTheDocument();
    expect(await screen.findByText('Transcribing audio...')).toBeInTheDocument();
    expect(await screen.findByText('Generating meeting minutes...')).toBeInTheDocument();
    expect(api.create).toHaveBeenCalledWith(owner, file);
    await act(async () => resolveCreate({ conversation: detail, messages: [msg('audio-user', 1, 'user', 'Uploaded file: meeting.wav')] }));
  });

  it('keeps the audio file chip after transcription fails before a conversation exists', async () => {
    const file = new File(['audio bytes'], 'meeting.mp3', { type: 'audio/mpeg' });
    vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code: 'TRANSCRIPTION_FAILED', message: rawServerText }));
    await mountWithList();
    fireEvent.change(screen.getByLabelText('Attach a meeting file'), { target: { files: [file] } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not transcribe this recording. Try a clearer or shorter file.');
    expect(screen.getByText('meeting.mp3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('failed first message restores stored messages, adds the chat to the sidebar, and shows Retry', async () => {
    const failure = new ApiRequestError({ code: 'LLM_UNAVAILABLE', message: rawServerText, conversationId: summary.id });
    vi.mocked(api.create).mockRejectedValue(failure);
    vi.mocked(api.messages).mockResolvedValue(response());
    vi.mocked(api.list).mockResolvedValueOnce([]).mockResolvedValue([summary]);
    render(<App />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await submit();
    expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
    expect(await within(screen.getByRole('navigation')).findByText('Weekly review')).toBeInTheDocument();
    expect(getStoredRetryButton()).toBeInTheDocument();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.messages).toHaveBeenCalledWith(owner, summary.id);
  });

  it.each(['LLM_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_BAD_OUTPUT', 'LLM_EMPTY', 'RATE_LIMITED'])(
    'shows Retry for %s', async code => {
      vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code, message: rawServerText, conversationId: summary.id }));
      vi.mocked(api.messages).mockResolvedValue(response());
      await mountWithList();
      await submit();
      expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
      expect(getStoredRetryButton()).toBeInTheDocument();
    },
  );

  it('does not show Retry for LLM_CONFIG_ERROR', async () => {
    vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code: 'LLM_CONFIG_ERROR', message: rawServerText, conversationId: summary.id }));
    vi.mocked(api.messages).mockResolvedValue(response());
    await mountWithList();
    await submit();
    expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
    expect(getStoredRetryButton()).not.toBeInTheDocument();
  });

  it.each([
    ['RATE_LIMITED', 'The AI service is busy. Please wait a moment and try again.'],
    ['LLM_CONFIG_ERROR', 'The AI service is not configured. Please contact the administrator.'],
    ['LLM_UNAVAILABLE', 'The AI service is temporarily unavailable. Please try again.'],
    ['LLM_EMPTY', 'The AI could not produce a response. Please try again.'],
    ['LLM_BAD_OUTPUT', 'The AI response could not be read. Please try again.'],
    ['LLM_TIMEOUT', 'The AI request took too long. Please try again.'],
    ['INVALID_INPUT', 'Please check your text and try again.'],
    ['PAYLOAD_TOO_LARGE', 'This text or file is too large. Please shorten it or choose a smaller file.'],
    ['INVALID_CLIENT_ID', 'This browser session is invalid. Refresh the page to start a new session.'],
    ['INVALID_ID', 'That conversation link is invalid. Choose a meeting from the sidebar.'],
    ['CONVERSATION_NOT_FOUND', 'That conversation could not be found. Refresh the meeting list.'],
    ['RETRY_NOT_ALLOWED', 'There is no failed response to retry.'],
    ['BAD_REQUEST', 'The request could not be understood. Please try again.'],
    ['INTERNAL_SERVER_ERROR', 'The server encountered a problem. Please try again.'],
    ['UNKNOWN_CODE', 'Something went wrong. Please try again.'],
  ])('shows a friendly message for %s and hides raw server text', async (code, expected) => {
    vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code, message: rawServerText }));
    await mountWithList();
    await submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(expected);
    expect(alert).not.toHaveTextContent(rawServerText);
  });

  it.each([
    ['UNSUPPORTED_FILE_TYPE', 'This file format is not supported yet. Convert audio to MP3 or WAV, or choose a TXT or PDF file.'],
    ['INVALID_FILE', 'That file is empty, corrupt, or not a valid supported file.'],
    ['NO_EXTRACTABLE_TEXT', 'This PDF seems to be scanned or image-only. This version needs a PDF with selectable text.'],
  ])('shows a friendly message without Retry for upload error %s', async (code, expected) => {
    vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code, message: rawServerText }));
    await mountWithList();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows the friendly TRANSCRIPTION_FAILED message without raw server text or Retry', async () => {
    vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code: 'TRANSCRIPTION_FAILED', message: rawServerText }));
    await mountWithList();
    await submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We could not transcribe this recording. Try a clearer or shorter file.');
    expect(alert).not.toHaveTextContent(rawServerText);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('Retry replaces the error in place without duplicating it or losing earlier messages', async () => {
    vi.mocked(api.messages).mockResolvedValueOnce(response([msg('m1', 1, 'user', 'Earlier meeting notes'), msg('m2', 2, 'assistant', 'Earlier answer')]));
    vi.mocked(api.messages).mockResolvedValueOnce(response());
    vi.mocked(api.send).mockRejectedValue(new ApiRequestError({ code: 'LLM_UNAVAILABLE', message: rawServerText }));
    vi.mocked(api.retry).mockResolvedValue({ message: msg('m4', 4, 'assistant', 'Recovered answer', 'text') });
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    await submit('What did the team decide?');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Recovered answer')).toBeInTheDocument();
    expect(screen.getByText('Earlier meeting notes')).toBeInTheDocument();
    expect(screen.getByText('Earlier answer')).toBeInTheDocument();
    expect(screen.queryByText('Stored failure message')).not.toBeInTheDocument();
    expect(screen.getAllByText('Recovered answer')).toHaveLength(1);
    expect(api.retry).toHaveBeenCalledTimes(1);
  });

  it('a 409 retry response reloads messages and hides Retry when the current last message is not an error', async () => {
    vi.mocked(api.messages).mockResolvedValueOnce(response());
    vi.mocked(api.messages).mockResolvedValueOnce(response([
      msg('m1', 1, 'user', 'Question'),
      msg('m2', 2, 'assistant', 'Resolved by another request'),
    ]));
    vi.mocked(api.retry).mockRejectedValue(new ApiRequestError({ code: 'RETRY_NOT_ALLOWED', message: rawServerText }));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Resolved by another request')).toBeInTheDocument();
    expect(screen.queryByText('Stored failure message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(api.messages).toHaveBeenCalledTimes(2);
    expect(api.messages).toHaveBeenLastCalledWith(owner, summary.id);
  });

  it('a failed retry with LLM_CONFIG_ERROR shows the configuration message and keeps the stored error', async () => {
    vi.mocked(api.messages).mockResolvedValue(response());
    vi.mocked(api.retry).mockRejectedValue(new ApiRequestError({ code: 'LLM_CONFIG_ERROR', message: rawServerText }));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI service is not configured. Please contact the administrator.');
    expect(screen.getByText('Stored failure message')).toBeInTheDocument();
    expect(screen.queryByText(rawServerText)).not.toBeInTheDocument();
  });

  it('failed follow-up reloads messages and shows the stored error with Retry', async () => {
    vi.mocked(api.messages).mockResolvedValueOnce(response([msg('m1', 1, 'user', 'Earlier meeting notes')])).mockResolvedValueOnce(response());
    vi.mocked(api.send).mockRejectedValue(new ApiRequestError({ code: 'LLM_TIMEOUT', message: rawServerText }));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    await submit('What did the team decide?');
    expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
    expect(getStoredRetryButton()).toBeInTheDocument();
    expect(api.messages).toHaveBeenCalledTimes(2);
    expect(api.messages).toHaveBeenLastCalledWith(owner, summary.id);
  });

  it('opening a sidebar item calls only GET messages', async () => {
    vi.mocked(api.messages).mockResolvedValue(response([msg('m1', 1, 'user', 'Earlier meeting notes')]));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    expect(await screen.findByText('Earlier meeting notes')).toBeInTheDocument();
    expect(api.messages).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.retry).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('reopening a conversation shows Retry when the stored error is its last message', async () => {
    vi.mocked(api.messages).mockResolvedValue(response());
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
    expect(getStoredRetryButton()).toBeInTheDocument();
  });

  it('does not show Retry for a stored error that is not the last message', async () => {
    vi.mocked(api.messages).mockResolvedValue(response([
      msg('m1', 1, 'user', 'Question'),
      msg('m2', 2, 'assistant', 'Earlier error', 'error'),
      msg('m3', 3, 'user', 'Later question'),
      msg('m4', 4, 'assistant', 'Later answer'),
    ]));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    const errorBubble = screen.getByText('Earlier error').closest('.error-message');
    expect(errorBubble).not.toBeNull();
    expect(within(errorBubble as HTMLElement).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('a page reload restores the active failed conversation and shows Retry', async () => {
    vi.mocked(api.create).mockRejectedValue(new ApiRequestError({ code: 'LLM_UNAVAILABLE', message: rawServerText, conversationId: summary.id }));
    vi.mocked(api.messages).mockResolvedValue(response());
    vi.mocked(api.list).mockResolvedValue([summary]);
    render(<App />);
    await submit();
    expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('meetbrief-active-conversation')).toBe(summary.id));

    cleanup();
    vi.mocked(api.messages).mockResolvedValue(response());
    render(<App />);
    expect(await screen.findByText('Stored failure message')).toBeInTheDocument();
    expect(getStoredRetryButton()).toBeInTheDocument();
    expect(api.messages).toHaveBeenCalledWith(owner, summary.id);
  });

  it('New Chat clears the active view without making an API write', async () => {
    vi.mocked(api.messages).mockResolvedValue(response([msg('m1', 1, 'user', 'Earlier meeting notes')]));
    await mountWithList([summary]);
    await userEvent.click((await screen.findAllByRole('button', { name: /Weekly review/ }))[0]);
    expect(await screen.findByText('Earlier meeting notes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /New chat/i }));
    expect(screen.queryByText('Earlier meeting notes')).not.toBeInTheDocument();
    expect(screen.getByText(/Make every meeting/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.retry).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('full mocked chat flow stores only the client id in localStorage', async () => {
    const createdMessages = [msg('m1', 1, 'user', 'The team reviewed the project timeline and agreed to follow up next week.'), { ...msg('m2', 2, 'assistant', 'Minutes', 'minutes'), structuredData: minutes }];
    vi.mocked(api.create).mockResolvedValue({ conversation: detail, messages: createdMessages });
    vi.mocked(api.send).mockResolvedValue({ messages: [msg('m3', 3, 'user', 'What is next?'), msg('m4', 4, 'assistant', 'Follow up next week.')] });
    await mountWithList();
    await submit('The team reviewed the project timeline and agreed to follow up next week.');
    await submit('What is next?');
    const storedKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    expect(storedKeys).toEqual(['meetbrief-client-id']);
    expect(localStorage.getItem('meetbrief-client-id')).toBe(owner);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(1);
  });
});
