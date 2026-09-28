"""Phase 1 position metrics. Definitions: docs/metrics.md."""

import json
from collections import defaultdict

# Target-in-frame decision bands (experiment plan §16; gaps between bands filled in docs/metrics.md).
BANDS = ((0.85, "candidate"), (0.60, "marginal"), (0.0, "unacceptable"))
REPOSITION_LIMIT = 0.20
FIRST_ANSWER_TARGET = 0.80


def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def band(rate: float | None) -> str | None:
    if rate is None:
        return None
    return next(name for floor, name in BANDS if rate >= floor)


def compute(sessions: list[dict], marks: list[dict], frames: list[dict],
            group_by: tuple[str, ...] = ("mount",)) -> list[dict]:
    session_key = {s["id"]: tuple(s[k] for k in group_by) for s in sessions}
    frame_stats = {f["session_id"]: f for f in frames}

    groups: dict[tuple, dict] = defaultdict(lambda: defaultdict(int))
    for s in sessions:
        g = groups[session_key[s["id"]]]
        g["sessions"] += 1
        g["participants_set"] = g.get("participants_set") or set()
        g["participants_set"].add(s["participant"])
        fs = frame_stats.get(s["id"])
        if fs:
            g["frames"] += fs["n"]
            g["frames_auto_ok"] += fs["auto_ok"] or 0
            if fs["n"] > 1:
                g["frame_intervals"] += fs["n"] - 1
                g["duration_ms"] += fs["t1"] - fs["t0"]

    for m in marks:
        key = session_key.get(m["session_id"])
        if key is None:
            continue
        g = groups[key]
        if m["kind"] == "reposition":
            g["repositions"] += 1
            continue
        if m["kind"] != "gaze":
            continue
        g["gaze"] += 1
        if m["target_in_frame"] is None:
            continue
        g["annotated"] += 1
        g["in_frame"] += m["target_in_frame"]
        g["centered"] += m["centered"] or 0
        g["occluded"] += m["occluded"] or 0
        g["useful"] += m["useful"] or 0

    out = []
    for key, g in sorted(groups.items(), key=lambda kv: tuple(str(k) for k in kv[0])):
        tif = _rate(g["in_frame"], g["annotated"])
        repo = _rate(g["repositions"], g["gaze"])
        out.append({
            **dict(zip(group_by, key)),
            "sessions": g["sessions"],
            "participants": len(g.get("participants_set") or ()),
            "gaze_marks": g["gaze"],
            "annotated": g["annotated"],
            "target_in_frame_rate": tif,
            "target_in_frame_band": band(tif),
            "target_center_rate": _rate(g["centered"], g["annotated"]),
            "occlusion_rate": _rate(g["occluded"], g["annotated"]),
            "useful_frame_rate": _rate(g["useful"], g["annotated"]),
            "reposition_rate": repo,
            "reposition_over_limit": None if repo is None else repo > REPOSITION_LIMIT,
            "frames": g["frames"],
            "auto_ok_rate": _rate(g["frames_auto_ok"], g["frames"]),
            "effective_fps": round(g["frame_intervals"] / (g["duration_ms"] / 1000), 3) if g["duration_ms"] else None,
        })
    return out


def _percentile(values: list[int], q: float) -> int | None:
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(round(q * (len(v) - 1))))]


def compute_qa(sessions: list[dict], marks: list[dict], turns: list[dict],
               group_by: tuple[str, ...] = ("mount",)) -> list[dict]:
    """Phase 2 metrics over voice turns inside experiment sessions. Definitions: docs/metrics.md."""

    session_key = {s["id"]: tuple(s[k] for k in group_by) for s in sessions}
    groups: dict[tuple, dict] = defaultdict(lambda: defaultdict(int))
    latencies: dict[tuple, list[int]] = defaultdict(list)

    for m in marks:
        key = session_key.get(m["session_id"])
        if key is not None and m["kind"] == "phone":
            groups[key]["phone_uses"] += 1

    for t in turns:
        key = session_key.get(t["session_id"])
        if key is None or t["status"] not in ("done", "error"):
            continue
        g = groups[key]
        g["turns"] += 1
        first = t["retry_of"] is None
        g["first_turns" if first else "retries"] += 1
        if t["status"] == "error":
            g["errors"] += 1
        if t["correct"] is not None:
            g["judged"] += 1
            g["correct"] += t["correct"]
            if first:
                g["first_judged"] += 1
                g["first_correct"] += t["correct"]
        if t["described_scene"] is not None:
            g["described_judged"] += 1
            g["described"] += t["described_scene"]
        timings = json.loads(t["timings"]) if t["timings"] else {}
        if t["status"] == "done" and "total_ms" in timings:
            latencies[key].append(timings["total_ms"])

    out = []
    for key, g in sorted(groups.items(), key=lambda kv: tuple(str(k) for k in kv[0])):
        first_acc = _rate(g["first_correct"], g["first_judged"])
        out.append({
            **dict(zip(group_by, key)),
            "turns": g["turns"],
            "judged": g["judged"],
            "answer_accuracy": _rate(g["correct"], g["judged"]),
            "first_answer_accuracy": first_acc,
            "first_answer_ok": None if first_acc is None else first_acc >= FIRST_ANSWER_TARGET,
            "rephrase_rate": _rate(g["retries"], g["first_turns"]),
            "described_scene_rate": _rate(g["described"], g["described_judged"]),
            "phone_uses": g["phone_uses"],
            "error_rate": _rate(g["errors"], g["turns"]),
            "latency_p50_ms": _percentile(latencies[key], 0.5),
            "latency_p90_ms": _percentile(latencies[key], 0.9),
        })
    return out
