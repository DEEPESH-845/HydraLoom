import json

import pytest
from pydantic import ValidationError

from gantrylab.rig.models import CONTRACT_DIR, MODELS, schema_text

FIX = CONTRACT_DIR / "fixtures"


def _cases(kind):
    return sorted((FIX / kind).glob("*.json"))


def test_fixtures_exist():
    assert _cases("valid") and _cases("invalid")


@pytest.mark.parametrize("path", _cases("valid"), ids=lambda p: p.stem)
def test_valid(path):
    MODELS[path.stem.split(".")[0]].model_validate_json(path.read_text("utf-8"))


@pytest.mark.parametrize("path", _cases("invalid"), ids=lambda p: p.stem)
def test_invalid(path):
    with pytest.raises(ValidationError):
        MODELS[path.stem.split(".")[0]].model_validate_json(path.read_text("utf-8"))


@pytest.mark.parametrize("name", MODELS)
def test_schema_not_stale(name):
    on_disk = (CONTRACT_DIR / f"{name}.schema.json").read_text("utf-8")
    assert json.loads(on_disk) == json.loads(schema_text(name))
