require('dotenv').config();
const { runReviewAgent } = require('./review-agent');

// Usage: node src/review-fix.js <owner>/<repo> <pr_number>
// Example: node src/review-fix.js asfar95/sample-app 5

const [, , repoArg, prArg] = process.argv;

if (!repoArg || !prArg) {
  console.error('Usage: node src/review-fix.js <owner>/<repo> <pr_number>');
  process.exit(1);
}

const [owner, repo] = repoArg.split('/');
const pullNumber = parseInt(prArg, 10);

if (!owner || !repo || isNaN(pullNumber)) {
  console.error('Invalid arguments. Example: node src/review-fix.js asfar95/sample-app 5');
  process.exit(1);
}

runReviewAgent(owner, repo, pullNumber)
  .then(result => {
    if (result.skipped) {
      console.log('\n⏭️  Skipped — review already addressed');
    } else {
      console.log(`\n✅ Done after ${result.iterations} iteration(s)`);
    }
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
