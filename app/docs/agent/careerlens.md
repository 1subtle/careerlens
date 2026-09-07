# CareerLens extension

The CareerLens workspace is at `/`. It uses the upstream resume schema, editor, PDF route, encrypted key store and LiteLLM adapter. New API routes live under `/api/v1/career`; do not replace upstream resume or job routes with incompatible contracts.

Implementation entry points:

- Backend: `apps/backend/app/routers/career.py`, `schemas/career.py`, `services/matching.py`, `services/career_ai.py`.
- Frontend: `apps/frontend/components/career/`, `lib/api/career.ts`.
- ORM: three additive snapshot/match/rewrite models in `apps/backend/app/models.py`.
- Tests: `test_career_matching.py`, `test_career_api.py`; root `scripts/smoke.py` exercises actual HTTP and PDF.

The score is deterministic weighted evidence coverage. AI may extract requirements and draft prose; it never supplies scores or market numbers. No valid requirements means a null score. A missing source is pending, not proof of inability. Human review creates another match record.

Snapshots are immutable. Applying a draft checks the current resume/JD hashes and writes the result, improvement log and accepted state in one transaction. Replays return the original result. Deletion relies on explicit cleanup and actual foreign keys, not assumed upstream string relationships.

Rewrite output has `draft`, `claims[{text,source_ids}]`, `missing_facts`, `reason`. Claims must cover the draft and refer to supplied source IDs. New numeric facts, recognized skills and placeholders are rejected. These checks do not establish full semantic truth; the user confirms the complete draft before acceptance. Provider metadata remains in the payload, without keys.

The market workflow may select only existing category/city values, then calls a fixed aggregate. Numeric prose is rendered from that aggregate. Synthetic rows are excluded by default. Currency and payment periods remain separate. Full Chinese contracts and current validation status are in root `docs/`.

Keep both lockfiles tracked. Root `app/` is a source import, not a nested repository. Runtime data and API keys must stay out of Git. The main workflow is a local personal workspace; the inherited tracker and other auxiliary routes are outside CareerLens acceptance scope.
