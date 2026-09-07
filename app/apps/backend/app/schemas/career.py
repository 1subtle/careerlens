"""CareerLens contracts; all user/model input crosses these boundaries."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.models import ResumeData

EvidenceStatus = Literal["supported", "mentioned", "pending", "gap"]


class TextInput(BaseModel):
    text: str = Field(min_length=1, max_length=30000)
    use_ai: bool = False

    @field_validator("text")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入有效文本")
        return value.strip()


class ResumeInput(BaseModel):
    title: str = Field(default="我的简历", min_length=1, max_length=120)
    data: ResumeData
    source_text: str = Field(default="", max_length=30000)
    expected_hash: str | None = None


class Requirement(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    source_text: str = Field(min_length=1, max_length=3000)
    priority: Literal["required", "preferred"] = "required"

    @field_validator("name")
    @classmethod
    def canonical_name(cls, value: str) -> str:
        from app.services.matching import SKILLS

        value = value.strip()
        if not value:
            raise ValueError("要求名称不能为空")
        for name, aliases in SKILLS.items():
            if value.casefold() in {alias.casefold() for alias in [name, *aliases]}:
                return name
        return value


class JobInput(TextInput):
    title: str = Field(min_length=1, max_length=120)
    company: str = Field(default="", max_length=120)
    category: str = Field(default="其他", max_length=60)
    city: str = Field(default="", max_length=60)
    salary_text: str = Field(default="", max_length=120)
    source_url: str = Field(default="", max_length=2000)
    source_type: Literal["manual", "course", "synthetic"] = "manual"
    published_at: date | None = None
    requirements: list[Requirement] | None = Field(default=None, max_length=60)

    @model_validator(mode="after")
    def validate_requirements(self) -> "JobInput":
        if self.requirements is not None:
            ids = [r.id for r in self.requirements]
            names = [r.name.casefold().strip() for r in self.requirements]
            if len(set(ids)) != len(ids) or len(set(names)) != len(names):
                raise ValueError("岗位要求不能重复")
            if any(r.source_text not in self.text for r in self.requirements):
                raise ValueError("要求引用必须来自 JD 原文")
        return self


class MatchInput(BaseModel):
    resume_id: str
    job_id: str


class ReviewInput(BaseModel):
    requirement_id: str
    status: EvidenceStatus
    evidence_ids: list[str] = Field(default_factory=list, max_length=20)


class RewriteInput(BaseModel):
    match_id: str
    section_id: str
    facts: list[str] = Field(default_factory=list, max_length=8)
    use_ai: bool = False

    @field_validator("facts")
    @classmethod
    def limit_facts(cls, values: list[str]) -> list[str]:
        if any(len(value) > 1000 for value in values):
            raise ValueError("每项补充事实请控制在 1000 字以内")
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class Claim(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    source_ids: list[str] = Field(min_length=1, max_length=10)


class RewriteDraft(BaseModel):
    draft: str = Field(min_length=1, max_length=5000)
    claims: list[Claim] = Field(min_length=1, max_length=20)
    missing_facts: list[str] = Field(default_factory=list, max_length=8)
    reason: str = Field(max_length=2000)


class ApplyInput(BaseModel):
    confirmed: Literal[True]


class MarketFilter(BaseModel):
    category: str = Field(default="", max_length=60)
    city: str = Field(default="", max_length=60)
    since: date | None = None
    include_demo: bool = False


class MarketQuestion(MarketFilter):
    question: str = Field(
        default="这些岗位有哪些共同要求？", min_length=1, max_length=1000
    )
    use_ai: bool = False
