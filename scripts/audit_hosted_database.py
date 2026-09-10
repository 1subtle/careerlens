#!/usr/bin/env python3
"""Read-only, anonymous storage audit; no application imports or migrations.

Usage: python scripts/audit_hosted_database.py [DATA_DIRECTORY]
Every connection uses SQLite mode=ro and query_only. Live databases are read in
separate transactions, so totals are not a simultaneous cross-database snapshot.
Separate files and clean integrity checks do not prove application authorization
or confidentiality. This script never inspects model caches or document bodies.
"""

import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import stat
import sys
from uuid import UUID


BUSINESS_TABLES = {
    "resumes", "jobs", "improvements", "tailoring_previews", "applications",
    "resume_snapshots", "match_records", "rewrite_records", "direction_history", "market_history",
}
KNOWN_TABLES = BUSINESS_TABLES | {
    "users", "credit_accounts", "account_preferences", "sessions", "challenges", "send_events", "api_keys",
    "schema_migrations", "credit_ledger", "credit_operations", "credit_generations", "payment_orders",
}


def quoted(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def canonical_uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def key_fingerprint(*values):
    # Only irreversible fingerprints leave the SQL query; no raw business IDs.
    return hashlib.sha256(repr(values).encode("utf-8")).hexdigest()


@contextmanager
def readonly(path):
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.create_function("audit_uuid", 1, canonical_uuid, deterministic=True)
        connection.create_function("audit_key", -1, key_fingerprint, deterministic=True)
        connection.execute("BEGIN")
        yield connection
    finally:
        connection.close()


def scalar(connection, sql, parameters=()):
    return connection.execute(sql, parameters).fetchone()[0]


def inspect_database(connection, fingerprints=None):
    checks = list(connection.execute("PRAGMA quick_check"))
    tables = [row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]
    # Unknown schema names are anonymous too: a table name could contain PII.
    labels = {name: name if name in KNOWN_TABLES else f"other_table_{i}"
              for i, name in enumerate(tables, 1)}
    result = {
        "quick_check_ok": checks == [("ok",)],
        "quick_check_errors": sum(row[0] != "ok" for row in checks),
        "foreign_key_violations": sum(1 for _ in connection.execute("PRAGMA foreign_key_check")),
        "table_rows": {labels[name]: scalar(connection, f"SELECT COUNT(*) FROM {quoted(name)}")
                       for name in tables},
    }
    if fingerprints is not None:
        for table in sorted(BUSINESS_TABLES.intersection(tables)):
            columns = list(connection.execute(f"PRAGMA table_info({quoted(table)})"))
            primary = [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]]
            if not primary:
                continue
            keys = ", ".join(quoted(column) for column in primary)
            counts = fingerprints[table]
            # GROUP BY prevents repeated rows within one database from counting
            # as an overlap between distinct workspaces. Never select api_keys.
            for digest, _count in connection.execute(
                f"SELECT audit_key({keys}), COUNT(*) FROM {quoted(table)} GROUP BY {keys}"
            ):
                counts[digest] += 1
    return result


def inspect_auth(connection):
    result = inspect_database(connection)
    result.update({
        "account_count": scalar(connection, "SELECT COUNT(*) FROM users"),
        "invalid_user_ids": scalar(connection, "SELECT COUNT(*) FROM users WHERE NOT audit_uuid(id)"),
        "credit_account_count": scalar(connection, "SELECT COUNT(*) FROM credit_accounts"),
        "credit_balance_total": scalar(connection, "SELECT COALESCE(SUM(balance),0) FROM credit_accounts"),
        "credit_granted_total": scalar(connection, "SELECT COALESCE(SUM(granted),0) FROM credit_accounts"),
        "negative_credit_accounts": scalar(connection,
            "SELECT COUNT(*) FROM credit_accounts WHERE balance < 0 OR granted < 0"),
        "orphan_credit_accounts": scalar(connection,
            "SELECT COUNT(*) FROM credit_accounts c LEFT JOIN users u ON u.id=c.user_id WHERE u.id IS NULL"),
        "orphan_sessions": scalar(connection,
            "SELECT COUNT(*) FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL"),
        "users_without_credit_accounts": scalar(connection,
            "SELECT COUNT(*) FROM users u LEFT JOIN credit_accounts c ON c.user_id=u.id WHERE c.user_id IS NULL"),
        "duplicate_normalized_email_groups": scalar(connection,
            "SELECT COUNT(*) FROM (SELECT 1 FROM users GROUP BY lower(trim(email)) HAVING COUNT(*)>1)"),
        "duplicate_normalized_email_extra_accounts": scalar(connection,
            "SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM users GROUP BY lower(trim(email)) HAVING COUNT(*)>1)"),
    })
    tables = result["table_rows"]
    if "account_preferences" in tables:
        result["orphan_account_preferences"] = scalar(connection,
            "SELECT COUNT(*) FROM account_preferences p LEFT JOIN users u ON u.id=p.user_id WHERE u.id IS NULL")
        result["users_without_preferences"] = scalar(connection,
            "SELECT COUNT(*) FROM users u LEFT JOIN account_preferences p ON p.user_id=u.id WHERE p.user_id IS NULL")
        result["invalid_preference_languages"] = scalar(connection,
            "SELECT COUNT(*) FROM account_preferences WHERE ui_language NOT IN ('en','es','zh','ja','pt','fr','ko') "
            "OR content_language NOT IN ('en','es','zh','ja','pt','fr','ko')")
    session_columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
    if {"public_id", "created_at"} <= session_columns:
        result["invalid_public_session_ids"] = scalar(connection,
            "SELECT COUNT(*) FROM sessions WHERE public_id IS NULL OR typeof(public_id)!='text' "
            "OR length(public_id)!=32 OR public_id GLOB '*[^0-9a-f]*'")
        result["invalid_session_timestamps"] = scalar(connection,
            "SELECT COUNT(*) FROM sessions WHERE expires_at<=0 "
            "OR (created_at IS NOT NULL AND (created_at<=0 OR created_at>expires_at))")
    if "credit_ledger" in tables:
        result["credit_reserved_total"] = scalar(connection, "SELECT COALESCE(SUM(reserved),0) FROM credit_accounts")
        result["ledger_balance_mismatches"] = scalar(connection, """
            SELECT COUNT(*) FROM credit_accounts a WHERE a.balance != COALESCE((
              SELECT SUM(balance_delta) FROM credit_ledger l WHERE l.user_id=a.user_id),0)
              OR a.reserved != COALESCE((SELECT SUM(reserved_delta) FROM credit_ledger l WHERE l.user_id=a.user_id),0)
        """)
        result["reservation_mismatches"] = scalar(connection, """
            SELECT COUNT(*) FROM credit_accounts a WHERE a.reserved != (
              SELECT COUNT(*) FROM credit_generations g WHERE g.user_id=a.user_id AND g.status IN ('held','completed'))
        """)
        result["paid_orders_without_credit"] = scalar(connection, """
            SELECT COUNT(*) FROM payment_orders o WHERE o.status='paid' AND NOT EXISTS (
              SELECT 1 FROM credit_ledger l WHERE l.order_id=o.id AND l.user_id=o.user_id
              AND l.kind='purchase' AND l.balance_delta=o.credits)
        """)
    result["hash_format"] = {}
    for table, column, label in (
        ("sessions", "token_hash", "session_tokens"),
        ("challenges", "code_hash", "email_codes"),
        ("send_events", "ip_hash", "ip_addresses"),
    ):
        col = quoted(column)
        invalid = scalar(connection,
            f"SELECT COUNT(*) FROM {quoted(table)} WHERE {col} IS NULL OR typeof({col})!='text' "
            f"OR length({col})!=64 OR {col} GLOB '*[^0-9A-Fa-f]*'")
        result["hash_format"][label] = {"all_hex_64": invalid == 0, "invalid_count": invalid}
    return result


def audit(data_directory):
    root = Path(data_directory).absolute()
    path_issues = Counter()
    seen_inodes = set()
    fingerprints = defaultdict(Counter)
    result = {"scope": "storage_snapshot_only", "auth": None, "operator": None,
              "workspaces": [], "path_issues": path_issues}

    def safe_path(path, directory=False, optional=False):
        try:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                path_issues["symlinks"] += 1
                return False
            if not path.resolve().is_relative_to(root.resolve()):
                path_issues["path_escapes"] += 1
                return False
            if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
                path_issues["unexpected_file_types"] += 1
                return False
            if not directory:
                inode = (info.st_dev, info.st_ino)
                if info.st_nlink != 1 or inode in seen_inodes:
                    path_issues["hardlink_or_inode_reuse"] += 1
                    return False
                seen_inodes.add(inode)
            return True
        except FileNotFoundError:
            if not optional:
                path_issues["missing_required_paths"] += 1
            return False
        except OSError:
            path_issues["unreadable_paths"] += 1
            return False

    def safe_database(path, optional=False):
        if not safe_path(path, optional=optional):
            return False
        safe = True
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = path.with_name(path.name + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                safe = safe_path(sidecar) and safe
        return safe

    def database_summary(path, duplicates=None):
        try:
            with readonly(path) as connection:
                return inspect_database(connection, duplicates)
        except (OSError, sqlite3.Error):
            # Exception text can contain identifiers or file contents.
            return {"error": "database_read_failed"}

    if not safe_path(root, directory=True):
        result["ok"] = False
        return result
    root = root.resolve()
    auth_path = root / "auth.sqlite"
    operator_path = root / "resume_matcher.db"
    if safe_database(operator_path):
        result["operator"] = database_summary(operator_path)
    if not safe_database(auth_path):
        result["ok"] = False
        return result

    owned_workspaces = 0
    owned_directories = 0
    try:
        with readonly(auth_path) as auth:
            result["auth"] = inspect_auth(auth)
            users_path = root / "users"
            if safe_path(users_path, directory=True, optional=True):
                for entry in sorted(users_path.iterdir(), key=lambda item: item.name):
                    if not safe_path(entry, directory=True):
                        continue
                    if not canonical_uuid(entry.name):
                        path_issues["invalid_workspace_directory_names"] += 1
                        continue
                    owner_exists = scalar(auth, "SELECT COUNT(*) FROM users WHERE id=?", (entry.name,)) == 1
                    if not owner_exists:
                        path_issues["workspace_directories_without_user"] += 1
                    else:
                        owned_directories += 1
                    workspace_path = entry / "workspace.sqlite"
                    if not safe_database(workspace_path, optional=True):
                        continue
                    owned_workspaces += int(owner_exists)
                    summary = database_summary(workspace_path, fingerprints)
                    summary.update({"workspace_number": len(result["workspaces"]) + 1,
                                    "owner_exists": owner_exists})
                    result["workspaces"].append(summary)
            result["users_without_workspace_directory"] = result["auth"]["account_count"] - owned_directories
            result["users_without_workspace_database"] = result["auth"]["account_count"] - owned_workspaces
    except (OSError, sqlite3.Error):
        result["auth"] = {"error": "auth_audit_failed"}

    result["cross_workspace_duplicate_primary_keys"] = {
        table: {"distinct_duplicate_ids": sum(count > 1 for count in counts.values()),
                "extra_workspace_occurrences": sum(max(0, count - 1) for count in counts.values())}
        for table, counts in sorted(fingerprints.items())
    }
    summaries = [result["auth"], result["operator"], *result["workspaces"]]
    auth_result = result["auth"] or {}
    result["ok"] = (
        not path_issues and all(item and item.get("quick_check_ok")
                               and item.get("foreign_key_violations") == 0 for item in summaries)
        and not any(auth_result.get(key, 0) for key in (
            "invalid_user_ids", "negative_credit_accounts", "orphan_credit_accounts", "orphan_sessions",
            "users_without_credit_accounts", "duplicate_normalized_email_groups",
            "orphan_account_preferences", "users_without_preferences", "invalid_preference_languages",
            "invalid_public_session_ids", "invalid_session_timestamps",
            "ledger_balance_mismatches", "reservation_mismatches", "paid_orders_without_credit"))
        and all(item["all_hex_64"] for item in auth_result.get("hash_format", {}).values())
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_directory", nargs="?", default="/app/backend/data")
    args = parser.parse_args()
    try:
        result = audit(args.data_directory)
    except Exception:
        # Never print a traceback with production paths, schema names or values.
        result = {"ok": False, "error": "audit_failed"}
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
