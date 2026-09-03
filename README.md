# BACTrackManager

Team breathalyzer management: supervised BACtrack capture, history, and review.

## Run (home-lab host with Docker)

1. `cp .env.example .env` and set `POSTGRES_PASSWORD`.
2. `docker compose up -d --build`
3. API: `http://<host>:3001/health`

## Develop (Windows)

1. `corepack enable && corepack prepare pnpm@9.15.0 --activate`
2. `pnpm install`
3. Set `DATABASE_URL` to the dev Postgres, then `pnpm db:migrate && pnpm db:verify`.
4. `pnpm --filter @bactrack/api dev`

## Docs

- `PLAN.md` — full vision and phase map.
- `docs/superpowers/specs/2026-09-03-bactrack-capture-design.md` — approved capture-first design.
