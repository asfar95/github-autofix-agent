const OpenAI = require('openai');
const { Octokit } = require('@octokit/rest');
const { TOOL_DEFINITIONS, TOOL_HANDLERS } = require('./tools/github');

const MAX_ITERATIONS = 15;
const MAX_RETRIES = 3;
const REVIEW_MARKER = '<!-- autofix-review-agent -->';

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
});
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are an autonomous software engineer agent. A pull request you previously created has received inline code review comments. Your job is to read those comments, apply the valid fixes to the PR branch, and reply to each comment explaining what you did.

IMPORTANT: Call ONE tool at a time. Never batch multiple tool calls in a single response. Wait to see the result of each tool call before deciding what to call next. Use the actual values returned by each tool — never use placeholder text.

═══ PHASE 1 — READ THE REVIEW ═══

1. get_pull_request — get the PR details including the head branch name
2. get_pr_review_comments — get all inline review comments
3. For each comment, read the file it refers to with get_file_content (using the head branch)
   to understand the current state of the code in context

═══ PHASE 2 — TRIAGE THE COMMENTS ═══

Categorise each comment as:
- ACTIONABLE: a clear code fix you can apply (wrong logic, missing check, bad naming, style issue)
- NOT_APPLICABLE: opinion-based, architectural, requires more context, or conflicts with other comments
- ALREADY_FIXED: the issue no longer exists in the current file content

For NOT_APPLICABLE or ALREADY_FIXED comments, reply explaining why — do not silently skip them.

═══ PHASE 3 — APPLY FIXES ═══

For each ACTIONABLE comment:
1. get_file_content on the affected file (with branch = head branch) to get current content and sha
2. Apply the fix — match the existing code style exactly
3. create_or_update_file with the full corrected file content, sha, and a clear commit message
4. reply_to_review_comment: "✅ Fixed in [short description of what changed]"

For NOT_APPLICABLE:
- reply_to_review_comment: explain briefly why it wasn't changed

For ALREADY_FIXED:
- reply_to_review_comment: "This was already addressed in the current code."

═══ PRINCIPLES ═══

- Write the COMPLETE file content — never a partial snippet
- Always read the file first (get_file_content with the head branch) before writing
- Fix only what the comment specifically asks — no extra refactoring
- If two comments conflict with each other, fix the more conservative one and explain in replies
- If a fix would break other code you can see, reply explaining the risk instead of applying it
- Match existing code style: spacing, quotes, naming, error handling patterns
- Never create new files or change files not mentioned in review comments`;

// ── Idempotency ────────────────────────────────────────────────────────────────
async function alreadyAddressed(owner, repo, pullNumber) {
  const { data: comments } = await octokit.pulls.listReviewComments({
    owner, repo, pull_number: pullNumber, per_page: 100,
  });
  return comments.some(c => c.body && c.body.includes(REVIEW_MARKER));
}

// ── Context pruning — cap history to avoid runaway token growth ────────────────
function pruneMessages(messages) {
  const MAX_HISTORY = 12;
  if (messages.length <= MAX_HISTORY + 1) return messages;
  const first = messages[0];
  const recent = messages.slice(-MAX_HISTORY);
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
      max_tokens: 2048,
    });
  } catch (err) {
    if (err.status === 429) {
      const isQuotaExhausted = /tokens per day|tokens per hour|quota/i.test(err.message);
      if (isQuotaExhausted) {
        const waitMatch = err.message.match(/try again in ([\d]+m[\d.]+s|[\d.]+s)/i);
        throw new Error(`Daily token quota exhausted${waitMatch ? ` (retry after: ${waitMatch[1]})` : ''}`);
      }
      if (attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 2000;
        console.warn(`  ⏳ Rate limited — retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        return callLLM(messages, attempt + 1);
      }
    }
    if (err.status === 503 && attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 2000;
      await new Promise(r => setTimeout(r, delay));
      return callLLM(messages, attempt + 1);
    }
    throw err;
  }
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
async function runReviewAgent(owner, repo, pullNumber) {
  console.log(`\n🔍 Review-fix agent starting on ${owner}/${repo}#${pullNumber}`);

  if (await alreadyAddressed(owner, repo, pullNumber)) {
    console.log(`⏭️  PR #${pullNumber} review already addressed — skipping`);
    return { success: true, skipped: true };
  }

  const messages = [
    {
      role: 'user',
      content: `Address the review comments on pull request #${pullNumber} in the ${owner}/${repo} repository. Follow the read → triage → fix phases from your instructions.`,
    },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`\n🔄 Iteration ${iterations}`);

    let response;
    try {
      response = await callLLM(messages);
    } catch (err) {
      if (err.message.startsWith('Daily token quota exhausted')) throw err;
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
      console.log(`\n✅ Review agent finished after ${iterations} iteration(s)`);
      if (message.content) console.log(`💬 ${message.content}`);
      return { success: true, iterations };
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

      // Stamp review replies so idempotency check works
      if (name === 'reply_to_review_comment' && !args.body?.includes(REVIEW_MARKER)) {
        args.body = `${args.body}\n\n${REVIEW_MARKER}`;
      }

      let result;
      try {
        const handler = TOOL_HANDLERS[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        result = await handler(args);
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
  return { success: false, iterations };
}

module.exports = { runReviewAgent };
