# Supabase setup

1. Create a Supabase project.
2. In `Authentication -> Providers`, enable `Email`.
3. In `Authentication -> URL Configuration`, add your local dev URL:
   - `http://127.0.0.1:4174`
   - `http://localhost:4174`
   - add your Render production URL too, for sign-in and password recovery
4. Open the SQL editor and run [supabase/schema.sql](/Users/lukasrathsachlang/Downloads/trading-dashboard-project/supabase/schema.sql:1).
5. Copy `.env.example` to `.env` and fill in:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Restart the Vite dev server.

This setup stores one JSON session document per user and protects it with Row Level Security using `auth.uid() = user_id`.
