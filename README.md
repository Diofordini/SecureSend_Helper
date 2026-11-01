# SecureSend Helper

Browser-only tool that creates AES-256 encrypted `.7z` archives (encrypted file names) for emailing to external recipients, with the password sent separately. Files and passwords never leave the user's computer.

- App: [`site/index.html`](site/index.html), a single self-contained file with no dependencies
- Tests: [`tests/`](tests/), which verify every archive against the real 7-Zip CLI
- CI/CD: [`.github/workflows/test-and-deploy.yml`](.github/workflows/test-and-deploy.yml). Every push is tested, and `main` deploys to GitHub Pages **only if all tests pass**

## Run the tests locally

Prerequisites: Node.js 20+, Google Chrome, and the 7-Zip CLI on your PATH.

| OS | 7-Zip CLI |
|---|---|
| Windows | Install 7-Zip, then add `C:\Program Files\7-Zip` to PATH, or `set SEVENZ=C:\Program Files\7-Zip\7z.exe` |
| macOS | `brew install sevenzip`, then `export SEVENZ=7zz` |
| Linux | `sudo apt install p7zip-full` |

```bash
npm ci
npm test            # core + end-to-end
npm run test:core   # engine vs 7-Zip only (no browser needed)
npm run test:e2e    # headless Chrome from file:// (set CHROME_PATH if Chrome isn't auto-detected)
```

## Manual acceptance checklist (run once per release, on a work PC)

1. Open `site/index.html` by double-clicking it (file://). Then open DevTools → Network and tick **Preserve log**.
2. Add 2–3 real documents, including one with a non-English name. Click Encrypt & Download.
3. Network tab: **zero requests**.
4. Open the `.7z` in **7-Zip on Windows**. It must ask for the password **before** showing names.
5. Enter a wrong password: it fails. Enter the right password, then 7-Zip → *Test archive*: "No errors". Then extract and compare the files.
6. Repeat step 4 on a Mac with Keka or The Unarchiver.
7. Open the `.7z` in a hex editor or Notepad++ and search for a file name: **not found**.

## Integrity

Each CI run publishes the SHA-256 of `index.html` in the job summary. Users can check a downloaded copy:

```powershell
Get-FileHash index.html -Algorithm SHA256      # Windows
```
```bash
shasum -a 256 index.html                       # macOS/Linux
```

## Versioning

Bump `APP_VERSION` in `site/index.html` and `version` in `package.json`, then tag: `git tag v1.0.1 && git push --tags`.
