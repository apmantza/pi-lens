---
section: Fixed
---

- Late auxiliary findings (a slow scanner such as opengrep answering after its
  grace window) are less likely to be delivered against a newer revision of
  the file. The pending pair records how many sends the scanner still had to
  answer, and the turn-end drain waits for that many publications, so a
  re-edit made while an older scan was running no longer lets that scan's
  findings through. Publications are counted when stored or when a resync or
  a newer answer supersedes them, capped at the sends, so opengrep's extra
  answers around its rule load no longer shorten the count and a dropped
  answer no longer withholds later findings. A stale verdict keeps the
  original baseline instead of resetting it. An extra publication that
  arrives while a send is still outstanding can still be miscounted (refs
  #3482).
