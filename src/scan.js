require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const { runAgent } = require('./agent');

// Usage: node src/scan.js <owner>/<repo> [--dry-run]
// Finds all open issues labelled "bug" that haven't been attempted yet and runs the agent on each.

const [, , repoArg, flag] = process.argv;
const dryRun = flag === '--dry-run';

if (!repoArg || !repoArg.includes('/')) {
  console.error('Usage: node src/scan.js <owner>/<repo> [--dry-run]');
  process.exit(1);
}

const [owner, repo] = repoArg.split('/');
const BOT_MARKER = '<!-- autofix-agent -->';
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function hasBeenAttempted(issueNumber) {
  const { data: comments } = await octokit.issues.listComments({
    owner, repo, issue_number: issueNumber, per_page: 30,
  });
  return comments.some(c => c.body && c.body.includes(BOT_MARKER));
}

async function scan() {
  console.log(`\n🔍 Scanning ${owner}/${repo} for open bug issues...\n`);

  const { data: issues } = await octokit.issues.listForRepo({
    owner, repo,
    state: 'open',
    labels: 'bug',
    per_page: 50,
  });

  if (issues.length === 0) {
    console.log('✅ No open bug issues found.');
    return;
  }

  console.log(`Found ${issues.length} open bug issue(s):\n`);

  const pending = [];
  for (const issue of issues) {
    const attempted = await hasBeenAttempted(issue.number);
    const status = attempted ? '⏭️  already attempted' : '🔧 pending';
    console.log(`  #${issue.number} ${status} — ${issue.title}`);
    if (!attempted) pending.push(issue);
  }

  if (pending.length === 0) {
    console.log('\n✅ All bug issues already attempted.');
    return;
  }

  if (dryRun) {
    console.log(`\n🔍 Dry run — would process ${pending.length} issue(s). Remove --dry-run to run.`);
    return;
  }

  console.log(`\n▶️  Processing ${pending.length} issue(s)...\n`);

  for (const issue of pending) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Processing #${issue.number}: ${issue.title}`);
    console.log('─'.repeat(60));
    try {
      const result = await runAgent(owner, repo, issue.number);
      if (result.pr_created) {
        console.log(`✅ #${issue.number} — PR created`);
      } else if (result.skipped) {
        console.log(`⏭️  #${issue.number} — skipped`);
      } else {
        console.log(`⚠️  #${issue.number} — finished without PR (escalated or max iterations)`);
      }
    } catch (err) {
      console.error(`❌ #${issue.number} failed: ${err.message}`);
    }
  }

  console.log('\n✅ Scan complete.');
}

scan().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
