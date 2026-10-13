# Forking and branding

1. Fork this repository. Deploy `frontend/` directly; only the bot requires dependency installation.
2. Customize public branding assets without changing Buzzo platform integrations. The frontend contains compiled production assets, not editable React/Vite source.
3. Create your own Telegram bot and set `BUZZO_BOT_USERNAME` and `BUZZO_BOT_TOKEN`. Replace the bot profile image and customize public menu text as needed.
4. Preserve the public fee recipient, contract addresses, fee-account checks, routing settings and wallet safety logic.
5. Use a fresh local database and new operator credentials. Never import production user data.
6. Host frontend SPA routes and the Buzzo API proxy correctly. Private/API-account features need approved service integration; publishing a frontend does not grant administrator access.

Do not run two polling processes with the same Telegram token. Do not claim that an independently operated fork is the official Buzzo service.

Code can be modified by downstream fork owners; this reference distribution cannot make arbitrary source edits impossible. Compatibility relies on retaining the integration and, where applicable, on-chain checks.
