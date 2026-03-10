// Browser bookmarklet for capturing AI chat sessions
// Supports: ChatGPT, Claude.ai, Gemini
// NOTE: DOM selectors WILL break as platforms update their UIs.
// Update the SCRAPERS object when selectors change.

export const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: ['chatgpt', 'claude-web', 'gemini-web', 'custom'] },
    title: { type: 'string' },
    started_at: { type: 'string', format: 'date-time' },
    model: { type: 'string' },
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string', maxLength: 2000 },
        },
        required: ['role', 'content'],
      },
    },
  },
  required: ['tool', 'turns'],
};

// The actual bookmarklet code as a template literal
const BOOKMARKLET_SOURCE = `
(function(){
  var MAX_CONTENT = 2000;
  var ENDPOINT = 'http://localhost:3030/api/sessions/import';

  function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s || ''; }

  function detectPlatform() {
    var h = location.hostname;
    if (h.includes('chat.openai.com') || h.includes('chatgpt.com')) return 'chatgpt';
    if (h.includes('claude.ai')) return 'claude-web';
    if (h.includes('gemini.google.com')) return 'gemini-web';
    return null;
  }

  // --- ChatGPT scraper ---
  function scrapeChatGPT() {
    var turns = [];
    // Try data-message-author-role attribute first
    var msgs = document.querySelectorAll('[data-message-author-role]');
    if (msgs.length === 0) {
      // Fallback: alternating message containers
      msgs = document.querySelectorAll('main .group\\\\/conversation-turn');
    }
    msgs.forEach(function(el) {
      var role = el.getAttribute('data-message-author-role') || '';
      if (role === 'user' || role === 'assistant') {
        var text = el.innerText || '';
        turns.push({ role: role, content: truncate(text.trim(), MAX_CONTENT) });
      }
    });
    // If attribute approach failed, try generic alternating
    if (turns.length === 0) {
      var all = document.querySelectorAll('[class*="message"]');
      var i = 0;
      all.forEach(function(el) {
        var text = (el.innerText || '').trim();
        if (text.length > 10) {
          turns.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: truncate(text, MAX_CONTENT) });
          i++;
        }
      });
    }
    var title = document.title || 'ChatGPT Session';
    var model = '';
    var modelEl = document.querySelector('[class*="model"]');
    if (modelEl) model = modelEl.innerText || '';
    return { tool: 'chatgpt', title: title, model: model, turns: turns };
  }

  // --- Claude.ai scraper ---
  function scrapeClaude() {
    var turns = [];
    // Claude uses data-testid or role-based classes
    var humanEls = document.querySelectorAll('[data-testid="human-turn"], .human-turn, [class*="human"]');
    var assistantEls = document.querySelectorAll('[data-testid="ai-turn"], .ai-turn, [class*="assistant"]');
    // If we got both, interleave
    if (humanEls.length > 0 || assistantEls.length > 0) {
      var maxLen = Math.max(humanEls.length, assistantEls.length);
      for (var i = 0; i < maxLen; i++) {
        if (humanEls[i]) turns.push({ role: 'user', content: truncate((humanEls[i].innerText || '').trim(), MAX_CONTENT) });
        if (assistantEls[i]) turns.push({ role: 'assistant', content: truncate((assistantEls[i].innerText || '').trim(), MAX_CONTENT) });
      }
    }
    // Fallback: find message containers
    if (turns.length === 0) {
      var all = document.querySelectorAll('[class*="message"], [class*="Message"]');
      var j = 0;
      all.forEach(function(el) {
        var text = (el.innerText || '').trim();
        if (text.length > 10) {
          turns.push({ role: j % 2 === 0 ? 'user' : 'assistant', content: truncate(text, MAX_CONTENT) });
          j++;
        }
      });
    }
    var title = document.title || 'Claude Session';
    return { tool: 'claude-web', title: title, model: 'claude', turns: turns };
  }

  // --- Gemini scraper ---
  function scrapeGemini() {
    var turns = [];
    // Gemini uses message-content containers
    var userEls = document.querySelectorAll('.user-query, [class*="query-text"], [data-message-author="user"]');
    var modelEls = document.querySelectorAll('.model-response, [class*="response-text"], [data-message-author="model"]');
    if (userEls.length > 0 || modelEls.length > 0) {
      var maxLen = Math.max(userEls.length, modelEls.length);
      for (var i = 0; i < maxLen; i++) {
        if (userEls[i]) turns.push({ role: 'user', content: truncate((userEls[i].innerText || '').trim(), MAX_CONTENT) });
        if (modelEls[i]) turns.push({ role: 'assistant', content: truncate((modelEls[i].innerText || '').trim(), MAX_CONTENT) });
      }
    }
    // Fallback
    if (turns.length === 0) {
      var all = document.querySelectorAll('[class*="message"]');
      var j = 0;
      all.forEach(function(el) {
        var text = (el.innerText || '').trim();
        if (text.length > 10) {
          turns.push({ role: j % 2 === 0 ? 'user' : 'assistant', content: truncate(text, MAX_CONTENT) });
          j++;
        }
      });
    }
    var title = document.title || 'Gemini Session';
    return { tool: 'gemini-web', title: title, model: 'gemini', turns: turns };
  }

  function showToast(msg, isError) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;padding:12px 20px;border-radius:8px;font-family:system-ui;font-size:14px;color:white;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;';
    d.style.background = isError ? '#ef4444' : '#22c55e';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function() { d.style.opacity = '0'; setTimeout(function() { d.remove(); }, 300); }, 3000);
  }

  // --- Main ---
  var platform = detectPlatform();
  if (!platform) {
    showToast('Not on a supported AI chat page (ChatGPT, Claude, Gemini)', true);
    return;
  }

  var data;
  if (platform === 'chatgpt') data = scrapeChatGPT();
  else if (platform === 'claude-web') data = scrapeClaude();
  else if (platform === 'gemini-web') data = scrapeGemini();

  if (!data || !data.turns || data.turns.length === 0) {
    showToast('No conversation found on this page', true);
    return;
  }

  data.started_at = new Date().toISOString();

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(j) {
    if (j.ok) showToast('Captured ' + data.turns.length + ' turns from ' + platform);
    else showToast('Import failed: ' + (j.error || 'unknown'), true);
  })
  .catch(function(e) {
    showToast('Failed to send: ' + e.message + '. Is the dashboard running?', true);
  });
})();
`;

/**
 * Returns the bookmarklet code as a `javascript:void(...)` URL.
 */
export function getBookmarkletCode() {
  // Minify by removing newlines and extra spaces
  const minified = BOOKMARKLET_SOURCE
    .replace(/\/\/[^\n]*/g, '') // strip comments
    .replace(/\n\s*/g, ' ')     // collapse newlines
    .replace(/\s{2,}/g, ' ')    // collapse spaces
    .trim();
  return `javascript:void(${encodeURIComponent(minified)})`;
}
