"""Inspect or upgrade a database: python -m app.migrations status --kind auth --database PATH."""

import argparse
import json
from pathlib import Path

from app.migrations import migrate, status

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("command", choices=["status", "upgrade"])
parser.add_argument("--kind", choices=["auth", "business"], required=True)
parser.add_argument("--database", type=Path, required=True)
args = parser.parse_args()
if args.command == "upgrade":
    migrate(args.database, args.kind)
print(json.dumps(status(args.database, args.kind)))
