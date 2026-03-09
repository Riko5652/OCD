// Ensure .env exists — copies from .env.example on first run.
// Called by npm prestart/predev scripts.
import { existsSync, copyFileSync } from 'fs';

if (!existsSync('.env') && existsSync('.env.example')) {
  copyFileSync('.env.example', '.env');
  console.log('  Created .env from .env.example — customize it for LLM features.');
}
