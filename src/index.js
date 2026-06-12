require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { runAgent } = require('./agent');
const { runReviewAgent } = require('./review-agent');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.raw({ type: 'application/json' }));

function verifySignature(payload, signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];

  if (!verifySignature(req.body, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;

  // Trigger 1: issues.labeled with "bug" → run autofix agent
  if (event === 'issues' && payload.action === 'labeled') {
    if (payload.label?.name !== 'bug') {
      return res.status(200).json({ message: `Ignored label: ${payload.label?.name}` });
    }
    const issueNumber = payload.issue.number;
    console.log(`\n📬 Bug label added: ${owner}/${repo}#${issueNumber} — "${payload.issue.title}"`);
    res.status(200).json({ message: 'Fix started', issue: issueNumber });
    runAgent(owner, repo, issueNumber).catch(err =>
      console.error('❌ Autofix agent error:', err.message)
    );
    return;
  }

  // Trigger 2: pull_request_review.submitted → run review-fix agent
  if (event === 'pull_request_review' && payload.action === 'submitted') {
    // Only act on reviews that have inline comments (not just approve/request changes with no body)
    const pullNumber = payload.pull_request?.number;
    const reviewer = payload.review?.user?.login;
    console.log(`\n🔍 PR review submitted on ${owner}/${repo}#${pullNumber} by ${reviewer}`);
    res.status(200).json({ message: 'Review fix started', pr: pullNumber });
    runReviewAgent(owner, repo, pullNumber).catch(err =>
      console.error('❌ Review agent error:', err.message)
    );
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
