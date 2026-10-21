You are building MeetBrief AI one phase at a time. Follow these rules in every phase.

1. Read docs/PLAN.md before starting. It is the source of truth for architecture, schema, API, prompts and phases. Read docs/SPEC.pdf only if the plan is unclear. If your idea disagrees with the plan, follow the plan and tell me; never change it silently.
2. Do only the phase I give you. No extra features. No dependencies beyond those named in the plan or the phase prompt; if you think one is needed, stop and ask.
3. TypeScript strict mode on server and client. No `any` without a comment giving the reason. Validate at runtime with zod and derive types with z.infer.
4. Secrets: never read, print, log or commit server/.env or any API key. Use server/.env.example for variable names. The client must never contain a key.
5. Never log meeting text, transcripts or file contents. Log ids, sizes and durations only.
6. API shape: success is {data}, failure is {error:{code,message}}, exactly as in section F of the plan.
7. For the Gemini SDK and the PDF library, read their current official documentation before writing code and tell me which pages you used. Do not rely on memory for model names, limits or method signatures.
8. Verification: after implementing, run the checks yourself (typecheck, tests, and the commands in the phase prompt). Never report PASS for something you did not run. If you cannot run it, report NOT VERIFIED and tell me what to do.
9. Finish with a Verification Report, then stop and wait:
    - Phase and branch name
    - Table: Acceptance criterion | How you checked it | Result (PASS / FAIL / NOT VERIFIED) | Evidence (short output summary)
    - Files created or changed, one line each
    - Deviations from the plan, and why
    - Known risks or follow-ups
10. Commit on the current phase branch with a clear message. Do not merge and do not start the next phase.