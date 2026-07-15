const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

# Base44 Project

Use this repository to run and edit the app locally, then publish changes back through db.

Any change pushed to the repo will also be reflected in the Base44 Builder.

## Prerequisites

1. Clone the repository using the project's Git URL.
2. Navigate to the project directory.
3. Install dependencies: `npm install`.
4. Install the Base44 CLI: `npm install -g base44@latest`.

See the [Base44 CLI docs](https://docs.db.com/developers/references/cli/get-started/overview) if you want to run Base44 commands directly.

## Run Locally

Run the full local development environment from the project root:

```bash
base44 dev
```

`base44 dev` starts the local Base44 development backend and, when this app is configured for it, also starts the frontend dev server for you. Use the frontend URL printed by the command.

For example, when the Base44 project config includes a `serveCommand`, `base44 dev` can launch the frontend too:

```json5
{
  "site": {
    "serveCommand": "npm run dev"
  }
}
```

In a Base44 project this lives in `base44/config.jsonc`.

## Run Only The Frontend

If you only want to run the frontend against the hosted Base44 backend:

```bash
npm run dev
```

## Vercel deployment and server-side API keys

This project is deployable to Vercel using the root `vercel.json`. Third-party API calls must run through server-side routes under `/api`; the browser must not receive API keys.

Configure these server-only Vercel Environment Variables:

```text
SPORTSGAMEODDS_API_KEY=your_rotated_key
WEATHERAPI_KEY=your_weatherapi_key
```

The Weather API MCP server uses:

```bash
WEATHERAPI_KEY=your_weatherapi_key npx weatherapi-mcp
```

Do not use a `VITE_` prefix for secrets. Do not commit `.env.local`; the repository already ignores `.env.*` while allowing the safe `.env.example` template.

After deployment, configure the variables in Vercel Project Settings → Environment Variables. Never paste real secret values into source files or commit them to GitHub.

Current optional server-side provider variables:

- `ODDS_API_RAPIDAPI_KEY`
- `JSONODDS_RAPIDAPI_KEY`
- `AI_API_KEY` (reserved)

Do not prefix these with `VITE_`; browser code must call internal `/api/*` routes.
