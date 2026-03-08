/**
 * Sanitizes user-generated text before embedding in LLM prompts.
 * Prevents prompt injection from malicious project files or session titles.
 */

const INJECTION_PATTERNS = [
  /ignore (all |previous |prior )?instructions?/gi,
  /\[INST\]|\[\/INST\]/g,
  /<\|im_start\|>|<\|im_end\|>/g,
  /system:/gi,
  /###\s*(system|human|assistant)/gi,
];

/**
 * @param {string} text - Raw text from DB (session label, file path, prompt preview)
 * @param {number} maxLen - Maximum length after sanitization
 */
export function sanitizeForPrompt(text, maxLen = 300) {
  if (!text || typeof text !== 'string') return '';
  let clean = text.replace(/<[^>]+>/g, '');
  for (const p of INJECTION_PATTERNS) clean = clean.replace(p, '[filtered]');
  return clean.slice(0, maxLen);
}
