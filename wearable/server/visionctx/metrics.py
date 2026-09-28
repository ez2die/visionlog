"""Phase 1 position metrics. Definitions: docs/metrics.md."""

from collections import defaultdict

# Target-in-frame decision bands (experiment plan §16; gaps between bands filled in docs/metrics.md).
BANDS = ((0.85, "candidate"), (0.60, "marginal"), (0.0, "unacceptable"))
REPOSITION_LIMIT = 0.20


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
