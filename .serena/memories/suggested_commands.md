# Suggested Commands
- `npx pnpm i`: Install dependencies in the monorepo.
- `npx pnpm dev` (in `apps/server`): Start the Fastify backend.
- `npx pnpm dev` (in `apps/client`): Start the Vite React frontend.
- `npx pnpm build`: Build both projects.
- `npm rebuild better-sqlite3` (in `apps/server`): Fix native binding issues on Windows if needed.