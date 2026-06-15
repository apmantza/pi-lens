# Tool-smoke fixture for #209 — hadolint flags the untagged FROM (DL3006)
# and the unpinned apt-get install (DL3008/DL3009).
FROM ubuntu
RUN apt-get update && apt-get install -y curl
