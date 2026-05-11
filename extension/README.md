# Chrome extension

This extension now injects an in-page overlay on Axiom, so paper trading happens inside the trading site instead of only through the popup.

## Setup

1. Copy `config.example.js` to `config.js`.
2. Fill in:
   - `supabaseUrl`
   - `supabaseAnonKey`
   - `dashboardUrl`
3. In Supabase, run the SQL in `supabase/schema.sql` so the `user_paper_trades` table exists.
4. In Chrome, open `chrome://extensions`.
5. Enable `Developer mode`.
6. Click `Load unpacked` and choose the `extension` folder.
7. Open a coin page on `https://axiom.trade/meme/...` and look for the instant trade overlay on the left side.

## Notes

- The overlay uses the same Supabase project and the same user credentials as the dashboard.
- The extension session and open paper positions are stored in `chrome.storage.local`.
- The current Axiom integration is heuristic: it tries to detect token and market cap from the page and supports `Paper Buy` / `Paper Sell`.
- Completed paper trades are stored in Supabase and the dashboard imports them automatically.
