"""웹페이지에서 설정을 바꿀 때 쓰는 PIN (코인·주식 공통). 원문은 저장하지 않고 해시만 DB에 남긴다.

아직 만들지 않았으면 기본 PIN(DEFAULT_PIN)이고, 웹페이지 ⚙️ 설정에서 바꾼다.
잊어버렸을 때 (파이에서): python3 -m mypie.pin 으로 새로 만든다.
"""

import getpass
import hashlib
import hmac
import os
import sys

STATE_KEY = "web_pin"
ITERATIONS = 100_000
DEFAULT_PIN = "0000"     # 아직 PIN을 만들지 않았을 때
MIN_LENGTH, MAX_LENGTH = 4, 32
_default_seen: dict[str, bool] = {}  # 저장된 해시 → 기본 PIN인지 (해시 계산이 무거워서 한 번만)


def _digest(pin: str, salt: bytes, iterations: int) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, iterations).hex()


def make(pin: str) -> dict:
    salt = os.urandom(16)
    return {"salt": salt.hex(), "hash": _digest(pin, salt, ITERATIONS), "iterations": ITERATIONS}


def verify(pin: str, stored: dict | None) -> bool:
    """stored가 없으면 기본 PIN과 비교한다."""
    if not stored:
        return hmac.compare_digest(pin.encode("utf-8"), DEFAULT_PIN.encode("utf-8"))
    expected = _digest(pin, bytes.fromhex(stored["salt"]), int(stored["iterations"]))
    return hmac.compare_digest(expected, stored["hash"])


def is_default(stored: dict | None) -> bool:
    """아직 기본 PIN(0000)인지. 화면이 '바꿔 주세요'를 띄우는 데 쓴다."""
    if not stored:
        return True
    if stored["hash"] not in _default_seen:
        _default_seen[stored["hash"]] = verify(DEFAULT_PIN, stored)
    return _default_seen[stored["hash"]]


def problem(new: str) -> str | None:
    """새 PIN으로 쓸 수 없으면 그 이유."""
    if not MIN_LENGTH <= len(new) <= MAX_LENGTH:
        return f"PIN은 {MIN_LENGTH}~{MAX_LENGTH}자로 정해 주세요."
    if new.strip() != new:
        return "PIN 앞뒤에 빈칸이 있어요."
    return None


def main() -> None:
    from .config import load_config
    from .db import Database

    pin = getpass.getpass("새 PIN (4자리 이상, 입력해도 화면에 안 보여요): ")
    if problem(pin):
        sys.exit(problem(pin))
    if getpass.getpass("한 번 더 입력: ") != pin:
        sys.exit("두 번 입력한 PIN이 달라요. 다시 해 주세요.")
    db = Database(load_config()["general"]["db_path"])
    db.set_state(STATE_KEY, make(pin))
    db.close()
    print("PIN을 저장했어요. 웹페이지에서 설정을 바꿀 때 입력하세요. 다음부터는 ⚙️ 설정에서도 바꿀 수 있어요.")


if __name__ == "__main__":
    main()
