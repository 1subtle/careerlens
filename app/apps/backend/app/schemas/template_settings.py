"""Persisted print settings shared by the PDF UI and editable Word export."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Level = Literal[1, 2, 3, 4, 5]
FontFamily = Literal["serif", "sans-serif", "mono"]


class PrintOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Margins(PrintOptions):
    top: int = Field(default=14, ge=5, le=25)
    bottom: int = Field(default=14, ge=5, le=25)
    left: int = Field(default=14, ge=5, le=25)
    right: int = Field(default=14, ge=5, le=25)


class Spacing(PrintOptions):
    section: Level = 4
    item: Level = 3
    lineHeight: Level = 4


class FontSize(PrintOptions):
    base: Level = 4
    headerScale: Level = 3
    headerFont: FontFamily = "sans-serif"
    bodyFont: FontFamily = "sans-serif"


class TemplateSettings(PrintOptions):
    template: Literal[
        "swiss-single",
        "swiss-two-column",
        "modern",
        "modern-two-column",
        "latex",
        "clean",
        "vivid",
    ] = "swiss-single"
    pageSize: Literal["A4", "LETTER"] = "A4"
    margins: Margins = Field(default_factory=Margins)
    spacing: Spacing = Field(default_factory=Spacing)
    fontSize: FontSize = Field(default_factory=FontSize)
    compactMode: bool = False
    showContactIcons: bool = False
    accentColor: Literal["blue", "green", "orange", "red"] = "blue"
