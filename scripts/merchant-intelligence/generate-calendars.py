#!/usr/bin/env python3
"""Generate the offline public-holiday artifact from verified holidays==0.105.

Run with the pinned PyPI source archive (no generator/runtime network access):
  /tmp/balanceframe-phase11-calendar/bin/python scripts/merchant-intelligence/generate-calendars.py --sdist /path/to/holidays-0.105.tar.gz
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import tarfile

import holidays
from holidays.constants import PUBLIC

VERSION = "0.105"
PACKAGE_SHA256 = "fc9abc0c187b62e955f92aa12dbe7ed1998cc94712f295ec9244db788594d662"
COVERAGE_START = "2020-01-01"
COVERAGE_END = "2035-12-31"
SOURCE = {
    "provider": "python-holidays",
    "version": VERSION,
    "license": "MIT",
    "sourceUrl": "https://pypi.org/project/holidays/0.105/",
    "licenseUrl": "https://github.com/vacanza/holidays/blob/v0.105/LICENSE",
    "packageSha256": PACKAGE_SHA256,
    "coverageStart": COVERAGE_START,
    "coverageEnd": COVERAGE_END,
    "observed": True,
    "language": "en_US",
    "categories": ["public"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdist", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "packages/application/src/merchant-calendar-data.json")
    args = parser.parse_args()
    if hashlib.sha256(args.sdist.read_bytes()).hexdigest() != PACKAGE_SHA256:
        raise SystemExit("Calendar source archive does not match the pinned SHA-256")
    if importlib.metadata.version("holidays") != VERSION or holidays.__version__ != VERSION:
        raise SystemExit("Calendar generator requires holidays==0.105")
    package_root = Path(holidays.__file__).resolve().parent
    with tarfile.open(args.sdist, "r:gz") as archive:
        members = {member.name.removeprefix(f"holidays-{VERSION}/"): member for member in archive.getmembers() if member.isfile()}
        # Verify the installed code and translations against the pinned source, not
        # merely its version string. Never extract untrusted archive paths.
        for relative, member in sorted(members.items()):
            if not relative.startswith("holidays/") or not relative.endswith((".py", ".mo")):
                continue
            installed = package_root.parent / relative
            source = archive.extractfile(member)
            if source is None or not installed.is_file() or installed.read_bytes() != source.read():
                raise SystemExit(f"Installed calendar source differs from pinned archive: {relative}")
        license_member = members.get("LICENSE")
        contributors_member = members.get("CONTRIBUTORS")
        if license_member is None or contributors_member is None:
            raise SystemExit("Pinned source must include its full license and contributors")
        license_file = archive.extractfile(license_member)
        contributors_file = archive.extractfile(contributors_member)
        if license_file is None or contributors_file is None:
            raise SystemExit("Unreadable source attribution")
        license_text = license_file.read().decode("utf-8")
        contributors_text = contributors_file.read().decode("utf-8")
        if "Permission is hereby granted, free of charge" not in license_text:
            raise SystemExit("Pinned calendar source license is not MIT")
    calendars = []
    for jurisdiction in ("US", "CA", "GB"):
        national = holidays.country_holidays(jurisdiction, categories=(PUBLIC,), language="en_US", observed=True, expand=False)
        for subdivision in (None, *sorted(national.subdivisions)):
            calendar = holidays.country_holidays(
                jurisdiction, subdiv=subdivision, years=range(2019, 2037),
                categories=(PUBLIC,), language="en_US", observed=True, expand=False,
            )
            dates = [
                {"date": date.isoformat(), "name": name}
                for date, name in sorted(calendar.items())
                if COVERAGE_START <= date.isoformat() <= COVERAGE_END
            ]
            calendars.append({"jurisdiction": jurisdiction, "subdivision": subdivision, "holidays": dates})
    artifact = {
        "source": SOURCE,
        "attribution": {"licenseText": license_text, "contributorsText": contributors_text},
        "version": "python-holidays/0.105:public:observed:2020-2035",
        "calendars": calendars,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
