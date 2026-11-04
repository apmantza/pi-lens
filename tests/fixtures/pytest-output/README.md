# pytest output fixtures (#5270)

Captured on 2026-11-04 from real `python -m pytest <file> --tb=short -q`
runs (pytest 9.2.0, CPython 3.14.4), one file per case, each in a throwaway
project with a bare `pytest.ini`. Nothing was edited except the project path in
`collect.txt`. The exit code of each run:

| file | content | exit |
| --- | --- | --- |
| `pass.txt` | one passing test | 0 |
| `xfail.txt` | one passing test, one `xfail` | 0 |
| `mixed.txt` | one passing test, one whose fixture raises | 1 |
| `fail_and_error.txt` | one failing test, one fixture error | 1 |
| `collect.txt` | a module that fails to import | 2 |
| `empty.txt` | a test file with no tests | 5 |
