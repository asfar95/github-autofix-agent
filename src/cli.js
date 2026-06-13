require('dotenv').config();
const { runAgent } = require('./agent');

// Usage: node src/cli.js <owner>/<repo> <issue_number>
// Example: node src/cli.js asfar95/ai-agent-playground 7

const [, , repoArg, issueArg] = process.argv;

if (!repoArg || !issueArg) {
  console.error('Usage: node src/cli.js <owner>/<repo> <issue_number>');
  process.exit(1);
}

const [owner, repo] = repoArg.split('/');
const issueNumber = parseInt(issueArg, 10);

if (!owner || !repo || isNaN(issueNumber)) {
  console.error('Invalid arguments. Example: node src/cli.js asfar95/ai-agent-playground 7');
  process.exit(1);
}

runAgent(owner, repo, issueNumber)
  .then(result => {
    if (result.skipped) {
      console.log('\n⏭️  Skipped — already attempted');
    } else if (result.pr_created) {
      console.log(`\n✅ Done — PR created after ${result.iterations} iteration(s)`);
    } else {
      console.log(`\n⚠️  Done — no PR created after ${result.iterations} iteration(s)`);
    }
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
