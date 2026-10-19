import contextlib
import io
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import check_config


ROOT = Path(__file__).resolve().parents[1]
ROLES = ("planning", "implementation", "correctness_review", "complexity_review")
SKILLS = ("ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain",
          "ponytail-help", "ponytail-review")


class CheckConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for relative in (
            *(Path(".codex/agents") / f"{role}.toml" for role in ROLES),
            *(Path(".agents/skills") / skill / "SKILL.md" for skill in SKILLS),
        ):
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)

    def profile(self, role="implementation"):
        return self.root / ".codex/agents" / f"{role}.toml"

    def test_valid_fixtures(self):
        self.assertEqual(check_config.validate(self.root), [])

    def test_missing_and_malformed_profiles(self):
        self.profile().unlink()
        self.profile("planning").write_text("name = [", encoding="utf-8")
        errors = "\n".join(check_config.validate(self.root))
        self.assertIn("implementation.toml", errors)
        self.assertIn("planning.toml", errors)
        self.assertEqual(len(check_config.validate(self.root)), 2)

    def test_role_name_model_and_effort(self):
        for role in ROLES:
            path = self.profile(role)
            original = path.read_text(encoding="utf-8")
            model = "gpt-6-astra" if role == "planning" else "gpt-6.1-sol"
            for field, expected in (
                ("name", role), ("model", model), ("model_reasoning_effort", "high")
            ):
                with self.subTest(role=role, field=field):
                    path.write_text(original.replace(
                        f'{field} = "{expected}"', f'{field} = "incorrect"', 1
                    ), encoding="utf-8")
                    errors = "\n".join(check_config.validate(self.root))
                    self.assertIn(f"{role}.toml", errors)
                    self.assertIn(field, errors)
                    path.write_text(original, encoding="utf-8")

    def test_missing_empty_and_wrong_type_fields(self):
        path = self.profile()
        original = path.read_text(encoding="utf-8")
        for field in ("name", "model", "model_reasoning_effort", "description",
                      "developer_instructions"):
            for value in (None, '"   "', "42"):
                with self.subTest(field=field, value=value):
                    # A minimal valid TOML fixture isolates each field failure.
                    values = {
                        "name": '"implementation"', "model": '"gpt-6.1-sol"',
                        "model_reasoning_effort": '"high"',
                        "description": '"Implement changes"',
                        "developer_instructions": '"Follow repository instructions"',
                    }
                    if value is None:
                        del values[field]
                    else:
                        values[field] = value
                    path.write_text("\n".join(
                        f"{key} = {item}" for key, item in values.items()
                    ), encoding="utf-8")
                    self.assertIn(field, "\n".join(check_config.validate(self.root)))
        path.write_text(original, encoding="utf-8")

    def test_missing_empty_and_unreadable_skills(self):
        for skill in SKILLS:
            path = self.root / ".agents/skills" / skill / "SKILL.md"
            original = path.read_text(encoding="utf-8")
            for contents in (None, " \n", b"\xff"):
                with self.subTest(skill=skill, contents=contents):
                    path.unlink()
                    if isinstance(contents, bytes):
                        path.write_bytes(contents)
                    elif contents is not None:
                        path.write_text(contents, encoding="utf-8")
                    self.assertIn(str(path.relative_to(self.root)),
                                  "\n".join(check_config.validate(self.root)))
                    path.write_text(original, encoding="utf-8")

    def test_cli_success_and_failure_exit_status(self):
        for invalid in (False, True):
            with self.subTest(invalid=invalid):
                if invalid:
                    self.profile().unlink()
                output, errors = io.StringIO(), io.StringIO()
                with patch.object(sys, "argv", ["check_config.py", str(self.root)]), \
                        contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(errors), \
                        self.assertRaises(SystemExit) as result:
                    runpy.run_path(str(ROOT / ".codex/check_config.py"), run_name="__main__")
                self.assertEqual(result.exception.code, 1 if invalid else 0)
                if invalid:
                    self.assertIn("implementation.toml", errors.getvalue())
                    self.assertEqual(output.getvalue(), "")
                else:
                    self.assertIn("static", output.getvalue().lower())
                    self.assertEqual(errors.getvalue(), "")

    def test_default_root_is_based_on_script(self):
        with tempfile.TemporaryDirectory() as empty_cwd, \
                contextlib.chdir(empty_cwd), \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(check_config.main([]), 0)


if __name__ == "__main__":
    unittest.main()
