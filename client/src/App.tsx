import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from './api/client';
import { useClientId } from './hooks/useClientId';
import type { ConversationSummary, MessageItem, Minutes } from './types/api';
import './App.css';

const friendly: Record<string, string> = {
  RATE_LIMITED: 'The AI service is busy. Please wait a moment and try again.',
  LLM_CONFIG_ERROR: 'The AI service is not configured. Please contact the administrator.',
  LLM_UNAVAILABLE: 'The AI service is temporarily unavailable. Please try again.',
  LLM_EMPTY: 'The AI could not produce a response. Please try again.',
  LLM_BAD_OUTPUT: 'The AI response could not be read. Please try again.',
  LLM_TIMEOUT: 'The AI request took too long. Please try again.',
  INVALID_INPUT: 'Please check your text and try again.',
  PAYLOAD_TOO_LARGE: 'This text or file is too large. Please shorten it or choose a smaller file.',
  INVALID_CLIENT_ID: 'This browser session is invalid. Refresh the page to start a new session.',
  INVALID_ID: 'That conversation link is invalid. Choose a meeting from the sidebar.',
  CONVERSATION_NOT_FOUND: 'That conversation could not be found. Refresh the meeting list.',
  RETRY_NOT_ALLOWED: 'There is no failed response to retry.',
  BAD_REQUEST: 'The request could not be understood. Please try again.',
  INTERNAL_SERVER_ERROR: 'The server encountered a problem. Please try again.',
  UNSUPPORTED_FILE_TYPE: 'This file format is not supported yet. Convert audio to MP3 or WAV, or choose a TXT or PDF file.',
  INVALID_FILE: 'That file is empty, corrupt, or not a valid supported file.',
  NO_EXTRACTABLE_TEXT: 'This PDF seems to be scanned or image-only. This version needs a PDF with selectable text.',
  TRANSCRIPTION_FAILED: 'We could not transcribe this recording. Try a clearer or shorter file.',
};
const retryable = new Set(['RATE_LIMITED', 'LLM_UNAVAILABLE', 'LLM_EMPTY', 'LLM_BAD_OUTPUT', 'LLM_TIMEOUT']);
const FILE_STAGE_PAUSE_MS = 120;

export function MinutesCard({ minutes }: { minutes: Minutes }) {
  return <article className="minutes-card">
    <h2>{minutes.title}</h2><section><h3>Summary</h3><p>{minutes.summary}</p></section>
    <section><h3>Key decisions</h3>{minutes.decisions.length ? <ul>{minutes.decisions.map((d, i) => <li key={i}><strong>{d.decision}</strong>{d.context && <p>{d.context}</p>}</li>)}</ul> : <p>No confirmed decisions.</p>}</section>
    <section><h3>Action items</h3><div className="table-wrap"><table><thead><tr><th>Task</th><th>Assignee</th><th>Deadline</th></tr></thead><tbody>{minutes.actionItems.map((a, i) => <tr key={i}><td>{a.task}</td><td>{a.assignee || 'Unassigned'}</td><td>{a.deadline || 'Not specified'}</td></tr>)}</tbody></table></div></section>
    <section><h3>Suggestions <small>(not decided)</small></h3>{minutes.suggestions.length ? <ul>{minutes.suggestions.map((s, i) => <li key={i}>{s.text}</li>)}</ul> : <p>None noted.</p>}</section>
    <section><h3>Pending issues</h3>{minutes.pendingIssues.length ? <ul>{minutes.pendingIssues.map((p, i) => <li key={i}>{p.issue}</li>)}</ul> : <p>None noted.</p>}</section>
    {minutes.limitations.length > 0 && <section><h3>Limitations</h3><ul>{minutes.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
    <small className="ai-note">AI-generated content. Please review for accuracy.</small>
  </article>;
}

export function Composer({
  busy,
  onSend,
  allowUpload = true,
  selectedFile = null,
  onFileChange = () => undefined,
}: {
  busy: boolean;
  onSend: (text: string, file?: File) => void;
  allowUpload?: boolean;
  selectedFile?: File | null;
  onFileChange?: (file: File | null) => void;
}) {
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && (text.trim() || selectedFile)) {
      onSend(text.trim(), selectedFile ?? undefined);
      setText('');
    }
  };
  const disabledTitle = 'One meeting per chat. Start a New Chat to upload another';
  return <form className="composer" onSubmit={submit}>
    {selectedFile && <div className="file-chip">
      <span className="file-chip-icon">▤</span>
      <span className="file-chip-text"><strong>{selectedFile.name}</strong><small>{formatFileSize(selectedFile.size)}</small></span>
      <button type="button" aria-label="Remove attached file" onClick={() => { onFileChange(null); if (fileInput.current) fileInput.current.value = ''; }}>×</button>
    </div>}
    <div className="composer-row">
      <button type="button" className="attach" disabled={busy || !allowUpload} title={allowUpload ? 'Attach a meeting file' : disabledTitle} onClick={() => fileInput.current?.click()}>＋</button>
      <input ref={fileInput} className="file-input" type="file" accept=".txt,.pdf,.mp3,.wav,text/plain,application/pdf,audio/mpeg,audio/mp3,audio/wav" aria-label="Attach a meeting file" onChange={event => onFileChange(event.target.files?.[0] ?? null)} />
      <textarea aria-label="Message" placeholder="Paste meeting notes or ask a question…" value={text} onChange={e => setText(e.target.value)} disabled={busy} rows={2} />
      <button type="submit" disabled={busy || (!text.trim() && !selectedFile)}>{busy ? 'Working…' : 'Send'}</button>
    </div>
  </form>;
}

function formatFileSize(sizeBytes: number): string {
  return sizeBytes < 1024 * 1024
    ? `${Math.max(1, Math.round(sizeBytes / 1024))} KB`
    : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ErrorMessage({ message, onRetry, retrying }: { message: MessageItem; onRetry?: () => void; retrying: boolean }) {
  return <div className="error-message"><p>{message.content}</p>{onRetry && <button onClick={onRetry} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry'}</button>}</div>;
}

export default function App() {
  const clientId = useClientId();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => sessionStorage.getItem('meetbrief-active-conversation'));
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [banner, setBanner] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = conversations.find(c => c.id === activeId);

  const refresh = async () => { try { setConversations(await api.list(clientId)); } catch { setBanner('Could not load your conversations. Check that the server is running.'); } };
  useEffect(() => { void refresh(); }, [clientId]);
  useEffect(() => { if (activeId) sessionStorage.setItem('meetbrief-active-conversation', activeId); else sessionStorage.removeItem('meetbrief-active-conversation'); }, [activeId]);
  useEffect(() => {
    if (!activeId) return;
    let current = true;
    setBusy(true);
    void api.messages(clientId, activeId)
      .then(result => { if (current) { setMessages(result.messages); setRetryAllowed(result.messages.at(-1)?.messageType === 'error'); } })
      .catch(error => { if (current) setBanner(errorText(error)); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [clientId]);
  useEffect(() => { if (scrollRef.current) { if (scrollRef.current.scrollTo) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); else scrollRef.current.scrollTop = scrollRef.current.scrollHeight; } }, [messages, stage]);

  const startNew = () => { setActiveId(null); setMessages([]); setBanner(''); setStage(''); setRetryAllowed(false); setSelectedFile(null); setMobileOpen(false); };
  const openChat = async (id: string) => {
    setBusy(true); setBanner('');
    try { const result = await api.messages(clientId, id); setActiveId(id); setMessages(result.messages); setRetryAllowed(result.messages.at(-1)?.messageType === 'error'); setMobileOpen(false); }
    catch (e) { setBanner(errorText(e)); }
    finally { setBusy(false); }
  };
  const handleFailure = (e: unknown) => {
    const error = e instanceof ApiRequestError ? e : null;
    setBanner(errorText(e));
    setRetryAllowed(Boolean(error && retryable.has(error.code)));
    if (error?.conversationId) {
      setActiveId(error.conversationId);
      void api.messages(clientId, error.conversationId).then(r => setMessages(r.messages)).catch(() => undefined);
      void refresh();
    }
  };
  const send = async (text: string, file?: File) => {
    setBusy(true); setBanner('');
    if (!activeId) {
      const displayText = file ? `Uploaded file: ${file.name}` : text;
      const optimistic: MessageItem = { id: `local-${Date.now()}`, conversationId: '', seq: 0, role: 'user', content: displayText, messageType: 'text', attachments: file ? [{ name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size }] : [], createdAt: new Date().toISOString() };
      setMessages([optimistic]);
      try {
        let resultPromise: ReturnType<typeof api.create>;
        if (file) {
          setStage('Uploading...');
          resultPromise = api.create(clientId, file);
          void resultPromise.catch(() => undefined);
          await new Promise<void>(resolve => window.setTimeout(resolve, FILE_STAGE_PAUSE_MS));
          if (file.name.toLowerCase().endsWith('.pdf')) {
            setStage('Extracting PDF text...');
            await new Promise<void>(resolve => window.setTimeout(resolve, FILE_STAGE_PAUSE_MS));
          } else if (/\.(mp3|wav)$/i.test(file.name)) {
            setStage('Transcribing audio...');
            await new Promise<void>(resolve => window.setTimeout(resolve, FILE_STAGE_PAUSE_MS));
          }
          setStage('Generating meeting minutes...');
        } else {
          setStage('Generating meeting minutes...');
          resultPromise = api.create(clientId, text);
        }
        const result = await resultPromise;
        setActiveId(result.conversation.id); setMessages(result.messages); setRetryAllowed(false); setSelectedFile(null); await refresh();
      }
      catch (e) { handleFailure(e); if (e instanceof ApiRequestError && e.conversationId) setSelectedFile(null); }
      finally { setBusy(false); setStage(''); }
    } else {
      setStage('Answering…');
      const optimistic: MessageItem = { id: `local-${Date.now()}`, conversationId: activeId, seq: messages.length + 1, role: 'user', content: text, messageType: 'text', attachments: [], createdAt: new Date().toISOString() };
      setMessages(m => [...m, optimistic]);
      try { const result = await api.send(clientId, activeId, text); setMessages(m => [...m.filter(x => !x.id.startsWith('local-')), ...result.messages]); setRetryAllowed(false); await refresh(); }
      catch (e) { handleFailure(e); try { const restored = await api.messages(clientId, activeId); setMessages(restored.messages); } catch { /* Keep the submitted question visible if reload also fails. */ } }
      finally { setBusy(false); setStage(''); }
    }
  };
  const retry = async () => {
    if (!activeId) return;
    setBusy(true); setBanner('');
    try { const result = await api.retry(clientId, activeId); setMessages(m => m.map(x => x.id === result.message.id ? result.message : x)); setRetryAllowed(false); await refresh(); }
    catch (e) {
      if (e instanceof ApiRequestError && e.code === 'RETRY_NOT_ALLOWED') {
        setBanner(errorText(e));
        try {
          const restored = await api.messages(clientId, activeId);
          setMessages(restored.messages);
          setRetryAllowed(restored.messages.at(-1)?.messageType === 'error');
        } catch (reloadError) { setBanner(errorText(reloadError)); }
      } else handleFailure(e);
    }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    try { await api.remove(clientId, id); setConversations(m => m.filter(c => c.id !== id)); if (activeId === id) startNew(); }
    catch (e) { setBanner(errorText(e)); }
  };
  return <div className="shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-mark">M</span><span>MeetBrief <small>AI</small></span></div>
      <button className="new-chat" onClick={startNew}>＋ <span>New chat</span></button>
      <div className="sidebar-label">YOUR MEETINGS</div>
      <nav>{conversations.map(c => <div className={`conversation-row ${c.id === activeId ? 'active' : ''}`} key={c.id}>
        <button className="conversation-link" onClick={() => void openChat(c.id)}><span className="conversation-icon">◷</span><span>{c.title}</span></button>
        <button className="delete-chat" aria-label={`Delete ${c.title}`} title="Delete conversation" onClick={() => void remove(c.id)}>×</button>
      </div>)}</nav>
      <p className="sidebar-foot">Your meetings, clearly summarized.</p>
    </aside>
    {mobileOpen && <button className="scrim" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><button className="menu-toggle" aria-label="Open menu" onClick={() => setMobileOpen(true)}>☰</button><div><strong>{active?.title || (activeId ? 'Meeting' : 'New conversation')}</strong><span>{active ? 'Meeting workspace' : 'AI meeting assistant'}</span></div><span className="topbar-status"><i /> Ready</span></header>
      <div className="message-area" ref={scrollRef}>
        {!activeId && messages.length === 0 ? <div className="welcome"><div className="welcome-orb">✳</div><p className="eyebrow">MEETBRIEF AI</p><h1>Make every meeting<br /><em>clear and actionable.</em></h1><p className="welcome-copy">Turn conversations into decisions, action items, and answers you can come back to.</p><div className="welcome-options"><div><b>◉</b><span><strong>Upload a recording</strong><small>Audio transcription</small></span></div><div><b>▤</b><span><strong>Upload a transcript or PDF</strong><small>Bring your meeting notes</small></span></div><div><b>✎</b><span><strong>Paste meeting notes</strong><small>Start with text below</small></span></div></div></div> : <div className="messages">{messages.map(m => <div className={`message-row ${m.role}`} key={m.id}><div className="avatar">{m.role === 'user' ? 'You' : 'M'}</div><div className="message-body">{m.messageType === 'minutes' && m.structuredData ? <MinutesCard minutes={m.structuredData} /> : m.messageType === 'error' ? <ErrorMessage message={m} onRetry={m.id === messages.at(-1)?.id && retryAllowed ? retry : undefined} retrying={busy} /> : <div className="bubble">{m.content}</div>}</div></div>)}{stage && <div className="stage"><span className="spinner" />{stage}</div>}</div>}
      </div>
      {banner && <div role="alert" className="banner"><span>{banner}</span><button onClick={() => setBanner('')} aria-label="Dismiss error">×</button></div>}
      <Composer busy={busy} onSend={send} allowUpload={!activeId} selectedFile={selectedFile} onFileChange={setSelectedFile} />
      <p className="privacy-note">Meetings are private to this browser · AI-generated content should be reviewed</p>
    </main>
  </div>;
}
function errorText(e: unknown): string { return e instanceof ApiRequestError ? friendly[e.code] || 'Something went wrong. Please try again.' : 'Something went wrong. Please try again.'; }
