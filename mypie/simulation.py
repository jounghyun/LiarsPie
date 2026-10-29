"""전략 시뮬레이션 계산 중 긴 기간용 (웹 서버와 따로 도는 계산 작업 simjob.py가 같이 쓴다).

짧은 기간은 웹 서버가 바로 계산한다 (web._simulate). 긴 기간(LONG_BARS개보다 많은 봉, 또는 3년)은 파이 3B에서
몇 분까지 걸려서 따로 계산하고, 결과를 하루 동안 파일로 남겨 둔다. 화면 차트에는 MAX_POINTS개까지만 보낸다.
전략마다 따로 굴릴 수 있어서 코어를 WORKERS개까지 나눠 쓴다 (하나는 매매 봇 몫으로 남긴다).
"""

import hashlib
import json
import math
import multiprocessing as mp
import os
from bisect import bisect_left
from pathlib import Path

from . import backtest, timeframes
from .strategies import STOCK_STRATEGIES, STRATEGIES, strategy_params
from .strategies.combo import is_simple, make_rule

LONG_BARS = 1500           # 이보다 많은 봉을 굴리는 기간은 따로 계산한다
LONG_DAYS = 1095           # 3년은 봉 개수와 상관없이 따로
MAX_POINTS = 2000          # 화면 차트에 보내는 점 개수
SEC_PER_STEP = 0.0004      # 파이 3B에서 전략 하나 × 봉 하나 계산 시간 (재 보니 전략 13개가 봉 하나에 5ms)
SEC_PER_FETCH = 0.45       # 업비트 과거 봉 200개 받는 시간 (쉬는 시간 포함)
CACHE_DIR = "simcache"
WORKERS = max(1, (os.cpu_count() or 2) - 1)  # 계산에 쓰는 코어 수: 하나는 매매 봇·웹페이지 몫으로 남긴다


class Stopped(Exception):
    """멈춤을 눌렀다."""


def bars_of(kind: str, tf: str, days: int) -> int:
    """기간(일) → 굴릴 봉 개수. 주식은 1년에 거래일이 250일쯤이다."""
    return days * 250 // 365 if kind == "stock" else backtest.period_bars(timeframes.minutes(tf), days)


def is_long(days: int, bars: int) -> bool:
    return bars > LONG_BARS or days >= LONG_DAYS


def context(kind: str, cfg: dict, tf: str, stop_loss: float) -> dict:
    """코인·주식마다 다른 계산 조건: 전략 목록, 수수료·세금, 순위 기준, 1년 봉 수, 계산에 쓰는 봉."""
    if kind == "stock":
        from .stockbot import REGULAR_TF  # 주식은 정규장 일봉으로 계산한다

        sc = cfg["stock"]
        strategies, fee, sell_cost = STOCK_STRATEGIES, float(sc["fee_rate"]), float(sc["sell_tax"])
        rank_by, per_year, bars_tf = sc.get("rank_by", "return"), 250, REGULAR_TF
    else:
        strategies, fee, sell_cost = STRATEGIES, float(cfg["paper"]["fee_rate"]), 0.0
        rank_by, per_year, bars_tf = cfg["backtest"]["rank_by"], timeframes.bars_per_year(tf), tf
    return {"strategies": strategies, "params": {name: strategy_params(cfg, name) for name in strategies},
            "fee": fee, "sell_cost": sell_cost, "rank_by": rank_by, "per_year": per_year, "bars_tf": bars_tf,
            "stop_loss": stop_loss, "history": backtest.history_needed(strategies)}


def folder(db_path: str | Path) -> Path:
    return Path(db_path).parent / CACHE_DIR


def keys(kind: str, market: str, tf: str, days: int, stop_loss: float, day: str, rule: dict | None) -> tuple[str, str | None]:
    """(모든 전략 결과의 이름, 조합 결과의 이름). 결과는 그날 하루 동안 다시 쓴다."""
    base = hashlib.sha1(json.dumps([kind, market, tf, days, stop_loss, day]).encode()).hexdigest()[:16]
    if not rule or is_simple(rule):
        return base, None
    return base, base + "-" + hashlib.sha1(json.dumps(rule, sort_keys=True).encode()).hexdigest()[:10]


def load(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def tasks(ctx: dict, rule: dict | None, have_base: bool) -> list[tuple[str, str | None]]:
    """따로 굴릴 것들: 조합(있으면), 전략 하나하나, 손절선을 켰으면 손절 없는 비교선. 무거운 조합을 먼저 나눠 준다."""
    out = [("combo", None)] if rule and not is_simple(rule) else []
    if not have_base:
        out += [("single", name) for name in ctx["strategies"]] + ([("hold", None)] if ctx["stop_loss"] else [])
    return out


def estimate(ctx: dict, bars: int, rule: dict | None, missing_bars: int = 0, have_base: bool = False,
             workers: int | None = None) -> int:
    """대략 몇 초 걸릴지: (전략 수 + 조합의 전략들) × 봉 수를 코어 수로 나눈 것 + 모자란 봉 받는 시간."""
    workers = workers or WORKERS
    steps = [len(set(rule["buy"]) | set(rule["sell"])) if kind == "combo" else 1 for kind, _ in tasks(ctx, rule, have_base)]
    work = max(sum(steps) / max(1, min(workers, len(steps))), max(steps, default=0)) * bars * SEC_PER_STEP
    return round(work + math.ceil(max(0, missing_bars) / 200) * SEC_PER_FETCH)


def sample(n: int) -> list[int]:
    """n개 봉 중 화면에 보낼 위치들 (처음과 마지막은 꼭 넣는다)."""
    if n <= MAX_POINTS:
        return list(range(n))
    stride = math.ceil(n / MAX_POINTS)
    idx = list(range(0, n, stride))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


def thin(detail: dict, idx: list[int]) -> dict:
    """자산 곡선과 매매 지점을 화면용 점에 맞춘다. 매매는 사고팔기가 번갈아 나오니, 한 점 안에 여러 번이면
    첫 매매와 마지막 매매만 남긴다 (같은 쪽이면 하나만). 그래야 점마다 들고 있었는지가 그대로 맞는다."""
    groups: dict[int, list[dict]] = {}
    for f in detail["fills"]:
        groups.setdefault(min(bisect_left(idx, f["i"]), len(idx) - 1), []).append(f)
    fills = []
    for bucket, g in groups.items():
        kept = [g[0]] if len(g) == 1 or g[0]["side"] == g[-1]["side"] else [g[0], g[-1]]
        fills += [{**f, "i": bucket} for f in kept]
    return {"equity": [round(detail["equity"][i], 5) for i in idx], "fills": fills, "holding": detail["holding"]}


def _strip(r: dict) -> dict:
    return {k: v for k, v in r.items() if k not in ("detail", "description", "guide")}


_JOB: dict = {}  # 지금 계산하는 것 (나눠 쓰는 CPU들은 fork로 이걸 그대로 물려받는다)


def _run(item: tuple[int, tuple[str, str | None]]) -> tuple[tuple[str, str | None], dict]:
    """할 일 하나를 굴린다 (이 프로세스에서, 또는 나눠 쓰는 CPU에서)."""
    slot, (kind, name) = item
    job, ctx = _JOB, _JOB["ctx"]

    def step(done: int) -> None:
        job["shared"][slot] = done
        if job["progress"]:
            job["progress"](sum(job["shared"]))   # 이 프로세스: 진행 표시 (멈춤이면 여기서 Stopped)
        elif job["stop_file"] and Path(job["stop_file"]).exists():
            raise Stopped                         # 나눠 쓰는 CPU: 멈춤 표시를 직접 본다

    stop = ctx["stop_loss"]
    if kind == "combo":
        made = make_rule(job["rule"], lambda n: ctx["strategies"][n](ctx["params"].get(n)))
    elif kind == "hold":  # 비교선 '그냥 들고 있었다면'은 손절 없이
        made, stop = ctx["strategies"]["buy_and_hold"](None), 0.0
    else:
        made = ctx["strategies"][name](ctx["params"].get(name))
    r = backtest.simulate(made, job["window"], ctx["fee"], job["warm"], ctx["per_year"], True, ctx["sell_cost"], stop, step)
    return (kind, name), {"name": name or kind, "label": made.label, **r}


def compute(candles: list[dict], bars: int, ctx: dict, rule: dict | None = None, base: dict | None = None,
            workers: int = 1, progress=None, stop_file: str | None = None) -> tuple[dict, dict | None]:
    """base가 없으면 모든 전략을, 조합(rule)이 있으면 그 조합도 이 기간 굴린다 → (모든 전략 결과, 조합 결과).
    workers > 1이면 할 일을 CPU 여러 개에 나눈다 (fork가 되는 리눅스에서만). progress(done): 굴린 봉 수의 합."""
    todo = tasks(ctx, rule, base is not None)
    warm = min(ctx["history"], len(candles) - bars)
    if warm < backtest.WARMUP:
        raise ValueError("이 기간을 시험하기엔 모아 둔 봉이 모자라요")
    parallel = workers > 1 and len(todo) > 1 and "fork" in mp.get_all_start_methods()
    fork = mp.get_context("fork") if parallel else None
    _JOB.update(ctx=ctx, rule=rule, window=candles[-(bars + warm):], warm=warm, stop_file=stop_file,
                shared=fork.Array("q", len(todo), lock=False) if parallel else [0] * len(todo),
                progress=None if parallel else progress)
    try:
        if parallel:
            with fork.Pool(min(workers, len(todo))) as pool:
                pending = pool.map_async(_run, list(enumerate(todo)), chunksize=1)
                while not pending.ready():
                    pending.wait(0.5)
                    if progress:
                        progress(sum(_JOB["shared"]))  # 멈춤이면 Stopped → with를 나가며 나눠 쓰던 CPU도 멈춘다
                done = dict(pending.get())
        else:
            done = dict(_run(item) for item in enumerate(todo))
    finally:
        _JOB.clear()

    idx = sample(bars)
    if base is None:
        results = [done[("single", name)] for name in ctx["strategies"]]  # 전략 목록 순서 → 같은 점수면 목록 순서대로
        results.sort(key=lambda r: backtest.score(r, ctx["rank_by"]), reverse=True)
        for rank, r in enumerate(results, 1):
            r["rank"] = rank
        hold = done.get(("hold", None)) or next((r for r in results if r["name"] == "buy_and_hold"), results[0])
        window = candles[-bars:]
        base = {"from": window[0]["day"], "to": window[-1]["day"], "bars": bars,
                "keys": [window[i]["day"] for i in idx], "close": [window[i]["close"] for i in idx],
                "results": [_strip(r) for r in results],
                "details": {r["name"]: thin(r["detail"], idx) for r in results},
                "hold": {"total_return": hold["total_return"], "mdd": hold["mdd"],
                         "equity": thin(hold["detail"], idx)["equity"]}}
    combo = None
    if ("combo", None) in done:  # 순위는 '전략들 사이에 넣으면 몇 위'
        r = done[("combo", None)]
        result = {**_strip(r), "name": "combo"}
        ranked = sorted(base["results"] + [result], key=lambda x: backtest.score(x, ctx["rank_by"]), reverse=True)
        result["rank"] = next(i for i, x in enumerate(ranked, 1) if x is result)
        combo = {"result": result, "detail": thin(r["detail"], idx)}
    return base, combo


def assemble(out: dict, base: dict, combo: dict | None, strategy: str, rank_by: str, stop_loss: float) -> dict:
    """저장해 둔 결과 → 화면에 보내는 모양 (짧은 기간의 web._simulate와 같다)."""
    results = base["results"]
    chosen = "combo" if combo else (strategy if strategy in base["details"] else results[0]["name"])
    detail = combo["detail"] if combo else base["details"][chosen]
    shown = ([{**combo["result"], "combo": True}] if combo else []) + results
    return {**out, "ready": True, "long": True, "rank_by": rank_by, "stop_loss": stop_loss,
            "hold": {"total_return": base["hold"]["total_return"], "mdd": base["hold"]["mdd"]},
            "from": base["from"], "to": base["to"], "bars": base["bars"], "computed_at": base.get("computed_at"),
            "results": shown,
            "detail": {"name": chosen, "keys": base["keys"], "close": base["close"], "equity": detail["equity"],
                       "hold": base["hold"]["equity"], "fills": detail["fills"], "holding": detail["holding"]}}
