<!--
PR TITLE: write a short, meaningful summary of the change as a whole, in the
imperative mood - don't leave the auto-filled first-commit message. Examples:
  * Fix pull authentication race condition
  * Add R2-backed manifest caching layer
  * Improve edge cache hit-rate on manifest reads
Individual commits should still follow Conventional Commits.
-->

## Type of change

<!-- Please check all that apply - this drives the PR's type labels. -->

- [ ] **Bug fix** (fixes an issue in pull/push/manifest/auth behaviour)
- [ ] **Feature** (adds new registry capability)
- [ ] **Enhancement** (improves registry performance)
- [ ] **Refactor** (restructures code without changing behaviour)
- [ ] **Breaking change** (changes registry API or deployment requirements)
- [ ] **Security** (security-related fix or hardening)

## Description

### Why is this change needed?

<!-- Explain the motivation and context for this change -->

### Related Issues

<!-- Link to related issues using "Fixes #123", "Closes #123", or "Relates to #123" -->

## Testing

<!-- Describe how you tested your changes -->

- [ ] `pnpm test`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run format:check`

## Checklist

<!-- Ensure all applicable items are completed before requesting review -->

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Linter and type checker pass
- [ ] Documentation updated (if applicable)
