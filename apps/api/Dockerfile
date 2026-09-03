FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile --filter @bactrack/api...
COPY packages/db ./packages/db
COPY apps/api ./apps/api
RUN pnpm --filter @bactrack/db build && pnpm --filter @bactrack/api build
EXPOSE 3001
# NOTE: @bactrack/db exports TS source for dev ergonomics, so runtime uses tsx (devDep, installed in image).
CMD ["pnpm", "--filter", "@bactrack/api", "exec", "tsx", "src/main.ts"]
