# End-to-end acceptance checklist

Use synthetic content and record a result, date, and initials for every test. Do not use a real meeting or API key from a shared/demo account. Start the client/server and local database only when performing this manual checklist.

| # | Steps | Expected result | Result | Date | Initials |
|---:|---|---|---|---|---|
| 1 | Paste a short synthetic transcript and submit. | Structured minutes appear with title, summary, decisions, actions, suggestions, and pending issues. | | | |
| 2 | Paste a longer transcript with multiple participants and decisions. | Minutes capture the main decisions and actions without mixing speakers. | | | |
| 3 | Upload a UTF-8 `.txt` transcript. | Minutes are generated from the file contents. | | | |
| 4 | Upload a selectable-text PDF. | Extracted text produces minutes. | | | |
| 5 | Upload a PDF with no extractable text. | Clear no-text error; no conversation is created. | | | |
| 6 | Upload a valid MP3 or WAV recording. | Audio is transcribed and minutes are generated. | | | |
| 7 | Upload an unsupported file, then an oversized file. | Unsupported type and size errors are clear; temporary files are removed. | | | |
| 8 | Submit a transcript with actions but no deadlines. | Missing dates display as “Not specified”; none are invented. | | | |
| 9 | Submit notes containing proposals but no confirmed decisions. | Proposals appear as suggestions or pending issues, not decisions. | | | |
| 10 | Ask a question answered directly by the source. | Answer is grounded in the meeting source. | | | |
| 11 | Ask a question absent from the source. | Answer says the information is not in the source. | | | |
| 12 | Open a saved chat, refresh the browser, and reopen it. | Stored messages return in sequence and no LLM call is made on restore. | | | |
| 13 | Ask a follow-up, then inspect the earlier messages after restore. | Historic assistant responses are unchanged and not regenerated. | | | |
| 14 | Open New Meeting after a populated chat and submit another synthetic source. | New meeting has no context from the previous meeting. | | | |
| 15 | Cause a Gemini error or timeout in a safe test setup. | Friendly error appears; retry uses the failed turn and does not expose secrets or source text in logs. | | | |
| 16 | Attempt to open another client's conversation using a different `x-client-id`. | Request returns not found; foreign data is not exposed. | | | |
| 17 | Upload an `.m4a` file. | Format is rejected with a clear unsupported-file error. | | | |
| 18 | Upload a fake MP3 that is not valid audio. | Transcription fails clearly and temporary files are removed. | | | |
| 19 | Upload a file above the configured size limit. | Request returns the size-limit error and removes temporary files. | | | |
| 20 | Upload a password-protected PDF. | Extraction fails clearly; no partial meeting is saved. | | | |
| 21 | Export the same completed minutes as Markdown and TXT. | Both downloads contain title, sections, and review note, and exclude transcript text. | | | |
| 22 | Exceed the configured request limit in a controlled test. | API responds with 429 `TOO_MANY_REQUESTS`. | | | |
| 23 | Submit `eval/transcripts/injection.txt` through the UI. | Output follows the minutes schema and does not contain injected `HACKED`. | | | |
| 24 | Delete the currently open chat, then reload the page. | Deleted chat and its source/messages remain absent. | | | |
| 25 | Create a chat, restart the app/database as part of the team's manual test, and reopen it. | Persisted chat and messages are restored unchanged. | | | |
