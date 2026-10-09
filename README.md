# Inkwell

An installable, offline-first writing app for phones, tablets and desktops: everything Scrivener for iOS does, plus some extras. Projects sync through Dropbox in real `.scriv` format, so they keep working with Scrivener on a Mac or PC.

## Features

**Scrivener for iOS parity**
- Binder: folders and documents, drag and drop, move up, down, in and out, move to, duplicate, trash/restore/empty trash
- Editor: bold, italic, underline, strikethrough, highlight, alignment, block quotes, lists, scene breaks
- Linked comments, footnotes and inline annotations, all round-tripped to Scrivener
- Corkboard with editable index cards, label colours and status stamps
- Outliner with label, status, word count, target and include-in-compile columns
- Scrivenings: edit a whole chapter or the full draft as one continuous text
- Inspector: synopsis, label, status, keywords, include in compile, page break before, document notes
- Snapshots: take, compare (word-level diff), restore
- Project and document word targets; session targets
- Search the whole project
- Compile to DOCX (real footnotes, standard manuscript format), ePub 3, PDF, HTML, Markdown and plain text
- Dropbox sync with desktop Scrivener; `.scriv` import and export

**Extras**
- Split a document at the cursor and merge documents
- Project-wide find and replace (snapshots every changed document first)
- Writing history chart, daily streak and deadline planner
- Composition mode with typewriter scrolling
- Read-aloud mode
- Light, sepia and dark themes, with adjustable fonts and spacing

## How it avoids the classic mobile-Scrivener bugs

| Problem | What Inkwell does |
|---|---|
| Lost work | Every keystroke is saved to on-device storage within 0.4 s, and also on blur, app switch and page close. The editor never waits on the network. |
| Sync conflicts | A three-way merge against the last synced state. A document edited on two devices is never auto-merged: you get Compare, Keep mine, Use other, or Keep both. Before any sync changes a document, it takes a snapshot. |
| Clobbered files | Every upload names the Dropbox revision it replaces. If someone else saved in between, Dropbox refuses the upload and the sync starts over. |
| Half-synced projects | Documents upload before the binder, so desktop Scrivener never sees a binder entry without its text. Per-file sync state means an interrupted sync resumes cleanly. |
| Project open on the Mac | Detects Scrivener's lock file and pauses (you can override). |
| Mangled formatting | Documents you didn't edit are written back byte-for-byte. The `.scrivx` is edited in place, so compile settings, collections and custom metadata survive. Documents containing images or tables open read-only rather than silently losing them. |
| Cursor jumps | The editor never reloads its own saves; content is replaced only after a sync or a restore. |
| Crashes | Large folders mount lazily. A crash screen appears instead of a blank app, and your data is already on disk. |

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests: RTF, .scrivx, sync engine
npx vite build && npx vite preview --port 4173
node e2e/smoke.mjs # end-to-end test on a phone viewport (needs the preview server)
```

### Hosting
Any static host works. To use GitHub Pages, push to `main` and enable Pages with **Source: GitHub Actions**; the included workflow builds and deploys. Then open the site on your phone and choose **Share → Add to Home Screen**.

### Dropbox (one-time)
1. Go to https://www.dropbox.com/developers/apps and choose **Create app**, with **Scoped access** and **Full Dropbox**.
2. Under Permissions, enable `files.metadata.read`, `files.content.read`, `files.content.write` and `account_info.read`.
3. Under Settings, add your site's URL (for example `https://you.github.io/inkwell/`) as a redirect URI.
4. In Inkwell, go to **Settings → Dropbox**, paste the app key, and choose **Connect**.

Alternatively, set `VITE_DROPBOX_APP_KEY` at build time.

## Limits
- Scrivener 3 projects only. Scrivener 2 projects need to be opened once in Scrivener 3 to upgrade them.
- Inline images and tables are shown as protected (read-only) documents rather than being edited.
- The `.scriv` reader and writer are tested against hand-built Scrivener 3 fixtures. Try it on a copy of a real project before relying on it.
