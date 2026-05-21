# Supabase setup

1. Create a Supabase project.
2. In `Authentication -> Providers`, enable `Email`.
3. In `Authentication -> URL Configuration`, add your local dev URL:
   - `http://127.0.0.1:4174`
   - `http://localhost:4174`
   - `https://posture-chi.vercel.app`
4. Open the SQL editor and run [supabase/schema.sql](/Users/lukasrathsachlang/Downloads/trading-dashboard-project/supabase/schema.sql:1).
5. Copy `.env.example` to `.env` and fill in:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Restart the Vite dev server.

## Vercel deployment

Use these settings when importing the repo into Vercel:

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Environment Variables:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

The production dashboard URL is `https://posture-chi.vercel.app`.

This setup stores one JSON session document per user and protects it with Row Level Security using `auth.uid() = user_id`.
