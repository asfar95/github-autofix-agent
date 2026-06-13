require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { runAgent } = require('./agent');
const { runReviewAgent } = require('./review-agent');

const app = express();
const PORT = process.env.PORT || 3003;

// Tracks repos with an autofix job currently running.
// review-fix polls this set instead of using a fixed time delay.
const activeAutofixJobs = new Set();

function verifySignature(rawBody, signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

function waitUntilDone(condition, intervalMs = 5000) {
  return new Promise(resolve => {
    if (condition()) return resolve();
    const id = setInterval(() => {
      if (condition()) { clearInterval(id); resolve(); }
    }, intervalMs);
  });
}

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  await new Promise(resolve => req.on('end', resolve));
  const rawBody = Buffer.concat(chunks);

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    let bodyStr = rawBody.toString();
    if (bodyStr.startsWith('payload=')) bodyStr = decodeURIComponent(bodyStr.slice(8));
    payload = JSON.parse(bodyStr);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const repoKey = `${owner}/${repo}`;

  // Trigger 1: issues.labeled with "bug" → run autofix agent
  if (event === 'issues' && payload.action === 'labeled') {
    if (payload.label?.name !== 'bug') {
      return res.status(200).json({ message: `Ignored label: ${payload.label?.name}` });
    }
    const issueNumber = payload.issue.number;
    console.log(`\n📬 Bug label added: ${owner}/${repo}#${issueNumber} — "${payload.issue.title}"`);
    res.status(200).json({ message: 'Fix started', issue: issueNumber });

    const startupDelay = parseInt(process.env.AUTOFIX_STARTUP_DELAY ?? '0', 10);
    (async () => {
      if (startupDelay > 0) {
        console.log(`  ⏳ Waiting ${startupDelay / 1000}s for triage agent to finish...`);
        await new Promise(r => setTimeout(r, startupDelay));
      }
      activeAutofixJobs.add(repoKey);
      console.log(`  🔒 Autofix lock acquired for ${repoKey}`);
      try {
        await runAgent(owner, repo, issueNumber);
      } catch (err) {
        console.error('❌ Autofix agent error:', err.message);
      } finally {
        activeAutofixJobs.delete(repoKey);
        console.log(`  🔓 Autofix lock released for ${repoKey}`);
      }
    })();
    return;
  }

  // Trigger 2: pull_request_review.submitted → run review-fix agent
  if (event === 'pull_request_review' && payload.action === 'submitted') {
    const pullNumber = payload.pull_request?.number;
    const reviewer = payload.review?.user?.login;
    console.log(`\n🔍 PR review submitted on ${owner}/${repo}#${pullNumber} by ${reviewer}`);
    res.status(200).json({ message: 'Review fix started', pr: pullNumber });

    (async () => {
      if (activeAutofixJobs.has(repoKey)) {
        console.log(`  ⏳ Autofix still running for ${repoKey} — waiting for it to finish before review-fix...`);
        await waitUntilDone(() => !activeAutofixJobs.has(repoKey));
        console.log(`  ✅ Autofix done — starting review-fix now`);
      }
      runReviewAgent(owner, repo, pullNumber).catch(err =>
        console.error('❌ Review agent error:', err.message)
      );
    })();
    return;
  }

  return res.status(200).json({ message: `Ignored: ${event}.${payload.action}` });
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🔧 GitHub Autofix Agent`);
  console.log(`   Webhook  : http://localhost:${PORT}/webhook`);
  console.log(`   Health   : http://localhost:${PORT}/health\n`);
  console.log(`   Triggers :`);
  console.log(`     issues.labeled "bug"       → autofix agent`);
  console.log(`     pull_request_review.submit → review-fix agent\n`);
});
