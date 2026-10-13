# Security

- Never commit `.env`, encryption secrets, private keys, bot tokens or connection strings containing credentials.
- Never put secrets in `VITE_` variables: frontend environment values are public.
- Keep the Telegram wallet database and its encryption key isolated and securely backed up.
- Never use production wallets or databases for testing. Test without signing or broadcasting real transactions.
- Keep wallet-account checks, nonce coordination, transaction journals and recovery safeguards intact.
- Do not remove platform fee checks or redirect the approved fee recipient.
- A fork operator controls its own bot wallet custody and must secure its own server and database.
- Treasury referral/payout functionality cannot be operated using Buzzo credentials supplied by this repository; none are distributed.
- Do not post sensitive vulnerability details, user data or wallet exports in public issues.

This repository is not a security-audit report or a guarantee that a deployment is safe to hold funds.
