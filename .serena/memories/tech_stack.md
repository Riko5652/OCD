# Tech Stack & Architecture
- **Monorepo**: PNPM Workspaces separating `apps/server` and `apps/client`.
- **Backend**: Fastify for high-performance routing. `better-sqlite3` for native SQLite disk storage (replacing in-memory sql.js for efficiency).
- **Frontend**: React, Vite, Tailwind CSS for a premium, fast, and responsive UI.
- **Language**: Strict TypeScript across the board for type safety.
- **AI Adapters**: Strategy pattern implementation to handle complex semantic and context data from tools like Cursor, Windsurf, etc.