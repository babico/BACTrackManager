FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY apps/worker/package.json ./apps/worker/
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile --filter @bactrack/worker...
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker
RUN pnpm --filter @bactrack/db build && pnpm --filter @bactrack/worker build
# NOTE: @bactrack/db exports TS source for dev ergonomics, so runtime uses tsx (devDep, installed in image).
CMD ["pnpm", "--filter", "@bactrack/worker", "exec", "tsx", "src/index.ts"]
