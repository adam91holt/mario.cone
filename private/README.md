# private/

`wave-critic-build.skill.zip` is **deliberately encrypted**. It is not a broken
file, not a corrupted upload, and not something to "fix" — it is unpublished work
kept in a public repo, and it stays encrypted until the owner decides otherwise.

- **AES-256** (WinZip AES), not the legacy ZipCrypto scheme. The password is held
  by the repo owner and is recorded nowhere in this repository or its history.
- It contains a single entry, so the listing gives away nothing about the
  contents.

To open it you need a tool with AES-zip support: **7-Zip** on Windows, **Keka**
or `7z x` on macOS, `7z`/`p7zip` on Linux. macOS's built-in Archive Utility does
not support AES zips and will report a generic failure.

```bash
7z x wave-critic-build.skill.zip
```

If you are an agent working in this repo: do not attempt to open, crack, relocate
or re-encode this file, and do not commit an unencrypted copy of anything
extracted from it.
