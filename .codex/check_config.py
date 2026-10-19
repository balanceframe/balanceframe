"""Check repository role fields and skill files statically using Python 3.11+."""

import argparse
from pathlib import Path
import sys
import tomllib


ROLE_MODELS = {
    "planning": "gpt-6-astra",
    "implementation": "gpt-6.1-sol",
    "correctness_review": "gpt-6.1-sol",
    "complexity_review": "gpt-6.1-sol",
}
SKILLS = (
    "ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain",
    "ponytail-help", "ponytail-review",
)


def validate(root: Path) -> list[str]:
    """Return static profile and skill errors for a repository root."""
    errors = []
    for role, model in ROLE_MODELS.items():
        relative = Path(".codex/agents") / f"{role}.toml"
        try:
            with (root / relative).open("rb") as source:
                profile = tomllib.load(source)
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
            errors.append(f"{relative}: {error}")
            continue
        for field, expected in (
            ("name", role), ("model", model), ("model_reasoning_effort", "high")
        ):
            if profile.get(field) != expected:
                errors.append(f"{relative}: {field} must be {expected!r}")
        for field in ("description", "developer_instructions"):
            value = profile.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{relative}: {field} must be a nonempty string")
    for skill in SKILLS:
        relative = Path(".agents/skills") / skill / "SKILL.md"
        try:
            if not (root / relative).read_text(encoding="utf-8").strip():
                errors.append(f"{relative}: skill file must be nonempty")
        except (OSError, UnicodeError) as error:
            errors.append(f"{relative}: {error}")
    return errors


def main(argv: list[str] | None = None) -> int:
    """Print static validation results and return a CLI exit status."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[1])
    errors = validate(parser.parse_args(argv).root)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Static-only checks passed: 4 role profiles and 6 nonempty skill files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
