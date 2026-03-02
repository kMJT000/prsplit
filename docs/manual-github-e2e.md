# Manual GitHub E2E Playbook

This playbook verifies the end-to-end behavior that requires real GitHub side effects:
- split PR creation
- chained workflow behavior on merge
- auto-close of original PR
- cleanup command behavior

## 1) Preconditions

- A dedicated GitHub test repository (not production)
- An open original PR with enough file changes to split
- Local branch checked out to this repository
- Required environment variables:

```bash
export GITHUB_TOKEN=ghp_xxxxx
export ANTHROPIC_API_KEY=sk-ant-xxxxx
export OPENAI_API_KEY=sk-xxxxx
export PRSPLIT_TEST_PR=https://github.com/<owner>/<repo>/pull/<number>
export PRSPLIT_TEST_REPO_FULL_NAME=<owner>/<repo>
```

## 2) Preflight Check

Run the preflight-only suite:

```bash
npm run test:github:manual
```

If preflight fails, do not continue.

## 3) Split Dry Run

Check proposal quality without side effects:

```bash
npm run dev -- split "$PRSPLIT_TEST_PR" --model claude --dry-run
npm run dev -- split "$PRSPLIT_TEST_PR" --model codex --dry-run
```

Checklist:
- [ ] Proposal is generated for both models
- [ ] All changed files are allocated exactly once
- [ ] Titles/descriptions/rationale are in English

## 4) Create Chained Draft PRs

Create real draft PR chain:

```bash
npm run dev -- split "$PRSPLIT_TEST_PR" --model claude
```

Checklist:
- [ ] Draft PR chain is created
- [ ] Each PR base points to previous split PR branch
- [ ] First split PR includes generated workflow files

## 5) Merge Chain Verification

Perform the following in GitHub UI:

1. Merge split PR #1
2. Confirm split PR #2 is retargeted to original base and undrafted
3. Merge split PR #2 (and continue until last split PR)
4. Confirm original PR is auto-closed after last split PR merge

Checklist:
- [ ] Retarget + undraft automation works for each chain step
- [ ] Original PR closes only when final split PR is merged
- [ ] Generated chain workflow files are cleaned up at completion

## 6) Cleanup Command Verification

Create another draft chain (if needed), then run:

```bash
npm run dev -- cleanup "$PRSPLIT_TEST_PR"
```

Checklist:
- [ ] Only draft PRs with matching Original PR row are targeted
- [ ] Only PRs containing prsplit footer are targeted
- [ ] Target PRs are closed and branches are deleted

## 7) Evidence to Record

- Original PR URL
- Split PR URLs
- Actions workflow run URLs
- Screenshots (before/after retarget, undraft, close)
- CLI output logs
