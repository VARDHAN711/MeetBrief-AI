# MeetBrief AI — Phase prompts for the coding agent

This file holds one prompt per phase. Work on ONE phase at a time.

**For the agent:** when told "start Phase N", read ONLY that phase's section in this file (from its `## Phase N` heading to the next `## Phase` heading). Do not read, plan, or start any other phase. Always follow `docs/AGENT_RULES.md`. `docs/PLAN.md` is the source of truth for architecture, schema, API and prompts.

**For the human:** start each phase in a fresh conversation on `main` (up to date with `git pull`, working tree clean), with this message (change N, the name, and the section letters if you like; the phase section already names what to read):

```
We are starting Phase N (<name>) of MeetBrief AI.
0. First run `git branch --show-current` and `git status`. The branch must be main and the working tree must be clean. If not, STOP and tell me; do not switch branches, commit or stash anything.
1. Read docs/AGENT_RULES.md and follow it for this whole conversation.
2. Read docs/PROMPTS.md, but ONLY the "Phase N" section. Do not read or start any other phase.
3. Read the sections of docs/PLAN.md that the Phase N section names.
4. Target Node 26. Implement exactly the Phase N section, run its verification, and end with the Verification Report in the format from AGENT_RULES.md. Then stop and wait for me.
```

Lines marked **Human-only** are for you, not the agent. Do not skip them: an agent's report on its own work can overstate. All rows PASS and your check passes: commit and push to main yourself (the agent does not commit), run `git tag phase-N-verified`, tick the phase in section O of the plan, start the next phase. Any FAIL or NOT VERIFIED: paste those rows back with "Fix only these, then re-verify".

---

## Phase 0 — Project setup

Read docs/PLAN.md sections B, C, I, J (Phase 0 row) and L first. Target Node 26 (current 26.x).

Goal: a running skeleton with no features.

Tasks:
1. Root: confirm .gitignore exists and ignores .env, node_modules, dist and server/uploads/ (it was created beforehand; do not weaken it). Create README.md with setup and run steps.
2. server/ (the folder already exists and contains only a .env that you must not read, print or modify): Node + Express + TypeScript (ESM, strict). Dev with tsx watch, build with tsc. Install only: express, mongoose, cors, helmet, dotenv, zod; dev: typescript, tsx, vitest, supertest and the needed @types packages. Add "engines": {"node": ">=26"} to package.json.
3. server/src/config/env.ts: validate env vars with zod (PORT, MONGODB_URI, GEMINI_API_KEY, GEMINI_MODEL, CLIENT_ORIGIN, MAX_TEXT_CHARS, MAX_AUDIO_MB, MAX_DOC_MB). On a missing or invalid value, exit with a clear message naming the variable. GEMINI_API_KEY may be optional in this phase.
4. app.ts exports the express app; index.ts connects MongoDB (local, default port) and then listens. GET /api/health returns {data:{ok:true}}. Add helmet and CORS limited to CLIENT_ORIGIN.
5. Create server/.env.example with every variable name and empty values. Never create, read or modify server/.env.
6. client/: create with Vite (React + TypeScript template), engines node >=26, dev proxy from /api to the server. A placeholder page calls /api/health and shows the result.
7. npm scripts dev, build, typecheck, test in both folders. One supertest health test on the server.

Verification (run these): npm run typecheck and npm test in both folders; start the server and request GET /api/health; start it with MONGODB_URI unset and confirm the clear error; git check-ignore -v server/.env; git status shows no secrets and no node_modules; client build succeeds. If MongoDB is not reachable, report NOT VERIFIED for the DB check.

Acceptance: health returns ok; the client page shows server status; a missing env var fails fast; secrets and uploads are git-ignored.

**Human-only check:** run both dev servers, open the client in the browser, and see the health status.

---

## Phase 1 — Persistence core (no AI yet)

Read docs/PLAN.md sections E, F, G (schema), J (Phase 1 row) and M first.

Goal: conversations and messages are stored in MongoDB and restored exactly, with ownership checks. The LLM is a stub.

Tasks:
1. Mongoose models Conversation and Message exactly as in section E, including the unique index on (conversationId, seq) and the (clientId, updatedAt) index.
2. middleware/clientId.ts: requires header x-client-id as a UUID v4, otherwise 400 INVALID_CLIENT_ID.
3. utils/AppError.ts and middleware/errorHandler.ts: map AppError and unknown errors to {error:{code,message}}; never leak stack traces or raw Mongo errors. Wrap async controllers so rejections reach the handler.
4. Routes and controllers: GET /api/conversations (no sourceText, newest first, max 100); GET /api/conversations/:id/messages; DELETE /api/conversations/:id (messages first, then the conversation); POST /api/conversations accepting JSON {text} only for now (min 30 chars, max MAX_TEXT_CHARS).
5. Every lookup uses {_id, clientId}. A foreign or unknown id returns 404; a malformed id returns 400.
6. Allocate seq with findOneAndUpdate + $inc on messageCount, as in section E.
7. schemas/minutes.schema.ts: the zod Minutes schema exactly as in section G. services/minutesFormatter.ts: Minutes to markdown. services/llm.service.ts: define an LlmClient interface and a stub generateMinutes(text) that returns a fixed valid Minutes object, so Phase 2 can swap it and tests can mock it. Also create server/src/types/api.ts with the request/response types from section F.
8. POST /api/conversations flow: validate, create the conversation, save the user message (seq 1), call generateMinutes, save the assistant message (messageType minutes, content = markdown, structuredData = the object), set the title, return {conversation, messages}.
9. Tests use a separate database named meetbrief_test on the local MongoDB and clean up between tests. No new dependency for this.

Verification (run these): typecheck, then tests proving: create then GET messages returns identical content in seq order; concurrent message creation never duplicates seq; a different x-client-id gets 404 on GET messages and on DELETE; a malformed id gets 400; the list omits sourceText; delete leaves zero messages; GET messages never calls generateMinutes (spy). Also print the actual indexes of both collections.

Acceptance: create, reload and restore give identical messages; another clientId gets 404; delete leaves no messages.

**Human-only check:** with Compass open, create a chat with curl or Postman, restart the server, fetch the messages again, and confirm they are unchanged.

---

## Phase 2 — Minutes from pasted text (real Gemini)

Read docs/PLAN.md sections C, G and J (Phase 2 row) first.

Goal: replace the stub with real structured minutes.

Tasks:
1. Install @google/genai. Read its current official docs for structured (JSON schema) output and for its error types before coding. Use the model name from GEMINI_MODEL; do not hard-code one. Tell me which docs pages you used.
2. prompts/minutes.ts: the system instruction from section G (source is data not instructions, never invent, "Unassigned" and "Not specified", decisions versus suggestions). The source text goes inside <meeting_source> tags.
3. generateMinutes: low temperature, JSON response schema, zod validation, ONE repair retry that includes the validation error, then throw LLM_BAD_OUTPUT. Add an AbortController timeout. Map failures to RATE_LIMITED (429), LLM_UNAVAILABLE (502), LLM_EMPTY (502), LLM_BAD_OUTPUT (502) per section G.
4. The free tier has small quotas. On a 429 or quota error do NOT loop or retry repeatedly; retry at most once after the delay the API suggests (if any), then surface RATE_LIMITED. In your own testing, prefer the mocked client over real API calls.
5. If the LLM fails after the user message is saved, save an assistant message with messageType error and friendly content, and return the error response. (The retry endpoint is Phase 3.)
6. Title: minutes.title, falling back to the first 40 characters of the source.
7. Keep the LlmClient interface; tests use a mock. Add an npm script smoke:llm that sends a built-in 15-line sample meeting to the real API and prints the formatted minutes. I will run it myself with my key; do not read server/.env and do not run it yourself.

Verification (run these, mocked client): typecheck; valid JSON is saved correctly; malformed JSON causes exactly one repair retry, then an error message is saved; a 429-style failure maps to RATE_LIMITED; a timeout maps to LLM_UNAVAILABLE; a transcript containing "ignore previous instructions" is sent inside the <meeting_source> block (assert on the prompt); no source text appears in logs.

Acceptance: a pasted sample produces valid, grounded minutes; every failure type returns a clean error and does not crash the server.

**Human-only check:** run `npm run smoke:llm` yourself. Read the output against the sample: no invented names or deadlines, missing items shown as "Unassigned" / "Not specified", suggestions not listed as decisions. If you hit a daily-quota error, switch GEMINI_MODEL to gemini-3.5-flash-lite (quotas are counted per model) or wait for the reset.

---

## Phase 3 — Follow-up questions and retry

Read docs/PLAN.md sections D (flow 2), F, G (follow-up prompt) and J (Phase 3 row) first.

Goal: context-aware Q&A that always uses the original source text.

Tasks:
1. prompts/followup.ts and answerQuestion(sourceText, history, question) on the LlmClient interface. The source goes in the system instruction inside <meeting_source>; history is the last 10 non-error messages as chat turns. Rules from section G: answer only from the source, separate explicit statements from interpretation, say plainly when the source does not contain the answer, this conversation concerns only this meeting.
2. POST /api/conversations/:id/messages with {content} (1 to 2000 chars, trimmed): ownership check, save the user message, load sourceText and history, answer, save the assistant message, return both. On LLM failure keep the user message and store an error message.
3. POST /api/conversations/:id/retry: only when the last message is an error message (otherwise 409); regenerate the reply for the last user message and replace that error message; return the new message. Retry works for a failed minutes generation too.
4. Error messages are never included in LLM history.

Verification (run these, mocked client): the prompt sent contains the full sourceText, not just the summary (assert); history is capped at 10 and excludes error messages; messages are saved in seq order; a failed LLM call keeps the user message and stores an error message; retry replaces the error and returns 409 when the last message is not an error; a foreign clientId gets 404 on both endpoints; reopening a conversation still allows a follow-up.

Acceptance: an answerable question is answered from the source; an unanswerable one gets a "not in the source" style reply; reopened chats still answer.

**Human-only check:** with the real key, ask one question whose answer is in the meeting and one that is not (for example, "What was the budget?" when none was mentioned).

---

## Phase 4 — Frontend

Read docs/PLAN.md sections F, H, M and J (Phase 4 row) first. The backend from Phases 0 to 3 already works.

Goal: the complete text-only experience in the browser.

Tasks:
1. client/src/types/api.ts: copy the API types from server/src/types/api.ts. client/src/api/client.ts is the ONLY place that calls fetch; it adds x-client-id and unwraps {data} / {error}.
2. hooks/useClientId.ts: generate with crypto.randomUUID() once, store in localStorage. Nothing else is stored in localStorage; messages are never cached there.
3. Layout per section H: sidebar (app name, New Chat, conversation list with active highlight and delete with confirmation; becomes a drawer on narrow screens) and main area (title bar, scrollable messages that auto-scroll to the bottom, composer pinned at the bottom). Dark theme by default, plain CSS.
4. Welcome state when no conversation is active, explaining: upload a recording, upload a transcript or PDF, or paste meeting notes. No fake history. In this phase only pasted text works; show the attach button disabled with a tooltip.
5. First submit in a new chat calls POST /api/conversations and shows the user bubble with a text preview, a stage label ("Generating meeting minutes..."), then the result. Later submits call POST /messages with the label "Answering...". The composer and send button are disabled while busy.
6. MinutesCard renders structuredData as React elements: Summary, Key decisions, Action items table (Task / Assignee / Deadline), Suggestions (not decided), Pending issues, limitations, and a small note that the content is AI-generated and should be reviewed. NEVER use dangerouslySetInnerHTML.
7. New Chat only resets client state (activeId null, messages cleared); it makes no API call. Clicking a sidebar item calls only GET /messages and renders the stored content.
8. Error banner with friendly text per error code; Retry button on LLM_* errors calling /retry.
9. Responsive down to about 375 px wide.
10. You may add vitest, @testing-library/react and jsdom as dev dependencies for component tests.

Verification (run these): typecheck and build; component tests for MinutesCard (missing owner shows Unassigned, missing deadline shows Not specified, HTML in a field is shown as text), for Composer (disabled while busy) and for New Chat (no network call, state cleared); grep confirms no dangerouslySetInnerHTML and no API key in client/. If you can drive a browser against the running servers, walk through: paste text, get minutes, ask a follow-up, New Chat, reopen the first chat, reload the page, delete a chat; attach screenshots and confirm from the network panel that reopening a chat sends only GET /messages. If you cannot drive a browser, list those steps as NOT VERIFIED. Do not make real Gemini calls while testing; use the mocked backend or existing saved data where possible.

Acceptance: the full text-only flow works; reload restores exactly; a new chat shows no trace of the previous meeting.

**Human-only check:** repeat the walkthrough yourself at desktop width and at phone width.

---

## Phase 5 — TXT and PDF input

Read docs/PLAN.md sections C, D (flow 1), F (validation), J (Phase 5 row) and M (files) first.

Goal: files feed the same pipeline as pasted text.

Tasks:
1. Backend: add multer (disk storage in server/uploads/tmp) and unpdf. Read the unpdf README for the current extractText usage and tell me what you used.
2. POST /api/conversations accepts multipart with field name file as well as JSON {text}. Validation: extension allow-list, MIME type as a second signal only, size limits from MAX_DOC_MB, PDF magic bytes (%PDF-), TXT must decode as non-empty UTF-8. Return 400, 413, 415, 422 as in section F.
3. services/extract.service.ts: txt and pdf to text. A PDF with no usable text returns 422 NO_EXTRACTABLE_TEXT with a message that scanned PDFs need OCR, which is not supported yet.
4. Storage names are a random uuid plus the extension. The original name is sanitized (utils/sanitizeFilename.ts) and stored only as display text. Delete the temp file in a finally block on every path, success or failure.
5. Save attachments metadata {name, mimeType, sizeBytes} on the user message and sourceType/originalFilename on the conversation. No file binaries in MongoDB.
6. Frontend: enable the attach button for new chats only (tooltip in existing chats: one meeting per chat, start a New Chat). Show a file chip with name and size and a remove button before sending; stage labels "Uploading...", "Extracting PDF text...", then "Generating meeting minutes..."; friendly messages for each error code.

Verification (run these): typecheck; tests with fixtures (generate them by script, no sensitive content): small TXT; PDF with selectable text; blank PDF; empty TXT; a .exe renamed to .pdf (magic-byte rejection); oversized file; a filename containing ../ . After every test assert server/uploads/tmp is empty. Confirm the user message stores attachment metadata and the conversation stores extracted sourceText. Use the mocked LLM in tests.

Acceptance: TXT and text PDF produce minutes; a blank PDF gives the OCR message and saves nothing; no files remain in uploads/tmp.

**Human-only check:** upload a real text PDF and a screenshot-only PDF from the browser.

---

## Phase 6 — Audio transcription

Read docs/PLAN.md sections C, G (audio), F and J (Phase 6 row) first.

Goal: uploaded recordings become transcripts, then go through the existing pipeline.

Tasks:
1. Before coding, read the current official Gemini docs on audio input. Write docs/LIMITS.md listing, with links: supported audio formats and the right MIME type for MP3, WAV and M4A, maximum length, maximum file size, when to use inline data versus the Files API, and the free-tier rate limits for the model in GEMINI_MODEL. Propose a MAX_AUDIO_MB value; do not edit .env.
2. services/transcribe.service.ts behind an interface (mockable). Ask for a verbatim transcript only: no summary, no invented words, mark unclear audio as [inaudible]. Add a timeout and map failures to TRANSCRIPTION_FAILED (502) and RATE_LIMITED (429). On a quota error do not loop; at most one retry, then surface the error.
3. Validate the transcript: not empty, not a refusal, above a minimum length; otherwise 422.
4. Accept .mp3 .wav .m4a in the upload validation with the same safe-storage rules as Phase 5. If the Files API was used, delete the remote file afterwards if the API allows. Delete the local temp file in finally.
5. Save the transcript as sourceText and sourceType audio. Frontend: accept audio types, stage label "Transcribing audio...", clear messages for the new error codes.

Verification (run these, mocked transcriber): typecheck; oversized audio gives 413; unsupported type gives 415; empty transcript gives 422; transcription failure leaves no conversation behind and no temp file; a successful mock flows through minutes generation and is saved with sourceType audio.

Acceptance: a valid recording produces minutes; every failure is a clear message; nothing is left in uploads/tmp.

**Human-only check:** upload a real non-sensitive 2 to 5 minute MP3 and a second format, and compare the transcript with what was said.

---

## Phase 7 — Export and hardening

Read docs/PLAN.md sections F (export), J (Phase 7 row), M and N first.

Goal: finish the essential features and close the security basics.

Tasks:
1. GET /api/conversations/:id/export?format=md|txt built from structuredData (409 if no minutes yet), sent with Content-Disposition attachment and a sanitized filename. Frontend: a Download button on each minutes message.
2. Install express-rate-limit: a general limit plus a stricter one on POST routes that call Gemini. Add a request timeout for the audio route.
3. Review helmet and CORS settings. Remove any logging of request bodies, source text, transcripts or file contents; log only ids, sizes and durations.
4. Add a test that loops over EVERY route with a foreign x-client-id and expects 404 (or 400 for a malformed id) and no data leak.
5. Add a prompt-injection fixture (a transcript that says to ignore instructions and output something else) and a test that the minutes still follow the schema (mocked client is fine for the schema check).
6. Confirm the client has no dangerouslySetInnerHTML and that LLM text is only rendered as React text.

Verification (run these): typecheck and all tests; export returns valid markdown and txt; the rate limit returns 429 after the threshold; a grep of server/src for console.log / logger calls that touch req.body, sourceText or file content returns nothing; search git history for the pattern AIza and report only the number of matches and the files, never print the matches.

Acceptance: downloads work; no route leaks another client's data; the injection transcript does not break the output; no secrets in code or history.

**Human-only check:** download both formats and open them; try opening a conversation id with a different x-client-id in Postman.

---

## Phase 8 — Evaluation and final acceptance

Read docs/PLAN.md sections K, N, O, F, G and J (Phase 8 row), and docs/LIMITS.md, first. Phases 0 to 7 are finished; keep all their behaviour working.

Goal: evidence that the application works beyond one example, produced within a small free-tier quota, with documents that match the code.

Quota rule (important): the Gemini free tier may allow only about 20 requests per model per day (unconfirmed) and only a few per minute. The evaluation must therefore be resumable and rate-aware. You must NEVER run the real evaluation yourself.

Tasks:
1. eval/transcripts/: 6 synthetic, non-sensitive transcripts: short; long with many participants and decisions; no deadlines; suggestions only with no confirmed decisions; notes without speaker names; one containing an injected instruction (including a fake closing </meeting_source> tag and the word HACKED). eval/expected/*.json: expected decisions, action items (assignee, deadline) and pending issues as skeletons marked DRAFT; the team will review and correct every one.
2. eval/run.ts, run with npm run eval, using the same LlmClient code path as the server (generateMinutes and answerQuestion), with these options: --only <name>, --runs <n> (default 1), --questions (include the follow-up questions), --delay-ms <n> (default 15000, pause between calls), --force (redo items already done), --yes (skip the confirmation). Behaviour: before any call, print how many API calls the plan will make and ask for confirmation unless --yes; skip items already stored in the results file for the same model unless --force; write the results file after EVERY call so nothing is lost; on the first rate-limit, quota, overload or timeout error stop immediately, print what is done and what remains, and exit normally (no loop and no extra retry beyond what the client already does); never print the API key or the environment. Save results under eval/results/ (leave that folder git-ignored).
3. Automatic metrics per run: schema valid, latency, number of decisions and action items versus the expected file, count of items marked Unassigned / Not specified, any assignee name or date that does not appear in the transcript (flag as possible invention), any expected suggestion that the model listed as a decision, and for the injected transcript whether the injected word appears in the output. Leave the human-scored columns (decision correctness, completeness, usefulness) blank for the team. Produce a markdown results table the team can paste into the report.
4. eval/questions.json: for 2 of the transcripts, 5 follow-up questions each (3 answerable, 2 not answerable from the source). The runner asks each question independently with answerQuestion(sourceText, [], question) and records the answer for human scoring. A first full pass is therefore 6 + 10 = 16 calls (a second pass of the transcripts adds 6).
5. Tests for the runner using a mocked client (no real API): resumes without repeating finished items, stops at the first rate-limit error, never prints key-like strings, computes the metrics correctly (including the invention flag and the suggestion-as-decision flag). Also verify that `npm run eval -- --help` prints the options.
6. docs/E2E_CHECKLIST.md: every test in brief section 14 as a step-by-step manual checklist with expected results, plus the extra checks from Phases 5 to 7 (M4A rejected, fake MP3, oversized file, password-protected PDF, export of both formats, rate limit, injection transcript, delete the open chat then reload, restart persistence). Add a column for result, date and initials.
7. Docs-versus-code check: compare docs/PLAN.md sections F, G and L, and docs/LIMITS.md, with the actual code (server/src, client/src, server/.env.example, env.ts). Do NOT edit docs/PLAN.md. Report a table of mismatches: what the document says | what the code does | file. Verify the HTTP status of every error code in the section F table against the code. Also check README.md against package.json scripts and server/.env.example and fix README only.
8. Final acceptance: go through every item of section N of the plan and report PASS / FAIL / NOT VERIFIED with evidence (for secrets report counts and file names only, never the matches).
9. README.md: setup, run, scripts (dev, build, test, typecheck, smoke:llm, eval), environment variables, limitations (anonymous ID is not authentication; local temp files; free-tier quotas, overload (503) and rate limits; free-tier data may be used by Google, so use sample data only; MP3 and WAV only; no OCR; PDFs up to 300 pages; no chunking above MAX_TEXT_CHARS; PDF extraction briefly blocks the server). No keys anywhere.
10. docs/DEMO.md: a 5-minute classroom demo script using synthetic data only (what to paste, what to click, what to say), plus a fallback plan for when Gemini returns 503 or a quota error (switch GEMINI_MODEL to gemini-3.5-flash-lite, show an already-finished chat, show the test results).
11. No new dependencies. Do not read server/.env, do not call the real API, do not start any service, do not commit.

Verification (run these): typecheck, build and all server and client tests; the runner tests; `npm run eval -- --help`. Every PASS must cite a real test name or command output; mark anything you did not run NOT VERIFIED. End with the Verification Report in the format from AGENT_RULES.md, including "Deviations from the plan" and "Known risks or follow-ups", plus the mismatch table from task 7.

Acceptance: every section N item is PASS or explicitly handed to the team; the runner, the checklists and the results format exist; the mismatch table is delivered.

**Human-only check:** review and correct every expected JSON file first. Then run the real evaluation yourself in portions, for example `npm run eval -- --only <name>` on day one and `npm run eval -- --questions` on day two, with GEMINI_MODEL stated in the report. Score the human columns, run the E2E checklist once end to end, rehearse the demo script, and tell Claude the mismatch table so the plan can be corrected.

---

## If an agent goes off-plan

Paste: "You changed X, which the plan says is Y. Revert it and follow the plan, or explain why the plan is wrong." Nothing is committed until a phase passes your check, so a bad phase can be thrown away without touching earlier work: run `git status`, then `git restore .` and `git clean -fd` (git-ignored files such as server/.env are left alone). Check `git status` first, because `git clean -fd` deletes untracked files for good.