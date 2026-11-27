"""계좌 카드의 작은 그래프: 이 계좌가 첫 매매부터 전략대로 사고판 수익률과, 그때 사서 그냥 들고 있었다면의 수익률.

실제 매매 기록(가격·수수료)과 봉 종가로 다시 그린다. 이 봇은 계좌 돈 전부로 사고 전부 파니까,
들고 있는 동안은 가격만큼 움직이고 판 뒤에는 그대로다. 중간에 넣고 뺀 돈은 수익률에 섞지 않는다
(시뮬레이션 그래프와 같은 방식). 그래서 넣은 돈 기준인 '계좌 수익률'과는 조금 다를 수 있다.
"""

from datetime import date, datetime, timedelta

from . import timeframes
from .db import Database
from .timeutil import KST, now_kst, ts

MAX_POINTS = 240  # 카드 안 그래프라 이 정도면 충분하다


def build(trades: list[dict], bars: list[tuple[str, float]], price_now: float | None = None,
          now: str | None = None) -> dict:
    """trades: 이 계좌 매매 (오래된 것부터, ts·side·price·krw·fee). bars: (봉이 끝나는 시각, 종가) 오래된 것부터.
    {"start": 첫 매매 시각, "points": [[시각, 전략 %, 그냥 들고 있었다면 %, 가격], ...], "trades": [[시각, buy|sell, 가격], ...]}.
    매매가 없으면 points가 비어 있다."""
    if not trades:
        return {"start": None, "points": [], "trades": []}
    start, ref = trades[0]["ts"], float(trades[0]["price"])  # 바이앤홀드는 첫 매매 가격에 샀다고 친다
    holding = trades[0]["side"] == "sell"  # 처음이 매도면 그 전부터 들고 있었다
    index, mark, i = 1.0, ref, 0  # 전략 지수, 마지막으로 값을 매긴 가격, 다음 매매
    points = [[start, 0.0, 0.0, ref]]

    def trade_until(when: str | None) -> None:
        nonlocal index, mark, holding, i
        while i < len(trades) and (when is None or trades[i]["ts"] <= when):
            t = trades[i]
            if holding:
                index *= float(t["price"]) / mark
            index *= 1 - (float(t["fee"]) / float(t["krw"]) if t["krw"] else 0.0)
            holding, mark, i = t["side"] == "buy", float(t["price"]), i + 1

    def point(when: str, price: float) -> None:
        nonlocal index, mark
        if holding:
            index *= price / mark
        mark = price
        points.append([when, (index - 1) * 100, (price / ref - 1) * 100, price])

    for end, close in bars:
        if end <= start:
            continue
        trade_until(end)
        point(end, float(close))
    trade_until(None)
    if price_now:
        point(now or ts(), float(price_now))
    if len(points) > MAX_POINTS:  # 골고루 줄이되 처음과 끝은 남긴다
        step = (len(points) - 1) / (MAX_POINTS - 1)
        points = [points[round(k * step)] for k in range(MAX_POINTS)]
    return {"start": start, "points": points, "trades": [[t["ts"], t["side"], float(t["price"])] for t in trades]}


def slot_trades(db: Database, mode: str, slot: str) -> list[dict]:
    return db._rows("SELECT ts, side, price, krw, fee FROM trades WHERE mode = ? AND slot = ? ORDER BY id", (mode, slot))


def coin(db: Database, status: dict, slot_id: str) -> dict:
    """코인 계좌: 그 계좌의 판단 주기 봉으로."""
    x = next((s for s in (status or {}).get("slots", []) if s["id"] == slot_id), None)
    if not x:
        return {"start": None, "points": []}
    trades = slot_trades(db, status["mode"], slot_id)
    if not trades:
        return {"start": None, "points": []}
    minutes = timeframes.minutes(x["tf"])
    first = datetime.fromisoformat(trades[0]["ts"]).replace(tzinfo=KST)
    count = min(int((now_kst() - first).total_seconds() // 60 // minutes) + 3, 6000)  # 첫 매매 뒤의 봉 수
    bars = [(ts(timeframes.key_to_utc(b["day"]) + timedelta(minutes=minutes)), b["close"])
            for b in db.candle_history(x["market"], count, x["tf"])]
    return build(trades, bars, x.get("price"))


def stock(db: Database, status: dict, slot_id: str, day_tf: str) -> dict:
    """주식 계좌: 일봉으로 (KRX·NXT 통합이라 봉은 그날 20:00에 끝난다)."""
    x = next((s for s in (status or {}).get("slots", []) if s["id"] == slot_id), None)
    if not x:
        return {"start": None, "points": []}
    trades = slot_trades(db, status["mode"], slot_id)
    if not trades:
        return {"start": None, "points": []}
    days = (now_kst().date() - date.fromisoformat(trades[0]["ts"][:10])).days
    bars = [(f"{b['day']} 20:00:00", b["close"]) for b in db.candle_history(x["symbol"], min(days + 3, 3000), day_tf)]
    return build(trades, bars, x.get("price"))
