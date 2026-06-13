const OpenAI = require('openai');
const { Octokit } = require('@octokit/rest');
const { TOOL_DEFINITIONS, TOOL_HANDLERS } = require('./tools/github');

const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS || '12', 10);
const MAX_RETRIES = parseInt(process.env.AGENT_MAX_RETRIES || '3', 10);
const BOT_MARKER = '<!-- autofix-agent -->';

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
});
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are an autonomous software engineer agent. You are given a GitHub bug issue and your job is to understand it, find the root cause in the code, write a minimal fix, and open a pull request for human review.

═══ PHASE 1 — DISCOVERY (always start here) ═══

1. get_issue_details — read the full issue title and body carefully
2. get_default_branch — find out if the repo uses "main" or "master" (use the actual returned branch name in all subsequent calls)
3. get_file_content for "package.json" — discover the tech stack, test framework, dependencies
4. list_repo_files with path="" — understand the project structure
5. list_repo_files on relevant directories (src/, lib/, app/, etc.)
6. search_code using keywords from the bug report to find the relevant source files
7. get_file_content on the files most likely related to the bug
8. Look for test files — check for __tests__/, test/, *.test.js, *.spec.js. If tests exist, read one to understand the pattern.

═══ PHASE 2 — ANALYSIS ═══

Before writing a single line of code, be certain you can answer all of these:
- Exactly which file and which function contains the bug?
- What is the root cause — not just the symptom?
- What is the minimal change that fixes it without breaking anything else?
- Will this change affect other callers of the same function?

If you cannot answer all four confidently → escalate_to_human.

ESCALATE (do not attempt the fix) when:
- The fix requires changing more than 3 files
- The fix requires database schema or API contract changes
- The root cause spans multiple systems or services
- You cannot find the relevant code after thorough searching
- The bug description is too vague to pinpoint a root cause

═══ PHASE 3 — FIX ═══

1. create_branch with name: fix/issue-{number}-{short-slug}  (e.g. fix/issue-42-null-check-login)
2. For each file to change:
   a. get_file_content on that file to get its current content AND sha
   b. create_or_update_file with the full corrected content and the sha
   c. Write a clear, specific commit message: "fix: <what changed> (issue #<number>)"
3. IMPORTANT: create_or_update_file requires the COMPLETE file content — not just the changed function.
   Read the file first, apply only the minimal fix, then write the entire file back unchanged except for the fix.
   Never drop existing functions, imports, or exports.
4. If a test file exists for the module you changed, add a test case that covers the bug scenario

═══ PHASE 4 — PR ═══

1. create_pull_request:
   - title: "fix: <what was fixed> (#<issue_number>)"
   - body must include:
     * ## Problem — one paragraph describing the root cause (reference specific function/line)
     * ## Fix — what you changed and why
     * ## Testing — what the reviewer should verify manually or via tests
     * "Closes #<issue_number>" on its own line
2. post_issue_comment on the issue:
   "🤖 I've opened a fix for this: <PR URL>. Please review before merging."
   End the comment with <!-- autofix-agent -->

═══ PRINCIPLES ═══

- Match the existing code style exactly — spacing, naming conventions, error handling, quotes
- Never introduce new dependencies
- Never refactor code outside the scope of the fix
- If you updated a file, always read it first with get_file_content to get the sha
- Never push directly to the default branch — always use a fix/ branch
- Be honest in the PR description — mention any uncertainty or edge cases you're unsure about`;

// ── Idempotency ────────────────────────────────────────────────────────────────
async function alreadyAttempted(owner, repo, issueNumber) {
  const { data: comments } = await octokit.issues.listComments({
    owner, repo, issue_number: issueNumber, per_page: 30,
  });
  return comments.some(c => c.body && c.body.includes(BOT_MARKER));
}

// ── Context pruning — cap history to avoid runaway token growth ────────────────
function pruneMessages(messages) {
  const MAX_HISTORY = 12;
  if (messages.length <= MAX_HISTORY + 1) return messages;
  const first = messages[0];
  const recent = messages.slice(-MAX_HISTORY);
  // Don't start with orphaned tool results — find first assistant/user message
  let startIdx = 0;
  while (startIdx < recent.length && recent[startIdx].role === 'tool') startIdx++;
  return [first, ...recent.slice(startIdx)];
}

// ── Rate limit retry ───────────────────────────────────────────────────────────
async function callLLM(messages, attempt = 0) {
  try {
    return await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...pruneMessages(messages)],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_tokens: parseInt(process.env.AI_MAX_TOKENS || '1500', 10),
    });
  } catch (err) {
    // 413 = request too large — not retryable, fail fast
    if (err.status === 413) {
      throw new Error(`Request too large for model TPM limit — ${err.message}`);
    }
    if (err.status === 429) {
      // Daily/hourly quota exhausted — retrying in seconds won't help
      const isQuotaExhausted = /tokens per day|tokens per hour|quota/i.test(err.message);
      if (isQuotaExhausted) {
        const waitMatch = err.message.match(/try again in ([\d]+m[\d.]+s|[\d.]+s)/i);
        const waitHint = waitMatch ? ` (retry after: ${waitMatch[1]})` : '';
        throw new Error(`Daily token quota exhausted${waitHint} — ${err.message}`);
      }
      // Per-minute rate limit — exponential backoff
      if (attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 2000;
        console.warn(`  ⏳ Rate limited — retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        return callLLM(messages, attempt + 1);
      }
    }
    if (err.status === 503 && attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 2000;
      console.warn(`  ⏳ Service unavailable — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      return callLLM(messages, attempt + 1);
    }
    throw err;
  }
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
async function runAgent(owner, repo, issueNumber) {
  console.log(`\n🔧 Autofix agent starting on ${owner}/${repo}#${issueNumber}`);

  if (await alreadyAttempted(owner, repo, issueNumber)) {
    console.log(`⏭️  Already attempted issue #${issueNumber} — skipping`);
    return { success: true, skipped: true };
  }

  const messages = [
    {
      role: 'user',
      content: `Fix the bug reported in issue #${issueNumber} of the ${owner}/${repo} repository. Follow the discovery → analysis → fix → PR phases from your instructions.`,
    },
  ];

  let iterations = 0;
  let prCreated = false;
  let prUrl = null;
  let nudgeCount = 0;
  const MAX_NUDGES = 3;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`\n🔄 Iteration ${iterations}`);

    let response;
    try {
      response = await callLLM(messages);
    } catch (err) {
      if (err.message.startsWith('Daily token quota exhausted')) throw err;
      if (err.message.startsWith('Request too large')) throw err;
      console.error(`  ❌ LLM error: ${err.message}`);
      messages.push({
        role: 'user',
        content: 'Your last tool call was invalid. Please check the arguments and try again.',
      });
      continue;
    }

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      if (message.content) console.log(`💬 ${message.content}`);
      if (!prCreated && nudgeCount < MAX_NUDGES) {
        nudgeCount++;
        console.log(`  ↩️  No tool call but PR not created — nudging model (${nudgeCount}/${MAX_NUDGES})`);
        messages.push({ role: 'user', content: 'Continue with the next step. Call a tool.' });
        continue;
      }
      console.log(`\n✅ Agent finished after ${iterations} iteration(s)`);
      return { success: true, iterations, pr_created: prCreated, pr_url: prUrl };
    }

    for (const toolCall of message.tool_calls) {
      const name = toolCall.function.name;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: 'Invalid JSON in tool arguments' }),
        });
        continue;
      }

      console.log(`  🔧 ${name}`, JSON.stringify(args));

      // Inject real PR URL if agent left a placeholder
      if (name === 'post_issue_comment') {
        if (prUrl) args.body = args.body.replace(/<PR URL>|<pr url>|\[PR URL\]/gi, prUrl);
        if (!args.body?.includes(BOT_MARKER)) args.body = `${args.body}\n\n${BOT_MARKER}`;
      }

      if (name === 'create_pull_request') prCreated = true;

      let result;
      try {
        const handler = TOOL_HANDLERS[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        result = await handler(args);
        if (name === 'create_pull_request' && result.url) prUrl = result.url;
        console.log(`     ✅ ${name} succeeded`);
      } catch (err) {
        result = { error: err.message };
        console.error(`     ❌ ${name} failed: ${err.message}`);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.warn(`⚠️  Hit max iterations (${MAX_ITERATIONS})`);
  return { success: false, iterations, pr_created: prCreated, pr_url: prUrl };
}

module.exports = { runAgent };
