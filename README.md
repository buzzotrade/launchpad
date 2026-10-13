<p align="center"><img src="./frontend/buzzo-token.png" alt="Buzzo token logo" width="150" /></p>

# Buzzo Launchpad

**The production Buzzo web frontend and a forkable Telegram trading bot for BNB Smart Chain.**

[Visit Buzzo](https://buzzo.trade) · [Official documentation](https://buzzo.trade/docs) · [Official Telegram bot](https://t.me/Buzzotrade_bot)

## About the project

Buzzo connects token launches, market discovery, wallet-based trading and ecosystem tools in one platform. Its public interface includes token exploration, token pages and charts, launch tools, public fee displays, analytics and ecosystem information.

This repository distributes the **built production website**, exported from the live deployment, alongside the Telegram bot source. It is not a Vite starter or a development scaffold.

## What's included

```text
launchpad/
├── frontend/     # Production HTML, compiled JavaScript, CSS and public assets
│   ├── assets/   # Compiled application scripts, styles and fonts
│   ├── index.html
│   └── _redirects
├── bot/          # Forkable Telegram bot source and blank configuration example
├── docs/         # Deployment, forking and security guidance
└── README.md
```

No backend API implementation, administrator pages, production databases, wallet exports, private keys, credentials or VPS deployment tooling is included.

## Deploy the frontend

Publish **`frontend/` directly** with your static hosting provider. No dependency installation or frontend build command is required.

- Serve the included HTML, JavaScript, CSS, logos and fonts together, preserving their paths.
- Configure single-page application routing to fall back to `index.html`.
- Forward `/api/*` to Buzzo's hosted API, preserving the request path.
- Forward token-logo and X-profile image requests to the hosted platform.
- A Netlify-style `_redirects` example is included.

Use **`frontend` as the publish directory**, leave the build command empty, and deploy at the root of your website domain. Website routes are `/`, `/explore`, `/launch`, `/token/<address>` and the other public platform routes. Refreshing or opening a route directly must fall back to `index.html`.

GitHub URLs containing `blob/main` display repository files; they do not run the website. The README logo uses a relative image path. GitHub Pages project-path hosting is not configured in this production export; use a root-domain static host with the required API forwarding.

The frontend uses Buzzo's deployed services; this repository does not provide replacement backend services. Account-dependent functionality remains subject to the platform's integration and approved-origin policies.

Follow [buzzo.trade/docs](https://buzzo.trade/docs) for current platform configuration and integration information.

## Fork the bot

Requirements: Node.js 22.12 or newer, pnpm and your own dedicated MySQL database.

```bash
cd bot
pnpm install
cp .env.example .env
# Supply your own Telegram bot token, operator credentials and encryption secret.
pnpm db:init
pnpm start
```

Create your own bot through BotFather and set its username in `.env`. Customize its profile image and public menu text as needed. Keep platform integration settings consistent with the official documentation.

Each operator must use a fresh database and their own credentials. Forking does not grant access to Buzzo's production accounts, user wallets, private services or administrator permissions.

## Customization

The frontend is a compiled production distribution, not an editable React source project. You can host it and replace public branding assets; deeper application changes require the corresponding application source and a separate build process. The `bot/` folder contains editable bot source.

## Security

Never publish `.env`, bot tokens, private keys, database backups or wallet exports. The Telegram bot manages encrypted wallets and requires careful custody, access controls and independent security review before handling real user funds.

Read [deployment guidance](docs/ARCHITECTURE.md), [forking guidance](docs/FORKING.md) and [security guidance](docs/SECURITY.md).

## Contributions

Open an issue for reproducible bugs or submit focused pull requests with clear verification steps. Keep sensitive information out of public issues and commits.
