# Five-minute synthetic classroom demo

Use only the synthetic transcript below. Confirm the configured model and quota before the demo; never show `.env` or a key.

## 0:00–0:45 — Set context

Say: “MeetBrief turns a meeting transcript into structured minutes and answers questions from the original source. It is an assistant for review, not an official record.”

## 0:45–2:00 — Create a meeting

Paste this synthetic transcript into New Meeting and submit:

> Maya: We will launch the campus pilot on May 12. Arun will prepare the signup page by May 9. We have not chosen a budget.

Say: “The source includes one decision, one assigned action with a date, and one missing detail. We should check that the output keeps those categories separate.” Point out the decisions, action item, and pending issue in the minutes card.

## 2:00–3:00 — Ask grounded questions

Ask: “Who prepares the signup page, and by when?” Then ask: “What budget did the team choose?”

Say: “The first answer should use the source. The second should say that the budget is not in the source.”

## 3:00–4:00 — Review and export

Point to the saved conversation in the sidebar, open it, and show the Markdown and TXT export actions. Say: “Exports include the reviewed minutes, not the transcript.”

## 4:00–5:00 — Show evaluation and limits

Show `eval/expected/short.json` as DRAFT and the evaluation results table after the team has run and reviewed an evaluation. Say: “Automated counts help find issues; people score correctness, completeness, and usefulness.”

If Gemini returns HTTP 503 or a quota error, do not keep retrying. If the team has verified quota for the alternate model, set `GEMINI_MODEL=gemini-3.5-flash-lite` in the local environment and restart through the team's normal process. Otherwise, show an already-finished synthetic chat and mocked test results. Do not use a real meeting or display environment variables.
