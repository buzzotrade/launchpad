# Production distribution

`frontend/` contains the built static website from the live Buzzo deployment: HTML, compiled JavaScript, CSS and public branding assets. It intentionally contains no Vite configuration, frontend package manifest, source tree or development dependencies.

Deploy this directory directly. Configure SPA fallback routing and forward `/api/*`, `/token-logos/*` and `/x-profiles/*` to the hosted Buzzo platform. A Netlify-style `_redirects` example is included. Private/account features remain subject to the platform's access policies.

The repository-level `netlify.toml` selects `frontend` as the publish directory. Deploy at the root of a website domain, not a GitHub `blob` URL or a GitHub Pages project subdirectory. The frontend's `/assets/`, `/wallets/` and `/quote-logos/` paths resolve from that domain root. Direct requests to public app routes fall back to `index.html`.

The repository does not include the API server, indexer, production databases or administrator pages. Consult https://buzzo.trade/docs for current integration details.

The Telegram bot is separate editable source. Operators must install its dependencies and provide their own isolated database, Telegram token, operator wallet and encryption secret. The bot's existing platform behavior is unchanged.
