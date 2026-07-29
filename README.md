# Scribbledicks

A mobile-first real-time party game foundation built with React, TypeScript, Vite, and Supabase.

This milestone includes only the lobby flow: create a room, join by room code, and see players update live. Story generation, prompts, drawing, timers, narration, game rounds, and external integrations are intentionally not included.

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
