require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { runAgent } = require('./agent');

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

  // Trigger on issues.labeled with the "bug" label
  if (event !== 'issues' || payload.action !== 'labeled') {
    return res.status(200).json({ message: `Ignored: ${event}.${payload.action}` });
  }

  if (payload.label?.name !== 'bug') {
    return res.status(200).json({ message: `Ignored label: ${payload.label?.name}` });
  }

  const { repository, issue } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  console.log(`\n📬 Bug label added: ${owner}/${repo}#${issueNumber} — "${issue.title}"`);

  res.status(200).json({ message: 'Fix started', issue: issueNumber });

  runAgent(owner, repo, issueNumber).catch(err =>
    console.error('❌ Agent error:', err.message)
  );
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🔧 GitHub Autofix Agent`);
  console.log(`   Webhook : http://localhost:${PORT}/webhook`);
  console.log(`   Health  : http://localhost:${PORT}/health\n`);
  console.log(`   Trigger : issues.labeled with "bug"\n`);
});
