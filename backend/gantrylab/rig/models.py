"""Rig contract v1. Source of truth for contracts/rig/v1/*.schema.json.

Regenerate schemas: cd backend && python -m gantrylab.rig.models
Run results and calib.json are open objects: their real shapes are not known here.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Literal, Union

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel

Num = Annotated[float, Field(allow_inf_nan=False, strict=True)]
Conf = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False, strict=True)]
Int = Annotated[int, Field(ge=0, strict=True)]
Id = Annotated[str, Field(min_length=1, max_length=64)]
Source = Literal["real", "sim"]
GantryState = Literal["DISARMED", "ARMED", "HOMING", "IDLE", "MOVING", "HOLD", "ESTOP", "FAULT"]
SearchStatus = Literal["idle", "running", "aligning", "confirming", "parking", "done"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Gantry(Strict):
    state: GantryState
    x_mm: Num
    y_mm: Num
    target: Annotated[list[Num], Field(min_length=2, max_length=2)] | None


class Found(Strict):
    id: Id
    x_mm: Num
    y_mm: Num
    conf: Conf
    centred: Annotated[bool, Field(strict=True)]


class Search(Strict):
    status: SearchStatus
    step: Int
    cell: Annotated[list[Int], Field(min_length=2, max_length=2)] | None
    visited: list[list[Literal[0, 1]]]
    found: list[Found]


class Detection(Strict):
    x1: Num
    y1: Num
    x2: Num
    y2: Num
    conf: Conf
    label: Literal["shipwreck"]


class Telemetry(Strict):
    v: Literal[1]
    t: AwareDatetime
    source: Source
    rig: Literal["bench-v1"]
    gantry: Gantry
    search: Search
    detections: list[Detection]
    fps: Annotated[float, Field(ge=0, allow_inf_nan=False, strict=True)]
    throttled: Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]+$")]
    temp_c: Num


class _Cmd(Strict):
    id: Id


class Arm(_Cmd):
    cmd: Literal["arm"]
    phrase: Literal["ARM GANTRY"]


class Simple(_Cmd):
    cmd: Literal["disarm", "estop", "reset_fault", "set_origin_here", "park", "stop", "heartbeat"]


class Move(_Cmd):
    """Shape only. The bridge rejects targets outside the safe box; it never clamps."""

    cmd: Literal["move"]
    x_mm: Num
    y_mm: Num


class StartSearch(_Cmd):
    cmd: Literal["start_search"]
    policy: Literal["rl", "sweep"]
    conf: Conf
    model: Annotated[str, Field(min_length=1)]


class Command(RootModel[Annotated[Union[Arm, Simple, Move, StartSearch], Field(discriminator="cmd")]]):
    pass


class Reply(Strict):
    id: Id
    ok: Annotated[bool, Field(strict=True)]
    error: str | None = None


class Health(Strict):
    v: Literal[1]
    source: Source
    rig: Literal["bench-v1"]
    dry_run: Annotated[bool, Field(strict=True)]
    versions: dict[str, str]
    model: str | None
    camera: Annotated[bool, Field(strict=True)]
    serial: Annotated[bool, Field(strict=True)]
    throttled: Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]+$")] | None


class OpenObject(RootModel[dict[str, Any]]):
    """results.json / calib.json passthrough."""


MODELS = {"telemetry": Telemetry, "command": Command, "reply": Reply, "health": Health}
CONTRACT_DIR = Path(__file__).resolve().parents[3] / "contracts" / "rig" / "v1"


def schema_text(name: str) -> str:
    return json.dumps(MODELS[name].model_json_schema(), indent=2) + "\n"


if __name__ == "__main__":
    for n in MODELS:
        (CONTRACT_DIR / f"{n}.schema.json").write_text(schema_text(n), encoding="utf-8")
