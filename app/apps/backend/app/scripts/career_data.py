"""CareerLens database initialization and portable teaching data exports."""

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from sqlalchemy.dialects import sqlite
from sqlalchemy.schema import CreateIndex, CreateTable

from app.database import db
from app.models import Base
from app.routers.career import load_demo, save_job
from app.schemas.career import JobInput
from app.services.demo import DEMO_RESUME, demo_jobs


async def run(args: Any) -> None:
    if args.command == "schema":
        statements = [
            "-- Generated from SQLAlchemy models; no personal data.",
            "PRAGMA foreign_keys=ON;",
        ]
        for table in Base.metadata.sorted_tables:
            statements.append(
                str(
                    CreateTable(table, if_not_exists=True).compile(
                        dialect=sqlite.dialect()
                    )
                )
                + ";"
            )
            for index in sorted(table.indexes, key=lambda item: item.name):
                statements.append(
                    str(
                        CreateIndex(index, if_not_exists=True).compile(
                            dialect=sqlite.dialect()
                        )
                    )
                    + ";"
                )
        ddl = "\n\n".join(statements)
        Path(args.path).write_text(
            "\n".join(line.rstrip() for line in ddl.splitlines()) + "\n",
            encoding="utf-8",
        )
    elif args.command == "export-demo":
        directory = Path(args.path)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "jobs.synthetic.json").write_text(
            json.dumps(demo_jobs(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (directory / "resume.synthetic.txt").write_text(DEMO_RESUME, encoding="utf-8")
    elif args.command == "import-jobs":
        data = json.loads(Path(args.path).read_text(encoding="utf-8"))
        if not isinstance(data, list) or len(data) > 500:
            raise ValueError("输入应为最多 500 条岗位对象的 JSON 数组")
        # Validate the whole batch before any write.
        requests = [JobInput.model_validate(value) for value in data]
        for request in requests:
            await save_job(request)
        print(f"已处理 {len(requests)} 条岗位；重复岗位不会重复创建。")
    else:
        async with db._session():
            pass
        if args.demo:
            await load_demo()
        print(
            "数据库已初始化。"
            + ("已载入明确标注的虚构示例。" if args.demo else "未写入示例材料。")
        )
    await db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--demo", action="store_true")
    for command in ("schema", "export-demo", "import-jobs"):
        sub.add_parser(command).add_argument("path")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
