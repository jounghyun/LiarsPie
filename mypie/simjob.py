"""긴 기간 전략 시뮬레이션을 웹 서버와 따로 계산하는 작업 (python3 -m mypie.simjob <spec.json>).

웹 서버가 낮은 우선순위(nice 19)로 띄워서 매매 봇을 느리게 하지 않는다. 한 번에 하나만 돈다.
진행 상황은 simcache/job.json에 적고, simcache/job.stop 파일이 생기면 그 자리에서 멈춘다.
코인은 모자란 과거 봉을 업비트에서 먼저 받는다 (봇과 같은 DB의 bars 표).
"""

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from . import backtest, simulation, upbit
from .config import load_config
from .db import Database
from .history import sync_candles
from .timeutil import ts

log = logging.getLogger("mypie.simjob")
STATE, STOP, SPEC, LOG = "job.json", "job.stop", "job_spec.json", "job.log"
ROOT = Path(__file__).resolve().parent.parent
WRITE_EVERY = 0.7  # 진행 상황을 이 간격(초)보다 자주 적지 않는다
_procs: list[subprocess.Popen] = []


Stopped = simulation.Stopped


def _alive(pid: int) -> bool:
    if os.name == "nt":  # 윈도(개발 PC)의 os.kill(pid, 0)은 Ctrl+C를 보내 버려서 쓰지 않는다
        return True
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def read_state(folder: Path) -> dict:
    """지금(또는 마지막) 계산 작업 상태. 돌던 작업이 사라졌으면(파이 재시작 등) 멈춘 것으로 고친다."""
    for p in list(_procs):
        if p.poll() is not None:
            _procs.remove(p)
    state = simulation.load(folder / STATE) or {"state": "idle"}
    if state.get("state") == "running" and not _alive(int(state.get("pid") or 0)):
        state = {**state, "state": "stopped", "message": "계산이 중간에 멈췄어요 (파이가 다시 시작됐거나 오류)"}
        simulation.save(folder / STATE, state)
    return state


def start(folder: Path, spec: dict) -> tuple[bool, dict]:
    """계산 작업을 띄운다. 다른 계산이 돌고 있으면 (False, 그 상태)."""
    state = read_state(folder)
    if state.get("state") == "running":
        return state.get("id") == spec["id"], state
    folder.mkdir(parents=True, exist_ok=True)
    (folder / STOP).unlink(missing_ok=True)
    simulation.save(folder / SPEC, spec)
    state = {"id": spec["id"], "label": spec["label"], "state": "running", "phase": "start", "done": 0, "total": 0,
             "started": time.time(), "phase_started": time.time(), "pid": 0, "estimate_sec": spec.get("estimate_sec")}
    simulation.save(folder / STATE, state)
    with open(folder / LOG, "ab") as err:
        proc = subprocess.Popen([sys.executable, "-m", "mypie.simjob", str(folder / SPEC)], cwd=str(ROOT),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err,
                                preexec_fn=(lambda: os.nice(19)) if hasattr(os, "nice") else None)
    _procs.append(proc)
    state["pid"] = proc.pid
    simulation.save(folder / STATE, state)
    return True, state


def stop(folder: Path) -> dict:
    """돌고 있는 계산에 멈춤 표시를 남긴다 (작업이 1~2초 안에 보고 멈춘다)."""
    state = read_state(folder)
    if state.get("state") == "running":
        (folder / STOP).touch()
    return state


class Progress:
    """진행 상황을 job.json에 적고, 멈춤 표시를 확인한다."""

    def __init__(self, folder: Path, spec: dict):
        self.folder, self.path = folder, folder / STATE
        self.state = {**(simulation.load(self.path) or {}), "id": spec["id"], "label": spec["label"],
                      "state": "running", "pid": os.getpid(), "started": time.time()}
        self.written = 0.0

    def phase(self, name: str, total: int) -> None:
        self.state.update(phase=name, done=0, total=total, phase_started=time.time())
        self._write(force=True)

    def update(self, done: int) -> None:
        if (self.folder / STOP).exists():
            raise Stopped
        self.state["done"] = done
        self._write()

    def finish(self, state: str, message: str = "") -> None:
        self.state.update(state=state, message=message, finished=time.time())
        self._write(force=True)
        (self.folder / STOP).unlink(missing_ok=True)

    def _write(self, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self.written >= WRITE_EVERY:
            self.state["updated"] = time.time()
            simulation.save(self.path, self.state)
            self.written = now


def _fetch(db: Database, market: str, tf: str, need: int, progress: Progress) -> None:
    """모자란 과거 봉을 업비트에서 거슬러 받는다 (봇의 sync_candles와 같은 방식, 진행률을 보여주며)."""
    sync_candles(db, market, 0, tf)  # 최신 봉과 빈 곳부터
    count, oldest = db.candle_range(market, tf)
    progress.phase("data", need)
    progress.update(min(count, need))
    while count < need and oldest:
        for attempt in range(4):
            try:
                older = upbit.get_candles(market, tf, 200, to=oldest)
                break
            except upbit.UpbitError:
                if attempt == 3:
                    raise
                time.sleep(1 + attempt)
        if not older:
            break  # 상장일까지 다 받았다
        db.upsert_candles(market, older, tf)
        count, new_oldest = db.candle_range(market, tf)
        if new_oldest == oldest:
            break
        oldest = new_oldest
        progress.update(min(count, need))
        time.sleep(0.15)  # 업비트 요청 제한 배려


def run(spec: dict, folder: Path, cfg: dict | None = None) -> str:
    """계산 작업 본체 (테스트는 이걸 바로 부른다). 끝난 상태(done·stopped·error)를 돌려준다."""
    cfg = cfg or load_config()
    progress = Progress(folder, spec)
    results = Path(spec.get("results") or folder)  # 결과 파일은 계산한 DB 옆 (상태 파일은 folder)
    ctx = simulation.context(spec["kind"], cfg, spec["tf"], spec["stop_loss"])
    db = Database(spec["db"], create=False)
    try:
        bars, need = spec["bars"], spec["bars"] + ctx["history"]
        if spec["kind"] == "coin":
            _fetch(db, spec["market"], spec["tf"], need, progress)
        candles = db.candle_history(spec["market"], need, ctx["bars_tf"])
        if len(candles) - bars < backtest.WARMUP:
            raise ValueError(f"과거 데이터가 {len(candles)}봉뿐이라 이 기간은 계산할 수 없어요")
        base_path = results / f"{spec['base_key']}.json"
        base = simulation.load(base_path)
        combo_needed = spec.get("combo_key") and not (results / f"{spec['combo_key']}.json").exists()
        rule = spec["rule"] if combo_needed else None
        progress.phase("calc", len(simulation.tasks(ctx, rule, base is not None)) * bars)
        new_base, combo = simulation.compute(candles, bars, ctx, rule, base, spec.get("workers", simulation.WORKERS),
                                             progress.update, str(folder / STOP))
        if base is None:
            new_base["computed_at"] = ts()
            simulation.save(base_path, new_base)
        if combo:
            simulation.save(results / f"{spec['combo_key']}.json", combo)
        progress.state["done"] = progress.state["total"]
        progress.finish("done")
        _tidy(results)
        return "done"
    except Stopped:
        progress.finish("stopped", "멈췄어요")
        return "stopped"
    except Exception as e:
        log.exception("시뮬레이션 계산 실패")
        progress.finish("error", f"계산하지 못했어요 ({e})")
        return "error"
    finally:
        db.close()


def _tidy(folder: Path, keep: int = 30) -> None:
    """오래된 결과 파일은 지운다 (최근 keep개만)."""
    results = sorted((p for p in folder.glob("*.json") if p.name not in (STATE, SPEC)), key=lambda p: p.stat().st_mtime)
    for p in results[:-keep]:
        p.unlink(missing_ok=True)


def main(argv: list[str]) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    spec_path = Path(argv[0])
    run(json.loads(spec_path.read_text(encoding="utf-8")), spec_path.parent)


if __name__ == "__main__":
    main(sys.argv[1:])
