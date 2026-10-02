---
section: Changed
audience: user
---

- **Append context injection to the active user prompt to preserve KV cache (refs #3693)** — When the trailing message is a plain user prompt, `pi-lens` now appends findings and guidance directly to that message rather than inserting a separate `user` message before it (`append-to-last-user`). This preserves prompt prefix stability through the user prompt text on prefix-caching providers and eliminates consecutive `user` turns on local GGUF runners (such as `llama.cpp` with ChatML/Qwen templates). Array-shaped content blocks and string prompts are both supported without in-place mutation, and mid-loop tool result adjacency remains preserved.
