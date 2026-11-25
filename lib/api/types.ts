/**
 * Types mirroring the GANTRYLAB backend contract (docs/API_V1.md, backend/gantrylab/schemas.py).
 * `null` always means "not available" and is never a stand-in for zero.
 */

export type ISODate = string;

// ---------------------------------------------------------------------------
// Health and compute profiles
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  versions: Record<string, string | null>;
  adapters: Record<string, boolean>;
  devices: { cpu?: string | null; cuda?: string[]; torch_cuda_build?: string | null; [k: string]: unknown };
  llm_providers: Record<string, boolean>;
  llm_default: string;
  data_dir_writable: boolean;
  /** uploads, runs and reports need an access token; absent from older backends */
  write_auth?: boolean;
  limits: {
    max_model_mb?: number;
    max_dataset_frames?: number;
    max_frame_mb?: number;
    max_dataset_mb?: number;
    worker_timeout_s?: number;
    worker_mem_mb?: number;
    [k: string]: unknown;
  };
}

export type ProfileKind = "measured" | "estimated";
export type ValueKind = "measured" | "estimated" | "simulated";

export interface ComputeProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  hardware_name: string | null;
  available: boolean;
  device: "cpu" | "cuda" | null;
  method: string;
  effective_gflops: number | null;
  overhead_ms: number | null;
  assumptions: string[];
}

export interface ComputeProfileList {
  profiles: ComputeProfile[];
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type ModelStatus = "pending" | "ready" | "rejected";
export type ModelFormat = "pt" | "onnx";

export interface ModelInspection {
  format: ModelFormat;
  task: string | null;
  names: Record<string, string>;
  nc: number | null;
  imgsz: number | null;
  parameters: number | null;
  gflops: number | null;
  gflops_imgsz: number | null;
  architecture: string | null;
  checkpoint_ultralytics_version: string | null;
  checkpoint_date: string | null;
  checkpoint_torch_version: string | null;
  train_args: Record<string, unknown>;
  forward_check: string | null;
  worker_versions: Record<string, string | null>;
  /** ONNX only. */
  onnx_producer?: string | null;
  onnx_opset?: number | null;
  inputs?: unknown;
  outputs?: unknown;
  [k: string]: unknown;
}

export interface ModelVersionRef {
  version: number;
  id: string;
  sha256: string;
  uploaded_at: ISODate;
  status: ModelStatus;
}

export interface ModelRecord {
  id: string;
  sha256: string;
  name: string;
  version: number;
  versions: ModelVersionRef[];
  format: ModelFormat;
  size_bytes: number;
  original_filename: string;
  uploaded_at: ISODate;
  status: ModelStatus;
  status_reason: string | null;
  inspection: ModelInspection | null;
  inspected_at: ISODate | null;
  storage_path: string;
  deduplicated: boolean;
}

export interface ModelList {
  models: ModelRecord[];
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export interface GeneratorInfo {
  app: string;
  version: string;
  renderer?: string | null;
}

export interface CameraIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  position?: number[] | null;
  quaternion?: number[] | null;
  hfov_deg?: number | null;
}

export type ConditionValue = string | number | boolean | null;

export interface Annotation {
  object_id: string;
  class_name: string;
  bbox_xywh: [number, number, number, number];
  visible_fraction?: number | null;
  occluded_fraction?: number | null;
  truncated?: boolean | null;
  distance_m?: number | null;
  area_px?: number | null;
}

export interface ManifestFrame {
  file: string;
  width: number;
  height: number;
  camera?: CameraIntrinsics | null;
  conditions: Record<string, ConditionValue>;
  annotations: Annotation[];
}

export interface DatasetManifest {
  schema: "gantrylab.dataset/1";
  name: string;
  seed?: number | null;
  generator: GeneratorInfo;
  classes: string[];
  frames: ManifestFrame[];
}

export interface ConditionSummary {
  type: "numeric" | "categorical";
  min: number | null;
  max: number | null;
  values: string[] | null;
  n_frames: number;
}

export interface DatasetRecord {
  id: string;
  name: string;
  schema: string;
  seed: number | null;
  generator: GeneratorInfo;
  classes: string[];
  n_frames: number;
  n_annotations: number;
  class_counts: Record<string, number>;
  conditions: Record<string, ConditionSummary>;
  manifest_sha256: string;
  total_bytes: number;
  created_at: ISODate;
}

export interface DatasetFrameSummary {
  file: string;
  width: number;
  height: number;
  conditions: Record<string, ConditionValue>;
  n_annotations: number;
}

export interface DatasetDetail extends DatasetRecord {
  frames: DatasetFrameSummary[];
}

export interface DatasetList {
  datasets: DatasetRecord[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "complete" | "failed";
export type DeviceChoice = "cpu" | "cuda" | "auto";
export type AdapterChoice = "auto" | "mock";

export interface RunConfig {
  conf: number;
  iou: number;
  imgsz: number;
  max_det: number;
  device: DeviceChoice;
  class_map: Record<string, string | null>;
  compute_profile: string;
  budget_fps: number;
  warmup_frames: number | null;
}

export interface RunCreate {
  model_id: string;
  dataset_id: string;
  adapter: AdapterChoice;
  seed: number;
  config: RunConfig;
}

export interface RunCreated {
  id: string;
  status: RunStatus;
  events_url: string;
  status_url: string;
}

export interface RunModelRef {
  id: string;
  sha256: string;
  name: string;
  version: number;
  format: ModelFormat;
  task: string | null;
  gflops: number | null;
  gflops_imgsz: number | null;
  parameters: number | null;
  names_count: number;
  [k: string]: unknown;
}

export interface RunDatasetRef {
  id: string;
  name: string;
  manifest_sha256: string;
  n_frames: number;
  classes: string[];
  seed: number | null;
  generator: GeneratorInfo;
  [k: string]: unknown;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  progress: number;
  message: string;
  created_at: ISODate;
  started_at: ISODate | null;
  finished_at: ISODate | null;
  model: RunModelRef;
  dataset: RunDatasetRef;
  adapter: string;
  mock: boolean;
  seed: number;
  config: RunConfig;
  resolved_class_map: Record<string, string | null>;
  unmapped_model_classes: string[];
  versions: Record<string, unknown>;
  runtime: { device?: string; device_name?: string; warnings?: string[]; [k: string]: unknown };
  warnings: string[];
  error: string | null;
  metrics_available: boolean;
}

export interface RunList {
  runs: RunRecord[];
}

export type RunEventType = "status" | "progress" | "log" | "complete" | "failed";

export interface RunEvent {
  run_id: string;
  seq: number;
  type: RunEventType;
  status: RunStatus;
  progress: number;
  message: string;
  ts: ISODate;
}

// Metrics ---------------------------------------------------------------------

export interface OverallMetrics {
  n_gt: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  map50: number | null;
  map50_95: number | null;
  n_classes_evaluated: number;
}

export interface ClassMetrics {
  support: number;
  n_pred: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ap50: number | null;
  ap50_95: number | null;
}

export interface ConfSweep {
  thresholds: number[];
  precision: (number | null)[];
  recall: (number | null)[];
  f1: (number | null)[];
}

export interface BestF1 {
  conf: number;
  f1: number;
  precision: number | null;
  recall: number | null;
}

export interface ClassPR {
  recall: number[];
  precision: number[];
  ap50: number;
}

export interface PRCurves {
  per_class: Record<string, ClassPR>;
  conf_sweep: ConfSweep;
  best_f1: BestF1 | null;
  iou_threshold: number;
}

export interface ConfusionMatrix {
  labels: string[];
  matrix: number[][];
  axes: string;
  iou_same_class: number;
  iou_confusion: number;
  conf: number;
}

export type FalsePositiveType = "background" | "duplicate" | "class_confusion" | "localization";
export type FalseNegativeReason = "missed" | "misclassified" | "mislocalized" | "below_conf_threshold";

export interface FalsePositive {
  file: string | null;
  class_name: string;
  bbox_xyxy: [number, number, number, number];
  conf: number;
  type: FalsePositiveType;
  gt_class: string | null;
  best_iou: number;
  conditions: Record<string, ConditionValue>;
}

export interface FalseNegative {
  file: string | null;
  class_name: string;
  bbox_xyxy: [number, number, number, number];
  reason: FalseNegativeReason;
  object_id?: string | null;
  distance_m?: number | null;
  visible_fraction?: number | null;
  occluded_fraction?: number | null;
  area_px?: number | null;
  conditions: Record<string, ConditionValue>;
}

export interface ConfusedPair {
  gt_class: string;
  pred_class: string;
  count: number;
}

export interface ConfidenceHistogram {
  bins: number[];
  tp: number[];
  fp: number[];
  iou_threshold: number;
}

export interface SliceMetrics {
  id: string;
  key: string;
  bucket: string;
  order: number;
  lo: number | null;
  hi: number | null;
  kind: "condition" | "attribute";
  scope: "full" | "recall_only";
  n_frames: number;
  n_gt: number;
  tp: number;
  fp: number | null;
  fn: number;
  recall: number | null;
  precision: number | null;
  f1: number | null;
  ap50: number | null;
  low_support: boolean;
}

/** Joint turbidity x lighting cell; absent from runs made before the backend reported it. */
export interface ConditionCell {
  turbidity: string;
  lighting: string;
  n_frames: number;
  n_gt: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface RankedSlice {
  id: string;
  key: string;
  bucket: string;
  kind: string;
  n_frames: number;
  n_gt: number;
  metric: string;
  value: number;
}

export interface SliceRanking {
  min_support: number;
  n_eligible: number;
  n_excluded_low_support: number;
  worst: RankedSlice[];
  best: RankedSlice[];
}

export interface SensitivityBucket {
  bucket: string;
  x: number;
  recall: number | null;
  n_gt: number;
}

export interface Sensitivity {
  id: string;
  key: string;
  metric: string;
  slope_per_unit: number;
  intercept: number;
  n_buckets: number;
  recall_range: number[];
  delta_recall: number;
  buckets: SensitivityBucket[];
  note: string;
}

export interface LatencyStat {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export interface LatencyBlock {
  kind: "measured" | "not_measured";
  n_frames: number;
  n_warmup_excluded: number;
  warmup_total_ms: (number | null)[];
  preprocess_ms: LatencyStat;
  inference_ms: LatencyStat;
  postprocess_ms: LatencyStat;
  total_ms: LatencyStat;
  fps_from_mean_latency: number | null;
  wall_fps: number | null;
  note: string;
}

export interface ResourceBlock {
  kind: "measured" | "not_measured";
  peak_rss_mb: number | null;
  cpu_percent_mean: number | null;
  cpu_percent_max: number | null;
  gpu_max_memory_allocated_mb: number | null;
  gpu_util_mean: number | null;
  gpu_util_max: number | null;
  device: string | null;
  device_name: string | null;
  notes: string[];
}

export interface HardwareBlock {
  profile: string;
  name: string;
  kind: ValueKind;
  latency_ms_p50: number | null;
  fps: number | null;
  budget_fps_required: number;
  meets_budget: boolean | null;
  method: string;
  assumptions: string[];
}

export interface RunMetrics {
  run_id: string;
  mock: boolean;
  banner: string | null;
  conf_threshold: number;
  iou_thresholds: number[];
  n_frames: number;
  n_frames_empty_gt: number;
  n_predictions_total: number;
  classes: string[];
  overall: OverallMetrics;
  per_class: Record<string, ClassMetrics>;
  pr: PRCurves;
  confusion_matrix: ConfusionMatrix;
  false_positives: FalsePositive[];
  false_negatives: FalseNegative[];
  fp_types: Record<string, number>;
  fn_types: Record<string, number>;
  confused_pairs: ConfusedPair[];
  confidence_histogram: ConfidenceHistogram;
  tp_below_conf_threshold: number;
  failure_cap: number;
  slices: SliceMetrics[];
  condition_cells?: ConditionCell[];
  slice_ranking: SliceRanking;
  sensitivity: Sensitivity[];
  latency: LatencyBlock;
  resources: ResourceBlock;
  hardware: HardwareBlock;
  hardware_profiles: HardwareBlock[];
  simulated: Record<string, unknown>;
}

export interface Detection {
  class_id: number;
  class_name: string;
  bbox_xyxy: [number, number, number, number];
  conf: number;
  [k: string]: unknown;
}

export interface FramePredictions {
  file: string;
  detections: Detection[];
  timing: Record<string, number | null>;
}

export interface RunPredictions {
  run_id: string;
  mock: boolean;
  inference_conf_floor: number;
  frames: FramePredictions[];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type PatchFile = "data.yaml" | "hyp.yaml" | "inference.yaml";
export const PATCH_FILES: PatchFile[] = ["data.yaml", "hyp.yaml", "inference.yaml"];
export type LlmProvider = "auto" | "anthropic" | "openai" | "ollama" | "deterministic";

export interface ReportCreate {
  provider?: LlmProvider | null;
  include_failure_examples?: boolean;
  user_files?: Partial<Record<PatchFile, string>> | null;
}

export interface KeyFinding {
  text: string;
  evidence_refs: string[];
}

export interface ExecutiveSummary {
  what_was_tested: string;
  model: string;
  environments: string[];
  overall: string;
  key_findings: KeyFinding[];
  headline_metrics: Record<string, number | null>;
}

export interface Section {
  narrative: string;
  evidence_refs: string[];
  data: Record<string, unknown>;
}

export interface ConditionEntry {
  slice_id: string;
  key: string;
  bucket: string;
  metric: string;
  value: number;
  n_gt: number;
  n_frames: number;
}

export interface Recommendation {
  priority: number;
  action: string;
  rationale: string;
  evidence_refs: string[];
}

export interface NextExperiment {
  environment: Record<string, unknown>;
  parameters: Record<string, unknown>;
  rationale: string;
  evidence_refs: string[];
}

export interface ConfigSuggestion {
  id: string;
  file: string;
  key: string;
  original: unknown;
  original_source: "user_file" | "ultralytics_default" | "run_config" | "not_applicable";
  suggested: unknown;
  reason: string;
  evidence: string[];
  expected_benefit: string;
  tradeoffs: string;
  confidence: "low" | "medium" | "high";
  patchable: boolean;
  rationale: string | null;
}

export interface NumberCheck {
  checked?: boolean;
  replaced?: { field: string; unverified?: unknown; missing_refs?: string[] }[];
  attempts?: number;
  note?: string | null;
  [k: string]: unknown;
}

export interface EngineeringReport {
  id: string;
  run_id: string;
  created_at: ISODate;
  schema_version: "gantrylab.report/1";
  provider: string;
  provider_model: string | null;
  fallback: boolean;
  fallback_reason: string | null;
  mock: boolean;
  banner: string | null;
  evidence_hash: string;
  number_check: NumberCheck;
  executive_summary: ExecutiveSummary;
  performance_breakdown: Section;
  environmental_sensitivity: Section;
  failure_analysis: Section;
  best_conditions: ConditionEntry[];
  worst_conditions: ConditionEntry[];
  conditions_narrative: Section;
  hardware_suitability: Section;
  recommendations: Recommendation[];
  next_experiment: NextExperiment;
  config_suggestions: ConfigSuggestion[];
  disclaimers: string[];
  user_files_provided: string[];
}

export interface ReportSummary {
  id: string;
  run_id: string;
  created_at: ISODate;
  provider: string;
  fallback: boolean;
  mock: boolean;
}

export interface ReportList {
  reports: ReportSummary[];
}

export interface PatchResponse {
  report_id: string;
  file: PatchFile;
  original_source: "user_file" | "empty";
  original: string;
  patched: string;
  diff: string;
  applied_suggestions: string[];
  note: string;
}

export interface AskRequest {
  question: string;
  provider?: LlmProvider | null;
}

export interface AskResponse {
  report_id: string;
  question: string;
  answer: string;
  evidence_refs: string[];
  uncertainty: string;
  provider: string;
  fallback: boolean;
  fallback_reason: string | null;
  mock: boolean;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface CompareRun {
  run_id: string;
  model: Partial<RunModelRef>;
  dataset: Partial<RunDatasetRef>;
  adapter: string;
  mock: boolean;
  overall: OverallMetrics;
  latency_ms_p50: number | null;
  hardware: HardwareBlock;
}

export interface Delta {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface SliceDelta {
  id: string;
  key: string;
  bucket: string;
  n_gt_a: number | null;
  n_gt_b: number | null;
  recall: Delta;
  precision: Delta;
  f1: Delta;
  low_support: boolean;
}

export type ComparisonType = "models" | "environments" | "models_and_environments" | "repeat";

export interface CompareResponse {
  runs: CompareRun[];
  comparison_type: ComparisonType;
  overall_deltas: Record<string, Delta>;
  per_class_deltas: Record<string, Record<string, Delta>>;
  slice_deltas: SliceDelta[];
  notes: string[];
}

export const MOCK_BANNER = "MOCK ADAPTER - not a real model evaluation";
