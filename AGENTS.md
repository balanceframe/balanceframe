# Agent Guidelines

## Git Commits

Before making a git commit with `--signoff`, agents **MUST** read the repository's git config and use those values for the `Signed-off-by` line:

```bash
git config user.name
git config user.email
```

Do **NOT** use hardcoded or fabricated identities. Always derive `Signed-off-by: Name <email>` from the actual `git config` output for this repository.

If you are uncertain about the identity, run `git config --list --show-origin | grep user` to check local, global, and includes — do not guess.
