"""Pydantic v2 request / response models for every /api/v1 endpoint."""

from __future__ import annotations

import math
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FRAME_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
CLASS_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _./-]{0,63}$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Open(BaseModel):
    model_config = ConfigDict(extra="allow")


# ---------------------------------------------------------------------------
# Common
# ---------------------------------------------------------------------------


class ErrorResponse(BaseModel):
    detail: str | list | dict


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

ModelStatus = Literal["pending", "ready", "rejected"]
ModelFormat = Literal["pt", "onnx"]


class ModelInspection(Open):
    format: ModelFormat
    task: str | None = None
    names: dict[str, str] = Field(default_factory=dict)
    nc: int | None = None
    imgsz: int | None = None
    parameters: int | None = None
    gflops: float | None = None
    gflops_imgsz: int | None = None
    architecture: str | None = None
    checkpoint_ultralytics_version: str | None = None
    checkpoint_date: str | None = None
    checkpoint_torch_version: str | None = None
    train_args: dict[str, Any] = Field(default_factory=dict)
    forward_check: str | None = None
    worker_versions: dict[str, str | None] = Field(default_factory=dict)


class ModelVersionRef(BaseModel):
    version: int
    id: str
    sha256: str
    uploaded_at: str
    status: ModelStatus


class ModelRecord(BaseModel):
    id: str
    sha256: str
    name: str
    version: int
    versions: list[ModelVersionRef] = Field(default_factory=list)
    format: ModelFormat
    size_bytes: int
    original_filename: str
    uploaded_at: str
    status: ModelStatus
    status_reason: str | None = None
    inspection: ModelInspection | None = None
    inspected_at: str | None = None
    storage_path: str = Field(description="Path relative to the data directory. The file is read-only.")
    deduplicated: bool = False


class ModelList(BaseModel):
    models: list[ModelRecord]


# ---------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------


class GeneratorInfo(Strict):
    app: str = Field(max_length=128)
    version: str = Field(max_length=64)
    renderer: str | None = Field(default=None, max_length=128)


class CameraIntrinsics(Strict):
    fx: float = Field(gt=0)
    fy: float = Field(gt=0)
    cx: float
    cy: float
    position: list[float] | None = Field(default=None, min_length=3, max_length=3)
    quaternion: list[float] | None = Field(default=None, min_length=4, max_length=4)
    hfov_deg: float | None = Field(default=None, gt=0, lt=360)


ConditionValue = str | float | int | bool | None


class Annotation(Strict):
    object_id: str = Field(min_length=1, max_length=128)
    class_name: str
    bbox_xywh: list[float] = Field(min_length=4, max_length=4)
    visible_fraction: float | None = Field(default=None, ge=0, le=1)
    occluded_fraction: float | None = Field(default=None, ge=0, le=1)
    truncated: bool | None = None
    distance_m: float | None = Field(default=None, ge=0)
    area_px: float | None = Field(default=None, ge=0)

    @field_validator("bbox_xywh")
    @classmethod
    def _finite_positive(cls, v: list[float]) -> list[float]:
        if not all(math.isfinite(x) for x in v):
            raise ValueError("bbox values must be finite")
        if v[2] <= 0 or v[3] <= 0:
            raise ValueError("bbox width and height must be > 0")
        if v[0] < 0 or v[1] < 0:
            raise ValueError("bbox x and y must be >= 0")
        return v


class Frame(Strict):
    file: str
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    camera: CameraIntrinsics | None = None
    conditions: dict[str, ConditionValue] = Field(default_factory=dict)
    annotations: list[Annotation] = Field(default_factory=list, max_length=2000)

    @field_validator("file")
    @classmethod
    def _safe_file(cls, v: str) -> str:
        if not FRAME_FILE_RE.match(v) or ".." in v:
            raise ValueError("file must be a plain file name ([A-Za-z0-9._-], no path separators, no '..')")
        if not v.lower().endswith((".png", ".jpg", ".jpeg")):
            raise ValueError("file must end with .png, .jpg or .jpeg")
        return v

    @field_validator("conditions")
    @classmethod
    def _conditions(cls, v: dict[str, ConditionValue]) -> dict[str, ConditionValue]:
        if len(v) > 64:
            raise ValueError("at most 64 condition keys")
        for k, val in v.items():
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$", k):
                raise ValueError(f"invalid condition key {k!r}")
            if isinstance(val, float) and not math.isfinite(val):
                raise ValueError(f"condition {k} must be finite")
            if isinstance(val, str) and len(val) > 128:
                raise ValueError(f"condition {k} string too long")
        return v

    @model_validator(mode="after")
    def _bbox_inside(self) -> "Frame":
        tol = 1.0
        for a in self.annotations:
            x, y, w, h = a.bbox_xywh
            if x + w > self.width + tol or y + h > self.height + tol:
                raise ValueError(f"annotation {a.object_id} bbox exceeds image bounds {self.width}x{self.height}")
        return self


class DatasetManifest(Strict):
    schema_: Literal["gantrylab.dataset/1"] = Field(alias="schema")
    name: str = Field(min_length=1, max_length=200)
    seed: int | None = None
    generator: GeneratorInfo
    classes: list[str] = Field(min_length=1, max_length=1000)
    frames: list[Frame] = Field(min_length=1)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("classes")
    @classmethod
    def _classes(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("classes must be unique")
        for c in v:
            if not CLASS_NAME_RE.match(c):
                raise ValueError(f"invalid class name {c!r}")
        return v

    @model_validator(mode="after")
    def _cross(self) -> "DatasetManifest":
        names = [f.file for f in self.frames]
        lower = [n.lower() for n in names]
        if len(set(lower)) != len(lower):
            raise ValueError("frame file names must be unique (case-insensitive)")
        stems = [n.rsplit(".", 1)[0] for n in lower]
        if len(set(stems)) != len(stems):
            raise ValueError("frame file stems must be unique (YOLO label files are named <stem>.txt)")
        cls = set(self.classes)
        for f in self.frames:
            ids = set()
            for a in f.annotations:
                if a.class_name not in cls:
                    raise ValueError(f"frame {f.file}: class {a.class_name!r} not in classes")
                if a.object_id in ids:
                    raise ValueError(f"frame {f.file}: duplicate object_id {a.object_id!r}")
                ids.add(a.object_id)
        return self


class ConditionSummary(BaseModel):
    type: Literal["numeric", "categorical"]
    min: float | None = None
    max: float | None = None
    values: list[str] | None = None
    n_frames: int


class DatasetRecord(BaseModel):
    id: str
    name: str
    schema_: str = Field(alias="schema", serialization_alias="schema")
    seed: int | None
    generator: GeneratorInfo
    classes: list[str]
    n_frames: int
    n_annotations: int
    class_counts: dict[str, int]
    conditions: dict[str, ConditionSummary]
    manifest_sha256: str
    total_bytes: int
    created_at: str

    model_config = ConfigDict(populate_by_name=True)


class DatasetList(BaseModel):
    datasets: list[DatasetRecord]


class DatasetDetail(DatasetRecord):
    frames: list[dict[str, Any]] = Field(description="Frame entries from the manifest (file, size, conditions, n_annotations).")


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

RunStatus = Literal["queued", "running", "complete", "failed"]


class RunConfig(Strict):
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, gt=0.0, le=1.0)
    imgsz: int = Field(default=640, ge=32, le=4096)
    max_det: int = Field(default=300, ge=1, le=3000)
    device: Literal["cpu", "cuda", "auto"] = "auto"
    class_map: dict[str, str | None] = Field(default_factory=dict)
    compute_profile: str = Field(default="auto", max_length=64)
    budget_fps: float = Field(default=10.0, gt=0, le=10000)
    warmup_frames: int | None = Field(default=None, ge=0, le=100)

    @field_validator("imgsz")
    @classmethod
    def _stride(cls, v: int) -> int:
        if v % 32:
            raise ValueError("imgsz must be a multiple of 32")
        return v


class RunCreate(Strict):
    model_id: str = Field(min_length=1, max_length=80)
    dataset_id: str = Field(min_length=1, max_length=80)
    adapter: Literal["auto", "mock"] = "auto"
    seed: int = 0
    config: RunConfig = Field(default_factory=RunConfig)


class RunCreated(BaseModel):
    id: str
    status: RunStatus
    events_url: str
    status_url: str


class RunRecord(BaseModel):
    id: str
    status: RunStatus
    progress: float
    message: str
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    model: dict[str, Any]
    dataset: dict[str, Any]
    adapter: str
    mock: bool
    seed: int
    config: RunConfig
    resolved_class_map: dict[str, str | None] = Field(default_factory=dict)
    unmapped_model_classes: list[str] = Field(default_factory=list)
    versions: dict[str, Any] = Field(default_factory=dict)
    runtime: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    metrics_available: bool = False


class RunList(BaseModel):
    runs: list[RunRecord]


class RunEvent(BaseModel):
    run_id: str
    seq: int
    type: Literal["status", "progress", "log", "complete", "failed"]
    status: RunStatus
    progress: float
    message: str
    ts: str


# Metrics ---------------------------------------------------------------------


class OverallMetrics(BaseModel):
    n_gt: int
    tp: int
    fp: int
    fn: int
    precision: float | None
    recall: float | None
    f1: float | None
    map50: float | None
    map50_95: float | None
    n_classes_evaluated: int


class ClassMetrics(BaseModel):
    support: int
    n_pred: int
    tp: int
    fp: int
    fn: int
    precision: float | None
    recall: float | None
    f1: float | None
    ap50: float | None
    ap50_95: float | None


class ConfSweep(BaseModel):
    thresholds: list[float]
    precision: list[float | None]
    recall: list[float | None]
    f1: list[float | None]


class BestF1(BaseModel):
    conf: float
    f1: float
    precision: float | None
    recall: float | None


class ClassPR(BaseModel):
    recall: list[float]
    precision: list[float]
    ap50: float


class PRCurves(BaseModel):
    per_class: dict[str, ClassPR]
    conf_sweep: ConfSweep
    best_f1: BestF1 | None
    iou_threshold: float


class ConfusionMatrix(BaseModel):
    labels: list[str]
    matrix: list[list[int]]
    axes: str
    iou_same_class: float
    iou_confusion: float
    conf: float


class FalsePositive(BaseModel):
    file: str | None
    class_name: str
    bbox_xyxy: list[float]
    conf: float
    type: Literal["background", "duplicate", "class_confusion", "localization"]
    gt_class: str | None
    best_iou: float
    conditions: dict[str, Any]


class FalseNegative(BaseModel):
    file: str | None
    class_name: str
    bbox_xyxy: list[float]
    reason: Literal["missed", "misclassified", "mislocalized", "below_conf_threshold"]
    object_id: str | None = None
    distance_m: float | None = None
    visible_fraction: float | None = None
    occluded_fraction: float | None = None
    area_px: float | None = None
    conditions: dict[str, Any]


class ConfusedPair(BaseModel):
    gt_class: str
    pred_class: str
    count: int


class ConfidenceHistogram(BaseModel):
    bins: list[float]
    tp: list[int]
    fp: list[int]
    iou_threshold: float


class SliceMetrics(BaseModel):
    id: str
    key: str
    bucket: str
    order: int
    lo: float | None
    hi: float | None
    kind: Literal["condition", "attribute"]
    scope: Literal["full", "recall_only"]
    n_frames: int
    n_gt: int
    tp: int
    fp: int | None
    fn: int
    recall: float | None
    precision: float | None
    f1: float | None
    ap50: float | None
    low_support: bool


class RankedSlice(BaseModel):
    id: str
    key: str
    bucket: str
    kind: str
    n_frames: int
    n_gt: int
    metric: str
    value: float


class SliceRanking(BaseModel):
    min_support: int
    n_eligible: int
    n_excluded_low_support: int
    worst: list[RankedSlice]
    best: list[RankedSlice]


class SensitivityBucket(BaseModel):
    bucket: str
    x: float
    recall: float | None
    n_gt: int


class Sensitivity(BaseModel):
    id: str
    key: str
    metric: str
    slope_per_unit: float
    intercept: float
    n_buckets: int
    recall_range: list[float]
    delta_recall: float
    buckets: list[SensitivityBucket]
    note: str


class LatencyStat(BaseModel):
    n: int
    mean: float | None
    p50: float | None
    p95: float | None
    min: float | None
    max: float | None


class LatencyBlock(BaseModel):
    kind: Literal["measured", "not_measured"]
    n_frames: int
    n_warmup_excluded: int
    warmup_total_ms: list[float | None]
    preprocess_ms: LatencyStat
    inference_ms: LatencyStat
    postprocess_ms: LatencyStat
    total_ms: LatencyStat
    fps_from_mean_latency: float | None
    wall_fps: float | None
    note: str


class ResourceBlock(BaseModel):
    kind: Literal["measured", "not_measured"]
    peak_rss_mb: float | None
    cpu_percent_mean: float | None
    cpu_percent_max: float | None
    gpu_max_memory_allocated_mb: float | None
    gpu_util_mean: float | None
    gpu_util_max: float | None
    device: str | None
    device_name: str | None
    notes: list[str]


class HardwareBlock(BaseModel):
    profile: str
    name: str
    kind: Literal["measured", "estimated", "simulated"]
    latency_ms_p50: float | None
    fps: float | None
    budget_fps_required: float
    meets_budget: bool | None
    method: str
    assumptions: list[str]


class RunMetrics(BaseModel):
    run_id: str
    mock: bool
    banner: str | None
    conf_threshold: float
    iou_thresholds: list[float]
    n_frames: int
    n_frames_empty_gt: int
    n_predictions_total: int
    classes: list[str]
    overall: OverallMetrics
    per_class: dict[str, ClassMetrics]
    pr: PRCurves
    confusion_matrix: ConfusionMatrix
    false_positives: list[FalsePositive]
    false_negatives: list[FalseNegative]
    fp_types: dict[str, int]
    fn_types: dict[str, int]
    confused_pairs: list[ConfusedPair]
    confidence_histogram: ConfidenceHistogram
    tp_below_conf_threshold: int
    failure_cap: int
    slices: list[SliceMetrics]
    slice_ranking: SliceRanking
    sensitivity: list[Sensitivity]
    latency: LatencyBlock
    resources: ResourceBlock
    hardware: HardwareBlock
    hardware_profiles: list[HardwareBlock]
    simulated: dict[str, Any] = Field(default_factory=dict)


class FramePredictions(BaseModel):
    file: str
    detections: list[dict[str, Any]]
    timing: dict[str, float | None]


class RunPredictions(BaseModel):
    run_id: str
    mock: bool
    inference_conf_floor: float
    frames: list[FramePredictions]


# ---------------------------------------------------------------------------
# Compute profiles / health
# ---------------------------------------------------------------------------


class ComputeProfile(BaseModel):
    id: str
    name: str
    kind: Literal["measured", "estimated"]
    hardware_name: str | None
    available: bool
    device: Literal["cpu", "cuda"] | None
    method: str
    effective_gflops: float | None = None
    overhead_ms: float | None = None
    assumptions: list[str] = Field(default_factory=list)


class ComputeProfileList(BaseModel):
    profiles: list[ComputeProfile]


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    version: str
    versions: dict[str, str | None]
    adapters: dict[str, bool]
    devices: dict[str, Any]
    llm_providers: dict[str, bool]
    llm_default: str
    data_dir_writable: bool
    limits: dict[str, Any]


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

PatchFile = Literal["data.yaml", "hyp.yaml", "inference.yaml"]
MAX_USER_FILE = 256 * 1024


class ReportCreate(Strict):
    provider: str | None = Field(default=None, max_length=32)
    include_failure_examples: bool = True
    user_files: dict[PatchFile, str] | None = None

    @field_validator("user_files")
    @classmethod
    def _size(cls, v: dict[str, str] | None) -> dict[str, str] | None:
        if v:
            for k, text in v.items():
                if len(text.encode("utf-8")) > MAX_USER_FILE:
                    raise ValueError(f"{k} exceeds {MAX_USER_FILE} bytes")
        return v


class KeyFinding(BaseModel):
    text: str
    evidence_refs: list[str] = Field(default_factory=list)


class ExecutiveSummary(BaseModel):
    what_was_tested: str
    model: str
    environments: list[str]
    overall: str
    key_findings: list[KeyFinding]
    headline_metrics: dict[str, float | int | None]


class Section(BaseModel):
    narrative: str
    evidence_refs: list[str] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)


class ConditionEntry(BaseModel):
    slice_id: str
    key: str
    bucket: str
    metric: str
    value: float
    n_gt: int
    n_frames: int


class Recommendation(BaseModel):
    priority: int = Field(ge=1, le=10)
    action: str
    rationale: str
    evidence_refs: list[str]


class NextExperiment(BaseModel):
    environment: dict[str, Any]
    parameters: dict[str, Any]
    rationale: str
    evidence_refs: list[str] = Field(default_factory=list)


class ConfigSuggestion(BaseModel):
    id: str
    file: str
    key: str
    original: Any
    original_source: Literal["user_file", "ultralytics_default", "run_config", "not_applicable"]
    suggested: Any
    reason: str
    evidence: list[str]
    expected_benefit: str
    tradeoffs: str
    confidence: Literal["low", "medium", "high"]
    patchable: bool
    rationale: str | None = None


class EngineeringReport(BaseModel):
    id: str
    run_id: str
    created_at: str
    schema_version: Literal["gantrylab.report/1"] = "gantrylab.report/1"
    provider: str
    provider_model: str | None
    fallback: bool
    fallback_reason: str | None
    mock: bool
    banner: str | None
    evidence_hash: str
    number_check: dict[str, Any]
    executive_summary: ExecutiveSummary
    performance_breakdown: Section
    environmental_sensitivity: Section
    failure_analysis: Section
    best_conditions: list[ConditionEntry]
    worst_conditions: list[ConditionEntry]
    conditions_narrative: Section
    hardware_suitability: Section
    recommendations: list[Recommendation]
    next_experiment: NextExperiment
    config_suggestions: list[ConfigSuggestion]
    disclaimers: list[str]
    user_files_provided: list[str]


class ReportSummary(BaseModel):
    id: str
    run_id: str
    created_at: str
    provider: str
    fallback: bool
    mock: bool


class ReportList(BaseModel):
    reports: list[ReportSummary]


class PatchResponse(BaseModel):
    report_id: str
    file: PatchFile
    original_source: Literal["user_file", "empty"]
    original: str
    patched: str
    diff: str
    applied_suggestions: list[str]
    note: str


class AskRequest(Strict):
    question: str = Field(min_length=1, max_length=2000)
    provider: str | None = Field(default=None, max_length=32)


class AskResponse(BaseModel):
    report_id: str
    question: str
    answer: str
    evidence_refs: list[str]
    uncertainty: str
    provider: str
    fallback: bool
    fallback_reason: str | None
    mock: bool


# ---------------------------------------------------------------------------
# Compare
# ---------------------------------------------------------------------------


class CompareRun(BaseModel):
    run_id: str
    model: dict[str, Any]
    dataset: dict[str, Any]
    adapter: str
    mock: bool
    overall: OverallMetrics
    latency_ms_p50: float | None
    hardware: HardwareBlock


class Delta(BaseModel):
    a: float | None
    b: float | None
    delta: float | None


class SliceDelta(BaseModel):
    id: str
    key: str
    bucket: str
    n_gt_a: int | None
    n_gt_b: int | None
    recall: Delta
    precision: Delta
    f1: Delta
    low_support: bool


class CompareResponse(BaseModel):
    runs: list[CompareRun]
    comparison_type: Literal["models", "environments", "models_and_environments", "repeat"]
    overall_deltas: dict[str, Delta]
    per_class_deltas: dict[str, dict[str, Delta]]
    slice_deltas: list[SliceDelta]
    notes: list[str]
