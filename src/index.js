require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { runAgent } = require('./agent');
const { runReviewAgent } = require('./review-agent');

const app = express();
const PORT = process.env.PORT || 3003;

function verifySignature(rawBody, signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// Post a JSON signal to the webhook-router.
// No-ops silently if AUTOFIX_DONE_URL is not set (standalone mode).
function signalRouter(data) {
  const url = process.env.AUTOFIX_DONE_URL;
  if (!url) return Promise.resolve();

  const body = JSON.stringify(data);
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = transport.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', err => {
      console.warn(`  ⚠️  Router signal failed: ${err.message}`);
      resolve();
    });
    req.write(body);
    req.end();
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

  // Trigger 1: issues.labeled "bug" → run autofix agent
  // (Router guarantees this only arrives after triage-done)
  if (event === 'issues' && payload.action === 'labeled') {
    if (payload.label?.name !== 'bug') {
      return res.status(200).json({ message: `Ignored label: ${payload.label?.name}` });
    }
    const issueNumber = payload.issue.number;
    console.log(`\n📬 Bug label added: ${owner}/${repo}#${issueNumber} — "${payload.issue.title}"`);
    res.status(200).json({ message: 'Fix started', issue: issueNumber });

    (async () => {
      let pullNumber = null;
      try {
        const result = await runAgent(owner, repo, issueNumber);
        if (result.pr_url) {
          const parts = result.pr_url.split('/');
          pullNumber = parseInt(parts[parts.length - 1], 10) || null;
        }
      } catch (err) {
        console.error('❌ Autofix agent error:', err.message);
      } finally {
        await signalRouter({ owner, repo, issueNumber, pullNumber });
      }
    })();
    return;
  }

  // Trigger 2: pull_request_review.submitted → run review-fix agent
  // (Router guarantees this only arrives after autofix-done)
  if (event === 'pull_request_review' && payload.action === 'submitted') {
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
