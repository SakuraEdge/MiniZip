# MiniZip Dev v1.0.0 Design Approval

Status: approved by the user on 2026-11-18. Candidate C and the quick-compression window are selected for implementation. Review files remain an archive of the design approval.

## Icon Candidates

All candidates are original editable SVG marks, with transparent exterior and small-size previews. The built-in image generation tool was attempted for four variants but returned HTTP 502 for each. The delivered candidates are deterministic vector designs, not generated bitmaps.

- A: coral tile with archive lid and zipper. Recommended for clear format association and continuity with the existing UI.
- B: zipper folder silhouette without an outer tile.
- C: graphite tile with M monogram and coral zipper slider.
- D: open coral archive box with extraction arrow.

Selected: C. Export a multi-resolution Windows ICO and PNG assets, with pixel alignment checked at 16/20/24/32/48/64/128/256 px.

## Quick Compression UI

The review form is local-only. It does not read paths, start native tools or write archives.

- Only a compact window appears for the Explorer compression command; do not open the main workbench.
- Show input name, count and size; output name and destination; ZIP/7Z format; compression level; optional password protection; cancel and compress actions.
- Default to source parent directory, source basename, ZIP and normal compression.
- Never remove source files. Confirm conflicting output filenames before replacement.
- Passwords and user selections are not persisted in this review.

## Requested Work After Approval

1. Remove all built-in sample packages, thumbnails, sample navigation, sample favorites and demo task entry points from the user-facing app. Keep test fixtures outside the packaged app only.
2. Sidebar defaults to an icon rail; a visible icon button expands/collapses it. All icon-only actions need tooltips and accessible labels.
3. Use display version `Dev v1.0.0` initially. Keep numeric semantic version separate from the Dev/Rev release channel; later use `Rev` for stable releases. Never decide release ordering via lexicographic string comparison.
4. Create the user's explicitly requested public GitHub repository and upload audited source only. Exclude credentials, generated output, caches, local test files and installers from Git. Publish installers as release assets.
5. Add a GitHub release update screen with current version/channel, check state, available version and release notes, download/install confirmation and actionable error/retry states. Validate release asset origin and integrity; do not auto-run remote content without user intent.
6. Build an installer with optional archive file associations and Explorer context-menu entries. Modern Windows may require the user to confirm the default handler in Settings; do not overwrite or forge the protected UserChoice hash.
7. Explorer commands include opening archives with MiniZip and adding files/folders to a new archive. Quote paths, handle multiple selections and Unicode, and avoid shell concatenation or injecting paths as 7-Zip options.
8. Implement the approved quick-compression window and backend only after its UI is approved, then test a real installed build, update checks and uninstall cleanup.

## Review Entry

Open `index.html` in this directory. PNGs in `screenshots/` are rendered from the editable review UI, not generated illustrations.
