# Repository Ponytail skills

Six standalone skills are vendored unchanged from [Ponytail](https://github.com/DietrichGebert/ponytail/tree/16352ac229eb08a9598dcae48fe9f2b342567d86), version **5.3.2**, commit `16352ac229eb08a9598dcae48fe9f2b342567d86`.

The upstream MIT license is in `LICENSE.ponytail`. The README and benchmark referenced by `ponytail-gain` are included under that skill; its figures describe the upstream benchmark, never savings measured in BalanceFrame. Other relative links in that upstream README refer to the pinned source repository. No hooks, installers, plugin registration, or auto-update configuration are included.

Open the repository worktree as the working directory so compatible Codex clients discover `.agents/skills/<name>/SKILL.md`. Standalone skills use names such as `$ponytail` and `$ponytail-review`; upstream help also describes namespaced plugin invocations, which apply to plugin installations. The skills remain readable directly when a hosted task does not refresh its catalog. Start a fresh task or restart the local client if newly added skills are not listed. Discovery is not evidence of hook trust or native custom-role activation.

Follow the root `AGENTS.md` for Full-by-default behavior and task-local Ultra escalation. See `.codex/README.md` at the repository root for custom-role setup and hosted handoffs. Updates require an explicit reviewed change to the pinned files and provenance, not an installer run.
