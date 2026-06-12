const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ── Read tools ─────────────────────────────────────────────────────────────────

async function getIssueDetails({ owner, repo, issue_number }) {
  const { data } = await octokit.issues.get({ owner, repo, issue_number });
  return {
    number: data.number,
    title: data.title,
    body: data.body || '',
    state: data.state,
    labels: data.labels.map(l => l.name),
    author: data.user.login,
    url: data.html_url,
  };
}

async function listRepoFiles({ owner, repo, path = '' }) {
  const { data } = await octokit.repos.getContent({ owner, repo, path });
  return Array.isArray(data)
    ? data.map(f => ({ name: f.name, path: f.path, type: f.type }))
    : [{ name: data.name, path: data.path, type: data.type }];
}

async function getFileContent({ owner, repo, path, branch }) {
  try {
    const params = { owner, repo, path };
    if (branch) params.ref = branch;
    const { data } = await octokit.repos.getContent(params);
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return {
      path,
      sha: data.sha,
      content: content.length > 8000 ? content.slice(0, 8000) + '\n... [truncated]' : content,
    };
  } catch (err) {
    return { error: `Could not read ${path}: ${err.message}` };
  }
}

async function searchCode({ owner, repo, query }) {
  try {
    const { data } = await octokit.search.code({
      q: `${query} repo:${owner}/${repo}`,
      per_page: 8,
    });
    return data.items.map(i => ({ path: i.path, url: i.html_url }));
  } catch (err) {
    return { error: err.message };
  }
}

// ── PR review tools ───────────────────────────────────────────────────────────

async function getPullRequest({ owner, repo, pull_number }) {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number });
  return {
    number: data.number,
    title: data.title,
    body: data.body || '',
    state: data.state,
    head_branch: data.head.ref,
    base_branch: data.base.ref,
    url: data.html_url,
    created_by: data.user.login,
  };
}

async function getPrReviewComments({ owner, repo, pull_number }) {
  const { data } = await octokit.pulls.listReviewComments({
    owner, repo, pull_number, per_page: 50,
  });
  return data.map(c => ({
    id: c.id,
    path: c.path,
    line: c.line || c.original_line,
    body: c.body,
    author: c.user.login,
    url: c.html_url,
  }));
}

async function replyToReviewComment({ owner, repo, pull_number, comment_id, body }) {
  const { data } = await octokit.pulls.createReplyForReviewComment({
    owner, repo, pull_number,
    comment_id,
    body,
  });
  return { success: true, url: data.html_url };
}

// ── Branch / write tools ───────────────────────────────────────────────────────

async function getDefaultBranch({ owner, repo }) {
  const { data } = await octokit.repos.get({ owner, repo });
  return { default_branch: data.default_branch };
}

async function createBranch({ owner, repo, branch, from_branch }) {
  const { data: ref } = await octokit.git.getRef({
    owner, repo,
    ref: `heads/${from_branch}`,
  });
  await octokit.git.createRef({
    owner, repo,
    ref: `refs/heads/${branch}`,
    sha: ref.object.sha,
  });
  return { success: true, branch };
}

async function createOrUpdateFile({ owner, repo, path, content, message, branch, sha }) {
  const params = {
    owner, repo, path,
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  };
  if (sha) params.sha = sha;
  const { data } = await octokit.repos.createOrUpdateFileContents(params);
  return { success: true, commit_sha: data.commit.sha, path };
}

async function createPullRequest({ owner, repo, title, body, head, base }) {
  const { data } = await octokit.pulls.create({ owner, repo, title, body, head, base });
  return { success: true, number: data.number, url: data.html_url };
}

async function postIssueComment({ owner, repo, issue_number, body }) {
  const { data } = await octokit.issues.createComment({ owner, repo, issue_number, body });
  return { success: true, comment_url: data.html_url };
}

async function escalateToHuman({ owner, repo, issue_number, reason, questions }) {
  const { data: existing } = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
  const labelName = 'needs-human-fix';
  if (!existing.find(l => l.name === labelName)) {
    await octokit.issues.createLabel({
      owner, repo,
      name: labelName,
      color: 'e4b429',
      description: 'Autofix agent could not confidently fix this — requires a human developer',
    });
  }
  await octokit.issues.addLabels({ owner, repo, issue_number, labels: [labelName] });

  const questionsBlock = questions?.length
    ? `\n\n**Why I couldn't fix it automatically:**\n${questions.map(q => `- ${q}`).join('\n')}`
    : '';

  const body = `🤖 I attempted to fix this issue but couldn't proceed confidently because:\n\n> ${reason}${questionsBlock}\n\nI've applied the \`needs-human-fix\` label. The fix will need a human developer.\n\n<!-- autofix-agent -->`;

  const { data } = await octokit.issues.createComment({ owner, repo, issue_number, body });
  return { success: true, comment_url: data.html_url };
}

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_issue_details',
      description: 'Get full details of a GitHub issue',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_repo_files',
      description: 'List files and folders in the repository at a given path',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          path:  { type: 'string', description: 'Folder path (empty string for root)' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_content',
      description: 'Read a file. Returns content and SHA (needed for updates). Always call this before create_or_update_file on an existing file.',
      parameters: {
        type: 'object',
        properties: {
          owner:  { type: 'string' },
          repo:   { type: 'string' },
          path:   { type: 'string' },
          branch: { type: 'string', description: 'Branch to read from (omit for default branch)' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search for code in the repository — useful for finding which file contains a specific function, class, or variable',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          query: { type: 'string', description: 'Search term (function name, error message, variable, etc.)' },
        },
        required: ['owner', 'repo', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_default_branch',
      description: 'Get the default branch name of the repository (main, master, etc.)',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_branch',
      description: 'Create a new branch to commit the fix on. Always branch off the default branch.',
      parameters: {
        type: 'object',
        properties: {
          owner:       { type: 'string' },
          repo:        { type: 'string' },
          branch:      { type: 'string', description: 'New branch name — use format: fix/issue-{number}-{short-slug}' },
          from_branch: { type: 'string', description: 'Branch to branch off (use the default branch)' },
        },
        required: ['owner', 'repo', 'branch', 'from_branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_or_update_file',
      description: 'Create a new file or update an existing file on a branch. For updates, you MUST provide the sha from get_file_content.',
      parameters: {
        type: 'object',
        properties: {
          owner:   { type: 'string' },
          repo:    { type: 'string' },
          path:    { type: 'string', description: 'File path in the repo' },
          content: { type: 'string', description: 'Full file content (not a diff — the complete new file)' },
          message: { type: 'string', description: 'Commit message' },
          branch:  { type: 'string', description: 'Branch to commit to' },
          sha:     { type: 'string', description: 'SHA of the existing file — required when updating, omit when creating a new file' },
        },
        required: ['owner', 'repo', 'path', 'content', 'message', 'branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pull_request',
      description: 'Open a pull request for the fix',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          title: { type: 'string', description: 'PR title — format: "fix: <what was fixed> (#<issue_number>)"' },
          body:  { type: 'string', description: 'PR description — explain the bug, what you changed, and what the reviewer should verify' },
          head:  { type: 'string', description: 'The fix branch name' },
          base:  { type: 'string', description: 'The default branch to merge into' },
        },
        required: ['owner', 'repo', 'title', 'body', 'head', 'base'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_issue_comment',
      description: 'Post a comment on the issue — use after creating the PR to link back to it',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
          body:         { type: 'string' },
        },
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pull_request',
      description: 'Get details of a pull request including its branch name',
      parameters: {
        type: 'object',
        properties: {
          owner:       { type: 'string' },
          repo:        { type: 'string' },
          pull_number: { type: 'number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pr_review_comments',
      description: 'Get all inline review comments on a pull request, including the file path and line number each comment refers to',
      parameters: {
        type: 'object',
        properties: {
          owner:       { type: 'string' },
          repo:        { type: 'string' },
          pull_number: { type: 'number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_to_review_comment',
      description: 'Reply to a specific review comment on a PR — use to confirm a fix was applied or explain why a comment was not addressed',
      parameters: {
        type: 'object',
        properties: {
          owner:      { type: 'string' },
          repo:       { type: 'string' },
          pull_number: { type: 'number' },
          comment_id: { type: 'number', description: 'The id field from get_pr_review_comments' },
          body:       { type: 'string' },
        },
        required: ['owner', 'repo', 'pull_number', 'comment_id', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Flag the issue as requiring a human developer. Use when: the fix spans more than 3 files, requires schema/API changes, or you cannot confidently identify the root cause after reading the code.',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
          reason:       { type: 'string', description: 'One sentence explaining why you cannot fix this automatically' },
          questions:    { type: 'array', items: { type: 'string' }, description: 'Specific blockers or questions a human developer needs to resolve' },
        },
        required: ['owner', 'repo', 'issue_number', 'reason'],
      },
    },
  },
];

const TOOL_HANDLERS = {
  get_issue_details:      getIssueDetails,
  list_repo_files:        listRepoFiles,
  get_file_content:       getFileContent,
  search_code:            searchCode,
  get_default_branch:     getDefaultBranch,
  create_branch:          createBranch,
  create_or_update_file:  createOrUpdateFile,
  create_pull_request:    createPullRequest,
  post_issue_comment:     postIssueComment,
  escalate_to_human:      escalateToHuman,
  get_pull_request:       getPullRequest,
  get_pr_review_comments: getPrReviewComments,
  reply_to_review_comment: replyToReviewComment,
};

module.exports = { TOOL_DEFINITIONS, TOOL_HANDLERS };
