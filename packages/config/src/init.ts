/**
 * The starter config `shura init` writes.
 *
 * Heavily commented on purpose: for most people this file is the
 * documentation, and the commented-out blocks are how they discover that
 * GitHub and Jira are options at all.
 */

export function starterConfig(project: string): string {
  return `# Shura configuration.
#
# Committed to the repository. Credentials are NAMED here, never carried —
# every *Env field is the name of an environment variable, and the values live
# in .env, which is gitignored. Shura refuses to load a config containing
# anything shaped like a live token.

project: ${project}

# Where the code lives.
repo:
  type: local
  path: ./eval/fixtures/target-app
  base: main
  checks: ["node", "--test", "--experimental-strip-types", "test/orders.test.ts"]

  # To work against a real GitHub repository instead:
  # type: github
  # owner: your-account
  # name: your-repo
  # base: main
  # checks: ["pnpm", "test"]
  # tokenEnv: GITHUB_TOKEN

# Where work items live. "local" keeps them in Postgres and needs no account.
tracker:
  type: local

  # type: jira
  # site: https://your-org.atlassian.net
  # project: PORTAL
  # emailEnv: JIRA_EMAIL
  # tokenEnv: JIRA_API_TOKEN
  # statusMap:
  #   in_review: "Code Review"
  #   accepted: "PO Accepted"

# Which model runs each role.
#
# The producer and its verifier MUST be different vendors. Shura checks this
# when it schedules the verification and refuses before spending anything.
agents:
  builder:
    runtime: anthropic
    model: claude-sonnet-5
  reviewer:
    runtime: openai
    model: gpt-6.1-sol

# Ceilings. A run stops at these rather than asking forgiveness.
budgets:
  per_task_usd: 5
  per_task_tokens: 2000000
  per_task_minutes: 30
  loop_cap: 3
`;
}
