"""Pydantic mirror of src/lesson/types.ts, used to validate generated lessons.

Keep the two in sync. Any numeric, color or text field may also be an
expression object {"$": "..."}.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Expr(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    expr: str = Field(alias="$", min_length=1)


Num = Union[float, Expr]
Str = Union[str, Expr]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Term(Strict):
    term: str
    definition: str


class Source(Strict):
    title: str
    url: str


# ---------- scene elements ----------


class ElementBase(Strict):
    alpha: Num | None = None


class Clip(Strict):
    x: Num
    y: Num
    w: Num
    h: Num


class GroupEl(ElementBase):
    type: Literal["group"]
    children: list["SceneElement"]
    x: Num | None = None
    y: Num | None = None
    scale: Num | None = None
    rotate: Num | None = None
    origin: tuple[Num, Num] | None = None
    repeat: int | None = Field(default=None, ge=0, le=500)
    items: list[dict] | None = None
    as_: str | None = Field(default=None, alias="as")
    vars: dict[str, str] | None = None
    clip: Clip | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Paint(ElementBase):
    fill: Str | None = None
    stroke: Str | None = None
    lineWidth: Num | None = None


class RectEl(Paint):
    type: Literal["rect"]
    x: Num
    y: Num
    w: Num
    h: Num
    r: Num | None = None


class EllipseEl(Paint):
    type: Literal["ellipse"]
    x: Num
    y: Num
    rx: Num
    ry: Num | None = None
    rotate: Num | None = None
    start: Num | None = None
    end: Num | None = None


class LineEl(ElementBase):
    type: Literal["line"]
    x1: Num
    y1: Num
    x2: Num
    y2: Num
    stroke: Str | None = None
    lineWidth: Num | None = None
    progress: Num | None = None


class PathEl(Paint):
    type: Literal["path"]
    d: Str
    progress: Num | None = None


class LabelEl(ElementBase):
    type: Literal["label"]
    text: Str
    x: Num
    y: Num
    color: Str | None = None
    bg: bool | None = None
    align: Literal["left", "center", "right"] | None = None
    size: Num | None = None
    weight: int | None = None


class CalloutEl(ElementBase):
    type: Literal["callout"]
    text: Str
    x: Num
    y: Num
    lx: Num
    ly: Num
    color: Str | None = None


class Bounds(Strict):
    circle: tuple[float, float, float] | None = None
    rect: tuple[float, float, float, float] | None = None


class Connect(Strict):
    to: tuple[float, float]
    progress: Num


class NetworkEl(ElementBase):
    type: Literal["network"]
    seed: int
    x: float
    y: float
    angles: list[float] = Field(min_length=1, max_length=40)
    steps: int | None = Field(default=None, le=400)
    stepLength: float | None = None
    spread: float | None = None
    branchChance: float | None = None
    maxTips: int | None = Field(default=None, le=200)
    pull: float | None = None
    width: float | None = None
    bounds: Bounds | None = None
    color: Str | None = None
    progress: Num | None = None
    connect: Connect | None = None


class ParticlesEl(ElementBase):
    type: Literal["particles"]
    seed: int
    count: int = Field(ge=1, le=600)
    emit: tuple[float, float]
    x: tuple[float, float]
    y: tuple[float, float]
    vx: tuple[float, float]
    vy: tuple[float, float]
    gravity: float | None = None
    floor: float | None = None
    r: float | None = None
    color: Str | None = None


class ScatterEl(ElementBase):
    type: Literal["scatter"]
    seed: int
    count: int = Field(ge=1, le=1500)
    x: float
    y: float
    w: float
    h: float
    r: tuple[float, float] | None = None
    color: Str | None = None
    fraction: Num | None = None


class CycleNode(Strict):
    label: str
    step: str | None = None


class CycleEl(ElementBase):
    type: Literal["cycle"]
    x: float
    y: float
    rx: float
    ry: float
    nodes: list[CycleNode] = Field(min_length=2, max_length=10)


SceneElement = Annotated[
    Union[GroupEl, RectEl, EllipseEl, LineEl, PathEl, LabelEl, CalloutEl, NetworkEl, ParticlesEl, ScatterEl, CycleEl],
    Field(discriminator="type"),
]
GroupEl.model_rebuild()


class Scene(Strict):
    duration: float = Field(gt=0, le=60)
    background: str | None = None
    elements: list[SceneElement]


class StaticScene(Strict):
    background: str | None = None
    elements: list[SceneElement]


# ---------- steps ----------


class StepBase(Strict):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$", max_length=40)
    title: str
    tag: str


class VideoStep(StepBase):
    kind: Literal["video"]
    narration: list[str] = Field(min_length=2, max_length=8)
    terms: list[Term] = Field(max_length=6)
    scene: Scene


class SliderControl(Strict):
    id: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    label: str
    min: float
    max: float
    step: float = Field(gt=0)
    initial: float
    unit: str | None = None

    @model_validator(mode="after")
    def _range(self):
        if not self.min <= self.initial <= self.max:
            raise ValueError(f"control {self.id}: initial must be between min and max")
        return self


class Rule(Strict):
    when: str
    text: str


class UpdateRule(Strict):
    var: str
    expr: str


class PredictOption(Strict):
    label: str
    correct: bool
    feedback: str


class Predict(Strict):
    question: str
    options: list[PredictOption] = Field(min_length=2, max_length=5)


class Check(Strict):
    label: str
    detail: str | None = None
    pass_: str = Field(alias="pass")
    warn: str | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Readout(Strict):
    label: str
    kind: Literal["bar", "text"]
    value: str | None = None
    rules: list[Rule] | None = None


class Preset(Strict):
    label: str
    set: dict[str, float] | None = None
    reset: bool | None = None


class SimGoal(Strict):
    when: str
    note: str


class SimulationStep(StepBase):
    kind: Literal["simulation"]
    intro: str
    caption: str | None = None
    controls: list[SliderControl] = Field(min_length=1, max_length=4)
    state: dict[str, float]
    update: list[UpdateRule]
    predict: Predict | None = None
    checks: list[Check] | None = None
    readouts: list[Readout] | None = None
    verdict: list[Rule] | None = None
    presets: list[Preset] | None = None
    goal: SimGoal
    scene: StaticScene


class MatchToken(Strict):
    id: str
    label: str
    attrs: dict[str, Union[str, float]]
    colors: list[str] = Field(min_length=1, max_length=2)
    x: float
    y: float


class MatchRule(Strict):
    when: str
    text: str
    success: bool | None = None


class MatchGoal(Strict):
    successes: int = Field(ge=1)
    note: str


class MatchStep(StepBase):
    kind: Literal["match"]
    intro: str
    caption: str | None = None
    question: str
    legend: str | None = None
    tokens: list[MatchToken] = Field(min_length=2, max_length=6)
    rules: list[MatchRule] = Field(min_length=1)
    resultLabel: str | None = None
    goal: MatchGoal
    scene: StaticScene | None = None


class MergeToken(Strict):
    x: float
    y: float
    color: str
    label: str


class MergeAction(Strict):
    type: Literal["merge"]
    tokens: tuple[MergeToken, MergeToken]


class ButtonAction(Strict):
    type: Literal["button"]
    label: str


class ProcessItem(Strict):
    label: str
    action: Annotated[Union[MergeAction, ButtonAction], Field(discriminator="type")]
    early: str | None = None
    done: str


class ProcessGoal(Strict):
    note: str


class ProcessStep(StepBase):
    kind: Literal["process"]
    intro: str
    caption: str | None = None
    prompt: str
    steps: list[ProcessItem] = Field(min_length=2, max_length=6)
    base: list[SceneElement]
    stages: list[list[SceneElement]]
    goal: ProcessGoal

    @model_validator(mode="after")
    def _stages(self):
        if len(self.stages) != len(self.steps) + 1:
            raise ValueError(f"process {self.id}: stages must have len(steps) + 1 entries")
        return self


class QuizQuestion(Strict):
    question: str
    options: list[str] = Field(min_length=2, max_length=5)
    answer: int = Field(ge=0)
    explanation: str

    @model_validator(mode="after")
    def _answer(self):
        if self.answer >= len(self.options):
            raise ValueError("quiz answer index is out of range")
        return self


class QuizStep(StepBase):
    kind: Literal["quiz"]
    questions: list[QuizQuestion] = Field(min_length=3, max_length=8)
    scene: StaticScene | None = None


Step = Annotated[
    Union[VideoStep, SimulationStep, MatchStep, ProcessStep, QuizStep],
    Field(discriminator="kind"),
]


class FunctionDef(Strict):
    args: list[str]
    expr: str


class Lesson(Strict):
    title: str
    eyebrow: str
    summary: str
    palette: dict[str, str] | None = None
    functions: dict[str, FunctionDef] | None = None
    steps: list[Step] = Field(min_length=3, max_length=16)
    sources: list[Source]
    note: str | None = None

    @model_validator(mode="after")
    def _ids(self):
        ids = [s.id for s in self.steps]
        if len(ids) != len(set(ids)):
            raise ValueError("step ids must be unique")
        if not any(s.kind == "video" for s in self.steps):
            raise ValueError("a lesson needs at least one video step")
        if self.steps[-1].kind != "quiz":
            raise ValueError("the last step must be the quiz")
        return self
