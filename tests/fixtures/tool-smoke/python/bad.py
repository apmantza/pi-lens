"""Tool-smoke fixture for #209 — ruff must flag the unused import (F401)."""

import os


def add(a, b):
    return a + b


result = add(1, 2)
