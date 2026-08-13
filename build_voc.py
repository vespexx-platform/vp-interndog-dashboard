#!/usr/bin/env python3
"""voc_graph_data.json → 암호화 → site/voc.js (window.__VOC_ENC__).

대시보드 비밀번호(DASHBOARD_PASSWORD)로 AES-256-GCM 암호화(기존 data.js와 동일 포맷).
공개 레포엔 암호문만 올라감. 원본 집계(voc_graph_data.json)는 gitignore.
"""
import base64
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = os.environ["DASHBOARD_PASSWORD"]
ITERS = 200_000
SRC = os.path.join(HERE, "voc_graph_data.json")
OUT = os.path.join(HERE, "site", "voc.js")


def encrypt(plaintext: str) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=SHA256(), length=32, salt=salt, iterations=ITERS).derive(PASSWORD.encode())
    ct = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"salt": b(salt), "iv": b(iv), "iters": ITERS, "ct": b(ct)}


def main():
    data = open(SRC, encoding="utf-8").read()
    enc = encrypt(data)
    with open(OUT, "w") as f:
        f.write("window.__VOC_ENC__ = " + json.dumps(enc) + ";\n")
    print(f"저장: {OUT} (암호문 {len(enc['ct'])}B)")


if __name__ == "__main__":
    main()
