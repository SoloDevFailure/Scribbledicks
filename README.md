# Scribbledicks

A mobile-first real-time party game built with React, TypeScript, Vite, Supabase,
and a server-side OpenAI integration.

The current gameplay wave includes the lobby plus private opening questions, a server-authoritative
60-second deadline, frozen participants, aggregate answer progress, and a
private OpenAI-generated outline. Drawing, storyboards, second-round questions,
narration, audio, and the premiere remain intentionally unimplemented.

## Local setup

1. Install Node.js 20.19+ or 22.12+.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in:

   ```env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-public-anon-key
   ```

   Find both under **Supabase → Project Settings → API**. Use only the public anon key in the frontend. Never add the service-role key.

4. Run the app:

   ```bash
   npm run dev
   ```

## Supabase database setup

Open **Supabase → SQL Editor**, create a new query, paste the complete contents of:

`supabase/migrations/202607290001_initial_lobby.sql`

Run it once. It creates the `rooms` and `players` tables, validation constraints, indexes, row-level security, restricted browser permissions, lobby RPC functions, and Realtime publication entries.

If the initial migration was run before `202607290002_fix_join_room.sql` was
added, run that second migration afterward. It repairs guest joining without
deleting existing rooms or players.

Then run `supabase/migrations/202607290003_opening_questions.sql`. It adds the
game-state tables, private prompt and answer storage, AI jobs, story outlines,
token-validating RPCs, and the first gameplay phase.

## Outline Edge Function

The browser never contacts OpenAI. Deploy the function from a terminal with the
Supabase CLI linked to your project:

```bash
supabase login
supabase link --project-ref your-project-ref
supabase secrets set OPENAI_API_KEY=your-key OPENAI_MODEL=gpt-5-mini
supabase functions deploy compose-outline --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied automatically inside
deployed Supabase Edge Functions. The service-role key and OpenAI key must never
be added to GitHub Pages secrets or any `VITE_` variable.

The function validates the local player session token, claims the single
pending AI job atomically, loads answers itself, requests strict structured JSON
from OpenAI, validates the spoiler-free slot count and content, and stores the
private outline.

For a dashboard-only deployment, create a `compose-outline` Edge Function,
paste `supabase/functions/compose-outline/index.ts`, disable JWT verification
for this function, and set `OPENAI_API_KEY` and `OPENAI_MODEL` under Edge
Function secrets.

## Gameplay smoke test

After applying migration 003 to a development project, run
`supabase/tests/opening_questions_smoke.sql` in the SQL Editor. It tests
three-player and six-player assignment counts, foundational and unique roles,
all-answer early progression, deadline progression with missing answers, and
single AI-job creation. The script runs in a transaction and rolls back all
test data.

If the project already has either table or has already added them to `supabase_realtime`, do not run the migration blindly; review and reconcile it first.

## Checks

```bash
npm run typecheck
npm run build
```

## GitHub Pages

The included GitHub Actions workflow builds and deploys the app whenever
`main` is updated.

1. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
2. Add repository secrets named `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`.
3. Open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Push to `main`, then follow the deployment under the **Actions** tab.

Do not select the repository root as the Pages source. The source files are not
a deployable website until Vite builds them.

## Session and security notes

- A random per-player token is stored in local browser storage so a refresh restores the lobby session.
- The token is written to the database but is not selectable by the public browser role.
- Room creation, joining, starting, heartbeats, and leaving use narrowly scoped database functions.
- Duplicate join requests using the same token are idempotent, and names are unique within a room.
- Leaving through the lobby removes the player immediately. Closing a tab is not fully reliable on the web, so disconnected players remain listed for this milestone; `last_seen_at` is maintained for future presence cleanup.
- Host departure closes the room to new joins.

## Project structure

- `src/App.tsx` — landing, create/join forms, and lobby UI
- `src/lib/lobby.ts` — Supabase lobby operations
- `src/lib/session.ts` — local session persistence
- `src/lib/supabase.ts` — public Supabase client configuration
- `src/types.ts` — shared strict TypeScript types
- `supabase/migrations/` — database schema and security migration
- `supabase/functions/compose-outline/` — server-side OpenAI outline generation
- `supabase/tests/` — rollback-only database smoke tests
