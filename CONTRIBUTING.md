# Contributing to OCD

First off, thank you for considering contributing to OCD! This project thrives on community contributions.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. We expect all contributors to maintain a welcoming and inclusive environment.

## Getting Started

1. **Fork the repository** on GitHub.
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/OCD.git
   cd OCD
   ```
3. **Install dependencies**:
   ```bash
   npm install
   # or
   pnpm install
   ```
4. **Create a new branch** for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

- The project uses a monorepo structure.
- `apps/client` is the Vite-based React frontend.
- `apps/server` is the Express/Fastify API server and SQLite analytics engine.
- You can run both concurrently via:
  ```bash
  npm run dev
  ```

## Pull Request Process

1. Ensure your code satisfies the linting and formatting standards (`npm run lint`).
2. Update any relevant documentation (e.g., `README.md`) if you added new features or changed behaviors.
3. Open a Pull Request from your branch to our `main` branch.
4. Describe your changes clearly in the PR description, linking to any relevant issues.

## Reporting Bugs

When filing an issue, please ensure you include:
- Your operating system and Node.js version.
- The version of OCD you are running.
- A clear, step-by-step reproduction of the bug.
- Any relevant logs or errors shown in the terminal.

We appreciate your effort in making OCD better!
