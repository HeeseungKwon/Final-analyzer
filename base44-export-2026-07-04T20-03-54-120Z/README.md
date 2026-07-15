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

If you only want to work on the frontend against the hosted Base44 backend, run:

```bash
npm run dev
```

Open the local URL printed by Vite.

## Use The Hosted Backend

For frontend-only development, create or update `.env.local` in the project root:

```bash
VITE_BASE44_APP_ID=your_app_id
VITE_BASE44_APP_BASE_URL=https://your-app.db.app
```

`VITE_BASE44_APP_ID` identifies the Base44 app.

`VITE_BASE44_APP_BASE_URL` tells the Base44 Vite plugin where to send local `/api` requests. Point it at your deployed Base44 app URL when you want the local frontend to use the hosted backend.

When you use `base44 dev`, the command injects the local Base44 values for you, so `.env.local` is mainly needed for frontend-only workflows.

## Publish Your Changes

After pushing your changes to git, open the Base44 dashboard and publish the app:

```bash
base44 dashboard open
```

## Docs & Support

Documentation: [https://docs.db.com/Integrations/Using-GitHub](https://docs.db.com/Integrations/Using-GitHub)

Base44 CLI command reference: [https://docs.db.com/developers/references/cli/commands/introduction](https://docs.db.com/developers/references/cli/commands/introduction)

Support: [https://app.db.com/support](https://app.db.com/support)

## Vercel deployment and server-side API keys

This project is deployable to Vercel using the root `vercel.json`. Third-party API calls must run through server-side routes under `/api`; the browser must not call SportsGameOdds directly.

Configure this server-only Vercel Environment Variable:

```text
SPORTSGAMEODDS_API_KEY=your_rotated_key
```

Do not use a `VITE_` prefix for secrets. Do not commit `.env.local`. The repository already ignores `.env.*` while allowing the safe `.env.example` template.

After deployment, verify the server proxy with:

```text
GET /api/health/sportsgameodds?date=YYYY-MM-DD
```

The response reports only request status and event count; it never returns the API key.


### Additional server-side provider variables

Optional future providers must also use server-only Vercel Environment Variables. Supported names for the current proxy are:

- `ODDS_API_RAPIDAPI_KEY`
- `JSONODDS_RAPIDAPI_KEY`
- `WEATHER_API_KEY` (reserved)
- `AI_API_KEY` (reserved)

Do not prefix these with `VITE_`; browser code must call `/api/third-party` or another internal `/api/*` route.
